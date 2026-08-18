#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODEL_COLORS as TERMINAL_MODEL_COLORS,
  renderTerminal,
} from "./token-ledger-terminal.mjs";
import { buildUsageTrend, multiDayBounds } from "./token-ledger-trend.mjs";
import { renderTrendImage } from "./token-ledger-trend-image.mjs";
import { renderTrendCombo } from "./token-ledger-trend-terminal.mjs";
import { startInteractive } from "./token-ledger-tui.mjs";

export const DEFAULT_SNAPSHOT = resolve(
  homedir(),
  ".token-ledger",
  "token-ledger-snapshot.json",
);
const DEFAULT_TOP = 10;
const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const SNAPSHOT_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const ANSI_RESET = "\u001b[0m";
const MODEL_COLORS = {
  sol: TERMINAL_MODEL_COLORS.sol,
  luna: TERMINAL_MODEL_COLORS.luna,
  terra: TERMINAL_MODEL_COLORS.terra,
  "gpt-5.5": TERMINAL_MODEL_COLORS.gpt,
  "gpt-5.4": TERMINAL_MODEL_COLORS.gpt,
  other: TERMINAL_MODEL_COLORS.other,
};

function usage() {
  return `Token Ledger terminal usage

Usage:
  tledger day <YYYY-MM-DD>
  tledger week [end-day]
  tledger trend [7d|14d|30d]
  tledger report [7d|14d|30d]
  npm run usage:day -- <YYYY-MM-DD>
  npm run usage:week -- [end-day]

Options:
  --date <day>         Date as YYYY-MM-DD, today, or yesterday
  --period <window>    Trend window: 7d, 14d, or 30d
  --input <file>       Snapshot to read (default: ~/.token-ledger/token-ledger-snapshot.json)
  --refresh            Rebuild the default snapshot from CODEX_HOME or ~/.codex
  --no-refresh         Use the cached snapshot without checking local JSONL files
  --codex-home <dir>   Codex data root used when refreshing
  --tz <name>          IANA timezone (default: machine timezone)
  --top <number>       Number of projects to show (default: 10)
  --width <number>     Terminal layout width in columns
  --raw-projects       Keep singleton thread labels instead of grouping them
  --no-archived        Skip archived_sessions when refreshing
  --plain              Disable terminal colors
  --ascii              Use ASCII bars instead of Unicode blocks
  --static             Print once instead of opening the interactive dashboard
  --drain               Trend columns show observed limit drain percent instead of token volume
  --image               Write trend view as an SVG image
  --image-output <file> SVG output path for trend view
  --image-width <px>   SVG image width from 900 to 2400 pixels
  --youplot            Use the legacy single-series YouPlot renderer
  --help               Show this help

The report command writes the dashboard SVG (same as trend --image) to
token-ledger-report-<period>.svg; use --image-output to choose the path.

The command reads a privacy-reduced Token Ledger snapshot. It never uploads
the snapshot or prints message bodies, tool payloads, credentials, or paths.`;
}

