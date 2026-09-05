import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../bin/token-ledger.mjs";
import { renderTrendImage } from "../bin/token-ledger-trend-image.mjs";
import { multiDayBounds } from "../bin/token-ledger-trend.mjs";

test("private reports hide names without changing usage or source data", () => {
  const snapshot = {
    generatedAt: "2026-09-04T12:30:00Z",
    coverage: {}, threads: [], quotaObservations: [],
    events: ["AlphaSecret", "BetaSecret"].map((project, i) => ({
      project, timestamp: "2026-09-04T12:00:00Z", model: "gpt-5.6-luna",
      totalTokens: (i + 1) * 1000, inputTokens: (i + 1) * 1000,
      outputTokens: 0, cachedInputTokens: 0,
    })),
  };
  const before = JSON.stringify(snapshot);
  const args = {
    snapshot, bounds: multiDayBounds("2026-09-04", "UTC", 1), days: 1,
    reportTimeMs: Date.parse(snapshot.generatedAt), sourceStatus: "unchecked-cache",
  };
  const normal = renderTrendImage({ ...args, options: {} });
  const privateReport = renderTrendImage({ ...args, options: { private: true } });
  assert.match(normal, /AlphaSecret/);
  assert.match(normal, /BetaSecret/);
  assert.doesNotMatch(privateReport, /AlphaSecret|BetaSecret/);
  assert.match(privateReport, />Project 1<\/text>/);
  assert.match(privateReport, />Project 2<\/text>/);
  assert.equal(privateReport, normal
    .replaceAll("BetaSecret", "Project 1")
    .replaceAll("AlphaSecret", "Project 2"));
  assert.equal(JSON.stringify(snapshot), before);
});

test("private option is explicit and restricted to reports", () => {
  assert.equal(parseArgs(["report", "1d", "--private"]).private, true);
  assert.equal(parseArgs(["report", "1d"]).private, false);
  assert.throws(() => parseArgs(["1d", "--private"]), /only available with the report/);
});
