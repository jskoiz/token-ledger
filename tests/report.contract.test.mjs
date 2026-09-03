import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { multiDayBounds } from "../bin/token-ledger-trend.mjs";
import {
  buildTrendReportViewModel,
  isFastMode,
  resolveEffectiveEnd,
} from "../bin/token-ledger-report-data.mjs";
import {
  renderTrendImage,
  writeTrendPng,
} from "../bin/token-ledger-trend-image.mjs";
import {
  ACCOUNT_QUOTA_LIMIT_KEY,
  QUOTA_IDENTITY_CONTRACT_VERSION,
} from "../lib/token-ledger-quota-contract.mjs";

const TIME_ZONE = "Pacific/Honolulu";
const bounds = multiDayBounds("2026-08-23", TIME_ZONE, 7);

function timestamp(day, hour, minute = 0) {
  return new Date(Date.UTC(2026, 7, day, hour + 10, minute)).toISOString();
}

function timestampMs(day, hour, minute = 0) {
  return Date.UTC(2026, 7, day, hour + 10, minute);
}

function usage(day, hour, overrides = {}) {
  const totalTokens = overrides.totalTokens ?? 1_000;
  const inputTokens = overrides.inputTokens ?? totalTokens;
  const outputTokens = overrides.outputTokens ?? totalTokens - inputTokens;
  return {
    timestamp: timestamp(day, hour, overrides.minute ?? 0),
    model: overrides.model ?? "gpt-5.6-luna",
    project: overrides.project ?? "alpha",
    serviceTier: overrides.serviceTier ?? null,
    totalTokens,
    inputTokens,
    outputTokens,
    cachedInputTokens: overrides.cachedInputTokens ?? 0,
  };
}

function quota(day, hour, usedPercent, resetsAt, limitName = null) {
  return {
    timestamp: timestamp(day, hour),
    usedPercent,
    windowMinutes: 10_080,
    resetsAt,
    limitName,
    limitKey: limitName === null ? ACCOUNT_QUOTA_LIMIT_KEY : "0123456789abcdef",
    scope: limitName === null ? "account" : "named",
  };
}

function snapshotOf(events = [], quotaObservations = [], overrides = {}) {
  return {
    schemaVersion: 3,
    generatedAt: timestamp(23, 23),
    provenance: { kind: "codex-local-metadata", rateCardAsOf: "2026-08-17" },
    metadata: {
      durableLedger: {
        quotaIdentityContract: QUOTA_IDENTITY_CONTRACT_VERSION,
      },
    },
    coverage: { parseErrors: 0 },
    events,
    threads: [],
    quotaObservations,
    ...overrides,
  };
}

function buildReport(overrides = {}) {
  return buildTrendReportViewModel({
    snapshot: snapshotOf(),
    bounds,
    days: 7,
    reportTimeMs: timestampMs(24, 5),
    sourceStatus: "verified-current",
    ...overrides,
  });
}

function resetAt(day, hour = 6) {
  return Math.floor(Date.UTC(2026, 7, day, hour) / 1_000);
}

