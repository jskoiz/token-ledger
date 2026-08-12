import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  aggregateProjects,
  allBounds,
  dayBounds,
  DEFAULT_SNAPSHOT,
  filterDayEvents,
  monthBounds,
  parseArgs,
  rollingBounds,
  sanitizeTerminalText,
  snapshotNeedsRefresh,
  VERSION,
  weekBounds,
} from "../bin/token-ledger.mjs";
import {
  quotaCycleSummary,
  renderFullscreen,
  renderTerminal,
} from "../bin/token-ledger-terminal.mjs";
import { sourceFingerprint } from "../lib/token-ledger-collector.mjs";
import {
  modelColorKey,
  modelDisplayName,
  normalizeModelIdentifier,
} from "../lib/token-ledger-models.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(testDirectory, "../bin/token-ledger.mjs");
const fixturePath = resolve(
  testDirectory,
  "fixtures/demo-snapshot.json",
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

function stripAnsi(value) {
  return String(value)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function tokenEvent({ timestamp, turnId, totalTokens, model = "gpt-5.6-sol" }) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: totalTokens - 10,
          cached_input_tokens: Math.max(0, totalTokens - 20),
          output_tokens: 10,
          reasoning_output_tokens: 2,
          total_tokens: totalTokens,
        },
        last_token_usage: {
          input_tokens: totalTokens - 10,
          cached_input_tokens: Math.max(0, totalTokens - 20),
          output_tokens: 10,
          reasoning_output_tokens: 2,
          total_tokens: totalTokens,
        },
        model_context_window: 128000,
      },
    },
    model,
    turnId,
  };
}

async function writeSyntheticCodexHome(root, options = {}) {
  const threadId = options.threadId ?? "11111111-1111-4111-8111-111111111111";
  const turnId = options.turnId ?? `turn-${options.totalTokens ?? 100}`;
  const target = options.archived ? "archived_sessions" : "sessions";
  const directory = resolve(root, target, "2026", "08", "05");
  await mkdir(directory, { recursive: true });
  await mkdir(resolve(root, "sessions"), { recursive: true });
  const timestamp = "2026-08-05T12:00:00.000Z";
  const rows = [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: threadId,
        cwd: `/workspace/${options.project ?? "synthetic-source"}`,
        source: "exec",
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId,
        started_at: Date.parse(timestamp) / 1000,
      },
    },
    {
      timestamp,
      type: "turn_context",
      payload: {
        turn_id: turnId,
        model: "gpt-5.6-sol",
        effort: "medium",
        cwd: `/workspace/${options.project ?? "synthetic-source"}`,
      },
    },
    tokenEvent({
      timestamp: "2026-08-05T12:00:02.000Z",
      turnId,
      totalTokens: options.totalTokens ?? 100,
    }),
  ];
  const file = resolve(directory, `rollout-2026-08-05-${threadId}.jsonl`);
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return file;
}

test("day and week bounds honor explicit local calendar timezones", () => {
  const day = dayBounds("2026-08-01", "Pacific/Honolulu");
  assert.equal(day.start.toISOString(), "2026-08-01T10:00:00.000Z");
  assert.equal(day.end.toISOString(), "2026-08-02T10:00:00.000Z");

  const week = weekBounds("2026-08-03", "Pacific/Honolulu");
  assert.equal(week.startDateString, "2026-07-28");
  assert.equal(week.endDateString, "2026-08-03");
  assert.equal(week.start.toISOString(), "2026-07-28T10:00:00.000Z");
  assert.equal(week.end.toISOString(), "2026-08-04T10:00:00.000Z");
});

