const ISO_TIMESTAMP_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.(?<fraction>\d+))?)?(?<timeZone>Z|[+-]\d{2}:\d{2})$/;

function invalidCollectionSince() {
  return new Error("--since requires a valid ISO timestamp.");
}

export function normalizeCollectionSince(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw invalidCollectionSince();
    return value.toISOString();
  }

  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) throw invalidCollectionSince();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalidCollectionSince();

  const components = match.groups;
  const year = Number(components.year);
  const month = Number(components.month);
  const day = Number(components.day);
  const hour = Number(components.hour);
  const minute = Number(components.minute);
  const second = components.second ? Number(components.second) : 0;
  const milliseconds = components.fraction
    ? Number(components.fraction.slice(0, 3).padEnd(3, "0"))
    : 0;
  const timeZone = components.timeZone;
  const offsetMinutes =
    timeZone === "Z"
      ? 0
      : (timeZone[0] === "-" ? -1 : 1) *
        (Number(timeZone.slice(1, 3)) * 60 + Number(timeZone.slice(4, 6)));
  const localDate = new Date(date.getTime() + offsetMinutes * 60 * 1_000);
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() + 1 !== month ||
    localDate.getUTCDate() !== day ||
    localDate.getUTCHours() !== hour ||
    localDate.getUTCMinutes() !== minute ||
    localDate.getUTCSeconds() !== second ||
    localDate.getUTCMilliseconds() !== milliseconds
  ) {
    throw invalidCollectionSince();
  }
  return date.toISOString();
}

export function collectionScope(options = {}) {
  return {
    since: normalizeCollectionSince(options.since),
    includeArchived: options.includeArchived !== false,
  };
}

export function snapshotCollectionScope(snapshot = {}) {
  const collection = snapshot?.provenance?.collection;
  if (!collection) return null;
  if (
    !Object.prototype.hasOwnProperty.call(collection, "since") ||
    (collection.includeArchived !== true && collection.includeArchived !== false)
  ) {
    return null;
  }
  let since;
  try {
    since = normalizeCollectionSince(collection.since);
  } catch {
    return null;
  }
  if (since !== collection.since) return null;
  return { since, includeArchived: collection.includeArchived };
}

export function snapshotMatchesCollectionScope(snapshot, scope) {
  const actual = snapshotCollectionScope(snapshot);
  return Boolean(
    actual &&
      actual.since === scope.since &&
      actual.includeArchived === scope.includeArchived,
  );
}

export function historyScopeLabel(snapshot = {}) {
  const scope = snapshotCollectionScope(snapshot);
  if (!scope || (scope.since === null && scope.includeArchived)) return null;

  const details = [];
  if (scope.since !== null) details.push(`before ${scope.since}`);
  if (!scope.includeArchived) details.push("archived sessions excluded");
  return `TRUNCATED HISTORY${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

export function snapshotCollectionCutoffMs(snapshot = {}) {
  const scope = snapshotCollectionScope(snapshot);
  if (!scope?.since) return null;
  return Date.parse(scope.since);
}
