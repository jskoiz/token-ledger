import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateProjects,
  dayBounds,
  filterDayEvents,
  parseArgs,
  redactLocalPaths,
  rolling24hBounds,
  rollingDurationBounds,
  run,
  sanitizeTerminalText,
  DEFAULT_SNAPSHOT,
  snapshotCacheIsFresh,
  snapshotFreshness,
  snapshotNeedsRefresh,
  weekBounds,
} from "../bin/token-ledger.mjs";
import {
  quotaCycleSummary,
  renderFullscreen,
  renderTerminal,
} from "../bin/token-ledger-terminal.mjs";
import {
  buildBurnDayBins,
  buildUsageTrend,
  multiDayBounds,
  normalizeQuotaTimeline,
  weeklyQuotaObservations,
} from "../bin/token-ledger-trend.mjs";
import { creditsForUsage } from "../bin/token-ledger-rates.mjs";
import {
  renderTrendImage,
  textWidth,
  writeTrendPng,
} from "../bin/token-ledger-trend-image.mjs";
import {
  buildCacheReportData,
  renderCacheReportImage,
} from "../bin/token-ledger-cache-image.mjs";
import {
  INTERACTIVE_FOOTER,
  INTERACTIVE_HELP,
  INTERACTIVE_KEY_INPUTS,
} from "../bin/token-ledger-controls.mjs";
import { actionFor } from "../bin/token-ledger-tui.mjs";
import {
  buildActualTokenBins,
  renderTrendPlain,
} from "../bin/token-ledger-trend-terminal.mjs";

const ROLLING_24H_FIXTURE = fileURLToPath(
  new URL("./fixtures/rolling-24h-projects.json", import.meta.url),
);
const CLI_ENTRYPOINT = fileURLToPath(
  new URL("../bin/token-ledger.mjs", import.meta.url),
);

test(
  "CLI entrypoint supports direct shebang execution",
  { skip: process.platform === "win32" },
  () => {
    const result = spawnSync(CLI_ENTRYPOINT, ["--help"], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--help/);
  },
);

test("dayBounds uses local calendar midnights for an explicit timezone", () => {
  const bounds = dayBounds("2026-08-01", "Pacific/Honolulu");
  assert.equal(bounds.start.toISOString(), "2026-08-01T10:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-08-02T10:00:00.000Z");
});

test("weekBounds covers seven local calendar days ending on the selected day", () => {
  const bounds = weekBounds("2026-08-03", "Pacific/Honolulu");
  assert.equal(bounds.startDateString, "2026-07-28");
  assert.equal(bounds.endDateString, "2026-08-03");
  assert.equal(bounds.start.toISOString(), "2026-07-28T10:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-08-04T10:00:00.000Z");
  assert.equal(bounds.rangeDays, 7);
});

test("rolling24hBounds covers the exact preceding 24 hours", () => {
  const end = new Date("2026-08-19T22:15:30.000Z");
  const bounds = rolling24hBounds(end, "Pacific/Honolulu");
  assert.equal(bounds.start.toISOString(), "2026-08-18T22:15:30.000Z");
  assert.equal(bounds.end.toISOString(), "2026-08-19T22:15:30.000Z");
  assert.equal(bounds.rangeHours, 24);
  assert.equal(bounds.timeZone, "Pacific/Honolulu");
});

test("rollingDurationBounds covers arbitrary day windows ending at the supplied time", () => {
  const end = new Date("2026-08-19T22:15:30.000Z");
  const bounds = rollingDurationBounds(end, "Pacific/Honolulu", 3);
  assert.equal(bounds.start.toISOString(), "2026-08-16T22:15:30.000Z");
  assert.equal(bounds.end.toISOString(), "2026-08-19T22:15:30.000Z");
  assert.equal(bounds.rangeHours, 72);
  assert.equal(bounds.rangeDays, 3);
  assert.equal(bounds.timeZone, "Pacific/Honolulu");
});

test("filterDayEvents keeps the start and excludes the end boundary", () => {
  const snapshot = {
    events: [
      null,
      { id: "hostile", timestamp: { toString: null, valueOf: null } },
      { id: "before", timestamp: "2026-08-01T09:59:59.999Z" },
      { id: "start", timestamp: "2026-08-01T10:00:00.000Z" },
      { id: "inside", timestamp: "2026-08-01T20:00:00.000Z" },
      { id: "end", timestamp: "2026-08-02T10:00:00.000Z" },
    ],
  };
  const events = filterDayEvents(snapshot, dayBounds("2026-08-01", "Pacific/Honolulu"));
  assert.deepEqual(events.map((event) => event.id), ["start", "inside"]);
});

test("aggregateProjects sorts by tokens and retains model mix", () => {
  const snapshot = {
    events: [],
    threads: [
      { id: "alpha-1", project: "alpha" },
      { id: "alpha-2", project: "alpha" },
      { id: "beta-1", project: "beta" },
    ],
  };
  const events = [
    {
      project: "alpha",
      threadId: "alpha-1",
      model: "gpt-5.6-sol",
      totalTokens: 900,
      outputTokens: 90,
      toolCalls: 2,
      rateCardCredits: 4,
    },
    {
      project: "alpha",
      threadId: "alpha-2",
      model: "gpt-5.6-luna",
      totalTokens: 100,
      outputTokens: 10,
      toolCalls: 1,
      rateCardCredits: 1,
    },
    {
      project: "beta",
      threadId: "beta-1",
      model: "gpt-5.5",
      totalTokens: 500,
      outputTokens: 50,
      toolCalls: 1,
      rateCardCredits: null,
    },
  ];
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  assert.deepEqual(rows.map((row) => row.project), ["alpha", "beta"]);
  assert.equal(rows[0].threads, 2);
  assert.deepEqual(
    rows[0].models.map((model) => model.model),
    ["Sol", "Luna"],
  );
  assert.equal(rows[0].totalTokens, 1_000);
});

test("project labels remove terminal control sequences before rendering", () => {
  const project = "\u001b]8;;https://example.test\u0007\u001b[31msecret\u001b[0m\u0000";
  const rows = aggregateProjects(
    { events: [], threads: [{ id: "thread-1", project }] },
    [{ project, threadId: "thread-1", totalTokens: 1 }],
    { rawProjects: true },
  );

  assert.equal(sanitizeTerminalText(project), "secret ");
  assert.equal(rows[0].project, "secret");
  assert.equal(rows[0].displayProject, "secret");
});

test("parseArgs accepts the day subcommand and date option", () => {
  const options = parseArgs([
    "day",
    "--date",
    "2026-08-01",
    "--top",
    "5",
    "--raw-projects",
  ]);
  assert.equal(options.date, "2026-08-01");
  assert.equal(options.top, 5);
  assert.equal(options.rawProjects, true);
});