test("month, custom, and all ranges use inclusive local calendar bounds", () => {
  const month = monthBounds("2026-08-03", "Pacific/Honolulu");
  assert.equal(month.startDateString, "2026-07-05");
  assert.equal(month.endDateString, "2026-08-03");
  assert.equal(month.rangeDays, 30);

  const ninetyDays = rollingBounds("2026-08-03", "Pacific/Honolulu", 90);
  assert.equal(ninetyDays.startDateString, "2026-05-06");
  assert.equal(ninetyDays.endDateString, "2026-08-03");
  assert.equal(ninetyDays.start.toISOString(), "2026-05-06T10:00:00.000Z");
  assert.equal(ninetyDays.end.toISOString(), "2026-08-04T10:00:00.000Z");

  const snapshot = {
    events: [
      { timestamp: "not-a-date" },
      { timestamp: null },
      { timestamp: "2026-06-01T10:00:00.000Z" },
      { timestamp: "2026-08-04T09:59:59.999Z" },
    ],
  };
  const all = allBounds(snapshot, "Pacific/Honolulu");
  assert.equal(all.startDateString, "2026-06-01");
  assert.equal(all.endDateString, "2026-08-03");
  assert.equal(all.start.toISOString(), "2026-06-01T10:00:00.000Z");
  assert.equal(all.end.toISOString(), "2026-08-04T10:00:00.000Z");
  assert.equal(all.rangeDays, null);
  assert.equal(filterDayEvents(snapshot, all).length, 2);
});

test("today and yesterday resolve in the selected timezone", () => {
  const today = dayBounds("today", "Pacific/Honolulu");
  const yesterday = dayBounds("yesterday", "Pacific/Honolulu");
  assert.equal(
    (today.start.getTime() - yesterday.start.getTime()) / 86_400_000,
    1,
  );
});

test("filterDayEvents includes the start and excludes the end boundary", () => {
  const snapshot = {
    events: [
      { id: "before", timestamp: "2026-08-01T09:59:59.999Z" },
      { id: "start", timestamp: "2026-08-01T10:00:00.000Z" },
      { id: "inside", timestamp: "2026-08-01T20:00:00.000Z" },
      { id: "end", timestamp: "2026-08-02T10:00:00.000Z" },
    ],
  };
  const events = filterDayEvents(
    snapshot,
    dayBounds("2026-08-01", "Pacific/Honolulu"),
  );
  assert.deepEqual(events.map((event) => event.id), ["start", "inside"]);
});

