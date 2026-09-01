import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rename,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import test from "node:test";

import { loadSnapshot } from "../bin/token-ledger.mjs";
import {
  collectUsage,
  sourceLocationForPath,
} from "../lib/token-ledger-importer.mjs";
import {
  DURABLE_LEDGER_FILENAME,
  codexHomeFingerprint,
  durableQuotaObservationKey,
  normalizeQuotaObservationFields,
  readDurableLedger,
  readDurableLedgerCacheState,
  readDurableLedgerRevision,
  resolveDurableLedgerPath,
  updateDurableLedger,
} from "../lib/token-ledger-ledger.mjs";
import {
  QUOTA_IDENTITY_CONTRACT_VERSION,
} from "../lib/token-ledger-quota-contract.mjs";
import { apiUsdForUsage } from "../lib/token-ledger-rates.mjs";
import {
  readPrivateSnapshot,
  stagePrivateSnapshot,
  writePrivateSnapshot,
} from "../lib/token-ledger-snapshot.mjs";

const THREAD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROLLOUT_NAME = `rollout-${THREAD_ID}.jsonl`;
const ARCHIVED_THREAD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ARCHIVED_ROLLOUT_NAME = `rollout-${ARCHIVED_THREAD_ID}.jsonl`;
const SHARED_THREAD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TEST_LEDGER_STATE_ROOT = resolve(
  userInfo().homedir,
  ".token-ledger",
  "test-state",
  String(process.pid),
);

test.after(async () => {
  await rm(TEST_LEDGER_STATE_ROOT, { recursive: true, force: true });
});
const SHARED_ROLLOUT_NAME = `rollout-${SHARED_THREAD_ID}.jsonl`;
const BASE_TIMESTAMP = "2026-08-20T10:00:00.000Z";
const WEEKLY_RESET = Date.parse("2026-08-30T10:00:00.000Z") / 1_000;

function serialize(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function turnStart(timestamp, turnId, model = "gpt-5.4") {
  return [
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId,
        started_at: Date.parse(timestamp) / 1_000,
      },
    },
    {
      timestamp,
      type: "turn_context",
      payload: {
        turn_id: turnId,
        model,
        effort: "medium",
      },
    },
  ];
}

function tokenCount(timestamp, total, usedPercent = null) {
  const row = {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total - 10,
          cached_input_tokens: 10,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: total,
        },
        last_token_usage: {
          input_tokens: total - 10,
          cached_input_tokens: 10,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: total,
        },
        model_context_window: 128_000,
      },
    },
  };
  if (usedPercent !== null) {
    row.payload.rate_limits = {
      primary: {
        window_minutes: 10_080,
        used_percent: usedPercent,
        resets_at: WEEKLY_RESET,
        limit_id: "weekly",
        plan_type: "plus",
      },
    };
  }
  return row;
}

function rolloutRows(
  totals,
  { offset = 0, baseTimestamp = BASE_TIMESTAMP, usedPercent = null } = {},
) {
  const baseMs = Date.parse(baseTimestamp);
  return totals.flatMap((total, index) => {
    const turnIndex = offset + index;
    const timestamp = new Date(baseMs + turnIndex * 60_000).toISOString();
    return [
      ...turnStart(timestamp, `turn-${turnIndex + 1}`),
      tokenCount(
        new Date(Date.parse(timestamp) + 1_000).toISOString(),
        total,
        usedPercent,
      ),
    ];
  });
}

async function createFixture(
  totals,
  {
    usedPercent = null,
    baseTimestamp = BASE_TIMESTAMP,
  } = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-durable-"));
  const sessions = resolve(root, "sessions", "2026", "08", "20");
  const stateDirectory = dirname(resolveDurableLedgerPath({ codexHome: root }));
  const output = resolve(root, "exports", "snapshot.json.gz");
  const file = resolve(sessions, ROLLOUT_NAME);
  await mkdir(sessions, { recursive: true });
  await writeFile(
    file,
    serialize(rolloutRows(totals, { usedPercent, baseTimestamp })),
  );
  return { root, file, stateDirectory, output };
}

function options(fixture, extra = {}) {
  return {
    output: fixture.output,
    codexHome: fixture.root,
    includeArchived: true,
    since: null,
    ...extra,
  };
}

function totalTokens(snapshot) {
  return snapshot.events.reduce((sum, event) => sum + event.totalTokens, 0);
}

async function replaceRollout(fixture, totals) {
  const replacement = `${fixture.file}.replacement`;
  await writeFile(replacement, serialize(rolloutRows(totals)));
  await rename(replacement, fixture.file);
}

function crashCollection(fixture, point, { stageSnapshot = false } = {}) {
  const importerUrl = new URL(
    "../lib/token-ledger-importer.mjs",
    import.meta.url,
  ).href;
  const snapshotUrl = new URL(
    "../lib/token-ledger-snapshot.mjs",
    import.meta.url,
  ).href;
  const script = `
    import { collectUsage } from ${JSON.stringify(importerUrl)};
    import { stagePrivateSnapshot } from ${JSON.stringify(snapshotUrl)};
    const selected = JSON.parse(process.env.TOKEN_LEDGER_CRASH_OPTIONS);
    delete selected.stateDirectory;
    const faultInjector = ({ point }) => {
        if (point === process.env.TOKEN_LEDGER_CRASH_POINT) process.exit(86);
    };
    const stageSnapshot = process.env.TOKEN_LEDGER_STAGE_SNAPSHOT === "1"
      ? (candidate) => stagePrivateSnapshot(selected.output, candidate)
      : undefined;
    await collectUsage({ ...selected, faultInjector, stageSnapshot });
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: "child-process",
        TOKEN_LEDGER_TEST_STATE_NAMESPACE: String(process.pid),
        TOKEN_LEDGER_CRASH_OPTIONS: JSON.stringify(options(fixture)),
        TOKEN_LEDGER_CRASH_POINT: point,
        TOKEN_LEDGER_STAGE_SNAPSHOT: stageSnapshot ? "1" : "0",
      },
      timeout: 30_000,
    },
  );
  assert.equal(
    child.status,
    86,
    `crash child did not stop at ${point}: ${child.stderr || child.stdout}`,
  );
  return child;
}

function snapshotDestinationHash(path) {
  return createHash("sha256")
    .update(resolve(path))
    .digest("hex")
    .slice(0, 16);
}

function stableHash(value, length = 64) {
  return createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, length);
}

function installPreviewQuotaIdentities(
  ledgerPath,
  timestamp = "2026-08-20T10:00:01.000Z",
  quotaIdentityContract = null,
) {
  const database = new DatabaseSync(ledgerPath);
  try {
    const sourceId = String(database.prepare(
      "SELECT source_id AS sourceId FROM source_state LIMIT 1",
    ).get().sourceId);
    database.exec("BEGIN IMMEDIATE");
    database.prepare("DELETE FROM quota_sources").run();
    database.prepare("DELETE FROM quota_observations").run();
    const insertQuota = database.prepare(`
      INSERT INTO quota_observations (
        observation_id, observation_key, identity_kind, limit_key,
        limit_name, scope, window_minutes, resets_at, used_percent,
        plan_type, first_seen_at, last_seen_at, migrated, exact_seen
      ) VALUES (?, ?, ?, ?, ?, ?, 10080, ?, 37, 'plus', ?, ?, ?, ?)
    `);
    const insertSource = database.prepare(`
      INSERT INTO quota_sources (
        observation_id, source_id, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?)
    `);
    for (const legacy of [
      {
        rawKey: "anonymous",
        identityKind: "exact",
        limitName: null,
        migrated: 0,
        scope: "account",
        sourceOwned: true,
      },
      {
        rawKey: "Legacy label",
        identityKind: "exact",
        limitName: "Legacy label",
        migrated: 0,
        scope: "named",
        sourceOwned: true,
      },
      {
        rawKey: "migrated-anonymous",
        identityKind: "migrated_compacted",
        limitName: "Migrated label",
        migrated: 1,
        scope: "account",
        sourceOwned: false,
      },
    ]) {
      const limitKey = stableHash(legacy.rawKey, 16);
      const observationKey = JSON.stringify([
        limitKey,
        10_080,
        WEEKLY_RESET,
        37,
      ]);
      const observationId = `quota-${stableHash(observationKey)}`;
      insertQuota.run(
        observationId,
        observationKey,
        legacy.identityKind,
        limitKey,
        legacy.limitName,
        legacy.scope,
        WEEKLY_RESET,
        timestamp,
        timestamp,
        legacy.migrated,
        legacy.migrated ? 0 : 1,
      );
      if (legacy.sourceOwned) {
        insertSource.run(observationId, sourceId, timestamp, timestamp);
      }
    }
    if (quotaIdentityContract === null) {
      database.prepare(
        "DELETE FROM ledger_meta WHERE key = 'quota_identity_contract'",
      ).run();
    } else {
      database.prepare(`
        INSERT INTO ledger_meta(key, value)
        VALUES ('quota_identity_contract', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(quotaIdentityContract);
    }
    database.prepare(`
      UPDATE source_state
         SET quota_reconciliation_pending = 0
    `).run();
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the mutation error.
    }
    throw error;
  } finally {
    database.close();
  }
}

function shellCall(timestamp, callId) {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: callId,
    },
  };
}

function totalToolCalls(snapshot) {
  return snapshot.events.reduce((sum, event) => sum + event.toolCalls, 0);
}

function legacySnapshotForFixture(fixture, snapshot) {
  return {
    ...snapshot,
    provenance: {
      ...snapshot.provenance,
      collection: snapshot.provenance?.collection || {
        since: null,
        includeArchived: true,
      },
    },
    metadata: {
      ...snapshot.metadata,
      durableLedger: {
        ...snapshot.metadata?.durableLedger,
        codexHomeFingerprint: codexHomeFingerprint(fixture.root),
        quotaIdentityContract: QUOTA_IDENTITY_CONTRACT_VERSION,
      },
    },
  };
}