test("parseArgs defaults the week end day to today", () => {
  const options = parseArgs(["week", "--top", "5"]);
  assert.equal(options.range, "week");
  assert.equal(options.date, "today");
  assert.equal(options.top, 5);
  assert.equal(options.autoRefresh, true);
  assert.equal(options.inputExplicit, false);
  assert.equal(
    options.timeZone,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  assert.equal(
    options.input,
    resolve(homedir(), ".token-ledger", "token-ledger-snapshot.json"),
  );
  assert.equal(options.input, DEFAULT_SNAPSHOT);
});

test("parseArgs accepts the bare 1d rolling project view", () => {
  const options = parseArgs(["1d", "--static", "--top", "5"]);
  assert.equal(options.range, "rolling24h");
  assert.equal(options.rolling24h, true);
  assert.equal(options.view, "projects");
  assert.equal(options.date, null);
  assert.equal(options.static, true);
  assert.equal(options.top, 5);

  const explicit = parseArgs(["day", "1d"]);
  assert.equal(explicit.range, "rolling24h");
  assert.equal(explicit.rolling24h, true);
  assert.throws(
    () => parseArgs(["week", "1d"]),
    /1d alias is only available as `tledger 1d` or `tledger day 1d`/,
  );
  assert.throws(
    () => parseArgs(["1d", "--date", "today"]),
    /does not accept --date/,
  );
});

test("parseArgs accepts rolling day and week duration aliases", () => {
  const twoDays = parseArgs(["2d", "--static"]);
  assert.equal(twoDays.range, "rolling");
  assert.equal(twoDays.rollingDuration, true);
  assert.equal(twoDays.rollingDays, 2);
  assert.equal(twoDays.rollingLabel, "2 days");
  assert.equal(twoDays.view, "projects");
  assert.equal(twoDays.date, null);

  const threeWeeks = parseArgs(["3w"]);
  assert.equal(threeWeeks.range, "rolling");
  assert.equal(threeWeeks.rollingDays, 21);
  assert.equal(threeWeeks.rollingLabel, "3 weeks");
  assert.throws(
    () => parseArgs(["2d", "today"]),
    /does not accept --date/,
  );
});

test("parseArgs accepts --no-open for trend images and rejects it elsewhere", () => {
  const options = parseArgs(["trend", "--image", "--no-open"]);
  assert.equal(options.image, true);
  assert.equal(options.openImage, false);
  assert.equal(parseArgs(["report"]).openImage, true);
  assert.throws(
    () => parseArgs(["week", "--no-open"]),
    /--no-open is only available for the trend view/,
  );
});

test("rolling view describes an empty range as the last 24 hours", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-rolling-empty-"));
  const snapshotPath = resolve(root, "snapshot.json");
  try {
    await writeFile(snapshotPath, JSON.stringify({ events: [], threads: [] }));
    const output = await run(parseArgs([
      "1d",
      "--input",
      snapshotPath,
      "--no-refresh",
      "--static",
      "--plain",
    ]));
    assert.match(output, /No model-call events found for the last 24 hours \(/);
    assert.match(output, /Source: snapshot\.json/);
    assert.ok(!output.includes(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redactLocalPaths redacts detected UNC path forms", () => {
  const backslashPath = "\\\\server\\share\\private\\snapshot.json";
  const normalizedPath = "//server/share/private/snapshot.json";
  const message =
    "unc=" +
    backslashPath +
    '; normalized="' +
    normalizedPath +
    '"';

  const redacted = redactLocalPaths(message);

  assert.equal(redacted, 'unc=[local path]; normalized="[local path]"');
  assert.ok(!redacted.includes("server"));
  assert.ok(!redacted.includes("share"));
});

test("redactLocalPaths preserves safe basenames for explicit UNC paths", () => {
  const backslashPath = "\\\\server\\share\\private\\snapshot.json";
  const normalizedPath = "//server/share/private/snapshot.json";

  assert.equal(
    redactLocalPaths("missing " + backslashPath, [backslashPath]),
    "missing snapshot.json",
  );
  assert.equal(
    redactLocalPaths("missing " + normalizedPath, [normalizedPath]),
    "missing snapshot.json",
  );
});

test("redactLocalPaths preserves URL schemes while redacting UNC paths", () => {
  const redacted = redactLocalPaths(
    "url=https://registry.npmjs.org/sharp; unc=//server/share/private/snapshot.json",
  );

  assert.equal(
    redacted,
    "url=https://registry.npmjs.org/sharp; unc=[local path]",
  );
});

test("snapshot errors retain safe labels without absolute paths", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-privacy-"));
  const missingPath = resolve(root, "missing-snapshot.json");
  const malformedPath = resolve(root, "malformed-snapshot.json");
  const unreadablePath = resolve(root, "unreadable-snapshot.json");
  try {
    await assert.rejects(
      () => run(parseArgs([
        "day",
        "2026-08-20",
        "--input",
        missingPath,
        "--no-refresh",
        "--static",
      ])),
      (error) => {
        assert.match(error.message, /Snapshot not found: missing-snapshot\.json/);
        assert.ok(!error.message.includes(root));
        return true;
      },
    );

    await writeFile(malformedPath, JSON.stringify({ threads: [] }));
    await assert.rejects(
      () => run(parseArgs([
        "day",
        "2026-08-20",
        "--input",
        malformedPath,
        "--no-refresh",
        "--static",
      ])),
      (error) => {
        assert.match(
          error.message,
          /Snapshot is missing its events array: malformed-snapshot\.json/,
        );
        assert.ok(!error.message.includes(root));
        return true;
      },
    );

    await mkdir(unreadablePath);
    await assert.rejects(
      () => run(parseArgs([
        "day",
        "2026-08-20",
        "--input",
        unreadablePath,
        "--no-refresh",
        "--static",
      ])),
      (error) => {
        assert.match(
          error.message,
          /Could not read snapshot unreadable-snapshot\.json/,
        );
        assert.match(error.message, /EISDIR|directory|read/);
        assert.ok(!error.message.includes(root));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh and source failures retain context without absolute paths", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-source-privacy-"));
  const missingCodexHome = resolve(root, "missing-codex-home");
  const staleSnapshotPath = resolve(root, "stale-snapshot.json");
  const codexHome = resolve(root, "codex-home");
  try {
    await assert.rejects(
      () => run(parseArgs([
        "week",
        "--refresh",
        "--codex-home",
        missingCodexHome,
      ])),
      (error) => {
        assert.match(
          error.message,
          /Codex data directory not found: missing-codex-home/,
        );
        assert.ok(!error.message.includes(root));
        return true;
      },
    );

    await mkdir(codexHome);
    await writeFile(resolve(codexHome, "sessions"), "not a directory");
    await writeFile(staleSnapshotPath, JSON.stringify({ events: [] }));
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    await utimes(staleSnapshotPath, staleTime, staleTime);

    const options = parseArgs(["week"]);
    options.input = staleSnapshotPath;
    options.inputExplicit = false;
    options.codexHome = codexHome;
    await assert.rejects(
      () => run(options),
      (error) => {
        assert.match(error.message, /Could not inspect local Codex source/);
        assert.match(error.message, /ENOTDIR|not a directory|scandir/);
        assert.ok(!error.message.includes(root));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("1d renders deterministic project totals from a rolling 24-hour fixture", async () => {
  const nowMs = Date.parse("2026-08-20T00:00:00.000Z");
  const output = await run(parseArgs([
    "1d",
    "--input",
    ROLLING_24H_FIXTURE,
    "--no-refresh",
    "--static",
    "--plain",
    "--ascii",
    "--tz",
    "Pacific/Honolulu",
    "--width",
    "120",
  ]), { nowMs });

  assert.match(output, /LAST 24 HOURS/);
  assert.match(output, /24 HOURS/);
  assert.match(output, /TOKENS BY PROJECT/);
  assert.match(output, /Alpha.*1\.20K/);
  assert.match(output, /Beta.*800/);
  assert.match(output, /2\.00K TOKENS/);
  assert.match(output, /SNAPSHOT · fresh · 15m old/);
  assert.doesNotMatch(output, /Gamma|Delta|5\.80K|10\.20K/);
  assert.ok(!output.includes(ROLLING_24H_FIXTURE));
});

test("static freshness uses the wall clock after snapshot loading", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-post-load-time-"));
  const snapshotPath = resolve(root, "snapshot.json");
  const beforeLoadMs = Date.parse("2026-08-20T00:00:00.000Z");
  const afterLoadMs = beforeLoadMs + 1_000;
  try {
    await writeFile(snapshotPath, JSON.stringify({
      generatedAt: new Date(afterLoadMs).toISOString(),
      events: [{
        project: "alpha",
        threadId: "alpha-1",
        model: "gpt-5.5",
        timestamp: "2026-08-19T12:00:00.000Z",
        totalTokens: 1,
        outputTokens: 0,
        toolCalls: 0,
        rateCardCredits: 1,
      }],
      threads: [{ id: "alpha-1", project: "alpha" }],
    }));

    const originalDateNow = Date.now;
    let nowCalls = 0;
    Date.now = () => {
      nowCalls += 1;
      return nowCalls === 1 ? beforeLoadMs : afterLoadMs;
    };
    try {
      const output = await run(parseArgs([
        "1d",
        "--input",
        snapshotPath,
        "--no-refresh",
        "--static",
        "--plain",
        "--ascii",
        "--tz",
        "UTC",
      ]));

      assert.match(output, /SNAPSHOT · fresh · now/);
      assert.equal(nowCalls, 2);
    } finally {
      Date.now = originalDateNow;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseArgs supports day and week trend windows", () => {
  const positional = parseArgs(["trend", "14d", "--static"]);
  assert.equal(positional.view, "trend");
  assert.equal(positional.range, "trend");
  assert.equal(positional.trendDays, 14);
  assert.equal(positional.date, "today");

  const option = parseArgs(["trend", "--period", "30d", "--date", "2026-08-15"]);
  assert.equal(option.trendDays, 30);
  assert.equal(option.date, "2026-08-15");
  assert.equal(parseArgs(["trend", "2w"]).trendDays, 14);
  assert.equal(parseArgs(["trend", "10d"]).trendDays, 10);
  assert.throws(
    () => parseArgs(["trend", "0d"]),
    /Duration must be between 1d and/,
  );
  assert.throws(
    () => parseArgs(["trend", "7d", "--period", "14d"]),
    /only be specified once/,
  );
  assert.throws(
    () => parseArgs(["week", "--period", "14d"]),
    /only available for the trend view/,
  );

  const image = parseArgs([
    "trend",
    "7d",
    "--image",
    "--image-output",
    "artifacts/trend.png",
    "--image-width",
    "1400",
  ]);
  assert.equal(image.image, true);
  assert.equal(image.imageOutput, resolve("artifacts/trend.png"));
  assert.equal(image.imageWidth, 1400);
  assert.throws(
    () => parseArgs(["day", "2026-08-15", "--image"]),
    /only available for the trend view/,
  );
  assert.throws(
    () => parseArgs(["trend", "7d", "--image-output", "trend.svg"]),
    /must end in .png/,
  );
});

test("parseArgs supports static output mode", () => {
  const options = parseArgs(["week", "--static"]);
  assert.equal(options.static, true);
});

test("parseArgs supports opting out of the automatic JSONL freshness check", () => {
  const options = parseArgs(["week", "--no-refresh"]);
  assert.equal(options.autoRefresh, false);
  assert.throws(
    () => parseArgs(["week", "--refresh", "--no-refresh"]),
    /cannot be combined/,
  );
});

test("parseArgs rejects refresh requests that target an explicit snapshot", () => {
  assert.throws(
    () => parseArgs([
      "day",
      "2026-08-18",
      "--input",
      "custom-snapshot.json",
      "--refresh",
    ]),
    /--refresh cannot be combined with --input/,
  );
});

test("snapshot freshness follows the newest local source mtime", () => {
  assert.equal(snapshotNeedsRefresh(100, 101), true);
  assert.equal(snapshotNeedsRefresh(100, 100), false);
  assert.equal(snapshotNeedsRefresh(100, 99), false);
});

test("recent snapshots skip the automatic source freshness walk", () => {
  const now = 1_000_000;
  assert.equal(snapshotCacheIsFresh(now, now), true);
  assert.equal(snapshotCacheIsFresh(now - 60 * 60 * 1000 + 1, now), true);
  assert.equal(snapshotCacheIsFresh(now - 60 * 60 * 1000, now), false);
  assert.equal(snapshotCacheIsFresh(now - 60 * 60 * 1000 - 1, now), false);
  assert.equal(snapshotCacheIsFresh(now + 1, now), false);
});

test("snapshot freshness labels the one-hour cache age without exposing paths", () => {
  const now = Date.parse("2026-08-20T00:00:00.000Z");
  assert.deepEqual(
    snapshotFreshness({ generatedAt: "2026-08-19T23:45:00.000Z" }, now),
    { status: "fresh", ageLabel: "15m old" },
  );
  assert.deepEqual(
    snapshotFreshness({ generatedAt: "2026-08-19T23:00:00.000Z" }, now),
    { status: "stale", ageLabel: "1h old" },
  );
  assert.deepEqual(snapshotFreshness({}, now), {
    status: "unknown",
    ageLabel: "age unknown",
  });
  assert.deepEqual(
    snapshotFreshness({ generatedAt: "not-a-date" }, now),
    { status: "unknown", ageLabel: "age unknown" },
  );
  for (const generatedAt of [0, {}, { toString: null, valueOf: null }]) {
    assert.deepEqual(snapshotFreshness({ generatedAt }, now), {
      status: "unknown",
      ageLabel: "age unknown",
    });
  }
});

test("interactive controls stay aligned with rendered and documented help", async () => {
  for (const input of INTERACTIVE_KEY_INPUTS.up) assert.equal(actionFor(input), "up");
  for (const input of INTERACTIVE_KEY_INPUTS.down) assert.equal(actionFor(input), "down");
  for (const input of INTERACTIVE_KEY_INPUTS.quit) assert.equal(actionFor(input), "quit");
  for (const input of ["\r", "\n", "d", "w", "m"]) {
    assert.equal(actionFor(input), null);
  }

  const snapshot = {
    events: [],
    threads: [{ id: "alpha-1", project: "alpha" }],
  };
  const events = [{
    project: "alpha",
    threadId: "alpha-1",
    model: "gpt-5.5",
    totalTokens: 1,
    outputTokens: 0,
    toolCalls: 0,
    rateCardCredits: 1,
  }];
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const bounds = dayBounds("2026-08-01", "Pacific/Honolulu");
  const footerOutput = renderTerminal({
    options: { plain: true, ascii: true, width: 80 },
    snapshot,
    bounds,
    events,
    rows,
    allRows: rows,
  });
  assert.ok(footerOutput.includes(INTERACTIVE_FOOTER.ascii));
  assert.doesNotMatch(footerOutput, /inspect|range/);

  const fullscreenOutput = renderFullscreen({
    options: { plain: true, ascii: true, forceColor: false },
    snapshot,
    bounds,
    events,
    rows,
    allRows: rows,
    width: 120,
    height: 32,
  });
  assert.ok(fullscreenOutput.includes(INTERACTIVE_HELP));
  assert.doesNotMatch(fullscreenOutput, /inspect|range/);

  const readme = await readFile(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  );
  assert.match(readme, /`q`, `Q`, `Esc`, or `Ctrl-C` exits\./);
  assert.match(readme, /Enter does not inspect a project/);
  assert.match(readme, /`d` \/ `w` \/ `m` do not change the\s+range/);
});

test("terminal renderer produces the dashboard layout and scaled bars", () => {
  const snapshot = {
    events: [],
    threads: [
      { id: "alpha-1", project: "alpha" },
      { id: "alpha-2", project: "alpha" },
    ],
  };
  const events = [
    {
      project: "alpha",
      threadId: "alpha-1",
      model: "gpt-5.6-sol",
      inputTokens: 900,
      cachedInputTokens: 450,
      totalTokens: 1_000,
      outputTokens: 100,
      toolCalls: 1,
      useType: "sdk",
      rateCardCredits: 2,
    },
    {
      project: "alpha",
      threadId: "alpha-2",
      model: "gpt-5.6-luna",
      inputTokens: 200,
      cachedInputTokens: 100,
      totalTokens: 250,
      outputTokens: 25,
      toolCalls: 1,
      useType: "tool",
      rateCardCredits: 1,
    },
  ];
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const output = renderTerminal({
    options: { plain: true, ascii: true, width: 80 },
    bounds: dayBounds("2026-08-01", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });
  assert.match(output, /TOKENS BY PROJECT/);
  assert.match(output, /MODEL MIX/);
  assert.match(output, /USAGE TYPE · TOKENS/);
  assert.match(output, /SDK\s+80\.0%/);
  assert.match(output, /Tool\s+20\.0%/);
  assert.match(output, /CACHE · INPUT/);
  assert.match(output, /Cached\s+50\.0%/);
  assert.match(output, /Uncached\s+50\.0%/);
  assert.doesNotMatch(output, /THIS WINDOW|TOP 3 SHARE|CREDIT LEADER|BUSIEST PROJECT/);
  assert.match(output, /alpha\s+#+\s+1\.25K/);
  assert.doesNotMatch(output, /\|#+\|/);
  assert.match(output, /\[j\/k\] select/);
  assert.match(output, /2 threads · 100\.0% credits/);
  assert.doesNotMatch(output, /2 threads · 2 calls/);
  const compactHeader = output.split("\n")[0];
  assert.match(compactHeader, /TOKEN LEDGER · SAT 01 AUG · DAY · 1\.25K T · 2 C · 2 TH · 1 P/);
  assert.match(output.split("\n")[1], /^\+/);

  const weekOutput = renderTerminal({
    options: { plain: true, ascii: true, width: 80, range: "week" },
    bounds: weekBounds("2026-08-03", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });
  assert.match(weekOutput, /JUL 28–AUG 03/);
  assert.match(weekOutput, /7D/);
  const weekHeader = weekOutput.split("\n")[0];
  assert.match(weekHeader, /TOKEN LEDGER · JUL 28–AUG 03 · 7D · 1\.25K T · 2 C · 2 TH · 1 P/);

  const rollingSnapshot = {
    ...snapshot,
    generatedAt: "2026-08-19T23:45:00.000Z",
  };
  const rollingFreshness = snapshotFreshness(
    rollingSnapshot,
    Date.parse("2026-08-20T00:00:00.000Z"),
  );
  const rollingOutput = renderTerminal({
    options: { plain: true, ascii: true, width: 120, range: "rolling24h" },
    snapshot: rollingSnapshot,
    snapshotFreshness: rollingFreshness,
    bounds: rolling24hBounds(new Date("2026-08-19T22:15:30.000Z"), "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });
  assert.match(
    rollingOutput.split("\n")[0],
    /TOKEN LEDGER · LAST 24 HOURS · 24 HOURS · 1\.25K TOKENS · 2 CALLS · 2 THREADS · 1 PROJECTS/,
  );
  assert.match(rollingOutput, /SNAPSHOT · fresh · 15m old/);
  assert.doesNotMatch(rollingOutput, /token-ledger-snapshot\.json|\/Users\//);

  const fullscreenRollingOutput = renderFullscreen({
    options: {
      range: "rolling24h",
      plain: true,
      ascii: true,
      forceColor: false,
    },
    snapshot: rollingSnapshot,
    snapshotFreshness: rollingFreshness,
    bounds: rolling24hBounds(new Date("2026-08-19T22:15:30.000Z"), "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
    width: 100,
    height: 30,
  });
  assert.match(fullscreenRollingOutput, /SNAPSHOT · fresh · 15m old/);

  const narrowOutput = renderTerminal({
    options: { plain: true, ascii: true, width: 64 },
    bounds: dayBounds("2026-08-01", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });
  assert.ok(narrowOutput.split("\n").every((line) => line.length <= 64));
  assert.match(narrowOutput, /0\s+1\.25K/);
});

test("terminal renderer moves the selected project cursor", () => {
  const events = [
    {
      project: "alpha",
      threadId: "alpha-1",
      model: "gpt-5.6-luna",
      inputTokens: 100,
      cachedInputTokens: 0,
      totalTokens: 100,
      outputTokens: 0,
      useType: "sdk",
      rateCardCredits: 1,
    },
    {
      project: "beta",
      threadId: "beta-1",
      model: "gpt-5.6-sol",
      inputTokens: 50,
      cachedInputTokens: 0,
      totalTokens: 50,
      outputTokens: 0,
      useType: "sdk",
      rateCardCredits: 1,
    },
  ];
  const snapshot = { events, threads: [] };
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const output = renderTerminal({
    options: {
      plain: true,
      ascii: true,
      width: 102,
      selectedIndex: 1,
    },
    snapshot,
    bounds: dayBounds("2026-08-01", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });

  assert.match(output, /\|  1\. alpha/);
  assert.match(output, /\|> 2\. beta/);
});

test("quota context maps the selected range to reset-cycle burn", () => {
  const observation = {
    timestamp: "2026-08-02T00:00:00.000Z",
    usedPercent: 25,
    windowMinutes: 10_080,
    resetsAt: Date.parse("2026-08-07T00:00:00.000Z") / 1_000,
  };
  const events = [
    { timestamp: "2026-08-01T00:00:00.000Z", totalTokens: 800 },
    { timestamp: "2026-08-01T12:00:00.000Z", totalTokens: 200 },
    { timestamp: "2026-08-03T00:00:00.000Z", totalTokens: 1_000 },
  ];
  const snapshot = { events, quotaObservations: [observation] };
  const quota = quotaCycleSummary(snapshot, [events[0]]);

  assert.equal(quota.usedPercent, 25);
  assert.equal(quota.remainingPercent, 75);
  assert.equal(quota.cycleTokens, 1_000);
  assert.equal(quota.displayedTokens, 800);
  assert.equal(quota.displayedSharePercent, 80);
  assert.equal(quota.estimatedDisplayedBurnPercent, 20);

  const rows = [{
    project: "alpha",
    displayProject: "alpha",
    totalTokens: 800,
    outputTokens: 0,
    reasoningTokens: 0,
    toolCalls: 0,
    events: 1,
    threadIds: new Set(["alpha-1"]),
    threads: 1,
    rateCardCredits: 0,
    knownCreditTokens: 0,
    models: [],
  }];
  const output = renderTerminal({
    options: { plain: true, ascii: true, width: 102 },
    snapshot,
    bounds: weekBounds("2026-08-03", "Pacific/Honolulu"),
    events: [events[0]],
    rows,
    allRows: rows,
  });
  assert.match(output, /RESET CYCLE/);
  assert.match(output, /Used\s+25\.0%/);
  assert.match(output, /Remaining\s+75\.0%/);
  assert.match(output, /View burn\s+~20\.0 pts/);
});

test("quota burn recomputes current card credits when every cycle event is rated", () => {
  const observation = {
    timestamp: "2026-08-02T00:00:00.000Z",
    usedPercent: 20,
    windowMinutes: 10_080,
    resetsAt: Date.parse("2026-08-07T00:00:00.000Z") / 1_000,
  };
  const displayed = {
    timestamp: "2026-08-01T00:00:00.000Z",
    model: "gpt-5.6-luna",
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
    rateCardCredits: 1,
  };
  const other = {
    timestamp: "2026-08-01T12:00:00.000Z",
    model: "gpt-5.6-sol",
    inputTokens: 120_000,
    outputTokens: 0,
    totalTokens: 120_000,
    rateCardCredits: 99,
  };
  const quota = quotaCycleSummary(
    { events: [displayed, other], quotaObservations: [observation] },
    [displayed],
  );
  assert.equal(quota.shareBasis, "credits");
  assert.equal(quota.displayedSharePercent, 25);
  assert.equal(quota.estimatedDisplayedBurnPercent, 5);

  const fallbackDisplayed = {
    timestamp: "2026-08-01T00:00:00.000Z",
    totalTokens: 1_000,
    rateCardCredits: 10,
  };
  const fallbackOther = {
    timestamp: "2026-08-01T12:00:00.000Z",
    totalTokens: 1_000,
    rateCardCredits: null,
  };
  const fallback = quotaCycleSummary(
    {
      events: [fallbackDisplayed, fallbackOther],
      quotaObservations: [observation],
    },
    [fallbackDisplayed],
  );
  assert.equal(fallback.shareBasis, "tokens");
  assert.equal(fallback.displayedSharePercent, 50);
  assert.equal(fallback.estimatedDisplayedBurnPercent, 10);
});

test("compact totals promote values that round to 1000 of a unit", () => {
  const events = [
    {
      project: "alpha",
      threadId: "alpha-1",
      model: "gpt-5.6-sol",
      inputTokens: 900_000,
      cachedInputTokens: 0,
      totalTokens: 999_999,
      outputTokens: 99_999,
      useType: "sdk",
      rateCardCredits: 1,
    },
  ];
  const snapshot = { events, threads: [] };
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const output = renderTerminal({
    options: { plain: true, ascii: true, width: 102 },
    snapshot,
    bounds: dayBounds("2026-08-01", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });
  assert.match(output, /1\.00M/);
  assert.doesNotMatch(output, /1000K/);
});

test("rate lookups normalize whitespace model separators", () => {
  const usage = {
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 1_000_000,
  };
  const spaced = creditsForUsage("gpt-5.4 mini", usage);
  assert.equal(spaced, creditsForUsage("gpt-5.4-mini", usage));
  assert.notEqual(spaced, creditsForUsage("gpt-5.4", usage));
});

test("quota normalization is monotone inside cycles and marks resets", () => {
  const resetOne = Date.parse("2026-08-11T10:00:00.000Z") / 1_000;
  const observations = normalizeQuotaTimeline([
    {
      timestampMs: Date.parse("2026-08-09T12:00:00.000Z"),
      resetsAt: resetOne,
      usedPercent: 20,
    },
    {
      timestampMs: Date.parse("2026-08-10T12:00:00.000Z"),
      resetsAt: resetOne,
      usedPercent: 30,
    },
    {
      timestampMs: Date.parse("2026-08-11T12:00:00.000Z"),
      resetsAt: resetOne,
      usedPercent: 24,
    },
    {
      timestampMs: Date.parse("2026-08-12T12:00:00.000Z"),
      resetsAt: resetOne + 10_080 * 60,
      usedPercent: 5,
    },
  ]);
  assert.deepEqual(
    observations.map((observation) => observation.normalizedUsedPercent),
    [20, 30, 30, 5],
  );
  assert.deepEqual(
    observations.map((observation) => observation.reset),
    [false, false, false, true],
  );
  assert.deepEqual(
    observations.map((observation) => observation.cycle),
    [0, 0, 0, 1],
  );
});

test("combo trend bins actual tokens and overlays an explicit reset marker", () => {
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 7);
  const resetOne = Date.parse("2026-08-11T10:00:00.000Z") / 1_000;
  const snapshot = {
    events: [
      {
        timestamp: "2026-08-09T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1_000,
        inputTokens: 900,
        outputTokens: 100,
      },
      {
        timestamp: "2026-08-10T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 2_000,
        inputTokens: 1_800,
        outputTokens: 200,
      },
    ],
    quotaObservations: [
      {
        timestamp: "2026-08-09T12:00:00.000Z",
        usedPercent: 20,
        windowMinutes: 10_080,
        resetsAt: resetOne,
      },
      {
        timestamp: "2026-08-10T12:00:00.000Z",
        usedPercent: 30,
        windowMinutes: 10_080,
        resetsAt: resetOne,
      },
      {
        timestamp: "2026-08-12T12:00:00.000Z",
        usedPercent: 5,
        windowMinutes: 10_080,
        resetsAt: resetOne + 10_080 * 60,
      },
    ],
  };
  const bins = buildActualTokenBins(snapshot, bounds, 7, 96);
  assert.equal(bins.binSize, 1);
  assert.equal(bins.bins[0].totalTokens, 1_000);
  assert.equal(bins.bins[1].totalTokens, 2_000);
  assert.equal(bins.totals.get("Luna"), 1_000);
  assert.equal(bins.totals.get("Sol"), 2_000);

  const trend = buildUsageTrend(snapshot, bounds);
  const output = renderTrendPlain({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { width: 96 },
  });
  assert.match(output, /ACTUAL TOKENS \+ WEEKLY QUOTA/);
  assert.match(output, /-% row = observed drain/);
  assert.match(output, /LEFT AXIS/);
  assert.match(output, /RIGHT AXIS/);
  assert.match(output, /CALENDAR DAY · -% = OBSERVED METER DROP/);
  assert.match(output, /■ Luna 1\.00K/);
  assert.match(output, /■ Sol 2\.00K/);
  assert.match(output, /-20%~/);
  assert.match(output, /-10%/);
  assert.match(output, /-5%/);
  assert.doesNotMatch(output, /-0%/);
  assert.match(output, /↟ reset marker returns the line to 100%/);
  assert.ok(output.split("\n").every((line) => line.length <= 96));

  const drainOutput = renderTrendPlain({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { width: 96, drain: true },
  });
  assert.match(drainOutput, /OBSERVED LIMIT DRAIN \+ WEEKLY METER/);
  assert.match(drainOutput, /one percent scale/);
  assert.match(drainOutput, /■ Luna 20\.0% of limit · 1\.00K tok/);
  assert.match(drainOutput, /■ Sol 10\.0% of limit · 2\.00K tok/);
  assert.match(drainOutput, /■ Unattributed 5\.00% of limit/);
  assert.match(drainOutput, /Columns sum to observed meter drops/);
});

test("image trend renderer emits stacked model bars and a quota line", () => {
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 7);
  const resetOne = Date.parse("2026-08-11T10:00:00.000Z") / 1_000;
  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: [
      {
        timestamp: "2026-08-09T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1_000,
      },
      {
        timestamp: "2026-08-10T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 2_000,
        serviceTier: "priority",
      },
      {
        timestamp: "2026-08-11T12:00:00.000Z",
        model: "auto-review",
        totalTokens: 500,
      },
    ],
    quotaObservations: [
      {
        timestamp: "2026-08-09T12:00:00.000Z",
        usedPercent: 20,
        windowMinutes: 10_080,
        resetsAt: resetOne,
      },
      {
        timestamp: "2026-08-10T12:00:00.000Z",
        usedPercent: 30,
        windowMinutes: 10_080,
        resetsAt: resetOne,
      },
      {
        timestamp: "2026-08-12T12:00:00.000Z",
        usedPercent: 5,
        windowMinutes: 10_080,
        resetsAt: resetOne + 10_080 * 60,
      },
    ],
  };
  const svg = renderTrendImage({
    snapshot,
    bounds,
    trend: buildUsageTrend(snapshot, bounds),
    days: 7,
    options: { imageWidth: 1_000 },
  });
  assert.match(svg, /<title[^>]*>Token Ledger · 7-day trend<\/title>/);
  assert.match(svg, /fill="#3b82f6"/);
  assert.match(svg, /fill="#10a394"/);
  assert.match(svg, /ACTUAL TOKEN VOLUME/);
  assert.match(svg, /WEEKLY METER REMAINING/);
  assert.match(svg, /35\.0 meter points/);
  assert.match(svg, /ESTIMATED COST/);
  assert.match(svg, /stroke="#f6b73c"/);
  assert.match(svg, /Luna/);
  assert.match(svg, /Sol/);
  // The fixture's second window follows a genuine weekly expiry, so the
  // reset break, its dated footnote, and the plain-language reset count all
  // appear.
  assert.match(svg, /RESET 100%/);
  assert.match(svg, /1 scheduled · 0 early/);
  assert.match(svg, /was the normal weekly reset/);
  assert.match(svg, /meter last read Aug 12, 2:00 AM/);
  assert.doesNotMatch(svg, /meter last read Aug 16/);
  // The all-fast Sol segment gets the darker fast-mode shade, and the fast
  // mode stat card explains it.
  assert.match(svg, /fill="#0a655c"/);
  assert.match(svg, /FAST MODE/);
  assert.match(svg, /1\.50× rate/);
  assert.match(svg, /Darker shade = fast mode/);
  // The projects and pace row is fed from the events in range.
  assert.match(svg, /WHERE IT WENT · TOP PROJECTS/);
  assert.match(svg, /PACE &amp; RUNWAY/);
  assert.match(svg, /tokens per meter point/);
  assert.ok((svg.match(/<rect /g) ?? []).length >= 4);

  const drainSvg = renderTrendImage({
    snapshot,
    bounds,
    trend: buildUsageTrend(snapshot, bounds),
    days: 7,
    options: { imageWidth: 1_000, drain: true },
  });
  assert.match(drainSvg, /OBSERVED LIMIT DRAIN/);
  assert.match(drainSvg, /Bars = observed meter drops/);
  assert.match(drainSvg, /35\.0 meter points/);
});

test("cache report weights cached input, clamps event values, and keeps models secondary", () => {
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 7);
  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: [
      {
        timestamp: "2026-08-09T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1_200,
        inputTokens: 1_000,
        cachedInputTokens: 800,
        outputTokens: 200,
      },
      {
        timestamp: "2026-08-10T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1_100,
        inputTokens: 1_000,
        cachedInputTokens: 100,
        outputTokens: 100,
      },
      {
        timestamp: "2026-08-11T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 600,
        inputTokens: 500,
        cachedInputTokens: 900,
        outputTokens: 100,
      },
      {
        timestamp: "2026-08-12T12:00:00.000Z",
        model: "gpt-5.5",
        totalTokens: 300,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        breakdownAvailable: false,
      },
      {
        timestamp: "2026-08-02T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 1_100,
        inputTokens: 1_000,
        cachedInputTokens: 250,
        outputTokens: 100,
      },
    ],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.equal(data.inputTokens, 2_500);
  assert.equal(data.cachedInputTokens, 1_400);
  assert.equal(data.uncachedInputTokens, 1_100);
  assert.ok(Math.abs(data.rate - 56) < 0.0001);
  assert.equal(data.measurementCoveragePercent, 90.625);
  assert.equal(data.inputEventCount, 3);
  assert.equal(data.bins[0].rate, 80);
  assert.equal(data.bins[1].rate, 10);
  assert.equal(data.bins[2].rate, 100);
  assert.deepEqual(
    data.models.map((model) => [model.model, model.rate]),
    [["Luna", 45], ["Sol", 100]],
  );

  const svg = renderCacheReportImage({
    snapshot,
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
  });
  assert.match(svg, /Token Ledger · 7-day cache report/);
  assert.match(svg, /56\.0% cached/);
  assert.match(svg, /Prior 25\.0% · \+31\.0 pp/);
  assert.match(svg, /CACHE RATE BY PERIOD/);
  assert.match(svg, />MODEL<\/text>/);
  assert.match(svg, /Luna/);
  assert.match(svg, /Sol/);
  assert.match(svg, /MEASUREMENT COVERAGE/);
  assert.match(svg, /cached input ÷ measured input/);
  assert.match(svg, /3 measured input-bearing calls/);
  assert.doesNotMatch(svg, /WHERE IT WENT|WEEKLY METER|NaN/);
});

test("cache report contains non-finite snapshot token values", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1_100,
        inputTokens: 1_000,
        cachedInputTokens: 600,
        outputTokens: 100,
        breakdownAvailable: true,
      },
      {
        timestamp: "2026-08-14T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: "1e999",
        inputTokens: "Infinity",
        cachedInputTokens: "Infinity",
        outputTokens: "Infinity",
        breakdownAvailable: true,
      },
    ],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.equal(data.totalTokens, 1_100);
  assert.equal(data.inputTokens, 1_000);
  assert.equal(data.cachedInputTokens, 600);
  assert.equal(data.rate, 60);
  const svg = renderCacheReportImage({ snapshot, bounds, days: 7 });
  assert.match(svg, /60\.0% cached/);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
});

test("cache report saturates finite token sums before rendering", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const huge = Number.MAX_VALUE;
  const eventFor = (model, includeReportedTotal = true) => {
    const event = {
      timestamp: "2026-08-15T12:00:00.000Z",
      model,
      inputTokens: huge,
      cachedInputTokens: huge,
      outputTokens: huge,
      breakdownAvailable: true,
    };
    if (includeReportedTotal) event.totalTokens = huge;
    return event;
  };
  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: [
      eventFor("gpt-5.6-luna", false),
      eventFor("gpt-5.6-luna"),
      eventFor("gpt-5.6-sol"),
      eventFor("gpt-5.6-terra"),
      eventFor("gpt-5.5"),
      eventFor("gpt-5.4"),
      eventFor("gpt-5.5-daybreak-blue-latest"),
      eventFor("gpt-5.5-auto-review"),
    ],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.equal(data.totalTokens, huge);
  assert.equal(data.detailedTokens, huge);
  assert.equal(data.inputTokens, huge);
  assert.equal(data.cachedInputTokens, huge);
  assert.equal(data.uncachedInputTokens, 0);
  assert.equal(data.rate, 100);
  assert.equal(data.bins.at(-1).totalTokens, huge);
  assert.equal(data.bins.at(-1).inputTokens, huge);
  assert.ok(data.models.every((model) => Number.isFinite(model.inputTokens)));

  const svg = renderCacheReportImage({ snapshot, bounds, days: 7 });
  assert.match(svg, /Other models/);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
  assert.doesNotMatch(svg, /(?:width|height|x|y)="NaN/);

  const control = buildCacheReportData({
    events: [{
      timestamp: "2026-08-15T12:00:00.000Z",
      model: "gpt-5.6-luna",
      totalTokens: 12,
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 2,
      breakdownAvailable: true,
    }],
  }, bounds, 7, 1_100);
  assert.equal(control.totalTokens, 12);
  assert.equal(control.inputTokens, 10);
  assert.equal(control.cachedInputTokens, 4);
  assert.equal(control.rate, 40);
});

test("cache report coverage includes inferred event totals", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        inputTokens: 900,
        cachedInputTokens: 450,
        outputTokens: 100,
      },
      {
        timestamp: "2026-08-14T12:00:00.000Z",
        totalTokens: 1_000,
        breakdownAvailable: false,
      },
    ],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.equal(data.totalTokens, 2_000);
  assert.equal(data.detailedTokens, 1_000);
  assert.equal(data.measurementCoveragePercent, 50);
  assert.equal(data.bins.at(-1).totalTokens, 1_000);
  assert.equal(data.bins.at(-1).detailedTokens, 1_000);
  assert.equal(data.bins.at(-1).measurementCoveragePercent, 100);
});

test("cache report contains hostile object-shaped snapshot fields", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const hostileValue = () => ({ toString: null, valueOf: null });
  const snapshot = {
    generatedAt: hostileValue(),
    events: [
      {
        timestamp: hostileValue(),
        model: "gpt-5.6-sol",
        totalTokens: 1_000,
        inputTokens: 900,
        cachedInputTokens: 450,
        outputTokens: 100,
      },
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        model: hostileValue(),
        totalTokens: 1_000,
        inputTokens: 900,
        cachedInputTokens: 450,
        outputTokens: 100,
      },
      {
        timestamp: "2026-08-15T13:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: hostileValue(),
        inputTokens: hostileValue(),
        cachedInputTokens: hostileValue(),
        outputTokens: hostileValue(),
        breakdownAvailable: true,
      },
    ],
  };

  let data;
  let svg;
  assert.doesNotThrow(() => {
    data = buildCacheReportData(snapshot, bounds, 7, 1_100);
    svg = renderCacheReportImage({ snapshot, bounds, days: 7 });
  });
  assert.equal(data.eventCount, 2);
  assert.equal(data.totalTokens, 1_000);
  assert.equal(data.inputTokens, 900);
  assert.deepEqual(
    data.models.map((model) => [model.model, model.inputTokens]),
    [["Unknown", 900]],
  );
  assert.match(svg, />unknown<\/text>/);
  assert.match(svg, /Unknown/);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
});

test("cache report labels non-string generation timestamps as unknown", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1_000,
        inputTokens: 900,
        cachedInputTokens: 450,
        outputTokens: 100,
      },
    ],
  };

  for (const generatedAt of [null, 0, { toString: null, valueOf: null }]) {
    const svg = renderCacheReportImage({
      snapshot: { ...snapshot, generatedAt },
      bounds,
      days: 7,
    });
    assert.match(svg, /DATA AS OF[\s\S]*>unknown<\/text>/);
  }
});

test("cache report coalesces overflow models and renders zero-measurement state", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const modelNames = [
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.5-daybreak-blue-latest",
    "gpt-5.5-auto-review",
  ];
  const overflowSnapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: modelNames.map((model, index) => {
      const inputTokens = (index + 1) * 100;
      return {
        timestamp: "2026-08-15T12:00:00.000Z",
        model,
        totalTokens: inputTokens + 10,
        inputTokens,
        cachedInputTokens: inputTokens / 2,
        outputTokens: 10,
        breakdownAvailable: true,
      };
    }),
  };
  const overflowSvg = renderCacheReportImage({
    snapshot: overflowSnapshot,
    bounds,
    days: 7,
  });
  assert.match(
    overflowSvg,
    /Other models<\/text>[\s\S]{0,800}>50\.0%<\/text>/,
  );

  const unmeasuredSnapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: [{
      timestamp: "2026-08-15T12:00:00.000Z",
      model: "gpt-5.6-luna",
      totalTokens: 1_000,
      inputTokens: 900,
      cachedInputTokens: 450,
      outputTokens: 100,
      breakdownAvailable: false,
    }],
  };
  const unmeasured = buildCacheReportData(unmeasuredSnapshot, bounds, 7, 1_100);
  assert.equal(unmeasured.rate, null);
  assert.equal(unmeasured.measurementCoveragePercent, 0);
  const unmeasuredSvg = renderCacheReportImage({
    snapshot: unmeasuredSnapshot,
    bounds,
    days: 7,
  });
  assert.match(unmeasuredSvg, /No measured input/);
  assert.match(unmeasuredSvg, /0\.00% of token volume/);
  assert.match(unmeasuredSvg, /0 measured input-bearing calls/);
  assert.doesNotMatch(unmeasuredSvg, /NaN|Infinity|undefined/);
});

test("cache report separates the final multi-day axis label", () => {
  const bounds = multiDayBounds("2026-08-20", "UTC", 90);
  const snapshot = {
    generatedAt: "2026-08-20T12:00:00.000Z",
    events: [],
  };
  const data = buildCacheReportData(snapshot, bounds, 90, 1_104);
  assert.equal(data.binSize, 3);
  assert.equal(data.binCount, 30);
  const svg = renderCacheReportImage({ snapshot, bounds, days: 90 });
  assert.match(svg, /Aug 18–Aug 20/);
  assert.doesNotMatch(svg, /Aug 12–Aug 14/);
});

test("cache report keeps 30 daily bins at default width and coalesces at minimum width", () => {
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 30);
  const snapshot = {
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 100,
        inputTokens: 90,
        cachedInputTokens: 45,
        outputTokens: 10,
      },
    ],
  };
  const defaultWidth = buildCacheReportData(snapshot, bounds, 30, 1_104);
  assert.equal(defaultWidth.binSize, 1);
  assert.equal(defaultWidth.binCount, 30);

  const minimumWidth = buildCacheReportData(snapshot, bounds, 30, 724);
  assert.equal(minimumWidth.binSize, 2);
  assert.equal(minimumWidth.binCount, 15);
});