test("report totals reconcile across daily, model, project, and token components", () => {
  const events = [
    usage(17, 8, {
      totalTokens: 1_000,
      inputTokens: 600,
      outputTokens: 400,
      cachedInputTokens: 500,
      model: "gpt-5.6-luna",
      project: "alpha",
    }),
    usage(18, 8, {
      totalTokens: 2_000,
      inputTokens: 1_500,
      outputTokens: 500,
      cachedInputTokens: 500,
      model: "gpt-5.6-sol",
      project: "beta",
    }),
    usage(19, 8, {
      totalTokens: 3_000,
      inputTokens: 2_400,
      outputTokens: 600,
      model: "gpt-5.6-terra",
      project: "gamma",
    }),
    usage(20, 8, {
      totalTokens: 4_000,
      inputTokens: 3_200,
      outputTokens: 800,
      cachedInputTokens: 1_000,
      model: "gpt-5.5",
      project: "delta",
    }),
  ];
  const vm = buildReport({ snapshot: snapshotOf(events) });

  assert.equal(vm.summary.totalTokens, 10_000);
  assert.equal(vm.summary.inputTokens, 7_700);
  assert.equal(vm.summary.outputTokens, 2_300);
  assert.equal(vm.summary.cachedInputTokens, 2_000);
  assert.equal(vm.summary.uncachedInputTokens, 5_700);
  assert.equal(vm.summary.inputTokens + vm.summary.outputTokens, vm.summary.totalTokens);
  assert.equal(vm.daily.reduce((sum, row) => sum + row.totalTokens, 0), vm.summary.totalTokens);
  assert.equal(vm.models.reduce((sum, row) => sum + row.totalTokens, 0), vm.summary.totalTokens);
  assert.equal(
    vm.projects.reduce((sum, row) => sum + row.totalTokens, 0) + vm.projectRemainder.totalTokens,
    vm.summary.totalTokens,
  );
  assert.equal(vm.daily.reduce((sum, row) => sum + row.inputTokens, 0), vm.summary.inputTokens);
  assert.equal(vm.daily.reduce((sum, row) => sum + row.outputTokens, 0), vm.summary.outputTokens);
  assert.equal(vm.daily.reduce((sum, row) => sum + row.cachedInputTokens, 0), vm.summary.cachedInputTokens);
  assert.equal(vm.models.reduce((sum, row) => sum + row.cacheInputTokens, 0), vm.summary.inputTokens);
});

test("project ranking fills five rows with four projects and a remainder", () => {
  const events = [
    usage(17, 8, {
      project: "alpha",
      model: "gpt-5.6-luna",
      totalTokens: 6_000,
    }),
    usage(18, 8, {
      project: "beta",
      model: "gpt-5.6-sol",
      totalTokens: 5_000,
    }),
    usage(19, 8, {
      project: "gamma",
      model: "gpt-5.5",
      totalTokens: 4_000,
    }),
    usage(20, 8, {
      project: "delta",
      model: "gpt-5.4",
      totalTokens: 3_000,
    }),
    usage(21, 8, {
      project: "epsilon",
      model: "gpt-daybreak-blue-latest",
      totalTokens: 2_000,
    }),
    usage(22, 8, {
      project: "zeta",
      model: "gpt-5.6-luna",
      totalTokens: 1_000,
    }),
  ];
  const vm = buildReport({ snapshot: snapshotOf(events) });

  assert.deepEqual(
    vm.projects.map((row) => row.displayProject),
    ["alpha", "beta", "gamma", "delta"],
  );
  assert.equal(vm.projectRemainder.count, 2);
  assert.equal(vm.projectRemainder.totalTokens, 3_000);
  assert.equal(vm.summary.topFourProjectTokens, 18_000);
  assert.equal(
    vm.summary.topFourProjectSharePercent,
    (18_000 / 21_000) * 100,
  );

  const report = renderTrendImage({
    snapshot: snapshotOf(events),
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
    reportTimeMs: timestampMs(23, 12),
    sourceStatus: "verified-current",
  });
  assert.match(report, />delta<\/text>/);
  assert.match(report, />2 other projects<\/text>/);
  assert.match(report, />Top 4 projects = 85\.7% of tokens<\/text>/);
  assert.equal(report.match(/data-role="project-row"/g)?.length, 5);
  assert.doesNotMatch(report, /data-kind="placeholder"/);
  const projectBaselines = [...report.matchAll(
    /data-role="project-row"[^>]*data-baseline="([^"]+)"/g,
  )].map((match) => Number(match[1]));
  const modelBaselines = [...report.matchAll(
    /data-role="model-cache-row"[^>]*data-baseline="([^"]+)"/g,
  )].map((match) => Number(match[1]));
  assert.deepEqual(projectBaselines, modelBaselines);

  const sparseReport = renderTrendImage({
    snapshot: snapshotOf(events.slice(0, 2)),
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
    reportTimeMs: timestampMs(23, 12),
    sourceStatus: "verified-current",
  });
  assert.equal(sparseReport.match(/data-role="project-row"/g)?.length, 5);
  assert.equal(sparseReport.match(/data-kind="placeholder"/g)?.length, 3);
});

