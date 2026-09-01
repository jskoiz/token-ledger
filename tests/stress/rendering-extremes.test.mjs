import test from "node:test";
import assert from "node:assert/strict";

import { multiDayBounds } from "../../bin/token-ledger-trend.mjs";
import { renderTrendImage } from "../../bin/token-ledger-trend-image.mjs";

const TIME_ZONE = "Pacific/Honolulu";
const bounds = multiDayBounds("2026-08-23", TIME_ZONE, 7);
const snapshot = {
  generatedAt: "2026-08-24T09:00:00.000Z",
  events: [
    {
      timestamp: "2026-08-21T18:00:00.000Z",
      model: "gpt-5.6-luna",
      project: "width-boundary",
      totalTokens: 1_000,
      inputTokens: 900,
      outputTokens: 100,
      cachedInputTokens: 100,
    },
  ],
  quotaObservations: [],
};

test("pathological image widths clamp to finite minimum and maximum canvases", () => {
  for (const [requestedWidth, expectedWidth] of [[1, 900], [100_000, 2_400]]) {
    const report = renderTrendImage({
      snapshot,
      bounds,
      days: 7,
      options: { imageWidth: requestedWidth },
      reportTimeMs: Date.parse("2026-08-24T10:00:00.000Z"),
      sourceStatus: "verified-current",
    });
    const root = report.match(
      /^<svg\b[^>]*\bwidth="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/,
    );
    assert.ok(root, `missing finite SVG root for requested width ${requestedWidth}`);
    assert.equal(Number(root[1]), expectedWidth);
    assert.equal(root[1], root[3]);
    assert.equal(root[2], root[4]);
    assert.ok(Number(root[2]) > 0);
    assert.doesNotMatch(report, /NaN|Infinity|undefined/);
  }
});
