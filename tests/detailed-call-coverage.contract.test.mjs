import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUsageBuckets,
  normalizeTokenUsage,
  splitUsageBucketsAtBoundaries,
  usageCallCount,
  usageDetailedCallCount,
} from "../lib/token-ledger-usage.mjs";

const LATEST_TIMESTAMP_MS = Date.parse("2026-08-22T12:00:00.000Z");

function detailedRow(overrides = {}) {
  const totalTokens = overrides.totalTokens ?? 100;
  const inputTokens = overrides.inputTokens ?? 80;
  return {
    timestamp: new Date(LATEST_TIMESTAMP_MS).toISOString(),
    project: "coverage-contract",
    model: "gpt-5.6-luna",
    effort: "medium",
    source: "desktop",
    useType: "interactive",
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: overrides.outputTokens ?? totalTokens - inputTokens,
    reasoningTokens: 0,
    totalTokens,
    breakdownAvailable: true,
    ...overrides,
  };
}

function exactBuckets(rows) {
  return buildUsageBuckets(rows, {
    latestTimestampMs: LATEST_TIMESTAMP_MS,
    policy: [{ maximumAgeMs: Number.POSITIVE_INFINITY, resolutionMs: 0 }],
  });
}

test("total-only rows cannot report detailed calls after normalization", () => {
  const normalized = normalizeTokenUsage({
    ...detailedRow({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 100,
      callCount: 3,
      detailedCallCount: 3,
      breakdownAvailable: false,
    }),
  });

  assert.equal(normalized.breakdownAvailable, false);
  assert.equal(normalized.detailedCallCount, 0);
  assert.equal(usageDetailedCallCount(normalized), 0);

  const [bucket] = exactBuckets([normalized]);
  assert.equal(bucket.breakdownAvailable, false);
  assert.equal(bucket.callCount, 3);
  assert.equal(bucket.detailedCallCount, 0);

  const oversized = normalizeTokenUsage(detailedRow({
    callCount: 4,
    detailedCallCount: 9,
  }));
  assert.equal(oversized.detailedCallCount, 4);
  assert.equal(usageDetailedCallCount(oversized), 4);
});

test("missing or malformed detailed counts retain the valid detailed fallback", () => {
  for (const detailedCallCount of [undefined, null, "legacy-value", -1, 1.5]) {
    const normalized = normalizeTokenUsage(detailedRow({
      callCount: 3,
      ...(detailedCallCount === undefined ? {} : { detailedCallCount }),
    }));

    assert.equal(normalized.breakdownAvailable, true);
    assert.equal(normalized.detailedCallCount, 3);
    assert.equal(usageDetailedCallCount(normalized), 3);
  }
});

test("explicit zero preserves known partial detailed coverage", () => {
  const normalized = normalizeTokenUsage(detailedRow({
    callCount: 4,
    detailedCallCount: 0,
  }));

  assert.equal(normalized.detailedCallCount, 0);
  assert.equal(usageDetailedCallCount(normalized), 0);
  assert.equal(exactBuckets([normalized])[0].detailedCallCount, 0);
});

test("compacted mixed coverage preserves fractional call allocations", () => {
  const rows = [
    detailedRow({
      timestamp: "2026-08-22T12:00:10.000Z",
      totalTokens: 400,
      inputTokens: 320,
      callCount: 4,
      detailedCallCount: 3,
    }),
    detailedRow({
      timestamp: "2026-08-22T12:00:40.000Z",
      totalTokens: 200,
      inputTokens: 160,
      callCount: 2,
      detailedCallCount: 0,
    }),
  ];
  const [bucket] = buildUsageBuckets(rows, {
    latestTimestampMs: LATEST_TIMESTAMP_MS,
    policy: [{ maximumAgeMs: Number.POSITIVE_INFINITY, resolutionMs: 60_000 }],
  });

  assert.equal(bucket.callCount, 6);
  assert.equal(bucket.detailedCallCount, 3);

  const boundary = Date.parse("2026-08-22T12:00:25.000Z");
  const fragments = splitUsageBucketsAtBoundaries([bucket], [boundary]);
  assert.equal(fragments.length, 2);
  assert.ok(fragments.every((fragment) => fragment.rangeAllocationEstimated));
  assert.equal(
    fragments.reduce((sum, fragment) => sum + usageCallCount(fragment), 0),
    6,
  );
  assert.equal(
    fragments.reduce((sum, fragment) => sum + usageDetailedCallCount(fragment), 0),
    3,
  );
  assert.ok(fragments.some((fragment) => fragment.detailedCallCount > 0));
  assert.ok(fragments.some((fragment) => fragment.detailedCallCount < 3));
});
