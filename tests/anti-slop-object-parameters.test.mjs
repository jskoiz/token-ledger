import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OXLINT = resolve(
  REPOSITORY_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "oxlint.cmd" : "oxlint",
);
const OXLINT_CONFIG = resolve(REPOSITORY_ROOT, ".oxlintrc.json");

async function lintTypeScript(source) {
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "tledger-anti-slop-object-"));
  const fixturePath = resolve(fixtureDirectory, "fixture.ts");
  try {
    await writeFile(fixturePath, source);
    const result = spawnSync(
      OXLINT,
      ["--config", OXLINT_CONFIG, "--no-ignore", fixturePath],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    );
    assert.ifError(result.error);
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
    };
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

test("no-object-parameters keeps empty object intersection members neutral", async () => {
  const result = await lintTypeScript(`
    type Empty = {};
    type EmptyAlias<T> = {};
    type Identity<T> = T;
    function direct(value: object & {}): void {}
    function alias(value: object & Empty): void {}
    function generic(value: object & EmptyAlias<number>): void {}
    function nested(value: object & ({} & object)): void {}
    function identity(value: object & Identity<{}>): void {}
    function narrowed(value: object & { id: string }): void {}
    function primitive(value: string & {}): void {}
    function impossible(value: object & never): void {}
    function unknownOnly(value: unknown & {}): void {}
    void direct;
    void alias;
    void generic;
    void nested;
    void identity;
    void narrowed;
    void primitive;
    void impossible;
    void unknownOnly;
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-object-parameters\)/g)?.length,
    5,
    result.output,
  );
});
