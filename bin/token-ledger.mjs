#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import {
  readFile,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderTerminal } from "./token-ledger-terminal.mjs";
import { startInteractive } from "./token-ledger-tui.mjs";

export const DEFAULT_SNAPSHOT = resolve(
  homedir(),
  ".token-ledger",
  "token-ledger-snapshot.json",
);
const DEFAULT_TOP = 10;
const MAX_RANGE_DAYS = 100_000;
const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function usage() {
  return `Token Ledger terminal usage

Usage:
  tledger
  tledger week [end-day]
  tledger day [day]
  tledger month [end-day]
  tledger <number>d [end-day]
  tledger all

Ranges:
  day                  One calendar day
  week                 7 days ending on end-day (default: today)
  month                30 days ending on end-day (default: today)
  <number>d            That many days ending on end-day, for example 90d
  all                  Every dated event in the snapshot

Options:
  --date <day>         Date as YYYY-MM-DD, today, or yesterday
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
  --help               Show this help

The default view is the seven-day window ending today. Token Ledger never
uploads data or renders message bodies, tool payloads, or credentials.`;
}

function readOption(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function rangeSpec(value) {
  if (value === "day") return { range: "day", rangeDays: 1 };
  if (value === "week") return { range: "week", rangeDays: 7 };
  if (value === "month") return { range: "month", rangeDays: 30 };
  if (value === "all") return { range: "all", rangeDays: null };
  const custom = /^(\d+)d$/.exec(value ?? "");
  if (!custom) return null;
  const rangeDays = Number(custom[1]);
  if (
    !Number.isSafeInteger(rangeDays) ||
    rangeDays < 1 ||
    rangeDays > MAX_RANGE_DAYS
  ) {
    throw new Error(
      `Day range must be an integer from 1 to ${MAX_RANGE_DAYS.toLocaleString("en-US")}, for example 90d.`,
    );
  }
  return { range: `${rangeDays}d`, rangeDays };
}

export function parseArgs(argv) {
  const requestedRange = rangeSpec(argv[0]);
  const commandExplicit = Boolean(requestedRange);
  if (argv[0] && !argv[0].startsWith("-") && !commandExplicit) {
    throw new Error(
      `Unknown command: ${argv[0]}. Use day, week, month, all, or a duration like 90d.`,
    );
  }
  const command = requestedRange ?? { range: "week", rangeDays: 7 };
  const options = {
    range: command.range,
    rangeDays: command.rangeDays,
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
    help: false,
  };

  let index = commandExplicit ? 1 : 0;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--date") {
      options.date = readOption(argv, index, "--date");
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
    } else if (commandExplicit && !argument.startsWith("-") && !options.date) {
      options.date = argument;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!options.help && options.range === "all" && options.date) {
    throw new Error("The all range does not accept an end day.");
  }
  if (!options.help && !options.date && options.range !== "all") {
    options.date = "today";
  }
  if (!options.help && options.refresh && !options.autoRefresh) {
    throw new Error("--refresh cannot be combined with --no-refresh.");
  }
  if (!options.help && options.refresh && options.inputExplicit) {
    throw new Error("--refresh cannot be combined with --input.");
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
  return {
    dateString,
    startDateString: dateString,
    endDateString: dateString,
    start,
    end,
    timeZone,
    rangeDays: 1,
  };
}

export function rollingBounds(value, timeZone, rangeDays) {
  if (
    !Number.isSafeInteger(rangeDays) ||
    rangeDays < 1 ||
    rangeDays > MAX_RANGE_DAYS
  ) {
    throw new Error(
      `Range days must be an integer from 1 to ${MAX_RANGE_DAYS.toLocaleString("en-US")}.`,
    );
  }
  const endDay = dayBounds(value, timeZone);
  const startDateString = shiftCalendarDate(endDay.dateString, -(rangeDays - 1));
  return {
    ...endDay,
    startDateString,
    endDateString: endDay.dateString,
    start: zonedMidnight(startDateString, timeZone),
    rangeDays,
  };
}

export function weekBounds(value, timeZone) {
  return rollingBounds(value, timeZone, 7);
}

export function monthBounds(value, timeZone) {
  return rollingBounds(value, timeZone, 30);
}

function eventTimestamp(event) {
  if (typeof event?.timestamp !== "string" || !event.timestamp.trim()) {
    return Number.NaN;
  }
  return new Date(event.timestamp).getTime();
}

export function allBounds(snapshot, timeZone) {
  validateTimeZone(timeZone);
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const event of snapshot.events ?? []) {
    const timestamp = eventTimestamp(event);
    if (!Number.isFinite(timestamp)) continue;
    earliest = Math.min(earliest, timestamp);
    latest = Math.max(latest, timestamp);
  }
  if (!Number.isFinite(earliest)) {
    return {
      ...dayBounds("today", timeZone),
      rangeDays: null,
      allTime: true,
    };
  }
  const dateString = (timestamp) => dateStringFromParts(numericDateParts({
    value: new Date(timestamp),
    timeZone,
  }));
  const startDateString = dateString(earliest);
  const endDateString = dateString(latest);
  return {
    dateString: endDateString,
    startDateString,
    endDateString,
    start: zonedMidnight(startDateString, timeZone),
    end: zonedMidnight(shiftCalendarDate(endDateString, 1), timeZone),
    timeZone,
    rangeDays: null,
    allTime: true,
  };
}

