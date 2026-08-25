// Shared image-axis sizing rules. This module has no renderer or domain imports.

export function chooseBinSize(
  days,
  width,
  { minBinWidth = 1, preferDaily = false } = {},
) {
  const rangeDays = Number(days);
  const plotWidth = Math.max(1, Number(width) || 1);
  const minimumBinWidth = Math.max(1, Number(minBinWidth) || 1);
  const maxBinCount = Math.max(1, Math.floor(plotWidth / minimumBinWidth));
  const preferredBinSize = preferDaily
    ? 1
    : rangeDays <= 14
      ? 1
      : plotWidth >= 120
        ? 2
        : 3;
  return Math.max(preferredBinSize, Math.ceil(rangeDays / maxBinCount));
}