test("ledger statement preparation is constant across event volume", async () => {
  async function measuredCollection(eventCount) {
    const fixture = await createFixture([]);
    try {
      const baseMs = Date.parse(BASE_TIMESTAMP);
      const rows = Array.from({ length: eventCount }).flatMap((_, index) => {
        const timestamp = new Date(baseMs + index * 60_000).toISOString();
        return [
          ...turnStart(timestamp, `prepare-turn-${index + 1}`),
          tokenCount(
            new Date(Date.parse(timestamp) + 1_000).toISOString(),
            100,
            index + 1,
          ),
          shellCall(
            new Date(Date.parse(timestamp) + 2_000).toISOString(),
            `prepare-call-${index + 1}`,
          ),
        ];
      });
      await writeFile(fixture.file, serialize(rows));

      const originalPrepare = DatabaseSync.prototype.prepare;
      let prepareCount = 0;
      DatabaseSync.prototype.prepare = function (sql) {
        prepareCount += 1;
        return originalPrepare.call(this, sql);
      };
      let snapshot;
      try {
        snapshot = await collectUsage(options(fixture));
      } finally {
        DatabaseSync.prototype.prepare = originalPrepare;
      }
      const ledger = await readDurableLedger(
        resolveDurableLedgerPath({ codexHome: fixture.root }),
      );
      return { ledger, prepareCount, snapshot };
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }

  const single = await measuredCollection(1);
  const many = await measuredCollection(32);

  assert.equal(many.prepareCount, single.prepareCount);
  assert.equal(totalTokens(many.snapshot), 3_200);
  assert.equal(many.snapshot.coverage.observedModelCalls, 32);
  assert.equal(totalToolCalls(many.snapshot), 32);
  assert.equal(many.snapshot.quotaObservations.length, 32);
  assert.equal(many.ledger.usageRows.length, 32);
  assert.equal(many.ledger.toolRows.length, 32);
  assert.equal(many.ledger.quotaRows.length, 32);
  assert.equal(
    many.ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
    3_200,
  );
});

test("durable materialization can stream usage and tool rows without arrays", async () => {
  const fixture = await createFixture([100, 200]);
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  try {
    await appendFile(fixture.file, serialize([
      shellCall("2026-08-20T10:02:00.000Z", "stream-call-one"),
      shellCall("2026-08-20T10:03:00.000Z", "stream-call-two"),
    ]));
    await collectUsage(options(fixture));
    const before = await readDurableLedger(ledgerPath);
    const streamedUsage = [];
    const streamedTools = [];
    const committed = await updateDurableLedger({
      options: {},
      codexHome: fixture.root,
      inventory: { files: [], lifecycleFiles: [] },
      includeArchived: true,
      onMaterializedRow: ({ kind, row }) => {
        if (kind === "usage") {
          streamedUsage.push([
            row.observationId,
            row.identityKind,
            row.totalTokens,
          ]);
        } else if (kind === "tool") {
          streamedTools.push([
            row.callKey,
            row.usageOwned,
          ]);
        }
      },
    });

    assert.equal(committed.usageRows.length, 0);
    assert.equal(committed.toolRows.length, 0);
    assert.deepEqual(
      streamedUsage,
      before.usageRows.map((row) => [
        row.observationId,
        row.identityKind,
        row.totalTokens,
      ]),
    );
    assert.deepEqual(
      streamedTools,
      before.toolRows.map((row) => [row.callKey, row.usageOwned]),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("schema v2 source positions migrate to bounded event-key digests", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    const eventKey = String(database.prepare(`
      SELECT event_key AS eventKey
        FROM usage_observations
       WHERE identity_kind = 'exact'
       LIMIT 1
    `).get().eventKey);
    const position = database.prepare(`
      SELECT source_id AS sourceId, event_ordinal AS eventOrdinal
        FROM source_event_positions
       LIMIT 1
    `).get();
    assert.ok(position?.sourceId);
    database.prepare(`
      UPDATE source_event_positions
         SET event_key = ?
    `).run(eventKey);
    const insertPosition = database.prepare(`
      INSERT INTO source_event_positions (
        source_id, event_ordinal, observation_id, event_key,
        first_seen_at, last_seen_at
      )
      SELECT source_id, ?, observation_id, ?, first_seen_at, last_seen_at
        FROM source_event_positions
       WHERE source_id = ? AND event_ordinal = ?
    `);
    for (let index = 1; index <= 1_024; index += 1) {
      insertPosition.run(
        Number(position.eventOrdinal) + index,
        `${eventKey}:${index}`,
        position.sourceId,
        position.eventOrdinal,
      );
    }
    database.exec("PRAGMA user_version = 2");
    database.close();
    database = null;

    const originalAll = StatementSync.prototype.all;
    const migrationBatchSizes = [];
    StatementSync.prototype.all = function (...args) {
      const rows = originalAll.apply(this, args);
      if (
        this.sourceSQL.includes("FROM source_event_positions") &&
        this.sourceSQL.includes("event_ordinal AS eventOrdinal") &&
        this.sourceSQL.includes("LIMIT ?")
      ) {
        migrationBatchSizes.push(rows.length);
      }
      return rows;
    };
    let snapshot;
    try {
      snapshot = await collectUsage(options(fixture));
    } finally {
      StatementSync.prototype.all = originalAll;
    }
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const migratedPosition = database.prepare(`
      SELECT event_key AS eventKey
        FROM source_event_positions
       WHERE source_id = ? AND event_ordinal = ?
    `).get(position.sourceId, position.eventOrdinal);
    assert.equal(snapshot.events.reduce((sum, row) => sum + row.totalTokens, 0), 100);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 3);
    assert.equal(migratedPosition.eventKey, stableHash(eventKey));
    assert.match(migratedPosition.eventKey, /^[0-9a-f]{64}$/);
    assert.deepEqual(migrationBatchSizes, [512, 512, 1]);
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("new durable ledgers use incremental vacuum and reclaim a large freelist", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    assert.equal(database.prepare("PRAGMA auto_vacuum").get().auto_vacuum, 2);
    database.exec("CREATE TABLE vacuum_canary (payload BLOB)");
    database.prepare("INSERT INTO vacuum_canary(payload) VALUES (?)").run(
      Buffer.alloc(8 * 1024 * 1024, 7),
    );
    database.exec("DROP TABLE vacuum_canary");
    const freeBefore = Number(
      database.prepare("PRAGMA freelist_count").get().freelist_count,
    );
    assert.ok(freeBefore >= 512);
    database.close();
    database = null;

    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const freeAfter = Number(
      database.prepare("PRAGMA freelist_count").get().freelist_count,
    );
    assert.ok(freeAfter < freeBefore);
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("quota normalization accepts only exact provider percentage fields", () => {
  const valid = [
    { windowMinutes: 1, resetsAt: 1, usedPercent: 0 },
    { windowMinutes: 10_080, resetsAt: WEEKLY_RESET, usedPercent: 100 },
  ];
  for (const row of valid) {
    assert.deepEqual(normalizeQuotaObservationFields(row), row);
    assert.notEqual(
      durableQuotaObservationKey({ limitKey: "weekly", ...row }),
      null,
    );
  }

  const invalid = [
    {},
    { windowMinutes: 10_080, resetsAt: WEEKLY_RESET },
    { windowMinutes: 10_080, resetsAt: WEEKLY_RESET, usedPercent: null },
    { windowMinutes: 10_080, resetsAt: WEEKLY_RESET, usedPercent: "0" },
    { windowMinutes: 10_080, resetsAt: WEEKLY_RESET, usedPercent: -1 },
    { windowMinutes: 10_080, resetsAt: WEEKLY_RESET, usedPercent: 100.01 },
    { windowMinutes: 10_080, resetsAt: WEEKLY_RESET, usedPercent: NaN },
    { windowMinutes: 10_080, resetsAt: WEEKLY_RESET, usedPercent: Infinity },
    { windowMinutes: 0, resetsAt: WEEKLY_RESET, usedPercent: 10 },
    { windowMinutes: 1.5, resetsAt: WEEKLY_RESET, usedPercent: 10 },
    { windowMinutes: "10080", resetsAt: WEEKLY_RESET, usedPercent: 10 },
    { windowMinutes: 10_080, resetsAt: 0, usedPercent: 10 },
    { windowMinutes: 10_080, resetsAt: "1", usedPercent: 10 },
    { windowMinutes: 10_080, resetsAt: 1.5, usedPercent: 10 },
    { windowMinutes: 10_080, resetsAt: Number.MAX_VALUE, usedPercent: 10 },
    {
      windowMinutes: 10_080,
      resetsAt: Number.MAX_SAFE_INTEGER,
      usedPercent: 10,
    },
    { windowMinutes: 10_080, resetsAt: Infinity, usedPercent: 10 },
  ];
  for (const row of invalid) {
    assert.equal(normalizeQuotaObservationFields(row), null);
    assert.equal(
      durableQuotaObservationKey({ limitKey: "weekly", ...row }),
      null,
    );
  }
});

test("durable writes reject quota key and scope mismatches", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-quota-scope-"));
  const ledgerPath = resolveDurableLedgerPath({ codexHome: root });
  const base = {
    options: {},
    codexHome: root,
    inventory: { files: [], lifecycleFiles: [] },
  };
  try {
    await updateDurableLedger(base);
    const validFields = {
      timestamp: BASE_TIMESTAMP,
      lastSeenAt: BASE_TIMESTAMP,
      usedPercent: 37,
      windowMinutes: 10_080,
      resetsAt: WEEKLY_RESET,
      planType: "plus",
      limitKey: stableHash("codex", 16),
      scope: "account",
    };
    for (const invalid of [
      { ...validFields, limitKey: undefined },
      { ...validFields, limitKey: null },
      { ...validFields, limitKey: "" },
      { ...validFields, limitKey: "not-a-provider-hash" },
      { ...validFields, scope: "named" },
      {
        ...validFields,
        limitKey: stableHash("codex-secondary", 16),
        scope: "account",
      },
      { ...validFields, scope: null },
    ]) {
      await assert.rejects(
        () => updateDurableLedger({ ...base, quotas: [invalid] }),
        (error) => error?.code === "ERR_DURABLE_LEDGER_QUOTA",
      );
      assert.equal(await readDurableLedgerRevision(ledgerPath), 1);
    }
    assert.equal((await readDurableLedger(ledgerPath)).quotaRows.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted quota key and scope mismatches fail closed without mutation", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.prepare(
      "UPDATE quota_observations SET scope = 'named'",
    ).run();
    database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    database.close();
    database = null;
    const before = await readFile(ledgerPath);

    await assert.rejects(
      () => readDurableLedger(ledgerPath),
      (error) => error?.code === "ERR_DURABLE_LEDGER_QUOTA",
    );
    assert.deepEqual(await readFile(ledgerPath), before);
    assert.equal(await readDurableLedgerRevision(ledgerPath), null);
    assert.deepEqual(await readFile(ledgerPath), before);
    await assert.rejects(
      () => collectUsage(options(fixture)),
      (error) => error?.code === "ERR_DURABLE_LEDGER_QUOTA",
    );
    assert.deepEqual(await readFile(ledgerPath), before);

    database = new DatabaseSync(ledgerPath);
    database.prepare(
      "UPDATE quota_observations SET scope = 'account'",
    ).run();
    database.close();
    database = null;
    const recovered = await collectUsage(options(fixture));
    assert.deepEqual(
      recovered.quotaObservations.map((quota) => quota.usedPercent),
      [37],
    );
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("malformed quota rows make cache state unavailable without losing the cache", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    const snapshot = await collectUsage(options(fixture));
    await writePrivateSnapshot(fixture.output, snapshot);
    database = new DatabaseSync(ledgerPath);
    database.prepare(
      "UPDATE quota_observations SET scope = 'named'",
    ).run();
    database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    database.close();
    database = null;

    assert.equal(await readDurableLedgerCacheState(ledgerPath), null);
    const loaded = await loadSnapshot({
      input: fixture.output,
      codexHome: fixture.root,
      includeArchived: true,
      since: null,
      refresh: false,
      inputExplicit: false,
      autoRefresh: false,
    });
    assert.equal(loaded.sourceStatus, "unchecked-cache");
    assert.equal(totalTokens(loaded.snapshot), 100);
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("non-v2 durable reads preserve usage but suppress opaque quota", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await collectUsage(options(fixture));
    for (const [name, contract] of [
      ["markerless", null],
      ["v1", "codex-limit-id-v1"],
      ["future", "codex-limit-id-v3"],
    ]) {
      database = new DatabaseSync(ledgerPath);
      if (contract === null) {
        database.prepare(
          "DELETE FROM ledger_meta WHERE key = 'quota_identity_contract'",
        ).run();
      } else {
        database.prepare(`
          INSERT INTO ledger_meta(key, value)
          VALUES ('quota_identity_contract', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(contract);
      }
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      database.close();
      database = null;
      const before = await readFile(ledgerPath);

      const ledger = await readDurableLedger(ledgerPath);
      assert.equal(
        ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
        100,
        name,
      );
      assert.equal(ledger.quotaIdentityContract, contract, name);
      assert.deepEqual(ledger.quotaRows, [], name);
      assert.deepEqual(await readFile(ledgerPath), before, name);
    }
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("persisted invalid quota fields fail closed before ledger upgrade", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.exec(
      "ALTER TABLE source_state DROP COLUMN quota_reconciliation_pending",
    );
    database.prepare(
      "UPDATE quota_observations SET used_percent = 150",
    ).run();
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.close();
    database = null;
    const before = await readFile(ledgerPath);

    await assert.rejects(
      () => readDurableLedger(ledgerPath),
      (error) => error?.code === "ERR_DURABLE_LEDGER_QUOTA",
    );
    assert.deepEqual(await readFile(ledgerPath), before);
    await assert.rejects(
      () => collectUsage(options(fixture)),
      (error) => error?.code === "ERR_DURABLE_LEDGER_QUOTA",
    );
    assert.deepEqual(await readFile(ledgerPath), before);

    database = new DatabaseSync(ledgerPath);
    assert.equal(
      database.prepare("PRAGMA table_info(source_state)").all().some(
        (column) => column.name === "quota_reconciliation_pending",
      ),
      false,
    );
    database.prepare(
      "UPDATE quota_observations SET used_percent = 37",
    ).run();
    database.close();
    database = null;

    const recovered = await collectUsage(options(fixture));
    assert.deepEqual(
      recovered.quotaObservations.map((quota) => quota.usedPercent),
      [37],
    );
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(
      database.prepare("PRAGMA table_info(source_state)").all().some(
        (column) => column.name === "quota_reconciliation_pending",
      ),
      true,
    );
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("usage and quota survive rollout source disappearance", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  try {
    const first = await collectUsage(options(fixture));
    assert.equal(first.coverage.observedTokens, 100);
    assert.equal(first.quotaObservations.length, 1);

    await rm(fixture.file);
    const second = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(second.coverage.observedTokens, 100);
    assert.equal(second.quotaObservations.length, 1);
    assert.equal(second.coverage.sourceIncomplete, true);
    assert.equal(second.coverage.sourceStates.tombstoned, 1);
    assert.equal(activeOnly.coverage.observedTokens, 100);
    assert.equal(activeOnly.quotaObservations.length, 1);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.sourceSummary.states[0].status, "tombstoned");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("invalid quota replacements retain last-known quota until a clean rescan", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    const first = await collectUsage(options(fixture));
    assert.deepEqual(
      first.quotaObservations.map((quota) => quota.usedPercent),
      [37],
    );

    await writeFile(
      replacement,
      serialize(rolloutRows([200], { usedPercent: -25 })),
    );
    await rename(replacement, fixture.file);
    const invalid = await collectUsage(options(fixture));
    const invalidReload = await collectUsage(options(fixture));
    let ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(invalid), 200);
    assert.equal(invalid.coverage.invalidQuotaRecords, 1);
    assert.deepEqual(
      invalid.quotaObservations.map((quota) => quota.usedPercent),
      [37],
    );
    assert.deepEqual(
      invalidReload.quotaObservations.map((quota) => quota.usedPercent),
      [37],
    );
    assert.equal(
      ledger.sourceSummary.states[0].quotaReconciliationPending,
      true,
    );
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);

    await writeFile(
      replacement,
      serialize(rolloutRows([300], { usedPercent: 58 })),
    );
    await rename(replacement, fixture.file);
    const recovered = await collectUsage(options(fixture));
    const recoveredReload = await collectUsage(options(fixture));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(recovered), 300);
    assert.equal(recovered.coverage.invalidQuotaRecords, 0);
    assert.deepEqual(
      recovered.quotaObservations.map((quota) => quota.usedPercent),
      [58],
    );
    assert.deepEqual(
      recoveredReload.quotaObservations.map((quota) => quota.usedPercent),
      [58],
    );
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.quotaRows[0].usedPercent, 58);
    assert.equal(
      ledger.sourceSummary.states[0].quotaReconciliationPending,
      false,
    );
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing primary is a clean optional-bucket replacement", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    const first = await collectUsage(options(fixture));
    assert.deepEqual(
      first.quotaObservations.map((quota) => quota.usedPercent),
      [37],
    );

    const secondaryOnly = rolloutRows([200], { usedPercent: 58 });
    const rateLimits = secondaryOnly.at(-1).payload.rate_limits;
    rateLimits.secondary = rateLimits.primary;
    delete rateLimits.primary;
    await writeFile(replacement, serialize(secondaryOnly));
    await rename(replacement, fixture.file);

    const replaced = await collectUsage(options(fixture));
    const reloaded = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    for (const snapshot of [replaced, reloaded]) {
      assert.equal(snapshot.coverage.invalidQuotaRecords, 0);
      assert.deepEqual(
        snapshot.quotaObservations.map((quota) => quota.usedPercent),
        [58],
      );
    }
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.quotaRows[0].usedPercent, 58);
    assert.equal(
      ledger.sourceSummary.states[0].quotaReconciliationPending,
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("sparse quota labels survive changed readings and reloads", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const replacement = resolve(fixture.root, "replacement.jsonl");
  const withIdentity = (total, usedPercent, identity) => {
    const rows = rolloutRows([total], { usedPercent });
    Object.assign(rows.at(-1).payload.rate_limits, identity);
    return rows;
  };
  try {
    await writeFile(
      fixture.file,
      serialize(withIdentity(100, 37, {
        limit_id: "codex-secondary",
        limit_name: "Luna",
        plan_type: "plus",
      })),
    );
    const first = await collectUsage(options(fixture));
    assert.equal(first.quotaObservations.length, 1);
    assert.equal(first.quotaObservations[0].scope, "named");
    assert.equal(first.quotaObservations[0].limitName, "Luna");
    const limitKey = first.quotaObservations[0].limitKey;

    await writeFile(
      replacement,
      serialize(withIdentity(200, 58, {
        limit_id: "CODEX_SECONDARY",
        limit_name: null,
        plan_type: null,
      })),
    );
    await rename(replacement, fixture.file);
    const changed = await collectUsage(options(fixture));
    const reloaded = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    for (const snapshot of [changed, reloaded]) {
      assert.equal(snapshot.quotaObservations.length, 1);
      assert.equal(snapshot.quotaObservations[0].usedPercent, 58);
      assert.equal(snapshot.quotaObservations[0].limitKey, limitKey);
      assert.equal(snapshot.quotaObservations[0].limitName, "Luna");
      assert.equal(snapshot.quotaObservations[0].scope, "named");
    }
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.quotaRows[0].limitName, "Luna");
    assert.equal(ledger.quotaRows[0].scope, "named");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("quota labels materialize only from scope-eligible source evidence", async () => {
  const fixture = await createFixture([]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  const labeledRows = (total, usedPercent, label, baseTimestamp) => {
    const rows = rolloutRows([total], { usedPercent, baseTimestamp });
    Object.assign(rows.at(-1).payload.rate_limits, {
      limit_id: "codex-secondary",
      limit_name: label,
      plan_type: "plus",
    });
    return rows;
  };
  const readings = (snapshot) => snapshot.quotaObservations
    .map((quota) => [quota.usedPercent, quota.limitName])
    .sort((left, right) => left[0] - right[0]);
  try {
    await writeFile(
      fixture.file,
      serialize(labeledRows(100, 37, "Active", BASE_TIMESTAMP)),
    );
    await mkdir(archivedDirectory, { recursive: true });
    const archivedBytes = serialize(labeledRows(
      200,
      58,
      "Archived",
      "2026-08-20T11:00:00.000Z",
    ));
    await writeFile(archivedFile, archivedBytes);

    const full = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const fullReload = await collectUsage(options(fixture));
    assert.deepEqual(readings(full), [[37, "Archived"], [58, "Archived"]]);
    assert.deepEqual(readings(activeOnly), [[37, "Active"]]);
    assert.deepEqual(
      readings(fullReload),
      [[37, "Archived"], [58, "Archived"]],
    );

    await rm(archivedFile);
    const tombstoned = await collectUsage(options(fixture));
    assert.deepEqual(readings(tombstoned), [[37, "Active"], [58, "Active"]]);

    await writeFile(archivedFile, archivedBytes);
    const restored = await collectUsage(options(fixture));
    const restoredReload = await collectUsage(options(fixture));
    assert.deepEqual(
      readings(restored),
      [[37, "Archived"], [58, "Archived"]],
    );
    assert.deepEqual(
      readings(restoredReload),
      [[37, "Archived"], [58, "Archived"]],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("quota label recency uses explicit observations and binary ties", async () => {
  const fixture = await createFixture([]);
  const sourceB = resolve(dirname(fixture.file), SHARED_ROLLOUT_NAME);
  const withIdentity = (rows, labels) => {
    const quotaRows = rows.filter((row) => row.payload?.type === "token_count");
    for (const [index, row] of quotaRows.entries()) {
      Object.assign(row.payload.rate_limits, {
        limit_id: "codex-secondary",
        limit_name: labels[index] ?? null,
        plan_type: "plus",
      });
    }
    return rows;
  };
  try {
    const oldThenNull = withIdentity(
      rolloutRows([100, 200], { usedPercent: 20 }),
      ["Old", null],
    );
    const newer = withIdentity(
      rolloutRows([300], {
        usedPercent: 40,
        baseTimestamp: "2026-08-20T10:00:30.000Z",
      }),
      ["New"],
    );
    await writeFile(fixture.file, serialize(oldThenNull));
    await writeFile(sourceB, serialize(newer));
    const observed = await collectUsage(options(fixture));
    const reloaded = await collectUsage(options(fixture));
    for (const snapshot of [observed, reloaded]) {
      assert.deepEqual(
        [...new Set(snapshot.quotaObservations.map(
          (quota) => quota.limitName,
        ))],
        ["New"],
      );
    }

    await rm(fixture.stateDirectory, { recursive: true, force: true });
    await rm(fixture.output, { force: true });
    const equalTimestampA = withIdentity(
      rolloutRows([100], { usedPercent: 20 }),
      ["z"],
    );
    const equalTimestampB = withIdentity(
      rolloutRows([300], { usedPercent: 40 }),
      ["ä"],
    );
    await writeFile(fixture.file, serialize(equalTimestampA));
    await writeFile(sourceB, serialize(equalTimestampB));
    const tied = await collectUsage(options(fixture));
    const tiedReload = await collectUsage(options(fixture));
    for (const snapshot of [tied, tiedReload]) {
      assert.deepEqual(
        [...new Set(snapshot.quotaObservations.map(
          (quota) => quota.limitName,
        ))],
        ["ä"],
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("malformed quota identity retains durable quota until a clean rescan", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    const first = await collectUsage(options(fixture));
    assert.deepEqual(
      first.quotaObservations.map((quota) => quota.usedPercent),
      [37],
    );

    const invalidRows = rolloutRows([200], { usedPercent: 58 });
    invalidRows.at(-1).payload.rate_limits.limit_id = { malformed: true };
    await writeFile(replacement, serialize(invalidRows));
    await rename(replacement, fixture.file);
    const invalid = await collectUsage(options(fixture));
    const invalidReload = await collectUsage(options(fixture));
    let ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(invalid), 200);
    assert.equal(invalid.coverage.invalidQuotaRecords, 1);
    assert.equal(invalidReload.coverage.invalidQuotaRecords, 1);
    assert.deepEqual(
      invalid.quotaObservations.map((quota) => quota.usedPercent),
      [37],
    );
    assert.equal(
      ledger.sourceSummary.states[0].quotaReconciliationPending,
      true,
    );

    const cleanRows = rolloutRows([300], { usedPercent: 58 });
    cleanRows.at(-1).payload.rate_limits.limit_id = " CODEX ";
    await writeFile(replacement, serialize(cleanRows));
    await rename(replacement, fixture.file);
    const recovered = await collectUsage(options(fixture));
    const recoveredReload = await collectUsage(options(fixture));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(recovered), 300);
    assert.equal(recovered.coverage.invalidQuotaRecords, 0);
    assert.deepEqual(
      recovered.quotaObservations.map((quota) => quota.usedPercent),
      [58],
    );
    assert.deepEqual(
      recoveredReload.quotaObservations.map((quota) => quota.usedPercent),
      [58],
    );
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(
      ledger.sourceSummary.states[0].quotaReconciliationPending,
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("malformed quota siblings cannot relabel trusted history", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const replacement = resolve(fixture.root, "replacement.jsonl");
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  const rowsWithIdentity = (total, usedPercent, limitName) => {
    const rows = rolloutRows([total], { usedPercent });
    Object.assign(rows.at(-1).payload.rate_limits, {
      limit_id: "codex-secondary",
      limit_name: limitName,
      plan_type: "plus",
    });
    return rows;
  };
  try {
    await writeFile(
      fixture.file,
      serialize(rowsWithIdentity(100, 37, "Trusted")),
    );
    const first = await collectUsage(options(fixture));
    assert.deepEqual(
      first.quotaObservations.map((quota) => [
        quota.usedPercent,
        quota.limitName,
      ]),
      [[37, "Trusted"]],
    );

    const partial = rowsWithIdentity(200, 58, "Injected");
    partial.at(-1).payload.rate_limits.secondary = {
      window_minutes: 300,
      used_percent: -1,
      resets_at: WEEKLY_RESET,
    };
    await writeFile(replacement, serialize(partial));
    await rename(replacement, fixture.file);
    const uncertain = await collectUsage(options(fixture));
    const uncertainReload = await collectUsage(options(fixture));

    for (const snapshot of [uncertain, uncertainReload]) {
      assert.equal(snapshot.coverage.invalidQuotaRecords, 1);
      assert.deepEqual(
        snapshot.quotaObservations.map((quota) => [
          quota.usedPercent,
          quota.limitName,
        ]).sort((left, right) => left[0] - right[0]),
        [[37, "Trusted"], [58, "Trusted"]],
      );
    }
    let ledger = await readDurableLedger(ledgerPath);
    assert.equal(
      ledger.sourceSummary.states[0].quotaReconciliationPending,
      true,
    );

    await writeFile(
      replacement,
      serialize(rowsWithIdentity(300, 70, "Recovered")),
    );
    await rename(replacement, fixture.file);
    await assert.rejects(
      () => collectUsage(options(fixture, {
        faultInjector: ({ point }) => {
          if (point === "before-commit") throw new Error("label rollback");
        },
      })),
      /label rollback/,
    );
    ledger = await readDurableLedger(ledgerPath);
    assert.deepEqual(
      ledger.quotaRows
        .map((quota) => [quota.usedPercent, quota.limitName])
        .sort((left, right) => left[0] - right[0]),
      [[37, "Trusted"], [58, "Trusted"]],
    );
    assert.equal(
      ledger.sourceSummary.states[0].quotaReconciliationPending,
      true,
    );

    const recovered = await collectUsage(options(fixture));
    const recoveredReload = await collectUsage(options(fixture));
    for (const snapshot of [recovered, recoveredReload]) {
      assert.equal(snapshot.coverage.invalidQuotaRecords, 0);
      assert.deepEqual(
        snapshot.quotaObservations.map((quota) => [
          quota.usedPercent,
          quota.limitName,
        ]),
        [[70, "Recovered"]],
      );
    }
    ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.quotaRows[0].limitName, "Recovered");
    assert.equal(
      ledger.sourceSummary.states[0].quotaReconciliationPending,
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("preview quota identities converge without rekeying opaque hashes", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  try {
    const rows = rolloutRows([100], { usedPercent: 37 });
    rows.at(-1).payload.rate_limits.limit_name = "Legacy label";
    await writeFile(fixture.file, serialize(rows));
    await collectUsage(options(fixture));
    installPreviewQuotaIdentities(ledgerPath);

    const converged = await collectUsage(options(fixture));
    const reloaded = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(ledgerPath);
    const inspection = new DatabaseSync(ledgerPath, { readOnly: true });
    let marker;
    try {
      marker = inspection.prepare(
        "SELECT value FROM ledger_meta WHERE key = 'quota_identity_contract'",
      ).get()?.value;
    } finally {
      inspection.close();
    }

    for (const snapshot of [converged, reloaded]) {
      assert.equal(snapshot.quotaObservations.length, 1);
      assert.equal(snapshot.quotaObservations[0].limitKey, stableHash("codex", 16));
      assert.equal(snapshot.quotaObservations[0].limitName, "Legacy label");
      assert.equal(snapshot.quotaObservations[0].scope, "account");
    }
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(
      ledger.sourceSummary.states[0].quotaReconciliationPending,
      false,
    );
    assert.equal(marker, QUOTA_IDENTITY_CONTRACT_VERSION);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("malformed pre-contract quota cannot block a safe v2 upgrade", async () => {
  for (const [name, contract, corruptMigrationFlag] of [
    ["markerless", null, false],
    ["v1", "codex-limit-id-v1", true],
  ]) {
    const fixture = await createFixture([100], { usedPercent: 37 });
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    let database;
    try {
      await collectUsage(options(fixture));
      installPreviewQuotaIdentities(
        ledgerPath,
        "2026-08-20T10:00:01.000Z",
        contract,
      );
      database = new DatabaseSync(ledgerPath);
      database.prepare(
        "UPDATE quota_observations SET used_percent = 150",
      ).run();
      if (corruptMigrationFlag) {
        database.prepare(
          "UPDATE quota_observations SET migrated = 2 WHERE migrated = 1",
        ).run();
      }
      database.close();
      database = null;

      const upgraded = await collectUsage(options(fixture));
      const ledger = await readDurableLedger(ledgerPath);
      assert.equal(totalTokens(upgraded), 100, name);
      assert.deepEqual(
        upgraded.quotaObservations.map((quota) => quota.usedPercent),
        [37],
        name,
      );
      assert.equal(
        ledger.quotaIdentityContract,
        QUOTA_IDENTITY_CONTRACT_VERSION,
        name,
      );
      assert.equal(
        ledger.quotaContractExactRowsDiscarded,
        corruptMigrationFlag ? 3 : 2,
        name,
      );
      assert.equal(
        ledger.quotaContractMigratedRowsDiscarded,
        corruptMigrationFlag ? 0 : 1,
        name,
      );
    } finally {
      database?.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("quota identity upgrade rolls back and remains pending after malformed scans", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  const replacement = resolve(fixture.root, "replacement.jsonl");
  const contractState = () => {
    const database = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      return {
        marker: database.prepare(
          "SELECT value FROM ledger_meta WHERE key = 'quota_identity_contract'",
        ).get()?.value ?? null,
        pending: Number(database.prepare(`
          SELECT quota_reconciliation_pending AS pending
            FROM source_state
           LIMIT 1
        `).get()?.pending || 0),
        quotaRows: Number(database.prepare(
          "SELECT COUNT(*) AS count FROM quota_observations",
        ).get()?.count || 0),
      };
    } finally {
      database.close();
    }
  };
  try {
    const firstRows = rolloutRows([100], { usedPercent: 37 });
    firstRows.at(-1).payload.rate_limits.limit_name = "Legacy label";
    await writeFile(fixture.file, serialize(firstRows));
    await collectUsage(options(fixture));
    installPreviewQuotaIdentities(
      ledgerPath,
      "2026-08-20T10:00:01.000Z",
      "codex-limit-id-v1",
    );

    await assert.rejects(
      updateDurableLedger({
        options: options(fixture),
        codexHome: fixture.root,
        inventory: { files: [], lifecycleFiles: [] },
        validateAfterCommit: async () => {
          throw new Error("reject quota contract upgrade");
        },
      }),
      /reject quota contract upgrade/,
    );
    assert.deepEqual(contractState(), {
      marker: "codex-limit-id-v1",
      pending: 0,
      quotaRows: 3,
    });

    const malformedRows = rolloutRows([200], { usedPercent: 58 });
    Object.assign(malformedRows.at(-1).payload.rate_limits, {
      limit_id: { malformed: true },
      limit_name: "Legacy label",
    });
    await writeFile(replacement, serialize(malformedRows));
    await rename(replacement, fixture.file);

    await assert.rejects(
      collectUsage(options(fixture, {
        faultInjector: ({ point }) => {
          if (point === "before-commit") throw new Error("marker rollback");
        },
      })),
      /marker rollback/,
    );
    assert.deepEqual(contractState(), {
      marker: "codex-limit-id-v1",
      pending: 0,
      quotaRows: 3,
    });

    const malformed = await collectUsage(options(fixture));
    const malformedReload = await collectUsage(options(fixture));
    assert.equal(totalTokens(malformed), 200);
    assert.equal(malformed.coverage.invalidQuotaRecords, 1);
    assert.equal(malformedReload.coverage.invalidQuotaRecords, 1);
    assert.deepEqual(
      malformed.quotaObservations.map((quota) => quota.usedPercent),
      [],
    );
    assert.deepEqual(contractState(), {
      marker: QUOTA_IDENTITY_CONTRACT_VERSION,
      pending: 1,
      quotaRows: 0,
    });
    const upgradedLedger = await readDurableLedger(ledgerPath);
    assert.equal(upgradedLedger.quotaContractExactRowsDiscarded, 2);
    assert.equal(upgradedLedger.quotaContractMigratedRowsDiscarded, 1);

    const cleanRows = rolloutRows([300], { usedPercent: 58 });
    Object.assign(cleanRows.at(-1).payload.rate_limits, {
      limit_id: "   ",
      limit_name: "Legacy label",
    });
    await writeFile(replacement, serialize(cleanRows));
    await rename(replacement, fixture.file);
    const recovered = await collectUsage(options(fixture));
    const recoveredReload = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(ledgerPath);

    for (const snapshot of [recovered, recoveredReload]) {
      assert.equal(totalTokens(snapshot), 300);
      assert.equal(snapshot.coverage.invalidQuotaRecords, 0);
      assert.equal(snapshot.quotaObservations.length, 1);
      assert.equal(snapshot.quotaObservations[0].limitKey, stableHash("codex", 16));
      assert.equal(snapshot.quotaObservations[0].limitName, "Legacy label");
      assert.equal(snapshot.quotaObservations[0].scope, "account");
    }
    assert.equal(ledger.quotaRows.length, 1);
    assert.deepEqual(contractState(), {
      marker: QUOTA_IDENTITY_CONTRACT_VERSION,
      pending: 0,
      quotaRows: 1,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("first active-only refresh excludes a rollout moved into the archive", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  try {
    await appendFile(fixture.file, serialize([{
      timestamp: "2026-08-20T10:01:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        call_id: "call-before-archive",
      },
    }]));
    const initial = await collectUsage(options(fixture));
    assert.equal(initial.coverage.observedTokens, 100);
    assert.equal(initial.quotaObservations.length, 1);
    assert.equal(initial.events[0].toolCalls, 1);

    await mkdir(archivedDirectory, { recursive: true });
    await copyFile(fixture.file, archivedFile);
    await rm(fixture.file);
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
      { includeArchived: false },
    );

    assert.equal(totalTokens(activeOnly), 0);
    assert.equal(activeOnly.quotaObservations.length, 0);
    assert.equal(activeOnly.events.length, 0);
    assert.equal(ledger.usageRows.length, 0);
    assert.equal(ledger.quotaRows.length, 0);
    assert.equal(ledger.toolRows.length, 0);
    assert.equal(ledger.sourceSummary.states.length, 1);
    assert.equal(ledger.sourceSummary.states[0].location, "archived");
    assert.equal(ledger.sourceSummary.states[0].status, "archived");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only refresh preserves an atomically replaced archive source", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "21",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "archived-replacement.jsonl");
  try {
    await appendFile(fixture.file, serialize([
      shellCall("2026-08-20T10:01:00.000Z", "call-active-retained"),
    ]));
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      serialize([
        ...rolloutRows([200], {
          baseTimestamp: "2026-08-21T10:00:00.000Z",
          usedPercent: 58,
        }),
        shellCall("2026-08-21T10:01:00.000Z", "call-archive-retained"),
      ]),
    );

    const initial = await collectUsage(options(fixture));
    await copyFile(archivedFile, replacement);
    await rename(replacement, archivedFile);

    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const retainedAfterActiveOnly = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    await rm(archivedFile);
    const afterArchivedDeletion = await collectUsage(options(fixture));
    const activeOnlyAfterDeletion = await collectUsage(options(fixture, {
      includeArchived: false,
    }));

    assert.equal(totalTokens(initial), 300);
    assert.equal(initial.quotaObservations.length, 2);
    assert.equal(totalToolCalls(initial), 2);
    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(activeOnly.quotaObservations.length, 1);
    assert.equal(totalToolCalls(activeOnly), 1);
    assert.equal(
      retainedAfterActiveOnly.usageRows.reduce(
        (sum, row) => sum + row.totalTokens,
        0,
      ),
      300,
    );
    assert.equal(retainedAfterActiveOnly.quotaRows.length, 2);
    assert.equal(retainedAfterActiveOnly.toolRows.length, 2);
    assert.equal(totalTokens(afterArchivedDeletion), 300);
    assert.equal(afterArchivedDeletion.quotaObservations.length, 2);
    assert.equal(totalToolCalls(afterArchivedDeletion), 2);
    assert.equal(totalTokens(activeOnlyAfterDeletion), 100);
    assert.equal(activeOnlyAfterDeletion.quotaObservations.length, 1);
    assert.equal(totalToolCalls(activeOnlyAfterDeletion), 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("full refresh reconciles an archive replaced during active-only tracking", async () => {
  const fixture = await createFixture([]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "smaller-archive.jsonl");
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(archivedFile, serialize([
      ...rolloutRows([100, 150], { usedPercent: 37 }),
      shellCall("2026-08-20T10:02:00.000Z", "call-old-archive-one"),
      shellCall("2026-08-20T10:03:00.000Z", "call-old-archive-two"),
    ]));
    await rm(fixture.file);
    const initial = await collectUsage(options(fixture));

    await writeFile(replacement, serialize([
      ...rolloutRows([200], { usedPercent: 58 }),
      shellCall("2026-08-20T10:01:00.000Z", "call-new-archive"),
    ]));
    assert.equal(
      (await stat(replacement)).size < (await stat(archivedFile)).size,
      true,
    );
    await rename(replacement, archivedFile);

    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const retainedBeforeRescan = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const rescanned = await collectUsage(options(fixture));
    const reconciled = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    await rm(archivedFile);
    const afterDeletion = await collectUsage(options(fixture));

    assert.equal(totalTokens(initial), 250);
    assert.equal(initial.quotaObservations[0].usedPercent, 37);
    assert.equal(totalToolCalls(initial), 2);
    assert.equal(totalTokens(activeOnly), 0);
    assert.equal(activeOnly.quotaObservations.length, 0);
    assert.equal(totalToolCalls(activeOnly), 0);
    assert.equal(
      retainedBeforeRescan.usageRows.reduce(
        (sum, row) => sum + row.totalTokens,
        0,
      ),
      250,
    );
    assert.equal(retainedBeforeRescan.quotaRows[0].usedPercent, 37);
    assert.equal(retainedBeforeRescan.toolRows.length, 2);
    assert.equal(totalTokens(rescanned), 200);
    assert.equal(rescanned.quotaObservations.length, 1);
    assert.equal(rescanned.quotaObservations[0].usedPercent, 58);
    assert.equal(totalToolCalls(rescanned), 1);
    assert.equal(reconciled.usageRows.length, 1);
    assert.equal(reconciled.quotaRows.length, 1);
    assert.equal(reconciled.toolRows.length, 1);
    assert.equal(reconciled.sourceSummary.states[0].changeCount, 1);
    assert.equal(totalTokens(afterDeletion), 200);
    assert.equal(afterDeletion.quotaObservations[0].usedPercent, 58);
    assert.equal(totalToolCalls(afterDeletion), 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active move reconciles an archive replaced during active-only tracking", async () => {
  const fixture = await createFixture([]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "smaller-active-move.jsonl");
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(archivedFile, serialize([
      ...rolloutRows([100, 150], { usedPercent: 37 }),
      shellCall("2026-08-20T10:02:00.000Z", "call-old-before-move-one"),
      shellCall("2026-08-20T10:03:00.000Z", "call-old-before-move-two"),
    ]));
    await rm(fixture.file);
    await collectUsage(options(fixture));

    await writeFile(replacement, serialize([
      ...rolloutRows([200], { usedPercent: 58 }),
      shellCall("2026-08-20T10:01:00.000Z", "call-new-after-move"),
    ]));
    await rename(replacement, archivedFile);
    const activeOnlyBeforeMove = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    await rename(archivedFile, fixture.file);

    const rescanned = await collectUsage(options(fixture));
    const activeOnlyAfterMove = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(activeOnlyBeforeMove), 0);
    assert.equal(activeOnlyBeforeMove.quotaObservations.length, 0);
    assert.equal(totalToolCalls(activeOnlyBeforeMove), 0);
    assert.equal(totalTokens(rescanned), 200);
    assert.equal(rescanned.quotaObservations[0].usedPercent, 58);
    assert.equal(totalToolCalls(rescanned), 1);
    assert.equal(totalTokens(activeOnlyAfterMove), 200);
    assert.equal(activeOnlyAfterMove.quotaObservations[0].usedPercent, 58);
    assert.equal(totalToolCalls(activeOnlyAfterMove), 1);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.toolRows.length, 1);
    assert.equal(ledger.sourceSummary.states[0].location, "active");
    assert.equal(ledger.sourceSummary.states[0].changeCount, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uncertain replacement is evidence-only until a clean rescan", async () => {
  const fixture = await createFixture([100, 150], { usedPercent: 37 });
  const replacement = resolve(fixture.root, "uncertain-replacement.jsonl");
  const recovered = resolve(fixture.root, "recovered-replacement.jsonl");
  const validReplacementRows = [
    ...rolloutRows([200], { usedPercent: 58 }),
    shellCall("2026-08-20T10:01:00.000Z", "call-new-after-parse-error"),
  ];
  try {
    await appendFile(fixture.file, serialize([
      shellCall("2026-08-20T10:02:00.000Z", "call-old-before-error-one"),
      shellCall("2026-08-20T10:03:00.000Z", "call-old-before-error-two"),
    ]));
    const initial = await collectUsage(options(fixture));

    await writeFile(
      replacement,
      `${serialize(validReplacementRows)}{"type":"event_msg","payload":{"type":"token_count"\n`,
    );
    await rename(replacement, fixture.file);
    const uncertain = await collectUsage(options(fixture));
    const retained = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    await writeFile(recovered, serialize(validReplacementRows));
    await rename(recovered, fixture.file);
    const clean = await collectUsage(options(fixture));
    const reconciled = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(initial), 250);
    assert.equal(initial.quotaObservations.length, 1);
    assert.equal(totalToolCalls(initial), 2);
    assert.equal(uncertain.coverage.parseErrors, 1);
    assert.equal(totalTokens(uncertain), 250);
    assert.deepEqual(
      uncertain.quotaObservations.map((quota) => quota.usedPercent).sort(),
      [37],
    );
    assert.equal(totalToolCalls(uncertain), 2);
    assert.equal(
      retained.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      250,
    );
    assert.equal(retained.quotaRows.length, 1);
    assert.equal(retained.toolRows.length, 2);
    assert.equal(retained.sourceSummary.states[0].reconciliationPending, true);
    assert.equal(totalTokens(afterRemoval), 250);
    assert.equal(afterRemoval.quotaObservations.length, 1);
    assert.equal(totalToolCalls(afterRemoval), 2);
    assert.equal(clean.coverage.parseErrors, 0);
    assert.equal(totalTokens(clean), 200);
    assert.deepEqual(
      clean.quotaObservations.map((quota) => quota.usedPercent),
      [58],
    );
    assert.equal(totalToolCalls(clean), 1);
    assert.equal(reconciled.usageRows.length, 1);
    assert.equal(reconciled.quotaRows.length, 1);
    assert.equal(reconciled.toolRows.length, 1);
    assert.equal(
      reconciled.sourceSummary.states[0].reconciliationPending,
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("invalid-token uncertainty is scoped to its replaced source", async () => {
  const fixture = await createFixture([100, 150], { usedPercent: 37 });
  const secondFile = resolve(
    fixture.root,
    "sessions",
    "2026",
    "08",
    "20",
    SHARED_ROLLOUT_NAME,
  );
  const firstReplacement = resolve(fixture.root, "invalid-first-source.jsonl");
  const secondReplacement = resolve(fixture.root, "valid-second-source.jsonl");
  const recoveredFirst = resolve(fixture.root, "valid-first-source.jsonl");
  const invalidToken = tokenCount("2026-08-20T10:02:01.000Z", 500, 58);
  invalidToken.payload.info.last_token_usage.total_tokens = "invalid";
  try {
    await appendFile(fixture.file, serialize([
      shellCall("2026-08-20T10:02:00.000Z", "call-first-old-one"),
      shellCall("2026-08-20T10:03:00.000Z", "call-first-old-two"),
    ]));
    await writeFile(secondFile, serialize([
      ...rolloutRows([300, 350], { offset: 10, usedPercent: 45 }),
      shellCall("2026-08-20T10:12:00.000Z", "call-second-old-one"),
      shellCall("2026-08-20T10:13:00.000Z", "call-second-old-two"),
    ]));
    const initial = await collectUsage(options(fixture));

    await writeFile(firstReplacement, serialize([
      ...rolloutRows([200], { usedPercent: 58 }),
      shellCall("2026-08-20T10:01:00.000Z", "call-first-uncertain"),
      ...turnStart("2026-08-20T10:02:00.000Z", "invalid-turn"),
      invalidToken,
    ]));
    await writeFile(secondReplacement, serialize([
      ...rolloutRows([400], { offset: 10, usedPercent: 67 }),
      shellCall("2026-08-20T10:11:00.000Z", "call-second-valid"),
    ]));
    await rename(firstReplacement, fixture.file);
    await rename(secondReplacement, secondFile);
    const sourceScoped = await collectUsage(options(fixture));

    await writeFile(recoveredFirst, serialize([
      ...rolloutRows([250], { usedPercent: 59 }),
      shellCall("2026-08-20T10:01:00.000Z", "call-first-recovered"),
    ]));
    await rename(recoveredFirst, fixture.file);
    const recovered = await collectUsage(options(fixture));

    assert.equal(totalTokens(initial), 900);
    assert.equal(totalToolCalls(initial), 4);
    assert.equal(sourceScoped.coverage.invalidTokenRecords, 1);
    assert.equal(totalTokens(sourceScoped), 650);
    assert.deepEqual(
      sourceScoped.quotaObservations
        .map((quota) => quota.usedPercent)
        .sort((left, right) => left - right),
      [37, 67],
    );
    assert.equal(totalToolCalls(sourceScoped), 3);
    assert.equal(recovered.coverage.invalidTokenRecords, 0);
    assert.equal(totalTokens(recovered), 650);
    assert.deepEqual(
      recovered.quotaObservations
        .map((quota) => quota.usedPercent)
        .sort((left, right) => left - right),
      [59, 67],
    );
    assert.equal(totalToolCalls(recovered), 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-inode uncertain scans cannot overwrite positional usage", async () => {
  const fixture = await createFixture([100, 150]);
  const invalidToken = tokenCount("2026-08-20T10:02:01.000Z", 500);
  invalidToken.payload.info.last_token_usage.total_tokens = "invalid";
  try {
    const initial = await collectUsage(options(fixture));
    const before = await stat(fixture.file);
    await writeFile(fixture.file, serialize([
      ...rolloutRows([50]),
      ...turnStart("2026-08-20T10:02:00.000Z", "invalid-turn"),
      invalidToken,
      {
        timestamp: "2026-08-20T10:03:00.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "padding".repeat(1_024),
        },
      },
    ]));
    const after = await stat(fixture.file);
    assert.equal(after.ino, before.ino);
    assert.ok(after.size > before.size);

    const uncertain = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(initial), 250);
    assert.equal(uncertain.coverage.invalidTokenRecords, 1);
    assert.equal(totalTokens(uncertain), 250);
    assert.equal(totalTokens(afterRemoval), 250);
    assert.deepEqual(
      ledger.usageRows.map((row) => row.totalTokens).sort((a, b) => a - b),
      [100, 150],
    );
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uncertain scans cannot clear prior tool ownership", async () => {
  const fixture = await createFixture([100]);
  try {
    await appendFile(fixture.file, serialize([
      shellCall("2026-08-20T10:01:00.000Z", "call-before-uncertainty"),
    ]));
    const initial = await collectUsage(options(fixture));
    const before = await stat(fixture.file);
    await writeFile(
      fixture.file,
      `${serialize(rolloutRows([50]))}{"type":"response_item","payload":{"type":"function_call"\n`,
    );
    const after = await stat(fixture.file);
    assert.equal(after.ino, before.ino);

    const uncertain = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(initial), 100);
    assert.equal(totalToolCalls(initial), 1);
    assert.equal(uncertain.coverage.parseErrors, 1);
    assert.equal(totalTokens(uncertain), 100);
    assert.equal(totalToolCalls(uncertain), 1);
    assert.equal(totalTokens(afterRemoval), 100);
    assert.equal(totalToolCalls(afterRemoval), 1);
    assert.equal(ledger.toolRows.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("deferred replacement reconciles after a clean append", async () => {
  const fixture = await createFixture([100, 150], { usedPercent: 37 });
  const replacement = resolve(fixture.root, "deferred-replacement.jsonl");
  const validRows = [
    ...rolloutRows([200], { usedPercent: 58 }),
    shellCall("2026-08-20T10:01:00.000Z", "call-after-recovery"),
  ];
  try {
    await appendFile(fixture.file, serialize([
      shellCall("2026-08-20T10:02:00.000Z", "call-old-one"),
      shellCall("2026-08-20T10:03:00.000Z", "call-old-two"),
    ]));
    await collectUsage(options(fixture));

    await writeFile(
      replacement,
      `${serialize(validRows)}{"type":"event_msg","payload":{"type":"user_message","message":"`,
    );
    await rename(replacement, fixture.file);
    const uncertain = await collectUsage(options(fixture));
    let ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    assert.equal(uncertain.coverage.parseErrors, 0);
    assert.equal(totalTokens(uncertain), 200);
    assert.equal(ledger.sourceSummary.states[0].changeCount, 1);
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, false);

    await appendFile(fixture.file, `completed"}}\n`);
    const recovered = await collectUsage(options(fixture));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(recovered.coverage.parseErrors, 0);
    assert.equal(totalTokens(recovered), 200);
    assert.deepEqual(
      recovered.quotaObservations.map((quota) => quota.usedPercent),
      [58],
    );
    assert.equal(totalToolCalls(recovered), 1);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.toolRows.length, 1);
    assert.equal(ledger.sourceSummary.states[0].changeCount, 1);
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pending reconciliation survives truncation lifecycle tracking and tombstone", async () => {
  const fixture = await createFixture([100]);
  const replacement = resolve(fixture.root, "uncertain-replacement.jsonl");
  const archived = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    ROLLOUT_NAME,
  );
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  try {
    await collectUsage(options(fixture));
    await writeFile(
      replacement,
      `${serialize(rolloutRows([200]))}{"type":"event_msg","payload":\n`,
    );
    await rename(replacement, fixture.file);
    await collectUsage(options(fixture));
    let ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);

    await writeFile(fixture.file, serialize(rolloutRows([200])));
    await collectUsage(options(fixture));
    ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].changeState, "truncated");
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);

    await mkdir(resolve(archived, ".."), { recursive: true });
    await rename(fixture.file, archived);
    await collectUsage(options(fixture, { includeArchived: false }));
    ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].location, "archived");
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);

    await rm(archived);
    await collectUsage(options(fixture));
    ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].status, "tombstoned");
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pending reconciliation survives a missing zero-observation source", async () => {
  const fixture = await createFixture([]);
  const replacement = resolve(fixture.root, "uncertain-empty-replacement.jsonl");
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  try {
    await collectUsage(options(fixture));
    await writeFile(
      replacement,
      `{"type":"event_msg","payload":{"type":"token_count"\n`,
    );
    await rename(replacement, fixture.file);
    await collectUsage(options(fixture));
    let ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].observedEventCount, 0);
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);

    await rm(fixture.file);
    await collectUsage(options(fixture));
    ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].status, "missing");
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only lifecycle keeps simultaneous active and archived copies distinct", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  try {
    await collectUsage(options(fixture));
    await mkdir(archivedDirectory, { recursive: true });
    await copyFile(fixture.file, archivedFile);

    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const allSources = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(totalTokens(allSources), 100);
    assert.equal(ledger.sourceSummary.states.length, 2);
    assert.deepEqual(
      ledger.sourceSummary.states.map((state) => state.location).sort(),
      ["active", "archived"],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("durable ledgers reject a different Codex data directory", async () => {
  const firstFixture = await createFixture([100]);
  const secondCodexHome = resolve(firstFixture.root, "other-codex-home");
  try {
    await collectUsage(options(firstFixture));
    await mkdir(secondCodexHome);
    await assert.rejects(
      collectUsage(options(firstFixture, {
        codexHome: secondCodexHome,
        output: firstFixture.output,
      })),
      (error) => error?.code === "ERR_DURABLE_LEDGER_CODEX_HOME",
    );
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: firstFixture.root }),
    );

    assert.equal(
      ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      100,
    );
    assert.equal(ledger.revision, 1);
  } finally {
    await rm(firstFixture.root, { recursive: true, force: true });
  }
});

test("rejected first commits do not bind the Codex data directory", async () => {
  const fixture = await createFixture([100]);
  const secondCodexHome = resolve(fixture.root, "other-codex-home");
  const inventory = { files: [], lifecycleFiles: [] };
  try {
    await mkdir(secondCodexHome);
    await assert.rejects(
      updateDurableLedger({
        options: options(fixture),
        codexHome: fixture.root,
        inventory,
        validateAfterCommit: async () => {
          throw new Error("reject first binding");
        },
      }),
      /reject first binding/,
    );

    await updateDurableLedger({
      options: options(fixture),
      codexHome: secondCodexHome,
      inventory,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("durable ledger binding canonicalizes Codex home aliases", async () => {
  const fixture = await createFixture([100]);
  const alias = resolve(fixture.root, "codex-home-alias");
  try {
    await collectUsage(options(fixture));
    await symlink(fixture.root, alias, "dir");
    const throughAlias = await collectUsage(options(fixture, {
      codexHome: alias,
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(throughAlias), 100);
    assert.equal(ledger.revision, 2);
    assert.equal(
      codexHomeFingerprint(alias),
      codexHomeFingerprint(fixture.root),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exact observations retain tool-call ownership after source disappearance", async () => {
  const fixture = await createFixture([100]);
  try {
    await appendFile(
      fixture.file,
      serialize([{
        timestamp: "2026-08-20T10:01:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "call-exact-tool",
        },
      }]),
    );
    const first = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture, {
      includeArchived: false,
    }));

    assert.equal(first.events[0].toolCalls, 1);
    assert.equal(afterRemoval.events[0].toolCalls, 1);
    assert.equal(afterRemoval.threads[0].toolCalls, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("shared observations retain the durable union of partial tool calls", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  const call = (callId) => ({
    timestamp: "2026-08-20T10:01:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: callId,
    },
  });
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await appendFile(
      fixture.file,
      serialize([call("call-shared"), call("call-active-only")]),
    );
    await writeFile(
      archivedFile,
      serialize([...rolloutRows([100]), call("call-shared")]),
    );

    const allSources = await collectUsage(options(fixture));
    await rm(fixture.file);
    const partialSource = await collectUsage(options(fixture));
    await rm(archivedFile);
    const afterRemoval = await collectUsage(options(fixture));

    assert.equal(allSources.events[0].toolCalls, 2);
    assert.equal(partialSource.events[0].toolCalls, 2);
    assert.equal(partialSource.threads[0].toolCalls, 2);
    assert.equal(afterRemoval.events[0].toolCalls, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement removes only its stale shared-event membership", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(archivedFile, await readFile(fixture.file));
    await collectUsage(options(fixture));
    await writeFile(replacement, serialize(rolloutRows([200])));
    await rename(replacement, fixture.file);

    const allSources = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const archivedSourceId = ledger.sourceSummary.states.find(
      (state) => state.location === "archived",
    )?.sourceId;
    const oldObservation = ledger.usageRows.find(
      (row) => row.totalTokens === 100,
    );

    assert.equal(totalTokens(allSources), 300);
    assert.equal(totalTokens(activeOnly), 200);
    assert.deepEqual([...oldObservation.sourceIds], [archivedSourceId]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unchanged and appended sources add each logical event once", async () => {
  const fixture = await createFixture([100]);
  try {
    const first = await collectUsage(options(fixture));
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );
    const appendedProgress = [];
    const appended = await collectUsage(
      options(fixture),
      ({ current, total }) => appendedProgress.push([current, total]),
    );
    const unchangedProgress = [];
    const unchanged = await collectUsage(
      options(fixture),
      ({ current, total }) => unchangedProgress.push([current, total]),
    );
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(first.coverage.observedTokens, 100);
    assert.equal(appended.coverage.observedTokens, 300);
    assert.equal(unchanged.coverage.observedTokens, 300);
    assert.deepEqual(appendedProgress, [[1, 1]]);
    assert.deepEqual(unchangedProgress, []);
    assert.equal(appended.coverage.filesScanned, 1);
    assert.equal(appended.coverage.filesReused, 0);
    assert.equal(unchanged.coverage.filesScanned, 0);
    assert.equal(unchanged.coverage.filesReused, 1);
    assert.equal(unchanged.coverage.bytesScanned, 0);
    assert.ok(unchanged.coverage.bytesReused > 0);
    assert.equal(ledger.usageRows.filter((row) => row.identityKind === "exact").length, 2);
    assert.equal(
      ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      300,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unchanged rollouts rescan when state metadata changes in the same second", async () => {
  const fixture = await createFixture([100]);
  const state = new DatabaseSync(resolve(fixture.root, "state_5.sqlite"));
  try {
    state.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, updated_at INTEGER)",
    );
    const metadataTimestamp = Math.floor(Date.now() / 1_000);
    state.prepare("INSERT INTO threads (id, cwd, updated_at) VALUES (?, ?, ?)")
      .run(THREAD_ID, "/projects/old-project", metadataTimestamp);

    const first = await collectUsage(options(fixture));
    state.prepare("UPDATE threads SET cwd = ?, updated_at = ? WHERE id = ?")
      .run("/projects/new-project", metadataTimestamp, THREAD_ID);
    const refreshed = await collectUsage(options(fixture));

    assert.equal(first.events[0].project, "old-project");
    assert.equal(refreshed.events[0].project, "new-project");
    assert.equal(refreshed.coverage.filesScanned, 1);
    assert.equal(refreshed.coverage.filesReused, 0);
  } finally {
    state.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("snapshot staging rejects durable ledger and SQLite sidecar paths", async () => {
  const fixture = await createFixture([]);
  try {
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    await collectUsage(options(fixture));
    const ledgerBefore = await readDurableLedger(ledgerPath);
    for (const output of [
      ledgerPath,
      `${ledgerPath}.writer-lock.sqlite`,
      `${ledgerPath}-journal`,
      `${ledgerPath}-wal`,
      `${ledgerPath}-shm`,
    ]) {
      await assert.rejects(
        stagePrivateSnapshot(output, { events: [] }),
        (error) => error?.code === "ERR_SNAPSHOT_RESERVED_PATH",
      );
    }
    assert.equal((await readDurableLedger(ledgerPath)).revision, ledgerBefore.revision);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unchanged rollouts rescan when a session-index title has no timestamp", async () => {
  const fixture = await createFixture([100]);
  const sessionIndex = resolve(fixture.root, "session_index.jsonl");
  try {
    await writeFile(
      sessionIndex,
      serialize([{ id: THREAD_ID, thread_name: "Old title" }]),
    );
    const first = await collectUsage(options(fixture));

    await writeFile(
      sessionIndex,
      serialize([{ id: THREAD_ID, thread_name: "New title" }]),
    );
    const refreshed = await collectUsage(options(fixture));

    assert.equal(first.threads[0].title, "Old title");
    assert.equal(refreshed.threads[0].title, "New title");
    assert.equal(refreshed.coverage.filesScanned, 1);
    assert.equal(refreshed.coverage.filesReused, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("metadata changes rescan rollout paths without UUIDs", async () => {
  const fixture = await createFixture([100]);
  const nonUuidFile = resolve(
    dirname(fixture.file),
    "rollout-without-a-thread-id.jsonl",
  );
  try {
    await rename(fixture.file, nonUuidFile);
    const first = await collectUsage(options(fixture));
    await writeFile(
      resolve(fixture.root, "session_index.jsonl"),
      serialize([{ id: THREAD_ID, thread_name: "Metadata changed" }]),
    );
    const refreshed = await collectUsage(options(fixture));

    assert.equal(first.coverage.filesScanned, 1);
    assert.equal(refreshed.coverage.filesScanned, 1);
    assert.equal(refreshed.coverage.filesReused, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement and truncation reconcile without double counting", async () => {
  const fixture = await createFixture([100, 200]);
  try {
    await collectUsage(options(fixture));
    await writeFile(
      fixture.file,
      serialize(rolloutRows([100, 300])),
    );
    const replaced = await collectUsage(options(fixture));
    let ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    assert.equal(replaced.coverage.observedTokens, 400);
    assert.equal(ledger.usageRows.filter((row) => row.identityKind === "exact").length, 2);
    assert.equal(replaced.coverage.sourceStates.changed, 1);
    assert.equal(ledger.sourceSummary.states[0].changeState, "replaced");

    await writeFile(fixture.file, serialize(rolloutRows([100])));
    const truncated = await collectUsage(options(fixture));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    assert.equal(truncated.coverage.observedTokens, 400);
    assert.equal(ledger.usageRows.filter((row) => row.identityKind === "exact").length, 2);
    assert.equal(truncated.coverage.sourceIncomplete, true);
    assert.equal(truncated.coverage.sourceStates.changed, 1);
    assert.equal(ledger.sourceSummary.states[0].changeState, "truncated");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-inode rewrite with a non-original turn replaces positional usage", async () => {
  const fixture = await createFixture([100]);
  const replacementTimestamp = "2026-08-20T10:00:00.000Z";
  const replacementRows = [
    ...turnStart(replacementTimestamp, "turn-2"),
    tokenCount("2026-08-20T10:00:01.000Z", 200),
  ];
  replacementRows[0].payload.started_at =
    Date.parse("2026-08-19T10:00:00.000Z") / 1_000;
  try {
    const first = await collectUsage(options(fixture));
    const before = await stat(fixture.file);
    await writeFile(fixture.file, serialize(replacementRows));
    const after = await stat(fixture.file);
    const replaced = await collectUsage(options(fixture));
    const replacedLedger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const unchanged = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const exactRows = ledger.usageRows.filter(
      (row) => row.identityKind === "exact",
    );

    assert.equal(totalTokens(first), 100);
    assert.equal(before.ino, after.ino);
    assert.equal(totalTokens(replaced), 200);
    assert.equal(totalTokens(unchanged), 200);
    assert.equal(exactRows.length, 1);
    assert.equal(exactRows[0].turnId, "turn-2");
    assert.equal(exactRows[0].totalTokens, 200);
    assert.equal(replacedLedger.sourceSummary.states[0].changeState, "replaced");
    assert.equal(ledger.sourceSummary.states[0].changeState, "stable");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("split after salted allocation keeps memberships and positions aligned", async () => {
  const fixture = await createFixture([100]);
  const oldSource = resolve(
    dirname(fixture.file),
    SHARED_ROLLOUT_NAME,
  );
  const rescanSource = resolve(
    dirname(fixture.file),
    "rollout-dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl",
  );
  const replacementRows = [
    ...turnStart(BASE_TIMESTAMP, "turn-2"),
    tokenCount("2026-08-20T10:00:01.000Z", 200),
  ];
  replacementRows[0].payload.started_at =
    Date.parse("2026-08-19T10:00:00.000Z") / 1_000;
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    // First establish an exact row for B, then repurpose its identity for C.
    await collectUsage(options(fixture));
    await writeFile(fixture.file, serialize(replacementRows));
    await collectUsage(options(fixture));

    // B's old copy is compacted while C retains the unsalted exact identity.
    await writeFile(
      oldSource,
      serialize(rolloutRows([100], {
        baseTimestamp: "2015-08-20T10:00:00.000Z",
      })),
    );
    await collectUsage(options(fixture));

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const membership = database.prepare(`
      SELECT event_key AS eventKey
        FROM usage_compaction_membership
       LIMIT 1
    `).get();
    assert.ok(membership?.eventKey);
    const eventKeyB = String(membership.eventKey);
    const foreign = database.prepare(`
      SELECT observation_id AS observationId, event_key AS eventKey
        FROM usage_observations
       WHERE identity_kind = 'exact' AND turn_id = 'turn-2'
       LIMIT 1
    `).get();
    assert.ok(foreign?.observationId);
    const unsaltedId = `exact-${stableHash(eventKeyB)}`;
    assert.equal(foreign.observationId, unsaltedId);
    assert.notEqual(foreign.eventKey, eventKeyB);
    database.close();
    database = null;

    // A current B copy splits out of the compacted row. The split must retain
    // the salted exact identity because C occupies B's unsalted candidate.
    await writeFile(rescanSource, serialize(rolloutRows([100])));
    await collectUsage(options(fixture));

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const saltedId = `exact-${stableHash(JSON.stringify([eventKeyB, 1]))}`;
    const eventKeyBDigest = stableHash(eventKeyB);
    const exactB = database.prepare(`
      SELECT observation_id AS observationId, event_key AS eventKey,
             identity_kind AS identityKind
        FROM usage_observations
       WHERE event_key = ?
    `).get(eventKeyB);
    const exactForeign = database.prepare(`
      SELECT observation_id AS observationId, event_key AS eventKey
        FROM usage_observations
       WHERE observation_id = ?
    `).get(unsaltedId);
    const bPositions = database.prepare(`
      SELECT COUNT(*) AS count
        FROM source_event_positions
       WHERE event_key = ? AND observation_id = ?
    `).get(eventKeyBDigest, saltedId);
    const foreignPositions = database.prepare(`
      SELECT COUNT(*) AS count
        FROM source_event_positions
       WHERE event_key = ? AND observation_id = ?
    `).get(eventKeyBDigest, unsaltedId);
    const bSources = database.prepare(`
      SELECT COUNT(*) AS count
        FROM usage_sources
       WHERE observation_id = ?
    `).get(saltedId);
    const compactedMemberships = database.prepare(`
      SELECT COUNT(*) AS count
        FROM usage_compaction_membership
       WHERE event_key = ?
    `).get(eventKeyB);

    assert.equal(exactB?.observationId, saltedId);
    assert.equal(exactB?.eventKey, eventKeyB);
    assert.equal(exactB?.identityKind, "exact");
    assert.equal(exactForeign?.observationId, unsaltedId);
    assert.equal(exactForeign?.eventKey, foreign.eventKey);
    assert.equal(Number(bPositions.count), 2);
    assert.equal(Number(foreignPositions.count), 0);
    assert.equal(Number(bSources.count), 2);
    assert.equal(Number(compactedMemberships.count), 0);
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("turnless usage events reconcile by stable source position", async () => {
  const fixture = await createFixture([]);
  const legacyRows = (totals) => totals.map((total, index) => tokenCount(
    new Date(Date.parse(BASE_TIMESTAMP) + index * 60_000).toISOString(),
    total,
  ));
  try {
    await writeFile(fixture.file, serialize(legacyRows([100, 200])));
    const first = await collectUsage(options(fixture));
    await writeFile(fixture.file, serialize(legacyRows([200, 300])));
    const replaced = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(first), 300);
    assert.equal(totalTokens(replaced), 500);
    assert.equal(totalTokens(afterRemoval), 500);
    assert.equal(ledger.usageRows.length, 2);
    assert.equal(
      ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      500,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a replaced event key can resurface in another source", async () => {
  const fixture = await createFixture([100]);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  const resurfaced = resolve(fixture.file, "..", SHARED_ROLLOUT_NAME);
  try {
    await collectUsage(options(fixture));
    await writeFile(replacement, serialize(rolloutRows([200])));
    await rename(replacement, fixture.file);
    await collectUsage(options(fixture));
    await writeFile(resurfaced, serialize(rolloutRows([100])));

    const combined = await collectUsage(options(fixture));
    await rm(fixture.file);
    await rm(resurfaced);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(combined), 300);
    assert.equal(totalTokens(afterRemoval), 300);
    assert.deepEqual(
      ledger.usageRows.map((row) => row.totalTokens).sort((a, b) => a - b),
      [100, 200],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exact event identity lookup uses the partial event-key index", async () => {
  const fixture = await createFixture([100, 200]);
  let database;
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const plan = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT observation_id AS observationId
        FROM usage_observations
       WHERE identity_kind = 'exact' AND event_key = ?
    `).all("event-key-placeholder")
      .map((row) => String(row.detail))
      .join("\n");

    assert.match(plan, /usage_exact_event_key/);
    assert.doesNotMatch(plan, /\bSCAN usage_observations\b/);
  } finally {
    try {
      database?.close();
    } catch {
      // Fixture cleanup remains authoritative.
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("atomic replacement preserves source identity and reconciles positions", async () => {
  const fixture = await createFixture([100, 200]);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    await collectUsage(options(fixture));
    const beforeLedger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    await writeFile(replacement, serialize(rolloutRows([100, 300])));
    await rename(replacement, fixture.file);

    const replaced = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(replaced), 400);
    assert.equal(ledger.usageRows.length, 2);
    assert.equal(ledger.sourceSummary.states.length, 1);
    assert.equal(
      ledger.sourceSummary.states[0].sourceId,
      beforeLedger.sourceSummary.states[0].sourceId,
    );
    assert.equal(ledger.sourceSummary.states[0].changeState, "replaced");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("shorter atomic replacement removes unmatched source observations", async () => {
  const fixture = await createFixture([100, 200]);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    await collectUsage(options(fixture));
    await writeFile(replacement, serialize(rolloutRows([300])));
    await rename(replacement, fixture.file);

    const replaced = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(replaced), 300);
    assert.equal(totalTokens(afterRemoval), 300);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.usageRows[0].totalTokens, 300);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("true append after atomic replacement does not count another replacement", async () => {
  const fixture = await createFixture([100]);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    await collectUsage(options(fixture));
    await writeFile(replacement, serialize(rolloutRows([200])));
    await rename(replacement, fixture.file);
    const replaced = await collectUsage(options(fixture));

    await appendFile(
      fixture.file,
      serialize(rolloutRows([300], { offset: 1 })),
    );
    const appended = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(replaced), 200);
    assert.equal(totalTokens(appended), 500);
    assert.equal(ledger.usageRows.length, 2);
    assert.equal(ledger.sourceSummary.states.length, 1);
    assert.equal(ledger.sourceSummary.states[0].changeCount, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("move plus same-inode rewrite reconciles as a replacement", async () => {
  const fixture = await createFixture([100, 200]);
  const archived = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    ROLLOUT_NAME,
  );
  try {
    await collectUsage(options(fixture));
    const before = await stat(fixture.file);
    await mkdir(resolve(archived, ".."), { recursive: true });
    await rename(fixture.file, archived);
    await writeFile(archived, serialize(rolloutRows([300])));
    const after = await stat(archived);
    assert.equal(after.ino, before.ino);
    assert.ok(after.size < before.size);

    const rewritten = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    assert.equal(totalTokens(rewritten), 300);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.sourceSummary.states[0].location, "archived");
    assert.equal(ledger.sourceSummary.states[0].changeCount, 1);
    assert.equal(ledger.sourceSummary.states[0].changeState, "replaced");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("forced reconciliation removes stale positions for shared observations", async () => {
  const fixture = await createFixture([100, 200]);
  const sharedFile = resolve(fixture.file, "..", SHARED_ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await writeFile(sharedFile, await readFile(fixture.file));
    await collectUsage(options(fixture));
    const originalInode = (await stat(fixture.file)).ino;
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const activeSourceId = String(database.prepare(`
      SELECT source_id AS sourceId
        FROM source_state
       WHERE inode = ?
    `).get(originalInode).sourceId);
    database.close();
    database = null;

    await writeFile(replacement, serialize(rolloutRows([300])));
    await rename(replacement, fixture.file);
    const replaced = await collectUsage(options(fixture));

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const replacedPositions = database.prepare(`
      SELECT event_ordinal AS eventOrdinal
        FROM source_event_positions
       WHERE source_id = ?
       ORDER BY event_ordinal
    `).all(activeSourceId);
    const retainedSharedUsage = database.prepare(`
      SELECT COUNT(*) AS count
        FROM usage_observations
       WHERE total_tokens IN (100, 200)
    `).get().count;

    assert.equal(totalTokens(replaced), 600);
    assert.equal(replacedPositions.length, 1);
    assert.equal(retainedSharedUsage, 2);
  } finally {
    try {
      database?.close();
    } catch {
      // Fixture cleanup remains authoritative.
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("larger same-inode overwrite removes unmatched source observations", async () => {
  const fixture = await createFixture([100, 200]);
  try {
    await collectUsage(options(fixture));
    const before = await stat(fixture.file);
    await writeFile(fixture.file, serialize([
      ...rolloutRows([300]),
      {
        timestamp: "2026-08-20T10:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "padding".repeat(1_024),
        },
      },
    ]));
    const after = await stat(fixture.file);
    assert.equal(after.ino, before.ino);
    assert.ok(after.size > before.size);

    const replaced = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(replaced), 300);
    assert.equal(totalTokens(afterRemoval), 300);
    assert.equal(replaced.coverage.sourceIncomplete, true);
    assert.equal(replaced.coverage.sourceStates.changed, 1);
    assert.equal(ledger.sourceSummary.states[0].changeState, "replaced");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("metadata-only touches with identical content remain stable", async () => {
  const fixture = await createFixture([100]);
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const touchedAt = new Date(Date.now() + 2_000);
    await utimes(fixture.file, touchedAt, touchedAt);

    const touched = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(totalTokens(touched), 100);
    assert.equal(touched.coverage.sourceIncomplete, false);
    assert.equal(touched.coverage.sourceStates.changed, 0);
    assert.equal(ledger.sourceSummary.states[0].changeState, "stable");
    assert.equal(ledger.sourceSummary.states[0].changeCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacing one source does not rewrite a shared observation", async () => {
  const fixture = await createFixture([100]);
  const sharedFile = resolve(fixture.file, "..", SHARED_ROLLOUT_NAME);
  try {
    await writeFile(sharedFile, await readFile(fixture.file));
    const shared = await collectUsage(options(fixture));

    await writeFile(fixture.file, serialize(rolloutRows([200])));
    const replaced = await collectUsage(options(fixture));
    await rm(fixture.file);
    await rm(sharedFile);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(shared), 100);
    assert.equal(totalTokens(replaced), 300);
    assert.equal(totalTokens(afterRemoval), 300);
    assert.deepEqual(
      ledger.usageRows.map((row) => row.totalTokens).sort((left, right) => left - right),
      [100, 200],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("original promotion refreshes persisted origin attribution", async () => {
  const fixture = await createFixture([]);
  const originalFile = resolve(fixture.file, "..", SHARED_ROLLOUT_NAME);
  const inheritedRows = rolloutRows([100]);
  inheritedRows[0].payload.started_at =
    Date.parse("2026-08-19T10:00:00.000Z") / 1_000;
  const originalRows = rolloutRows([100]);
  originalRows[1].payload.model = "gpt-5.6-sol";
  try {
    await writeFile(fixture.file, serialize(inheritedRows));
    await collectUsage(options(fixture));
    let ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    assert.equal(ledger.usageRows[0].originalLikely, false);
    assert.equal(ledger.usageRows[0].originThreadId, THREAD_ID);

    await writeFile(originalFile, serialize(originalRows));
    await collectUsage(options(fixture));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    assert.equal(ledger.usageRows[0].originalLikely, true);
    assert.equal(ledger.usageRows[0].threadId, SHARED_THREAD_ID);
    assert.equal(ledger.usageRows[0].originThreadId, SHARED_THREAD_ID);
    assert.equal(ledger.usageRows[0].model, "gpt-5.6-sol");
    assert.equal(ledger.usageRows[0].originModel, "gpt-5.6-sol");

    await rm(fixture.file);
    await rm(originalFile);
    await collectUsage(options(fixture));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    assert.equal(ledger.usageRows[0].originThreadId, SHARED_THREAD_ID);
    assert.equal(ledger.usageRows[0].originModel, "gpt-5.6-sol");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source replacement refreshes tool ownership without stale call counts", async () => {
  const fixture = await createFixture([100, 200]);
  const call = (callId) => ({
    timestamp: "2026-08-20T10:02:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: callId,
    },
  });
  try {
    await appendFile(fixture.file, serialize([call("call-before-replace")]));
    const first = await collectUsage(options(fixture));

    await writeFile(
      fixture.file,
      serialize([
        ...rolloutRows([100, 300]),
        call("call-after-replace"),
      ]),
    );
    const replaced = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));

    assert.equal(first.events.reduce((sum, event) => sum + event.toolCalls, 0), 1);
    assert.equal(replaced.events.reduce((sum, event) => sum + event.toolCalls, 0), 1);
    assert.equal(afterRemoval.events.reduce((sum, event) => sum + event.toolCalls, 0), 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-to-archived movement preserves one source and event set", async () => {
  const fixture = await createFixture([100]);
  try {
    await collectUsage(options(fixture));
    const archived = resolve(
      fixture.root,
      "archived_sessions",
      "2026",
      "08",
      ROLLOUT_NAME,
    );
    await mkdir(resolve(archived, ".."), { recursive: true });
    await rename(fixture.file, archived);

    const moved = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const withoutArchived = await collectUsage(
      options(fixture, { includeArchived: false }),
    );

    assert.equal(moved.coverage.observedTokens, 100);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.sourceSummary.states.length, 1);
    assert.equal(ledger.sourceSummary.states[0].location, "archived");
    assert.equal(ledger.sourceSummary.states[0].status, "archived");
    assert.equal(ledger.sourceSummary.counts.changed, 0);
    assert.equal(withoutArchived.coverage.observedTokens, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("simultaneous active and archived rollout copies keep separate scope", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      serialize(rolloutRows([200], { offset: 1 })),
    );
    const allSources = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    await rm(fixture.file);
    const afterActiveRemoval = await collectUsage(options(fixture));
    const retainedActiveHistory = await collectUsage(options(fixture, {
      includeArchived: false,
    }));

    assert.equal(totalTokens(allSources), 300);
    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(totalTokens(afterActiveRemoval), 300);
    assert.equal(totalTokens(retainedActiveHistory), 100);
    assert.deepEqual(
      ledger.sourceSummary.states.map((state) => state.location).sort(),
      ["active", "archived"],
    );
    assert.equal(new Set(
      ledger.sourceSummary.states.map((state) => state.sourceId),
    ).size, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("atomic replacement keeps one simultaneous rollout copy isolated", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      serialize(rolloutRows([200], { offset: 1 })),
    );
    await collectUsage(options(fixture));
    const beforeLedger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    await writeFile(replacement, serialize(rolloutRows([300])));
    await rename(replacement, fixture.file);

    const replaced = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const sourceIdByLocation = (value) => new Map(
      value.sourceSummary.states.map((state) => [state.location, state.sourceId]),
    );

    assert.equal(totalTokens(replaced), 500);
    assert.equal(ledger.sourceSummary.states.length, 2);
    assert.deepEqual(
      sourceIdByLocation(ledger),
      sourceIdByLocation(beforeLedger),
    );
    assert.equal(
      ledger.sourceSummary.states.find((state) => state.location === "active")
        ?.changeState,
      "replaced",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a failed persistence transaction leaves the last complete ledger usable", async () => {
  const fixture = await createFixture([100]);
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const priorRevision = await readDurableLedgerRevision(ledgerPath);
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    await assert.rejects(
      () => collectUsage(options(fixture, {
        faultInjector: ({ point }) => {
          if (point === "before-commit") throw new Error("injected persistence failure");
        },
      })),
      /injected persistence failure/,
    );
    const afterFailure = await readDurableLedger(ledgerPath);
    assert.equal(await readDurableLedgerRevision(ledgerPath), priorRevision);
    assert.equal(
      afterFailure.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      100,
    );

    const recovered = await collectUsage(options(fixture));
    assert.equal(recovered.coverage.observedTokens, 300);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("overlapping ledger writers serialize on the writer guard", async () => {
  const fixture = await createFixture([100]);
  let writerGuard;
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const priorRevision = await readDurableLedgerRevision(ledgerPath);
    writerGuard = new DatabaseSync(`${ledgerPath}.writer-lock.sqlite`);
    writerGuard.exec("BEGIN IMMEDIATE");
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    await assert.rejects(
      () => collectUsage(options(fixture)),
      /database is locked|SQLITE_BUSY/i,
    );
    assert.equal(await readDurableLedgerRevision(ledgerPath), priorRevision);
    const unchanged = await readDurableLedger(ledgerPath);
    assert.equal(
      unchanged.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      100,
    );

    writerGuard.exec("ROLLBACK");
    writerGuard.close();
    writerGuard = null;
    const recovered = await collectUsage(options(fixture));
    assert.equal(totalTokens(recovered), 300);
  } finally {
    try {
      writerGuard?.exec("ROLLBACK");
    } catch {
      // Best-effort test cleanup.
    }
    writerGuard?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ledger readers block writers until they close", async () => {
  const fixture = await createFixture([100]);
  let readerGuard;
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const priorRevision = await readDurableLedgerRevision(ledgerPath);
    readerGuard = new DatabaseSync(`${ledgerPath}.writer-lock.sqlite`);
    readerGuard.exec("BEGIN");
    readerGuard.prepare("SELECT COUNT(*) FROM writer_guard").get();
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    await assert.rejects(
      () => collectUsage(options(fixture)),
      /database is locked|SQLITE_BUSY/i,
    );
    assert.equal(await readDurableLedgerRevision(ledgerPath), priorRevision);

    readerGuard.exec("ROLLBACK");
    readerGuard.close();
    readerGuard = null;
    const recovered = await collectUsage(options(fixture));
    assert.equal(totalTokens(recovered), 300);
  } finally {
    try {
      readerGuard?.exec("ROLLBACK");
    } catch {
      // Best-effort test cleanup.
    }
    readerGuard?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("revision reads tolerate Node SQLite corruption error codes", async () => {
  const fixture = await createFixture([]);
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  try {
    await mkdir(fixture.stateDirectory, { recursive: true });
    await writeFile(ledgerPath, "not a sqlite database");
    assert.equal(await readDurableLedgerRevision(ledgerPath), null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source changes before commit roll back transient observations", async () => {
  const fixture = await createFixture([100, 150]);
  let replaced = false;
  try {
    const snapshot = await collectUsage(options(fixture, {
      faultInjector: async ({ point }) => {
        if (point === "before-commit" && !replaced) {
          replaced = true;
          await writeFile(fixture.file, serialize(rolloutRows([200])));
        }
      },
    }));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(snapshot), 200);
    assert.equal(totalTokens(afterRemoval), 200);
    assert.deepEqual(ledger.usageRows.map((row) => row.totalTokens), [200]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source changes after validation roll back the candidate before retry", async () => {
  const fixture = await createFixture([100]);
  let changed = false;
  try {
    await collectUsage(options(fixture));
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );
    const snapshot = await collectUsage(options(fixture, {
      faultInjector: async ({ point }) => {
        if (point === "after-validation" && !changed) {
          changed = true;
          await writeFile(fixture.file, serialize(rolloutRows([100])));
        }
      },
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(changed, true);
    assert.equal(totalTokens(snapshot), 100);
    assert.equal(
      ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      100,
    );
    assert.equal(ledger.usageRows.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a post-commit source race publishes once and converges next refresh", async () => {
  const fixture = await createFixture([100]);
  let commitCount = 0;
  try {
    const initial = await collectUsage(options(fixture));
    await writePrivateSnapshot(fixture.output, initial);
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    const snapshot = await collectUsage(options(fixture, {
      stageSnapshot: (candidate) =>
        stagePrivateSnapshot(fixture.output, candidate),
      faultInjector: async ({ point }) => {
        if (point === "after-sqlite-commit") {
          commitCount += 1;
          if (commitCount === 1) {
            await replaceRollout(fixture, [400, 500]);
          }
        }
      },
    }));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const stored = await readPrivateSnapshot(fixture.output);

    assert.equal(commitCount, 1);
    assert.equal(totalTokens(snapshot), 300);
    assert.equal(totalTokens(stored), 300);
    assert.equal(snapshot.metadata.durableLedger.revision, 2);
    assert.equal(stored.metadata.durableLedger.revision, 2);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 2);

    const converged = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(ledgerPath);
    assert.equal(totalTokens(converged), 900);
    assert.equal(converged.metadata.durableLedger.revision, 3);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 3);
    assert.deepEqual(ledger.usageRows.map((row) => row.totalTokens), [400, 500]);
    assert.deepEqual(
      (await readdir(dirname(fixture.output))).filter((name) =>
        name.startsWith(".token-ledger-")
      ),
      [],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a post-commit truncation race discards the transient append", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  let commitCount = 0;
  try {
    await collectUsage(options(fixture));
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1, usedPercent: 58 })),
    );

    const snapshot = await collectUsage(options(fixture, {
      faultInjector: async ({ point }) => {
        if (point === "after-sqlite-commit") {
          commitCount += 1;
          if (commitCount === 1) {
            await writeFile(
              fixture.file,
              serialize(rolloutRows([100], { usedPercent: 37 })),
            );
          }
        }
      },
    }));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(commitCount, 2);
    assert.equal(totalTokens(snapshot), 100);
    assert.deepEqual(ledger.usageRows.map((row) => row.totalTokens), [100]);
    // The rejected revision's transient quota reading is reverted with it.
    assert.deepEqual(
      snapshot.quotaObservations.map((quota) => quota.usedPercent),
      [37],
    );
    assert.deepEqual(
      ledger.quotaRows.map((row) => row.usedPercent),
      [37],
    );
    // Reverting the rejected revision also restores its pre-race cursor, so
    // the retry sees the truncated-back file as unchanged rather than
    // truncated.
    assert.equal(ledger.sourceSummary.states[0].changeState, "stable");

    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    assert.equal(totalTokens(afterRemoval), 100);
    assert.deepEqual(
      afterRemoval.quotaObservations.map((quota) => quota.usedPercent),
      [37],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a rejected repeat quota reading reverts the extended bound", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  let commitCount = 0;
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const validated = await readDurableLedger(ledgerPath);
    // The same 37% reading repeated at a later timestamp extends only the
    // observation and source bounds.
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1, usedPercent: 37 })),
    );

    const snapshot = await collectUsage(options(fixture, {
      faultInjector: async ({ point }) => {
        if (point === "after-sqlite-commit") {
          commitCount += 1;
          if (commitCount === 1) {
            await writeFile(
              fixture.file,
              serialize(rolloutRows([100], { usedPercent: 37 })),
            );
          }
        }
      },
    }));
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(commitCount, 2);
    assert.equal(totalTokens(snapshot), 100);
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.quotaRows[0].usedPercent, 37);
    assert.equal(
      ledger.quotaRows[0].lastSeenAt,
      validated.quotaRows[0].lastSeenAt,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a rejected commit reverts same-run compaction of its own events", async () => {
  const fixture = await createFixture([100]);
  let commitCount = 0;
  try {
    await collectUsage(options(fixture));
    // The transient append predates the exact-observation retention cutoff,
    // so the same transaction compacts it immediately after ingest.
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], {
        offset: 1,
        baseTimestamp: "2015-01-01T10:00:00.000Z",
      })),
    );

    const snapshot = await collectUsage(options(fixture, {
      faultInjector: async ({ point }) => {
        if (point === "after-sqlite-commit") {
          commitCount += 1;
          if (commitCount === 1) {
            await writeFile(fixture.file, serialize(rolloutRows([100])));
          }
        }
      },
    }));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(commitCount, 2);
    assert.equal(totalTokens(snapshot), 100);
    assert.deepEqual(
      ledger.usageRows.map((row) => [row.identityKind, row.totalTokens]),
      [["exact", 100]],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a rejected first commit retries the one-shot legacy migration", async () => {
  const fixture = await createFixture([100]);
  const legacySnapshotPath = resolve(fixture.root, "exports", "snapshot.json");
  const generatedAt = "2026-08-19T12:00:00.000Z";
  let commitCount = 0;
  try {
    await mkdir(dirname(legacySnapshotPath), { recursive: true });
    await writePrivateSnapshot(
      legacySnapshotPath,
      legacySnapshotForFixture(fixture, {
        schemaVersion: 3,
        generatedAt,
        events: [{
          timestamp: generatedAt,
          startAt: generatedAt,
          endAt: generatedAt,
          project: "legacy-project",
          model: "gpt-5.4",
          rateCardModel: "gpt-5.4",
          effort: "medium",
          source: "local",
          useType: "interactive",
          inputTokens: 490,
          cachedInputTokens: 10,
          outputTokens: 10,
          reasoningTokens: 4,
          totalTokens: 500,
          toolCalls: 0,
          callCount: 1,
          detailedCallCount: 1,
          inputCallCount: 1,
          breakdownAvailable: true,
          threadIds: ["legacy-rejected-thread"],
        }],
      }),
    );

    const snapshot = await collectUsage(options(fixture, {
      output: legacySnapshotPath,
      faultInjector: async ({ point }) => {
        if (point === "after-sqlite-commit") {
          commitCount += 1;
          if (commitCount === 1) {
            await replaceRollout(fixture, [200]);
          }
        }
      },
    }));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const ledger = await readDurableLedger(ledgerPath);

    // The rejected first commit reverted its migration and the one-shot
    // marker together, so the retry re-reads the legacy snapshot instead of
    // silently dropping the migrated history.
    assert.equal(commitCount, 2);
    assert.equal(totalTokens(snapshot), 700);
    assert.equal(ledger.migratedUsageRows, 1);
    assert.equal(
      ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      700,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a crash between commit and validation unwinds on the next refresh", async () => {
  const fixture = await createFixture([100]);
  try {
    const initial = await collectUsage(options(fixture));
    await writePrivateSnapshot(fixture.output, initial);
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    crashCollection(fixture, "after-sqlite-commit");
    await writeFile(fixture.file, serialize(rolloutRows([100])));

    const snapshot = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(totalTokens(snapshot), 100);
    assert.deepEqual(ledger.usageRows.map((row) => row.totalTokens), [100]);
    const database = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      assert.equal(
        database.prepare(
          "SELECT value FROM ledger_meta WHERE key = 'post_commit_validation_pending'",
        ).get()?.value ?? null,
        null,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("post-commit source changes keep the staged ledger and cache aligned", async () => {
  const fixture = await createFixture([100]);
  let commitCount = 0;
  try {
    const initial = await collectUsage(options(fixture));
    await writePrivateSnapshot(fixture.output, initial);
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    await replaceRollout(fixture, [100, 200]);
    const snapshot = await collectUsage(options(fixture, {
      stageSnapshot: (candidate) =>
        stagePrivateSnapshot(fixture.output, candidate),
      faultInjector: async ({ point }) => {
        if (point === "after-sqlite-commit") {
          await replaceRollout(fixture, [300, 400]);
          commitCount += 1;
        }
      },
    }));
    const ledger = await readDurableLedger(ledgerPath);
    const stored = await readPrivateSnapshot(fixture.output);

    assert.equal(commitCount, 1);
    assert.equal(ledger.revision, 2);
    assert.deepEqual(ledger.usageRows.map((row) => row.totalTokens), [100, 200]);
    assert.equal(totalTokens(snapshot), 300);
    assert.equal(stored.metadata.durableLedger.revision, 2);
    assert.equal(totalTokens(stored), 300);
    assert.equal(
      stored.metadata.durableLedger.revision,
      await readDurableLedgerRevision(ledgerPath),
    );
    assert.deepEqual(
      (await readdir(dirname(fixture.output))).filter((name) =>
        name.startsWith(".token-ledger-")
      ),
      [],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("main-ledger aliases fail closed before opening transactions", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-main-path-"));
  const target = resolveDurableLedgerPath({ codexHome: root });
  const symbolicAlias = resolve(root, "symbolic.sqlite");
  const hardAlias = resolve(root, "hard.sqlite");
  const inventory = { files: [], lifecycleFiles: [] };
  const update = (options, extra = {}) => updateDurableLedger({
    options,
    codexHome: root,
    inventory,
    ...extra,
  });
  try {
    await update({});
    assert.equal(await readDurableLedgerRevision(target), 1);
    await symlink(target, symbolicAlias);

    let postCommitValidationCalled = false;
    await assert.rejects(
      () => update({ ledgerPath: symbolicAlias }, {
        validateAfterCommit: async () => {
          postCommitValidationCalled = true;
          throw new Error("reject committed candidate");
        },
      }),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    assert.equal(postCommitValidationCalled, false);
    assert.equal((await lstat(symbolicAlias)).isSymbolicLink(), true);
    assert.equal(await readDurableLedgerRevision(target), 1);
    await assert.rejects(
      () => readDurableLedger(symbolicAlias),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );

    await link(target, hardAlias);
    await assert.rejects(
      () => update({ ledgerPath: hardAlias }),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    await assert.rejects(
      () => readDurableLedgerRevision(hardAlias),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    await rm(hardAlias);
    assert.equal(await readDurableLedgerRevision(target), 1);

    const names = await readdir(root);
    assert.equal(
      names.some((name) => name.startsWith("symbolic.sqlite.")),
      false,
    );
    assert.equal(
      names.some((name) => name.startsWith("hard.sqlite.")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writer-guard aliases fail closed without mutating their targets", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-guard-path-"));
  const ledgerPath = resolveDurableLedgerPath({ codexHome: root });
  const guardPath = `${ledgerPath}.writer-lock.sqlite`;
  const victimPath = resolve(root, "victim.sqlite");
  const update = () => updateDurableLedger({
    options: {},
    codexHome: root,
    inventory: { files: [], lifecycleFiles: [] },
  });
  const assertVictimUnchanged = async () => {
    const victimStat = await stat(victimPath);
    assert.equal(victimStat.mode & 0o777, 0o644);
    const database = new DatabaseSync(victimPath, { readOnly: true });
    try {
      assert.deepEqual(
        database.prepare(`
          SELECT name FROM sqlite_master
           WHERE type = 'table'
           ORDER BY name
        `).all().map((row) => row.name),
        ["protected"],
      );
      assert.equal(
        database.prepare("SELECT value FROM protected").get().value,
        "unchanged",
      );
    } finally {
      database.close();
    }
  };
  let victimDatabase;
  try {
    await update();
    assert.equal(await readDurableLedgerRevision(ledgerPath), 1);
    await rm(guardPath);
    victimDatabase = new DatabaseSync(victimPath);
    victimDatabase.exec(`
      CREATE TABLE protected(value TEXT);
      INSERT INTO protected VALUES ('unchanged');
    `);
    victimDatabase.close();
    victimDatabase = null;
    await chmod(victimPath, 0o644);

    await symlink(victimPath, guardPath);
    await assert.rejects(
      update,
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    await assert.rejects(
      () => readDurableLedgerRevision(ledgerPath),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    assert.equal((await lstat(guardPath)).isSymbolicLink(), true);
    await assertVictimUnchanged();
    await rm(guardPath);

    await link(victimPath, guardPath);
    await assert.rejects(
      update,
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    await assert.rejects(
      () => readDurableLedgerRevision(ledgerPath),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    assert.equal((await stat(victimPath)).nlink, 2);
    await assertVictimUnchanged();
    await rm(guardPath);

    await mkdir(guardPath);
    await assert.rejects(
      update,
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    await assert.rejects(
      () => readDurableLedgerRevision(ledgerPath),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    await assertVictimUnchanged();
    await rm(guardPath, { recursive: true });

    await update();
    assert.equal(await readDurableLedgerRevision(ledgerPath), 2);
    const guardStat = await lstat(guardPath);
    assert.equal(guardStat.isFile(), true);
    assert.equal(guardStat.nlink, 1);
    assert.equal(guardStat.mode & 0o777, 0o600);
  } finally {
    victimDatabase?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite sidecar aliases fail closed without touching victims", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-sidecar-path-"));
  const ledgerPath = resolveDurableLedgerPath({ codexHome: root });
  const update = () => updateDurableLedger({
    options: {},
    codexHome: root,
    inventory: { files: [], lifecycleFiles: [] },
  });
  try {
    await update();
    assert.equal(await readDurableLedgerRevision(ledgerPath), 1);
    const checkpoint = new DatabaseSync(ledgerPath);
    try {
      checkpoint.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } finally {
      checkpoint.close();
    }
    await rm(`${ledgerPath}-wal`, { force: true });
    await rm(`${ledgerPath}-shm`, { force: true });
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      for (const kind of ["symlink", "hardlink", "directory"]) {
        const sidecarPath = `${ledgerPath}${suffix}`;
        const victimPath = resolve(
          root,
          `victim-${suffix.slice(1)}-${kind}.bin`,
        );
        const original = Buffer.alloc(65_536, suffix.charCodeAt(1));
        if (kind === "directory") {
          await mkdir(sidecarPath);
        } else {
          await writeFile(victimPath, original, { mode: 0o644 });
          await chmod(victimPath, 0o644);
          if (kind === "symlink") await symlink(victimPath, sidecarPath);
          else await link(victimPath, sidecarPath);
        }

        await assert.rejects(
          update,
          (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
          `${suffix} ${kind}`,
        );
        await assert.rejects(
          () => readDurableLedgerRevision(ledgerPath),
          (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
          `${suffix} ${kind} read`,
        );
        if (kind !== "directory") {
          assert.deepEqual(await readFile(victimPath), original);
          const victimStat = await stat(victimPath);
          assert.equal(victimStat.mode & 0o777, 0o644);
          assert.equal(victimStat.nlink, kind === "hardlink" ? 2 : 1);
        }
        await rm(sidecarPath, {
          force: true,
          recursive: kind === "directory",
        });
      }
    }

    await update();
    assert.equal(await readDurableLedgerRevision(ledgerPath), 2);
    const database = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      assert.equal(
        database.prepare("PRAGMA journal_mode").get().journal_mode,
        "wal",
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-regular main-ledger paths fail before creating sidecars", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-main-nonregular-"));
  const stateDirectory = dirname(resolveDurableLedgerPath({ codexHome: root }));
  const ledgerPath = resolveDurableLedgerPath({ codexHome: root });
  try {
    await mkdir(dirname(ledgerPath), { recursive: true });
    await mkdir(ledgerPath);
    await assert.rejects(
      () => updateDurableLedger({
        options: {},
        codexHome: root,
        inventory: { files: [], lifecycleFiles: [] },
      }),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    await assert.rejects(
      () => readDurableLedger(ledgerPath),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    assert.deepEqual(await readdir(stateDirectory), [DURABLE_LEDGER_FILENAME]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom state directories are rejected before SQLite access", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-parent-link-"));
  const realStateDirectory = resolve(root, "real-state");
  const linkedStateDirectory = resolve(root, "linked-state");
  try {
    await mkdir(realStateDirectory);
    await symlink(realStateDirectory, linkedStateDirectory, "dir");
    assert.throws(
      () => resolveDurableLedgerPath({ stateDirectory: linkedStateDirectory }),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    assert.deepEqual(await readdir(realStateDirectory), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a process crash before commit rolls back the candidate", async () => {
  const fixture = await createFixture([100]);
  try {
    const initial = await collectUsage(options(fixture));
    await writePrivateSnapshot(fixture.output, initial);
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    crashCollection(fixture, "before-commit");
    const ledger = await readDurableLedger(ledgerPath);
    const stored = await readPrivateSnapshot(fixture.output);

    assert.equal(ledger.revision, 1);
    assert.deepEqual(ledger.usageRows.map((row) => row.totalTokens), [100]);
    assert.equal(stored.metadata.durableLedger.revision, 1);
    assert.equal(totalTokens(stored), 100);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a process crash after commit leaves a complete ledger and stale cache", async () => {
  const fixture = await createFixture([100]);
  try {
    fixture.output = resolve(
      fixture.stateDirectory,
      "token-ledger-snapshot-v3.json.gz",
    );
    const initial = await collectUsage(options(fixture));
    await writePrivateSnapshot(fixture.output, initial);
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    const crashed = crashCollection(
      fixture,
      "after-sqlite-commit",
      { stageSnapshot: true },
    );
    const committed = await readDurableLedger(ledgerPath);
    const oldCache = await readPrivateSnapshot(fixture.output);
    assert.equal(committed.revision, 2);
    assert.equal(
      committed.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      300,
    );
    assert.equal(oldCache.metadata.durableLedger.revision, 1);

    const destinationHash = snapshotDestinationHash(fixture.output);
    const orphaned = (await readdir(fixture.stateDirectory)).filter((name) =>
      name.endsWith(".tmp")
    );
    assert.equal(orphaned.length, 1);
    assert.match(
      orphaned[0],
      new RegExp(`^\\.token-ledger-${destinationHash}-${crashed.pid}-`),
    );
    const orphanPath = resolve(fixture.stateDirectory, orphaned[0]);
    const otherDestinationCanary = resolve(
      fixture.stateDirectory,
      `.token-ledger-${snapshotDestinationHash(resolve(fixture.root, "other.json.gz"))}-${crashed.pid}-00000000-0000-4000-8000-000000000001.tmp`,
    );
    const liveCanary = resolve(
      fixture.stateDirectory,
      `.token-ledger-${destinationHash}-${process.pid}-00000000-0000-4000-8000-000000000002.tmp`,
    );
    const unrelatedCanary = resolve(
      fixture.stateDirectory,
      ".token-ledger-unrelated.tmp",
    );
    await writeFile(otherDestinationCanary, "different destination\n");
    await writeFile(liveCanary, "live owner\n");
    await writeFile(unrelatedCanary, "unrelated\n");

    const originalGetuid = process.getuid;
    try {
      process.getuid = () => originalGetuid() + 1;
      const ownershipProbe = await stagePrivateSnapshot(
        fixture.output,
        oldCache,
      );
      await ownershipProbe.discard();
      await stat(orphanPath);
    } finally {
      process.getuid = originalGetuid;
    }

    const refreshed = await loadSnapshot({
      input: fixture.output,
      codexHome: fixture.root,
      includeArchived: true,
      since: null,
      refresh: false,
      inputExplicit: false,
      autoRefresh: true,
    });
    assert.equal(refreshed.sourceStatus, "verified-current");
    assert.equal(totalTokens(refreshed.snapshot), 300);
    assert.equal(refreshed.snapshot.metadata.durableLedger.revision, 3);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 3);
    await assert.rejects(stat(orphanPath), { code: "ENOENT" });
    assert.equal(
      await readFile(otherDestinationCanary, "utf8"),
      "different destination\n",
    );
    assert.equal(await readFile(liveCanary, "utf8"), "live owner\n");
    assert.equal(await readFile(unrelatedCanary, "utf8"), "unrelated\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("snapshot orphan cleanup preserves non-regular and linked canaries", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-orphan-safety-"));
  const output = resolve(root, "snapshot.json.gz");
  const victim = resolve(root, "victim.txt");
  const deadOwner = spawnSync(process.execPath, ["--eval", ""], {
    encoding: "utf8",
  });
  const candidate = (suffix) => resolve(
    root,
    `.token-ledger-${snapshotDestinationHash(output)}-${deadOwner.pid}-${suffix}.tmp`,
  );
  const ordinary = candidate("00000000-0000-4000-8000-000000000010");
  const symbolic = candidate("00000000-0000-4000-8000-000000000011");
  const hard = candidate("00000000-0000-4000-8000-000000000012");
  const directory = candidate("00000000-0000-4000-8000-000000000013");
  try {
    assert.equal(deadOwner.status, 0);
    assert.throws(
      () => process.kill(deadOwner.pid, 0),
      (error) => error?.code === "ESRCH",
    );
    await writeFile(victim, "preserve victim bytes\n", { mode: 0o640 });
    await writeFile(ordinary, "remove orphan\n", { mode: 0o600 });
    await symlink(victim, symbolic);
    await link(victim, hard);
    await mkdir(directory);
    const victimBefore = await stat(victim);

    const staged = await stagePrivateSnapshot(output, { events: [] });
    await staged.discard();

    await assert.rejects(stat(ordinary), { code: "ENOENT" });
    assert.equal((await lstat(symbolic)).isSymbolicLink(), true);
    assert.equal((await lstat(hard)).isFile(), true);
    assert.equal((await lstat(directory)).isDirectory(), true);
    const victimAfter = await stat(victim);
    assert.equal(await readFile(victim, "utf8"), "preserve victim bytes\n");
    assert.equal(victimAfter.mode & 0o777, victimBefore.mode & 0o777);
    assert.equal(victimAfter.nlink, victimBefore.nlink);
    assert.equal(victimAfter.nlink, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh creates no recovery artifacts or ledger-sized copy", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  let observedCommittedFiles = false;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.exec(`
      CREATE TABLE refresh_padding (payload BLOB NOT NULL);
      INSERT INTO refresh_padding VALUES (zeroblob(4194304));
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    database.close();
    database = null;
    const ledgerSize = (await stat(ledgerPath)).size;
    assert.ok(ledgerSize >= 4 * 1_024 * 1_024);

    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );
    const refreshed = await collectUsage(options(fixture, {
      faultInjector: async ({ point }) => {
        if (point !== "after-sqlite-commit") return;
        const expected = new Set([
          DURABLE_LEDGER_FILENAME,
          `${DURABLE_LEDGER_FILENAME}-shm`,
          `${DURABLE_LEDGER_FILENAME}-wal`,
          `${DURABLE_LEDGER_FILENAME}.writer-lock.sqlite`,
          `${DURABLE_LEDGER_FILENAME}.writer-lock.sqlite-shm`,
          `${DURABLE_LEDGER_FILENAME}.writer-lock.sqlite-wal`,
        ]);
        const unexpected = (await readdir(fixture.stateDirectory))
          .filter((name) => !expected.has(name));
        assert.deepEqual(unexpected, []);
        observedCommittedFiles = true;
      },
    }));

    assert.equal(observedCommittedFiles, true);
    assert.equal(totalTokens(refreshed), 300);
    assert.equal(
      (await readdir(fixture.stateDirectory)).some((name) =>
        name.includes(".recovery.")
      ),
      false,
    );
  } finally {
    try {
      database?.close();
    } catch {
      // Fixture cleanup remains authoritative.
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("staged cleanup errors do not mask post-commit failures", async () => {
  const fixture = await createFixture([100]);
  try {
    await collectUsage(options(fixture));
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    await assert.rejects(
      () => collectUsage(options(fixture, {
        stageSnapshot: async (snapshot) => ({
          snapshot,
          publish: async () => {},
          discard: async () => {
            throw new Error("injected staged cleanup failure");
          },
        }),
        faultInjector: ({ point }) => {
          if (point === "after-sqlite-commit") {
            throw new Error("injected authoritative commit failure");
          }
        },
      })),
      (error) => {
        assert.equal(error?.message, "injected authoritative commit failure");
        assert.deepEqual(
          error?.cleanupErrors?.map((cleanup) => cleanup.message),
          ["injected staged cleanup failure"],
        );
        return true;
      },
    );
    const ledger = await readDurableLedger(resolveDurableLedgerPath({ codexHome: fixture.root }));
    assert.equal(ledger.revision, 2);
    assert.deepEqual(
      ledger.usageRows.map((row) => row.totalTokens),
      [100, 200],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source changes after commit do not retry an already committed attempt", async () => {
  const fixture = await createFixture([100, 200]);
  let changed = false;
  try {
    const committed = await collectUsage(options(fixture, {
      faultInjector: async ({ point }) => {
        if (point === "after-commit" && !changed) {
          changed = true;
          await writeFile(fixture.file, serialize(rolloutRows([100])));
        }
      },
    }));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(changed, true);
    assert.equal(totalTokens(committed), 300);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 1);
    assert.equal(
      ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      300,
    );
    assert.equal(ledger.usageRows.length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("write-open rejects newer durable ledger schemas without rewriting them", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await mkdir(fixture.stateDirectory, { recursive: true });
    database = new DatabaseSync(ledgerPath);
    database.exec(`
      CREATE TABLE future_only (value TEXT);
      PRAGMA user_version = 4;
    `);
    database.close();
    database = null;

    await assert.rejects(
      () => collectUsage(options(fixture)),
      (error) => error?.code === "ERR_DURABLE_LEDGER_SCHEMA",
    );

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 4);
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
          FROM sqlite_master
         WHERE type = 'table' AND name = 'source_state'
      `).get().count,
      0,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM future_only").get().count,
      0,
    );
  } finally {
    try {
      database?.close();
    } catch {
      // Fixture cleanup remains authoritative.
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("write-open rejects future quota contracts without downgrading them", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.prepare(`
      UPDATE ledger_meta
         SET value = 'codex-limit-id-v3'
       WHERE key = 'quota_identity_contract'
    `).run();
    database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    database.close();
    database = null;
    const before = await readFile(ledgerPath);

    await assert.rejects(
      () => collectUsage(options(fixture)),
      (error) => error?.code === "ERR_DURABLE_LEDGER_QUOTA_CONTRACT",
    );
    assert.deepEqual(await readFile(ledgerPath), before);

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare(`
      SELECT value
        FROM ledger_meta
       WHERE key = 'quota_identity_contract'
    `).get().value, "codex-limit-id-v3");
    assert.equal(database.prepare(`
      SELECT value
        FROM ledger_meta
       WHERE key = 'revision'
    `).get().value, "1");
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM quota_observations",
    ).get().count, 1);
    database.close();
    database = null;

    database = new DatabaseSync(ledgerPath);
    database.prepare(`
      UPDATE ledger_meta
         SET value = ?
       WHERE key = 'quota_identity_contract'
    `).run(QUOTA_IDENTITY_CONTRACT_VERSION);
    database.close();
    database = null;
    const recovered = await collectUsage(options(fixture));
    assert.deepEqual(
      recovered.quotaObservations.map((quota) => quota.usedPercent),
      [37],
    );
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("v2 ledgers add reconciliation state without breaking read-only access", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.exec("ALTER TABLE source_state DROP COLUMN reconciliation_pending");
    database.close();
    database = null;

    const legacyV2 = await readDurableLedger(ledgerPath);
    assert.equal(legacyV2.sourceSummary.states[0].reconciliationPending, false);
    await collectUsage(options(fixture));

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const columns = database.prepare("PRAGMA table_info(source_state)").all()
      .map((column) => String(column.name));
    assert(columns.includes("reconciliation_pending"));
  } finally {
    try {
      database?.close();
    } catch {
      // Fixture cleanup remains authoritative.
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source identity compares device and inode as one pair", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-device-identity-"));
  const stateDirectory = dirname(resolveDurableLedgerPath({ codexHome: root }));
  const sourcePath = resolve(root, "sessions", ROLLOUT_NAME);
  const ledgerPath = resolveDurableLedgerPath({ codexHome: root });
  const source = ({
    device,
    inode = 17,
    size,
    cursorFingerprint,
    continuityBytes = null,
    continuityFingerprint = null,
  }) => ({
    path: sourcePath,
    sourceId: "synthetic-device-source",
    location: "active",
    size,
    mtimeMs: size,
    ctimeMs: size,
    dev: device,
    ino: inode,
    cursorBytes: size,
    cursorFingerprint,
    continuityBytes,
    continuityFingerprint,
  });
  const update = async (entry) => updateDurableLedger({
    options: {},
    codexHome: root,
    inventory: { files: [entry], lifecycleFiles: [entry] },
    includeArchived: true,
  });
  try {
    await update(source({
      device: 1,
      size: 100,
      cursorFingerprint: "a".repeat(64),
    }));
    await update(source({
      device: 2,
      size: 100,
      cursorFingerprint: "b".repeat(64),
    }));
    let ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].changeState, "replaced");
    assert.equal(ledger.sourceSummary.states[0].changeCount, 1);

    await rm(stateDirectory, { recursive: true, force: true });
    await update(source({
      device: 3,
      size: 100,
      cursorFingerprint: "c".repeat(64),
    }));
    await update(source({
      device: 3,
      size: 120,
      cursorFingerprint: "d".repeat(64),
      continuityBytes: 100,
      continuityFingerprint: "c".repeat(64),
    }));
    ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].changeState, "stable");
    assert.equal(ledger.sourceSummary.states[0].changeCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed legacy snapshots preserve the one-shot migration retry", async () => {
  const fixture = await createFixture([]);
  const legacySnapshotPath = resolve(fixture.root, "exports", "snapshot.json");
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  const malformed = Buffer.from("{not-json\n", "utf8");
  const generatedAt = "2026-08-20T12:00:00.000Z";
  let database;
  try {
    await mkdir(dirname(legacySnapshotPath), { recursive: true });
    await writeFile(legacySnapshotPath, malformed);
    await assert.rejects(
      () => collectUsage(options(fixture, { output: legacySnapshotPath })),
      (error) => {
        assert.equal(error?.code, "ERR_DURABLE_LEDGER_LEGACY_SNAPSHOT");
        assert.ok(error.cause instanceof SyntaxError);
        return true;
      },
    );
    assert.deepEqual(await readFile(legacySnapshotPath), malformed);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 0);
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare(
      "SELECT value FROM ledger_meta WHERE key = 'legacy_snapshot_checked'",
    ).get(), undefined);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM migration_runs",
    ).get().count, 0);
    database.close();
    database = null;

    const validLegacy = legacySnapshotForFixture(fixture, {
      schemaVersion: 3,
      generatedAt,
      events: [{
        timestamp: generatedAt,
        startAt: generatedAt,
        endAt: generatedAt,
        project: "legacy-project",
        model: "gpt-5.4",
        rateCardModel: "gpt-5.4",
        effort: "medium",
        source: "local",
        useType: "interactive",
        inputTokens: 90,
        cachedInputTokens: 10,
        outputTokens: 10,
        reasoningTokens: 4,
        totalTokens: 100,
        toolCalls: 0,
        callCount: 1,
        detailedCallCount: 1,
        inputCallCount: 1,
        breakdownAvailable: true,
        threadIds: ["legacy-retry-thread"],
      }],
    });
    await writePrivateSnapshot(legacySnapshotPath, validLegacy);
    const first = await collectUsage(options(fixture, {
      output: legacySnapshotPath,
    }));
    const second = await collectUsage(options(fixture, {
      output: legacySnapshotPath,
    }));
    const ledger = await readDurableLedger(ledgerPath);
    database = new DatabaseSync(ledgerPath, { readOnly: true });

    assert.equal(totalTokens(first), 100);
    assert.equal(totalTokens(second), 100);
    assert.equal(first.metadata.durableLedger.revision, 1);
    assert.equal(second.metadata.durableLedger.revision, 2);
    assert.equal(ledger.migratedUsageRows, 1);
    assert.equal(database.prepare(
      "SELECT value FROM ledger_meta WHERE key = 'legacy_snapshot_checked'",
    ).get().value, "1");
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM migration_runs",
    ).get().count, 1);
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("readable non-v3 legacy snapshots remain retryable hard failures", async () => {
  const fixture = await createFixture([]);
  const legacySnapshotPath = resolve(fixture.root, "exports", "snapshot.json");
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await mkdir(dirname(legacySnapshotPath), { recursive: true });
    await writeFile(legacySnapshotPath, JSON.stringify({
      schemaVersion: 4,
      events: [],
    }));
    await assert.rejects(
      () => collectUsage(options(fixture, { output: legacySnapshotPath })),
      (error) => {
        assert.equal(error?.code, "ERR_DURABLE_LEDGER_LEGACY_SNAPSHOT");
        assert.match(error.message, /unsupported schema/i);
        return true;
      },
    );
    assert.equal(await readDurableLedgerRevision(ledgerPath), 0);
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare(
      "SELECT value FROM ledger_meta WHERE key = 'legacy_snapshot_checked'",
    ).get(), undefined);
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("markerless legacy quota is quarantined while usage migrates", async () => {
  const fixture = await createFixture([]);
  const generatedAt = "2026-08-20T12:00:00.000Z";
  try {
    const legacy = legacySnapshotForFixture(fixture, {
      schemaVersion: 3,
      generatedAt,
      events: [{
        timestamp: generatedAt,
        project: "legacy-project",
        model: "gpt-5.4",
        rateCardModel: "gpt-5.4",
        effort: "medium",
        source: "local",
        useType: "interactive",
        inputTokens: 90,
        cachedInputTokens: 10,
        outputTokens: 10,
        reasoningTokens: 4,
        totalTokens: 100,
        toolCalls: 0,
        callCount: 1,
        detailedCallCount: 1,
        inputCallCount: 1,
        breakdownAvailable: true,
        threadIds: [],
      }],
      quotaObservations: [
        {
          timestamp: generatedAt,
          lastSeenAt: generatedAt,
          usedPercent: 22,
          windowMinutes: 10_080,
          resetsAt: WEEKLY_RESET,
          planType: "plus",
          limitKey: stableHash("anonymous", 16),
          scope: "account",
        },
        {
          timestamp: generatedAt,
          lastSeenAt: generatedAt,
          usedPercent: 44,
          windowMinutes: 10_080,
          resetsAt: WEEKLY_RESET,
          planType: "plus",
          limitKey: stableHash("Legacy label", 16),
          limitName: "Legacy label",
          scope: "named",
        },
      ],
      threads: [],
    });
    delete legacy.metadata.durableLedger.quotaIdentityContract;
    await writePrivateSnapshot(fixture.output, legacy);

    const migrated = await collectUsage(options(fixture));
    let ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    assert.equal(totalTokens(migrated), 100);
    assert.equal(migrated.quotaObservations.length, 0);
    assert.equal(
      migrated.coverage.legacyQuotaStatus,
      "skipped-contract-unverified",
    );
    assert.equal(migrated.coverage.legacyQuotaRowsSkipped, 2);
    assert.equal(ledger.migratedUsageRows, 1);
    assert.equal(ledger.migratedQuotaRows, 0);
    assert.equal(ledger.migration.quotaRows, 0);

    await writeFile(
      fixture.file,
      serialize(rolloutRows([200], { usedPercent: 58 })),
    );
    const recovered = await collectUsage(options(fixture));
    const recoveredReload = await collectUsage(options(fixture));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    for (const snapshot of [recovered, recoveredReload]) {
      assert.deepEqual(
        snapshot.quotaObservations.map((quota) => [
          quota.limitKey,
          quota.scope,
          quota.usedPercent,
        ]),
        [[stableHash("codex", 16), "account", 58]],
      );
    }
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.migratedQuotaRows, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("malformed v3 legacy rows cannot burn the one-shot migration", async () => {
  const fixture = await createFixture([]);
  const legacySnapshotPath = resolve(fixture.root, "exports", "legacy.json");
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  const generatedAt = "2026-08-20T12:00:00.000Z";
  const validLegacy = legacySnapshotForFixture(fixture, {
    schemaVersion: 3,
    generatedAt,
    events: [{
      timestamp: generatedAt,
      project: "legacy-project",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "local",
      useType: "interactive",
      inputTokens: 90,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 100,
      toolCalls: 0,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
      threadIds: ["legacy-row-thread"],
    }],
    quotaObservations: [{
      timestamp: generatedAt,
      lastSeenAt: generatedAt,
      usedPercent: 22,
      windowMinutes: 10_080,
      resetsAt: WEEKLY_RESET,
      planType: "plus",
      limitKey: stableHash("codex", 16),
      scope: "account",
    }],
    threads: [{
      id: "legacy-row-thread",
      title: "Legacy row thread",
      project: "legacy-project",
      model: "gpt-5.4",
      effort: "medium",
      source: "local",
      useType: "interactive",
      reportedCumulativeTokens: 100,
      firstActiveAt: generatedAt,
      lastActiveAt: generatedAt,
    }],
  });
  const invalidCases = [
    ["usage event", (snapshot) => {
      snapshot.events[0].timestamp = "not-a-timestamp";
    }],
    ["null usage timestamp", (snapshot) => {
      snapshot.events[0].timestamp = null;
    }],
    ["missing usage timestamp", (snapshot) => {
      delete snapshot.events[0].timestamp;
    }],
    ["thread row", (snapshot) => {
      snapshot.threads[0] = null;
    }],
    ["thread timestamp", (snapshot) => {
      snapshot.threads[0].lastActiveAt = "not-a-timestamp";
    }],
    ["thread counter", (snapshot) => {
      snapshot.threads[0].reportedCumulativeTokens = "100";
    }],
  ];
  let stageCalls = 0;
  let database;
  try {
    await mkdir(dirname(legacySnapshotPath), { recursive: true });
    for (const [label, mutate] of invalidCases) {
      const malformed = JSON.parse(JSON.stringify(validLegacy));
      mutate(malformed);
      const bytes = Buffer.from(`${JSON.stringify(malformed)}\n`, "utf8");
      await writeFile(legacySnapshotPath, bytes);
      await assert.rejects(
        () => collectUsage(options(fixture, {
          output: legacySnapshotPath,
          stageSnapshot: async () => {
            stageCalls += 1;
            throw new Error("invalid legacy input reached snapshot staging");
          },
        })),
        (error) => {
          assert.equal(
            error?.code,
            "ERR_DURABLE_LEDGER_LEGACY_SNAPSHOT",
            label,
          );
          return true;
        },
      );
      assert.deepEqual(await readFile(legacySnapshotPath), bytes, label);
      assert.equal(await readDurableLedgerRevision(ledgerPath), 0, label);
      database = new DatabaseSync(ledgerPath, { readOnly: true });
      assert.equal(database.prepare(
        "SELECT value FROM ledger_meta WHERE key = 'legacy_snapshot_checked'",
      ).get(), undefined, label);
      assert.equal(database.prepare(
        "SELECT COUNT(*) AS count FROM migration_runs",
      ).get().count, 0, label);
      database.close();
      database = null;
    }
    assert.equal(stageCalls, 0);

    await writeFile(
      legacySnapshotPath,
      `${JSON.stringify(validLegacy)}\n`,
    );
    const first = await collectUsage(options(fixture, {
      output: legacySnapshotPath,
    }));
    const second = await collectUsage(options(fixture, {
      output: legacySnapshotPath,
    }));
    const ledger = await readDurableLedger(ledgerPath);
    database = new DatabaseSync(ledgerPath, { readOnly: true });

    assert.equal(totalTokens(first), 100);
    assert.equal(totalTokens(second), 100);
    assert.equal(first.quotaObservations.length, 1);
    assert.equal(ledger.migratedUsageRows, 1);
    assert.equal(ledger.migratedQuotaRows, 1);
    assert.equal(
      ledger.threadRows.filter((row) => row.id === "legacy-row-thread").length,
      1,
    );
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM migration_runs",
    ).get().count, 1);
    assert.equal(database.prepare(
      "SELECT value FROM ledger_meta WHERE key = 'legacy_snapshot_checked'",
    ).get().value, "1");
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("legacy usage migrates independently of invalid v2 quota claims", async () => {
  const generatedAt = "2026-08-20T12:00:00.000Z";
  const cases = [
    ["invalid-array", 0, (snapshot) => {
      snapshot.quotaObservations = {};
    }],
    ["malformed-sibling", 2, (snapshot) => {
      snapshot.quotaObservations.push({
        ...snapshot.quotaObservations[0],
        usedPercent: -1,
      });
    }],
    ["scope-key-mismatch", 1, (snapshot) => {
      snapshot.quotaObservations[0].scope = "named";
    }],
  ];
  for (const [name, rowsSkipped, mutate] of cases) {
    const fixture = await createFixture([]);
    try {
      const legacy = legacySnapshotForFixture(fixture, {
        schemaVersion: 3,
        generatedAt,
        events: [{
          timestamp: generatedAt,
          project: "legacy-project",
          model: "gpt-5.4",
          rateCardModel: "gpt-5.4",
          effort: "medium",
          source: "local",
          useType: "interactive",
          inputTokens: 90,
          cachedInputTokens: 10,
          outputTokens: 10,
          reasoningTokens: 4,
          totalTokens: 100,
          toolCalls: 0,
          callCount: 1,
          detailedCallCount: 1,
          inputCallCount: 1,
          breakdownAvailable: true,
          threadIds: [],
        }],
        quotaObservations: [{
          timestamp: generatedAt,
          lastSeenAt: generatedAt,
          usedPercent: 22,
          windowMinutes: 10_080,
          resetsAt: WEEKLY_RESET,
          planType: "plus",
          limitKey: stableHash("codex", 16),
          scope: "account",
        }],
        threads: [],
      });
      mutate(legacy);
      await writePrivateSnapshot(fixture.output, legacy);

      const first = await collectUsage(options(fixture));
      const second = await collectUsage(options(fixture));
      const ledger = await readDurableLedger(
        resolveDurableLedgerPath({ codexHome: fixture.root }),
      );
      assert.equal(totalTokens(first), 100, name);
      assert.equal(totalTokens(second), 100, name);
      assert.equal(first.quotaObservations.length, 0, name);
      assert.equal(first.coverage.legacyQuotaStatus, "skipped-invalid", name);
      assert.equal(first.coverage.legacyQuotaRowsSkipped, rowsSkipped, name);
      assert.equal(ledger.migratedUsageRows, 1, name);
      assert.equal(ledger.migratedQuotaRows, 0, name);
      assert.equal(ledger.migration.usageRows, 1, name);
      assert.equal(ledger.migration.quotaRows, 0, name);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("old v3 snapshot migration is idempotent and marks compacted estimates", async () => {
  const fixture = await createFixture([]);
  const generatedAt = "2026-08-20T12:00:00.000Z";
  const rangeStart = "2024-01-02T12:00:00.000Z";
  const rangeEnd = "2024-01-03T12:00:00.000Z";
  const legacy = {
    schemaVersion: 3,
    generatedAt,
    quotaObservations: [{
      id: "legacy-quota",
      timestamp: generatedAt,
      lastSeenAt: generatedAt,
      usedPercent: 22,
      windowMinutes: 10_080,
      resetsAt: WEEKLY_RESET,
      planType: "plus",
      limitKey: stableHash("codex", 16),
      scope: "account",
    }],
    threads: [{
      id: "legacy-thread",
      title: "Migrated thread",
      project: "legacy-project",
      model: "gpt-5.4",
      effort: "medium",
      source: "local",
      useType: "interactive",
      reportedCumulativeTokens: 100,
      firstActiveAt: rangeStart,
      lastActiveAt: rangeEnd,
    }],
    events: [{
      timestamp: rangeStart,
      startAt: rangeStart,
      endAt: rangeEnd,
      project: "legacy-project",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "local",
      useType: "interactive",
      inputTokens: 90,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 100,
      toolCalls: 0,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
      threadIds: ["legacy-thread"],
    }],
  };
  try {
    await writePrivateSnapshot(
      fixture.output,
      legacySnapshotForFixture(fixture, legacy),
    );
    const first = await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const firstLedger = await readDurableLedger(ledgerPath);
    const second = await collectUsage(options(fixture));
    const secondLedger = await readDurableLedger(ledgerPath);

    assert.equal(totalTokens(first), 100);
    assert.equal(first.coverage.migratedCompactedCalls, 1);
    assert.equal(first.coverage.migratedCompactedTokens, 100);
    assert.equal(first.coverage.completeSinceWindowStart, false);
    assert.equal(firstLedger.migration.usageRows, 1);
    assert.equal(firstLedger.migration.quotaRows, 1);
    assert.equal(firstLedger.migratedUsageRows, 1);
    assert.equal(firstLedger.usageRows[0].rangeAllocationEstimated, true);
    assert.equal(firstLedger.usageRows[0].startAt, rangeStart);
    assert.equal(firstLedger.usageRows[0].endAt, rangeEnd);
    assert.equal(second.coverage.migratedCompactedCalls, 1);
    assert.equal(secondLedger.migration.usageRows, 1);
    assert.equal(secondLedger.usageRows.length, 1);
    assert.equal(secondLedger.quotaRows.length, 1);
    assert.equal(secondLedger.threadRows[0].id, "legacy-thread");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("partial legacy overlap does not retain credits for rescanned usage", async () => {
  const fixture = await createFixture([40]);
  const legacy = {
    schemaVersion: 3,
    generatedAt: "2026-08-20T12:00:00.000Z",
    events: [{
      timestamp: "2026-08-20T09:00:00.000Z",
      startAt: "2026-08-20T09:00:00.000Z",
      endAt: "2026-08-20T12:00:00.000Z",
      project: "Unknown project",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "unknown",
      useType: "unknown",
      inputTokens: 190,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 200,
      toolCalls: 0,
      rateCardCredits: 7,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
      threadIds: [THREAD_ID],
    }],
  };
  try {
    await writePrivateSnapshot(
      fixture.output,
      legacySnapshotForFixture(fixture, legacy),
    );
    const snapshot = await collectUsage(options(fixture));
    const credits = snapshot.events.reduce(
      (sum, event) => sum + (event.rateCardCredits || 0),
      0,
    );

    assert.equal(snapshot.coverage.observedTokens, 200);
    assert.ok(credits < 7);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("streamed migrated residuals preserve long-context allocation origin", async () => {
  const fixture = await createFixture([]);
  const timestamp = "2026-08-20T10:00:00.000Z";
  const legacy = {
    schemaVersion: 3,
    generatedAt: "2026-08-20T12:00:00.000Z",
    events: [{
      timestamp: "2026-08-20T09:00:00.000Z",
      startAt: "2026-08-20T09:00:00.000Z",
      endAt: "2026-08-20T12:00:00.000Z",
      project: "Unknown project",
      model: "gpt-5.6-sol",
      rateCardModel: "gpt-5.6-sol",
      effort: "medium",
      source: "unknown",
      useType: "unknown",
      inputTokens: 300_000,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 300_010,
      toolCalls: 0,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
      threadIds: [THREAD_ID],
    }],
  };
  try {
    await writeFile(fixture.file, serialize([
      ...turnStart(timestamp, "turn-1", "gpt-5.6-sol"),
      tokenCount("2026-08-20T10:00:01.000Z", 100_010),
    ]));
    await writePrivateSnapshot(
      fixture.output,
      legacySnapshotForFixture(fixture, legacy),
    );

    await collectUsage(options(fixture));
    const streamedUsage = [];
    await updateDurableLedger({
      options: {},
      codexHome: fixture.root,
      inventory: { files: [], lifecycleFiles: [] },
      includeArchived: true,
      onMaterializedRow: ({ kind, row }) => {
        if (kind === "usage") streamedUsage.push(row);
      },
    });
    const residual = streamedUsage.find(
      (event) => event.identityKind === "migrated_compacted",
    );
    assert.ok(residual);
    const api = apiUsdForUsage(residual);

    assert.equal(residual.inputTokens, 200_000);
    assert.equal(residual.rangeAllocationOrigin.inputTokens, 300_000);
    assert.equal(api.amount, null);
    assert.deepEqual(api.reasons, ["compacted-long-context-ambiguous"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("legacy overlap subtracts rescanned observations after compaction", async () => {
  const baseTimestamp = "2015-08-20T10:00:00.000Z";
  const eventTimestamp = "2015-08-20T10:00:01.000Z";
  const fixture = await createFixture([100], { baseTimestamp });
  const legacy = {
    schemaVersion: 3,
    generatedAt: "2026-08-20T12:00:00.000Z",
    events: [{
      timestamp: eventTimestamp,
      startAt: eventTimestamp,
      endAt: eventTimestamp,
      project: "Unknown project",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "unknown",
      useType: "unknown",
      inputTokens: 90,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 100,
      toolCalls: 0,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
      threadIds: [THREAD_ID],
    }],
  };
  try {
    await writePrivateSnapshot(
      fixture.output,
      legacySnapshotForFixture(fixture, legacy),
    );
    const snapshot = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(ledger.compactedUsageRows, 1);
    assert.equal(ledger.migratedUsageRows, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only legacy migrations survive --no-archived refreshes", async () => {
  const fixture = await createFixture([]);
  const generatedAt = "2026-08-20T12:00:00.000Z";
  const legacy = {
    schemaVersion: 3,
    generatedAt,
    provenance: {
      collection: { since: null, includeArchived: false },
    },
    quotaObservations: [{
      timestamp: generatedAt,
      lastSeenAt: generatedAt,
      usedPercent: 22,
      windowMinutes: 10_080,
      resetsAt: WEEKLY_RESET,
      planType: "plus",
      limitKey: stableHash("codex", 16),
      scope: "account",
    }],
    events: [{
      timestamp: generatedAt,
      project: "active-history",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "local",
      useType: "interactive",
      inputTokens: 90,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 100,
      toolCalls: 0,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
      threadIds: ["active-history-thread"],
    }],
  };
  try {
    await writePrivateSnapshot(
      fixture.output,
      legacySnapshotForFixture(fixture, legacy),
    );
    const snapshot = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
      { includeArchived: false },
    );

    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.coverage.migratedCompactedTokens, 100);
    assert.equal(snapshot.quotaObservations.length, 1);
    assert.equal(ledger.migration.includeArchived, false);
    assert.equal(ledger.migration.collectionSince, null);
    assert.equal(ledger.migration.scopeKnown, true);
    assert.equal(ledger.migratedUsageRows, 1);
    assert.equal(ledger.migratedQuotaRows, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only migration does not subtract unrelated archived exact usage", async () => {
  const fixture = await createFixture([]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "21",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  const timestamp = "2026-08-21T10:00:01.000Z";
  const legacy = legacySnapshotForFixture(fixture, {
    schemaVersion: 3,
    generatedAt: "2026-08-22T00:00:00.000Z",
    provenance: {
      collection: { since: null, includeArchived: false },
    },
    events: [{
      timestamp,
      startAt: timestamp,
      endAt: timestamp,
      project: "Unknown project",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "unknown",
      useType: "unknown",
      inputTokens: 90,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 100,
      toolCalls: 0,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
      threadIds: ["active-history-thread"],
    }],
  });
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      serialize(rolloutRows([100], {
        baseTimestamp: "2026-08-21T10:00:00.000Z",
      })),
    );
    await writePrivateSnapshot(fixture.output, legacy);

    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const full = await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const activeLedger = await readDurableLedger(ledgerPath, {
      includeArchived: false,
    });
    const fullLedger = await readDurableLedger(ledgerPath);

    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(totalTokens(full), 200);
    assert.equal(
      activeLedger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      100,
    );
    assert.equal(
      fullLedger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      200,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only legacy migration keeps subtracting after the rollout is archived", async () => {
  const fixture = await createFixture([40]);
  const archivedFile = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
    ROLLOUT_NAME,
  );
  const eventTimestamp = "2026-08-20T10:00:01.000Z";
  const legacy = legacySnapshotForFixture(fixture, {
    schemaVersion: 3,
    generatedAt: "2026-08-20T12:00:00.000Z",
    provenance: {
      collection: { since: null, includeArchived: false },
    },
    events: [{
      timestamp: eventTimestamp,
      startAt: eventTimestamp,
      endAt: eventTimestamp,
      project: "Unknown project",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "unknown",
      useType: "unknown",
      inputTokens: 30,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 40,
      toolCalls: 0,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
      threadIds: [THREAD_ID],
    }],
  });
  try {
    await writePrivateSnapshot(fixture.output, legacy);
    const initial = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    assert.equal(totalTokens(initial), 40);

    await mkdir(dirname(archivedFile), { recursive: true });
    await rename(fixture.file, archivedFile);
    const archived = await collectUsage(options(fixture));
    const archivedLedger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const archivedMigrated = archivedLedger.usageRows.filter(
      (row) => row.identityKind === "migrated_compacted",
    );
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));

    assert.equal(totalTokens(archived), 40);
    assert.equal(totalTokens(activeOnly), 0);
    assert.ok(archivedMigrated.every((row) => row.totalTokens === 0));
    assert.equal(
      archivedLedger.sourceSummary.states[0].firstSeenLocation,
      "active",
    );
    assert.equal(archivedLedger.sourceSummary.states[0].location, "archived");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pre-fix source schema adds and backfills first-seen location", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.exec("ALTER TABLE source_state DROP COLUMN first_seen_location");
    database.close();
    database = null;

    await collectUsage(options(fixture));

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const columns = new Set(database.prepare(
      "PRAGMA table_info(source_state)",
    ).all().map((column) => String(column.name)));
    const source = database.prepare(`
      SELECT first_seen_location AS firstSeenLocation
        FROM source_state
       LIMIT 1
    `).get();
    assert.equal(columns.has("first_seen_location"), true);
    assert.equal(source.firstSeenLocation, "active");
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("legacy migration requires matching collection and Codex-home provenance", async () => {
  const fixture = await createFixture([]);
  const legacy = {
    schemaVersion: 3,
    generatedAt: "2026-08-20T12:00:00.000Z",
    provenance: {
      collection: { since: null, includeArchived: true },
    },
    events: [{
      timestamp: "2026-08-20T10:00:01.000Z",
      project: "unverified-history",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "local",
      useType: "interactive",
      inputTokens: 90,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 100,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
    }],
  };
  let database;
  try {
    await writePrivateSnapshot(fixture.output, legacy);
    const snapshot = await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const ledger = await readDurableLedger(ledgerPath);
    database = new DatabaseSync(ledgerPath, { readOnly: true });

    assert.equal(totalTokens(snapshot), 0);
    assert.equal(ledger.migration, null);
    assert.equal(ledger.legacySnapshotStatus, "codex-home-unverified");
    assert.equal(
      snapshot.coverage.legacySnapshotStatus,
      "codex-home-unverified",
    );
    assert.equal(
      snapshot.metadata.durableLedger.legacySnapshotStatus,
      "codex-home-unverified",
    );
    assert.equal(
      database.prepare(
        "SELECT value FROM ledger_meta WHERE key = 'legacy_snapshot_status'",
      ).get().value,
      "codex-home-unverified",
    );
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("collection cutoff slices migrated compacted ranges", async () => {
  const fixture = await createFixture([]);
  const legacy = {
    schemaVersion: 3,
    generatedAt: "2026-08-22T00:00:00.000Z",
    provenance: {
      collection: {
        since: "2026-08-20T00:00:00.000Z",
        includeArchived: true,
      },
    },
    events: [{
      timestamp: "2026-08-20T00:00:00.000Z",
      startAt: "2026-08-20T00:00:00.000Z",
      endAt: "2026-08-22T00:00:00.000Z",
      project: "cutoff-history",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "local",
      useType: "interactive",
      inputTokens: 190,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 200,
      toolCalls: 0,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
      threadIds: ["cutoff-thread"],
    }],
  };
  try {
    await writePrivateSnapshot(
      fixture.output,
      legacySnapshotForFixture(fixture, legacy),
    );
    const snapshot = await collectUsage(options(fixture, {
      since: "2026-08-21T00:00:00.000Z",
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.ok(Math.abs(totalTokens(snapshot) - 100) < 1e-6);
    assert.ok(Math.abs(snapshot.coverage.migratedCompactedTokens - 100) < 1e-6);
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].rangeAllocationEstimated, true);
    assert.equal(
      ledger.migration.collectionSince,
      "2026-08-20T00:00:00.000Z",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("collection cutoff retains overlapping durable quota readings", async () => {
  const fixture = await createFixture([100, 200], { usedPercent: 37 });
  const cutoff = "2026-08-20T10:00:30.000Z";
  try {
    await collectUsage(options(fixture));
    const snapshot = await collectUsage(options(fixture, { since: cutoff }));

    assert.equal(snapshot.quotaObservations.length, 1);
    assert.equal(snapshot.quotaObservations[0].timestamp, cutoff);
    assert.equal(
      snapshot.quotaObservations[0].lastSeenAt,
      "2026-08-20T10:01:01.000Z",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only quota spans exclude archived observations", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "21",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      serialize(rolloutRows([200], {
        baseTimestamp: "2026-08-21T10:00:00.000Z",
        usedPercent: 37,
      })),
    );
    const allSources = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const activeOnlySinceArchivedSample = await collectUsage(options(fixture, {
      includeArchived: false,
      since: "2026-08-21T00:00:00.000Z",
    }));

    assert.equal(
      allSources.quotaObservations[0].lastSeenAt,
      "2026-08-21T10:00:01.000Z",
    );
    assert.equal(
      activeOnly.quotaObservations[0].lastSeenAt,
      "2026-08-20T10:00:01.000Z",
    );
    assert.equal(activeOnlySinceArchivedSample.quotaObservations.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement reconciles shared quota and tool source ownership", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  const sharedCall = {
    timestamp: "2026-08-20T10:01:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: "call-shared-replacement",
    },
  };
  try {
    await appendFile(fixture.file, serialize([sharedCall]));
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(archivedFile, await readFile(fixture.file));
    await collectUsage(options(fixture));
    await writeFile(replacement, serialize(rolloutRows([200])));
    await rename(replacement, fixture.file);

    const allSources = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    await rm(archivedFile);
    const afterArchivedRemoval = await collectUsage(options(fixture));

    assert.equal(totalTokens(allSources), 300);
    assert.equal(allSources.quotaObservations.length, 1);
    assert.equal(
      allSources.events.reduce((sum, event) => sum + event.toolCalls, 0),
      1,
    );
    assert.equal(totalTokens(activeOnly), 200);
    assert.equal(activeOnly.quotaObservations.length, 0);
    assert.equal(activeOnly.events[0].toolCalls, 0);
    assert.equal(totalTokens(afterArchivedRemoval), 300);
    assert.equal(afterArchivedRemoval.quotaObservations.length, 1);
    assert.equal(
      afterArchivedRemoval.events.reduce(
        (sum, event) => sum + event.toolCalls,
        0,
      ),
      1,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement resets retained quota source bounds", async () => {
  const fixture = await createFixture([100], {
    baseTimestamp: "2026-08-21T10:00:00.000Z",
    usedPercent: 37,
  });
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    await collectUsage(options(fixture));
    await writeFile(replacement, serialize(rolloutRows([200], {
      baseTimestamp: "2026-08-20T10:00:00.000Z",
      usedPercent: 37,
    })));
    await rename(replacement, fixture.file);

    const allSources = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const allSourcesAfterOldSample = await collectUsage(options(fixture, {
      since: "2026-08-21T00:00:00.000Z",
    }));
    const afterOldSample = await collectUsage(options(fixture, {
      includeArchived: false,
      since: "2026-08-21T00:00:00.000Z",
    }));

    assert.equal(
      allSources.quotaObservations[0].lastSeenAt,
      "2026-08-20T10:00:01.000Z",
    );
    assert.equal(
      activeOnly.quotaObservations[0].lastSeenAt,
      "2026-08-20T10:00:01.000Z",
    );
    assert.equal(allSourcesAfterOldSample.quotaObservations.length, 0);
    assert.equal(afterOldSample.quotaObservations.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement prunes orphaned compacted observations", async () => {
  const baseTimestamp = "2015-08-20T10:00:00.000Z";
  const fixture = await createFixture([100, 200], { baseTimestamp });
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    const initial = await collectUsage(options(fixture));
    await writeFile(
      replacement,
      serialize(rolloutRows([100], { baseTimestamp })),
    );
    await rename(replacement, fixture.file);

    const replaced = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(initial), 300);
    assert.equal(totalTokens(replaced), 100);
    assert.equal(totalTokens(afterRemoval), 100);
    assert.equal(ledger.compactedUsageRows, 1);
    assert.equal(ledger.usageRows[0].totalTokens, 100);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("old compacted observations retain source membership without rescan double counts", async () => {
  const fixture = await createFixture([100], {
    baseTimestamp: "2015-08-20T10:00:00.000Z",
  });
  try {
    await appendFile(
      fixture.file,
      serialize([shellCall("2015-08-20T10:01:00.000Z", "call-rescan")]),
    );
    const first = await collectUsage(options(fixture));
    const second = await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const ledger = await readDurableLedger(ledgerPath);
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));

    assert.equal(first.coverage.observedTokens, 100);
    assert.equal(second.coverage.observedTokens, 100);
    assert.equal(totalToolCalls(first), 1);
    assert.equal(totalToolCalls(second), 1);
    assert.equal(ledger.compactedUsageRows, 1);
    assert.equal(ledger.usageRows[0].identityKind, "compacted");
    assert.equal(ledger.usageRows[0].sourceIds.size, 1);
    assert.equal(ledger.usageRows[0].toolCalls, 1);
    assert.deepEqual(ledger.usageRows[0].toolCallKeys, ["id|call-rescan"]);
    assert.equal(afterRemoval.coverage.observedTokens, 100);
    assert.equal(totalToolCalls(afterRemoval), 1);
    assert.equal(afterRemoval.coverage.sourceIncomplete, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unchanged compacted observations retain membership provenance", async () => {
  const fixture = await createFixture([100, 200], {
    baseTimestamp: "2015-08-20T10:00:00.000Z",
  });
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    let database = new DatabaseSync(ledgerPath, { readOnly: true });
    const before = database.prepare(`
      SELECT event_key AS eventKey, observation_id AS observationId,
             first_seen_at AS firstSeenAt
        FROM usage_compaction_membership
       ORDER BY event_key
    `).all();
    database.close();

    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const after = database.prepare(`
      SELECT event_key AS eventKey, observation_id AS observationId,
             first_seen_at AS firstSeenAt
        FROM usage_compaction_membership
       ORDER BY event_key
    `).all();
    const indexes = new Map([
      [
        "source_event_positions",
        "source_event_positions_observation",
      ],
      [
        "usage_compaction_membership",
        "usage_compaction_membership_observation",
      ],
      ["usage_sources", "usage_sources_source"],
      ["tool_sources", "tool_sources_source"],
      ["quota_sources", "quota_sources_source"],
    ]);
    for (const [table, indexName] of indexes) {
      const names = database.prepare(`PRAGMA index_list(${table})`).all()
        .map((row) => String(row.name));
      assert(names.includes(indexName), `${indexName} should index ${table}`);
    }
    database.close();

    assert.equal(before.length, 2);
    assert.deepEqual(after, before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("compacted observations retain tool-call ownership after source disappearance", async () => {
  const fixture = await createFixture([100], {
    baseTimestamp: "2015-08-20T10:00:00.000Z",
  });
  try {
    await appendFile(
      fixture.file,
      serialize([{
        timestamp: "2015-08-20T10:01:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "call-old-tool",
        },
      }]),
    );
    const first = await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(first.events[0].toolCalls, 1);
    assert.equal(ledger.usageRows[0].toolCalls, 1);
    assert.deepEqual(ledger.usageRows[0].toolCallKeys, ["id|call-old-tool"]);

    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    assert.equal(afterRemoval.events[0].toolCalls, 1);
    assert.equal(afterRemoval.threads[0].toolCalls, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only reads exclude tool calls owned only by archived sources", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  const archivedCall = {
    timestamp: "2026-08-20T10:01:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: "call-archived-only",
    },
  };
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      `${await readFile(fixture.file, "utf8")}${serialize([archivedCall])}`,
    );
    const allSources = await collectUsage(options(fixture));
    await rm(fixture.file);
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const activeOnlyLedger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
      { includeArchived: false },
    );

    assert.equal(totalTokens(allSources), 100);
    assert.equal(allSources.events[0].toolCalls, 1);
    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(activeOnly.events[0].toolCalls, 0);
    assert.deepEqual(activeOnlyLedger.usageRows[0].toolCallKeys, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only refreshes preserve archived tool ownership durably", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  const archivedCall = {
    timestamp: "2026-08-20T10:01:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: "call-archived-preserved",
    },
  };
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      `${await readFile(fixture.file, "utf8")}${serialize([archivedCall])}`,
    );
    const allSources = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const afterActiveOnlyLedger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    assert.deepEqual(
      afterActiveOnlyLedger.usageRows[0].toolCallKeys,
      ["id|call-archived-preserved"],
    );
    const archivedSourceId = afterActiveOnlyLedger.sourceSummary.states.find(
      (state) => state.location === "archived",
    )?.sourceId;
    assert.deepEqual(
      [...afterActiveOnlyLedger.toolRows[0].sourceIds].sort(),
      [archivedSourceId],
    );
    await rm(archivedFile);
    const afterArchiveRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(allSources.events[0].toolCalls, 1);
    assert.equal(activeOnly.events[0].toolCalls, 0);
    assert.deepEqual(
      ledger.usageRows[0].toolCallKeys,
      ["id|call-archived-preserved"],
    );
    assert.equal(afterArchiveRemoval.events[0].toolCalls, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only compacted reads derive tool totals from scoped memberships", async () => {
  const baseTimestamp = "2015-08-20T10:00:00.000Z";
  const fixture = await createFixture([100], { baseTimestamp });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2015",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  const archivedCall = {
    timestamp: "2015-08-20T10:01:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: "call-archived-compacted",
    },
  };
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      `${await readFile(fixture.file, "utf8")}${serialize([archivedCall])}`,
    );
    const allSources = await collectUsage(options(fixture));
    await rm(fixture.file);
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const activeOnlyLedger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
      { includeArchived: false },
    );

    assert.equal(allSources.events[0].toolCalls, 1);
    assert.equal(activeOnlyLedger.compactedUsageRows, 1);
    assert.equal(activeOnly.events[0].toolCalls, 0);
    assert.deepEqual(activeOnlyLedger.usageRows[0].toolCallKeys, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("compaction keeps active and archived source scopes filterable", async () => {
  const fixture = await createFixture([100], {
    baseTimestamp: "2015-08-20T10:00:00.000Z",
  });
  const call = (timestamp, callId) => ({
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: callId,
    },
  });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await appendFile(
      fixture.file,
      serialize([call("2015-08-20T10:01:00.000Z", "call-active")]),
    );
    await writeFile(
      archivedFile,
      serialize([
        ...rolloutRows([200], {
          offset: 10,
          baseTimestamp: "2015-08-20T10:00:00.000Z",
        }),
        call("2015-08-20T10:11:00.000Z", "call-archived"),
      ]),
    );
    const allSources = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));

    assert.equal(totalTokens(allSources), 300);
    assert.equal(allSources.events.reduce((sum, event) => sum + event.toolCalls, 0), 2);
    assert.equal(ledger.compactedUsageRows, 2);
    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(
      activeOnly.events.reduce((sum, event) => sum + event.toolCalls, 0),
      1,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a reappearing compacted member does not expose its archived siblings", async () => {
  const baseTimestamp = "2015-08-20T10:00:00.000Z";
  const fixture = await createFixture([], { baseTimestamp });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2015",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      serialize(rolloutRows([100, 200], { baseTimestamp })),
    );
    const archivedOnly = await collectUsage(options(fixture));
    let ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    assert.equal(totalTokens(archivedOnly), 300);
    assert.equal(ledger.compactedUsageRows, 1);

    await writeFile(
      fixture.file,
      serialize(rolloutRows([100], { baseTimestamp })),
    );
    const withReappearedMember = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    await rm(fixture.file);
    const retainedActiveHistory = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(totalTokens(withReappearedMember), 300);
    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(totalTokens(retainedActiveHistory), 100);
    assert.equal(ledger.compactedUsageRows, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("custom snapshot outputs never relocate SQLite state", async () => {
  const fixture = await createFixture([100]);
  const selectedDirectory = resolve(fixture.root, "shared-output");
  const selectedOutput = resolve(selectedDirectory, "snapshot.json.gz");
  const oldAdjacentLedger = `${selectedOutput}.ledger.sqlite`;
  const victim = resolve(fixture.root, "victim.sqlite");
  try {
    await mkdir(selectedDirectory, { recursive: true });
    await chmod(selectedDirectory, 0o755);
    await writeFile(victim, "unchanged", { mode: 0o644 });
    await symlink(victim, oldAdjacentLedger);
    await collectUsage(options(fixture, {
      output: selectedOutput,
      stateDirectory: undefined,
    }));

    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
    assert.equal((await stat(selectedDirectory)).mode & 0o777, 0o755);
    assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
    assert.equal(dirname(ledgerPath), fixture.stateDirectory);
    assert.equal((await lstat(oldAdjacentLedger)).isSymbolicLink(), true);
    assert.equal(await readFile(victim, "utf8"), "unchanged");
    assert.equal(
      (await readdir(selectedDirectory)).some((name) =>
        name.endsWith(".writer-lock.sqlite") ||
        name.endsWith("-wal") ||
        name.endsWith("-shm")
      ),
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("custom SQLite paths and state directories are rejected", async () => {
  const fixture = await createFixture([100]);
  const selectedDirectory = resolve(fixture.root, "shared-state");
  const selectedLedger = resolve(selectedDirectory, "custom.sqlite");
  try {
    await mkdir(selectedDirectory, { recursive: true });
    await chmod(selectedDirectory, 0o755);
    assert.throws(
      () => resolveDurableLedgerPath({ stateDirectory: selectedDirectory }),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    assert.throws(
      () => resolveDurableLedgerPath({ ledgerPath: selectedLedger }),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    await assert.rejects(
      () => readDurableLedger(selectedLedger),
      (error) => error?.code === "ERR_DURABLE_LEDGER_PATH",
    );
    assert.equal((await stat(selectedDirectory)).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(selectedDirectory), []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("caller-controlled HOME cannot relocate durable SQLite state", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-home-override-"));
  const moduleUrl = new URL("../lib/token-ledger-ledger.mjs", import.meta.url).href;
  const env = { ...process.env, HOME: root };
  delete env.NODE_TEST_CONTEXT;
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { resolveDurableLedgerPath } from ${JSON.stringify(moduleUrl)}; console.log(resolveDurableLedgerPath());`,
      ],
      { encoding: "utf8", env, timeout: 30_000 },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(
      child.stdout.trim(),
      resolve(userInfo().homedir, ".token-ledger", DURABLE_LEDGER_FILENAME),
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing app-owned private state directory is tightened to 0700", async () => {
  const fixture = await createFixture([100]);
  const output = resolve(fixture.stateDirectory, "token-ledger-snapshot-v3.json.gz");
  try {
    await mkdir(fixture.stateDirectory, { recursive: true });
    await chmod(fixture.stateDirectory, 0o755);
    await collectUsage(options(fixture, {
      output,
    }));

    assert.equal((await stat(fixture.stateDirectory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(resolveDurableLedgerPath({ codexHome: fixture.root }))).mode & 0o777,
      0o600,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("schema v1 upgrades transactionally and scrubs persisted private metadata", async () => {
  const fixture = await createFixture([100]);
  const cwdCanary = "/private/credential-path-canary";
  const remoteCanary = "https://user:secret@example.test/private.git";
  const sourceCanary = "/private/raw-source-canary.jsonl";
  const homeCanary = "/private/canonical-codex-home-canary";
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.exec(`
      DROP TABLE migration_runs;
      CREATE TABLE migration_runs (
        migration_key TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        source_label TEXT NOT NULL,
        generated_at TEXT,
        migrated_at TEXT NOT NULL,
        usage_rows INTEGER NOT NULL,
        quota_rows INTEGER NOT NULL
      ) WITHOUT ROWID;
    `);
    database.prepare(`
      UPDATE usage_observations
         SET token_cwd = ?, token_git_origin = ?, token_raw_source = ?,
             origin_cwd = ?, origin_git_origin = ?, origin_raw_source = ?
    `).run(
      cwdCanary,
      remoteCanary,
      sourceCanary,
      cwdCanary,
      remoteCanary,
      sourceCanary,
    );
    database.prepare(`
      INSERT INTO ledger_meta(key, value) VALUES ('codex_home', ?)
    `).run(homeCanary);
    database.exec("PRAGMA user_version = 1");
    database.close();
    database = null;

    await collectUsage(options(fixture));

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 3);
    const migrationColumns = new Set(database.prepare(
      "PRAGMA table_info(migration_runs)",
    ).all().map((column) => column.name));
    assert.equal(migrationColumns.has("collection_since"), true);
    assert.equal(migrationColumns.has("include_archived"), true);
    assert.equal(migrationColumns.has("scope_known"), true);
    assert.equal(migrationColumns.has("codex_home_fingerprint"), true);
    const persisted = database.prepare(`
      SELECT token_cwd AS tokenCwd, token_git_origin AS tokenGitOrigin,
             token_raw_source AS tokenRawSource, origin_cwd AS originCwd,
             origin_git_origin AS originGitOrigin,
             origin_raw_source AS originRawSource
        FROM usage_observations
       LIMIT 1
    `).get();
    assert.deepEqual({ ...persisted }, {
      tokenCwd: "",
      tokenGitOrigin: null,
      tokenRawSource: null,
      originCwd: null,
      originGitOrigin: null,
      originRawSource: null,
    });
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM ledger_meta WHERE key = 'codex_home'",
      ).get().count,
      0,
    );
    assert.match(
      database.prepare(
        "SELECT value FROM ledger_meta WHERE key = 'codex_home_fingerprint'",
      ).get().value,
      /^[0-9a-f]{64}$/,
    );
    database.close();
    database = null;

    const storedBytes = await readFile(ledgerPath, "utf8");
    for (const canary of [cwdCanary, remoteCanary, sourceCanary, homeCanary]) {
      assert.equal(storedBytes.includes(canary), false);
    }
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unscoped early-v1 migrated history is rejected without mutation", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.exec(`
      DROP TABLE migration_runs;
      CREATE TABLE migration_runs (
        migration_key TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        source_label TEXT NOT NULL,
        generated_at TEXT,
        migrated_at TEXT NOT NULL,
        usage_rows INTEGER NOT NULL,
        quota_rows INTEGER NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO migration_runs (
        migration_key, source_fingerprint, source_label, generated_at,
        migrated_at, usage_rows, quota_rows
      ) VALUES (
        'snapshot-v3-default', 'legacy-fingerprint', 'legacy-snapshot',
        '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z', 1, 0
      );
      PRAGMA user_version = 1;
    `);
    database.close();
    database = null;
    const before = await readFile(ledgerPath);

    await assert.rejects(
      collectUsage(options(fixture)),
      (error) => {
        assert.equal(error?.code, "ERR_DURABLE_LEDGER_MIGRATION_SCOPE");
        assert.match(error.message, /ledger was left untouched/i);
        assert.match(error.message, /keep it as a backup/i);
        return true;
      },
    );

    assert.deepEqual(await readFile(ledgerPath), before);
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(
      new Set(database.prepare("PRAGMA table_info(migration_runs)").all()
        .map((column) => column.name)).has("include_archived"),
      false,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM migration_runs").get().count,
      1,
    );
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("scoped v1 migration records upgrade without changing exact totals", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.exec(`
      DROP TABLE migration_runs;
      CREATE TABLE migration_runs (
        migration_key TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        source_label TEXT NOT NULL,
        generated_at TEXT,
        migrated_at TEXT NOT NULL,
        include_archived INTEGER NOT NULL,
        usage_rows INTEGER NOT NULL,
        quota_rows INTEGER NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO migration_runs (
        migration_key, source_fingerprint, source_label, generated_at,
        migrated_at, include_archived, usage_rows, quota_rows
      ) VALUES (
        'snapshot-v3-default', 'legacy-fingerprint', 'legacy-snapshot',
        '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z', 0, 0, 0
      );
      PRAGMA user_version = 1;
    `);
    database.close();
    database = null;

    const snapshot = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(totalTokens(snapshot), 100);
    assert.equal(ledger.revision, 2);
    assert.equal(ledger.migration.includeArchived, false);
    assert.equal(ledger.migration.collectionSince, null);
    assert.equal(ledger.migration.scopeKnown, false);
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 3);
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("archive source classification normalizes path separators", () => {
  assert.equal(
    sourceLocationForPath(
      "C:\\Users\\tester\\.codex",
      "C:\\Users\\tester\\.codex/archived_sessions\\2026\\rollout.jsonl",
    ),
    "archived",
  );
  assert.equal(
    sourceLocationForPath(
      "/tmp/codex",
      "/tmp/codex/sessions/2026/rollout.jsonl",
    ),
    "active",
  );
});

test("durable storage and exported snapshots keep privacy and permissions", async () => {
  const fixture = await createFixture([100]);
  const secretPrompt = "do not export this prompt";
  const cwdCanary = "/private/new-write-cwd-canary";
  const remoteCanary = "https://user:secret@example.test/new-write.git";
  const sourceCanary = "/private/new-write-source-canary.jsonl";
  let database;
  try {
    await writeFile(
      fixture.file,
      serialize([
        {
          timestamp: BASE_TIMESTAMP,
          type: "session_meta",
          payload: {
            id: THREAD_ID,
            source: sourceCanary,
            cwd: cwdCanary,
            git: { repository_url: remoteCanary },
          },
        },
        ...rolloutRows([100]),
        {
          timestamp: BASE_TIMESTAMP,
          type: "event_msg",
          payload: {
            type: "message",
            message: secretPrompt,
            cwd: fixture.root,
          },
        },
      ]),
    );
    const snapshot = await collectUsage(options(fixture));
    const writeResult = await writePrivateSnapshot(fixture.output, snapshot);
    const encoded = await readFile(fixture.output, "utf8");
    const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });

    assert.equal(writeResult.snapshot.coverage.observedTokens, 100);
    assert.equal(encoded.includes(fixture.root), false);
    assert.equal(encoded.includes(secretPrompt), false);
    assert.equal(encoded.includes(cwdCanary), false);
    assert.equal(encoded.includes(remoteCanary), false);
    assert.equal(encoded.includes(sourceCanary), false);
    assert.equal((await stat(fixture.stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
    assert.equal((await stat(fixture.output)).mode & 0o777, 0o600);
    assert.equal(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
      resolve(fixture.stateDirectory, DURABLE_LEDGER_FILENAME),
    );
    assert.deepEqual(
      (await readPrivateSnapshot(fixture.output)).coverage.observedTokens,
      100,
    );
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const persisted = database.prepare(`
      SELECT token_cwd AS tokenCwd, token_git_origin AS tokenGitOrigin,
             token_raw_source AS tokenRawSource
        FROM usage_observations
       LIMIT 1
    `).get();
    assert.deepEqual({ ...persisted }, {
      tokenCwd: "",
      tokenGitOrigin: null,
      tokenRawSource: null,
    });
    database.close();
    database = null;
    const storedBytes = await readFile(ledgerPath, "utf8");
    assert.equal(storedBytes.includes(cwdCanary), false);
    assert.equal(storedBytes.includes(remoteCanary), false);
    assert.equal(storedBytes.includes(sourceCanary), false);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        assert.equal((await stat(`${ledgerPath}${suffix}`)).mode & 0o777, 0o600);
      } catch (error) {
        assert.equal(error.code, "ENOENT");
      }
    }
  } finally {
    database?.close();
    await chmod(fixture.file, 0o600).catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});
