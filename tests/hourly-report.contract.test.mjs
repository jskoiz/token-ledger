import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTrendReportViewModel,
} from "../bin/token-ledger-report-data.mjs";
import {
  buildBurnHourBins,
  renderTrendImage,
} from "../bin/token-ledger-trend-image.mjs";
import { multiDayBounds } from "../bin/token-ledger-trend.mjs";
import {
  ACCOUNT_QUOTA_LIMIT_KEY,
  QUOTA_IDENTITY_CONTRACT_VERSION,
} from "../lib/token-ledger-quota-contract.mjs";

const HOUR_MS = 3_600_000;

function snapshotOf(events, generatedAt = "2026-08-23T23:59:59.000Z") {
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
    quotaObservations: [],
  };
}

function usage({
  timestamp,
  model = "gpt-5.6-luna",
  project = "hourly-report",
  totalTokens = 100,
  inputTokens = totalTokens,
  outputTokens = 0,
  cachedInputTokens = 0,
  serviceTier = null,
  ...overrides
}) {
  return {
    timestamp,
    model,
    project,
    totalTokens,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    serviceTier,
    ...overrides,
  };
}

function buildReport({
  date = "2026-08-23",
  timeZone = "UTC",
  events = [],
  reportTimeMs = null,
  generatedAt = "2026-08-23T23:59:59.000Z",
} = {}) {
  const bounds = multiDayBounds(date, timeZone, 1);
  return buildTrendReportViewModel({
    snapshot: snapshotOf(events, generatedAt),
    bounds,
    days: 1,
    reportTimeMs: reportTimeMs ?? bounds.end.getTime(),
    sourceStatus: "verified-current",
  });
}

function approximately(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-4,
    message ?? `${actual} differs from ${expected}`,
  );
}

test("1d hourly rows respect local midnight and exclusive day end", () => {
  const bounds = multiDayBounds("2026-08-23", "UTC", 1);
  const report = buildReport({
    events: [
      usage({
        timestamp: "2026-08-23T00:00:00.000Z",
        totalTokens: 100,
      }),
      usage({
        timestamp: "2026-08-24T00:00:00.000Z",
        totalTokens: 900,
      }),
    ],
  });

  assert.equal(report.meta.granularity, "hour");
  assert.equal(report.hourly.length, 24);
  assert.equal(report.hourly[0].startMs, bounds.start.getTime());
  assert.equal(report.hourly.at(-1).endMs, bounds.end.getTime());
  assert.equal(report.hourly[0].totalTokens, 100);
  assert.equal(report.hourly.at(-1).totalTokens, 0);
  assert.equal(report.summary.totalTokens, 100);
  assert.equal(
    report.hourly.reduce((sum, row) => sum + row.totalTokens, 0),
    report.summary.totalTokens,
  );
});

test("1d partial cutoff ends at the final elapsed hour without future rows", () => {
  const cutoff = Date.parse("2026-08-23T05:30:00.000Z");
  const report = buildReport({
    reportTimeMs: cutoff,
    generatedAt: "2026-08-23T05:30:00.000Z",
    events: [
      usage({
        timestamp: "2026-08-23T05:15:00.000Z",
        totalTokens: 250,
      }),
      usage({
        timestamp: "2026-08-23T06:15:00.000Z",
        totalTokens: 900,
      }),
    ],
  });

  assert.equal(report.hourly.length, 6);
  assert.equal(report.hourly.at(-1).startMs, Date.parse("2026-08-23T05:00:00.000Z"));
  assert.equal(report.hourly.at(-1).endMs, Date.parse("2026-08-23T06:00:00.000Z"));
  assert.equal(report.hourly.at(-1).observedEndMs, cutoff);
  assert.equal(report.hourly.at(-1).partial, true);
  assert.equal(report.hourly.some((row) => row.startMs >= cutoff), false);
  assert.equal(report.summary.totalTokens, 250);
});

test("hourly compacted allocation preserves model, cache, fast, and estimate totals", () => {
  const report = buildReport({
    events: [usage({
      timestamp: "2026-08-23T03:00:00.000Z",
      startAt: "2026-08-23T01:30:00.000Z",
      endAt: "2026-08-23T04:30:00.000Z",
      totalTokens: 300,
      inputTokens: 200,
      outputTokens: 100,
      cachedInputTokens: 100,
      serviceTier: "priority",
      callCount: 3,
      detailedCallCount: 3,
      inputCallCount: 3,
      breakdownAvailable: true,
    })],
  });

  assert.equal(report.summary.totalTokens, 300);
  assert.equal(report.summary.fastTokens, 300);
  assert.equal(report.summary.inputTokens, 200);
  assert.equal(report.summary.cachedInputTokens, 100);
  assert.equal(report.hourly.some((row) => row.estimated), true);
  for (const [index, expected] of [50, 100, 100, 50].entries()) {
    approximately(
      report.hourly[index + 1].totalTokens,
      expected,
      `hour ${index + 1} should receive its proportional compacted allocation`,
    );
  }
  approximately(
    report.hourly.reduce((sum, row) => sum + row.totalTokens, 0),
    report.summary.totalTokens,
  );
  approximately(
    report.hourly.reduce((sum, row) => sum + row.inputTokens, 0),
    report.summary.inputTokens,
  );
  approximately(
    report.hourly.reduce((sum, row) => sum + row.cachedInputTokens, 0),
    report.summary.cachedInputTokens,
  );
  approximately(
    report.hourly.reduce(
      (sum, row) => sum + [...row.models.values()]
        .reduce((rowTotal, model) => rowTotal + model.fastTokens, 0),
      0,
    ),
    report.summary.fastTokens,
  );
});

