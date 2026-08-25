const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const SNAPSHOT_SCHEMA_VERSION = 3;
export const ADAPTIVE_USAGE_RESOLUTIONS_SECONDS = Object.freeze([
  5 * 60,
  15 * 60,
  60 * 60,
  6 * 60 * 60,
  24 * 60 * 60,
  7 * 24 * 60 * 60,
  30 * 24 * 60 * 60,
]);
export const DEFAULT_USAGE_RESOLUTION_POLICY = Object.freeze([
  Object.freeze({ maximumAgeMs: 2 * DAY_MS, resolutionMs: 0 }),
  Object.freeze({ maximumAgeMs: 30 * DAY_MS, resolutionMs: MINUTE_MS }),
  Object.freeze({ maximumAgeMs: 365 * DAY_MS, resolutionMs: HOUR_MS }),
  Object.freeze({ maximumAgeMs: Infinity, resolutionMs: DAY_MS }),
]);

const COMPACT_DURING_BUILD_BUCKET_COUNT = 50_000;
const MAX_BUILD_BUCKET_COUNT = 100_000;
export const MAX_SAFE_TOKEN_COUNT = Number.MAX_SAFE_INTEGER;

const NUMERIC_USAGE_FIELDS = Object.freeze([
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
  "toolCalls",
]);
const FRACTIONAL_COUNT_FIELDS = Object.freeze([
  "callCount",
  "detailedCallCount",
  "inputCallCount",
]);

function primitiveNumber(value) {
  try {
    const number = Number.prototype.valueOf.call(value);
    return number === value ? number : null;
  } catch {
    return null;
  }
}

function parsedTokenValue(value, allowFractional = false) {
  const number = primitiveNumber(value);
  if (
    number === null ||
    !Number.isFinite(number) ||
    number < 0 ||
    number > MAX_SAFE_TOKEN_COUNT ||
    (!allowFractional && !Number.isSafeInteger(number))
  ) {
    return null;
  }
  return number;
}

function parsedOptionalTokenValue(value, allowFractional = false) {
  return value === undefined
    ? 0
    : parsedTokenValue(value, allowFractional);
}

export function tokenValue(value, { allowFractional = false } = {}) {
  return parsedTokenValue(value, allowFractional) ?? 0;
}

export function isValidTokenValue(value, { allowFractional = false } = {}) {
  return parsedTokenValue(value, allowFractional) !== null;
}

export function checkedTokenAdd(
  current,
  contribution,
  { allowFractional = false } = {},
) {
  const left = tokenValue(current, { allowFractional: true });
  const right = tokenValue(contribution, { allowFractional });
  const sum = left + right;
  return Number.isFinite(sum) && sum <= MAX_SAFE_TOKEN_COUNT
    ? sum
    : MAX_SAFE_TOKEN_COUNT;
}

const TOKEN_PARTITION_SCALE = Symbol("tokenPartitionScale");

function tokenPartitionScale(target) {
  return Number.isFinite(target[TOKEN_PARTITION_SCALE]) &&
      target[TOKEN_PARTITION_SCALE] >= 1
    ? target[TOKEN_PARTITION_SCALE]
    : 1;
}

function setTokenPartitionScale(target, scale) {
  Object.defineProperty(target, TOKEN_PARTITION_SCALE, {
    configurable: true,
    enumerable: false,
    value: scale,
    writable: true,
  });
}

export function checkedTokenPartitionAdd(
  target,
  contribution,
  { detailed = false } = {},
) {
  const targetScale = tokenPartitionScale(target);
  const value =
    tokenValue(contribution, { allowFractional: true }) / targetScale;
  let nextDetailed = tokenValue(target.detailedTokens, {
    allowFractional: true,
  });
  let nextUnknown = tokenValue(target.unknownBreakdownTokens, {
    allowFractional: true,
  });
  if (detailed) nextDetailed += value;
  else nextUnknown += value;
  const scaleFactor = Math.max(
    1,
    (nextDetailed + nextUnknown) / MAX_SAFE_TOKEN_COUNT,
  );
  target.detailedTokens = nextDetailed / scaleFactor;
  target.unknownBreakdownTokens = nextUnknown / scaleFactor;
  setTokenPartitionScale(target, targetScale * scaleFactor);
}

export function nonNegativeFiniteValue(value) {
  const number = primitiveNumber(value);
  return number !== null && Number.isFinite(number) && number >= 0
    ? number
    : 0;
}

