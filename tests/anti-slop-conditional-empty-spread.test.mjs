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
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "tledger-anti-slop-empty-spread-"));
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

test("anti-slop unwraps type-only wrappers around conditional empty branches", async () => {
  const result = await lintTypeScript(`
    declare const enabled: boolean;
    declare const fields: { id: string };
    const asBranch = { ...(enabled ? fields : ({} as const)) };
    const angleBranch = { ...(enabled ? (<{}>{}) : fields) };
    const satisfiesBranch = {
      ...(enabled ? fields : ((({}) satisfies object))),
    };
    const nonNullBranch = { ...(enabled ? fields : (({})!)) };
    const wrappedConditional = { ...((enabled ? fields : {})!) };
    void asBranch;
    void angleBranch;
    void satisfiesBranch;
    void nonNullBranch;
    void wrappedConditional;
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-conditional-empty-object-spread\)/g)?.length,
    5,
    result.output,
  );
});

test("anti-slop preserves nonempty and non-conditional spreads", async () => {
  const result = await lintTypeScript(`
    declare const enabled: boolean;
    declare const fields: { id: string };
    const nonempty = { ...(enabled ? fields : ({ id: "fallback" } as const)) };
    const direct = { ...({} as const) };
    const conditionalFields = { ...(enabled ? fields : fields) };
    void nonempty;
    void direct;
    void conditionalFields;
  `);
  assert.doesNotMatch(result.output, /anti-slop\(no-conditional-empty-object-spread\)/);
});
