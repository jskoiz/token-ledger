import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  stat,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { readPrivateSnapshot } from "./token-ledger-snapshot.mjs";
import {
  buildUsageBuckets,
  normalizeTokenUsage,
  usageCallCount,
  usageDetailedCallCount,
  usageInputCallCount,
} from "./token-ledger-usage.mjs";

export const DURABLE_LEDGER_SCHEMA_VERSION = 1;
export const DURABLE_LEDGER_FILENAME = "token-ledger-ledger.sqlite";
export const DURABLE_LEDGER_RETENTION_DAYS = 3_650;
export const DURABLE_LEDGER_RETENTION_MS =
  DURABLE_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const DURABLE_LEDGER_COMPACTED_RETENTION_DAYS = 7_300;
export const DURABLE_LEDGER_COMPACTED_RETENTION_MS =
  DURABLE_LEDGER_COMPACTED_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

const DEFAULT_SNAPSHOT_BASENAME = "token-ledger-snapshot-v3.json.gz";
const DAY_MS = 24 * 60 * 60 * 1_000;
const LEDGER_BUSY_TIMEOUT_MS = 1_000;
const USAGE_FIELDS = Object.freeze([
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
  "toolCalls",
]);
const COUNT_FIELDS = Object.freeze([
  "callCount",
  "detailedCallCount",
  "inputCallCount",
]);
const SOURCE_STATUSES = new Set([
  "active",
  "archived",
  "missing",
  "tombstoned",
]);

function hash(value, length = 64) {
  return createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, length);
}

function primitiveString(value) {
  try {
    const text = String.prototype.valueOf.call(value);
    return text === value ? text : null;
  } catch {
    return null;
  }
}

function text(value, maximumLength = 2_000, fallback = "") {
  const primitive = primitiveString(value);
  return primitive === null ? fallback : primitive.slice(0, maximumLength);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number >= 0 ? number : 0;
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeIso(value, fallback) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : fallback;
}

function isoNow(value = Date.now()) {
  return new Date(value).toISOString();
}

function finiteTimestamp(value) {
  const timestampMs = Date.parse(text(value));
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function parseJson(value, fallback = null) {
  const source = primitiveString(value);
  if (source === null || source.length === 0) return fallback;
  try {
    return JSON.parse(source);
  } catch {
    return fallback;
  }
}

function sourceIdForPath(codexHome, path) {
  const match = basename(path).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  if (match) return `rollout:${match[1].toLowerCase()}`;
  const relativePath = path
    .replaceAll("\\", "/")
    .replace(`${resolve(codexHome).replaceAll("\\", "/")}/`, "");
  return `path:${hash(relativePath, 64)}`;
}

function sourceLocation(codexHome, path) {
  const root = resolve(codexHome).replaceAll("\\", "/");
  const normalized = resolve(path).replaceAll("\\", "/");
  if (
    normalized === `${root}/sessions` ||
    normalized.startsWith(`${root}/sessions/`)
  ) {
    return "active";
  }
  if (
    normalized === `${root}/archived_sessions` ||
    normalized.startsWith(`${root}/archived_sessions/`)
  ) {
    return "archived";
  }
  return "active";
}

export function durableSourceId(codexHome, path) {
  return sourceIdForPath(codexHome, path);
}

export function resolveDurableLedgerPath(options = {}) {
  if (options.ledgerPath) return resolve(options.ledgerPath);
  if (options.stateDirectory) {
    return resolve(options.stateDirectory, DURABLE_LEDGER_FILENAME);
  }
  const output = resolve(options.output || DEFAULT_SNAPSHOT_BASENAME);
  if (
    basename(output) === DEFAULT_SNAPSHOT_BASENAME &&
    basename(dirname(output)) === ".token-ledger"
  ) {
    return resolve(dirname(output), DURABLE_LEDGER_FILENAME);
  }
  return resolve(`${output}.ledger.sqlite`);
}

function ledgerSchema() {
  return `
    CREATE TABLE IF NOT EXISTS ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS source_state (
      source_id TEXT PRIMARY KEY,
      source_label TEXT NOT NULL,
      path_fingerprint TEXT NOT NULL,
      location TEXT NOT NULL,
      status TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      ctime_ms REAL NOT NULL,
      device INTEGER,
      inode INTEGER,
      cursor_bytes INTEGER NOT NULL,
      cursor_fingerprint TEXT NOT NULL,
      change_state TEXT NOT NULL DEFAULT 'stable',
      change_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_transition_at TEXT NOT NULL,
      observed_event_count INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS usage_observations (
      observation_id TEXT PRIMARY KEY,
      identity_kind TEXT NOT NULL,
      event_key TEXT,
      turn_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      input_tokens REAL NOT NULL,
      cached_input_tokens REAL NOT NULL,
      cache_write_input_tokens REAL NOT NULL,
      output_tokens REAL NOT NULL,
      reasoning_tokens REAL NOT NULL,
      total_tokens REAL NOT NULL,
      tool_calls REAL NOT NULL DEFAULT 0,
      call_count REAL NOT NULL DEFAULT 1,
      detailed_call_count REAL NOT NULL DEFAULT 1,
      input_call_count REAL NOT NULL DEFAULT 1,
      components_valid INTEGER NOT NULL,
      token_model TEXT NOT NULL,
      token_effort TEXT NOT NULL,
      token_cwd TEXT NOT NULL,
      token_git_origin TEXT,
      token_raw_source TEXT,
      token_service_tier TEXT,
      origin_thread_id TEXT,
      origin_timestamp TEXT,
      origin_model TEXT,
      origin_effort TEXT,
      origin_cwd TEXT,
      origin_git_origin TEXT,
      origin_raw_source TEXT,
      origin_service_tier TEXT,
      project TEXT NOT NULL,
      display_model TEXT NOT NULL,
      source_label TEXT NOT NULL,
      use_type TEXT NOT NULL,
      rate_card_model TEXT NOT NULL,
      rate_card_credits REAL,
      original_likely INTEGER NOT NULL,
      range_allocation_estimated INTEGER NOT NULL DEFAULT 0,
      range_allocation_origin TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS usage_exact_event_key
      ON usage_observations(event_key)
      WHERE identity_kind = 'exact' AND event_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS source_event_positions (
      source_id TEXT NOT NULL,
      event_ordinal INTEGER NOT NULL,
      observation_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY(source_id, event_ordinal)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS usage_compaction_membership (
      event_key TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS usage_sources (
      observation_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY(observation_id, source_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS tool_observations (
      call_key TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      original_likely INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS tool_sources (
      call_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY(call_key, source_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS quota_observations (
      observation_id TEXT PRIMARY KEY,
      observation_key TEXT NOT NULL UNIQUE,
      identity_kind TEXT NOT NULL,
      limit_key TEXT NOT NULL,
      limit_name TEXT,
      scope TEXT NOT NULL,
      window_minutes INTEGER NOT NULL,
      resets_at REAL NOT NULL,
      used_percent REAL NOT NULL,
      plan_type TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      migrated INTEGER NOT NULL DEFAULT 0,
      exact_seen INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS quota_sources (
      observation_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY(observation_id, source_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS thread_records (
      thread_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      source TEXT NOT NULL,
      use_type TEXT NOT NULL,
      parent_thread_id TEXT,
      reported_cumulative_tokens REAL,
      created_at TEXT,
      updated_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS migration_runs (
      migration_key TEXT PRIMARY KEY,
      source_fingerprint TEXT NOT NULL,
      source_label TEXT NOT NULL,
      generated_at TEXT,
      migrated_at TEXT NOT NULL,
      usage_rows INTEGER NOT NULL,
      quota_rows INTEGER NOT NULL
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS usage_timestamp
      ON usage_observations(timestamp);
    CREATE INDEX IF NOT EXISTS quota_timestamp
      ON quota_observations(first_seen_at, last_seen_at);
  `;
}

async function chmodIfPresent(path, mode) {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (![
      "ENOENT",
      "ENOTDIR",
      "EACCES",
      "EPERM",
    ].includes(error?.code)) throw error;
  }
}

async function openLedger(path, readOnly = false) {
  if (!readOnly) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmodIfPresent(dirname(path), 0o700);
  }
  const database = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
  database.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
  if (!readOnly) {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(ledgerSchema());
    ensureLedgerColumns(database);
    database.exec(
      `PRAGMA user_version = ${DURABLE_LEDGER_SCHEMA_VERSION}`,
    );
    await chmodIfPresent(path, 0o600);
  }
  return database;
}

function closeDatabase(database) {
  try {
    database?.close();
  } catch {
    // The caller already has the transaction result; close errors cannot make
    // a committed SQLite transaction less durable.
  }
}

function ensureLedgerColumns(database) {
  const columns = new Set(database.prepare(
    "PRAGMA table_info(source_state)",
  ).all().map((column) => String(column.name)));
  if (!columns.has("change_state")) {
    database.exec(
      "ALTER TABLE source_state ADD COLUMN change_state TEXT NOT NULL DEFAULT 'stable'",
    );
  }
  if (!columns.has("change_count")) {
    database.exec(
      "ALTER TABLE source_state ADD COLUMN change_count INTEGER NOT NULL DEFAULT 0",
    );
  }
}

async function restrictLedgerFiles(path) {
  await chmodIfPresent(dirname(path), 0o700);
  await chmodIfPresent(path, 0o600);
  await chmodIfPresent(`${path}-wal`, 0o600);
  await chmodIfPresent(`${path}-shm`, 0o600);
}

function metaValue(database, key) {
  return database.prepare(
    "SELECT value FROM ledger_meta WHERE key = ?",
  ).get(key)?.value ?? null;
}