function readOption(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function parseArgs(argv) {
  const command = argv[0] === "week"
    ? "week"
    : argv[0] === "trend" || argv[0] === "report"
      ? "trend"
      : "day";
  const options = {
    range: command,
    view: command === "trend" ? "trend" : "projects",
    report: argv[0] === "report",
    trendDays: 7,
    date: null,
    input: DEFAULT_SNAPSHOT,
    inputExplicit: false,
    refresh: false,
    autoRefresh: true,
    codexHome: resolve(process.env.CODEX_HOME || `${homedir()}/.codex`),
    includeArchived: true,
    timeZone: DEFAULT_TIME_ZONE,
    top: DEFAULT_TOP,
    width: null,
    rawProjects: false,
    plain: false,
    ascii: false,
    static: false,
    image: false,
    imageOutput: null,
    imageWidth: null,
    drain: false,
    legacyPlot: false,
    help: false,
  };

  let trendPeriodSeen = false;
  let index = ["day", "week", "trend", "report"].includes(argv[0]) ? 1 : 0;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--date") {
      options.date = readOption(argv, index, "--date");
      index += 1;
    } else if (argument === "--period") {
      if (options.view !== "trend") {
        throw new Error("--period is only available for the trend view.");
      }
      if (trendPeriodSeen) {
        throw new Error("Trend period can only be specified once.");
      }
      const value = readOption(argv, index, "--period");
      if (!["7d", "14d", "30d"].includes(value)) {
        throw new Error("Trend period must be 7d, 14d, or 30d.");
      }
      options.trendDays = Number.parseInt(value, 10);
      trendPeriodSeen = true;
      index += 1;
    } else if (argument === "--input") {
      options.input = resolve(readOption(argv, index, "--input"));
      options.inputExplicit = true;
      index += 1;
    } else if (argument === "--refresh") {
      options.refresh = true;
    } else if (argument === "--no-refresh") {
      options.autoRefresh = false;
    } else if (argument === "--codex-home") {
      options.codexHome = resolve(readOption(argv, index, "--codex-home"));
      index += 1;
    } else if (argument === "--tz") {
      options.timeZone = readOption(argv, index, "--tz");
      index += 1;
    } else if (argument === "--top") {
      const value = Number(readOption(argv, index, "--top"));
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error("--top must be an integer from 1 to 100.");
      }
      options.top = value;
      index += 1;
    } else if (argument === "--width") {
      const value = Number(readOption(argv, index, "--width"));
      if (!Number.isInteger(value) || value < 40 || value > 200) {
        throw new Error("--width must be an integer from 40 to 200.");
      }
      options.width = value;
      index += 1;
    } else if (argument === "--raw-projects") {
      options.rawProjects = true;
    } else if (argument === "--no-archived") {
      options.includeArchived = false;
    } else if (argument === "--plain") {
      options.plain = true;
    } else if (argument === "--ascii") {
      options.ascii = true;
    } else if (argument === "--static") {
      options.static = true;
    } else if (argument === "--drain") {
      if (options.view !== "trend") {
        throw new Error("--drain is only available for the trend view.");
      }
      options.drain = true;
    } else if (argument === "--image") {
      if (options.view !== "trend") {
        throw new Error("--image is only available for the trend view.");
      }
      options.image = true;
    } else if (argument === "--image-output") {
      if (options.view !== "trend") {
        throw new Error("--image-output is only available for the trend view.");
      }
      const value = readOption(argv, index, "--image-output");
      if (!value.toLowerCase().endsWith(".svg")) {
        throw new Error("--image-output must end in .svg.");
      }
      options.image = true;
      options.imageOutput = resolve(value);
      index += 1;
    } else if (argument === "--image-width") {
      if (options.view !== "trend") {
        throw new Error("--image-width is only available for the trend view.");
      }
      const value = Number(readOption(argv, index, "--image-width"));
      if (!Number.isInteger(value) || value < 900 || value > 2400) {
        throw new Error("--image-width must be an integer from 900 to 2400.");
      }
      options.image = true;
      options.imageWidth = value;
      index += 1;
    } else if (argument === "--youplot") {
      options.legacyPlot = true;
    } else if (!argument.startsWith("-") && options.view === "trend") {
      if (trendPeriodSeen) {
        throw new Error("Trend period can only be specified once.");
      }
      if (!["7d", "14d", "30d"].includes(argument)) {
        throw new Error("Trend period must be 7d, 14d, or 30d.");
      }
      options.trendDays = Number.parseInt(argument, 10);
      trendPeriodSeen = true;
    } else if (!argument.startsWith("-") && !options.date) {
      options.date = argument;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (options.report) options.image = true;
  if (!options.help && !options.date && (options.range === "week" || options.view === "trend")) {
    options.date = "today";
  }
  if (!options.help && !options.date) {
    throw new Error("A day is required, for example: tledger day 2026-08-01");
  }
  if (!options.help && options.refresh && !options.autoRefresh) {
    throw new Error("--refresh cannot be combined with --no-refresh.");
  }
  if (!options.help && options.view === "trend" && options.legacyPlot) {
    throw new Error("--youplot is only available for the project view.");
  }
  return options;
}

function numericDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: date.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date.value);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return values;
}

function dateStringFromParts(parts) {
  return [parts.year, parts.month, parts.day]
    .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
    .join("-");
}

function shiftCalendarDate(value, amount) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function validateTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new Error(`Unknown IANA timezone: ${timeZone}`);
  }
}

function offsetAt(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return (
    Date.UTC(
      values.year,
      values.month - 1,
      values.day,
      values.hour,
      values.minute,
      values.second,
    ) - instant.getTime()
  );
}

