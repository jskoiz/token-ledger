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
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "tledger-anti-slop-mocking-"));
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

test("no-module-mocking follows stable framework aliases and namespaces", async () => {
  const result = await lintTypeScript(`
    import { vi as importedVi } from "vitest";
    import { jest as importedJest } from "@jest/globals";
    import * as vitest from "vitest";
    import * as jestGlobals from "@jest/globals";

    const localVi = importedVi;
    const localJest = importedJest;
    const directMock = localVi.mock;
    const directJestMock = localJest.mock;
    const { mock } = vi;
    const { mock: aliasedMock } = importedJest;
    const { vi: nestedVi } = vitest;
    const { jest: nestedJest } = jestGlobals;
    const namespaceViMock = vitest.vi.mock;
    const namespaceJestMock = jestGlobals.jest.mock;

    localVi.mock("a");
    localJest.mock("b");
    vitest.vi.mock("c");
    jestGlobals.jest.mock("d");
    directMock("e");
    directJestMock("f");
    mock("g");
    aliasedMock("h");
    nestedVi.mock("i");
    nestedJest.mock("j");
    namespaceViMock("k");
    namespaceJestMock("l");
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-module-mocking\)/g)?.length,
    12,
    result.output,
  );
});

test("no-module-mocking ignores unrelated or mutable lookalikes", async () => {
  const result = await lintTypeScript(`
    const fake = { mock() {} };
    const fakeAlias = fake;
    let mutable = vi;
    mutable = fake;
    function local(vi: { mock(): void }) {
      vi.mock("local");
    }
    const { mock: fakeMock } = fake;
    fake.mock("fake");
    fakeAlias.mock("fake-alias");
    mutable.mock("mutable");
    fakeMock("fake-destructured");
    void local;
  `);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /anti-slop\(no-module-mocking\)/);
});
