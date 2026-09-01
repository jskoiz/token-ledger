import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  readPrivateSnapshot,
  writePrivateSnapshot,
} from "../lib/token-ledger-snapshot.mjs";
import { SNAPSHOT_SCHEMA_VERSION } from "../lib/token-ledger-usage.mjs";

function snapshot(label) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    label,
    coverage: {},
    events: [],
  };
}

async function mode(path) {
  return (await stat(path)).mode & 0o777;
}

test("private JSON snapshots replace atomically and remain mode 0600", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-snapshot-contract-"));
  const output = resolve(root, "snapshot.json");
  try {
    const first = await writePrivateSnapshot(output, snapshot("first"));
    assert.equal(first.encoding, "json");
    assert.equal(await mode(output), 0o600);
    const baseline = await readPrivateSnapshot(output);

    const replacement = await writePrivateSnapshot(output, snapshot("second"));
    assert.equal(replacement.snapshot.label, "second");
    assert.equal(await mode(output), 0o600);
    assert.equal((await readPrivateSnapshot(output)).label, "second");
    assert.notDeepEqual(replacement.snapshot, baseline);
    assert.deepEqual(await readdir(root), ["snapshot.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gzip snapshots round-trip while compressed input and expansion stay bounded", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-snapshot-gzip-"));
  const output = resolve(root, "snapshot.json.gz");
  try {
    const source = snapshot("gzip");
    const written = await writePrivateSnapshot(output, source);
    assert.equal(written.encoding, "gzip");
    assert.equal(await mode(output), 0o600);
    assert.deepEqual(await readPrivateSnapshot(output), written.snapshot);

    const encoded = await readFile(output);
    await assert.rejects(
      () => readPrivateSnapshot(output, {
        maxBytes: encoded.byteLength - 1,
        maxJsonBytes: 16_384,
      }),
      (error) => {
        assert.equal(error.code, "ERR_SNAPSHOT_SIZE_LIMIT");
        assert.match(error.message, /compressed read limit/);
        return true;
      },
    );

    const expansionPath = resolve(root, "expansion.json.gz");
    const expandedJson = Buffer.from(JSON.stringify({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      label: "x".repeat(4_096),
      events: [],
    }));
    const compressedExpansion = gzipSync(expandedJson);
    await writeFile(expansionPath, compressedExpansion, { mode: 0o600 });
    await assert.rejects(
      () => readPrivateSnapshot(expansionPath, {
        maxBytes: compressedExpansion.byteLength + 1,
        maxJsonBytes: 512,
      }),
      (error) => {
        assert.equal(error.code, "ERR_SNAPSHOT_SIZE_LIMIT");
        assert.match(error.message, /expands beyond|JSON read limit/);
        return true;
      },
    );

    const jsonPath = resolve(root, "oversized-input.json");
    await writeFile(jsonPath, JSON.stringify(snapshot("x".repeat(2_048))), {
      mode: 0o600,
    });
    await assert.rejects(
      () => readPrivateSnapshot(jsonPath, { maxJsonBytes: 512 }),
      (error) => {
        assert.equal(error.code, "ERR_SNAPSHOT_SIZE_LIMIT");
        assert.match(error.message, /JSON read limit/);
        return true;
      },
    );

    const directoryPath = resolve(root, "not-a-snapshot");
    await mkdir(directoryPath);
    await assert.rejects(
      () => readPrivateSnapshot(directoryPath),
      (error) => error.code === "ERR_SNAPSHOT_NOT_REGULAR",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an oversized replacement preserves the previous valid private cache", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-snapshot-size-"));
  try {
    for (const fileName of ["snapshot.json", "snapshot.json.gz"]) {
      const output = resolve(root, fileName);
      await writePrivateSnapshot(output, snapshot("valid cache"));
      const baseline = await readPrivateSnapshot(output);
      const oversized = {
        ...snapshot("too large"),
        label: "x".repeat(10_000),
      };

      await assert.rejects(
        () => writePrivateSnapshot(output, oversized, {
          maxBytes: 512,
          targetBytes: 256,
          maxJsonBytes: 1_024,
          targetJsonBytes: 512,
        }),
        (error) => {
          assert.equal(error.code, "ERR_SNAPSHOT_SIZE_LIMIT");
          return true;
        },
      );
      assert.deepEqual(await readPrivateSnapshot(output), baseline);
      assert.equal(await mode(output), 0o600);
    }
    assert.deepEqual(
      (await readdir(root)).sort(),
      ["snapshot.json", "snapshot.json.gz"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
