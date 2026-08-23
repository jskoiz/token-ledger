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
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "tledger-anti-slop-aliases-"));
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

test("no-unknown-type-aliases resolves conditional branches that expose unknown", async () => {
  const result = await lintTypeScript(`
    type Direct = string extends string ? unknown : number;
    type Always<T> = T extends string ? unknown : unknown;
    type Select<T> = T extends string ? unknown : number;
    type Selected = Select<string>;
    type Concrete = Select<number>;
    type Defaulted<T = string> = T extends string ? unknown : boolean;
    type UsesDefault = Defaulted;
    type Nested<T> = T extends string
      ? T extends "safe" ? unknown : unknown
      : unknown;
    type Alias<T> = Select<T>;
    type Aliased = Alias<"unsafe">;
    type Distributed = Select<string | number>;
    type PromiseWrapped<T> = Promise<T extends string ? unknown : unknown>;
    type PromiseLikeWrapped<T> = PromiseLike<T extends string ? unknown : unknown>;
    type LiteralNever = never extends string ? unknown : number;
    type AnyTrue = any extends string ? unknown : number;
    type AnyFalse = any extends string ? number : unknown;
    type UnknownFalse = unknown extends string ? number : unknown;
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-unknown-type-aliases\)/g)?.length,
    11,
    result.output,
  );
  for (const alias of [
    "Direct",
    "Always",
    "Selected",
    "UsesDefault",
    "Nested",
    "Aliased",
    "Distributed",
    "LiteralNever",
    "AnyTrue",
    "AnyFalse",
    "UnknownFalse",
  ]) {
    assert.match(result.output, new RegExp("Type alias `" + alias + "` hides"));
  }
  assert.doesNotMatch(result.output, /Type alias `Concrete` hides/);
  assert.doesNotMatch(result.output, /Type alias `Promise(?:Like)?Wrapped` hides/);
});

test("no-unknown-type-aliases preserves undecidable and concrete conditional controls", async () => {
  const result = await lintTypeScript(`
    type OneUnknown<T> = T extends string ? unknown : number;
    type OtherUnknown<T> = T extends string ? boolean : unknown;
    type ConcreteFalse = OneUnknown<number>;
    type ConcreteTrue = OtherUnknown<string>;
    type Generic<T> = OneUnknown<T>;
    type Nested<T> = T extends string
      ? T extends "safe" ? string : unknown
      : number;
    type DefaultConcrete<T = number> = T extends string ? unknown : boolean;
    type UsesConcreteDefault = DefaultConcrete;
    type PromiseWrapped = Promise<unknown>;
    type PromiseLikeWrapped = PromiseLike<unknown>;
    type DistributedNever = OneUnknown<never>;
    type AnyDominated = any extends string ? unknown : any;
    type AnyConcrete = any extends string ? number : boolean;
    type UnknownConcrete = unknown extends string ? unknown : number;
  `);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /anti-slop\(no-unknown-type-aliases\)/);
  assert.doesNotMatch(result.output, /Type alias `DistributedNever` hides/);
});
