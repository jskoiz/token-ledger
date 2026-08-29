#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODEL_COLORS as TERMINAL_MODEL_COLORS,
  renderTerminal,
} from "./token-ledger-terminal.mjs";
import {
  buildRangeAnalysis,
  buildUsageTrend,
  multiDayBounds,
  priorPeriodBounds,
} from "./token-ledger-trend.mjs";
import {
  buildTrendReportViewModel,
  resolveEffectiveEnd,
} from "./token-ledger-report-data.mjs";
import { renderTrendCombo } from "./token-ledger-trend-terminal.mjs";
import { renderCostTerminal } from "./token-ledger-cost-terminal.mjs";
import { startInteractive } from "./token-ledger-tui.mjs";
import {
  createTimeZoneFormatter,
  formatCalendarDate,
  localDateBoundary,
  shiftCalendarDate,
  todayInTimeZone,
  validateTimeZone,
} from "../lib/token-ledger-calendar.mjs";
import {
  readPrivateSnapshot,
  writePrivateSnapshot,
} from "../lib/token-ledger-snapshot.mjs";
import {
  collectionScope,
  historyScopeLabel,
  normalizeCollectionSince,
  snapshotCollectionCutoffMs,
  snapshotCollectionScope,
  snapshotMatchesCollectionScope,
} from "../lib/token-ledger-collection.mjs";
import {
  SNAPSHOT_SCHEMA_VERSION,
  checkedFiniteAdd,
  checkedTokenAdd,
  scaledOutputTokens,
  tokenValue,
  MAX_SAFE_TOKEN_COUNT,
  usageBuckets,
  usageBucketsInRange,
  usageCallCount,
  usageThreadIds,
} from "../lib/token-ledger-usage.mjs";
import { calculateCodexPurchasedCredits } from "../lib/token-ledger-rates.mjs";
import { sanitizeTerminalText } from "../lib/token-ledger-terminal-text.mjs";

export { sanitizeTerminalText };

export const DEFAULT_SNAPSHOT = resolve(
  homedir(),
  ".token-ledger",
  "token-ledger-snapshot-v3.json.gz",
);
const DEFAULT_TOP = 10;
const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const SNAPSHOT_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
export const ROLLING_24_HOURS_MS = 24 * 60 * 60 * 1000;
const MAX_ROLLING_DAYS = 3_650;
const DURATION_ALIAS = /^(\d+)(d|w)$/i;
const ANSI_RESET = "\u001b[0m";
const MODEL_COLORS = {
  sol: TERMINAL_MODEL_COLORS.sol,
  luna: TERMINAL_MODEL_COLORS.luna,
  terra: TERMINAL_MODEL_COLORS.terra,
  "gpt-5.5": TERMINAL_MODEL_COLORS.gpt,
  "gpt-5.4": TERMINAL_MODEL_COLORS.gpt,
  other: TERMINAL_MODEL_COLORS.other,
};

function createSharedTokenScale() {
  return {
    scale: 1,
    totalTokens: 0,
    targets: new Set(),
  };
}

function addSharedTokenContribution(state, contribution, targets) {
  const tokens = tokenValue(contribution, { allowFractional: true });
  if (!(tokens > 0)) return;
  const scaledTokens = tokens / state.scale;
  for (const target of targets) {
    state.targets.add(target);
    target.totalTokens += scaledTokens;
  }
  state.totalTokens += scaledTokens;
  const scaleFactor = Math.max(
    1,
    state.totalTokens / MAX_SAFE_TOKEN_COUNT,
  );
  if (scaleFactor === 1) return;
  for (const target of state.targets) {
    target.totalTokens /= scaleFactor;
    if (target.totalTokens >= MAX_SAFE_TOKEN_COUNT - 2) {
      target.totalTokens = MAX_SAFE_TOKEN_COUNT;
    }
  }
  state.totalTokens = MAX_SAFE_TOKEN_COUNT;
  state.scale *= scaleFactor;
}

export function usage() {
  return `Token Ledger

Usage:
  tledger 1d                         Last 24 hours in the terminal
  tledger week                       Last 7 calendar days in the terminal
  tledger 30d                        Rolling 30 days in the terminal
  tledger cost 7d --basis api-usd    Hypothetical API-equivalent USD estimate
  tledger cost week --basis codex-credits
                                     Codex purchased-credit estimate
  tledger report 7d                  Write the 7-day PNG report
  tledger report 7d --cache-rate     Write the cache-only PNG report

Common options:
  --static                  Print once instead of opening the dashboard
  --refresh                 Rebuild the local usage cache
  --since <ISO timestamp>   Collect history at or after this timestamp
  --image-output <file>     Choose where to save a PNG
  --no-open                 Do not open a generated PNG
  -h, --help                Show this quick guide
  --help-all                Show every command and option

Token Ledger reads local Codex data only. It does not upload your usage.`;
}