test("cache report wraps long timezone footer text at minimum width", () => {
  const timeZone = "America/Argentina/ComodRivadavia";
  const bounds = multiDayBounds("2026-08-15", timeZone, 7);
  const minimumSvg = renderCacheReportImage({
    snapshot: { generatedAt: "2026-08-15T12:00:00.000Z", events: [] },
    bounds,
    days: 7,
    options: { imageWidth: 900 },
  });

  assert.match(minimumSvg, />America\/Argentina\/ComodRivadavia<\/text>/);
  assert.match(minimumSvg, />7-day calendar window<\/text>/);
  assert.doesNotMatch(
    minimumSvg,
    /America\/Argentina\/ComodRivadavia · 7-day calendar window/,
  );

  const shortZoneSvg = renderCacheReportImage({
    snapshot: { generatedAt: "2026-08-15T12:00:00.000Z", events: [] },
    bounds: multiDayBounds("2026-08-15", "UTC", 7),
    days: 7,
    options: { imageWidth: 900 },
  });
  assert.match(shortZoneSvg, />UTC · 7-day calendar window<\/text>/);

  const wideSvg = renderCacheReportImage({
    snapshot: { generatedAt: "2026-08-15T12:00:00.000Z", events: [] },
    bounds,
    days: 7,
    options: { imageWidth: 2_400 },
  });
  assert.match(
    wideSvg,
    />America\/Argentina\/ComodRivadavia · 7-day calendar window<\/text>/,
  );
});

