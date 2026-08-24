import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { collectUsage } from "../lib/token-ledger-importer.mjs";
import {
  DEFAULT_SNAPSHOT_MAX_BYTES,
  readPrivateSnapshot,
  writePrivateSnapshot,
} from "../lib/token-ledger-snapshot.mjs";
import {
  buildUsageBuckets,
  normalizeTokenUsage,
  SNAPSHOT_SCHEMA_VERSION,
  splitUsageBucketsAtBoundaries,
  usageBuckets,
  usageBucketStats,
} from "../lib/token-ledger-usage.mjs";

function tokenCount(timestamp, total, last) {
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
        model_context_window: 128000,
      },
    },
  };
}

function serialize(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

test("empty thread settings reset the service tier for the next turn", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-importer-"));
  const threadId = "11111111-1111-4111-8111-111111111111";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    const firstTimestamp = "2026-08-18T10:00:00.000Z";
    const secondTimestamp = "2026-08-18T10:01:00.000Z";
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        {
          timestamp: firstTimestamp,
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
            started_at: Date.parse(firstTimestamp) / 1000,
          },
        },
        {
          timestamp: firstTimestamp,
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: {
              model: "gpt-5.5",
              reasoning_effort: "medium",
              service_tier: "priority",
            },
          },
        },
        {
          timestamp: firstTimestamp,
          type: "turn_context",
          payload: {
            turn_id: "turn-1",
            model: "gpt-5.5",
            effort: "medium",
          },
        },
        tokenCount("2026-08-18T10:00:01.000Z", 100, 100),
        {
          timestamp: secondTimestamp,
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-2",
            started_at: Date.parse(secondTimestamp) / 1000,
          },
        },
        {
          timestamp: secondTimestamp,
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: {
              model: "gpt-5.5",
              reasoning_effort: "medium",
              service_tier: "",
            },
          },
        },
        {
          timestamp: secondTimestamp,
          type: "turn_context",
          payload: {
            turn_id: "turn-2",
            model: "gpt-5.5",
            effort: "medium",
          },
        },
        tokenCount("2026-08-18T10:01:01.000Z", 200, 100),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.events[0].serviceTier, "priority");
    assert.equal(snapshot.events[1].serviceTier, null);
    assert.ok(
      Math.abs(
        snapshot.events[0].rateCardCredits -
          snapshot.events[1].rateCardCredits * 1.5,
      ) < 0.000001,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports clamp token subsets and price whitespace model names", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-importer-"));
  const threadId = "33333333-3333-4333-8333-333333333333";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "19");
    await mkdir(rolloutDirectory, { recursive: true });
    const timestamp = "2026-08-19T09:00:00.000Z";
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        {
          timestamp,
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
            started_at: Date.parse(timestamp) / 1000,
          },
        },
        {
          timestamp,
          type: "turn_context",
          payload: {
            turn_id: "turn-1",
            model: "gpt-5.4 mini",
            effort: "medium",
          },
        },
        {
          timestamp: "2026-08-19T09:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 90,
                cached_input_tokens: 500,
                output_tokens: 10,
                reasoning_output_tokens: 40,
                total_tokens: 100,
              },
              last_token_usage: {
                input_tokens: 90,
                cached_input_tokens: 500,
                output_tokens: 10,
                reasoning_output_tokens: 40,
                total_tokens: 100,
              },
              model_context_window: 128000,
            },
          },
        },
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.events.length, 1);
    const event = snapshot.events[0];
    assert.equal(event.model, "gpt-5.4-mini");
    assert.equal(event.cachedInputTokens, 90);
    assert.equal(event.reasoningTokens, 10);
    // Priced at the mini rate: (90 cached × 1.875 + 10 output × 113) per 1M.
    assert.ok(Math.abs(event.rateCardCredits - 0.00129875) < 1e-9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private snapshots replace atomically and enforce mode 0600", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-write-"));
  try {
    const output = resolve(root, "snapshot.json");
    await writeFile(output, "old\n");
    await chmod(output, 0o644);
    await writePrivateSnapshot(output, { events: [], synthetic: true });

    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      events: [],
      synthetic: true,
    });
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gzip snapshots are compact, readable, atomic, and private", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-gzip-write-"));
  try {
    const output = resolve(root, "snapshot.json.gz");
    const snapshot = {
      generatedAt: "2026-08-22T00:00:00.000Z",
      events: Array.from({ length: 1_000 }, (_, index) => ({
        id: `event-${index}`,
        timestamp: "2026-08-22T00:00:00.000Z",
        project: "repeated-project",
        model: "gpt-5.6-sol",
        totalTokens: index + 1,
      })),
    };

    const result = await writePrivateSnapshot(output, snapshot);
    const encoded = await readFile(output);

    assert.deepEqual([...encoded.subarray(0, 2)], [0x1f, 0x8b]);
    assert.deepEqual(await readPrivateSnapshot(output), snapshot);
    assert.equal(result.encoding, "gzip");
    assert.equal(result.bytesWritten, encoded.byteLength);
    assert.ok(result.bytesWritten < result.jsonBytes / 4);
    assert.equal(result.maxBytes, DEFAULT_SNAPSHOT_MAX_BYTES);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot reader rejects compressed inputs above the pre-read limit", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-gzip-read-size-"));
  try {
    const output = resolve(root, "oversized.json.gz");
    await writeFile(output, Buffer.alloc(1_025, 0));

    await assert.rejects(
      () => readPrivateSnapshot(output, {
        maxBytes: 1_024,
        maxJsonBytes: 4_096,
      }),
      (error) => {
        assert.equal(error.code, "ERR_SNAPSHOT_SIZE_LIMIT");
        assert.match(error.message, /compressed read limit/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot reader bounds gzip expansion and preserves valid reads", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-gzip-read-json-"));
  try {
    const output = resolve(root, "snapshot.json.gz");
    const snapshot = { label: "x".repeat(4_096), events: [] };
    const encoded = gzipSync(Buffer.from(JSON.stringify(snapshot)));
    await writeFile(output, encoded);

    await assert.rejects(
      () => readPrivateSnapshot(output, {
        maxBytes: encoded.byteLength + 1,
        maxJsonBytes: 1_024,
      }),
      (error) => {
        assert.equal(error.code, "ERR_SNAPSHOT_SIZE_LIMIT");
        assert.match(error.message, /expands beyond the .* JSON read limit/);
        return true;
      },
    );
    assert.deepEqual(
      await readPrivateSnapshot(output, {
        maxBytes: encoded.byteLength + 1,
        maxJsonBytes: 8_192,
      }),
      snapshot,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot size limit preserves the previous cache", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-size-limit-"));
  try {
    const output = resolve(root, "snapshot.json.gz");
    await writeFile(output, "previous-cache\n");

    await assert.rejects(
      () => writePrivateSnapshot(
        output,
        {
          events: Array.from({ length: 100 }, (_, index) => ({
            id: `event-${index}-${"x".repeat(index + 1)}`,
          })),
        },
        { maxBytes: 1 },
      ),
      /exceeding the .* safety limit/,
    );

    assert.equal(await readFile(output, "utf8"), "previous-cache\n");
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expanded JSON limit preserves the previous compressed cache", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-json-limit-"));
  try {
    const output = resolve(root, "snapshot.json.gz");
    await writeFile(output, "previous-cache\n");

    await assert.rejects(
      () => writePrivateSnapshot(
        output,
        {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          coverage: {},
          label: "x".repeat(5_000),
          events: [],
        },
        {
          maxBytes: 64 * 1_024,
          targetBytes: 64 * 1_024,
          maxJsonBytes: 1_024,
          targetJsonBytes: 512,
        },
      ),
      /exceeding the .* in-memory safety limit/,
    );

    assert.equal(await readFile(output, "utf8"), "previous-cache\n");
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage buckets preserve additive totals across age tiers", () => {
  const latestTimestampMs = Date.parse("2026-08-22T12:00:00.000Z");
  const rows = [
    ["2026-08-22T11:59:58.000Z", "recent-a", 10],
    ["2026-08-22T11:59:59.000Z", "recent-b", 20],
    ["2026-08-19T10:00:01.000Z", "minute-a", 30],
    ["2026-08-19T10:00:20.000Z", "minute-b", 40],
    ["2026-07-10T10:01:00.000Z", "hour-a", 50],
    ["2026-07-10T10:40:00.000Z", "hour-b", 60],
    ["2025-06-01T10:00:00.000Z", "day-a", 70],
    ["2025-06-01T18:00:00.000Z", "day-b", 80],
  ].map(([timestamp, threadId, totalTokens]) => ({
    timestamp,
    threadId,
    project: "bounded-history",
    model: "gpt-5.6-luna",
    effort: "medium",
    source: "desktop",
    useType: "interactive",
    serviceTier: null,
    inputTokens: totalTokens - 2,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 1,
    totalTokens,
    toolCalls: 1,
    rateCardCredits: totalTokens / 1_000,
    breakdownAvailable: true,
  }));

  const buckets = buildUsageBuckets(rows, { latestTimestampMs });
  const stats = usageBucketStats(buckets);
  assert.equal(stats.bucketCount, 5);
  assert.equal(stats.callCount, rows.length);
  assert.equal(stats.maximumResolutionSeconds, 86_400);
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
    rows.reduce((sum, row) => sum + row.totalTokens, 0),
  );
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.cacheWriteInputTokens, 0),
    rows.length,
  );
  assert.deepEqual(
    buckets.flatMap((bucket) => bucket.threadIds).sort(),
    rows.map((row) => row.threadId).sort(),
  );
});

