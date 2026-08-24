import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isIgnored(path) {
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--quiet", "--", path],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  assert.ifError(result.error);
  assert.ok(
    result.status === 0 || result.status === 1,
    result.stderr || `git check-ignore exited with ${result.status}`,
  );
  return result.status === 0;
}

test("only default report PNG families are ignored at the repository root", () => {
  for (const path of [
    "token-ledger-report-7d.png",
    "token-ledger-cache-report-7d.png",
    "token-ledger-trend-7d.png",
  ]) {
    assert.equal(isIgnored(path), true, `${path} should be ignored`);
  }

  for (const path of [
    "docs/token-ledger-report-7-day.png",
    "custom-report.png",
    "nested/token-ledger-report-7d.png",
  ]) {
    assert.equal(isIgnored(path), false, `${path} should remain trackable`);
  }
});
