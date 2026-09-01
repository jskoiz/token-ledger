// Pure view model for the PNG trend report. Builds validated,
// reconciliation-safe report data from a snapshot and range bounds so the SVG
// renderer consumes one bounded event set instead of recalculating totals in
// every layout section. Contains no SVG, positions, colors, or formatted
// strings.

import {
  normalizeQuotaTimeline,
  trendModelLabel,
  weeklyQuotaObservations,
} from "./token-ledger-trend.mjs";
import { historyScopeLabel } from "../lib/token-ledger-collection.mjs";
import {
  CODEX_CREDIT_RATE_CARD_AS_OF,
  isFastServiceTier,
} from "../lib/token-ledger-rates.mjs";
import { MAX_SAFE_TOKEN_COUNT } from "../lib/token-ledger-usage.mjs";
import {
  localDateBoundary,
  localDateString,
  shiftCalendarDate,
} from "../lib/token-ledger-calendar.mjs";
import { SOURCE_STATUSES } from "./token-ledger-source-status.mjs";

export { shiftCalendarDate, SOURCE_STATUSES };

const DAY_MS = 86_400_000;
// Two readings this close in percent confirm a flat reported interval.
const METER_EQUAL_TOLERANCE = 0.05;
// Remaining percent at or below this reads as an exhausted meter.
const METER_EXHAUSTED_TOLERANCE = 0.05;
const RECONCILE_RELATIVE_TOLERANCE = 1e-6;
const RECONCILE_ABSOLUTE_TOLERANCE = 1.5;

// Fast mode is an overlapping usage property, not a separate model. Both
// recognized service-tier labels count.
export function isFastMode(serviceTier) {
  return isFastServiceTier(serviceTier);
}

