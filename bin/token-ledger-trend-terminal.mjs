import { buildBurnDayBins, buildUsageTrend, trendModelLabel } from "./token-ledger-trend.mjs";
import { chooseBinSize } from "./token-ledger-image-layout.mjs";
import {
  MAX_SAFE_TOKEN_COUNT,
  checkedTokenAdd,
  splitUsageBucketsAtBoundaries,
  tokenValue,
  usageBuckets,
  usageCallCount,
} from "../lib/token-ledger-usage.mjs";
import { sanitizeTerminalText } from "../lib/token-ledger-terminal-text.mjs";

export { chooseBinSize } from "./token-ledger-image-layout.mjs";

const RESET = "\u001b[0m";
const PRIMARY_STYLE = [38, 2, 255, 255, 255];
const SECONDARY_STYLE = [38, 2, 155, 155, 155];
const BORDER_STYLE = [38, 2, 88, 88, 88];
const GRID_STYLE = [38, 2, 72, 72, 72];
const LINE_STYLE = [1, 38, 2, 255, 236, 168];
const RESET_LINE_STYLE = [1, 38, 2, 255, 255, 255];
const TOKEN_SCALE = Symbol("tokenScale");

function tokenScale(target) {
  return Number.isFinite(target[TOKEN_SCALE]) && target[TOKEN_SCALE] >= 1
    ? target[TOKEN_SCALE]
    : 1;
}

function setTokenScale(target, scale) {
  Object.defineProperty(target, TOKEN_SCALE, {
    configurable: true,
    enumerable: false,
    value: scale,
    writable: true,
  });
}

function scaleTokenMap(values, ratio) {
  for (const [model, value] of values) {
    values.set(model, value * ratio);
  }
}

function addBinTokens(bin, model, tokens, fast) {
  if (!(tokens > 0)) return;
  const scale = tokenScale(bin);
  const scaledTokens = tokens / scale;
  bin.totalTokens += scaledTokens;
  bin.values.set(model, (bin.values.get(model) ?? 0) + scaledTokens);
  if (fast) {
    bin.fastValues.set(model, (bin.fastValues.get(model) ?? 0) + scaledTokens);
  }

  const scaleFactor = Math.max(1, bin.totalTokens / MAX_SAFE_TOKEN_COUNT);
  if (scaleFactor === 1) return;
  bin.totalTokens = MAX_SAFE_TOKEN_COUNT;
  scaleTokenMap(bin.values, 1 / scaleFactor);
  scaleTokenMap(bin.fastValues, 1 / scaleFactor);
  setTokenScale(bin, scale * scaleFactor);
}

function mergeBinTotals(state, bin) {
  const sourceScale = tokenScale(bin);
  const commonScale = Math.max(state.scale, sourceScale);
  const targetRatio = state.scale / commonScale;
  const sourceRatio = sourceScale / commonScale;
  state.totalTokens *= targetRatio;
  scaleTokenMap(state.values, targetRatio);
  scaleTokenMap(state.fastValues, targetRatio);
  for (const [model, value] of bin.values) {
    state.totalTokens += value * sourceRatio;
    state.values.set(
      model,
      (state.values.get(model) ?? 0) + value * sourceRatio,
    );
  }
  for (const [model, value] of bin.fastValues) {
    state.fastValues.set(
      model,
      (state.fastValues.get(model) ?? 0) + value * sourceRatio,
    );
  }

  const scaleFactor = Math.max(1, state.totalTokens / MAX_SAFE_TOKEN_COUNT);
  if (scaleFactor > 1) {
    state.totalTokens = MAX_SAFE_TOKEN_COUNT;
    scaleTokenMap(state.values, 1 / scaleFactor);
    scaleTokenMap(state.fastValues, 1 / scaleFactor);
  }
  state.scale = commonScale * scaleFactor;
}

