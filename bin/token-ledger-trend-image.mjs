import { Buffer } from "node:buffer";

import sharp from "sharp";

import { buildBurnDayBins, buildUsageTrend } from "./token-ledger-trend.mjs";
import { creditsForUsage } from "./token-ledger-rates.mjs";
import { buildActualTokenBins } from "./token-ledger-trend-terminal.mjs";

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
  "Unattributed",
];

// Dark-surface categorical palette; the co-occurring set and the stack-order
// adjacency both pass CVD, normal-vision, and contrast checks on #0e1420.
export const TREND_IMAGE_MODEL_COLORS = {
  Luna: "#3b82f6",
  Sol: "#10a394",
  Terra: "#8b7cf6",
  "GPT-5.5": "#d55181",
  "GPT-5.4": "#0891b2",
  Daybreak: "#16a34a",
  "Auto review": "#e5484d",
  Other: "#64748b",
  Unknown: "#64748b",
  Unattributed: "#475569",
};

const COLORS = {
  background: "#0e1420",
  panel: "#151d2c",
  panelBorder: "#273246",
  ink: "#f2f5fa",
  secondary: "#aeb8c9",
  muted: "#77839a",
  grid: "#1c2534",
  baseline: "#33405a",
  line: "#f6b73c",
  chipFill: "#151d2c",
  leftAxis: "#7ea2f0",
};

const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const FAST_MODE_LABEL_COLOR = "#a78bfa";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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
  return `${Number(value).toFixed(value >= 10 ? 1 : 2)}%`;
}

function niceCeiling(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
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

function styleForModel(model) {
  return TREND_IMAGE_MODEL_COLORS[model] ?? TREND_IMAGE_MODEL_COLORS.Other;
}

// Darker step of the same hue, used for the fast-mode share of a segment.
export function fastShade(hexColor) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hexColor));
  if (!match) return hexColor;
  const channels = [0, 2, 4].map((offset) =>
    Math.round(parseInt(match[1].slice(offset, offset + 2), 16) * 0.62),
  );
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function sortedModelEntries(values) {
  return [...values.entries()]
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => modelSort(left, right));
}

function eventRateCardCredits(event) {
  const computed = creditsForUsage(event.model, event);
  if (Number.isFinite(computed) && computed >= 0) {
    return event.serviceTier === "priority" ? computed * 1.5 : computed;
  }
  const stored = Number(event.rateCardCredits);
  if (
    event.rateCardCredits !== null &&
    event.rateCardCredits !== undefined &&
    Number.isFinite(stored) &&
    stored >= 0
  ) {
    return stored;
  }
  return null;
}

function rateCardSummary(snapshot, bounds) {
  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();
  let totalTokens = 0;
  let ratedTokens = 0;
  let credits = 0;
  for (const event of snapshot.events ?? []) {
    const timestampMs = new Date(event.timestamp).getTime();
    if (!Number.isFinite(timestampMs) || timestampMs < startMs || timestampMs >= endMs) {
      continue;
    }
    const tokens = Math.max(0, Number(event.totalTokens) || 0);
    totalTokens += tokens;
    const eventCredits = eventRateCardCredits(event);
    if (Number.isFinite(eventCredits) && eventCredits >= 0) {
      ratedTokens += tokens;
      credits += eventCredits;
    }
  }
  return {
    totalTokens,
    ratedTokens,
    credits,
    coveragePercent: totalTokens > 0 ? (ratedTokens / totalTokens) * 100 : 0,
  };
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

function timeZoneOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(instant);
  const value = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  if (value === "GMT") return 0;
  const match = value.match(/^GMT([+-])(\d{2}):?(\d{2})?$/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return (match[1] === "+" ? 1 : -1) * minutes * 60 * 1_000;
}

function zonedMidnight(dateString, timeZone) {
  const [year, month, day] = dateParts(dateString);
  const utcGuess = Date.UTC(year, month - 1, day);
  const first = new Date(utcGuess - timeZoneOffsetMs(new Date(utcGuess), timeZone));
  return new Date(first.getTime() - timeZoneOffsetMs(first, timeZone));
}

function localDateLabel(dateString, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(zonedMidnight(dateString, timeZone));
}

function localWeekdayLabel(dateString, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(zonedMidnight(dateString, timeZone));
}

function localDateTimeLabel(timestampMs, timeZone) {
  if (!Number.isFinite(timestampMs)) return "unknown time";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestampMs));
}

function binDateLabel(bin, timeZone) {
  const start = localDateLabel(bin.startDateString, timeZone);
  const lastDate = shiftCalendarDate(bin.endDateString, -1);
  if (lastDate === bin.startDateString) return start;
  return `${start}–${localDateLabel(lastDate, timeZone).replace(/^[A-Za-z]+ /, "")}`;
}