test("cache report moves long timezone header metadata below the title", () => {
  const timeZone = "America/Argentina/ComodRivadavia";
  const bounds = multiDayBounds("2026-08-15", timeZone, 7);
  const minimumSvg = renderCacheReportImage({
    snapshot: { events: [] },
    bounds,
    days: 7,
    options: { imageWidth: 900 },
  });

  assert.match(
    minimumSvg,
    /<text x="32" y="53"[^>]*>TOKEN LEDGER · CACHE REPORT<\/text>/,
  );
  assert.match(
    minimumSvg,
    /<text x="868" y="77"[^>]*>Aug 9 – Aug 15, 2026 · America\/Argentina\/ComodRivadavia<\/text>/,
  );

  const shortZoneSvg = renderCacheReportImage({
    snapshot: { events: [] },
    bounds: multiDayBounds("2026-08-15", "UTC", 7),
    days: 7,
    options: { imageWidth: 900 },
  });
  assert.match(
    shortZoneSvg,
    /<text x="868" y="53"[^>]*>Aug 9 – Aug 15, 2026 · UTC<\/text>/,
  );
  assert.doesNotMatch(
    shortZoneSvg,
    /<text x="868" y="77"[^>]*>Aug 9 – Aug 15, 2026 · UTC<\/text>/,
  );

  const wideSvg = renderCacheReportImage({
    snapshot: { events: [] },
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
  });
  assert.match(
    wideSvg,
    /<text x="1248" y="53"[^>]*>Aug 9 – Aug 15, 2026 · America\/Argentina\/ComodRivadavia<\/text>/,
  );
});

