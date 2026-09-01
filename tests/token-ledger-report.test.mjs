import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { multiDayBounds, buildUsageTrend } from "../bin/token-ledger-trend.mjs";
import {
  buildTrendReportViewModel,
  isFastMode,
  resolveEffectiveEnd,
} from "../bin/token-ledger-report-data.mjs";
import {
  renderTrendImage,
  reportCeiling,
  writeTrendPng,
} from "../bin/token-ledger-trend-image.mjs";
import { CODEX_CREDIT_RATE_CARD_AS_OF } from "../lib/token-ledger-rates.mjs";

const TZ = "Pacific/Honolulu"; // UTC-10, no DST
const WEEK_SECONDS = 10_080 * 60;

function bounds7() {
  return multiDayBounds("2026-08-23", TZ, 7);
}

// Local Honolulu wall time helper: iso(23, 12) = Aug 23, 12:00 local.
function iso(day, hour, minute = 0) {
  return new Date(Date.UTC(2026, 7, day, hour + 10, minute)).toISOString();
}

function ms(day, hour, minute = 0) {
  return Date.UTC(2026, 7, day, hour + 10, minute);
}

let nextId = 0;
function event(day, hour, overrides = {}) {
  const totalTokens = overrides.totalTokens ?? 1_000;
  const inputTokens = overrides.inputTokens ?? Math.round(totalTokens * 0.9);
  const outputTokens = overrides.outputTokens ?? totalTokens - inputTokens;
  return {
    id: `evt-${nextId++}`,
    timestamp: iso(day, hour, overrides.minute ?? 0),
    model: overrides.model ?? "gpt-5.6-luna",
    project: overrides.project ?? "alpha",
    serviceTier: overrides.serviceTier ?? null,
    totalTokens,
    inputTokens,
    outputTokens,
    cachedInputTokens: overrides.cachedInputTokens ?? 0,
    reasoningTokens: overrides.reasoningTokens ?? 0,
    breakdownAvailable: overrides.breakdownAvailable,
    rangeAllocationEstimated:
      overrides.rangeAllocationEstimated === true,
    resolutionSeconds: overrides.resolutionSeconds,
  };
}

function quota(day, hour, usedPercent, resetsAt, extra = {}) {
  return {
    timestamp: iso(day, hour),
    usedPercent,
    windowMinutes: 10_080,
    resetsAt,
    ...extra,
  };
}

function snapshotOf(events, quotaObservations = [], overrides = {}) {
  return {
    schemaVersion: 9,
    generatedAt: iso(23, 23),
    provenance: {
      kind: "codex-local-metadata",
      rateCardAsOf: CODEX_CREDIT_RATE_CARD_AS_OF,
    },
    coverage: { parseErrors: 0 },
    events,
    threads: [],
    quotaObservations,
    ...overrides,
  };
}

function build(snapshot, extra = {}) {
  return buildTrendReportViewModel({
    snapshot,
    bounds: bounds7(),
    days: 7,
    sourceStatus: "verified-current",
    reportTimeMs: ms(23, 12, 9),
    ...extra,
  });
}

// ---------------------------------------------------------------- calculations