function finiteTimestamp(value) {
  // Snapshot timestamps are serialized as ISO strings. Keep finite numeric
  // epoch milliseconds for existing callers, but do not let Date coerce
  // null, booleans, objects, or other non-timestamp values.
  if (Number.isFinite(value)) {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const text = primitiveString(value);
  if (text === null) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function primitiveString(value) {
  try {
    const text = String.prototype.valueOf.call(value);
    return text === value ? text : null;
  } catch {
    return null;
  }
}

function dateStringFromParts(year, month, day) {
  return [year, month, day]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

function offsetAt(instant, timeZone) {
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

function localDateTimeParts(timestampMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    dateString: dateStringFromParts(values.year, values.month, values.day),
    hour: values.hour,
    minute: values.minute,
    second: values.second,
    millisecond: new Date(timestampMs).getUTCMilliseconds(),
  };
}

function zonedDateTime(dateString, timeZone, time = {}) {
  const [year, month, day] = dateString.split("-").map(Number);
  const utcGuess = Date.UTC(
    year,
    month - 1,
    day,
    time.hour ?? 0,
    time.minute ?? 0,
    time.second ?? 0,
    time.millisecond ?? 0,
  );
  let instant = new Date(utcGuess - offsetAt(new Date(utcGuess), timeZone));
  instant = new Date(utcGuess - offsetAt(instant, timeZone));
  return instant;
}

export function zonedMidnight(dateString, timeZone) {
  return localDateBoundary(dateString, timeZone);
}

// Whether the stored input/output components of an event can be trusted.
// Mirrors the importer's breakdownAvailable rule for snapshots that predate
// the stored flag.
function usableComponents(event) {
  if (event.breakdownAvailable === true) return true;
  if (event.breakdownAvailable === false) return false;
  const total = Math.max(0, Number(event.totalTokens) || 0);
  const input = Math.max(0, Number(event.inputTokens) || 0);
  const output = Math.max(0, Number(event.outputTokens) || 0);
  if (total === 0) return input > 0 || output > 0;
  return input + output === total && (input > 0 || output > 0);
}

// The moment the report's event window actually ends. A verified-current
// source may report through the wall clock; every other source status must
// stop at the snapshot's own capture time so the report never claims data it
// could not have seen.
export function resolveEffectiveEnd({
  snapshot = {},
  bounds,
  reportTimeMs = null,
  sourceStatus = "unchecked-cache",
}) {
  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();
  const generatedAtMs = finiteTimestamp(snapshot.generatedAt);
  const sourceCutoffAtMs = finiteTimestamp(
    snapshot.provenance?.sourceCutoffAt,
  );
  const wallClockMs = Number.isFinite(reportTimeMs) ? reportTimeMs : endMs;
  // The capture-time cutoff is inclusive: an event stamped exactly at
  // generatedAt was part of the capture.
  const cutoff = sourceStatus === "verified-current"
    ? wallClockMs
    : (sourceCutoffAtMs ?? generatedAtMs) === null
      ? wallClockMs
      : (sourceCutoffAtMs ?? generatedAtMs) + 1;
  return Math.max(startMs, Math.min(endMs, cutoff));
}

function approxEqual(left, right) {
  return (
    Math.abs(left - right) <=
    Math.max(
      RECONCILE_ABSOLUTE_TOLERANCE,
      RECONCILE_RELATIVE_TOLERANCE * Math.max(Math.abs(left), Math.abs(right)),
    )
  );
}

function assertReconciles(label, left, right) {
  if (!approxEqual(left, right)) {
    throw new Error(
      `Report reconciliation failed: ${label} (${left} vs ${right})`,
    );
  }
}

function modelRowFor(map, model) {
  const row = map.get(model) ?? {
    model,
    totalTokens: 0,
    normalTokens: 0,
    fastTokens: 0,
    cacheInputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    estimated: false,
  };
  map.set(model, row);
  return row;
}

function buildMeter({ snapshot, bounds, effectiveEndMs, sourceStatus, events }) {
  const startMs = bounds.start.getTime();
  const stale = sourceStatus === "stale-fallback";
  // weeklyQuotaObservations owns quota identity and account-scope selection;
  // this layer only applies the report-range cutoff to its selected meter.
  const selected = weeklyQuotaObservations(snapshot);
  const observationsAll = normalizeQuotaTimeline(selected).filter(
    (observation) => observation.timestampMs < effectiveEndMs,
  );

  const empty = {
    status: "unavailable",
    stale,
    remainingPercent: null,
    lastObservedAtMs: null,
    observedThroughMs: null,
    firstExhaustedObservedAtMs: null,
    resetsAtMs: null,
    resetInMs: null,
    cycleStartMs: null,
    cycleBurnPercent: null,
    burnPerDay: null,
    runwayDays: null,
    tokensPerMeterPoint: null,
    observations: [],
    segments: [],
    resets: [],
  };
  if (!observationsAll.length) return empty;

  const latest = observationsAll.at(-1);
  const remainingPercent = Math.max(
    0,
    Math.min(100, 100 - latest.normalizedUsedPercent),
  );

  // Points for the sampled meter line: real observations inside the range
  // plus one carried anchor at the range start when an earlier reading
  // exists. The anchor is not drawn as a dot.
  const inRange = observationsAll.filter(
    (observation) => observation.timestampMs >= startMs,
  );
  const before = observationsAll.filter(
    (observation) => observation.timestampMs < startMs,
  );
  const points = [];
  const anchor = before.at(-1);
  if (anchor && (!inRange.length || inRange[0].cycle === anchor.cycle)) {
    points.push({
      timestampMs: startMs,
      remainingPercent: Math.max(
        0,
        Math.min(100, 100 - anchor.normalizedUsedPercent),
      ),
      cycle: anchor.cycle,
      observed: false,
    });
  }
  for (const observation of inRange) {
    points.push({
      timestampMs: observation.timestampMs,
      remainingPercent: Math.max(
        0,
        Math.min(100, 100 - observation.normalizedUsedPercent),
      ),
      cycle: observation.cycle,
      observed: true,
    });
  }

  // Straight segments between adjacent readings of one cycle. Repeated equal
  // readings confirm a flat reported interval; a changed value means the
  // movement happened somewhere unobserved, so the connector is a gap.
  const segments = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from.cycle !== to.cycle) continue;
    if (to.timestampMs - from.timestampMs <= 0) continue;
    segments.push({
      fromMs: from.timestampMs,
      toMs: to.timestampMs,
      fromPercent: from.remainingPercent,
      toPercent: to.remainingPercent,
      cycle: from.cycle,
      kind:
        Math.abs(to.remainingPercent - from.remainingPercent) <=
        METER_EQUAL_TOLERANCE
          ? "confirmed"
          : "gap",
    });
  }

  // Cycle resets that land inside the display window. The reset moment is
  // derived from the window schedule, not directly observed.
  const resets = [];
  const seenCycles = new Set();
  for (const observation of observationsAll) {
    if (seenCycles.has(observation.cycle)) continue;
    seenCycles.add(observation.cycle);
    if (!observation.reset) continue;
    const timestampMs = Math.min(
      observation.cycleStartMs,
      observation.timestampMs,
    );
    if (timestampMs < startMs || timestampMs >= effectiveEndMs) continue;
    resets.push({
      timestampMs,
      observedAtMs: observation.timestampMs,
      kind: observation.resetKind ?? "restart",
      inferred: true,
    });
  }

  // Pace uses only the active weekly cycle: observed burn between its first
  // and last readings, never the whole report range.
  const cycleObservations = observationsAll.filter(
    (observation) => observation.cycle === latest.cycle,
  );
  const firstCycleObservation = cycleObservations[0];
  const cycleBurnPercent =
    latest.normalizedUsedPercent - firstCycleObservation.normalizedUsedPercent;
  const observedCycleMs = latest.timestampMs - firstCycleObservation.timestampMs;
  const burnPerDay =
    cycleBurnPercent > 0 && observedCycleMs > 0
      ? cycleBurnPercent / (observedCycleMs / DAY_MS)
      : null;
  const runwayDays =
    burnPerDay !== null && burnPerDay > 0 ? remainingPercent / burnPerDay : null;
  let cycleTokens = 0;
  if (cycleBurnPercent > 0) {
    for (const event of events) {
      if (
        event.timestampMs > firstCycleObservation.timestampMs &&
        event.timestampMs <= latest.timestampMs
      ) {
        cycleTokens += event.tokens;
      }
    }
  }
  const tokensPerMeterPoint =
    cycleBurnPercent > 0 && cycleTokens > 0
      ? cycleTokens / cycleBurnPercent
      : null;

  const firstExhausted = cycleObservations.find(
    (observation) =>
      100 - observation.normalizedUsedPercent <= METER_EXHAUSTED_TOLERANCE,
  );
  const resetsAtMs = Number.isFinite(latest.resetsAt)
    ? latest.resetsAt * 1_000
    : null;
  const resetInMs =
    resetsAtMs !== null && resetsAtMs > effectiveEndMs
      ? resetsAtMs - effectiveEndMs
      : null;

  let status = "active";
  if (remainingPercent <= METER_EXHAUSTED_TOLERANCE) {
    status = "exhausted";
  } else if (
    runwayDays !== null &&
    resetInMs !== null &&
    runwayDays * DAY_MS < resetInMs
  ) {
    status = "at-risk";
  }

  return {
    status,
    stale,
    remainingPercent,
    lastObservedAtMs: latest.timestampMs,
    observedThroughMs: latest.timestampMs,
    firstExhaustedObservedAtMs: firstExhausted?.timestampMs ?? null,
    resetsAtMs,
    resetInMs,
    cycleStartMs: latest.cycleStartMs ?? null,
    cycleBurnPercent,
    burnPerDay,
    runwayDays,
    tokensPerMeterPoint,
    observations: points,
    segments,
    resets,
  };
}

export function buildTrendReportViewModel({
  snapshot = {},
  bounds,
  days = null,
  reportTimeMs = null,
  sourceStatus = "unchecked-cache",
  projectRows = null,
  events = null,
  priorEvents = null,
}) {
  if (!SOURCE_STATUSES.includes(sourceStatus)) {
    throw new Error(`Unknown report source status: ${sourceStatus}`);
  }
  const timeZone = bounds.timeZone;
  const startMs = bounds.start.getTime();
  const requestedEndMs = bounds.end.getTime();
  const rangeDays = Number(days) || bounds.rangeDays || 7;
  const effectiveEndMs = resolveEffectiveEnd({
    snapshot,
    bounds,
    reportTimeMs,
    sourceStatus,
  });
  const partialFinalDay = effectiveEndMs < requestedEndMs;

  const dayStrings = Array.from({ length: rangeDays }, (_, index) =>
    shiftCalendarDate(bounds.startDateString, index),
  );
  const dayIndexByString = new Map(
    dayStrings.map((dateString, index) => [dateString, index]),
  );
  const lastObservedMs = Math.max(startMs, effectiveEndMs - 1);
  const lastObservedDateString = localDateString(lastObservedMs, timeZone);
  const lastObservedDayIndex = dayIndexByString.get(lastObservedDateString);
  const lastObservedDayEndMs =
    lastObservedDayIndex === undefined
      ? null
      : zonedMidnight(
          shiftCalendarDate(lastObservedDateString, 1),
          timeZone,
        ).getTime();
  const partialDayIndex =
    partialFinalDay &&
    effectiveEndMs > startMs &&
    lastObservedDayIndex !== undefined &&
    effectiveEndMs !== lastObservedDayEndMs
      ? lastObservedDayIndex
      : null;
  const daily = dayStrings.map((dateString, index) => ({
    dateString,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    cacheRatePercent: null,
    modelCalls: 0,
    estimated: false,
    observed: !partialFinalDay ||
      (lastObservedDayIndex !== undefined && index <= lastObservedDayIndex),
    partial: partialDayIndex === index,
    models: new Map(),
  }));

  // One pass over the selected range classifies every event once; the bounded
  // set feeds every panel so subtotals reconcile by construction. Callers that
  // already built a shared range analysis may provide its split current and
  // prior fragments so the image report uses the exact same allocations as
  // the terminal and cache renderers.
  const boundedEvents = [];
  const priorStartMs = zonedMidnight(
    shiftCalendarDate(bounds.startDateString, -rangeDays),
    timeZone,
  ).getTime();
  const effectiveLocal = localDateTimeParts(effectiveEndMs, timeZone);
  const priorEndMs = zonedDateTime(
    shiftCalendarDate(effectiveLocal.dateString, -rangeDays),
    timeZone,
    effectiveLocal,
  ).getTime();
  let priorEquivalentTokens = 0;
  let priorHasEvents = false;
  let priorEquivalentEstimated = false;

  const models = new Map();
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let fastTokens = 0;
  let detailedTokens = 0;
  let detailedCalls = 0;
  let modelCalls = 0;

  const currentEvents = Array.isArray(events) ? events : snapshot.events ?? [];
  const comparisonEvents = Array.isArray(priorEvents)
    ? priorEvents
    : snapshot.events ?? [];
  const rawTokenTotal = currentEvents.reduce((sum, event) => {
    const tokens = Number(event?.totalTokens);
    return Number.isFinite(tokens) && tokens > 0 ? sum + tokens : sum;
  }, 0);
  const tokenScale = Number.isFinite(rawTokenTotal) &&
      rawTokenTotal > MAX_SAFE_TOKEN_COUNT
    ? rawTokenTotal / MAX_SAFE_TOKEN_COUNT
    : 1;
  const scaledTokens = (value) => {
    const tokens = Number(value);
    return Number.isFinite(tokens) && tokens > 0 ? tokens / tokenScale : 0;
  };
  for (const event of comparisonEvents) {
    const timestampMs = finiteTimestamp(event.timestamp);
    if (timestampMs === null) continue;
    const tokens = scaledTokens(event.totalTokens);
    if (timestampMs >= priorStartMs && timestampMs < priorEndMs) {
      priorEquivalentTokens += tokens;
      priorHasEvents = true;
      priorEquivalentEstimated ||=
        tokens > 0 && event.rangeAllocationEstimated === true;
    }
  }
  for (const event of currentEvents) {
    const timestampMs = finiteTimestamp(event.timestamp);
    if (timestampMs === null) continue;
    if (timestampMs < startMs || timestampMs >= effectiveEndMs) continue;

    const tokens = scaledTokens(event.totalTokens);
    const model = trendModelLabel(event.model);
    const fast = isFastMode(event.serviceTier);
    const usable = usableComponents(event);
    const input = usable ? scaledTokens(event.inputTokens) : 0;
    const output = usable ? scaledTokens(event.outputTokens) : 0;
    const cached = usable
      ? Math.min(input, scaledTokens(event.cachedInputTokens))
      : 0;
    const estimated = tokens > 0 && event.rangeAllocationEstimated === true;

    boundedEvents.push({ timestampMs, tokens, model, fast, event });
    totalTokens += tokens;
    modelCalls += 1;
    if (usable) {
      detailedTokens += tokens;
      detailedCalls += 1;
    }
    inputTokens += input;
    outputTokens += output;
    cachedInputTokens += cached;
    if (fast) fastTokens += tokens;

    const modelRow = modelRowFor(models, model);
    modelRow.totalTokens += tokens;
    if (fast) modelRow.fastTokens += tokens;
    else modelRow.normalTokens += tokens;
    modelRow.cacheInputTokens += input;
    modelRow.cachedInputTokens += cached;
    modelRow.estimated ||= estimated;

    const dayRow = daily[dayIndexByString.get(localDateString(timestampMs, timeZone)) ?? -1];
    if (dayRow) {
      dayRow.totalTokens += tokens;
      dayRow.inputTokens += input;
      dayRow.outputTokens += output;
      dayRow.cachedInputTokens += cached;
      dayRow.modelCalls += 1;
      dayRow.estimated ||= estimated;
      const dayModel = dayRow.models.get(model) ?? {
        model,
        totalTokens: 0,
        normalTokens: 0,
        fastTokens: 0,
        estimated: false,
      };
      dayModel.totalTokens += tokens;
      if (fast) dayModel.fastTokens += tokens;
      else dayModel.normalTokens += tokens;
      dayModel.estimated ||= estimated;
      dayRow.models.set(model, dayModel);
    }
  }

  for (const row of daily) {
    row.uncachedInputTokens = Math.max(0, row.inputTokens - row.cachedInputTokens);
    row.cacheRatePercent =
      row.inputTokens > 0
        ? (row.cachedInputTokens / row.inputTokens) * 100
        : null;
    row.models = [...row.models.values()].sort(
      (left, right) => right.totalTokens - left.totalTokens,
    );
  }

  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const modelRows = [...models.values()]
    .map((row) => ({
      ...row,
      sharePercent: totalTokens > 0 ? (row.totalTokens / totalTokens) * 100 : 0,
      uncachedInputTokens: Math.max(
        0,
        row.cacheInputTokens - row.cachedInputTokens,
      ),
      cacheRatePercent:
        row.cacheInputTokens > 0
          ? (row.cachedInputTokens / row.cacheInputTokens) * 100
          : null,
    }))
    .sort(
      (left, right) =>
        right.totalTokens - left.totalTokens ||
        left.model.localeCompare(right.model),
    );

  // Projects: prefer sanitized rows aggregated by the caller from the same
  // bounded event set; otherwise group locally by raw project label.
  let allProjectRows;
  if (projectRows) {
    allProjectRows = projectRows.map((row) => ({
      project: row.project,
      displayProject: row.displayProject ?? row.project,
      totalTokens: Math.max(0, Number(row.totalTokens) || 0),
      estimated: row.estimated === true,
    }));
  } else {
    const projectTotals = new Map();
    for (const { tokens, event } of boundedEvents) {
      if (!(tokens > 0)) continue;
      const project =
        String(event.project ?? "")
          .replace(/[\t\r\n]+/g, " ")
          .replace(/\s+/g, " ")
          .trim() || "Unlabelled activity";
      const row = projectTotals.get(project) ?? {
        totalTokens: 0,
        estimated: false,
      };
      row.totalTokens += tokens;
      row.estimated ||= event.rangeAllocationEstimated === true;
      projectTotals.set(project, row);
    }
    allProjectRows = [...projectTotals.entries()].map(
      ([project, row]) => ({
        project,
        displayProject: project,
        totalTokens: row.totalTokens,
        estimated: row.estimated,
      }),
    );
  }
  allProjectRows.sort(
    (left, right) =>
      right.totalTokens - left.totalTokens ||
      left.project.localeCompare(right.project),
  );
  const topProjects = allProjectRows.slice(0, 3).map((row) => ({
    ...row,
    sharePercent: totalTokens > 0 ? (row.totalTokens / totalTokens) * 100 : 0,
  }));
  const remainderRows = allProjectRows.slice(3);
  const remainderTokens = remainderRows.reduce(
    (sum, row) => sum + row.totalTokens,
    0,
  );
  const projectRemainder = {
    count: remainderRows.length,
    totalTokens: remainderTokens,
    sharePercent: totalTokens > 0 ? (remainderTokens / totalTokens) * 100 : 0,
    estimated: remainderRows.some((row) => row.estimated),
  };
  const topThreeProjectTokens = topProjects.reduce(
    (sum, row) => sum + row.totalTokens,
    0,
  );

  const meter = buildMeter({
    snapshot,
    bounds,
    effectiveEndMs,
    sourceStatus,
    events: boundedEvents,
  });

  const durationMs = effectiveEndMs - startMs;
  const totalDeltaPercent =
    priorHasEvents && priorEquivalentTokens > 0 && durationMs > 0
      ? (totalTokens / priorEquivalentTokens - 1) * 100
      : null;
  const estimated = daily.some((row) => row.estimated);
  const rawLegacySnapshotStatus = snapshot.coverage?.legacySnapshotStatus ??
    snapshot.metadata?.durableLedger?.legacySnapshotStatus;
  const legacySnapshotStatus = primitiveString(rawLegacySnapshotStatus);
  const maximumEstimatedResolutionSeconds = boundedEvents.reduce(
    (maximum, { tokens, event }) => {
      if (!(tokens > 0) || event.rangeAllocationEstimated !== true) {
        return maximum;
      }
      const resolutionSeconds = Number(event.resolutionSeconds);
      return Number.isFinite(resolutionSeconds) && resolutionSeconds > 0
        ? Math.max(maximum, resolutionSeconds)
        : maximum;
    },
    0,
  );

  const snapshotGeneratedAtMs = finiteTimestamp(snapshot.generatedAt);
  const viewModel = {
    meta: {
      startMs,
      requestedEndMs,
      effectiveEndMs,
      timeZone,
      rangeDays,
      startDateString: bounds.startDateString,
      endDateString: bounds.endDateString,
      partialFinalDay,
      observedThroughDateString:
        lastObservedDayIndex === undefined ? null : lastObservedDateString,
      reportThroughMs: effectiveEndMs,
      meterObservedThroughMs: meter.observedThroughMs,
      sourceStatus,
    },
    summary: {
      totalTokens,
      estimated,
      priorEquivalentTokens: priorHasEvents ? priorEquivalentTokens : null,
      priorEquivalentEstimated:
        priorHasEvents && priorEquivalentEstimated,
      totalDeltaPercent,
      totalDeltaEstimated:
        totalDeltaPercent !== null && (estimated || priorEquivalentEstimated),
      inputTokens,
      outputTokens,
      cachedInputTokens,
      uncachedInputTokens,
      cacheRatePercent:
        inputTokens > 0 ? (cachedInputTokens / inputTokens) * 100 : null,
      fastTokens,
      fastEstimated: boundedEvents.some(
        ({ fast, tokens, event }) =>
          fast && tokens > 0 && event.rangeAllocationEstimated === true,
      ),
      fastSharePercent: totalTokens > 0 ? (fastTokens / totalTokens) * 100 : null,
      activeProjects: allProjectRows.length,
      topThreeProjectTokens,
      topThreeProjectSharePercent:
        totalTokens > 0 ? (topThreeProjectTokens / totalTokens) * 100 : null,
    },
    models: modelRows,
    daily,
    meter,
    projects: topProjects,
    projectRemainder,
    coverage: {
      modelCalls,
      detailedCalls,
      detailedTokens,
      componentCoveragePercent:
        totalTokens > 0 ? (detailedTokens / totalTokens) * 100 : 100,
      parseErrors: Math.max(0, Number(snapshot.coverage?.parseErrors) || 0),
      invalidTokenRecords: Math.max(
        0,
        Number(snapshot.coverage?.invalidTokenRecords) || 0,
      ),
      invalidQuotaRecords: Math.max(
        0,
        Number(snapshot.coverage?.invalidQuotaRecords) || 0,
      ),
      sourceIncomplete: snapshot.coverage?.sourceIncomplete === true,
      estimated,
      estimatedBucketCount: daily.filter((row) => row.estimated).length,
      maximumResolutionSeconds: maximumEstimatedResolutionSeconds || null,
      legacySnapshotStatus,
    },
    provenance: {
      localOnly: (snapshot.provenance?.kind ?? "codex-local-metadata") ===
        "codex-local-metadata",
      historyScope: historyScopeLabel(snapshot),
      snapshotGeneratedAtMs,
      rateCardAsOf: CODEX_CREDIT_RATE_CARD_AS_OF,
      snapshotRateCardAsOf: snapshot.provenance?.rateCardAsOf ?? null,
    },
  };

  validateReportViewModel(viewModel);
  return viewModel;
}

// Core reconciliation invariants from the report specification. A failure is
// a calculation bug, never something to render around, so it throws with a
// descriptive message.
export function validateReportViewModel(viewModel) {
  const { summary, daily, models, projects, projectRemainder } = viewModel;

  assertReconciles(
    "daily totals must sum to total usage",
    daily.reduce((sum, row) => sum + row.totalTokens, 0),
    summary.totalTokens,
  );
  assertReconciles(
    "model totals must sum to total usage",
    models.reduce((sum, row) => sum + row.totalTokens, 0),
    summary.totalTokens,
  );
  assertReconciles(
    "project totals plus remainder must sum to total usage",
    projects.reduce((sum, row) => sum + row.totalTokens, 0) +
      projectRemainder.totalTokens,
    summary.totalTokens,
  );
  assertReconciles(
    "daily input must sum to overall input",
    daily.reduce((sum, row) => sum + row.inputTokens, 0),
    summary.inputTokens,
  );
  assertReconciles(
    "model cache input must sum to overall input",
    models.reduce((sum, row) => sum + row.cacheInputTokens, 0),
    summary.inputTokens,
  );
  if (summary.cachedInputTokens > summary.inputTokens) {
    throw new Error(
      "Report reconciliation failed: cached input exceeds input",
    );
  }
  assertReconciles(
    "uncached input must equal input minus cached input",
    summary.uncachedInputTokens,
    summary.inputTokens - summary.cachedInputTokens,
  );
  if (summary.fastTokens > summary.totalTokens) {
    throw new Error(
      "Report reconciliation failed: fast-mode tokens exceed total usage",
    );
  }
  for (const row of daily) {
    if (row.inputTokens > row.totalTokens) {
      throw new Error(
        `Report reconciliation failed: ${row.dateString} input exceeds its total`,
      );
    }
    if (row.cachedInputTokens > row.inputTokens) {
      throw new Error(
        `Report reconciliation failed: ${row.dateString} cached input exceeds its input`,
      );
    }
  }
  for (const row of models) {
    if (row.fastTokens > row.totalTokens) {
      throw new Error(
        `Report reconciliation failed: ${row.model} fast tokens exceed its total`,
      );
    }
    if (row.uncachedInputTokens < 0) {
      throw new Error(
        `Report reconciliation failed: ${row.model} uncached input is negative`,
      );
    }
  }
  if (
    summary.inputTokens > 0 &&
    !approxEqual(
      summary.cacheRatePercent,
      (summary.cachedInputTokens / summary.inputTokens) * 100,
    )
  ) {
    throw new Error(
      "Report reconciliation failed: cache rate must be input-token weighted",
    );
  }
}
