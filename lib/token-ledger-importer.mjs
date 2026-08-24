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

import { writePrivateSnapshot } from "./token-ledger-snapshot.mjs";
import {
  buildUsageBuckets,
  checkedFiniteAdd,
  checkedTokenPartitionAdd,
  checkedTokenAdd,
  isValidTokenValue,
  MAX_SAFE_TOKEN_COUNT,
  SNAPSHOT_SCHEMA_VERSION,
  tokenValue,
  usageBucketStats,
} from "./token-ledger-usage.mjs";

const RATE_CARD_AS_OF = "2026-08-17";
const FAST_MODE_MULTIPLIER = 1.5;
const RATE_CARD_URL = "https://help.openai.com/en/articles/20001106";
const WEEK_MINUTES = 10_080;
const UUID_AT_END =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

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
      components_valid INTEGER NOT NULL,
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
      total_tokens, components_valid, timestamp, thread_id, model, effort, cwd,
      git_origin, raw_source, service_tier, original_likely
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        usage.componentsValid ? 1 : 0,
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
               token.components_valid AS componentsValid,
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
  // token_count payloads arrive from untrusted JSONL. Token counts are kept
  // only when they are primitive, non-negative safe integers. Invalid
  // components become unknown breakdown values; the total is validated by the
  // caller before the record enters the usage spool.
  const {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    cache_write_input_tokens: cacheWriteInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    total_tokens: totalTokens,
  } = value ?? {};
  const rawValues = [
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  ];
  return {
    values: rawValues.map((value) => tokenValue(value)),
    valid: rawValues.map((value, index) =>
      index < 5 && value === undefined
        ? true
        : isValidTokenValue(value)),
  };
}

function usageFromTuple(tuple) {
  // Cached input is a subset of input and reasoning is a subset of output.
  // Clamp at export so one out-of-range source record cannot skew subset
  // math downstream.
  const inputTokens = tuple.values[0];
  const outputTokens = tuple.values[3];
  return {
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, tuple.values[1]),
    cacheWriteInputTokens: tuple.values[2],
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tuple.values[4]),
    totalTokens: tuple.values[5],
    componentsValid: tuple.valid.slice(0, -1).every(Boolean),
  };
}

function hasDetailedBreakdown(usage) {
  if (!usage.componentsValid) return false;
  if (usage.totalTokens === 0) return true;
  const componentTotal = usage.inputTokens + usage.outputTokens;
  return (
    Number.isSafeInteger(componentTotal) &&
    componentTotal === usage.totalTokens &&
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
  const allowed = new Set([
    "function_call",
    "custom_tool_call",
    "tool_search_call",
    "web_search_call",
    "image_generation_call",
  ]);
  if (!payload || !allowed.has(payload.type)) return null;
  return {
    type: payload.type,
    name: String(payload.name || payload.namespace || payload.type).slice(0, 80),
    stableId: payload.call_id || payload.id || null,
  };
}

async function scanRollout(path, context) {
  const match = path.match(UUID_AT_END);
  const threadId = match?.[1] || `file-${hash(path)}`;
  const stateRow = context.stateRows.get(threadId);
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
  let currentCandidateSelected = false;
  let previousCumulative = null;

  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      context.parseErrors += 1;
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
          context.parents.set(
            threadId,
            String(payload.parent_thread_id || payload.forked_from_id),
          );
        }
        const spawnedParent =
          payload.source?.subagent?.thread_spawn?.parent_thread_id;
        if (spawnedParent) context.parents.set(threadId, String(spawnedParent));
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
        currentCandidateSelected = context.spool.insertOrigin(currentCandidate);
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
        if (currentCandidateSelected) {
          context.spool.updateOrigin(currentCandidate);
        }
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
      context.spool.insertCall(
        callKey,
        currentTurnId,
        threadId,
        originalLikely,
      );
      continue;
    }

    if (record.type !== "event_msg" || record.payload?.type !== "token_count") {
      continue;
    }

    rememberQuota(context.quotas, record.payload.rate_limits, occurrence);
    const info = record.payload.info;
    if (info?.last_token_usage === undefined) continue;

    const totalTuple = tokenTuple(info.total_token_usage);
    const lastTuple = tokenTuple(info.last_token_usage);
    if (!lastTuple.valid[5]) {
      context.invalidTokenRecords += 1;
      continue;
    }
    if (lastTuple.values[5] <= 0) continue;
    const contextWindow = asFiniteNumber(info.model_context_window);
    const eventKey = currentTurnId
      ? JSON.stringify([
          currentTurnId,
          totalTuple.values,
          totalTuple.valid,
          lastTuple.values,
          lastTuple.valid,
          contextWindow,
        ])
      : JSON.stringify([
          "legacy",
          totalTuple.values,
          totalTuple.valid,
          lastTuple.values,
          lastTuple.valid,
          contextWindow,
        ]);

    if (
      totalTuple.valid[5] &&
      previousCumulative !== null &&
      totalTuple.values[5] < previousCumulative
    ) {
      context.correctionIntervals += 1;
    }
    previousCumulative = totalTuple.valid[5] ? totalTuple.values[5] : null;

    const inserted = context.spool.insertToken(
      eventKey,
      currentTurnId,
      usageFromTuple(lastTuple),
      occurrence,
      originalLikely,
    );
    if (!inserted) {
      context.duplicateEventsSkipped += 1;
    }
  }
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
      row && isValidTokenValue(row.tokens_used)
        ? row.tokens_used
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
    hasPositiveUnrated: false,
    eventCount: 0,
  };
}