export function advancedUsage() {
  return `Token Ledger command reference

Terminal commands:
  tledger 1d                         Rolling 24-hour project breakdown
  tledger <N>d                       Rolling N-day project breakdown
  tledger <N>w                       Rolling N-week project breakdown
  tledger day <YYYY-MM-DD>           One local calendar day
  tledger week [end-day]             Seven local calendar days
  tledger trend [Nd|Nw]              Multi-day terminal trend

Cost commands (basis is required):
  tledger cost <1d|Nd|Nw|week> --basis api-usd
                                      Hypothetical API-equivalent USD estimate
  tledger cost <1d|Nd|Nw|week> --basis codex-credits
                                      Codex purchased-credit estimate

Report commands:
  tledger report [Nd|Nw]             Write the usage dashboard PNG
  tledger report [Nd|Nw] --cache-rate
                                      Write the cache-only PNG

Dates and ranges:
  --date <day>               YYYY-MM-DD, today, or yesterday
  --period <window>          Trend window such as 7d, 14d, or 2w
  --tz <name>                IANA timezone (default: machine timezone)

Data and refresh:
  --input <file>             Read an explicit snapshot
  --refresh                  Rebuild the default snapshot from local Codex data
  --no-refresh               Use the cached snapshot without checking source files
  --codex-home <dir>         Codex data root used when refreshing
  --since <ISO timestamp>    Collect history at or after this timestamp
  --no-archived              Skip archived sessions when refreshing

Terminal output:
  --top <number>             Projects to show, from 1 to 100 (default: 10)
  --width <number>           Layout width, from 40 to 200 columns
  --raw-projects             Keep singleton thread labels ungrouped
  --plain                    Disable terminal colors
  --ascii                    Use ASCII bars instead of Unicode blocks
  --static                   Print once instead of opening the dashboard
  --youplot                  Use the legacy single-series renderer

Report output:
  --drain                    Chart estimated meter drain instead of token volume
  --cache-rate               Write the cache-only report (report command only)
  --image                    Write the trend view as a PNG
  --image-output <file>      Choose the PNG output path
  --image-width <px>         Set PNG width from 900 to 2400 pixels
  --no-open                  Do not open the finished PNG

Help:
  -h, --help                Show the quick guide
  --help-all                Show this complete reference

The default snapshot is ~/.token-ledger/token-ledger-snapshot-v3.json.gz.
Token Ledger reads local Codex data only. It does not upload your usage.`;
}

function durationAlias(value) {
  const match = DURATION_ALIAS.exec(String(value ?? ""));
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const days = unit === "w" ? amount * 7 : amount;
  if (
    !Number.isSafeInteger(amount) ||
    !Number.isSafeInteger(days) ||
    amount < 1 ||
    days > MAX_ROLLING_DAYS
  ) {
    throw new Error(
      `Duration must be between 1d and ${MAX_ROLLING_DAYS}d (or the equivalent in weeks).`,
    );
  }
  const noun = unit === "w"
    ? amount === 1 ? "week" : "weeks"
    : amount === 1 ? "day" : "days";
  return {
    amount,
    unit,
    days,
    label: `${amount} ${noun}`,
  };
}

function rollingRangeDescription(options) {
  return options.range === "rolling24h"
    ? "the last 24 hours"
    : `the last ${options.rollingLabel}`;
}