function boundsForOptions(options, snapshot) {
  if (options.range === "all") return allBounds(snapshot, options.timeZone);
  return rollingBounds(options.date, options.timeZone, options.rangeDays);
}

function describeRange(options, bounds) {
  if (options.range === "all") return "all time";
  if (bounds.rangeDays === 1) return bounds.dateString;
  return `${bounds.startDateString} through ${bounds.endDateString}`;
}

export function sanitizeTerminalText(value) {
  return String(value ?? "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
}

function cleanLabel(value, fallback) {
  const label = sanitizeTerminalText(value)
    .replace(/\s+/g, " ")
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
    const normalizedProject = cleanLabel(project, "Unlabelled activity");
    const ids = threadIdsByProject.get(normalizedProject) ?? new Set();
    ids.add(threadId);
    threadIdsByProject.set(normalizedProject, ids);
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
    const timestamp = eventTimestamp(event);
    return Number.isFinite(timestamp) && timestamp >= start && timestamp < end;
  });
}

export function aggregateProjects(snapshot, events, options = {}) {
  const singletonProjects = options.rawProjects ? new Set() : oneOffProjects(snapshot);
  const grouped = new Map();

  for (const event of events) {
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
        models: new Map(),
      };
    row.totalTokens += Number(event.totalTokens) || 0;
    row.outputTokens += Number(event.outputTokens) || 0;
    row.reasoningTokens += Number(event.reasoningTokens) || 0;
    row.toolCalls += Number(event.toolCalls) || 0;
    row.events += 1;
    if (event.threadId) row.threadIds.add(event.threadId);
    const model = modelLabel(event.model);
    const modelRow = row.models.get(model) ?? {
      model,
      totalTokens: 0,
      events: 0,
    };
    modelRow.totalTokens += Number(event.totalTokens) || 0;
    modelRow.events += 1;
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

function sourceLabel(snapshotPath, snapshot) {
  const generated = snapshot.generatedAt
    ? new Date(snapshot.generatedAt).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "unknown time";
  return `${cleanLabel(basename(snapshotPath), "snapshot")} · captured ${generated}`;
}

function latestActivityDateString(snapshot, timeZone) {
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const event of snapshot.events ?? []) {
    const timestamp = eventTimestamp(event);
    if (Number.isFinite(timestamp) && timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
    }
  }
  if (!Number.isFinite(latestTimestamp)) return null;
  return dateStringFromParts(numericDateParts({
    value: new Date(latestTimestamp),
    timeZone,
  }));
}

function displayCalendarDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function emptyState(options, snapshot, bounds) {
  const lines = [
    `No model-call events found for ${describeRange(options, bounds)} (${bounds.timeZone}).`,
    "Token Ledger reads only Codex history stored on this computer.",
  ];
  const latestDate = latestActivityDateString(snapshot, bounds.timeZone);
  if (latestDate) {
    lines.push(`Latest local activity: ${displayCalendarDate(latestDate)}.`);
    lines.push(`Try: tledger ${options.range} ${latestDate}`);
  }
  lines.push(`Source: ${sourceLabel(options.input, snapshot)}`);
  return lines.join("\n");
}

