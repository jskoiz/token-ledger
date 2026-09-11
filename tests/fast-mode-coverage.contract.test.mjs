import assert from "node:assert/strict";
import test from "node:test";

import { buildTrendReportViewModel } from "../bin/token-ledger-report-data.mjs";
import { renderTrendImage } from "../bin/token-ledger-trend-image.mjs";
import { multiDayBounds } from "../bin/token-ledger-trend.mjs";
import { QUOTA_IDENTITY_CONTRACT_VERSION } from "../lib/token-ledger-quota-contract.mjs";

const TIME_ZONE = "UTC";
const bounds = multiDayBounds("2026-08-23", TIME_ZONE, 7);

function usage(hour, totalTokens, serviceTier, model = "gpt-5.6-luna") {
  return {
    timestamp: `2026-08-23T${String(hour).padStart(2, "0")}:00:00.000Z`,
    model,
    project: "fast-mode-coverage",
    serviceTier,
    totalTokens,
    inputTokens: totalTokens,
    outputTokens: 0,
    cachedInputTokens: 0,
  };
}

function snapshotOf(events) {
  return {
    schemaVersion: 3,
    generatedAt: "2026-08-30T00:00:00.000Z",
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

function buildReport(events) {
  return buildTrendReportViewModel({
    snapshot: snapshotOf(events),
    bounds,
    days: 7,
    reportTimeMs: bounds.end.getTime(),
    sourceStatus: "verified-current",
  });
}

test("fast-mode coverage separates known normal from null and unknown tiers", () => {
  const report = buildReport([
    usage(1, 200, "fast"),
    usage(2, 300, "default"),
    usage(3, 100, null),
    usage(4, 400, "future-tier"),
  ]);

  assert.equal(report.summary.totalTokens, 1_000);
  assert.equal(report.summary.fastTokens, 200);
  assert.equal(report.summary.normalTokens, 300);
  assert.equal(report.summary.unknownTokens, 500);
  assert.equal(report.summary.fastSharePercent, 20);
  assert.equal(report.summary.unknownSharePercent, 50);
  assert.equal(
    report.summary.fastTokens +
      report.summary.normalTokens +
      report.summary.unknownTokens,
    report.summary.totalTokens,
  );

  const model = report.models[0];
  assert.equal(model.fastTokens, 200);
  assert.equal(model.normalTokens, 300);
  assert.equal(model.unknownTokens, 500);
  assert.equal(
    model.fastTokens + model.normalTokens + model.unknownTokens,
    model.totalTokens,
  );
  assert.equal(
    report.daily.reduce(
      (sum, row) => sum + row.models.reduce((rowSum, entry) => rowSum + entry.unknownTokens, 0),
      0,
    ),
    report.summary.unknownTokens,
  );
});

test("fast-mode KPI says confirmed fast and discloses unknown tier at both report widths", () => {
  const snapshot = snapshotOf([
    usage(1, 200, "fast"),
    usage(2, 300, "default"),
    usage(3, 100, null),
    usage(4, 400, "future-tier"),
  ]);

  for (const imageWidth of [900, 1_280]) {
    const image = renderTrendImage({
      snapshot,
      bounds,
      days: 7,
      options: { imageWidth },
      reportTimeMs: bounds.end.getTime(),
      sourceStatus: "verified-current",
    });
    assert.match(image, /20\.0% confirmed fast/);
    assert.match(image, /data-role="kpi-caption"[\s\S]*50\.0% unknown/);
    assert.match(image, /50\.0% unknown · hatch=fast/);
    assert.doesNotMatch(image, /NaN|Infinity/);
  }
});

test("fast-mode KPI omits unknown-tier disclosure when every tier is known", () => {
  const events = [
    usage(1, 200, "fast"),
    usage(2, 300, "default"),
    usage(3, 500, "standard"),
  ];
  const report = buildReport(events);

  assert.equal(report.summary.unknownTokens, 0);
  assert.equal(report.summary.unknownSharePercent, 0);

  const image = renderTrendImage({
    snapshot: snapshotOf(events),
    bounds,
    days: 7,
    options: { imageWidth: 900 },
    reportTimeMs: bounds.end.getTime(),
    sourceStatus: "verified-current",
  });
  assert.match(image, /20\.0% confirmed fast/);
  assert.doesNotMatch(image, /tier unknown/);
});

test("fast-mode KPI does not show an unqualified average when fast rates are incomplete", () => {
  const events = [
    usage(1, 200, "fast"),
    usage(2, 100, "fast", "gpt-daybreak-blue-latest"),
    usage(3, 700, "default"),
  ];
  const image = renderTrendImage({
    snapshot: snapshotOf(events),
    bounds,
    days: 7,
    options: { imageWidth: 900 },
    reportTimeMs: bounds.end.getTime(),
    sourceStatus: "verified-current",
  });

  assert.doesNotMatch(image, /× avg/);
  assert.match(image, /Some fast usage is unrated/);
});
