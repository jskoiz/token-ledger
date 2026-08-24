// Cache report analysis. This module owns snapshot parsing and aggregation but
// has no dependency on either image renderer.

import {
  multiDayBounds,
  trendModelLabel,
} from "./token-ledger-trend.mjs";
import { chooseBinSize } from "./token-ledger-image-layout.mjs";
import { shiftCalendarDate } from "./token-ledger-image-primitives.mjs";
import {
  splitUsageBucketsAtBoundaries,
  usageBuckets,
  usageBucketsInRange,
  usageCallCount,
  usageDetailedCallCount,
  usageInputCallCount,
} from "../lib/token-ledger-usage.mjs";

const MIN_BIN_WIDTH = 34;
const MAX_MODEL_ROWS = 6;
const MAX_FINITE_NUMBER = Number.MAX_VALUE;
const SCALE_HEADROOM = 1 - Number.EPSILON;

function rateFor(inputTokens, cachedInputTokens) {
  return inputTokens > 0 ? (cachedInputTokens / inputTokens) * 100 : null;
}

function localDateFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function localDateString(timestampMs, formatter) {
  const parts = formatter.formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function timeZoneOffsetMs(timestampMs, formatter) {
  const parts = formatter.formatToParts(new Date(timestampMs));
  const value = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  if (value === "GMT") return 0;
  const match = value.match(/^GMT([+-])(\d{2}):?(\d{2})?$/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return (match[1] === "+" ? 1 : -1) * minutes * 60 * 1_000;
}

function zonedMidnightMs(dateString, formatter) {
  const [year, month, day] = dateString.split("-").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day);
  const first = utcGuess - timeZoneOffsetMs(utcGuess, formatter);
  return utcGuess - timeZoneOffsetMs(first, formatter);
}

function primitiveString(value) {
  try {
    const text = String.prototype.valueOf.call(value);
    return text === value ? text : null;
  } catch {
    return null;
  }
}

function primitiveNumber(value) {
  try {
    const number = Number.prototype.valueOf.call(value);
    return number === value ? number : null;
  } catch {
    return null;
  }
}

function finiteTimestamp(value) {
  const text = primitiveString(value);
  if (text === null) return null;
  const timestampMs = Date.parse(text);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function parsedNonNegativeFiniteNumber(value) {
  const primitive = primitiveNumber(value);
  const text = primitive === null ? primitiveString(value) : null;
  const number = primitive ?? (
    text === null || text.trim() === "" ? NaN : Number(text)
  );
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function scaleToFiniteSum(values) {
  // Values are non-negative and finite; return one common factor for them.
  const ratio = values.reduce(
    (sum, value) => sum + value / MAX_FINITE_NUMBER,
    0,
  );
  const sum = values.reduce((total, value) => total + value, 0);
  return ratio > 1 || !Number.isFinite(sum)
    ? SCALE_HEADROOM / Math.max(1, ratio)
    : 1;
}

function scaleInputTokens(target, factor) {
  target.inputTokens *= factor;
  target.cachedInputTokens *= factor;
  target.uncachedInputTokens *= factor;
}

function scaleAggregateTokens(target, factor) {
  if (Number.isFinite(target.totalTokens)) target.totalTokens *= factor;
  if (Number.isFinite(target.detailedTokens)) {
    target.detailedTokens *= factor;
  }
  scaleInputTokens(target, factor);
}

function scaleBreakdown(breakdown, factor) {
  return {
    ...breakdown,
    totalTokens: breakdown.totalTokens * factor,
    inputTokens: breakdown.inputTokens * factor,
    cachedInputTokens: breakdown.cachedInputTokens * factor,
    uncachedInputTokens: breakdown.uncachedInputTokens * factor,
  };
}

function tokenAdditionRatio(target, totalContribution, inputContribution) {
  const totalRatio = Number.isFinite(target.totalTokens)
    ? target.totalTokens / MAX_FINITE_NUMBER +
      totalContribution / MAX_FINITE_NUMBER
    : 0;
  const inputRatio = target.inputTokens / MAX_FINITE_NUMBER +
    inputContribution / MAX_FINITE_NUMBER;
  return Math.max(totalRatio, inputRatio);
}

function tokenAdditionOverflows(target, totalContribution, inputContribution) {
  return (
    (Number.isFinite(target.totalTokens) &&
      !Number.isFinite(target.totalTokens + totalContribution)) ||
    !Number.isFinite(target.inputTokens + inputContribution)
  );
}

function safeModelLabel(value) {
  const model = primitiveString(value);
  return model === null ? "Unknown" : trendModelLabel(model);
}

function cacheBreakdown(event) {
  const parsedReportedTotalTokens = parsedNonNegativeFiniteNumber(
    event.totalTokens,
  );
  const parsedInputTokens = parsedNonNegativeFiniteNumber(event.inputTokens);
  const parsedCachedInputTokens = parsedNonNegativeFiniteNumber(
    event.cachedInputTokens,
  );
  const parsedOutputTokens = parsedNonNegativeFiniteNumber(event.outputTokens);
  const reportedTotalTokens = parsedReportedTotalTokens ?? 0;
  const rawInputTokens = parsedInputTokens ?? 0;
  const outputTokens = parsedOutputTokens ?? 0;
  const rawCachedInputTokens = Math.min(
    rawInputTokens,
    parsedCachedInputTokens ?? 0,
  );
  const componentOverflowed = !Number.isFinite(rawInputTokens + outputTokens);
  const componentScale = scaleToFiniteSum([rawInputTokens, outputTokens]);
  const inputTokens = rawInputTokens * componentScale;
  const componentOutputTokens = outputTokens * componentScale;
  const cachedInputTokens = Math.min(
    inputTokens,
    rawCachedInputTokens * componentScale,
  );
  const componentTotalTokens = Math.min(
    MAX_FINITE_NUMBER,
    inputTokens + componentOutputTokens,
  );
  const totalTokens = reportedTotalTokens > 0
    ? reportedTotalTokens
    : componentTotalTokens;
  const hasComponents = inputTokens > 0 || outputTokens > 0;
  const hasReconciledBreakdown = hasComponents && (
    reportedTotalTokens === 0 ||
    componentTotalTokens === reportedTotalTokens ||
    (componentOverflowed && reportedTotalTokens === MAX_FINITE_NUMBER)
  );
  const hasExplicitReconciledZeroBreakdown =
    event.breakdownAvailable === true &&
    parsedReportedTotalTokens === 0 &&
    parsedInputTokens === 0 &&
    parsedCachedInputTokens === 0 &&
    parsedOutputTokens === 0;
  const detailed = event.breakdownAvailable !== false && (
    hasReconciledBreakdown || hasExplicitReconciledZeroBreakdown
  );
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    detailed,
  };
}

function parseCacheEvent(value) {
  if (value == null) return null;
  try {
    const timestampMs = finiteTimestamp(value.timestamp);
    if (timestampMs === null) return null;
    return {
      timestampMs,
      model: safeModelLabel(value.model),
      breakdown: cacheBreakdown(value),
    };
  } catch {
    return null;
  }
}

function emptyAggregate() {
  return {
    eventCount: 0,
    detailedEventCount: 0,
    inputEventCount: 0,
    totalTokens: 0,
    detailedTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
  };
}

function addInput(target, breakdown, inputCallCount) {
  const factor = scaleToFiniteSum([
    target.inputTokens,
    breakdown.inputTokens,
  ]);
  if (factor < 1) {
    scaleInputTokens(target, factor);
    breakdown = scaleBreakdown(breakdown, factor);
  }
  target.inputTokens += breakdown.inputTokens;
  target.cachedInputTokens += breakdown.cachedInputTokens;
  target.cachedInputTokens = Math.min(
    target.inputTokens,
    target.cachedInputTokens,
  );
  target.uncachedInputTokens = Math.max(
    0,
    target.inputTokens - target.cachedInputTokens,
  );
  target.inputEventCount += inputCallCount;
}

function finalizeAggregate(aggregate) {
  const uncachedInputTokens = Math.max(
    0,
    aggregate.inputTokens - aggregate.cachedInputTokens,
  );
  const measurementCoveragePercent = aggregate.totalTokens > 0
    ? (aggregate.detailedTokens / aggregate.totalTokens) * 100
    : aggregate.eventCount > 0
      ? (aggregate.detailedEventCount / aggregate.eventCount) * 100
      : null;
  return {
    ...aggregate,
    uncachedInputTokens,
    rate: rateFor(aggregate.inputTokens, aggregate.cachedInputTokens),
    measurementCoveragePercent,
  };
}

function accumulateRange(snapshot, bounds, bins = null, dateIndexByString = null) {
  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();
  const totals = emptyAggregate();
  const modelTotals = new Map();
  // One shared scale keeps rates, shares, and coverage proportional everywhere.
  const tokenScale = { value: 1 };
  const dateFormatter = bins === null
    ? null
    : localDateFormatter(bounds.timeZone);

  const events = bins === null
    ? usageBucketsInRange(snapshot, startMs, endMs)
    : splitUsageBucketsAtBoundaries(
        usageBuckets(snapshot),
        [
          startMs,
          ...bins.map((bin) =>
            zonedMidnightMs(bin.endDateString, dateFormatter)),
          endMs,
        ],
      );
  for (const event of events) {
    const parsed = parseCacheEvent(event);
    if (
      parsed === null ||
      parsed.timestampMs < startMs ||
      parsed.timestampMs >= endMs
    ) {
      continue;
    }
    let { breakdown } = parsed;
    const dateString = dateFormatter === null
      ? null
      : localDateString(parsed.timestampMs, dateFormatter);
    const binIndex = dateString === null ? null : dateIndexByString.get(dateString);
    const bin = binIndex === undefined || binIndex === null ? null : bins[binIndex];
    const existingModelAggregate = breakdown.detailed && breakdown.inputTokens > 0
      ? modelTotals.get(parsed.model)
      : null;
    const targets = [totals];
    if (bin) targets.push(bin);
    if (existingModelAggregate) targets.push(existingModelAggregate);
    const scale = tokenScale.value;
    const inputContribution = breakdown.detailed ? breakdown.inputTokens : 0;
    const totalContribution = breakdown.totalTokens * scale;
    const scaledInputContribution = inputContribution * scale;
    const overflowRatio = Math.max(
      ...targets.map((target) =>
        tokenAdditionRatio(
          target,
          totalContribution,
          scaledInputContribution,
        )),
    );
    const directOverflow = targets.some((target) =>
      tokenAdditionOverflows(
        target,
        totalContribution,
        scaledInputContribution,
      ));
    if (overflowRatio > 1 || directOverflow) {
      const factor = SCALE_HEADROOM / Math.max(1, overflowRatio);
      scaleAggregateTokens(totals, factor);
      for (const bin of bins ?? []) scaleAggregateTokens(bin, factor);
      for (const model of modelTotals.values()) {
        scaleAggregateTokens(model, factor);
      }
      tokenScale.value *= factor;
    }
    breakdown = scaleBreakdown(breakdown, tokenScale.value);

    const callCount = usageCallCount(event);
    const detailedCallCount = usageDetailedCallCount(event);
    const inputCallCount = usageInputCallCount(event);
    totals.eventCount += callCount;
    totals.totalTokens += breakdown.totalTokens;
    if (bin) {
      bin.eventCount += callCount;
      bin.totalTokens += breakdown.totalTokens;
    }
    if (!breakdown.detailed) continue;

    totals.detailedEventCount += detailedCallCount;
    totals.detailedTokens += breakdown.totalTokens;
    if (bin) {
      bin.detailedEventCount += detailedCallCount;
      bin.detailedTokens += breakdown.totalTokens;
    }
    if (!(breakdown.inputTokens > 0)) continue;

    addInput(totals, breakdown, inputCallCount);
    if (bin) addInput(bin, breakdown, inputCallCount);
    const model = parsed.model;
    const modelAggregate = modelTotals.get(model) ?? {
      model,
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      inputEventCount: 0,
    };
    addInput(modelAggregate, breakdown, inputCallCount);
    modelTotals.set(model, modelAggregate);
  }

  const summary = finalizeAggregate(totals);
  summary.models = [...modelTotals.values()]
    .map((model) => finalizeAggregate(model))
    .sort(
      (left, right) =>
        right.inputTokens - left.inputTokens || left.model.localeCompare(right.model),
    );
  return summary;
}

export function aggregateCacheRange(snapshot, bounds) {
  return accumulateRange(snapshot, bounds);
}

export function buildCacheReportData(
  snapshot,
  bounds,
  days,
  plotWidth,
  binSizeOverride = null,
) {
  const rangeDays = Math.max(1, Number(days) || Number(bounds.rangeDays) || 7);
  // The combined report passes the trend chart's bin size so both charts'
  // columns stay vertically aligned.
  const binSize = binSizeOverride ?? chooseBinSize(rangeDays, plotWidth, {
    minBinWidth: MIN_BIN_WIDTH,
    preferDaily: true,
  });
  const binCount = Math.ceil(rangeDays / binSize);
  const bins = Array.from({ length: binCount }, (_, index) => ({
    ...emptyAggregate(),
    startDateString: shiftCalendarDate(
      bounds.startDateString,
      index * binSize,
    ),
    endDateString: shiftCalendarDate(
      bounds.startDateString,
      Math.min(rangeDays, (index + 1) * binSize),
    ),
  }));
  const dateIndexByString = new Map(
    Array.from({ length: rangeDays }, (_, index) => [
      shiftCalendarDate(bounds.startDateString, index),
      Math.floor(index / binSize),
    ]),
  );
  const summary = accumulateRange(snapshot, bounds, bins, dateIndexByString);
  return {
    ...summary,
    bins: bins.map((bin) => finalizeAggregate(bin)),
    binSize,
    binCount,
  };
}

export function combinedModelRows(models) {
  if (models.length <= MAX_MODEL_ROWS) return models;
  const visible = models.slice(0, MAX_MODEL_ROWS - 1);
  const remainder = models.slice(MAX_MODEL_ROWS - 1).reduce(
    (row, model) => {
      row.inputTokens += model.inputTokens;
      row.cachedInputTokens += model.cachedInputTokens;
      row.inputEventCount += model.inputEventCount;
      row.uncachedInputTokens = Math.max(
        0,
        row.inputTokens - row.cachedInputTokens,
      );
      return row;
    },
    {
      model: "Other models",
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      inputEventCount: 0,
    },
  );
  return [...visible, finalizeAggregate(remainder)];
}

export function priorPeriodSummary(snapshot, bounds, days) {
  const priorEndDate = shiftCalendarDate(bounds.startDateString, -1);
  const priorBounds = multiDayBounds(priorEndDate, bounds.timeZone, days);
  return aggregateCacheRange(snapshot, priorBounds);
}
