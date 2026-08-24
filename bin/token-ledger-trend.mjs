import {
  creditsForUsage,
  RATE_CARD_AS_OF,
} from "../lib/token-ledger-rates.mjs";
import {
  splitUsageBucketsAtBoundaries,
  usageBuckets,
  usageBucketsInRange,
} from "../lib/token-ledger-usage.mjs";

const WEEK_MINUTES = 10_080;
const RESET_JITTER_SECONDS = 5 * 60;
const MAX_TREND_DAYS = 3_650;
// Meter observations more than this far apart get their burn spread across
// calendar days as an estimate rather than pinned to the observation day.
const LONG_GAP_MS = 36 * 60 * 60 * 1_000;

const MODEL_SORT_ORDER = new Map([
  ["Luna", 0],
  ["Sol", 1],
  ["Terra", 2],
  ["GPT-5.5", 3],
  ["GPT-5.4", 4],
  ["Daybreak", 5],
  ["Auto review", 6],
  ["Other", 7],
  ["Unknown", 8],
  ["Unattributed", 9],
]);

function finiteTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function dateStringFromParts(parts) {
  return [parts.year, parts.month, parts.day]
    .map((value, index) =>
      index === 0 ? String(value) : String(value).padStart(2, "0"),
    )
    .join("-");
}

function shiftCalendarDate(dateString, amount) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return dateStringFromParts({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
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

function zonedMidnight(dateString, timeZone) {
  const [year, month, day] = dateString.split("-").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day);
  let instant = new Date(utcGuess - offsetAt(new Date(utcGuess), timeZone));
  instant = new Date(utcGuess - offsetAt(instant, timeZone));
  return instant;
}

function localDateString(timestampMs, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestampMs));
}

function todayInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return dateStringFromParts(values);
}

