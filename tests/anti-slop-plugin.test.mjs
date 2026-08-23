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
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "tledger-anti-slop-"));
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

test("anti-slop resolves applied generic aliases before checking returns", async () => {
  const result = await lintTypeScript(`
    type Identity<T> = T;
    type Wrapped<T> = Identity<T>;
    export function load(): Wrapped<unknown> {
      throw new Error("unreachable");
    }
  `);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /anti-slop\(no-unknown-returns\)/);
});

test("anti-slop recognizes aliases whose unions collapse to unknown", async () => {
  const result = await lintTypeScript(`
    export type Payload = string | unknown;
  `);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /anti-slop\(no-unknown-type-aliases\)/);
});

test("anti-slop resolves intersections that remain unknown", async () => {
  const result = await lintTypeScript(`
    type Payload = unknown & unknown;
    type Narrowed = unknown & string;
    export function consume(value: Payload & unknown): void {}
    export function keep(value: Narrowed): Narrowed { return value; }
    export function load(): Promise<Payload & unknown> {
      throw new Error("unreachable");
    }
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-unknown-type-aliases\)/g)?.length,
    1,
    result.output,
  );
  assert.equal(
    result.output.match(/anti-slop\(no-unknown-parameters\)/g)?.length,
    1,
    result.output,
  );
  assert.equal(
    result.output.match(/anti-slop\(no-unknown-returns\)/g)?.length,
    1,
    result.output,
  );
});

test("anti-slop unwraps parenthesized empty-object spread branches", async () => {
  const result = await lintTypeScript(`
    declare const enabled: boolean;
    declare const fields: { id: string };
    export const alternate = { ...(enabled ? fields : (({}))) };
    export const consequent = { ...(enabled ? (({})) : fields) };
    export const nonempty = { ...(enabled ? fields : ({ id: "fallback" })) };
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-conditional-empty-object-spread\)/g)?.length,
    2,
    result.output,
  );
});

test("anti-slop resolves unions and generic aliases in unknown parameters", async () => {
  const result = await lintTypeScript(`
    type Identity<T> = T;
    type DefaultUnknown<T = unknown> = T;
    export function consumeUnion(value: string | unknown): void {}
    export function consumeAlias(value: Identity<unknown>): void {}
    export function consumeDefault(value: DefaultUnknown): void {}
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-unknown-parameters\)/g)?.length,
    3,
    result.output,
  );
});

test("anti-slop resolves applied generic aliases in object parameters", async () => {
  const result = await lintTypeScript(`
    type Identity<T> = T;
    type Wrapped<T> = Identity<T>;
    type DefaultObject<T = object> = T;
    export function consume(value: Wrapped<object>): void {}
    export function consumeDefault(value: DefaultObject): void {}
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-object-parameters\)/g)?.length,
    2,
    result.output,
  );
});

test("anti-slop resolves aliases declared in function scope", async () => {
  const result = await lintTypeScript(`
    export function outer(): void {
      type Identity<T> = T;
      type Payload = Identity<unknown>;
      function load(value: Payload): Payload {
        throw new Error(String(value));
      }
      void load;
    }
  `);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /anti-slop\(no-unknown-type-aliases\)/);
  assert.match(result.output, /anti-slop\(no-unknown-parameters\)/);
  assert.match(result.output, /anti-slop\(no-unknown-returns\)/);
});

test("anti-slop resolves namespace aliases declared after their use", async () => {
  const result = await lintTypeScript(`
    namespace Box {
      export function load(value: Payload): Payload {
        throw new Error(String(value));
      }
      export type Payload = unknown;
    }
  `);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /anti-slop\(no-unknown-type-aliases\)/);
  assert.match(result.output, /anti-slop\(no-unknown-parameters\)/);
  assert.match(result.output, /anti-slop\(no-unknown-returns\)/);
});

test("anti-slop alias lookup respects block and generic shadowing", async () => {
  const result = await lintTypeScript(`
    type Payload = string;
    export function generic<Payload>(value: Payload): Payload {
      return value;
    }
    {
      type Payload = object;
      function consume(value: Payload): void {}
      void consume;
    }
    export function keep(value: Payload): Payload {
      return value;
    }
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-object-parameters\)/g)?.length,
    1,
    result.output,
  );
  assert.doesNotMatch(result.output, /anti-slop\(no-unknown-/);
});

test("anti-slop ignores value-space names when resolving type aliases", async () => {
  const result = await lintTypeScript(`
    type Payload = unknown;
    export function load(Payload: string): Payload {
      throw new Error(Payload);
    }
  `);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /anti-slop\(no-unknown-type-aliases\)/);
  assert.match(result.output, /anti-slop\(no-unknown-returns\)/);
});

test("anti-slop honors visible type declarations named Promise", async () => {
  const result = await lintTypeScript(`
    type Promise<T> = string;
    export function load(): Promise<unknown> {
      return "ready";
    }
    namespace Local {
      interface Promise<T> { value: T }
      export function load(): Promise<unknown> {
        return { value: "ready" };
      }
    }
  `);
  assert.equal(result.status, 0, result.output);
});

test("anti-slop still unwraps the built-in Promise contracts", async () => {
  const result = await lintTypeScript(`
    export function load(): Promise<unknown> {
      throw new Error("unreachable");
    }
    export function loadLike(): PromiseLike<unknown> {
      throw new Error("unreachable");
    }
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-unknown-returns\)/g)?.length,
    2,
    result.output,
  );
});

test("anti-slop resolves qualified namespace aliases", async () => {
  const result = await lintTypeScript(`
    namespace Box {
      export type Payload = unknown;
    }
    export function load(value: Box.Payload): Box.Payload {
      throw new Error(String(value));
    }
  `);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /anti-slop\(no-unknown-parameters\)/);
  assert.match(result.output, /anti-slop\(no-unknown-returns\)/);
});

test("anti-slop resolves aliases across merged namespace blocks", async () => {
  const result = await lintTypeScript(`
    namespace Box {
      export type Payload = unknown;
    }
    namespace Box {
      export function load(value: Payload): Payload {
        throw new Error(String(value));
      }
    }
  `);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /anti-slop\(no-unknown-parameters\)/);
  assert.match(result.output, /anti-slop\(no-unknown-returns\)/);
});

test("anti-slop keeps concrete generic aliases valid", async () => {
  const result = await lintTypeScript(`
    type Identity<T> = T;
    export function load<T>(value: T): Identity<T> {
      return value;
    }
  `);
  assert.equal(result.status, 0, result.output);
});
