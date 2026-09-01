import { createHash } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  stat,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { readPrivateSnapshot } from "./token-ledger-snapshot.mjs";
import { snapshotCollectionScope } from "./token-ledger-collection.mjs";
import {
  QUOTA_IDENTITY_CONTRACT_VERSION,
  quotaIdentityMatchesContract,
  snapshotQuotaIdentityContract,
} from "./token-ledger-quota-contract.mjs";
import {
  buildUsageBuckets,
  normalizeTokenUsage,
  usageCallCount,
  usageDetailedCallCount,
  usageInputCallCount,
} from "./token-ledger-usage.mjs";

export const DURABLE_LEDGER_SCHEMA_VERSION = 3;
export const DURABLE_LEDGER_FILENAME = "token-ledger-ledger.sqlite";
export const DURABLE_LEDGER_RETENTION_DAYS = 3_650;
export const DURABLE_LEDGER_RETENTION_MS =
  DURABLE_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const DURABLE_LEDGER_COMPACTED_RETENTION_DAYS = 7_300;
export const DURABLE_LEDGER_COMPACTED_RETENTION_MS =
  DURABLE_LEDGER_COMPACTED_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

const DEFAULT_PRIVATE_STATE_DIRECTORY = resolve(
  userInfo().homedir,
  ".token-ledger",
);
const TEST_STATE_NAMESPACE = /^\d+$/.test(
  process.env.TOKEN_LEDGER_TEST_STATE_NAMESPACE || "",
)
  ? process.env.TOKEN_LEDGER_TEST_STATE_NAMESPACE
  : String(process.pid);
const TEST_PRIVATE_STATE_ROOT = resolve(
  DEFAULT_PRIVATE_STATE_DIRECTORY,
  "test-state",
  TEST_STATE_NAMESPACE,
);
const QUOTA_IDENTITY_CONTRACT_KEY = "quota_identity_contract";
const PREVIOUS_QUOTA_IDENTITY_CONTRACT_VERSION = "codex-limit-id-v1";
const POST_COMMIT_VALIDATION_PENDING_KEY = "post_commit_validation_pending";
// Every table the capture window may mutate. The commit undo log records
// those mutations so a revision rejected by post-commit source validation
// can be reverted exactly instead of being approximated from timestamps.
const COMMIT_UNDO_TABLES = Object.freeze([
  "ledger_meta",
  "source_state",
  "usage_observations",
  "usage_sources",
  "source_event_positions",
  "usage_compaction_membership",
  "usage_tool_membership",
  "tool_observations",
  "tool_sources",
  "quota_observations",
  "quota_sources",
  "quota_label_evidence",
  "thread_records",
  "migration_runs",
]);
// Re-observing existing rows bumps only last_seen_at in the high-volume
// usage and tool tables; skipping that column keeps the undo log
// proportional to real changes instead of scan volume. Quota bounds are
// reported observation data rather than scan metadata, so the quota tables
// capture every column.
const COMMIT_UNDO_VOLATILE_COLUMNS = new Set(["last_seen_at"]);
const COMMIT_UNDO_FULLY_CAPTURED_TABLES = new Set([
  "quota_observations",
  "quota_sources",
]);
const DAY_MS = 24 * 60 * 60 * 1_000;
const LEDGER_BUSY_TIMEOUT_MS = 1_000;
const DURABLE_LEDGER_SCHEMA_VERSION_V2 = 2;
const LEDGER_VACUUM_MIN_FREELIST_PAGES = 512;
const LEDGER_VACUUM_MIN_FREE_RATIO = 0.05;
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

