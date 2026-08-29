import { Buffer } from "node:buffer";

import sharp from "sharp";

import { buildBurnDayBins, buildUsageTrend } from "./token-ledger-trend.mjs";
import { chooseBinSize } from "./token-ledger-trend-terminal.mjs";
import {
  calculateCodexPurchasedCredits,
  codexCreditMultiplier,
  isFastServiceTier,
} from "../lib/token-ledger-rates.mjs";
import {
  compact,
  escapeXml,
  fastShade,
  shiftCalendarDate,
  svgRect,
  svgText,
  textWidth,
  truncateText,
  TREND_IMAGE_MODEL_COLORS,
} from "./token-ledger-image-primitives.mjs";
import {
  buildTrendReportViewModel,
  zonedMidnight,
} from "./token-ledger-report-data.mjs";
import {
  sourceStatusLabel,
  sourceStatusLine,
} from "./token-ledger-source-status.mjs";

export {
  compact,
  escapeXml,
  fastShade,
  shiftCalendarDate,
  svgRect,
  svgText,
  textWidth,
  truncateText,
  TREND_IMAGE_MODEL_COLORS,
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
  "Unattributed",
];

const COLORS = {
  background: "#0e1420",
  panel: "#151d2c",
  panelBorder: "#273246",
  separator: "rgba(119,131,154,.22)",
  meterPanel: "#1b1712",
  meterPanelBorder: "rgba(246,183,60,.4)",
  ink: "#f2f5fa",
  secondary: "#aeb8c9",
  muted: "#77839a",
  grid: "#1c2534",
  baseline: "#33405a",
  track: "rgba(255,255,255,.09)",
  projectTrack: "rgba(255,255,255,.07)",
  line: "#f6b73c",
  meterAxis: "#cf9a37",
  leftAxis: "#7ea2f0",
  cache: "#22c58f",
  uncached: "#b0483f",
  deltaUp: "#7fb37a",
  deltaDown: "#e08a86",
  warn: "#f0a35e",
  remainderBar: "#475569",
  onFill: "rgba(255,255,255,.82)",
};

const FAST_MODE_LABEL_COLOR = "#a78bfa";
const MIN_BAR_WIDTH = 26;

function pct(value) {
  if (!Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.05) return "<0.1%";
  return `${value.toFixed(1)}%`;
}

// Meter percentages read as whole numbers when they are whole ("0%", "62%").
function meterPct(value) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 0.05) return `${rounded}%`;
  return `${value.toFixed(1)}%`;
}

// Advance width of a letter-spaced label; SVG letter-spacing adds per glyph.
function spacedWidth(text, size, weight, spacing) {
  return textWidth(text, size, weight) + (Number(spacing) || 0) * String(text).length;
}