export function isNonNegativeFiniteValue(value) {
  const number = primitiveNumber(value);
  return number !== null && Number.isFinite(number) && number >= 0;
}

export function checkedFiniteAdd(current, contribution) {
  const sum =
    nonNegativeFiniteValue(current) + nonNegativeFiniteValue(contribution);
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

export function tokenTotalsReconcile(
  totalTokens,
  inputTokens,
  outputTokens,
  allowFractional,
) {
  const componentTotal = inputTokens + outputTokens;
  if (
    !Number.isFinite(componentTotal) ||
    componentTotal > MAX_SAFE_TOKEN_COUNT
  ) {
    return false;
  }
  if (componentTotal === totalTokens) return true;
  if (!allowFractional) return false;
  const tolerance =
    Number.EPSILON * Math.max(1, componentTotal, totalTokens) * 16;
  return Math.abs(componentTotal - totalTokens) <= tolerance;
}

function invalidTokenUsage(row) {
  const source = Object(row) === row ? { ...row } : {};
  return {
    ...source,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    breakdownAvailable: false,
    invalidTokenRecord: true,
  };
}

export function normalizeTokenUsage(row) {
  if (!row || Object(row) !== row) return null;
  if (row.invalidTokenRecord === true) return invalidTokenUsage(row);

  const allowFractional = row.rangeAllocationEstimated === true;
  const totalTokens = parsedTokenValue(row.totalTokens, allowFractional);
  if (totalTokens === null) return invalidTokenUsage(row);

  const componentValues = [
    parsedOptionalTokenValue(row.inputTokens, allowFractional),
    parsedOptionalTokenValue(row.cachedInputTokens, allowFractional),
    parsedOptionalTokenValue(row.cacheWriteInputTokens, allowFractional),
    parsedOptionalTokenValue(row.outputTokens, allowFractional),
    parsedOptionalTokenValue(row.reasoningTokens, allowFractional),
  ];
  const componentsValid = componentValues.every((value) => value !== null);
  const inputTokens = componentValues[0] ?? 0;
  const cachedInputTokens = Math.min(inputTokens, componentValues[1] ?? 0);
  const cacheWriteInputTokens = componentValues[2] ?? 0;
  const outputTokens = componentValues[3] ?? 0;
  const reasoningTokens = Math.min(outputTokens, componentValues[4] ?? 0);
  const componentTotal = inputTokens + outputTokens;
  const breakdownAvailable =
    row.breakdownAvailable !== false &&
    componentsValid &&
    (totalTokens === 0
      ? componentTotal === 0
      : tokenTotalsReconcile(
          totalTokens,
          inputTokens,
          outputTokens,
          allowFractional,
        ) &&
        (inputTokens > 0 || outputTokens > 0));

  return {
    ...row,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    toolCalls: tokenValue(row.toolCalls, { allowFractional }),
    breakdownAvailable,
  };
}

function finiteTimestamp(value) {
  try {
    const timestampMs = Date.parse(String(value ?? ""));
    return Number.isFinite(timestampMs) ? timestampMs : null;
  } catch {
    return null;
  }
}

function nonNegativeNumber(value) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  } catch {
    return 0;
  }
}

function positiveSafeInteger(value) {
  const number = parsedTokenValue(value);
  return number !== null && number > 0 ? number : 0;
}

function positiveNumber(value) {
  const number = nonNegativeFiniteValue(value);
  return number > 0 ? number : 0;
}

function primitiveString(value) {
  try {
    const text = String.prototype.valueOf.call(value);
    return text === value ? text : null;
  } catch {
    return null;
  }
}

function rowThreadIds(row) {
  if (Array.isArray(row?.threadIds)) {
    return row.threadIds
      .map(primitiveString)
      .filter(Boolean);
  }
  const threadId = primitiveString(row?.threadId);
  return threadId ? [threadId] : [];
}

function resolutionForAge(ageMs, policy) {
  for (const tier of policy) {
    if (ageMs <= tier.maximumAgeMs) return tier.resolutionMs;
  }
  return policy.at(-1)?.resolutionMs ?? DAY_MS;
}

