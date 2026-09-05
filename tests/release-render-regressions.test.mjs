import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUsageTrend,
  multiDayBounds,
} from "../bin/token-ledger-trend.mjs";
import {
  renderTrendImage,
} from "../bin/token-ledger-trend-image.mjs";
import {
  renderTrendPlain,
} from "../bin/token-ledger-trend-terminal.mjs";
import {
  ACCOUNT_QUOTA_LIMIT_KEY,
  QUOTA_IDENTITY_CONTRACT_VERSION,
} from "../lib/token-ledger-quota-contract.mjs";

function snapshotOf(events, quotaObservations = [], generatedAt = "2026-08-23T23:00:00.000Z") {
  return {
    schemaVersion: 3,
    generatedAt,
    provenance: { kind: "codex-local-metadata" },
    metadata: {
      durableLedger: {
        quotaIdentityContract: QUOTA_IDENTITY_CONTRACT_VERSION,
      },
    },
    coverage: { parseErrors: 0 },
    events,
    threads: [],
    quotaObservations,
  };
}

function usage(overrides = {}) {
  const totalTokens = overrides.totalTokens ?? 1_000;
  return {
    timestamp: overrides.timestamp ?? "2026-08-23T12:00:00.000Z",
    model: overrides.model ?? "gpt-5.6-luna",
    project: overrides.project ?? "release-render-regression",
    totalTokens,
    inputTokens: overrides.inputTokens ?? totalTokens,
    outputTokens: overrides.outputTokens ?? 0,
    cachedInputTokens: overrides.cachedInputTokens ?? 0,
    ...overrides,
  };
}

function quota(timestamp, usedPercent, resetsAt = "2026-08-30T12:00:00.000Z") {
  return {
    timestamp,
    usedPercent,
    windowMinutes: 10_080,
    resetsAt: Math.floor(Date.parse(resetsAt) / 1_000),
    limitName: null,
    limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
    scope: "account",
  };
}

test("aggregated image labels retain ending month and year", () => {
  const monthBounds = multiDayBounds("2026-09-28", "UTC", 60);
  const monthReport = renderTrendImage({
    snapshot: snapshotOf([
      usage({ timestamp: "2026-08-01T12:00:00.000Z", project: "cross-month" }),
    ], [], "2026-09-28T12:00:00.000Z"),
    bounds: monthBounds,
    days: 60,
    options: { imageWidth: 1_280 },
    reportTimeMs: Date.parse("2026-09-28T12:00:00.000Z"),
    sourceStatus: "explicit-snapshot",
  });

  assert.match(monthReport, />Jul 31–Aug 1<\/text>/);
  assert.doesNotMatch(monthReport, />Jul 31–1<\/text>/);

  const yearBounds = multiDayBounds("2027-01-01", "UTC", 30);
  const yearReport = renderTrendImage({
    snapshot: snapshotOf([
      usage({ timestamp: "2027-01-01T12:00:00.000Z", project: "cross-year" }),
    ], [], "2027-01-01T23:00:00.000Z"),
    bounds: yearBounds,
    days: 30,
    options: { imageWidth: 1_280 },
    reportTimeMs: Date.parse("2027-01-01T23:00:00.000Z"),
    sourceStatus: "explicit-snapshot",
  });

  assert.match(yearReport, />Dec 31 2026–Jan 1 2027<\/text>/);
});

test("narrow image axes skip crowded labels but retain the final partial bin", () => {
  const bounds = multiDayBounds("2026-09-28", "UTC", 60);
  const report = renderTrendImage({
    snapshot: snapshotOf([
      usage({ timestamp: "2026-08-01T12:00:00.000Z", project: "narrow-axis" }),
    ], [], "2026-09-28T12:00:00.000Z"),
    bounds,
    days: 60,
    options: { imageWidth: 900 },
    reportTimeMs: Date.parse("2026-09-28T12:00:00.000Z"),
    sourceStatus: "explicit-snapshot",
  });

  assert.doesNotMatch(report, />Sep 23–25<\/text>/);
  assert.match(report, />Sep 26–28<\/text>/);
  assert.doesNotMatch(report, />Sep 25–26<\/text>/);
  assert.match(report, />Sep 27–28<\/text>/);
  assert.match(report, />PARTIAL<\/text>/);
});

test("drain fallback labels actual token bars in terminal and image views", () => {
  const bounds = multiDayBounds("2026-08-23", "UTC", 7);
  const snapshot = snapshotOf(
    [usage()],
    [quota("2026-08-23T12:00:00.000Z", 0)],
  );
  const trend = buildUsageTrend(snapshot, bounds);
  assert.equal(trend.available, true);
  assert.equal(trend.burnIntervals.length, 0);

  const terminal = renderTrendPlain({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { drain: true, width: 120 },
    snapshotFreshness: { status: "fresh", ageLabel: "now" },
    sourceStatus: "explicit-snapshot",
  });
  assert.match(terminal, /ACTUAL TOKENS · DRAIN UNAVAILABLE/);
  assert.match(terminal, /DRAIN UNAVAILABLE · BARS = raw local tokens/);
  assert.match(terminal, /--drain unavailable; showing raw local tokens/);
  assert.doesNotMatch(terminal, /-% row = observed drain per column/);

  const defaultTerminal = renderTrendPlain({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { width: 120 },
    snapshotFreshness: { status: "fresh", ageLabel: "now" },
    sourceStatus: "explicit-snapshot",
  });
  assert.match(defaultTerminal, /no usable meter drain observed/);
  assert.doesNotMatch(defaultTerminal, /-% row = observed drain per column/);

  const image = renderTrendImage({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { drain: true, imageWidth: 1_280 },
    reportTimeMs: Date.parse("2026-08-23T23:00:00.000Z"),
    sourceStatus: "explicit-snapshot",
  });
  assert.match(image, />DAILY TOKEN VOLUME<\/text>/);
  assert.match(image, />\(actual · --drain unavailable; raw local tokens\)<\/text>/);
  assert.doesNotMatch(image, />OBSERVED LIMIT DRAIN<\/text>/);

  const narrowImage = renderTrendImage({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { drain: true, imageWidth: 900 },
    reportTimeMs: Date.parse("2026-08-23T23:00:00.000Z"),
    sourceStatus: "explicit-snapshot",
  });
  assert.match(narrowImage, />\(actual · --drain unavailable; raw local tokens\)<\/text>/);
});

test("terminal trend discloses allocated compacted values", () => {
  const bounds = multiDayBounds("2026-08-23", "UTC", 7);
  const snapshot = snapshotOf([
    usage({
      timestamp: "2026-08-20T12:00:00.000Z",
      startAt: "2026-08-19T12:00:00.000Z",
      endAt: "2026-08-21T12:00:00.000Z",
      totalTokens: 300,
      inputTokens: 300,
    }),
  ]);

  const terminal = renderTrendPlain({
    snapshot,
    bounds,
    days: 7,
    options: { width: 120 },
    snapshotFreshness: { status: "fresh", ageLabel: "now" },
    sourceStatus: "explicit-snapshot",
  });

  assert.match(terminal, /≈ marks allocated estimates/);
  assert.match(terminal, /■ Luna ≈/);
});
