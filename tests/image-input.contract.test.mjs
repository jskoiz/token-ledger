import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import sharp from "sharp";

import { multiDayBounds } from "../bin/token-ledger-trend.mjs";
import {
  escapeXml,
} from "../bin/token-ledger-image-primitives.mjs";
import { renderTrendImage } from "../bin/token-ledger-trend-image.mjs";

function hasInvalidXmlCharacter(value) {
  return [...String(value)].some((character) => {
    const codePoint = character.codePointAt(0);
    return !(
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    );
  });
}

test("escapeXml keeps valid Unicode and XML escapes while removing invalid code points", () => {
  const value = "Ω😀\t\n\r\u0000\u000b\uD800\uFFFE<>&\"'";
  const escaped = escapeXml(value);

  assert.equal(
    escaped,
    "Ω😀\t\n\r&lt;&gt;&amp;&quot;&apos;",
  );
  assert.equal(hasInvalidXmlCharacter(escaped), false);
});

test("a contaminated explicit snapshot still produces a valid PNG report", async () => {
  const snapshot = {
    schemaVersion: 3,
    generatedAt: "2026-08-20T12:00:00.000Z",
    provenance: { kind: "codex-local-metadata" },
    coverage: { parseErrors: 0 },
    events: [{
      timestamp: "2026-08-20T12:00:00.000Z",
      project: "Ω<>&\"'😀\u0001",
      model: "gpt-5.5",
      totalTokens: 100,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 0,
    }],
    threads: [],
    quotaObservations: [],
  };
  const svg = renderTrendImage({
    snapshot,
    bounds: multiDayBounds("2026-08-20", "UTC", 7),
    days: 7,
    options: { imageWidth: 1_280 },
    reportTimeMs: Date.parse("2026-08-20T12:00:00.000Z"),
    sourceStatus: "explicit-snapshot",
  });

  assert.equal(hasInvalidXmlCharacter(svg), false);
  assert.match(svg, /Ω/);
  assert.match(svg, /😀/);
  assert.match(svg, /Ω&lt;&gt;&amp;&quot;&apos;😀/);

  const png = await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
  assert.deepEqual([...png.subarray(0, 8)], [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
});