test("cache report spaces long multi-day labels at minimum width", () => {
  const bounds = multiDayBounds("2026-08-20", "UTC", 180);
  const svg = renderCacheReportImage({
    snapshot: { events: [] },
    bounds,
    days: 180,
    options: { imageWidth: 900 },
  });
  const labels = [...svg.matchAll(
    /<text x="([^"]+)" y="730"[^>]*>([^<]+)<\/text>/g,
  )].map((match) => ({
    x: Number(match[1]),
    value: match[2],
  }));

  assert.ok(labels.length >= 2, "expected multiple date labels");
  for (let index = 1; index < labels.length; index += 1) {
    const previous = labels[index - 1];
    const current = labels[index];
    const minimumDistance =
      (textWidth(previous.value, 13) + textWidth(current.value, 13)) / 2 + 12;
    assert.ok(
      current.x - previous.x >= minimumDistance,
      `${previous.value} overlaps ${current.value}`,
    );
  }
});

test("PNG image output has a real PNG signature", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-png-"));
  try {
    const output = resolve(root, "report.png");
    await writeTrendPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="#10a394"/></svg>',
      output,
    );
    const bytes = await readFile(output);
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report emits progress while generating the PNG", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-report-"));
  const snapshotPath = resolve(root, "snapshot.json");
  const outputPath = resolve(root, "report.png");
  const originalWrite = process.stderr.write;
  const stderr = [];
  try {
    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        generatedAt: "2026-08-15T12:00:00.000Z",
        events: [
          {
            timestamp: "2026-08-15T12:00:00.000Z",
            model: "gpt-5.5",
            totalTokens: 1_000,
            inputTokens: 900,
            cachedInputTokens: 0,
            outputTokens: 100,
            reasoningTokens: 0,
            serviceTier: null,
            rateCardCredits: 0.2,
          },
        ],
        threads: [],
        quotaObservations: [],
      })}\n`,
    );
    process.stderr.write = (chunk) => {
      stderr.push(String(chunk));
      return true;
    };
    const result = await run(parseArgs([
      "report",
      "7d",
      "--date",
      "2026-08-15",
      "--tz",
      "UTC",
      "--input",
      snapshotPath,
      "--image-output",
      outputPath,
    ]));
    assert.match(result, /Wrote report:/);
    assert.deepEqual(
      [...(await readFile(outputPath)).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    const progress = stderr.join("");
    assert.match(progress, /generating report PNG/);
    assert.match(progress, /encoding report PNG/);
    assert.match(progress, /finished report PNG/);
  } finally {
    process.stderr.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});

test("cache-rate report uses its separate renderer and progress label", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-cache-report-"));
  const snapshotPath = resolve(root, "snapshot.json");
  const outputPath = resolve(root, "cache-report.png");
  const originalWrite = process.stderr.write;
  const stderr = [];
  try {
    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        generatedAt: "2026-08-15T12:00:00.000Z",
        events: [
          {
            timestamp: "2026-08-15T12:00:00.000Z",
            model: "gpt-5.6-luna",
            totalTokens: 1_000,
            inputTokens: 900,
            cachedInputTokens: 600,
            outputTokens: 100,
          },
        ],
        threads: [],
        quotaObservations: [],
      })}\n`,
    );
    process.stderr.write = (chunk) => {
      stderr.push(String(chunk));
      return true;
    };
    const result = await run(parseArgs([
      "report",
      "7d",
      "--cache-rate",
      "--date",
      "2026-08-15",
      "--tz",
      "UTC",
      "--input",
      snapshotPath,
      "--image-output",
      outputPath,
    ]));
    assert.match(result, /Wrote cache report:/);
    assert.deepEqual(
      [...(await readFile(outputPath)).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    const progress = stderr.join("");
    assert.match(progress, /generating cache report PNG/);
    assert.match(progress, /encoding cache report PNG/);
    assert.match(progress, /finished cache report PNG/);
  } finally {
    process.stderr.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});

