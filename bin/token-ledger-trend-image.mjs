import { Buffer } from "node:buffer";

import sharp from "sharp";

import {
  buildBurnDayBins,
  buildUsageTrend,
  weeklyQuotaObservations,
} from "./token-ledger-trend.mjs";
import {
  creditsForUsage,
  FAST_MODE_MULTIPLIER,
} from "./token-ledger-rates.mjs";
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
  meterPanel: "#1b1712",
  meterPanelBorder: "rgba(246,183,60,.4)",
  ink: "#f2f5fa",
  secondary: "#aeb8c9",
  muted: "#77839a",
  grid: "#1c2534",
  baseline: "#33405a",
  rule: "rgba(255,255,255,.1)",
  track: "rgba(255,255,255,.09)",
  projectTrack: "rgba(255,255,255,.07)",
  line: "#f6b73c",
  meterAxis: "#cf9a37",
  chipFill: "#151d2c",
  leftAxis: "#7ea2f0",
  deltaUp: "#7fb37a",
  deltaUpFill: "rgba(127,179,122,.14)",
  deltaDown: "#e08a86",
  deltaDownFill: "rgba(217,83,79,.16)",
  remainderBar: "#475569",
  onFill: "rgba(255,255,255,.82)",
};

const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO_FAMILY = "ui-monospace, Menlo, monospace";
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
  for (const [divisor, suffix] of [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ]) {
    if (absolute >= divisor) {
      const scaled = value / divisor;
      const precision = scaled >= 100 ? 0 : scaled >= 10 ? 1 : digits;
      return `${scaled.toFixed(precision)}${suffix}`;
    }
  }
  return Math.round(value).toLocaleString("en-US");
}

function percent(value) {
  return `${Number(value).toFixed(value >= 10 ? 1 : 2)}%`;
}

function meterLabel(value) {
  return `${Number(value).toFixed(1)}%`;
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
  // Recompute from token components first so the current rate card applies;
  // snapshots can carry credits stored under an outdated card. Fast-mode
  // turns (service tier "priority") debit the limit at a higher rate.
  const computed = creditsForUsage(event.model, event);
  if (Number.isFinite(computed) && computed >= 0) {
    return event.serviceTier === "priority"
      ? computed * FAST_MODE_MULTIPLIER
      : computed;
  }
  // Stored credits from current snapshots already include the fast-mode
  // multiplier.
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
  let fastCredits = 0;
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
      if (event.serviceTier === "priority") fastCredits += eventCredits;
    }
  }
  return {
    totalTokens,
    ratedTokens,
    credits,
    fastCredits,
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

function shortDateTimeLabel(timestampMs, timeZone) {
  if (!Number.isFinite(timestampMs)) return "unknown time";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}

function timestampDateLabel(timestampMs, timeZone) {
  if (!Number.isFinite(timestampMs)) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(new Date(timestampMs));
}

function binDateLabel(bin, timeZone) {
  const start = localDateLabel(bin.startDateString, timeZone);
  const lastDate = shiftCalendarDate(bin.endDateString, -1);
  if (lastDate === bin.startDateString) return start;
  return `${start}–${localDateLabel(lastDate, timeZone).replace(/^[A-Za-z]+ /, "")}`;
}

// Rough sans-serif advance widths in em units, for placing inline runs
// (value + chip, legend items, pace rows). SVG has no flow layout.
function textWidth(text, size, weight = 400) {
  let units = 0;
  for (const character of String(text)) {
    if (/[il.,:;'|!]/.test(character)) units += 0.3;
    else if (/[Ijtfr\-()[\] ]/.test(character)) units += 0.37;
    else if (/[mwMW@%]/.test(character)) units += 0.92;
    else if (/[A-Z]/.test(character)) units += 0.7;
    else if (/[0-9+±×−]/.test(character)) units += 0.58;
    else units += 0.55;
  }
  return units * size * (weight >= 700 ? 1.05 : 1);
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
  mono = false,
}) {
  const spacingAttr = spacing ? ` letter-spacing="${spacing}"` : "";
  const opacityAttr = opacity !== null ? ` opacity="${opacity}"` : "";
  const family = mono ? MONO_FAMILY : FONT_FAMILY;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}px" font-weight="${weight}" text-anchor="${anchor}"${spacingAttr}${opacityAttr}>${escapeXml(value)}</text>`;
}

function svgRect(x, y, width, height, attrs = {}) {
  const pieces = [
    `x="${Number(x).toFixed(2)}"`,
    `y="${Number(y).toFixed(2)}"`,
    `width="${Math.max(0, Number(width)).toFixed(2)}"`,
    `height="${Math.max(0, Number(height)).toFixed(2)}"`,
  ];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    pieces.push(`${key}="${value}"`);
  }
  return `<rect ${pieces.join(" ")}/>`;
}