function deltaLabel(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}%`;
}

function approximateLabel(value, estimated) {
  return estimated && value !== "—" ? `≈${value}` : value;
}

function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const hours = ms / 3_600_000;
  if (hours >= 36) return `${Math.round(ms / 86_400_000)} days`;
  if (hours >= 21) return "1 day";
  return `${Math.max(1, Math.round(hours))} ${Math.max(1, Math.round(hours)) === 1 ? "hour" : "hours"}`;
}

// Source-bin resolution is evidence about aggregation precision, so preserve
// it exactly instead of applying the intentionally coarse meter-duration
// labels above. Stored resolutions are whole seconds, with adaptive bins
// normally landing on whole minutes, hours, or days.
function sourceResolutionLabel(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const units = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [unitSeconds, unit] of units) {
    if (seconds % unitSeconds !== 0) continue;
    const count = seconds / unitSeconds;
    return `${count} ${unit}${count === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function fastRateSummary(snapshot, bounds, effectiveEndMs, events = null) {
  let standardCardCredits = 0;
  let fastCardCredits = 0;
  let unratedTokens = 0;
  const multipliers = new Set();
  const sourceEvents = events ?? snapshot.events ?? [];
  for (const event of sourceEvents) {
    const timestampMs = new Date(event?.timestamp).getTime();
    if (
      !Number.isFinite(timestampMs) ||
      timestampMs < bounds.start.getTime() ||
      timestampMs >= effectiveEndMs ||
      !isFastServiceTier(event?.serviceTier)
    ) {
      continue;
    }
    const tokens = Math.max(0, Number(event.totalTokens) || 0);
    const model = event.rateCardModel ?? event.model;
    const multiplier = codexCreditMultiplier(model, event.serviceTier);
    const standardCredits = calculateCodexPurchasedCredits({
      model,
      serviceTier: null,
      usage: event,
    });
    const fastCredits = calculateCodexPurchasedCredits({
      model,
      serviceTier: event.serviceTier,
      usage: event,
    });
    if (
      multiplier === null ||
      !Number.isFinite(standardCredits) ||
      !(standardCredits > 0) ||
      !Number.isFinite(fastCredits)
    ) {
      unratedTokens += tokens;
      continue;
    }
    standardCardCredits += standardCredits;
    fastCardCredits += fastCredits;
    multipliers.add(multiplier);
  }
  const sortedMultipliers = [...multipliers].sort((left, right) => left - right);
  return {
    unratedTokens,
    effectiveMultiplier: standardCardCredits > 0
      ? fastCardCredits / standardCardCredits
      : null,
    minimumMultiplier: sortedMultipliers[0] ?? null,
    maximumMultiplier: sortedMultipliers.at(-1) ?? null,
    mixedMultipliers: sortedMultipliers.length > 1,
  };
}

// Darker step of the same hue; retained for terminal parity and callers that
// still shade fast-mode swatches (the report itself uses the hatch pattern).
// Ceiling scale for the daily chart. Tighter than 1–2–5 so a 2.39B peak lands
// on a 3.00B axis instead of 5.00B.
const NICE_CEILING_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
export function reportCeiling(value) {
  if (!(value > 0)) return 1;
  const target = value * 1.12;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const normalized = target / magnitude;
  const step =
    NICE_CEILING_STEPS.find((candidate) => normalized <= candidate) ?? 10;
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

function truncateToWidth(text, maxWidth, size, weight = 400) {
  const value = String(text);
  if (textWidth(value, size, weight) <= maxWidth) return value;
  let kept = value;
  while (kept.length > 1 && textWidth(`${kept}…`, size, weight) > maxWidth) {
    kept = kept.slice(0, -1);
  }
  return `${kept.trimEnd()}…`;
}

function svgLine(x1, y1, x2, y2, attrs = {}) {
  const pieces = [
    `x1="${Number(x1).toFixed(2)}"`,
    `y1="${Number(y1).toFixed(2)}"`,
    `x2="${Number(x2).toFixed(2)}"`,
    `y2="${Number(y2).toFixed(2)}"`,
  ];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    pieces.push(`${key}="${value}"`);
  }
  return `<line ${pieces.join(" ")}/>`;
}

function chip(x, y, label, { fill, stroke, color, size = 11.5, weight = 700, anchor = "start", mono = false }) {
  const width = textWidth(label, size, weight) + 14;
  const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
  return {
    width,
    markup: [
      svgRect(left, y - 13, width, 19, {
        rx: 4,
        fill: fill ?? "none",
        stroke: stroke ?? null,
        "stroke-width": stroke ? 1 : null,
      }),
      svgText({ x: left + 7, y: y + 1, value: label, fill: color, size, weight, mono }),
    ].join("\n"),
  };
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

function timeOnlyLabel(timestampMs, timeZone) {
  if (!Number.isFinite(timestampMs)) return "unknown time";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}

function binDateLabel(bin, timeZone) {
  const start = localDateLabel(bin.startDateString, timeZone);
  const lastDate = bin.lastDateString;
  if (lastDate === bin.startDateString) return start;
  return `${start}–${localDateLabel(lastDate, timeZone).replace(/^[A-Za-z]+ /, "")}`;
}

function labelEvery(binCount) {
  if (binCount <= 14) return 1;
  if (binCount <= 20) return 2;
  return 3;
}

// Merge the view model's per-day rows into multi-day bins for narrow layouts.
function binDailyRows(daily, binSize) {
  const bins = [];
  for (let index = 0; index < daily.length; index += binSize) {
    const rows = daily.slice(index, index + binSize);
    const models = new Map();
    for (const row of rows) {
      for (const dayModel of row.models) {
        const merged = models.get(dayModel.model) ?? {
          model: dayModel.model,
          totalTokens: 0,
          normalTokens: 0,
          fastTokens: 0,
          estimated: false,
        };
        merged.totalTokens += dayModel.totalTokens;
        merged.normalTokens += dayModel.normalTokens;
        merged.fastTokens += dayModel.fastTokens;
        merged.estimated ||= dayModel.estimated === true;
        models.set(dayModel.model, merged);
      }
    }
    bins.push({
      startDateString: rows[0].dateString,
      lastDateString: rows.at(-1).dateString,
      totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      cachedInputTokens: rows.reduce(
        (sum, row) => sum + row.cachedInputTokens,
        0,
      ),
      modelCalls: rows.reduce((sum, row) => sum + row.modelCalls, 0),
      estimated: rows.some((row) => row.estimated),
      partial: rows.some((row) => row.partial),
      unobserved: rows.every((row) => row.observed === false),
      models: [...models.values()].sort(
        (left, right) => modelSort(left.model, right.model),
      ),
    });
  }
  return bins;
}

export function renderTrendImage({
  snapshot,
  bounds,
  trend = null,
  days = bounds.rangeDays ?? 7,
  options = {},
  projectRows = null,
  viewModel = null,
  reportTimeMs = null,
  sourceStatus = null,
  analysis = null,
  reportEvents = null,
}) {
  const width = Math.max(900, Math.min(2_400, Number(options.imageWidth) || 1_280));
  const outer = 28;
  const contentRight = width - outer;
  const contentWidth = width - outer * 2;
  const wide = width >= 1_100;

  const effectiveReportTimeMs = Number.isFinite(reportTimeMs)
    ? reportTimeMs
    : Number.isFinite(options.reportTimeMs)
      ? options.reportTimeMs
      : null;
  const effectiveSourceStatus = sourceStatus ?? options.sourceStatus ??
    "verified-current";
  const vm = viewModel ?? buildTrendReportViewModel({
    snapshot,
    bounds,
    days,
    reportTimeMs: effectiveReportTimeMs,
    sourceStatus: effectiveSourceStatus,
    projectRows,
    events: analysis?.currentEvents ?? null,
    priorEvents: analysis?.priorEvents ?? null,
  });
  const { summary, meter, meta } = vm;
  const timeZone = meta.timeZone;
  const stale = meta.sourceStatus === "stale-fallback";
  const verified = meta.sourceStatus === "verified-current";
  const fastRates = fastRateSummary(
    snapshot,
    bounds,
    meta.effectiveEndMs,
    reportEvents ?? analysis?.currentEvents,
  );
  const componentsComplete = vm.coverage.componentCoveragePercent >= 99.95;
  const rateCardMismatch = Boolean(
    vm.provenance.snapshotRateCardAsOf &&
      vm.provenance.snapshotRateCardAsOf !== vm.provenance.rateCardAsOf,
  );

  // Drain mode swaps the main chart to observed meter-drain columns; every
  // other panel keeps actual-token semantics.
  const drainTrend = options.drain
    ? trend ?? buildUsageTrend(snapshot, bounds)
    : null;

  const elements = [];
  const defs = [
    "<defs>",
    // Fast-mode tokens keep the model color and add this hatch so they stay
    // visible in grayscale without inventing extra bar height.
    '<pattern id="fast-mode-hatch" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">',
    '<line x1="0" y1="0" x2="0" y2="7" stroke="rgba(255,255,255,.75)" stroke-width="2"/>',
    "</pattern>",
    "</defs>",
  ].join("\n");

  // ---------------------------------------------------------------- header
  function buildHeaderSection() {
    const yearLabel = meta.endDateString.slice(0, 4);
    const title = `TOKEN LEDGER · ${meta.rangeDays}-DAY TREND`;
    const subtitle = [
      `${localDateLabel(meta.startDateString, timeZone)} – ${localDateLabel(meta.endDateString, timeZone)}, ${yearLabel}`,
      timeZone,
      vm.provenance.historyScope,
    ].filter(Boolean).join(" · ");
    elements.push(svgText({
      x: outer,
      y: 46,
      value: title,
      size: 26,
      weight: 800,
      spacing: "-0.26",
    }));
    // The subtitle sits beside the title when the right-hand provenance block
    // leaves room; otherwise it wraps beneath the title.
    const subtitleX = outer + textWidth(title, 26, 800) + 18;
    const subtitleInline =
      subtitleX + textWidth(subtitle, 13.5) < contentRight - 270;
    elements.push(svgText({
      x: subtitleInline ? subtitleX : outer,
      y: subtitleInline ? 46 : 68,
      value: subtitle,
      fill: COLORS.muted,
      size: 13.5,
    }));

    const generatedLabel = shortDateTimeLabel(
      vm.provenance.snapshotGeneratedAtMs,
      timeZone,
    );
    const throughLine = verified
      ? `Report through ${shortDateTimeLabel(meta.reportThroughMs, timeZone)}`
      : `Snapshot generated ${generatedLabel}`;
    const provenanceBadge = chip(
      contentRight,
      32,
      sourceStatusLine(meta.sourceStatus),
      {
        fill: verified
          ? "rgba(255,255,255,.06)"
          : "rgba(246,183,60,.16)",
        stroke: verified ? COLORS.separator : COLORS.line,
        color: verified ? COLORS.secondary : COLORS.line,
        anchor: "end",
      },
    );
    elements.push(provenanceBadge.markup);
    elements.push(svgText({
      x: contentRight,
      y: 51,
      value: throughLine,
      fill: COLORS.secondary,
      size: 12.5,
      anchor: "end",
    }));
    elements.push(svgText({
      x: contentRight,
      y: 69,
      value: meter.lastObservedAtMs !== null
        ? `Meter last observed ${shortDateTimeLabel(meter.lastObservedAtMs, timeZone)}`
        : "No weekly meter observation",
      fill: COLORS.muted,
      size: 12.5,
      anchor: "end",
    }));
    return 82;
  }

  // Material trust conditions stay compact and disappear entirely for a
  // healthy local/current/exact report. Each chip contains the actual scope or
  // count so the warning remains useful even when the PNG is viewed alone.
  function buildIntegrityWarnings(top) {
    const warnings = [];
    if (vm.coverage.parseErrors > 0) {
      warnings.push({
        kind: "parse-errors",
        label: `${vm.coverage.parseErrors.toLocaleString("en-US")} UNPARSED SOURCE ${vm.coverage.parseErrors === 1 ? "RECORD" : "RECORDS"}`,
      });
    }
    if (vm.coverage.invalidTokenRecords > 0) {
      warnings.push({
        kind: "invalid-token-records",
        label: `${vm.coverage.invalidTokenRecords.toLocaleString("en-US")} INVALID TOKEN ${vm.coverage.invalidTokenRecords === 1 ? "RECORD" : "RECORDS"} EXCLUDED`,
      });
    }
    if (vm.coverage.invalidQuotaRecords > 0) {
      warnings.push({
        kind: "invalid-quota-records",
        label: `${vm.coverage.invalidQuotaRecords.toLocaleString("en-US")} INVALID QUOTA ${vm.coverage.invalidQuotaRecords === 1 ? "RECORD" : "RECORDS"} EXCLUDED`,
      });
    }
    if (vm.coverage.sourceIncomplete) {
      warnings.push({
        kind: "source-incomplete",
        label: "INCOMPLETE SOURCE PROVENANCE",
      });
    }
    if (!componentsComplete) {
      warnings.push({
        kind: "component-coverage",
        label: `${meterPct(vm.coverage.componentCoveragePercent)} COMPONENT COVERAGE`,
      });
    }
    if (!vm.provenance.localOnly) {
      warnings.push({ kind: "external-source", label: "EXTERNAL SNAPSHOT INPUT" });
    }
    if (!verified) {
      const label = sourceStatusLabel(meta.sourceStatus);
      warnings.push({ kind: "source-status", label });
    }
    if (vm.coverage.estimated) {
      const resolution = vm.coverage.maximumResolutionSeconds
        ? ` · ${sourceResolutionLabel(vm.coverage.maximumResolutionSeconds)} SOURCE BINS`
        : "";
      warnings.push({
        kind: "estimated-history",
        label: `≈ ESTIMATED HISTORY${resolution}`,
      });
    }
    const legacyStatusLabel = new Map([
      ["collection-scope-unverified", "SCOPE UNVERIFIED"],
      ["codex-home-unverified", "HOME UNVERIFIED"],
      ["codex-home-mismatch", "HOME MISMATCH"],
    ]).get(vm.coverage.legacySnapshotStatus);
    if (legacyStatusLabel) {
      warnings.push({
        kind: "legacy-history",
        label: `LEGACY HISTORY SKIPPED · ${legacyStatusLabel}`,
      });
    }
    if (rateCardMismatch) {
      warnings.push({
        kind: "rate-card-mismatch",
        label: `RATE CARD ${vm.provenance.snapshotRateCardAsOf} → ${vm.provenance.rateCardAsOf}`,
      });
    }
    if (!warnings.length) return top;

    const gap = 8;
    const rowHeight = 28;
    let x = outer;
    let baseline = top + 14;
    for (const warning of warnings) {
      const item = chip(x, baseline, warning.label, {
        fill: "rgba(240,163,94,.10)",
        stroke: "rgba(240,163,94,.55)",
        color: COLORS.warn,
        size: 10.5,
      });
      if (x > outer && x + item.width > contentRight) {
        x = outer;
        baseline += rowHeight;
      }
      const placed = chip(x, baseline, warning.label, {
        fill: "rgba(240,163,94,.10)",
        stroke: "rgba(240,163,94,.55)",
        color: COLORS.warn,
        size: 10.5,
      });
      elements.push(
        `<g data-role="integrity-warning" data-kind="${warning.kind}">${placed.markup}</g>`,
      );
      x += placed.width + gap;
    }
    return baseline + 9;
  }

  // -------------------------------------------------------------- KPI cards
  function compactCards() {
    const cards = [];
    cards.push({
      accent: COLORS.leftAxis,
      label: "TOTAL USAGE",
      value: approximateLabel(compact(summary.totalTokens), summary.estimated),
      unit: "tokens",
      sub: summary.totalDeltaPercent !== null
        ? {
            text: approximateLabel(
              deltaLabel(summary.totalDeltaPercent),
              summary.totalDeltaEstimated,
            ),
            color: summary.totalDeltaPercent >= 0 ? COLORS.deltaUp : COLORS.deltaDown,
            weight: 700,
          }
        : { text: "no prior-period baseline", color: COLORS.muted },
      caption: summary.totalDeltaPercent !== null
        ? "vs prior equivalent period"
        : null,
      sparkline: vm.daily
        .filter((row) => row.observed !== false)
        .map((row) => row.totalTokens),
    });
    const cacheKnown = summary.inputTokens > 0;
    cards.push({
      accent: COLORS.cache,
      label: "CACHE EFFICIENCY",
      value: cacheKnown
        ? approximateLabel(pct(summary.cacheRatePercent), summary.estimated)
        : "—",
      unit: cacheKnown ? "input-weighted" : null,
      sub: cacheKnown
        ? {
            text: `${approximateLabel(compact(summary.cachedInputTokens), summary.estimated)} of ${approximateLabel(compact(summary.inputTokens), summary.estimated)} input cached`,
            color: COLORS.secondary,
          }
        : { text: "No measured input-token breakdown", color: COLORS.muted },
      bar: cacheKnown
        ? { fraction: summary.cacheRatePercent / 100, fill: COLORS.cache }
        : null,
    });
    const hasFast = summary.fastTokens > 0;
    cards.push({
      accent: FAST_MODE_LABEL_COLOR,
      label: "FAST MODE USAGE",
      value: approximateLabel(compact(summary.fastTokens), summary.fastEstimated),
      unit: "tokens",
      sub: hasFast
        ? {
            text: `${approximateLabel(pct(summary.fastSharePercent), summary.estimated)} of usage${
              fastRates.effectiveMultiplier === null
                ? ""
                : ` · ${fastRates.effectiveMultiplier.toFixed(2)}× avg`
            }`,
            color: COLORS.secondary,
          }
        : { text: "no fast-mode usage in range", color: COLORS.muted },
      bar: hasFast
        ? { fraction: summary.fastSharePercent / 100, fill: FAST_MODE_LABEL_COLOR }
        : null,
      caption: hasFast
        ? fastRates.effectiveMultiplier === null
          ? "Fast credit rate: UNRATED"
          : fastRates.unratedTokens > 0
            ? "Some fast usage is unrated"
            : "Fast mode shown with hatching"
        : null,
    });
    cards.push({
      accent: COLORS.secondary,
      label: "PROJECTS",
      value: String(summary.activeProjects),
      unit: "active",
      sub: summary.topThreeProjectSharePercent !== null
        ? {
            text: `Top ${Math.min(3, vm.projects.length)} = ${approximateLabel(pct(summary.topThreeProjectSharePercent), summary.estimated)}`,
            color: COLORS.secondary,
          }
        : { text: "no project activity", color: COLORS.muted },
      histogram: [...vm.projects.map((row) => row.sharePercent),
        vm.projectRemainder.sharePercent].filter((share) => share > 0),
    });
    return cards;
  }

  function drawCompactCard(card, x, y, cardWidth, cardHeight) {
    elements.push(svgText({
      x: x + 16,
      y: y + 25,
      value: card.label,
      fill: card.accent,
      size: 12,
      weight: 600,
      spacing: "1.08",
    }));
    const valueBaseline = y + 62;
    elements.push(svgText({
      x: x + 16,
      y: valueBaseline,
      value: card.value,
      size: 30,
      weight: 800,
      spacing: "-0.6",
    }));
    if (card.unit) {
      elements.push(svgText({
        x: x + 16 + textWidth(card.value, 30, 800) + 11,
        y: valueBaseline,
        value: card.unit,
        fill: COLORS.muted,
        size: 12.5,
      }));
    }
    if (card.sub) {
      elements.push(svgText({
        x: x + 16,
        y: y + 88,
        value: truncateToWidth(card.sub.text, cardWidth - 32, 12.5, card.sub.weight ?? 400),
        fill: card.sub.color,
        size: 12.5,
        weight: card.sub.weight ?? 400,
      }));
    }
    if (card.caption) {
      elements.push(svgText({
        x: x + 16,
        y: y + 107,
        value: truncateToWidth(card.caption, cardWidth - 32, 12),
        fill: COLORS.muted,
        size: 12,
      }));
    }
    if (card.bar) {
      const barY = y + cardHeight - 22;
      const barWidth = cardWidth - 32;
      elements.push(svgRect(x + 16, barY, barWidth, 5, { rx: 2.5, fill: COLORS.track }));
      const fillWidth = Math.max(0, Math.min(1, card.bar.fraction)) * barWidth;
      if (fillWidth > 0) {
        elements.push(svgRect(x + 16, barY, fillWidth, 5, { rx: 2.5, fill: card.bar.fill }));
      }
    }
    if (card.sparkline && card.sparkline.length > 1 && card.sparkline.some((value) => value > 0)) {
      const sparkWidth = Math.min(84, cardWidth * 0.34);
      const sparkHeight = 26;
      const sparkLeft = x + cardWidth - sparkWidth - 14;
      const sparkTop = y + 16;
      const maxValue = Math.max(...card.sparkline);
      const points = card.sparkline.map((value, index) => {
        const px = sparkLeft + (index / (card.sparkline.length - 1)) * sparkWidth;
        const py = sparkTop + (1 - (maxValue > 0 ? value / maxValue : 0)) * sparkHeight;
        return `${px.toFixed(1)},${py.toFixed(1)}`;
      });
      elements.push(`<polyline points="${points.join(" ")}" fill="none" stroke="${COLORS.leftAxis}" stroke-width="1.6" stroke-linejoin="round"/>`);
    }
    if (card.histogram && card.histogram.length) {
      const shares = card.histogram.slice(0, 7);
      const maxShare = Math.max(...shares);
      const histWidth = Math.min(86, cardWidth * 0.34);
      const slot = histWidth / shares.length;
      const histBottom = y + cardHeight - 20;
      shares.forEach((share, index) => {
        const barHeight = maxShare > 0 ? Math.max(2, (share / maxShare) * 30) : 2;
        elements.push(svgRect(
          x + cardWidth - 14 - histWidth + index * slot,
          histBottom - barHeight,
          Math.max(2, slot - 3),
          barHeight,
          { fill: COLORS.leftAxis, opacity: 0.85, rx: 1 },
        ));
      });
    }
  }

  function addVerticalDivider(x, y, height, role) {
    elements.push(svgLine(x, y + 2, x, y + height - 2, {
      stroke: COLORS.separator,
      "stroke-width": 1,
      "data-role": role,
    }));
  }

  function drawWeeklyCard(x, y, cardWidth, cardHeight) {
    elements.push(svgRect(x, y, cardWidth, cardHeight, {
      rx: 8,
      fill: COLORS.meterPanel,
      stroke: COLORS.meterPanelBorder,
      "stroke-width": 1,
    }));
    let labelX = x + 16;
    elements.push(svgText({
      x: labelX,
      y: y + 25,
      value: "WEEKLY LIMIT",
      fill: COLORS.meterAxis,
      size: 12,
      weight: 600,
      spacing: "1.08",
    }));
    labelX += textWidth("WEEKLY LIMIT", 12, 600) + 22;
    if (stale) {
      elements.push(chip(labelX, y + 21, "STALE SNAPSHOT", {
        fill: "rgba(246,183,60,.16)",
        stroke: COLORS.line,
        color: COLORS.line,
        size: 10.5,
      }).markup);
    }

    const status = meter.status;
    const valueBaseline = y + 60;
    const rightX = x + cardWidth - 16;

    if (status === "unavailable") {
      elements.push(svgText({
        x: x + 16,
        y: valueBaseline,
        value: "NO OBSERVATION",
        fill: COLORS.line,
        size: 24,
        weight: 800,
        spacing: "-0.24",
      }));
      elements.push(svgText({
        x: x + 16,
        y: y + 86,
        value: truncateToWidth(
          "No account-wide weekly-limit reading was found",
          cardWidth - 32,
          12.5,
        ),
        fill: COLORS.secondary,
        size: 12.5,
      }));
      return;
    }

    // Right column: time to the scheduled reset.
    if (meter.resetInMs !== null) {
      elements.push(svgText({
        x: rightX,
        y: y + 25,
        value: "RESETS IN",
        fill: COLORS.meterAxis,
        size: 11,
        weight: 600,
        spacing: "1",
        anchor: "end",
      }));
      elements.push(svgText({
        x: rightX,
        y: y + 50,
        value: durationLabel(meter.resetInMs).toUpperCase(),
        fill: COLORS.line,
        size: 21,
        weight: 800,
        anchor: "end",
        spacing: "-0.2",
      }));
    }

    let subLine;
    if (status === "exhausted") {
      elements.push(svgText({
        x: x + 16,
        y: valueBaseline,
        value: "EXHAUSTED",
        fill: COLORS.line,
        size: 26,
        weight: 800,
        spacing: "-0.26",
      }));
      subLine = meter.firstExhaustedObservedAtMs !== null && meter.resetsAtMs !== null
        ? `Reached 0% about ${durationLabel(meter.resetsAtMs - meter.firstExhaustedObservedAtMs)} before reset`
        : "Latest reading reports 0% remaining";
    } else {
      elements.push(svgText({
        x: x + 16,
        y: valueBaseline,
        value: meterPct(meter.remainingPercent),
        fill: COLORS.line,
        size: 26,
        weight: 800,
        spacing: "-0.26",
      }));
      elements.push(svgText({
        x: x + 16 + textWidth(meterPct(meter.remainingPercent), 26, 800) + 12,
        y: valueBaseline,
        value: "remaining",
        fill: COLORS.secondary,
        size: 12.5,
      }));
      if (status === "at-risk" && meter.runwayDays !== null && meter.resetInMs !== null) {
        subLine = `At this pace: 0% about ${durationLabel(meter.resetInMs - meter.runwayDays * 86_400_000)} before reset`;
      } else if (meter.runwayDays !== null) {
        subLine = `${meter.runwayDays.toFixed(1)} days of runway at this pace`;
      } else {
        subLine = "Runway unavailable · no usable meter drain in the active cycle";
      }
    }
    elements.push(svgText({
      x: x + 16,
      y: y + 91,
      value: truncateToWidth(subLine, cardWidth - 32, 12.5),
      fill: status === "at-risk" ? COLORS.warn : COLORS.secondary,
      size: 12.5,
    }));

    const barY = y + cardHeight - 20;
    const barWidth = cardWidth - 32;
    elements.push(svgRect(x + 16, barY, barWidth, 5, { rx: 2.5, fill: "rgba(246,183,60,.2)" }));
    const fillWidth = (Math.max(0, Math.min(100, meter.remainingPercent)) / 100) * barWidth;
    if (fillWidth > 0) {
      elements.push(svgRect(x + 16, barY, fillWidth, 5, { rx: 2.5, fill: COLORS.line }));
    }
  }

  function buildKpiSection(top) {
    const cards = compactCards();
    const cardHeight = 140;
    const gap = 12;
    if (wide) {
      // Weekly card takes ~1.55 compact-card widths on one row.
      const unit = (contentWidth - gap * 4) / (4 + 1.55);
      for (let index = 1; index < cards.length; index += 1) {
        addVerticalDivider(
          outer + index * (unit + gap) - gap / 2,
          top,
          cardHeight,
          "kpi-column-divider",
        );
      }
      cards.forEach((card, index) => {
        drawCompactCard(card, outer + index * (unit + gap), top, unit, cardHeight);
      });
      drawWeeklyCard(outer + 4 * (unit + gap), top, unit * 1.55, cardHeight);
      return top + cardHeight;
    }
    const half = (contentWidth - gap) / 2;
    addVerticalDivider(
      outer + half + gap / 2,
      top,
      cardHeight * 2 + gap,
      "kpi-column-divider",
    );
    cards.forEach((card, index) => {
      const row = Math.floor(index / 2);
      const column = index % 2;
      drawCompactCard(card, outer + column * (half + gap), top + row * (cardHeight + gap), half, cardHeight);
    });
    const weeklyTop = top + 2 * (cardHeight + gap);
    drawWeeklyCard(outer, weeklyTop, contentWidth, cardHeight);
    return weeklyTop + cardHeight;
  }

  // ------------------------------------------------------------- model mix
  function buildModelMixSection(top) {
    const sectionHeight = 28;
    const labelBaseline = top + 19;
    elements.push(svgText({
      x: outer + 16,
      y: labelBaseline,
      value: "MODEL MIX",
      fill: COLORS.leftAxis,
      size: 11.5,
      weight: 600,
      spacing: "1.08",
    }));
    elements.push(svgText({
      x: outer + 16 + spacedWidth("MODEL MIX", 11.5, 600, 1.08) + 8,
      y: labelBaseline,
      value: "(by tokens)",
      fill: COLORS.muted,
      size: 11,
    }));

    const rows = vm.models.filter((row) => row.totalTokens > 0);
    if (!rows.length || !(summary.totalTokens > 0)) {
      elements.push(svgText({
        x: contentRight - 16,
        y: labelBaseline,
        value: "no usage in range",
        fill: COLORS.muted,
        size: 12.5,
        anchor: "end",
      }));
      return top + sectionHeight;
    }

    // Segments that are too narrow for an inside label move to an external
    // caption at the right end of the strip.
    const barLeft = outer + 170;
    const external = [];
    const externalRows = [];
    let barRight = contentRight - 16;
    const segmentLabel = (row) =>
      `${row.model} ${approximateLabel(pct(row.sharePercent), summary.estimated)} (${approximateLabel(compact(row.totalTokens), row.estimated)})`;
    for (const row of [...rows].reverse()) {
      const share = row.totalTokens / summary.totalTokens;
      const estimatedWidth = share * (barRight - barLeft);
      if (
        estimatedWidth < textWidth(segmentLabel(row), 12, 600) + 18 &&
        externalRows.length < 2 &&
        rows.length > 1
      ) {
        externalRows.unshift(row);
      } else {
        break;
      }
    }
    for (const row of externalRows) external.push(segmentLabel(row));
    if (external.length) {
      const caption = external.join(" · ");
      barRight -= textWidth(caption, 11, 500) + 16;
      elements.push(svgText({
        x: contentRight - 16,
        y: labelBaseline,
        value: caption,
        fill: COLORS.secondary,
        size: 11,
        weight: 500,
        anchor: "end",
      }));
    }
    const barY = top + 7;
    const barHeight = 14;
    let cursor = barLeft;
    const barWidth = Math.max(60, barRight - barLeft);
    rows.forEach((row, index) => {
      const share = row.totalTokens / summary.totalTokens;
      const segmentWidth = share * barWidth;
      elements.push(svgRect(cursor, barY, segmentWidth, barHeight, {
        fill: styleForModel(row.model),
        rx: index === 0 || index === rows.length - 1 ? 3 : null,
      }));
      const label = segmentLabel(row);
      if (!externalRows.includes(row) && textWidth(label, 10.5, 600) + 14 <= segmentWidth) {
        elements.push(svgText({
          x: cursor + segmentWidth / 2,
          y: barY + 10.5,
          value: label,
          fill: "#ffffff",
          size: 10.5,
          weight: 600,
          anchor: "middle",
        }));
      }
      cursor += segmentWidth;
    });
    return top + sectionHeight;
  }

  // ------------------------------------------------------------ daily chart
  function buildDailyChartSection(top) {
    const percentMode = Boolean(options.drain) &&
      Boolean(drainTrend?.available) &&
      meter.status !== "unavailable";

    const plotWidthEstimate = contentWidth - 70 - 66 - 24;
    const binSize = chooseBinSize(meta.rangeDays, plotWidthEstimate, {
      minBinWidth: MIN_BAR_WIDTH,
      preferDaily: true,
    });
    const tokenBins = binDailyRows(vm.daily, binSize);
    const burn = percentMode
      ? buildBurnDayBins(drainTrend, bounds, { days: meta.rangeDays, binSize })
      : null;
    const bins = percentMode
      ? burn.bins.map((bin, index) => ({
          startDateString: bin.startDateString,
          lastDateString: shiftCalendarDate(bin.endDateString, -1),
          totalPercent: bin.totalPercent,
          approximate: bin.approximate,
          values: bin.values,
          partial: tokenBins[index]?.partial ?? false,
          unobserved: tokenBins[index]?.unobserved ?? true,
          estimated: false,
        }))
      : tokenBins;
    const binCount = bins.length;
    const binTotalOf = (bin) => (percentMode ? bin.totalPercent : bin.totalTokens);
    const maxBin = bins.reduce((maximum, bin) => Math.max(maximum, binTotalOf(bin)), 0);
    const ceiling = reportCeiling(maxBin);
    const meterVisible = meter.status !== "unavailable" && meter.observations.length > 0;

    const panelTop = top;
    const headerBaseline = panelTop + 27;
    const plotLeft = outer + 70;
    const plotRight = contentRight - (meterVisible ? 66 : 24);
    const plotWidth = plotRight - plotLeft;
    const plotTop = panelTop + 64;
    const plotHeight = wide ? 330 : 300;
    const plotBottom = plotTop + plotHeight;
    const partialInRange = bins.some((bin) => bin.partial);
    const labelBand = 58 + (partialInRange ? 18 : 0);
    const panelHeight = plotBottom - panelTop + labelBand;
    elements.push(svgRect(outer, panelTop, contentWidth, panelHeight, {
      rx: 8,
      fill: COLORS.panel,
      stroke: COLORS.panelBorder,
      "stroke-width": 1,
    }));

    // Panel header: title + legend + right axis caption.
    elements.push(svgText({
      x: outer + 16,
      y: headerBaseline,
      value: percentMode ? "OBSERVED LIMIT DRAIN" : "DAILY TOKEN VOLUME",
      fill: COLORS.leftAxis,
      size: 12,
      weight: 600,
      spacing: "1.08",
    }));
    elements.push(svgText({
      x: outer + 16 +
        spacedWidth(percentMode ? "OBSERVED LIMIT DRAIN" : "DAILY TOKEN VOLUME", 12, 600, 1.08) + 8,
      y: headerBaseline,
      value: percentMode ? "(meter percent by model)" : "(actual)",
      fill: COLORS.muted,
      size: 11.5,
    }));
    if (meterVisible) {
      elements.push(svgText({
        x: contentRight - 16,
        y: headerBaseline,
        value: "Meter %",
        fill: COLORS.meterAxis,
        size: 12,
        weight: 600,
        anchor: "end",
      }));
    }

    // Legend, wrapped when narrow.
    const legendItems = [];
    const presentModels = vm.models
      .filter((row) => row.totalTokens > 0)
      .map((row) => row.model)
      .sort(modelSort);
    for (const model of presentModels) {
      legendItems.push({ kind: "swatch", fill: styleForModel(model), label: model });
    }
    if (!percentMode && summary.fastTokens > 0) {
      legendItems.push({ kind: "hatch", label: "Fast mode" });
    }
    if (meterVisible) {
      legendItems.push({ kind: "solid", label: "Reported interval" });
      legendItems.push({ kind: "dashed", label: "Unobserved gap" });
    }
    let legendX = outer + 16;
    let legendY = headerBaseline + 21;
    const legendLimit = contentRight - 16;
    for (const item of legendItems) {
      const swatchWidth = item.kind === "swatch" || item.kind === "hatch" ? 13 : 20;
      const itemWidth = swatchWidth + 7 + textWidth(item.label, 12) + 18;
      if (legendX + itemWidth > legendLimit && legendX > outer + 16) {
        legendX = outer + 16;
        legendY += 18;
      }
      if (item.kind === "swatch") {
        elements.push(svgRect(legendX, legendY - 9, 13, 10, { fill: item.fill, rx: 2 }));
      } else if (item.kind === "hatch") {
        elements.push(svgRect(legendX, legendY - 9, 13, 10, { fill: COLORS.leftAxis, rx: 2 }));
        elements.push(svgRect(legendX, legendY - 9, 13, 10, { fill: "url(#fast-mode-hatch)", rx: 2 }));
      } else if (item.kind === "solid") {
        elements.push(svgLine(legendX, legendY - 4, legendX + 20, legendY - 4, {
          stroke: COLORS.line,
          "stroke-width": 2.4,
        }));
      } else {
        elements.push(svgLine(legendX, legendY - 4, legendX + 20, legendY - 4, {
          stroke: COLORS.line,
          "stroke-width": 2,
          "stroke-dasharray": "4 4",
        }));
      }
      elements.push(svgText({
        x: legendX + swatchWidth + 7,
        y: legendY,
        value: item.label,
        fill: COLORS.secondary,
        size: 12,
      }));
      legendX += itemWidth;
    }

    // Meter pixel geometry is needed both by the overlay and by bar-total
    // placement (totals step above the line when it crosses their band).
    const spanMs = meta.requestedEndMs - meta.startMs;
    const xForTs = (timestampMs) =>
      plotLeft +
      Math.max(0, Math.min(1, spanMs > 0 ? (timestampMs - meta.startMs) / spanMs : 0)) *
        plotWidth;
    const yForRemaining = (value) =>
      plotTop + (1 - Math.max(0, Math.min(100, value)) / 100) * plotHeight;
    const pixelSegments = meterVisible
      ? meter.segments.map((segment) => ({
          x0: xForTs(segment.fromMs),
          y0: yForRemaining(segment.fromPercent),
          x1: xForTs(segment.toMs),
          y1: yForRemaining(segment.toPercent),
        }))
      : [];
    const lineTopWithin = (x0, x1, bandTop, bandBottom) => {
      let top = Infinity;
      for (const segment of pixelSegments) {
        if (segment.x1 < x0 || segment.x0 > x1) continue;
        const clip0 = Math.max(x0, segment.x0);
        const clip1 = Math.min(x1, segment.x1);
        if (clip1 < clip0) continue;
        const yAt = (x) =>
          segment.y0 +
          (segment.x1 === segment.x0
            ? 0
            : ((x - segment.x0) / (segment.x1 - segment.x0)) * (segment.y1 - segment.y0));
        const yLow = Math.min(yAt(clip0), yAt(clip1));
        const yHigh = Math.max(yAt(clip0), yAt(clip1));
        if (yLow <= bandBottom && yHigh >= bandTop) top = Math.min(top, yLow);
      }
      return Number.isFinite(top) ? top : null;
    };

    // Grid and axes.
    for (const fraction of [1, 0.75, 0.5, 0.25, 0]) {
      const y = plotBottom - fraction * plotHeight;
      elements.push(svgLine(plotLeft, y, plotRight, y, {
        stroke: fraction === 0 ? COLORS.baseline : COLORS.grid,
        "stroke-width": 1,
      }));
      elements.push(svgText({
        x: plotLeft - 12,
        y: y + 4,
        value: percentMode
          ? `${Number((ceiling * fraction).toFixed(1))}%`
          : fraction === 0
            ? "0"
            : compact(ceiling * fraction),
        fill: COLORS.muted,
        size: 12,
        anchor: "end",
        mono: true,
      }));
      if (meterVisible) {
        elements.push(svgText({
          x: plotRight + 12,
          y: y + 4,
          value: `${Math.round(fraction * 100)}%`,
          fill: COLORS.meterAxis,
          size: 12,
          mono: true,
        }));
      }
    }

    // Bars.
    const slotWidth = plotWidth / binCount;
    const barWidth = Math.min(86, Math.max(MIN_BAR_WIDTH, slotWidth * 0.62));
    const labelStep = labelEvery(binCount);
    const isLabeledColumn = (index) => index % labelStep === 0 || index === binCount - 1;
    const segmentLabels = [];

    bins.forEach((bin, binIndex) => {
      const centerX = plotLeft + (binIndex + 0.5) * slotWidth;
      const x = centerX - barWidth / 2;
      if (bin.unobserved) {
        elements.push(svgRect(centerX - slotWidth / 2 + 2, plotTop, slotWidth - 4, plotHeight, {
          fill: "rgba(255,255,255,.025)",
        }));
        if (isLabeledColumn(binIndex)) {
          elements.push(chip(centerX, plotBottom + 21, "UNOBSERVED", {
            fill: "rgba(255,255,255,.04)",
            stroke: COLORS.baseline,
            color: COLORS.muted,
            size: 9.5,
            anchor: "middle",
          }).markup);
          elements.push(svgText({
            x: centerX,
            y: plotBottom + 45,
            value: binDateLabel(bin, timeZone),
            fill: COLORS.secondary,
            size: 14,
            anchor: "middle",
          }));
        }
        return;
      }
      if (bin.partial) {
        elements.push(svgRect(centerX - slotWidth / 2 + 2, plotTop, slotWidth - 4, plotHeight, {
          fill: "rgba(255,255,255,.03)",
        }));
      }
      const entries = percentMode
        ? [...bin.values.entries()]
            .filter(([, value]) => value > 0)
            .sort(([left], [right]) => modelSort(left, right))
            .map(([model, value]) => ({ model, totalTokens: value, fastTokens: 0 }))
        : [...bin.models].sort((left, right) => modelSort(left.model, right.model));
      let y = plotBottom;
      for (const entry of entries) {
        const value = entry.totalTokens;
        const segmentHeight = (value / ceiling) * plotHeight;
        y -= segmentHeight;
        if (segmentHeight <= 0.4) continue;
        const baseColor = styleForModel(entry.model);
        elements.push(svgRect(x, y, barWidth, segmentHeight, {
          fill: baseColor,
          "data-series": "usage-bars",
        }));
        // Fast-mode tokens are a subset of the segment: same color, hatched,
        // never extra height.
        const fastFraction = value > 0 ? Math.min(1, entry.fastTokens / value) : 0;
        const fastHeight = segmentHeight * fastFraction;
        if (fastHeight > 0.5) {
          elements.push(svgRect(x, y, barWidth, fastHeight, {
            fill: "url(#fast-mode-hatch)",
          }));
        }
        const valueLabel = percentMode
          ? pct(value)
          : approximateLabel(compact(value), entry.estimated);
        const fits = (text, size) => textWidth(text, size, 700) <= barWidth - 6;
        if (segmentHeight >= 34 && fits(entry.model, 12.5) && fits(valueLabel, 14)) {
          const segmentCenter = y + segmentHeight / 2;
          segmentLabels.push(svgText({
            x: centerX,
            y: segmentCenter - 4,
            value: entry.model,
            fill: COLORS.onFill,
            size: 12.5,
            anchor: "middle",
          }));
          segmentLabels.push(svgText({
            x: centerX,
            y: segmentCenter + 13,
            value: valueLabel,
            fill: "#ffffff",
            size: 14,
            weight: 700,
            anchor: "middle",
          }));
        }
      }
      const total = binTotalOf(bin);
      if (total > 0 && isLabeledColumn(binIndex)) {
        const estimatedPrefix = (percentMode ? bin.approximate : bin.estimated) ? "≈" : "";
        let labelTop = y;
        const clearance = lineTopWithin(
          centerX - barWidth / 2 - 8,
          centerX + barWidth / 2 + 8,
          labelTop - 28,
          labelTop + 8,
        );
        if (clearance !== null) labelTop = Math.min(labelTop, clearance);
        segmentLabels.push(svgText({
          x: centerX,
          y: Math.max(plotTop + 12, labelTop - 9),
          value: percentMode
            ? `${estimatedPrefix}${pct(total)}`
            : `${estimatedPrefix}${compact(total)}`,
          size: 15,
          weight: 700,
          anchor: "middle",
        }));
      }
      // Day labels.
      if (isLabeledColumn(binIndex)) {
        const weekday = binSize === 1 && bin.lastDateString === bin.startDateString
          ? localWeekdayLabel(bin.startDateString, timeZone).toUpperCase()
          : "";
        if (bin.partial) {
          elements.push(chip(centerX, plotBottom + 21, "PARTIAL", {
            fill: "rgba(255,255,255,.06)",
            stroke: COLORS.baseline,
            color: COLORS.secondary,
            size: 10.5,
            anchor: "middle",
          }).markup);
        } else if (weekday) {
          elements.push(svgText({
            x: centerX,
            y: plotBottom + 25,
            value: weekday,
            fill: COLORS.muted,
            size: 12,
            anchor: "middle",
            spacing: "1.44",
          }));
        }
        elements.push(svgText({
          x: centerX,
          y: plotBottom + (weekday || bin.partial ? 45 : 34),
          value: binDateLabel(bin, timeZone),
          fill: COLORS.secondary,
          size: 14,
          anchor: "middle",
        }));
        if (bin.partial && meta.partialFinalDay) {
          elements.push(svgText({
            x: centerX,
            y: plotBottom + 62,
            value: `THROUGH ${timeOnlyLabel(meta.effectiveEndMs, timeZone).toUpperCase()}`,
            fill: COLORS.muted,
            size: 10.5,
            anchor: "middle",
            spacing: "0.63",
          }));
        }
      }
    });

    // Meter overlay: solid runs mark spans confirmed by repeated equal
    // readings, while dashed runs bridge unobserved gaps. The line never
    // extends past the last reading.
    if (meterVisible) {
      // Dense windows keep a line per reset but cap the callout chips so the
      // top of the plot stays readable; scheduled expiries win the labels.
      const chipLimit = 4;
      const labeledResets = (() => {
        if (meter.resets.length <= chipLimit) return new Set(meter.resets);
        const scheduled = meter.resets.filter(
          (reset) => reset.kind === "weekly-expiry",
        );
        const pool = scheduled.length >= chipLimit ? scheduled : meter.resets;
        const selected = new Set();
        for (let index = 0; index < chipLimit; index += 1) {
          selected.add(
            pool[Math.round((index / (chipLimit - 1)) * (pool.length - 1))],
          );
        }
        return selected;
      })();
      const resetLabelMarkups = [];
      const resetLabelBounds = [];
      for (const reset of meter.resets) {
        const x = xForTs(reset.timestampMs);
        elements.push(svgLine(x, plotTop, x, plotBottom, {
          stroke: "rgba(246,183,60,.5)",
          "stroke-width": 2,
          "stroke-dasharray": reset.inferred ? "5 6" : null,
        }));
        if (!labeledResets.has(reset)) continue;
        const labelX = Math.max(plotLeft + 32, Math.min(plotRight - 32, x));
        const resetLabel = chip(
          labelX,
          plotTop + 13,
          reset.kind === "weekly-expiry" ? "RESET" : "RESTART",
          {
            fill: COLORS.panel,
            color: COLORS.meterAxis,
            size: 10.5,
            weight: 600,
            anchor: "middle",
            mono: true,
          },
        );
        resetLabelBounds.push({
          left: labelX - resetLabel.width / 2,
          right: labelX + resetLabel.width / 2,
          bottom: plotTop + 19,
        });
        resetLabelMarkups.push(
          `<g data-role="meter-reset-label">${resetLabel.markup}</g>`,
        );
      }

      for (const segment of meter.segments) {
        elements.push(svgLine(
          xForTs(segment.fromMs),
          yForRemaining(segment.fromPercent),
          xForTs(segment.toMs),
          yForRemaining(segment.toPercent),
          {
            stroke: COLORS.line,
            "stroke-width": segment.kind === "confirmed" ? 2.6 : 2,
            "stroke-dasharray": segment.kind === "confirmed" ? null : "5 5",
            "stroke-linecap": "round",
            "data-series": "weekly-meter",
          },
        ));
      }
      elements.push(...resetLabelMarkups);
      const latest = meter.observations.at(-1);
      if (latest) {
        const label = `${Math.round(latest.remainingPercent)}%`;
        const px = xForTs(latest.timestampMs);
        const py = yForRemaining(latest.remainingPercent);
        const anchorEnd = px > plotRight - 70;
        const labelX = anchorEnd ? px - 10 : px + 10;
        const labelWidth = textWidth(label, 11, 700) + 14;
        const labelLeft = anchorEnd ? labelX - labelWidth : labelX;
        const labelRight = labelLeft + labelWidth;
        let labelY = Math.max(plotTop + 14, Math.min(plotBottom - 6, py + 1));
        const overlapsResetLabel = resetLabelBounds.some((bounds) =>
          labelLeft < bounds.right + 6 &&
          labelRight > bounds.left - 6 &&
          labelY - 13 < bounds.bottom + 6
        );
        if (overlapsResetLabel) labelY = plotTop + 38;
        const latestLabel = chip(
          labelX,
          labelY,
          label,
          {
            fill: COLORS.background,
            stroke: COLORS.line,
            color: COLORS.line,
            size: 11,
            anchor: anchorEnd ? "end" : "start",
            mono: true,
          },
        );
        elements.push(
          `<g data-role="meter-latest-label">${latestLabel.markup}</g>`,
        );
      }
    }

    elements.push(...segmentLabels);
    return panelTop + panelHeight;
  }

  // ------------------------------------------------------------ lower panels
  function panelHeading(x, y, title, suffix = null) {
    elements.push(svgText({
      x: x + 16,
      y: y + 25,
      value: title,
      fill: COLORS.leftAxis,
      size: 12,
      weight: 600,
      spacing: "1.08",
    }));
    if (suffix) {
      elements.push(svgText({
        x: x + 16 + spacedWidth(title, 12, 600, 1.08) + 8,
        y: y + 25,
        value: suffix,
        fill: COLORS.muted,
        size: 11.5,
      }));
    }
  }

  function buildCacheByDayPanel(x, y, panelWidth, panelHeight) {
    panelHeading(x, y, "CACHE EFFICIENCY BY DAY", "(input-weighted)");
    const inner = panelWidth - 32;
    const left = x + 16;

    const binSize = chooseBinSize(meta.rangeDays, inner, {
      minBinWidth: 18,
      preferDaily: true,
    });
    const cacheBins = binDailyRows(vm.daily, binSize);
    const rated = cacheBins.filter((bin) => bin.inputTokens > 0);
    if (!rated.length) {
      elements.push(svgText({
        x: left,
        y: y + 60,
        value: "No measured input-token breakdown in this range",
        fill: COLORS.muted,
        size: 12.5,
      }));
      return;
    }

    const rates = rated.map((bin) => (bin.cachedInputTokens / bin.inputTokens) * 100);
    const minRate = Math.min(...rates);
    // Zoomed axis: at least a 20-point span, floor snapped to tens, 0–80.
    let floor = Math.max(0, Math.min(80, Math.floor((minRate - 5) / 10) * 10));
    floor = Math.min(floor, 80);
    if (floor > 0) {
      elements.push(svgText({
        x: x + panelWidth - 16,
        y: y + 25,
        value: "ZOOMED SCALE",
        fill: COLORS.muted,
        size: 9.5,
        weight: 600,
        spacing: "0.65",
        anchor: "end",
      }));
    }

    const lineTop = y + 52;
    const lineHeight = 64;
    const lineBottom = lineTop + lineHeight;
    const axisLabels = [
      { value: 100, y: lineTop },
      { value: (100 + floor) / 2, y: lineTop + lineHeight / 2 },
      { value: floor, y: lineBottom },
    ];
    const axisWidth = 34;
    for (const label of axisLabels) {
      elements.push(svgText({
        x: left + axisWidth - 6,
        y: label.y + 4,
        value: `${Math.round(label.value)}%`,
        fill: COLORS.muted,
        size: 10.5,
        anchor: "end",
        mono: true,
      }));
      elements.push(svgLine(left + axisWidth, label.y, x + panelWidth - 16, label.y, {
        stroke: COLORS.grid,
        "stroke-width": 1,
      }));
    }
    const chartLeft = left + axisWidth + 6;
    const chartWidth = x + panelWidth - 16 - chartLeft;
    const slot = chartWidth / cacheBins.length;
    const yForRate = (rate) =>
      lineBottom - ((Math.max(floor, Math.min(100, rate)) - floor) / (100 - floor)) * lineHeight;

    const linePoints = [];
    cacheBins.forEach((bin, index) => {
      if (!(bin.inputTokens > 0)) {
        linePoints.push(null);
        return;
      }
      linePoints.push({
        x: chartLeft + (index + 0.5) * slot,
        y: yForRate((bin.cachedInputTokens / bin.inputTokens) * 100),
        rate: (bin.cachedInputTokens / bin.inputTokens) * 100,
        estimated: bin.estimated,
      });
    });
    for (let index = 0; index < linePoints.length - 1; index += 1) {
      const from = linePoints[index];
      const to = linePoints[index + 1];
      if (!from || !to) continue;
      elements.push(svgLine(from.x, from.y, to.x, to.y, {
        stroke: COLORS.cache,
        "stroke-width": 2,
        "stroke-linecap": "round",
      }));
    }
    const rateLabelStep = cacheBins.length <= 8 ? 1 : Math.ceil(cacheBins.length / 8);
    linePoints.forEach((point, index) => {
      if (!point) return;
      elements.push(`<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3.2" fill="${COLORS.cache}"/>`);
      if (index % rateLabelStep === 0 || index === linePoints.length - 1) {
        elements.push(svgText({
          x: point.x,
          y: point.y - 8,
          value: approximateLabel(pct(point.rate), point.estimated),
          fill: COLORS.secondary,
          size: 10.5,
          anchor: "middle",
        }));
      }
    });

    // Input-volume columns beneath the rate line.
    const columnsTop = lineBottom + 26;
    const columnsHeight = 44;
    const columnsBottom = columnsTop + columnsHeight;
    const maxInput = Math.max(...cacheBins.map((bin) => bin.inputTokens), 1);
    elements.push(svgText({
      x: left + axisWidth - 6,
      y: columnsBottom - columnsHeight / 2 + 4,
      value: "Input",
      fill: COLORS.muted,
      size: 10.5,
      anchor: "end",
    }));
    cacheBins.forEach((bin, index) => {
      const centerX = chartLeft + (index + 0.5) * slot;
      const columnWidth = Math.min(30, Math.max(8, slot * 0.5));
      if (bin.unobserved) {
        elements.push(svgRect(
          centerX - columnWidth / 2,
          lineTop,
          columnWidth,
          columnsBottom - lineTop,
          { fill: "rgba(255,255,255,.025)" },
        ));
      }
      const columnHeight = (bin.inputTokens / maxInput) * columnsHeight;
      if (columnHeight > 0.4) {
        elements.push(svgRect(centerX - columnWidth / 2, columnsBottom - columnHeight, columnWidth, columnHeight, {
          fill: COLORS.cache,
          opacity: 0.85,
          rx: 1.5,
        }));
      }
      if (index % rateLabelStep === 0 || index === cacheBins.length - 1) {
        if (bin.inputTokens > 0) {
          elements.push(svgText({
            x: centerX,
            y: columnsBottom - columnHeight - 5,
            value: approximateLabel(compact(bin.inputTokens), bin.estimated),
            fill: COLORS.muted,
            size: 10,
            anchor: "middle",
          }));
        }
        if (bin.unobserved) {
          elements.push(svgText({
            x: centerX,
            y: columnsBottom + 15,
            value: "UNOBSERVED",
            fill: COLORS.muted,
            size: 8.5,
            weight: 600,
            spacing: "0.45",
            anchor: "middle",
          }));
        } else {
          elements.push(svgText({
            x: centerX,
            y: columnsBottom + 15,
            value: binDateLabel(bin, timeZone),
            fill: COLORS.muted,
            size: 10,
            anchor: "middle",
          }));
        }
      }
    });

    // Summary strip.
    const stripY = y + panelHeight - 32;
    const approxUncached = vm.coverage.estimated;
    elements.push(svgText({
      x: left,
      y: stripY + 15,
      value: truncateToWidth(
        `${approximateLabel(pct(summary.cacheRatePercent), summary.estimated)} input-weighted · ${approximateLabel(compact(summary.cachedInputTokens), summary.estimated)} of ${approximateLabel(compact(summary.inputTokens), summary.estimated)} input cached · ${approxUncached ? "≈" : ""}${compact(summary.uncachedInputTokens)} uncached`,
        inner,
        11,
      ),
      fill: COLORS.cache,
      size: 11,
    }));
  }

  function buildProjectsPanel(x, y, panelWidth, panelHeight) {
    panelHeading(x, y, "WHERE IT WENT · TOP PROJECTS");
    elements.push(svgText({
      x: x + panelWidth - 16,
      y: y + 25,
      value: `${summary.activeProjects} ${summary.activeProjects === 1 ? "project" : "projects"} active`,
      fill: COLORS.muted,
      size: 11.5,
      anchor: "end",
    }));

    const rows = vm.projects.map((row, index) => ({
      rank: String(index + 1).padStart(2, "0"),
      name: row.displayProject,
      tokens: row.totalTokens,
      share: row.sharePercent,
      estimated: row.estimated,
      muted: false,
    }));
    if (vm.projectRemainder.count > 0) {
      rows.push({
        rank: String(rows.length + 1).padStart(2, "0"),
        name: vm.projectRemainder.count === 1
          ? "1 other project"
          : `${vm.projectRemainder.count} other projects`,
        tokens: vm.projectRemainder.totalTokens,
        share: vm.projectRemainder.sharePercent,
        estimated: vm.projectRemainder.estimated,
        muted: true,
      });
    }
    if (!rows.length) {
      elements.push(svgText({
        x: x + 16,
        y: y + 60,
        value: "No project activity in range",
        fill: COLORS.muted,
        size: 12.5,
      }));
      return;
    }

    const rowTop = y + 44;
    const rowGap = 33;
    const rankX = x + 16;
    const nameX = rankX + 26;
    const pctRight = x + panelWidth - 16;
    const tokensRight = pctRight - 52;
    const barWidth = Math.max(56, panelWidth * 0.2);
    const barX = tokensRight - 66 - barWidth;
    const nameWidth = barX - nameX - 12;
    rows.forEach((row, index) => {
      const centerY = rowTop + index * rowGap + 8;
      elements.push(svgText({
        x: rankX,
        y: centerY + 4,
        value: row.rank,
        fill: COLORS.muted,
        size: 12,
        mono: true,
      }));
      elements.push(svgText({
        x: nameX,
        y: centerY + 4,
        value: truncateToWidth(row.name, nameWidth, 13.5, row.muted ? 400 : 700),
        fill: row.muted ? COLORS.muted : COLORS.ink,
        size: 13.5,
        weight: row.muted ? 400 : 700,
      }));
      elements.push(svgRect(barX, centerY - 4, barWidth, 9, {
        rx: 2,
        fill: COLORS.projectTrack,
      }));
      const fillWidth = (Math.max(0, Math.min(100, row.share)) / 100) * barWidth;
      if (fillWidth > 0) {
        elements.push(svgRect(barX, centerY - 4, fillWidth, 9, {
          rx: 2,
          fill: row.muted ? COLORS.remainderBar : COLORS.leftAxis,
        }));
      }
      elements.push(svgText({
        x: tokensRight,
        y: centerY + 4,
        value: approximateLabel(compact(row.tokens), row.estimated),
        fill: row.muted ? COLORS.secondary : COLORS.ink,
        size: 13.5,
        weight: 700,
        anchor: "end",
      }));
      elements.push(svgText({
        x: pctRight,
        y: centerY + 4,
        value: approximateLabel(pct(row.share), summary.estimated),
        fill: COLORS.muted,
        size: 12,
        anchor: "end",
      }));
    });

    if (summary.topThreeProjectSharePercent !== null && vm.projects.length) {
      const stripY = y + panelHeight - 32;
      elements.push(svgText({
        x: x + 16,
        y: stripY + 15,
        value: `Top ${Math.min(3, vm.projects.length)} projects = ${approximateLabel(pct(summary.topThreeProjectSharePercent), summary.estimated)} of tokens`,
        fill: COLORS.leftAxis,
        size: 11.5,
      }));
    }
  }

  function buildModelCachePanel(x, y, panelWidth, panelHeight) {
    panelHeading(x, y, "CACHE EFFICIENCY BY MODEL", "(input-weighted)");

    // Combine minor models past the fourth row so the table always fits.
    const source = vm.models.filter((row) => row.totalTokens > 0);
    const rows = source.slice(0, 4).map((row) => ({ ...row }));
    const overflow = source.slice(4);
    if (overflow.length) {
      const merged = overflow.reduce(
        (sum, row) => {
          sum.cacheInputTokens += row.cacheInputTokens;
          sum.cachedInputTokens += row.cachedInputTokens;
          sum.estimated ||= row.estimated === true;
          return sum;
        },
        {
          model: `${overflow.length} other models`,
          cacheInputTokens: 0,
          cachedInputTokens: 0,
          estimated: false,
        },
      );
      merged.uncachedInputTokens = Math.max(
        0,
        merged.cacheInputTokens - merged.cachedInputTokens,
      );
      merged.cacheRatePercent = merged.cacheInputTokens > 0
        ? (merged.cachedInputTokens / merged.cacheInputTokens) * 100
        : null;
      merged.combined = true;
      rows.push(merged);
    }
    if (!rows.length) {
      elements.push(svgText({
        x: x + 16,
        y: y + 60,
        value: "No measured input-token breakdown in this range",
        fill: COLORS.muted,
        size: 12.5,
      }));
      return;
    }

    const inputRight = x + panelWidth - 104;
    const uncachedRight = x + panelWidth - 16;
    elements.push(svgText({
      x: inputRight,
      y: y + 47,
      value: "INPUT",
      fill: COLORS.muted,
      size: 10.5,
      spacing: "0.84",
      anchor: "end",
    }));
    elements.push(svgText({
      x: uncachedRight,
      y: y + 47,
      value: "UNCACHED",
      fill: COLORS.muted,
      size: 10.5,
      spacing: "0.84",
      anchor: "end",
    }));

    const rowTop = y + 64;
    const rowGap = 33;
    const nameX = x + 30;
    const rateX = x + Math.min(150, panelWidth * 0.34);
    const barX = rateX + 52;
    const barWidth = Math.max(44, inputRight - 66 - barX);
    rows.forEach((row, index) => {
      const centerY = rowTop + index * rowGap;
      if (!row.combined) {
        elements.push(`<circle cx="${x + 19}" cy="${centerY - 4}" r="4" fill="${styleForModel(row.model)}"/>`);
      }
      elements.push(svgText({
        x: nameX,
        y: centerY,
        value: truncateToWidth(row.model, rateX - nameX - 8, 13, row.combined ? 400 : 600),
        fill: row.combined ? COLORS.muted : COLORS.ink,
        size: 13,
        weight: row.combined ? 400 : 600,
      }));
      const hasComponents = row.cacheRatePercent !== null;
      elements.push(svgText({
        x: rateX + 44,
        y: centerY,
        value: hasComponents
          ? approximateLabel(pct(row.cacheRatePercent), row.estimated)
          : "—",
        fill: COLORS.ink,
        size: 13,
        weight: 700,
        anchor: "end",
        mono: true,
      }));
      if (hasComponents && barWidth > 30) {
        elements.push(svgRect(barX, centerY - 8, barWidth, 8, {
          rx: 2,
          fill: COLORS.track,
        }));
        const cachedWidth = (row.cacheRatePercent / 100) * barWidth;
        if (cachedWidth > 0) {
          elements.push(svgRect(barX, centerY - 8, cachedWidth, 8, {
            rx: 2,
            fill: COLORS.cache,
          }));
        }
        if (barWidth - cachedWidth > 0.5) {
          elements.push(svgRect(barX + cachedWidth, centerY - 8, barWidth - cachedWidth, 8, {
            fill: COLORS.uncached,
            rx: 2,
          }));
        }
      }
      elements.push(svgText({
        x: inputRight,
        y: centerY,
        value: hasComponents
          ? approximateLabel(compact(row.cacheInputTokens), row.estimated)
          : "—",
        fill: COLORS.secondary,
        size: 12.5,
        anchor: "end",
        mono: true,
      }));
      elements.push(svgText({
        x: uncachedRight,
        y: centerY,
        value: hasComponents
          ? approximateLabel(compact(row.uncachedInputTokens), row.estimated)
          : "—",
        fill: COLORS.secondary,
        size: 12.5,
        anchor: "end",
        mono: true,
      }));
    });

    elements.push(svgText({
      x: x + 16,
      y: y + panelHeight - 15,
      value: "Uncached = input not served from cache (input-weighted)",
      fill: COLORS.muted,
      size: 11,
    }));
  }

  function buildLowerSection(top) {
    const gap = 14;
    const projectRowCount = Math.min(4, vm.projects.length) +
      (vm.projectRemainder.count > 0 ? 1 : 0);
    const modelRowCount = Math.min(5, vm.models.filter((r) => r.totalTokens > 0).length || 1);
    const cacheHeight = 258;
    const projectsHeight = Math.max(150, 44 + projectRowCount * 33 + 46);
    const modelHeight = Math.max(150, 64 + modelRowCount * 33 + 30);
    if (wide) {
      const height = Math.max(cacheHeight, projectsHeight, modelHeight);
      const cacheWidth = contentWidth * 0.36;
      const projectsWidth = contentWidth * 0.31 - gap;
      const modelWidth = contentWidth - cacheWidth - projectsWidth - gap * 2;
      addVerticalDivider(
        outer + cacheWidth + gap / 2,
        top,
        height,
        "lower-column-divider",
      );
      addVerticalDivider(
        outer + cacheWidth + gap + projectsWidth + gap / 2,
        top,
        height,
        "lower-column-divider",
      );
      buildCacheByDayPanel(outer, top, cacheWidth, height);
      buildProjectsPanel(outer + cacheWidth + gap, top, projectsWidth, height);
      buildModelCachePanel(outer + cacheWidth + projectsWidth + gap * 2, top, modelWidth, height);
      return top + height;
    }
    buildCacheByDayPanel(outer, top, contentWidth, cacheHeight);
    const rowTop = top + cacheHeight + gap;
    const half = (contentWidth - gap) / 2;
    const rowHeight = Math.max(projectsHeight, modelHeight);
    addVerticalDivider(
      outer + half + gap / 2,
      rowTop,
      rowHeight,
      "lower-column-divider",
    );
    buildProjectsPanel(outer, rowTop, half, rowHeight);
    buildModelCachePanel(outer + half + gap, rowTop, half, rowHeight);
    return rowTop + rowHeight;
  }

  // ---------------------------------------------------------------- compose
  const body = [];
  const headerBottom = buildHeaderSection();
  const warningTop = headerBottom + 10;
  const warningBottom = buildIntegrityWarnings(warningTop);
  const kpiBottom = buildKpiSection(
    warningBottom + (warningBottom > warningTop ? 8 : 0),
  );
  const mixBottom = buildModelMixSection(kpiBottom + 10);
  const chartBottom = buildDailyChartSection(mixBottom + 10);
  const lowerBottom = buildLowerSection(chartBottom + 14);
  const height = Math.ceil(lowerBottom + 16);

  const description =
    "Dark report card: conditional integrity warnings; total usage, input-weighted cache efficiency, fast-mode share, and active-project KPI cards beside the sampled weekly-limit state; a model-mix strip; stacked daily token columns by model with hatched fast-mode overlays and the sampled weekly meter drawn as solid confirmed intervals and dashed unobserved gaps; plus daily cache efficiency, top projects, and per-model cache tables.";
  body.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="trend-title trend-description">`,
    `<title id="trend-title">${escapeXml(`Token Ledger · ${meta.rangeDays}-day trend`)}</title>`,
    `<desc id="trend-description">${escapeXml(description)}</desc>`,
    defs,
    `<rect width="100%" height="100%" fill="${COLORS.background}"/>`,
    ...elements,
    "</svg>",
  );
  return body.join("\n");
}

export async function writeTrendPng(svg, outputPath) {
  await sharp(Buffer.from(svg, "utf8")).png().toFile(outputPath);
}