test("report totals reconcile across days, models, and projects", () => {
  const events = [
    event(17, 8, { model: "gpt-5.6-luna", project: "alpha", totalTokens: 5_000, cachedInputTokens: 4_000 }),
    event(19, 9, { model: "gpt-5.6-sol", project: "beta", totalTokens: 3_000, cachedInputTokens: 2_500 }),
    event(20, 10, { model: "auto-review", project: "gamma", totalTokens: 700 }),
    event(21, 11, { model: "gpt-5.6-luna", project: "delta", totalTokens: 1_300, serviceTier: "priority" }),
    event(22, 12, { model: "gpt-5.6-sol", project: "epsilon", totalTokens: 900 }),
  ];
  const vm = build(snapshotOf(events));

  assert.equal(vm.summary.totalTokens, 10_900);
  assert.equal(vm.daily.reduce((sum, row) => sum + row.totalTokens, 0), 10_900);
  assert.equal(vm.models.reduce((sum, row) => sum + row.totalTokens, 0), 10_900);
  assert.equal(
    vm.projects.reduce((sum, row) => sum + row.totalTokens, 0) +
      vm.projectRemainder.totalTokens,
    10_900,
  );
  assert.equal(vm.projectRemainder.count, 2);
  assert.equal(vm.summary.activeProjects, 5);
  assert.equal(
    vm.daily.reduce((sum, row) => sum + row.inputTokens, 0),
    vm.summary.inputTokens,
  );
  assert.equal(
    vm.models.reduce((sum, row) => sum + row.cacheInputTokens, 0),
    vm.summary.inputTokens,
  );
  for (const row of vm.daily) {
    assert.ok(row.inputTokens <= row.totalTokens);
    assert.ok(row.cachedInputTokens <= row.inputTokens);
  }
  assert.equal(
    vm.summary.uncachedInputTokens,
    vm.summary.inputTokens - vm.summary.cachedInputTokens,
  );
});

test("cache rate is input-token weighted, never a mean of daily rates", () => {
  const events = [
    // Day one: tiny input, fully cached. Day two: large input, uncached.
    event(17, 8, { totalTokens: 200, inputTokens: 100, outputTokens: 100, cachedInputTokens: 100 }),
    event(18, 8, { totalTokens: 1_000, inputTokens: 900, outputTokens: 100, cachedInputTokens: 0 }),
  ];
  const vm = build(snapshotOf(events));
  assert.ok(Math.abs(vm.summary.cacheRatePercent - 10) < 1e-9);
  assert.equal(vm.daily[0].cacheRatePercent, 100);
  assert.equal(vm.daily[1].cacheRatePercent, 0);
});

test("fast mode counts both recognized tiers and stays a subset", () => {
  assert.equal(isFastMode("priority"), true);
  assert.equal(isFastMode("fast"), true);
  assert.equal(isFastMode("standard"), false);
  const events = [
    event(17, 8, { totalTokens: 1_000, serviceTier: "priority" }),
    event(18, 8, { totalTokens: 500, serviceTier: "fast" }),
    event(19, 8, { totalTokens: 2_000 }),
  ];
  const vm = build(snapshotOf(events));
  assert.equal(vm.summary.fastTokens, 1_500);
  assert.ok(vm.summary.fastTokens <= vm.summary.totalTokens);
  for (const row of vm.models) {
    assert.ok(row.fastTokens <= row.totalTokens);
    assert.equal(row.normalTokens + row.fastTokens, row.totalTokens);
  }
});

test("prior-period cutoff preserves local wall time across DST", () => {
  const timeZone = "America/New_York";
  const bounds = multiDayBounds("2026-03-08", timeZone, 7);
  const reportTimeMs = Date.parse("2026-03-08T16:00:00.000Z");
  const vm = buildTrendReportViewModel({
    bounds,
    days: 7,
    reportTimeMs,
    sourceStatus: "verified-current",
    snapshot: {
      events: [
        {
          timestamp: "2026-03-01T16:30:00.000Z",
          model: "gpt-5.6-luna",
          totalTokens: 11,
        },
        {
          timestamp: "2026-03-08T15:00:00.000Z",
          model: "gpt-5.6-luna",
          totalTokens: 20,
        },
      ],
    },
  });

  // Noon on Mar 8 EDT maps to noon on Mar 1 EST. The prior event at 11:30
  // EST is inside that local-time-equivalent window.
  assert.equal(vm.summary.priorEquivalentTokens, 11);
});

test("reasoning stays inside output and no overhead category exists", () => {
  const events = [
    event(19, 9, {
      totalTokens: 1_000,
      inputTokens: 700,
      outputTokens: 300,
      reasoningTokens: 250,
    }),
  ];
  const vm = build(snapshotOf(events));
  assert.equal(vm.summary.outputTokens, 300);
  assert.equal(vm.summary.inputTokens + vm.summary.outputTokens, 1_000);
});

