import { Buffer } from "node:buffer";

import {
  buildBurnDayBins,
  buildUsageTrend,
  priorPeriodBounds,
  weeklyQuotaObservations,
} from "./token-ledger-trend.mjs";
import { FAST_MODE_MULTIPLIER } from "../lib/token-ledger-rates.mjs";
import { buildActualTokenBins } from "./token-ledger-trend-terminal.mjs";
import { buildCacheReportData } from "./token-ledger-cache-data.mjs";
import {
  checkedTokenAdd,
  tokenValue,
  usageBucketsInRange,
  MAX_SAFE_TOKEN_COUNT,
} from "../lib/token-ledger-usage.mjs";
import {
  compact,
  escapeXml,
  fastShade,
  shiftCalendarDate,
  svgRect,
  svgText,
  textWidth,
  truncateText,
  TREND_IMAGE_COLORS as COLORS,
  TREND_IMAGE_MODEL_COLORS,
  FAST_MODE_LABEL_COLOR,
} from "./token-ledger-image-primitives.mjs";

export {
  TREND_IMAGE_MODEL_COLORS,
  escapeXml,
  compact,
  fastShade,
  shiftCalendarDate,
  svgRect,
  svgText,
  textWidth,
  truncateText,
} from "./token-ledger-image-primitives.mjs";
import { historyScopeLabel } from "../lib/token-ledger-collection.mjs";

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

const MIN_BAR_WIDTH = 26;
const METER_PANEL_HEADING = "WEEKLY LIMIT · PACE & RUNWAY";

function percent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  if (numeric > 0 && numeric < 0.1) return "<0.1%";
  return `${numeric.toFixed(1)}%`;
}