// Fritsch–Carlson monotone cubic through the points; keeps the meter line
// smooth without overshooting between observations.
function monotonePath(points) {
  const count = points.length;
  if (count < 2) return "";
  const round = (value) => Math.round(value * 100) / 100;
  const dx = [];
  const slope = [];
  for (let index = 0; index < count - 1; index += 1) {
    dx[index] = Math.max(0.01, points[index + 1].x - points[index].x);
    slope[index] = (points[index + 1].y - points[index].y) / dx[index];
  }
  const tangent = [slope[0]];
  for (let index = 1; index < count - 1; index += 1) {
    tangent.push(
      slope[index - 1] * slope[index] <= 0
        ? 0
        : (slope[index - 1] + slope[index]) / 2,
    );
  }
  tangent.push(slope[count - 2]);
  for (let index = 0; index < count - 1; index += 1) {
    if (slope[index] === 0) {
      tangent[index] = 0;
      tangent[index + 1] = 0;
      continue;
    }
    const alpha = tangent[index] / slope[index];
    const beta = tangent[index + 1] / slope[index];
    const magnitude = alpha * alpha + beta * beta;
    if (magnitude > 9) {
      const tau = 3 / Math.sqrt(magnitude);
      tangent[index] = tau * alpha * slope[index];
      tangent[index + 1] = tau * beta * slope[index];
    }
  }
  let path = `M ${round(points[0].x)} ${round(points[0].y)}`;
  for (let index = 0; index < count - 1; index += 1) {
    const h = dx[index];
    path += ` C ${round(points[index].x + h / 3)} ${round(points[index].y + (tangent[index] * h) / 3)}` +
      ` ${round(points[index + 1].x - h / 3)} ${round(points[index + 1].y - (tangent[index + 1] * h) / 3)}` +
      ` ${round(points[index + 1].x)} ${round(points[index + 1].y)}`;
  }
  return path;
}

function labelEvery(binCount) {
  if (binCount <= 14) return 1;
  if (binCount <= 20) return 2;
  return 3;
}

