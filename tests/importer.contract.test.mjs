import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  collectUsage,
  collectUsageSequential,
  SOURCE_COLLECTION_MAX_ATTEMPTS,
  sourceInventory,
  sourceWatermarksEqual,
} from "../lib/token-ledger-importer.mjs";
import {
  buildUsageBuckets,
  SNAPSHOT_SCHEMA_VERSION,
  usageBucketStats,
} from "../lib/token-ledger-usage.mjs";

const THREAD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function serialize(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function turnStart(timestamp, turnId, model = "gpt-5.5") {
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
      payload: { turn_id: turnId, model, effort: "medium" },
    },
  ];
}

function tokenCount(timestamp, total, last = total) {
  return {
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
          input_tokens: last - 10,
          cached_input_tokens: 10,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: last,
        },
        model_context_window: 128_000,
      },
    },
  };
}

function quotaRecord(timestamp, {
  usedPercent,
  limitId = null,
  limitName = null,
} = {}) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: {
          window_minutes: 10_080,
          used_percent: usedPercent,
          resets_at: Date.parse("2026-08-25T00:00:00.000Z") / 1_000,
        },
        plan_type: "plus",
        limit_id: limitId,
        limit_name: limitName,
      },
    },
  };
}

async function createHome(prefix = "token-ledger-contract-") {
  return mkdtemp(resolve(tmpdir(), prefix));
}

async function writeRollout(root, rows, {
  threadId = THREAD_ID,
  archived = false,
  fileName = null,
} = {}) {
  const directory = resolve(
    root,
    archived ? "archived_sessions" : "sessions",
    "2026",
    "08",
    "18",
  );
  await mkdir(directory, { recursive: true });
  const path = resolve(
    directory,
    fileName || `rollout-${threadId}.jsonl`,
  );
  await writeFile(path, serialize(rows));
  return path;
}

function collectionOptions(root, overrides = {}) {
  return {
    output: resolve(root, "snapshot.json"),
    codexHome: root,
    includeArchived: true,
    since: null,
    ...overrides,
  };
}

