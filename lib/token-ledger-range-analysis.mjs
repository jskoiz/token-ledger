import {
  createTimeZoneFormatter,
  localDateBoundary,
  shiftCalendarDate,
} from "./token-ledger-calendar.mjs";
import {
  splitUsageBucketsAtBoundaries,
  usageBuckets,
} from "./token-ledger-usage.mjs";

function finiteTimestamp(value) {
  try {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch {
    return null;
  }
}

function rangeEvents(events, bounds) {
  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();
  return events.filter((event) => {
    const timestampMs = finiteTimestamp(event?.timestamp);
    return timestampMs !== null && timestampMs >= startMs && timestampMs < endMs;
  });
}

function eventsThrough(events, endMs) {
  return events.filter((event) => {
    const timestampMs = finiteTimestamp(event?.timestamp);
    return timestampMs !== null && timestampMs < endMs;
  });
}

function freezeEvents(events) {
  return Object.freeze([...events]);
}

function localCalendarBoundaries(bounds) {
  if (
    !bounds?.timeZone ||
    !bounds?.startDateString ||
    !bounds?.endDateString
  ) {
    return [];
  }
  const formatter = createTimeZoneFormatter(bounds.timeZone);
  const finalDateString = shiftCalendarDate(bounds.endDateString, 1);
  const boundaries = [];
  for (
    let dateString = bounds.startDateString;
    dateString <= finalDateString;
    dateString = shiftCalendarDate(dateString, 1)
  ) {
    boundaries.push(
      localDateBoundary(dateString, bounds.timeZone, formatter).getTime(),
    );
  }
  return boundaries;
}

// Calendar totals and meter attribution use different boundaries. A quota
// sample can require allocating a bucket between meter intervals without
// making that bucket's already-known daily token total an estimate.
export function buildRangeAnalysis(
  snapshot = {},
  bounds,
  { priorBounds = null, quotaObservations = [] } = {},
) {
  const endMs = bounds.end.getTime();
  const scopedQuotaObservations = quotaObservations.filter(
    (observation) =>
      Number.isFinite(observation?.timestampMs) &&
      observation.timestampMs < endMs,
  );
  const boundaryValues = [
    bounds.start.getTime(),
    bounds.end.getTime(),
    ...localCalendarBoundaries(bounds),
    ...(priorBounds
      ? [
          priorBounds.start.getTime(),
          priorBounds.end.getTime(),
          ...localCalendarBoundaries(priorBounds),
        ]
      : []),
  ];
  const sourceEvents = usageBuckets(snapshot);
  const splitEvents = splitUsageBucketsAtBoundaries(
    sourceEvents,
    boundaryValues,
  );
  const currentEvents = rangeEvents(splitEvents, bounds);
  // null marks a prior range that was never requested; renderers treat an
  // array as authoritative, so an empty one would hide real prior events.
  const priorEvents = priorBounds === null
    ? null
    : rangeEvents(splitEvents, priorBounds);
  const quotaBoundaries = scopedQuotaObservations.flatMap((observation) => [
    observation.cycleStartMs,
    observation.timestampMs,
  ]);
  const trendEvents = splitUsageBucketsAtBoundaries(
    eventsThrough(splitEvents, endMs),
    quotaBoundaries,
  );

  return Object.freeze({
    allEvents: freezeEvents(splitEvents),
    currentEvents: freezeEvents(currentEvents),
    priorEvents: priorEvents === null ? null : freezeEvents(priorEvents),
    trendEvents: freezeEvents(trendEvents),
    quotaObservations: Object.freeze([...scopedQuotaObservations]),
    sourceBucketCount: sourceEvents.length,
    boundaryCount: new Set(
      boundaryValues.map(Number).filter(Number.isFinite),
    ).size,
  });
}