function stringArrayFromJson(value) {
  const parsed = parseJson(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => primitiveString(item))
    .filter((item) => item !== null && item.length > 0);
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

function testPrivateStateDirectory({ codexHome, output }) {
  if (!process.env.NODE_TEST_CONTEXT || !codexHome) return null;
  const home = resolve(codexHome);
  let scope = output ? dirname(resolve(output)) : home;
  while (
    scope !== dirname(scope) &&
    (relative(scope, home).startsWith("..") ||
      resolve(scope, relative(scope, home)) !== home)
  ) {
    scope = dirname(scope);
  }
  return resolve(
    TEST_PRIVATE_STATE_ROOT,
    hash(scope === dirname(scope) ? home : scope, 32),
  );
}

export function resolveDurableLedgerPath(options = {}) {
  if (options.ledgerPath) {
    throw ledgerPathError(
      "Custom durable ledger paths are not supported; Token Ledger stores SQLite state in its private application directory.",
    );
  }
  if (options.stateDirectory) {
    throw ledgerPathError(
      "Custom durable ledger directories are not supported; Token Ledger stores SQLite state in its private application directory.",
    );
  }
  const testDirectory = testPrivateStateDirectory(options);
  if (testDirectory) return resolve(testDirectory, DURABLE_LEDGER_FILENAME);
  return resolve(DEFAULT_PRIVATE_STATE_DIRECTORY, DURABLE_LEDGER_FILENAME);
}

function validateAppOwnedLedgerPath(path) {
  const selected = resolve(path);
  const defaultPath = resolve(
    DEFAULT_PRIVATE_STATE_DIRECTORY,
    DURABLE_LEDGER_FILENAME,
  );
  if (selected === defaultPath) return selected;
  if (
    process.env.NODE_TEST_CONTEXT &&
    !relative(TEST_PRIVATE_STATE_ROOT, dirname(selected)).startsWith("..") &&
    basename(selected) === DURABLE_LEDGER_FILENAME
  ) {
    return selected;
  }
  throw ledgerPathError(
    "Durable SQLite access is restricted to Token Ledger's private application directory.",
  );
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
      quota_reconciliation_pending INTEGER NOT NULL DEFAULT 0,
      first_seen_location TEXT,
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
      -- This is the 64-character SHA-256 digest of the event key. The full
      -- JSON event key is retained once in usage_observations or
      -- usage_compaction_membership, rather than once per source position.
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

    CREATE TABLE IF NOT EXISTS quota_label_evidence (
      limit_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      limit_name TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(limit_key, source_id)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS quota_label_evidence_source
      ON quota_label_evidence(source_id);

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

    CREATE TABLE IF NOT EXISTS commit_undo_log (
      sequence INTEGER PRIMARY KEY,
      table_name TEXT NOT NULL,
      operation TEXT NOT NULL,
      row_data TEXT NOT NULL
    );

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

function ledgerPathError(message) {
  const error = new Error(message);
  error.code = "ERR_DURABLE_LEDGER_PATH";
  return error;
}

function validateSingleLinkRegularFileStat(fileStat, description) {
  if (fileStat.isSymbolicLink()) {
    throw ledgerPathError(
      `The ${description} path must not be a symbolic link.`,
    );
  }
  if (!fileStat.isFile()) {
    throw ledgerPathError(
      `The ${description} path must be a regular file.`,
    );
  }
  if (Number(fileStat.nlink) !== 1) {
    throw ledgerPathError(
      `The ${description} path must have exactly one filesystem link.`,
    );
  }
  return fileStat;
}

async function validateSingleLinkRegularFile(
  path,
  { allowMissing = false, description = "durable ledger" } = {},
) {
  let fileStat;
  try {
    fileStat = await lstat(path);
  } catch (error) {
    if (allowMissing && ["ENOENT", "ENOTDIR"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
  return validateSingleLinkRegularFileStat(fileStat, description);
}

async function validateLedgerMainPath(path, options = {}) {
  return validateSingleLinkRegularFile(path, {
    ...options,
    description: "durable ledger",
  });
}

function sqliteTransientPaths(path) {
  return [
    [`${path}-journal`, "rollback journal"],
    [`${path}-wal`, "WAL sidecar"],
    [`${path}-shm`, "shared-memory sidecar"],
  ];
}

async function validateSqliteTransientPaths(path, description) {
  for (const [transientPath, transientDescription] of sqliteTransientPaths(path)) {
    await validateSingleLinkRegularFile(transientPath, {
      allowMissing: true,
      description: `${description} ${transientDescription}`,
    });
  }
}

function sameFileIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      Number(left.dev) === Number(right.dev) &&
      Number(left.ino) === Number(right.ino),
  );
}

async function openValidatedSqliteDatabase(
  path,
  {
    allowMissing = false,
    description,
    readOnly = false,
  },
) {
  const beforeOpen = await validateSingleLinkRegularFile(path, {
    allowMissing,
    description,
  });
  await validateSqliteTransientPaths(path, description);
  const database = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
  try {
    const afterOpen = await validateSingleLinkRegularFile(path, {
      description,
    });
    if (beforeOpen !== null && !sameFileIdentity(beforeOpen, afterOpen)) {
      throw ledgerPathError(
        `The ${description} path changed while it was being opened.`,
      );
    }
    await validateSqliteTransientPaths(path, description);
  } catch (error) {
    closeDatabase(database);
    throw error;
  }
  return database;
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
  const database = await openValidatedSqliteDatabase(path, {
    allowMissing: !readOnly,
    description: "durable ledger",
    readOnly,
  });
  database.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
  if (!readOnly) {
    const version = Number(
      database.prepare("PRAGMA user_version").get()?.user_version,
    );
    const newLedger = version === 0 &&
      !tableExists(database, "ledger_meta") &&
      !tableExists(database, "source_state") &&
      !tableExists(database, "quota_observations");
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
    try {
      assertWritableQuotaIdentityContract(database);
    } catch (error) {
      closeDatabase(database);
      throw error;
    }
    try {
      assertPersistedQuotaRows(database);
    } catch (error) {
      closeDatabase(database);
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
    if (newLedger) database.exec("PRAGMA auto_vacuum = INCREMENTAL");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA foreign_keys = ON");
    let effectiveVersion = version;
    if (effectiveVersion === 1) {
      migrateLedgerSchemaV1ToV2(database);
      effectiveVersion = 2;
    }
    if (effectiveVersion === 2) {
      migrateLedgerSchemaV2ToV3(database);
    } else {
      database.exec(ledgerSchema());
    }
    ensureLedgerColumns(database);
    if (newLedger) {
      setMeta(
        database,
        QUOTA_IDENTITY_CONTRACT_KEY,
        QUOTA_IDENTITY_CONTRACT_VERSION,
      );
    }
    database.exec(`PRAGMA user_version = ${DURABLE_LEDGER_SCHEMA_VERSION}`);
    await restrictLedgerFiles(path);
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
  if (!columns.has("quota_reconciliation_pending")) {
    database.exec(
      "ALTER TABLE source_state ADD COLUMN quota_reconciliation_pending INTEGER NOT NULL DEFAULT 0",
    );
  }
  addColumnIfMissing(
    database,
    "source_state",
    columns,
    "first_seen_location TEXT",
  );
  database.prepare(`
    UPDATE source_state
       SET first_seen_location = location
     WHERE first_seen_location IS NULL
  `).run();
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
    "This early preview durable ledger contains migrated history without a reconstructable collection scope. The ledger was left untouched. Keep it as a backup, verify the matching legacy snapshot belongs to this Codex home, and rebuild into a new durable ledger before reconciling totals.",
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
    setMeta(database, "schema_version", DURABLE_LEDGER_SCHEMA_VERSION_V2);
    database.exec(`PRAGMA user_version = ${DURABLE_LEDGER_SCHEMA_VERSION_V2}`);
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
  database.exec("PRAGMA auto_vacuum = INCREMENTAL");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec("VACUUM");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

function migrateLedgerSchemaV2ToV3(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(ledgerSchema());
    const positions = database.prepare(`
      SELECT source_id AS sourceId, event_ordinal AS eventOrdinal,
             event_key AS eventKey
        FROM source_event_positions
    `).all();
    const updatePosition = database.prepare(`
      UPDATE source_event_positions
         SET event_key = ?
       WHERE source_id = ? AND event_ordinal = ?
    `);
    for (const position of positions) {
      const eventKey = primitiveString(position.eventKey);
      if (eventKey === null || eventKey.length === 0) {
        throw new Error(
          "Durable ledger source position has an invalid event key.",
        );
      }
      // A failed process can be restarted after the data rewrite but before
      // user_version is advanced. Treat an already-canonical digest as
      // idempotent so recovery never hashes it a second time.
      const digest = /^[0-9a-f]{64}$/i.test(eventKey)
        ? eventKey.toLowerCase()
        : hash(eventKey, 64);
      updatePosition.run(
        digest,
        String(position.sourceId),
        Math.trunc(Number(position.eventOrdinal)),
      );
    }
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
  // The digest rewrite makes every position substantially smaller. Rebuild
  // once so the old JSON payloads are not retained in free pages or the WAL;
  // later deletes use incremental vacuum maintenance instead.
  database.exec("PRAGMA auto_vacuum = INCREMENTAL");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec("VACUUM");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

function maintainLedgerStorage(database) {
  const pageCount = Number(
    database.prepare("PRAGMA page_count").get()?.page_count,
  );
  const freelistCount = Number(
    database.prepare("PRAGMA freelist_count").get()?.freelist_count,
  );
  if (
    !Number.isSafeInteger(pageCount) ||
    !Number.isSafeInteger(freelistCount) ||
    freelistCount < LEDGER_VACUUM_MIN_FREELIST_PAGES ||
    freelistCount / Math.max(1, pageCount) < LEDGER_VACUUM_MIN_FREE_RATIO
  ) return false;

  const autoVacuum = Number(
    database.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum,
  );
  try {
    if (autoVacuum === 2) {
      database.exec(`PRAGMA incremental_vacuum(${freelistCount})`);
    } else {
      database.exec("VACUUM");
    }
    return true;
  } catch (error) {
    const sqliteErrcode = Number(error?.errcode);
    const sqliteErrstr = text(error?.errstr, 80).toUpperCase();
    if (
      error?.code === "SQLITE_BUSY" ||
      error?.code === "SQLITE_LOCKED" ||
      (
        error?.code === "ERR_SQLITE_ERROR" &&
        ([5, 6].includes(sqliteErrcode) ||
          ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(sqliteErrstr))
      )
    ) return false;
    throw error;
  }
}

async function chmodValidatedLedgerFile(
  path,
  expectedStat,
  description,
) {
  let handle;
  let primaryError = null;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const openedStat = validateSingleLinkRegularFileStat(
      await handle.stat(),
      description,
    );
    const currentStat = await validateSingleLinkRegularFile(path, {
      description,
    });
    if (
      !sameFileIdentity(expectedStat, openedStat) ||
      !sameFileIdentity(openedStat, currentStat)
    ) {
      throw ledgerPathError(
        `The ${description} path changed before its permissions were secured.`,
      );
    }
    await handle.chmod(0o600);
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle?.close();
  } catch (error) {
    if (primaryError === null) primaryError = error;
    else attachCleanupError(primaryError, error);
  }
  if (primaryError !== null) throw primaryError;
}

async function restrictLedgerFiles(path, description = "durable ledger") {
  const files = [
    [path, description],
    ...sqliteTransientPaths(path).map(
      ([transientPath, transientDescription]) => [
        transientPath,
        `${description} ${transientDescription}`,
      ],
    ),
  ];
  const present = [];
  for (const [filePath, fileDescription] of files) {
    const fileStat = await validateSingleLinkRegularFile(filePath, {
      allowMissing: true,
      description: fileDescription,
    });
    if (fileStat !== null) present.push([filePath, fileStat, fileDescription]);
  }
  for (const [filePath, fileStat, fileDescription] of present) {
    await chmodValidatedLedgerFile(filePath, fileStat, fileDescription);
  }
}

async function openLedgerGuard(path) {
  return openValidatedSqliteDatabase(path, {
    allowMissing: true,
    description: "durable-ledger writer guard",
  });
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
  const database = await openLedgerGuard(path);
  try {
    database.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS writer_guard (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      );
      BEGIN EXCLUSIVE;
    `);
    await restrictLedgerFiles(path, "durable-ledger writer guard");
    return { database, path };
  } catch (error) {
    closeDatabase(database);
    throw error;
  }
}

async function acquireLedgerReadLock(ledgerPath) {
  await ensureLedgerDirectory(ledgerPath, false);
  const path = `${ledgerPath}.writer-lock.sqlite`;
  const database = await openLedgerGuard(path);
  try {
    database.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS writer_guard (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      );
      BEGIN;
    `);
    database.prepare("SELECT COUNT(*) FROM writer_guard").get();
    await restrictLedgerFiles(path, "durable-ledger writer guard");
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

async function invokeLedgerFault(faultInjector, point, ledgerPath) {
  if (faultInjector instanceof Function) {
    await faultInjector({ point, path: ledgerPath });
  }
}

function createTransactionStatementCache(database) {
  const statements = new Map();
  let active = true;
  return {
    prepare(sql) {
      if (!active) {
        throw new Error("Durable-ledger transaction statements were released.");
      }
      const key = String(sql);
      let statement = statements.get(key);
      if (!statement) {
        statement = database.prepare(key);
        statements.set(key, statement);
      }
      return statement;
    },
    release() {
      active = false;
      statements.clear();
    },
  };
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

function quotaIdentityContractError() {
  const error = new Error(
    "Unsupported Token Ledger quota identity contract; refusing to modify the durable ledger.",
  );
  error.code = "ERR_DURABLE_LEDGER_QUOTA_CONTRACT";
  return error;
}

function assertWritableQuotaIdentityContract(database) {
  if (!tableExists(database, "ledger_meta")) return;
  const contract = metaValue(database, QUOTA_IDENTITY_CONTRACT_KEY);
  if (
    contract !== null &&
    contract !== PREVIOUS_QUOTA_IDENTITY_CONTRACT_VERSION &&
    contract !== QUOTA_IDENTITY_CONTRACT_VERSION
  ) throw quotaIdentityContractError();
}

function ensureQuotaIdentityContract(database) {
  const previousContract = metaValue(database, QUOTA_IDENTITY_CONTRACT_KEY);
  if (previousContract === QUOTA_IDENTITY_CONTRACT_VERSION) return;
  if (
    previousContract !== null &&
    previousContract !== PREVIOUS_QUOTA_IDENTITY_CONTRACT_VERSION
  ) throw quotaIdentityContractError();

  const totalRowsDiscarded = Number(database.prepare(`
    SELECT COUNT(*) AS count
      FROM quota_observations
  `).get()?.count || 0);
  const migratedRowsDiscarded = Number(database.prepare(`
    SELECT COUNT(*) AS count
      FROM quota_observations
     WHERE migrated = 1
  `).get()?.count || 0);
  const exactRowsDiscarded = totalRowsDiscarded - migratedRowsDiscarded;

  // Capture the source boundary before deleting incompatible memberships. A
  // clean complete scan is the only authority that can repopulate quota rows
  // after this marker change.
  database.prepare(`
    UPDATE source_state
       SET quota_reconciliation_pending = 1
     WHERE EXISTS (
       SELECT 1
         FROM quota_sources
        WHERE quota_sources.source_id = source_state.source_id
     )
  `).run();
  database.prepare("DELETE FROM quota_sources").run();
  database.prepare("DELETE FROM quota_observations").run();

  // Any evidence created before the marker change cannot prove a trustworthy
  // source and explicit observation timestamp under the new contract.
  database.prepare("DELETE FROM quota_label_evidence").run();
  setMeta(
    database,
    "quota_contract_upgrade_status",
    previousContract === null ? "upgraded-markerless" : "upgraded-incompatible",
  );
  setMeta(
    database,
    "quota_contract_migrated_rows_discarded",
    migratedRowsDiscarded,
  );
  setMeta(
    database,
    "quota_contract_exact_rows_discarded",
    exactRowsDiscarded,
  );
  // The contract marker is deliberately last: rollback leaves both the old
  // rows and old marker intact, while commit exposes only the coherent state.
  setMeta(
    database,
    QUOTA_IDENTITY_CONTRACT_KEY,
    QUOTA_IDENTITY_CONTRACT_VERSION,
  );
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
  const scanBytes = Number.isSafeInteger(Number(entry.scanBytes)) &&
      Number(entry.scanBytes) >= 0
    ? Number(entry.scanBytes)
    : size;
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
    cursorBytes: scanBytes,
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
    windowMinutes,
    resetsAt,
    usedPercent,
  ]);
}

function normalizedQuotaIdentity({ limitKey, scope } = {}) {
  const key = primitiveString(limitKey);
  if (key === null || !quotaIdentityMatchesContract({ limitKey: key, scope })) {
    return null;
  }
  const normalizedLimitKey = key.toLowerCase();
  return { limitKey: normalizedLimitKey, scope };
}

export function normalizeQuotaObservationFields({
  windowMinutes,
  resetsAt,
  usedPercent,
} = {}) {
  // Provider quota fields are exact measurements, not coercible counters.
  // A percentage is inclusive from 0 through 100; overflow is malformed and
  // must never be clamped into a plausible-looking meter.
  const normalizedResetsAt = primitiveNumber(resetsAt);
  const normalizedUsedPercent = primitiveNumber(usedPercent);
  if (
    !Number.isSafeInteger(windowMinutes) ||
    windowMinutes <= 0 ||
    !Number.isSafeInteger(normalizedResetsAt) ||
    normalizedResetsAt <= 0 ||
    !Number.isFinite(new Date(normalizedResetsAt * 1_000).getTime()) ||
    normalizedUsedPercent === null ||
    !Number.isFinite(normalizedUsedPercent) ||
    normalizedUsedPercent < 0 ||
    normalizedUsedPercent > 100
  ) return null;
  return {
    windowMinutes,
    resetsAt: normalizedResetsAt,
    // Canonicalize negative zero so every accepted percentage has one key.
    usedPercent: normalizedUsedPercent === 0 ? 0 : normalizedUsedPercent,
  };
}

export function durableQuotaObservationKey({
  limitKey,
  windowMinutes,
  resetsAt,
  usedPercent,
} = {}) {
  const normalized = normalizeQuotaObservationFields({
    windowMinutes,
    resetsAt,
    usedPercent,
  });
  return normalized
    ? quotaKey(
      limitKey,
      normalized.windowMinutes,
      normalized.resetsAt,
      normalized.usedPercent,
    )
    : null;
}

function persistedQuotaError(row) {
  const observationId = text(row?.observationId, 100, "unknown");
  const error = new Error(
    `Durable ledger quota observation ${observationId} has invalid provider fields; the ledger was left untouched.`,
  );
  error.code = "ERR_DURABLE_LEDGER_QUOTA";
  return error;
}

function assertPersistedQuotaRows(database) {
  const exists = database.prepare(`
    SELECT 1 AS present
      FROM sqlite_master
     WHERE type = 'table' AND name = 'quota_observations'
  `).get();
  if (!exists) return;
  const contract = tableExists(database, "ledger_meta")
    ? metaValue(database, QUOTA_IDENTITY_CONTRACT_KEY)
    : null;
  // Markerless and v1 rows are opaque pre-contract state. A write transaction
  // must be able to discard them without first trusting either their identity
  // or measurements. Current-contract rows, by contrast, are certified durable
  // state and fail closed if any persisted field violates that contract.
  if (contract !== QUOTA_IDENTITY_CONTRACT_VERSION) return;
  const rows = database.prepare(`
    SELECT observation_id AS observationId,
           limit_key AS limitKey, scope,
           window_minutes AS windowMinutes,
           resets_at AS resetsAt,
           used_percent AS usedPercent
      FROM quota_observations
  `).all();
  for (const row of rows) {
    if (
      !normalizeQuotaObservationFields(row) ||
      !normalizedQuotaIdentity(row)
    ) {
      throw persistedQuotaError(row);
    }
  }
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

function subtractMigratedContribution(state, candidate) {
  if (!state.interval) return false;
  const contribution = overlappingUsageContribution(
    state.row,
    candidate,
    state.interval,
  );
  if (!contribution) return false;
  for (const field of USAGE_FIELDS) {
    state.residual[field] = Math.max(
      0,
      nonNegativeNumber(state.residual[field]) -
        nonNegativeNumber(contribution[field]),
    );
  }
  for (const field of COUNT_FIELDS) {
    state.residual[field] = Math.max(
      0,
      nonNegativeNumber(state.residual[field]) -
        nonNegativeNumber(contribution[field]),
    );
  }
  // The legacy aggregate only carries a total credit estimate. Once an
  // exact/compacted row overlaps it, retaining that estimate would double
  // count credits in the rebuilt snapshot.
  state.residual.rateCardCredits = null;
  state.residual.rangeAllocationEstimated = true;
  const origin = state.residual.rangeAllocationOrigin &&
      Object(state.residual.rangeAllocationOrigin) ===
        state.residual.rangeAllocationOrigin
    ? { ...state.residual.rangeAllocationOrigin }
    : {
        inputTokens: state.row.inputTokens,
        totalTokens: state.row.totalTokens,
        callCount: state.row.callCount,
      };
  origin.inputTokens = state.residual.inputTokens;
  origin.totalTokens = state.residual.totalTokens;
  origin.callCount = state.residual.callCount;
  state.residual.rangeAllocationOrigin = origin;
  return true;
}

function migratedResidualStates(rows) {
  return rows.map((row) => ({
    row,
    residual: { ...row },
    interval: usageInterval(row),
  }));
}

function observeMigratedResiduals(states, row, migrationScope, sources) {
  if (!states.length) return;
  const scoped = observedRowWithinMigrationScope(
    row,
    migrationScope,
    sources,
  );
  if (!scoped) return;
  for (const state of states) subtractMigratedContribution(state, scoped);
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
    ![...row.sourceIds].some((sourceId) => {
      const source = sources.get(String(sourceId));
      return (source?.firstSeenLocation ?? source?.location) === "active";
    })
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
  if (
    !normalized ||
    normalized.invalidTokenRecord === true ||
    !validLegacyTimestamp(normalized.timestamp)
  ) return null;
  const timestamp = safeIso(normalized.timestamp, null);
  if (!timestamp) return null;
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

function legacySnapshotError(reason, cause = null) {
  const message =
    `Existing legacy snapshot ${reason}; the durable ledger was left untouched. ` +
    "Preserve it in a private backup, then repair or replace the snapshot and retry.";
  const error = cause === null
    ? new Error(message)
    : new Error(message, { cause });
  error.code = "ERR_DURABLE_LEDGER_LEGACY_SNAPSHOT";
  return error;
}

function legacyOptionalArray(snapshot, field) {
  if (!Object.prototype.hasOwnProperty.call(snapshot, field)) return [];
  const value = snapshot[field];
  if (!Array.isArray(value)) {
    throw legacySnapshotError(`${field} must be an array when present`);
  }
  return value;
}

function validLegacyTimestamp(value) {
  return primitiveString(value) !== null && finiteTimestamp(value) !== null;
}

function primitiveNumber(value) {
  try {
    const number = Number.prototype.valueOf.call(value);
    return number === value ? number : null;
  } catch {
    return null;
  }
}

function validOptionalLegacyText(value, maximumLength) {
  if (value == null) return true;
  const candidate = primitiveString(value);
  return candidate !== null && candidate.length <= maximumLength;
}

function validateLegacyQuota(quota, index) {
  if (!quota || Object(quota) !== quota || Array.isArray(quota)) {
    throw legacySnapshotError(
      `contains an invalid quota observation at index ${index}`,
    );
  }
  const normalized = normalizeQuotaObservationFields({
    windowMinutes: quota.windowMinutes,
    resetsAt: primitiveNumber(quota.resetsAt),
    usedPercent: primitiveNumber(quota.usedPercent),
  });
  if (
    !normalized ||
    !validLegacyTimestamp(quota.timestamp)
  ) {
    throw legacySnapshotError(
      `contains an invalid quota observation at index ${index}`,
    );
  }
  if (
    quota.lastSeenAt != null &&
    (
      !validLegacyTimestamp(quota.lastSeenAt) ||
      finiteTimestamp(quota.lastSeenAt) < finiteTimestamp(quota.timestamp)
    )
  ) {
    throw legacySnapshotError(
      `contains an invalid quota observation at index ${index}`,
    );
  }
  if (
    quota.scope !== "account" &&
    quota.scope !== "named"
  ) {
    throw legacySnapshotError(
      `contains an invalid quota observation at index ${index}`,
    );
  }
  for (const [field, maximumLength] of [
    ["limitKey", 160],
    ["limitName", 80],
    ["planType", 80],
  ]) {
    if (!validOptionalLegacyText(quota[field], maximumLength)) {
      throw legacySnapshotError(
        `contains an invalid quota observation at index ${index}`,
      );
    }
  }
  if (!normalizedQuotaIdentity(quota)) {
    throw legacySnapshotError(
      `contains an invalid quota observation at index ${index}`,
    );
  }
}

function legacyQuotaImportPlan(snapshot) {
  const present = Object.prototype.hasOwnProperty.call(
    snapshot,
    "quotaObservations",
  );
  const value = present ? snapshot.quotaObservations : [];
  const rowCount = Array.isArray(value) ? value.length : 0;
  if (!present) {
    return {
      allowed: false,
      rows: [],
      rowsSkipped: 0,
      status: "not-present",
    };
  }
  const contract = snapshotQuotaIdentityContract(snapshot);
  if (contract === QUOTA_IDENTITY_CONTRACT_VERSION) {
    if (!Array.isArray(value)) {
      return {
        allowed: false,
        rows: [],
        rowsSkipped: 0,
        status: "skipped-invalid",
      };
    }
    if (value.length === 0) {
      return {
        allowed: false,
        rows: [],
        rowsSkipped: 0,
        status: "not-present",
      };
    }
    try {
      for (const [index, quota] of value.entries()) {
        validateLegacyQuota(quota, index);
      }
    } catch {
      return {
        allowed: false,
        rows: [],
        rowsSkipped: value.length,
        status: "skipped-invalid",
      };
    }
    return {
      allowed: true,
      rows: value,
      rowsSkipped: 0,
      status: "eligible",
    };
  }
  if (rowCount === 0 && Array.isArray(value)) {
    return {
      allowed: false,
      rows: [],
      rowsSkipped: 0,
      status: "not-present",
    };
  }
  return {
    allowed: false,
    rows: [],
    rowsSkipped: rowCount,
    status: contract === null
      ? "skipped-contract-unverified"
      : "skipped-contract-mismatch",
  };
}

function validateLegacyThread(thread, index) {
  if (!thread || Object(thread) !== thread || Array.isArray(thread)) {
    throw legacySnapshotError(`contains an invalid thread at index ${index}`);
  }
  const threadId = primitiveString(thread.id);
  if (!threadId?.trim() || threadId.length > 400) {
    throw legacySnapshotError(`contains an invalid thread at index ${index}`);
  }
  if (
    thread.reportedCumulativeTokens != null &&
    (
      !Number.isSafeInteger(thread.reportedCumulativeTokens) ||
      thread.reportedCumulativeTokens < 0
    )
  ) {
    throw legacySnapshotError(`contains an invalid thread at index ${index}`);
  }
  if (
    !validOptionalLegacyText(thread.parentThreadId, 400) ||
    (thread.parentThreadId != null && !thread.parentThreadId.trim())
  ) {
    throw legacySnapshotError(`contains an invalid thread at index ${index}`);
  }
  for (const field of ["firstActiveAt", "lastActiveAt"]) {
    if (thread[field] != null && !validLegacyTimestamp(thread[field])) {
      throw legacySnapshotError(`contains an invalid thread at index ${index}`);
    }
  }
  if (
    thread.firstActiveAt != null &&
    thread.lastActiveAt != null &&
    finiteTimestamp(thread.lastActiveAt) < finiteTimestamp(thread.firstActiveAt)
  ) {
    throw legacySnapshotError(`contains an invalid thread at index ${index}`);
  }
}

function validateLegacySnapshot(snapshot) {
  if (
    !snapshot ||
    Object(snapshot) !== snapshot ||
    Array.isArray(snapshot) ||
    snapshot.schemaVersion !== 3 ||
    !Array.isArray(snapshot.events)
  ) {
    throw legacySnapshotError("uses an unsupported schema");
  }
  if (snapshot.generatedAt != null && !validLegacyTimestamp(snapshot.generatedAt)) {
    throw legacySnapshotError("has an invalid generatedAt timestamp");
  }
  const validationTimestamp = safeIso(
    snapshot.generatedAt,
    "1970-01-01T00:00:00.000Z",
  );
  for (const [index, bucket] of snapshot.events.entries()) {
    if (
      migrationRowFromBucket(
        bucket,
        "snapshot-v3-validation",
        index,
        validationTimestamp,
        validationTimestamp,
      ) === null
    ) {
      throw legacySnapshotError(
        `contains an invalid usage event at index ${index}`,
      );
    }
  }
  legacyQuotaImportPlan(snapshot);
  const threads = legacyOptionalArray(snapshot, "threads");
  for (const [index, thread] of threads.entries()) {
    validateLegacyThread(thread, index);
  }
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
    throw legacySnapshotError(reason, cause);
  }
  validateLegacySnapshot(snapshot);
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
    const quotaPlan = legacyQuotaImportPlan(snapshot);
    setMeta(database, "legacy_quota_status", `skipped-${gate.reason}`);
    setMeta(
      database,
      "legacy_quota_rows_skipped",
      quotaPlan.rows.length + quotaPlan.rowsSkipped,
    );
    return { migrated: false, migrationKey, reason: gate.reason };
  }

  const generatedAt = snapshot.generatedAt == null
    ? now
    : safeIso(snapshot.generatedAt, now);
  const migrationScope = gate.scope;
  const includeArchived = migrationScope.includeArchived;
  const sourceFingerprint = hash(JSON.stringify(snapshot), 64);
  const sourceLabel = "token-ledger-snapshot-v3";
  const quotaPlan = legacyQuotaImportPlan(snapshot);
  const usageRows = snapshot.events
    .map((bucket, index) =>
      migrationRowFromBucket(bucket, migrationKey, index, generatedAt, now));
  if (usageRows.some((row) => row === null)) {
    // readLegacySnapshot validates every row before the write transaction.
    // Keep this defensive guard so a future converter change cannot silently
    // burn the one-shot migration opportunity.
    throw legacySnapshotError("contains an invalid usage event");
  }
  const quotaRows = quotaPlan.rows
    .map((quota) => {
      const normalized = normalizeQuotaObservationFields(quota);
      if (!normalized) {
        // readLegacySnapshot validates every row before the transaction.
        throw legacySnapshotError("contains an invalid quota observation");
      }
      const { windowMinutes, resetsAt, usedPercent } = normalized;
      const timestamp = safeIso(quota.timestamp, null);
      const limitKey = text(quota.limitKey, 16).toLowerCase();
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
        // A generated snapshot is aggregate output, not source-level label
        // evidence. Preserve the canonical identity and measurements only.
        limitName: null,
        scope: quota.scope,
        windowMinutes,
        resetsAt,
        usedPercent,
        planType: text(quota.planType, 80, "unknown"),
        firstSeenAt: timestamp,
        lastSeenAt: quota.lastSeenAt == null
          ? timestamp
          : safeIso(quota.lastSeenAt, timestamp),
        migrated: 1,
        exactSeen: 0,
      };
    });

  const insertThread = database.prepare(`
    INSERT OR IGNORE INTO thread_records (
      thread_id, title, project, model, effort, source, use_type,
      parent_thread_id, reported_cumulative_tokens, created_at, updated_at,
      first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const thread of legacyOptionalArray(snapshot, "threads")) {
    const threadId = text(thread?.id, 400, "");
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
  setMeta(database, "legacy_quota_status", quotaRows.length > 0
    ? "migrated"
    : quotaPlan.status);
  setMeta(
    database,
    "legacy_quota_rows_skipped",
    quotaPlan.rowsSkipped,
  );
  return {
    migrated: true,
    migrationKey,
    since: migrationScope.since,
    includeArchived,
    usageRows: usageRows.length,
    quotaRows: quotaRows.length,
    quotaStatus: quotaRows.length > 0 ? "migrated" : quotaPlan.status,
    quotaRowsSkipped: quotaPlan.rowsSkipped,
  };
}

function updateSourceStates(
  database,
  codexHome,
  inventory,
  includeArchived,
  uncertainSourceIds,
  quotaUncertainSourceIds,
  now,
) {
  const priorSources = new Map(database.prepare(`
    SELECT source_id AS sourceId, first_seen_at AS firstSeenAt,
           first_seen_location AS firstSeenLocation,
           path_fingerprint AS pathFingerprint, cursor_bytes AS cursorBytes,
           cursor_fingerprint AS cursorFingerprint, device, inode,
           change_state AS changeState,
           reconciliation_pending AS reconciliationPending,
           quota_reconciliation_pending AS quotaReconciliationPending
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
  const quotaUncertainIds = new Set(
    [...(quotaUncertainSourceIds || [])].map(String),
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
      first_seen_location, last_seen_at, last_transition_at,
      reconciliation_pending, quota_reconciliation_pending
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      first_seen_location = COALESCE(
        source_state.first_seen_location,
        excluded.first_seen_location
      ),
      change_state = excluded.change_state,
      change_count = source_state.change_count + excluded.change_count,
      reconciliation_pending = excluded.reconciliation_pending,
      quota_reconciliation_pending = excluded.quota_reconciliation_pending,
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
    const changeCount = sourceWasIngested && (truncated || replaced) ? 1 : 0;
    const sourceUncertain = uncertainIds.has(String(source.sourceId));
    const quotaSourceUncertain =
      sourceUncertain || quotaUncertainIds.has(String(source.sourceId));
    const priorReconciliationPending = Number(
      prior?.reconciliationPending,
    ) === 1;
    const priorQuotaReconciliationPending = Number(
      prior?.quotaReconciliationPending,
    ) === 1;
    const blockedReconciliation = Boolean(
      sourceWasIngested &&
      sourceUncertain &&
      !truncated,
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
      : priorReconciliationPending || blockedReconciliation;
    const completedReconciliation = Boolean(
      sourceWasIngested &&
      !sourceUncertain &&
      !truncated &&
      (source.reconcileMemberships || !source.reconciliationPending)
    );
    const changeState = truncated
      ? "truncated"
      : replaced
        ? "replaced"
        : completedReconciliation
          ? "stable"
          : prior && prior.changeState !== "stable"
            ? text(prior.changeState, 40, "replaced")
            : "stable";
    const quotaReconciliationRequired = Boolean(
      sourceWasIngested &&
      !truncated &&
      (replaced || priorReconciliationPending || priorQuotaReconciliationPending),
    );
    source.reconcileQuotaMemberships = Boolean(
      quotaReconciliationRequired && !quotaSourceUncertain,
    );
    source.quotaReconciliationPending = source.reconcileQuotaMemberships
      ? false
      : priorQuotaReconciliationPending ||
        (sourceWasIngested && !truncated && quotaSourceUncertain);
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
      prior?.firstSeenLocation || source.location,
      now,
      now,
      source.reconciliationPending ? 1 : 0,
      source.quotaReconciliationPending ? 1 : 0,
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

function allocateExactObservationId(database, eventKey) {
  for (let salt = 0; ; salt += 1) {
    const identity = salt === 0
      ? eventKey
      : JSON.stringify([eventKey, salt]);
    const candidate = `exact-${hash(identity, 64)}`;
    const occupied = database.prepare(`
      SELECT event_key AS eventKey
        FROM usage_observations
       WHERE observation_id = ?
    `).get(candidate);
    if (!occupied || String(occupied.eventKey) === eventKey) return candidate;
  }
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

  const exactObservationId = allocateExactObservationId(database, eventKey);
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
  `).run(exactObservationId, compactedObservationId, hash(eventKey, 64));
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
  const eventKeyDigest = hash(eventKey, 64);
  const global = database.prepare(`
    SELECT observation_id AS observationId
      FROM usage_observations
     WHERE identity_kind = 'exact' AND event_key = ?
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
        SELECT observation_id AS observationId,
               event_key AS eventKeyDigest,
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
          displaced.eventKeyDigest,
          displaced.firstSeenAt,
          displaced.lastSeenAt,
        );
      }
    }
    return { observationId, replacesEventKey: null };
  }
  for (const position of positions || []) {
    const positioned = database.prepare(`
      SELECT position.observation_id AS observationId,
             position.event_key AS eventKeyDigest,
             observation.identity_kind AS identityKind
        FROM source_event_positions AS position
        JOIN usage_observations AS observation
          ON observation.observation_id = position.observation_id
       WHERE position.source_id = ? AND position.event_ordinal = ?
    `).get(String(position.sourceId), Math.trunc(Number(position.ordinal)));
    if (!positioned?.observationId) continue;
    if (String(positioned.eventKeyDigest) === eventKeyDigest) {
      return {
        observationId: String(positioned.observationId),
        replacesEventKey: null,
      };
    }
    const shared = database.prepare(`
      SELECT 1 AS present
        FROM usage_sources
       WHERE observation_id = ? AND source_id <> ?
       LIMIT 1
    `).get(positioned.observationId, String(position.sourceId));
    if (positioned.identityKind === "compacted" || shared?.present) continue;
    return {
      observationId: String(positioned.observationId),
      replacesEventKey: positioned.eventKeyDigest == null
        ? null
        : true,
    };
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
    hash(eventKey, 64),
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
  replaceIdentity = false,
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
    positioned?.observationId || allocateExactObservationId(database, eventKey),
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
    WITH replacement_flag(value) AS (VALUES (?))
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
      turn_id = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.turn_id ELSE usage_observations.turn_id END,
      thread_id = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.thread_id ELSE usage_observations.thread_id END,
      timestamp = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.timestamp ELSE usage_observations.timestamp END,
      event_key = excluded.event_key,
      input_tokens = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.input_tokens ELSE usage_observations.input_tokens END,
      cached_input_tokens = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.cached_input_tokens ELSE usage_observations.cached_input_tokens END,
      cache_write_input_tokens = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.cache_write_input_tokens ELSE usage_observations.cache_write_input_tokens END,
      output_tokens = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.output_tokens ELSE usage_observations.output_tokens END,
      reasoning_tokens = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.reasoning_tokens ELSE usage_observations.reasoning_tokens END,
      total_tokens = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.total_tokens ELSE usage_observations.total_tokens END,
      tool_calls = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.tool_calls ELSE usage_observations.tool_calls END,
      call_count = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.call_count ELSE usage_observations.call_count END,
      detailed_call_count = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.detailed_call_count ELSE usage_observations.detailed_call_count END,
      input_call_count = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.input_call_count ELSE usage_observations.input_call_count END,
      components_valid = CASE WHEN (SELECT value FROM replacement_flag) = 1
          OR excluded.original_likely = 1
          OR usage_observations.original_likely = 0
        THEN excluded.components_valid ELSE usage_observations.components_valid END,
      token_model = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.token_model ELSE usage_observations.token_model END,
      token_effort = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.token_effort ELSE usage_observations.token_effort END,
      token_cwd = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.token_cwd ELSE usage_observations.token_cwd END,
      token_git_origin = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.token_git_origin ELSE usage_observations.token_git_origin END,
      token_raw_source = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.token_raw_source ELSE usage_observations.token_raw_source END,
      token_service_tier = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.token_service_tier ELSE usage_observations.token_service_tier END,
      origin_thread_id = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.origin_thread_id ELSE usage_observations.origin_thread_id END,
      origin_timestamp = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.origin_timestamp ELSE usage_observations.origin_timestamp END,
      origin_model = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.origin_model ELSE usage_observations.origin_model END,
      origin_effort = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.origin_effort ELSE usage_observations.origin_effort END,
      origin_cwd = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.origin_cwd ELSE usage_observations.origin_cwd END,
      origin_git_origin = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.origin_git_origin ELSE usage_observations.origin_git_origin END,
      origin_raw_source = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.origin_raw_source ELSE usage_observations.origin_raw_source END,
      origin_service_tier = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.origin_service_tier ELSE usage_observations.origin_service_tier END,
      project = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.project ELSE usage_observations.project END,
      display_model = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.display_model ELSE usage_observations.display_model END,
      source_label = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.source_label ELSE usage_observations.source_label END,
      use_type = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.use_type ELSE usage_observations.use_type END,
      rate_card_model = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.rate_card_model ELSE usage_observations.rate_card_model END,
      rate_card_credits = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.rate_card_credits ELSE usage_observations.rate_card_credits END,
      range_allocation_estimated = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.range_allocation_estimated
        ELSE usage_observations.range_allocation_estimated END,
      range_allocation_origin = CASE WHEN (SELECT value FROM replacement_flag) = 1
        OR excluded.original_likely = 1
        THEN excluded.range_allocation_origin
        ELSE usage_observations.range_allocation_origin END,
      original_likely = CASE WHEN (SELECT value FROM replacement_flag) = 1
        THEN excluded.original_likely
        ELSE MAX(usage_observations.original_likely, excluded.original_likely) END
  `);
  const metadataRecord = metadata || {};
  insert.run(
    replaceIdentity ? 1 : 0,
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

function persistQuotaLabelEvidence(
  database,
  sourceMap,
  seenQuotaLimitKeysBySource,
  quotaLabelEvidence,
  now,
) {
  const storedForSource = database.prepare(
    "SELECT limit_key AS limitKey FROM quota_label_evidence WHERE source_id = ?",
  );
  const deleteEvidence = database.prepare(`
    DELETE FROM quota_label_evidence
     WHERE source_id = ? AND limit_key = ?
  `);
  for (const [sourceId, source] of sourceMap) {
    // A clean complete replacement is authoritative for this source's own
    // pool set. Keep prior explicit evidence when that pool is still observed
    // without an optional label, but remove evidence for pools no longer
    // present. Uncertain scans never receive this flag.
    if (!source.reconcileQuotaMemberships) continue;
    const seen = seenQuotaLimitKeysBySource.get(sourceId) || new Set();
    for (const row of storedForSource.all(sourceId)) {
      if (!seen.has(String(row.limitKey))) {
        deleteEvidence.run(sourceId, row.limitKey);
      }
    }
  }
  const merge = database.prepare(`
    INSERT INTO quota_label_evidence (
      limit_key, source_id, limit_name, observed_at, recorded_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(limit_key, source_id) DO UPDATE SET
      limit_name = excluded.limit_name,
      observed_at = excluded.observed_at,
      recorded_at = excluded.recorded_at
    WHERE excluded.observed_at > quota_label_evidence.observed_at
       OR (
         excluded.observed_at = quota_label_evidence.observed_at
         AND excluded.limit_name > quota_label_evidence.limit_name
       )
  `);
  const replace = database.prepare(`
    INSERT INTO quota_label_evidence (
      limit_key, source_id, limit_name, observed_at, recorded_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(limit_key, source_id) DO UPDATE SET
      limit_name = excluded.limit_name,
      observed_at = excluded.observed_at,
      recorded_at = excluded.recorded_at
  `);
  for (const evidence of quotaLabelEvidence || []) {
    const sourceId = text(evidence?.sourceId, 400, "");
    const limitKey = text(evidence?.limitKey, 160, "");
    const normalizedLimitKey = limitKey.toLowerCase();
    const limitName = text(evidence?.limitName, 80, "").trim();
    const observedAt = safeIso(evidence?.observedAt, null);
    if (
      !sourceMap.has(sourceId) ||
      !/^[0-9a-f]{16}$/i.test(limitKey) ||
      !seenQuotaLimitKeysBySource.get(sourceId)?.has(normalizedLimitKey) ||
      !limitName ||
      observedAt === null
    ) continue;
    const write = sourceMap.get(sourceId)?.reconcileQuotaMemberships
      ? replace
      : merge;
    write.run(
      normalizedLimitKey,
      sourceId,
      limitName,
      observedAt,
      now,
    );
  }
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
  const normalized = normalizeQuotaObservationFields(row);
  const identity = normalizedQuotaIdentity(row);
  if (!normalized || !identity) throw persistedQuotaError(row);
  const { windowMinutes, resetsAt, usedPercent } = normalized;
  // Identity is parser-owned and provider-id-derived. Never guess a durable
  // identity from an optional display label at the storage boundary.
  const { limitKey, scope } = identity;
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
    ) VALUES (?, ?, 'exact', ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, 1)
    ON CONFLICT(observation_id) DO UPDATE SET
      identity_kind = 'exact',
      migrated = 0,
      limit_name = NULL,
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
    scope,
    windowMinutes,
    resetsAt,
    usedPercent,
    text(row.planType, 80, "unknown"),
    firstSeenAt,
    lastSeenAt,
  );
  return { observationId, observationKey, limitKey };
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
  reconciliationField = "reconcileMemberships",
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
    if (!source[reconciliationField]) continue;
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

function commitUndoColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map(
    (column) => ({
      name: String(column.name),
      primaryKey: Number(column.pk) > 0,
    }),
  );
}

// Row-level logical undo for the capture window: the ingest pass, the
// compaction and retention-pruning passes over the candidate revision, and
// the one-shot legacy-migration marker. Temporary triggers capture, in
// commit order, the prior image of every updated or deleted row and the key
// of every inserted row across the mutable tables. The log commits
// atomically with the revision itself, so a rejection detected after COMMIT
// (or a crash before the post-commit source check completes) can revert the
// unvalidated scan exactly: in-place positional overwrites, quota evidence
// and bounds, compacted aggregates of candidate events, reconciliation
// deletions, and net-new additions alike. The revision counter and the
// pending-validation marker are written after the window closes so they
// survive reversion.
function createCommitUndoCapture(database) {
  const drops = [];
  for (const table of COMMIT_UNDO_TABLES) {
    const columns = commitUndoColumns(database, table);
    const image = (prefix, selected) => `json_object(${selected
      .map((column) => `'${column.name}', ${prefix}.${column.name}`)
      .join(", ")})`;
    const changed = columns
      .filter((column) =>
        COMMIT_UNDO_FULLY_CAPTURED_TABLES.has(table) ||
        !COMMIT_UNDO_VOLATILE_COLUMNS.has(column.name)
      )
      .map((column) => `OLD.${column.name} IS NOT NEW.${column.name}`)
      .join(" OR ");
    const keys = columns.filter((column) => column.primaryKey);
    const define = (operation, event, when, payload) => {
      const name = `commit_undo_${table}_${operation}`;
      database.exec(`
        CREATE TEMP TRIGGER ${name} AFTER ${event} ON ${table}
        ${when ? `WHEN ${when}` : ""}
        BEGIN
          INSERT INTO commit_undo_log (table_name, operation, row_data)
          VALUES ('${table}', '${operation}', ${payload});
        END
      `);
      drops.push(name);
    };
    define("insert", "INSERT", null, image("NEW", keys));
    define("update", "UPDATE", changed, image("OLD", columns));
    define("delete", "DELETE", null, image("OLD", columns));
  }
  return () => {
    for (const name of drops) {
      database.exec(`DROP TRIGGER IF EXISTS ${name}`);
    }
  };
}

// Applies the captured undo entries newest-first: inserted rows are deleted
// by key and updated or deleted rows are restored from their prior images.
// Values move exclusively through SQLite's JSON functions so 64-bit device
// and inode numbers survive without JavaScript number precision loss.
function applyCommitUndoLog(database) {
  const entries = database.prepare(`
    SELECT sequence, table_name AS tableName, operation
      FROM commit_undo_log
     ORDER BY sequence DESC
  `).all();
  const statements = new Map();
  const statementFor = (table, operation) => {
    if (!COMMIT_UNDO_TABLES.includes(table)) return null;
    const key = `${operation}:${table}`;
    const cached = statements.get(key);
    if (cached) return cached;
    const columns = commitUndoColumns(database, table);
    const extract = (column) =>
      `(SELECT json_extract(row_data, '$.${column.name}') FROM commit_undo_log WHERE sequence = ?)`;
    const statement = operation === "insert"
      ? database.prepare(`
          DELETE FROM ${table}
           WHERE ${columns.filter((column) => column.primaryKey)
             .map((column) => `${column.name} IS ${extract(column)}`)
             .join(" AND ")}
        `)
      : database.prepare(`
          INSERT OR REPLACE INTO ${table} (${columns.map((column) => column.name).join(", ")})
          SELECT ${columns
            .map((column) => `json_extract(row_data, '$.${column.name}')`)
            .join(", ")}
            FROM commit_undo_log WHERE sequence = ?
        `);
    statements.set(key, statement);
    return statement;
  };
  for (const entry of entries) {
    const statement = statementFor(
      String(entry.tableName),
      String(entry.operation),
    );
    if (statement === null) continue;
    const parameters = entry.operation === "insert"
      ? commitUndoColumns(database, String(entry.tableName))
          .filter((column) => column.primaryKey)
          .map(() => entry.sequence)
      : [entry.sequence];
    statement.run(...parameters);
  }
  database.prepare("DELETE FROM commit_undo_log").run();
  return entries.length;
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
  quotaLabelEvidence,
  uncertainSourceIds,
  quotaUncertainSourceIds,
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
    quotaLabelEvidence = [...(quotaLabelEvidence || [])].map((evidence) => ({
      ...evidence,
      sourceId: sourceRemap.get(String(evidence.sourceId)) || evidence.sourceId,
    }));
    uncertainSourceIds = new Set(
      [...(uncertainSourceIds || [])].map((sourceId) =>
        sourceRemap.get(String(sourceId)) || String(sourceId)
      ),
    );
    quotaUncertainSourceIds = new Set(
      [...(quotaUncertainSourceIds || [])].map((sourceId) =>
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
    quotaUncertainSourceIds,
    now,
  );
  if (inventory?.metadataWatermark) {
    setMeta(
      database,
      "metadata_watermark",
      JSON.stringify(inventory.metadataWatermark),
    );
  }

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
    const positioned = observationForSourcePosition(
      database,
      positionsByEventKey.get(eventKey),
      eventKey,
    );
    const observationId = upsertUsageObservation(
      database,
      row,
      eventMetadata?.get(String(row.eventKey)),
      now,
      positioned?.observationId || null,
      sourceIds,
      allowCompactedReuse,
      positioned?.replacesEventKey != null,
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
  const quotaLimitKeys = new Map();
  for (const row of quotas || []) {
    const stored = upsertQuotaObservation(database, row, now);
    if (stored) {
      quotaObservationIds.set(stored.observationKey, stored.observationId);
      quotaLimitKeys.set(stored.observationKey, stored.limitKey);
    }
  }
  const seenQuotaLimitKeysBySource = new Map();
  for (const [key, sourceIds] of quotaSources || []) {
    const limitKey = quotaLimitKeys.get(String(key));
    if (!limitKey) continue;
    for (const sourceId of sourceIds) {
      const seen = seenQuotaLimitKeysBySource.get(String(sourceId)) ||
        new Set();
      seen.add(limitKey);
      seenQuotaLimitKeysBySource.set(String(sourceId), seen);
    }
  }
  persistQuotaLabelEvidence(
    database,
    sourceMap,
    seenQuotaLimitKeysBySource,
    quotaLabelEvidence,
    now,
  );
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
    reconciliationField: "reconcileQuotaMemberships",
  });
  for (const [key, sourceIds] of quotaSources || []) {
    const observationId = quotaObservationIds.get(String(key)) ||
      `quota-${hash(key, 64)}`;
    for (const sourceId of sourceIds) {
      const bounds = quotaSourceBounds?.get(String(key))?.get(String(sourceId));
      const firstSeenAt = safeIso(bounds?.firstSeenAt, now);
      const lastSeenAt = safeIso(bounds?.lastSeenAt, firstSeenAt);
      const writeSource = sourceMap.get(String(sourceId))
        ?.reconcileQuotaMemberships
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
    DELETE FROM quota_label_evidence
     WHERE source_id IN (
       SELECT source_id
         FROM source_state
        WHERE status IN ('missing', 'tombstoned')
          AND last_seen_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM usage_sources
             WHERE source_id = source_state.source_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM quota_sources
             WHERE source_id = source_state.source_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM tool_sources
             WHERE source_id = source_state.source_id
          )
     )
  `).run(cutoff);
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

const DURABLE_USAGE_OBSERVATION_SELECT = `
  observation.observation_id AS observationId,
  observation.identity_kind AS identityKind,
  observation.event_key AS eventKey,
  observation.turn_id AS turnId,
  observation.thread_id AS threadId,
  observation.timestamp,
  observation.input_tokens AS inputTokens,
  observation.cached_input_tokens AS cachedInputTokens,
  observation.cache_write_input_tokens AS cacheWriteInputTokens,
  observation.output_tokens AS outputTokens,
  observation.reasoning_tokens AS reasoningTokens,
  observation.total_tokens AS totalTokens,
  observation.tool_calls AS toolCalls,
  observation.call_count AS callCount,
  observation.detailed_call_count AS detailedCallCount,
  observation.input_call_count AS inputCallCount,
  observation.components_valid AS componentsValid,
  observation.token_model AS tokenModel,
  observation.token_effort AS tokenEffort,
  observation.token_cwd AS tokenCwd,
  observation.token_git_origin AS tokenGitOrigin,
  observation.token_raw_source AS tokenRawSource,
  observation.token_service_tier AS tokenServiceTier,
  observation.origin_thread_id AS originThreadId,
  observation.origin_timestamp AS originTimestamp,
  observation.origin_model AS originModel,
  observation.origin_effort AS originEffort,
  observation.origin_cwd AS originCwd,
  observation.origin_git_origin AS originGitOrigin,
  observation.origin_raw_source AS originRawSource,
  observation.origin_service_tier AS originServiceTier,
  observation.project,
  observation.display_model AS displayModel,
  observation.source_label AS sourceLabel,
  observation.use_type AS useType,
  observation.rate_card_model AS rateCardModel,
  observation.rate_card_credits AS rateCardCredits,
  observation.original_likely AS originalLikely,
  observation.range_allocation_estimated AS rangeAllocationEstimated,
  observation.range_allocation_origin AS rangeAllocationOrigin
`;

function databaseUsageRows(
  database,
  includeArchived,
  sources,
  { onRow = null } = {},
) {
  const migrationScope = latestMigrationScope(database);
  const activeOnlyMigration = migrationScope?.includeArchived === false;
  const includeMigrated = includeArchived || activeOnlyMigration;
  const collectRows = !(onRow instanceof Function);
  const rows = collectRows ? [] : null;
  const observedCandidates = collectRows ? [] : null;
  const migratedRows = includeMigrated
    ? database.prepare(`
      SELECT ${DURABLE_USAGE_OBSERVATION_SELECT}
        FROM usage_observations AS observation
       WHERE observation.identity_kind = 'migrated_compacted'
       ORDER BY observation.timestamp, observation.observation_id
    `).all().map((row) => {
      const usageRow = usageRowFromDatabase(row);
      usageRow.toolCallKeys = [];
      return usageRow;
    })
    : [];
  const residualStates = collectRows
    ? null
    : migratedResidualStates(migratedRows);
  const compactedEventKeysStatement = database.prepare(`
    SELECT event_key AS eventKey
      FROM usage_compaction_membership
     WHERE observation_id = ?
     ORDER BY event_key
  `);
  function* compactedEventKeys(observationId) {
    // Stream mode exposes this iterator only to the synchronous row sink. It
    // is consumed before the next usage row is requested, so the statement
    // never overlaps another use of itself.
    for (const member of compactedEventKeysStatement.iterate(observationId)) {
      yield String(member.eventKey);
    }
  }
  const scopedToolPredicate = includeArchived
    ? "1"
    : `EXISTS (
        SELECT 1
          FROM tool_sources AS source
          JOIN source_state AS state ON state.source_id = source.source_id
         WHERE source.call_key = membership.call_key
           AND state.location = 'active'
      )`;
  const statement = database.prepare(`
    WITH source_ids AS (
      SELECT observation_id,
             json_group_array(source_id ORDER BY source_id) AS sourceIds
        FROM usage_sources
       GROUP BY observation_id
    ), tool_keys AS (
      SELECT membership.observation_id,
             json_group_array(membership.call_key ORDER BY membership.call_key)
               AS allToolCallKeys,
             json_group_array(membership.call_key ORDER BY membership.call_key)
               FILTER (WHERE ${scopedToolPredicate}) AS scopedToolCallKeys
        FROM usage_tool_membership AS membership
       GROUP BY membership.observation_id
    )
    SELECT ${DURABLE_USAGE_OBSERVATION_SELECT},
           COALESCE(source_ids.sourceIds, '[]') AS sourceIdsJson,
           COALESCE(tool_keys.allToolCallKeys, '[]') AS allToolCallKeysJson,
           COALESCE(tool_keys.scopedToolCallKeys, '[]') AS scopedToolCallKeysJson
      FROM usage_observations AS observation
      LEFT JOIN source_ids
        ON source_ids.observation_id = observation.observation_id
      LEFT JOIN tool_keys
        ON tool_keys.observation_id = observation.observation_id
     WHERE observation.identity_kind <> 'migrated_compacted'
     ORDER BY observation.timestamp, observation.observation_id
  `);
  let compactedUsageRows = 0;
  const emit = (row) => {
    if (row.identityKind === "compacted") compactedUsageRows += 1;
    if (onRow instanceof Function) onRow(row);
    else rows.push(row);
  };
  for (const raw of statement.iterate()) {
    const sourceIds = new Set(stringArrayFromJson(raw.sourceIdsJson));
    const allToolCallKeys = stringArrayFromJson(raw.allToolCallKeysJson);
    const ownedToolCallKeys = stringArrayFromJson(raw.scopedToolCallKeysJson);
    const usageRow = usageRowFromDatabase({
      ...raw,
      toolCalls:
        raw.identityKind === "compacted" && allToolCallKeys.length > 0
          ? ownedToolCallKeys.length
          : Math.max(
              nonNegativeNumber(raw.toolCalls),
              ownedToolCallKeys.length,
            ),
    }, sourceIds);
    usageRow.toolCallKeys = ownedToolCallKeys;
    if (raw.identityKind === "compacted") {
      const members = compactedEventKeys(usageRow.observationId);
      usageRow.compactedEventKeys = collectRows
        ? [...members]
        : members;
    }
    if (raw.identityKind === "exact" || raw.identityKind === "compacted") {
      // Keep archive-filtered observations available for migration overlap
      // subtraction. Their source's first-seen location determines whether
      // they belong to an active-only legacy migration; current location is
      // still used below to decide which rows are returned to the caller.
      if (collectRows) observedCandidates.push(usageRow);
      if (collectRows) {
        if (sourceAssociationAllows(sourceIds, sources, includeArchived)) {
          if (usageRow.identityKind === "compacted") compactedUsageRows += 1;
          rows.push(usageRow);
        }
      } else {
        observeMigratedResiduals(
          residualStates,
          usageRow,
          migrationScope,
          sources,
        );
        if (sourceAssociationAllows(sourceIds, sources, includeArchived)) {
          emit(usageRow);
        }
      }
      continue;
    }
    emit(usageRow);
  }

  if (collectRows) {
    const observedRows = observedCandidates
      .map((row) => observedRowWithinMigrationScope(
        row,
        migrationScope,
        sources,
      ))
      .filter(Boolean);
    const migratedOutputRows = migratedRows
      .map((row) => subtractMigratedRow(row, observedRows))
      .filter(Boolean);
    const usageRows = rows.concat(migratedOutputRows).sort((left, right) =>
      (finiteTimestamp(left.timestamp) ?? 0) -
      (finiteTimestamp(right.timestamp) ?? 0) ||
      left.observationId.localeCompare(right.observationId),
    );
    return {
      rows: usageRows,
      migratedUsageRows: migratedOutputRows.length,
      migratedUsageTokens: migratedOutputRows.reduce(
        (sum, row) => sum + row.totalTokens,
        0,
      ),
      compactedUsageRows,
    };
  }

  let migratedUsageRows = 0;
  let migratedUsageTokens = 0;
  for (const state of residualStates) {
    if (state.residual.totalTokens <= 0 && state.residual.callCount <= 0) {
      continue;
    }
    migratedUsageRows += 1;
    migratedUsageTokens += state.residual.totalTokens;
    emit(state.residual);
  }
  return {
    rows: [],
    migratedUsageRows,
    migratedUsageTokens,
    compactedUsageRows,
  };
}

function quotaLabelsByLimitKey(database, includeArchived, sources) {
  if (!tableExists(database, "quota_label_evidence")) return new Map();
  const labels = new Map();
  for (const row of database.prepare(`
    SELECT limit_key AS limitKey, source_id AS sourceId,
           limit_name AS limitName, observed_at AS observedAt
      FROM quota_label_evidence
     WHERE EXISTS (
       SELECT 1
         FROM quota_sources AS membership
         JOIN quota_observations AS observation
           ON observation.observation_id = membership.observation_id
        WHERE membership.source_id = quota_label_evidence.source_id
          AND observation.limit_key = quota_label_evidence.limit_key
     )
     ORDER BY limit_key, observed_at, source_id
  `).all()) {
    const source = sources.get(String(row.sourceId));
    const sourceEligible = source &&
      ["active", "archived"].includes(source.status) &&
      (
        includeArchived ||
        (source.status === "active" && source.location === "active")
      );
    if (!sourceEligible) continue;
    const candidate = {
      limitName: text(row.limitName, 80, "").trim(),
      observedAt: safeIso(row.observedAt, null),
      sourceId: String(row.sourceId),
    };
    if (!candidate.limitName || candidate.observedAt === null) continue;
    const limitKey = String(row.limitKey);
    const current = labels.get(limitKey);
    if (
      !current ||
      candidate.observedAt > current.observedAt ||
      (
        candidate.observedAt === current.observedAt &&
        (
          candidate.limitName > current.limitName ||
          (
            candidate.limitName === current.limitName &&
            candidate.sourceId > current.sourceId
          )
        )
      )
    ) labels.set(limitKey, candidate);
  }
  return new Map(
    [...labels].map(([limitKey, evidence]) => [limitKey, evidence.limitName]),
  );
}

function databaseQuotaRows(database, includeArchived, sources) {
  if (
    metaValue(database, QUOTA_IDENTITY_CONTRACT_KEY) !==
      QUOTA_IDENTITY_CONTRACT_VERSION
  ) return [];
  assertPersistedQuotaRows(database);
  const labels = quotaLabelsByLimitKey(database, includeArchived, sources);
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
      const normalized = normalizeQuotaObservationFields(row);
      if (!normalized) throw persistedQuotaError(row);
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
        usedPercent: normalized.usedPercent,
        windowMinutes: normalized.windowMinutes,
        resetsAt: normalized.resetsAt,
        planType: text(row.planType, 80, "unknown"),
        limitKey: text(row.limitKey, 24, "anonymous"),
        limitName: Number(row.migrated) === 1
          ? null
          : labels.get(String(row.limitKey)) || null,
        scope: row.scope === "named" ? "named" : "account",
        source: "log",
        identityKind: text(row.identityKind, 40, "exact"),
        migrated: Number(row.migrated) === 1,
        exactSeen: Number(row.exactSeen) === 1,
      };
    })
    .filter(Boolean);
}

function databaseToolRows(
  database,
  includeArchived,
  sources,
  { onRow = null } = {},
) {
  const collectRows = !(onRow instanceof Function);
  const rows = collectRows ? [] : null;
  const statement = database.prepare(`
    SELECT tool.call_key AS callKey, tool.turn_id AS turnId,
           tool.thread_id AS threadId,
           tool.original_likely AS originalLikely,
           EXISTS (
             SELECT 1 FROM usage_tool_membership AS membership
              WHERE membership.call_key = tool.call_key
           ) AS usageOwned,
           COALESCE((
             SELECT json_group_array(source.source_id ORDER BY source.source_id)
               FROM tool_sources AS source
              WHERE source.call_key = tool.call_key
           ), '[]') AS sourceIdsJson
      FROM tool_observations AS tool
     ORDER BY tool.call_key
  `);
  for (const raw of statement.iterate()) {
    const sourceIds = new Set(stringArrayFromJson(raw.sourceIdsJson));
    if (!includeArchived && !sourceAssociationAllows(
      sourceIds,
      sources,
      false,
    )) continue;
    const row = {
      callKey: String(raw.callKey),
      turnId: text(raw.turnId, 400),
      threadId: text(raw.threadId, 400),
      originalLikely: Number(raw.originalLikely) === 1,
      usageOwned: Number(raw.usageOwned) === 1,
      sourceIds,
    };
    if (onRow instanceof Function) onRow(row);
    else rows.push(row);
  }
  return rows;
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
  const sourceColumns = tableColumns(database, "source_state");
  const reconciliationPending = sourceColumns.has("reconciliation_pending")
    ? "reconciliation_pending"
    : "0";
  const quotaReconciliationPending = sourceColumns.has(
    "quota_reconciliation_pending",
  )
    ? "quota_reconciliation_pending"
    : "0";
  const firstSeenLocation = sourceColumns.has("first_seen_location")
    ? "first_seen_location"
    : "NULL";
  const states = database.prepare(`
    SELECT source_id AS sourceId, location, status,
           ${firstSeenLocation} AS firstSeenLocation,
           observed_event_count AS observedEventCount,
           change_state AS changeState, change_count AS changeCount,
           ${reconciliationPending} AS reconciliationPending,
           ${quotaReconciliationPending} AS quotaReconciliationPending
      FROM source_state
  `).all().map((row) => ({
    sourceId: String(row.sourceId),
    location: text(row.location, 20, "active"),
    firstSeenLocation: row.firstSeenLocation == null
      ? null
      : text(row.firstSeenLocation, 20, "active"),
    status: text(row.status, 20, "missing"),
    observedEventCount: nonNegativeNumber(row.observedEventCount),
    changeState: text(row.changeState, 40, "stable"),
    changeCount: nonNegativeNumber(row.changeCount),
    reconciliationPending:
      Number(row.reconciliationPending) === 1 ||
      Number(row.quotaReconciliationPending) === 1,
    quotaReconciliationPending:
      Number(row.quotaReconciliationPending) === 1,
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
      counts.changed > 0 ||
      states.some((state) => state.reconciliationPending),
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

function materializeDurableLedger(
  database,
  ledgerPath,
  includeArchived,
  { onRow = null } = {},
) {
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
  const usageResult = databaseUsageRows(
    database,
    includeArchived,
    sources,
    onRow instanceof Function
      ? { onRow: (row) => onRow({ kind: "usage", row }) }
      : {},
  );
  const usageRows = usageResult.rows || [];
  const quotaRows = databaseQuotaRows(database, includeArchived, sources);
  const toolRows = databaseToolRows(
    database,
    includeArchived,
    sources,
    onRow instanceof Function
      ? { onRow: (row) => onRow({ kind: "tool", row }) }
      : {},
  ) || [];
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
  return {
    path: ledgerPath,
    revision: Number(metaValue(database, "revision") || 0),
    quotaIdentityContract: metaValue(
      database,
      QUOTA_IDENTITY_CONTRACT_KEY,
    ),
    quotaContractUpgradeStatus: metaValue(
      database,
      "quota_contract_upgrade_status",
    ),
    quotaContractMigratedRowsDiscarded: Number(metaValue(
      database,
      "quota_contract_migrated_rows_discarded",
    ) || 0),
    quotaContractExactRowsDiscarded: Number(metaValue(
      database,
      "quota_contract_exact_rows_discarded",
    ) || 0),
    legacySnapshotStatus: metaValue(database, "legacy_snapshot_status"),
    legacyQuotaStatus: metaValue(database, "legacy_quota_status"),
    legacyQuotaRowsSkipped: Number(
      metaValue(database, "legacy_quota_rows_skipped") || 0,
    ),
    usageRows,
    quotaRows,
    toolRows,
    threadRows,
    sourceSummary: summary,
    migration,
    migratedUsageRows: usageResult.migratedUsageRows,
    migratedUsageTokens: usageResult.migratedUsageTokens,
    compactedUsageRows: usageResult.compactedUsageRows,
    migratedQuotaRows: quotaRows.filter((row) => row.migrated).length,
  };
}

export async function readDurableLedger(
  path,
  { includeArchived = true } = {},
) {
  const ledgerPath = validateAppOwnedLedgerPath(path);
  await validateLedgerMainPath(ledgerPath, { allowMissing: true });
  let readLock;
  let database;
  try {
    readLock = await acquireLedgerReadLock(ledgerPath);
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
  const ledgerPath = validateAppOwnedLedgerPath(path);
  const sourceStat = await validateLedgerMainPath(ledgerPath, {
    allowMissing: true,
  });
  if (sourceStat === null) {
    return { sources: new Map(), metadataWatermark: null };
  }
  let readLock;
  let database;
  try {
    readLock = await acquireLedgerReadLock(ledgerPath);
    database = await openLedger(ledgerPath, true);
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== DURABLE_LEDGER_SCHEMA_VERSION) {
      return { sources: new Map(), metadataWatermark: null };
    }
    const sourceColumns = new Set(
      database.prepare("PRAGMA table_info(source_state)").all()
        .map((row) => String(row.name)),
    );
    const requiredColumns = [
      "size_bytes",
      "mtime_ms",
      "ctime_ms",
      "device",
      "inode",
      "reconciliation_pending",
      "quota_reconciliation_pending",
    ];
    if (
      requiredColumns.some((column) => !sourceColumns.has(column)) ||
      metaValue(database, QUOTA_IDENTITY_CONTRACT_KEY) !==
        QUOTA_IDENTITY_CONTRACT_VERSION ||
      metaValue(database, POST_COMMIT_VALIDATION_PENDING_KEY) !== null
    ) return { sources: new Map(), metadataWatermark: null };
    const rows = database.prepare(`
      SELECT source_id AS sourceId, cursor_bytes AS cursorBytes,
             cursor_fingerprint AS cursorFingerprint,
             path_fingerprint AS pathFingerprint,
             size_bytes AS sizeBytes, mtime_ms AS mtimeMs,
             ctime_ms AS ctimeMs, device, inode,
             reconciliation_pending AS reconciliationPending,
             quota_reconciliation_pending AS quotaReconciliationPending,
             last_seen_at AS lastSeenAt
        FROM source_state
       ORDER BY CASE WHEN status IN ('active', 'archived') THEN 0 ELSE 1 END,
                last_seen_at DESC, source_id
    `).all();
    const continuity = new Map(rows.map((row) => [
      String(row.sourceId), {
        cursorBytes: Number(row.cursorBytes),
        cursorFingerprint: String(row.cursorFingerprint),
        sizeBytes: Number(row.sizeBytes),
        mtimeMs: Number(row.mtimeMs),
        ctimeMs: Number(row.ctimeMs),
        device: row.device == null ? null : Number(row.device),
        inode: row.inode == null ? null : Number(row.inode),
        reconciliationPending: Number(row.reconciliationPending) === 1,
        quotaReconciliationPending:
          Number(row.quotaReconciliationPending) === 1,
        lastSeenAt: String(row.lastSeenAt),
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
    return {
      sources: continuity,
      metadataWatermark: parseJson(metaValue(database, "metadata_watermark")),
    };
  } catch (error) {
    const sqliteErrcode = Number(error?.errcode);
    const sqliteErrstr = text(error?.errstr, 80).toUpperCase();
    if (
      [
        "ERR_DURABLE_LEDGER_SCHEMA",
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
    ) return { sources: new Map(), metadataWatermark: null };
    throw error;
  } finally {
    closeDatabase(database);
    releaseLedgerLock(readLock);
  }
}

export async function readDurableLedgerCacheState(path) {
  const ledgerPath = validateAppOwnedLedgerPath(path);
  const sourceStat = await validateLedgerMainPath(ledgerPath, {
    allowMissing: true,
  });
  if (sourceStat === null) return null;
  let readLock;
  let database;
  try {
    readLock = await acquireLedgerReadLock(ledgerPath);
    database = await openLedger(ledgerPath, true);
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== DURABLE_LEDGER_SCHEMA_VERSION) return null;
    assertPersistedQuotaRows(database);
    const revision = Number(metaValue(database, "revision"));
    if (!Number.isSafeInteger(revision)) return null;
    return {
      revision,
      quotaIdentityContract: metaValue(
        database,
        QUOTA_IDENTITY_CONTRACT_KEY,
      ),
    };
  } catch (error) {
    const sqliteErrcode = Number(error?.errcode);
    const sqliteErrstr = text(error?.errstr, 80).toUpperCase();
    if (
      [
        "ERR_DURABLE_LEDGER_SCHEMA",
        "ERR_DURABLE_LEDGER_QUOTA",
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

export async function readDurableLedgerRevision(path) {
  return (await readDurableLedgerCacheState(path))?.revision ?? null;
}

function discardRejectedDurableCommit(database) {
  try {
    database.exec("BEGIN IMMEDIATE");
    applyCommitUndoLog(database);
    database.prepare(
      "DELETE FROM ledger_meta WHERE key = ?",
    ).run(POST_COMMIT_VALIDATION_PENDING_KEY);
    database.exec("COMMIT");
  } catch {
    try {
      database.exec("ROLLBACK");
    } catch {
      // SQLite's recovery journal remains authoritative after a failed
      // compensating transaction.
    }
    // The durable pending marker keeps the rejected revision discoverable;
    // the next writer reverts it before ingesting.
  }
}

function recoverRejectedDurableCommit(database) {
  if (metaValue(database, POST_COMMIT_VALIDATION_PENDING_KEY) === null) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    applyCommitUndoLog(database);
    database.prepare(
      "DELETE FROM ledger_meta WHERE key = ?",
    ).run(POST_COMMIT_VALIDATION_PENDING_KEY);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // SQLite's recovery journal remains authoritative after a failed
      // recovery transaction.
    }
    throw error;
  }
}

function clearPendingPostCommitValidation(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM commit_undo_log").run();
    database.prepare(
      "DELETE FROM ledger_meta WHERE key = ?",
    ).run(POST_COMMIT_VALIDATION_PENDING_KEY);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // SQLite's recovery journal remains authoritative after a failed
      // marker cleanup.
    }
    throw error;
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
  quotaLabelEvidence = [],
  uncertainSourceIds = new Set(),
  quotaUncertainSourceIds = new Set(),
  eventMetadata = new Map(),
  threadRecords = [],
  nowMs = Date.now(),
  legacySnapshotPath = options.legacySnapshotPath || options.output,
  faultInjector = null,
  validateBeforeCommit = null,
  validateAfterCommit = null,
  stageBeforeCommit = null,
  onMaterializedRow = null,
} = {}) {
  const ledgerPath = resolveDurableLedgerPath({
    ...options,
    codexHome,
    output: options.output,
  });
  const privateDirectory = true;
  const enforcePrivateDirectory = true;
  const now = isoNow(nowMs);

  await validateLedgerMainPath(ledgerPath, { allowMissing: true });

  let writeLock;
  let database;
  let transactionStatements;
  let committed = false;
  let stagedCommit = null;
  let result = null;
  let primaryError = null;
  try {
    writeLock = await acquireLedgerWriteLock(
      ledgerPath,
      privateDirectory,
      enforcePrivateDirectory,
    );
    database = await openLedger(ledgerPath, false, {
      privateDirectory,
      enforcePrivateDirectory,
    });
    // A prior writer that committed and then crashed or failed before its
    // post-commit source validation confirmed the scan left its revision
    // durably marked. Revert it before anything reads ledger state — the
    // legacy-snapshot check below must see the restored one-shot migration
    // marker, and the ingest must start from the last validated revision.
    recoverRejectedDurableCommit(database);
    const legacySnapshot = await readLegacyIfNeeded(
      database,
      legacySnapshotPath,
    );
    database.exec("BEGIN IMMEDIATE");
    // StatementSync has no explicit finalizer on the supported Node 22 line.
    // Keep one transaction-local instance per SQL string so large imports do
    // not accumulate one native prepared statement per event. Ledger queries
    // use get/all/run synchronously; streaming iterators are intentionally not
    // routed through this cache because overlapping iteration cannot reuse a
    // statement safely.
    transactionStatements = createTransactionStatementCache(database);
    const dropCommitUndoCapture = validateAfterCommit instanceof Function
      ? createCommitUndoCapture(database)
      : null;
    let migration;
    try {
      bindCodexHome(transactionStatements, codexHome);
      ensureQuotaIdentityContract(transactionStatements);
      migration = migrateAndCaptureSources({
        database: transactionStatements,
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
        quotaLabelEvidence,
        uncertainSourceIds,
        quotaUncertainSourceIds,
        eventMetadata,
        threadRecords,
        legacySnapshot,
      });
      // Metadata is only needed while ingesting token rows. Drop the caller's
      // per-event map before compaction and streamed materialization so the
      // durable pass cannot overlap it with the current-spool lookup state.
      eventMetadata?.clear?.();
      compactOldObservations(transactionStatements, nowMs);
      pruneExpiredLedgerData(transactionStatements, nowMs);
      if (
        metaValue(transactionStatements, "legacy_snapshot_checked") !== "1"
      ) {
        setMeta(transactionStatements, "legacy_snapshot_checked", "1");
      }
    } finally {
      dropCommitUndoCapture?.();
    }
    const previousRevision = Number(
      metaValue(transactionStatements, "revision") || 0,
    );
    const nextRevision = Number.isSafeInteger(previousRevision)
      ? previousRevision + 1
      : 1;
    setMeta(transactionStatements, "revision", nextRevision);
    setMeta(
      transactionStatements,
      "schema_version",
      DURABLE_LEDGER_SCHEMA_VERSION,
    );
    if (validateAfterCommit instanceof Function) {
      // Committing publishes this revision before the post-commit source
      // check can confirm the scan. The pending marker commits atomically
      // with the captured undo log, so a rejection — or a crash before the
      // check completes — leaves the unvalidated revision durably marked for
      // exact reversion instead of letting it accrete.
      setMeta(transactionStatements, POST_COMMIT_VALIDATION_PENDING_KEY, now);
    }
    await invokeLedgerFault(faultInjector, "before-commit", ledgerPath);
    if (validateBeforeCommit instanceof Function) {
      await validateBeforeCommit({ path: ledgerPath });
    }
    await invokeLedgerFault(faultInjector, "after-validation", ledgerPath);
    const committedLedger = materializeDurableLedger(
      transactionStatements,
      ledgerPath,
      includeArchived,
      onMaterializedRow instanceof Function
        ? { onRow: onMaterializedRow }
        : {},
    );
    transactionStatements.release();
    transactionStatements = null;
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
    // SQLite's atomic commit is the durable-ledger linearization point. The
    // staged cache remains private until the post-commit source check passes.
    // If that check detects a race, discard the cache candidate below and
    // revert the rejected revision from its own undo log, so the collector
    // converges even when the racing change was a truncation, which never
    // reconciles memberships.
    database.exec("COMMIT");
    committed = true;
    await invokeLedgerFault(
      faultInjector,
      "after-sqlite-commit",
      ledgerPath,
    );
    if (validateAfterCommit instanceof Function) {
      try {
        await validateAfterCommit({ path: ledgerPath });
      } catch (validationError) {
        discardRejectedDurableCommit(database);
        throw validationError;
      }
      clearPendingPostCommitValidation(database);
    }
    if (stagedCommit) await stagedCommit.publish();
    maintainLedgerStorage(database);
    await invokeLedgerFault(faultInjector, "after-commit", ledgerPath);
    await restrictLedgerFiles(ledgerPath);
    result = {
      ...committedLedger,
      committed,
      migration,
    };
  } catch (error) {
    primaryError = error;
    if (!committed) {
      try {
        database?.exec("ROLLBACK");
      } catch {
        // SQLite's recovery journal remains authoritative after an interrupted
        // or failed transaction.
      }
    }
  }

  transactionStatements?.release();
  closeDatabase(database);
  primaryError = await runCleanup(primaryError, async () => {
    await restrictLedgerFiles(ledgerPath);
  });
  primaryError = await runCleanup(primaryError, async () => {
    if (stagedCommit) await stagedCommit.discard();
  });
  releaseLedgerLock(writeLock);
  primaryError = await runCleanup(primaryError, async () => {
    if (writeLock) {
      await restrictLedgerFiles(
        writeLock.path,
        "durable-ledger writer guard",
      );
    }
  });

  if (primaryError !== null) throw primaryError;
  return result;
}