function svgText({
  x,
  y,
  value,
  fill = COLORS.ink,
  size = 12,
  weight = 400,
  anchor = "start",
  spacing = null,
  opacity = null,
}) {
  const spacingAttr = spacing ? ` letter-spacing="${spacing}"` : "";
  const opacityAttr = opacity !== null ? ` opacity="${opacity}"` : "";
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${FONT_FAMILY}" font-size="${size}px" font-weight="${weight}" text-anchor="${anchor}"${spacingAttr}${opacityAttr}>${escapeXml(value)}</text>`;
}

// Approximate text fitting for card and footer copy: shrink a little, then
// ellipsize, so text never crosses its container border.
function fitLine(text, size, maxWidth, minSize = 10) {
  const widthOf = (value, fontSize) => value.length * fontSize * 0.62;
  let fitted = size;
  while (widthOf(text, fitted) > maxWidth && fitted > minSize) fitted -= 0.5;
  if (widthOf(text, fitted) <= maxWidth) return { text, size: fitted };
  const capacity = Math.max(1, Math.floor(maxWidth / (fitted * 0.62)) - 1);
  return { text: `${text.slice(0, capacity)}…`, size: fitted };
}

function linePath(points) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
}

function roundedTopRect(x, y, width, height, radius, fill) {
  const r = Math.min(radius, width / 2, height);
  return `<path d="M${x.toFixed(2)},${(y + height).toFixed(2)} L${x.toFixed(2)},${(y + r).toFixed(2)} Q${x.toFixed(2)},${y.toFixed(2)} ${(x + r).toFixed(2)},${y.toFixed(2)} L${(x + width - r).toFixed(2)},${y.toFixed(2)} Q${(x + width).toFixed(2)},${y.toFixed(2)} ${(x + width).toFixed(2)},${(y + r).toFixed(2)} L${(x + width).toFixed(2)},${(y + height).toFixed(2)} Z" fill="${fill}"/>`;
}

function xPosition(timestampMs, bounds, plotLeft, plotWidth) {
  const span = bounds.end.getTime() - bounds.start.getTime();
  const ratio = span > 0
    ? (timestampMs - bounds.start.getTime()) / span
    : 0;
  return plotLeft + Math.max(0, Math.min(1, ratio)) * plotWidth;
}

function buildQuotaLine(trend, bounds, plotLeft, plotWidth, chartTop, chartHeight) {
  const points = (trend.points ?? [])
    .filter((point) => point.timestampMs >= bounds.start.getTime() && point.timestampMs <= bounds.end.getTime())
    .sort((left, right) => left.timestampMs - right.timestampMs);
  if (!points.length) return { points: [], resetPoints: [], yForRemaining: null };

  const resetPoints = [];
  const linePoints = [];
  const resets = [...(trend.resets ?? [])].sort((left, right) => left.timestampMs - right.timestampMs);
  let resetIndex = 0;

  const yForRemaining = (value) =>
    chartTop + chartHeight - (Math.max(0, Math.min(100, value)) / 100) * chartHeight;
  for (const point of points) {
    while (resetIndex < resets.length && resets[resetIndex].timestampMs <= point.timestampMs) {
      const reset = resets[resetIndex];
      if (reset.timestampMs >= bounds.start.getTime() && linePoints.length) {
        const x = xPosition(reset.timestampMs, bounds, plotLeft, plotWidth);
        const previous = linePoints.at(-1);
        linePoints.push({ x, y: previous.y });
        linePoints.push({ x, y: yForRemaining(100), reset: true });
        resetPoints.push({ x, timestampMs: reset.timestampMs, kind: reset.kind });
      }
      resetIndex += 1;
    }
    linePoints.push({
      x: xPosition(point.timestampMs, bounds, plotLeft, plotWidth),
      y: yForRemaining(point.remainingPercent),
      timestampMs: point.timestampMs,
      remainingPercent: point.remainingPercent,
    });
  }
  return { points: linePoints, resetPoints, yForRemaining };
}

function labelEvery(binCount) {
  if (binCount <= 14) return 1;
  if (binCount <= 20) return 2;
  return 3;
}

function chip(x, y, value, { anchor = "middle", small = false } = {}) {
  const textSize = small ? 10.5 : 12;
  const paddingX = small ? 7 : 9;
  const chipHeight = small ? 19 : 23;
  const chipWidth = String(value).length * (textSize * 0.62) + paddingX * 2;
  const left = anchor === "middle" ? x - chipWidth / 2 : anchor === "end" ? x - chipWidth : x;
  return [
    `<rect x="${left.toFixed(2)}" y="${(y - chipHeight / 2).toFixed(2)}" width="${chipWidth.toFixed(2)}" height="${chipHeight}" rx="6" fill="${COLORS.chipFill}" stroke="${COLORS.line}" stroke-width="1.25"/>`,
    svgText({
      x: left + chipWidth / 2,
      y: y + textSize * 0.36,
      value,
      fill: COLORS.line,
      size: textSize,
      weight: 650,
      anchor: "middle",
    }),
  ].join("\n");
}

