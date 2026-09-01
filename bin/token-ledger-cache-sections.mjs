// Named SVG sections for the standalone cache report. Each builder is pure
// with respect to its context and returns markup in render order.

import {
  buildCacheReportData,
  combinedModelRows,
  priorPeriodSummary,
} from "./token-ledger-cache-data.mjs";
import {
  compact,
  escapeXml,
  shiftCalendarDate,
  svgRect,
  svgText,
  textWidth,
  truncateText,
  CACHE_IMAGE_COLORS as COLORS,
  TREND_IMAGE_MODEL_COLORS,
} from "./token-ledger-image-primitives.mjs";
import { historyScopeLabel } from "../lib/token-ledger-collection.mjs";
import { sourceStatusLine } from "./token-ledger-source-status.mjs";
import { incompleteSourceWarning } from "./token-ledger-terminal.mjs";

function percent(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
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

function wrapFooterText(value, maxWidth, size = 12) {
  const words = String(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && textWidth(candidate, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function footerQualifierLines(value, fallbackLines, maxWidth) {
  if (textWidth(value, 12) <= maxWidth) return [value];
  return fallbackLines.flatMap((line) => wrapFooterText(line, maxWidth));
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

function modelColor(model) {
  return TREND_IMAGE_MODEL_COLORS[model] ?? TREND_IMAGE_MODEL_COLORS.Other;
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

function createCacheReportContext({
  snapshot,
  bounds,
  days,
  options,
  analysis,
  sourceStatus,
}) {
  const width = Math.max(900, Math.min(2_400, Number(options.imageWidth) || 1_280));
  const outer = 32;
  const contentRight = width - outer;
  const plotLeft = 82;
  const plotRight = width - 94;
  const plotWidth = plotRight - plotLeft;
  const data = buildCacheReportData(
    snapshot,
    bounds,
    days,
    plotWidth,
    null,
    analysis?.currentEvents ?? null,
  );
  const prior = priorPeriodSummary(
    snapshot,
    bounds,
    days,
    analysis?.priorEvents ?? null,
  );
  const models = combinedModelRows(data.models);
  const columnWidth = (contentRight - outer) / 3;
  const qualifierWidth = columnWidth - 22;
  const measurementCounts = `${data.detailedEventCount.toLocaleString("en-US")} of ${data.eventCount.toLocaleString("en-US")} calls`;
  const measurementQualifier = `${measurementCounts} include component detail`;
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
      qualifiers: footerQualifierLines(
        measurementQualifier,
        [measurementCounts, "include component detail"],
        qualifierWidth,
      ),
    },
    {
      label: "DATA AS OF",
      value: generatedAtLabel(snapshot.generatedAt, bounds.timeZone),
      qualifiers: footerQualifierLines(
        dataAsOfQualifier,
        [bounds.timeZone, `${days}-day calendar window`],
        qualifierWidth,
      ),
    },
  ];
  const qualifierLineCount = Math.max(
    ...footerItems.map((item) => item.qualifiers.length),
  );
  const sourceWarning = incompleteSourceWarning(snapshot);
  const headerOffset = sourceWarning ? 24 : 0;
  const headerTitle = "TOKEN LEDGER · CACHE REPORT";
  const history = historyScopeLabel(snapshot);
  const headerMetadata = [periodLabel(bounds), bounds.timeZone, history]
    .filter(Boolean)
    .join(" · ");
  const headerTitleWidth = textWidth(headerTitle, 27, 800) -
    0.27 * (headerTitle.length - 1);
  const headerMetadataFits = headerTitleWidth + textWidth(headerMetadata, 14) + 24 <=
    contentRight - outer;
  const renderedHeaderMetadata = textWidth(headerMetadata, 14) <= contentRight - outer
    ? headerMetadata
    : truncateText(headerMetadata, contentRight - outer, 14);
  const ratePlotTop = 320 + headerOffset;
  const ratePlotHeight = 270;
  const ratePlotBottom = ratePlotTop + ratePlotHeight;
  const volumeTop = 635 + headerOffset;
  const volumeHeight = 55;
  const volumeBottom = volumeTop + volumeHeight;
  const legendBaseline = 770 + headerOffset;
  const modelRuleY = 800 + headerOffset;
  const modelHeaderBaseline = 830 + headerOffset;
  const modelRowsTop = 858 + headerOffset;
  const modelRowHeight = 44;
  const modelRowCount = Math.max(1, models.length);
  const footerRuleY = modelRowsTop + modelRowCount * modelRowHeight + 28;
  const height = footerRuleY + 118 + Math.max(0, qualifierLineCount - 2) * 16;
  return {
    snapshot,
    bounds,
    days,
    width,
    outer,
    contentRight,
    plotLeft,
    plotRight,
    plotWidth,
    data,
    prior,
    models,
    columnWidth,
    footerItems,
    qualifierLineCount,
    headerTitle,
    headerMetadata: renderedHeaderMetadata,
    headerMetadataFits,
    sourceWarning,
    headerOffset,
    sourceStatus,
    ratePlotTop,
    ratePlotHeight,
    ratePlotBottom,
    volumeTop,
    volumeHeight,
    volumeBottom,
    legendBaseline,
    modelRuleY,
    modelHeaderBaseline,
    modelRowsTop,
    modelRowHeight,
    footerRuleY,
    height,
  };
}

export function buildCacheHeaderSection(context) {
  const {
    days,
    data,
    prior,
    width,
    height,
    outer,
    contentRight,
    headerTitle,
    headerMetadata,
    headerMetadataFits,
    sourceWarning = null,
    headerOffset = 0,
    sourceStatus,
  } = context;
  const elements = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="cache-title cache-description">`,
    `<title id="cache-title">${escapeXml(`Token Ledger · ${days}-day cache report`)}</title>`,
    `<desc id="cache-description">${escapeXml("Dark cache report with a weighted cached-versus-uncached input split, normalized cache-rate columns with input-volume context, and a secondary model-level cache-rate breakout.")}</desc>`,
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
    svgText({
      x: contentRight,
      y: 97,
      value: sourceStatusLine(sourceStatus),
      fill: sourceStatus === "verified-current" ? COLORS.secondary : COLORS.weighted,
      size: 12,
      weight: 700,
      anchor: "end",
      spacing: ".72",
    }),
  ];
  if (sourceWarning) {
    elements.push(svgText({
      x: outer,
      y: 116,
      value: sourceWarning,
      fill: COLORS.weighted,
      size: 12,
      weight: 700,
      spacing: ".72",
    }));
  }
  const summaryValue = Number.isFinite(data.rate)
    ? `${percent(data.rate)} cached`
    : "No measured input";
  elements.push(svgText({
    x: outer,
    y: 135 + headerOffset,
    value: summaryValue,
    size: 29,
    weight: 800,
    spacing: "-0.58",
  }));
  elements.push(svgText({
    x: contentRight,
    y: 133 + headerOffset,
    value: periodComparison(data.rate, prior.rate),
    fill: COLORS.secondary,
    size: 14,
    weight: 600,
    anchor: "end",
  }));
  const railTop = 153 + headerOffset;
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
    y: 230 + headerOffset,
    value: Number.isFinite(data.rate)
      ? `${compact(data.cachedInputTokens)} cached · ${compact(data.uncachedInputTokens)} uncached · ${compact(data.inputTokens)} total input`
      : "No events with a usable input-token breakdown in this range",
    fill: COLORS.secondary,
    size: 14,
  }));
  elements.push(svgText({
    x: contentRight,
    y: 230 + headerOffset,
    value: `${data.inputEventCount.toLocaleString("en-US")} measured input-bearing ${data.inputEventCount === 1 ? "call" : "calls"}`,
    fill: COLORS.muted,
    size: 13,
    anchor: "end",
  }));
  elements.push(svgText({
    x: outer,
    y: 283 + headerOffset,
    value: "CACHE RATE BY PERIOD",
    fill: COLORS.muted,
    size: 12,
    spacing: "1.32",
  }));
  elements.push(svgText({
    x: contentRight,
    y: 283 + headerOffset,
    value: "Rate bars are normalized to 100% · input volume below",
    fill: COLORS.muted,
    size: 12.5,
    anchor: "end",
  }));
  return elements;
}

export function buildCacheRateSection(context) {
  const {
    data,
    outer,
    plotLeft,
    plotRight,
    ratePlotTop,
    ratePlotHeight,
    ratePlotBottom,
    plotWidth,
    volumeTop,
    volumeHeight,
    volumeBottom,
    legendBaseline,
    headerOffset = 0,
  } = context;
  const elements = [];
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
          y: 718 + headerOffset,
          value: weekdayLabel(bin.startDateString),
          fill: COLORS.muted,
          size: 11.5,
          anchor: "middle",
          spacing: "1.15",
        }));
      }
      elements.push(svgText({
        x: centerX,
        y: (daily ? 739 : 730) + headerOffset,
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
  return elements;
}

export function buildCacheModelSection(context) {
  const {
    data,
    models,
    width,
    outer,
    contentRight,
    modelRuleY,
    modelHeaderBaseline,
    modelRowsTop,
    modelRowHeight,
  } = context;
  const elements = [
    `<line x1="${outer}" y1="${modelRuleY}" x2="${contentRight}" y2="${modelRuleY}" stroke="${COLORS.rule}" stroke-width="1"/>`,
    svgText({
      x: outer,
      y: modelHeaderBaseline,
      value: "MODEL",
      fill: COLORS.muted,
      size: 11,
      spacing: "1.1",
    }),
  ];
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
  return elements;
}

export function buildCacheFooterSection(context) {
  const {
    outer,
    contentRight,
    footerRuleY,
    columnWidth,
    qualifierLineCount,
    footerItems,
  } = context;
  const elements = [
    `<line x1="${outer}" y1="${footerRuleY}" x2="${contentRight}" y2="${footerRuleY}" stroke="${COLORS.rule}" stroke-width="1"/>`,
  ];
  const footerTop = footerRuleY + 22;
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
  return elements;
}

export function renderCacheReportSections({
  snapshot,
  bounds,
  days = bounds.rangeDays ?? 7,
  options = {},
  analysis = null,
  sourceStatus = "unchecked-cache",
}) {
  const context = createCacheReportContext({
    snapshot,
    bounds,
    days,
    options,
    analysis,
    sourceStatus,
  });
  return [
    ...buildCacheHeaderSection(context),
    ...buildCacheRateSection(context),
    ...buildCacheModelSection(context),
    ...buildCacheFooterSection(context),
    "</svg>",
  ].join("\n");
}
