import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs, run } from "../bin/token-ledger.mjs";

test("report output keeps its invocation cutoff when the clock advances during loading", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "token-ledger-report-clock-"));
  const startedAt = Date.parse("2026-09-04T12:00:00.000Z");
  const completedAt = startedAt + 2 * 60 * 60 * 1_000;
  const input = join(root, "snapshot.json");
  const snapshot = {
    schemaVersion: 3,
    // A snapshot without a usable capture time falls back to the report clock.
    generatedAt: null,
    events: [
      [startedAt - 30 * 60 * 1_000, 1_000],
      [startedAt + 30 * 60 * 1_000, 9_000],
    ].map(([timestamp, totalTokens]) => ({
      timestamp: new Date(timestamp).toISOString(),
      model: "gpt-5.6-luna",
      project: "clock-fixture",
      totalTokens,
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
    })),
    threads: [],
    quotaObservations: [],
  };
  const options = (name) => parseArgs([
    "report", "7d", "--date", "2026-09-04", "--input", input,
    "--no-refresh", "--no-open", "--tz", "UTC",
    "--image-output", join(root, `${name}.png`),
  ]);
  try {
    await writeFile(input, JSON.stringify(snapshot));
    const delayed = options("delayed");
    let clockReads = 0;
    const clock = t.mock.method(Date, "now", () => clockReads++ === 0 ? startedAt : completedAt);
    try {
      await run(delayed);
    } finally {
      clock.mock.restore();
    }
    await run(options("at-start"), { nowMs: startedAt });
    await run(options("at-end"), { nowMs: completedAt });
    const delayedImage = await readFile(join(root, "delayed.png"));
    assert.deepEqual(delayedImage, await readFile(join(root, "at-start.png")));
    assert.notDeepEqual(delayedImage, await readFile(join(root, "at-end.png")));

    snapshot.generatedAt = new Date(startedAt).toISOString();
    await writeFile(input, JSON.stringify(snapshot));
    const terminal = parseArgs([
      "1d", "--input", input,
      "--no-refresh", "--static", "--plain", "--tz", "UTC",
    ]);
    clockReads = 0;
    const freshnessClock = t.mock.method(Date, "now", () => clockReads++ === 0 ? startedAt : completedAt);
    try {
      assert.match(await run(terminal), /2h old/);
    } finally {
      freshnessClock.mock.restore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
