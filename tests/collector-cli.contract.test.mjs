import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the direct collector command keeps missing-source paths out of diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "token-ledger-collector-privacy-"));
  try {
    const codexHome = join(root, "private-source-does-not-exist");
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../lib/token-ledger-importer.mjs", import.meta.url)),
      "--codex-home", codexHome,
      "--output", join(root, "snapshot.json"),
    ], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Codex data directory not found: \[local path\]/);
    assert.equal(result.stderr.includes(root), false);
    assert.equal(result.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