function priorRangeTotals(snapshot, bounds, days) {
  const startMs = zonedMidnight(
    shiftCalendarDate(bounds.startDateString, -days),
    bounds.timeZone,
  ).getTime();
  const endMs = bounds.start.getTime();
  const totals = new Map();
  for (const event of snapshot.events ?? []) {
    const timestampMs = new Date(event.timestamp).getTime();
    if (!Number.isFinite(timestampMs) || timestampMs < startMs || timestampMs >= endMs) {
      continue;
    }
    const tokens = Math.max(0, Number(event.totalTokens) || 0);
    if (!(tokens > 0)) continue;
    const model = (() => {
      const value = String(event.model || "unknown").trim().toLowerCase();
      for (const label of MODEL_ORDER) {
        if (label === "Other" || label === "Unknown" || label === "Unattributed") continue;
      }
      return value;
    })();
    void model;
    totals.set(event.model, tokens);
  }
  return { startMs, endMs };
}

export function renderTrendImage({
  snapshot,
  bounds,
  trend = buildUsageTrend(snapshot, bounds),
  days = bounds.rangeDays ?? 7,
  options = {},
}) {
  const width = Math.max(900, Math.min(2_400, Number(options.imageWidth) || 1_280));
  const outer = 32;
  const margin = { left: 84, right: 96 };
  const plotLeft = margin.left;
  const plotWidth = width - margin.left - margin.right;

  const actual = buildActualTokenBins(snapshot, bounds, days, plotWidth);
  const burn = buildBurnDayBins(trend, bounds, { days, binSize: actual.binSize });
  const meterUsable = Boolean(trend.available && burn.totalPercent > 0);
  const percentMode = Boolean(options.drain) && meterUsable;
  const bars = percentMode ? burn.bins : actual.bins;
  const binCount = actual.binCount;
  const binTotalOf = (bin) => (percentMode ? bin.totalPercent : bin.totalTokens);
  const maxBar = niceCeiling(
    bars.reduce((maximum, bin) => Math.max(maximum, binTotalOf(bin)), 0),
  );
  const hasLine = Boolean(trend.available && (trend.points ?? []).length > 1);

  // Range totals for the stat cards.
  const totalTokens = [...actual.totals.values()].reduce((sum, value) => sum + value, 0);
  const modelCards = [...actual.totals.entries()]
    .filter(([, value]) => value > 0 && totalTokens > 0 && value / totalTokens >= 0.01)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([model, value]) => ({ model, tokens: value }));
  const fastTokens = [...(actual.fastTotals?.values() ?? [])].reduce((sum, value) => sum + value, 0);
  const hasFast = !percentMode && fastTokens > 0;

  // Prior-period per-model totals for the delta line.
  const prior = priorRangeTotals(snapshot, bounds, days);
  const priorTotals = new Map();
  for (const event of snapshot.events ?? []) {
    const timestampMs = new Date(event.timestamp).getTime();
    if (!Number.isFinite(timestampMs) || timestampMs < prior.startMs || timestampMs >= prior.endMs) {
      continue;
    }
    const tokens = Math.max(0, Number(event.totalTokens) || 0);
    if (!(tokens > 0)) continue;
    const label = MODEL_ORDER.find((candidate) =>
      String(event.model || "").toLowerCase().includes(candidate.toLowerCase().split(" ")[0]),
    );
    void label;
  }
  // Reuse the bin labeler for prior-period totals so model naming matches.
  const priorBounds = {
    ...bounds,
    startDateString: shiftCalendarDate(bounds.startDateString, -days),
    endDateString: shiftCalendarDate(bounds.endDateString, -days),
    start: new Date(prior.startMs),
    end: new Date(prior.endMs),
  };
  const priorActual = buildActualTokenBins(snapshot, priorBounds, days, plotWidth);
  for (const [model, value] of priorActual.totals) priorTotals.set(model, value);

  const latestQuotaPoint = [...(trend.points ?? [])]
    .filter((point) => point.timestampMs <= bounds.end.getTime())
    .at(-1);
  const rateCard = rateCardSummary(snapshot, bounds);
  const expiries = (trend.resets ?? []).filter((reset) => reset.kind === "weekly-expiry").length;
  const restarts = (trend.resets ?? []).filter((reset) => reset.kind !== "weekly-expiry").length;

  // ---- Layout ----
  const headerTop = 48;
  const cardTop = 100;
  const cardHeight = 100;
  const chartTop = cardTop + cardHeight + 64;
  const chartHeight = 470;
  const chartBottom = chartTop + chartHeight;
  const xLabelBand = 58;
  const legendY = chartBottom + xLabelBand + 26;
  const footerTop = legendY + 26;
  const footerHeight = 96;
  const height = footerTop + footerHeight + outer;

  const title = `TOKEN LEDGER · ${days}-DAY TREND`;
  const yearLabel = bounds.endDateString.slice(0, 4);
  const subtitle = `${localDateLabel(bounds.startDateString, bounds.timeZone)} – ${localDateLabel(bounds.endDateString, bounds.timeZone)}, ${yearLabel} · ${bounds.timeZone}${latestQuotaPoint ? ` · Latest remaining: ${percent(latestQuotaPoint.remainingPercent)}` : ""}`;
  const description = percentMode
    ? "Dark dashboard: stat cards for each model, then stacked columns of the observed weekly-limit percentage consumed per day split by model via rate-card credit weights, overlaid with the observed weekly meter remaining as an amber line with value chips."
    : "Dark dashboard: stat cards for each model, then stacked columns of local token volume per day by model with per-segment token and share labels, overlaid with the observed weekly meter remaining as an amber line with value chips. Darker shades within a segment are fast-mode usage.";

  const elements = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="trend-title trend-description">`,
    `<title id="trend-title">${escapeXml(`Token Ledger · ${days}-day trend`)}</title>`,
    `<desc id="trend-description">${escapeXml(description)}</desc>`,
    `<rect width="100%" height="100%" fill="${COLORS.background}"/>`,
    svgText({ x: outer, y: headerTop, value: title, size: 26, weight: 750, spacing: "0.02em" }),
    svgText({ x: outer, y: headerTop + 26, value: subtitle, fill: COLORS.secondary, size: 13 }),
  ];

  // ---- Stat cards ----
  const card = (x, cardWidth, body) => {
    elements.push(`<rect x="${x.toFixed(2)}" y="${cardTop}" width="${cardWidth.toFixed(2)}" height="${cardHeight}" rx="10" fill="${COLORS.panel}" stroke="${COLORS.panelBorder}" stroke-width="1"/>`);
    body(x + 16, cardTop);
  };
  const deltaLine = (model, tokens) => {
    const priorValue = priorTotals.get(model) ?? 0;
    if (priorValue < 1_000_000) return `no prior ${days}d baseline`;
    const ratio = tokens / priorValue;
    if (ratio >= 5) return `${ratio.toFixed(1)}× vs prior ${days}d`;
    const delta = (ratio - 1) * 100;
    const signed = `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}%`;
    return `${signed} vs prior ${days}d`;
  };
  const cardGap = 12;
  const cardCount = modelCards.length + (hasFast ? 1 : 0) + (hasLine ? 1 : 0);
  const keyCardScale = 1.45;
  const unitWidth = (width - outer * 2 - cardGap * cardCount) / (cardCount + keyCardScale);
  let cardX = outer;
  for (const { model, tokens } of modelCards) {
    card(cardX, unitWidth, (x, y) => {
      elements.push(`<circle cx="${x + 6}" cy="${y + 25}" r="6" fill="${styleForModel(model)}"/>`);
      elements.push(svgText({ x: x + 20, y: y + 30, value: model, fill: COLORS.ink, size: 14, weight: 650 }));
      elements.push(svgText({ x, y: y + 58, value: compact(tokens), fill: COLORS.ink, size: 20, weight: 700 }));
      elements.push(svgText({
        x: x + unitWidth - 32,
        y: y + 58,
        value: totalTokens > 0 ? percent((tokens / totalTokens) * 100) : "—",
        fill: COLORS.secondary,
        size: 14,
        weight: 600,
        anchor: "end",
      }));
      const delta = fitLine(deltaLine(model, tokens), 11.5, unitWidth - 32);
      elements.push(svgText({ x, y: y + 82, value: delta.text, fill: COLORS.muted, size: delta.size }));
    });
    cardX += unitWidth + cardGap;
  }
  if (hasFast) {
    card(cardX, unitWidth, (x, y) => {
      elements.push(`<circle cx="${x + 6}" cy="${y + 25}" r="6" fill="${FAST_MODE_LABEL_COLOR}"/>`);
      elements.push(svgText({ x: x + 20, y: y + 30, value: "Fast Mode", fill: COLORS.ink, size: 14, weight: 650 }));
      elements.push(svgText({ x, y: y + 58, value: "1.50× rate", fill: COLORS.ink, size: 20, weight: 700 }));
      const fastSub = fitLine(
        `${percent((fastTokens / Math.max(1, totalTokens)) * 100)} of tokens`,
        11.5,
        unitWidth - 32,
      );
      elements.push(svgText({
        x,
        y: y + 82,
        value: fastSub.text,
        fill: COLORS.muted,
        size: fastSub.size,
      }));
    });
    cardX += unitWidth + cardGap;
  }
  if (hasLine) {
    card(cardX, unitWidth, (x, y) => {
      elements.push(`<circle cx="${x + 6}" cy="${y + 25}" r="6" fill="${COLORS.line}"/>`);
      elements.push(svgText({ x: x + 20, y: y + 30, value: "Weekly Meter", fill: COLORS.ink, size: 14, weight: 650 }));
      elements.push(svgText({
        x,
        y: y + 58,
        value: latestQuotaPoint ? percent(latestQuotaPoint.remainingPercent) : "—",
        fill: COLORS.ink,
        size: 20,
        weight: 700,
      }));
      const meterSub = fitLine(
        latestQuotaPoint
          ? `remaining · ${localDateLabel(bounds.endDateString, bounds.timeZone)}`
          : "no observations",
        11.5,
        unitWidth - 32,
      );
      elements.push(svgText({
        x,
        y: y + 82,
        value: meterSub.text,
        fill: COLORS.muted,
        size: meterSub.size,
      }));
    });
    cardX += unitWidth + cardGap;
  }
  const keyCardWidth = unitWidth * keyCardScale;
  card(cardX, keyCardWidth, (x, y) => {
    // Mini stacked-bar glyph.
    elements.push(`<rect x="${x}" y="${y + 24}" width="5" height="10" rx="1" fill="${styleForModel("Luna")}"/>`);
    elements.push(`<rect x="${x}" y="${y + 17}" width="5" height="6" rx="1" fill="${styleForModel("Sol")}"/>`);
    elements.push(`<rect x="${x + 7}" y="${y + 20}" width="5" height="14" rx="1" fill="${styleForModel("Luna")}"/>`);
    const keyLineOne = fitLine(
      percentMode
        ? "Bars = observed limit drain"
        : "Bars = actual token volume",
      12,
      keyCardWidth - 54,
    );
    elements.push(svgText({
      x: x + 22,
      y: y + 30,
      value: keyLineOne.text,
      fill: COLORS.secondary,
      size: keyLineOne.size,
    }));
    elements.push(`<line x1="${x}" y1="${y + 56}" x2="${x + 12}" y2="${y + 56}" stroke="${COLORS.line}" stroke-width="2.5" stroke-linecap="round"/>`);
    elements.push(`<circle cx="${x + 6}" cy="${y + 56}" r="2.5" fill="${COLORS.line}"/>`);
    const keyLineTwo = fitLine(
      "Line = weekly meter remaining (%)",
      12,
      keyCardWidth - 54,
    );
    elements.push(svgText({
      x: x + 22,
      y: y + 60,
      value: keyLineTwo.text,
      fill: COLORS.secondary,
      size: keyLineTwo.size,
    }));
    const keyLineThree = fitLine(
      "Darker segment shade = fast mode",
      11,
      keyCardWidth - 54,
    );
    elements.push(svgText({
      x: x + 22,
      y: y + 82,
      value: keyLineThree.text,
      fill: COLORS.muted,
      size: keyLineThree.size,
    }));
  });

  // ---- Chart grid + axes ----
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const y = chartBottom - fraction * chartHeight;
    elements.push(`<line x1="${plotLeft}" y1="${y.toFixed(2)}" x2="${plotLeft + plotWidth}" y2="${y.toFixed(2)}" stroke="${fraction === 0 ? COLORS.baseline : COLORS.grid}" stroke-width="1"/>`);
    elements.push(svgText({
      x: plotLeft - 12,
      y: y + 4,
      value: percentMode
        ? `${Number((maxBar * fraction).toFixed(1))}%`
        : compact(maxBar * fraction),
      fill: COLORS.secondary,
      size: 12,
      anchor: "end",
    }));
    if (hasLine) {
      elements.push(svgText({
        x: plotLeft + plotWidth + 14,
        y: y + 4,
        value: `${Math.round(fraction * 100)}%`,
        fill: COLORS.line,
        size: 12,
        weight: 600,
      }));
    }
  }
  elements.push(svgText({
    x: 26,
    y: chartTop + chartHeight / 2,
    value: percentMode ? "OBSERVED LIMIT DRAIN" : "ACTUAL TOKEN VOLUME",
    fill: COLORS.leftAxis,
    size: 12,
    weight: 650,
    anchor: "middle",
    spacing: "0.1em",
  }).replace("<text ", `<text transform="rotate(-90 26 ${chartTop + chartHeight / 2})" `));
  if (hasLine) {
    elements.push(svgText({
      x: width - 24,
      y: chartTop + chartHeight / 2,
      value: "WEEKLY METER REMAINING (%)",
      fill: COLORS.line,
      size: 12,
      weight: 650,
      anchor: "middle",
      spacing: "0.1em",
    }).replace("<text ", `<text transform="rotate(90 ${width - 24} ${chartTop + chartHeight / 2})" `));
  }

  // ---- Bars ----
  const slotWidth = plotWidth / binCount;
  const barWidth = Math.min(104, Math.max(26, slotWidth * 0.62));
  const segmentGap = 2;

  for (const [binIndex, bin] of bars.entries()) {
    const x = plotLeft + binIndex * slotWidth + (slotWidth - barWidth) / 2;
    const binTotal = binTotalOf(bin);
    const entries = sortedModelEntries(bin.values);
    let cumulative = 0;
    for (const [entryIndex, [model, value]] of entries.entries()) {
      const isTop = entryIndex === entries.length - 1;
      const fullHeight = (value / maxBar) * chartHeight;
      const gap = entryIndex === 0 ? 0 : segmentGap;
      const segmentHeight = Math.max(0, fullHeight - gap);
      const y = chartBottom - cumulative - fullHeight;
      const baseColor = styleForModel(model);
      if (segmentHeight > 0.4) {
        if (isTop) {
          elements.push(roundedTopRect(x, y, barWidth, segmentHeight, 5, baseColor));
        } else {
          elements.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${segmentHeight.toFixed(2)}" fill="${baseColor}"/>`);
        }
        const fastValue = percentMode ? 0 : (bin.fastValues?.get(model) ?? 0);
        const fastHeight = fastValue > 0 && value > 0
          ? segmentHeight * Math.min(1, fastValue / value)
          : 0;
        if (fastHeight > 0.5) {
          if (isTop) {
            elements.push(roundedTopRect(x, y, barWidth, fastHeight, 5, fastShade(baseColor)));
          } else {
            elements.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${fastHeight.toFixed(2)}" fill="${fastShade(baseColor)}"/>`);
          }
        }
        // Per-segment labels: model name first, then value and share of the
        // column — each line only when it fits the segment.
        const share = binTotal > 0 ? (value / binTotal) * 100 : 0;
        const valueLabel = percentMode ? percent(value) : compact(value);
        const fits = (text, size) => text.length * size * 0.6 <= barWidth - 8;
        const candidates = [
          { value: model, size: 12, weight: 650, opacity: null },
          { value: valueLabel, size: 11.5, weight: 600, opacity: null },
          { value: `(${percent(share)})`, size: 10, weight: 400, opacity: 0.75 },
        ].filter((line) => fits(line.value, line.size));
        const lineHeight = 15;
        const maxLines = Math.min(
          candidates.length,
          Math.floor((segmentHeight - 6) / lineHeight),
        );
        if (maxLines > 0) {
          const lines = candidates.slice(0, maxLines);
          const blockTop = y + segmentHeight / 2 - ((lines.length - 1) * lineHeight) / 2;
          for (const [lineIndex, line] of lines.entries()) {
            elements.push(svgText({
              x: x + barWidth / 2,
              y: blockTop + lineIndex * lineHeight + 4,
              value: line.value,
              fill: "#ffffff",
              size: line.size,
              weight: line.weight,
              anchor: "middle",
              opacity: line.opacity,
            }));
          }
        }
      }
      cumulative += fullHeight;
    }
    if (binTotal > 0) {
      elements.push(svgText({
        x: x + barWidth / 2,
        y: chartBottom - (binTotal / maxBar) * chartHeight - 10,
        value: percentMode
          ? `${bin.approximate ? "≈" : ""}${percent(binTotal)}`
          : compact(binTotal),
        fill: COLORS.ink,
        size: 14.5,
        weight: 650,
        anchor: "middle",
      }));
    }

    if (binIndex % labelEvery(binCount) === 0 || binIndex === binCount - 1) {
      const weekday = actual.binSize === 1
        ? localWeekdayLabel(bin.startDateString, bounds.timeZone).toUpperCase()
        : "";
      if (weekday) {
        elements.push(svgText({
          x: x + barWidth / 2,
          y: chartBottom + 24,
          value: weekday,
          fill: COLORS.muted,
          size: 11,
          weight: 600,
          anchor: "middle",
        }));
      }
      elements.push(svgText({
        x: x + barWidth / 2,
        y: chartBottom + (weekday ? 42 : 30),
        value: binDateLabel(bin, bounds.timeZone),
        fill: COLORS.secondary,
        size: 12.5,
        anchor: "middle",
      }));
    }
  }

  // ---- Meter line, refill markers, chips ----
  const quota = hasLine
    ? buildQuotaLine(trend, bounds, plotLeft, plotWidth, chartTop, chartHeight)
    : { points: [], resetPoints: [] };
  if (hasLine && quota.points.length > 1) {
    for (const reset of quota.resetPoints) {
      elements.push(`<line x1="${reset.x.toFixed(2)}" y1="${chartTop}" x2="${reset.x.toFixed(2)}" y2="${chartBottom}" stroke="${COLORS.baseline}" stroke-width="1.25" stroke-dasharray="5 5"/>`);
    }
    elements.push(`<path d="${linePath(quota.points)}" fill="none" stroke="${COLORS.line}" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"/>`);

    // Chips: one meter reading per labeled column (the last observation in
    // that column), plus a refill chip at each restart or reset.
    const step = labelEvery(binCount);
    const observationPoints = quota.points.filter((point) => point.timestampMs);
    const chipPoints = [];
    for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
      if (binIndex % step !== 0 && binIndex !== binCount - 1) continue;
      const binEndMs = zonedMidnight(
        bars[binIndex].endDateString,
        bounds.timeZone,
      ).getTime();
      const candidates = observationPoints.filter((point) => point.timestampMs < binEndMs);
      const point = candidates.at(-1);
      if (point) chipPoints.push(point);
    }
    const lastPoint = observationPoints.at(-1);
    if (lastPoint) chipPoints.push(lastPoint);
    const seen = new Set();
    const barGeometry = (xValue) => {
      const binIndex = Math.max(0, Math.min(binCount - 1,
        Math.floor((xValue - plotLeft) / slotWidth)));
      const barLeft = plotLeft + binIndex * slotWidth + (slotWidth - barWidth) / 2;
      const total = binTotalOf(bars[binIndex]);
      const topY = chartBottom - (total / maxBar) * chartHeight;
      return { barLeft, barRight: barLeft + barWidth, topY, total };
    };
    for (const point of chipPoints) {
      const key = `${point.x.toFixed(0)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(`<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="4.5" fill="${COLORS.line}" stroke="${COLORS.background}" stroke-width="2"/>`);
      const geometry = barGeometry(point.x);
      const overBar = point.x >= geometry.barLeft - 8 && point.x <= geometry.barRight + 8;
      const insideBar = overBar && point.y > geometry.topY - 6 && geometry.total > 0;
      let chipX = point.x;
      let chipY = point.y - 24;
      let anchor = "middle";
      if (insideBar) {
        // Slide the chip into the slot gap beside the column.
        const rightX = geometry.barRight + 12;
        if (rightX + 64 <= plotLeft + plotWidth) {
          chipX = rightX;
          anchor = "start";
        } else {
          chipX = geometry.barLeft - 12;
          anchor = "end";
        }
        chipY = point.y;
      } else if (overBar && Math.abs(point.y - geometry.topY) < 60 && geometry.total > 0) {
        // Keep clear of the column-total label just above the cap.
        chipY = geometry.topY - 44;
      } else if (point.y < chartTop + 44) {
        chipY = point.y + 26;
      }
      elements.push(chip(chipX, chipY, percent(point.remainingPercent), { anchor }));
    }
    let previousRefillX = -Infinity;
    let refillLane = 0;
    for (const reset of quota.resetPoints) {
      const label = reset.kind === "weekly-expiry" ? "RESET 100%" : "RESTART 100%";
      // Stagger dense refill chips across two lanes so they stay legible.
      refillLane = reset.x - previousRefillX < 112 ? (refillLane + 1) % 2 : 0;
      previousRefillX = reset.x;
      elements.push(chip(reset.x, chartTop - 18 - refillLane * 24, label, { small: true }));
    }
  }

  // ---- Legend strip ----
  const legendModels = sortedModelEntries(
    percentMode ? burn.totals : actual.totals,
  ).map(([model]) => model);
  const legendParts = legendModels.map((model) => ({ swatch: styleForModel(model), label: model }));
  let legendX = plotLeft;
  for (const part of legendParts) {
    elements.push(`<rect x="${legendX}" y="${legendY - 11}" width="13" height="13" rx="3" fill="${part.swatch}"/>`);
    elements.push(svgText({ x: legendX + 20, y: legendY, value: part.label, fill: COLORS.secondary, size: 12.5 }));
    legendX += 20 + part.label.length * 7.4 + 28;
  }
  if (hasLine) {
    elements.push(`<line x1="${legendX}" y1="${legendY - 5}" x2="${legendX + 22}" y2="${legendY - 5}" stroke="${COLORS.line}" stroke-width="2.75" stroke-linecap="round"/>`);
    elements.push(`<circle cx="${legendX + 11}" cy="${legendY - 5}" r="3" fill="${COLORS.line}"/>`);
    elements.push(svgText({
      x: legendX + 30,
      y: legendY,
      value: "Observed weekly meter remaining (%)",
      fill: COLORS.secondary,
      size: 12.5,
    }));
  }

  // ---- Footer strip ----
  elements.push(`<rect x="${outer}" y="${footerTop}" width="${width - outer * 2}" height="${footerHeight}" rx="10" fill="${COLORS.panel}" stroke="${COLORS.panelBorder}" stroke-width="1"/>`);
  const generatedAtMs = new Date(snapshot.generatedAt).getTime();
  const meterTime = latestQuotaPoint
    ? localDateTimeLabel(latestQuotaPoint.timestampMs, bounds.timeZone)
    : "unknown";
  const snapshotTime = Number.isFinite(generatedAtMs)
    ? localDateTimeLabel(generatedAtMs, bounds.timeZone)
    : "unknown";
  const footerCells = [
    {
      icon: "bars",
      lines: percentMode
        ? ["Bars = observed meter drops", `${percent(burn.totalPercent)} drained in range`, "split by rate-card credit weights"]
        : meterUsable
          ? ["Bars show actual token volume", `meter dropped ${percent(burn.totalPercent)} in range`, "≈ = drop spread over meter gaps"]
          : ["Bars show actual token volume", "no usable meter drain in range", ""],
    },
    {
      icon: "card",
      lines: [
        "Rate-card estimate",
        `${compact(rateCard.credits)} credits${hasFast ? " · fast ×1.5" : ""} · card ${trend.rateCardAsOf}`,
        "estimate only · not the meter",
      ],
    },
    {
      icon: "clock",
      lines: [
        `${expiries} weekly expir${expiries === 1 ? "y" : "ies"}, ${restarts} restart${restarts === 1 ? "" : "s"}`,
        "restarts are provider-initiated",
        "windows keyed by reset time",
      ],
    },
    {
      icon: "calendar",
      lines: ["Meter snapshots", `latest ${meterTime}`, `snapshot ${snapshotTime}`],
    },
  ];
  const cellWidth = (width - outer * 2) / footerCells.length;
  const drawIcon = (kind, x, y) => {
    const stroke = COLORS.secondary;
    if (kind === "bars") {
      elements.push(`<rect x="${x}" y="${y + 8}" width="4" height="10" rx="1" fill="${stroke}"/>`);
      elements.push(`<rect x="${x + 6}" y="${y + 3}" width="4" height="15" rx="1" fill="${stroke}"/>`);
      elements.push(`<rect x="${x + 12}" y="${y + 11}" width="4" height="7" rx="1" fill="${stroke}"/>`);
    } else if (kind === "card") {
      elements.push(`<rect x="${x}" y="${y + 3}" width="17" height="14" rx="2" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);
      elements.push(`<line x1="${x}" y1="${y + 8}" x2="${x + 17}" y2="${y + 8}" stroke="${stroke}" stroke-width="1.5"/>`);
    } else if (kind === "clock") {
      elements.push(`<circle cx="${x + 8}" cy="${y + 10}" r="7.5" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);
      elements.push(`<path d="M${x + 8},${y + 6} L${x + 8},${y + 10} L${x + 11},${y + 12}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round"/>`);
    } else {
      elements.push(`<rect x="${x}" y="${y + 4}" width="16" height="13" rx="2" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);
      elements.push(`<line x1="${x + 4}" y1="${y + 2}" x2="${x + 4}" y2="${y + 6}" stroke="${stroke}" stroke-width="1.5"/>`);
      elements.push(`<line x1="${x + 12}" y1="${y + 2}" x2="${x + 12}" y2="${y + 6}" stroke="${stroke}" stroke-width="1.5"/>`);
    }
  };
  for (const [cellIndex, cell] of footerCells.entries()) {
    const cellX = outer + cellIndex * cellWidth;
    if (cellIndex > 0) {
      elements.push(`<line x1="${cellX.toFixed(2)}" y1="${footerTop + 14}" x2="${cellX.toFixed(2)}" y2="${footerTop + footerHeight - 14}" stroke="${COLORS.panelBorder}" stroke-width="1"/>`);
    }
    drawIcon(cell.icon, cellX + 20, footerTop + 22);
    for (const [lineIndex, line] of cell.lines.entries()) {
      if (!line) continue;
      const fitted = fitLine(line, lineIndex === 0 ? 12.5 : 11.5, cellWidth - 52 - 18);
      elements.push(svgText({
        x: cellX + 52,
        y: footerTop + 32 + lineIndex * 20,
        value: fitted.text,
        fill: lineIndex === 0 ? COLORS.secondary : COLORS.muted,
        size: fitted.size,
        weight: lineIndex === 0 ? 600 : 400,
      }));
    }
  }

  elements.push("</svg>");
  return elements.join("\n");
}

export async function writeTrendPng(svg, outputPath) {
  await sharp(Buffer.from(svg, "utf8")).png().toFile(outputPath);
}