function groupingKey(row, bucketIndex, uniqueKey = "") {
  return JSON.stringify([
    bucketIndex,
    uniqueKey,
    String(row.project ?? "Unlabelled activity"),
    String(row.model ?? "unknown"),
    String(row.rateCardModel ?? row.model ?? "unknown"),
    String(row.effort ?? "unknown"),
    String(row.source ?? "unknown"),
    String(row.useType ?? "unknown"),
    row.serviceTier == null ? null : String(row.serviceTier),
    row.breakdownAvailable === true,
    row.rateCardCredits == null,
  ]);
}

function newAggregate(row, timestampMs, resolutionMs) {
  const rateCardCredits = row.rateCardCredits == null
    ? null
    : 0;
  const callCount = usageCallCount(row);
  const aggregate = {
    timestampMeanMs: timestampMs,
    timestampWeight: callCount,
    startMs: finiteTimestamp(row.startAt) ?? timestampMs,
    endMs: finiteTimestamp(row.endAt) ?? timestampMs,
    project: String(row.project ?? "Unlabelled activity"),
    model: String(row.model ?? "unknown"),
    rateCardModel: String(row.rateCardModel ?? row.model ?? "unknown"),
    effort: String(row.effort ?? "unknown"),
    source: String(row.source ?? "unknown"),
    useType: String(row.useType ?? "unknown"),
    serviceTier: row.serviceTier == null ? null : String(row.serviceTier),
    breakdownAvailable: row.breakdownAvailable === true,
    rateCardCredits,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    callCount: 0,
    detailedCallCount: 0,
    inputCallCount: 0,
    rangeAllocationEstimated: false,
    resolutionSeconds: Math.max(
      nonNegativeNumber(row.resolutionSeconds),
      resolutionMs / 1_000,
    ),
    threadIds: new Set(),
  };
  addToAggregate(aggregate, row, timestampMs);
  return aggregate;
}

function addToAggregate(aggregate, row, timestampMs) {
  const estimated = row.rangeAllocationEstimated === true;
  aggregate.rangeAllocationEstimated ||= estimated;
  const callCount = usageCallCount(row);
  if (aggregate.callCount > 0) {
    const combinedWeight = aggregate.timestampWeight + callCount;
    aggregate.timestampMeanMs +=
      ((timestampMs - aggregate.timestampMeanMs) * callCount) / combinedWeight;
    aggregate.timestampWeight = combinedWeight;
  }
  aggregate.startMs = Math.min(
    aggregate.startMs,
    finiteTimestamp(row.startAt) ?? timestampMs,
  );
  aggregate.endMs = Math.max(
    aggregate.endMs,
    finiteTimestamp(row.endAt) ?? timestampMs,
  );
  for (const field of NUMERIC_USAGE_FIELDS) {
    aggregate[field] = checkedTokenAdd(aggregate[field], row[field], {
      allowFractional: estimated,
    });
  }
  aggregate.cachedInputTokens = Math.min(
    aggregate.inputTokens,
    aggregate.cachedInputTokens,
  );
  aggregate.reasoningTokens = Math.min(
    aggregate.outputTokens,
    aggregate.reasoningTokens,
  );
  aggregate.breakdownAvailable =
    aggregate.breakdownAvailable &&
    tokenTotalsReconcile(
      aggregate.totalTokens,
      aggregate.inputTokens,
      aggregate.outputTokens,
      aggregate.rangeAllocationEstimated,
    );
  aggregate.callCount = checkedTokenAdd(aggregate.callCount, callCount, {
    allowFractional: estimated,
  });
  const detailedCallCount = usageDetailedCallCount(row);
  aggregate.detailedCallCount = checkedTokenAdd(
    aggregate.detailedCallCount,
    detailedCallCount,
    { allowFractional: estimated },
  );
  const inputCallCount = usageInputCallCount(row);
  aggregate.inputCallCount = checkedTokenAdd(
    aggregate.inputCallCount,
    inputCallCount,
    { allowFractional: estimated },
  );
  if (aggregate.rateCardCredits !== null) {
    aggregate.rateCardCredits = checkedFiniteAdd(
      aggregate.rateCardCredits,
      row.rateCardCredits,
    );
  }
  aggregate.resolutionSeconds = Math.max(
    aggregate.resolutionSeconds,
    nonNegativeNumber(row.resolutionSeconds),
  );
  for (const threadId of rowThreadIds(row)) aggregate.threadIds.add(threadId);
}