function fallbackProjectRows(snapshot, bounds) {
  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();
  const totals = new Map();
  for (const event of snapshot.events ?? []) {
    const timestampMs = new Date(event.timestamp).getTime();
    if (!Number.isFinite(timestampMs) || timestampMs < startMs || timestampMs >= endMs) {
      continue;
    }
    const tokens = Math.max(0, Number(event.totalTokens) || 0);
    if (!(tokens > 0)) continue;
    const project = String(event.project || "Unlabelled activity")
      .replace(/[\t\r\n]+/g, " ")
      .trim() || "Unlabelled activity";
    totals.set(project, (totals.get(project) ?? 0) + tokens);
  }
  return [...totals.entries()]
    .map(([project, totalTokens]) => ({
      project,
      displayProject: project,
      totalTokens,
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens);
}

export function renderTrendImage({
  snapshot,
  bounds,
  trend = buildUsageTrend(snapshot, bounds),
  days = bounds.rangeDays ?? 7,
  options = {},
  projectRows = null,
}) {
  const width = Math.max(900, Math.min(2_400, Number(options.imageWidth) || 1_280));
  const outer = 32;
  const plotLeft = 124;
  const plotRight = width - 126;
  const plotWidth = plotRight - plotLeft;
  const contentRight = width - outer;
  const contentWidth = width - outer * 2;

  // The image has no character-cell limit, so every window gets one bar per
  // calendar day instead of the terminal's multi-day bins.
  const actual = buildActualTokenBins(snapshot, bounds, days, plotWidth, { binSize: 1 });
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

  const totalTokens = [...actual.totals.values()].reduce((sum, value) => sum + value, 0);
  const fastTokens = [...(actual.fastTotals?.values() ?? [])].reduce(
    (sum, value) => sum + value,
    0,
  );
  const hasFast = !percentMode && fastTokens > 0;

  const modelCards = [...actual.totals.entries()]
    .filter(([, value]) => value > 0 && totalTokens > 0 && value / totalTokens >= 0.01)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([model, value]) => ({ model, tokens: value }));

  // Prior-period per-model totals feed the delta chips.
  const priorBounds = {
    ...bounds,
    startDateString: shiftCalendarDate(bounds.startDateString, -days),
    endDateString: shiftCalendarDate(bounds.endDateString, -days),
    start: zonedMidnight(
      shiftCalendarDate(bounds.startDateString, -days),
      bounds.timeZone,
    ),
    end: bounds.start,
  };
  const priorTotals = buildActualTokenBins(snapshot, priorBounds, days, plotWidth, { binSize: 1 }).totals;

  const latestQuotaPoint = [...(trend.points ?? [])]
    .filter((point) => point.timestampMs <= bounds.end.getTime())
    .at(-1);
  const rateCard = rateCardSummary(snapshot, bounds);
  const resetsInRange = trend.resets ?? [];
  const expiries = resetsInRange.filter((reset) => reset.kind === "weekly-expiry").length;
  const restarts = resetsInRange.filter(
    (reset) => reset.kind !== "weekly-expiry" && reset.kind !== "start",
  ).length;
  const weeklyObservationsAll = weeklyQuotaObservations(snapshot).filter(
    (observation) => observation.timestampMs < bounds.end.getTime(),
  );
  const latestResetsAtSec = weeklyObservationsAll.at(-1)?.resetsAt ?? null;

  const rows = projectRows ?? fallbackProjectRows(snapshot, bounds);

  // ---- Layout ----
  const headerBaseline = 53;
  const cardTop = 82;
  const cardHeight = 121;
  const chartBlockTop = cardTop + cardHeight + 18;
  const plotTop = chartBlockTop + 40;
  const plotHeight = 430;
  const plotBottom = plotTop + plotHeight;
  const chartBlockBottom = plotBottom + 70;
  const legendBaseline = chartBlockBottom + 25;
  const projectsRuleY = legendBaseline + 23;
  const projectsTop = projectsRuleY + 20;
  const projectRowCount = Math.min(4, rows.length > 3 ? 4 : rows.length);
  const paceLineCount = hasLine && meterUsable ? 3 : 1;
  const projectsBlockHeight = Math.max(
    29 + projectRowCount * 29,
    29 + paceLineCount * 34 + 44,
    178,
  );
  const footnotesRuleY = projectsTop + projectsBlockHeight + 34;
  const height = footnotesRuleY + 18 + 53 + 30;

  const yearLabel = bounds.endDateString.slice(0, 4);
  const title = `TOKEN LEDGER · ${days}-DAY TREND`;
  const subtitle = `${localDateLabel(bounds.startDateString, bounds.timeZone)} – ${localDateLabel(bounds.endDateString, bounds.timeZone)}, ${yearLabel} · ${bounds.timeZone}`;
  const description = percentMode
    ? "Dark report card: model stat cards with share micro-bars, stacked columns of the observed weekly-limit percentage consumed per column split by model via rate-card credit weights, the observed weekly meter remaining as a smoothed amber line with reset breaks and callout pills, top projects with pace and runway, and provenance footnotes."
    : "Dark report card: model stat cards with week-over-week delta chips and share micro-bars, stacked columns of local token volume by model with fast-mode usage in a darker shade, the observed weekly meter remaining as a smoothed amber line with reset breaks and callout pills, top projects with pace and runway, and provenance footnotes.";

  const elements = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="trend-title trend-description">`,
    `<title id="trend-title">${escapeXml(`Token Ledger · ${days}-day trend`)}</title>`,
    `<desc id="trend-description">${escapeXml(description)}</desc>`,
    `<rect width="100%" height="100%" fill="${COLORS.background}"/>`,
    svgText({
      x: outer,
      y: headerBaseline,
      value: title,
      size: 27,
      weight: 800,
      spacing: "-0.27",
    }),
    svgText({
      x: contentRight,
      y: headerBaseline,
      value: subtitle,
      fill: COLORS.muted,
      size: 14,
      anchor: "end",
    }),
  ];

  // ---- KPI cards ----
  const cards = [];
  for (const { model, tokens } of modelCards) {
    const share = totalTokens > 0 ? (tokens / totalTokens) * 100 : 0;
    const priorValue = priorTotals.get(model) ?? 0;
    let chip = null;
    if (priorValue >= 1_000_000) {
      const ratio = tokens / priorValue;
      const delta = (ratio - 1) * 100;
      chip = {
        text: ratio >= 5
          ? `${ratio.toFixed(1)}×`
          : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}%`,
        color: delta >= 0 ? COLORS.deltaUp : COLORS.deltaDown,
        fill: delta >= 0 ? COLORS.deltaUpFill : COLORS.deltaDownFill,
      };
    }
    cards.push({
      swatch: styleForModel(model),
      label: model,
      labelColor: COLORS.muted,
      value: compact(tokens),
      valueColor: COLORS.ink,
      chip,
      suffix: null,
      track: COLORS.track,
      fill: styleForModel(model),
      barPercent: share,
      caption: `${percent(share)} of tokens`,
      panel: COLORS.panel,
      border: COLORS.panelBorder,
    });
  }
  if (hasFast) {
    const fastShare = totalTokens > 0 ? (fastTokens / totalTokens) * 100 : 0;
    cards.push({
      swatch: FAST_MODE_LABEL_COLOR,
      label: "Fast mode",
      labelColor: COLORS.muted,
      value: `${FAST_MODE_MULTIPLIER.toFixed(2)}× rate`,
      valueColor: COLORS.ink,
      chip: null,
      suffix: null,
      track: COLORS.track,
      fill: FAST_MODE_LABEL_COLOR,
      barPercent: fastShare,
      caption: `${percent(fastShare)} of tokens · darker bar shade`,
      panel: COLORS.panel,
      border: COLORS.panelBorder,
    });
  }
  if (hasLine && latestQuotaPoint) {
    const lastReset = resetsInRange.at(-1);
    const resetCaption = lastReset
      ? `reset ${timestampDateLabel(lastReset.timestampMs, bounds.timeZone)}`
      : latestResetsAtSec
        ? `resets ${timestampDateLabel(latestResetsAtSec * 1_000, bounds.timeZone)}`
        : "no reset in range";
    cards.push({
      swatch: COLORS.line,
      label: "Weekly meter",
      labelColor: COLORS.meterAxis,
      value: meterLabel(latestQuotaPoint.remainingPercent),
      valueColor: COLORS.line,
      chip: null,
      suffix: "remaining",
      track: "rgba(246,183,60,.2)",
      fill: COLORS.line,
      barPercent: latestQuotaPoint.remainingPercent,
      caption: `${resetCaption} · read ${timestampDateLabel(latestQuotaPoint.timestampMs, bounds.timeZone)}`,
      panel: COLORS.meterPanel,
      border: COLORS.meterPanelBorder,
    });
  }
  if (cards.length) {
    const gap = 12;
    const cardWidth = (contentWidth - gap * (cards.length - 1)) / cards.length;
    cards.forEach((card, index) => {
      const x = outer + index * (cardWidth + gap);
      elements.push(svgRect(x, cardTop, cardWidth, cardHeight, {
        rx: 7,
        fill: card.panel,
        stroke: card.border,
        "stroke-width": 1,
      }));
      elements.push(`<circle cx="${(x + 19.5).toFixed(2)}" cy="${cardTop + 21.5}" r="4.5" fill="${card.swatch}"/>`);
      elements.push(svgText({
        x: x + 32,
        y: cardTop + 26,
        value: card.label.toUpperCase(),
        fill: card.labelColor,
        size: 13,
        spacing: "1.17",
      }));
      const valueBaseline = cardTop + 63;
      elements.push(svgText({
        x: x + 15,
        y: valueBaseline,
        value: card.value,
        fill: card.valueColor,
        size: 29,
        weight: 800,
        spacing: "-0.72",
      }));
      const valueWidth = textWidth(card.value, 29, 800);
      if (card.chip) {
        const chipTextWidth = textWidth(card.chip.text, 12.5, 700);
        const chipX = x + 15 + valueWidth + 9;
        elements.push(svgRect(chipX, valueBaseline - 13, chipTextWidth + 12, 19, {
          rx: 4,
          fill: card.chip.fill,
        }));
        elements.push(svgText({
          x: chipX + 6,
          y: valueBaseline,
          value: card.chip.text,
          fill: card.chip.color,
          size: 12.5,
          weight: 700,
        }));
      } else if (card.suffix) {
        elements.push(svgText({
          x: x + 15 + valueWidth + 9,
          y: valueBaseline,
          value: card.suffix,
          fill: COLORS.secondary,
          size: 12.5,
        }));
      }
      const barY = cardTop + 82;
      const barWidth = cardWidth - 30;
      elements.push(svgRect(x + 15, barY, barWidth, 4, { rx: 2, fill: card.track }));
      const fillWidth = (Math.min(100, Math.max(0, card.barPercent)) / 100) * barWidth;
      if (fillWidth > 0) {
        elements.push(svgRect(x + 15, barY, fillWidth, 4, { rx: 2, fill: card.fill }));
      }
      elements.push(svgText({
        x: x + 15,
        y: cardTop + 103,
        value: card.caption,
        fill: COLORS.muted,
        size: 12.5,
      }));
    });
  }

  // ---- Chart grid + axes ----
  for (const fraction of [1, 0.75, 0.5, 0.25, 0]) {
    const y = plotBottom - fraction * plotHeight;
    elements.push(`<line x1="${plotLeft}" y1="${y.toFixed(2)}" x2="${plotRight}" y2="${y.toFixed(2)}" stroke="${fraction === 0 ? COLORS.baseline : COLORS.grid}" stroke-width="1"/>`);
    elements.push(svgText({
      x: plotLeft - 14,
      y: y + 4,
      value: percentMode
        ? `${Number((maxBar * fraction).toFixed(1))}%`
        : fraction === 0
          ? "0"
          : compact(maxBar * fraction),
      fill: COLORS.muted,
      size: 13,
      anchor: "end",
      mono: true,
    }));
    if (hasLine) {
      elements.push(svgText({
        x: plotRight + 14,
        y: y + 4,
        value: `${Math.round(fraction * 100)}%`,
        fill: COLORS.meterAxis,
        size: 13,
        mono: true,
      }));
    }
  }
  const axisTitleY = plotTop + plotHeight / 2;
  elements.push(svgText({
    x: outer + 30,
    y: axisTitleY,
    value: percentMode ? "OBSERVED LIMIT DRAIN" : "ACTUAL TOKEN VOLUME",
    fill: COLORS.leftAxis,
    size: 12,
    anchor: "middle",
    spacing: "2",
  }).replace("<text ", `<text transform="rotate(-90 ${outer + 30} ${axisTitleY})" `));
  if (hasLine) {
    elements.push(svgText({
      x: width - outer - 6,
      y: axisTitleY,
      value: "WEEKLY METER REMAINING (%)",
      fill: COLORS.meterAxis,
      size: 12,
      anchor: "middle",
      spacing: "2",
    }).replace("<text ", `<text transform="rotate(90 ${width - outer - 6} ${axisTitleY})" `));
  }

  // ---- Bars ----
  const slotWidth = plotWidth / binCount;
  const barWidth = Math.min(74, Math.max(26, slotWidth * 0.6));
  const barGeometry = bars.map((bin, binIndex) => {
    const centerX = plotLeft + (binIndex + 0.5) * slotWidth;
    return {
      bin,
      centerX,
      x: centerX - barWidth / 2,
      topY: plotBottom - (binTotalOf(bin) / maxBar) * plotHeight,
    };
  });

  const segmentLabels = [];
  for (const { bin, centerX, x } of barGeometry) {
    const entries = sortedModelEntries(bin.values);
    let y = plotBottom;
    for (const [model, value] of entries) {
      const segmentHeight = (value / maxBar) * plotHeight;
      y -= segmentHeight;
      if (segmentHeight <= 0.4) continue;
      const baseColor = styleForModel(model);
      const fastValue = percentMode ? 0 : (bin.fastValues?.get(model) ?? 0);
      const fastHeight = fastValue > 0 && value > 0
        ? segmentHeight * Math.min(1, fastValue / value)
        : 0;
      elements.push(svgRect(x, y, barWidth, segmentHeight - fastHeight, { fill: baseColor }));
      if (fastHeight > 0.5) {
        elements.push(svgRect(x, y + segmentHeight - fastHeight, barWidth, fastHeight, {
          fill: fastShade(baseColor),
        }));
      }
      const valueLabel = percentMode ? percent(value) : compact(value);
      const fits = (text, size) => textWidth(text, size, 700) <= barWidth - 6;
      if (segmentHeight >= 32 && fits(model, 13) && fits(valueLabel, 15)) {
        const segmentCenter = y + segmentHeight / 2;
        segmentLabels.push(svgText({
          x: centerX,
          y: segmentCenter - 5,
          value: model,
          fill: COLORS.onFill,
          size: 13,
          anchor: "middle",
        }));
        segmentLabels.push(svgText({
          x: centerX,
          y: segmentCenter + 13,
          value: valueLabel,
          fill: "#ffffff",
          size: 15,
          weight: 700,
          anchor: "middle",
        }));
      }
    }
  }

  // ---- Meter line: per-cycle smoothed segments with reset breaks ----
  const yForRemaining = (value) =>
    plotTop + (1 - Math.max(0, Math.min(100, value)) / 100) * plotHeight;
  const xForTimestamp = (timestampMs) => {
    const span = bounds.end.getTime() - bounds.start.getTime();
    const ratio = span > 0 ? (timestampMs - bounds.start.getTime()) / span : 0;
    return plotLeft + Math.max(0, Math.min(1, ratio)) * plotWidth;
  };

  let resetMarks = [];
  let binDots = [];
  let pills = [];
  const lineSegments = [];
  if (hasLine) {
    const cycles = new Map();
    for (const point of trend.points ?? []) {
      const cycle = cycles.get(point.cycle) ?? [];
      cycle.push(point);
      cycles.set(point.cycle, cycle);
    }
    const orderedCycles = [...cycles.values()].sort(
      (left, right) => left[0].timestampMs - right[0].timestampMs,
    );

    resetMarks = resetsInRange
      .filter((reset) => reset.kind !== "start")
      .map((reset) => {
        // Nudge a reset that lands inside a column into the gutter to its
        // right, so the dashed break never crosses the bar or its total.
        let x = xForTimestamp(Math.max(bounds.start.getTime(), reset.timestampMs));
        const binIndex = Math.floor((x - plotLeft) / slotWidth);
        const barRight = plotLeft + (binIndex + 0.5) * slotWidth + barWidth / 2;
        if (x >= barRight - barWidth && x <= barRight) {
          x = Math.min(barRight + 14, plotRight - 4);
        }
        return {
          x,
          label: reset.kind === "weekly-expiry" ? "RESET 100%" : "RESTART 100%",
        };
      });

    for (const [cycleIndex, cyclePoints] of orderedCycles.entries()) {
      // Thin to at most one point per 2px so the path stays light while the
      // spline still follows every meaningful movement.
      const thinned = [];
      for (const point of cyclePoints) {
        const x = xForTimestamp(point.timestampMs);
        const y = yForRemaining(point.remainingPercent);
        const previous = thinned.at(-1);
        if (previous && x - previous.x < 2) {
          previous.y = y;
          previous.remainingPercent = point.remainingPercent;
          previous.timestampMs = point.timestampMs;
        } else {
          thinned.push({
            x,
            y,
            remainingPercent: point.remainingPercent,
            timestampMs: point.timestampMs,
          });
        }
      }
      if (cycleIndex > 0 && thinned.length) {
        const reset = resetMarks[cycleIndex - 1];
        if (reset) {
          // Observations between the true reset moment and the nudged break
          // would draw left of the dashed line; drop them when enough of the
          // cycle remains to its right.
          const beyond = thinned.filter((point) => point.x > reset.x + 1);
          if (beyond.length >= 2) thinned.splice(0, thinned.length - beyond.length);
          if (reset.x < thinned[0].x - 1) {
            thinned.unshift({
              x: reset.x,
              y: yForRemaining(100),
              synthetic: true,
            });
          }
        }
      }
      const path = monotonePath(thinned);
      if (path) {
        elements.push(`<path d="${path}" fill="none" stroke="${COLORS.line}" stroke-width="3" stroke-linecap="round"/>`);
        lineSegments.push(thinned);
      }
    }

    // One dot per labeled column: the last observation inside that column.
    const observed = (trend.points ?? []).filter((point) => point.observed);
    const step = labelEvery(binCount);
    const resetBinIndexes = new Set(resetMarks.map((reset) =>
      Math.max(0, Math.min(binCount - 1, Math.floor((reset.x - plotLeft) / slotWidth)))));
    for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
      if (binIndex % step !== 0 && binIndex !== binCount - 1) continue;
      if (resetBinIndexes.has(binIndex)) continue;
      const binEndMs = zonedMidnight(
        bars[binIndex].endDateString,
        bounds.timeZone,
      ).getTime();
      const binStartMs = zonedMidnight(
        bars[binIndex].startDateString,
        bounds.timeZone,
      ).getTime();
      const point = observed.findLast(
        (candidate) =>
          candidate.timestampMs >= binStartMs && candidate.timestampMs < binEndMs,
      );
      if (!point) continue;
      binDots.push({
        binIndex,
        x: xForTimestamp(point.timestampMs),
        y: yForRemaining(point.remainingPercent),
        remainingPercent: point.remainingPercent,
      });
    }
    for (const dot of binDots) {
      elements.push(`<circle cx="${dot.x.toFixed(2)}" cy="${dot.y.toFixed(2)}" r="4" fill="${COLORS.line}"/>`);
    }

    // Stagger dense reset labels across lanes: a label joins the first lane
    // whose previous label sits far enough to its left.
    const laneRight = [];
    for (const reset of resetMarks) {
      elements.push(`<line x1="${reset.x.toFixed(2)}" y1="${plotTop}" x2="${reset.x.toFixed(2)}" y2="${plotBottom}" stroke="rgba(246,183,60,.5)" stroke-width="2" stroke-dasharray="5 6"/>`);
      let lane = laneRight.findIndex((right) => reset.x - right >= 112);
      if (lane < 0) {
        lane = laneRight.length < 3
          ? laneRight.length
          : laneRight.indexOf(Math.min(...laneRight));
      }
      laneRight[lane] = reset.x;
      elements.push(svgText({
        x: reset.x,
        y: chartBlockTop + 26 - lane * 16,
        value: reset.label,
        fill: COLORS.line,
        size: 13,
        anchor: "middle",
        mono: true,
      }));
    }

    // Callout pills: at most four, spread across the observed dots; the last
    // one sits under its own point so it never covers a post-reset stroke.
    const pillSources = binDots;
    let picked = pillSources;
    if (pillSources.length > 4) {
      const lastIndex = pillSources.length - 1;
      const indexes = [...new Set([
        0,
        Math.round(lastIndex / 3),
        Math.round((2 * lastIndex) / 3),
        lastIndex,
      ])];
      picked = indexes.map((index) => pillSources[index]);
    }
    pills = picked.map((dot, pickIndex) => {
      const label = meterLabel(dot.remainingPercent);
      const pillWidth = label.length * 8.4 + 18;
      const below = pickIndex === picked.length - 1;
      let x = below ? dot.x - pillWidth / 2 : dot.x + barWidth / 2 + 10;
      if (x + pillWidth > plotRight + 30) x = dot.x - pillWidth - barWidth / 2 - 10;
      const centerY = below
        ? Math.min(plotBottom - 14, dot.y + 26)
        : Math.max(plotTop + 14, dot.y - 24);
      return { x, y: centerY - 13, w: pillWidth, h: 26, tx: x + pillWidth / 2, ty: centerY + 5, label };
    });
  }

  // ---- Bar totals and day labels (drawn over the line like the labels) ----
  elements.push(...segmentLabels);
  // Where the line passes through a horizontal span at band height, from the
  // thinned polylines; keeps each column total clear of the amber stroke.
  const lineTopIfCrossing = (x0, x1, bandTop, bandBottom) => {
    let top = Infinity;
    for (const segment of lineSegments) {
      for (let index = 0; index < segment.length - 1; index += 1) {
        const from = segment[index];
        const to = segment[index + 1];
        if (to.x < x0 || from.x > x1) continue;
        const clip0 = Math.max(x0, from.x);
        const clip1 = Math.min(x1, to.x);
        if (clip1 < clip0) continue;
        const yAt = (x) =>
          from.y + (to.x === from.x ? 0 : ((x - from.x) / (to.x - from.x)) * (to.y - from.y));
        const yLow = Math.min(yAt(clip0), yAt(clip1));
        const yHigh = Math.max(yAt(clip0), yAt(clip1));
        if (yLow <= bandBottom && yHigh >= bandTop) top = Math.min(top, yLow);
      }
    }
    return top;
  };
  const labelStep = labelEvery(binCount);
  const isLabeledColumn = (binIndex) =>
    binIndex % labelStep === 0 || binIndex === binCount - 1;
  for (const [binIndex, { bin, centerX, topY }] of barGeometry.entries()) {
    const binTotal = binTotalOf(bin);
    // Dense windows only caption the columns that carry date labels; a total
    // on all 30 daily columns would overlap its neighbours.
    if (binTotal > 0 && isLabeledColumn(binIndex)) {
      // The total label sits in the band just above the stack; step it above
      // the line only when the line actually crosses that band.
      const lineTop = lineTopIfCrossing(
        centerX - barWidth / 2 - 6,
        centerX + barWidth / 2 + 6,
        topY - 32,
        topY + 8,
      );
      const clearedTop = Number.isFinite(lineTop) ? Math.min(topY, lineTop) : topY;
      elements.push(svgText({
        x: centerX,
        y: clearedTop - 13,
        value: percentMode
          ? `${bin.approximate ? "≈" : ""}${percent(binTotal)}`
          : compact(binTotal),
        fill: COLORS.ink,
        size: 16,
        weight: 700,
        anchor: "middle",
      }));
    }
    if (isLabeledColumn(binIndex)) {
      const weekday = actual.binSize === 1
        ? localWeekdayLabel(bin.startDateString, bounds.timeZone).toUpperCase()
        : "";
      if (weekday) {
        elements.push(svgText({
          x: centerX,
          y: plotBottom + 32,
          value: weekday,
          fill: COLORS.muted,
          size: 13,
          anchor: "middle",
          spacing: "1.56",
        }));
      }
      elements.push(svgText({
        x: centerX,
        y: plotBottom + (weekday ? 54 : 40),
        value: binDateLabel(bin, bounds.timeZone),
        fill: COLORS.secondary,
        size: 15,
        anchor: "middle",
      }));
    }
  }
  for (const pill of pills) {
    elements.push(svgRect(pill.x, pill.y, pill.w, pill.h, {
      rx: 6,
      fill: COLORS.background,
      stroke: COLORS.line,
      "stroke-width": 1.2,
    }));
    elements.push(svgText({
      x: pill.tx,
      y: pill.ty,
      value: pill.label,
      fill: COLORS.line,
      size: 13,
      anchor: "middle",
      mono: true,
    }));
  }

  // ---- Legend row ----
  const legendModels = sortedModelEntries(
    percentMode ? burn.totals : actual.totals,
  ).map(([model]) => model);
  let legendX = outer;
  const legendItem = (swatchMarkup, swatchWidth, label) => {
    elements.push(swatchMarkup);
    elements.push(svgText({
      x: legendX + swatchWidth + 9,
      y: legendBaseline,
      value: label,
      fill: COLORS.secondary,
      size: 13.5,
    }));
    legendX += swatchWidth + 9 + textWidth(label, 13.5) + 24;
  };
  for (const model of legendModels) {
    legendItem(
      svgRect(legendX, legendBaseline - 10, 13, 11, { fill: styleForModel(model) }),
      13,
      model,
    );
  }
  if (hasFast && legendModels.length) {
    legendItem(
      svgRect(legendX, legendBaseline - 10, 13, 11, {
        fill: fastShade(styleForModel(legendModels[0])),
      }),
      13,
      "Darker shade = fast mode",
    );
  }
  if (hasLine) {
    legendItem(
      svgRect(legendX, legendBaseline - 6, 20, 3, { fill: COLORS.line }),
      20,
      percentMode
        ? "Bars = observed meter drops · line = weekly meter remaining (%)"
        : "Observed weekly meter remaining (%)",
    );
  }

  // ---- Projects + pace ----
  elements.push(`<line x1="${outer}" y1="${projectsRuleY}" x2="${contentRight}" y2="${projectsRuleY}" stroke="${COLORS.rule}" stroke-width="1"/>`);
  const sectionBaseline = projectsTop + 10;
  const columnGap = 28;
  const leftColumnWidth = ((contentWidth - columnGap) * 1.55) / 2.55;
  const leftColumnRight = outer + leftColumnWidth;
  const dividerX = leftColumnRight + columnGap;
  const paceX = dividerX + 28;

  elements.push(svgText({
    x: outer,
    y: sectionBaseline,
    value: "WHERE IT WENT · TOP PROJECTS",
    fill: COLORS.muted,
    size: 12,
    spacing: "1.32",
  }));
  const topRows = rows.slice(0, 3);
  const restRows = rows.slice(3);
  const topTokens = topRows.reduce((sum, row) => sum + row.totalTokens, 0);
  elements.push(svgText({
    x: leftColumnRight,
    y: sectionBaseline,
    value: `${rows.length} ${rows.length === 1 ? "project" : "projects"} active · top ${topRows.length} = ${totalTokens > 0 ? percent((topTokens / totalTokens) * 100) : "—"} of tokens`,
    fill: COLORS.muted,
    size: 12.5,
    anchor: "end",
  }));

  const displayRows = topRows.map((row, index) => ({
    rank: String(index + 1).padStart(2, "0"),
    name: row.displayProject ?? row.project,
    tokens: row.totalTokens,
    fill: COLORS.leftAxis,
    muted: false,
  }));
  if (restRows.length) {
    displayRows.push({
      rank: null,
      name: restRows.length === 1
        ? (restRows[0].displayProject ?? restRows[0].project)
        : `${restRows.length} other projects`,
      tokens: restRows.reduce((sum, row) => sum + row.totalTokens, 0),
      fill: COLORS.remainderBar,
      muted: true,
    });
  }
  const rowGap = 12;
  const rankX = outer;
  const nameX = rankX + 22 + rowGap;
  const projectBarX = nameX + 190 + rowGap;
  const tokensRight = leftColumnRight - 62 - rowGap;
  const projectBarWidth = tokensRight - (86 + rowGap) - projectBarX;
  displayRows.forEach((row, index) => {
    const centerY = projectsTop + 29 + index * 29 + 9;
    if (row.rank) {
      elements.push(svgText({
        x: rankX,
        y: centerY + 5,
        value: row.rank,
        fill: COLORS.muted,
        size: 13,
        mono: true,
      }));
    }
    elements.push(svgText({
      x: nameX,
      y: centerY + 5,
      value: row.name,
      fill: row.muted ? COLORS.muted : COLORS.ink,
      size: 15,
      weight: row.muted ? 400 : 700,
    }));
    elements.push(svgRect(projectBarX, centerY - 5, projectBarWidth, 10, {
      rx: 2,
      fill: COLORS.projectTrack,
    }));
    const share = totalTokens > 0 ? (row.tokens / totalTokens) * 100 : 0;
    const fillWidth = (Math.min(100, share) / 100) * projectBarWidth;
    if (fillWidth > 0) {
      elements.push(svgRect(projectBarX, centerY - 5, fillWidth, 10, {
        rx: 2,
        fill: row.fill,
      }));
    }
    elements.push(svgText({
      x: tokensRight,
      y: centerY + 5,
      value: compact(row.tokens),
      fill: row.muted ? COLORS.secondary : COLORS.ink,
      size: 15,
      weight: 700,
      anchor: "end",
    }));
    elements.push(svgText({
      x: leftColumnRight,
      y: centerY + 5,
      value: percent(share),
      fill: COLORS.muted,
      size: 13.5,
      anchor: "end",
    }));
  });

  elements.push(`<line x1="${dividerX}" y1="${projectsTop}" x2="${dividerX}" y2="${projectsTop + projectsBlockHeight}" stroke="${COLORS.rule}" stroke-width="1"/>`);
  elements.push(svgText({
    x: paceX,
    y: sectionBaseline,
    value: "PACE & RUNWAY",
    fill: COLORS.muted,
    size: 12,
    spacing: "1.32",
  }));

  const generatedAtMs = new Date(snapshot.generatedAt).getTime();
  const paceLines = [];
  let paceNote = null;
  const dailyAverage = totalTokens / Math.max(1, days);
  if (hasLine && meterUsable && latestQuotaPoint && totalTokens > 0) {
    const tokensPerPercent = totalTokens / burn.totalPercent;
    const burnPerDay = dailyAverage / tokensPerPercent;
    const runwayDays = burnPerDay > 0
      ? latestQuotaPoint.remainingPercent / burnPerDay
      : null;
    if (runwayDays !== null) {
      paceLines.push({
        value: `${runwayDays.toFixed(1)} days`,
        size: 24,
        weight: 800,
        color: COLORS.line,
        detail: "of meter left at this pace",
      });
    }
    paceLines.push({
      value: `${compact(dailyAverage)} / day`,
      size: 18,
      weight: 700,
      color: COLORS.ink,
      detail: `${days}-day average · ${burnPerDay.toFixed(1)}% of meter`,
    });
    paceLines.push({
      value: `${compact(tokensPerPercent)} / 1%`,
      size: 18,
      weight: 700,
      color: COLORS.ink,
      detail: "tokens per meter point",
    });
    const daysToReset = latestResetsAtSec !== null && Number.isFinite(generatedAtMs)
      ? (latestResetsAtSec * 1_000 - generatedAtMs) / 86_400_000
      : null;
    if (runwayDays !== null && daysToReset !== null && daysToReset > 0) {
      const resetIn = Math.max(1, Math.round(daysToReset));
      const resetInLabel = `${resetIn} ${resetIn === 1 ? "day" : "days"}`;
      const gap = runwayDays - daysToReset;
      if (Math.abs(gap) <= 1.5) {
        paceNote = `Next weekly reset in ${resetInLabel} — the current pace lands within ~${Math.max(1, Math.round(Math.abs(gap)))} day of it.`;
      } else if (gap > 0) {
        paceNote = `Next weekly reset in ${resetInLabel} — the current pace leaves ~${Math.round(gap)} days of headroom past it.`;
      } else {
        paceNote = `Next weekly reset in ${resetInLabel} — the current pace runs the meter out ~${Math.round(-gap)} days before it.`;
      }
    }
  } else {
    paceLines.push({
      value: `${compact(dailyAverage)} / day`,
      size: 18,
      weight: 700,
      color: COLORS.ink,
      detail: `${days}-day average`,
    });
    paceNote = "No usable weekly meter drain in this range, so runway cannot be estimated.";
  }
  let paceBaseline = projectsTop + 48;
  for (const line of paceLines) {
    elements.push(svgText({
      x: paceX,
      y: paceBaseline,
      value: line.value,
      fill: line.color,
      size: line.size,
      weight: line.weight,
      spacing: line.size >= 24 ? "-0.48" : null,
    }));
    elements.push(svgText({
      x: paceX + textWidth(line.value, line.size, line.weight) + 10,
      y: paceBaseline,
      value: line.detail,
      fill: COLORS.muted,
      size: 13,
    }));
    paceBaseline += 34;
  }
  if (paceNote) {
    const noteWidth = contentRight - paceX;
    const words = paceNote.split(" ");
    const noteLines = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, 12.5) > noteWidth && current) {
        noteLines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) noteLines.push(current);
    let noteBaseline = paceBaseline - 6;
    for (const line of noteLines) {
      elements.push(svgText({
        x: paceX,
        y: noteBaseline,
        value: line,
        fill: COLORS.muted,
        size: 12.5,
      }));
      noteBaseline += 19;
    }
  }

  // ---- Footnote strip ----
  elements.push(`<line x1="${outer}" y1="${footnotesRuleY}" x2="${contentRight}" y2="${footnotesRuleY}" stroke="${COLORS.rule}" stroke-width="1"/>`);
  const totalResets = expiries + restarts;
  let resetsValue = "no meter reads in range";
  let resetsQualifier = "resets refill the meter to 100%";
  if (hasLine && totalResets === 0) {
    resetsValue = "none in this window";
    resetsQualifier = latestResetsAtSec
      ? `next scheduled reset ${timestampDateLabel(latestResetsAtSec * 1_000, bounds.timeZone)}`
      : "resets refill the meter to 100%";
  } else if (hasLine && restarts === 0) {
    resetsValue = `${totalResets} scheduled · 0 early`;
    const lastReset = resetsInRange.at(-1);
    resetsQualifier = totalResets === 1 && lastReset
      ? `${timestampDateLabel(lastReset.timestampMs, bounds.timeZone)} was the normal weekly reset`
      : "all were normal weekly resets";
  } else if (hasLine) {
    resetsValue = `${totalResets} total · ${restarts} early`;
    resetsQualifier = "early resets are provider-initiated";
  }
  const footnotes = [
    {
      label: "Meter burned this range",
      value: meterUsable
        ? `${burn.totalPercent.toFixed(1)} meter points`
        : "no usable meter drain",
      qualifier: "total fall of the amber line, across resets",
    },
    {
      label: "Estimated cost",
      value: rateCard.credits > 0
        ? `≈${compact(rateCard.credits)} credits`
        : "no rated tokens in range",
      qualifier: `priced at published rates${rateCard.fastCredits > 0 ? ` · fast mode ×${FAST_MODE_MULTIPLIER}` : ""}`,
    },
    {
      label: "Weekly resets",
      value: resetsValue,
      qualifier: resetsQualifier,
    },
    {
      label: "Data as of",
      value: Number.isFinite(generatedAtMs)
        ? localDateTimeLabel(generatedAtMs, bounds.timeZone)
        : "unknown",
      qualifier: latestQuotaPoint
        ? `meter last read ${shortDateTimeLabel(latestQuotaPoint.timestampMs, bounds.timeZone)}`
        : "no weekly meter reads in range",
    },
  ];
  const footnoteTop = footnotesRuleY + 18;
  const footnoteColumnWidth = contentWidth / 4;
  footnotes.forEach((note, index) => {
    const columnX = outer + index * footnoteColumnWidth;
    const x = index === 0 ? columnX : columnX + 22;
    if (index > 0) {
      elements.push(`<line x1="${columnX.toFixed(2)}" y1="${footnoteTop}" x2="${columnX.toFixed(2)}" y2="${footnoteTop + 53}" stroke="${COLORS.rule}" stroke-width="1"/>`);
    }
    elements.push(svgText({
      x,
      y: footnoteTop + 10,
      value: note.label.toUpperCase(),
      fill: COLORS.muted,
      size: 12,
      spacing: "1.32",
    }));
    elements.push(svgText({
      x,
      y: footnoteTop + 31,
      value: note.value,
      fill: COLORS.ink,
      size: 16,
      weight: 700,
    }));
    elements.push(svgText({
      x,
      y: footnoteTop + 48,
      value: note.qualifier,
      fill: COLORS.muted,
      size: 12.5,
    }));
  });

  elements.push("</svg>");
  return elements.join("\n");
}

export async function writeTrendPng(svg, outputPath) {
  await sharp(Buffer.from(svg, "utf8")).png().toFile(outputPath);
}
