import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { readPrivateSnapshot } from "./token-ledger-snapshot.mjs";
import { snapshotCollectionScope } from "./token-ledger-collection.mjs";
import {
  buildUsageBuckets,
  normalizeTokenUsage,
  usageCallCount,
  usageDetailedCallCount,
  usageInputCallCount,
} from "./token-ledger-usage.mjs";

export const DURABLE_LEDGER_SCHEMA_VERSION = 2;
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
const LEDGER_RECOVERY_PROTOCOL_VERSION = 1;
const LEDGER_RECOVERY_MARKER_MAX_BYTES = 16 * 1_024;
const LEDGER_RECOVERY_COPY_FLAGS =
  fsConstants.COPYFILE_FICLONE | fsConstants.COPYFILE_EXCL;
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

export function codexHomeFingerprint(codexHome) {
  return hash(canonicalCodexHome(codexHome), 64);
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
      reconciliation_pending INTEGER NOT NULL DEFAULT 0,
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

    CREATE INDEX IF NOT EXISTS source_event_positions_observation
      ON source_event_positions(observation_id);

    CREATE TABLE IF NOT EXISTS usage_compaction_membership (
      event_key TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS usage_compaction_membership_observation
      ON usage_compaction_membership(observation_id);

    CREATE TABLE IF NOT EXISTS usage_sources (
      observation_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY(observation_id, source_id)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS usage_sources_source
      ON usage_sources(source_id);

    CREATE TABLE IF NOT EXISTS usage_tool_membership (
      observation_id TEXT NOT NULL,
      call_key TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY(observation_id, call_key)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS usage_tool_membership_call
      ON usage_tool_membership(call_key);

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

    CREATE INDEX IF NOT EXISTS tool_sources_source
      ON tool_sources(source_id);

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

    CREATE INDEX IF NOT EXISTS quota_sources_source
      ON quota_sources(source_id);

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
      collection_since TEXT,
      include_archived INTEGER,
      scope_known INTEGER NOT NULL DEFAULT 1,
      codex_home_fingerprint TEXT,
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

function ledgerRecoveryPaths(ledgerPath) {
  const path = resolve(ledgerPath);
  return {
    ledgerPath: path,
    markerPath: `${path}.recovery.json`,
    backupPath: `${path}.recovery.sqlite`,
    backupTempPath: `${path}.recovery.prepare`,
    markerTempPath: `${path}.recovery.json.prepare`,
    restoreTempPath: `${path}.recovery.restore`,
    ledgerIdentity: hash(`token-ledger-recovery:${path}`, 64),
  };
}

function ledgerRecoveryError(message, cause = null) {
  const error = cause === null
    ? new Error(message)
    : new Error(message, { cause });
  error.code = "ERR_DURABLE_LEDGER_RECOVERY";
  return error;
}

function attachCleanupError(primaryError, cleanupError) {
  if (!(primaryError instanceof Error)) return;
  const prior = Array.isArray(primaryError.cleanupErrors)
    ? primaryError.cleanupErrors
    : [];
  primaryError.cleanupErrors = [...prior, cleanupError];
}

async function runCleanup(primaryError, cleanup) {
  try {
    await cleanup();
    return primaryError;
  } catch (cleanupError) {
    if (primaryError !== null) {
      attachCleanupError(primaryError, cleanupError);
      return primaryError;
    }
    return cleanupError;
  }
}

async function syncPath(path, noFollow = false) {
  const flags = noFollow
    ? fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    : "r";
  const handle = await open(path, flags);
  let primaryError = null;
  try {
    await handle.sync();
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (primaryError === null) primaryError = error;
    else attachCleanupError(primaryError, error);
  }
  if (primaryError !== null) throw primaryError;
}

async function syncLedgerDirectory(ledgerPath) {
  await syncPath(dirname(ledgerPath));
}

async function regularFileStat(path) {
  try {
    const fileStat = await lstat(path);
    return fileStat.isFile() ? fileStat : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return null;
    throw error;
  }
}

async function pathPresent(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false;
    throw error;
  }
}

async function recoveryMarkerPresent(ledgerPath) {
  return pathPresent(ledgerRecoveryPaths(ledgerPath).markerPath);
}

function sqliteSidecarPaths(path) {
  return [`${path}-wal`, `${path}-shm`];
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false;
    throw error;
  }
}

async function ensureLedgerDirectory(
  path,
  privateDirectory,
  enforcePrivateDirectory = false,
) {
  const directory = dirname(path);
  const existed = await directoryExists(directory);
  await mkdir(directory, {
    recursive: true,
    mode: privateDirectory ? 0o700 : 0o777,
  });
  if (privateDirectory && (!existed || enforcePrivateDirectory)) {
    await chmodIfPresent(directory, 0o700);
  }
}

async function openLedger(
  path,
  readOnly = false,
  {
    privateDirectory = false,
    enforcePrivateDirectory = false,
  } = {},
) {
  if (!readOnly) {
    await ensureLedgerDirectory(
      path,
      privateDirectory,
      enforcePrivateDirectory,
    );
  }
  const database = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
  database.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
  if (!readOnly) {
    const version = Number(
      database.prepare("PRAGMA user_version").get()?.user_version,
    );
    if (version > DURABLE_LEDGER_SCHEMA_VERSION) {
      const error = new Error("Unsupported Token Ledger durable ledger schema.");
      error.code = "ERR_DURABLE_LEDGER_SCHEMA";
      try {
        database.close();
      } catch {
        // The schema error remains authoritative.
      }
      throw error;
    }
    if (version === 1) {
      try {
        assertSchemaV1MigrationScope(database);
      } catch (error) {
        closeDatabase(database);
        throw error;
      }
    }
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA foreign_keys = ON");
    if (version === 1) {
      migrateLedgerSchemaV1ToV2(database);
    } else {
      database.exec(ledgerSchema());
    }
    ensureLedgerColumns(database);
    database.exec(`PRAGMA user_version = ${DURABLE_LEDGER_SCHEMA_VERSION}`);
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
  if (!columns.has("reconciliation_pending")) {
    database.exec(
      "ALTER TABLE source_state ADD COLUMN reconciliation_pending INTEGER NOT NULL DEFAULT 0",
    );
  }
}

function tableColumns(database, table) {
  return new Set(database.prepare(
    `PRAGMA table_info(${table})`,
  ).all().map((column) => String(column.name)));
}

function addColumnIfMissing(database, table, columns, definition) {
  const [name] = definition.split(/\s+/, 1);
  if (columns.has(name)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  columns.add(name);
}

function tableExists(database, table) {
  return Boolean(database.prepare(`
    SELECT 1 AS present
      FROM sqlite_master
     WHERE type = 'table' AND name = ?
  `).get(table));
}

function assertSchemaV1MigrationScope(database) {
  if (!tableExists(database, "migration_runs")) return;
  const columns = tableColumns(database, "migration_runs");
  const unscopedRows = columns.has("include_archived")
    ? Number(database.prepare(`
      SELECT COUNT(*) AS count
        FROM migration_runs
       WHERE include_archived IS NULL
    `).get()?.count || 0)
    : Number(database.prepare(
      "SELECT COUNT(*) AS count FROM migration_runs",
    ).get()?.count || 0);
  if (unscopedRows === 0) return;
  const error = new Error(
    "This early preview durable ledger contains migrated history without a reconstructable collection scope. The ledger was left untouched. Keep it as a backup, verify the matching legacy snapshot belongs to this Codex home, and rebuild into a new v2 ledger before reconciling totals.",
  );
  error.code = "ERR_DURABLE_LEDGER_MIGRATION_SCOPE";
  throw error;
}

function scrubPrivateLedgerMetadata(database) {
  database.exec(`
    UPDATE usage_observations
       SET token_cwd = '',
           token_git_origin = NULL,
           token_raw_source = NULL,
           origin_cwd = NULL,
           origin_git_origin = NULL,
           origin_raw_source = NULL;
  `);
  const storedHome = metaValue(database, "codex_home");
  if (
    storedHome !== null &&
    metaValue(database, "codex_home_fingerprint") === null
  ) {
    setMeta(
      database,
      "codex_home_fingerprint",
      hash(canonicalCodexHome(storedHome), 64),
    );
  }
  database.prepare("DELETE FROM ledger_meta WHERE key = ?").run("codex_home");
}

function migrateLedgerSchemaV1ToV2(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(ledgerSchema());
    const migrationColumns = tableColumns(database, "migration_runs");
    const hadIncludeArchived = migrationColumns.has("include_archived");
    addColumnIfMissing(
      database,
      "migration_runs",
      migrationColumns,
      "collection_since TEXT",
    );
    addColumnIfMissing(
      database,
      "migration_runs",
      migrationColumns,
      "include_archived INTEGER",
    );
    addColumnIfMissing(
      database,
      "migration_runs",
      migrationColumns,
      "scope_known INTEGER NOT NULL DEFAULT 0",
    );
    addColumnIfMissing(
      database,
      "migration_runs",
      migrationColumns,
      "codex_home_fingerprint TEXT",
    );
    // Preview ledgers that already recorded include_archived retain that
    // trustworthy portion of their scope. Earlier previews cannot reconstruct
    // it, so NULL remains an explicit unknown instead of assuming a scope.
    if (hadIncludeArchived) {
      database.exec(`
        UPDATE migration_runs
           SET scope_known = 0
         WHERE scope_known IS NULL OR scope_known <> 1;
      `);
    }
    scrubPrivateLedgerMetadata(database);
    setMeta(database, "schema_version", DURABLE_LEDGER_SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${DURABLE_LEDGER_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The migration error remains authoritative.
    }
    throw error;
  }
  // Rebuild the file after the transactional scrub so deleted path and
  // credential bytes are not retained in free pages or the WAL.
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec("VACUUM");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

async function restrictLedgerFiles(path) {
  await chmodIfPresent(path, 0o600);
  await chmodIfPresent(`${path}-wal`, 0o600);
  await chmodIfPresent(`${path}-shm`, 0o600);
}

async function acquireLedgerWriteLock(
  ledgerPath,
  privateDirectory,
  enforcePrivateDirectory = false,
) {
  await ensureLedgerDirectory(
    ledgerPath,
    privateDirectory,
    enforcePrivateDirectory,
  );
  const path = `${ledgerPath}.writer-lock.sqlite`;
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS writer_guard (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      );
      BEGIN EXCLUSIVE;
    `);
    await restrictLedgerFiles(path);
    return { database, path };
  } catch (error) {
    closeDatabase(database);
    throw error;
  }
}

async function acquireLedgerReadLock(ledgerPath) {
  await ensureLedgerDirectory(ledgerPath, false);
  const path = `${ledgerPath}.writer-lock.sqlite`;
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS writer_guard (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      );
      BEGIN;
    `);
    database.prepare("SELECT COUNT(*) FROM writer_guard").get();
    await restrictLedgerFiles(path);
    return { database, path };
  } catch (error) {
    closeDatabase(database);
    throw error;
  }
}

function releaseLedgerLock(lock) {
  try {
    lock?.database?.exec("ROLLBACK");
  } catch {
    // Closing the guard connection still releases its SQLite writer lock.
  }
  closeDatabase(lock?.database);
}

async function readLedgerRecoveryMarker(ledgerPath) {
  const paths = ledgerRecoveryPaths(ledgerPath);
  let markerStat;
  try {
    markerStat = await lstat(paths.markerPath);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return null;
    throw error;
  }
  if (!markerStat.isFile()) {
    throw ledgerRecoveryError(
      "The durable-ledger recovery marker is not a regular file.",
    );
  }
  if (markerStat.size > LEDGER_RECOVERY_MARKER_MAX_BYTES) {
    throw ledgerRecoveryError(
      "The durable-ledger recovery marker exceeds its safety limit.",
    );
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(paths.markerPath, "utf8"));
  } catch (cause) {
    throw ledgerRecoveryError(
      "The durable-ledger recovery marker is unreadable.",
      cause,
    );
  }
  const attemptId = primitiveString(marker?.attemptId);
  if (
    marker?.protocolVersion !== LEDGER_RECOVERY_PROTOCOL_VERSION ||
    marker?.ledgerIdentity !== paths.ledgerIdentity ||
    marker?.backupFile !== basename(paths.backupPath) ||
    !Number.isSafeInteger(marker?.baselineRevision) ||
    marker.baselineRevision < 0 ||
    !Number.isSafeInteger(marker?.schemaVersion) ||
    marker.schemaVersion < 1 ||
    marker.schemaVersion > DURABLE_LEDGER_SCHEMA_VERSION ||
    !Number.isSafeInteger(marker?.backupSize) ||
    marker.backupSize < 1 ||
    attemptId === null ||
    attemptId.length < 1 ||
    attemptId.length > 80
  ) {
    throw ledgerRecoveryError(
      "The durable-ledger recovery marker is invalid for this ledger.",
    );
  }
  return {
    ...paths,
    attemptId,
    baselineRevision: marker.baselineRevision,
    schemaVersion: marker.schemaVersion,
    backupSize: marker.backupSize,
    markerActive: true,
  };
}

async function validateLedgerRecoveryBackup(
  recovery,
  { quickCheck = true } = {},
) {
  let database;
  try {
    let removedSidecar = false;
    for (const sidecarPath of sqliteSidecarPaths(recovery.backupPath)) {
      if (await pathPresent(sidecarPath)) {
        await rm(sidecarPath, { force: true });
        removedSidecar = true;
      }
    }
    if (removedSidecar) await syncLedgerDirectory(recovery.backupPath);
    const backupStat = await regularFileStat(recovery.backupPath);
    if (backupStat === null || backupStat.size !== recovery.backupSize) {
      throw ledgerRecoveryError(
        "The durable-ledger recovery backup is missing or incomplete.",
      );
    }
    database = new DatabaseSync(recovery.backupPath, { readOnly: true });
    const version = Number(
      database.prepare("PRAGMA user_version").get()?.user_version,
    );
    const revision = Number(metaValue(database, "revision") || 0);
    if (
      version !== recovery.schemaVersion ||
      revision !== recovery.baselineRevision
    ) {
      throw ledgerRecoveryError(
        "The durable-ledger recovery backup identity did not match its marker.",
      );
    }
    if (quickCheck) {
      const result = database.prepare("PRAGMA quick_check").get();
      if (String(result?.quick_check) !== "ok") {
        throw ledgerRecoveryError(
          "The durable-ledger recovery backup failed SQLite validation.",
        );
      }
    }
  } catch (cause) {
    if (cause?.code === "ERR_DURABLE_LEDGER_RECOVERY") throw cause;
    throw ledgerRecoveryError(
      "The durable-ledger recovery backup could not be validated.",
      cause,
    );
  } finally {
    closeDatabase(database);
  }
}

async function cleanupInactiveLedgerRecovery(recovery) {
  const cleanupPaths = [
    recovery.backupPath,
    recovery.backupTempPath,
    recovery.markerTempPath,
    recovery.restoreTempPath,
    ...sqliteSidecarPaths(recovery.backupPath),
    ...sqliteSidecarPaths(recovery.backupTempPath),
    ...sqliteSidecarPaths(recovery.restoreTempPath),
  ];
  const existing = [];
  for (const path of cleanupPaths) {
    if (await pathPresent(path)) existing.push(path);
  }
  for (const path of existing) await rm(path, { force: true });
  if (existing.length > 0) await syncLedgerDirectory(recovery.ledgerPath);
}

async function deactivateLedgerRecovery(recovery) {
  await rm(recovery.markerPath, { force: true });
  await syncLedgerDirectory(recovery.ledgerPath);
  recovery.markerActive = false;
}

async function prepareLedgerRecovery(
  database,
  ledgerPath,
  { faultInjector = null } = {},
) {
  const paths = ledgerRecoveryPaths(ledgerPath);
  const existing = await readLedgerRecoveryMarker(ledgerPath);
  if (existing !== null) {
    throw ledgerRecoveryError(
      "The prior durable-ledger recovery attempt was not resolved.",
    );
  }
  await cleanupInactiveLedgerRecovery(paths);

  const checkpoint = database.prepare(
    "PRAGMA wal_checkpoint(TRUNCATE)",
  ).get();
  if (Number(checkpoint?.busy) !== 0 || Number(checkpoint?.log) !== 0) {
    throw ledgerRecoveryError(
      "The durable ledger could not checkpoint before recovery staging.",
    );
  }

  const baselineRevision = Number(metaValue(database, "revision") || 0);
  if (!Number.isSafeInteger(baselineRevision) || baselineRevision < 0) {
    throw ledgerRecoveryError(
      "The durable-ledger baseline revision is invalid.",
    );
  }
  const attemptId = randomUUID();
  let markerPublished = false;
  let primaryError = null;
  try {
    await invokeLedgerFault(
      faultInjector,
      "before-recovery-backup-copy",
      paths.ledgerPath,
    );
    await copyFile(
      paths.ledgerPath,
      paths.backupTempPath,
      LEDGER_RECOVERY_COPY_FLAGS,
    );
    await chmod(paths.backupTempPath, 0o600);
    await syncPath(paths.backupTempPath, true);
    const backupStat = await lstat(paths.backupTempPath);
    const recovery = {
      ...paths,
      attemptId,
      baselineRevision,
      schemaVersion: DURABLE_LEDGER_SCHEMA_VERSION,
      backupSize: backupStat.size,
      markerActive: false,
    };
    await validateLedgerRecoveryBackup(
      { ...recovery, backupPath: paths.backupTempPath },
      { quickCheck: false },
    );
    await rename(paths.backupTempPath, paths.backupPath);
    await syncLedgerDirectory(paths.ledgerPath);

    const marker = {
      protocolVersion: LEDGER_RECOVERY_PROTOCOL_VERSION,
      ledgerIdentity: paths.ledgerIdentity,
      backupFile: basename(paths.backupPath),
      baselineRevision,
      schemaVersion: DURABLE_LEDGER_SCHEMA_VERSION,
      backupSize: backupStat.size,
      attemptId,
      createdAt: isoNow(),
    };
    await writeFile(
      paths.markerTempPath,
      `${JSON.stringify(marker)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await chmod(paths.markerTempPath, 0o600);
    await syncPath(paths.markerTempPath, true);
    await rename(paths.markerTempPath, paths.markerPath);
    markerPublished = true;
    await invokeLedgerFault(
      faultInjector,
      "after-recovery-marker-rename",
      paths.ledgerPath,
    );
    await syncLedgerDirectory(paths.ledgerPath);
    recovery.markerActive = true;
    return recovery;
  } catch (error) {
    primaryError = error;
  }
  primaryError = await runCleanup(primaryError, async () => {
    await rm(paths.backupTempPath, { force: true });
    await rm(paths.markerTempPath, { force: true });
    if (!markerPublished) await rm(paths.backupPath, { force: true });
    await syncLedgerDirectory(paths.ledgerPath);
  });
  throw primaryError;
}

async function invokeLedgerFault(faultInjector, point, ledgerPath) {
  if (faultInjector instanceof Function) {
    await faultInjector({ point, path: ledgerPath });
  }
}

async function restoreLedgerRecovery(
  recovery,
  { faultInjector = null } = {},
) {
  await validateLedgerRecoveryBackup(recovery);
  await invokeLedgerFault(
    faultInjector,
    "before-recovery-restore",
    recovery.ledgerPath,
  );
  await rm(recovery.restoreTempPath, { force: true });
  await copyFile(
    recovery.backupPath,
    recovery.restoreTempPath,
    LEDGER_RECOVERY_COPY_FLAGS,
  );
  await chmod(recovery.restoreTempPath, 0o600);
  await syncPath(recovery.restoreTempPath, true);
  await validateLedgerRecoveryBackup({
    ...recovery,
    backupPath: recovery.restoreTempPath,
  });

  await rm(`${recovery.ledgerPath}-wal`, { force: true });
  await rm(`${recovery.ledgerPath}-shm`, { force: true });
  await syncLedgerDirectory(recovery.ledgerPath);
  await invokeLedgerFault(
    faultInjector,
    "after-recovery-wal-removal",
    recovery.ledgerPath,
  );

  await rename(recovery.restoreTempPath, recovery.ledgerPath);
  await chmod(recovery.ledgerPath, 0o600);
  await syncPath(recovery.ledgerPath, true);
  await syncLedgerDirectory(recovery.ledgerPath);
  await invokeLedgerFault(
    faultInjector,
    "after-recovery-ledger-replace",
    recovery.ledgerPath,
  );

  await validateLedgerRecoveryBackup({
    ...recovery,
    backupPath: recovery.ledgerPath,
  });
  await deactivateLedgerRecovery(recovery);
  await cleanupInactiveLedgerRecovery(recovery);
}

async function recoverLedgerIfNeeded(
  ledgerPath,
  { faultInjector = null } = {},
) {
  const recovery = await readLedgerRecoveryMarker(ledgerPath);
  if (recovery === null) {
    await cleanupInactiveLedgerRecovery(ledgerRecoveryPaths(ledgerPath));
    return false;
  }
  await restoreLedgerRecovery(recovery, { faultInjector });
  return true;
}

async function recoverLedgerWithWriteLock(ledgerPath) {
  let writeLock;
  let primaryError = null;
  try {
    writeLock = await acquireLedgerWriteLock(ledgerPath, false);
    await recoverLedgerIfNeeded(ledgerPath);
  } catch (error) {
    primaryError = error;
  }
  releaseLedgerLock(writeLock);
  primaryError = await runCleanup(primaryError, async () => {
    if (writeLock) await restrictLedgerFiles(writeLock.path);
  });
  if (primaryError !== null) throw primaryError;
}

async function acquireRecoveredLedgerReadLock(ledgerPath) {
  for (;;) {
    const readLock = await acquireLedgerReadLock(ledgerPath);
    try {
      if (!(await recoveryMarkerPresent(ledgerPath))) return readLock;
    } catch (error) {
      releaseLedgerLock(readLock);
      throw error;
    }
    releaseLedgerLock(readLock);
    await recoverLedgerWithWriteLock(ledgerPath);
  }
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

function canonicalCodexHome(codexHome) {
  const selected = resolve(codexHome);
  try {
    return realpathSync.native(selected);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
    return selected;
  }
}

function bindCodexHome(database, codexHome) {
  const selected = codexHomeFingerprint(codexHome);
  const stored = metaValue(database, "codex_home_fingerprint");
  if (stored === null) {
    setMeta(database, "codex_home_fingerprint", selected);
    return;
  }
  if (stored === selected) return;
  const error = new Error(
    "Durable ledger belongs to a different Codex data directory.",
  );
  error.code = "ERR_DURABLE_LEDGER_CODEX_HOME";
  throw error;
}

function sourcePathFingerprint(codexHome, path) {
  const relativePath = resolve(path)
    .replaceAll("\\", "/")
    .replace(`${resolve(codexHome).replaceAll("\\", "/")}/`, "");
  return hash(relativePath, 64);
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
  return {
    sourceId,
    sourceLabel,
    pathFingerprint: sourcePathFingerprint(codexHome, path),
    location: location === "archived" ? "archived" : "active",
    size,
    mtimeMs,
    ctimeMs,
    device,
    inode,
    cursorBytes: size,
    cursorFingerprint: text(
      entry.cursorFingerprint,
      64,
      hash(JSON.stringify([size, mtimeMs, ctimeMs, device, inode]), 64),
    ),
    continuityBytes: nullableNumber(entry.continuityBytes),
    continuityFingerprint: text(entry.continuityFingerprint, 64, "") || null,
    observedAt: now,
  };
}

function sourceIdentityRemap(codexHome, inventory, priorSources) {
  const files = inventory?.files || [];
  const lifecycleFiles = inventory?.lifecycleFiles || files;
  if (!lifecycleFiles.length) return new Map();
  const currentIds = new Set(
    (inventory?.lifecycleFiles || files).map((entry) => String(
      entry.sourceId || sourceIdForPath(codexHome, entry.path),
    )),
  );
  const priorIds = new Set(priorSources.map((row) => String(row.sourceId)));
  const priorByPath = new Map();
  const priorByBase = new Map();
  for (const row of priorSources) {
    const sourceId = String(row.sourceId);
    const pathFingerprint = String(row.pathFingerprint);
    const candidates = priorByPath.get(pathFingerprint) || [];
    candidates.push(sourceId);
    priorByPath.set(pathFingerprint, candidates);
    const baseId = sourceId.split(":file:")[0];
    const logicalCandidates = priorByBase.get(baseId) || [];
    logicalCandidates.push(sourceId);
    priorByBase.set(baseId, logicalCandidates);
  }
  const remap = new Map();
  for (const entry of lifecycleFiles) {
    const currentId = String(
      entry.sourceId || sourceIdForPath(codexHome, entry.path),
    );
    if (priorIds.has(currentId)) continue;
    const baseId = sourceIdForPath(codexHome, entry.path);
    const pathCandidates = priorByPath.get(
      sourcePathFingerprint(codexHome, entry.path),
    ) || [];
    let priorId = pathCandidates.find((candidate) =>
      !currentIds.has(candidate) &&
      (candidate === baseId || candidate.startsWith(`${baseId}:`))
    );
    if (!priorId) {
      const logicalCandidates = (priorByBase.get(baseId) || []).filter(
        (candidate) => !currentIds.has(candidate),
      );
      if (logicalCandidates.length === 1) [priorId] = logicalCandidates;
    }
    if (!priorId) continue;
    remap.set(currentId, priorId);
    currentIds.add(priorId);
  }
  return remap;
}

function reconcileSourceIdentities(database, codexHome, inventory) {
  const priorSources = database.prepare(`
    SELECT source_id AS sourceId, path_fingerprint AS pathFingerprint
      FROM source_state
     ORDER BY CASE WHEN status IN ('active', 'archived') THEN 0 ELSE 1 END,
              last_seen_at DESC, source_id
  `).all();
  return sourceIdentityRemap(codexHome, inventory, priorSources);
}

function remapSourceAssociations(associations, remap) {
  if (!remap.size) return associations;
  return new Map(
    [...(associations || [])].map(([key, sourceIds]) => [
      key,
      new Set(
        [...sourceIds].map((sourceId) =>
          remap.get(String(sourceId)) || String(sourceId)
        ),
      ),
    ]),
  );
}

function remapQuotaSourceBounds(bounds, remap) {
  if (!remap.size) return bounds;
  const remapped = new Map();
  for (const [key, bySource] of bounds || []) {
    const remappedBySource = new Map();
    for (const [sourceId, span] of bySource) {
      const remappedSourceId = remap.get(String(sourceId)) || String(sourceId);
      const current = remappedBySource.get(remappedSourceId);
      remappedBySource.set(remappedSourceId, {
        firstSeenAt: current && current.firstSeenAt < span.firstSeenAt
          ? current.firstSeenAt
          : span.firstSeenAt,
        lastSeenAt: current && current.lastSeenAt > span.lastSeenAt
          ? current.lastSeenAt
          : span.lastSeenAt,
      });
    }
    remapped.set(key, remappedBySource);
  }
  return remapped;
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
    sources.get(sourceId)?.location === "active"
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

function rowToolCallKeys(
  database,
  { includeArchived = true, sources = new Map() } = {},
) {
  const toolSourceIds = includeArchived
    ? null
    : rowSourceIds(database, "tool_sources", "call_key", "source_id");
  const callKeys = new Map();
  for (const row of database.prepare(`
    SELECT observation_id AS observationId, call_key AS callKey
      FROM usage_tool_membership
     ORDER BY observation_id, call_key
  `).all()) {
    const callKey = String(row.callKey);
    if (
      toolSourceIds &&
      !sourceAssociationAllows(
        toolSourceIds.get(callKey) || new Set(),
        sources,
        false,
      )
    ) continue;
    const observationId = String(row.observationId);
    const current = callKeys.get(observationId) || [];
    current.push(callKey);
    callKeys.set(observationId, current);
  }
  return callKeys;
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

function overlappingUsageContribution(row, candidate, interval) {
  if (!sameUsageDimensions(row, candidate)) return null;
  const candidateInterval = usageInterval(candidate);
  if (candidateInterval === null) return null;
  const overlapStart = Math.max(interval.startMs, candidateInterval.startMs);
  const overlapEnd = Math.min(interval.endMs, candidateInterval.endMs);
  if (overlapEnd <= overlapStart) return null;
  const duration = candidateInterval.endMs - candidateInterval.startMs;
  const fraction = Math.min(1, (overlapEnd - overlapStart) / duration);
  if (fraction === 1) return candidate;
  const contribution = { ...candidate };
  for (const field of [...USAGE_FIELDS, ...COUNT_FIELDS]) {
    contribution[field] = nonNegativeNumber(candidate[field]) * fraction;
  }
  return contribution;
}

function subtractMigratedRow(row, observedRows) {
  const interval = usageInterval(row);
  if (interval === null) return row;
  const matches = observedRows
    .map((candidate) => overlappingUsageContribution(row, candidate, interval))
    .filter(Boolean);
  if (!matches.length) return row;
  const residual = { ...row };
  for (const field of USAGE_FIELDS) {
    residual[field] = subtractNonNegative(row, matches, field);
  }
  for (const field of COUNT_FIELDS) {
    residual[field] = subtractNonNegative(row, matches, field);
  }
  // Legacy buckets only carry an aggregate credit estimate. Once exact rows
  // are reintroduced, that estimate may include the matched usage and cannot
  // be subtracted safely without historical rate-card provenance. Clear it so
  // the remaining usage is recomputed once during snapshot materialization.
  residual.rateCardCredits = null;
  if (residual.totalTokens <= 0 && residual.callCount <= 0) return null;
  residual.rangeAllocationEstimated = true;
  residual.rangeAllocationOrigin = row.rangeAllocationOrigin || {
    inputTokens: row.inputTokens,
    totalTokens: row.totalTokens,
    callCount: row.callCount,
  };
  return residual;
}

function latestMigrationScope(database) {
  const row = database.prepare(`
    SELECT generated_at AS generatedAt,
           collection_since AS collectionSince,
           include_archived AS includeArchived,
           scope_known AS scopeKnown
      FROM migration_runs
     ORDER BY migrated_at DESC
     LIMIT 1
  `).get();
  if (!row) return null;
  return {
    generatedAt: row.generatedAt == null ? null : String(row.generatedAt),
    since: row.collectionSince == null ? null : String(row.collectionSince),
    includeArchived: row.includeArchived == null
      ? null
      : Number(row.includeArchived) === 1,
    scopeKnown: Number(row.scopeKnown) === 1,
  };
}

function observedRowWithinMigrationScope(row, scope, sources) {
  if (!scope || scope.includeArchived === null) return null;
  if (
    scope.includeArchived === false &&
    !sourceAssociationAllows(row.sourceIds, sources, false)
  ) return null;
  const interval = usageInterval(row);
  if (interval === null) return null;
  const lowerBound = finiteTimestamp(scope.since) ?? Number.NEGATIVE_INFINITY;
  const upperBound = finiteTimestamp(scope.generatedAt) ??
    Number.POSITIVE_INFINITY;
  const startMs = Math.max(interval.startMs, lowerBound);
  const endMs = Math.min(interval.endMs, upperBound + 1);
  if (endMs <= startMs) return null;
  if (startMs === interval.startMs && endMs === interval.endMs) return row;
  const fraction = (endMs - startMs) / (interval.endMs - interval.startMs);
  const scoped = {
    ...row,
    timestamp: new Date(startMs).toISOString(),
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(Math.max(startMs, endMs - 1)).toISOString(),
  };
  for (const field of [...USAGE_FIELDS, ...COUNT_FIELDS]) {
    scoped[field] = nonNegativeNumber(row[field]) * fraction;
  }
  return scoped;
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
  let snapshot;
  try {
    snapshot = await readPrivateSnapshot(path);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    let reason = "could not be read";
    if (cause instanceof SyntaxError) {
      reason = "is not valid JSON";
    } else if (cause?.code === "ERR_SNAPSHOT_SIZE_LIMIT") {
      reason = "exceeds the snapshot safety limit";
    } else if (cause?.code === "ERR_SNAPSHOT_NOT_REGULAR") {
      reason = "is not a regular file";
    } else if (["EACCES", "EPERM"].includes(cause?.code)) {
      reason = "could not be opened with the current permissions";
    } else if (
      String(cause?.code || "").startsWith("Z_") ||
      cause?.code === "ERR_BUFFER_TOO_LARGE"
    ) {
      reason = "could not be decompressed";
    }
    const error = new Error(
      `Existing legacy snapshot ${reason}; the durable ledger was left untouched. Preserve it in a private backup, then repair or replace the snapshot and retry.`,
      { cause },
    );
    error.code = "ERR_DURABLE_LEDGER_LEGACY_SNAPSHOT";
    throw error;
  }
  if (
    !snapshot ||
    snapshot.schemaVersion !== 3 ||
    !Array.isArray(snapshot.events)
  ) {
    const error = new Error(
      "Existing legacy snapshot uses an unsupported schema; the durable ledger was left untouched. Preserve it in a private backup, then restore a v3 snapshot and retry.",
    );
    error.code = "ERR_DURABLE_LEDGER_LEGACY_SNAPSHOT";
    throw error;
  }
  return snapshot;
}

function snapshotCodexHomeFingerprint(snapshot) {
  const fingerprint = primitiveString(
    snapshot?.metadata?.durableLedger?.codexHomeFingerprint,
  );
  return fingerprint && /^[0-9a-f]{64}$/i.test(fingerprint)
    ? fingerprint.toLowerCase()
    : null;
}

function legacyMigrationGate(snapshot, codexHome) {
  const scope = snapshotCollectionScope(snapshot);
  if (!scope) {
    return { allowed: false, reason: "collection-scope-unverified" };
  }
  const snapshotFingerprint = snapshotCodexHomeFingerprint(snapshot);
  if (!snapshotFingerprint) {
    return { allowed: false, reason: "codex-home-unverified" };
  }
  if (snapshotFingerprint !== codexHomeFingerprint(codexHome)) {
    return { allowed: false, reason: "codex-home-mismatch" };
  }
  return { allowed: true, scope, snapshotFingerprint };
}

function migrateLegacySnapshot(database, snapshot, now, codexHome) {
  const migrationKey = "snapshot-v3-default";
  if (database.prepare(
    "SELECT 1 AS present FROM migration_runs WHERE migration_key = ?",
  ).get(migrationKey)) {
    return { migrated: false, migrationKey };
  }

  const gate = legacyMigrationGate(snapshot, codexHome);
  if (!gate.allowed) {
    setMeta(database, "legacy_snapshot_status", gate.reason);
    return { migrated: false, migrationKey, reason: gate.reason };
  }

  const generatedAt = safeIso(snapshot.generatedAt, now);
  const migrationScope = gate.scope;
  const includeArchived = migrationScope.includeArchived;
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
      "",
      null,
      null,
      row.serviceTier,
      row.originThreadId,
      row.originTimestamp,
      row.originModel,
      row.originEffort,
      null,
      null,
      null,
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
      migrated_at, collection_since, include_archived, scope_known,
      codex_home_fingerprint, usage_rows, quota_rows
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    migrationKey,
    sourceFingerprint,
    sourceLabel,
    snapshot.generatedAt == null ? null : generatedAt,
    now,
    migrationScope.since,
    includeArchived ? 1 : 0,
    1,
    gate.snapshotFingerprint,
    usageRows.length,
    quotaRows.length,
  );
  setMeta(database, "legacy_snapshot_status", "migrated");
  return {
    migrated: true,
    migrationKey,
    since: migrationScope.since,
    includeArchived,
    usageRows: usageRows.length,
    quotaRows: quotaRows.length,
  };
}

function updateSourceStates(
  database,
  codexHome,
  inventory,
  includeArchived,
  uncertainSourceIds,
  now,
) {
  const priorSources = new Map(database.prepare(`
    SELECT source_id AS sourceId, first_seen_at AS firstSeenAt,
           path_fingerprint AS pathFingerprint, cursor_bytes AS cursorBytes,
           cursor_fingerprint AS cursorFingerprint, device, inode,
           change_state AS changeState,
           reconciliation_pending AS reconciliationPending
      FROM source_state
  `).all().map((row) => [String(row.sourceId), row]));
  const current = new Map();
  const ingestedSourceIds = new Set(
    (inventory?.files || []).map((entry) => String(
      entry.sourceId || sourceIdForPath(codexHome, entry.path),
    )),
  );
  const uncertainIds = new Set(
    [...(uncertainSourceIds || [])].map(String),
  );
  for (const entry of inventory?.lifecycleFiles || inventory?.files || []) {
    const sourceId = String(
      entry.sourceId || sourceIdForPath(codexHome, entry.path),
    );
    const prior = priorSources.get(sourceId);
    // Stat-only archive entries exist solely to track already-ingested sources
    // across active/archive moves. Never create observations or source rows for
    // an archive that --no-archived deliberately did not ingest.
    if (!ingestedSourceIds.has(sourceId) && !prior) continue;
    const source = sourceEntry(codexHome, entry, now);
    if (!ingestedSourceIds.has(sourceId) && prior) {
      source.cursorBytes = Number(prior.cursorBytes);
      source.cursorFingerprint = String(prior.cursorFingerprint);
    }
    current.set(source.sourceId, source);
  }
  const insertSource = database.prepare(`
    INSERT INTO source_state (
      source_id, source_label, path_fingerprint, location, status,
      size_bytes, mtime_ms, ctime_ms, device, inode, cursor_bytes,
      cursor_fingerprint, change_state, change_count, first_seen_at,
      last_seen_at, last_transition_at, reconciliation_pending
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      reconciliation_pending = excluded.reconciliation_pending,
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
    const prior = priorSources.get(String(source.sourceId));
    const sourceWasIngested = ingestedSourceIds.has(String(source.sourceId));
    const previousSize = Number(prior?.cursorBytes);
    const cursorChanged = prior &&
      String(prior.cursorFingerprint) !== source.cursorFingerprint;
    const completeFileIdentity = prior &&
      prior.device != null &&
      source.device != null &&
      prior.inode != null &&
      source.inode != null;
    const sameFileIdentity = completeFileIdentity &&
      Number(prior.device) === Number(source.device) &&
      Number(prior.inode) === Number(source.inode);
    const fileIdentityChanged = completeFileIdentity &&
      (
        Number(prior.device) !== Number(source.device) ||
        Number(prior.inode) !== Number(source.inode)
      );
    const relocated = sameFileIdentity &&
      String(prior.pathFingerprint) !== source.pathFingerprint;
    const truncated = prior &&
      !fileIdentityChanged &&
      !relocated &&
      source.size < previousSize;
    const appended = prior &&
      sameFileIdentity &&
      source.size > previousSize &&
      source.continuityBytes === previousSize &&
      source.continuityFingerprint === String(prior.cursorFingerprint);
    const replaced = prior &&
      (
        fileIdentityChanged ||
        (
          sameFileIdentity &&
          cursorChanged &&
          !appended
        )
      );
    const changeState = truncated
      ? "truncated"
      : replaced
        ? "replaced"
        : prior && prior.changeState !== "stable"
          ? text(prior.changeState, 40, "replaced")
          : "stable";
    const changeCount = sourceWasIngested && (truncated || replaced) ? 1 : 0;
    const sourceUncertain = uncertainIds.has(String(source.sourceId));
    const priorReconciliationPending = Number(
      prior?.reconciliationPending,
    ) === 1;
    const blockedReplacement = Boolean(
      sourceWasIngested &&
      sourceUncertain &&
      !truncated &&
      replaced,
    );
    // Every rollout scan reads the complete source. Once a replacement was
    // deferred, the next clean, non-truncated content scan is authoritative
    // even if the immediate filesystem transition looks appended or stable.
    source.reconcileMemberships = Boolean(
      sourceWasIngested &&
      !sourceUncertain &&
      !truncated &&
      (replaced || priorReconciliationPending),
    );
    source.reconciliationPending = source.reconcileMemberships
      ? false
      : priorReconciliationPending || blockedReplacement;
    // The cursor and file identity describe the last content scan. A stat-only
    // lifecycle pass may update location/status, but advancing its identity
    // would hide a replacement from the next scan and retain stale members.
    insertSource.run(
      source.sourceId,
      source.sourceLabel,
      source.pathFingerprint,
      source.location,
      source.location,
      source.size,
      source.mtimeMs,
      source.ctimeMs,
      sourceWasIngested || !prior ? source.device : prior.device,
      sourceWasIngested || !prior ? source.inode : prior.inode,
      source.cursorBytes,
      source.cursorFingerprint,
      changeState,
      changeCount,
      prior?.firstSeenAt || now,
      now,
      now,
      source.reconciliationPending ? 1 : 0,
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

function splitCompactedObservationForEvent(
  database,
  eventKey,
  row,
  metadata,
  existingCompactedObservationId = null,
) {
  const compactedObservationId = existingCompactedObservationId ||
    compactedObservationForEvent(database, eventKey);
  if (!compactedObservationId) return false;
  const compacted = database.prepare(`
    SELECT timestamp, input_tokens AS inputTokens,
           cached_input_tokens AS cachedInputTokens,
           cache_write_input_tokens AS cacheWriteInputTokens,
           output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens,
           total_tokens AS totalTokens, tool_calls AS toolCalls,
           call_count AS callCount, detailed_call_count AS detailedCallCount,
           input_call_count AS inputCallCount,
           rate_card_credits AS rateCardCredits,
           range_allocation_origin AS rangeAllocationOrigin
      FROM usage_observations
     WHERE observation_id = ? AND identity_kind = 'compacted'
  `).get(compactedObservationId);
  if (!compacted) return false;

  const exactObservationId = `exact-${hash(eventKey, 64)}`;
  database.prepare(`
    INSERT OR IGNORE INTO usage_sources (
      observation_id, source_id, first_seen_at, last_seen_at
    )
    SELECT ?, source_id, first_seen_at, last_seen_at
      FROM usage_sources
     WHERE observation_id = ?
  `).run(exactObservationId, compactedObservationId);
  database.prepare(`
    UPDATE source_event_positions
       SET observation_id = ?
     WHERE observation_id = ? AND event_key = ?
  `).run(exactObservationId, compactedObservationId, eventKey);
  database.prepare(
    "DELETE FROM usage_compaction_membership WHERE event_key = ?",
  ).run(eventKey);

  const remainingMembers = Number(database.prepare(`
    SELECT COUNT(*) AS count
      FROM usage_compaction_membership
     WHERE observation_id = ?
  `).get(compactedObservationId)?.count || 0);
  if (remainingMembers === 0) {
    database.prepare(`
      INSERT OR IGNORE INTO usage_tool_membership (
        observation_id, call_key, first_seen_at, last_seen_at
      )
      SELECT ?, call_key, first_seen_at, last_seen_at
        FROM usage_tool_membership
       WHERE observation_id = ?
    `).run(exactObservationId, compactedObservationId);
    database.prepare(
      "DELETE FROM usage_tool_membership WHERE observation_id = ?",
    ).run(compactedObservationId);
    database.prepare(
      "DELETE FROM usage_sources WHERE observation_id = ?",
    ).run(compactedObservationId);
    database.prepare(
      "DELETE FROM usage_observations WHERE observation_id = ?",
    ).run(compactedObservationId);
    return true;
  }

  const rowCallCount = Math.max(0, nonNegativeNumber(row.callCount) || 1);
  const remainingCallCount = Math.max(
    0,
    nonNegativeNumber(compacted.callCount) - rowCallCount,
  );
  const compactedTimestampMs = finiteTimestamp(compacted.timestamp);
  const rowTimestampMs = finiteTimestamp(row.timestamp);
  const remainingTimestamp = compactedTimestampMs !== null &&
      rowTimestampMs !== null && remainingCallCount > 0
    ? new Date(Math.round(
      (
        compactedTimestampMs * nonNegativeNumber(compacted.callCount) -
        rowTimestampMs * rowCallCount
      ) / remainingCallCount,
    )).toISOString()
    : compacted.timestamp;
  const subtract = (field) => Math.max(
    0,
    nonNegativeNumber(compacted[field]) - nonNegativeNumber(row[field]),
  );
  const residual = {
    inputTokens: subtract("inputTokens"),
    cachedInputTokens: subtract("cachedInputTokens"),
    cacheWriteInputTokens: subtract("cacheWriteInputTokens"),
    outputTokens: subtract("outputTokens"),
    reasoningTokens: subtract("reasoningTokens"),
    totalTokens: subtract("totalTokens"),
    toolCalls: subtract("toolCalls"),
    callCount: remainingCallCount,
    detailedCallCount: subtract("detailedCallCount"),
    inputCallCount: subtract("inputCallCount"),
  };
  const rowCredits = nullableNumber(metadata?.rateCardCredits);
  const rateCardCredits = compacted.rateCardCredits == null || rowCredits == null
    ? null
    : Math.max(0, Number(compacted.rateCardCredits) - rowCredits);
  const origin = parseJson(compacted.rangeAllocationOrigin);
  if (origin) {
    origin.inputTokens = residual.inputTokens;
    origin.totalTokens = residual.totalTokens;
    origin.callCount = residual.callCount;
  }
  database.prepare(`
    UPDATE usage_observations
       SET timestamp = ?, input_tokens = ?, cached_input_tokens = ?,
           cache_write_input_tokens = ?, output_tokens = ?,
           reasoning_tokens = ?, total_tokens = ?, tool_calls = ?,
           call_count = ?, detailed_call_count = ?, input_call_count = ?,
           rate_card_credits = ?, range_allocation_origin = ?
     WHERE observation_id = ?
  `).run(
    remainingTimestamp,
    residual.inputTokens,
    residual.cachedInputTokens,
    residual.cacheWriteInputTokens,
    residual.outputTokens,
    residual.reasoningTokens,
    residual.totalTokens,
    residual.toolCalls,
    residual.callCount,
    residual.detailedCallCount,
    residual.inputCallCount,
    rateCardCredits,
    origin ? JSON.stringify(origin) : null,
    compactedObservationId,
  );
  return true;
}

function observationForSourcePosition(database, positions, eventKey) {
  const global = database.prepare(`
    SELECT observation_id AS observationId
      FROM usage_observations
     WHERE event_key = ?
  `).get(eventKey);
  if (global?.observationId) {
    const observationId = String(global.observationId);
    for (const position of positions || []) {
      const sourceId = String(position.sourceId);
      const targetOrdinal = Math.trunc(Number(position.ordinal));
      const current = database.prepare(`
        SELECT event_ordinal AS ordinal
          FROM source_event_positions
         WHERE source_id = ? AND observation_id = ?
         ORDER BY event_ordinal
         LIMIT 1
      `).get(sourceId, observationId);
      if (!current || Number(current.ordinal) === targetOrdinal) continue;
      const displaced = database.prepare(`
        SELECT observation_id AS observationId, event_key AS eventKey,
               first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
          FROM source_event_positions
         WHERE source_id = ? AND event_ordinal = ?
      `).get(sourceId, targetOrdinal);
      database.prepare(`
        DELETE FROM source_event_positions
         WHERE source_id = ? AND event_ordinal IN (?, ?)
      `).run(sourceId, Number(current.ordinal), targetOrdinal);
      if (displaced && String(displaced.observationId) !== observationId) {
        database.prepare(`
          INSERT INTO source_event_positions (
            source_id, event_ordinal, observation_id, event_key,
            first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          sourceId,
          Number(current.ordinal),
          displaced.observationId,
          displaced.eventKey,
          displaced.firstSeenAt,
          displaced.lastSeenAt,
        );
      }
    }
    return observationId;
  }
  for (const position of positions || []) {
    const positioned = database.prepare(`
      SELECT position.observation_id AS observationId,
             position.event_key AS eventKey,
             observation.identity_kind AS identityKind
        FROM source_event_positions AS position
        JOIN usage_observations AS observation
          ON observation.observation_id = position.observation_id
       WHERE position.source_id = ? AND position.event_ordinal = ?
    `).get(String(position.sourceId), Math.trunc(Number(position.ordinal)));
    if (!positioned?.observationId) continue;
    if (String(positioned.eventKey) === eventKey) {
      return String(positioned.observationId);
    }
    const shared = database.prepare(`
      SELECT 1 AS present
        FROM usage_sources
       WHERE observation_id = ? AND source_id <> ?
       LIMIT 1
    `).get(positioned.observationId, String(position.sourceId));
    if (positioned.identityKind === "compacted" || shared?.present) continue;
    return String(positioned.observationId);
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
  currentSourceIds = [],
  allowCompactedReuse = false,
) {
  const eventKey = text(row.eventKey, 4_000, "");
  if (!eventKey) return null;
  const compactedObservationId = compactedObservationForEvent(
    database,
    eventKey,
  );
  if (compactedObservationId && allowCompactedReuse) {
    const hasSource = database.prepare(`
      SELECT 1 AS present
        FROM usage_sources
       WHERE observation_id = ? AND source_id = ?
    `);
    if (
      currentSourceIds.length > 0 &&
      currentSourceIds.every((sourceId) =>
        hasSource.get(compactedObservationId, sourceId)?.present === 1
      )
    ) {
      return compactedObservationId;
    }
  }
  if (compactedObservationId) {
    splitCompactedObservationForEvent(
      database,
      eventKey,
      row,
      metadata,
      compactedObservationId,
    );
    positionedObservationId = null;
  }
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
      origin_thread_id = CASE WHEN excluded.original_likely = 1
        THEN excluded.origin_thread_id ELSE usage_observations.origin_thread_id END,
      origin_timestamp = CASE WHEN excluded.original_likely = 1
        THEN excluded.origin_timestamp ELSE usage_observations.origin_timestamp END,
      origin_model = CASE WHEN excluded.original_likely = 1
        THEN excluded.origin_model ELSE usage_observations.origin_model END,
      origin_effort = CASE WHEN excluded.original_likely = 1
        THEN excluded.origin_effort ELSE usage_observations.origin_effort END,
      origin_cwd = CASE WHEN excluded.original_likely = 1
        THEN excluded.origin_cwd ELSE usage_observations.origin_cwd END,
      origin_git_origin = CASE WHEN excluded.original_likely = 1
        THEN excluded.origin_git_origin ELSE usage_observations.origin_git_origin END,
      origin_raw_source = CASE WHEN excluded.original_likely = 1
        THEN excluded.origin_raw_source ELSE usage_observations.origin_raw_source END,
      origin_service_tier = CASE WHEN excluded.original_likely = 1
        THEN excluded.origin_service_tier ELSE usage_observations.origin_service_tier END,
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
    "",
    null,
    null,
    row.serviceTier == null ? null : text(row.serviceTier, 80),
    originThreadId,
    row.originTimestamp == null ? null : text(row.originTimestamp, 80),
    row.originModel == null ? null : text(row.originModel, 200),
    row.originEffort == null ? null : text(row.originEffort, 80),
    null,
    null,
    null,
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

function toolOwnershipKey(row) {
  const turnId = text(row?.turnId, 400, "");
  const threadId = text(
    row?.originThreadId || row?.threadId,
    400,
    "",
  );
  return turnId || `thread:${threadId}`;
}

function upsertUsageToolMembership(database, observationId, callKey, now) {
  const safeObservationId = text(observationId, 400, "");
  const safeCallKey = text(callKey, 4_000, "");
  if (!safeObservationId || !safeCallKey) return;
  database.prepare(`
    DELETE FROM usage_tool_membership
     WHERE call_key = ? AND observation_id <> ?
  `).run(safeCallKey, safeObservationId);
  database.prepare(`
    INSERT INTO usage_tool_membership (
      observation_id, call_key, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(observation_id, call_key) DO UPDATE SET
      last_seen_at = CASE WHEN excluded.last_seen_at > usage_tool_membership.last_seen_at
        THEN excluded.last_seen_at ELSE usage_tool_membership.last_seen_at END
  `).run(safeObservationId, safeCallKey, now, now);
}

function latestUsageEventByOwnershipKey(rows) {
  const latest = new Map();
  for (const row of rows || []) {
    const eventKey = text(row?.eventKey, 4_000, "");
    if (!eventKey) continue;
    latest.set(toolOwnershipKey(row), {
      eventKey,
      observationId: row.observationId == null
        ? null
        : text(row.observationId, 400, ""),
    });
  }
  return latest;
}

function captureUsageToolOwnership(
  database,
  tokenRows,
  callRows,
  exactObservationIds,
  eventSources,
  now,
) {
  const latest = latestUsageEventByOwnershipKey(tokenRows);
  const scannedSourcesByObservation = new Map();
  for (const row of tokenRows || []) {
    const eventKey = text(row?.eventKey, 4_000, "");
    const observationId = exactObservationIds.get(eventKey);
    if (!observationId) continue;
    const scannedSources = scannedSourcesByObservation.get(observationId) ||
      new Set();
    for (const sourceId of eventSources?.get(eventKey) || []) {
      scannedSources.add(String(sourceId));
    }
    scannedSourcesByObservation.set(observationId, scannedSources);
  }
  const toolSourceIds = rowSourceIds(
    database,
    "tool_sources",
    "call_key",
    "source_id",
  );
  const memberships = database.prepare(`
    SELECT call_key AS callKey
      FROM usage_tool_membership
     WHERE observation_id = ?
  `);
  const deleteMembership = database.prepare(
    `DELETE FROM usage_tool_membership
      WHERE observation_id = ? AND call_key = ?`,
  );
  for (const [observationId, scannedSources] of scannedSourcesByObservation) {
    for (const membership of memberships.all(observationId)) {
      const callKey = String(membership.callKey);
      const membershipSources = toolSourceIds.get(callKey) || new Set();
      if ([...membershipSources].some((sourceId) => scannedSources.has(sourceId))) {
        deleteMembership.run(observationId, callKey);
      }
    }
  }
  for (const row of callRows || []) {
    const callKey = text(row?.callKey, 4_000, "");
    const owner = latest.get(toolOwnershipKey(row));
    const observationId = owner
      ? exactObservationIds.get(owner.eventKey) || owner.observationId
      : null;
    if (callKey && observationId) {
      upsertUsageToolMembership(database, observationId, callKey, now);
    }
  }
}

function backfillUsageToolOwnership(database, now) {
  if (metaValue(database, "usage_tool_membership_backfilled") === "1") return;
  const latest = latestUsageEventByOwnershipKey(database.prepare(`
    SELECT observation_id AS observationId, event_key AS eventKey,
           turn_id AS turnId, thread_id AS threadId,
           origin_thread_id AS originThreadId
      FROM usage_observations
     WHERE identity_kind = 'exact' AND event_key IS NOT NULL
     ORDER BY timestamp, observation_id
  `).all());
  const calls = database.prepare(`
    SELECT call_key AS callKey, turn_id AS turnId, thread_id AS threadId
      FROM tool_observations
  `).all();
  const hasMembership = database.prepare(`
    SELECT 1 AS present
      FROM usage_tool_membership
     WHERE call_key = ?
     LIMIT 1
  `);
  for (const call of calls) {
    const callKey = text(call.callKey, 4_000, "");
    if (!callKey || hasMembership.get(callKey)) continue;
    const owner = latest.get(toolOwnershipKey(call));
    if (owner?.observationId) {
      upsertUsageToolMembership(database, owner.observationId, callKey, now);
    }
  }
  setMeta(database, "usage_tool_membership_backfilled", "1");
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

function reconcileReplacedSourceMemberships({
  database,
  sourceMap,
  table,
  keyColumn,
  seenBySource,
}) {
  const selectMemberships = database.prepare(`
    SELECT ${keyColumn} AS itemId
      FROM ${table}
     WHERE source_id = ?
  `);
  const deleteMembership = database.prepare(`
    DELETE FROM ${table}
     WHERE ${keyColumn} = ? AND source_id = ?
  `);
  for (const source of sourceMap.values()) {
    if (!source.reconcileMemberships) continue;
    const seen = seenBySource.get(String(source.sourceId)) || new Set();
    for (const row of selectMemberships.all(source.sourceId)) {
      if (seen.has(String(row.itemId))) continue;
      deleteMembership.run(row.itemId, source.sourceId);
    }
  }
}

function reconcileReplacedSourcePositions(
  database,
  sourceMap,
  eventPositions,
) {
  const seenBySource = new Map();
  for (const position of eventPositions || []) {
    const sourceId = String(position.sourceId);
    const seen = seenBySource.get(sourceId) || new Set();
    seen.add(Math.trunc(Number(position.ordinal)));
    seenBySource.set(sourceId, seen);
  }
  const selectPositions = database.prepare(`
    SELECT event_ordinal AS eventOrdinal
      FROM source_event_positions
     WHERE source_id = ?
  `);
  const deletePosition = database.prepare(`
    DELETE FROM source_event_positions
     WHERE source_id = ? AND event_ordinal = ?
  `);
  for (const source of sourceMap.values()) {
    if (!source.reconcileMemberships) continue;
    const seen = seenBySource.get(String(source.sourceId)) || new Set();
    for (const row of selectPositions.all(source.sourceId)) {
      const eventOrdinal = Number(row.eventOrdinal);
      if (seen.has(eventOrdinal)) continue;
      deletePosition.run(source.sourceId, eventOrdinal);
    }
  }
}

function pruneOrphanedReplacedObservations(database) {
  const orphanedUsage = database.prepare(`
    SELECT observation_id AS observationId
      FROM usage_observations AS observation
     WHERE observation.identity_kind IN ('exact', 'compacted')
       AND NOT EXISTS (
         SELECT 1 FROM usage_sources AS source
          WHERE source.observation_id = observation.observation_id
       )
  `).all();
  for (const row of orphanedUsage) {
    database.prepare(
      "DELETE FROM usage_tool_membership WHERE observation_id = ?",
    ).run(row.observationId);
    database.prepare(
      "DELETE FROM source_event_positions WHERE observation_id = ?",
    ).run(row.observationId);
    database.prepare(
      "DELETE FROM usage_compaction_membership WHERE observation_id = ?",
    ).run(row.observationId);
    database.prepare(
      "DELETE FROM usage_observations WHERE observation_id = ?",
    ).run(row.observationId);
  }

  const orphanedTools = database.prepare(`
    SELECT call_key AS callKey
      FROM tool_observations AS observation
     WHERE NOT EXISTS (
       SELECT 1 FROM tool_sources AS source
        WHERE source.call_key = observation.call_key
     )
  `).all();
  for (const row of orphanedTools) {
    database.prepare(
      "DELETE FROM usage_tool_membership WHERE call_key = ?",
    ).run(row.callKey);
    database.prepare(
      "DELETE FROM tool_observations WHERE call_key = ?",
    ).run(row.callKey);
  }

  database.prepare(`
    DELETE FROM quota_observations AS observation
     WHERE observation.migrated = 0
       AND NOT EXISTS (
         SELECT 1 FROM quota_sources AS source
          WHERE source.observation_id = observation.observation_id
       )
  `).run();
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
  quotaSourceBounds,
  uncertainSourceIds,
  eventMetadata,
  threadRecords,
  legacySnapshot,
}) {
  const sourceRemap = reconcileSourceIdentities(
    database,
    codexHome,
    inventory,
  );
  if (sourceRemap.size) {
    const remapEntry = (entry) => {
      const sourceId = entry.sourceId || sourceIdForPath(codexHome, entry.path);
      return {
        ...entry,
        sourceId: sourceRemap.get(String(sourceId)) || sourceId,
      };
    };
    const lifecycleFiles = (
      inventory?.lifecycleFiles || inventory?.files || []
    ).map(remapEntry);
    const lifecycleByPath = new Map(
      lifecycleFiles.map((entry) => [resolve(entry.path), entry]),
    );
    inventory = {
      ...inventory,
      files: (inventory?.files || []).map((entry) =>
        lifecycleByPath.get(resolve(entry.path)) || remapEntry(entry)
      ),
      lifecycleFiles,
    };
    eventSources = remapSourceAssociations(eventSources, sourceRemap);
    callSources = remapSourceAssociations(callSources, sourceRemap);
    quotaSources = remapSourceAssociations(quotaSources, sourceRemap);
    quotaSourceBounds = remapQuotaSourceBounds(
      quotaSourceBounds,
      sourceRemap,
    );
    uncertainSourceIds = new Set(
      [...(uncertainSourceIds || [])].map((sourceId) =>
        sourceRemap.get(String(sourceId)) || String(sourceId)
      ),
    );
    eventPositions = (eventPositions || []).map((position) => ({
      ...position,
      sourceId: sourceRemap.get(String(position.sourceId)) || position.sourceId,
    }));
  }
  const sourceMap = updateSourceStates(
    database,
    codexHome,
    inventory,
    includeArchived,
    uncertainSourceIds,
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
    const sourceIds = [...(eventSources?.get(eventKey) || [])].map(String);
    const allowCompactedReuse = sourceIds.length > 0 && sourceIds.every(
      (sourceId) => sourceMap.get(sourceId)?.reconcileMemberships !== true,
    );
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
      sourceIds,
      allowCompactedReuse,
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
  // Position rows are source-owned even when their observation is shared by
  // another source. Reconcile them independently of orphan pruning so a clean
  // replacement cannot leave stale ordinals pointing at a retained shared row.
  reconcileReplacedSourcePositions(database, sourceMap, eventPositions);
  const seenUsageBySource = new Map();
  for (const [eventKey, sourceIds] of eventSources || []) {
    const observationId = exactObservationIds.get(String(eventKey));
    if (!observationId) continue;
    for (const sourceId of sourceIds) {
      const seen = seenUsageBySource.get(String(sourceId)) || new Set();
      seen.add(String(observationId));
      seenUsageBySource.set(String(sourceId), seen);
    }
  }
  reconcileReplacedSourceMemberships({
    database,
    sourceMap,
    table: "usage_sources",
    keyColumn: "observation_id",
    seenBySource: seenUsageBySource,
  });
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
  const seenToolsBySource = new Map();
  for (const [callKey, sourceIds] of callSources || []) {
    const storedCallKey = exactCallKeys.get(String(callKey)) || String(callKey);
    for (const sourceId of sourceIds) {
      const seen = seenToolsBySource.get(String(sourceId)) || new Set();
      seen.add(storedCallKey);
      seenToolsBySource.set(String(sourceId), seen);
    }
  }
  reconcileReplacedSourceMemberships({
    database,
    sourceMap,
    table: "tool_sources",
    keyColumn: "call_key",
    seenBySource: seenToolsBySource,
  });
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
  backfillUsageToolOwnership(database, now);
  captureUsageToolOwnership(
    database,
    tokenRows,
    callRows,
    exactObservationIds,
    eventSources,
    now,
  );

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
  const seenQuotasBySource = new Map();
  const mergeQuotaSource = database.prepare(`
    INSERT INTO quota_sources (
      observation_id, source_id, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(observation_id, source_id) DO UPDATE SET
      first_seen_at = CASE WHEN excluded.first_seen_at < quota_sources.first_seen_at
        THEN excluded.first_seen_at ELSE quota_sources.first_seen_at END,
      last_seen_at = CASE WHEN excluded.last_seen_at > quota_sources.last_seen_at
        THEN excluded.last_seen_at ELSE quota_sources.last_seen_at END
  `);
  const replaceQuotaSource = database.prepare(`
    INSERT INTO quota_sources (
      observation_id, source_id, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(observation_id, source_id) DO UPDATE SET
      first_seen_at = excluded.first_seen_at,
      last_seen_at = excluded.last_seen_at
  `);
  for (const [key, sourceIds] of quotaSources || []) {
    const observationId = quotaObservationIds.get(String(key)) ||
      `quota-${hash(key, 64)}`;
    for (const sourceId of sourceIds) {
      const seen = seenQuotasBySource.get(String(sourceId)) || new Set();
      seen.add(observationId);
      seenQuotasBySource.set(String(sourceId), seen);
    }
  }
  reconcileReplacedSourceMemberships({
    database,
    sourceMap,
    table: "quota_sources",
    keyColumn: "observation_id",
    seenBySource: seenQuotasBySource,
  });
  for (const [key, sourceIds] of quotaSources || []) {
    const observationId = quotaObservationIds.get(String(key)) ||
      `quota-${hash(key, 64)}`;
    for (const sourceId of sourceIds) {
      const bounds = quotaSourceBounds?.get(String(key))?.get(String(sourceId));
      const firstSeenAt = safeIso(bounds?.firstSeenAt, now);
      const lastSeenAt = safeIso(bounds?.lastSeenAt, firstSeenAt);
      const writeSource = sourceMap.get(String(sourceId))?.reconcileMemberships
        ? replaceQuotaSource
        : mergeQuotaSource;
      writeSource.run(observationId, sourceId, firstSeenAt, lastSeenAt);
    }
  }
  pruneOrphanedReplacedObservations(database);

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
    migration = migrateLegacySnapshot(
      database,
      legacySnapshot,
      now,
      codexHome,
    );
  }
  for (const row of threadRecords || []) upsertThreadRecord(database, row, now);
  return migration;
}

function compactedBucketKey(bucket) {
  const timestampMs = finiteTimestamp(bucket.timestamp) ?? 0;
  return JSON.stringify([
    Math.floor(timestampMs / DAY_MS),
    bucket.compactionSourceScope ?? null,
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
  if (row.compactionSourceScope !== bucket.compactionSourceScope) {
    return false;
  }
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

function compactionMembershipKey(row) {
  return JSON.stringify([
    row.compactionSourceScope ?? null,
    row.project ?? null,
    row.displayModel ?? row.model ?? null,
    row.rateCardModel ?? row.model ?? null,
    row.effort ?? null,
    row.source ?? null,
    row.useType ?? null,
    row.serviceTier ?? null,
    row.breakdownAvailable === true,
    row.rateCardCredits == null,
  ]);
}

function indexedCompactionMembers(rows) {
  const indexed = new Map();
  for (const row of rows) {
    const timestampMs = finiteTimestamp(row.timestamp);
    if (timestampMs === null) continue;
    const key = compactionMembershipKey(row);
    const members = indexed.get(key) || [];
    members.push({ row, timestampMs });
    indexed.set(key, members);
  }
  for (const members of indexed.values()) {
    members.sort((left, right) => left.timestampMs - right.timestampMs);
  }
  return indexed;
}

function lowerBoundTimestamp(members, targetMs) {
  let low = 0;
  let high = members.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (members[middle].timestampMs < targetMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function indexedMembersForBucket(indexed, bucket) {
  const members = indexed.get(compactionMembershipKey({
    ...bucket,
    displayModel: bucket.model,
  })) || [];
  const interval = usageInterval(bucket);
  if (!members.length || interval === null) return [];
  const start = lowerBoundTimestamp(members, interval.startMs);
  const end = lowerBoundTimestamp(members, interval.endMs);
  return members
    .slice(start, end)
    .map((member) => member.row)
    .filter((row) => bucketMatchesUsage(bucket, row));
}

function compactionSourceScope(sourceIds) {
  return hash(JSON.stringify(
    [...(sourceIds || [])].map(String).sort(),
  ), 64);
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
  const toolCallKeysByObservation = rowToolCallKeys(database);
  const normalizedRows = rows.map((row) => {
    const toolCallKeys = toolCallKeysByObservation.get(String(row.observationId)) || [];
    const sourceIds = sourceIdsByObservation.get(String(row.observationId)) || new Set();
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
          toolCalls: Math.max(
            nonNegativeNumber(normalized.toolCalls),
            toolCallKeys.length,
          ),
          toolCallKeys,
          sourceIds,
          compactionSourceScope: compactionSourceScope(sourceIds),
        }
      : null;
  }).filter(Boolean);
  if (!normalizedRows.length) return 0;
  const rowsBySourceScope = new Map();
  for (const row of normalizedRows) {
    const scopedRows = rowsBySourceScope.get(row.compactionSourceScope) || [];
    scopedRows.push(row);
    rowsBySourceScope.set(row.compactionSourceScope, scopedRows);
  }
  const buckets = [...rowsBySourceScope.entries()].flatMap(
    ([compactionSourceScopeValue, scopedRows]) =>
      buildUsageBuckets(scopedRows, { latestTimestampMs: nowMs })
        .map((bucket) => ({
          ...bucket,
          compactionSourceScope: compactionSourceScopeValue,
        })),
  );
  const membersByBucket = indexedCompactionMembers(normalizedRows);
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
  const insertCompactionMembership = database.prepare(`
    INSERT INTO usage_compaction_membership (
      event_key, observation_id, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(event_key) DO UPDATE SET
      observation_id = excluded.observation_id,
      last_seen_at = CASE WHEN excluded.last_seen_at > usage_compaction_membership.last_seen_at
        THEN excluded.last_seen_at ELSE usage_compaction_membership.last_seen_at END
  `);
  const insertToolMembership = database.prepare(`
    INSERT INTO usage_tool_membership (
      observation_id, call_key, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(observation_id, call_key) DO UPDATE SET
      last_seen_at = CASE WHEN excluded.last_seen_at > usage_tool_membership.last_seen_at
        THEN excluded.last_seen_at ELSE usage_tool_membership.last_seen_at END
  `);
  const compactedIds = new Set();
  const compactedIdByMember = new Map();
  for (const bucket of buckets) {
    const members = indexedMembersForBucket(membersByBucket, bucket);
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
        insertCompactionMembership.run(
          member.eventKey,
          id,
          isoNow(nowMs),
          isoNow(nowMs),
        );
      }
      for (const callKey of member.toolCallKeys || []) {
        insertToolMembership.run(
          id,
          callKey,
          aggregate.firstSeenAt,
          aggregate.lastSeenAt,
        );
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
  const deleteToolMembership = database.prepare(
    "DELETE FROM usage_tool_membership WHERE observation_id = ?",
  );
  for (const id of compactedIds) {
    updatePositions.run(compactedIdByMember.get(id), id);
    deleteSources.run(id);
    deleteToolMembership.run(id);
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
  const deleteToolMembership = database.prepare(
    "DELETE FROM usage_tool_membership WHERE observation_id = ?",
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
    deleteToolMembership.run(row.observationId);
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
  const migrationScope = latestMigrationScope(database);
  const activeOnlyMigration = migrationScope?.includeArchived === false;
  const includeMigrated = includeArchived || activeOnlyMigration;
  const sourceIds = rowSourceIds(
    database,
    "usage_sources",
    "observation_id",
    "source_id",
  );
  const allToolCallKeys = rowToolCallKeys(database);
  const toolCallKeys = includeArchived
    ? allToolCallKeys
    : rowToolCallKeys(database, { includeArchived, sources });
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
    if (row.identityKind === "migrated_compacted" && !includeMigrated) continue;
    const ownedToolCallKeys = toolCallKeys.get(String(row.observationId)) || [];
    const hasExactToolMembership = (
      allToolCallKeys.get(String(row.observationId)) || []
    ).length > 0;
    const usageRow = usageRowFromDatabase({
      ...row,
      toolCalls:
        row.identityKind === "compacted" && hasExactToolMembership
          ? ownedToolCallKeys.length
          : Math.max(
              nonNegativeNumber(row.toolCalls),
              ownedToolCallKeys.length,
            ),
    }, associated);
    usageRow.toolCallKeys = ownedToolCallKeys;
    if (row.identityKind === "compacted") {
      usageRow.compactedEventKeys = compactedEventKeys.get(
        String(row.observationId),
      ) || [];
    }
    rows.push(usageRow);
  }
  const observedRows = rows
    .filter((row) =>
      row.identityKind === "exact" || row.identityKind === "compacted"
    )
    .map((row) => observedRowWithinMigrationScope(row, migrationScope, sources))
    .filter(Boolean);
  return rows
    .filter((row) => row.identityKind !== "migrated_compacted")
    .concat(
      includeMigrated
        ? rows
          .filter((row) => row.identityKind === "migrated_compacted")
          .map((row) => subtractMigratedRow(row, observedRows))
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
  const activeOnlyMigration = latestMigrationScope(database)
    ?.includeArchived === false;
  const sourceBounds = new Map();
  for (const row of database.prepare(`
    SELECT observation_id AS observationId, source_id AS sourceId,
           first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
      FROM quota_sources
  `).all()) {
    const bounds = sourceBounds.get(String(row.observationId)) || [];
    bounds.push({
      sourceId: String(row.sourceId),
      firstSeenAt: String(row.firstSeenAt),
      lastSeenAt: String(row.lastSeenAt),
    });
    sourceBounds.set(String(row.observationId), bounds);
  }
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
    .map((row) => {
      let firstSeenAt = String(row.firstSeenAt);
      let lastSeenAt = String(row.lastSeenAt);
      if (Number(row.migrated) !== 1) {
        const scopedBounds = (
          sourceBounds.get(String(row.observationId)) || []
        ).filter((bound) =>
          includeArchived || sources.get(bound.sourceId)?.location === "active"
        );
        if (!scopedBounds.length) return null;
        firstSeenAt = scopedBounds.reduce(
          (earliest, bound) => bound.firstSeenAt < earliest
            ? bound.firstSeenAt
            : earliest,
          scopedBounds[0].firstSeenAt,
        );
        lastSeenAt = scopedBounds.reduce(
          (latest, bound) => bound.lastSeenAt > latest
            ? bound.lastSeenAt
            : latest,
          scopedBounds[0].lastSeenAt,
        );
      } else if (!includeArchived && !activeOnlyMigration) {
        return null;
      }
      return {
        id: `quota-${hash(row.observationKey, 24)}`,
        timestamp: text(firstSeenAt, 80),
        lastSeenAt: text(lastSeenAt, 80),
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
      };
    })
    .filter(Boolean);
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
  const reconciliationPending = tableColumns(
    database,
    "source_state",
  ).has("reconciliation_pending")
    ? "reconciliation_pending"
    : "0";
  const states = database.prepare(`
    SELECT source_id AS sourceId, location, status,
           observed_event_count AS observedEventCount,
           change_state AS changeState, change_count AS changeCount,
           ${reconciliationPending} AS reconciliationPending
      FROM source_state
  `).all().map((row) => ({
    sourceId: String(row.sourceId),
    location: text(row.location, 20, "active"),
    status: text(row.status, 20, "missing"),
    observedEventCount: nonNegativeNumber(row.observedEventCount),
    changeState: text(row.changeState, 40, "stable"),
    changeCount: nonNegativeNumber(row.changeCount),
    reconciliationPending: Number(row.reconciliationPending) === 1,
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

function materializeDurableLedger(database, ledgerPath, includeArchived) {
  const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
  if (version !== DURABLE_LEDGER_SCHEMA_VERSION) {
    const error = new Error("Unsupported Token Ledger durable ledger schema.");
    error.code = "ERR_DURABLE_LEDGER_SCHEMA";
    throw error;
  }
  const summary = sourceSummary(database);
  const sources = new Map(
    summary.states.map((state) => [state.sourceId, state]),
  );
  const usageRows = databaseUsageRows(database, includeArchived, sources);
  const quotaRows = databaseQuotaRows(database, includeArchived, sources);
  const toolRows = databaseToolRows(database, includeArchived, sources);
  const threadRows = databaseThreadRows(database);
  const migrationRow = database.prepare(`
    SELECT migration_key AS migrationKey,
           source_fingerprint AS sourceFingerprint,
           generated_at AS generatedAt, migrated_at AS migratedAt,
           collection_since AS collectionSince,
           include_archived AS includeArchived,
           scope_known AS scopeKnown,
           codex_home_fingerprint AS codexHomeFingerprint,
           usage_rows AS usageRows, quota_rows AS quotaRows
      FROM migration_runs
     ORDER BY migrated_at DESC
     LIMIT 1
  `).get() || null;
  const migration = migrationRow
    ? {
        ...migrationRow,
        includeArchived: migrationRow.includeArchived == null
          ? null
          : Number(migrationRow.includeArchived) === 1,
        scopeKnown: Number(migrationRow.scopeKnown) === 1,
      }
    : null;
  const migratedUsageRows = usageRows.filter(
    (row) => row.identityKind === "migrated_compacted",
  );
  const compactedUsageRows = usageRows.filter(
    (row) => row.identityKind === "compacted",
  );
  return {
    path: ledgerPath,
    revision: Number(metaValue(database, "revision") || 0),
    legacySnapshotStatus: metaValue(database, "legacy_snapshot_status"),
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
}

export async function readDurableLedger(
  path,
  { includeArchived = true, writerLockHeld = false } = {},
) {
  const ledgerPath = resolve(path);
  let readLock;
  let database;
  try {
    if (writerLockHeld) await recoverLedgerIfNeeded(ledgerPath);
    else readLock = await acquireRecoveredLedgerReadLock(ledgerPath);
    database = await openLedger(ledgerPath, true);
    return materializeDurableLedger(database, ledgerPath, includeArchived);
  } finally {
    closeDatabase(database);
    releaseLedgerLock(readLock);
  }
}

export async function readDurableSourceContinuity(
  path,
  { codexHome = null, inventory = null } = {},
) {
  const ledgerPath = resolve(path);
  try {
    const sourceStat = await stat(ledgerPath);
    if (!sourceStat.isFile()) return new Map();
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  let readLock;
  let database;
  try {
    readLock = await acquireRecoveredLedgerReadLock(ledgerPath);
    database = await openLedger(ledgerPath, true);
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== DURABLE_LEDGER_SCHEMA_VERSION) return new Map();
    const rows = database.prepare(`
      SELECT source_id AS sourceId, cursor_bytes AS cursorBytes,
             cursor_fingerprint AS cursorFingerprint,
             path_fingerprint AS pathFingerprint
        FROM source_state
       ORDER BY CASE WHEN status IN ('active', 'archived') THEN 0 ELSE 1 END,
                last_seen_at DESC, source_id
    `).all();
    const continuity = new Map(rows.map((row) => [
      String(row.sourceId), {
        cursorBytes: Number(row.cursorBytes),
        cursorFingerprint: String(row.cursorFingerprint),
      },
    ]));
    // An atomic replacement changes the inode-qualified inventory ID before
    // the write transaction remaps it to the stable durable source row. Apply
    // that same unambiguous remap while choosing scan continuity so a true
    // append after the replacement is not repeatedly classified as another
    // replacement. The matcher refuses a remap when the prior identity is also
    // present (for example, simultaneous active and archived copies).
    if (codexHome && inventory) {
      for (const [currentId, priorId] of sourceIdentityRemap(
        codexHome,
        inventory,
        rows,
      )) {
        const prior = continuity.get(priorId);
        if (prior) continuity.set(currentId, prior);
      }
    }
    return continuity;
  } catch (error) {
    const sqliteErrcode = Number(error?.errcode);
    const sqliteErrstr = text(error?.errstr, 80).toUpperCase();
    if (
      [
        "ERR_DURABLE_LEDGER_SCHEMA",
        "ERR_DURABLE_LEDGER_RECOVERY",
        "SQLITE_NOTADB",
        "SQLITE_CORRUPT",
        "SQLITE_BUSY",
      ].includes(error?.code) ||
      (
        error?.code === "ERR_SQLITE_ERROR" &&
        (
          [5, 6, 11, 26].includes(sqliteErrcode) ||
          [
            "SQLITE_BUSY",
            "SQLITE_LOCKED",
            "SQLITE_CORRUPT",
            "SQLITE_NOTADB",
          ].includes(sqliteErrstr)
        )
      )
    ) return new Map();
    throw error;
  } finally {
    closeDatabase(database);
    releaseLedgerLock(readLock);
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
  let readLock;
  let database;
  try {
    readLock = await acquireRecoveredLedgerReadLock(ledgerPath);
    database = await openLedger(ledgerPath, true);
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== DURABLE_LEDGER_SCHEMA_VERSION) return null;
    const revision = Number(metaValue(database, "revision"));
    return Number.isSafeInteger(revision) ? revision : null;
  } catch (error) {
    const sqliteErrcode = Number(error?.errcode);
    const sqliteErrstr = text(error?.errstr, 80).toUpperCase();
    if (
      [
        "ERR_DURABLE_LEDGER_SCHEMA",
        "ERR_DURABLE_LEDGER_RECOVERY",
        "SQLITE_NOTADB",
        "SQLITE_CORRUPT",
        "SQLITE_BUSY",
      ].includes(error?.code)
      || (
        error?.code === "ERR_SQLITE_ERROR" &&
        (
          [5, 6, 11, 26].includes(sqliteErrcode) ||
          [
            "SQLITE_BUSY",
            "SQLITE_LOCKED",
            "SQLITE_CORRUPT",
            "SQLITE_NOTADB",
          ].includes(sqliteErrstr)
        )
      )
    ) return null;
    throw error;
  } finally {
    closeDatabase(database);
    releaseLedgerLock(readLock);
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
  quotaSourceBounds = new Map(),
  uncertainSourceIds = new Set(),
  eventMetadata = new Map(),
  threadRecords = [],
  nowMs = Date.now(),
  legacySnapshotPath = options.legacySnapshotPath || options.output,
  faultInjector = null,
  validateBeforeCommit = null,
  validateAfterCommit = null,
  stageBeforeCommit = null,
} = {}) {
  const ledgerPath = resolveDurableLedgerPath({
    ...options,
    output: options.output,
  });
  const privateDirectory = Boolean(
    options.stateDirectory || options.privateStateDirectory,
  );
  const enforcePrivateDirectory = options.privateStateDirectory === true;
  const now = isoNow(nowMs);

  let writeLock;
  let database;
  let committed = false;
  let commitAttempted = false;
  let recovery = null;
  let stagedCommit = null;
  let result = null;
  let primaryError = null;
  try {
    writeLock = await acquireLedgerWriteLock(
      ledgerPath,
      privateDirectory,
      enforcePrivateDirectory,
    );
    await recoverLedgerIfNeeded(ledgerPath, { faultInjector });
    const legacySnapshot = await (async () => {
      let legacyDatabase;
      try {
        legacyDatabase = await openLedger(ledgerPath, false, {
          privateDirectory,
          enforcePrivateDirectory,
        });
        return await readLegacyIfNeeded(legacyDatabase, legacySnapshotPath);
      } finally {
        closeDatabase(legacyDatabase);
      }
    })();
    database = await openLedger(ledgerPath, false, {
      privateDirectory,
      enforcePrivateDirectory,
    });
    if (validateAfterCommit instanceof Function) {
      recovery = await prepareLedgerRecovery(
        database,
        ledgerPath,
        { faultInjector },
      );
      await invokeLedgerFault(
        faultInjector,
        "after-recovery-marker",
        ledgerPath,
      );
    }
    database.exec("BEGIN IMMEDIATE");
    bindCodexHome(database, codexHome);
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
      quotaSourceBounds,
      uncertainSourceIds,
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
    await invokeLedgerFault(faultInjector, "before-commit", ledgerPath);
    if (validateBeforeCommit instanceof Function) {
      await validateBeforeCommit({ path: ledgerPath });
    }
    await invokeLedgerFault(faultInjector, "after-validation", ledgerPath);
    const committedLedger = materializeDurableLedger(
      database,
      ledgerPath,
      includeArchived,
    );
    if (stageBeforeCommit instanceof Function) {
      stagedCommit = await stageBeforeCommit({
        path: ledgerPath,
        ledger: committedLedger,
      });
      if (
        stagedCommit &&
        !(
          stagedCommit.publish instanceof Function &&
          stagedCommit.discard instanceof Function
        )
      ) {
        throw new Error(
          "A staged durable-ledger commit requires publish and discard functions.",
        );
      }
    }
    if (validateBeforeCommit instanceof Function) {
      await validateBeforeCommit({ path: ledgerPath });
    }
    await invokeLedgerFault(
      faultInjector,
      "after-final-validation",
      ledgerPath,
    );
    commitAttempted = true;
    database.exec("COMMIT");
    committed = true;
    await invokeLedgerFault(
      faultInjector,
      "after-sqlite-commit",
      ledgerPath,
    );
    if (validateAfterCommit instanceof Function) {
      await validateAfterCommit({ path: ledgerPath });
    }
    if (recovery !== null) {
      await deactivateLedgerRecovery(recovery);
      await cleanupInactiveLedgerRecovery(recovery);
      recovery = null;
    }
    if (stagedCommit) await stagedCommit.publish();
    await invokeLedgerFault(faultInjector, "after-commit", ledgerPath);
    await restrictLedgerFiles(ledgerPath);
    result = {
      ...committedLedger,
      committed,
      migration,
    };
  } catch (error) {
    primaryError = error;
    if ((committed || commitAttempted) && recovery?.markerActive) {
      closeDatabase(database);
      database = null;
      try {
        await restoreLedgerRecovery(recovery, { faultInjector });
        recovery = null;
        committed = false;
      } catch (restoreError) {
        if (restoreError instanceof Error) {
          if (restoreError.cause == null) restoreError.cause = primaryError;
          else restoreError.commitError = primaryError;
        }
        primaryError = restoreError;
      }
    } else if (!committed) {
      try {
        database?.exec("ROLLBACK");
      } catch {
        // SQLite's recovery journal remains authoritative after an interrupted
        // or failed transaction.
      }
      if (recovery?.markerActive) {
        primaryError = await runCleanup(primaryError, async () => {
          await deactivateLedgerRecovery(recovery);
          await cleanupInactiveLedgerRecovery(recovery);
          recovery = null;
        });
      }
    }
  }

  closeDatabase(database);
  if (recovery !== null && !recovery.markerActive) {
    primaryError = await runCleanup(primaryError, async () => {
      await cleanupInactiveLedgerRecovery(recovery);
      recovery = null;
    });
  }
  primaryError = await runCleanup(primaryError, async () => {
    await restrictLedgerFiles(ledgerPath);
  });
  primaryError = await runCleanup(primaryError, async () => {
    if (stagedCommit) await stagedCommit.discard();
  });
  releaseLedgerLock(writeLock);
  primaryError = await runCleanup(primaryError, async () => {
    if (writeLock) await restrictLedgerFiles(writeLock.path);
  });

  if (primaryError !== null) throw primaryError;
  return result;
}
