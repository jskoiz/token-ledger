#!/usr/bin/env node

/**
 * Token Ledger local collector
 *
 * Reads Codex's local JSONL rollouts and metadata database, then writes a
 * privacy-reduced snapshot for the Token Ledger site. It never exports message
 * bodies, tool arguments/results, reasoning text, instructions, credential
 * fields, or full local paths in the generated snapshot.
 *
 * Node 22.13 or newer is required for node:sqlite.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdtemp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  extname,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

import { writePrivateSnapshot } from "./token-ledger-snapshot.mjs";
import {
  buildUsageBuckets,
  SNAPSHOT_SCHEMA_VERSION,
  usageBucketStats,
} from "./token-ledger-usage.mjs";

const RATE_CARD_AS_OF = "2026-08-17";
const FAST_MODE_MULTIPLIER = 1.5;
const RATE_CARD_URL = "https://help.openai.com/en/articles/20001106";
const WEEK_MINUTES = 10_080;
const SCAN_CONCURRENCY = 4;
const UUID_AT_END =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const RELEVANT_EVENT_TYPES = new Set([
  "task_started",
  "thread_settings_applied",
  "token_count",
]);
const RELEVANT_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "tool_search_call",
  "web_search_call",
  "image_generation_call",
]);

function spoolText(value, maximumLength = 2_000) {
  try {
    return String(value ?? "").slice(0, maximumLength);
  } catch {
    return "";
  }
}

function spoolSource(value) {
  const descriptor = sourceDescriptor(value);
  if (descriptor.subagent) return '{"subagent":true}';
  return descriptor.label || "";
}

async function createUsageSpool() {
  const directory = await mkdtemp(resolve(tmpdir(), "token-ledger-import-"));
  const path = resolve(directory, "usage.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = FILE;
    CREATE TABLE token_events (
      event_key TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      input_tokens REAL NOT NULL,
      cached_input_tokens REAL NOT NULL,
      cache_write_input_tokens REAL NOT NULL,
      output_tokens REAL NOT NULL,
      reasoning_tokens REAL NOT NULL,
      total_tokens REAL NOT NULL,
      timestamp TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      cwd TEXT NOT NULL,
      git_origin TEXT,
      raw_source TEXT,
      service_tier TEXT,
      original_likely INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE tool_calls (
      call_key TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      original_likely INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE turn_origins (
      turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      delta_ms REAL NOT NULL,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      cwd TEXT NOT NULL,
      git_origin TEXT,
      raw_source TEXT,
      service_tier TEXT
    ) WITHOUT ROWID;
    BEGIN IMMEDIATE;
  `);
  const insertToken = database.prepare(`
    INSERT OR IGNORE INTO token_events (
      event_key, turn_id, input_tokens, cached_input_tokens,
      cache_write_input_tokens, output_tokens, reasoning_tokens,
      total_tokens, timestamp, thread_id, model, effort, cwd,
      git_origin, raw_source, service_tier, original_likely
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const promoteToken = database.prepare(`
    UPDATE token_events
       SET turn_id = ?, timestamp = ?, thread_id = ?, model = ?, effort = ?,
           cwd = ?, git_origin = ?, raw_source = ?, service_tier = ?,
           original_likely = 1
     WHERE event_key = ? AND original_likely = 0
  `);
  const insertCall = database.prepare(`
    INSERT OR IGNORE INTO tool_calls (
      call_key, turn_id, thread_id, original_likely
    ) VALUES (?, ?, ?, ?)
  `);
  const promoteCall = database.prepare(`
    UPDATE tool_calls
       SET turn_id = ?, thread_id = ?, original_likely = 1
     WHERE call_key = ? AND original_likely = 0
  `);
  const insertOrigin = database.prepare(`
    INSERT INTO turn_origins (
      turn_id, thread_id, timestamp, delta_ms, model, effort, cwd,
      git_origin, raw_source, service_tier
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(turn_id) DO UPDATE SET
      thread_id = excluded.thread_id,
      timestamp = excluded.timestamp,
      delta_ms = excluded.delta_ms,
      model = excluded.model,
      effort = excluded.effort,
      cwd = excluded.cwd,
      git_origin = excluded.git_origin,
      raw_source = excluded.raw_source,
      service_tier = excluded.service_tier
    WHERE excluded.delta_ms < turn_origins.delta_ms
  `);
  const updateOrigin = database.prepare(`
    UPDATE turn_origins
       SET thread_id = ?, timestamp = ?, model = ?, effort = ?, cwd = ?,
           git_origin = ?, raw_source = ?, service_tier = ?
     WHERE turn_id = ?
  `);
  let writing = true;

  function originValues(candidate) {
    return [
      candidate.turnId,
      candidate.threadId,
      candidate.timestamp,
      Number.isFinite(candidate.deltaMs)
        ? candidate.deltaMs
        : Number.MAX_SAFE_INTEGER,
      spoolText(candidate.model, 200),
      spoolText(candidate.effort, 80),
      spoolText(candidate.cwd),
      spoolText(candidate.gitOrigin),
      spoolSource(candidate.rawSource),
      candidate.serviceTier == null
        ? null
        : spoolText(candidate.serviceTier, 80),
    ];
  }

  return {
    directory,
    insertOrigin(candidate) {
      return insertOrigin.run(...originValues(candidate)).changes > 0;
    },
    updateOrigin(candidate) {
      const values = originValues(candidate);
      updateOrigin.run(
        values[1],
        values[2],
        values[4],
        values[5],
        values[6],
        values[7],
        values[8],
        values[9],
        values[0],
      );
    },
    insertToken(eventKey, turnId, usage, occurrence, originalLikely) {
      const values = [
        eventKey,
        turnId,
        usage.inputTokens,
        usage.cachedInputTokens,
        usage.cacheWriteInputTokens,
        usage.outputTokens,
        usage.reasoningTokens,
        usage.totalTokens,
        occurrence.timestamp,
        occurrence.threadId,
        spoolText(occurrence.model, 200),
        spoolText(occurrence.effort, 80),
        spoolText(occurrence.cwd),
        spoolText(occurrence.gitOrigin),
        spoolSource(occurrence.rawSource),
        occurrence.serviceTier == null
          ? null
          : spoolText(occurrence.serviceTier, 80),
        originalLikely ? 1 : 0,
      ];
      const inserted = insertToken.run(...values).changes > 0;
      if (!inserted && originalLikely) {
        promoteToken.run(
          turnId,
          occurrence.timestamp,
          occurrence.threadId,
          spoolText(occurrence.model, 200),
          spoolText(occurrence.effort, 80),
          spoolText(occurrence.cwd),
          spoolText(occurrence.gitOrigin),
          spoolSource(occurrence.rawSource),
          occurrence.serviceTier == null
            ? null
            : spoolText(occurrence.serviceTier, 80),
          eventKey,
        );
      }
      return inserted;
    },
    insertCall(callKey, turnId, threadId, originalLikely) {
      const inserted = insertCall.run(
        callKey,
        turnId,
        threadId,
        originalLikely ? 1 : 0,
      ).changes > 0;
      if (!inserted && originalLikely) {
        promoteCall.run(turnId, threadId, callKey);
      }
    },
    finishWrites() {
      if (!writing) return;
      database.exec("COMMIT");
      writing = false;
    },
    tokenRows() {
      return database.prepare(`
        SELECT token.event_key AS eventKey, token.turn_id AS turnId,
               token.input_tokens AS inputTokens,
               token.cached_input_tokens AS cachedInputTokens,
               token.cache_write_input_tokens AS cacheWriteInputTokens,
               token.output_tokens AS outputTokens,
               token.reasoning_tokens AS reasoningTokens,
               token.total_tokens AS totalTokens,
               token.timestamp, token.thread_id AS threadId,
               token.model, token.effort, token.cwd,
               token.git_origin AS gitOrigin,
               token.raw_source AS rawSource,
               token.service_tier AS serviceTier,
               token.original_likely AS originalLikely,
               origin.thread_id AS originThreadId,
               origin.timestamp AS originTimestamp,
               origin.model AS originModel,
               origin.effort AS originEffort,
               origin.cwd AS originCwd,
               origin.git_origin AS originGitOrigin,
               origin.raw_source AS originRawSource,
               origin.service_tier AS originServiceTier
          FROM token_events AS token
          LEFT JOIN turn_origins AS origin ON origin.turn_id = token.turn_id
         ORDER BY token.timestamp, token.event_key
      `).iterate();
    },
    callRows() {
      return database.prepare(`
        SELECT call.turn_id AS turnId,
               COALESCE(origin.thread_id, call.thread_id) AS threadId
          FROM tool_calls AS call
          LEFT JOIN turn_origins AS origin ON origin.turn_id = call.turn_id
      `).iterate();
    },
    close() {
      if (writing) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // The spool is disposable; cleanup below remains authoritative.
        }
        writing = false;
      }
      database.close();
    },
  };
}

const RATE_CARD = {
  "gpt-5.6-sol": { input: 125, cached: 12.5, output: 750 },
  "gpt-5.6-terra": { input: 50, cached: 5, output: 300 },
  "gpt-5.6-luna": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.5": { input: 125, cached: 12.5, output: 750 },
  "gpt-5.5-cyber": { input: 500, cached: 50, output: 3_000 },
  "gpt-5.4": { input: 62.5, cached: 6.25, output: 375 },
  "gpt-5.4-mini": { input: 18.75, cached: 1.875, output: 113 },
  "gpt-5.3-codex": { input: 43.75, cached: 4.375, output: 350 },
  "gpt-5.2": { input: 43.75, cached: 4.375, output: 350 },
};

function usage() {
  return `Token Ledger local collector

Usage:
  node token-ledger-importer.mjs [options]

Options:
  --output <file>       Snapshot destination (default: token-ledger-snapshot-v2.json.gz)
  --codex-home <dir>    Codex data root (default: CODEX_HOME or ~/.codex)
  --since <ISO date>    Ignore model calls before this timestamp
  --no-archived         Skip archived_sessions
  --help                Show this help

The snapshot contains usage metadata and Codex display titles only. It never
contains message bodies, tool payloads, reasoning text, credential fields, or
full local paths in its output. Codex display titles may contain user-written
text.`;
}

function parseArgs(argv) {
  const options = {
    output: resolve("token-ledger-snapshot-v2.json.gz"),
    codexHome: resolve(process.env.CODEX_HOME || `${homedir()}/.codex`),
    includeArchived: true,
    since: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--no-archived") {
      options.includeArchived = false;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a file path.");
      options.output = resolve(value);
    } else if (argument === "--codex-home") {
      const value = argv[++index];
      if (!value) throw new Error("--codex-home requires a directory.");
      options.codexHome = resolve(value);
    } else if (argument === "--since") {
      const value = argv[++index];
      if (!value || Number.isNaN(new Date(value).getTime())) {
        throw new Error("--since requires a valid ISO date.");
      }
      options.since = new Date(value);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function hash(value, length = 24) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function asFiniteNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function isoFromEpoch(value, fallback = null) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  const milliseconds = number > 10_000_000_000 ? number : number * 1_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function safeIso(value, fallback = null) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function tokenTuple(value) {
  // token_count payloads arrive from untrusted JSONL. Read the named usage
  // fields once and coerce each to a finite count so malformed records
  // contribute zeros instead of leaking odd shapes downstream.
  const {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    cache_write_input_tokens: cacheWriteInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    total_tokens: totalTokens,
  } = value ?? {};
  return [
    asFiniteNumber(inputTokens),
    asFiniteNumber(cachedInputTokens),
    asFiniteNumber(cacheWriteInputTokens),
    asFiniteNumber(outputTokens),
    asFiniteNumber(reasoningOutputTokens),
    asFiniteNumber(totalTokens),
  ];
}

function usageFromTuple(tuple) {
  // Cached input is a subset of input and reasoning is a subset of output.
  // Clamp at export so one out-of-range source record cannot skew subset
  // math downstream.
  const inputTokens = tuple[0];
  const outputTokens = tuple[3];
  return {
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, tuple[1]),
    cacheWriteInputTokens: tuple[2],
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tuple[4]),
    totalTokens: tuple[5],
  };
}

function hasDetailedBreakdown(usage) {
  if (usage.totalTokens === 0) return true;
  return (
    usage.inputTokens + usage.outputTokens === usage.totalTokens &&
    (usage.inputTokens > 0 || usage.outputTokens > 0)
  );
}

function normalizeModel(model) {
  // Collapse underscore and whitespace separators to dashes so variants like
  // "gpt-5.4 mini" resolve to their own rate-card entry instead of falling
  // back to the base model's higher rate. Keep in lockstep with
  // normalizeModel in bin/token-ledger-rates.mjs.
  const value = String(model || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (RATE_CARD[value]) return value;
  if (value.startsWith("gpt-5.6-sol")) return "gpt-5.6-sol";
  if (value.startsWith("gpt-5.6-terra")) return "gpt-5.6-terra";
  if (value.startsWith("gpt-5.6-luna")) return "gpt-5.6-luna";
  if (value.startsWith("gpt-5.5-cyber")) return "gpt-5.5-cyber";
  if (value.startsWith("gpt-5.5")) return "gpt-5.5";
  if (value.startsWith("gpt-5.4-mini")) return "gpt-5.4-mini";
  if (value.startsWith("gpt-5.4")) return "gpt-5.4";
  if (value.startsWith("gpt-5.3-codex")) return "gpt-5.3-codex";
  if (value.startsWith("gpt-5.2")) return "gpt-5.2";
  return value || "unknown";
}

function creditsForUsage(model, usage) {
  if (!hasDetailedBreakdown(usage)) return null;
  const rate = RATE_CARD[normalizeModel(model)];
  if (!rate) return null;
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const uncached = Math.max(0, usage.inputTokens - cached);
  return (
    (uncached * rate.input +
      cached * rate.cached +
      usage.outputTokens * rate.output) /
    1_000_000
  );
}

function primitiveString(value) {
  try {
    const text = String.prototype.valueOf.call(value);
    return text === value ? text : null;
  } catch {
    return null;
  }
}

function sourceDescriptor(value) {
  // Thread sources reach us in two representations: rollout session_meta
  // lines carry parsed JSON (a label string or an object with subagent
  // details) while the sqlite source column carries the same value as text.
  // Parse both here, once, so callers only branch on the named fields.
  if (value == null) return { label: null, subagent: null };
  const sourceText = primitiveString(value);
  if (sourceText === null) {
    return { label: null, subagent: value.subagent || null };
  }
  const text = sourceText.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      return { label: null, subagent: parsed.subagent || null };
    } catch {
      // Not JSON after all; fall through to the plain-label case.
    }
  }
  return { label: text || null, subagent: null };
}

function sourceLabels(threadSource, rawSource) {
  const source = sourceDescriptor(rawSource);
  if (threadSource === "subagent" || source.subagent) {
    return { source: "subagent", useType: "subagent" };
  }
  if (threadSource === "automation") {
    return { source: "automation", useType: "automation" };
  }
  if (threadSource === "realtime_voice") {
    return { source: "voice", useType: "voice" };
  }
  if (source.label === "exec") return { source: "cli", useType: "cli" };
  if (source.label === "vscode") {
    return { source: "desktop", useType: "interactive" };
  }
  if (source.label) {
    return {
      source: source.label.slice(0, 40),
      useType: threadSource || "interactive",
    };
  }
  return { source: "unknown", useType: threadSource || "unknown" };
}

function cleanRemote(value) {
  if (!value) return null;
  const remote = String(value).trim();
  const scp = remote.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) {
    return `${scp[1]}/${scp[2].replace(/\.git$/i, "")}`;
  }
  try {
    const url = new URL(remote);
    const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
    return path ? `${url.hostname}/${path}` : url.hostname;
  } catch {
    const withoutCredentials = remote.replace(/\/\/[^/@]+@/, "//");
    return withoutCredentials.replace(/\.git$/i, "").slice(0, 160);
  }
}

function projectLabel(cwd, gitOrigin) {
  const remote = cleanRemote(gitOrigin);
  if (remote) {
    const parts = remote.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || "Unknown project";
  }
  const path = String(cwd || "").replaceAll("\\", "/").replace(/\/+$/, "");
  const worktree = path.match(/\/\.codex\/worktrees\/[^/]+\/([^/]+)$/);
  if (worktree) return worktree[1];
  const name = basename(path);
  return name && name !== "." && name !== "/" ? name : "Unknown project";
}

function safeTitle(row, sessionTitle) {
  const candidate = String(sessionTitle || row?.title || row?.name || "").trim();
  const subagent =
    row?.thread_source === "subagent" ||
    String(row?.source || "").includes('"subagent"');
  if (
    !candidate ||
    candidate.includes("<codex_delegation>") ||
    (subagent && candidate.length > 120)
  ) {
    if (row?.agent_nickname) return `Subagent · ${row.agent_nickname}`;
    return subagent ? `Subagent · ${String(row?.id || "").slice(0, 8)}` : "Untitled task";
  }
  return candidate
    .replace(/\/Users\/[^\s"'`]+/g, "[local path]")
    .replace(/\/(?:private\/)?tmp\/[^\s"'`]+/g, "[temporary path]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|lin_api_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{16,})\b/g,
      "[redacted credential-like text]",
    )
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function listJsonlFiles(root) {
  if (!(await pathExists(root))) return [];
  const found = [];
  const queue = [root];
  while (queue.length) {
    const directory = queue.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && extname(entry.name) === ".jsonl") found.push(path);
    }
  }
  return found;
}

export async function latestSourceModifiedAt(codexHome, includeArchived = true) {
  const roots = [resolve(codexHome, "sessions")];
  if (includeArchived) {
    roots.push(resolve(codexHome, "archived_sessions"));
  }
  const files = (await Promise.all(roots.map((root) => listJsonlFiles(root))))
    .flat();
  const metadataFiles = [
    resolve(codexHome, "session_index.jsonl"),
    resolve(codexHome, "state_5.sqlite"),
    resolve(codexHome, "sqlite", "state_5.sqlite"),
  ];
  const existingMetadataFiles = [];
  for (const path of metadataFiles) {
    if (await pathExists(path)) existingMetadataFiles.push(path);
  }
  const sourceFiles = [...files, ...existingMetadataFiles];
  if (!sourceFiles.length) return 0;
  const stats = await Promise.all(sourceFiles.map((path) => stat(path)));
  return Math.max(...stats.map((entry) => entry.mtimeMs));
}

async function readSessionTitles(path) {
  const titles = new Map();
  if (!(await pathExists(path))) return titles;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (!record?.id || !record?.thread_name) continue;
      const timestamp = new Date(record.updated_at || 0).getTime();
      const current = titles.get(record.id);
      if (!current || timestamp >= current.timestamp) {
        titles.set(record.id, {
          title: String(record.thread_name).replace(/\s+/g, " ").slice(0, 180),
          timestamp,
        });
      }
    } catch {
      // The thread index is optional; malformed lines do not affect token totals.
    }
  }
  return titles;
}

async function readState(codexHome) {
  const preferred = resolve(codexHome, "state_5.sqlite");
  const legacy = resolve(codexHome, "sqlite", "state_5.sqlite");
  const path = (await pathExists(preferred))
    ? preferred
    : (await pathExists(legacy))
      ? legacy
      : null;
  const rows = new Map();
  const parents = new Map();
  if (!path) return { path: null, rows, parents };

  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const threadRows = database
      .prepare(
        `SELECT id, created_at, updated_at, source, cwd, title, name,
                tokens_used, git_sha, git_branch, git_origin_url,
                agent_nickname, agent_role, model, reasoning_effort,
                thread_source
           FROM threads`,
      )
      .all();
    for (const row of threadRows) rows.set(String(row.id), row);

    const edgeRows = database
      .prepare(
        "SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges",
      )
      .all();
    for (const edge of edgeRows) {
      parents.set(String(edge.child_thread_id), String(edge.parent_thread_id));
    }
  } finally {
    database.close();
  }
  return { path, rows, parents };
}

function taskStartCandidate(record, threadId, stateRow, fileContext) {
  const outerMs = new Date(record.timestamp).getTime();
  const started = asFiniteNumber(record.payload?.started_at);
  const startedMs = started > 10_000_000_000 ? started : started * 1_000;
  const timestamp = isoFromEpoch(started, safeIso(record.timestamp, new Date(0).toISOString()));
  const deltaMs =
    Number.isFinite(outerMs) && Number.isFinite(startedMs)
      ? Math.abs(outerMs - startedMs)
      : Number.POSITIVE_INFINITY;
  return {
    turnId: String(record.payload?.turn_id || ""),
    threadId,
    timestamp,
    outerTimestamp: safeIso(record.timestamp, timestamp),
    deltaMs,
    model: fileContext.model || stateRow?.model || "unknown",
    effort: fileContext.effort || stateRow?.reasoning_effort || "unknown",
    cwd: fileContext.cwd || stateRow?.cwd || "",
    gitOrigin: fileContext.gitOrigin || stateRow?.git_origin_url || null,
    rawSource: fileContext.rawSource || stateRow?.source || null,
    serviceTier: fileContext.serviceTier,
  };
}

function rememberQuota(quotaMap, rateLimits, occurrence) {
  // rate_limits payloads come straight from JSONL. Read the named fields
  // once; records without usable buckets drop out via the filter below.
  const {
    primary,
    secondary,
    limit_id: limitId,
    limit_name: limitName,
    plan_type: planType,
  } = rateLimits ?? {};
  const buckets = [primary, secondary].filter(Boolean);
  for (const bucket of buckets) {
    const windowMinutes = asFiniteNumber(bucket.window_minutes);
    const usedPercent = asFiniteNumber(bucket.used_percent);
    const resetsAt = asFiniteNumber(bucket.resets_at);
    if (!windowMinutes || !resetsAt) continue;
    const limitKey = String(limitId || limitName || "anonymous");
    const key = [
      hash(limitKey, 16),
      windowMinutes,
      resetsAt,
      usedPercent,
    ].join("|");
    const candidate = {
      id: `quota-${hash(key)}`,
      // Keep the first and last occurrence of an unchanged reading without
      // storing every repeated provider sample in the snapshot.
      timestamp: occurrence.timestamp,
      lastSeenAt: occurrence.timestamp,
      usedPercent,
      windowMinutes,
      resetsAt,
      planType: String(planType || "unknown"),
      limitKey: hash(limitKey, 16),
      limitName: limitName ? String(limitName).slice(0, 80) : null,
      source: "log",
      turnId: occurrence.turnId || null,
      originalLikely: occurrence.originalLikely,
    };
    const current = quotaMap.get(key);
    if (
      !current ||
      (!current.originalLikely && candidate.originalLikely)
    ) {
      quotaMap.set(key, candidate);
    } else if (current.originalLikely === candidate.originalLikely) {
      quotaMap.set(key, {
        ...current,
        timestamp:
          candidate.timestamp < current.timestamp
            ? candidate.timestamp
            : current.timestamp,
        lastSeenAt:
          candidate.timestamp > current.lastSeenAt
            ? candidate.timestamp
            : current.lastSeenAt,
      });
    }
  }
}

function responseCall(record) {
  if (record.type !== "response_item") return null;
  const payload = record.payload;
  if (!payload || !RELEVANT_CALL_TYPES.has(payload.type)) return null;
  return {
    type: payload.type,
    name: String(payload.name || payload.namespace || payload.type).slice(0, 80),
    stableId: payload.call_id || payload.id || null,
  };
}

function inspectJsonLine(line) {
  let index = 0;
  let topType = { kind: "absent" };
  let payloadType = { kind: "absent" };

  function skipWhitespace() {
    while (
      line[index] === " " ||
      line[index] === "\t" ||
      line[index] === "\n" ||
      line[index] === "\r"
    ) {
      index += 1;
    }
  }

  function parseString() {
    if (line[index] !== '"') return { valid: false };
    index += 1;
    const start = index;
    let simple = true;
    while (index < line.length) {
      const code = line.charCodeAt(index);
      if (code === 34) {
        const value = simple ? line.slice(start, index) : null;
        index += 1;
        return { valid: true, simple, value };
      }
      if (code === 92) {
        simple = false;
        index += 1;
        if (index >= line.length) return { valid: false };
        if (line[index] === "u") {
          if (!/^[0-9a-f]{4}$/i.test(line.slice(index + 1, index + 5))) {
            return { valid: false };
          }
          index += 5;
        } else if ('"\\/bfnrt'.includes(line[index])) {
          index += 1;
        } else {
          return { valid: false };
        }
        continue;
      }
      if (code < 0x20) return { valid: false };
      index += 1;
    }
    return { valid: false };
  }

  function parseNumber() {
    const start = index;
    if (line[index] === "-") index += 1;
    if (line[index] === "0") {
      index += 1;
    } else if (line[index] >= "1" && line[index] <= "9") {
      while (line[index] >= "0" && line[index] <= "9") index += 1;
    } else {
      return false;
    }
    if (line[index] === ".") {
      index += 1;
      const fractionStart = index;
      while (line[index] >= "0" && line[index] <= "9") index += 1;
      if (index === fractionStart) return false;
    }
    if (line[index] === "e" || line[index] === "E") {
      index += 1;
      if (line[index] === "+" || line[index] === "-") index += 1;
      const exponentStart = index;
      while (line[index] >= "0" && line[index] <= "9") index += 1;
      if (index === exponentStart) return false;
    }
    return index > start;
  }

  function parseLiteral(value) {
    if (line.slice(index, index + value.length) !== value) return false;
    index += value.length;
    return true;
  }

  function captureValue() {
    if (line[index] === '"') {
      const result = parseString();
      if (!result.valid) return { valid: false };
      return result.simple
        ? { valid: true, kind: "string", value: result.value }
        : { valid: true, kind: "unknown" };
    }
    return parseValue()
      ? { valid: true, kind: "other" }
      : { valid: false };
  }

  function rememberType(current, captured) {
    if (current.kind === "unknown") return current;
    return captured.kind === "unknown"
      ? { kind: "unknown" }
      : captured.kind === "string"
        ? { kind: "string", value: captured.value }
        : { kind: "other" };
  }

  function parseObject(scope = "generic") {
    if (line[index] !== "{") return false;
    index += 1;
    skipWhitespace();
    if (line[index] === "}") {
      index += 1;
      return true;
    }
    while (index < line.length) {
      const key = parseString();
      if (!key.valid) return false;
      skipWhitespace();
      if (line[index] !== ":") return false;
      index += 1;
      skipWhitespace();

      if (scope === "top" && !key.simple) {
        topType = { kind: "unknown" };
        payloadType = { kind: "unknown" };
      }
      if (scope === "payload" && !key.simple) {
        payloadType = { kind: "unknown" };
      }

      if (scope === "top" && key.simple && key.value === "type") {
        const captured = captureValue();
        if (!captured.valid) return false;
        topType = rememberType(topType, captured);
      } else if (scope === "top" && key.simple && key.value === "payload") {
        if (line[index] === "{") {
          if (!parseObject("payload")) return false;
          if (payloadType.kind === "absent") {
            payloadType = { kind: "other" };
          }
        } else {
          const captured = captureValue();
          if (!captured.valid) return false;
          payloadType = { kind: "other" };
        }
      } else if (scope === "payload" && key.simple && key.value === "type") {
        const captured = captureValue();
        if (!captured.valid) return false;
        payloadType = rememberType(payloadType, captured);
      } else if (!parseValue()) {
        return false;
      }

      skipWhitespace();
      if (line[index] === "}") {
        index += 1;
        return true;
      }
      if (line[index] !== ",") return false;
      index += 1;
      skipWhitespace();
    }
    return false;
  }

  function parseArray() {
    if (line[index] !== "[") return false;
    index += 1;
    skipWhitespace();
    if (line[index] === "]") {
      index += 1;
      return true;
    }
    while (index < line.length) {
      if (!parseValue()) return false;
      skipWhitespace();
      if (line[index] === "]") {
        index += 1;
        return true;
      }
      if (line[index] !== ",") return false;
      index += 1;
      skipWhitespace();
    }
    return false;
  }

  function parseValue() {
    if (line[index] === '"') return parseString().valid;
    if (line[index] === "{") return parseObject();
    if (line[index] === "[") return parseArray();
    if (line[index] === "t") return parseLiteral("true");
    if (line[index] === "f") return parseLiteral("false");
    if (line[index] === "n") return parseLiteral("null");
    return parseNumber();
  }

  skipWhitespace();
  if (line[index] !== "{" || !parseObject("top")) return null;
  skipWhitespace();
  if (index !== line.length) return null;
  return { topType, payloadType };
}

function lineMayAffectUsage(line) {
  const inspected = inspectJsonLine(line);
  if (!inspected) return true;
  if (inspected.topType.kind === "unknown") return true;
  if (inspected.topType.kind !== "string") return false;
  if (inspected.topType.value === "session_meta") return true;
  if (inspected.topType.value === "turn_context") return true;
  if (inspected.topType.value === "event_msg") {
    return (
      inspected.payloadType.kind === "unknown" ||
      (inspected.payloadType.kind === "string" &&
        RELEVANT_EVENT_TYPES.has(inspected.payloadType.value))
    );
  }
  if (inspected.topType.value === "response_item") {
    return (
      inspected.payloadType.kind === "unknown" ||
      (inspected.payloadType.kind === "string" &&
        RELEVANT_CALL_TYPES.has(inspected.payloadType.value))
    );
  }
  return false;
}

async function scanRollout(path, stateRows, signal) {
  const match = path.match(UUID_AT_END);
  const threadId = match?.[1] || `file-${hash(path)}`;
  const stateRow = stateRows.get(threadId);
  const fileContext = {
    model: stateRow?.model || "unknown",
    effort: stateRow?.reasoning_effort || "unknown",
    cwd: stateRow?.cwd || "",
    gitOrigin: stateRow?.git_origin_url || null,
    rawSource: stateRow?.source || null,
    serviceTier: null,
  };
  const callOrdinals = new Map();
  let currentTurnId = "";
  let currentCandidate = null;
  let previousCumulative = null;
  const operations = [];
  let parseErrors = 0;
  let correctionIntervals = 0;

  const input = createReadStream(path, { encoding: "utf8", signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim() || !lineMayAffectUsage(line)) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        parseErrors += 1;
        continue;
      }

      if (record.type === "session_meta") {
        const payload = record.payload;
        if (payload?.id === threadId) {
          fileContext.cwd = payload.cwd || fileContext.cwd;
          fileContext.gitOrigin =
            payload.git?.repository_url || fileContext.gitOrigin;
          fileContext.rawSource = payload.source || fileContext.rawSource;
          if (payload.parent_thread_id || payload.forked_from_id) {
            operations.push({
              kind: "parent",
              threadId,
              parentThreadId: String(
                payload.parent_thread_id || payload.forked_from_id,
              ),
            });
          }
          const spawnedParent =
            payload.source?.subagent?.thread_spawn?.parent_thread_id;
          if (spawnedParent) {
            operations.push({
              kind: "parent",
              threadId,
              parentThreadId: String(spawnedParent),
            });
          }
        }
        continue;
      }

      if (record.type === "event_msg" && record.payload?.type === "task_started") {
        currentTurnId = String(record.payload.turn_id || currentTurnId || "");
        if (currentTurnId) {
          currentCandidate = taskStartCandidate(
            record,
            threadId,
            stateRow,
            fileContext,
          );
          operations.push({
            kind: "origin",
            candidate: { ...currentCandidate },
          });
        }
        continue;
      }

      if (record.type === "turn_context") {
        currentTurnId = String(record.payload?.turn_id || currentTurnId || "");
        fileContext.model = record.payload?.model || fileContext.model;
        fileContext.effort = record.payload?.effort || fileContext.effort;
        fileContext.cwd = record.payload?.cwd || fileContext.cwd;
        if (currentCandidate?.turnId === currentTurnId) {
          currentCandidate.model = fileContext.model;
          currentCandidate.effort = fileContext.effort;
          currentCandidate.cwd = fileContext.cwd;
          operations.push({
            kind: "origin_update",
            turnId: currentTurnId,
            model: fileContext.model,
            effort: fileContext.effort,
            cwd: fileContext.cwd,
          });
        }
        continue;
      }

      if (
        record.type === "event_msg" &&
        record.payload?.type === "thread_settings_applied"
      ) {
        const settings = record.payload?.thread_settings;
        fileContext.model = settings?.model || fileContext.model;
        fileContext.effort = settings?.reasoning_effort || fileContext.effort;
        const serviceTier = String(settings?.service_tier ?? "").trim();
        fileContext.serviceTier = serviceTier
          ? serviceTier.slice(0, 40)
          : null;
        continue;
      }

      const originalLikely = Boolean(currentCandidate?.deltaMs <= 2_000);
      const occurrence = {
        threadId,
        turnId: currentTurnId,
        timestamp: safeIso(
          record.timestamp,
          currentCandidate?.timestamp || new Date(0).toISOString(),
        ),
        originalLikely,
        model: fileContext.model,
        effort: fileContext.effort,
        cwd: fileContext.cwd,
        gitOrigin: fileContext.gitOrigin,
        rawSource: fileContext.rawSource,
        serviceTier: fileContext.serviceTier,
      };

      const call = responseCall(record);
      if (call) {
        const ordinalBase = `${currentTurnId}|${call.type}|${call.name}`;
        const ordinal = (callOrdinals.get(ordinalBase) || 0) + 1;
        callOrdinals.set(ordinalBase, ordinal);
        const callKey = call.stableId
          ? `id|${call.stableId}`
          : `ordinal|${ordinalBase}|${ordinal}`;
        operations.push({
          kind: "call",
          callKey,
          turnId: currentTurnId,
          threadId,
          originalLikely,
        });
        continue;
      }

      if (record.type !== "event_msg" || record.payload?.type !== "token_count") {
        continue;
      }

      const info = record.payload.info;
      operations.push({
        kind: "quota",
        rateLimits: record.payload.rate_limits,
        occurrence,
      });
      if (!info?.last_token_usage) continue;

      const totalTuple = tokenTuple(info.total_token_usage);
      const lastTuple = tokenTuple(info.last_token_usage);
      if (lastTuple[5] <= 0) continue;
      const contextWindow = asFiniteNumber(info.model_context_window);
      const eventKey = currentTurnId
        ? JSON.stringify([
            currentTurnId,
            totalTuple,
            lastTuple,
            contextWindow,
          ])
        : JSON.stringify(["legacy", totalTuple, lastTuple, contextWindow]);

      if (
        previousCumulative !== null &&
        totalTuple[5] < previousCumulative
      ) {
        correctionIntervals += 1;
      }
      previousCumulative = totalTuple[5];

      operations.push({
        kind: "token",
        eventKey,
        turnId: currentTurnId,
        usage: usageFromTuple(lastTuple),
        occurrence,
        originalLikely,
      });
    }
  } finally {
    lines.close();
  }
  return { path, operations, parseErrors, correctionIntervals };
}

function threadMetadata(threadId, stateRows, titles, parents, fallback = {}) {
  const row = stateRows.get(threadId);
  const sessionTitle = titles.get(threadId)?.title;
  const labels = sourceLabels(
    row?.thread_source,
    fallback.rawSource || row?.source,
  );
  return {
    id: threadId,
    title: safeTitle(row, sessionTitle),
    project: projectLabel(
      fallback.cwd || row?.cwd,
      fallback.gitOrigin || row?.git_origin_url,
    ),
    model: normalizeModel(fallback.model || row?.model || "unknown"),
    effort: String(
      fallback.effort || row?.reasoning_effort || "unknown",
    ).slice(0, 40),
    source: labels.source,
    useType: labels.useType,
    parentThreadId: parents.get(threadId) || null,
    reportedCumulativeTokens:
      row && row.tokens_used !== null
        ? asFiniteNumber(row.tokens_used)
        : null,
    createdAt: isoFromEpoch(row?.created_at),
    updatedAt: isoFromEpoch(row?.updated_at),
  };
}

function resolvedOccurrence(token) {
  const origin = token.originThreadId == null
    ? null
    : {
        threadId: token.originThreadId,
        timestamp: token.originTimestamp,
        model: token.originModel,
        effort: token.originEffort,
        cwd: token.originCwd,
        gitOrigin: token.originGitOrigin,
        rawSource: token.originRawSource,
        serviceTier: token.originServiceTier,
      };
  const occurrence = token.originalLikely || !origin ? token : origin;
  return {
    origin,
    occurrence,
    threadId: origin?.threadId || occurrence.threadId,
    timestamp: token.timestamp || origin?.timestamp,
  };
}

function newThreadAggregate(metadata, timestamp) {
  return {
    metadata,
    firstActiveAt: timestamp,
    lastActiveAt: timestamp,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    detailedTokens: 0,
    unknownBreakdownTokens: 0,
    rateCardCredits: 0,
    ratedTokens: 0,
    eventCount: 0,
  };
}

function addToThreadAggregate(aggregate, event) {
  aggregate.lastActiveAt = event.timestamp;
  aggregate.inputTokens += event.inputTokens;
  aggregate.cachedInputTokens += event.cachedInputTokens;
  aggregate.outputTokens += event.outputTokens;
  aggregate.reasoningTokens += event.reasoningTokens;
  aggregate.totalTokens += event.totalTokens;
  aggregate.toolCalls += event.toolCalls;
  aggregate.eventCount += 1;
  if (event.breakdownAvailable) {
    aggregate.detailedTokens += event.totalTokens;
  } else {
    aggregate.unknownBreakdownTokens += event.totalTokens;
  }
  if (event.rateCardCredits !== null) {
    aggregate.rateCardCredits += event.rateCardCredits;
    aggregate.ratedTokens += event.totalTokens;
  }
}

function buildSnapshot(context, options, titles) {
  context.spool.finishWrites();
  const sinceMs = options.since ? options.since.getTime() : -Infinity;
  const lastEventKeyByTurn = new Map();
  let earliestEventAt = null;
  let latestEventAt = null;

  // The spool is ordered on disk. This lightweight pass finds the event that
  // receives each turn's tool calls without retaining the usage rows.
  for (const token of context.spool.tokenRows()) {
    const { threadId, timestamp } = resolvedOccurrence(token);
    if (Date.parse(timestamp) < sinceMs) continue;
    earliestEventAt ||= timestamp;
    latestEventAt = timestamp;
    const key = token.turnId || `thread:${threadId}`;
    lastEventKeyByTurn.set(key, token.eventKey);
  }

  const toolCounts = new Map();
  for (const call of context.spool.callRows()) {
    const key = call.turnId || `thread:${call.threadId}`;
    toolCounts.set(key, (toolCounts.get(key) || 0) + 1);
  }

  const threadAggregates = new Map();
  let observedTokens = 0;
  let detailedTokens = 0;
  let legacyHeuristicEvents = 0;
  let observedModelCalls = 0;

  function* compactableEvents() {
    for (const token of context.spool.tokenRows()) {
      const { origin, occurrence, threadId, timestamp } = resolvedOccurrence(token);
      if (Date.parse(timestamp) < sinceMs) continue;
      const metadata = threadMetadata(
        threadId,
        context.stateRows,
        titles,
        context.parents,
        origin || occurrence,
      );
      const usage = {
        inputTokens: Number(token.inputTokens),
        cachedInputTokens: Number(token.cachedInputTokens),
        cacheWriteInputTokens: Number(token.cacheWriteInputTokens),
        outputTokens: Number(token.outputTokens),
        reasoningTokens: Number(token.reasoningTokens),
        totalTokens: Number(token.totalTokens),
      };
      const breakdownAvailable = hasDetailedBreakdown(usage);
      const serviceTier = occurrence.serviceTier || null;
      const baseCredits = creditsForUsage(metadata.model, usage);
      const turnKey = token.turnId || `thread:${threadId}`;
      const event = {
        ...usage,
        timestamp,
        threadId,
        project: metadata.project,
        model: metadata.model,
        effort: metadata.effort,
        source: metadata.source,
        useType: metadata.useType,
        toolCalls:
          lastEventKeyByTurn.get(turnKey) === token.eventKey
            ? toolCounts.get(turnKey) || 0
            : 0,
        serviceTier,
        rateCardCredits:
          baseCredits === null
            ? null
            : serviceTier === "priority"
              ? baseCredits * FAST_MODE_MULTIPLIER
              : baseCredits,
        breakdownAvailable,
      };

      let aggregate = threadAggregates.get(threadId);
      if (!aggregate) {
        aggregate = newThreadAggregate(metadata, timestamp);
        threadAggregates.set(threadId, aggregate);
      }
      addToThreadAggregate(aggregate, event);
      observedTokens += event.totalTokens;
      if (breakdownAvailable) detailedTokens += event.totalTokens;
      if (!token.turnId) legacyHeuristicEvents += 1;
      observedModelCalls += 1;
      yield event;
    }
  }

  const usageBuckets = buildUsageBuckets(compactableEvents(), {
    latestTimestampMs: latestEventAt ? Date.parse(latestEventAt) : 0,
  });
  const usageStats = usageBucketStats(usageBuckets);
  toolCounts.clear();
  lastEventKeyByTurn.clear();

  const allThreadIds = new Set(context.stateRows.keys());
  for (const threadId of threadAggregates.keys()) allThreadIds.add(threadId);
  const threads = [];
  for (const threadId of allThreadIds) {
    const aggregate = threadAggregates.get(threadId);
    const metadata = aggregate?.metadata || threadMetadata(
      threadId,
      context.stateRows,
      titles,
      context.parents,
    );
    if (!aggregate && !(metadata.reportedCumulativeTokens > 0)) continue;
    const eventCount = aggregate?.eventCount || 0;
    const threadCoverage =
      eventCount === 0
        ? "unresolved"
        : aggregate.detailedTokens === aggregate.totalTokens
          ? "complete"
          : aggregate.detailedTokens > 0
            ? "partial"
            : "total-only";
    threads.push({
      id: threadId,
      title: metadata.title,
      project: metadata.project,
      model: metadata.model,
      effort: metadata.effort,
      source: metadata.source,
      useType: metadata.useType,
      parentThreadId: metadata.parentThreadId,
      firstActiveAt: aggregate?.firstActiveAt || metadata.createdAt,
      lastActiveAt: aggregate?.lastActiveAt || metadata.updatedAt,
      totalTokens: aggregate?.totalTokens || 0,
      detailedTokens: aggregate?.detailedTokens || 0,
      unknownBreakdownTokens: aggregate?.unknownBreakdownTokens || 0,
      reportedCumulativeTokens: metadata.reportedCumulativeTokens,
      inputTokens: aggregate?.inputTokens || 0,
      cachedInputTokens: aggregate?.cachedInputTokens || 0,
      outputTokens: aggregate?.outputTokens || 0,
      reasoningTokens: aggregate?.reasoningTokens || 0,
      rateCardCredits:
        aggregate?.totalTokens > 0 &&
        aggregate.ratedTokens === aggregate.totalTokens
          ? aggregate.rateCardCredits
          : null,
      ratedTokens: aggregate?.ratedTokens || 0,
      toolCalls: aggregate?.toolCalls || 0,
      eventCount,
      coverage: threadCoverage,
    });
  }
  threads.sort((left, right) => right.totalTokens - left.totalTokens);
  threadAggregates.clear();
  allThreadIds.clear();
  context.stateRows.clear();
  context.parents.clear();

  const quotas = [...context.quotas.values()]
    .map((quota) => {
      const exported = { ...quota };
      delete exported.turnId;
      delete exported.originalLikely;
      return exported;
    })
    .filter((quota) => {
      if (!options.since) return true;
      return Date.parse(quota.lastSeenAt) >= sinceMs;
    })
    .sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    );

  const unknownBreakdownTokens = observedTokens - detailedTokens;
  const stateCounterSumNonAdditive = threads.reduce(
    (sum, thread) => sum + (thread.reportedCumulativeTokens || 0),
    0,
  );
  const unresolvedThreadCounters = threads.filter(
    (thread) =>
      thread.coverage === "unresolved" &&
      (thread.reportedCumulativeTokens || 0) > 0,
  ).length;
  const weeklyCandidates = quotas.filter(
    (quota) => quota.windowMinutes === WEEK_MINUTES,
  );
  const accountWideWeekly = weeklyCandidates.filter(
    (quota) => !quota.limitName,
  );
  const weekly = [
    ...(accountWideWeekly.length ? accountWideWeekly : weeklyCandidates),
  ]
    .sort(
      (left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt),
    )[0];
  const weeklyStart = weekly
    ? (weekly.resetsAt - weekly.windowMinutes * 60) * 1_000
    : null;
  const completeSinceWindowStart = Boolean(
    weeklyStart &&
      earliestEventAt &&
      Date.parse(earliestEventAt) <= weeklyStart &&
      context.parseErrors === 0,
  );

  const notes = [
    "Observed totals sum globally de-duplicated last_token_usage model-call events.",
    "The snapshot keeps exact recent calls and compacts older usage into time buckets; token, cache, model, project, tool-call, and thread totals remain additive.",
    "Codex thread counters are retained only as non-additive reference values because forks and subagents inherit cumulative history.",
    "Historical rollout files can be pruned; a state-only counter cannot reveal that thread's unique token contribution.",
    "Legacy events without turn IDs use a high-specificity usage-signature heuristic and are labeled in the ledger.",
  ];

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    label: "Local Codex snapshot",
    provenance: {
      kind: "codex-local-metadata",
      privacy:
        "Contains token metadata and Codex display titles only; credential fields, message bodies, reasoning text, tool payloads, and full local paths are not exported. Display titles may contain user-written text.",
      rateCardAsOf: RATE_CARD_AS_OF,
      rateCardUrl: RATE_CARD_URL,
    },
    coverage: {
      filesScanned: context.filesScanned,
      bytesScanned: context.bytesScanned,
      parseErrors: context.parseErrors,
      duplicateEventsSkipped: context.duplicateEventsSkipped,
      correctionIntervals: context.correctionIntervals,
      observedTokens,
      detailedTokens,
      unknownBreakdownTokens,
      stateCounterSumNonAdditive,
      unresolvedThreadCounters,
      legacyHeuristicEvents,
      observedModelCalls,
      usageBucketCount: usageStats.bucketCount,
      maximumUsageResolutionSeconds: usageStats.maximumResolutionSeconds,
      detailedPercent:
        observedTokens > 0 ? (detailedTokens / observedTokens) * 100 : 100,
      earliestEventAt,
      latestEventAt,
      completeSinceWindowStart,
      notes,
    },
    quotaObservations: quotas,
    threads,
    events: usageBuckets,
  };
}

function createCollectionContext(state, spool) {
  return {
    stateRows: state.rows,
    parents: state.parents,
    quotas: new Map(),
    spool,
    filesScanned: 0,
    bytesScanned: 0,
    parseErrors: 0,
    duplicateEventsSkipped: 0,
    correctionIntervals: 0,
  };
}

function reduceScanResult(result, context) {
  let currentCandidate = null;
  let currentCandidateSelected = false;
  for (const operation of result.operations) {
    if (operation.kind === "parent") {
      context.parents.set(operation.threadId, operation.parentThreadId);
      continue;
    }
    if (operation.kind === "origin") {
      currentCandidate = operation.candidate;
      currentCandidateSelected = context.spool.insertOrigin(currentCandidate);
      continue;
    }
    if (operation.kind === "origin_update") {
      if (currentCandidate?.turnId === operation.turnId) {
        currentCandidate.model = operation.model;
        currentCandidate.effort = operation.effort;
        currentCandidate.cwd = operation.cwd;
        if (currentCandidateSelected) {
          context.spool.updateOrigin(currentCandidate);
        }
      }
      continue;
    }
    if (operation.kind === "quota") {
      rememberQuota(context.quotas, operation.rateLimits, operation.occurrence);
      continue;
    }
    if (operation.kind === "call") {
      context.spool.insertCall(
        operation.callKey,
        operation.turnId,
        operation.threadId,
        operation.originalLikely,
      );
      continue;
    }
    if (operation.kind === "token") {
      const inserted = context.spool.insertToken(
        operation.eventKey,
        operation.turnId,
        operation.usage,
        operation.occurrence,
        operation.originalLikely,
      );
      if (!inserted) context.duplicateEventsSkipped += 1;
      continue;
    }
    throw new Error(`Unknown rollout operation: ${operation.kind}`);
  }
  context.parseErrors += result.parseErrors;
  context.correctionIntervals += result.correctionIntervals;
}

function createProgressReporter(files, onProgress) {
  const completed = Array.from({ length: files.length }, () => false);
  let flushed = 0;
  return (index) => {
    completed[index] = true;
    while (completed[flushed]) {
      const current = flushed + 1;
      flushed += 1;
      if (
        current === 1 ||
        current === files.length ||
        current % 10 === 0
      ) {
        onProgress({ current, total: files.length, path: files[current - 1] });
      }
    }
  };
}

function workerError(error) {
  const result = new Error(error?.message || "Rollout worker failed.");
  result.name = error?.name || "Error";
  if (error?.code) result.code = error.code;
  if (error?.stack) result.stack = error.stack;
  return result;
}

async function scanFilesSequential(files, stateRows, onProgress, onResult) {
  const reportCompleted = createProgressReporter(files, onProgress);
  for (let index = 0; index < files.length; index += 1) {
    const result = await scanRollout(files[index], stateRows);
    await onResult(result, index);
    reportCompleted(index);
  }
}

async function scanFilesWithWorkers(
  files,
  stateRows,
  concurrency,
  onProgress,
  onResult,
) {
  const reportCompleted = createProgressReporter(files, onProgress);
  const workerCount = Math.min(concurrency, files.length);
  const maxReorderWindow = Math.max(1, concurrency * 2);
  const stateEntries = [...stateRows.entries()];
  const workers = [];
  try {
    for (let index = 0; index < workerCount; index += 1) {
      workers.push(
        new Worker(new URL(import.meta.url), {
          type: "module",
          workerData: {
            tokenLedgerImporterWorker: true,
            stateEntries,
          },
          execArgv: ["--no-warnings"],
        }),
      );
    }
  } catch (error) {
    await Promise.all(workers.map((worker) => worker.terminate()));
    throw error;
  }

  let nextIndex = 0;
  let completedCount = 0;
  let closed = false;
  const assignments = new Map();
  const pendingResults = new Map();
  let nextResultIndex = 0;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  function close(error = null) {
    if (closed) return;
    closed = true;
    Promise.all(workers.map((worker) => worker.terminate())).then(
      () => {
        if (error) rejectDone(error);
        else resolveDone();
      },
      (terminationError) => rejectDone(error || terminationError),
    );
  }

  function dispatch(worker) {
    if (closed || nextIndex >= files.length) return;
    const index = nextIndex;
    nextIndex += 1;
    assignments.set(worker, index);
    try {
      worker.postMessage({ index, path: files[index] });
    } catch (error) {
      close(error);
    }
  }

  function flushResults() {
    while (pendingResults.has(nextResultIndex)) {
      const result = pendingResults.get(nextResultIndex);
      pendingResults.delete(nextResultIndex);
      onResult(result, nextResultIndex);
      nextResultIndex += 1;
    }
  }

  function dispatchAvailable() {
    while (
      !closed &&
      nextIndex < files.length &&
      nextIndex - nextResultIndex < maxReorderWindow
    ) {
      const worker = workers.find((candidate) => !assignments.has(candidate));
      if (!worker) return;
      dispatch(worker);
    }
  }

  for (const worker of workers) {
    worker.on("message", (message) => {
      if (closed) return;
      const expectedIndex = assignments.get(worker);
      if (expectedIndex !== message.index) {
        close(new Error("Rollout worker returned an unexpected file index."));
        return;
      }
      assignments.delete(worker);
      if (message.error) {
        close(workerError(message.error));
        return;
      }
      pendingResults.set(message.index, message.result);
      try {
        reportCompleted(message.index);
        flushResults();
      } catch (error) {
        close(error);
        return;
      }
      completedCount += 1;
      if (completedCount === files.length) {
        close();
      } else {
        dispatchAvailable();
      }
    });
    worker.on("error", (error) => close(error));
    worker.on("exit", (code) => {
      if (!closed) {
        close(
          new Error(
            `Rollout worker exited before completing its scan (code ${code}).`,
          ),
        );
      }
    });
  }
  dispatchAvailable();
  return done;
}

async function scanFiles(files, stateRows, concurrency, onProgress, onResult) {
  if (!files.length) return;
  if (concurrency <= 1) {
    return scanFilesSequential(files, stateRows, onProgress, onResult);
  }
  return scanFilesWithWorkers(
    files,
    stateRows,
    concurrency,
    onProgress,
    onResult,
  );
}

async function collectUsageWithConcurrency(
  options,
  onProgress,
  concurrency,
) {
  const state = await readState(options.codexHome);
  const titles = await readSessionTitles(
    resolve(options.codexHome, "session_index.jsonl"),
  );
  const roots = [resolve(options.codexHome, "sessions")];
  if (options.includeArchived) {
    roots.push(resolve(options.codexHome, "archived_sessions"));
  }
  const files = (
    await Promise.all(roots.map((root) => listJsonlFiles(root)))
  )
    .flat()
    .sort();
  const sizes = await Promise.all(files.map((path) => stat(path)));
  const spool = await createUsageSpool();
  const context = createCollectionContext(state, spool);

  try {
    await scanFiles(
      files,
      state.rows,
      concurrency,
      onProgress,
      (result, index) => {
        reduceScanResult(result, context);
        context.filesScanned += 1;
        context.bytesScanned += sizes[index].size;
      },
    );
    return buildSnapshot(context, options, titles);
  } finally {
    spool.close();
    await rm(spool.directory, { recursive: true, force: true });
  }
}

export async function collectUsage(options, onProgress = () => {}) {
  return collectUsageWithConcurrency(options, onProgress, SCAN_CONCURRENCY);
}

export async function collectUsageSequential(options, onProgress = () => {}) {
  return collectUsageWithConcurrency(options, onProgress, 1);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!(await pathExists(options.codexHome))) {
    throw new Error(`Codex data directory not found: ${options.codexHome}`);
  }

  process.stdout.write("Token Ledger: scanning local Codex metadata…\n");
  const snapshot = await collectUsage(options, ({ current, total }) => {
    process.stdout.write(
      `\rToken Ledger: scanned ${current.toLocaleString()}/${total.toLocaleString()} rollout files`,
    );
  });
  process.stdout.write("\nToken Ledger: writing privacy-reduced snapshot…\n");
  const writeResult = await writePrivateSnapshot(options.output, snapshot);
  const storedSnapshot = writeResult.snapshot;
  process.stdout.write(
    [
      `Snapshot: ${options.output}`,
      `Observed model-call tokens: ${storedSnapshot.coverage.observedTokens.toLocaleString()}`,
      `Unique model calls: ${storedSnapshot.coverage.observedModelCalls.toLocaleString()}`,
      `Stored usage buckets: ${storedSnapshot.events.length.toLocaleString()}`,
      `Duplicate/copied events skipped: ${storedSnapshot.coverage.duplicateEventsSkipped.toLocaleString()}`,
      `Threads with unresolved state-only counters: ${storedSnapshot.coverage.unresolvedThreadCounters.toLocaleString()}`,
      `Snapshot size: ${(writeResult.bytesWritten / 1_000_000).toFixed(1)} MB (${writeResult.encoding}; ${(writeResult.jsonBytes / 1_000_000).toFixed(1)} MB JSON before encoding)`,
      `Snapshot safety limit: ${(writeResult.maxBytes / 1_000_000).toFixed(1)} MB`,
    ].join("\n") + "\n",
  );
}

if (!isMainThread && workerData?.tokenLedgerImporterWorker && parentPort) {
  const workerStateRows = new Map(workerData.stateEntries);
  parentPort.on("message", async ({ index, path }) => {
    try {
      const result = await scanRollout(path, workerStateRows);
      parentPort.postMessage({ index, result });
    } catch (error) {
      parentPort.postMessage({
        index,
        error: {
          name: error?.name,
          message: error?.message || String(error),
          stack: error?.stack,
          code: error?.code,
        },
      });
    }
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (isMainThread && import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(
      `Token Ledger collector failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