test("hourly rows follow 23-hour and 25-hour local DST days", () => {
  const spring = buildReport({
    date: "2026-03-08",
    timeZone: "America/New_York",
    generatedAt: "2026-03-09T04:00:00.000Z",
  });
  const fall = buildReport({
    date: "2026-11-01",
    timeZone: "America/Havana",
    generatedAt: "2026-11-02T05:00:00.000Z",
  });

  assert.equal(spring.hourly.length, 23);
  assert.equal(fall.hourly.length, 25);
  for (const report of [spring, fall]) {
    assert.ok(report.hourly.every((row) => row.endMs - row.startMs === HOUR_MS));
    assert.ok(report.hourly.every((row) => row.dateString === report.meta.startDateString));
  }
});

test("hourly drain allocation only includes the in-window share", () => {
  const startMs = Date.parse("2026-08-23T00:00:00.000Z");
  const hourRows = [0, 1, 2].map((index) => ({
    startMs: startMs + index * HOUR_MS,
    endMs: startMs + (index + 1) * HOUR_MS,
  }));
  const bins = buildBurnHourBins(
    {
      burnIntervals: [{
        startMs: startMs - HOUR_MS,
        endMs: startMs + 3 * HOUR_MS,
        contributions: { Luna: 40 },
        spansLongGap: false,
      }],
    },
    hourRows,
    startMs,
    startMs + 3 * HOUR_MS,
  );

  approximately(bins.totalPercent, 30);
  assert.deepEqual(
    bins.bins.map((bin) => bin.totalPercent),
    [10, 10, 10],
  );
});

test("1d image uses hourly usage and cache axes while multiday stays daily", () => {
  const bounds = multiDayBounds("2026-08-23", "UTC", 1);
  const snapshot = snapshotOf([
    usage({
      timestamp: "2026-08-23T02:15:00.000Z",
      totalTokens: 1_000,
      inputTokens: 800,
      outputTokens: 200,
      cachedInputTokens: 400,
    }),
  ]);
  for (const imageWidth of [900, 1_280]) {
    const image = renderTrendImage({
      snapshot,
      bounds,
      days: 1,
      options: { imageWidth },
      reportTimeMs: bounds.end.getTime(),
      sourceStatus: "verified-current",
    });
    assert.match(image, /HOURLY TOKEN VOLUME/);
    assert.match(image, /CACHE EFFICIENCY BY HOUR/);
    assert.match(image, />12:00 AM<\/text>/);
    assert.doesNotMatch(image, /NaN|Infinity/);
  }

  const cutoff = Date.parse("2026-08-23T05:30:00.000Z");
  const partialBounds = multiDayBounds("2026-08-23", "UTC", 1);
  const partialSnapshot = snapshotOf([
    usage({
      timestamp: "2026-08-23T05:15:00.000Z",
      totalTokens: 250,
    }),
  ], "2026-08-23T05:30:00.000Z");
  const partialImage = renderTrendImage({
    snapshot: partialSnapshot,
    bounds: partialBounds,
    days: 1,
    options: { imageWidth: 900 },
    reportTimeMs: cutoff,
    sourceStatus: "verified-current",
  });
  assert.match(partialImage, />PARTIAL<\/text>/);
  assert.match(partialImage, />THROUGH 5:30 AM<\/text>/);

  const peakImage = renderTrendImage({
    snapshot: snapshotOf([
      usage({
        timestamp: "2026-08-23T11:00:00.000Z",
        totalTokens: 221_000_000,
      }),
      usage({
        timestamp: "2026-08-23T02:00:00.000Z",
        totalTokens: 1_000,
      }),
    ]),
    bounds,
    days: 1,
    options: { imageWidth: 900 },
    reportTimeMs: bounds.end.getTime(),
    sourceStatus: "verified-current",
  });
  assert.match(
    peakImage,
    /data-role="bar-total-label"[^>]*>[\s\S]*>221M<\/text>/,
  );

  const multidayBounds = multiDayBounds("2026-08-23", "UTC", 2);
  const multidayImage = renderTrendImage({
    snapshot,
    bounds: multidayBounds,
    days: 2,
    options: { imageWidth: 900 },
    reportTimeMs: multidayBounds.end.getTime(),
    sourceStatus: "verified-current",
  });
  assert.match(multidayImage, /DAILY TOKEN VOLUME/);
  assert.match(multidayImage, /CACHE EFFICIENCY BY DAY/);
  assert.doesNotMatch(multidayImage, /HOURLY TOKEN VOLUME/);
});

test("hourly report meter identity remains account-scoped", () => {
  const bounds = multiDayBounds("2026-08-23", "UTC", 1);
  const snapshot = snapshotOf([]);
  snapshot.quotaObservations = [{
    timestamp: "2026-08-23T01:00:00.000Z",
    usedPercent: 10,
    windowMinutes: 10_080,
    resetsAt: Math.floor(Date.parse("2026-08-30T01:00:00.000Z") / 1_000),
    limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
    scope: "account",
  }];
  const report = buildTrendReportViewModel({
    snapshot,
    bounds,
    days: 1,
    reportTimeMs: bounds.end.getTime(),
    sourceStatus: "verified-current",
  });
  assert.equal(report.hourly.length, 24);
  assert.equal(report.meter.status, "active");
});
