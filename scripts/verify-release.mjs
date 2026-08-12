import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifier = resolve(repository, "scripts", "verify-packed-install.mjs");
const root = await mkdtemp(resolve(tmpdir(), "tledger-release-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  const packed = spawnSync(
    npmCommand,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
    {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: resolve(root, "npm-cache"),
      },
      timeout: 30_000,
    },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const metadata = JSON.parse(packed.stdout);
  assert.equal(metadata.length, 1);
  assert.deepEqual(
    metadata[0].files.map((entry) => entry.path).sort(),
    [
      "LICENSE",
      "README.md",
      "bin/token-ledger-terminal.mjs",
      "bin/token-ledger-tui.mjs",
      "bin/token-ledger.mjs",
      "lib/token-ledger-collector.mjs",
      "lib/token-ledger-models.mjs",
      "package.json",
    ],
  );
  const tarball = resolve(root, metadata[0].filename);
  await access(tarball);

  const verified = spawnSync(process.execPath, [verifier, tarball], {
    cwd: repository,
    stdio: "inherit",
    timeout: 60_000,
  });
  assert.equal(verified.status, 0, "Packed install verification failed.");
  process.stdout.write(`Release artifact verified: ${metadata[0].filename}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