function readOption(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function parseArgs(argv) {
  const helpCommand = argv[0] === "help";
  const costCommand = argv[0] === "cost";
  const costRangeValue = costCommand ? argv[1] : null;
  const costHelpWithoutRange = costCommand &&
    ["--help", "-h", "--help-all"].includes(costRangeValue);
  const costAlias = costCommand && costRangeValue !== "week" && !costHelpWithoutRange
    ? durationAlias(costRangeValue)
    : null;
  const costRangeValid = costRangeValue === "week" || Boolean(costAlias);
  const alias = durationAlias(argv[0]);
  const rolling24hCommand = argv[0] === "1d" ||
    (costCommand && costAlias?.days === 1);
  const rollingDurationCommand = (Boolean(alias) && argv[0] !== "1d") ||
    (costCommand && Boolean(costAlias) && costAlias.days !== 1);
  const command = costCommand && costRangeValue === "week"
    ? "week"
    : rolling24hCommand
    ? "rolling24h"
    : rollingDurationCommand
      ? "rolling"
    : argv[0] === "week"
      ? "week"
      : argv[0] === "trend" || argv[0] === "report"
        ? "trend"
        : "day";
  const options = {
    range: command,
    view: costCommand ? "cost" : command === "trend" ? "trend" : "projects",
    rolling24h: rolling24hCommand,
    rollingDuration: rollingDurationCommand,
    rollingDays: (costCommand ? costAlias?.days : alias?.days) ?? (rolling24hCommand ? 1 : null),
    rollingAmount: (costCommand ? costAlias?.amount : alias?.amount) ?? (rolling24hCommand ? 1 : null),
    rollingUnit: (costCommand ? costAlias?.unit : alias?.unit) ?? (rolling24hCommand ? "d" : null),
    rollingLabel: (costCommand ? costAlias?.label : alias?.label) ?? "1 day",
    basis: null,
    report: argv[0] === "report",
    trendDays: 7,
    date: null,
    input: DEFAULT_SNAPSHOT,
    inputExplicit: false,
    refresh: false,
    autoRefresh: true,
    codexHome: resolve(process.env.CODEX_HOME || `${homedir()}/.codex`),
    since: null,
    includeArchived: true,
    timeZone: DEFAULT_TIME_ZONE,
    top: DEFAULT_TOP,
    width: null,
    rawProjects: false,
    plain: false,
    ascii: false,
    static: costCommand,
    image: false,
    imageOutput: null,
    imageWidth: null,
    openImage: true,
    drain: false,
    cacheRate: false,
    legacyPlot: false,
    help: argv.length === 0 || helpCommand,
    helpAll: false,
  };

  let trendPeriodSeen = false;
  let basisSeen = false;
  let index = costCommand
    ? costHelpWithoutRange ? 1 : 2
    : alias || ["day", "week", "trend", "report", "help"].includes(argv[0]) ? 1 : 0;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--help-all") {
      options.help = true;
      options.helpAll = true;
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
      const period = durationAlias(value);
      if (!period) {
        throw new Error(
          "Trend period must use a positive number of days or weeks, such as 7d or 2w.",
        );
      }
      options.trendDays = period.days;
      trendPeriodSeen = true;
      index += 1;
    } else if (argument === "--basis") {
      if (options.view !== "cost") {
        throw new Error("--basis is only available with the cost command.");
      }
      if (basisSeen) throw new Error("Cost basis can only be specified once.");
      const value = readOption(argv, index, "--basis");
      if (value !== "codex-credits" && value !== "api-usd") {
        throw new Error("--basis must be codex-credits or api-usd.");
      }
      options.basis = value;
      basisSeen = true;
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
    } else if (argument === "--since") {
      const value = readOption(argv, index, "--since");
      options.since = new Date(normalizeCollectionSince(value));
      index += 1;
    } else if (argument === "--tz") {
      options.timeZone = readOption(argv, index, "--tz");
      index += 1;
    } else if (argument === "--top") {
      if (options.view === "cost") {
        throw new Error("--top is not available with the cost command.");
      }
      const value = Number(readOption(argv, index, "--top"));
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error("--top must be an integer from 1 to 100.");
      }
      options.top = value;
      index += 1;
    } else if (argument === "--width") {
      if (options.view === "cost") {
        throw new Error("--width is not available with the cost command.");
      }
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
      if (options.view === "cost") {
        throw new Error("--ascii is not available with the cost command.");
      }
      options.ascii = true;
    } else if (argument === "--static") {
      options.static = true;
    } else if (argument === "--drain") {
      if (options.view !== "trend") {
        throw new Error("--drain is only available for the trend view.");
      }
      options.drain = true;
    } else if (argument === "--cache-rate") {
      if (!options.report) {
        throw new Error("--cache-rate is only available with the report command.");
      }
      options.cacheRate = true;
    } else if (argument === "--image") {
      if (options.view !== "trend") {
        throw new Error("--image is only available for the trend view.");
      }
      options.image = true;
    } else if (argument === "--no-open") {
      if (options.view !== "trend") {
        throw new Error("--no-open is only available for the trend view.");
      }
      options.openImage = false;
    } else if (argument === "--image-output") {
      if (options.view !== "trend") {
        throw new Error("--image-output is only available for the trend view.");
      }
      const value = readOption(argv, index, "--image-output");
      if (!value.toLowerCase().endsWith(".png")) {
        throw new Error("--image-output must end in .png.");
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
    } else if (
      !argument.startsWith("-") &&
      options.view === "projects" &&
      argument === "1d" &&
      !options.date
    ) {
      if (argv[0] !== "day") {
        throw new Error(
          "The 1d alias is only available as `tledger 1d` or `tledger day 1d`.",
        );
      }
      options.range = "rolling24h";
      options.rolling24h = true;
    } else if (!argument.startsWith("-") && options.view === "trend") {
      if (trendPeriodSeen) {
        throw new Error("Trend period can only be specified once.");
      }
      const period = durationAlias(argument);
      if (!period) {
        throw new Error(
          "Trend period must use a positive number of days or weeks, such as 7d or 2w.",
        );
      }
      options.trendDays = period.days;
      trendPeriodSeen = true;
    } else if (!argument.startsWith("-") && !options.date) {
      options.date = argument;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (options.report) options.image = true;
  if (!options.help && costCommand && !costRangeValid) {
    throw new Error("Cost range must be 1d, Nd, Nw, or week.");
  }
  if (!options.help && costCommand && !options.basis) {
    throw new Error("The cost command requires --basis codex-credits or --basis api-usd.");
  }
  if (!options.help && (options.rolling24h || options.rollingDuration) && options.date) {
    throw new Error(`${options.rollingLabel} does not accept --date; its rolling window ends now.`);
  }
  if (!options.help && !options.date && (options.range === "week" || options.view === "trend")) {
    options.date = "today";
  }
  if (!options.help && !options.date && !options.rolling24h && !options.rollingDuration) {
    throw new Error("A day is required, for example: tledger day 2026-08-01");
  }
  if (!options.help && options.refresh && !options.autoRefresh) {
    throw new Error("--refresh cannot be combined with --no-refresh.");
  }
  if (!options.help && options.refresh && options.inputExplicit) {
    throw new Error("--refresh cannot be combined with --input.");
  }
  if (!options.help && options.view === "trend" && options.legacyPlot) {
    throw new Error("--youplot is only available for the project view.");
  }
  if (!options.help && options.view === "cost" && options.legacyPlot) {
    throw new Error("--youplot is not available with the cost command.");
  }
  if (!options.help && options.view === "cost" && options.rawProjects) {
    throw new Error("--raw-projects is not available with the cost command.");
  }
  if (!options.help && options.cacheRate && options.drain) {
    throw new Error("--cache-rate cannot be combined with --drain.");
  }
  return options;
}

export function dayBounds(value, timeZone) {
  validateTimeZone(timeZone);
  const formatter = createTimeZoneFormatter(timeZone);
  let dateString = value;
  if (value === "today" || value === "yesterday") {
    const today = todayInTimeZone(timeZone, formatter);
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
  const start = localDateBoundary(dateString, timeZone, formatter);
  const end = localDateBoundary(nextDateString, timeZone, formatter);
  return { dateString, start, end, timeZone };
}

export function weekBounds(value, timeZone) {
  const endDay = dayBounds(value, timeZone);
  const startDateString = shiftCalendarDate(endDay.dateString, -6);
  return {
    ...endDay,
    startDateString,
    endDateString: endDay.dateString,
    start: localDateBoundary(startDateString, timeZone),
    rangeDays: 7,
  };
}

export function rollingDurationBounds(
  value = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
  rangeDays = 1,
) {
  validateTimeZone(timeZone);
  const end = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(end.getTime())) {
    throw new Error("Rolling window requires a valid end time.");
  }
  const days = Number(rangeDays);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_ROLLING_DAYS) {
    throw new Error(
      `Rolling window must be between 1 and ${MAX_ROLLING_DAYS} days.`,
    );
  }
  return {
    start: new Date(end.getTime() - days * ROLLING_24_HOURS_MS),
    end,
    timeZone,
    rangeHours: days * 24,
    rangeDays: days,
  };
}