function setMeta(database, key, value) {
  database.prepare(`
    INSERT INTO ledger_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function sourceEntry(codexHome, entry, now) {
  const path = resolve(entry.path);
  const sourceStat = entry.sourceStat || entry;
  const size = nonNegativeNumber(sourceStat.size ?? entry.size);
  const mtimeMs = nonNegativeNumber(sourceStat.mtimeMs ?? entry.mtimeMs);
  const ctimeMs = nonNegativeNumber(sourceStat.ctimeMs ?? entry.ctimeMs);
  const device = nullableNumber(sourceStat.dev ?? entry.dev);
  const inode = nullableNumber(sourceStat.ino ?? entry.ino);
  const sourceId = entry.sourceId || sourceIdForPath(codexHome, path);
  const location = entry.location || sourceLocation(codexHome, path);
  const sourceLabel = text(entry.sourceLabel || basename(path), 180, "rollout.jsonl");
  const relativePath = path
    .replaceAll("\\", "/")
    .replace(`${resolve(codexHome).replaceAll("\\", "/")}/`, "");
  return {
    sourceId,
    sourceLabel,
    pathFingerprint: hash(relativePath, 64),
    location: location === "archived" ? "archived" : "active",
    size,
    mtimeMs,
    ctimeMs,
    device,
    inode,
    cursorBytes: size,
    cursorFingerprint: hash(
      JSON.stringify([size, mtimeMs, ctimeMs, device, inode]),
      64,
    ),
    observedAt: now,
  };
}

function quotaKey(limitKey, windowMinutes, resetsAt, usedPercent) {
  return JSON.stringify([
    text(limitKey, 160, "anonymous"),
    Math.trunc(windowMinutes),
    resetsAt,
    usedPercent,
  ]);
}

export function durableQuotaObservationKey({
  limitKey,
  windowMinutes,
  resetsAt,
  usedPercent,
}) {
  return quotaKey(limitKey, windowMinutes, resetsAt, usedPercent);
}

function sourceAssociationAllows(sourceIds, sources, includeArchived) {
  if (includeArchived) return true;
  return [...sourceIds].some((sourceId) =>
    sources.get(sourceId)?.status === "active"
  );
}

function rowSourceIds(database, table, keyColumn, idColumn) {
  const sourceIds = new Map();
  for (const row of database.prepare(
    `SELECT ${keyColumn} AS keyValue, ${idColumn} AS sourceId FROM ${table}`,
  ).all()) {
    const key = String(row.keyValue);
    const current = sourceIds.get(key) || new Set();
    current.add(String(row.sourceId));
    sourceIds.set(key, current);
  }
  return sourceIds;
}

function usageRowFromDatabase(row, sourceIds = new Set()) {
  const rangeAllocationOrigin = parseJson(row.rangeAllocationOrigin);
  const result = {
    observationId: String(row.observationId),
    identityKind: String(row.identityKind),
    eventKey: row.eventKey == null ? null : String(row.eventKey),
    turnId: text(row.turnId, 400),
    threadId: text(row.threadId, 400),
    timestamp: text(row.timestamp, 80),
    inputTokens: nonNegativeNumber(row.inputTokens),
    cachedInputTokens: nonNegativeNumber(row.cachedInputTokens),
    cacheWriteInputTokens: nonNegativeNumber(row.cacheWriteInputTokens),
    outputTokens: nonNegativeNumber(row.outputTokens),
    reasoningTokens: nonNegativeNumber(row.reasoningTokens),
    totalTokens: nonNegativeNumber(row.totalTokens),
    toolCalls: nonNegativeNumber(row.toolCalls),
    callCount: nonNegativeNumber(row.callCount),
    detailedCallCount: nonNegativeNumber(row.detailedCallCount),
    inputCallCount: nonNegativeNumber(row.inputCallCount),
    componentsValid: Number(row.componentsValid) === 1,
    model: text(row.tokenModel, 200, "unknown"),
    effort: text(row.tokenEffort, 80, "unknown"),
    cwd: text(row.tokenCwd),
    gitOrigin: row.tokenGitOrigin == null ? null : text(row.tokenGitOrigin),
    rawSource: row.tokenRawSource == null ? null : text(row.tokenRawSource),
    serviceTier: row.tokenServiceTier == null
      ? null
      : text(row.tokenServiceTier, 80),
    originThreadId: row.originThreadId == null ? null : text(row.originThreadId, 400),
    originTimestamp: row.originTimestamp == null ? null : text(row.originTimestamp, 80),
    originModel: row.originModel == null ? null : text(row.originModel, 200),
    originEffort: row.originEffort == null ? null : text(row.originEffort, 80),
    originCwd: row.originCwd == null ? null : text(row.originCwd),
    originGitOrigin: row.originGitOrigin == null ? null : text(row.originGitOrigin),
    originRawSource: row.originRawSource == null ? null : text(row.originRawSource),
    originServiceTier: row.originServiceTier == null
      ? null
      : text(row.originServiceTier, 80),
    project: text(row.project, 160, "Unknown project"),
    displayModel: text(row.displayModel, 80, "unknown"),
    source: text(row.sourceLabel, 80, "unknown"),
    useType: text(row.useType, 80, "unknown"),
    rateCardModel: text(row.rateCardModel, 200, "unknown"),
    rateCardCredits: nullableNumber(row.rateCardCredits),
    originalLikely: Number(row.originalLikely) === 1,
    rangeAllocationEstimated: Number(row.rangeAllocationEstimated) === 1,
    rangeAllocationOrigin,
    startAt: rangeAllocationOrigin?.startAt ?? null,
    endAt: rangeAllocationOrigin?.endAt ?? null,
    sourceIds,
  };
  return result;
}

function usageInterval(row) {
  const timestampMs = finiteTimestamp(row.timestamp);
  if (timestampMs === null) return null;
  const startMs = finiteTimestamp(row.startAt) ?? timestampMs;
  const endMs = finiteTimestamp(row.endAt) ?? timestampMs;
  return {
    startMs: Math.min(startMs, endMs, timestampMs),
    endMs: Math.max(startMs, endMs, timestampMs) + 1,
  };
}

function sameUsageDimensions(left, right) {
  return [
    "project",
    "displayModel",
    "rateCardModel",
    "effort",
    "source",
    "useType",
    "serviceTier",
  ].every((field) => (left[field] ?? null) === (right[field] ?? null));
}

function subtractNonNegative(base, values, field) {
  const subtracted = values.reduce(
    (sum, row) => sum + nonNegativeNumber(row[field]),
    0,
  );
  return Math.max(0, nonNegativeNumber(base[field]) - subtracted);
}

function subtractMigratedRow(row, exactRows) {
  const interval = usageInterval(row);
  if (interval === null) return row;
  const matches = exactRows.filter((exact) => {
    if (!sameUsageDimensions(row, exact)) return false;
    const timestampMs = finiteTimestamp(exact.timestamp);
    return (
      timestampMs !== null &&
      timestampMs >= interval.startMs &&
      timestampMs < interval.endMs
    );
  });
  if (!matches.length) return row;
  const residual = { ...row };
  for (const field of USAGE_FIELDS) {
    residual[field] = subtractNonNegative(row, matches, field);
  }
  for (const field of COUNT_FIELDS) {
    residual[field] = subtractNonNegative(row, matches, field);
  }
  if (residual.totalTokens <= 0 && residual.callCount <= 0) return null;
  residual.rangeAllocationEstimated = true;
  residual.rangeAllocationOrigin = row.rangeAllocationOrigin || {
    inputTokens: row.inputTokens,
    totalTokens: row.totalTokens,
    callCount: row.callCount,
  };
  return residual;
}

function migrationRowFromBucket(bucket, migrationKey, index, generatedAt, now) {
  const normalized = normalizeTokenUsage(bucket);
  const timestamp = safeIso(normalized?.timestamp, null);
  if (!normalized || normalized.invalidTokenRecord === true || !timestamp) {
    return null;
  }
  const threadIds = Array.isArray(normalized.threadIds)
    ? normalized.threadIds.map((value) => text(value, 400)).filter(Boolean)
    : [];
  const identitySeed = JSON.stringify([migrationKey, index, bucket]);
  const observationId = `migrated-${hash(identitySeed, 64)}`;
  const threadId = threadIds.length === 1
    ? threadIds[0]
    : `migrated:${hash(observationId, 24)}`;
  const origin = {
    ...normalized.rangeAllocationOrigin,
    startAt: normalized.startAt || timestamp,
    endAt: normalized.endAt || timestamp,
    inputTokens: normalized.inputTokens,
    totalTokens: normalized.totalTokens,
    callCount: usageCallCount(normalized),
  };
  return {
    observationId,
    identityKind: "migrated_compacted",
    eventKey: null,
    turnId: "",
    threadId,
    timestamp,
    inputTokens: nonNegativeNumber(normalized.inputTokens),
    cachedInputTokens: nonNegativeNumber(normalized.cachedInputTokens),
    cacheWriteInputTokens: nonNegativeNumber(normalized.cacheWriteInputTokens),
    outputTokens: nonNegativeNumber(normalized.outputTokens),
    reasoningTokens: nonNegativeNumber(normalized.reasoningTokens),
    totalTokens: nonNegativeNumber(normalized.totalTokens),
    toolCalls: nonNegativeNumber(normalized.toolCalls),
    callCount: usageCallCount(normalized),
    detailedCallCount: usageDetailedCallCount(normalized),
    inputCallCount: usageInputCallCount(normalized),
    componentsValid: normalized.breakdownAvailable === true,
    model: text(normalized.rateCardModel || normalized.model, 200, "unknown"),
    effort: text(normalized.effort, 80, "unknown"),
    cwd: "",
    gitOrigin: null,
    rawSource: null,
    serviceTier: normalized.serviceTier == null
      ? null
      : text(normalized.serviceTier, 80),
    originThreadId: null,
    originTimestamp: null,
    originModel: null,
    originEffort: null,
    originCwd: null,
    originGitOrigin: null,
    originRawSource: null,
    originServiceTier: null,
    project: text(normalized.project, 160, "Unknown project"),
    displayModel: text(normalized.model, 80, "unknown"),
    source: text(normalized.source, 80, "unknown"),
    useType: text(normalized.useType, 80, "unknown"),
    rateCardModel: text(
      normalized.rateCardModel || normalized.model,
      200,
      "unknown",
    ),
    rateCardCredits: nullableNumber(normalized.rateCardCredits),
    originalLikely: true,
    rangeAllocationEstimated: true,
    rangeAllocationOrigin: origin,
    sourceIds: new Set(),
    startAt: normalized.startAt || timestamp,
    endAt: normalized.endAt || timestamp,
    generatedAt: generatedAt || now,
  };
}

async function readLegacySnapshot(path) {
  if (!path) return null;
  try {
    const snapshot = await readPrivateSnapshot(path);
    if (
      !snapshot ||
      snapshot.schemaVersion !== 3 ||
      !Array.isArray(snapshot.events)
    ) return null;
    return snapshot;
  } catch {
    return null;
  }
}

function migrateLegacySnapshot(database, snapshot, now) {
  const migrationKey = "snapshot-v3-default";
  if (database.prepare(
    "SELECT 1 AS present FROM migration_runs WHERE migration_key = ?",
  ).get(migrationKey)) {
    return { migrated: false, migrationKey };
  }

  const generatedAt = safeIso(snapshot.generatedAt, now);
  const sourceFingerprint = hash(JSON.stringify(snapshot), 64);
  const sourceLabel = "token-ledger-snapshot-v3";
  const usageRows = snapshot.events
    .map((bucket, index) =>
      migrationRowFromBucket(bucket, migrationKey, index, generatedAt, now))
    .filter(Boolean);
  const quotaRows = (Array.isArray(snapshot.quotaObservations)
    ? snapshot.quotaObservations
    : [])
    .map((quota) => {
      const windowMinutes = Math.trunc(nonNegativeNumber(quota.windowMinutes));
      const resetsAt = nonNegativeNumber(quota.resetsAt);
      const usedPercent = nonNegativeNumber(quota.usedPercent);
      const timestamp = safeIso(quota.timestamp, null);
      if (!windowMinutes || !resetsAt || !timestamp) return null;
      const rawLimitKey = text(
        quota.limitKey || quota.limitName || "anonymous",
        160,
        "anonymous",
      );
      const limitKey = /^[0-9a-f]{16}$/i.test(rawLimitKey)
        ? rawLimitKey.toLowerCase()
        : hash(rawLimitKey, 16);
      const observationKey = quotaKey(
        limitKey,
        windowMinutes,
        resetsAt,
        usedPercent,
      );
      return {
        observationId: `quota-${hash(observationKey, 64)}`,
        observationKey,
        identityKind: "migrated_compacted",
        limitKey,
        limitName: quota.limitName == null
          ? null
          : text(quota.limitName, 80),
        scope: quota.scope === "named" ? "named" : "account",
        windowMinutes,
        resetsAt,
        usedPercent,
        planType: text(quota.planType, 80, "unknown"),
        firstSeenAt: timestamp,
        lastSeenAt: safeIso(quota.lastSeenAt, timestamp),
        migrated: 1,
        exactSeen: 0,
      };
    })
    .filter(Boolean);

  const insertThread = database.prepare(`
    INSERT OR IGNORE INTO thread_records (
      thread_id, title, project, model, effort, source, use_type,
      parent_thread_id, reported_cumulative_tokens, created_at, updated_at,
      first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const thread of Array.isArray(snapshot.threads) ? snapshot.threads : []) {
    const threadId = text(thread?.id, 400, "");
    if (!threadId) continue;
    insertThread.run(
      threadId,
      text(thread.title, 180, "Untitled task"),
      text(thread.project, 160, "Unknown project"),
      text(thread.model, 80, "unknown"),
      text(thread.effort, 40, "unknown"),
      text(thread.source, 80, "unknown"),
      text(thread.useType, 80, "unknown"),
      thread.parentThreadId == null ? null : text(thread.parentThreadId, 400),
      nullableNumber(thread.reportedCumulativeTokens),
      thread.firstActiveAt == null ? null : safeIso(thread.firstActiveAt, null),
      thread.lastActiveAt == null ? null : safeIso(thread.lastActiveAt, null),
      now,
      now,
    );
  }

  const insertUsage = database.prepare(`
    INSERT OR IGNORE INTO usage_observations (
      observation_id, identity_kind, event_key, turn_id, thread_id, timestamp,
      input_tokens, cached_input_tokens, cache_write_input_tokens,
      output_tokens, reasoning_tokens, total_tokens, tool_calls, call_count,
      detailed_call_count, input_call_count, components_valid, token_model,
      token_effort, token_cwd, token_git_origin, token_raw_source,
      token_service_tier, origin_thread_id, origin_timestamp, origin_model,
      origin_effort, origin_cwd, origin_git_origin, origin_raw_source,
      origin_service_tier, project, display_model, source_label, use_type,
      rate_card_model, rate_card_credits, original_likely,
      range_allocation_estimated, range_allocation_origin, first_seen_at,
      last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of usageRows) {
    insertUsage.run(
      row.observationId,
      row.identityKind,
      row.eventKey,
      row.turnId,
      row.threadId,
      row.timestamp,
      row.inputTokens,
      row.cachedInputTokens,
      row.cacheWriteInputTokens,
      row.outputTokens,
      row.reasoningTokens,
      row.totalTokens,
      row.toolCalls,
      row.callCount,
      row.detailedCallCount,
      row.inputCallCount,
      row.componentsValid ? 1 : 0,
      row.model,
      row.effort,
      row.cwd,
      row.gitOrigin,
      row.rawSource,
      row.serviceTier,
      row.originThreadId,
      row.originTimestamp,
      row.originModel,
      row.originEffort,
      row.originCwd,
      row.originGitOrigin,
      row.originRawSource,
      row.originServiceTier,
      row.project,
      row.displayModel,
      row.source,
      row.useType,
      row.rateCardModel,
      row.rateCardCredits,
      1,
      1,
      JSON.stringify(row.rangeAllocationOrigin),
      row.generatedAt,
      row.generatedAt,
    );
  }

  const insertQuota = database.prepare(`
    INSERT OR IGNORE INTO quota_observations (
      observation_id, observation_key, identity_kind, limit_key, limit_name,
      scope, window_minutes, resets_at, used_percent, plan_type,
      first_seen_at, last_seen_at, migrated, exact_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of quotaRows) {
    insertQuota.run(
      row.observationId,
      row.observationKey,
      row.identityKind,
      row.limitKey,
      row.limitName,
      row.scope,
      row.windowMinutes,
      row.resetsAt,
      row.usedPercent,
      row.planType,
      row.firstSeenAt,
      row.lastSeenAt,
      row.migrated,
      row.exactSeen,
    );
  }

  database.prepare(`
    INSERT INTO migration_runs (
      migration_key, source_fingerprint, source_label, generated_at,
      migrated_at, usage_rows, quota_rows
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    migrationKey,
    sourceFingerprint,
    sourceLabel,
    snapshot.generatedAt == null ? null : generatedAt,
    now,
    usageRows.length,
    quotaRows.length,
  );
  return {
    migrated: true,
    migrationKey,
    usageRows: usageRows.length,
    quotaRows: quotaRows.length,
  };
}

function updateSourceStates(database, codexHome, inventory, includeArchived, now) {
  const current = new Map();
  for (const entry of inventory?.files || []) {
    const source = sourceEntry(codexHome, entry, now);
    current.set(source.sourceId, source);
  }
  const insertSource = database.prepare(`
    INSERT INTO source_state (
      source_id, source_label, path_fingerprint, location, status,
      size_bytes, mtime_ms, ctime_ms, device, inode, cursor_bytes,
      cursor_fingerprint, change_state, change_count, first_seen_at,
      last_seen_at, last_transition_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      source_label = excluded.source_label,
      path_fingerprint = excluded.path_fingerprint,
      location = excluded.location,
      status = excluded.status,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      ctime_ms = excluded.ctime_ms,
      device = excluded.device,
      inode = excluded.inode,
      cursor_bytes = excluded.cursor_bytes,
      cursor_fingerprint = excluded.cursor_fingerprint,
      change_state = CASE
        WHEN excluded.change_state <> 'stable'
          THEN excluded.change_state
        ELSE source_state.change_state
      END,
      change_count = source_state.change_count + excluded.change_count,
      last_seen_at = excluded.last_seen_at,
      last_transition_at = CASE
        WHEN source_state.status <> excluded.status
          OR source_state.location <> excluded.location
          OR source_state.change_state <> excluded.change_state
        THEN excluded.last_seen_at
        ELSE source_state.last_transition_at
      END
  `);
  for (const source of current.values()) {
    const prior = database.prepare(
      `SELECT first_seen_at, path_fingerprint, cursor_bytes,
              cursor_fingerprint, device, inode, change_state
         FROM source_state
        WHERE source_id = ?`,
    ).get(source.sourceId);
    const previousSize = Number(prior?.cursor_bytes);
    const cursorChanged = prior &&
      String(prior.cursor_fingerprint) !== source.cursorFingerprint;
    const sameFileIdentity = prior &&
      prior.inode != null &&
      source.inode != null &&
      Number(prior.inode) === Number(source.inode);
    const fileIdentityChanged = prior &&
      prior.inode != null &&
      source.inode != null &&
      Number(prior.inode) !== Number(source.inode);
    const relocated = sameFileIdentity &&
      String(prior.path_fingerprint) !== source.pathFingerprint;
    const truncated = prior && source.size < previousSize;
    const replaced = prior &&
      (
        fileIdentityChanged ||
        (sameFileIdentity && source.size === previousSize && cursorChanged && !relocated)
      );
    const changeState = truncated
      ? "truncated"
      : replaced
        ? "replaced"
        : prior && prior.change_state !== "stable"
          ? text(prior.change_state, 40, "replaced")
          : "stable";
    const changeCount = truncated || replaced ? 1 : 0;
    insertSource.run(
      source.sourceId,
      source.sourceLabel,
      source.pathFingerprint,
      source.location,
      source.location,
      source.size,
      source.mtimeMs,
      source.ctimeMs,
      source.device,
      source.inode,
      source.cursorBytes,
      source.cursorFingerprint,
      changeState,
      changeCount,
      prior?.first_seen_at || now,
      now,
      now,
    );
  }

  if (includeArchived) {
    for (const prior of database.prepare(
      "SELECT source_id, status, observed_event_count FROM source_state",
    ).all()) {
      if (current.has(String(prior.source_id))) continue;
      if (!SOURCE_STATUSES.has(String(prior.status))) continue;
      const status = Number(prior.observed_event_count) > 0
        ? "tombstoned"
        : "missing";
      database.prepare(`
        UPDATE source_state
           SET status = ?, last_transition_at = CASE
             WHEN status <> ? THEN ? ELSE last_transition_at END
         WHERE source_id = ?
      `).run(status, status, now, prior.source_id);
    }
  } else {
    for (const prior of database.prepare(
      "SELECT source_id, location, status, observed_event_count FROM source_state WHERE location = 'active'",
    ).all()) {
      if (current.has(String(prior.source_id))) continue;
      const status = Number(prior.observed_event_count) > 0
        ? "tombstoned"
        : "missing";
      database.prepare(`
        UPDATE source_state
           SET status = ?, last_transition_at = CASE
             WHEN status <> ? THEN ? ELSE last_transition_at END
         WHERE source_id = ?
      `).run(status, status, now, prior.source_id);
    }
  }
  return current;
}

function compactedObservationForEvent(database, eventKey) {
  const row = database.prepare(`
    SELECT membership.observation_id AS observationId
      FROM usage_compaction_membership AS membership
      JOIN usage_observations AS observation
        ON observation.observation_id = membership.observation_id
     WHERE membership.event_key = ?
       AND observation.identity_kind = 'compacted'
  `).get(eventKey);
  if (row?.observationId) return String(row.observationId);
  database.prepare(
    "DELETE FROM usage_compaction_membership WHERE event_key = ?",
  ).run(eventKey);
  return null;
}

function observationForSourcePosition(database, positions, eventKey) {
  for (const position of positions || []) {
    const global = database.prepare(`
      SELECT observation_id AS observationId, identity_kind AS identityKind
        FROM usage_observations
       WHERE event_key = ?
    `).get(eventKey);
    if (global?.observationId) return String(global.observationId);
    const positioned = database.prepare(`
      SELECT observation_id AS observationId
        FROM source_event_positions
       WHERE source_id = ? AND event_ordinal = ?
    `).get(String(position.sourceId), Math.trunc(Number(position.ordinal)));
    if (positioned?.observationId) return String(positioned.observationId);
  }
  return null;
}

function upsertSourceEventPosition(
  database,
  position,
  observationId,
  eventKey,
  now,
) {
  if (!position?.sourceId || !Number.isSafeInteger(Number(position.ordinal))) {
    return;
  }
  database.prepare(`
    INSERT INTO source_event_positions (
      source_id, event_ordinal, observation_id, event_key,
      first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, event_ordinal) DO UPDATE SET
      observation_id = excluded.observation_id,
      event_key = excluded.event_key,
      last_seen_at = CASE WHEN excluded.last_seen_at > source_event_positions.last_seen_at
        THEN excluded.last_seen_at ELSE source_event_positions.last_seen_at END
  `).run(
    String(position.sourceId),
    Math.trunc(Number(position.ordinal)),
    observationId,
    eventKey,
    now,
    now,
  );
}

function upsertUsageObservation(
  database,
  row,
  metadata,
  now,
  positionedObservationId = null,
) {
  const eventKey = text(row.eventKey, 4_000, "");
  if (!eventKey) return null;
  const compactedObservationId = compactedObservationForEvent(database, eventKey);
  if (compactedObservationId) return compactedObservationId;
  const positioned = positionedObservationId
    ? database.prepare(`
      SELECT observation_id AS observationId, identity_kind AS identityKind
        FROM usage_observations
       WHERE observation_id = ?
    `).get(positionedObservationId)
    : null;
  if (positioned?.identityKind === "compacted") {
    return String(positioned.observationId);
  }
  const observationId = String(
    positioned?.observationId || `exact-${hash(eventKey, 64)}`,
  );
  const originThreadId = row.originThreadId == null
    ? null
    : text(row.originThreadId, 400);
  const usage = {
    inputTokens: nonNegativeNumber(row.inputTokens),
    cachedInputTokens: nonNegativeNumber(row.cachedInputTokens),
    cacheWriteInputTokens: nonNegativeNumber(row.cacheWriteInputTokens),
    outputTokens: nonNegativeNumber(row.outputTokens),
    reasoningTokens: nonNegativeNumber(row.reasoningTokens),
    totalTokens: nonNegativeNumber(row.totalTokens),
  };
  const insert = database.prepare(`
    INSERT OR IGNORE INTO usage_observations (
      observation_id, identity_kind, event_key, turn_id, thread_id, timestamp,
      input_tokens, cached_input_tokens, cache_write_input_tokens,
      output_tokens, reasoning_tokens, total_tokens, tool_calls, call_count,
      detailed_call_count, input_call_count, components_valid, token_model,
      token_effort, token_cwd, token_git_origin, token_raw_source,
      token_service_tier, origin_thread_id, origin_timestamp, origin_model,
      origin_effort, origin_cwd, origin_git_origin, origin_raw_source,
      origin_service_tier, project, display_model, source_label, use_type,
      rate_card_model, rate_card_credits, original_likely,
      range_allocation_estimated, range_allocation_origin, first_seen_at,
      last_seen_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(observation_id) DO UPDATE SET
      last_seen_at = CASE
        WHEN excluded.last_seen_at > usage_observations.last_seen_at
        THEN excluded.last_seen_at ELSE usage_observations.last_seen_at END,
      turn_id = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.turn_id ELSE usage_observations.turn_id END,
      thread_id = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.thread_id ELSE usage_observations.thread_id END,
      timestamp = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.timestamp ELSE usage_observations.timestamp END,
      event_key = excluded.event_key,
      input_tokens = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.input_tokens ELSE usage_observations.input_tokens END,
      cached_input_tokens = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.cached_input_tokens ELSE usage_observations.cached_input_tokens END,
      cache_write_input_tokens = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.cache_write_input_tokens ELSE usage_observations.cache_write_input_tokens END,
      output_tokens = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.output_tokens ELSE usage_observations.output_tokens END,
      reasoning_tokens = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.reasoning_tokens ELSE usage_observations.reasoning_tokens END,
      total_tokens = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.total_tokens ELSE usage_observations.total_tokens END,
      tool_calls = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.tool_calls ELSE usage_observations.tool_calls END,
      call_count = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.call_count ELSE usage_observations.call_count END,
      detailed_call_count = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.detailed_call_count ELSE usage_observations.detailed_call_count END,
      input_call_count = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.input_call_count ELSE usage_observations.input_call_count END,
      components_valid = CASE WHEN excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.components_valid ELSE usage_observations.components_valid END,
      token_model = CASE WHEN excluded.original_likely = 1
        THEN excluded.token_model ELSE usage_observations.token_model END,
      token_effort = CASE WHEN excluded.original_likely = 1
        THEN excluded.token_effort ELSE usage_observations.token_effort END,
      token_cwd = CASE WHEN excluded.original_likely = 1
        THEN excluded.token_cwd ELSE usage_observations.token_cwd END,
      token_git_origin = CASE WHEN excluded.original_likely = 1
        THEN excluded.token_git_origin ELSE usage_observations.token_git_origin END,
      token_raw_source = CASE WHEN excluded.original_likely = 1
        THEN excluded.token_raw_source ELSE usage_observations.token_raw_source END,
      token_service_tier = CASE WHEN excluded.original_likely = 1
        THEN excluded.token_service_tier ELSE usage_observations.token_service_tier END,
      project = CASE WHEN excluded.original_likely = 1
        THEN excluded.project ELSE usage_observations.project END,
      display_model = CASE WHEN excluded.original_likely = 1
        THEN excluded.display_model ELSE usage_observations.display_model END,
      source_label = CASE WHEN excluded.original_likely = 1
        THEN excluded.source_label ELSE usage_observations.source_label END,
      use_type = CASE WHEN excluded.original_likely = 1
        THEN excluded.use_type ELSE usage_observations.use_type END,
      rate_card_model = CASE WHEN excluded.original_likely = 1
        THEN excluded.rate_card_model ELSE usage_observations.rate_card_model END,
      original_likely = MAX(usage_observations.original_likely, excluded.original_likely)
  `);
  const metadataRecord = metadata || {};
  insert.run(
    observationId,
    "exact",
    eventKey,
    text(row.turnId, 400),
    text(row.threadId, 400),
    safeIso(row.timestamp, now),
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteInputTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
    nonNegativeNumber(row.toolCalls),
    Math.max(0, nonNegativeNumber(row.callCount) || 1),
    nonNegativeNumber(row.detailedCallCount),
    nonNegativeNumber(row.inputCallCount),
    row.componentsValid ? 1 : 0,
    text(row.model, 200, "unknown"),
    text(row.effort, 80, "unknown"),
    text(row.cwd),
    row.gitOrigin == null ? null : text(row.gitOrigin),
    row.rawSource == null ? null : text(row.rawSource),
    row.serviceTier == null ? null : text(row.serviceTier, 80),
    originThreadId,
    row.originTimestamp == null ? null : text(row.originTimestamp, 80),
    row.originModel == null ? null : text(row.originModel, 200),
    row.originEffort == null ? null : text(row.originEffort, 80),
    row.originCwd == null ? null : text(row.originCwd),
    row.originGitOrigin == null ? null : text(row.originGitOrigin),
    row.originRawSource == null ? null : text(row.originRawSource),
    row.originServiceTier == null ? null : text(row.originServiceTier, 80),
    text(metadataRecord.project, 160, "Unknown project"),
    text(metadataRecord.model, 80, "unknown"),
    text(metadataRecord.source, 80, "unknown"),
    text(metadataRecord.useType, 80, "unknown"),
    text(metadataRecord.rateCardModel || row.model, 200, "unknown"),
    nullableNumber(metadataRecord.rateCardCredits),
    row.originalLikely ? 1 : 0,
    0,
    null,
    safeIso(row.timestamp, now),
    now,
  );
  return observationId;
}

function upsertToolObservation(database, row, now) {
  const callKey = text(row.callKey, 4_000, "");
  if (!callKey) return null;
  database.prepare(`
    INSERT INTO tool_observations (
      call_key, turn_id, thread_id, original_likely, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_key) DO UPDATE SET
      turn_id = CASE WHEN excluded.original_likely = 1
        THEN excluded.turn_id ELSE tool_observations.turn_id END,
      thread_id = CASE WHEN excluded.original_likely = 1
        THEN excluded.thread_id ELSE tool_observations.thread_id END,
      original_likely = MAX(tool_observations.original_likely, excluded.original_likely),
      last_seen_at = CASE WHEN excluded.last_seen_at > tool_observations.last_seen_at
        THEN excluded.last_seen_at ELSE tool_observations.last_seen_at END
  `).run(
    callKey,
    text(row.turnId, 400),
    text(row.threadId, 400),
    row.originalLikely ? 1 : 0,
    now,
    now,
  );
  return callKey;
}

function upsertQuotaObservation(database, row, now) {
  const windowMinutes = Math.trunc(nonNegativeNumber(row.windowMinutes));
  const resetsAt = nonNegativeNumber(row.resetsAt);
  const usedPercent = nonNegativeNumber(row.usedPercent);
  if (!windowMinutes || !resetsAt) return null;
  // The importer supplies an already privacy-safe stable key. Legacy callers
  // may still provide a human limit name, so normalize that input exactly once.
  const limitKey = row.limitKey
    ? text(row.limitKey, 160, "anonymous")
    : hash(text(row.limitName, 160, "anonymous"), 16);
  const observationKey = quotaKey(
    limitKey,
    windowMinutes,
    resetsAt,
    usedPercent,
  );
  const observationId = `quota-${hash(observationKey, 64)}`;
  const firstSeenAt = safeIso(row.timestamp, now);
  const lastSeenAt = safeIso(row.lastSeenAt, firstSeenAt);
  database.prepare(`
    INSERT INTO quota_observations (
      observation_id, observation_key, identity_kind, limit_key, limit_name,
      scope, window_minutes, resets_at, used_percent, plan_type,
      first_seen_at, last_seen_at, migrated, exact_seen
    ) VALUES (?, ?, 'exact', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
    ON CONFLICT(observation_id) DO UPDATE SET
      identity_kind = 'exact',
      migrated = 0,
      limit_name = COALESCE(excluded.limit_name, quota_observations.limit_name),
      scope = excluded.scope,
      plan_type = excluded.plan_type,
      first_seen_at = CASE WHEN excluded.first_seen_at < quota_observations.first_seen_at
        THEN excluded.first_seen_at ELSE quota_observations.first_seen_at END,
      last_seen_at = CASE WHEN excluded.last_seen_at > quota_observations.last_seen_at
        THEN excluded.last_seen_at ELSE quota_observations.last_seen_at END,
      exact_seen = 1
  `).run(
    observationId,
    observationKey,
    limitKey,
    row.limitName == null ? null : text(row.limitName, 80),
    row.scope === "named" ? "named" : "account",
    windowMinutes,
    resetsAt,
    usedPercent,
    text(row.planType, 80, "unknown"),
    firstSeenAt,
    lastSeenAt,
  );
  return observationId;
}

function upsertThreadRecord(database, row, now) {
  const threadId = text(row.id || row.threadId, 400, "");
  if (!threadId) return;
  database.prepare(`
    INSERT INTO thread_records (
      thread_id, title, project, model, effort, source, use_type,
      parent_thread_id, reported_cumulative_tokens, created_at, updated_at,
      first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      title = CASE WHEN excluded.title <> 'Untitled task' THEN excluded.title
        ELSE thread_records.title END,
      project = CASE WHEN excluded.project <> 'Unknown project' THEN excluded.project
        ELSE thread_records.project END,
      model = CASE WHEN excluded.model <> 'unknown' THEN excluded.model
        ELSE thread_records.model END,
      effort = CASE WHEN excluded.effort <> 'unknown' THEN excluded.effort
        ELSE thread_records.effort END,
      source = CASE WHEN excluded.source <> 'unknown' THEN excluded.source
        ELSE thread_records.source END,
      use_type = CASE WHEN excluded.use_type <> 'unknown' THEN excluded.use_type
        ELSE thread_records.use_type END,
      parent_thread_id = COALESCE(excluded.parent_thread_id, thread_records.parent_thread_id),
      reported_cumulative_tokens = COALESCE(excluded.reported_cumulative_tokens, thread_records.reported_cumulative_tokens),
      created_at = COALESCE(excluded.created_at, thread_records.created_at),
      updated_at = COALESCE(excluded.updated_at, thread_records.updated_at),
      last_seen_at = CASE WHEN excluded.last_seen_at > thread_records.last_seen_at
        THEN excluded.last_seen_at ELSE thread_records.last_seen_at END
  `).run(
    threadId,
    text(row.title, 180, "Untitled task"),
    text(row.project, 160, "Unknown project"),
    text(row.model, 80, "unknown"),
    text(row.effort, 40, "unknown"),
    text(row.source, 80, "unknown"),
    text(row.useType, 80, "unknown"),
    row.parentThreadId == null ? null : text(row.parentThreadId, 400),
    nullableNumber(row.reportedCumulativeTokens),
    row.createdAt == null ? null : safeIso(row.createdAt, null),
    row.updatedAt == null ? null : safeIso(row.updatedAt, null),
    now,
    now,
  );
}

function migrateAndCaptureSources({
  database,
  codexHome,
  inventory,
  includeArchived,
  now,
  tokenRows,
  callRows,
  quotas,
  eventSources,
  eventPositions,
  callSources,
  quotaSources,
  eventMetadata,
  threadRecords,
  legacySnapshot,
}) {
  const sourceMap = updateSourceStates(
    database,
    codexHome,
    inventory,
    includeArchived,
    now,
  );

  const exactObservationIds = new Map();
  const positionsByEventKey = new Map();
  for (const position of eventPositions || []) {
    const positions = positionsByEventKey.get(String(position.eventKey)) || [];
    positions.push(position);
    positionsByEventKey.set(String(position.eventKey), positions);
  }
  for (const row of tokenRows) {
    const eventKey = String(row.eventKey);
    const observationId = upsertUsageObservation(
      database,
      row,
      eventMetadata?.get(String(row.eventKey)),
      now,
      observationForSourcePosition(
        database,
        positionsByEventKey.get(eventKey),
        eventKey,
      ),
    );
    if (observationId) {
      exactObservationIds.set(eventKey, observationId);
      for (const position of positionsByEventKey.get(eventKey) || []) {
        upsertSourceEventPosition(
          database,
          position,
          observationId,
          eventKey,
          now,
        );
      }
    }
  }
  for (const [eventKey, sourceIds] of eventSources || []) {
    const observationId = exactObservationIds.get(String(eventKey)) ||
      `exact-${hash(eventKey, 64)}`;
    for (const sourceId of sourceIds) {
      database.prepare(`
        INSERT INTO usage_sources (
          observation_id, source_id, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(observation_id, source_id) DO UPDATE SET
          last_seen_at = CASE WHEN excluded.last_seen_at > usage_sources.last_seen_at
            THEN excluded.last_seen_at ELSE usage_sources.last_seen_at END
      `).run(observationId, sourceId, now, now);
    }
  }

  const exactCallKeys = new Map();
  for (const row of callRows) {
    const callKey = upsertToolObservation(database, row, now);
    if (callKey) exactCallKeys.set(String(row.callKey), callKey);
  }
  for (const [callKey, sourceIds] of callSources || []) {
    const storedCallKey = exactCallKeys.get(String(callKey)) || String(callKey);
    for (const sourceId of sourceIds) {
      database.prepare(`
        INSERT INTO tool_sources (
          call_key, source_id, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(call_key, source_id) DO UPDATE SET
          last_seen_at = CASE WHEN excluded.last_seen_at > tool_sources.last_seen_at
            THEN excluded.last_seen_at ELSE tool_sources.last_seen_at END
      `).run(storedCallKey, sourceId, now, now);
    }
  }

  const quotaObservationIds = new Map();
  for (const row of quotas || []) {
    const observationId = upsertQuotaObservation(database, row, now);
    if (observationId) {
      const key = durableQuotaObservationKey({
        limitKey: row.limitKey || row.limitName || "anonymous",
        windowMinutes: row.windowMinutes,
        resetsAt: row.resetsAt,
        usedPercent: row.usedPercent,
      });
      quotaObservationIds.set(key, observationId);
    }
  }
  for (const [key, sourceIds] of quotaSources || []) {
    const observationId = quotaObservationIds.get(String(key)) ||
      `quota-${hash(key, 64)}`;
    for (const sourceId of sourceIds) {
      database.prepare(`
        INSERT INTO quota_sources (
          observation_id, source_id, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(observation_id, source_id) DO UPDATE SET
          last_seen_at = CASE WHEN excluded.last_seen_at > quota_sources.last_seen_at
            THEN excluded.last_seen_at ELSE quota_sources.last_seen_at END
      `).run(observationId, sourceId, now, now);
    }
  }

  const sourceIds = [...sourceMap.keys()];
  const sourceCountExpression = sourceIds.length
    ? `SELECT COUNT(*) FROM usage_sources WHERE source_id = ?`
    : null;
  if (sourceCountExpression) {
    const count = database.prepare(sourceCountExpression);
    for (const sourceId of sourceIds) {
      database.prepare(
        "UPDATE source_state SET observed_event_count = ? WHERE source_id = ?",
      ).run(Number(count.get(sourceId)?.["COUNT(*)"] || 0), sourceId);
    }
  }

  let migration = null;
  if (
    legacySnapshot &&
    !database.prepare(
      "SELECT 1 AS present FROM migration_runs WHERE migration_key = ?",
    ).get("snapshot-v3-default")
  ) {
    migration = migrateLegacySnapshot(database, legacySnapshot, now);
  }
  for (const row of threadRecords || []) upsertThreadRecord(database, row, now);
  return migration;
}

function compactedBucketKey(bucket) {
  const timestampMs = finiteTimestamp(bucket.timestamp) ?? 0;
  return JSON.stringify([
    Math.floor(timestampMs / DAY_MS),
    bucket.project,
    bucket.model,
    bucket.rateCardModel,
    bucket.effort,
    bucket.source,
    bucket.useType,
    bucket.serviceTier ?? null,
    bucket.breakdownAvailable === true,
    bucket.rateCardCredits == null,
  ]);
}

function bucketMatchesUsage(bucket, row) {
  const timestampMs = finiteTimestamp(row.timestamp);
  const interval = usageInterval(bucket);
  if (timestampMs === null || interval === null) return false;
  return (
    timestampMs >= interval.startMs &&
    timestampMs < interval.endMs &&
    sameUsageDimensions(row, {
      ...bucket,
      displayModel: bucket.model,
    }) &&
    row.breakdownAvailable === (bucket.breakdownAvailable === true) &&
    (row.rateCardCredits == null) === (bucket.rateCardCredits == null)
  );
}

function compactedAggregate(existing, bucket, nowMs) {
  const existingOrigin = parseJson(existing?.range_allocation_origin);
  const existingCallCount = nonNegativeNumber(existing?.call_count);
  const addedCallCount = usageCallCount(bucket);
  const totalCallCount = existing
    ? existingCallCount + addedCallCount
    : addedCallCount;
  const existingTimestampMs = finiteTimestamp(existing?.timestamp);
  const bucketTimestampMs = finiteTimestamp(bucket.timestamp) ?? nowMs;
  const timestampMs = existing && existingTimestampMs !== null
    ? (existingTimestampMs * existingCallCount + bucketTimestampMs * addedCallCount) /
      Math.max(1, totalCallCount)
    : bucketTimestampMs;
  const existingStartMs = finiteTimestamp(existingOrigin?.startAt) ??
    existingTimestampMs ?? bucketTimestampMs;
  const bucketStartMs = finiteTimestamp(bucket.startAt) ?? bucketTimestampMs;
  const existingEndMs = finiteTimestamp(existingOrigin?.endAt) ??
    existingTimestampMs ?? bucketTimestampMs;
  const bucketEndMs = finiteTimestamp(bucket.endAt) ?? bucketTimestampMs;
  const origin = {
    startAt: new Date(Math.min(existingStartMs, bucketStartMs)).toISOString(),
    endAt: new Date(Math.max(existingEndMs, bucketEndMs)).toISOString(),
    inputTokens: nonNegativeNumber(existing?.input_tokens) +
      nonNegativeNumber(bucket.inputTokens),
    totalTokens: nonNegativeNumber(existing?.total_tokens) +
      nonNegativeNumber(bucket.totalTokens),
    callCount: totalCallCount,
  };
  return {
    timestamp: new Date(Math.round(timestampMs)).toISOString(),
    inputTokens: nonNegativeNumber(existing?.input_tokens) +
      nonNegativeNumber(bucket.inputTokens),
    cachedInputTokens: nonNegativeNumber(existing?.cached_input_tokens) +
      nonNegativeNumber(bucket.cachedInputTokens),
    cacheWriteInputTokens: nonNegativeNumber(existing?.cache_write_input_tokens) +
      nonNegativeNumber(bucket.cacheWriteInputTokens),
    outputTokens: nonNegativeNumber(existing?.output_tokens) +
      nonNegativeNumber(bucket.outputTokens),
    reasoningTokens: nonNegativeNumber(existing?.reasoning_tokens) +
      nonNegativeNumber(bucket.reasoningTokens),
    totalTokens: nonNegativeNumber(existing?.total_tokens) +
      nonNegativeNumber(bucket.totalTokens),
    toolCalls: nonNegativeNumber(existing?.tool_calls) +
      nonNegativeNumber(bucket.toolCalls),
    callCount: totalCallCount,
    detailedCallCount: nonNegativeNumber(existing?.detailed_call_count) +
      usageDetailedCallCount(bucket),
    inputCallCount: nonNegativeNumber(existing?.input_call_count) +
      usageInputCallCount(bucket),
    componentsValid: existing
      ? Number(existing.components_valid) === 1 && bucket.breakdownAvailable === true
      : bucket.breakdownAvailable === true,
    model: text(bucket.model, 200, "unknown"),
    effort: text(bucket.effort, 80, "unknown"),
    serviceTier: bucket.serviceTier == null ? null : text(bucket.serviceTier, 80),
    project: text(bucket.project, 160, "Unknown project"),
    displayModel: text(bucket.model, 80, "unknown"),
    source: text(bucket.source, 80, "unknown"),
    useType: text(bucket.useType, 80, "unknown"),
    rateCardModel: text(bucket.rateCardModel || bucket.model, 200, "unknown"),
    rateCardCredits: existing?.rate_card_credits == null
      ? nullableNumber(bucket.rateCardCredits)
      : nonNegativeNumber(existing.rate_card_credits) +
        nonNegativeNumber(bucket.rateCardCredits),
    origin,
    firstSeenAt: new Date(Math.min(existingStartMs, bucketStartMs)).toISOString(),
    lastSeenAt: new Date(Math.max(existingEndMs, bucketEndMs)).toISOString(),
  };
}

function compactOldObservations(database, nowMs) {
  const cutoffMs = nowMs - DURABLE_LEDGER_RETENTION_MS;
  const rows = database.prepare(`
    SELECT observation_id AS observationId, event_key AS eventKey,
           timestamp, input_tokens AS inputTokens,
           cached_input_tokens AS cachedInputTokens,
           cache_write_input_tokens AS cacheWriteInputTokens,
           output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens,
           total_tokens AS totalTokens, tool_calls AS toolCalls,
           call_count AS callCount, detailed_call_count AS detailedCallCount,
           input_call_count AS inputCallCount, components_valid AS componentsValid,
           token_effort AS effort, token_service_tier AS serviceTier,
           project, display_model AS displayModel, source_label AS source,
           use_type AS useType, rate_card_model AS rateCardModel,
           rate_card_credits AS rateCardCredits,
           range_allocation_estimated AS rangeAllocationEstimated
      FROM usage_observations
     WHERE identity_kind = 'exact' AND timestamp < ?
     ORDER BY timestamp, observation_id
  `).all(new Date(cutoffMs).toISOString());
  if (!rows.length) return 0;

  const sourceIdsByObservation = rowSourceIds(
    database,
    "usage_sources",
    "observation_id",
    "source_id",
  );
  const normalizedRows = rows.map((row) => {
    const normalized = normalizeTokenUsage({
      ...row,
      model: row.displayModel,
      rateCardModel: row.rateCardModel,
      timestamp: row.timestamp,
      threadIds: [],
      breakdownAvailable: Number(row.componentsValid) === 1,
      rangeAllocationEstimated: Number(row.rangeAllocationEstimated) === 1,
    });
    return normalized
      ? {
          ...normalized,
          eventKey: row.eventKey,
          observationId: String(row.observationId),
          sourceIds: sourceIdsByObservation.get(String(row.observationId)) || new Set(),
        }
      : null;
  }).filter(Boolean);
  if (!normalizedRows.length) return 0;
  const buckets = buildUsageBuckets(normalizedRows, {
    latestTimestampMs: nowMs,
  });
  const insert = database.prepare(`
    INSERT INTO usage_observations (
      observation_id, identity_kind, event_key, turn_id, thread_id, timestamp,
      input_tokens, cached_input_tokens, cache_write_input_tokens,
      output_tokens, reasoning_tokens, total_tokens, tool_calls, call_count,
      detailed_call_count, input_call_count, components_valid, token_model,
      token_effort, token_cwd, token_git_origin, token_raw_source,
      token_service_tier, origin_thread_id, origin_timestamp, origin_model,
      origin_effort, origin_cwd, origin_git_origin, origin_raw_source,
      origin_service_tier, project, display_model, source_label, use_type,
      rate_card_model, rate_card_credits, original_likely,
      range_allocation_estimated, range_allocation_origin, first_seen_at,
      last_seen_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(observation_id) DO UPDATE SET
      timestamp = excluded.timestamp,
      input_tokens = excluded.input_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      cache_write_input_tokens = excluded.cache_write_input_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      total_tokens = excluded.total_tokens,
      tool_calls = excluded.tool_calls,
      call_count = excluded.call_count,
      detailed_call_count = excluded.detailed_call_count,
      input_call_count = excluded.input_call_count,
      components_valid = excluded.components_valid,
      token_model = excluded.token_model,
      token_effort = excluded.token_effort,
      token_service_tier = excluded.token_service_tier,
      project = excluded.project,
      display_model = excluded.display_model,
      source_label = excluded.source_label,
      use_type = excluded.use_type,
      rate_card_model = excluded.rate_card_model,
      rate_card_credits = excluded.rate_card_credits,
      range_allocation_origin = excluded.range_allocation_origin,
      first_seen_at = excluded.first_seen_at,
      last_seen_at = excluded.last_seen_at
  `);
  const insertSource = database.prepare(`
    INSERT INTO usage_sources (
      observation_id, source_id, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(observation_id, source_id) DO UPDATE SET
      last_seen_at = CASE WHEN excluded.last_seen_at > usage_sources.last_seen_at
        THEN excluded.last_seen_at ELSE usage_sources.last_seen_at END
  `);
  const insertMembership = database.prepare(`
    INSERT INTO usage_compaction_membership (
      event_key, observation_id, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(event_key) DO UPDATE SET
      observation_id = excluded.observation_id,
      last_seen_at = CASE WHEN excluded.last_seen_at > usage_compaction_membership.last_seen_at
        THEN excluded.last_seen_at ELSE usage_compaction_membership.last_seen_at END
  `);
  const compactedIds = new Set();
  const compactedIdByMember = new Map();
  for (const bucket of buckets) {
    const members = normalizedRows.filter((row) => bucketMatchesUsage(bucket, row));
    if (!members.length) continue;
    const id = `compacted-${hash(compactedBucketKey(bucket), 64)}`;
    const existing = database.prepare(`
      SELECT timestamp, input_tokens, cached_input_tokens,
             cache_write_input_tokens, output_tokens, reasoning_tokens,
             total_tokens, tool_calls, call_count, detailed_call_count,
             input_call_count, components_valid, rate_card_credits,
             range_allocation_origin
        FROM usage_observations
       WHERE observation_id = ?
    `).get(id);
    const aggregate = compactedAggregate(existing, bucket, nowMs);
    insert.run(
      id,
      "compacted",
      null,
      "",
      `compacted:${hash(id, 24)}`,
      aggregate.timestamp,
      aggregate.inputTokens,
      aggregate.cachedInputTokens,
      aggregate.cacheWriteInputTokens,
      aggregate.outputTokens,
      aggregate.reasoningTokens,
      aggregate.totalTokens,
      aggregate.toolCalls,
      aggregate.callCount,
      aggregate.detailedCallCount,
      aggregate.inputCallCount,
      aggregate.componentsValid ? 1 : 0,
      aggregate.model,
      aggregate.effort,
      "",
      null,
      null,
      aggregate.serviceTier,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      aggregate.project,
      aggregate.displayModel,
      aggregate.source,
      aggregate.useType,
      aggregate.rateCardModel,
      aggregate.rateCardCredits,
      1,
      1,
      JSON.stringify(aggregate.origin),
      aggregate.firstSeenAt,
      aggregate.lastSeenAt,
    );
    const sourceIds = new Set(sourceIdsByObservation.get(id) || []);
    for (const member of members) {
      for (const sourceId of member.sourceIds) sourceIds.add(sourceId);
      if (member.eventKey) {
        insertMembership.run(member.eventKey, id, isoNow(nowMs), isoNow(nowMs));
      }
      compactedIds.add(member.observationId);
      compactedIdByMember.set(member.observationId, id);
    }
    for (const sourceId of sourceIds) {
      insertSource.run(id, sourceId, aggregate.firstSeenAt, aggregate.lastSeenAt);
    }
  }
  const deleteRows = database.prepare(
    "DELETE FROM usage_observations WHERE observation_id = ?",
  );
  const updatePositions = database.prepare(
    "UPDATE source_event_positions SET observation_id = ? WHERE observation_id = ?",
  );
  const deleteSources = database.prepare(
    "DELETE FROM usage_sources WHERE observation_id = ?",
  );
  for (const id of compactedIds) {
    updatePositions.run(compactedIdByMember.get(id), id);
    deleteSources.run(id);
    deleteRows.run(id);
  }
  return compactedIds.size;
}

function pruneExpiredLedgerData(database, nowMs) {
  const cutoff = isoNow(nowMs - DURABLE_LEDGER_COMPACTED_RETENTION_MS);
  const expiredUsage = database.prepare(`
    SELECT observation_id AS observationId, timestamp, range_allocation_origin AS origin
      FROM usage_observations
     WHERE identity_kind IN ('compacted', 'migrated_compacted')
  `).all().filter((row) => {
    const origin = parseJson(row.origin);
    const endAt = finiteTimestamp(origin?.endAt) ?? finiteTimestamp(row.timestamp);
    return endAt !== null && endAt < Date.parse(cutoff);
  });
  const deleteMembership = database.prepare(
    "DELETE FROM usage_compaction_membership WHERE observation_id = ?",
  );
  const deletePositions = database.prepare(
    "DELETE FROM source_event_positions WHERE observation_id = ?",
  );
  const deleteUsageSources = database.prepare(
    "DELETE FROM usage_sources WHERE observation_id = ?",
  );
  const deleteUsage = database.prepare(
    "DELETE FROM usage_observations WHERE observation_id = ?",
  );
  for (const row of expiredUsage) {
    deleteMembership.run(row.observationId);
    deletePositions.run(row.observationId);
    deleteUsageSources.run(row.observationId);
    deleteUsage.run(row.observationId);
  }

  const expiredQuota = database.prepare(`
    SELECT observation_id AS observationId
      FROM quota_observations
     WHERE last_seen_at < ?
  `).all(cutoff);
  const deleteQuotaSources = database.prepare(
    "DELETE FROM quota_sources WHERE observation_id = ?",
  );
  const deleteQuota = database.prepare(
    "DELETE FROM quota_observations WHERE observation_id = ?",
  );
  for (const row of expiredQuota) {
    deleteQuotaSources.run(row.observationId);
    deleteQuota.run(row.observationId);
  }

  const expiredTools = database.prepare(`
    SELECT call_key AS callKey
      FROM tool_observations
     WHERE last_seen_at < ?
  `).all(cutoff);
  const deleteToolSources = database.prepare(
    "DELETE FROM tool_sources WHERE call_key = ?",
  );
  const deleteTools = database.prepare(
    "DELETE FROM tool_observations WHERE call_key = ?",
  );
  for (const row of expiredTools) {
    deleteToolSources.run(row.callKey);
    deleteTools.run(row.callKey);
  }

  database.prepare(`
    DELETE FROM source_state
     WHERE status IN ('missing', 'tombstoned')
       AND last_seen_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM usage_sources WHERE source_id = source_state.source_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM quota_sources WHERE source_id = source_state.source_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM tool_sources WHERE source_id = source_state.source_id
       )
  `).run(cutoff);
  database.prepare(`
    DELETE FROM thread_records
     WHERE last_seen_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM usage_observations
          WHERE thread_id = thread_records.thread_id
            AND identity_kind = 'exact'
       )
  `).run(cutoff);
  return expiredUsage.length + expiredQuota.length + expiredTools.length;
}

function databaseUsageRows(database, includeArchived, sources) {
  const sourceIds = rowSourceIds(
    database,
    "usage_sources",
    "observation_id",
    "source_id",
  );
  const compactedEventKeys = new Map();
  for (const row of database.prepare(`
    SELECT event_key AS eventKey, observation_id AS observationId
      FROM usage_compaction_membership
  `).all()) {
    const keys = compactedEventKeys.get(String(row.observationId)) || [];
    keys.push(String(row.eventKey));
    compactedEventKeys.set(String(row.observationId), keys);
  }
  const rows = [];
  for (const row of database.prepare(`
    SELECT observation_id AS observationId,
           identity_kind AS identityKind, event_key AS eventKey,
           turn_id AS turnId, thread_id AS threadId, timestamp,
           input_tokens AS inputTokens,
           cached_input_tokens AS cachedInputTokens,
           cache_write_input_tokens AS cacheWriteInputTokens,
           output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens,
           total_tokens AS totalTokens, tool_calls AS toolCalls,
           call_count AS callCount, detailed_call_count AS detailedCallCount,
           input_call_count AS inputCallCount,
           components_valid AS componentsValid, token_model AS tokenModel,
           token_effort AS tokenEffort, token_cwd AS tokenCwd,
           token_git_origin AS tokenGitOrigin,
           token_raw_source AS tokenRawSource,
           token_service_tier AS tokenServiceTier,
           origin_thread_id AS originThreadId,
           origin_timestamp AS originTimestamp,
           origin_model AS originModel, origin_effort AS originEffort,
           origin_cwd AS originCwd, origin_git_origin AS originGitOrigin,
           origin_raw_source AS originRawSource,
           origin_service_tier AS originServiceTier,
           project, display_model AS displayModel,
           source_label AS sourceLabel, use_type AS useType,
           rate_card_model AS rateCardModel,
           rate_card_credits AS rateCardCredits,
           original_likely AS originalLikely,
           range_allocation_estimated AS rangeAllocationEstimated,
           range_allocation_origin AS rangeAllocationOrigin
      FROM usage_observations
     ORDER BY timestamp, observation_id
  `).all()) {
    const associated = sourceIds.get(String(row.observationId)) || new Set();
    if (
      (row.identityKind === "exact" || row.identityKind === "compacted") &&
      !sourceAssociationAllows(associated, sources, includeArchived)
    ) continue;
    if (row.identityKind === "migrated_compacted" && !includeArchived) continue;
    const usageRow = usageRowFromDatabase(row, associated);
    if (row.identityKind === "compacted") {
      usageRow.compactedEventKeys = compactedEventKeys.get(
        String(row.observationId),
      ) || [];
    }
    rows.push(usageRow);
  }
  const exactRows = rows.filter((row) => row.identityKind === "exact");
  return rows
    .filter((row) => row.identityKind !== "migrated_compacted")
    .concat(
      includeArchived
        ? rows
          .filter((row) => row.identityKind === "migrated_compacted")
          .map((row) => subtractMigratedRow(row, exactRows))
          .filter(Boolean)
        : [],
    )
    .sort((left, right) =>
      (finiteTimestamp(left.timestamp) ?? 0) -
      (finiteTimestamp(right.timestamp) ?? 0) ||
      left.observationId.localeCompare(right.observationId),
    );
}

function databaseQuotaRows(database, includeArchived, sources) {
  const sourceIds = rowSourceIds(
    database,
    "quota_sources",
    "observation_id",
    "source_id",
  );
  return database.prepare(`
    SELECT observation_id AS observationId, observation_key AS observationKey,
           identity_kind AS identityKind, limit_key AS limitKey,
           limit_name AS limitName, scope, window_minutes AS windowMinutes,
           resets_at AS resetsAt, used_percent AS usedPercent,
           plan_type AS planType, first_seen_at AS firstSeenAt,
           last_seen_at AS lastSeenAt, migrated, exact_seen AS exactSeen
      FROM quota_observations
     ORDER BY first_seen_at, observation_id
  `).all()
    .filter((row) => {
      if (includeArchived) return true;
      return sourceAssociationAllows(
        sourceIds.get(String(row.observationId)) || new Set(),
        sources,
        false,
      );
    })
    .map((row) => ({
      id: `quota-${hash(row.observationKey, 24)}`,
      timestamp: text(row.firstSeenAt, 80),
      lastSeenAt: text(row.lastSeenAt, 80),
      usedPercent: nonNegativeNumber(row.usedPercent),
      windowMinutes: Math.trunc(nonNegativeNumber(row.windowMinutes)),
      resetsAt: nonNegativeNumber(row.resetsAt),
      planType: text(row.planType, 80, "unknown"),
      limitKey: text(row.limitKey, 24, "anonymous"),
      limitName: row.limitName == null ? null : text(row.limitName, 80),
      scope: row.scope === "named" ? "named" : "account",
      source: "log",
      identityKind: text(row.identityKind, 40, "exact"),
      migrated: Number(row.migrated) === 1,
      exactSeen: Number(row.exactSeen) === 1,
    }));
}

function databaseToolRows(database, includeArchived, sources) {
  const sourceIds = rowSourceIds(
    database,
    "tool_sources",
    "call_key",
    "source_id",
  );
  return database.prepare(`
    SELECT call_key AS callKey, turn_id AS turnId, thread_id AS threadId,
           original_likely AS originalLikely
      FROM tool_observations
  `).all()
    .filter((row) => includeArchived || sourceAssociationAllows(
      sourceIds.get(String(row.callKey)) || new Set(),
      sources,
      false,
    ))
    .map((row) => ({
      callKey: String(row.callKey),
      turnId: text(row.turnId, 400),
      threadId: text(row.threadId, 400),
      originalLikely: Number(row.originalLikely) === 1,
      sourceIds: sourceIds.get(String(row.callKey)) || new Set(),
    }));
}

function databaseThreadRows(database) {
  return database.prepare(`
    SELECT thread_id AS threadId, title, project, model, effort, source,
           use_type AS useType, parent_thread_id AS parentThreadId,
           reported_cumulative_tokens AS reportedCumulativeTokens,
           created_at AS createdAt, updated_at AS updatedAt
      FROM thread_records
  `).all().map((row) => ({
    id: String(row.threadId),
    title: text(row.title, 180, "Untitled task"),
    project: text(row.project, 160, "Unknown project"),
    model: text(row.model, 80, "unknown"),
    effort: text(row.effort, 40, "unknown"),
    source: text(row.source, 80, "unknown"),
    useType: text(row.useType, 80, "unknown"),
    parentThreadId: row.parentThreadId == null
      ? null
      : text(row.parentThreadId, 400),
    reportedCumulativeTokens: nullableNumber(row.reportedCumulativeTokens),
    createdAt: row.createdAt == null ? null : text(row.createdAt, 80),
    updatedAt: row.updatedAt == null ? null : text(row.updatedAt, 80),
  }));
}

function sourceSummary(database) {
  const states = database.prepare(`
    SELECT source_id AS sourceId, location, status,
           observed_event_count AS observedEventCount,
           change_state AS changeState, change_count AS changeCount
      FROM source_state
  `).all().map((row) => ({
    sourceId: String(row.sourceId),
    location: text(row.location, 20, "active"),
    status: text(row.status, 20, "missing"),
    observedEventCount: nonNegativeNumber(row.observedEventCount),
    changeState: text(row.changeState, 40, "stable"),
    changeCount: nonNegativeNumber(row.changeCount),
  }));
  const counts = {
    active: 0,
    archived: 0,
    missing: 0,
    tombstoned: 0,
    changed: 0,
  };
  for (const state of states) {
    if (Object.prototype.hasOwnProperty.call(counts, state.status)) {
      counts[state.status] += 1;
    }
    if (state.changeState !== "stable") counts.changed += 1;
  }
  return {
    states,
    counts,
    sourceIncomplete: counts.tombstoned > 0 || counts.missing > 0 ||
      counts.changed > 0,
    activeSources: counts.active,
    archivedSources: counts.archived,
    missingSources: counts.missing,
    tombstonedSources: counts.tombstoned,
  };
}

async function readLegacyIfNeeded(database, legacySnapshotPath) {
  if (metaValue(database, "legacy_snapshot_checked") === "1") return null;
  return readLegacySnapshot(legacySnapshotPath);
}

export async function readDurableLedger(
  path,
  { includeArchived = true } = {},
) {
  const ledgerPath = resolve(path);
  let database;
  try {
    database = await openLedger(ledgerPath, true);
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== DURABLE_LEDGER_SCHEMA_VERSION) {
      const error = new Error("Unsupported Token Ledger durable ledger schema.");
      error.code = "ERR_DURABLE_LEDGER_SCHEMA";
      throw error;
    }
    const sources = new Map(
      sourceSummary(database).states.map((state) => [state.sourceId, state]),
    );
    const summary = sourceSummary(database);
    const usageRows = databaseUsageRows(database, includeArchived, sources);
    const quotaRows = databaseQuotaRows(database, includeArchived, sources);
    const toolRows = databaseToolRows(database, includeArchived, sources);
    const threadRows = databaseThreadRows(database);
    const migration = database.prepare(`
      SELECT migration_key AS migrationKey,
             source_fingerprint AS sourceFingerprint,
             generated_at AS generatedAt, migrated_at AS migratedAt,
             usage_rows AS usageRows, quota_rows AS quotaRows
        FROM migration_runs
       ORDER BY migrated_at DESC
       LIMIT 1
    `).get() || null;
    const migratedUsageRows = usageRows.filter(
      (row) => row.identityKind === "migrated_compacted",
    );
    const compactedUsageRows = usageRows.filter(
      (row) => row.identityKind === "compacted",
    );
    return {
      path: ledgerPath,
      revision: Number(metaValue(database, "revision") || 0),
      usageRows,
      quotaRows,
      toolRows,
      threadRows,
      sourceSummary: summary,
      migration,
      migratedUsageRows: migratedUsageRows.length,
      migratedUsageTokens: migratedUsageRows.reduce(
        (sum, row) => sum + row.totalTokens,
        0,
      ),
      compactedUsageRows: compactedUsageRows.length,
      migratedQuotaRows: quotaRows.filter((row) => row.migrated).length,
    };
  } finally {
    closeDatabase(database);
  }
}

export async function readDurableLedgerRevision(path) {
  const ledgerPath = resolve(path);
  try {
    const sourceStat = await stat(ledgerPath);
    if (!sourceStat.isFile()) return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let database;
  try {
    database = await openLedger(ledgerPath, true);
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== DURABLE_LEDGER_SCHEMA_VERSION) return null;
    const revision = Number(metaValue(database, "revision"));
    return Number.isSafeInteger(revision) ? revision : null;
  } catch (error) {
    if (
      [
        "ERR_DURABLE_LEDGER_SCHEMA",
        "SQLITE_NOTADB",
        "SQLITE_CORRUPT",
        "SQLITE_BUSY",
      ].includes(error?.code)
    ) return null;
    throw error;
  } finally {
    closeDatabase(database);
  }
}

export async function updateDurableLedger({
  options = {},
  codexHome,
  inventory,
  includeArchived = true,
  tokenRows = [],
  callRows = [],
  quotas = [],
  eventSources = new Map(),
  eventPositions = [],
  callSources = new Map(),
  quotaSources = new Map(),
  eventMetadata = new Map(),
  threadRecords = [],
  nowMs = Date.now(),
  legacySnapshotPath = options.legacySnapshotPath || options.output,
  faultInjector = null,
} = {}) {
  const ledgerPath = resolveDurableLedgerPath({
    ...options,
    output: options.output,
  });
  const now = isoNow(nowMs);
  const legacySnapshot = await (async () => {
    let database;
    try {
      database = await openLedger(ledgerPath, false);
      return await readLegacyIfNeeded(database, legacySnapshotPath);
    } finally {
      closeDatabase(database);
    }
  })();

  let database;
  let committed = false;
  try {
    database = await openLedger(ledgerPath, false);
    database.exec("BEGIN IMMEDIATE");
    const migration = migrateAndCaptureSources({
      database,
      codexHome,
      inventory,
      includeArchived,
      now,
      tokenRows,
      callRows,
      quotas,
      eventSources,
      eventPositions,
      callSources,
      quotaSources,
      eventMetadata,
      threadRecords,
      legacySnapshot,
    });
    compactOldObservations(database, nowMs);
    pruneExpiredLedgerData(database, nowMs);
    const previousRevision = Number(metaValue(database, "revision") || 0);
    const nextRevision = Number.isSafeInteger(previousRevision)
      ? previousRevision + 1
      : 1;
    setMeta(database, "revision", nextRevision);
    setMeta(database, "schema_version", DURABLE_LEDGER_SCHEMA_VERSION);
    if (metaValue(database, "legacy_snapshot_checked") !== "1") {
      setMeta(database, "legacy_snapshot_checked", "1");
    }
    if (faultInjector instanceof Function) {
      faultInjector({ point: "before-commit", path: ledgerPath });
    }
    database.exec("COMMIT");
    committed = true;
    if (faultInjector instanceof Function) {
      faultInjector({ point: "after-commit", path: ledgerPath });
    }
    await restrictLedgerFiles(ledgerPath);
    return {
      ...(await readDurableLedger(ledgerPath, { includeArchived })),
      committed,
      migration,
    };
  } catch (error) {
    if (!committed) {
      try {
        database?.exec("ROLLBACK");
      } catch {
        // SQLite's recovery journal remains authoritative after an interrupted
        // or failed transaction.
      }
    }
    throw error;
  } finally {
    closeDatabase(database);
    await restrictLedgerFiles(ledgerPath);
  }
}