test("bare execution and week default to the current seven-day window", () => {
  for (const argv of [[], ["week"]]) {
    const options = parseArgs(argv);
    assert.equal(options.range, "week");
    assert.equal(options.date, "today");
    assert.equal(options.top, 10);
    assert.equal(options.autoRefresh, true);
    assert.equal(options.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(options.input, resolve(homedir(), ".token-ledger", "token-ledger-snapshot.json"));
    assert.equal(options.input, DEFAULT_SNAPSHOT);
  }
  assert.equal(parseArgs(["day"]).date, "today");
  assert.equal(parseArgs(["day", "yesterday"]).date, "yesterday");
});

test("month, all, and arbitrary day commands map to their ranges", () => {
  const month = parseArgs(["month"]);
  assert.equal(month.range, "month");
  assert.equal(month.rangeDays, 30);
  assert.equal(month.date, "today");

  const custom = parseArgs(["90d", "2026-08-05"]);
  assert.equal(custom.range, "90d");
  assert.equal(custom.rangeDays, 90);
  assert.equal(custom.date, "2026-08-05");

  const all = parseArgs(["all"]);
  assert.equal(all.range, "all");
  assert.equal(all.rangeDays, null);
  assert.equal(all.date, null);
});

test("every retained option maps to the intended setting", () => {
  const codexHome = resolve(tmpdir(), "synthetic-codex-home");
  const options = parseArgs([
    "week",
    "--date",
    "2026-08-05",
    "--input",
    fixturePath,
    "--no-refresh",
    "--codex-home",
    codexHome,
    "--tz",
    "UTC",
    "--top",
    "3",
    "--width",
    "80",
    "--raw-projects",
    "-anon",
    "--no-archived",
    "--plain",
    "--ascii",
    "--static",
  ]);
  assert.deepEqual(
    {
      range: options.range,
      date: options.date,
      input: options.input,
      inputExplicit: options.inputExplicit,
      autoRefresh: options.autoRefresh,
      codexHome: options.codexHome,
      includeArchived: options.includeArchived,
      timeZone: options.timeZone,
      top: options.top,
      width: options.width,
      rawProjects: options.rawProjects,
      anonymizeProjects: options.anonymizeProjects,
      plain: options.plain,
      ascii: options.ascii,
      static: options.static,
    },
    {
      range: "week",
      date: "2026-08-05",
      input: fixturePath,
      inputExplicit: true,
      autoRefresh: false,
      codexHome,
      includeArchived: false,
      timeZone: "UTC",
      top: 3,
      width: 80,
      rawProjects: true,
      anonymizeProjects: true,
      plain: true,
      ascii: true,
      static: true,
    },
  );
  assert.equal(parseArgs(["--refresh"]).refresh, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--version"]).version, true);
  assert.equal(parseArgs(["-v"]).version, true);
});

test("argument failures are explicit and bounded", () => {
  assert.throws(() => parseArgs(["unknown"]), /Unknown command/);
  assert.throws(() => parseArgs(["week", "2026-08-05", "extra"]), /Unknown option/);
  for (const option of ["--date", "--input", "--codex-home", "--tz", "--top", "--width"]) {
    assert.throws(() => parseArgs([option]), /requires a value/);
  }
  assert.throws(() => parseArgs(["--top", "0"]), /1 to 100/);
  assert.throws(() => parseArgs(["--top", "101"]), /1 to 100/);
  assert.throws(() => parseArgs(["--width", "39"]), /40 to 200/);
  assert.throws(() => parseArgs(["--width", "201"]), /40 to 200/);
  assert.throws(() => parseArgs(["0d"]), /integer from 1/);
  assert.throws(() => parseArgs(["all", "2026-08-05"]), /does not accept an end day/);
  assert.throws(() => parseArgs(["--refresh", "--no-refresh"]), /cannot be combined/);
  assert.throws(() => parseArgs(["--refresh", "--input", fixturePath]), /cannot be combined/);
  assert.throws(() => dayBounds("2026-02-30", "UTC"), /Invalid calendar day/);
  assert.throws(() => dayBounds("not-a-day", "UTC"), /Day must be/);
  assert.throws(() => dayBounds("2026-08-05", "Mars\/Base"), /Unknown IANA timezone/);
});

test("snapshot freshness includes source identity as well as mtime", () => {
  const one = sourceFingerprint(resolve(tmpdir(), "synthetic-one"));
  const two = sourceFingerprint(resolve(tmpdir(), "synthetic-two"));
  assert.notEqual(
    sourceFingerprint(resolve(tmpdir(), "synthetic-one"), true),
    sourceFingerprint(resolve(tmpdir(), "synthetic-one"), false),
  );
  assert.equal(snapshotNeedsRefresh(100, 101, one, one, 2, 2), true);
  assert.equal(snapshotNeedsRefresh(100, 100, one, one, 2, 2), false);
  assert.equal(snapshotNeedsRefresh(100, 99, one, one, 2, 2), false);
  assert.equal(snapshotNeedsRefresh(100, 99, one, two, 2, 2), true);
  assert.equal(snapshotNeedsRefresh(100, 99, one, one, 2, 1), true);
});

test("project aggregation groups singleton labels and strips terminal controls", () => {
  const snapshot = {
    events: [],
    threads: [
      { id: "alpha-1", project: "synthetic-alpha" },
      { id: "alpha-2", project: "synthetic-alpha" },
      { id: "beta-1", project: "synthetic-beta" },
    ],
  };
  const events = [
    { project: "synthetic-alpha", threadId: "alpha-1", model: "gpt-5.6-sol", totalTokens: 900 },
    { project: "synthetic-alpha", threadId: "alpha-2", model: "gpt-5.6-luna", totalTokens: 100 },
    { project: "\u001b]8;;invalid\u0007synthetic-beta\u001b]8;;\u0007", threadId: "beta-1", model: "gpt-5.5", totalTokens: 500 },
  ];
  const grouped = aggregateProjects(snapshot, events);
  assert.deepEqual(grouped.map((row) => row.project), ["synthetic-alpha", "Other activity"]);
  const raw = aggregateProjects(snapshot, events, { rawProjects: true });
  assert.equal(raw[1].project, "synthetic-beta");
  assert.equal(raw[0].threads, 2);
  assert.deepEqual(raw[0].models.map((model) => model.model), ["Sol", "Luna"]);
  assert.equal(sanitizeTerminalText("safe\u001b[31m red\u0007"), "safe red ");
});

test("model mix names every active model instead of folding models into Other", () => {
  assert.equal(modelDisplayName("gpt-daybreak-blue-latest"), "Daybreak Blue");
  assert.equal(modelDisplayName("gpt-5.3-codex"), "GPT-5.3 Codex");
  assert.equal(modelDisplayName("nova-model"), "nova-model");
  assert.equal(modelDisplayName("unknown"), "Unknown model");
  assert.equal(modelColorKey("Daybreak Blue"), "daybreakBlue");
  assert.equal(normalizeModelIdentifier("gpt-daybreak-blue-latest"), "gpt-daybreak-blue");
  assert.equal(modelDisplayName("gpt-daybreak-blueberry"), "gpt-daybreak-blueberry");
  assert.equal(modelDisplayName("gpt-5.6-solar"), "gpt-5.6-solar");
  assert.equal(modelDisplayName("gpt-5.5-cybernetic"), "GPT-5.5");

  const bounds = dayBounds("2026-08-05", "UTC");
  const base = {
    timestamp: "2026-08-05T12:00:00.000Z",
    project: "synthetic-model-project",
    threadId: "synthetic-model-thread",
    useType: "interactive",
  };
  const events = [
    { ...base, id: "daybreak", model: "gpt-daybreak-blue-latest", totalTokens: 500 },
    { ...base, id: "codex", model: "gpt-5.3-codex", totalTokens: 300 },
    { ...base, id: "custom", model: "nova-model", totalTokens: 200 },
  ];
  const snapshot = {
    events,
    threads: [{ id: base.threadId, project: base.project }],
  };
  const allRows = aggregateProjects(snapshot, events, { rawProjects: true });
  assert.deepEqual(
    allRows[0].models.map((model) => model.model),
    ["Daybreak Blue", "GPT-5.3 Codex", "nova-model"],
  );

  const output = stripAnsi(renderTerminal({
    options: {
      range: "day",
      plain: true,
      ascii: true,
      static: true,
      width: 120,
    },
    snapshot,
    bounds,
    events,
    rows: allRows,
    allRows,
  }));

  assert.match(output, /Daybreak Blue\s+50\.0%/);
  assert.match(output, /GPT-5\.3 Codex\s+30\.0%/);
  assert.match(output, /nova-model\s+20\.0%/);
  assert.doesNotMatch(output, /■ Other\s/);
  assert.doesNotMatch(output, /Terra\s+0\.00%/);
});

test("renderer supports static widths and interactive selection without false keys", () => {
  const bounds = weekBounds("2026-08-05", "UTC");
  const events = filterDayEvents(fixture, bounds);
  const allRows = aggregateProjects(fixture, events, { rawProjects: true });
  const staticOutput = renderTerminal({
    options: { range: "week", plain: true, ascii: true, static: true, width: 40 },
    snapshot: fixture,
    bounds,
    events,
    rows: allRows.slice(0, 3),
    allRows,
  });
  assert.ok(staticOutput.split("\n").every((line) => line.length <= 40));
  assert.doesNotMatch(staticOutput, /select|inspect|range|quit/);
  assert.doesNotMatch(staticOutput, /> 1\./);

  const interactive = renderTerminal({
    options: {
      range: "week",
      plain: true,
      ascii: true,
      static: false,
      selectedIndex: 1,
      width: 90,
    },
    snapshot: fixture,
    bounds,
    events,
    rows: allRows,
    allRows,
  });
  assert.match(interactive, /> 2\./);
  assert.match(interactive, /\d+ threads · \d+\.\d+% of tokens/);
  assert.doesNotMatch(interactive, /> 1\./);
  assert.match(interactive, /\[j\/k\] select\s+\[q\/esc\] quit/);
  assert.doesNotMatch(interactive, /inspect|d\/w\/m/);
});

test("renderer surfaces auto review turns, tokens, and cache share", () => {
  const bounds = weekBounds("2026-08-05", "UTC");
  const base = {
    timestamp: "2026-08-05T12:00:00.000Z",
    project: "synthetic-review-project",
    threadId: "synthetic-review-thread",
    reasoningTokens: 0,
    toolCalls: 0,
  };
  const event = ({ totalTokens, ...values }) => ({
    ...base,
    ...values,
    inputTokens: totalTokens * 0.9,
    cachedInputTokens: totalTokens * 0.8,
    outputTokens: totalTokens * 0.1,
    totalTokens,
  });
  const events = [
    event({ id: "auto-1a", turnId: "auto-turn-1", model: "codex-auto-review", useType: "subagent", totalTokens: 50 }),
    event({ id: "auto-1b", turnId: "auto-turn-1", model: "codex-auto-review", useType: "subagent", totalTokens: 50 }),
    event({ id: "auto-2", turnId: "auto-turn-2", model: "codex-auto-review", useType: "subagent", totalTokens: 100 }),
    event({ id: "regular-1", turnId: "regular-1", model: "gpt-5.6-sol", useType: "interactive", totalTokens: 800 }),
    event({ id: "regular-2", turnId: "regular-2", model: "gpt-5.6-sol", useType: "subagent", totalTokens: 700 }),
    event({ id: "regular-3", turnId: "regular-3", model: "gpt-5.6-sol", useType: "automation", totalTokens: 600 }),
    event({ id: "regular-4", turnId: "regular-4", model: "gpt-5.6-sol", useType: "cli", totalTokens: 500 }),
    event({ id: "regular-5", turnId: "regular-5", model: "gpt-5.6-sol", useType: "voice", totalTokens: 400 }),
    event({ id: "regular-6", turnId: "regular-6", model: "gpt-5.6-sol", useType: "tool", totalTokens: 300 }),
  ];
  const snapshot = {
    events,
    threads: [{ id: base.threadId, project: base.project }],
    quotaObservations: [{
      timestamp: base.timestamp,
      usedPercent: 25,
      windowMinutes: 10_080,
      resetsAt: Date.parse("2026-08-08T00:00:00.000Z") / 1000,
    }],
  };
  const allRows = aggregateProjects(snapshot, events, { rawProjects: true });
  const output = stripAnsi(renderTerminal({
    options: {
      range: "week",
      plain: true,
      ascii: true,
      static: true,
      width: 120,
    },
    snapshot,
    bounds,
    events,
    rows: allRows,
    allRows,
  }));

  assert.equal((output.match(/Auto Review/g) ?? []).length, 2);
  assert.match(output, /Auto Review\s+5\.71%/);
  assert.match(output, /2 turns · 25\.0%/);
  assert.match(output, /200 · 88\.9% cached/);
  assert.match(output, /Subagent\s+20\.0%/);

  const fullscreen = stripAnsi(renderFullscreen({
    options: { range: "week", forceColor: false, selectedIndex: 0 },
    snapshot,
    bounds,
    events,
    rows: allRows,
    allRows,
    width: 100,
    height: 30,
  }));
  assert.equal(fullscreen.split("\n").length, 30);
  assert.match(fullscreen, /Auto Review/);
  assert.match(fullscreen, /RESET CYCLE/);
  assert.match(fullscreen, /q\/esc quit/);
});

test("quota context maps the selected range to reset-cycle burn", () => {
  const observation = {
    timestamp: "2026-08-02T00:00:00.000Z",
    usedPercent: 25,
    windowMinutes: 10080,
    resetsAt: Date.parse("2026-08-07T00:00:00.000Z") / 1000,
  };
  const events = [
    { timestamp: "2026-08-01T00:00:00.000Z", totalTokens: 800 },
    { timestamp: "2026-08-01T12:00:00.000Z", totalTokens: 200 },
    { timestamp: "2026-08-03T00:00:00.000Z", totalTokens: 1000 },
  ];
  const quota = quotaCycleSummary({ events, quotaObservations: [observation] }, [events[0]]);
  assert.equal(quota.usedPercent, 25);
  assert.equal(quota.remainingPercent, 75);
  assert.equal(quota.cycleTokens, 1000);
  assert.equal(quota.displayedTokens, 800);
  assert.equal(quota.estimatedDisplayedBurnPercent, 20);
});

test("fullscreen renderer applies the terminal theme and selected row", () => {
  const bounds = weekBounds("2026-08-05", "UTC");
  const events = filterDayEvents(fixture, bounds);
  const allRows = aggregateProjects(fixture, events, { rawProjects: true });
  const output = renderFullscreen({
    options: { range: "week", forceColor: true, selectedIndex: 2 },
    snapshot: fixture,
    bounds,
    events,
    rows: allRows,
    allRows,
    width: 100,
    height: 30,
  });
  assert.equal(output.split("\n").length, 30);
  assert.match(output, /\u001b\[48;2;16;16;18m/);
  assert.match(output, /\u001b\[48;2;5;5;6m/);
  assert.match(stripAnsi(output), /▶ 3\./);
  assert.match(stripAnsi(output), /└─+┴─+┘/);
  assert.match(stripAnsi(output), /q\/esc quit/);
  assert.doesNotMatch(output, /inspect|d\/w\/m/);
});

test("fullscreen renderer budgets project and model rows without clipping controls", () => {
  const bounds = weekBounds("2026-08-05", "UTC");
  const events = Array.from({ length: 15 }, (_, index) => ({
    id: `many-model-${index + 1}`,
    timestamp: "2026-08-05T12:00:00.000Z",
    project: `synthetic-project-${index + 1}`,
    threadId: `synthetic-thread-${index + 1}`,
    model: `synthetic-model-${index + 1}`,
    useType: "interactive",
    inputTokens: 100 - index,
    cachedInputTokens: 80 - index,
    outputTokens: 10,
    totalTokens: 110 - index,
  }));
  const snapshot = {
    events,
    threads: events.map((event) => ({ id: event.threadId, project: event.project })),
  };
  const allRows = aggregateProjects(snapshot, events, { rawProjects: true });
  const output = stripAnsi(renderFullscreen({
    options: { range: "week", forceColor: false, selectedIndex: 9 },
    snapshot,
    bounds,
    events,
    rows: allRows.slice(0, 10),
    allRows,
    width: 120,
    height: 24,
  }));

  assert.equal(output.split("\n").length, 24);
  assert.match(output, /▶ 10\./);
  assert.match(output, /… \d+ more models?/);
  assert.match(output, /CACHE · INPUT/);
  assert.match(output, /└─+┴─+┘/);
  assert.match(output, /q\/esc quit/);
});

test("CLI reports the installed package version without reading usage data", () => {
  for (const flag of ["--version", "-v"]) {
    const result = runCli([flag], {
      env: { HOME: resolve(tmpdir(), "missing-tledger-home") },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${VERSION}\n`);
    assert.equal(result.stderr, "");
  }
});

test("CLI help lists the complete self-contained command surface", () => {
  for (const flag of ["--help", "-h"]) {
    const result = runCli([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /tledger week \[end-day\]/);
    assert.match(result.stdout, /tledger month \[end-day\]/);
    assert.match(result.stdout, /tledger <number>d \[end-day\]/);
    assert.match(result.stdout, /tledger all/);
    for (const option of [
      "--date",
      "--input",
      "--refresh",
      "--no-refresh",
      "--codex-home",
      "--tz",
      "--top",
      "--width",
      "--raw-projects",
      "-anon",
      "--no-archived",
      "--plain",
      "--ascii",
      "--static",
      "--version",
      "--help",
    ]) {
      assert.match(result.stdout, new RegExp(option.replace("--", "\\-\\-")));
    }
  }
});

test("CLI renders explicit snapshots through week, day, plain, ASCII, top, width, and raw paths", () => {
  const week = runCli([
    "week",
    "2026-08-05",
    "--input",
    fixturePath,
    "--static",
    "--plain",
    "--raw-projects",
    "--top",
    "3",
    "--width",
    "100",
    "--tz",
    "UTC",
  ]);
  assert.equal(week.status, 0, week.stderr);
  assert.match(week.stdout, /TOKEN LEDGER/);
  assert.match(week.stdout, /sample-atlas/);
  assert.match(week.stdout, /sample-beacon/);
  assert.match(week.stdout, /sample-cascade/);
  assert.doesNotMatch(week.stdout, /sample-drift/);
  assert.doesNotMatch(week.stdout, /\u001b/);
  assert.ok(week.stdout.trimEnd().split("\n").every((line) => line.length <= 100));

  const anonymous = runCli([
    "week",
    "2026-08-05",
    "--input",
    fixturePath,
    "--static",
    "--plain",
    "--raw-projects",
    "-anon",
    "--top",
    "3",
    "--width",
    "100",
    "--tz",
    "UTC",
  ]);
  assert.equal(anonymous.status, 0, anonymous.stderr);
  assert.match(anonymous.stdout, /1\. Project 1/);
  assert.match(anonymous.stdout, /2\. Project 2/);
  assert.match(anonymous.stdout, /3\. Project 3/);
  assert.doesNotMatch(anonymous.stdout, /sample-(?:atlas|beacon|cascade)/);

  const day = runCli([
    "day",
    "--date",
    "2026-08-05",
    "--input",
    fixturePath,
    "--plain",
    "--ascii",
    "--raw-projects",
    "--width",
    "80",
    "--tz",
    "UTC",
  ]);
  assert.equal(day.status, 0, day.stderr);
  assert.match(day.stdout, /DAY/);
  assert.match(day.stdout, /#+/);
  assert.doesNotMatch(day.stdout, /█/);

  const noColor = runCli([
    "week",
    "2026-08-05",
    "--input",
    fixturePath,
    "--static",
  ], { env: { NO_COLOR: "1", TZ: "UTC" } });
  assert.equal(noColor.status, 0, noColor.stderr);
  assert.doesNotMatch(noColor.stdout, /\u001b/);
});

test("CLI renders month, arbitrary-day, and all-time ranges", () => {
  const cases = [
    { args: ["1d", "2026-08-05"], header: /WED 05 AUG 2026 · 1 DAY/ },
    { args: ["month", "2026-08-05"], header: /JUL 07–AUG 05 · 30D/ },
    { args: ["90d", "2026-08-05"], header: /MAY 08–AUG 05 · 90D/ },
    { args: ["all"], header: /JUL 30 – AUG 05 2026 · ALL/ },
  ];
  for (const { args, header } of cases) {
    const result = runCli([
      ...args,
      "--input",
      fixturePath,
      "--static",
      "--plain",
      "--raw-projects",
      "--width",
      "100",
      "--tz",
      "UTC",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.split("\n")[0], header);
  }
});

test("CLI empty state explains local scope and points to the latest activity", () => {
  const empty = runCli([
    "week",
    "2026-08-12",
    "--input",
    fixturePath,
    "--static",
    "--plain",
    "--tz",
    "UTC",
  ]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(
    empty.stdout,
    /No model-call events found for 2026-08-06 through 2026-08-12 \(UTC\)\./,
  );
  assert.match(empty.stdout, /reads only Codex history stored on this computer/);
  assert.match(empty.stdout, /Latest local activity: August 5, 2026\./);
  assert.match(empty.stdout, /Try: tledger week 2026-08-05/);
});

test("CLI empty state resolves the latest date in the selected timezone", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-empty-timezone-"));
  try {
    const snapshot = resolve(root, "snapshot.json");
    await writeFile(snapshot, JSON.stringify({
      generatedAt: "2026-08-06T22:47:08.714Z",
      events: [{ timestamp: "2026-07-29T06:33:43.754Z" }],
    }));
    const empty = runCli([
      "week",
      "2026-08-06",
      "--input",
      snapshot,
      "--static",
      "--plain",
      "--tz",
      "Pacific/Honolulu",
    ]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /Latest local activity: July 28, 2026\./);
    assert.match(empty.stdout, /Try: tledger week 2026-07-28/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI failure messages cover invalid input without terminal injection", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-errors-"));
  try {
    const missing = resolve(root, "missing.json");
    const missingResult = runCli(["week", "--input", missing, "--static"]);
    assert.equal(missingResult.status, 1);
    assert.match(missingResult.stderr, /Snapshot not found/);

    const malformed = resolve(root, "malformed.json");
    await writeFile(malformed, "{not-json}\n");
    const malformedResult = runCli(["week", "--input", malformed, "--static"]);
    assert.equal(malformedResult.status, 1);
    assert.match(malformedResult.stderr, /Could not read snapshot/);

    const invalidShape = resolve(root, "invalid-shape.json");
    await writeFile(invalidShape, "{}\n");
    const shapeResult = runCli(["week", "--input", invalidShape, "--static"]);
    assert.equal(shapeResult.status, 1);
    assert.match(shapeResult.stderr, /missing its events array/);

    const badZone = runCli(["week", "--input", fixturePath, "--tz", "Mars/Base", "--static"]);
    assert.equal(badZone.status, 1);
    assert.match(badZone.stderr, /Unknown IANA timezone/);

    const badDate = runCli(["day", "2026-02-30", "--input", fixturePath, "--static"]);
    assert.equal(badDate.status, 1);
    assert.match(badDate.stderr, /Invalid calendar day/);

    const unknown = runCli(["unknown"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown command/);
    assert.doesNotMatch(unknown.stderr, /\u001b/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic refresh is source-bound, atomic, private, and cached-only when requested", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-refresh-"));
  try {
    const home = resolve(root, "home");
    const sourceOne = resolve(root, "source-one");
    const sourceTwo = resolve(root, "source-two");
    await mkdir(home, { recursive: true });
    await writeSyntheticCodexHome(sourceOne, {
      project: "synthetic-one",
      totalTokens: 100,
      threadId: "11111111-1111-4111-8111-111111111111",
    });
    await writeSyntheticCodexHome(sourceTwo, {
      project: "synthetic-two",
      totalTokens: 200,
      threadId: "22222222-2222-4222-8222-222222222222",
    });

    const first = runCli([
      "week",
      "2026-08-05",
      "--codex-home",
      sourceOne,
      "--static",
      "--plain",
      "--raw-projects",
      "--tz",
      "UTC",
    ], { env: { HOME: home, CODEX_HOME: sourceOne } });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /refreshing local snapshot/);
    assert.match(first.stdout, /synthetic-one/);

    const cache = resolve(home, ".token-ledger", "token-ledger-snapshot.json");
    const firstSnapshot = JSON.parse(await readFile(cache, "utf8"));
    assert.equal(firstSnapshot.coverage.observedTokens, 100);
    assert.equal(firstSnapshot.provenance.sourceFingerprint, sourceFingerprint(sourceOne));
    assert.equal((await stat(cache)).mode & 0o777, 0o600);
    assert.equal((await readFile(cache, "utf8")).includes("/workspace/"), false);

    await chmod(cache, 0o644);
    const switched = runCli([
      "week",
      "2026-08-05",
      "--codex-home",
      sourceTwo,
      "--static",
      "--plain",
      "--raw-projects",
      "--tz",
      "UTC",
    ], { env: { HOME: home, CODEX_HOME: sourceTwo } });
    assert.equal(switched.status, 0, switched.stderr);
    assert.match(switched.stderr, /refreshing local snapshot/);
    assert.match(switched.stdout, /synthetic-two/);
    const switchedSnapshot = JSON.parse(await readFile(cache, "utf8"));
    assert.equal(switchedSnapshot.coverage.observedTokens, 200);
    assert.equal(switchedSnapshot.provenance.sourceFingerprint, sourceFingerprint(sourceTwo));
    assert.equal((await stat(cache)).mode & 0o777, 0o600);

    const cachedOnly = runCli([
      "week",
      "2026-08-05",
      "--codex-home",
      sourceOne,
      "--no-refresh",
      "--static",
      "--plain",
      "--raw-projects",
      "--tz",
      "UTC",
    ], { env: { HOME: home, CODEX_HOME: sourceOne } });
    assert.equal(cachedOnly.status, 0, cachedOnly.stderr);
    assert.doesNotMatch(cachedOnly.stderr, /refreshing local snapshot/);
    assert.match(cachedOnly.stdout, /synthetic-two/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forced refresh and archived-session exclusion are deterministic", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-archived-"));
  try {
    const home = resolve(root, "home");
    const source = resolve(root, "source");
    await mkdir(home, { recursive: true });
    await writeSyntheticCodexHome(source, {
      archived: true,
      project: "synthetic-archived",
      totalTokens: 300,
      threadId: "33333333-3333-4333-8333-333333333333",
    });
    const env = { HOME: home, CODEX_HOME: source };
    const excluded = runCli([
      "week",
      "2026-08-05",
      "--refresh",
      "--no-archived",
      "--static",
      "--plain",
      "--raw-projects",
      "--tz",
      "UTC",
    ], { env });
    assert.equal(excluded.status, 0, excluded.stderr);
    assert.match(excluded.stdout, /No model-call events found/);
    assert.doesNotMatch(excluded.stdout, /synthetic-archived/);

    const included = runCli([
      "week",
      "2026-08-05",
      "--refresh",
      "--static",
      "--plain",
      "--raw-projects",
      "--tz",
      "UTC",
    ], { env });
    assert.equal(included.status, 0, included.stderr);
    assert.match(included.stdout, /synthetic-archived/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
