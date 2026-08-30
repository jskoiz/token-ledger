import { createHash } from "node:crypto";

export const QUOTA_IDENTITY_CONTRACT_VERSION = "codex-limit-id-v2";
export const ACCOUNT_QUOTA_LIMIT_KEY = createHash("sha256")
  .update("codex")
  .digest("hex")
  .slice(0, 16);

function primitiveString(value) {
  try {
    const text = String.prototype.valueOf.call(value);
    return text === value ? text : null;
  } catch {
    return null;
  }
}

export function snapshotQuotaIdentityContract(snapshot = {}) {
  return primitiveString(
    snapshot?.metadata?.durableLedger?.quotaIdentityContract,
  );
}

export function snapshotHasCurrentQuotaIdentityContract(snapshot = {}) {
  return snapshotQuotaIdentityContract(snapshot) ===
    QUOTA_IDENTITY_CONTRACT_VERSION;
}

export function quotaIdentityMatchesContract({ limitKey, scope } = {}) {
  const key = primitiveString(limitKey);
  if (
    key === null ||
    !/^[0-9a-f]{16}$/i.test(key) ||
    (scope !== "account" && scope !== "named")
  ) return false;
  return (key.toLowerCase() === ACCOUNT_QUOTA_LIMIT_KEY) ===
    (scope === "account");
}