test("usage buckets cap safe aggregates and exclude invalid totals", () => {
  const large = 5_000_000_000_000_000;
  const rows = [
    {
      timestamp: "2026-08-22T11:59:58.000Z",
      project: "bounded-history",
      model: "gpt-5.6-luna",
      inputTokens: large - 10,
      cachedInputTokens: large - 20,
      outputTokens: 10,
      reasoningTokens: 5,
      totalTokens: large,
      breakdownAvailable: true,
    },
    {
      timestamp: "2026-08-22T11:59:59.000Z",
      project: "bounded-history",
      model: "gpt-5.6-luna",
      inputTokens: large - 10,
      cachedInputTokens: large - 20,
      outputTokens: 10,
      reasoningTokens: 5,
      totalTokens: large,
      breakdownAvailable: true,
    },
    {
      timestamp: "2026-08-22T12:00:00.000Z",
      project: "bounded-history",
      model: "gpt-5.6-luna",
      inputTokens: "malformed",
      outputTokens: 10,
      totalTokens: 100,
      breakdownAvailable: true,
    },
    {
      timestamp: "2026-08-22T12:00:01.000Z",
      project: "bounded-history",
      model: "gpt-5.6-luna",
      inputTokens: 90,
      outputTokens: 10,
      totalTokens: "100",
      breakdownAvailable: true,
    },
  ];

  const buckets = buildUsageBuckets(rows, {
    latestTimestampMs: Date.parse("2026-08-22T12:00:01.000Z"),
    policy: [{ maximumAgeMs: Infinity, resolutionMs: 86_400_000 }],
  });
  const capped = buckets.find(
    (bucket) => bucket.totalTokens === Number.MAX_SAFE_INTEGER,
  );
  const unknown = buckets.find((bucket) => bucket.totalTokens === 100);
  assert.equal(capped.breakdownAvailable, false);
  assert.equal(capped.inputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(capped.cachedInputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(unknown.totalTokens, 100);
  assert.equal(unknown.inputTokens, 0);
  assert.equal(usageBucketStats(buckets).callCount, 3);
  assert.ok(buckets.every((bucket) =>
    [
      bucket.inputTokens,
      bucket.cachedInputTokens,
      bucket.outputTokens,
      bucket.reasoningTokens,
      bucket.totalTokens,
    ].every(Number.isFinite)),
  );
});

test("compacted buckets split proportionally at range boundaries", () => {
  const rows = [
    ["2025-06-01T06:00:00.000Z", 70],
    ["2025-06-01T18:00:00.000Z", 80],
  ].map(([timestamp, totalTokens], index) => ({
    timestamp,
    threadId: `thread-${index}`,
    project: "boundary-history",
    model: "gpt-5.6-luna",
    effort: "medium",
    source: "desktop",
    useType: "interactive",
    serviceTier: null,
    inputTokens: totalTokens - 10,
    cachedInputTokens: 10,
    outputTokens: 10,
    totalTokens,
    callCount: 1,
    breakdownAvailable: true,
  }));
  const [bucket] = buildUsageBuckets(rows, {
    latestTimestampMs: Date.parse("2026-08-23T00:00:00.000Z"),
    policy: [{ maximumAgeMs: Infinity, resolutionMs: 86_400_000 }],
  });
  const fragments = splitUsageBucketsAtBoundaries(
    [bucket],
    [Date.parse("2025-06-01T07:00:00.000Z")],
  );

  assert.equal(fragments.length, 2);
  assert.ok(fragments.every((fragment) => fragment.rangeAllocationEstimated));
  assert.ok(fragments[0].totalTokens > 0);
  assert.ok(fragments[1].totalTokens > 0);
  assert.ok(Math.abs(
    fragments.reduce((sum, fragment) => sum + fragment.totalTokens, 0) -
      bucket.totalTokens,
  ) < 1e-9);
  assert.ok(Math.abs(
    fragments.reduce((sum, fragment) => sum + fragment.inputTokens, 0) -
      bucket.inputTokens,
  ) < 1e-9);
  assert.ok(Math.abs(
    fragments.reduce((sum, fragment) => sum + fragment.callCount, 0) -
      bucket.callCount,
  ) < 1e-9);
  const normalizedFragments = usageBuckets({ events: fragments });
  assert.ok(normalizedFragments.every((fragment) => fragment.breakdownAvailable));
});

test("estimated token components tolerate floating-point reconciliation", () => {
  const normalized = normalizeTokenUsage({
    inputTokens: 0.1,
    outputTokens: 0.5,
    totalTokens: 0.6,
    rangeAllocationEstimated: true,
    breakdownAvailable: true,
  });

  assert.equal(normalized.breakdownAvailable, true);
});

test("usage buckets omit invalid token rows before metadata consumers see them", () => {
  const rows = usageBuckets({
    events: [
      {
        timestamp: "2026-08-22T12:00:00.000Z",
        project: "malformed-project",
        threadId: "malformed-thread",
        totalTokens: "not-a-token-count",
      },
      {
        timestamp: "2026-08-22T12:01:00.000Z",
        project: "valid-project",
        threadId: "valid-thread",
        totalTokens: 10,
        inputTokens: 10,
        outputTokens: 0,
      },
    ],
  });

  assert.deepEqual(
    rows.map(({ project, threadId }) => ({ project, threadId })),
    [{ project: "valid-project", threadId: "valid-thread" }],
  );
});

test("dense recent usage compacts during collection before memory grows unbounded", () => {
  const latestTimestampMs = Date.parse("2026-08-22T12:00:00.000Z");
  const rows = Array.from({ length: 50_100 }, (_, index) => ({
    timestamp: new Date(latestTimestampMs - index).toISOString(),
    threadId: `thread-${index % 10}`,
    project: "dense-history",
    model: "gpt-5.6-luna",
    effort: "medium",
    source: "desktop",
    useType: "interactive",
    serviceTier: null,
    inputTokens: 9,
    cachedInputTokens: 4,
    cacheWriteInputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 0,
    totalTokens: 10,
    toolCalls: 0,
    rateCardCredits: 0.001,
    breakdownAvailable: true,
  }));

  const buckets = buildUsageBuckets(rows, { latestTimestampMs });
  const stats = usageBucketStats(buckets);
  assert.ok(stats.bucketCount < 1_000);
  assert.equal(stats.callCount, rows.length);
  assert.ok(stats.maximumResolutionSeconds >= 300);
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
    501_000,
  );
});

test("snapshot writer coarsens toward its soft target without losing totals", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-adaptive-write-"));
  try {
    const output = resolve(root, "snapshot.json.gz");
    const snapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      generatedAt: "2026-08-22T12:00:00.000Z",
      coverage: {},
      threads: [],
      events: Array.from({ length: 2_000 }, (_, index) => ({
        timestamp: new Date(
          Date.parse("2026-08-22T10:00:00.000Z") + index * 1_000,
        ).toISOString(),
        threadId: `thread-${index % 10}`,
        project: "adaptive-history",
        model: "gpt-5.6-luna",
        effort: "medium",
        source: "desktop",
        useType: "interactive",
        serviceTier: null,
        inputTokens: 9,
        cachedInputTokens: 4,
        cacheWriteInputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 10,
        toolCalls: index % 2,
        rateCardCredits: 0.001,
        breakdownAvailable: true,
      })),
    };

    const result = await writePrivateSnapshot(output, snapshot, {
      maxBytes: 64 * 1_024,
      targetBytes: 4 * 1_024,
    });
    const stored = await readPrivateSnapshot(output);
    const stats = usageBucketStats(stored.events);
    assert.ok(result.adaptiveResolutionSeconds >= 300);
    assert.ok(result.bytesWritten <= result.targetBytes);
    assert.equal(stats.callCount, snapshot.events.length);
    assert.equal(
      stored.events.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
      20_000,
    );
    assert.equal(stored.storage.modelCalls, snapshot.events.length);
    assert.equal(stored.coverage.usageBucketCount, stored.events.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function turnStart(timestamp, turnId, model = "gpt-5.5") {
  return [
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId,
        started_at: Date.parse(timestamp) / 1000,
      },
    },
    {
      timestamp,
      type: "turn_context",
      payload: { turn_id: turnId, model, effort: "medium" },
    },
  ];
}

test("source labels resolve structured, encoded, and plain thread sources", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-importer-"));
  const parentId = "99999999-9999-4999-8999-999999999999";
  const threads = [
    {
      id: "44444444-4444-4444-8444-444444444444",
      turn: "turn-a",
      timestamp: "2026-08-18T10:00:00.000Z",
      total: 100,
      source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
      expected: { source: "subagent", useType: "subagent" },
    },
    {
      id: "55555555-5555-4555-8555-555555555555",
      turn: "turn-b",
      timestamp: "2026-08-18T11:00:00.000Z",
      total: 200,
      source: "exec",
      expected: { source: "cli", useType: "cli" },
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      turn: "turn-c",
      timestamp: "2026-08-18T12:00:00.000Z",
      total: 300,
      source: '{"subagent":{"id":"delegated"}}',
      expected: { source: "subagent", useType: "subagent" },
    },
    {
      id: "77777777-7777-4777-8777-777777777777",
      turn: "turn-d",
      timestamp: "2026-08-18T13:00:00.000Z",
      total: 400,
      source: "a custom launcher label that runs far past forty characters",
      expected: {
        source: "a custom launcher label that runs far pa",
        useType: "interactive",
      },
    },
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      turn: "turn-e",
      timestamp: "2026-08-18T14:00:00.000Z",
      total: 500,
      source: { toString: null, valueOf: null },
      expected: { source: "unknown", useType: "unknown" },
    },
  ];
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    for (const thread of threads) {
      await writeFile(
        resolve(rolloutDirectory, `rollout-${thread.id}.jsonl`),
        serialize([
          {
            timestamp: thread.timestamp,
            type: "session_meta",
            payload: { id: thread.id, source: thread.source },
          },
          ...turnStart(thread.timestamp, thread.turn),
          tokenCount(thread.timestamp, thread.total, thread.total),
        ]),
      );
    }

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.events.length, threads.length);
    for (const [index, thread] of threads.entries()) {
      assert.equal(snapshot.events[index].source, thread.expected.source);
      assert.equal(snapshot.events[index].useType, thread.expected.useType);
    }
    const subagentThread = snapshot.threads.find(
      (thread) => thread.id === threads[0].id,
    );
    assert.equal(subagentThread.parentThreadId, parentId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed usage and rate-limit payloads are ignored safely", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-importer-"));
  const threadId = "88888888-8888-4888-8888-888888888888";
  const timestamp = "2026-08-18T10:00:00.000Z";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        ...turnStart(timestamp, "turn-1"),
        {
          timestamp,
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: "garbage",
            info: { last_token_usage: "garbage", total_token_usage: 7 },
          },
        },
        {
          timestamp,
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: {
                window_minutes: 10080,
                used_percent: 12.5,
                resets_at: Date.parse("2026-08-24T00:00:00.000Z") / 1000,
              },
              plan_type: "plus",
              limit_name: "weekly",
            },
          },
        },
        tokenCount("2026-08-18T10:00:01.000Z", 100, 100),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].totalTokens, 100);
    assert.equal(snapshot.quotaObservations.length, 1);
    const quota = snapshot.quotaObservations[0];
    assert.equal(quota.usedPercent, 12.5);
    assert.equal(quota.windowMinutes, 10080);
    assert.equal(quota.planType, "plus");
    assert.equal(quota.limitName, "weekly");
    assert.equal(snapshot.coverage.parseErrors, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates token totals and preserves malformed breakdowns as unknown", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-token-validation-"));
  const threadId = "91919191-9191-4919-8919-919191919191";
  const validUsage = {
    input_tokens: 90,
    cached_input_tokens: 500,
    output_tokens: 10,
    reasoning_output_tokens: 40,
    total_tokens: 100,
  };
  const tokenRecord = (timestamp, usage) => ({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage,
        last_token_usage: usage,
        model_context_window: 128000,
      },
    },
  });
  const invalidTotals = [
    -1,
    100.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_VALUE,
    "100",
    true,
    [100],
    { value: 100 },
  ];
  const rows = [];
  for (const [index, total] of invalidTotals.entries()) {
    const timestamp = new Date(
      Date.parse("2026-08-18T10:00:00.000Z") + index * 60_000,
    ).toISOString();
    rows.push(...turnStart(timestamp, `invalid-${index}`));
    rows.push(tokenRecord(timestamp, { ...validUsage, total_tokens: total }));
  }
  const validTimestamp = "2026-08-18T20:00:00.000Z";
  rows.push(...turnStart(validTimestamp, "valid-turn"));
  rows.push(tokenRecord(validTimestamp, validUsage));
  const malformedBreakdownTimestamp = "2026-08-18T20:01:00.000Z";
  rows.push(...turnStart(malformedBreakdownTimestamp, "unknown-turn"));
  rows.push(tokenRecord(malformedBreakdownTimestamp, {
    ...validUsage,
    input_tokens: "90",
  }));

  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize(rows),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.coverage.invalidTokenRecords, invalidTotals.length);
    assert.equal(snapshot.coverage.observedModelCalls, 2);
    assert.equal(snapshot.coverage.observedTokens, 200);
    assert.equal(snapshot.coverage.detailedTokens, 100);
    assert.equal(snapshot.coverage.unknownBreakdownTokens, 100);
    assert.equal(snapshot.coverage.detailedPercent, 50);
    assert.equal(snapshot.events.length, 2);

    const validEvent = snapshot.events.find(
      (event) => event.breakdownAvailable === true,
    );
    const unknownEvent = snapshot.events.find(
      (event) => event.breakdownAvailable === false,
    );
    assert.equal(validEvent.cachedInputTokens, 90);
    assert.equal(validEvent.reasoningTokens, 10);
    assert.equal(validEvent.rateCardCredits !== null, true);
    assert.equal(unknownEvent.totalTokens, 100);
    assert.equal(unknownEvent.inputTokens, 0);
    assert.equal(unknownEvent.rateCardCredits, null);

    const [thread] = snapshot.threads;
    assert.equal(thread.totalTokens, 200);
    assert.equal(thread.detailedTokens, 100);
    assert.equal(thread.unknownBreakdownTokens, 100);
    assert.equal(thread.coverage, "partial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coverage preserves unknown totals after safe-counter saturation", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-importer-saturation-"));
  const threadId = "13131313-1313-4131-8131-131313131313";
  const firstTimestamp = "2026-08-18T21:00:00.000Z";
  const secondTimestamp = "2026-08-18T21:01:00.000Z";
  const thirdTimestamp = "2026-08-18T21:02:00.000Z";
  const huge = Number.MAX_SAFE_INTEGER;
  const totalOnlyRecord = (timestamp) => ({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: huge },
        last_token_usage: { total_tokens: huge },
        model_context_window: 128000,
      },
    },
  });

  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        ...turnStart(firstTimestamp, "saturation-detailed"),
        tokenCount(firstTimestamp, huge, huge),
        ...turnStart(secondTimestamp, "saturation-detailed-second"),
        tokenCount(secondTimestamp, huge, huge),
        ...turnStart(thirdTimestamp, "saturation-unknown"),
        totalOnlyRecord(thirdTimestamp),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    const [thread] = snapshot.threads;
    assert.equal(snapshot.coverage.observedTokens, huge);
    assert.ok(snapshot.coverage.detailedTokens < huge);
    assert.ok(snapshot.coverage.unknownBreakdownTokens < huge);
    assert.ok(
      Math.abs(snapshot.coverage.detailedPercent - (2 / 3) * 100) < 1e-12,
    );
    assert.equal(thread.unknownBreakdownTokens, huge);
    assert.equal(thread.coverage, "partial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged quota readings retain their full observed span", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-importer-"));
  const threadId = "89898989-8989-4989-8989-898989898989";
  const firstSeenAt = "2026-08-23T17:59:20.000Z";
  const lastSeenAt = "2026-08-23T18:08:57.000Z";
  const resetsAt = Date.parse("2026-08-26T10:00:00.000Z") / 1_000;
  const quotaRecord = (timestamp) => ({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: {
          window_minutes: 10_080,
          used_percent: 80,
          resets_at: resetsAt,
        },
        plan_type: "plus",
      },
    },
  });

  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "23");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        ...turnStart(firstSeenAt, "turn-1"),
        quotaRecord(firstSeenAt),
        quotaRecord(lastSeenAt),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.quotaObservations.length, 1);
    assert.equal(snapshot.quotaObservations[0].timestamp, firstSeenAt);
    assert.equal(snapshot.quotaObservations[0].lastSeenAt, lastSeenAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