function finishAggregate(aggregate) {
  const result = {
    timestamp: new Date(Math.round(aggregate.timestampMeanMs)).toISOString(),
    startAt: new Date(aggregate.startMs).toISOString(),
    endAt: new Date(aggregate.endMs).toISOString(),
    project: aggregate.project,
    model: aggregate.model,
    rateCardModel: aggregate.rateCardModel,
    effort: aggregate.effort,
    source: aggregate.source,
    useType: aggregate.useType,
    serviceTier: aggregate.serviceTier,
    inputTokens: aggregate.inputTokens,
    cachedInputTokens: aggregate.cachedInputTokens,
    cacheWriteInputTokens: aggregate.cacheWriteInputTokens,
    outputTokens: aggregate.outputTokens,
    reasoningTokens: aggregate.reasoningTokens,
    totalTokens: aggregate.totalTokens,
    toolCalls: aggregate.toolCalls,
    rateCardCredits: aggregate.rateCardCredits,
    breakdownAvailable: aggregate.breakdownAvailable,
    callCount: aggregate.callCount,
    detailedCallCount: aggregate.detailedCallCount,
    inputCallCount: aggregate.inputCallCount,
    threadIds: [...aggregate.threadIds].sort(),
    resolutionSeconds: aggregate.resolutionSeconds,
  };
  if (aggregate.rangeAllocationEstimated) {
    result.rangeAllocationEstimated = true;
  }
  return result;
}

function addRowToGroups(
  groups,
  row,
  timestampMs,
  resolutionMs,
  uniqueKey = "",
) {
  const bucketIndex = resolutionMs > 0
    ? Math.floor(timestampMs / resolutionMs)
    : timestampMs;
  const key = groupingKey(row, bucketIndex, uniqueKey);
  const existing = groups.get(key);
  if (existing) addToAggregate(existing, row, timestampMs);
  else groups.set(key, newAggregate(row, timestampMs, resolutionMs));
}

