import {
  multiDayBounds,
  trendModelLabel,
} from "./token-ledger-trend.mjs";
import {
  compact,
  escapeXml,
  shiftCalendarDate,
  svgRect,
  svgText,
  textWidth,
  TREND_IMAGE_MODEL_COLORS,
} from "./token-ledger-trend-image.mjs";
import { chooseBinSize } from "./token-ledger-trend-terminal.mjs";

const COLORS = {
  background: "#0e1420",
  ink: "#f2f5fa",
  secondary: "#aeb8c9",
  muted: "#77839a",
  grid: "#1c2534",
  baseline: "#33405a",
  track: "#202a3a",
  cached: "#2ec4a1",
  uncached: "#d88362",
  volume: "#64748b",
  weighted: "#c7d2e8",
  rule: "rgba(255,255,255,.1)",
};

const MIN_BIN_WIDTH = 34;
const MAX_MODEL_ROWS = 6;
const MAX_FINITE_NUMBER = Number.MAX_VALUE;

function percent(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function rateFor(inputTokens, cachedInputTokens) {
  return inputTokens > 0 ? (cachedInputTokens / inputTokens) * 100 : null;
}

function localDateString(timestampMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function calendarDate(dateString) {
  return new Date(`${dateString}T00:00:00.000Z`);
}

function shortDateLabel(dateString) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(calendarDate(dateString));
}

function weekdayLabel(dateString) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
  }).format(calendarDate(dateString)).toUpperCase();
}

function periodLabel(bounds) {
  const startYear = bounds.startDateString.slice(0, 4);
  const endYear = bounds.endDateString.slice(0, 4);
  const start = shortDateLabel(bounds.startDateString);
  const end = shortDateLabel(bounds.endDateString);
  return startYear === endYear
    ? `${start} – ${end}, ${endYear}`
    : `${start}, ${startYear} – ${end}, ${endYear}`;
}