function zonedMidnight(dateString, timeZone) {
  const [year, month, day] = dateString.split("-").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day);
  let instant = new Date(utcGuess - offsetAt(new Date(utcGuess), timeZone));
  const refinedOffset = offsetAt(instant, timeZone);
  instant = new Date(utcGuess - refinedOffset);
  return instant;
}

export function dayBounds(value, timeZone) {
  validateTimeZone(timeZone);
  let dateString = value;
  if (value === "today" || value === "yesterday") {
    const today = dateStringFromParts(numericDateParts({
      value: new Date(),
      timeZone,
    }));
    dateString = value === "today" ? today : shiftCalendarDate(today, -1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw new Error("Day must be YYYY-MM-DD, today, or yesterday.");
  }
  const [year, month, day] = dateString.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar day: ${dateString}`);
  }
  const nextDateString = shiftCalendarDate(dateString, 1);
  const start = zonedMidnight(dateString, timeZone);
  const end = zonedMidnight(nextDateString, timeZone);
  return { dateString, start, end, timeZone };
}

export function weekBounds(value, timeZone) {
  const endDay = dayBounds(value, timeZone);
  const startDateString = shiftCalendarDate(endDay.dateString, -6);
  return {
    ...endDay,
    startDateString,
    endDateString: endDay.dateString,
    start: zonedMidnight(startDateString, timeZone),
    rangeDays: 7,
  };
}

function cleanLabel(value, fallback) {
  const label = String(value ?? "")
    .replace(/[\t\r\n]+/g, " ")
    .trim();
  return label || fallback;
}

function displayLabel(value) {
  const label = cleanLabel(value, "Unlabelled activity");
  if (label.length <= 30) return label;
  return `${label.slice(0, 14)}…${label.slice(-13)}`;
}

export function oneOffProjects(snapshot) {
  const threadIdsByProject = new Map();
  const add = (project, threadId) => {
    if (!project || !threadId) return;
    const ids = threadIdsByProject.get(project) ?? new Set();
    ids.add(threadId);
    threadIdsByProject.set(project, ids);
  };
  for (const event of snapshot.events ?? []) add(event.project, event.threadId);
  for (const thread of snapshot.threads ?? []) add(thread.project, thread.id);
  return new Set(
    [...threadIdsByProject.entries()]
      .filter(([, threadIds]) => threadIds.size === 1)
      .map(([project]) => project),
  );
}

function modelLabel(value) {
  const model = cleanLabel(value, "Unknown model");
  const lower = model.toLowerCase();
  if (lower.includes("sol")) return "Sol";
  if (lower.includes("luna")) return "Luna";
  if (lower.includes("terra")) return "Terra";
  if (lower === "gpt-5.5") return "GPT-5.5";
  if (lower === "gpt-5.4") return "GPT-5.4";
  return model;
}

export function filterDayEvents(snapshot, bounds) {
  const start = bounds.start.getTime();
  const end = bounds.end.getTime();
  return (snapshot.events ?? []).filter((event) => {
    const timestamp = new Date(event.timestamp).getTime();
    return Number.isFinite(timestamp) && timestamp >= start && timestamp < end;
  });
}

export function aggregateProjects(snapshot, events, options = {}) {
  const singletonProjects = options.rawProjects ? new Set() : oneOffProjects(snapshot);
  const grouped = new Map();

  for (const event of events) {
    const rawProject = cleanLabel(event.project, "Unlabelled activity");
    const project =
      !options.rawProjects && singletonProjects.has(event.project)
        ? "Other activity"
        : rawProject;
    const row =
      grouped.get(project) ?? {
        project,
        displayProject: displayLabel(project),
        totalTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        toolCalls: 0,
        events: 0,
        threadIds: new Set(),
        rateCardCredits: 0,
        knownCreditTokens: 0,
        models: new Map(),
      };
    row.totalTokens += Number(event.totalTokens) || 0;
    row.outputTokens += Number(event.outputTokens) || 0;
    row.reasoningTokens += Number(event.reasoningTokens) || 0;
    row.toolCalls += Number(event.toolCalls) || 0;
    row.events += 1;
    if (event.threadId) row.threadIds.add(event.threadId);
    if (event.rateCardCredits !== null && Number.isFinite(Number(event.rateCardCredits))) {
      row.rateCardCredits += Number(event.rateCardCredits);
      row.knownCreditTokens += Number(event.totalTokens) || 0;
    }

    const model = modelLabel(event.model);
    const modelRow = row.models.get(model) ?? {
      model,
      totalTokens: 0,
      events: 0,
      rateCardCredits: 0,
    };
    modelRow.totalTokens += Number(event.totalTokens) || 0;
    modelRow.events += 1;
    if (event.rateCardCredits !== null && Number.isFinite(Number(event.rateCardCredits))) {
      modelRow.rateCardCredits += Number(event.rateCardCredits);
    }
    row.models.set(model, modelRow);
    grouped.set(project, row);
  }

  return [...grouped.values()]
    .map((row) => ({
      ...row,
      threads: row.threadIds.size,
      models: [...row.models.values()].sort(
        (left, right) => right.totalTokens - left.totalTokens,
      ),
    }))
    .sort((left, right) => {
      if (right.totalTokens !== left.totalTokens) {
        return right.totalTokens - left.totalTokens;
      }
      return left.project.localeCompare(right.project);
    });
}

function totalSummary(events) {
  return events.reduce(
    (summary, event) => {
      summary.totalTokens += Number(event.totalTokens) || 0;
      summary.outputTokens += Number(event.outputTokens) || 0;
      summary.toolCalls += Number(event.toolCalls) || 0;
      if (event.threadId) summary.threadIds.add(event.threadId);
      if (event.rateCardCredits !== null && Number.isFinite(Number(event.rateCardCredits))) {
        summary.rateCardCredits += Number(event.rateCardCredits);
        summary.knownCreditTokens += Number(event.totalTokens) || 0;
      }
      return summary;
    },
    {
      totalTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      rateCardCredits: 0,
      knownCreditTokens: 0,
      threadIds: new Set(),
    },
  );
}

function compact(value, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const units = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [divisor, suffix] of units) {
    if (absolute >= divisor) {
      const scaled = value / divisor;
      const precision = scaled >= 100 ? 0 : scaled >= 10 ? 1 : digits;
      return `${scaled.toFixed(precision)}${suffix}`;
    }
  }
  return Math.round(value).toLocaleString("en-US");
}

function percent(value) {
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function chartUnit(maximum) {
  if (maximum >= 1_000_000_000) return { divisor: 1_000_000_000, suffix: "B" };
  if (maximum >= 1_000_000) return { divisor: 1_000_000, suffix: "M" };
  if (maximum >= 1_000) return { divisor: 1_000, suffix: "K" };
  return { divisor: 1, suffix: "tokens" };
}

function chartNumber(value, divisor) {
  const scaled = value / divisor;
  if (scaled >= 100) return scaled.toFixed(0);
  if (scaled >= 10) return scaled.toFixed(1);
  return scaled.toFixed(2);
}

function colorize(value, code, enabled) {
  const codes = Array.isArray(code) ? code.join(";") : code;
  return enabled ? `\u001b[${codes}m${value}${ANSI_RESET}` : value;
}

function modelColor(model) {
  const lower = model.toLowerCase();
  if (lower.includes("sol")) return MODEL_COLORS.sol;
  if (lower.includes("luna")) return MODEL_COLORS.luna;
  if (lower.includes("terra")) return MODEL_COLORS.terra;
  if (lower.includes("gpt-5.5") || lower.includes("gpt-5.4")) {
    return MODEL_COLORS["gpt-5.5"];
  }
  return MODEL_COLORS.other;
}

function modelMix(row, enabled) {
  return row.models
    .slice(0, 4)
    .map((model) => {
      const share = row.totalTokens > 0 ? (model.totalTokens / row.totalTokens) * 100 : 0;
      return `${colorize(model.model, modelColor(model.model), enabled)} ${percent(share)}`;
    })
    .join(" · ");
}

function sourceLabel(snapshotPath, snapshot) {
  const generated = snapshot.generatedAt
    ? new Date(snapshot.generatedAt).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "unknown time";
  return `${basename(snapshotPath)} · captured ${generated}`;
}

function runYouPlot(rows, options, dateLabel, unit) {
  const chartInput = [
    "project\tvalue",
    ...rows.map(
      (row) => `${row.displayProject.replace(/[\t\r\n]+/g, " ")}\t${chartNumber(row.totalTokens, unit.divisor)}`,
    ),
  ].join("\n");
  const terminalWidth = Number(process.stdout.columns) || 100;
  const width = options.width ?? Math.max(56, Math.min(110, terminalWidth - 4));
  const useColor = !options.plain && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
  const args = [
    "bar",
    "-H",
    "-o",
    "-",
    "-t",
    `Top ${rows.length} projects · tokens (${unit.suffix}) · ${dateLabel}`,
    "-w",
    String(width),
    "--symbol",
    options.ascii ? "#" : "█",
  ];
  if (useColor) args.push("-C", "-c", "blue");
  else args.push("-M");

  const result = spawnSync("uplot", args, {
    input: `${chartInput}\n`,
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(
      "YouPlot is required. Install it with `brew install youplot`, then rerun this command.",
    );
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "YouPlot failed to render the chart.");
  }
  return result.stdout;
}

async function readSnapshot(snapshotPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Snapshot not found: ${snapshotPath}`);
    }
    throw new Error(`Could not read snapshot ${snapshotPath}: ${error.message}`);
  }
  if (!parsed || !Array.isArray(parsed.events)) {
    throw new Error(`Snapshot is missing its events array: ${snapshotPath}`);
  }
  return parsed;
}