test("compact KPI typography keeps long cache labels inside their card", () => {
  const report = renderTrendImage({
    snapshot: snapshotOf([
      usage(23, 10, {
        totalTokens: 9_500_000_000,
        inputTokens: 9_500_000_000,
        outputTokens: 0,
        cachedInputTokens: 9_250_000_000,
      }),
    ]),
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
    reportTimeMs: timestampMs(23, 12),
    sourceStatus: "verified-current",
  });

  assert.match(
    report,
    /data-role="kpi-unit" data-placement="stacked">[\s\S]*?>input-weighted<\/text>/,
  );
  assert.match(report, />9\.25B of 9\.50B input cached<\/text>/);
  assert.doesNotMatch(report, /input cach…/);
});

test("stacked KPI units keep subtitles and captions separated", () => {
  const report = renderTrendImage({
    snapshot: snapshotOf([
      usage(16, 10, { totalTokens: 1_000 }),
      usage(23, 10, {
        totalTokens: 999_999_000_000_000,
        inputTokens: 999_999_000_000_000,
        outputTokens: 0,
        cachedInputTokens: 999_999_000_000_000,
      }),
    ]),
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
    reportTimeMs: timestampMs(23, 12),
    sourceStatus: "verified-current",
  });

  const stackedSub = report.match(
    /data-role="kpi-sub" data-placement="stacked" data-baseline="([^"]+)"/,
  );
  const stackedCaption = report.match(
    /data-role="kpi-caption" data-placement="stacked" data-baseline="([^"]+)"/,
  );
  assert.ok(stackedSub);
  assert.ok(stackedCaption);
  assert.ok(Number(stackedCaption[1]) - Number(stackedSub[1]) >= 12);
});

test("cache efficiency is input-weighted and fast mode remains a total subset", () => {
  assert.equal(isFastMode("priority"), true);
  assert.equal(isFastMode("fast"), true);
  assert.equal(isFastMode("standard"), false);

  const events = [
    usage(17, 8, {
      totalTokens: 200,
      inputTokens: 100,
      outputTokens: 100,
      cachedInputTokens: 100,
      serviceTier: "standard",
    }),
    usage(18, 8, {
      totalTokens: 1_000,
      inputTokens: 900,
      outputTokens: 100,
      serviceTier: "priority",
    }),
    usage(19, 8, {
      totalTokens: 500,
      inputTokens: 400,
      outputTokens: 100,
      cachedInputTokens: 200,
      serviceTier: "fast",
    }),
  ];
  const vm = buildReport({ snapshot: snapshotOf(events) });

  assert.equal(vm.summary.cacheRatePercent, (300 / 1_400) * 100);
  assert.notEqual(vm.summary.cacheRatePercent, (100 + 0 + 50) / 3);
  assert.equal(vm.summary.fastTokens, 1_500);
  assert.ok(vm.summary.fastTokens <= vm.summary.totalTokens);
  for (const row of vm.models) {
    assert.ok(row.fastTokens <= row.totalTokens);
    assert.equal(row.normalTokens + row.fastTokens, row.totalTokens);
  }
});

test("model cache panel names a single overflow model", () => {
  const report = renderTrendImage({
    snapshot: snapshotOf([
      usage(17, 8, { model: "gpt-5.6-luna", totalTokens: 6_000 }),
      usage(18, 8, { model: "gpt-5.6-sol", totalTokens: 5_000 }),
      usage(19, 8, { model: "gpt-5.5", totalTokens: 4_000 }),
      usage(20, 8, { model: "gpt-auto-review", totalTokens: 3_000 }),
      usage(21, 8, { model: "gpt-5.4", totalTokens: 1_000 }),
    ]),
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
    reportTimeMs: timestampMs(23, 12),
    sourceStatus: "verified-current",
  });

  assert.match(report, />GPT-5\.4<\/text>/);
  assert.doesNotMatch(report, />1 other models<\/text>/);
});