test("prior comparison uses an equivalent partial duration", () => {
  const events = [
    event(20, 8, { totalTokens: 1_000 }),
    event(23, 10, { totalTokens: 1_000 }),
    // Beyond the partial cutoff on the final day: excluded from the total.
    event(23, 14, { totalTokens: 500_000 }),
    // Prior equivalent window: in (Aug 16 before noon) and out (after noon).
    event(16, 10, { totalTokens: 500 }),
    event(16, 18, { totalTokens: 999_999 }),
    event(13, 9, { totalTokens: 1_000 }),
  ];
  const vm = build(snapshotOf(events), { reportTimeMs: ms(23, 12) });
  assert.equal(vm.meta.partialFinalDay, true);
  assert.equal(vm.summary.totalTokens, 2_000);
  assert.equal(vm.summary.priorEquivalentTokens, 1_500);
  assert.ok(Math.abs(vm.summary.totalDeltaPercent - (2_000 / 1_500 - 1) * 100) < 1e-9);
});

test("no delta is reported without a measured prior period", () => {
  const vm = build(snapshotOf([event(20, 8, { totalTokens: 1_000 })]));
  assert.equal(vm.summary.priorEquivalentTokens, null);
  assert.equal(vm.summary.totalDeltaPercent, null);
});

test("estimated state propagates through report aggregates and comparisons", () => {
  const currentEstimated = event(20, 8, {
    model: "gpt-5.6-luna",
    project: "estimated-project",
    totalTokens: 1_000,
    serviceTier: "priority",
    rangeAllocationEstimated: true,
    resolutionSeconds: 86_400,
  });
  const priorEstimated = event(13, 8, {
    model: "gpt-5.6-sol",
    project: "prior-project",
    totalTokens: 500,
    rangeAllocationEstimated: true,
  });
  const vm = build(snapshotOf([currentEstimated, priorEstimated], [], {
    coverage: {
      parseErrors: 0,
      maximumUsageResolutionSeconds: 86_400,
    },
  }));

  assert.equal(vm.summary.estimated, true);
  assert.equal(vm.summary.fastEstimated, true);
  assert.equal(vm.summary.priorEquivalentTokens, 500);
  assert.equal(vm.summary.priorEquivalentEstimated, true);
  assert.equal(vm.summary.totalDeltaEstimated, true);
  assert.equal(vm.daily.find((row) => row.dateString === "2026-08-20").estimated, true);
  assert.equal(vm.daily.find((row) => row.dateString === "2026-08-20").models[0].estimated, true);
  assert.equal(vm.models.find((row) => row.model === "Luna").estimated, true);
  assert.equal(vm.projects.find((row) => row.project === "estimated-project").estimated, true);
  assert.equal(vm.coverage.estimated, true);
  assert.equal(vm.coverage.estimatedBucketCount, 1);
  assert.equal(vm.coverage.maximumResolutionSeconds, 86_400);
});

test("estimated warning resolution is scoped to bounded current estimated events", () => {
  const currentEstimated = event(20, 8, {
    totalTokens: 1_000,
    rangeAllocationEstimated: true,
    resolutionSeconds: 900,
  });
  const currentExact = event(21, 8, {
    totalTokens: 1_000,
    resolutionSeconds: 86_400,
  });
  const priorEstimated = event(13, 8, {
    totalTokens: 1_000,
    rangeAllocationEstimated: true,
    resolutionSeconds: 604_800,
  });
  const vm = build(snapshotOf(
    [currentEstimated, currentExact, priorEstimated],
    [],
    {
      coverage: {
        parseErrors: 0,
        maximumUsageResolutionSeconds: 604_800,
      },
    },
  ));

  assert.equal(vm.coverage.estimated, true);
  assert.equal(vm.summary.priorEquivalentEstimated, true);
  assert.equal(vm.coverage.maximumResolutionSeconds, 900);
});

