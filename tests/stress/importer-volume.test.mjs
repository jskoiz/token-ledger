import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  readPrivateSnapshot,
  writePrivateSnapshot,
} from "../../lib/token-ledger-snapshot.mjs";
import {
  buildUsageBuckets,
  SNAPSHOT_SCHEMA_VERSION,
  usageBucketStats,
} from "../../lib/token-ledger-usage.mjs";

const LATEST_TIMESTAMP_MS = Date.parse("2026-08-22T12:00:00.000Z");

function denseRow(index) {
  return {
    timestamp: new Date(LATEST_TIMESTAMP_MS - index * 1_000).toISOString(),
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
  };
}

test("high-volume recent history compacts before bucket memory grows without losing totals", () => {
  const rows = Array.from({ length: 50_100 }, (_, index) => denseRow(index));
  const buckets = buildUsageBuckets(rows, { latestTimestampMs: LATEST_TIMESTAMP_MS });
  const stats = usageBucketStats(buckets);

  assert.ok(stats.bucketCount < 1_000);
  assert.equal(stats.callCount, rows.length);
  assert.ok(stats.maximumResolutionSeconds >= 300);
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
    501_000,
  );
});

test("adaptive snapshot writing coarsens a large event set within byte targets", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-snapshot-volume-"));
  const output = resolve(root, "snapshot.json.gz");
  try {
    const events = Array.from({ length: 2_000 }, (_, index) => ({
      ...denseRow(index),
      timestamp: new Date(
        Date.parse("2026-08-22T10:00:00.000Z") + index * 1_000,
      ).toISOString(),
      threadId: `thread-${index % 10}`,
      toolCalls: index % 2,
    }));
    const source = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      generatedAt: "2026-08-22T12:00:00.000Z",
      coverage: {},
      threads: [],
      events,
    };
    const result = await writePrivateSnapshot(output, source, {
      maxBytes: 64 * 1_024,
      targetBytes: 4 * 1_024,
    });
    const stored = await readPrivateSnapshot(output);
    const storedBytes = (await readFile(output)).byteLength;
    const stats = usageBucketStats(stored.events);

    assert.ok(result.adaptiveResolutionSeconds >= 300);
    assert.ok(storedBytes <= result.targetBytes);
    assert.equal(stats.callCount, events.length);
    assert.equal(
      stored.events.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
      20_000,
    );
    assert.equal(stored.storage.modelCalls, events.length);
    assert.equal(stored.coverage.usageBucketCount, stored.events.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