test("prior comparison matches the equivalent partial local duration", () => {
  const vm = buildReport({
    reportTimeMs: timestampMs(23, 12),
    snapshot: snapshotOf(),
    events: [
      usage(20, 8, { totalTokens: 1_000 }),
      usage(23, 10, { totalTokens: 1_000 }),
      usage(23, 13, { totalTokens: 500_000 }),
    ],
    priorEvents: [
      usage(16, 10, { totalTokens: 500 }),
      usage(16, 13, { totalTokens: 999_999 }),
      usage(9, 9, { totalTokens: 1_000 }),
    ],
  });

  assert.equal(vm.meta.partialFinalDay, true);
  assert.equal(vm.summary.totalTokens, 2_000);
  assert.equal(vm.daily.at(-1).totalTokens, 1_000);
  assert.equal(vm.summary.priorEquivalentTokens, 500);
  assert.equal(vm.summary.totalDeltaPercent, 300);

  const withoutPrior = buildReport({
    snapshot: snapshotOf([usage(23, 10)]),
    reportTimeMs: timestampMs(23, 12),
  });
  assert.equal(withoutPrior.summary.priorEquivalentTokens, null);
  assert.equal(withoutPrior.summary.totalDeltaPercent, null);
});

test("non-current source statuses stop at the inclusive snapshot capture", () => {
  const generatedAt = timestamp(23, 9);
  const captured = usage(23, 9, { totalTokens: 1_000 });
  const afterCapture = usage(23, 10, { totalTokens: 2_000 });

  for (const sourceStatus of [
    "explicit-snapshot",
    "unchecked-cache",
    "stale-fallback",
  ]) {
    const vm = buildReport({
      snapshot: snapshotOf([captured, afterCapture], [], { generatedAt }),
      reportTimeMs: timestampMs(23, 12),
      sourceStatus,
    });
    assert.equal(vm.summary.totalTokens, 1_000, sourceStatus);
    assert.equal(vm.meta.effectiveEndMs, Date.parse(generatedAt) + 1, sourceStatus);
    assert.equal(vm.meta.sourceStatus, sourceStatus);
  }

  const current = buildReport({
    snapshot: snapshotOf([captured, afterCapture], [], { generatedAt }),
    reportTimeMs: timestampMs(23, 12),
    sourceStatus: "verified-current",
  });
  assert.equal(current.summary.totalTokens, 3_000);
  assert.equal(current.meta.effectiveEndMs, timestampMs(23, 12));
});

test("invalid source cutoffs fall back to the generated timestamp", () => {
  const generatedAt = timestamp(23, 9);
  const expected = timestampMs(23, 9) + 1;
  for (const [sourceCutoffAt, label] of [
    [null, "null"],
    [undefined, "undefined"],
    ["not-a-date", "invalid string"],
    [{}, "object"],
  ]) {
    assert.equal(
      resolveEffectiveEnd({
        snapshot: { generatedAt, provenance: { sourceCutoffAt } },
        bounds,
        reportTimeMs: timestampMs(23, 12),
        sourceStatus: "unchecked-cache",
      }),
      expected,
      label,
    );
  }

  assert.equal(
    resolveEffectiveEnd({
      snapshot: {
        generatedAt,
        provenance: { sourceCutoffAt: timestamp(23, 10) },
      },
      bounds,
      reportTimeMs: timestampMs(23, 12),
      sourceStatus: "unchecked-cache",
    }),
    timestampMs(23, 10) + 1,
  );
});