function binDateLabel(bin) {
  const finalDate = shiftCalendarDate(bin.endDateString, -1);
  if (finalDate === bin.startDateString) return shortDateLabel(bin.startDateString);
  return `${shortDateLabel(bin.startDateString)}–${shortDateLabel(finalDate)}`;
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

function generatedAtLabel(value, timeZone) {
  const timestampMs = finiteTimestamp(value);
  if (timestampMs === null) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}

function nonNegativeFiniteNumber(value) {
  const primitive = primitiveNumber(value);
  const text = primitive === null ? primitiveString(value) : null;
  const number = primitive ?? (text === null ? NaN : Number(text));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function saturatingAdd(left, right) {
  // Keep large but individually valid snapshots finite for ratios and SVG math.
  const sum = left + right;
  return Number.isFinite(sum) ? sum : MAX_FINITE_NUMBER;
}

function safeModelLabel(value) {
  const model = primitiveString(value);
  return model === null ? "Unknown" : trendModelLabel(model);
}

function cacheBreakdown(event) {
  const reportedTotalTokens = nonNegativeFiniteNumber(event.totalTokens);
  const inputTokens = nonNegativeFiniteNumber(event.inputTokens);
  const outputTokens = nonNegativeFiniteNumber(event.outputTokens);
  const componentTotalTokens = saturatingAdd(inputTokens, outputTokens);
  const totalTokens = reportedTotalTokens > 0
    ? reportedTotalTokens
    : componentTotalTokens;
  const cachedInputTokens = Math.min(
    inputTokens,
    nonNegativeFiniteNumber(event.cachedInputTokens),
  );
  const hasComponents = inputTokens > 0 || outputTokens > 0;
  const inferredDetailed = hasComponents && (
    reportedTotalTokens === 0 || componentTotalTokens === reportedTotalTokens
  );
  const detailed = event.breakdownAvailable === true || (
    event.breakdownAvailable !== false && inferredDetailed
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

function addInput(target, breakdown) {
  target.inputTokens = saturatingAdd(target.inputTokens, breakdown.inputTokens);
  target.cachedInputTokens = saturatingAdd(
    target.cachedInputTokens,
    breakdown.cachedInputTokens,
  );
  target.uncachedInputTokens = saturatingAdd(
    target.uncachedInputTokens,
    breakdown.uncachedInputTokens,
  );
  target.inputEventCount = saturatingAdd(target.inputEventCount, 1);
}

function finalizeAggregate(aggregate) {
  const measurementCoveragePercent = aggregate.totalTokens > 0
    ? (aggregate.detailedTokens / aggregate.totalTokens) * 100
    : aggregate.eventCount > 0
      ? (aggregate.detailedEventCount / aggregate.eventCount) * 100
      : null;
  return {
    ...aggregate,
    rate: rateFor(aggregate.inputTokens, aggregate.cachedInputTokens),
    measurementCoveragePercent,
  };
}

function accumulateRange(snapshot, bounds, bins = null, dateIndexByString = null) {
  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();
  const totals = emptyAggregate();
  const modelTotals = new Map();

  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  for (const event of events) {
    const parsed = parseCacheEvent(event);
    if (
      parsed === null ||
      parsed.timestampMs < startMs ||
      parsed.timestampMs >= endMs
    ) {
      continue;
    }
    const { breakdown } = parsed;
    const dateString = bins
      ? localDateString(parsed.timestampMs, bounds.timeZone)
      : null;
    const binIndex = dateString === null ? null : dateIndexByString.get(dateString);
    const bin = binIndex === undefined || binIndex === null ? null : bins[binIndex];

    totals.eventCount = saturatingAdd(totals.eventCount, 1);
    totals.totalTokens = saturatingAdd(totals.totalTokens, breakdown.totalTokens);
    if (bin) {
      bin.eventCount = saturatingAdd(bin.eventCount, 1);
      bin.totalTokens = saturatingAdd(bin.totalTokens, breakdown.totalTokens);
    }
    if (!breakdown.detailed) continue;

    totals.detailedEventCount = saturatingAdd(totals.detailedEventCount, 1);
    totals.detailedTokens = saturatingAdd(
      totals.detailedTokens,
      breakdown.totalTokens,
    );
    if (bin) {
      bin.detailedEventCount = saturatingAdd(bin.detailedEventCount, 1);
      bin.detailedTokens = saturatingAdd(
        bin.detailedTokens,
        breakdown.totalTokens,
      );
    }
    if (!(breakdown.inputTokens > 0)) continue;

    addInput(totals, breakdown);
    if (bin) addInput(bin, breakdown);
    const model = parsed.model;
    const modelAggregate = modelTotals.get(model) ?? {
      model,
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      inputEventCount: 0,
    };
    addInput(modelAggregate, breakdown);
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

export function buildCacheReportData(snapshot, bounds, days, plotWidth) {
  const rangeDays = Math.max(1, Number(days) || Number(bounds.rangeDays) || 7);
  const binSize = chooseBinSize(rangeDays, plotWidth, {
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

function combinedModelRows(models) {
  if (models.length <= MAX_MODEL_ROWS) return models;
  const visible = models.slice(0, MAX_MODEL_ROWS - 1);
  const remainder = models.slice(MAX_MODEL_ROWS - 1).reduce(
    (row, model) => {
      row.inputTokens = saturatingAdd(row.inputTokens, model.inputTokens);
      row.cachedInputTokens = saturatingAdd(
        row.cachedInputTokens,
        model.cachedInputTokens,
      );
      row.uncachedInputTokens = saturatingAdd(
        row.uncachedInputTokens,
        model.uncachedInputTokens,
      );
      row.inputEventCount = saturatingAdd(
        row.inputEventCount,
        model.inputEventCount,
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

function modelColor(model) {
  return TREND_IMAGE_MODEL_COLORS[model] ?? TREND_IMAGE_MODEL_COLORS.Other;
}

function priorPeriodSummary(snapshot, bounds, days) {
  const priorEndDate = shiftCalendarDate(bounds.startDateString, -1);
  const priorBounds = multiDayBounds(priorEndDate, bounds.timeZone, days);
  return aggregateCacheRange(snapshot, priorBounds);
}

function periodComparison(currentRate, priorRate) {
  if (!Number.isFinite(currentRate)) return "No current-period input";
  if (!Number.isFinite(priorRate)) return "No prior-period input";
  const delta = currentRate - priorRate;
  const deltaLabel = Math.abs(delta) < 0.05
    ? "flat"
    : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} pp`;
  return `Prior ${percent(priorRate)} · ${deltaLabel}`;
}

const AXIS_LABEL_GAP = 12;

function labelEvery(bins, slotWidth) {
  if (bins.length === 0 || slotWidth <= 0) return 1;
  const widestLabel = Math.max(
    ...bins.map((bin) => textWidth(binDateLabel(bin), 13)),
  );
  return Math.max(1, Math.ceil((widestLabel + AXIS_LABEL_GAP) / slotWidth));
}

function pushLegendItem(elements, { x, y, color, label, line = false }) {
  if (line) {
    elements.push(
      `<line x1="${x}" y1="${y - 4}" x2="${x + 22}" y2="${y - 4}" stroke="${color}" stroke-width="2" stroke-dasharray="5 4"/>`,
    );
  } else {
    elements.push(svgRect(x, y - 12, 14, 11, { rx: 2, fill: color }));
  }
  elements.push(svgText({
    x: x + (line ? 31 : 23),
    y,
    value: label,
    fill: COLORS.secondary,
    size: 13,
  }));
}

export function renderCacheReportImage({
  snapshot,
  bounds,
  days = bounds.rangeDays ?? 7,
  options = {},
}) {
  const width = Math.max(900, Math.min(2_400, Number(options.imageWidth) || 1_280));
  const outer = 32;
  const contentRight = width - outer;
  const plotLeft = 82;
  const plotRight = width - 94;
  const plotWidth = plotRight - plotLeft;
  const data = buildCacheReportData(snapshot, bounds, days, plotWidth);
  const prior = priorPeriodSummary(snapshot, bounds, days);
  const models = combinedModelRows(data.models);
  const headerTitle = "TOKEN LEDGER · CACHE REPORT";
  const headerMetadata = `${periodLabel(bounds)} · ${bounds.timeZone}`;
  const headerTitleWidth = textWidth(headerTitle, 27, 800) -
    0.27 * (headerTitle.length - 1);
  const headerMetadataFits = headerTitleWidth + textWidth(headerMetadata, 14) + 24 <=
    contentRight - outer;

  const ratePlotTop = 320;
  const ratePlotHeight = 270;
  const ratePlotBottom = ratePlotTop + ratePlotHeight;
  const volumeTop = 635;
  const volumeHeight = 55;
  const volumeBottom = volumeTop + volumeHeight;
  const legendBaseline = 770;
  const modelRuleY = 800;
  const modelHeaderBaseline = 830;
  const modelRowsTop = 858;
  const modelRowHeight = 44;
  const modelRowCount = Math.max(1, models.length);
  const footerRuleY = modelRowsTop + modelRowCount * modelRowHeight + 28;
  const height = footerRuleY + 118;

  const description =
    "Dark cache report with a weighted cached-versus-uncached input split, normalized cache-rate columns with input-volume context, and a secondary model-level cache-rate breakout.";
  const elements = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="cache-title cache-description">`,
    `<title id="cache-title">${escapeXml(`Token Ledger · ${days}-day cache report`)}</title>`,
    `<desc id="cache-description">${escapeXml(description)}</desc>`,
    `<rect width="100%" height="100%" fill="${COLORS.background}"/>`,
    svgText({
      x: outer,
      y: 53,
      value: headerTitle,
      size: 27,
      weight: 800,
      spacing: "-0.27",
    }),
    svgText({
      x: contentRight,
      y: headerMetadataFits ? 53 : 77,
      value: headerMetadata,
      fill: COLORS.muted,
      size: 14,
      anchor: "end",
    }),
    svgText({
      x: outer,
      y: 97,
      value: "WEIGHTED INPUT CACHE RATE",
      fill: COLORS.muted,
      size: 12,
      spacing: "1.32",
    }),
  ];

  const summaryValue = Number.isFinite(data.rate)
    ? `${percent(data.rate)} cached`
    : "No measured input";
  elements.push(svgText({
    x: outer,
    y: 135,
    value: summaryValue,
    size: 29,
    weight: 800,
    spacing: "-0.58",
  }));
  elements.push(svgText({
    x: contentRight,
    y: 133,
    value: periodComparison(data.rate, prior.rate),
    fill: COLORS.secondary,
    size: 14,
    weight: 600,
    anchor: "end",
  }));

  const railTop = 153;
  const railHeight = 52;
  const railWidth = contentRight - outer;
  elements.push(
    `<defs><clipPath id="cache-coverage-clip">${svgRect(outer, railTop, railWidth, railHeight, { rx: 8 })}</clipPath></defs>`,
  );
  elements.push(`<g clip-path="url(#cache-coverage-clip)">`);
  elements.push(svgRect(outer, railTop, railWidth, railHeight, {
    fill: Number.isFinite(data.rate) ? COLORS.uncached : COLORS.track,
  }));
  const cachedRailWidth = Number.isFinite(data.rate)
    ? railWidth * (data.rate / 100)
    : 0;
  if (cachedRailWidth > 0) {
    elements.push(svgRect(outer, railTop, cachedRailWidth, railHeight, {
      fill: COLORS.cached,
    }));
  }
  elements.push("</g>");
  if (cachedRailWidth >= 150) {
    elements.push(svgText({
      x: outer + cachedRailWidth / 2,
      y: railTop + 32,
      value: `CACHED · ${compact(data.cachedInputTokens)}`,
      fill: COLORS.background,
      size: 13,
      weight: 800,
      anchor: "middle",
      spacing: ".65",
    }));
  }
  const uncachedRailWidth = railWidth - cachedRailWidth;
  if (Number.isFinite(data.rate) && uncachedRailWidth >= 150) {
    elements.push(svgText({
      x: outer + cachedRailWidth + uncachedRailWidth / 2,
      y: railTop + 32,
      value: `UNCACHED · ${compact(data.uncachedInputTokens)}`,
      fill: COLORS.background,
      size: 13,
      weight: 800,
      anchor: "middle",
      spacing: ".65",
    }));
  }
  elements.push(svgText({
    x: outer,
    y: 230,
    value: Number.isFinite(data.rate)
      ? `${compact(data.cachedInputTokens)} cached · ${compact(data.uncachedInputTokens)} uncached · ${compact(data.inputTokens)} total input`
      : "No events with a usable input-token breakdown in this range",
    fill: COLORS.secondary,
    size: 14,
  }));
  elements.push(svgText({
    x: contentRight,
    y: 230,
    value: `${data.inputEventCount.toLocaleString("en-US")} measured input-bearing ${data.inputEventCount === 1 ? "call" : "calls"}`,
    fill: COLORS.muted,
    size: 13,
    anchor: "end",
  }));

  elements.push(svgText({
    x: outer,
    y: 283,
    value: "CACHE RATE BY PERIOD",
    fill: COLORS.muted,
    size: 12,
    spacing: "1.32",
  }));
  elements.push(svgText({
    x: contentRight,
    y: 283,
    value: "Rate bars are normalized to 100% · input volume below",
    fill: COLORS.muted,
    size: 12.5,
    anchor: "end",
  }));

  for (const value of [100, 75, 50, 25, 0]) {
    const y = ratePlotBottom - (value / 100) * ratePlotHeight;
    elements.push(
      `<line x1="${plotLeft}" y1="${y.toFixed(2)}" x2="${plotRight}" y2="${y.toFixed(2)}" stroke="${value === 0 ? COLORS.baseline : COLORS.grid}" stroke-width="1"/>`,
    );
    elements.push(svgText({
      x: plotLeft - 13,
      y: y + 4,
      value: `${value}%`,
      fill: COLORS.muted,
      size: 12.5,
      anchor: "end",
      mono: true,
    }));
  }

  const slotWidth = plotWidth / data.binCount;
  const barWidth = Math.min(72, Math.max(16, slotWidth * 0.58));
  const observedMaxInput = Math.max(
    0,
    ...data.bins.map((bin) => bin.inputTokens),
  );
  const maxInput = Math.max(1, observedMaxInput);
  const dateStep = labelEvery(data.bins, slotWidth);
  data.bins.forEach((bin, index) => {
    const centerX = plotLeft + (index + 0.5) * slotWidth;
    const barX = centerX - barWidth / 2;
    if (Number.isFinite(bin.rate)) {
      elements.push(svgRect(barX, ratePlotTop, barWidth, ratePlotHeight, {
        rx: 4,
        fill: COLORS.uncached,
        opacity: ".88",
      }));
      const cachedHeight = ratePlotHeight * (bin.rate / 100);
      if (cachedHeight > 0) {
        elements.push(svgRect(
          barX,
          ratePlotBottom - cachedHeight,
          barWidth,
          cachedHeight,
          { rx: 2, fill: COLORS.cached },
        ));
      }
      if (slotWidth >= 50 && data.binCount <= 20) {
        elements.push(svgText({
          x: centerX,
          y: ratePlotTop - 10,
          value: percent(bin.rate),
          fill: COLORS.secondary,
          size: 12.5,
          weight: 700,
          anchor: "middle",
          mono: true,
        }));
      }
    } else {
      elements.push(svgRect(barX, ratePlotTop, barWidth, ratePlotHeight, {
        rx: 4,
        fill: COLORS.track,
        stroke: COLORS.baseline,
        "stroke-width": 1,
      }));
      elements.push(
        `<line x1="${barX + 5}" y1="${ratePlotTop + ratePlotHeight / 2}" x2="${barX + barWidth - 5}" y2="${ratePlotTop + ratePlotHeight / 2}" stroke="${COLORS.muted}" stroke-width="1"/>`,
      );
    }

    const volumeBarHeight = (bin.inputTokens / maxInput) * volumeHeight;
    if (volumeBarHeight > 0) {
      elements.push(svgRect(
        barX,
        volumeBottom - volumeBarHeight,
        barWidth,
        volumeBarHeight,
        { rx: 2, fill: COLORS.volume },
      ));
    }
    const finalBinIndex = data.binCount - 1;
    const showDateLabel = index === finalBinIndex || (
      index % dateStep === 0 && finalBinIndex - index >= dateStep
    );
    if (showDateLabel) {
      const daily = data.binSize === 1;
      if (daily) {
        elements.push(svgText({
          x: centerX,
          y: 718,
          value: weekdayLabel(bin.startDateString),
          fill: COLORS.muted,
          size: 11.5,
          anchor: "middle",
          spacing: "1.15",
        }));
      }
      elements.push(svgText({
        x: centerX,
        y: daily ? 739 : 730,
        value: binDateLabel(bin),
        fill: COLORS.secondary,
        size: 13,
        anchor: "middle",
      }));
    }
  });

  elements.push(svgText({
    x: plotLeft - 13,
    y: volumeTop + 4,
    value: observedMaxInput > 0 ? compact(observedMaxInput) : "—",
    fill: COLORS.muted,
    size: 11.5,
    anchor: "end",
    mono: true,
  }));
  elements.push(svgText({
    x: plotLeft - 13,
    y: volumeBottom + 4,
    value: "0",
    fill: COLORS.muted,
    size: 11.5,
    anchor: "end",
    mono: true,
  }));
  elements.push(svgText({
    x: outer,
    y: volumeTop - 10,
    value: "INPUT",
    fill: COLORS.muted,
    size: 10.5,
    spacing: "1.1",
  }));

  if (Number.isFinite(data.rate)) {
    const lineY = ratePlotBottom - (data.rate / 100) * ratePlotHeight;
    elements.push(
      `<line x1="${plotLeft}" y1="${lineY.toFixed(2)}" x2="${plotRight}" y2="${lineY.toFixed(2)}" stroke="${COLORS.weighted}" stroke-width="1.6" stroke-dasharray="6 5"/>`,
    );
    elements.push(svgText({
      x: plotRight + 8,
      y: lineY + 4,
      value: percent(data.rate),
      fill: COLORS.weighted,
      size: 11.5,
      weight: 700,
      mono: true,
    }));
  }

  pushLegendItem(elements, {
    x: outer,
    y: legendBaseline,
    color: COLORS.cached,
    label: "Cached input",
  });
  pushLegendItem(elements, {
    x: outer + 150,
    y: legendBaseline,
    color: COLORS.uncached,
    label: "Uncached input",
  });
  pushLegendItem(elements, {
    x: outer + 320,
    y: legendBaseline,
    color: COLORS.volume,
    label: "Input volume",
  });
  pushLegendItem(elements, {
    x: outer + 465,
    y: legendBaseline,
    color: COLORS.weighted,
    label: "Weighted rate",
    line: true,
  });

  elements.push(
    `<line x1="${outer}" y1="${modelRuleY}" x2="${contentRight}" y2="${modelRuleY}" stroke="${COLORS.rule}" stroke-width="1"/>`,
  );
  elements.push(svgText({
    x: outer,
    y: modelHeaderBaseline,
    value: "MODEL",
    fill: COLORS.muted,
    size: 11,
    spacing: "1.1",
  }));

  const rateRight = outer + 170;
  const modelBarLeft = outer + 188;
  const modelBarRight = width - 330;
  const modelBarWidth = modelBarRight - modelBarLeft;
  const inputRight = width - 135;
  const shareRight = contentRight;
  elements.push(svgText({
    x: rateRight,
    y: modelHeaderBaseline,
    value: "CACHE RATE",
    fill: COLORS.muted,
    size: 11,
    anchor: "end",
    spacing: "1.1",
  }));
  elements.push(svgText({
    x: modelBarLeft,
    y: modelHeaderBaseline,
    value: "CACHED / UNCACHED INPUT",
    fill: COLORS.muted,
    size: 11,
    spacing: "1.1",
  }));
  elements.push(svgText({
    x: inputRight,
    y: modelHeaderBaseline,
    value: "INPUT",
    fill: COLORS.muted,
    size: 11,
    anchor: "end",
    spacing: "1.1",
  }));
  elements.push(svgText({
    x: shareRight,
    y: modelHeaderBaseline,
    value: "SHARE",
    fill: COLORS.muted,
    size: 11,
    anchor: "end",
    spacing: "1.1",
  }));

  if (models.length === 0) {
    elements.push(svgText({
      x: outer,
      y: modelRowsTop + 27,
      value: "No measured input tokens to break out by model.",
      fill: COLORS.secondary,
      size: 14,
    }));
  }
  models.forEach((model, index) => {
    const centerY = modelRowsTop + index * modelRowHeight + 23;
    const modelShare = data.inputTokens > 0
      ? (model.inputTokens / data.inputTokens) * 100
      : 0;
    elements.push(
      `<circle cx="${outer + 5}" cy="${centerY - 4}" r="4.5" fill="${modelColor(model.model)}"/>`,
    );
    elements.push(svgText({
      x: outer + 18,
      y: centerY,
      value: model.model,
      fill: COLORS.ink,
      size: 14,
      weight: 700,
    }));
    elements.push(svgText({
      x: rateRight,
      y: centerY,
      value: percent(model.rate),
      fill: COLORS.secondary,
      size: 13,
      weight: 700,
      anchor: "end",
      mono: true,
    }));
    elements.push(svgRect(modelBarLeft, centerY - 11, modelBarWidth, 11, {
      rx: 3,
      fill: COLORS.uncached,
      opacity: ".7",
    }));
    const fillWidth = modelBarWidth * (model.rate / 100);
    if (fillWidth > 0) {
      elements.push(svgRect(modelBarLeft, centerY - 11, fillWidth, 11, {
        rx: 3,
        fill: COLORS.cached,
      }));
    }
    elements.push(svgText({
      x: inputRight,
      y: centerY,
      value: compact(model.inputTokens),
      fill: COLORS.secondary,
      size: 13,
      weight: 700,
      anchor: "end",
      mono: true,
    }));
    elements.push(svgText({
      x: shareRight,
      y: centerY,
      value: percent(modelShare),
      fill: COLORS.muted,
      size: 13,
      anchor: "end",
      mono: true,
    }));
  });

  elements.push(
    `<line x1="${outer}" y1="${footerRuleY}" x2="${contentRight}" y2="${footerRuleY}" stroke="${COLORS.rule}" stroke-width="1"/>`,
  );
  const footerTop = footerRuleY + 22;
  const columnWidth = (contentRight - outer) / 3;
  const dataAsOfQualifier = `${bounds.timeZone} · ${days}-day calendar window`;
  const footerItems = [
    {
      label: "RATE DEFINITION",
      value: "cached input ÷ measured input",
      qualifiers: ["weighted by input tokens, not daily averages"],
    },
    {
      label: "MEASUREMENT COVERAGE",
      value: Number.isFinite(data.measurementCoveragePercent)
        ? `${percent(data.measurementCoveragePercent)} of ${data.totalTokens > 0 ? "token volume" : "calls"}`
        : "unknown",
      qualifiers: [`${data.detailedEventCount.toLocaleString("en-US")} of ${data.eventCount.toLocaleString("en-US")} calls include component detail`],
    },
    {
      label: "DATA AS OF",
      value: generatedAtLabel(snapshot.generatedAt, bounds.timeZone),
      qualifiers: textWidth(dataAsOfQualifier, 12) <= columnWidth - 22
        ? [dataAsOfQualifier]
        : [bounds.timeZone, `${days}-day calendar window`],
    },
  ];
  const qualifierLineCount = Math.max(
    ...footerItems.map((item) => item.qualifiers.length),
  );
  footerItems.forEach((item, index) => {
    const columnX = outer + index * columnWidth;
    const x = index === 0 ? columnX : columnX + 22;
    if (index > 0) {
      elements.push(
        `<line x1="${columnX.toFixed(2)}" y1="${footerTop}" x2="${columnX.toFixed(2)}" y2="${footerTop + 53 + (qualifierLineCount - 1) * 16}" stroke="${COLORS.rule}" stroke-width="1"/>`,
      );
    }
    elements.push(svgText({
      x,
      y: footerTop + 10,
      value: item.label,
      fill: COLORS.muted,
      size: 11,
      spacing: "1.1",
    }));
    elements.push(svgText({
      x,
      y: footerTop + 33,
      value: item.value,
      fill: COLORS.ink,
      size: 15,
      weight: 700,
    }));
    item.qualifiers.forEach((qualifier, qualifierIndex) => {
      elements.push(svgText({
        x,
        y: footerTop + 53 + qualifierIndex * 16,
        value: qualifier,
        fill: COLORS.muted,
        size: 12,
      }));
    });
  });

  elements.push("</svg>");
  return elements.join("\n");
}