test("collects a rollout into a private-shaped snapshot and exposes source watermarks", async () => {
  const root = await createHome();
  const timestamp = "2026-08-18T10:00:00.000Z";
  try {
    const file = await writeRollout(root, [
      {
        timestamp,
        type: "session_meta",
        payload: {
          id: THREAD_ID,
          cwd: "/Users/example/private-project",
          source: "exec",
          git: { repository_url: "git@github.com:acme/private-project.git" },
        },
      },
      ...turnStart(timestamp, "turn-1"),
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "call-1",
          arguments: { secret: "never-export-this" },
        },
      },
      tokenCount("2026-08-18T10:00:01.000Z", 100),
    ]);

    const snapshot = await collectUsage(collectionOptions(root));
    const current = await sourceInventory(root, true);
    assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.coverage.observedModelCalls, 1);
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].toolCalls, 1);
    assert.equal(snapshot.events[0].source, "cli");
    assert.equal(snapshot.threads[0].project, "acme/private-project");
    assert.ok(sourceWatermarksEqual(snapshot.sourceWatermark, current.watermark));
    assert.ok(!JSON.stringify(snapshot).includes("never-export-this"));
    assert.ok(!JSON.stringify(snapshot).includes("/Users/example/private-project"));

    await appendFile(file, "\n");
    const changed = await sourceInventory(root, true);
    assert.equal(sourceWatermarksEqual(current.watermark, changed.watermark), false);
    assert.notEqual(current.watermark.fingerprint, changed.watermark.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replaces a rollout during collection and publishes only the complete retry", async () => {
  const root = await createHome();
  const directory = resolve(root, "sessions", "2026", "08", "18");
  const path = await writeRollout(root, [
    ...turnStart("2026-08-18T10:00:00.000Z", "turn-old"),
    tokenCount("2026-08-18T10:00:01.000Z", 100),
  ]);
  const replacement = resolve(directory, "replacement.jsonl");
  let replaced = false;
  try {
    const snapshot = await collectUsage(
      collectionOptions(root),
      async ({ current }) => {
        if (current !== 1 || replaced) return;
        replaced = true;
        await writeFile(replacement, serialize([
          ...turnStart("2026-08-18T11:00:00.000Z", "turn-new"),
          tokenCount("2026-08-18T11:00:01.000Z", 300),
        ]));
        await rename(replacement, path);
      },
    );

    assert.equal(replaced, true);
    assert.equal(snapshot.coverage.observedTokens, 300);
    assert.equal(snapshot.coverage.filesScanned, 1);
    assert.equal(snapshot.events.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds retries when sources keep changing and never emits a partial snapshot", async () => {
  const root = await createHome();
  const path = await writeRollout(root, [
    ...turnStart("2026-08-18T10:00:00.000Z", "turn-1"),
    tokenCount("2026-08-18T10:00:01.000Z", 100),
  ]);
  let progressCalls = 0;
  try {
    await assert.rejects(
      () => collectUsage(
        collectionOptions(root),
        async ({ current }) => {
          if (current !== 1) return;
          progressCalls += 1;
          await appendFile(path, "\n");
        },
      ),
      (error) => {
        assert.equal(error.code, "ERR_SOURCE_CHANGED_DURING_COLLECTION");
        assert.match(error.message, /after 3 attempts/);
        return true;
      },
    );
    assert.equal(progressCalls, SOURCE_COLLECTION_MAX_ATTEMPTS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state metadata failures fall back safely while rollout totals remain additive", async (t) => {
  const cases = [
    {
      name: "missing database",
      expected: { status: "missing", reason: null, threadRows: 0, parentEdges: 0 },
      setup: async () => () => {},
    },
    {
      name: "incompatible schema",
      expected: {
        status: "unavailable",
        reason: "schema-mismatch",
        threadRows: 0,
        parentEdges: 0,
      },
      setup: async (root) => {
        const database = new DatabaseSync(resolve(root, "state_5.sqlite"));
        database.exec("CREATE TABLE unrelated_metadata (value TEXT)");
        database.close();
        return () => {};
      },
    },
    {
      name: "corrupt database",
      expected: { status: "unavailable", reason: "corrupt", threadRows: 0, parentEdges: 0 },
      setup: async (root) => {
        await writeFile(resolve(root, "state_5.sqlite"), "not a sqlite database");
        return () => {};
      },
    },
    {
      name: "busy database",
      expected: { status: "unavailable", reason: "busy", threadRows: 0, parentEdges: 0 },
      setup: async (root) => {
        const database = new DatabaseSync(resolve(root, "state_5.sqlite"));
        database.exec(
          "CREATE TABLE threads (id TEXT PRIMARY KEY); BEGIN EXCLUSIVE",
        );
        return () => {
          database.exec("ROLLBACK");
          database.close();
        };
      },
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.name, async () => {
      const root = await createHome("token-ledger-state-contract-");
      const threadId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      let release = () => {};
      try {
        release = await fixture.setup(root);
        await writeRollout(root, [
          ...turnStart("2026-08-18T10:00:00.000Z", `turn-${index}`),
          tokenCount("2026-08-18T10:00:01.000Z", 100),
        ], { threadId });
        const snapshot = await collectUsageSequential(collectionOptions(root));
        assert.equal(snapshot.coverage.observedTokens, 100);
        assert.equal(snapshot.events.length, 1);
        assert.deepEqual(snapshot.metadata.stateDatabase, fixture.expected);
      } finally {
        release();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("malformed JSONL and malformed rate limits are ignored while valid usage survives", async () => {
  const root = await createHome();
  try {
    const path = await writeRollout(root, [
      ...turnStart("2026-08-18T10:00:00.000Z", "turn-valid"),
      {
        timestamp: "2026-08-18T10:00:00.500Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: "malformed rate limits",
        },
      },
      tokenCount("2026-08-18T10:00:01.000Z", 100),
    ]);
    await writeFile(path, `{this is not JSON\n${await readFile(path, "utf8")}`);

    const snapshot = await collectUsageSequential(collectionOptions(root));
    assert.equal(snapshot.coverage.parseErrors, 1);
    assert.equal(snapshot.coverage.observedModelCalls, 1);
    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.quotaObservations.length, 0);
    assert.equal(snapshot.events.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--since filters calls and quotas and records the exact collection provenance", async () => {
  const root = await createHome();
  const cutoff = new Date("2026-08-18T12:00:00.000Z");
  try {
    await writeRollout(root, [
      ...turnStart("2026-08-18T10:00:00.000Z", "turn-old"),
      quotaRecord("2026-08-18T10:00:00.500Z", { usedPercent: 10 }),
      tokenCount("2026-08-18T10:00:01.000Z", 100),
      ...turnStart("2026-08-18T13:00:00.000Z", "turn-new"),
      quotaRecord("2026-08-18T13:00:00.500Z", { usedPercent: 20 }),
      tokenCount("2026-08-18T13:00:01.000Z", 200, 100),
    ]);
    await writeRollout(root, [
      ...turnStart("2026-08-18T13:30:00.000Z", "turn-archived"),
      tokenCount("2026-08-18T13:30:01.000Z", 300),
    ], {
      threadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      archived: true,
    });

    const snapshot = await collectUsageSequential(collectionOptions(root, {
      includeArchived: false,
      since: cutoff,
    }));
    assert.equal(snapshot.coverage.observedModelCalls, 1);
    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.threads.length, 1);
    assert.equal(snapshot.threads[0].eventCount, 1);
    assert.equal(snapshot.quotaObservations.length, 1);
    assert.equal(snapshot.quotaObservations[0].usedPercent, 20);
    assert.deepEqual(snapshot.provenance.collection, {
      since: cutoff.toISOString(),
      includeArchived: false,
    });
    assert.equal(snapshot.coverage.completeSinceWindowStart, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quota observations preserve account scope separately from named limits", async () => {
  const root = await createHome();
  try {
    await writeRollout(root, [
      ...turnStart("2026-08-17T23:59:00.000Z", "turn-quota"),
      tokenCount("2026-08-17T23:59:01.000Z", 100),
      quotaRecord("2026-08-18T00:00:00.000Z", { usedPercent: 12 }),
      quotaRecord("2026-08-18T00:01:00.000Z", {
        usedPercent: 34,
        limitId: "named-luna",
        limitName: "Luna",
      }),
    ]);

    const snapshot = await collectUsageSequential(collectionOptions(root));
    const account = snapshot.quotaObservations.find(
      (quota) => quota.scope === "account",
    );
    const named = snapshot.quotaObservations.find(
      (quota) => quota.scope === "named",
    );
    assert.equal(account.limitName, null);
    assert.equal(account.limitKey.length, 16);
    assert.equal(named.limitName, "Luna");
    assert.equal(named.limitKey.length, 16);
    assert.equal(snapshot.coverage.completeSinceWindowStart, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("untrusted token components become explicit unknown breakdowns", async () => {
  const root = await createHome();
  try {
    const malformed = tokenCount("2026-08-18T10:00:01.000Z", 100);
    malformed.payload.info.last_token_usage.input_tokens = "90";
    malformed.payload.info.last_token_usage.reasoning_output_tokens = {};
    await writeRollout(root, [
      ...turnStart("2026-08-18T10:00:00.000Z", "turn-unknown"),
      malformed,
    ]);

    const snapshot = await collectUsageSequential(collectionOptions(root));
    const [event] = snapshot.events;
    const [thread] = snapshot.threads;
    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.coverage.detailedTokens, 0);
    assert.equal(snapshot.coverage.unknownBreakdownTokens, 100);
    assert.equal(event.totalTokens, 100);
    assert.equal(event.inputTokens, 0);
    assert.equal(event.breakdownAvailable, false);
    assert.equal(event.rateCardCredits, null);
    assert.equal(thread.unknownBreakdownTokens, 100);
    assert.equal(thread.coverage, "total-only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compaction keeps additive usage totals and call counts", () => {
  const rows = [10, 20, 30].map((total, index) => ({
    timestamp: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 20_000)
      .toISOString(),
    project: "acme/project",
    model: "gpt-5.5",
    rateCardModel: "gpt-5.5",
    effort: "medium",
    source: "cli",
    useType: "cli",
    inputTokens: total - 10,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 0,
    outputTokens: 10,
    reasoningTokens: 4,
    totalTokens: total,
    toolCalls: index + 1,
    rateCardCredits: 0.01 * (index + 1),
    breakdownAvailable: true,
    threadIds: [THREAD_ID],
  }));

  const buckets = buildUsageBuckets(rows, {
    latestTimestampMs: Date.parse("2026-02-01T00:00:00.000Z"),
    policy: [{ maximumAgeMs: Number.POSITIVE_INFINITY, resolutionMs: 60_000 }],
  });
  const [bucket] = buckets;
  const stats = usageBucketStats(buckets);
  assert.equal(buckets.length, 1);
  assert.equal(stats.callCount, 3);
  assert.equal(bucket.totalTokens, 60);
  assert.equal(bucket.inputTokens, 30);
  assert.equal(bucket.outputTokens, 30);
  assert.equal(bucket.toolCalls, 6);
  assert.equal(bucket.rateCardCredits, 0.06);
  assert.deepEqual(bucket.threadIds, [THREAD_ID]);
  assert.equal(bucket.resolutionSeconds, 60);
});