test("invalid generated timestamps fall back to report time", () => {
  const reportTimeMs = timestampMs(23, 12);
  for (const [generatedAt, label] of [
    [null, "null"],
    [undefined, "undefined"],
    ["not-a-date", "invalid string"],
    [Symbol("timestamp"), "symbol"],
  ]) {
    assert.equal(
      resolveEffectiveEnd({
        snapshot: { generatedAt, provenance: {} },
        bounds,
        reportTimeMs,
        sourceStatus: "unchecked-cache",
      }),
      reportTimeMs,
      label,
    );
  }

  for (const generatedAt of [timestamp(23, 9), timestampMs(23, 9)]) {
    assert.equal(
      resolveEffectiveEnd({
        snapshot: { generatedAt, provenance: {} },
        bounds,
        reportTimeMs,
        sourceStatus: "unchecked-cache",
      }),
      timestampMs(23, 9) + 1,
    );
  }
});

test("meter observations and line segments stop at the latest observation", () => {
  const observations = [
    quota(17, 2, 85, resetAt(20)),
    quota(18, 2, 88, resetAt(20)),
    quota(19, 2, 90, resetAt(20)),
    quota(20, 6, 5, resetAt(27)),
    quota(22, 2, 15, resetAt(27)),
    quota(22, 14, 15, resetAt(27)),
    // This reading is after the report cutoff and cannot extend the line.
    quota(23, 13, 22, resetAt(27)),
  ];
  const latestObservedMs = timestampMs(22, 14);
  const vm = buildReport({
    reportTimeMs: timestampMs(23, 12),
    snapshot: snapshotOf([usage(21, 8)], observations),
  });

  assert.equal(vm.meter.lastObservedAtMs, latestObservedMs);
  assert.equal(vm.meter.observedThroughMs, latestObservedMs);
  assert.ok(vm.meter.observations.every((point) => point.timestampMs <= latestObservedMs));
  assert.ok(vm.meter.segments.every((segment) => segment.toMs <= latestObservedMs));
});

test("report meter preserves the account selection for mixed quota pools", () => {
  const activeReset = resetAt(27);
  const accountObservations = [
    quota(20, 2, 40, activeReset),
    quota(21, 2, 50, activeReset),
  ];
  const accountMeter = buildReport({
    snapshot: snapshotOf([usage(20, 8)], accountObservations),
  }).meter;
  const mixedMeter = buildReport({
    snapshot: snapshotOf(
      [usage(20, 8)],
      [...accountObservations, quota(21, 3, 95, activeReset, "Luna")],
    ),
  }).meter;

  assert.deepEqual(mixedMeter, accountMeter);
});

test("partial, stale, and quota states keep their honesty markers", () => {
  const activeReset = resetAt(27);
  const cases = [
    {
      name: "partial current report",
      snapshot: snapshotOf([usage(23, 10)]),
      reportTimeMs: timestampMs(23, 12),
      sourceStatus: "verified-current",
      expected: { partial: true, stale: false, status: "unavailable" },
    },
    {
      name: "stale capture",
      snapshot: snapshotOf([usage(23, 9)], [], { generatedAt: timestamp(23, 9) }),
      reportTimeMs: timestampMs(24, 5),
      sourceStatus: "stale-fallback",
      expected: { partial: true, stale: true, status: "unavailable" },
    },
    {
      name: "active meter",
      snapshot: snapshotOf([], [
        quota(20, 2, 10, activeReset),
        quota(21, 2, 15, activeReset),
      ]),
      sourceStatus: "verified-current",
      expected: { partial: false, stale: false, status: "active" },
    },
    {
      name: "named-only meter is unavailable",
      snapshot: snapshotOf([], [
        quota(20, 2, 10, activeReset, "Luna"),
        quota(21, 2, 15, activeReset, "Luna"),
      ]),
      sourceStatus: "verified-current",
      expected: { partial: false, stale: false, status: "unavailable" },
    },
    {
      name: "at-risk meter",
      snapshot: snapshotOf([], [
        quota(20, 2, 40, activeReset),
        quota(22, 2, 82, activeReset),
      ]),
      sourceStatus: "verified-current",
      expected: { partial: false, stale: false, status: "at-risk" },
    },
    {
      name: "exhausted meter",
      snapshot: snapshotOf([], [
        quota(20, 2, 60, activeReset),
        quota(22, 2, 100, activeReset),
      ]),
      sourceStatus: "verified-current",
      expected: { partial: false, stale: false, status: "exhausted" },
    },
  ];

  for (const scenario of cases) {
    const vm = buildReport({
      snapshot: scenario.snapshot,
      reportTimeMs: scenario.reportTimeMs,
      sourceStatus: scenario.sourceStatus,
    });
    assert.equal(vm.meta.partialFinalDay, scenario.expected.partial, scenario.name);
    assert.equal(vm.meter.stale, scenario.expected.stale, scenario.name);
    assert.equal(vm.meter.status, scenario.expected.status, scenario.name);
    if (scenario.expected.status === "unavailable") {
      assert.equal(vm.meter.remainingPercent, null, scenario.name);
    }
  }
});