test("mismatched project rows fail reconciliation loudly", () => {
  assert.throws(
    () =>
      build(snapshotOf([event(20, 8, { totalTokens: 5_000 })]), {
        projectRows: [{ project: "alpha", displayProject: "alpha", totalTokens: 42 }],
      }),
    /Report reconciliation failed/,
  );
});

test("report ceiling uses the tightened step ladder", () => {
  assert.equal(reportCeiling(2_390_000_000), 3_000_000_000);
  assert.equal(reportCeiling(950_000_000), 1_200_000_000);
  assert.equal(reportCeiling(4_100_000_000), 5_000_000_000);
  assert.equal(reportCeiling(0), 1);
});

// --------------------------------------------------------------------- meter

test("active meter reports current-cycle pace and runway", () => {
  const resetsAt = Math.floor(Date.UTC(2026, 7, 26, 6) / 1_000);
  const observations = [
    quota(20, 2, 10, resetsAt),
    quota(21, 2, 15, resetsAt),
    quota(22, 2, 20, resetsAt),
  ];
  const vm = build(snapshotOf([event(21, 8, { totalTokens: 1_000 })], observations));
  assert.equal(vm.meter.status, "active");
  assert.equal(vm.meter.remainingPercent, 80);
  assert.equal(vm.meter.cycleBurnPercent, 10);
  assert.ok(Math.abs(vm.meter.burnPerDay - 5) < 1e-9);
  assert.ok(Math.abs(vm.meter.runwayDays - 16) < 1e-9);
});

test("at-risk meter projects exhaustion before the reset", () => {
  const resetsAt = Math.floor(Date.UTC(2026, 7, 27, 6) / 1_000);
  const observations = [
    quota(20, 2, 40, resetsAt),
    quota(22, 2, 82, resetsAt),
  ];
  const vm = build(snapshotOf([event(21, 8, { totalTokens: 1_000 })], observations));
  assert.equal(vm.meter.status, "at-risk");
  assert.ok(vm.meter.runwayDays * 86_400_000 < vm.meter.resetInMs);
});

test("exhausted meter records the first zero observation", () => {
  const resetsAt = Math.floor(Date.UTC(2026, 7, 26, 6) / 1_000);
  const observations = [
    quota(20, 2, 60, resetsAt),
    quota(22, 2, 100, resetsAt),
    quota(23, 2, 100, resetsAt),
  ];
  const vm = build(snapshotOf([event(21, 8, { totalTokens: 1_000 })], observations));
  assert.equal(vm.meter.status, "exhausted");
  assert.equal(vm.meter.remainingPercent, 0);
  assert.equal(vm.meter.firstExhaustedObservedAtMs, ms(22, 2));
});

test("missing and named-only quota pools yield the unavailable state", () => {
  const empty = build(snapshotOf([event(20, 8, {})]));
  assert.equal(empty.meter.status, "unavailable");
  assert.equal(empty.meter.remainingPercent, null);

  const namedOnly = build(snapshotOf(
    [event(20, 8, {})],
    [
      quota(20, 2, 40, Math.floor(Date.UTC(2026, 7, 26, 6) / 1_000), {
        limitKey: "pool-1",
        limitName: "gpt-5-pool",
      }),
      quota(21, 2, 50, Math.floor(Date.UTC(2026, 7, 26, 6) / 1_000), {
        limitKey: "pool-1",
        limitName: "gpt-5-pool",
      }),
    ],
  ));
  assert.equal(namedOnly.meter.status, "unavailable");
});