function addToThreadAggregate(aggregate, event) {
  aggregate.lastActiveAt = event.timestamp;
  aggregate.inputTokens = checkedTokenAdd(aggregate.inputTokens, event.inputTokens);
  aggregate.cachedInputTokens = checkedTokenAdd(
    aggregate.cachedInputTokens,
    event.cachedInputTokens,
  );
  aggregate.outputTokens = checkedTokenAdd(aggregate.outputTokens, event.outputTokens);
  aggregate.reasoningTokens = checkedTokenAdd(
    aggregate.reasoningTokens,
    event.reasoningTokens,
  );
  aggregate.totalTokens = checkedTokenAdd(aggregate.totalTokens, event.totalTokens);
  aggregate.toolCalls = checkedTokenAdd(aggregate.toolCalls, event.toolCalls);
  aggregate.cachedInputTokens = Math.min(
    aggregate.inputTokens,
    aggregate.cachedInputTokens,
  );
  aggregate.reasoningTokens = Math.min(
    aggregate.outputTokens,
    aggregate.reasoningTokens,
  );
  aggregate.eventCount = checkedTokenAdd(aggregate.eventCount, 1);
  if (event.breakdownAvailable) {
    aggregate.detailedTokens = checkedTokenAdd(
      aggregate.detailedTokens,
      event.totalTokens,
    );
  } else {
    aggregate.unknownBreakdownTokens = checkedTokenAdd(
      aggregate.unknownBreakdownTokens,
      event.totalTokens,
    );
  }
  if (event.rateCardCredits !== null) {
    aggregate.rateCardCredits = checkedFiniteAdd(
      aggregate.rateCardCredits,
      event.rateCardCredits,
    );
    aggregate.ratedTokens = checkedTokenAdd(
      aggregate.ratedTokens,
      event.totalTokens,
    );
  } else if (event.totalTokens > 0) {
    aggregate.hasPositiveUnrated = true;
  }
}

function representableUnknownBreakdownTokens(
  observedTokens,
  detailedTokens,
  unknownBreakdownTokens,
) {
  if (
    observedTokens >= MAX_SAFE_TOKEN_COUNT &&
    detailedTokens >= MAX_SAFE_TOKEN_COUNT
  ) {
    return unknownBreakdownTokens;
  }
  return Math.min(
    unknownBreakdownTokens,
    Math.max(0, observedTokens - detailedTokens),
  );
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
  const coverage = {
    detailedTokens: 0,
    unknownBreakdownTokens: 0,
  };
  let observedTokens = 0;
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
        componentsValid: Number(token.componentsValid) === 1,
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
      observedTokens = checkedTokenAdd(observedTokens, event.totalTokens);
      checkedTokenPartitionAdd(coverage, event.totalTokens, {
        detailed: breakdownAvailable,
      });
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
    const unknownBreakdownTokens = aggregate
      ? representableUnknownBreakdownTokens(
          aggregate.totalTokens,
          aggregate.detailedTokens,
          aggregate.unknownBreakdownTokens,
        )
      : 0;
    const threadCoverage =
      eventCount === 0
        ? "unresolved"
        : aggregate.unknownBreakdownTokens === 0
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
      unknownBreakdownTokens,
      reportedCumulativeTokens: metadata.reportedCumulativeTokens,
      inputTokens: aggregate?.inputTokens || 0,
      cachedInputTokens: aggregate?.cachedInputTokens || 0,
      outputTokens: aggregate?.outputTokens || 0,
      reasoningTokens: aggregate?.reasoningTokens || 0,
      rateCardCredits:
        aggregate?.totalTokens > 0 &&
        !aggregate.hasPositiveUnrated &&
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

  const { detailedTokens, unknownBreakdownTokens } = coverage;
  const coverageTokens = detailedTokens + unknownBreakdownTokens;
  const stateCounterSumNonAdditive = threads.reduce(
    (sum, thread) => checkedTokenAdd(
      sum,
      thread.reportedCumulativeTokens || 0,
    ),
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
      invalidTokenRecords: context.invalidTokenRecords,
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
        coverageTokens > 0 ? (detailedTokens / coverageTokens) * 100 : 100,
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

export async function collectUsage(options, onProgress = () => {}) {
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

  const context = {
    stateRows: state.rows,
    parents: state.parents,
    quotas: new Map(),
    spool,
    filesScanned: 0,
    bytesScanned: 0,
    parseErrors: 0,
    duplicateEventsSkipped: 0,
    invalidTokenRecords: 0,
    correctionIntervals: 0,
  };

  try {
    for (let index = 0; index < files.length; index += 1) {
      await scanRollout(files[index], context);
      context.filesScanned += 1;
      context.bytesScanned += sizes[index].size;
      if (
        index === 0 ||
        index === files.length - 1 ||
        (index + 1) % 10 === 0
      ) {
        onProgress({
          current: index + 1,
          total: files.length,
          path: files[index],
        });
      }
    }
    return buildSnapshot(context, options, titles);
  } finally {
    spool.close();
    await rm(spool.directory, { recursive: true, force: true });
  }
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
      `Invalid token records excluded: ${storedSnapshot.coverage.invalidTokenRecords.toLocaleString()}`,
      `Threads with unresolved state-only counters: ${storedSnapshot.coverage.unresolvedThreadCounters.toLocaleString()}`,
      `Snapshot size: ${(writeResult.bytesWritten / 1_000_000).toFixed(1)} MB (${writeResult.encoding}; ${(writeResult.jsonBytes / 1_000_000).toFixed(1)} MB JSON before encoding)`,
      `Snapshot safety limit: ${(writeResult.maxBytes / 1_000_000).toFixed(1)} MB`,
    ].join("\n") + "\n",
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(
      `Token Ledger collector failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
