import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isIgnored(path) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.excludesFile=/dev/null",
      "check-ignore",
      "--no-index",
      "--verbose",
      "--",
      path,
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  assert.ifError(result.error);
  assert.ok(
    result.status === 0 || result.status === 1,
    result.stderr || `git check-ignore exited with ${result.status}`,
  );
  if (result.status !== 0) return false;
  const source = result.stdout.trim().split("\t", 1)[0].replace(/:\d+:.*$/, "");
  const sourcePath = source.startsWith("/")
    ? resolve(source)
    : resolve(REPOSITORY_ROOT, source);
  return sourcePath === resolve(REPOSITORY_ROOT, ".gitignore");
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
