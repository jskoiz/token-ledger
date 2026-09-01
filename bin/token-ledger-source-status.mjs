export const SOURCE_STATUSES = Object.freeze([
  "verified-current",
  "explicit-snapshot",
  "unchecked-cache",
  "stale-fallback",
]);

const SOURCE_STATUS_LABELS = Object.freeze({
  "verified-current": "VERIFIED CURRENT",
  "stale-fallback": "STALE FALLBACK",
  "unchecked-cache": "UNCHECKED CACHE",
  "explicit-snapshot": "EXPLICIT SNAPSHOT",
});

export function sourceStatusLabel(sourceStatus = "unchecked-cache") {
  const label = SOURCE_STATUS_LABELS[sourceStatus];
  if (!label) {
    throw new Error(`Unknown report source status: ${String(sourceStatus)}`);
  }
  return label;
}

export function sourceStatusLine(sourceStatus = "unchecked-cache") {
  return `PROVENANCE · ${sourceStatusLabel(sourceStatus)}`;
}

export function snapshotFreshnessDetail(freshness) {
  return freshness?.status === "fresh" || freshness?.status === "stale"
    ? `${freshness.status} · ${freshness.ageLabel}`
    : "age unknown";
}