test("cache-rate report ignores unused project metadata for an empty range", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-cache-empty-"));
  const snapshotPath = resolve(root, "snapshot.json");
  const outputPath = resolve(root, "cache-report.png");
  const originalWrite = process.stderr.write;
  try {
    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        generatedAt: "2026-08-15T12:00:00.000Z",
        events: [
          null,
          { timestamp: { toString: null, valueOf: null } },
          {
            timestamp: "2026-07-01T12:00:00.000Z",
            model: "gpt-5.6-luna",
            totalTokens: 1_000,
            inputTokens: 900,
            cachedInputTokens: 450,
            outputTokens: 100,
          },
        ],
        threads: [null],
      })}\n`,
    );
    process.stderr.write = () => true;
    const result = await run(parseArgs([
      "report",
      "7d",
      "--cache-rate",
      "--date",
      "2026-08-15",
      "--tz",
      "UTC",
      "--input",
      snapshotPath,
      "--image-output",
      outputPath,
      "--no-open",
    ]));
    assert.match(result, /Wrote cache report:/);
    assert.deepEqual(
      [...(await readFile(outputPath)).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
  } finally {
    process.stderr.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});

test("standard image views retain the empty-range diagnostic", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-standard-empty-"));
  const snapshotPath = resolve(root, "snapshot.json");
  try {
    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        generatedAt: "2026-08-15T12:00:00.000Z",
        events: [
          null,
          { timestamp: { toString: null, valueOf: null } },
          {
            timestamp: "2026-07-01T12:00:00.000Z",
            model: "gpt-5.6-luna",
            totalTokens: 1_000,
            inputTokens: 900,
            outputTokens: 100,
          },
        ],
      })}\n`,
    );
    const commands = [
      ["report", "7d"],
      ["trend", "7d", "--image"],
    ];
    for (const [index, command] of commands.entries()) {
      const outputPath = resolve(root, `standard-${index}.png`);
      const result = await run(parseArgs([
        ...command,
        "--date",
        "2026-08-15",
        "--tz",
        "UTC",
        "--input",
        snapshotPath,
        "--image-output",
        outputPath,
        "--no-open",
      ]));
      assert.match(result, /No model-call events found/);
      await assert.rejects(readFile(outputPath), { code: "ENOENT" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cache-rate report uses a distinct default filename", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-cache-default-"));
  const snapshotPath = resolve(root, "snapshot.json");
  const outputPath = resolve(root, "token-ledger-cache-report-7d.png");
  try {
    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        generatedAt: "2026-08-15T12:00:00.000Z",
        events: [
          {
            timestamp: "2026-08-15T12:00:00.000Z",
            model: "gpt-5.6-sol",
            totalTokens: 1_000,
            inputTokens: 900,
            cachedInputTokens: 450,
            outputTokens: 100,
          },
        ],
      })}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        CLI_ENTRYPOINT,
        "report",
        "7d",
        "--cache-rate",
        "--date",
        "2026-08-15",
        "--tz",
        "UTC",
        "--input",
        snapshotPath,
        "--no-open",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Wrote cache report:/);
    assert.match(result.stdout, /token-ledger-cache-report-7d\.png/);
    assert.deepEqual(
      [...(await readFile(outputPath)).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("30-day trend bins use readable multi-day columns", () => {
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 30);
  const snapshot = {
    events: [
      {
        timestamp: "2026-07-20T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1,
      },
    ],
  };
  const narrow = buildActualTokenBins(snapshot, bounds, 30, 96);
  const wide = buildActualTokenBins(snapshot, bounds, 30, 120);
  assert.equal(narrow.binSize, 3);
  assert.equal(wide.binSize, 2);
  assert.equal(narrow.binCount, 10);
  assert.equal(wide.binCount, 15);

  const forced = buildActualTokenBins(snapshot, bounds, 30, 96, { binSize: 1 });
  assert.equal(forced.binSize, 1);
  assert.equal(forced.binCount, 30);
});

test("long trend windows fit terminal and image column widths", () => {
  const days = 3_650;
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", days);
  const snapshot = {
    events: [{
      timestamp: "2026-08-14T12:00:00.000Z",
      model: "gpt-5.6-luna",
      totalTokens: 1,
    }],
  };
  const terminal = buildActualTokenBins(snapshot, bounds, days, 36);
  assert.ok(terminal.binCount <= 36);
  assert.ok(terminal.binSize > 1);
  const terminalOutput = renderTrendPlain({
    snapshot,
    bounds,
    trend: buildUsageTrend(snapshot, bounds),
    days,
    options: { width: 96 },
  });
  assert.ok(terminalOutput.split("\n").every((line) => line.length <= 96));

  const imagePlotWidth = 1_280 - 124 - 126;
  const image = buildActualTokenBins(snapshot, bounds, days, imagePlotWidth, {
    minBinWidth: 26,
    preferDaily: true,
  });
  assert.ok(image.binCount <= Math.floor(imagePlotWidth / 26));
  assert.ok(image.binSize > 1);
  const svg = renderTrendImage({
    snapshot,
    bounds,
    trend: buildUsageTrend(snapshot, bounds),
    days,
    options: { imageWidth: 1_280 },
  });
  assert.match(svg, /<title[^>]*>Token Ledger · 3650-day trend<\/title>/);
  assert.doesNotMatch(svg, /NaN/);
});

test("the 30-day report image draws one bar per calendar day", () => {
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 30);
  const snapshot = {
    events: [
      {
        timestamp: "2026-07-20T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 5_000_000,
      },
      {
        timestamp: "2026-08-14T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 7_500_000,
      },
    ],
  };
  const svg = renderTrendImage({
    snapshot,
    bounds,
    trend: buildUsageTrend(snapshot, bounds),
    days: 30,
    options: { imageWidth: 1_280 },
  });
  assert.match(svg, /<title[^>]*>Token Ledger · 30-day trend<\/title>/);
  // Weekday captions only render on per-day columns, so their presence shows
  // the 30-day window still fits as daily bars at this image width.
  assert.match(svg, /\bTUE\b/);
  // Per-day columns mean no multi-day range labels like "Jul 17–19" beneath
  // the bars (the en dash in the header subtitle is surrounded by spaces).
  assert.doesNotMatch(svg, /\d–[A-Za-z]*\s*\d/);
});