export function rolling24hBounds(value = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return rollingDurationBounds(value, timeZone, 1);
}

function cleanLabel(value, fallback) {
  const label = sanitizeTerminalText(value)
    .replace(/\s+/g, " ")
    .trim();
  return label || fallback;
}

const QUOTED_ABSOLUTE_PATH =
  /(["'])(\/(?!\/)[^"'\r\n]*|(?:\/\/|\\\\)[^"'\r\n]+|[A-Za-z]:[\\/][^"'\r\n]*)\1/g;
const UNQUOTED_ABSOLUTE_PATH =
  /(^|[\s([{=])((?:\/(?!\/)|\/\/|\\\\|[A-Za-z]:[\\/])[^\s"'`)\]},;]+)/g;

function isAbsoluteLocalPath(path) {
  return (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

export function safeDisplayLabel(value, fallback = "local path") {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  const label = sanitizeTerminalText(basename(normalized))
    .replace(/\s+/g, " ")
    .trim();
  return label && label !== "." && label !== ".." ? label : fallback;
}

export function redactLocalPaths(value, paths = []) {
  let redacted = String(value ?? "");
  const explicitPaths = new Set(
    paths
      .filter(Boolean)
      .map((path) => String(path))
      .filter(isAbsoluteLocalPath),
  );
  const pathsToRedact = [...new Set([
    ...explicitPaths,
    homedir(),
    process.cwd(),
  ])]
    .filter((path) => path && path !== "/")
    .sort((left, right) => right.length - left.length);

  for (const path of pathsToRedact) {
    redacted = redacted.replaceAll(
      path,
      explicitPaths.has(path) ? safeDisplayLabel(path) : "[local path]",
    );
  }

  return redacted
    .replace(QUOTED_ABSOLUTE_PATH, (_match, quote) => `${quote}[local path]${quote}`)
    .replace(UNQUOTED_ABSOLUTE_PATH, (_match, prefix) => `${prefix}[local path]`);
}

function safeErrorMessage(error, paths = []) {
  return redactLocalPaths(
    error instanceof Error ? error.message : String(error),
    paths,
  );
}

function displayLabel(value) {
  const label = cleanLabel(value, "Unlabelled activity");
  if (label.length <= 30) return label;
  return `${label.slice(0, 14)}…${label.slice(-13)}`;
}

export function oneOffProjects(snapshot, events = null) {
  const threadIdsByProject = new Map();
  const add = (project, threadId) => {
    if (!project || !threadId) return;
    const normalizedProject = cleanLabel(project, "Unlabelled activity");
    const ids = threadIdsByProject.get(normalizedProject) ?? new Set();
    ids.add(threadId);
    threadIdsByProject.set(normalizedProject, ids);
  };
  for (const bucket of events ?? usageBuckets(snapshot)) {
    for (const threadId of usageThreadIds(bucket)) add(bucket.project, threadId);
  }
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

function currentRateCardCredits(event) {
  return calculateCodexPurchasedCredits({
    model: event?.rateCardModel ?? event?.model,
    serviceTier: event?.serviceTier,
    usage: event,
  });
}

export function filterDayEvents(snapshot, bounds, analysis = null) {
  if (analysis !== null) return analysis.currentEvents;
  const start = bounds.start.getTime();
  const end = bounds.end.getTime();
  return usageBucketsInRange(snapshot, start, end);
}

export function aggregateProjects(snapshot, events, options = {}, analysis = null) {
  const singletonProjects = options.rawProjects
    ? new Set()
    : oneOffProjects(snapshot, analysis?.allEvents);
  const grouped = new Map();
  const sharedTokenScale = createSharedTokenScale();

  for (const event of events) {
    if (event?.invalidTokenRecord === true) continue;
    const allowFractional = event?.rangeAllocationEstimated === true;
    const rawProject = cleanLabel(event.project, "Unlabelled activity");
    const project =
      !options.rawProjects && singletonProjects.has(rawProject)
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
        estimated: false,
      };
    row.estimated ||= allowFractional;
    row.outputTokens = checkedTokenAdd(
      row.outputTokens,
      tokenValue(event.outputTokens, { allowFractional }),
      { allowFractional },
    );
    row.reasoningTokens = checkedTokenAdd(
      row.reasoningTokens,
      tokenValue(event.reasoningTokens, { allowFractional }),
      { allowFractional },
    );
    row.toolCalls = checkedTokenAdd(
      row.toolCalls,
      tokenValue(event.toolCalls, { allowFractional }),
      { allowFractional },
    );
    row.events = checkedTokenAdd(row.events, usageCallCount(event), {
      allowFractional,
    });
    for (const threadId of usageThreadIds(event)) row.threadIds.add(threadId);
    const rateCardCredits = currentRateCardCredits(event);
    if (Number.isFinite(rateCardCredits)) {
      row.rateCardCredits = checkedFiniteAdd(row.rateCardCredits, rateCardCredits);
      row.knownCreditTokens = checkedTokenAdd(
        row.knownCreditTokens,
        tokenValue(event.totalTokens, { allowFractional }),
        { allowFractional },
      );
    }

    const model = modelLabel(event.model);
    const modelRow = row.models.get(model) ?? {
      model,
      totalTokens: 0,
      events: 0,
      rateCardCredits: 0,
      estimated: false,
    };
    modelRow.estimated ||= allowFractional;
    addSharedTokenContribution(
      sharedTokenScale,
      tokenValue(event.totalTokens, { allowFractional }),
      [row, modelRow],
    );
    modelRow.events = checkedTokenAdd(modelRow.events, usageCallCount(event), {
      allowFractional,
    });
    if (Number.isFinite(rateCardCredits)) {
      modelRow.rateCardCredits = checkedFiniteAdd(
        modelRow.rateCardCredits,
        rateCardCredits,
      );
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

function totalSummary(events, projectRows) {
  const summary = events.reduce(
    (summary, event) => {
      if (event?.invalidTokenRecord === true) return summary;
      const allowFractional = event?.rangeAllocationEstimated === true;
      summary.toolCalls = checkedTokenAdd(
        summary.toolCalls,
        tokenValue(event.toolCalls, { allowFractional }),
        { allowFractional },
      );
      summary.calls = checkedTokenAdd(summary.calls, usageCallCount(event), {
        allowFractional,
      });
      for (const threadId of usageThreadIds(event)) {
        summary.threadIds.add(threadId);
      }
      const rateCardCredits = currentRateCardCredits(event);
      if (Number.isFinite(rateCardCredits)) {
        summary.rateCardCredits = checkedFiniteAdd(
          summary.rateCardCredits,
          rateCardCredits,
        );
        summary.knownCreditTokens = checkedTokenAdd(
          summary.knownCreditTokens,
          tokenValue(event.totalTokens, { allowFractional }),
          { allowFractional },
        );
      }
      return summary;
    },
    {
      totalTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      calls: 0,
      rateCardCredits: 0,
      knownCreditTokens: 0,
      threadIds: new Set(),
    },
  );
  summary.totalTokens = projectRows.reduce(
    (sum, row) => sum + row.totalTokens,
    0,
  );
  summary.outputTokens = scaledOutputTokens(events, summary.totalTokens);
  return summary;
}

function compact(value, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const units = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (let index = 0; index < units.length; index += 1) {
    const [divisor, suffix] = units[index];
    if (absolute < divisor) continue;
    const scaled = value / divisor;
    const magnitude = Math.abs(scaled);
    const precision = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : digits;
    // Values that round to 1000 of a unit belong to the next unit up
    // (999,999 → 1.00M, not 1000K).
    if (index > 0 && Number(magnitude.toFixed(precision)) >= 1_000) {
      return compact(Math.sign(value) * divisor * 1_000, digits);
    }
    return `${scaled.toFixed(precision)}${suffix}`;
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
  return `${safeDisplayLabel(snapshotPath, "snapshot")} · captured ${generated}`;
}

function runYouPlot(rows, options, dateLabel, unit) {
  const chartInput = [
    "project\tvalue",
    ...rows.map(
      (row) => `${sanitizeTerminalText(row.displayProject).replace(/[\t\r\n]+/g, " ")}\t${chartNumber(row.totalTokens, unit.divisor)}`,
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
  const snapshotLabel = safeDisplayLabel(snapshotPath, "snapshot");
  let parsed;
  try {
    parsed = await readPrivateSnapshot(snapshotPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Snapshot not found: ${snapshotLabel}`);
    }
    throw new Error(
      `Could not read snapshot ${snapshotLabel}: ${safeErrorMessage(error, [snapshotPath])}`,
    );
  }
  if (
    !parsed ||
    parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    !Array.isArray(parsed.events)
  ) {
    throw new Error(
      `Snapshot uses an unsupported schema: ${snapshotLabel}. Rebuild it with --refresh.`,
    );
  }
  return parsed;
}

function snapshotScopeMatchesOptions(snapshot, options) {
  const requested = collectionScope(options);
  const actual = snapshotCollectionScope(snapshot);
  if (!actual) {
    // Explicit snapshots are deliberate inputs. Preserve the existing
    // fixture/export workflow when no collection filter was requested, while
    // refusing to claim that an unknown snapshot satisfies a filter.
    return requested.since === null && requested.includeArchived;
  }
  return snapshotMatchesCollectionScope(snapshot, requested);
}

function snapshotScopeError(snapshot, options) {
  const requested = collectionScope(options);
  const actual = snapshotCollectionScope(snapshot);
  const describe = (scope) => {
    if (!scope) return "unknown collection scope";
    const since = scope.since === null ? "full history" : `since ${scope.since}`;
    const archives = scope.includeArchived
      ? "archived sessions included"
      : "archived sessions excluded";
    return `${since}; ${archives}`;
  };
  const remedy = options.inputExplicit
    ? "For --input, supply matching --since/--no-archived filters or rebuild that file with the collector; --refresh cannot be combined with --input."
    : "Rebuild it with --refresh.";
  return new Error(
    `Snapshot collection scope does not match the requested filters (requested ${describe(requested)}; found ${describe(actual)}). ${remedy}`,
  );
}

async function refreshSnapshot(options) {
  if (!existsSync(options.codexHome)) {
    throw new Error(
      `Codex data directory not found: ${safeDisplayLabel(options.codexHome, "Codex data directory")}`,
    );
  }
  let progressStarted = false;
  try {
    const { collectUsage } = await import(
      "../lib/token-ledger-importer.mjs"
    );
    process.stderr.write("Token Ledger: refreshing local snapshot…\n");
    progressStarted = true;
    const snapshot = await collectUsage(
      {
        output: options.input,
        codexHome: options.codexHome,
        includeArchived: options.includeArchived,
        since: options.since,
      },
      ({ current, total }) => {
        process.stderr.write(`\rToken Ledger: scanned ${current}/${total} rollout files`);
      },
    );
    process.stderr.write("\n");
    const writeResult = await writePrivateSnapshot(options.input, snapshot);
    const storedSnapshot = writeResult.snapshot;
    process.stderr.write(
      `Token Ledger: cached ${(writeResult.bytesWritten / 1_000_000).toFixed(1)} MB ${writeResult.encoding} snapshot (${(writeResult.jsonBytes / 1_000_000).toFixed(1)} MB JSON before encoding; ${storedSnapshot.events.length.toLocaleString()} buckets for ${storedSnapshot.coverage.observedModelCalls.toLocaleString()} calls; ${(writeResult.maxBytes / 1_000_000).toFixed(1)} MB limit).\n`,
    );
    if (writeResult.bytesWritten / writeResult.maxBytes >= 0.7) {
      process.stderr.write(
        "Token Ledger: snapshot is above 70% of its safety limit; older buckets will compact automatically as it grows.\n",
      );
    }
    return storedSnapshot;
  } catch (error) {
    if (progressStarted) process.stderr.write("\n");
    if (error?.code === "ERR_SNAPSHOT_SIZE_LIMIT" && existsSync(options.input)) {
      try {
        const previous = await readSnapshot(options.input);
        if (snapshotScopeMatchesOptions(previous, options)) {
          process.stderr.write(
            "Token Ledger: refresh exceeded the safety limit; continuing with the previous cache, which may be stale.\n",
          );
          return previous;
        }
      } catch {
        // Preserve the original refresh error when the previous cache cannot
        // prove that it has the requested collection scope.
      }
    }
    throw new Error(
      `Could not refresh local snapshot: ${safeErrorMessage(error, [options.input, options.codexHome])}`,
    );
  }
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

export function shouldCheckSourceFreshness(
  options = {},
) {
  // The source manifest is cheap to stat and is the cache's validity anchor.
  // The full collector only runs when the persisted watermark changes.
  return options.autoRefresh !== false && options.inputExplicit !== true;
}

function snapshotAgeLabel(ageMs) {
  if (ageMs < 60 * 1_000) return "now";
  const minutes = Math.floor(ageMs / (60 * 1_000));
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;
  return `${Math.floor(hours / 24)}d old`;
}

function primitiveString(value) {
  try {
    const text = String.prototype.valueOf.call(value);
    return text === value ? text : null;
  } catch {
    return null;
  }
}

export function snapshotFreshness(snapshot = {}, nowMs = Date.now()) {
  const generatedAt = primitiveString(snapshot.generatedAt);
  const generatedAtMs = generatedAt === null ? NaN : Date.parse(generatedAt);
  if (
    !Number.isFinite(generatedAtMs) ||
    !Number.isFinite(nowMs) ||
    generatedAtMs > nowMs
  ) {
    return { status: "unknown", ageLabel: "age unknown" };
  }
  return {
    status: snapshotCacheIsFresh(generatedAtMs, nowMs) ? "fresh" : "stale",
    ageLabel: snapshotAgeLabel(nowMs - generatedAtMs),
  };
}

// Resolve the snapshot together with the evidence available for its report
// cutoff. A cache can be readable without being current, so callers must keep
// this status separate from the age label shown in terminal output.
export async function loadSnapshot(options) {
  if (options.refresh) {
    return {
      snapshot: await refreshSnapshot(options),
      sourceStatus: "verified-current",
    };
  }
  if (!existsSync(options.input)) {
    if (options.inputExplicit || !options.autoRefresh) {
      throw new Error(
        `Snapshot not found: ${safeDisplayLabel(options.input, "snapshot")}`,
      );
    }
    return {
      snapshot: await refreshSnapshot(options),
      sourceStatus: "verified-current",
    };
  }
  const cached = await readSnapshot(options.input);
  if (!snapshotScopeMatchesOptions(cached, options)) {
    if (options.inputExplicit || !options.autoRefresh) {
      throw snapshotScopeError(cached, options);
    }
    return {
      snapshot: await refreshSnapshot(options),
      sourceStatus: "verified-current",
    };
  }

  if (options.inputExplicit) {
    return { snapshot: cached, sourceStatus: "explicit-snapshot" };
  }
  if (!options.autoRefresh) {
    return { snapshot: cached, sourceStatus: "unchecked-cache" };
  }

  if (!shouldCheckSourceFreshness(options)) {
    return { snapshot: cached, sourceStatus: "unchecked-cache" };
  }

  const { sourceInventory, sourceWatermarksEqual } = await import(
    "../lib/token-ledger-importer.mjs"
  );
  let inventory;
  try {
    inventory = await sourceInventory(
      options.codexHome,
      options.includeArchived,
    );
  } catch (error) {
    throw new Error(
      `Could not inspect local Codex source: ${safeErrorMessage(error, [options.codexHome])}`,
    );
  }
  if (!sourceWatermarksEqual(cached.sourceWatermark, inventory.watermark)) {
    try {
      return {
        snapshot: await refreshSnapshot(options),
        sourceStatus: "verified-current",
      };
    } catch {
      return { snapshot: cached, sourceStatus: "stale-fallback" };
    }
  }
  return { snapshot: cached, sourceStatus: "verified-current" };
}

async function render(
  options,
  snapshot,
  bounds,
  events,
  rows,
  allRows,
  freshness,
  report = {},
  analysis,
) {
  if (options.view === "cost") {
    return renderCostTerminal({ events, bounds, basis: options.basis });
  }
  if (options.view === "trend") {
    if (options.image && options.cacheRate) {
      const { renderCacheReportImage } = await import(
        "./token-ledger-cache-image.mjs"
      );
      return renderCacheReportImage({
        snapshot,
        bounds,
        days: options.trendDays,
        options,
        analysis,
      });
    }
    const trend = buildUsageTrend(snapshot, bounds, { analysis });
    if (options.image) {
      const { renderTrendImage } = await import(
        "./token-ledger-trend-image.mjs"
      );
      return renderTrendImage({
        snapshot,
        bounds,
        trend,
        days: options.trendDays,
        options,
        viewModel: buildTrendReportViewModel({
          snapshot,
          bounds,
          days: options.trendDays,
          reportTimeMs: report.reportTimeMs ?? null,
          sourceStatus: report.sourceStatus ?? "unchecked-cache",
          projectRows: allRows,
          events,
        }),
      });
    }
    return renderTrendCombo({
      snapshot,
      bounds,
      trend,
      days: options.trendDays,
      options,
      analysis,
    });
  }
  if (!options.legacyPlot) {
    return renderTerminal({
      options,
      snapshot,
      snapshotFreshness: freshness,
      bounds,
      events,
      rows,
      allRows,
    });
  }
  const enabled = !options.plain && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
  const summary = totalSummary(events, allRows);
  const totalTokens = summary.totalTokens;
  const dateLabel = options.range === "rolling24h"
    ? "last 24 hours"
    : options.range === "rolling"
      ? `last ${options.rollingLabel}`
      : options.range === "week"
        ? `${bounds.startDateString} through ${bounds.endDateString}`
        : formatCalendarDate(bounds.dateString, {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        });
  const unit = chartUnit(rows[0]?.totalTokens ?? 0);
  const shares = rows.map((row) =>
    totalTokens > 0 ? (row.totalTokens / totalTokens) * 100 : 0,
  );
  const chart = runYouPlot(rows, options, dateLabel, unit).trimEnd();
  const historyScope = historyScopeLabel(snapshot);

  const header = [
    `Token Ledger · ${dateLabel} · ${bounds.timeZone}`,
    `${compact(totalTokens)} tokens · ${summary.threadIds.size.toLocaleString()} threads · ${summary.calls.toLocaleString()} calls · ${compact(summary.outputTokens)} output`,
    ...(historyScope ? [`History: ${historyScope}`] : []),
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
    return `${String(index + 1).padStart(2, " ")}  ${sanitizeTerminalText(row.displayProject)} · ${compact(row.totalTokens)} · ${percent(shares[index])} · ${row.threads.toLocaleString()} threads${knownCreditShare}\n    ${modelMix(row, enabled)}`;
  });

  return `${header.join("\n")}\n\n${details.join("\n")}`;
}

function boundsForOptions(options, now = new Date()) {
  if (options.view === "trend") {
    return multiDayBounds(options.date, options.timeZone, options.trendDays);
  }
  if (options.range === "week") {
    return weekBounds(options.date, options.timeZone);
  }
  if (options.range === "rolling24h") {
    return rolling24hBounds(now, options.timeZone);
  }
  if (options.range === "rolling") {
    return rollingDurationBounds(now, options.timeZone, options.rollingDays);
  }
  return dayBounds(options.date, options.timeZone);
}

function rangeDescription(options, bounds) {
  if (options.range === "rolling24h" || options.range === "rolling") {
    return rollingRangeDescription(options);
  }
  if (bounds.startDateString && bounds.endDateString) {
    return `${bounds.startDateString} through ${bounds.endDateString}`;
  }
  return bounds.dateString;
}

function emptyRangeMessage(options, snapshot, bounds) {
  const range = rangeDescription(options, bounds);
  const cutoffMs = snapshotCollectionCutoffMs(snapshot);
  const hasUncollectedHistory =
    Number.isFinite(cutoffMs) && bounds.start.getTime() < cutoffMs;
  const lines = [
    hasUncollectedHistory
      ? `No model-call events were collected for ${range} (${bounds.timeZone}); history before the snapshot cutoff is outside this snapshot and is not a verified zero.`
      : `No model-call events found for ${range} (${bounds.timeZone}).`,
  ];
  const scope = historyScopeLabel(snapshot);
  if (scope) lines.push(`History: ${scope}`);
  lines.push(`Source: ${sourceLabel(options.input, snapshot)}`);
  return lines.join("\n");
}

export async function run(options, { nowMs } = {}) {
  const hasInjectedNow = nowMs !== undefined;
  const now = new Date(hasInjectedNow ? nowMs : Date.now());
  const bounds = boundsForOptions(options, now);
  const { snapshot, sourceStatus } = await loadSnapshot(options);
  const analysis = buildRangeAnalysis(
    snapshot,
    bounds,
    {
      priorBounds: options.view === "trend"
        ? priorPeriodBounds(bounds, options.trendDays)
        : null,
      includeTrend: options.view === "trend" && !options.cacheRate,
    },
  );
  let events = filterDayEvents(snapshot, bounds, analysis);
  const writingImage = options.view === "trend" && options.image;
  const writingEmptyCacheReport = writingImage && options.cacheRate;
  const reportTimeMs = hasInjectedNow ? now.getTime() : Date.now();
  if (writingImage && !options.cacheRate) {
    const effectiveEndMs = resolveEffectiveEnd({
      snapshot,
      bounds,
      reportTimeMs,
      sourceStatus,
    });
    // Keep the terminal aggregation and the report's project breakdown on the
    // same captured event window. The report view model independently applies
    // the same bound to raw snapshot events for its other panels.
    events = events.filter(
      (event) => new Date(event.timestamp).getTime() < effectiveEndMs,
    );
  }
  if (events.length === 0 && !writingEmptyCacheReport) {
    return emptyRangeMessage(options, snapshot, bounds);
  }
  const allRows = options.cacheRate || options.view === "cost"
    ? []
    : aggregateProjects(snapshot, events, options, analysis);
  const rows = allRows.slice(0, options.top);
  const outputPath = writingImage
    ? options.imageOutput ??
      resolve(
        process.cwd(),
        `token-ledger-${options.cacheRate ? "cache-report" : options.report ? "report" : "trend"}-${options.trendDays}d.png`,
      )
    : null;
  const imageLabel = options.cacheRate
    ? "cache report"
    : options.report
      ? "report"
      : "trend image";
  if (writingImage) {
    process.stderr.write(`Token Ledger: generating ${imageLabel} PNG…\n`);
  }
  const output = await render(
    options,
    snapshot,
    bounds,
    events,
    rows,
    allRows,
    snapshotFreshness(
      snapshot,
      reportTimeMs,
    ),
    { sourceStatus, reportTimeMs },
    analysis,
  );
  if (writingImage) {
    await mkdir(dirname(outputPath), { recursive: true });
    process.stderr.write(`Token Ledger: encoding ${imageLabel} PNG…\n`);
    const { writeTrendPng } = await import("./token-ledger-trend-image.mjs");
    await writeTrendPng(output, outputPath);
    process.stderr.write(`Token Ledger: finished ${imageLabel} PNG.\n`);
    const lines = [
      `Wrote ${imageLabel}: ${outputPath}`,
      `Range: ${bounds.startDateString} through ${bounds.endDateString} (${bounds.timeZone})`,
    ];
    // Show the finished report on screen right away instead of leaving it to
    // be dug out of a file browser. Skipped for piped/scripted runs so
    // automation and CI never pop windows.
    if (options.openImage && process.stdout.isTTY) {
      lines.push(
        openInViewer(outputPath)
          ? "Opened the report in your default image viewer."
          : "Could not open a viewer automatically; open the file above to see the report.",
      );
    }
    return lines.join("\n");
  }
  return output;
}

function openInViewer(path) {
  const platform = process.platform;
  const [command, args] = platform === "darwin"
    ? ["open", [path]]
    : platform === "win32"
      ? ["cmd", ["/c", "start", "", path]]
      : ["xdg-open", [path]];
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

function shouldUseInteractive(options) {
  return Boolean(
    !options.static &&
      options.view !== "trend" &&
      options.view !== "cost" &&
      !options.plain &&
      !options.legacyPlot &&
      !process.env.NO_COLOR &&
      process.stdin.isTTY &&
      process.stdout.isTTY,
  );
}

async function runInteractive(options) {
  const bounds = boundsForOptions(options);
  const { snapshot } = await loadSnapshot(options);
  const analysis = buildRangeAnalysis(snapshot, bounds, { includeTrend: false });
  const events = filterDayEvents(snapshot, bounds, analysis);
  if (events.length === 0) {
    process.stdout.write(`${emptyRangeMessage(options, snapshot, bounds)}\n`);
    return;
  }
  const allRows = aggregateProjects(snapshot, events, options, analysis);
  await startInteractive({
    options,
    snapshot,
    snapshotFreshness: snapshotFreshness(snapshot),
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
      process.stdout.write(`${options.helpAll ? advancedUsage() : usage()}\n`);
      return;
    }
    if (shouldUseInteractive(options)) {
      await runInteractive(options);
    } else {
      process.stdout.write(`${await run(options)}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `Token Ledger: ${safeErrorMessage(error, [
        options?.input,
        options?.codexHome,
        options?.imageOutput,
      ])}\nRun \`tledger --help\` for examples or \`tledger --help-all\` for every option.\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const modulePath = realpathSync(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main();
}