async function readSnapshot(snapshotPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Snapshot not found: ${sanitizeTerminalText(snapshotPath)}`);
    }
    throw new Error(
      `Could not read snapshot ${sanitizeTerminalText(snapshotPath)}: ${sanitizeTerminalText(error.message)}`,
    );
  }
  if (!parsed || !Array.isArray(parsed.events)) {
    throw new Error(
      `Snapshot is missing its events array: ${sanitizeTerminalText(snapshotPath)}`,
    );
  }
  return parsed;
}

async function refreshSnapshot(options) {
  if (!existsSync(options.codexHome)) {
    throw new Error(
      `Codex data directory not found: ${sanitizeTerminalText(options.codexHome)}`,
    );
  }
  const { collectUsage, writePrivateSnapshot } = await import(
    "../lib/token-ledger-collector.mjs"
  );
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
  await writePrivateSnapshot(options.input, snapshot);
  return snapshot;
}

export function snapshotNeedsRefresh(
  snapshotMtimeMs,
  latestSourceMtimeMs,
  cachedSourceFingerprint,
  expectedSourceFingerprint,
  cachedSourceFileCount,
  currentSourceFileCount,
) {
  return (
    cachedSourceFingerprint !== expectedSourceFingerprint ||
    cachedSourceFileCount !== currentSourceFileCount ||
    latestSourceMtimeMs > snapshotMtimeMs
  );
}

async function loadSnapshot(options) {
  if (options.refresh) {
    return refreshSnapshot(options);
  }
  if (!existsSync(options.input)) {
    if (options.inputExplicit || !options.autoRefresh) {
      throw new Error(`Snapshot not found: ${sanitizeTerminalText(options.input)}`);
    }
    return refreshSnapshot(options);
  }
  if (!options.autoRefresh || options.inputExplicit) {
    return readSnapshot(options.input);
  }

  const { sourceFingerprint, sourceState } = await import(
    "../lib/token-ledger-collector.mjs"
  );
  const [snapshotStat, currentSourceState, snapshot] = await Promise.all([
    stat(options.input),
    sourceState(options.codexHome, options.includeArchived),
    readSnapshot(options.input),
  ]);
  if (snapshotNeedsRefresh(
    snapshotStat.mtimeMs,
    currentSourceState.latestMtimeMs,
    snapshot.provenance?.sourceFingerprint,
    sourceFingerprint(options.codexHome, options.includeArchived),
    snapshot.coverage?.sourceFileCount,
    currentSourceState.fileCount,
  )) {
    return refreshSnapshot(options);
  }
  return snapshot;
}

function render(options, snapshot, bounds, events, rows, allRows) {
  return renderTerminal({ options, snapshot, bounds, events, rows, allRows });
}

export async function run(options) {
  if (options.range !== "all") boundsForOptions(options);
  const snapshot = await loadSnapshot(options);
  const bounds = boundsForOptions(options, snapshot);
  const events = filterDayEvents(snapshot, bounds);
  if (events.length === 0) {
    return emptyState(options, snapshot, bounds);
  }
  const allRows = aggregateProjects(snapshot, events, options);
  const rows = allRows.slice(0, options.top);
  return render(options, snapshot, bounds, events, rows, allRows);
}

function shouldUseInteractive(options) {
  return Boolean(
    !options.static &&
      !options.plain &&
      !process.env.NO_COLOR &&
      process.stdin.isTTY &&
      process.stdout.isTTY,
  );
}

async function runInteractive(options) {
  if (options.range !== "all") boundsForOptions(options);
  const snapshot = await loadSnapshot(options);
  const bounds = boundsForOptions(options, snapshot);
  const events = filterDayEvents(snapshot, bounds);
  if (events.length === 0) {
    process.stdout.write(`${emptyState(options, snapshot, bounds)}\n`);
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
      process.stdout.write(`${await run({ ...options, static: true })}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `Token Ledger CLI failed: ${sanitizeTerminalText(error.message)}\n\n${usage()}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const modulePath = realpathSync(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main();
}
