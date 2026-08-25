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

// Build the one shared raw-bucket index used by every report renderer. The
// returned event sets are range-filtered views over one split pass; renderer
// specific binning may split those fragments further without revisiting the
// snapshot's source array.
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
    ...(priorBounds
      ? [priorBounds.start.getTime(), priorBounds.end.getTime()]
      : []),
    ...scopedQuotaObservations.flatMap((observation) => [
      observation.cycleStartMs,
      observation.timestampMs,
    ]),
  ];
  const sourceEvents = usageBuckets(snapshot);
  const splitEvents = splitUsageBucketsAtBoundaries(
    sourceEvents,
    boundaryValues,
  );
  const currentEvents = rangeEvents(splitEvents, bounds);
  const priorEvents = priorBounds === null
    ? []
    : rangeEvents(splitEvents, priorBounds);
  const trendEvents = eventsThrough(splitEvents, endMs);

  return Object.freeze({
    allEvents: freezeEvents(splitEvents),
    currentEvents: freezeEvents(currentEvents),
    priorEvents: freezeEvents(priorEvents),
    trendEvents: freezeEvents(trendEvents),
    quotaObservations: Object.freeze([...scopedQuotaObservations]),
    sourceBucketCount: sourceEvents.length,
    boundaryCount: new Set(
      boundaryValues.map(Number).filter(Number.isFinite),
    ).size,
  });
}