function meterLabel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric.toFixed(Number.isInteger(numeric) ? 0 : 1)}%`;
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

function sortedModelEntries(values) {
  return [...values.entries()]
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => modelSort(left, right));
}

function dateParts(dateString) {
  return dateString.split("-").map(Number);
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
  return new Date(utcGuess - timeZoneOffsetMs(first, timeZone));
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

function timestampDateLabel(timestampMs, timeZone) {
  if (!Number.isFinite(timestampMs)) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(new Date(timestampMs));
}

function timestampReadLabel(timestampMs, timeZone) {
  if (!Number.isFinite(timestampMs)) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}

function timestampTimeLabel(timestampMs, timeZone) {
  if (!Number.isFinite(timestampMs)) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}

function binDateLabel(bin, timeZone) {
  const start = localDateLabel(bin.startDateString, timeZone);
  const lastDate = shiftCalendarDate(bin.endDateString, -1);
  if (lastDate === bin.startDateString) return start;
  return `${start}–${localDateLabel(lastDate, timeZone).replace(/^[A-Za-z]+ /, "")}`;
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

function fallbackProjectRows(snapshot, bounds, events = null) {
  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();
  const totals = new Map();
  let scale = 1;
  let totalTokens = 0;
  const sourceEvents = events ?? usageBucketsInRange(snapshot, startMs, endMs);
  for (const event of sourceEvents) {
    if (event?.invalidTokenRecord === true) continue;
    const timestampMs = new Date(event.timestamp).getTime();
    if (!Number.isFinite(timestampMs)) continue;
    const allowFractional = event.rangeAllocationEstimated === true;
    const tokens = tokenValue(event.totalTokens, { allowFractional });
    if (!(tokens > 0)) continue;
    const project = String(event.project || "Unlabelled activity")
      .replace(/[\t\r\n]+/g, " ")
      .trim() || "Unlabelled activity";
    const scaledTokens = tokens / scale;
    totals.set(project, (totals.get(project) ?? 0) + scaledTokens);
    totalTokens += scaledTokens;
    const scaleFactor = Math.max(1, totalTokens / MAX_SAFE_TOKEN_COUNT);
    if (scaleFactor === 1) continue;
    for (const [projectName, value] of totals) {
      totals.set(projectName, value / scaleFactor);
    }
    totalTokens = MAX_SAFE_TOKEN_COUNT;
    scale *= scaleFactor;
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
  trend: providedTrend = null,
  days = bounds.rangeDays ?? 7,
  options = {},
  projectRows = null,
  analysis = null,
}) {
  const trend = providedTrend ?? analysis?.trend ?? buildUsageTrend(snapshot, bounds, { analysis });
  const width = Math.max(900, Math.min(2_400, Number(options.imageWidth) || 1_280));
  const outer = 32;
  const plotLeft = 96;
  const plotRight = width - 96;
  const plotWidth = plotRight - plotLeft;
  const contentRight = width - outer;
  const contentWidth = width - outer * 2;

  // Keep daily bars while they fit at the minimum readable width; aggregate
  // longer windows into multi-day columns so bars and labels never overlap.
  const actual = buildActualTokenBins(snapshot, bounds, days, plotWidth, {
    minBinWidth: MIN_BAR_WIDTH,
    preferDaily: true,
    events: analysis?.currentEvents,
  });
  const burn = buildBurnDayBins(trend, bounds, { days, binSize: actual.binSize });
  const meterUsable = Boolean(trend.available && burn.totalPercent > 0);
  const percentMode = Boolean(options.drain) && meterUsable;
  const bars = percentMode ? burn.bins : actual.bins;
  const binCount = actual.binCount;
  const binTotalOf = (bin) => (percentMode ? bin.totalPercent : bin.totalTokens);
  const maxBar = niceCeiling(
    bars.reduce((maximum, bin) => Math.max(maximum, binTotalOf(bin)), 0),
  );
  const hasLine = Boolean(trend.available && (trend.points ?? []).length > 0);

  const totalTokens = [...actual.totals.values()].reduce(
    (sum, value) => checkedTokenAdd(sum, value, { allowFractional: true }),
    0,
  );
  const fastTokens = [...(actual.fastTotals?.values() ?? [])].reduce(
    (sum, value) => checkedTokenAdd(sum, value, { allowFractional: true }),
    0,
  );
  const hasFast = !percentMode && fastTokens > 0;

  const modelCards = [...actual.totals.entries()]
    .filter(([, value]) => value > 0 && totalTokens > 0 && value / totalTokens >= 0.01)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([model, value]) => ({ model, tokens: value }));

  // Prior-period per-model totals feed the delta chips.
  const priorBounds = priorPeriodBounds(bounds, days);
  const priorActual = buildActualTokenBins(snapshot, priorBounds, days, plotWidth, {
    minBinWidth: MIN_BAR_WIDTH,
    preferDaily: true,
    events: analysis?.priorEvents,
  });
  const priorTotals = priorActual.totals;

  const latestQuotaPoint = [...(trend.points ?? [])]
    .filter(
      (point) => point.observed && point.timestampMs <= bounds.end.getTime(),
    )
    .at(-1);
  const latestQuotaReadMs = Number.isFinite(trend.observedThroughMs)
    ? trend.observedThroughMs
    : null;
  const resetsInRange = trend.resets ?? [];
  const weeklyObservationsAll = weeklyQuotaObservations(snapshot).filter(
    (observation) => observation.timestampMs < bounds.end.getTime(),
  );
  const latestResetsAtSec = weeklyObservationsAll.at(-1)?.resetsAt ?? null;

  const rows = projectRows ?? fallbackProjectRows(
    snapshot,
    bounds,
    analysis?.currentEvents,
  );

  // Cache bins share the trend chart's bin size so both charts' columns stay
  // vertically aligned.
  const cacheData = buildCacheReportData(
    snapshot,
    bounds,
    days,
    plotWidth,
    actual.binSize,
    analysis?.currentEvents,
  );
  const hasCache = cacheData.inputTokens > 0;
  const cacheModelRows = (() => {
    if (!hasCache) return [];
    const models = cacheData.models;
    if (models.length <= 4) return models;
    const rest = models.slice(3);
    const restInput = rest.reduce(
      (sum, model) => sum + model.inputTokens,
      0,
    );
    const restCached = rest.reduce(
      (sum, model) => sum + model.cachedInputTokens,
      0,
    );
    return [...models.slice(0, 3), {
      model: `${rest.length} other models`,
      inputTokens: restInput,
      cachedInputTokens: restCached,
      rate: restInput > 0
        ? (restCached / restInput) * 100
        : null,
      muted: true,
    }];
  })();

  // ---- Pace & runway (computed early: its height shapes the top row) ----
  const generatedAtMs = new Date(snapshot.generatedAt).getTime();
  const paceLines = [];
  let paceNote = null;
  let paceRunwayBar = null;
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
        size: 23,
        weight: 800,
        color: COLORS.line,
        detail: "of meter left at this pace",
      });
    }
    paceLines.push({
      value: `${compact(dailyAverage)} / day`,
      size: 17,
      weight: 700,
      color: COLORS.ink,
      detail: `${days}-day average · ${burnPerDay.toFixed(1)}% of meter`,
    });
    paceLines.push({
      value: `${compact(tokensPerPercent)} / 1%`,
      size: 17,
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
      paceRunwayBar = { runwayDays, daysToReset, resetInLabel };
      const gap = runwayDays - daysToReset;
      if (Math.abs(gap) <= 1.5) {
        paceNote = `Next weekly reset in ${resetInLabel}. Current pace lands within ~${Math.max(1, Math.round(Math.abs(gap)))} day of it.`;
      } else if (gap > 0) {
        paceNote = `Next weekly reset in ${resetInLabel}. Current pace leaves ~${Math.round(gap)} days of headroom past it.`;
      } else {
        paceNote = `Next weekly reset in ${resetInLabel}. Current pace runs the meter out ~${Math.round(-gap)} days before it.`;
      }
    }
  } else {
    paceLines.push({
      value: `${compact(dailyAverage)} / day`,
      size: 17,
      weight: 700,
      color: COLORS.ink,
      detail: `${days}-day average`,
    });
    paceNote = hasLine
      ? "No usable weekly meter drain in this range, so runway cannot be estimated."
      : "No account-wide weekly meter is available, so runway cannot be estimated.";
  }

  // ---- Layout ----
  // One uniform-height top band: a 2x2 quad of stat cells beside one unified
  // weekly meter + pace panel.
  const headerBaseline = 53;
  const cardTop = 82;
  const topGap = 24;
  const hasMeterCard = Boolean(hasLine && latestQuotaPoint);
  const statCardCount =
    modelCards.length + (hasFast ? 1 : 0) + (percentMode ? 1 : 0);
  const pacePanelWidth = hasMeterCard
    ? Math.min(560, Math.max(480, contentWidth * 0.55))
    : 432;
  const pacePanelX = contentRight - pacePanelWidth;
  const paceTextX = pacePanelX + 18;
  const paceInnerWidth = pacePanelWidth - 36;
  const quadWidth = contentWidth - pacePanelWidth - topGap;
  const quadColumns = statCardCount >= 2 ? 2 : 1;
  const quadRows = Math.max(1, Math.ceil(statCardCount / quadColumns));
  const paceNoteLines = [];
  if (paceNote) {
    let current = "";
    for (const word of paceNote.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, 11.5) > paceInnerWidth && current) {
        paceNoteLines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) paceNoteLines.push(current);
  }
  // Baseline offsets inside the unified panel: meter headline, optional
  // runway timeline, the two-column stat pair, then the note.
  const paceHeadlineBaseline = hasMeterCard ? 58 : 54;
  const paceStatValueBaseline = paceHeadlineBaseline + (paceRunwayBar ? 62 : 34);
  const paceStatsPresent = paceLines.length > (hasMeterCard ? 0 : 1);
  const paceNoteStart =
    (paceStatsPresent ? paceStatValueBaseline + 16 : paceHeadlineBaseline) + 24;
  const topRowHeight = Math.max(
    hasMeterCard ? 170 : 150,
    paceNoteStart + (paceNoteLines.length - 1) * 16 + 14,
  );
  const chartBlockTop = cardTop + topRowHeight + 16;
  const plotTop = chartBlockTop + 40;
  const plotHeight = 430;
  const plotBottom = plotTop + plotHeight;
  const chartBlockBottom = plotBottom + 70;
  const legendBaseline = chartBlockBottom + 25;
  const cacheRuleY = legendBaseline + 23;
  const cacheHeaderBaseline = cacheRuleY + 27;
  const cachePlotTop = cacheHeaderBaseline + 34;
  const cachePlotHeight = 128;
  const cachePlotBottom = hasCache
    ? cachePlotTop + cachePlotHeight
    : cacheHeaderBaseline + 26;
  const bottomRuleY = cachePlotBottom + 30;
  const bottomTop = bottomRuleY + 20;
  const projectRowCount = Math.min(4, rows.length > 3 ? 4 : rows.length);
  const bottomBlockHeight = Math.max(
    29 + projectRowCount * 29,
    29 + Math.max(1, cacheModelRows.length) * 30,
    120,
  );
  const height = bottomTop + bottomBlockHeight + 34;
  const rangeStartMs = bounds.start.getTime();
  const rangeEndMs = bounds.end.getTime();
  const requestedReportTimeMs = Number.isFinite(options.reportTimeMs)
    ? options.reportTimeMs
    : generatedAtMs;
  const reportTimeMs = Number.isFinite(requestedReportTimeMs) &&
      requestedReportTimeMs > rangeStartMs && requestedReportTimeMs < rangeEndMs
    ? requestedReportTimeMs
    : null;
  const slotWidth = plotWidth / binCount;
  const binTimeRanges = actual.bins.map((bin) => ({
    startMs: zonedMidnight(bin.startDateString, bounds.timeZone).getTime(),
    endMs: zonedMidnight(bin.endDateString, bounds.timeZone).getTime(),
  }));
  const finalBinTimeRange = binTimeRanges.at(-1);
  const partialFinalBin = Boolean(
    reportTimeMs !== null &&
      finalBinTimeRange &&
      reportTimeMs > finalBinTimeRange.startMs &&
      reportTimeMs < finalBinTimeRange.endMs,
  );
  // The x axis is made of equal calendar-period slots. On an incomplete final
  // day, stretch only the elapsed part of that slot so report time lands on
  // the right edge instead of reserving space for hours that have not happened.
  const xForTimestamp = (timestampMs) => {
    if (!(timestampMs > rangeStartMs)) return plotLeft;
    if (timestampMs >= (partialFinalBin ? reportTimeMs : rangeEndMs)) {
      return plotRight;
    }
    let binIndex = binTimeRanges.findIndex(
      (range) => timestampMs >= range.startMs && timestampMs < range.endMs,
    );
    if (binIndex < 0) {
      binIndex = timestampMs < rangeStartMs ? 0 : binCount - 1;
    }
    const range = binTimeRanges[binIndex];
    const effectiveEndMs = partialFinalBin && binIndex === binCount - 1
      ? reportTimeMs
      : range.endMs;
    const span = Math.max(1, effectiveEndMs - range.startMs);
    const ratio = Math.max(
      0,
      Math.min(1, (timestampMs - range.startMs) / span),
    );
    return plotLeft + (binIndex + ratio) * slotWidth;
  };
  const yForRemaining = (value) =>
    plotTop + (1 - Math.max(0, Math.min(100, value)) / 100) * plotHeight;
  const reportTimeX = reportTimeMs === null
    ? null
    : xForTimestamp(reportTimeMs);

  const yearLabel = bounds.endDateString.slice(0, 4);
  const history = historyScopeLabel(snapshot);
  const title = percentMode
    ? `TOKEN LEDGER · ${days}-DAY METER DRAIN`
    : `TOKEN LEDGER · ${days}-DAY TREND`;
  const subtitle = [
    `${localDateLabel(bounds.startDateString, bounds.timeZone)} – ${localDateLabel(bounds.endDateString, bounds.timeZone)}, ${yearLabel}`,
    bounds.timeZone,
    history,
  ].filter(Boolean).join(" · ");
  const headerTitleWidth = textWidth(title, 27, 800) -
    0.27 * (title.length - 1);
  const headerAvailableWidth = contentRight - outer;
  const headerMetadataFits = headerTitleWidth + textWidth(subtitle, 14) + 24 <=
    headerAvailableWidth;
  const renderedSubtitle = headerMetadataFits
    ? subtitle
    : truncateText(subtitle, headerAvailableWidth, 14);
  const description = percentMode
    ? "Dark report card: compact actual-token stat cards beside pace and runway, stacked columns of observed weekly-meter drain with an explicitly estimated per-model split, the OpenAI-reported weekly limit remaining as an amber line, a partial final day ending at report time, a compressed cache-rate-by-period strip, and top projects beside per-model cache rates."
    : hasLine
      ? "Dark report card: compact model stat cards with week-over-week delta chips beside pace and runway, stacked columns of local token volume by model with fast-mode usage in a darker shade, the OpenAI-reported weekly limit remaining as a smoothed amber line, a partial final day ending at report time, a compressed cache-rate-by-period strip, and top projects beside per-model cache rates."
      : "Dark report card: compact model stat cards with week-over-week delta chips beside pace and runway, stacked columns of local token volume by model with fast-mode usage in a darker shade, no account-wide weekly meter observation in this range, a partial final day ending at report time, a compressed cache-rate-by-period strip, and top projects beside per-model cache rates.";

  const elements = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="trend-title trend-description" data-report-mode="${percentMode ? "meter-drain" : "actual-tokens"}" data-time-domain="${partialFinalBin ? "through-report" : "full-range"}">`,
    `<title id="trend-title">${escapeXml(percentMode ? `Token Ledger · ${days}-day meter drain` : `Token Ledger · ${days}-day trend`)}</title>`,
    `<desc id="trend-description">${escapeXml(description)}</desc>`,
    `<defs><clipPath id="trend-plot-clip"><rect x="${plotLeft}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}"/></clipPath></defs>`,
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
      y: headerMetadataFits ? headerBaseline : headerBaseline + 24,
      value: renderedSubtitle,
      fill: COLORS.muted,
      size: 14,
      anchor: "end",
    }),
  ];

  const buildKpiSection = () => {
  // ---- KPI cards ----
  const cards = [];
  let meterCard = null;
  for (const { model, tokens } of modelCards) {
    const share = totalTokens > 0 ? (tokens / totalTokens) * 100 : 0;
    const priorValue = priorTotals.get(model) ?? 0;
    let chip = null;
    if (priorValue >= 1_000_000) {
      const ratio =
        (tokens / priorValue) * ((actual.scale ?? 1) / (priorActual.scale ?? 1));
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
      label: percentMode ? `${model} · tokens` : model,
      labelColor: COLORS.muted,
      value: compact(tokens),
      valueColor: COLORS.ink,
      chip,
      suffix: null,
      track: COLORS.track,
      fill: styleForModel(model),
      barPercent: share,
      caption: `${percent(share)} of ${percentMode ? "actual " : ""}tokens`,
      captionShort: percent(share),
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
      value: `${FAST_MODE_MULTIPLIER.toFixed(2)}×`,
      valueColor: COLORS.ink,
      chip: null,
      suffix: "rate",
      track: COLORS.track,
      fill: FAST_MODE_LABEL_COLOR,
      barPercent: fastShare,
      caption: `${percent(fastShare)} of tokens · darker bar shade`,
      captionShort: `${percent(fastShare)} of tokens`,
      panel: COLORS.panel,
      border: COLORS.panelBorder,
    });
  }
  if (percentMode) {
    cards.push({
      swatch: COLORS.line,
      label: "Observed drain",
      labelColor: COLORS.meterAxis,
      value: `${burn.totalPercent.toFixed(1)} pts`,
      valueColor: COLORS.line,
      chip: null,
      suffix: null,
      track: "rgba(246,183,60,.16)",
      fill: COLORS.line,
      barPercent: burn.totalPercent,
      caption: "observed total · model split estimated",
      captionShort: "model split estimated",
      panel: COLORS.panel,
      border: COLORS.panelBorder,
    });
  }
  if (hasLine && latestQuotaPoint) {
    const lastReset = resetsInRange.at(-1);
    const resetCaption = lastReset
      ? `last reset ${timestampDateLabel(lastReset.timestampMs, bounds.timeZone)}`
      : latestResetsAtSec
        ? `next reset ${timestampDateLabel(latestResetsAtSec * 1_000, bounds.timeZone)}`
        : "no reset in range";
    const meterCaption = (() => {
      if (latestQuotaReadMs === null) return resetCaption;
      const candidates = [
        `${resetCaption} · OpenAI reading ${timestampReadLabel(latestQuotaReadMs, bounds.timeZone)}`,
        `OpenAI reading · ${timestampReadLabel(latestQuotaReadMs, bounds.timeZone)}`,
        `OpenAI reading · ${timestampTimeLabel(latestQuotaReadMs, bounds.timeZone)}`,
      ];
      const available = Math.max(
        80,
        paceInnerWidth - 15 - textWidth(METER_PANEL_HEADING, 10.5) - 18,
      );
      return candidates.find((candidate) => textWidth(candidate, 10.5) <= available) ??
        `reported ${timestampTimeLabel(latestQuotaReadMs, bounds.timeZone)}`;
    })();
    meterCard = ({
      swatch: COLORS.line,
      label: "Weekly limit",
      labelColor: COLORS.meterAxis,
      value: meterLabel(latestQuotaPoint.remainingPercent),
      valueColor: COLORS.line,
      chip: null,
      suffix: "remaining",
      track: "rgba(246,183,60,.2)",
      fill: COLORS.line,
      barPercent: latestQuotaPoint.remainingPercent,
      caption: meterCaption,
      captionShort: resetCaption,
      panel: COLORS.meterPanel,
      border: COLORS.meterPanelBorder,
    });
  }
  if (cards.length) {
    // A 2x2 quad of stat cells inside one panel with hairline dividers.
    const cellWidth = quadWidth / quadColumns;
    const cellHeight = topRowHeight / quadRows;
    elements.push(svgRect(outer, cardTop, quadWidth, topRowHeight, {
      rx: 7,
      fill: COLORS.panel,
    }));
    if (quadColumns > 1) {
      const dividerX = outer + cellWidth;
      elements.push(`<line x1="${dividerX.toFixed(2)}" y1="${cardTop + 1}" x2="${dividerX.toFixed(2)}" y2="${cardTop + topRowHeight - 1}" stroke="${COLORS.panelBorder}" stroke-width="1"/>`);
    }
    if (quadRows > 1) {
      const dividerY = cardTop + cellHeight;
      elements.push(`<line x1="${outer + 1}" y1="${dividerY.toFixed(2)}" x2="${(outer + quadWidth - 1).toFixed(2)}" y2="${dividerY.toFixed(2)}" stroke="${COLORS.panelBorder}" stroke-width="1"/>`);
    }
    cards.forEach((card, index) => {
      const cellX = outer + (index % quadColumns) * cellWidth;
      const cellY = cardTop + Math.floor(index / quadColumns) * cellHeight;
      const contentX = cellX + 17;
      const innerWidth = cellWidth - 34;
      const innerRight = contentX + innerWidth;
      const labelText = card.label.toUpperCase();
      // Each corner carries something: label top-left, delta chip top-right,
      // value bottom-left, share caption bottom-right, bar along the bottom.
      elements.push(`<circle cx="${(contentX + 3.5).toFixed(2)}" cy="${(cellY + 19).toFixed(2)}" r="3.5" fill="${card.swatch}"/>`);
      elements.push(svgText({
        x: contentX + 15,
        y: cellY + 23,
        value: labelText,
        fill: card.labelColor,
        size: 10.5,
        spacing: ".9",
      }));
      const labelBaseline = cellY + 23;
      if (card.chip) {
        const chipTextWidth = textWidth(card.chip.text, 10, 700);
        const chipX = innerRight - chipTextWidth - 10;
        const labelEnd =
          contentX +
          15 +
          textWidth(labelText, 10.5) +
          Math.max(0, labelText.length - 1) * 0.9;
        if (chipX >= labelEnd + 10) {
          elements.push(svgRect(chipX, labelBaseline - 11, chipTextWidth + 10, 15, {
            rx: 3,
            fill: card.chip.fill,
          }));
          elements.push(svgText({
            x: chipX + 5,
            y: labelBaseline,
            value: card.chip.text,
            fill: card.chip.color,
            size: 10,
            weight: 700,
          }));
        }
      }
      const valueBaseline = cellY + cellHeight / 2 + 9;
      elements.push(svgText({
        x: contentX,
        y: valueBaseline,
        value: card.value,
        fill: card.valueColor,
        size: 21,
        weight: 800,
        spacing: "-0.5",
      }));
      let valueEnd = contentX + textWidth(card.value, 21, 800);
      if (card.suffix) {
        elements.push(svgText({
          x: valueEnd + 10,
          y: valueBaseline,
          value: card.suffix,
          fill: COLORS.secondary,
          size: 10.5,
        }));
        valueEnd += 10 + textWidth(card.suffix, 10.5);
      }
      const captionAvail = innerRight - valueEnd - 16;
      const caption = card.captionShort && textWidth(card.caption, 11) > captionAvail
        ? card.captionShort
        : card.caption;
      if (textWidth(caption, 11) <= captionAvail) {
        elements.push(svgText({
          x: innerRight,
          y: valueBaseline,
          value: caption,
          fill: COLORS.secondary,
          size: 11,
          anchor: "end",
        }));
      }
      const barY = cellY + cellHeight - 16;
      elements.push(svgRect(contentX, barY, innerWidth, 3, {
        rx: 1.5,
        fill: card.track,
      }));
      const fillWidth = (Math.min(100, Math.max(0, card.barPercent)) / 100) * innerWidth;
      if (fillWidth > 0) {
        elements.push(svgRect(contentX, barY, fillWidth, 3, {
          rx: 1.5,
          fill: card.fill,
        }));
      }
    });
    elements.push(svgRect(outer, cardTop, quadWidth, topRowHeight, {
      rx: 7,
      fill: "none",
      stroke: COLORS.panelBorder,
      "stroke-width": 1,
    }));
  }

  // ---- Unified weekly meter + pace panel (top right) ----
  elements.push(svgRect(pacePanelX, cardTop, pacePanelWidth, topRowHeight, {
    rx: 7,
    fill: meterCard ? meterCard.panel : COLORS.panel,
    stroke: meterCard ? meterCard.border : COLORS.panelBorder,
    "stroke-width": 1,
  }));
  const paceRight = pacePanelX + pacePanelWidth - 18;
  if (meterCard) {
    elements.push(`<circle cx="${(paceTextX + 3.5).toFixed(2)}" cy="${cardTop + 19}" r="3.5" fill="${meterCard.swatch}"/>`);
  }
  elements.push(svgText({
    x: paceTextX + (meterCard ? 15 : 0),
    y: cardTop + 23,
    value: meterCard ? METER_PANEL_HEADING : "PACE & RUNWAY",
    fill: meterCard ? meterCard.labelColor : COLORS.muted,
    size: 10.5,
    spacing: "1.2",
  }));
  if (meterCard) {
    // Provenance rides the label row; the meter reading is the headline with
    // the projected runway right-aligned beside it.
    elements.push(svgText({
      x: paceRight,
      y: cardTop + 23,
      value: meterCard.caption,
      fill: COLORS.muted,
      size: 10.5,
      anchor: "end",
    }));
    elements.push(svgText({
      x: paceTextX,
      y: cardTop + paceHeadlineBaseline,
      value: meterCard.value,
      fill: meterCard.valueColor,
      size: 28,
      weight: 800,
      spacing: "-0.6",
    }));
    elements.push(svgText({
      x: paceTextX + textWidth(meterCard.value, 28, 800) + 10,
      y: cardTop + paceHeadlineBaseline,
      value: meterCard.suffix,
      fill: COLORS.secondary,
      size: 11,
    }));
    if (paceLines.length > 1) {
      const runwayValue = paceLines[0].value;
      const runwayDetail = "left at this pace";
      const detailWidth = textWidth(runwayDetail, 11);
      elements.push(svgText({
        x: paceRight - detailWidth - 8,
        y: cardTop + paceHeadlineBaseline,
        value: runwayValue,
        fill: paceLines[0].color,
        size: 18,
        weight: 800,
        anchor: "end",
      }));
      elements.push(svgText({
        x: paceRight,
        y: cardTop + paceHeadlineBaseline,
        value: runwayDetail,
        fill: COLORS.muted,
        size: 11,
        anchor: "end",
      }));
    }
  } else {
    const paceHeadline = paceLines[0];
    elements.push(svgText({
      x: paceTextX,
      y: cardTop + paceHeadlineBaseline,
      value: paceHeadline.value,
      fill: paceHeadline.color,
      size: 26,
      weight: 800,
      spacing: "-0.52",
    }));
    elements.push(svgText({
      x: paceTextX + textWidth(paceHeadline.value, 26, 800) + 10,
      y: cardTop + paceHeadlineBaseline,
      value: paceHeadline.detail,
      fill: COLORS.muted,
      size: 12.5,
    }));
  }
  if (paceRunwayBar) {
    // Runway timeline: amber fill = days of meter left, tick = the next
    // weekly reset, both on a shared day scale.
    const scaleDays = Math.max(paceRunwayBar.runwayDays, paceRunwayBar.daysToReset) * 1.06;
    const trackY = cardTop + paceHeadlineBaseline + 12;
    elements.push(svgRect(paceTextX, trackY, paceInnerWidth, 5, {
      rx: 2.5,
      fill: "rgba(246,183,60,.14)",
    }));
    const runwayWidth = Math.min(1, paceRunwayBar.runwayDays / scaleDays) * paceInnerWidth;
    if (runwayWidth > 0) {
      elements.push(svgRect(paceTextX, trackY, runwayWidth, 5, {
        rx: 2.5,
        fill: COLORS.line,
      }));
    }
    const tickX = paceTextX +
      Math.min(1, paceRunwayBar.daysToReset / scaleDays) * paceInnerWidth;
    elements.push(`<line x1="${tickX.toFixed(2)}" y1="${trackY - 3}" x2="${tickX.toFixed(2)}" y2="${trackY + 8}" stroke="${COLORS.secondary}" stroke-width="2"/>`);
    elements.push(svgText({
      x: paceTextX,
      y: trackY + 22,
      value: "now",
      fill: COLORS.muted,
      size: 10.5,
    }));
    const resetLabel = `reset in ${paceRunwayBar.resetInLabel}`;
    const resetLabelWidth = textWidth(resetLabel, 10.5);
    const nowLabelWidth = textWidth("now", 10.5);
    const resetLabelX = Math.max(
      paceTextX + nowLabelWidth + 8 + resetLabelWidth / 2,
      Math.min(tickX, paceTextX + paceInnerWidth - resetLabelWidth / 2 - 2),
    );
    elements.push(svgText({
      x: resetLabelX,
      y: trackY + 22,
      value: resetLabel,
      fill: COLORS.muted,
      size: 10.5,
      anchor: "middle",
    }));
  }
  const paceStatLines = meterCard
    ? (paceLines.length > 1 ? paceLines.slice(1) : paceLines)
    : paceLines.slice(1);
  paceStatLines.forEach((line, index) => {
    const columnX = paceTextX + index * (paceInnerWidth / 2 + 8);
    elements.push(svgText({
      x: columnX,
      y: cardTop + paceStatValueBaseline,
      value: line.value,
      fill: line.color,
      size: 17,
      weight: 700,
    }));
    elements.push(svgText({
      x: columnX,
      y: cardTop + paceStatValueBaseline + 16,
      value: line.detail,
      fill: COLORS.muted,
      size: 11,
    }));
  });
  let paceNoteBaseline = cardTop + paceNoteStart;
  for (const line of paceNoteLines) {
    elements.push(svgText({
      x: paceTextX,
      y: paceNoteBaseline,
      value: line,
      fill: COLORS.muted,
      size: 11.5,
    }));
    paceNoteBaseline += 16;
  }

  };
  buildKpiSection();

  let hasHeldSegment = false;
  const buildChartSection = () => {
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
  elements.push(svgText({
    x: plotLeft,
    y: chartBlockTop + 18,
    value: percentMode
      ? "METER DRAIN · OBSERVED TOTAL, ESTIMATED MODEL SPLIT"
      : "TOKEN VOLUME · ACTUAL",
    fill: COLORS.leftAxis,
    size: 11.5,
    spacing: "1.25",
  }));
  if (hasLine) {
    elements.push(svgText({
      x: plotRight,
      y: chartBlockTop + 18,
      value: "WEEKLY LIMIT · OPENAI REPORTED",
      fill: COLORS.meterAxis,
      size: 11.5,
      anchor: "end",
      spacing: "1.25",
    }));
  }

  // ---- Bars ----
  const barWidth = Math.min(74, Math.max(MIN_BAR_WIDTH, slotWidth * 0.6));
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
    const segmentTotal = entries.reduce((sum, [, value]) => sum + value, 0);
    const partitionTotal = segmentTotal > 0 ? segmentTotal : binTotalOf(bin);
    const barHeight = (binTotalOf(bin) / maxBar) * plotHeight;
    let y = plotBottom;
    for (const [model, value] of entries) {
      const segmentHeight = (value / partitionTotal) * barHeight;
      y -= segmentHeight;
      if (segmentHeight <= 0.4) continue;
      const baseColor = styleForModel(model);
      const fastValue = percentMode ? 0 : (bin.fastValues?.get(model) ?? 0);
      const fastHeight = fastValue > 0 && value > 0
        ? segmentHeight * Math.min(1, fastValue / value)
        : 0;
      elements.push(svgRect(x, y, barWidth, segmentHeight - fastHeight, {
        fill: baseColor,
        "data-series": "usage-bars",
        "data-model": model,
        "data-value": value,
        "data-unit": percentMode ? "meter-points" : "tokens",
      }));
      if (fastHeight > 0.5) {
        elements.push(svgRect(x, y + segmentHeight - fastHeight, barWidth, fastHeight, {
          fill: fastShade(baseColor),
          "data-series": "usage-bars",
          "data-model": model,
          "data-value": fastValue,
          "data-unit": "tokens",
          "data-tier": "fast",
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
    const orderedCycles = [...cycles.entries()].sort(
      (left, right) => left[1][0].timestampMs - right[1][0].timestampMs,
    );

    resetMarks = resetsInRange
      .filter((reset) => reset.kind !== "start")
      .map((reset) => ({
        ...reset,
        x: xForTimestamp(Math.max(bounds.start.getTime(), reset.timestampMs)),
        label: reset.kind === "weekly-expiry"
          ? "RESET · 100%"
          : "RESTART · 100%",
      }));
    const resetByCycle = new Map(resetMarks.map((reset) => [reset.cycle, reset]));
    const resetLabels = (() => {
      const maximum = 4;
      if (resetMarks.length <= maximum) return resetMarks;
      const selected = new Map();
      const add = (reset) => {
        if (reset) selected.set(reset.cycle, reset);
      };
      const scheduled = resetMarks.filter(
        (reset) => reset.kind === "weekly-expiry",
      );
      if (scheduled.length >= maximum) {
        for (let index = 0; index < maximum; index += 1) {
          add(scheduled[Math.round((index / (maximum - 1)) * (scheduled.length - 1))]);
        }
      } else {
        scheduled.forEach(add);
        add(resetMarks[0]);
        add(resetMarks.findLast((reset) => reset.kind !== "weekly-expiry"));
        for (let index = 1; selected.size < maximum && index < resetMarks.length - 1; index += 1) {
          const candidateIndex = Math.round(
            (index / (maximum - 1)) * (resetMarks.length - 1),
          );
          add(resetMarks[candidateIndex]);
        }
      }
      return [...selected.values()]
        .sort((left, right) => left.x - right.x)
        .slice(-maximum);
    })();
    const labeledResetCycles = new Set(resetLabels.map((reset) => reset.cycle));

    for (const [cycleIndex, [cycleId, cyclePoints]] of orderedCycles.entries()) {
      const points = cyclePoints.map((point) => ({
        x: xForTimestamp(point.timestampMs),
        y: yForRemaining(point.remainingPercent),
        remainingPercent: point.remainingPercent,
        timestampMs: point.timestampMs,
      }));
      const cycleReset = resetByCycle.get(cycleId);
      if (
        cycleReset &&
        points.length &&
        cycleReset.timestampMs < points[0].timestampMs
      ) {
        points.unshift({
          x: cycleReset.x,
          y: yForRemaining(100),
          remainingPercent: 100,
          timestampMs: cycleReset.timestampMs,
          syntheticReset: true,
        });
      }

      // Keep a visual connection to a known reset boundary, but render the
      // unsampled hold as dashed instead of making it look observed.
      const nextCycleId = orderedCycles[cycleIndex + 1]?.[0];
      const nextReset = resetByCycle.get(nextCycleId);
      const lastPoint = points.at(-1);
      const resetCarry =
        nextReset &&
        lastPoint &&
        lastPoint.timestampMs < nextReset.timestampMs
          ? [lastPoint, {
              ...lastPoint,
              x: nextReset.x,
              timestampMs: nextReset.timestampMs,
              carriedToReset: true,
            }]
          : null;

      // Thin to at most one point per 2px so the path stays light while the
      // spline still follows every meaningful movement.
      const thinned = [];
      for (const point of points) {
        const { x, y } = point;
        const previous = thinned.at(-1);
        if (previous && x - previous.x < 2) {
          if (previous.syntheticReset && Math.abs(previous.y - y) > 0.5) {
            thinned.push({ ...point, x: Math.max(x, previous.x + 0.75) });
          } else {
            Object.assign(previous, point);
          }
        } else {
          thinned.push({ ...point });
        }
      }
      const path = monotonePath(thinned);
      if (path) {
        elements.push(`<path d="${path}" fill="none" stroke="${COLORS.background}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" opacity=".88" clip-path="url(#trend-plot-clip)"/>`);
        elements.push(`<path d="${path}" fill="none" stroke="${COLORS.line}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#trend-plot-clip)" data-series="weekly-meter" data-cycle="${escapeXml(cycleId)}"/>`);
        lineSegments.push(thinned);
      }
      if (resetCarry) {
        const [from, to] = resetCarry;
        const heldPath = `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} L ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
        elements.push(`<path d="${heldPath}" fill="none" stroke="${COLORS.background}" stroke-width="5.5" stroke-linecap="round" opacity=".72" clip-path="url(#trend-plot-clip)"/>`);
        elements.push(`<path d="${heldPath}" fill="none" stroke="${COLORS.line}" stroke-width="2.25" stroke-linecap="round" stroke-dasharray="5 6" opacity=".7" clip-path="url(#trend-plot-clip)" data-series="weekly-meter-held" data-reason="reset" data-cycle="${escapeXml(cycleId)}"/>`);
        lineSegments.push(resetCarry);
        hasHeldSegment = true;
      }
    }

    const latestObservedPoint = [...(trend.points ?? [])]
      .filter(
        (point) =>
          point.observed &&
          reportTimeMs !== null &&
          point.timestampMs <= reportTimeMs,
      )
      .at(-1);
    if (latestObservedPoint && reportTimeMs !== null) {
      const from = {
        x: xForTimestamp(latestObservedPoint.timestampMs),
        y: yForRemaining(latestObservedPoint.remainingPercent),
      };
      const to = { x: xForTimestamp(reportTimeMs), y: from.y };
      if (to.x - from.x >= 2) {
        const heldPath = `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} L ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
        elements.push(`<path d="${heldPath}" fill="none" stroke="${COLORS.background}" stroke-width="5.5" stroke-linecap="round" opacity=".72" clip-path="url(#trend-plot-clip)"/>`);
        elements.push(`<path d="${heldPath}" fill="none" stroke="${COLORS.line}" stroke-width="2.25" stroke-linecap="round" stroke-dasharray="5 6" opacity=".7" clip-path="url(#trend-plot-clip)" data-series="weekly-meter-held" data-reason="report-time"/>`);
        lineSegments.push([from, to]);
        hasHeldSegment = true;
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
        cycle: point.cycle,
      });
    }
    for (const dot of binDots) {
      elements.push(`<circle cx="${dot.x.toFixed(2)}" cy="${dot.y.toFixed(2)}" r="3.5" fill="${COLORS.line}" stroke="${COLORS.background}" stroke-width="1.5"/>`);
    }

    // Stagger dense reset labels across lanes: a label joins the first lane
    // whose previous label sits far enough to its left.
    const laneRight = [];
    for (const reset of resetMarks) {
      const resetBinIndex = Math.max(
        0,
        Math.min(binCount - 1, Math.floor((reset.x - plotLeft) / slotWidth)),
      );
      const resetBar = barGeometry[resetBinIndex];
      const crossesBar = resetBar &&
        reset.x >= resetBar.x - 2 &&
        reset.x <= resetBar.x + barWidth + 2;
      const resetLineBottom = crossesBar
        ? Math.max(plotTop + 36, resetBar.topY - 8)
        : plotBottom;
      elements.push(`<line x1="${reset.x.toFixed(2)}" y1="${plotTop}" x2="${reset.x.toFixed(2)}" y2="${resetLineBottom.toFixed(2)}" stroke="rgba(246,183,60,.48)" stroke-width="1.5" stroke-dasharray="5 6"/>`);
      if (!labeledResetCycles.has(reset.cycle)) continue;
      const labelWidth = textWidth(reset.label, 11, 700) + 14;
      const labelCenterX = Math.max(
        plotLeft + labelWidth / 2,
        Math.min(plotRight - labelWidth / 2, reset.x),
      );
      const labelLeft = labelCenterX - labelWidth / 2;
      let lane = laneRight.findIndex((right) => labelLeft - right >= 8);
      if (lane < 0) {
        lane = laneRight.length < 3
          ? laneRight.length
          : laneRight.indexOf(Math.min(...laneRight));
      }
      laneRight[lane] = labelCenterX + labelWidth / 2;
      const labelBaseline = plotTop + 20 + lane * 21;
      elements.push(svgRect(
        labelCenterX - labelWidth / 2,
        labelBaseline - 14,
        labelWidth,
        19,
        {
          rx: 5,
          fill: COLORS.background,
          stroke: "rgba(246,183,60,.42)",
          "stroke-width": 1,
        },
      ));
      elements.push(svgText({
        x: labelCenterX,
        y: labelBaseline,
        value: reset.label,
        fill: COLORS.line,
        size: 11,
        weight: 700,
        anchor: "middle",
        mono: true,
      }));
    }

    // Keep the line readable with no more than two decision-useful labels:
    // the first reading after the latest reset (or the range start when no
    // reset exists) and the latest reading.
    const picked = [];
    const latestReset = resetMarks.at(-1);
    if (latestReset) {
      const afterReset = binDots.find((dot) => dot.x > latestReset.x + 2);
      if (afterReset) picked.push(afterReset);
    } else if (binDots.length) {
      picked.push(binDots[0]);
    }
    if (binDots.length > 1) picked.push(binDots.at(-1));
    const uniquePicks = [...new Map(picked.map((dot) => [dot.binIndex, dot])).values()];
    pills = uniquePicks.map((dot, pickIndex) => {
      const label = meterLabel(dot.remainingPercent);
      const pillWidth = textWidth(label, 12, 700) + 18;
      const preferLeft = pickIndex === uniquePicks.length - 1 ||
        dot.x + pillWidth + 16 > plotRight;
      let x = preferLeft ? dot.x - pillWidth - 13 : dot.x + 13;
      x = Math.max(plotLeft + 3, Math.min(plotRight - pillWidth - 3, x));
      let y = dot.y - 32;
      if (y < plotTop + 7) y = dot.y + 11;
      y = Math.max(plotTop + 7, Math.min(plotBottom - 31, y));
      return {
        x,
        y,
        w: pillWidth,
        h: 24,
        tx: x + pillWidth / 2,
        ty: y + 16,
        label,
        dotX: dot.x,
        dotY: dot.y,
      };
    });
  }

  if (reportTimeX !== null) {
    elements.push(`<line x1="${reportTimeX.toFixed(2)}" y1="${plotTop}" x2="${reportTimeX.toFixed(2)}" y2="${plotBottom}" stroke="${COLORS.muted}" stroke-width="1.25" stroke-dasharray="4 5" opacity=".72" data-marker="report-time"/>`);
    elements.push(svgText({
      x: reportTimeX - 7,
      y: plotTop - 8,
      value: `AS OF ${timestampTimeLabel(reportTimeMs, bounds.timeZone).toUpperCase()}`,
      fill: COLORS.muted,
      size: 10.5,
      weight: 700,
      anchor: "end",
      spacing: ".55",
    }));
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
      if (partialFinalBin && binIndex === binCount - 1) {
        elements.push(svgText({
          x: centerX,
          y: plotBottom + 70,
          value: `PARTIAL · THROUGH ${timestampTimeLabel(reportTimeMs, bounds.timeZone).toUpperCase()}`,
          fill: COLORS.muted,
          size: 10.5,
          weight: 700,
          anchor: "middle",
          spacing: ".45",
        }));
      }
    }
  }
  for (const pill of pills) {
    const leaderX = pill.x > pill.dotX ? pill.x : pill.x + pill.w;
    const leaderY = Math.max(pill.y + 6, Math.min(pill.y + pill.h - 6, pill.dotY));
    elements.push(`<line x1="${pill.dotX.toFixed(2)}" y1="${pill.dotY.toFixed(2)}" x2="${leaderX.toFixed(2)}" y2="${leaderY.toFixed(2)}" stroke="rgba(246,183,60,.58)" stroke-width="1"/>`);
    elements.push(svgRect(pill.x, pill.y, pill.w, pill.h, {
      rx: 5,
      fill: COLORS.background,
      stroke: COLORS.line,
      "stroke-width": 1,
    }));
    elements.push(svgText({
      x: pill.tx,
      y: pill.ty,
      value: pill.label,
      fill: COLORS.line,
      size: 12,
      weight: 700,
      anchor: "middle",
      mono: true,
    }));
  }

  };
  buildChartSection();

  const buildLegendAndCacheSection = () => {
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
    if (hasHeldSegment) {
      legendItem(
        `<line x1="${legendX}" y1="${legendBaseline - 5}" x2="${legendX + 17}" y2="${legendBaseline - 5}" stroke="${COLORS.line}" stroke-width="3"/><line x1="${legendX + 25}" y1="${legendBaseline - 5}" x2="${legendX + 42}" y2="${legendBaseline - 5}" stroke="${COLORS.line}" stroke-width="2.25" stroke-dasharray="5 5" opacity=".7"/>`,
        42,
        "Limit: reported / awaiting update",
      );
    } else {
      legendItem(
        svgRect(legendX, legendBaseline - 6, 20, 3, { fill: COLORS.line }),
        20,
        "OpenAI weekly-limit reading",
      );
    }
  }

  // ---- Cache rate by period (compressed strip) ----
  elements.push(`<line x1="${outer}" y1="${cacheRuleY}" x2="${contentRight}" y2="${cacheRuleY}" stroke="${COLORS.rule}" stroke-width="1"/>`);
  elements.push(svgText({
    x: outer,
    y: cacheHeaderBaseline,
    value: "CACHE RATE BY PERIOD",
    fill: COLORS.muted,
    size: 12,
    spacing: "1.32",
  }));
  if (hasCache) {
    const cacheLegendItems = [
      { swatch: COLORS.cached, label: "Cached" },
      { swatch: COLORS.uncached, label: "Uncached" },
      {
        swatch: null,
        label: `${percent(cacheData.rate)} weighted · ${compact(cacheData.cachedInputTokens)} of ${compact(cacheData.inputTokens)} input cached`,
      },
    ];
    let cacheLegendX = contentRight - cacheLegendItems.reduce(
      (sum, item) =>
        sum + (item.swatch ? 20 : 0) + textWidth(item.label, 12.5) + 18,
      -18,
    );
    for (const item of cacheLegendItems) {
      if (item.swatch) {
        elements.push(svgRect(cacheLegendX, cacheHeaderBaseline - 10, 13, 11, {
          rx: 2,
          fill: item.swatch,
        }));
        cacheLegendX += 20;
      }
      elements.push(svgText({
        x: cacheLegendX,
        y: cacheHeaderBaseline,
        value: item.label,
        fill: COLORS.muted,
        size: 12.5,
      }));
      cacheLegendX += textWidth(item.label, 12.5) + 18;
    }
    for (const value of [100, 50, 0]) {
      const y = cachePlotBottom - (value / 100) * cachePlotHeight;
      elements.push(`<line x1="${plotLeft}" y1="${y.toFixed(2)}" x2="${plotRight}" y2="${y.toFixed(2)}" stroke="${value === 0 ? COLORS.baseline : COLORS.grid}" stroke-width="1"/>`);
      elements.push(svgText({
        x: plotLeft - 14,
        y: y + 4,
        value: `${value}%`,
        fill: COLORS.muted,
        size: 11.5,
        anchor: "end",
        mono: true,
      }));
    }
    const cacheSlotWidth = plotWidth / cacheData.binCount;
    const cacheBarWidth = Math.min(
      74,
      Math.max(MIN_BAR_WIDTH, cacheSlotWidth * 0.6),
    );
    const showCacheRateLabels = cacheSlotWidth >= 46 && cacheData.binCount <= 20;
    cacheData.bins.forEach((bin, binIndex) => {
      const centerX = plotLeft + (binIndex + 0.5) * cacheSlotWidth;
      const barX = centerX - cacheBarWidth / 2;
      if (Number.isFinite(bin.rate)) {
        elements.push(svgRect(barX, cachePlotTop, cacheBarWidth, cachePlotHeight, {
          rx: 3,
          fill: COLORS.uncached,
          opacity: ".88",
        }));
        const cachedHeight = cachePlotHeight * (bin.rate / 100);
        if (cachedHeight > 0) {
          elements.push(svgRect(
            barX,
            cachePlotBottom - cachedHeight,
            cacheBarWidth,
            cachedHeight,
            { rx: 2, fill: COLORS.cached },
          ));
        }
        if (showCacheRateLabels) {
          elements.push(svgText({
            x: centerX,
            y: cachePlotTop - 9,
            value: percent(bin.rate),
            fill: COLORS.secondary,
            size: 11.5,
            weight: 700,
            anchor: "middle",
            mono: true,
          }));
        }
      } else {
        // No measured input this period: an empty track with a midline dash.
        elements.push(svgRect(barX, cachePlotTop, cacheBarWidth, cachePlotHeight, {
          rx: 3,
          fill: COLORS.cacheTrack,
          stroke: COLORS.baseline,
          "stroke-width": 1,
        }));
        elements.push(`<line x1="${(barX + 5).toFixed(2)}" y1="${cachePlotTop + cachePlotHeight / 2}" x2="${(barX + cacheBarWidth - 5).toFixed(2)}" y2="${cachePlotTop + cachePlotHeight / 2}" stroke="${COLORS.muted}" stroke-width="1"/>`);
      }
    });
    if (Number.isFinite(cacheData.rate)) {
      const lineY = cachePlotBottom - (cacheData.rate / 100) * cachePlotHeight;
      elements.push(`<line x1="${plotLeft}" y1="${lineY.toFixed(2)}" x2="${plotRight}" y2="${lineY.toFixed(2)}" stroke="${COLORS.weighted}" stroke-width="1.6" stroke-dasharray="6 5"/>`);
      elements.push(svgText({
        x: plotRight + 8,
        y: lineY + 4,
        value: percent(cacheData.rate),
        fill: COLORS.weighted,
        size: 11.5,
        weight: 700,
        mono: true,
      }));
    }
  } else {
    elements.push(svgText({
      x: outer,
      y: cacheHeaderBaseline + 24,
      value: "No events with a usable input-token breakdown in this range.",
      fill: COLORS.secondary,
      size: 13,
    }));
  }

  };
  buildLegendAndCacheSection();

  const buildDestinationSection = () => {
  // ---- Top projects + cache rate by model ----
  elements.push(`<line x1="${outer}" y1="${bottomRuleY}" x2="${contentRight}" y2="${bottomRuleY}" stroke="${COLORS.rule}" stroke-width="1"/>`);
  const sectionBaseline = bottomTop + 10;
  const columnGap = 28;
  const modelColumnWidth = Math.min(
    368,
    Math.max(300, contentWidth * 0.32),
  );
  const leftColumnWidth =
    contentWidth - columnGap - 28 - modelColumnWidth;
  const leftColumnRight = outer + leftColumnWidth;
  const dividerX = leftColumnRight + columnGap;
  const modelColumnX = dividerX + 28;

  const projectHeader = "WHERE IT WENT · TOP PROJECTS";
  elements.push(svgText({
    x: outer,
    y: sectionBaseline,
    value: projectHeader,
    fill: COLORS.muted,
    size: 12,
    spacing: "1.32",
  }));
  const topRows = rows.slice(0, 3);
  const restRows = rows.slice(3);
  const topTokens = topRows.reduce(
    (sum, row) => checkedTokenAdd(sum, row.totalTokens, {
      allowFractional: true,
    }),
    0,
  );
  const topShare = totalTokens > 0
    ? percent((topTokens / totalTokens) * 100)
    : "—";
  const fullProjectSummary = `${rows.length} ${rows.length === 1 ? "project" : "projects"} active · top ${topRows.length} = ${topShare} of tokens`;
  const shortProjectSummary = `top ${topRows.length} = ${topShare}`;
  const projectHeaderWidth =
    textWidth(projectHeader, 12) +
    Math.max(0, projectHeader.length - 1) * 1.32;
  const projectSummary = textWidth(fullProjectSummary, 12.5) <=
      leftColumnRight - outer - projectHeaderWidth - 16
    ? fullProjectSummary
    : shortProjectSummary;
  elements.push(svgText({
    x: leftColumnRight,
    y: sectionBaseline,
    value: projectSummary,
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
      tokens: restRows.reduce(
        (sum, row) => checkedTokenAdd(sum, row.totalTokens, {
          allowFractional: true,
        }),
        0,
      ),
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
  const projectNameWidth = projectBarX - nameX - rowGap;
  displayRows.forEach((row, index) => {
    const centerY = bottomTop + 29 + index * 29 + 9;
    const projectName = truncateText(
      row.name,
      projectNameWidth,
      15,
      row.muted ? 400 : 700,
    );
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
      value: projectName,
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

  elements.push(`<line x1="${dividerX}" y1="${bottomTop}" x2="${dividerX}" y2="${bottomTop + bottomBlockHeight}" stroke="${COLORS.rule}" stroke-width="1"/>`);
  elements.push(svgText({
    x: modelColumnX,
    y: sectionBaseline,
    value: "CACHE RATE BY MODEL",
    fill: COLORS.muted,
    size: 12,
    spacing: "1.32",
  }));
  if (cacheModelRows.length === 0) {
    elements.push(svgText({
      x: modelColumnX,
      y: bottomTop + 29 + 14,
      value: "No measured input to break out.",
      fill: COLORS.secondary,
      size: 13,
    }));
  }
  const compactModelColumns = modelColumnWidth < 340;
  const modelLabelSize = compactModelColumns ? 12.5 : 13.5;
  const modelRateSize = compactModelColumns ? 11.5 : 12.5;
  const widestModelLabel = cacheModelRows.reduce(
    (width, model) => Math.max(
      width,
      textWidth(model.model, modelLabelSize, 700),
    ),
    0,
  );
  const minimumRateRight =
    modelColumnX +
    18 +
    widestModelLabel +
    8 +
    textWidth("100.0%", modelRateSize, 700);
  const modelRateRight = Math.max(
    modelColumnX + modelColumnWidth * 0.42,
    minimumRateRight,
  );
  const modelBarX = modelRateRight + 15;
  const modelInputReserve = Math.min(
    58,
    Math.max(48, modelColumnWidth * 0.16),
  );
  const modelBarWidth = contentRight - modelInputReserve - modelBarX;
  cacheModelRows.forEach((model, index) => {
    const centerY = bottomTop + 29 + index * 30 + 9;
    if (!model.muted) {
      elements.push(`<circle cx="${(modelColumnX + 5).toFixed(2)}" cy="${centerY}" r="4" fill="${styleForModel(model.model)}"/>`);
    }
    elements.push(svgText({
      x: modelColumnX + 18,
      y: centerY + 4,
      value: model.model,
      fill: model.muted ? COLORS.muted : COLORS.ink,
      size: modelLabelSize,
      weight: model.muted ? 400 : 700,
    }));
    elements.push(svgText({
      x: modelRateRight,
      y: centerY + 4,
      value: percent(model.rate),
      fill: COLORS.secondary,
      size: modelRateSize,
      weight: 700,
      anchor: "end",
      mono: true,
    }));
    elements.push(svgRect(modelBarX, centerY - 5, modelBarWidth, 10, {
      rx: 3,
      fill: COLORS.uncached,
      opacity: ".7",
    }));
    const rateFill = Number.isFinite(model.rate)
      ? modelBarWidth * (model.rate / 100)
      : 0;
    if (rateFill > 0) {
      elements.push(svgRect(modelBarX, centerY - 5, rateFill, 10, {
        rx: 3,
        fill: COLORS.cached,
      }));
    }
    elements.push(svgText({
      x: contentRight,
      y: centerY + 4,
      value: compact(model.inputTokens),
      fill: COLORS.secondary,
      size: 12.5,
      weight: 700,
      anchor: "end",
      mono: true,
    }));
  });

  };
  buildDestinationSection();

  elements.push("</svg>");
  return elements.join("\n");
}

export async function writeTrendPng(svg, outputPath) {
  const { default: sharp } = await import("sharp");
  await sharp(Buffer.from(svg, "utf8")).png().toFile(outputPath);
}