async function refreshSnapshot(options) {
  if (!existsSync(options.codexHome)) {
    throw new Error(`Codex data directory not found: ${options.codexHome}`);
  }
  const { collectUsage } = await import("../lib/token-ledger-importer.mjs");
  process.stderr.write("Token Ledger: refreshing local snapshot…\n");
  const snapshot = await collectUsage(
    {
      output: options.input,
      codexHome: options.codexHome,
      includeArchived: options.includeArchived,
      since: null,
    },
    ({ current, total }) => {
      process.stderr.write(`\rToken Ledger: scanned ${current}/${total} rollout files`);
    },
  );
  process.stderr.write("\n");
  await mkdir(dirname(options.input), { recursive: true });
  await writeFile(options.input, `${JSON.stringify(snapshot)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return snapshot;
}

export function snapshotNeedsRefresh(snapshotMtimeMs, latestJsonlMtimeMs) {
  return latestJsonlMtimeMs > snapshotMtimeMs;
}

export function snapshotCacheIsFresh(
  snapshotMtimeMs,
  nowMs = Date.now(),
) {
  return (
    Number.isFinite(snapshotMtimeMs) &&
    Number.isFinite(nowMs) &&
    snapshotMtimeMs <= nowMs &&
    nowMs - snapshotMtimeMs < SNAPSHOT_CACHE_MAX_AGE_MS
  );
}

async function loadSnapshot(options) {
  if (options.refresh) {
    return refreshSnapshot(options);
  }
  if (!existsSync(options.input)) {
    if (options.inputExplicit || !options.autoRefresh) {
      throw new Error(`Snapshot not found: ${options.input}`);
    }
    return refreshSnapshot(options);
  }
  if (!options.autoRefresh || options.inputExplicit) {
    return readSnapshot(options.input);
  }

  const snapshotStat = await stat(options.input);
  if (snapshotCacheIsFresh(snapshotStat.mtimeMs)) {
    return readSnapshot(options.input);
  }

  const { latestSourceModifiedAt } = await import("../lib/token-ledger-importer.mjs");
  const latestSourceMtimeMs = await latestSourceModifiedAt(
    options.codexHome,
    options.includeArchived,
  );
  if (snapshotNeedsRefresh(snapshotStat.mtimeMs, latestSourceMtimeMs)) {
    return refreshSnapshot(options);
  }
  return readSnapshot(options.input);
}

function render(options, snapshot, bounds, events, rows, allRows) {
  if (options.view === "trend") {
    const trend = buildUsageTrend(snapshot, bounds);
    if (options.image) {
      return renderTrendImage({
        snapshot,
        bounds,
        trend,
        days: options.trendDays,
        options,
      });
    }
    return renderTrendCombo({
      snapshot,
      bounds,
      trend,
      days: options.trendDays,
      options,
    });
  }
  if (!options.legacyPlot) {
    return renderTerminal({ options, snapshot, bounds, events, rows, allRows });
  }
  const enabled = !options.plain && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
  const summary = totalSummary(events);
  const totalTokens = summary.totalTokens;
  const dateLabel = options.range === "week"
    ? `${bounds.startDateString} through ${bounds.endDateString}`
    : new Intl.DateTimeFormat("en-US", {
      timeZone: bounds.timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(bounds.start);
  const unit = chartUnit(rows[0]?.totalTokens ?? 0);
  const shares = rows.map((row) =>
    totalTokens > 0 ? (row.totalTokens / totalTokens) * 100 : 0,
  );
  const chart = runYouPlot(rows, options, dateLabel, unit).trimEnd();

  const header = [
    `Token Ledger · ${dateLabel} · ${bounds.timeZone}`,
    `${compact(totalTokens)} tokens · ${summary.threadIds.size.toLocaleString()} threads · ${events.length.toLocaleString()} calls · ${compact(summary.outputTokens)} output`,
    `Source: ${sourceLabel(options.input, snapshot)}`,
    "",
    chart,
    "",
    `Model mix · colors: ${colorize("Sol", MODEL_COLORS.sol, enabled)}  ${colorize("Luna", MODEL_COLORS.luna, enabled)}  ${colorize("Terra", MODEL_COLORS.terra, enabled)}  ${colorize("GPT", MODEL_COLORS["gpt-5.5"], enabled)}  ${colorize("Other", MODEL_COLORS.other, enabled)}`,
  ];

  const details = rows.map((row, index) => {
    const knownCreditShare =
      summary.rateCardCredits > 0 && row.rateCardCredits > 0
        ? ` · ${percent((row.rateCardCredits / summary.rateCardCredits) * 100)} credits`
        : "";
    return `${String(index + 1).padStart(2, " ")}  ${row.displayProject} · ${compact(row.totalTokens)} · ${percent(shares[index])} · ${row.threads.toLocaleString()} threads${knownCreditShare}\n    ${modelMix(row, enabled)}`;
  });

  return `${header.join("\n")}\n\n${details.join("\n")}`;
}

export async function run(options) {
  const bounds = options.view === "trend"
    ? multiDayBounds(options.date, options.timeZone, options.trendDays)
    : options.range === "week"
      ? weekBounds(options.date, options.timeZone)
      : dayBounds(options.date, options.timeZone);
  const snapshot = await loadSnapshot(options);
  const events = filterDayEvents(snapshot, bounds);
  if (events.length === 0) {
    const rangeDescription = options.range === "week"
      ? `${bounds.startDateString} through ${bounds.endDateString}`
      : bounds.dateString;
    return [
      `No model-call events found for ${rangeDescription} (${bounds.timeZone}).`,
      `Source: ${sourceLabel(options.input, snapshot)}`,
    ].join("\n");
  }
  const allRows = aggregateProjects(snapshot, events, options);
  const rows = allRows.slice(0, options.top);
  const output = render(options, snapshot, bounds, events, rows, allRows);
  if (options.view === "trend" && options.image) {
    const outputPath = options.imageOutput ??
      resolve(
        process.cwd(),
        `token-ledger-${options.report ? "report" : "trend"}-${options.trendDays}d.svg`,
      );
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output, "utf8");
    return [
      `Wrote ${options.report ? "report" : "trend image"}: ${outputPath}`,
      `Range: ${bounds.startDateString} through ${bounds.endDateString} (${bounds.timeZone})`,
    ].join("\n");
  }
  return output;
}

function shouldUseInteractive(options) {
  return Boolean(
    !options.static &&
      options.view !== "trend" &&
      !options.plain &&
      !options.legacyPlot &&
      !process.env.NO_COLOR &&
      process.stdin.isTTY &&
      process.stdout.isTTY,
  );
}

async function runInteractive(options) {
  const bounds = options.range === "week"
    ? weekBounds(options.date, options.timeZone)
    : dayBounds(options.date, options.timeZone);
  const snapshot = await loadSnapshot(options);
  const events = filterDayEvents(snapshot, bounds);
  if (events.length === 0) {
    const rangeDescription = options.range === "week"
      ? `${bounds.startDateString} through ${bounds.endDateString}`
      : bounds.dateString;
    process.stdout.write([
      `No model-call events found for ${rangeDescription} (${bounds.timeZone}).`,
      `Source: ${sourceLabel(options.input, snapshot)}`,
      "",
    ].join("\n"));
    return;
  }
  const allRows = aggregateProjects(snapshot, events, options);
  await startInteractive({
    options,
    snapshot,
    bounds,
    events,
    rows: allRows.slice(0, options.top),
    allRows,
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    if (shouldUseInteractive(options)) {
      await runInteractive(options);
    } else {
      process.stdout.write(`${await run(options)}\n`);
    }
  } catch (error) {
    process.stderr.write(`Token Ledger CLI failed: ${error.message}\n\n${usage()}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const modulePath = realpathSync(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main();
}