test("report image omits provenance and integrity notification badges", () => {
  const report = renderTrendImage({
    snapshot: snapshotOf([usage(23, 10)]),
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
    reportTimeMs: timestampMs(24, 5),
    sourceStatus: "unchecked-cache",
  });

  assert.doesNotMatch(report, /data-role="integrity-warning"/);
  assert.doesNotMatch(report, /PROVENANCE ·/);
  assert.doesNotMatch(report, /UNCHECKED CACHE/);
  assert.doesNotMatch(report, /COMPONENT COVERAGE/);
  assert.doesNotMatch(report, /ESTIMATED HISTORY/);
  assert.doesNotMatch(report, /LEGACY HISTORY SKIPPED/);
});

test("fast-mode hatching uses muted dark ink", () => {
  const report = renderTrendImage({
    snapshot: snapshotOf([
      usage(23, 10, { serviceTier: "priority", totalTokens: 10_000 }),
    ]),
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
    reportTimeMs: timestampMs(23, 12),
    sourceStatus: "verified-current",
  });

  assert.match(
    report,
    /id="fast-mode-hatch"[\s\S]*stroke="rgba\(14,20,32,\.48\)" stroke-width="1\.6"/,
  );
  assert.doesNotMatch(report, /stroke="rgba\(255,255,255,\.75\)"/);
});

test("bar total labels move clear of restart marker lines", () => {
  const report = renderTrendImage({
    snapshot: snapshotOf(
      [usage(20, 12, { totalTokens: 3_000_000_000 })],
      [
        quota(19, 8, 70, resetAt(26, 22)),
        quota(19, 9, 71, resetAt(26, 22)),
        quota(20, 12, 5, resetAt(27, 22)),
        quota(20, 13, 6, resetAt(27, 22)),
      ],
    ),
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
    reportTimeMs: timestampMs(23, 12),
    sourceStatus: "verified-current",
  });

  assert.match(
    report,
    /data-role="bar-total-label" data-placement="reset-(?:left|right)" data-clearance="reset-marker"/,
  );
  assert.doesNotMatch(report, /data-placement="centered-over-reset"/);
});

test("representative report output is finite SVG and decodes to PNG", async () => {
  const report = renderTrendImage({
    snapshot: snapshotOf(
      [
        usage(20, 8, {
          totalTokens: 5_000,
          inputTokens: 4_000,
          outputTokens: 1_000,
          cachedInputTokens: 3_000,
          project: "x<&",
        }),
      ],
      [quota(20, 2, 10, resetAt(27)), quota(21, 2, 20, resetAt(27))],
    ),
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
    reportTimeMs: timestampMs(24, 5),
    sourceStatus: "verified-current",
  });
  assert.match(report, /^<svg\b[^>]*\bwidth="\d+"[^>]*\bviewBox="0 0 \d+ \d+"/);
  assert.match(report, /<svg[\s\S]*<\/svg>$/);
  assert.match(report, /x&lt;&amp;/);
  assert.doesNotMatch(report, /x<&/);
  assert.doesNotMatch(report, /NaN|Infinity|undefined/);

  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-report-contract-"));
  try {
    const output = resolve(root, "report.png");
    await writeTrendPng(report, output);
    const bytes = await readFile(output);
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.ok(bytes.length > 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