test("meter geometry samples observations without extrapolating", () => {
  const resetsAtA = Math.floor(Date.UTC(2026, 7, 20, 10) / 1_000);
  const resetsAtB = resetsAtA + WEEK_SECONDS;
  const observations = [
    quota(17, 2, 85, resetsAtA),
    quota(18, 2, 88, resetsAtA),
    quota(19, 2, 90, resetsAtA),
    quota(20, 6, 5, resetsAtB),
    quota(22, 2, 15, resetsAtB),
    quota(22, 14, 15, resetsAtB),
  ];
  const events = [
    event(18, 8, { totalTokens: 1_000 }), // previous cycle
    event(21, 8, { totalTokens: 5_000 }), // inside the observed active cycle
  ];
  const vm = build(snapshotOf(events, observations));

  // The line ends at the final observation; nothing beyond it is drawn.
  const last = vm.meter.observations.at(-1);
  assert.equal(last.timestampMs, ms(22, 14));
  assert.equal(vm.meter.lastObservedAtMs, ms(22, 14));
  assert.ok(vm.meter.segments.every((segment) => segment.toMs <= ms(22, 14)));

  // Repeated equal readings confirm a solid span; changed values are gaps.
  const kinds = vm.meter.segments.map((segment) => segment.kind);
  assert.ok(kinds.includes("confirmed"));
  assert.ok(kinds.includes("gap"));
  const confirmed = vm.meter.segments.find((segment) => segment.kind === "confirmed");
  assert.equal(confirmed.fromMs, ms(22, 2));
  assert.equal(confirmed.toMs, ms(22, 14));

  // The cycle boundary appears as one inferred reset marker.
  assert.equal(vm.meter.resets.length, 1);
  assert.equal(vm.meter.resets[0].kind, "weekly-expiry");
  assert.equal(vm.meter.resets[0].inferred, true);

  // Pace uses the active cycle only: burn 10 points, not the prior cycle's.
  assert.equal(vm.meter.cycleBurnPercent, 10);
  assert.equal(vm.meter.tokensPerMeterPoint, 500);
});

test("stale fallback keeps the meter honest about capture time", () => {
  const resetsAt = Math.floor(Date.UTC(2026, 7, 26, 6) / 1_000);
  const snapshot = snapshotOf(
    [event(20, 8, {}), event(23, 11, { totalTokens: 7 })],
    [quota(20, 2, 10, resetsAt), quota(21, 2, 20, resetsAt)],
    { generatedAt: iso(23, 9, 12) },
  );
  const vm = build(snapshot, { sourceStatus: "stale-fallback", reportTimeMs: ms(23, 12) });
  assert.equal(vm.meter.stale, true);
  assert.equal(vm.meta.sourceStatus, "stale-fallback");
  // The report stops at snapshot capture time, not the wall clock.
  assert.ok(vm.meta.effectiveEndMs <= ms(23, 9, 13));
  assert.equal(vm.summary.totalTokens, 1_000);
});

// ------------------------------------------------------------ partial periods

test("effective end honors source status", () => {
  const bounds = bounds7();
  const snapshot = snapshotOf([], [], { generatedAt: iso(23, 9) });
  assert.equal(
    resolveEffectiveEnd({ snapshot, bounds, reportTimeMs: ms(23, 12), sourceStatus: "verified-current" }),
    ms(23, 12),
  );
  for (const sourceStatus of ["explicit-snapshot", "unchecked-cache", "stale-fallback"]) {
    assert.equal(
      resolveEffectiveEnd({ snapshot, bounds, reportTimeMs: ms(23, 12), sourceStatus }),
      ms(23, 9) + 1,
    );
  }
  // A report time past the range never extends beyond the requested end.
  assert.equal(
    resolveEffectiveEnd({ snapshot, bounds, reportTimeMs: ms(25, 12), sourceStatus: "verified-current" }),
    bounds.end.getTime(),
  );
});

test("future events past the cutoff never reach the daily rows", () => {
  const events = [
    event(23, 10, { totalTokens: 100 }),
    event(23, 13, { totalTokens: 900 }),
  ];
  const vm = build(snapshotOf(events), { reportTimeMs: ms(23, 12) });
  assert.equal(vm.summary.totalTokens, 100);
  assert.equal(vm.daily.at(-1).totalTokens, 100);
  assert.equal(vm.daily.at(-1).partial, true);
  assert.equal(vm.coverage.modelCalls, 1);
});

