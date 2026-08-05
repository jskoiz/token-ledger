#!/usr/bin/env node

/**
 * Token Ledger local collector
 *
 * Reads Codex's local JSONL rollouts and metadata database, then writes a
 * privacy-reduced snapshot for the Token Ledger CLI. It never exports message
 * bodies, tool arguments/results, reasoning text, instructions, credential
 * fields, or full local paths in the generated snapshot.
 *
 * Node 22.13 or newer is required for node:sqlite.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const SCHEMA_VERSION = 1;
const WEEK_MINUTES = 10_080;
const UUID_AT_END =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
let databaseSyncPromise;

function loadDatabaseSync() {
  if (!databaseSyncPromise) {
    databaseSyncPromise = (async () => {
      const originalEmitWarning = process.emitWarning;
      process.emitWarning = function emitWarning(warning, ...arguments_) {
        const message = warning instanceof Error ? warning.message : String(warning);
        const type = typeof arguments_[0] === "string"
          ? arguments_[0]
          : arguments_[0]?.type;
        if (
          type === "ExperimentalWarning" &&
          message === "SQLite is an experimental feature and might change at any time"
        ) {
          return;
        }
        return originalEmitWarning.call(this, warning, ...arguments_);
      };
      try {
        return (await import("node:sqlite")).DatabaseSync;
      } finally {
        process.emitWarning = originalEmitWarning;
      }
    })();
  }
  return databaseSyncPromise;
}

function usage() {
  return `Token Ledger local collector

Usage:
  node lib/token-ledger-collector.mjs [options]

Options:
  --output <file>       Snapshot destination (default: token-ledger-snapshot.json)
  --codex-home <dir>    Codex data root (default: CODEX_HOME or ~/.codex)
  --since <ISO date>    Ignore model calls before this timestamp
  --no-archived         Skip archived_sessions
  --help                Show this help

The snapshot contains local token metadata and project labels only. It never
contains display titles, message bodies, tool payloads, reasoning text,
credential fields, or full local paths. Project labels can still be sensitive.`;
}

function parseArgs(argv) {
  const options = {
    output: resolve("token-ledger-snapshot.json"),
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

export function sourceFingerprint(codexHome, includeArchived = true) {
  return hash(JSON.stringify({
    codexHome: resolve(codexHome),
    includeArchived,
  }));
}

function sanitizeLabel(value, fallback = "unknown") {
  const label = String(value ?? "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (label || fallback).slice(0, 160);
}

export async function writePrivateSnapshot(output, snapshot) {
  const destination = resolve(output);
  const directory = dirname(destination);
  const temporary = resolve(
    directory,
    `.token-ledger-${process.pid}-${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
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
  const usage = value && typeof value === "object" ? value : {};
  return [
    asFiniteNumber(usage.input_tokens),
    asFiniteNumber(usage.cached_input_tokens),
    asFiniteNumber(usage.cache_write_input_tokens),
    asFiniteNumber(usage.output_tokens),
    asFiniteNumber(usage.reasoning_output_tokens),
    asFiniteNumber(usage.total_tokens),
  ];
}

function usageFromTuple(tuple) {
  return {
    inputTokens: tuple[0],
    cachedInputTokens: tuple[1],
    cacheWriteInputTokens: tuple[2],
    outputTokens: tuple[3],
    reasoningTokens: tuple[4],
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
  const value = sanitizeLabel(model, "unknown")
    .toLowerCase()
    .replaceAll("_", "-");
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

function parseStructuredSource(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function sourceLabels(threadSource, rawSource) {
  const source = parseStructuredSource(rawSource);
  if (
    threadSource === "subagent" ||
    (source && typeof source === "object" && source.subagent)
  ) {
    return { source: "subagent", useType: "subagent" };
  }
  if (threadSource === "automation") {
    return { source: "automation", useType: "automation" };
  }
  if (threadSource === "realtime_voice") {
    return { source: "voice", useType: "voice" };
  }
  if (source === "exec") return { source: "cli", useType: "cli" };
  if (source === "vscode") return { source: "desktop", useType: "interactive" };
  if (typeof source === "string" && source) {
    return {
      source: sanitizeLabel(source).slice(0, 40),
      useType: sanitizeLabel(threadSource || "interactive").slice(0, 40),
    };
  }
  return {
    source: "unknown",
    useType: sanitizeLabel(threadSource || "unknown").slice(0, 40),
  };
}

function cleanRemote(value) {
  if (!value) return null;
  const remote = String(value).trim();
  const scp = remote.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) {
    return sanitizeLabel(`${scp[1]}/${scp[2].replace(/\.git$/i, "")}`);
  }
  try {
    const url = new URL(remote);
    const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
    return sanitizeLabel(path ? `${url.hostname}/${path}` : url.hostname);
  } catch {
    const withoutCredentials = remote.replace(/\/\/[^/@]+@/, "//");
    return sanitizeLabel(withoutCredentials.replace(/\.git$/i, ""));
  }
}

function projectLabel(cwd, gitOrigin) {
  const remote = cleanRemote(gitOrigin);
  if (remote) {
    const parts = remote.split("/").filter(Boolean);
    return sanitizeLabel(parts.slice(-2).join("/"), "Unknown project");
  }
  const path = String(cwd || "").replaceAll("\\", "/").replace(/\/+$/, "");
  const worktree = path.match(/\/\.codex\/worktrees\/[^/]+\/([^/]+)$/);
  if (worktree) return worktree[1];
  const name = basename(path);
  return name && name !== "." && name !== "/"
    ? sanitizeLabel(name, "Unknown project")
    : "Unknown project";
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

export async function sourceState(codexHome, includeArchived = true) {
  const roots = [resolve(codexHome, "sessions")];
  if (includeArchived) {
    roots.push(resolve(codexHome, "archived_sessions"));
  }
  const files = (await Promise.all(roots.map((root) => listJsonlFiles(root))))
    .flat();
  const preferredState = resolve(codexHome, "state_5.sqlite");
  const legacyState = resolve(codexHome, "sqlite", "state_5.sqlite");
  const statePath = (await pathExists(preferredState))
    ? preferredState
    : (await pathExists(legacyState))
      ? legacyState
      : null;
  const sourceFiles = statePath ? [...files, statePath] : files;
  if (!sourceFiles.length) {
    return { latestMtimeMs: 0, fileCount: 0 };
  }
  const stats = await Promise.all(sourceFiles.map((path) => stat(path)));
  return {
    latestMtimeMs: Math.max(...stats.map((entry) => entry.mtimeMs)),
    fileCount: sourceFiles.length,
  };
}

export async function latestSourceModifiedAt(codexHome, includeArchived = true) {
  return (await sourceState(codexHome, includeArchived)).latestMtimeMs;
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

  const DatabaseSync = await loadDatabaseSync();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const threadRows = database
      .prepare(
        `SELECT id, created_at, updated_at, source, cwd,
                tokens_used, git_origin_url, model, reasoning_effort,
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
  };
}

function rememberQuota(quotaMap, rateLimits, occurrence) {
  if (!rateLimits || typeof rateLimits !== "object") return;
  const buckets = [rateLimits.primary, rateLimits.secondary].filter(Boolean);
  for (const bucket of buckets) {
    const windowMinutes = asFiniteNumber(bucket.window_minutes);
    const usedPercent = asFiniteNumber(bucket.used_percent);
    const resetsAt = asFiniteNumber(bucket.resets_at);
    if (!windowMinutes || !resetsAt) continue;
    const limitKey = String(rateLimits.limit_id || rateLimits.limit_name || "anonymous");
    const key = [
      hash(limitKey, 16),
      windowMinutes,
      resetsAt,
      usedPercent,
    ].join("|");
    const candidate = {
      id: `quota-${hash(key)}`,
      timestamp: occurrence.timestamp,
      usedPercent,
      windowMinutes,
      resetsAt,
      scope: rateLimits.limit_name ? "named" : "account",
      source: "log",
      turnId: occurrence.turnId || null,
      originalLikely: occurrence.originalLikely,
    };
    const current = quotaMap.get(key);
    if (
      !current ||
      (!current.originalLikely && candidate.originalLikely) ||
      (current.originalLikely === candidate.originalLikely &&
        candidate.timestamp < current.timestamp)
    ) {
      quotaMap.set(key, candidate);
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
  };
  const callOrdinals = new Map();
  let currentTurnId = "";
  let currentCandidate = null;
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
        const currentBest = context.origins.get(currentTurnId);
        if (!currentBest || currentCandidate.deltaMs < currentBest.deltaMs) {
          context.origins.set(currentTurnId, currentCandidate);
        }
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
    };

    const call = responseCall(record);
    if (call) {
      const ordinalBase = `${currentTurnId}|${call.type}|${call.name}`;
      const ordinal = (callOrdinals.get(ordinalBase) || 0) + 1;
      callOrdinals.set(ordinalBase, ordinal);
      const callKey = call.stableId
        ? `id|${call.stableId}`
        : `ordinal|${ordinalBase}|${ordinal}`;
      const existing = context.calls.get(callKey);
      if (!existing || (!existing.originalLikely && originalLikely)) {
        context.calls.set(callKey, {
          turnId: currentTurnId,
          threadId,
          originalLikely,
        });
      }
      continue;
    }

    if (record.type !== "event_msg" || record.payload?.type !== "token_count") {
      continue;
    }

    rememberQuota(context.quotas, record.payload.rate_limits, occurrence);
    const info = record.payload.info;
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
      context.correctionIntervals += 1;
    }
    previousCumulative = totalTuple[5];

    const existing = context.tokens.get(eventKey);
    if (existing) {
      context.duplicateEventsSkipped += 1;
      if (!existing.originalLikely && originalLikely) {
        existing.occurrence = occurrence;
        existing.originalLikely = true;
      }
      continue;
    }

    context.tokens.set(eventKey, {
      key: eventKey,
      turnId: currentTurnId,
      usage: usageFromTuple(lastTuple),
      occurrence,
      originalLikely,
      dedupeQuality: currentTurnId ? "turn-exact" : "legacy-heuristic",
    });
  }
}

function threadMetadata(threadId, stateRows, parents, fallback = {}) {
  const row = stateRows.get(threadId);
  const labels = sourceLabels(
    row?.thread_source,
    fallback.rawSource || row?.source,
  );
  return {
    id: threadId,
    project: projectLabel(
      fallback.cwd || row?.cwd,
      fallback.gitOrigin || row?.git_origin_url,
    ),
    model: normalizeModel(fallback.model || row?.model || "unknown"),
    effort: sanitizeLabel(
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

function buildSnapshot(context, options) {
  const events = [];
  for (const token of context.tokens.values()) {
    const origin = token.turnId ? context.origins.get(token.turnId) : null;
    const occurrence =
      token.originalLikely || !origin
        ? token.occurrence
        : {
            ...token.occurrence,
            ...origin,
            timestamp: token.occurrence.timestamp,
          };
    const threadId = origin?.threadId || occurrence.threadId;
    const metadata = threadMetadata(
      threadId,
      context.stateRows,
      context.parents,
      origin || occurrence,
    );
    const timestamp = occurrence.timestamp || origin?.timestamp;
    if (
      options.since &&
      new Date(timestamp).getTime() < options.since.getTime()
    ) {
      continue;
    }
    const breakdownAvailable = hasDetailedBreakdown(token.usage);
    events.push({
      ...token.usage,
      id: `evt-${hash(token.key)}`,
      timestamp,
      threadId,
      project: metadata.project,
      model: metadata.model,
      effort: metadata.effort,
      source: metadata.source,
      useType: metadata.useType,
      turnId: token.turnId || "",
      toolCalls: 0,
      breakdownAvailable,
      dedupeQuality: token.dedupeQuality,
    });
  }
  events.sort(
    (left, right) =>
      new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );

  const toolCounts = new Map();
  for (const call of context.calls.values()) {
    const origin = call.turnId ? context.origins.get(call.turnId) : null;
    const threadId = origin?.threadId || call.threadId;
    const key = call.turnId || `thread:${threadId}`;
    toolCounts.set(key, (toolCounts.get(key) || 0) + 1);
  }
  const lastEventByTurn = new Map();
  for (const event of events) {
    const key = event.turnId || `thread:${event.threadId}`;
    lastEventByTurn.set(key, event);
  }
  for (const [key, count] of toolCounts) {
    const event = lastEventByTurn.get(key);
    if (event) event.toolCalls = count;
  }

  const grouped = new Map();
  for (const event of events) {
    const rows = grouped.get(event.threadId) || [];
    rows.push(event);
    grouped.set(event.threadId, rows);
  }

  const allThreadIds = new Set([
    ...context.stateRows.keys(),
    ...grouped.keys(),
  ]);
  const threads = [];
  for (const threadId of allThreadIds) {
    const rows = grouped.get(threadId) || [];
    const first = rows[0];
    const last = rows.at(-1);
    const origin = first
      ? context.origins.get(first.turnId)
      : null;
    const metadata = threadMetadata(
      threadId,
      context.stateRows,
      context.parents,
      origin || first || {},
    );
    const totals = rows.reduce(
      (sum, event) => {
        sum.inputTokens += event.inputTokens;
        sum.cachedInputTokens += event.cachedInputTokens;
        sum.outputTokens += event.outputTokens;
        sum.reasoningTokens += event.reasoningTokens;
        sum.totalTokens += event.totalTokens;
        sum.toolCalls += event.toolCalls;
        if (event.breakdownAvailable) sum.detailedTokens += event.totalTokens;
        else sum.unknownBreakdownTokens += event.totalTokens;
        return sum;
      },
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        toolCalls: 0,
        detailedTokens: 0,
        unknownBreakdownTokens: 0,
      },
    );
    if (rows.length === 0 && !(metadata.reportedCumulativeTokens > 0)) continue;
    const coverage =
      rows.length === 0
        ? "unresolved"
        : totals.detailedTokens === totals.totalTokens
          ? "complete"
          : totals.detailedTokens > 0
            ? "partial"
            : "total-only";
    threads.push({
      id: threadId,
      project: metadata.project,
      model: metadata.model,
      effort: metadata.effort,
      source: metadata.source,
      useType: metadata.useType,
      parentThreadId: metadata.parentThreadId,
      firstActiveAt: first?.timestamp || metadata.createdAt,
      lastActiveAt: last?.timestamp || metadata.updatedAt,
      totalTokens: totals.totalTokens,
      detailedTokens: totals.detailedTokens,
      unknownBreakdownTokens: totals.unknownBreakdownTokens,
      reportedCumulativeTokens: metadata.reportedCumulativeTokens,
      inputTokens: totals.inputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      outputTokens: totals.outputTokens,
      reasoningTokens: totals.reasoningTokens,
      toolCalls: totals.toolCalls,
      eventCount: rows.length,
      coverage,
    });
  }
  threads.sort((left, right) => right.totalTokens - left.totalTokens);

  const quotas = [...context.quotas.values()]
    .map((quota) => {
      const exported = { ...quota };
      delete exported.turnId;
      delete exported.originalLikely;
      return exported;
    })
    .filter((quota) => {
      if (!options.since) return true;
      return new Date(quota.timestamp).getTime() >= options.since.getTime();
    })
    .sort(
      (left, right) =>
        new Date(left.timestamp).getTime() -
        new Date(right.timestamp).getTime(),
    );

  const observedTokens = events.reduce(
    (sum, event) => sum + event.totalTokens,
    0,
  );
  const detailedTokens = events
    .filter((event) => event.breakdownAvailable)
    .reduce((sum, event) => sum + event.totalTokens, 0);
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
  const earliestEventAt = events[0]?.timestamp || null;
  const latestEventAt = events.at(-1)?.timestamp || null;
  const weeklyCandidates = quotas.filter(
    (quota) => quota.windowMinutes === WEEK_MINUTES,
  );
  const accountWideWeekly = weeklyCandidates.filter(
    (quota) => quota.scope !== "named",
  );
  const weekly = [
    ...(accountWideWeekly.length ? accountWideWeekly : weeklyCandidates),
  ]
    .sort(
      (left, right) =>
        new Date(right.timestamp).getTime() -
        new Date(left.timestamp).getTime(),
    )[0];
  const weeklyStart = weekly
    ? (weekly.resetsAt - weekly.windowMinutes * 60) * 1_000
    : null;
  const completeSinceWindowStart = Boolean(
    weeklyStart &&
      earliestEventAt &&
      new Date(earliestEventAt).getTime() <= weeklyStart &&
      context.parseErrors === 0,
  );

  const notes = [
    "Observed totals sum globally de-duplicated last_token_usage model-call events.",
    "Codex thread counters are retained only as non-additive reference values because forks and subagents inherit cumulative history.",
    "Historical rollout files can be pruned; a state-only counter cannot reveal that thread's unique token contribution.",
    "Legacy events without turn IDs use a high-specificity usage-signature heuristic and are labeled in the ledger.",
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    label: "Local Codex snapshot",
    provenance: {
      kind: "codex-local-metadata",
      sourceFingerprint: sourceFingerprint(
        options.codexHome,
        options.includeArchived,
      ),
      privacy:
        "Contains token metadata and project labels only; display titles, credential fields, message bodies, reasoning text, tool payloads, and full local paths are not exported. Project labels can still be sensitive.",
    },
    coverage: {
      filesScanned: context.filesScanned,
      sourceFileCount: context.sourceFileCount,
      bytesScanned: context.bytesScanned,
      parseErrors: context.parseErrors,
      duplicateEventsSkipped: context.duplicateEventsSkipped,
      correctionIntervals: context.correctionIntervals,
      observedTokens,
      detailedTokens,
      unknownBreakdownTokens,
      stateCounterSumNonAdditive,
      unresolvedThreadCounters,
      legacyHeuristicEvents: events.filter(
        (event) => event.dedupeQuality === "legacy-heuristic",
      ).length,
      detailedPercent:
        observedTokens > 0 ? (detailedTokens / observedTokens) * 100 : 100,
      earliestEventAt,
      latestEventAt,
      completeSinceWindowStart,
      notes,
    },
    quotaObservations: quotas,
    threads,
    events,
  };
}

export async function collectUsage(options, onProgress = () => {}) {
  const state = await readState(options.codexHome);
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

  const context = {
    stateRows: state.rows,
    parents: state.parents,
    origins: new Map(),
    tokens: new Map(),
    quotas: new Map(),
    calls: new Map(),
    filesScanned: 0,
    sourceFileCount: files.length + (state.path ? 1 : 0),
    bytesScanned: 0,
    parseErrors: 0,
    duplicateEventsSkipped: 0,
    correctionIntervals: 0,
  };

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

  return buildSnapshot(context, options);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${sanitizeLabel(error.message)}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!(await pathExists(options.codexHome))) {
    throw new Error(
      `Codex data directory not found: ${sanitizeLabel(options.codexHome)}`,
    );
  }

  process.stdout.write("Token Ledger: scanning local Codex metadata…\n");
  const snapshot = await collectUsage(options, ({ current, total }) => {
    process.stdout.write(
      `\rToken Ledger: scanned ${current.toLocaleString()}/${total.toLocaleString()} rollout files`,
    );
  });
  process.stdout.write("\nToken Ledger: writing privacy-reduced snapshot…\n");
  await writePrivateSnapshot(options.output, snapshot);
  const outputSize = (await stat(options.output)).size;
  process.stdout.write(
    [
      `Snapshot: ${sanitizeLabel(options.output)}`,
      `Observed model-call tokens: ${snapshot.coverage.observedTokens.toLocaleString()}`,
      `Unique events: ${snapshot.events.length.toLocaleString()}`,
      `Duplicate/copied events skipped: ${snapshot.coverage.duplicateEventsSkipped.toLocaleString()}`,
      `Threads with unresolved state-only counters: ${snapshot.coverage.unresolvedThreadCounters.toLocaleString()}`,
      `Snapshot size: ${(outputSize / 1_000_000).toFixed(1)} MB`,
    ].join("\n") + "\n",
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(
      `Token Ledger collector failed: ${
        error instanceof Error ? sanitizeLabel(error.message) : sanitizeLabel(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