function alignBinsToScale(bins, scale) {
  for (const bin of bins) {
    const sourceScale = tokenScale(bin);
    if (sourceScale === scale) continue;
    const ratio = sourceScale / scale;
    bin.totalTokens *= ratio;
    scaleTokenMap(bin.values, ratio);
    scaleTokenMap(bin.fastValues, ratio);
    setTokenScale(bin, scale);
  }
}

// Mirrors the SVG renderer's validated categorical palette.
export const TREND_MODEL_COLORS = {
  Luna: [38, 2, 42, 120, 214],
  Sol: [38, 2, 235, 104, 52],
  Terra: [38, 2, 27, 175, 122],
  "GPT-5.5": [38, 2, 237, 161, 0],
  "GPT-5.4": [38, 2, 232, 123, 164],
  Daybreak: [38, 2, 0, 131, 0],
  "Auto review": [38, 2, 74, 58, 167],
  Other: [38, 2, 137, 135, 129],
  Unknown: [38, 2, 137, 135, 129],
  Unattributed: [38, 2, 195, 194, 183],
};

const MODEL_ORDER = [
  "Luna",
  "Sol",
  "Terra",
  "GPT-5.5",
  "GPT-5.4",
  "Daybreak",
  "Auto review",
  "Other",
  "Unknown",
];

const ATTRIBUTION_MODEL_ORDER = ["Luna", "Sol", "Terra"];

function colorsEnabled(options = {}) {
  return options.forceColor ??
    (!options.plain && !process.env.NO_COLOR && Boolean(process.stdout.isTTY));
}

function colorize(value, style, enabled) {
  return enabled ? `\u001b[${style.join(";")}m${value}${RESET}` : value;
}