test("partial cutoff marks its day and distinguishes later unobserved days", () => {
  const snapshot = snapshotOf(
    [
      event(20, 8, { totalTokens: 100 }),
      event(20, 12, { totalTokens: 900 }),
    ],
    [],
    { generatedAt: iso(20, 9) },
  );
  const vm = build(snapshot, {
    sourceStatus: "stale-fallback",
    reportTimeMs: ms(23, 12),
  });

  assert.equal(vm.meta.observedThroughDateString, "2026-08-20");
  assert.equal(vm.daily[3].dateString, "2026-08-20");
  assert.equal(vm.daily[3].observed, true);
  assert.equal(vm.daily[3].partial, true);
  assert.ok(vm.daily.slice(4).every((row) => row.observed === false));
  assert.ok(vm.daily.slice(4).every((row) => row.totalTokens === 0));
});

// ----------------------------------------------------------------- rendering

function richSnapshot() {
  const resetsAtA = Math.floor(Date.UTC(2026, 7, 20, 10) / 1_000);
  const resetsAtB = resetsAtA + WEEK_SECONDS;
  const events = [];
  for (let day = 17; day <= 23; day += 1) {
    events.push(event(day, 8, {
      model: "gpt-5.6-luna",
      project: `project-${day}`,
      totalTokens: 200_000_000 + day * 1_000_000,
      cachedInputTokens: 150_000_000,
    }));
    events.push(event(day, 10, {
      model: "gpt-5.6-sol",
      project: "shared-project",
      totalTokens: 60_000_000,
      serviceTier: "priority",
      cachedInputTokens: 50_000_000,
    }));
  }
  // Large enough to reach the top-project rows so label escaping is exercised.
  events.push(event(21, 12, { model: "auto-review", project: "<script>alert('x')</script>", totalTokens: 500_000_000 }));
  const observations = [
    quota(17, 2, 80, resetsAtA),
    quota(18, 2, 85, resetsAtA),
    quota(19, 2, 90, resetsAtA),
    quota(20, 12, 10, resetsAtB),
    quota(21, 12, 30, resetsAtB),
    quota(22, 6, 30, resetsAtB),
    quota(23, 2, 55, resetsAtB),
  ];
  return snapshotOf(events, observations);
}

function renderRich(extra = {}) {
  const snapshot = richSnapshot();
  return renderTrendImage({
    snapshot,
    bounds: bounds7(),
    trend: buildUsageTrend(snapshot, bounds7()),
    days: 7,
    options: { imageWidth: extra.imageWidth ?? 1_280, drain: extra.drain },
    reportTimeMs: ms(23, 12, 9),
    sourceStatus: extra.sourceStatus ?? "verified-current",
  });
}

function degradedSnapshot() {
  return snapshotOf([
    event(20, 8, {
      totalTokens: 500,
      inputTokens: 450,
      outputTokens: 50,
      cachedInputTokens: 225,
      breakdownAvailable: true,
      rangeAllocationEstimated: true,
      resolutionSeconds: 86_400,
    }),
    event(21, 8, {
      totalTokens: 500,
      inputTokens: 450,
      outputTokens: 50,
      breakdownAvailable: false,
      rangeAllocationEstimated: true,
      resolutionSeconds: 86_400,
    }),
  ], [], {
    provenance: {
      kind: "external-snapshot",
      rateCardAsOf: "2026-08-17",
    },
    coverage: {
      parseErrors: 2,
      maximumUsageResolutionSeconds: 86_400,
    },
  });
}

function renderDegraded(imageWidth) {
  const snapshot = degradedSnapshot();
  return renderTrendImage({
    snapshot,
    bounds: bounds7(),
    days: 7,
    options: { imageWidth },
    reportTimeMs: ms(23, 12, 9),
    sourceStatus: "stale-fallback",
  });
}