function aggregateRows(rows, resolutionForRow) {
  const groups = new Map();
  let index = 0;
  for (const sourceRow of rows) {
    const row = normalizeTokenUsage(sourceRow);
    if (!row || row.invalidTokenRecord === true) {
      index += 1;
      continue;
    }
    const timestampMs = finiteTimestamp(row?.timestamp);
    if (timestampMs === null) {
      index += 1;
      continue;
    }
    const resolutionMs = Math.max(0, Number(resolutionForRow(row, timestampMs)) || 0);
    addRowToGroups(
      groups,
      row,
      timestampMs,
      resolutionMs,
      resolutionMs === 0 ? String(index) : "",
    );
    index += 1;
  }
  return [...groups.values()]
    .map(finishAggregate)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function regroupAggregates(groups, minimumResolutionMs) {
  const regrouped = new Map();
  for (const aggregate of groups.values()) {
    const row = finishAggregate(aggregate);
    const timestampMs = Math.round(aggregate.timestampMeanMs);
    const resolutionMs = Math.max(
      minimumResolutionMs,
      nonNegativeNumber(row.resolutionSeconds) * 1_000,
    );
    addRowToGroups(regrouped, row, timestampMs, resolutionMs);
  }
  groups.clear();
  return regrouped;
}

function usageBucketLimitError() {
  const error = new Error(
    `Usage history still requires more than ${MAX_BUILD_BUCKET_COUNT.toLocaleString()} buckets at the maximum storage resolution. Use --since or --no-archived to reduce the source history.`,
  );
  error.code = "ERR_SNAPSHOT_SIZE_LIMIT";
  return error;
}

export function buildUsageBuckets(
  events,
  { latestTimestampMs, policy = DEFAULT_USAGE_RESOLUTION_POLICY } = {},
) {
  const rows = events?.[Symbol.iterator] ? events : [];
  const latest = Number.isFinite(latestTimestampMs)
    ? latestTimestampMs
    : Array.isArray(rows) ? rows.reduce(
        (maximum, row) => Math.max(maximum, finiteTimestamp(row?.timestamp) ?? 0),
        0,
      ) : 0;
  let groups = new Map();
  let minimumResolutionMs = 0;
  let nextResolutionIndex = 0;
  let index = 0;
  for (const sourceRow of rows) {
    const row = normalizeTokenUsage(sourceRow);
    if (!row || row.invalidTokenRecord === true) {
      index += 1;
      continue;
    }
    const timestampMs = finiteTimestamp(row?.timestamp);
    if (timestampMs === null) {
      index += 1;
      continue;
    }
    const resolutionMs = Math.max(
      minimumResolutionMs,
      resolutionForAge(Math.max(0, latest - timestampMs), policy),
      nonNegativeNumber(row?.resolutionSeconds) * 1_000,
    );
    addRowToGroups(
      groups,
      row,
      timestampMs,
      resolutionMs,
      resolutionMs === 0 ? String(index) : "",
    );
    index += 1;

    while (
      groups.size > COMPACT_DURING_BUILD_BUCKET_COUNT &&
      nextResolutionIndex < ADAPTIVE_USAGE_RESOLUTIONS_SECONDS.length
    ) {
      minimumResolutionMs =
        ADAPTIVE_USAGE_RESOLUTIONS_SECONDS[nextResolutionIndex] * 1_000;
      nextResolutionIndex += 1;
      groups = regroupAggregates(groups, minimumResolutionMs);
    }
    if (
      groups.size > MAX_BUILD_BUCKET_COUNT &&
      nextResolutionIndex === ADAPTIVE_USAGE_RESOLUTIONS_SECONDS.length
    ) {
      throw usageBucketLimitError();
    }
  }
  return [...groups.values()]
    .map(finishAggregate)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

export function coarsenUsageBuckets(buckets, resolutionSeconds) {
  const resolution = positiveSafeInteger(resolutionSeconds);
  if (!resolution) {
    throw new Error("Usage-bucket resolution must be a positive integer.");
  }
  const resolutionMs = resolution * 1_000;
  return aggregateRows(
    Array.isArray(buckets) ? buckets : [],
    (row) => Math.max(
      resolutionMs,
      nonNegativeNumber(row?.resolutionSeconds) * 1_000,
    ),
  );
}

export function usageBuckets(snapshot = {}) {
  if (!Array.isArray(snapshot.events)) return [];
  return [...snapshot.events].flatMap((row) => {
    const normalized = normalizeTokenUsage(row);
    return normalized && normalized.invalidTokenRecord !== true
      ? [normalized]
      : [];
  });
}

function usageBucketInterval(bucket) {
  const timestampMs = finiteTimestamp(bucket?.timestamp);
  if (timestampMs === null) return null;
  const startAtMs = finiteTimestamp(bucket?.startAt) ?? timestampMs;
  const endAtMs = finiteTimestamp(bucket?.endAt) ?? timestampMs;
  const startMs = Math.min(timestampMs, startAtMs, endAtMs);
  const inclusiveEndMs = Math.max(timestampMs, startAtMs, endAtMs);
  return {
    startMs,
    endMs: Math.max(startMs + 1, inclusiveEndMs + 1),
  };
}

function firstBoundaryAfter(boundaries, value) {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (boundaries[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sliceUsageBucket(bucket, startMs, endMs, fraction) {
  const rangeAllocationOrigin = bucket?.rangeAllocationOrigin ?? {
    inputTokens: nonNegativeNumber(bucket?.inputTokens),
    totalTokens: nonNegativeNumber(bucket?.totalTokens),
    callCount: usageCallCount(bucket),
  };
  const fragment = {
    ...bucket,
    timestamp: new Date(Math.round(startMs + (endMs - startMs - 1) / 2))
      .toISOString(),
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs - 1).toISOString(),
    rangeAllocationEstimated: true,
    rangeAllocationFraction:
      (positiveNumber(bucket?.rangeAllocationFraction) || 1) * fraction,
    rangeAllocationOrigin,
  };
  for (const field of NUMERIC_USAGE_FIELDS) {
    fragment[field] = tokenValue(bucket?.[field], { allowFractional: true }) * fraction;
  }
  if (bucket?.rateCardCredits != null) {
    fragment.rateCardCredits = nonNegativeFiniteValue(bucket.rateCardCredits) * fraction;
  }
  for (const field of FRACTIONAL_COUNT_FIELDS) {
    const value = field === "callCount"
      ? usageCallCount(bucket)
      : field === "detailedCallCount"
        ? usageDetailedCallCount(bucket)
        : usageInputCallCount(bucket);
    fragment[field] = value * fraction;
  }
  return fragment;
}

// Compacted buckets retain their first and last observed timestamps, but not
// every timestamp inside the bucket. Split any bucket that crosses a report
// boundary and allocate its additive values by overlap duration. This keeps
// adjacent ranges additive instead of assigning the entire bucket by its mean
// timestamp. The fragment marker lets renderers disclose the approximation.
export function splitUsageBucketsAtBoundaries(buckets, boundaryValues) {
  const boundaries = [...new Set(
    (Array.isArray(boundaryValues) ? boundaryValues : [])
      .map(Number)
      .filter(Number.isFinite),
  )].sort((left, right) => left - right);
  if (boundaries.length === 0) return Array.isArray(buckets) ? [...buckets] : [];

  const fragments = [];
  for (const sourceBucket of Array.isArray(buckets) ? buckets : []) {
    const bucket = normalizeTokenUsage(sourceBucket);
    if (!bucket || bucket.invalidTokenRecord === true) continue;
    const interval = usageBucketInterval(bucket);
    if (interval === null) {
      fragments.push(bucket);
      continue;
    }
    let boundaryIndex = firstBoundaryAfter(boundaries, interval.startMs);
    if (
      boundaryIndex >= boundaries.length ||
      boundaries[boundaryIndex] >= interval.endMs
    ) {
      fragments.push(bucket);
      continue;
    }

    const durationMs = interval.endMs - interval.startMs;
    let fragmentStartMs = interval.startMs;
    while (
      boundaryIndex < boundaries.length &&
      boundaries[boundaryIndex] < interval.endMs
    ) {
      const fragmentEndMs = boundaries[boundaryIndex];
      fragments.push(sliceUsageBucket(
        bucket,
        fragmentStartMs,
        fragmentEndMs,
        (fragmentEndMs - fragmentStartMs) / durationMs,
      ));
      fragmentStartMs = fragmentEndMs;
      boundaryIndex += 1;
    }
    fragments.push(sliceUsageBucket(
      bucket,
      fragmentStartMs,
      interval.endMs,
      (interval.endMs - fragmentStartMs) / durationMs,
    ));
  }
  return fragments;
}

export function usageBucketsInRange(snapshot, startValue, endValue) {
  const startMs = Number(startValue);
  const endMs = Number(endValue);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [];
  }
  return splitUsageBucketsAtBoundaries(
    usageBuckets(snapshot),
    [startMs, endMs],
  ).filter((bucket) => {
    const timestampMs = finiteTimestamp(bucket?.timestamp);
    return timestampMs !== null && timestampMs >= startMs && timestampMs < endMs;
  });
}

export function usageCallCount(bucket) {
  if (bucket == null || Object(bucket) !== bucket) return 0;
  if (bucket.invalidTokenRecord === true) return 0;
  const stored = bucket.rangeAllocationEstimated === true
    ? positiveNumber(bucket.callCount)
    : positiveSafeInteger(bucket.callCount);
  return stored || 1;
}

export function usageDetailedCallCount(bucket) {
  if (bucket?.invalidTokenRecord === true) return 0;
  const callCount = usageCallCount(bucket);
  const stored = bucket?.rangeAllocationEstimated === true
    ? positiveNumber(bucket.detailedCallCount)
    : positiveSafeInteger(bucket?.detailedCallCount);
  return Math.min(
    callCount,
    stored || (bucket?.breakdownAvailable === false ? 0 : callCount),
  );
}

export function usageInputCallCount(bucket) {
  if (bucket?.invalidTokenRecord === true) return 0;
  const callCount = usageCallCount(bucket);
  const stored = bucket?.rangeAllocationEstimated === true
    ? positiveNumber(bucket.inputCallCount)
    : positiveSafeInteger(bucket?.inputCallCount);
  return Math.min(
    callCount,
    stored || (nonNegativeNumber(bucket?.inputTokens) > 0 ? callCount : 0),
  );
}

export function usageThreadIds(bucket) {
  return rowThreadIds(bucket);
}

export function usageBucketStats(buckets) {
  const rows = Array.isArray(buckets) ? buckets : [];
  return {
    bucketCount: rows.length,
    callCount: rows.reduce(
      (sum, row) => checkedTokenAdd(sum, usageCallCount(row), {
        allowFractional: row?.rangeAllocationEstimated === true,
      }),
      0,
    ),
    maximumResolutionSeconds: rows.reduce(
      (maximum, row) => Math.max(
        maximum,
        nonNegativeNumber(row?.resolutionSeconds),
      ),
      0,
    ),
  };
}
