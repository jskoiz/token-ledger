export function normalizeCollectionSince(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("--since requires a valid ISO timestamp.");
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