export function multiDayBounds(value, timeZone, rangeDays) {
  const days = Number(rangeDays);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_TREND_DAYS) {
    throw new Error(`Trend range must be between 1 and ${MAX_TREND_DAYS} days.`);
  }
  let endDateString = value;
  if (!endDateString || endDateString === "today") {
    endDateString = todayInTimeZone(timeZone);
  } else if (endDateString === "yesterday") {
    endDateString = shiftCalendarDate(todayInTimeZone(timeZone), -1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDateString)) {
    throw new Error("Trend end date must be YYYY-MM-DD, today, or yesterday.");
  }
  const [year, month, day] = endDateString.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar day: ${endDateString}`);
  }
  const startDateString = shiftCalendarDate(endDateString, -days + 1);
  return {
    dateString: endDateString,
    startDateString,
    endDateString,
    start: zonedMidnight(startDateString, timeZone),
    end: zonedMidnight(shiftCalendarDate(endDateString, 1), timeZone),
    timeZone,
    rangeDays: days,
  };
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

export function trendModelLabel(value) {
  const model = String(value || "unknown").trim().toLowerCase();
  if (model.includes("luna")) return "Luna";
  if (model.includes("sol")) return "Sol";
  if (model.includes("terra")) return "Terra";
  if (model.includes("daybreak")) return "Daybreak";
  if (model.includes("auto-review")) return "Auto review";
  if (model === "gpt-5.5" || model.startsWith("gpt-5.5-")) return "GPT-5.5";
  if (model === "gpt-5.4" || model.startsWith("gpt-5.4-")) return "GPT-5.4";
  if (model === "unknown" || !model) return "Unknown";
  return "Other";
}

export function weeklyQuotaObservations(snapshot = {}) {
  let observations = (snapshot.quotaObservations ?? [])
    .map((observation) => {
      const timestampMs = finiteTimestamp(observation.timestamp);
      const lastSeenAtMs = finiteTimestamp(observation.lastSeenAt);
      return {
        ...observation,
        timestampMs,
        observedThroughMs:
          timestampMs === null
            ? lastSeenAtMs
            : Math.max(timestampMs, lastSeenAtMs ?? timestampMs),
        resetsAt: Number(observation.resetsAt),
        usedPercent: Number(observation.usedPercent),
      };
    })
    .filter(
      (observation) =>
        Number(observation.windowMinutes) === WEEK_MINUTES &&
        observation.timestampMs !== null &&
        Number.isFinite(observation.resetsAt) &&
        observation.resetsAt > 0 &&
        Number.isFinite(observation.usedPercent),
    )
    .map((observation) => ({
      ...observation,
      usedPercent: clampPercent(observation.usedPercent),
    }));

  // Keep exactly one meter: the account-wide weekly limit. Legacy snapshots
  // tag it with scope: "account"; current snapshots carry a limitKey per
  // limit bucket, where the account-wide bucket has no limitName. Named
  // buckets (per-model limit pools) are separate meters and must not be
  // stitched into this line.
  const accountScoped = observations.filter(
    (observation) => observation.scope === "account",
  );
  if (accountScoped.length) {
    observations = accountScoped;
  } else if (observations.some((observation) => observation.limitKey)) {
    const groups = new Map();
    for (const observation of observations) {
      const key = observation.limitKey ?? "anonymous";
      const group = groups.get(key) ?? [];
      group.push(observation);
      groups.set(key, group);
    }
    const accountWide = [...groups.values()].filter((group) =>
      group.every((observation) => !observation.limitName),
    );
    const pool = accountWide.length ? accountWide : [...groups.values()];
    observations = pool.sort((left, right) => right.length - left.length)[0];
  } else {
    const accountWide = observations.filter(
      (observation) => !observation.limitName,
    );
    if (accountWide.length) observations = accountWide;
  }

  observations.sort(
    (left, right) =>
      left.timestampMs - right.timestampMs || left.resetsAt - right.resetsAt,
  );
  return observations;
}

// The provider freezes resets_at for the lifetime of a limit window, so the
// reset timestamp is the window's identity. Cycles are therefore keyed by
// resets_at clusters instead of inferred from usage drops: refill events that
// start a fresh window days before the old one expires (limit restarts) and
// stale readings from sessions still reporting a superseded window would
// otherwise be fused into one line, producing meter drain that never happened.
export function normalizeQuotaTimeline(observations) {
  if (!observations.length) return [];

  const epochs = [];
  for (const observation of observations) {
    let epoch = epochs.find(
      (candidate) =>
        Math.abs(candidate.resetsAt - observation.resetsAt) <=
        RESET_JITTER_SECONDS,
    );
    if (!epoch) {
      epoch = { resetsAt: observation.resetsAt, observations: [] };
      epochs.push(epoch);
    }
    epoch.resetsAt = Math.max(epoch.resetsAt, observation.resetsAt);
    epoch.observations.push(observation);
  }
  for (const epoch of epochs) {
    epoch.firstMs = epoch.observations[0].timestampMs;
    epoch.lastMs = epoch.observations.at(-1).timestampMs;
  }
  epochs.sort(
    (left, right) =>
      left.firstMs - right.firstMs || left.resetsAt - right.resetsAt,
  );

  // A window with at most two readings sandwiched inside a longer-lived
  // window's span is a transient branch (for example a single stale refresh),
  // not a real refill.
  const kept = epochs.filter((epoch) => {
    if (epoch.observations.length > 2) return true;
    return !epochs.some(
      (other) =>
        other !== epoch &&
        other.observations.length > epoch.observations.length &&
        other.firstMs < epoch.firstMs &&
        other.lastMs > epoch.lastMs,
    );
  });

  const normalized = [];
  let previousEpoch = null;
  for (const [cycle, epoch] of kept.entries()) {
    const nextFirstMs = kept[cycle + 1]?.firstMs ?? Infinity;
    const resetKind =
      previousEpoch === null
        ? "start"
        : previousEpoch.resetsAt * 1_000 <=
            epoch.firstMs + RESET_JITTER_SECONDS * 1_000
          ? "weekly-expiry"
          : "restart";
    let usedPercent = null;
    let emitted = false;
    for (const observation of epoch.observations) {
      // Once a newer window starts reporting, remaining readings of this
      // window are stale echoes from long-lived sessions.
      if (observation.timestampMs >= nextFirstMs) continue;
      // Usage is cumulative inside a window; clamp display-rounding dips.
      usedPercent =
        usedPercent === null
          ? observation.usedPercent
          : Math.max(usedPercent, observation.usedPercent);
      normalized.push({
        ...observation,
        observedThroughMs: Math.min(
          Number.isFinite(observation.observedThroughMs)
            ? observation.observedThroughMs
            : observation.timestampMs,
          nextFirstMs,
        ),
        cycle,
        reset: !emitted && previousEpoch !== null,
        resetKind,
        cycleStartMs: (epoch.resetsAt - WEEK_MINUTES * 60) * 1_000,
        normalizedUsedPercent: usedPercent,
      });
      emitted = true;
    }
    if (emitted) previousEpoch = epoch;
  }
  return normalized;
}

export function eventCredits(event) {
  // Recompute from token components first so the current rate card applies;
  // snapshots can carry credits stored under an outdated card. Fast-mode
  // turns (service tier "priority") debit the limit at a higher rate.
  const computed = creditsForUsage(event.model, event, event.serviceTier);
  if (Number.isFinite(computed) && computed >= 0) return computed;
  const stored = Number(event.rateCardCredits);
  if (event.rateCardCredits !== null && event.rateCardCredits !== undefined) {
    // Stored credits from current snapshots already include the fast-mode
    // multiplier.
    if (Number.isFinite(stored) && stored >= 0) return stored;
  }
  return null;
}

function eventWeight(event, fallbackCreditsPerToken) {
  const credits = eventCredits(event);
  if (Number.isFinite(credits) && credits > 0) return credits;
  const tokens = Math.max(0, Number(event.totalTokens) || 0);
  return fallbackCreditsPerToken > 0 ? tokens * fallbackCreditsPerToken : tokens;
}

function allocateBurn(delta, events, timeZone) {
  if (!(delta > 0)) return { contributions: new Map(), method: "none" };

  let ratedCredits = 0;
  let ratedTokens = 0;
  let hasUnrated = false;
  for (const event of events) {
    const credits = eventCredits(event);
    const tokens = Math.max(0, Number(event.totalTokens) || 0);
    if (Number.isFinite(credits) && credits > 0) {
      ratedCredits += credits;
      ratedTokens += tokens;
    } else if (tokens > 0) {
      hasUnrated = true;
    }
  }

  const fallbackCreditsPerToken =
    ratedCredits > 0 && ratedTokens > 0 ? ratedCredits / ratedTokens : 0;
  const weights = new Map();
  const dayWeights = new Map();
  let totalWeight = 0;
  for (const event of events) {
    const weight = eventWeight(event, fallbackCreditsPerToken);
    if (!(weight > 0)) continue;
    const model = trendModelLabel(event.model);
    weights.set(model, (weights.get(model) ?? 0) + weight);
    if (timeZone) {
      const day = localDateString(event.timestampMs, timeZone);
      dayWeights.set(day, (dayWeights.get(day) ?? 0) + weight);
    }
    totalWeight += weight;
  }

  if (!(totalWeight > 0)) {
    return {
      contributions: new Map([["Unattributed", delta]]),
      method: "unattributed",
      dayShares: new Map(),
    };
  }

  const contributions = new Map();
  for (const [model, weight] of weights) {
    contributions.set(model, (delta * weight) / totalWeight);
  }
  const dayShares = new Map();
  for (const [day, weight] of dayWeights) {
    dayShares.set(day, weight / totalWeight);
  }
  return {
    contributions,
    method:
      ratedCredits > 0
        ? hasUnrated
          ? "mixed"
          : "rate-card"
        : "tokens",
    dayShares,
  };
}

// Fractions of the span [startMs, endMs) falling on each local calendar day.
function durationDayShares(startMs, endMs, timeZone) {
  if (!(endMs > startMs)) {
    return new Map([[localDateString(endMs, timeZone), 1]]);
  }
  const shares = new Map();
  let cursor = startMs;
  while (cursor < endMs) {
    const day = localDateString(cursor, timeZone);
    const nextMidnightMs = zonedMidnight(
      shiftCalendarDate(day, 1),
      timeZone,
    ).getTime();
    const sliceEnd = Math.min(endMs, Math.max(nextMidnightMs, cursor + 1));
    shares.set(day, (shares.get(day) ?? 0) + (sliceEnd - cursor));
    cursor = sliceEnd;
  }
  const total = [...shares.values()].reduce((sum, value) => sum + value, 0);
  return new Map([...shares].map(([day, value]) => [day, value / total]));
}

function tokenTotalsByModel(events) {
  const totals = new Map();
  for (const event of events) {
    const tokens = Math.max(0, Number(event.totalTokens) || 0);
    if (!(tokens > 0)) continue;
    const model = trendModelLabel(event.model);
    totals.set(model, (totals.get(model) ?? 0) + tokens);
  }
  return totals;
}

function modelSort(left, right) {
  const leftOrder = MODEL_SORT_ORDER.get(left) ?? MODEL_SORT_ORDER.size;
  const rightOrder = MODEL_SORT_ORDER.get(right) ?? MODEL_SORT_ORDER.size;
  return leftOrder - rightOrder || left.localeCompare(right);
}

function cloneAllocations(allocations) {
  return Object.fromEntries(
    [...allocations.entries()].sort(([left], [right]) => modelSort(left, right)),
  );
}

function eventsInBounds(events, bounds) {
  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();
  return usageBucketsInRange({ events }, startMs, endMs);
}

function buildModelStats(displayedEvents, intervals, bounds) {
  const rows = new Map();
  const rowFor = (model) => {
    const row = rows.get(model) ?? {
      model,
      tokens: 0,
      credits: 0,
      ratedTokens: 0,
      attributedTokens: 0,
      burnPoints: 0,
      efforts: new Map(),
    };
    rows.set(model, row);
    return row;
  };

  for (const event of displayedEvents) {
    const model = trendModelLabel(event.model);
    const row = rowFor(model);
    const tokens = Math.max(0, Number(event.totalTokens) || 0);
    const credits = eventCredits(event);
    row.tokens += tokens;
    if (Number.isFinite(credits) && credits >= 0) {
      row.credits += credits;
      row.ratedTokens += tokens;
    }
    const effort = String(event.effort || "unknown").toLowerCase();
    row.efforts.set(effort, (row.efforts.get(effort) ?? 0) + tokens);
  }

  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();
  for (const interval of intervals) {
    if (interval.endMs < startMs || interval.endMs >= endMs) continue;
    for (const [model, burnPoints] of interval.contributions) {
      const row = rowFor(model);
      row.burnPoints += burnPoints;
      row.attributedTokens += interval.modelTokens.get(model) ?? 0;
    }
  }

  return [...rows.values()]
    .map((row) => {
      const effortEntries = [...row.efforts.entries()].sort(
        (left, right) => right[1] - left[1],
      );
      const dominantEffort = effortEntries[0]?.[0] ?? "unknown";
      const dominantEffortShare =
        row.tokens > 0 ? (effortEntries[0]?.[1] ?? 0) / row.tokens : 0;
      return {
        ...row,
        efforts: Object.fromEntries(effortEntries),
        dominantEffort,
        dominantEffortShare,
        tokensPerBurnPoint:
          row.burnPoints > 0 && row.attributedTokens > 0
            ? row.attributedTokens / row.burnPoints
            : null,
        ratedPercent:
          row.tokens > 0 ? (row.ratedTokens / row.tokens) * 100 : null,
      };
    })
    .sort(
      (left, right) =>
        right.burnPoints - left.burnPoints ||
        right.tokens - left.tokens ||
        modelSort(left.model, right.model),
    );
}

export function buildUsageTrend(snapshot = {}, bounds) {
  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();
  const displayedEvents = eventsInBounds(usageBuckets(snapshot), bounds);
  const observations = normalizeQuotaTimeline(
    weeklyQuotaObservations(snapshot),
  ).filter((observation) => observation.timestampMs < endMs);

  if (!observations.length) {
    return {
      available: false,
      points: [],
      resets: [],
      burnIntervals: [],
      models: buildModelStats(displayedEvents, [], bounds),
      sampleCount: 0,
      allocationMethod: "unavailable",
      observedThroughMs: null,
      rateCardAsOf: snapshot.provenance?.rateCardAsOf ?? RATE_CARD_AS_OF,
    };
  }

  const sortedEvents = splitUsageBucketsAtBoundaries(
    usageBuckets(snapshot),
    [
      startMs,
      endMs,
      ...observations.flatMap((observation) => [
        observation.cycleStartMs,
        observation.timestampMs,
      ]),
    ],
  )
    .map((event) => ({ ...event, timestampMs: finiteTimestamp(event.timestamp) }))
    .filter((event) => event.timestampMs !== null && event.timestampMs < endMs)
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const points = [];
  const resets = [];
  const intervals = [];
  const methods = new Set();
  let eventIndex = 0;
  let activeCycle = null;
  let previousObservationMs = null;
  let previousUsedPercent = 0;
  let intervalStartMs = null;
  let pendingIntervalStartMs = null;
  let pendingEvents = [];
  let allocations = new Map();

  for (const observation of observations) {
    if (observation.cycle !== activeCycle) {
      activeCycle = observation.cycle;
      allocations = new Map();
      previousUsedPercent = 0;
      const inferredStartMs = observation.cycleStartMs;
      intervalStartMs = Math.min(
        observation.timestampMs,
        Math.max(inferredStartMs, previousObservationMs ?? inferredStartMs),
      );
      pendingIntervalStartMs = intervalStartMs;
      pendingEvents = [];
      if (previousObservationMs !== null) {
        resets.push({
          timestampMs: inferredStartMs,
          observedAtMs: observation.timestampMs,
          cycle: observation.cycle,
          kind: observation.resetKind ?? "restart",
        });
      }
    }

    while (
      eventIndex < sortedEvents.length &&
      sortedEvents[eventIndex].timestampMs <= intervalStartMs
    ) {
      eventIndex += 1;
    }
    const intervalEvents = [];
    while (
      eventIndex < sortedEvents.length &&
      sortedEvents[eventIndex].timestampMs <= observation.timestampMs
    ) {
      intervalEvents.push(sortedEvents[eventIndex]);
      eventIndex += 1;
    }
    pendingEvents.push(...intervalEvents);

    const delta = Math.max(
      0,
      observation.normalizedUsedPercent - previousUsedPercent,
    );
    const allocation = allocateBurn(delta, pendingEvents, bounds.timeZone);
    if (allocation.method !== "none" && observation.timestampMs >= startMs) {
      methods.add(allocation.method);
    }
    for (const [model, burnPoints] of allocation.contributions) {
      allocations.set(model, (allocations.get(model) ?? 0) + burnPoints);
    }
    if (delta > 0) {
      intervals.push({
        startMs: pendingIntervalStartMs,
        endMs: observation.timestampMs,
        cycle: observation.cycle,
        contributions: allocation.contributions,
        modelTokens: tokenTotalsByModel(pendingEvents),
        method: allocation.method,
        dayShares: allocation.dayShares?.size
          ? allocation.dayShares
          : durationDayShares(
              pendingIntervalStartMs,
              observation.timestampMs,
              bounds.timeZone,
            ),
        spansLongGap:
          observation.timestampMs - pendingIntervalStartMs > LONG_GAP_MS,
      });
      pendingEvents = [];
      pendingIntervalStartMs = observation.timestampMs;
    }
    points.push({
      timestampMs: observation.timestampMs,
      observedThroughMs: observation.observedThroughMs,
      cycle: observation.cycle,
      usedPercent: observation.normalizedUsedPercent,
      remainingPercent: 100 - observation.normalizedUsedPercent,
      allocations: cloneAllocations(allocations),
      observed: true,
    });
    previousUsedPercent = observation.normalizedUsedPercent;
    previousObservationMs = observation.timestampMs;
    intervalStartMs = observation.timestampMs;
  }

  const displayPoints = [];
  const beforeStart = [...points]
    .reverse()
    .find((point) => point.timestampMs <= startMs);
  if (beforeStart) {
    displayPoints.push({
      ...beforeStart,
      timestampMs: startMs,
      observed: beforeStart.timestampMs === startMs,
      carried: beforeStart.timestampMs !== startMs,
    });
  }
  displayPoints.push(
    ...points.filter(
      (point) => point.timestampMs > startMs && point.timestampMs < endMs,
    ),
  );

  // Repeated equal meter readings are compacted into an observed span. Extend
  // each displayed cycle only through its last real sample; never synthesize a
  // flat line through the unobserved remainder of the report range.
  const sourcePointsByCycle = new Map();
  for (const point of points) {
    const cyclePoints = sourcePointsByCycle.get(point.cycle) ?? [];
    cyclePoints.push(point);
    sourcePointsByCycle.set(point.cycle, cyclePoints);
  }
  const displayedCycles = new Set(displayPoints.map((point) => point.cycle));
  for (const cycle of displayedCycles) {
    const cyclePoints = sourcePointsByCycle.get(cycle) ?? [];
    const displayedCyclePoints = displayPoints.filter(
      (point) => point.cycle === cycle,
    );
    const lastPoint = displayedCyclePoints.at(-1);
    if (!lastPoint || !cyclePoints.length) continue;
    const observedThroughMs = Math.max(
      ...cyclePoints.map((point) => point.observedThroughMs),
    );
    const nextResetMs = resets.find((reset) => reset.cycle === cycle + 1)
      ?.timestampMs;
    const crossesNextReset = Number.isFinite(nextResetMs) &&
      observedThroughMs >= nextResetMs;
    const endpointMs = Math.min(observedThroughMs, endMs);
    if (!crossesNextReset && endpointMs > lastPoint.timestampMs) {
      displayPoints.push({
        ...lastPoint,
        timestampMs: endpointMs,
        observedThroughMs: endpointMs,
        observed: true,
        carried: false,
        confirmation: true,
      });
    }
  }
  displayPoints.sort(
    (left, right) => left.timestampMs - right.timestampMs || left.cycle - right.cycle,
  );

  const hasUnattributed = methods.has("unattributed");
  let allocationMethod = "unavailable";
  if (
    methods.has("mixed") ||
    (methods.has("rate-card") && methods.has("tokens"))
  ) {
    allocationMethod = "mixed rate-card and token weights";
  } else if (methods.has("rate-card")) {
    allocationMethod = "rate-card weights";
  } else if (methods.has("tokens")) {
    allocationMethod = "token weights";
  } else if (hasUnattributed) {
    allocationMethod = "unattributed burn";
  }
  if (hasUnattributed && allocationMethod !== "unattributed burn") {
    allocationMethod += " with unattributed gaps";
  }

  const burnIntervals = intervals
    .filter((interval) => interval.endMs >= startMs && interval.endMs < endMs)
    .map((interval) => ({
      startMs: Math.max(startMs, interval.startMs),
      endMs: interval.endMs,
      cycle: interval.cycle,
      contributions: cloneAllocations(interval.contributions),
      modelTokens: Object.fromEntries(interval.modelTokens),
      method: interval.method,
      dayShares: Object.fromEntries(interval.dayShares),
      spansLongGap: interval.spansLongGap,
    }));

  return {
    available: displayPoints.length > 0,
    points: displayPoints,
    resets: resets.filter(
      (reset) => reset.timestampMs >= startMs && reset.timestampMs < endMs,
    ),
    burnIntervals,
    models: buildModelStats(displayedEvents, intervals, bounds),
    sampleCount: points.filter(
      (point) => point.timestampMs >= startMs && point.timestampMs < endMs,
    ).length,
    allocationMethod,
    observedThroughMs:
      [...displayPoints].reverse().find((point) => point.observed)
        ?.timestampMs ?? null,
    rateCardAsOf: snapshot.provenance?.rateCardAsOf ?? RATE_CARD_AS_OF,
  };
}

// Bin observed meter drain into calendar-day (or multi-day) columns in the
// same percent unit as the meter line. Daily totals are the meter's own
// observed drops; only the per-model split within a drop and the day
// placement across long observation gaps are estimated.
export function buildBurnDayBins(trend, bounds, { days, binSize = 1 } = {}) {
  const rangeDays = Number(days) || bounds.rangeDays || 7;
  const binCount = Math.ceil(rangeDays / binSize);
  const bins = Array.from({ length: binCount }, (_, index) => ({
    startDateString: shiftCalendarDate(bounds.startDateString, index * binSize),
    endDateString: shiftCalendarDate(
      bounds.startDateString,
      Math.min(rangeDays, (index + 1) * binSize),
    ),
    values: new Map(),
    totalPercent: 0,
    approximate: false,
  }));
  const dayIndexByString = new Map(
    Array.from({ length: rangeDays }, (_, index) => [
      shiftCalendarDate(bounds.startDateString, index),
      index,
    ]),
  );

  for (const interval of trend?.burnIntervals ?? []) {
    for (const [day, fraction] of Object.entries(interval.dayShares ?? {})) {
      const dayIndex = dayIndexByString.get(day);
      if (dayIndex === undefined) continue;
      const bin = bins[Math.floor(dayIndex / binSize)];
      if (!bin) continue;
      if (interval.spansLongGap) bin.approximate = true;
      for (const [model, burnPoints] of Object.entries(
        interval.contributions ?? {},
      )) {
        const share = burnPoints * fraction;
        if (!(share > 0)) continue;
        bin.values.set(model, (bin.values.get(model) ?? 0) + share);
        bin.totalPercent += share;
      }
    }
  }

  const totals = new Map();
  let totalPercent = 0;
  for (const bin of bins) {
    for (const [model, value] of bin.values) {
      totals.set(model, (totals.get(model) ?? 0) + value);
      totalPercent += value;
    }
  }
  return { bins, totals, totalPercent, binSize, binCount };
}