test("the report SVG contains every required section", () => {
  const svg = renderRich();
  for (const heading of [
    "TOTAL USAGE",
    "CACHE EFFICIENCY",
    "FAST MODE USAGE",
    "PROJECTS",
    "WEEKLY LIMIT",
    "MODEL MIX",
    "DAILY TOKEN VOLUME",
    "CACHE EFFICIENCY BY DAY",
    "WHERE IT WENT · TOP PROJECTS",
    "CACHE EFFICIENCY BY MODEL",
  ]) {
    assert.ok(svg.includes(heading), `missing section heading: ${heading}`);
  }
  assert.match(svg, /fast-mode-hatch/);
  assert.match(svg, /url\(#fast-mode-hatch\)/);
  assert.match(svg, />RESET<\/text>/);
  assert.ok(
    svg.lastIndexOf('data-role="meter-reset-label"') >
      svg.lastIndexOf('data-series="weekly-meter"'),
  );
  assert.doesNotMatch(svg, /OpenAI observation/);
  assert.doesNotMatch(svg, /r="3\.8"/);
  assert.match(svg, /Unobserved gap/);
  // Partial-day treatment for the noon cutoff.
  assert.match(svg, /PARTIAL/);
  assert.match(svg, /THROUGH 12:09 PM/);
  // Exact uncached input remains unmarked even when multiple models contribute.
  assert.doesNotMatch(svg, /≈[^<]*uncached/);
  // Dynamic labels are XML escaped and no numeric garbage leaks through.
  assert.ok(!svg.includes("<script>"));
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);

  // The compact KPI cards use their label color without decorative side
  // stripes, and the lower report sections sit directly on the page rather
  // than adding another layer of card shells and inset summary boxes.
  assert.doesNotMatch(svg, /width="3\.00" height="140\.00"/);
  assert.equal((svg.match(/stroke="#273246"/g) ?? []).length, 1);
  assert.doesNotMatch(svg, /stroke="rgba\(34,197,143,\.35\)"/);
  assert.doesNotMatch(svg, /stroke="rgba\(126,162,240,\.35\)"/);
  assert.doesNotMatch(svg, /data-role="integrity-warning"/);
  assert.doesNotMatch(svg, /OpenAI reading|% REMAINING/);
  assert.equal((svg.match(/data-role="lower-column-divider"/g) ?? []).length, 2);
  assert.equal((svg.match(/data-role="kpi-column-divider"/g) ?? []).length, 3);
  assert.match(svg, /stroke="rgba\(119,131,154,\.22\)" stroke-width="1"/);
});

test("material integrity warnings are conditional and preserve estimated labels", () => {
  const healthy = renderRich();
  const degraded = renderDegraded(1_280);
  assert.doesNotMatch(healthy, /data-role="integrity-warning"/);
  for (const [kind, label] of [
    ["parse-errors", "2 UNPARSED SOURCE RECORDS"],
    ["component-coverage", "50% COMPONENT COVERAGE"],
    ["external-source", "EXTERNAL SNAPSHOT INPUT"],
    ["source-status", "STALE SNAPSHOT"],
    ["estimated-history", "≈ ESTIMATED HISTORY · 1 day SOURCE BINS"],
    [
      "rate-card-mismatch",
      `RATE CARD 2026-08-17 → ${CODEX_CREDIT_RATE_CARD_AS_OF}`,
    ],
  ]) {
    assert.match(degraded, new RegExp(`data-kind="${kind}"`));
    assert.ok(degraded.includes(label), `missing warning text: ${label}`);
  }
  assert.match(degraded, />≈1\.00K<\/text>/);
  assert.match(degraded, />≈50\.0%<\/text>/);
  assert.doesNotMatch(degraded, /NaN|Infinity|undefined/);
});

test("estimated warning preserves supported sub-hour source-bin resolutions", () => {
  for (const [resolutionSeconds, label] of [
    [300, "5 minutes"],
    [900, "15 minutes"],
  ]) {
    const snapshot = snapshotOf([
      event(20, 8, {
        totalTokens: 1_000,
        inputTokens: 900,
        outputTokens: 100,
        breakdownAvailable: true,
        rangeAllocationEstimated: true,
        resolutionSeconds,
      }),
    ], [], {
      coverage: {
        parseErrors: 0,
        maximumUsageResolutionSeconds: 86_400,
      },
    });
    const svg = renderTrendImage({
      snapshot,
      bounds: bounds7(),
      days: 7,
      options: { imageWidth: 1_280 },
      reportTimeMs: ms(23, 12, 9),
      sourceStatus: "verified-current",
    });

    assert.match(svg, /data-kind="estimated-history"/);
    assert.ok(svg.includes(`≈ ESTIMATED HISTORY · ${label} SOURCE BINS`));
    assert.doesNotMatch(svg, /ESTIMATED HISTORY · 1 hour SOURCE BINS/);
  }
});

test("partial and stale markers appear only in their states", () => {
  const complete = renderRich({ sourceStatus: "verified-current" });
  const stale = renderRich({ sourceStatus: "stale-fallback" });
  assert.doesNotMatch(complete, /STALE/);
  assert.match(complete, /Report through/);
  assert.match(stale, /STALE/);
  assert.match(stale, /Snapshot generated/);
  assert.doesNotMatch(stale, /Report through/);

  // A report cut at the requested range end has no partial-day treatment.
  const snapshot = richSnapshot();
  const finished = renderTrendImage({
    snapshot,
    bounds: bounds7(),
    days: 7,
    options: { imageWidth: 1_280 },
    reportTimeMs: ms(24, 5),
    sourceStatus: "verified-current",
  });
  assert.doesNotMatch(finished, /PARTIAL/);
  assert.doesNotMatch(finished, /THROUGH /);
});

test("the exhausted card never shows a zero-day runway", () => {
  const resetsAt = Math.floor(Date.UTC(2026, 7, 26, 6) / 1_000);
  const snapshot = snapshotOf(
    [event(20, 8, { totalTokens: 1_000_000 })],
    [quota(20, 2, 60, resetsAt), quota(22, 2, 100, resetsAt), quota(23, 2, 100, resetsAt)],
  );
  const svg = renderTrendImage({
    snapshot,
    bounds: bounds7(),
    days: 7,
    options: { imageWidth: 1_280 },
    reportTimeMs: ms(23, 12),
    sourceStatus: "verified-current",
  });
  assert.match(svg, /EXHAUSTED/);
  assert.doesNotMatch(svg, /0\.0 days/);
});

test("the layout fits its view box from 900 to 2400 pixels", () => {
  for (const imageWidth of [900, 1_280, 2_400]) {
    const svg = renderRich({ imageWidth });
    const match = svg.match(/<svg[^>]*width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/);
    assert.ok(match, "svg root has explicit dimensions");
    assert.equal(Number(match[1]), imageWidth);
    assert.equal(match[1], match[3]);
    assert.equal(match[2], match[4]);
    assert.ok(Number(match[2]) > 600);
    assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
  }
});

test("degraded warning chips fit and encode at 900, 1280, and 2400 pixels", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-report-degraded-"));
  try {
    for (const imageWidth of [900, 1_280, 2_400]) {
      const svg = renderDegraded(imageWidth);
      const warningGroups = [...svg.matchAll(
        /<g data-role="integrity-warning"[^>]*>([\s\S]*?)<\/g>/g,
      )];
      assert.equal(warningGroups.length, 6);
      for (const [, markup] of warningGroups) {
        const rect = markup.match(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"/);
        assert.ok(rect, "warning chip has a measurable backing rect");
        const left = Number(rect[1]);
        const right = left + Number(rect[2]);
        assert.ok(left >= 28, `warning starts inside ${imageWidth}px canvas`);
        assert.ok(right <= imageWidth - 28 + 0.01, `warning ends inside ${imageWidth}px canvas`);
      }
      const output = resolve(root, `degraded-${imageWidth}.png`);
      await writeTrendPng(svg, output);
      const bytes = await readFile(output);
      assert.deepEqual(
        [...bytes.subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the redesigned report encodes to PNG", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-report-png-"));
  try {
    const output = resolve(root, "report.png");
    await writeTrendPng(renderRich(), output);
    const bytes = await readFile(output);
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
