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
    type Dominated = {} | string;
    type DominatedAlias<T> = Empty | T;
    type NestedDominated<T> = Identity<{} | T>;
    type NarrowingUnion = { id: string } | { name: string };
    interface EmptyInterface {}
    interface EmptyInterface {}
    interface NonEmptyInterface { id: string }
    function direct(value: object & {}): void {}
    function alias(value: object & Empty): void {}
    function generic(value: object & EmptyAlias<number>): void {}
    function nested(value: object & ({} & object)): void {}
    function identity(value: object & Identity<{}>): void {}
    function narrowed(value: object & { id: string }): void {}
    function primitive(value: string & {}): void {}
    function impossible(value: object & never): void {}
    function unknownOnly(value: unknown & {}): void {}
    function interfaceEmpty(value: object & EmptyInterface): void {}
    function interfaceNested(value: object & (EmptyInterface & object)): void {}
    function interfaceNarrowed(value: object & NonEmptyInterface): void {}
    function dominatedDirect(value: object & ({} | string)): void {}
    function dominatedAlias(value: object & Dominated): void {}
    function dominatedGeneric(value: object & DominatedAlias<string>): void {}
    function dominatedNested(value: object & NestedDominated<string>): void {}
    function narrowingUnion(value: object & NarrowingUnion): void {}
    function nonemptyUnion(value: object & ({ id: string } | string)): void {}
    function neverUnion(value: object & ({ id: string } | never)): void {}
    function primitiveUnion(value: object & (string | number)): void {}
    function unknownNarrowedUnion(value: object & ((unknown & string) | never)): void {}
    void direct;
    void alias;
    void generic;
    void nested;
    void identity;
    void narrowed;
    void primitive;
    void impossible;
    void unknownOnly;
    void interfaceEmpty;
    void interfaceNested;
    void interfaceNarrowed;
    void dominatedDirect;
    void dominatedAlias;
    void dominatedGeneric;
    void dominatedNested;
    void narrowingUnion;
    void nonemptyUnion;
    void neverUnion;
    void primitiveUnion;
    void unknownNarrowedUnion;
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-object-parameters\)/g)?.length,
    11,
    result.output,
  );
});
