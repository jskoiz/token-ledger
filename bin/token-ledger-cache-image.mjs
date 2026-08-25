import { renderCacheReportSections } from "./token-ledger-cache-sections.mjs";

export {
  aggregateCacheRange,
  buildCacheReportData,
} from "./token-ledger-cache-data.mjs";

export function renderCacheReportImage(options) {
  return renderCacheReportSections(options);
}