function stripAnsi(value) {
  return sanitizeTerminalText(value);
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function fit(value, width, alignment = "left") {
  const text = String(value);
  const length = visibleLength(text);
  if (length > width) return stripAnsi(text).slice(0, Math.max(0, width - 1)) + (width > 0 ? "…" : "");
  const padding = " ".repeat(Math.max(0, width - length));
  if (alignment === "right") return `${padding}${text}`;
  if (alignment === "center") {
    const left = Math.floor(padding.length / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(padding.length - left)}`;
  }
  return `${text}${padding}`;
}

function compact(value) {
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
    const precision = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
    // Values that round to 1000 of a unit belong to the next unit up
    // (999,999 → 1.00M, not 1000K).
    if (index > 0 && Number(magnitude.toFixed(precision)) >= 1_000) {
      return compact(Math.sign(value) * divisor * 1_000);
    }
    return `${scaled.toFixed(precision)}${suffix}`;
  }
  return Math.round(value).toLocaleString("en-US");
}

function percent(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function styleForModel(model) {
  return TREND_MODEL_COLORS[model] ?? TREND_MODEL_COLORS.Other;
}

function modelSort(left, right) {
  const leftIndex = MODEL_ORDER.indexOf(left);
  const rightIndex = MODEL_ORDER.indexOf(right);
  return (
    (leftIndex < 0 ? MODEL_ORDER.length : leftIndex) -
      (rightIndex < 0 ? MODEL_ORDER.length : rightIndex) ||
    left.localeCompare(right)
  );
}

function dateParts(dateString) {
  return dateString.split("-").map(Number);
}

function dateStringFromParts(year, month, day) {
  return [year, month, day]
    .map((value, index) =>
      index === 0 ? String(value) : String(value).padStart(2, "0"),
    )
    .join("-");
}

function shiftCalendarDate(dateString, amount) {
  const [year, month, day] = dateParts(dateString);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return dateStringFromParts(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function timeZoneFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function timeZoneOffsetMs(instant, formatter) {
  const parts = formatter.formatToParts(instant);
  const value = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  if (value === "GMT") return 0;
  const match = value.match(/^GMT([+-])(\d{2}):?(\d{2})?$/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return (match[1] === "+" ? 1 : -1) * minutes * 60 * 1_000;
}

function zonedMidnight(
  dateString,
  timeZone,
  formatter = timeZoneFormatter(timeZone),
) {
  const [year, month, day] = dateParts(dateString);
  const utcGuess = Date.UTC(year, month - 1, day);
  const first = new Date(utcGuess - timeZoneOffsetMs(new Date(utcGuess), formatter));
  return new Date(utcGuess - timeZoneOffsetMs(first, formatter));
}

function localDateString(
  timestamp,
  timeZone,
  formatter = timeZoneFormatter(timeZone),
) {
  const parts = formatter.formatToParts(new Date(timestamp));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function localDateLabel(dateString, timeZone) {
  const date = zonedMidnight(dateString, timeZone);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "2-digit",
  })
    .format(date)
    .toUpperCase();
}

function sortedModelEntries(values) {
  return [...values.entries()]
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => modelSort(left, right));
}

export function buildActualTokenBins(
  snapshot,
  bounds,
  days,
  width,
  {
    binSize: forcedBinSize,
    minBinWidth,
    preferDaily,
    events = null,
  } = {},
) {
  const binSize = forcedBinSize ?? chooseBinSize(days, width, { minBinWidth, preferDaily });
  const binCount = Math.ceil(days / binSize);
  const bins = Array.from({ length: binCount }, (_, index) => ({
    startDateString: shiftCalendarDate(bounds.startDateString, index * binSize),
    endDateString: shiftCalendarDate(
      bounds.startDateString,
      Math.min(days, (index + 1) * binSize),
    ),
    values: new Map(),
    fastValues: new Map(),
    totalTokens: 0,
    calls: 0,
  }));
  const startDate = bounds.startDateString;
  const dateIndexByString = new Map(
    Array.from({ length: days }, (_, index) => [
      shiftCalendarDate(startDate, index),
      index,
    ]),
  );
  const dateFormatter = timeZoneFormatter(bounds.timeZone);
  const binBoundaries = [
    bins[0]?.startDateString,
    ...bins.map((bin) => bin.endDateString),
  ]
    .filter(Boolean)
    .map((dateString) =>
      zonedMidnight(dateString, bounds.timeZone, dateFormatter).getTime());
  for (const event of splitUsageBucketsAtBoundaries(
    events ?? usageBuckets(snapshot),
    binBoundaries,
  )) {
    const timestamp = new Date(event.timestamp).getTime();
    if (!Number.isFinite(timestamp)) continue;
    const dateString = localDateString(timestamp, bounds.timeZone, dateFormatter);
    const dayIndex = dateIndexByString.get(dateString);
    if (dayIndex === undefined || dayIndex >= days) continue;
    const bin = bins[Math.floor(dayIndex / binSize)];
    if (event?.invalidTokenRecord === true) continue;
    const allowFractional = event.rangeAllocationEstimated === true;
    const tokens = tokenValue(event.totalTokens, { allowFractional });
    const model = trendModelLabel(event.model);
    bin.calls = checkedTokenAdd(bin.calls, usageCallCount(event), {
      allowFractional,
    });
    addBinTokens(bin, model, tokens, event.serviceTier === "priority");
  }

  const totalsState = {
    scale: 1,
    totalTokens: 0,
    values: new Map(),
    fastValues: new Map(),
  };
  for (const bin of bins) {
    mergeBinTotals(totalsState, bin);
  }
  alignBinsToScale(bins, totalsState.scale);
  return {
    bins,
    totals: totalsState.values,
    fastTotals: totalsState.fastValues,
    scale: totalsState.scale,
    binSize,
    binCount,
  };
}

function niceCeiling(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function allocateSegmentHeights(entries, total, maxValue, plotHeight) {
  const barHeight = total > 0
    ? Math.max(1, Math.round((total / maxValue) * (plotHeight - 1)))
    : 0;
  if (!barHeight) return [];
  // Model counters can cap independently when the bin total reaches the
  // safe-token limit. Partition the already-scaled bar across the model
  // entries so capped components cannot make the stack taller than its bin.
  const segmentTotal = entries.reduce((sum, [, value]) => sum + value, 0);
  const partitionTotal = segmentTotal > 0 ? segmentTotal : total;
  const ideal = entries.map(([, value]) => (value / partitionTotal) * barHeight);
  const heights = ideal.map(Math.floor);
  let remainder = barHeight - heights.reduce((sum, value) => sum + value, 0);
  const order = ideal
    .map((value, index) => ({ index, fraction: value - Math.floor(value), value }))
    .sort((left, right) => right.fraction - left.fraction || right.value - left.value);
  for (let index = 0; index < remainder; index += 1) {
    heights[order[index % order.length].index] += 1;
  }
  // Preserve a one-cell sliver for a non-zero model whenever the bar has
  // enough vertical resolution to show it.
  if (barHeight >= entries.length) {
    for (let index = 0; index < entries.length; index += 1) {
      if (heights[index] > 0) continue;
      const donor = heights.findIndex((height) => height > 1);
      if (donor < 0) break;
      heights[donor] -= 1;
      heights[index] = 1;
    }
  }
  return heights;
}

function sampleQuota(trend, bounds, width) {
  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();
  const points = trend.points ?? [];
  const resets = trend.resets ?? [];
  const samples = [];
  let pointIndex = 0;
  let resetIndex = 0;
  let activePoint = null;

  for (let column = 0; column < width; column += 1) {
    const ratio = width <= 1 ? 0 : column / (width - 1);
    const timestampMs = startMs + (endMs - startMs) * ratio;
    while (
      pointIndex < points.length &&
      points[pointIndex].timestampMs <= timestampMs
    ) {
      activePoint = points[pointIndex];
      pointIndex += 1;
    }
    const previousTimestampMs =
      column === 0 ? startMs - 1 : samples[column - 1].timestampMs;
    let reset = false;
    while (
      resetIndex < resets.length &&
      resets[resetIndex].timestampMs <= previousTimestampMs
    ) {
      resetIndex += 1;
    }
    while (
      resetIndex < resets.length &&
      resets[resetIndex].timestampMs <= timestampMs
    ) {
      reset = true;
      resetIndex += 1;
    }
    samples.push({
      timestampMs,
      point: activePoint,
      reset,
      remainingPercent: reset ? 100 : activePoint?.remainingPercent ?? null,
    });
  }
  return samples;
}

function lineRow(remainingPercent, plotHeight) {
  if (!Number.isFinite(remainingPercent)) return null;
  return Math.max(
    0,
    Math.min(
      plotHeight - 1,
      Math.round(((100 - remainingPercent) / 100) * (plotHeight - 1)),
    ),
  );
}

function xLabelLine(bins, plotWidth, leftWidth, rightWidth, timeZone) {
  const labels = Array.from({ length: plotWidth }, () => " ");
  const write = (label, offset) => {
    for (let index = 0; index < label.length; index += 1) {
      const target = offset + index;
      if (target >= 0 && target < labels.length) labels[target] = label[index];
    }
  };
  bins.forEach((bin, index) => {
    const start = Math.round((index * plotWidth) / bins.length);
    const end = Math.round(((index + 1) * plotWidth) / bins.length);
    const label = localDateLabel(bin.startDateString, timeZone);
    if (end - start >= label.length) {
      write(label, start + Math.floor((end - start - label.length) / 2));
    } else if (index === 0 || index === bins.length - 1 || end - start >= 4) {
      write(label.slice(-2), start + Math.max(0, Math.floor((end - start - 2) / 2)));
    }
  });
  return `${" ".repeat(leftWidth + 1)}${labels.join("")}${" ".repeat(rightWidth + 1)}`;
}

function rowAxisLine(leftLabel, plot, rightLabel, leftWidth, rightWidth, enabled) {
  const axis = colorize("│", BORDER_STYLE, enabled);
  return `${fit(leftLabel, leftWidth, "right")}${axis}${plot}${axis}${fit(rightLabel, rightWidth)}`;
}

function frameLine(content, width) {
  return `│${fit(content, width - 2)}│`;
}

function wrapAttributionEntries(prefix, entries, width) {
  const lines = [];
  let line = prefix;
  for (const entry of entries) {
    const separator = line === prefix ? " · " : "   ";
    const candidate = `${line}${separator}${entry}`;
    if (visibleLength(candidate) <= width) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = entry;
  }
  lines.push(line);
  return lines;
}

function formatAttribution(trend, enabled, width, percentMode) {
  const rows = new Map((trend.models ?? []).map((row) => [row.model, row]));
  const entries = ATTRIBUTION_MODEL_ORDER
    .map((model) => {
      const row = rows.get(model);
      if (!row || !(row.tokensPerBurnPoint > 0)) return null;
      return percentMode
        ? `${model} ${compact(row.tokensPerBurnPoint)} tok/1%`
        : `${model} ${compact(row.tokensPerBurnPoint)} T/p · ${row.burnPoints.toFixed(1)} pts`;
    })
    .filter(Boolean);
  if (!entries.length) return [];
  const prefix = percentMode
    ? "Observed burn rate"
    : "ESTIMATE ONLY · quota attribution lens";
  const valueLines = wrapAttributionEntries(prefix, entries, width - 2).map(
    (line) => fit(colorize(line, SECONDARY_STYLE, enabled), width - 2),
  );
  const method = colorize(
    percentMode
      ? `Columns sum to observed meter drops; model split via rate-card credit weights (card ${trend.rateCardAsOf}).`
      : `Rate-card/token weights, ${trend.rateCardAsOf}; separate from actual-token bars and not official quota math.`,
    SECONDARY_STYLE,
    enabled,
  );
  return [...valueLines, fit(method, width - 2)];
}

function drainLabelLine(burnBins, plotWidth, leftWidth, rightWidth, enabled) {
  const labels = Array.from({ length: plotWidth }, () => " ");
  const write = (label, at) => {
    for (let index = 0; index < label.length; index += 1) {
      const target = at + index;
      if (target >= 0 && target < labels.length) labels[target] = label[index];
    }
  };
  burnBins.forEach((bin, index) => {
    if (Math.round(bin.totalPercent) < 1) return;
    const start = Math.round((index * plotWidth) / burnBins.length);
    const end = Math.round(((index + 1) * plotWidth) / burnBins.length);
    const label = `-${Math.round(bin.totalPercent)}%${bin.approximate ? "~" : ""}`;
    if (end - start >= label.length) {
      write(label, start + Math.floor((end - start - label.length) / 2));
    }
  });
  return `${" ".repeat(leftWidth + 1)}${colorize(labels.join(""), LINE_STYLE, enabled)}${" ".repeat(rightWidth + 1)}`;
}

export function renderTrendCombo({
  snapshot,
  bounds,
  trend: providedTrend = null,
  days = bounds.rangeDays ?? 7,
  options = {},
  analysis = null,
}) {
  const trend = providedTrend ?? analysis?.trend ?? buildUsageTrend(snapshot, bounds, { analysis });
  const enabled = colorsEnabled(options);
  const frameWidth = Math.max(82, Math.min(158, Number(options.width) || 120));
  const innerWidth = frameWidth - 2;
  const leftWidth = 8;
  const rightWidth = 7;
  const plotWidth = Math.max(36, innerWidth - leftWidth - rightWidth - 2);
  const plotHeight = 11;
  const actual = buildActualTokenBins(snapshot, bounds, days, plotWidth, {
    events: analysis?.currentEvents,
  });
  const burn = buildBurnDayBins(trend, bounds, {
    days,
    binSize: actual.binSize,
  });
  // Drain mode (--drain) draws the meter's own observed drops as columns in
  // the same unit as the quota line. The default volume mode keeps token bars
  // and shows the observed drop per column in a label row instead.
  const meterUsable = Boolean(trend.available && burn.totalPercent > 0);
  const percentMode = Boolean(options.drain) && meterUsable;
  const meterAvailable = Boolean(trend.available && (trend.points ?? []).length > 0);
  const barBins = percentMode ? burn.bins : actual.bins;
  const binTotal = (bin) => (percentMode ? bin.totalPercent : bin.totalTokens);
  const maxLeft = niceCeiling(
    barBins.reduce((maximum, bin) => Math.max(maximum, binTotal(bin)), 0),
  );
  const chart = Array.from({ length: plotHeight }, () =>
    Array.from({ length: plotWidth }, () => ({ char: "·", style: GRID_STYLE })),
  );
  const baseline = plotHeight - 1;
  const majorRows = new Set([0, Math.floor(baseline / 2), baseline]);
  for (const row of majorRows) {
    for (let column = 0; column < plotWidth; column += 1) {
      chart[row][column] = { char: "┄", style: GRID_STYLE };
    }
  }

  for (const [binIndex, bin] of barBins.entries()) {
    const entries = sortedModelEntries(bin.values);
    const heights = allocateSegmentHeights(
      entries,
      binTotal(bin),
      maxLeft,
      plotHeight,
    );
    const start = Math.round((binIndex * plotWidth) / actual.binCount);
    const end = Math.round(((binIndex + 1) * plotWidth) / actual.binCount);
    const fillStart = end - start > 2 ? start + 1 : start;
    const fillEnd = end - start > 2 ? end - 1 : end;
    let cumulative = 0;
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const [model] = entries[entryIndex];
      const height = heights[entryIndex];
      for (let row = baseline - cumulative - height; row < baseline - cumulative; row += 1) {
        if (row < 0 || row >= plotHeight) continue;
        for (let column = fillStart; column < fillEnd; column += 1) {
          chart[row][column] = { char: "█", style: styleForModel(model) };
        }
      }
      cumulative += height;
    }
  }

  const quotaSamples = sampleQuota(trend, bounds, plotWidth);
  const quotaRows = quotaSamples.map((sample) =>
    lineRow(sample.remainingPercent, plotHeight),
  );
  for (let column = 0; column < quotaSamples.length; column += 1) {
    const current = quotaRows[column];
    if (current === null) continue;
    const previous = column > 0 ? quotaRows[column - 1] : null;
    const sample = quotaSamples[column];
    if (sample.reset && previous !== null) {
      const top = Math.min(current, previous);
      const bottom = Math.max(current, previous);
      for (let row = top; row <= bottom; row += 1) {
        chart[row][column] = {
          char: row === current ? "↟" : "│",
          style: RESET_LINE_STYLE,
        };
      }
      continue;
    }
    const character = previous === null
      ? "◆"
      : current === previous
        ? "─"
        : current < previous
          ? "╱"
          : "╲";
    chart[current][column] = { char: character, style: LINE_STYLE };
  }

  const axisRows = [0, Math.floor(baseline / 2), baseline];
  const lines = [
    `┌${"─".repeat(frameWidth - 2)}┐`,
    frameLine(
      colorize(
        `TOKEN LEDGER · ${percentMode ? "OBSERVED LIMIT DRAIN + WEEKLY METER" : meterAvailable ? "ACTUAL TOKENS + WEEKLY QUOTA" : "ACTUAL TOKENS"} · ${localDateLabel(bounds.startDateString, bounds.timeZone)} – ${localDateLabel(bounds.endDateString, bounds.timeZone)} · ${days}D`,
        PRIMARY_STYLE,
        enabled,
      ),
      frameWidth,
    ),
    frameLine(
      colorize(
        percentMode
          ? "BARS = observed limit % consumed per day by model · LINE = meter remaining · one percent scale"
          : meterAvailable
            ? "BARS = actual token quantity by model · LINE = meter remaining · -% row = observed drain per column"
            : "BARS = actual token quantity by model · no account-wide weekly meter observed",
        SECONDARY_STYLE,
        enabled,
      ),
      frameWidth,
    ),
    `├${"─".repeat(frameWidth - 2)}┤`,
  ];
  for (let row = 0; row < plotHeight; row += 1) {
    const leftValue = maxLeft * (1 - row / baseline);
    const rightValue = 100 * (1 - row / baseline);
    const leftLabel = axisRows.includes(row)
      ? percentMode
        ? percent(leftValue)
        : compact(leftValue)
      : "";
    const rightLabel = meterAvailable && axisRows.includes(row)
      ? `${Math.round(rightValue)}%`
      : "";
    const content = chart[row]
      .map(({ char, style }) => colorize(char, style, enabled))
      .join("");
    lines.push(frameLine(rowAxisLine(leftLabel, content, rightLabel, leftWidth, rightWidth, enabled), frameWidth));
  }
  const axis = `${" ".repeat(leftWidth)}${colorize(`└${"─".repeat(plotWidth)}┘`, BORDER_STYLE, enabled)}${" ".repeat(rightWidth)}`;
  lines.push(frameLine(axis, frameWidth));
  lines.push(frameLine(xLabelLine(barBins, plotWidth, leftWidth, rightWidth, bounds.timeZone), frameWidth));
  if (!percentMode && meterUsable) {
    lines.push(frameLine(drainLabelLine(burn.bins, plotWidth, leftWidth, rightWidth, enabled), frameWidth));
    lines.push(frameLine(fit("CALENDAR DAY · -% = OBSERVED METER DROP", innerWidth, "center"), frameWidth));
  } else {
    lines.push(frameLine(fit("CALENDAR DAY", innerWidth, "center"), frameWidth));
  }
  lines.push(`├${"─".repeat(frameWidth - 2)}┤`);

  const totalTokens = [...actual.totals.values()].reduce(
    (sum, value) => checkedTokenAdd(sum, value, { allowFractional: true }),
    0,
  );
  const legendModels = percentMode
    ? [...burn.totals.keys()].sort(modelSort)
    : [...actual.totals.keys()].sort(modelSort);
  const legend = legendModels.map((model) => {
    if (percentMode) {
      const tokens = actual.totals.get(model);
      const tokenPart = tokens > 0 ? ` · ${compact(tokens)} tok` : "";
      return colorize(
        `■ ${model} ${percent(burn.totals.get(model))} of limit${tokenPart}`,
        styleForModel(model),
        enabled,
      );
    }
    const fastTokens = actual.fastTotals?.get(model) ?? 0;
    const fastPart = fastTokens > 0
      ? ` · ${percent((fastTokens / actual.totals.get(model)) * 100)} fast`
      : "";
    return colorize(
      `■ ${model} ${compact(actual.totals.get(model))} (${percent((actual.totals.get(model) / totalTokens) * 100)})${fastPart}`,
      styleForModel(model),
      enabled,
    );
  });
  lines.push(frameLine(colorize(percentMode ? "OBSERVED LIMIT DRAIN BY MODEL · LEFT AXIS" : "ACTUAL TOKEN VOLUME · LEFT AXIS", PRIMARY_STYLE, enabled), frameWidth));
  for (let index = 0; index < legend.length; index += 2) {
    const leftLegendWidth = Math.floor((innerWidth - 2) / 2);
    const rightLegendWidth = innerWidth - 2 - leftLegendWidth;
    lines.push(frameLine(`${fit(legend[index], leftLegendWidth)}  ${fit(legend[index + 1] ?? "", rightLegendWidth)}`, frameWidth));
  }
  if (meterAvailable) {
    lines.push(frameLine(colorize("LINE · OBSERVED WEEKLY QUOTA REMAINING · RIGHT AXIS", LINE_STYLE, enabled), frameWidth));
    lines.push(frameLine(colorize("↟ reset marker returns the line to 100%; it never rises within a cycle", SECONDARY_STYLE, enabled), frameWidth));
  } else {
    lines.push(frameLine(colorize("NO ACCOUNT-WIDE WEEKLY METER OBSERVED", SECONDARY_STYLE, enabled), frameWidth));
  }
  for (const line of formatAttribution(trend, enabled, frameWidth, percentMode)) {
    lines.push(frameLine(line, frameWidth));
  }
  lines.push(`└${"─".repeat(frameWidth - 2)}┘`);
  return lines.join("\n");
}

export function renderTrendPlain(args) {
  return renderTrendCombo({ ...args, options: { ...args.options, plain: true } });
}
