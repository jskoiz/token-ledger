import assert from "node:assert/strict";
import test from "node:test";

import { multiDayBounds, weeklyQuotaObservations } from "../bin/token-ledger-trend.mjs";
import { buildTrendReportViewModel } from "../bin/token-ledger-report-data.mjs";
import {
  ACCOUNT_QUOTA_LIMIT_KEY,
  QUOTA_IDENTITY_CONTRACT_VERSION,
} from "../lib/token-ledger-quota-contract.mjs";

const observedAt = "2026-09-04T12:00:00.000Z";
const reading = {
  timestamp: observedAt,
  windowMinutes: 10_080,
  usedPercent: 10,
  resetsAt: Date.parse("2026-09-10T12:00:00.000Z") / 1_000,
  scope: "account",
  limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
};

function snapshot(quotaObservations) {
  return {
    schemaVersion: 3,
    generatedAt: observedAt,
    metadata: { durableLedger: { quotaIdentityContract: QUOTA_IDENTITY_CONTRACT_VERSION } },
    events: [],
    quotaObservations,
  };
}

test("malformed quota timestamps never fabricate a carried account meter", () => {
  const bounds = multiDayBounds("2026-09-04", "UTC", 7);
  for (const timestamp of [null, true, false, [], [observedAt], {}, "invalid", 1e20]) {
    const input = snapshot([{ ...reading, timestamp, lastSeenAt: null }]);
    assert.deepEqual(weeklyQuotaObservations(input), []);
    const report = buildTrendReportViewModel({
      snapshot: input,
      bounds,
      days: 7,
      reportTimeMs: Date.parse("2026-09-04T13:00:00.000Z"),
      sourceStatus: "explicit-snapshot",
    });
    assert.equal(report.meter.status, "unavailable");
    assert.equal(report.meter.remainingPercent, null);
    assert.equal(report.meter.lastObservedAtMs, null);
  }
});

test("invalid quota measurements are skipped without hiding valid readings", () => {
  const invalid = [
    null,
    ...[null, false, "10", -1, 101].map((usedPercent) => ({ ...reading, usedPercent })),
    ...[true, "1789041600", 0].map((resetsAt) => ({ ...reading, resetsAt })),
  ];
  const observations = weeklyQuotaObservations(snapshot([...invalid, reading]));
  assert.equal(observations.length, 1);
  assert.equal(observations[0].usedPercent, 10);
  assert.equal(observations[0].timestampMs, Date.parse(observedAt));
  for (const malformed of [null, {}, "invalid"]) {
    assert.deepEqual(weeklyQuotaObservations(snapshot(malformed)), []);
  }
});

test("an invalid optional last-seen value preserves the actual observation time", () => {
  for (const lastSeenAt of [null, false, [], {}, "invalid"]) {
    const [observation] = weeklyQuotaObservations(snapshot([{ ...reading, lastSeenAt }]));
    assert.equal(observation.timestampMs, Date.parse(observedAt));
    assert.equal(observation.observedThroughMs, Date.parse(observedAt));
  }
});