test("fullscreen renderer applies the Codex Blue terminal theme", () => {
  const snapshot = { events: [] };
  const events = [
    {
      project: "alpha",
      threadId: "alpha-1",
      model: "gpt-5.6-sol",
      inputTokens: 800,
      cachedInputTokens: 400,
      totalTokens: 1_000,
      outputTokens: 200,
      rateCardCredits: 2,
      useType: "sdk",
    },
  ];
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const output = renderFullscreen({
    options: { range: "day", plain: false, ascii: false, forceColor: true },
    bounds: dayBounds("2026-08-01", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
    width: 100,
    height: 30,
  });
  assert.equal(output.split("\n").length, 30);
  assert.doesNotMatch(output, /TOKEN LEDGER — USAGE/);
  assert.doesNotMatch(output, /●/);
  assert.match(output, /\u001b\[38;2;255;255;255m/);
  assert.match(output, /\u001b\[38;2;51;156;255m/);
  assert.match(output, /\u001b\[38;2;120;185;242m/);
  assert.match(output, /\u001b\[38;2;214;168;95m/);
  assert.match(output, /\u001b\[38;2;174;139;219m/);
  assert.match(output, /\u001b\[38;2;116;125;144m/);
  assert.match(output, /\u001b\[38;2;155;155;155m/);
  assert.match(output, /\u001b\[38;2;88;88;88m/);
  assert.match(output, /\u001b\[38;2;59;59;59m/);
  assert.match(output, /\u001b\[48;2;30;30;30m/);
  assert.match(output, /\u001b\[48;2;24;24;24m/);
  assert.doesNotMatch(output, /\u001b\[(?:38|48);5;/);
});

test("epoch-keyed cycles split limit restarts and classify reset kinds", () => {
  const epochOne = Date.parse("2026-08-10T00:00:00.000Z") / 1_000;
  const epochTwo = Date.parse("2026-08-12T00:00:00.000Z") / 1_000;
  const observations = normalizeQuotaTimeline([
    {
      timestampMs: Date.parse("2026-08-04T00:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 50,
    },
    {
      timestampMs: Date.parse("2026-08-04T12:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 90,
    },
    // A fresh window starts days before the old one expires: a limit restart,
    // not a weekly reset, and never a continuation of the old cycle.
    {
      timestampMs: Date.parse("2026-08-05T00:00:00.000Z"),
      resetsAt: epochTwo,
      usedPercent: 0,
    },
    {
      timestampMs: Date.parse("2026-08-05T12:00:00.000Z"),
      resetsAt: epochTwo,
      usedPercent: 30,
    },
  ]);
  assert.deepEqual(
    observations.map((observation) => observation.cycle),
    [0, 0, 1, 1],
  );
  assert.equal(observations[2].reset, true);
  assert.equal(observations[2].resetKind, "restart");
  assert.deepEqual(
    observations.map((observation) => observation.normalizedUsedPercent),
    [50, 90, 0, 30],
  );
});

test("stale readings from a superseded window are dropped", () => {
  const epochOne = Date.parse("2026-08-10T00:00:00.000Z") / 1_000;
  const epochTwo = Date.parse("2026-08-12T00:00:00.000Z") / 1_000;
  const observations = normalizeQuotaTimeline([
    {
      timestampMs: Date.parse("2026-08-04T00:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 50,
    },
    {
      timestampMs: Date.parse("2026-08-05T00:00:00.000Z"),
      resetsAt: epochTwo,
      usedPercent: 5,
    },
    // A long-lived session still echoing the superseded window must not fold
    // its reading into the new cycle.
    {
      timestampMs: Date.parse("2026-08-05T06:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 95,
    },
    {
      timestampMs: Date.parse("2026-08-05T12:00:00.000Z"),
      resetsAt: epochTwo,
      usedPercent: 20,
    },
  ]);
  assert.equal(observations.length, 3);
  assert.deepEqual(
    observations.map((observation) => observation.normalizedUsedPercent),
    [50, 5, 20],
  );
});

test("a transient branch window inside a live cycle is ignored", () => {
  const epochOne = Date.parse("2026-08-10T00:00:00.000Z") / 1_000;
  const phantom = Date.parse("2026-08-14T00:00:00.000Z") / 1_000;
  const observations = normalizeQuotaTimeline([
    {
      timestampMs: Date.parse("2026-08-04T00:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 20,
    },
    {
      timestampMs: Date.parse("2026-08-05T00:00:00.000Z"),
      resetsAt: phantom,
      usedPercent: 0,
    },
    {
      timestampMs: Date.parse("2026-08-06T00:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 40,
    },
    {
      timestampMs: Date.parse("2026-08-07T00:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 60,
    },
  ]);
  assert.deepEqual(
    observations.map((observation) => observation.cycle),
    [0, 0, 0],
  );
  assert.deepEqual(
    observations.map((observation) => observation.normalizedUsedPercent),
    [20, 40, 60],
  );
});

test("named limit buckets are not stitched into the account meter", () => {
  const accountEpoch = Date.parse("2026-08-16T00:00:00.000Z") / 1_000;
  const namedEpoch = Date.parse("2026-08-18T00:00:00.000Z") / 1_000;
  const snapshot = {
    quotaObservations: [
      {
        timestamp: "2026-08-12T00:00:00.000Z",
        usedPercent: 10,
        windowMinutes: 10_080,
        resetsAt: accountEpoch,
        limitKey: "aaa",
      },
      {
        timestamp: "2026-08-12T01:00:00.000Z",
        usedPercent: 50,
        windowMinutes: 10_080,
        resetsAt: namedEpoch,
        limitKey: "bbb",
        limitName: "GPT-5.3-Codex-Spark",
      },
      {
        timestamp: "2026-08-12T02:00:00.000Z",
        usedPercent: 20,
        windowMinutes: 10_080,
        resetsAt: accountEpoch,
        limitKey: "aaa",
      },
    ],
  };
  const observations = weeklyQuotaObservations(snapshot);
  assert.deepEqual(
    observations.map((observation) => observation.usedPercent),
    [10, 20],
  );
});

test("burn day bins place observed drops on days in meter percent units", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const resetsAt = Date.parse("2026-08-16T00:00:00.000Z") / 1_000;
  const snapshot = {
    events: [
      {
        // Bogus stored credits must lose to recomputation under the current
        // rate card: 2.5M uncached Luna input = 12.5 credits.
        timestamp: "2026-08-12T09:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 2_500_000,
        inputTokens: 2_500_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        rateCardCredits: 9_999,
      },
      {
        // 100K uncached Sol input = 12.5 credits.
        timestamp: "2026-08-12T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 100_000,
        inputTokens: 100_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    ],
    quotaObservations: [
      {
        timestamp: "2026-08-12T06:00:00.000Z",
        usedPercent: 0,
        windowMinutes: 10_080,
        resetsAt,
      },
      {
        timestamp: "2026-08-12T18:00:00.000Z",
        usedPercent: 20,
        windowMinutes: 10_080,
        resetsAt,
      },
      {
        timestamp: "2026-08-15T00:00:00.000Z",
        usedPercent: 40,
        windowMinutes: 10_080,
        resetsAt,
      },
    ],
  };
  const trend = buildUsageTrend(snapshot, bounds);
  const burn = buildBurnDayBins(trend, bounds, { days: 7, binSize: 1 });
  const approximately = (actual, expected) =>
    assert.ok(
      Math.abs(actual - expected) < 0.01,
      `expected ${expected}, got ${actual}`,
    );

  const day12 = burn.bins[3];
  assert.equal(day12.startDateString, "2026-08-12");
  approximately(day12.values.get("Luna"), 10);
  approximately(day12.values.get("Sol"), 10);
  // The eventless 54-hour drop is spread across its span by duration and
  // flagged approximate: 6h on Aug 12, 24h each on Aug 13 and Aug 14.
  approximately(day12.values.get("Unattributed"), 20 * (6 / 54));
  approximately(burn.bins[4].values.get("Unattributed"), 20 * (24 / 54));
  approximately(burn.bins[5].values.get("Unattributed"), 20 * (24 / 54));
  assert.equal(burn.bins[5].approximate, true);
  approximately(burn.totalPercent, 40);
  approximately(burn.totals.get("Luna"), 10);
  approximately(burn.totals.get("Sol"), 10);
  approximately(burn.totals.get("Unattributed"), 20);
});

test("rate card prices Luna at the current published credit rates", () => {
  const credits = creditsForUsage("gpt-5.6-luna", {
    totalTokens: 2_000_000,
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 1_000_000,
  });
  assert.equal(credits, 35);
});

test("fast-mode turns weigh 1.5x in the burn allocation", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const resetsAt = Date.parse("2026-08-16T00:00:00.000Z") / 1_000;
  const snapshot = {
    events: [
      {
        // Sol and GPT-5.5 share identical rate-card prices and identical
        // usage; only the service tier differs.
        timestamp: "2026-08-12T09:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 1_000_000,
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        serviceTier: "priority",
      },
      {
        timestamp: "2026-08-12T10:00:00.000Z",
        model: "gpt-5.5",
        totalTokens: 1_000_000,
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    ],
    quotaObservations: [
      {
        timestamp: "2026-08-12T06:00:00.000Z",
        usedPercent: 0,
        windowMinutes: 10_080,
        resetsAt,
      },
      {
        timestamp: "2026-08-12T18:00:00.000Z",
        usedPercent: 25,
        windowMinutes: 10_080,
        resetsAt,
      },
    ],
  };
  const trend = buildUsageTrend(snapshot, bounds);
  const burn = buildBurnDayBins(trend, bounds, { days: 7, binSize: 1 });
  const day = burn.bins.find((bin) => bin.startDateString === "2026-08-12");
  // 187.5 fast credits vs 125 normal credits: 25% splits 15 / 10.
  assert.ok(Math.abs(day.values.get("Sol") - 15) < 0.01);
  assert.ok(Math.abs(day.values.get("GPT-5.5") - 10) < 0.01);
});

test("the report command writes the dashboard image by default", () => {
  const options = parseArgs(["report", "30d"]);
  assert.equal(options.view, "trend");
  assert.equal(options.report, true);
  assert.equal(options.image, true);
  assert.equal(options.trendDays, 30);
  assert.equal(options.date, "today");

  const withOutput = parseArgs([
    "report",
    "7d",
    "--image-output",
    "out/report.png",
  ]);
  assert.equal(withOutput.imageOutput, resolve("out/report.png"));

  const drain = parseArgs(["report", "7d", "--drain"]);
  assert.equal(drain.drain, true);

  const cache = parseArgs(["report", "14d", "--cache-rate"]);
  assert.equal(cache.cacheRate, true);
  assert.equal(cache.image, true);
  assert.equal(cache.trendDays, 14);
  assert.throws(
    () => parseArgs(["trend", "7d", "--cache-rate"]),
    /--cache-rate is only available with the report command/,
  );
  assert.throws(
    () => parseArgs(["report", "7d", "--cache-rate", "--drain"]),
    /--cache-rate cannot be combined with --drain/,
  );
});
