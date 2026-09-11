import assert from "node:assert/strict";
import test from "node:test";
import { buildRangeAnalysis } from "../lib/token-ledger-range-analysis.mjs";
import { multiDayBounds } from "../bin/token-ledger-trend.mjs";
import { buildTrendReportViewModel } from "../bin/token-ledger-report-data.mjs";

test("quota samples do not turn exact daily totals into allocated estimates", () => {
  const bounds = multiDayBounds("2026-09-04", "UTC", 7);
  const snapshot = {
    generatedAt: "2026-09-04T12:05:00Z",
    events: [{
      timestamp: "2026-09-04T12:00:30Z",
      startAt: "2026-09-04T12:00:00Z",
      endAt: "2026-09-04T12:00:59.999Z",
      totalTokens: 600,
      inputTokens: 500,
      cachedInputTokens: 300,
      outputTokens: 100,
      callCount: 4,
      detailedCallCount: 4,
      model: "gpt-6-astra",
      project: "fixture",
      breakdownAvailable: true,
    }],
  };
  const original = JSON.parse(JSON.stringify(snapshot));
  const withoutMeter = buildRangeAnalysis(snapshot, bounds);
  const withMeter = buildRangeAnalysis(snapshot, bounds, {
    quotaObservations: [{ timestampMs: Date.parse("2026-09-04T12:00:30Z") }],
  });
  assert.deepEqual(withMeter.currentEvents, withoutMeter.currentEvents);
  assert.equal(withMeter.trendEvents.length, 2);
  assert.ok(withMeter.trendEvents.every((event) => event.rangeAllocationEstimated));
  assert.equal(withMeter.trendEvents.reduce((sum, event) => sum + event.totalTokens, 0), 600);
  const vm = buildTrendReportViewModel({
    snapshot, bounds, days: 7, events: withMeter.currentEvents, priorEvents: [],
  });
  assert.equal(vm.summary.totalTokens, 600);
  assert.equal(vm.summary.estimated, false);
  assert.equal(vm.daily.at(-1).estimated, false);
  assert.deepEqual(snapshot, original);
});

test("genuine calendar allocations stay estimated with or without quota samples", () => {
  const bounds = multiDayBounds("2026-09-04", "UTC", 2);
  const snapshot = { events: [{
    timestamp: "2026-09-04T00:00:00Z",
    startAt: "2026-09-03T23:59:30Z",
    endAt: "2026-09-04T00:00:29.999Z",
    totalTokens: 600, inputTokens: 600, outputTokens: 0,
    callCount: 2, model: "gpt-6-astra", breakdownAvailable: true,
  }] };
  const result = buildRangeAnalysis(snapshot, bounds, {
    quotaObservations: [{ timestampMs: Date.parse("2026-09-04T00:00:15Z") }],
  });
  assert.equal(result.currentEvents.length, 2);
  assert.ok(result.currentEvents.every((event) => event.rangeAllocationEstimated));
  assert.deepEqual(result.currentEvents.map((event) => event.totalTokens), [300, 300]);
});
