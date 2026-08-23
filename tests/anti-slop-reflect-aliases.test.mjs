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
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "tledger-anti-slop-reflect-"));
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

test("Reflect rules follow stable object, member, renamed, and destructured aliases", async () => {
  const result = await lintTypeScript(`
    const value = { id: "value" };
    function target(argument) { return argument; }
    const args = [value];
    const nativeReflect = Reflect;
    const getMember = Reflect.get;
    const applyMember = Reflect.apply;
    const renamedGet = nativeReflect.get;
    const renamedApply = nativeReflect.apply;
    const { get: destructuredGet } = Reflect;
    const { apply: destructuredApply } = nativeReflect;
    const literalGet = Reflect["get"];
    const literalApply = nativeReflect["apply"];
    const globalReflect = globalThis["Reflect"];
    const globalGet = globalThis.Reflect.get;
    const globalApply = globalThis.Reflect.apply;

    nativeReflect.get(value, "id");
    nativeReflect.apply(target, null, args);
    getMember(value, "id");
    applyMember(target, null, args);
    renamedGet(value, "id");
    renamedApply(target, null, args);
    destructuredGet(value, "id");
    destructuredApply(target, null, args);
    literalGet(value, "id");
    literalApply(target, null, args);
    globalThis.Reflect.get(value, "id");
    globalThis.Reflect.apply(target, null, args);
    globalReflect.get(value, "id");
    globalReflect.apply(target, null, args);
    globalGet(value, "id");
    globalApply(target, null, args);
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-reflect-get\)/g)?.length,
    8,
    result.output,
  );
  assert.equal(
    result.output.match(/anti-slop\(no-reflect-apply\)/g)?.length,
    8,
    result.output,
  );
  assert.equal(
    result.output.match(/anti-slop\(/g)?.length,
    16,
    result.output,
  );
});

test("Reflect rules preserve mutable, shadowed, dynamic, unrelated, and allowed controls", async () => {
  const result = await lintTypeScript(`
    const value = { id: "value" };
    function target(argument) { return argument; }
    const args = [value];
    const fakeReflect = {
      get() { return "fake"; },
      apply() { return "fake"; },
    };
    let mutableGet = Reflect.get;
    let mutableApply = Reflect.apply;
    let mutableReflect = Reflect;
    mutableGet = fakeReflect.get;
    mutableApply = fakeReflect.apply;
    mutableReflect = fakeReflect;
    const unrelatedGet = fakeReflect.get;
    const { apply: unrelatedApply } = fakeReflect;
    const dynamicGet = "get";
    const dynamicApply = "apply";
    const construct = Reflect.construct;
    const fakeGlobalThis = { Reflect: fakeReflect };
    const fakeGlobalGet = fakeGlobalThis.Reflect.get;
    let mutableGlobalReflect = globalThis.Reflect;
    mutableGlobalReflect = fakeReflect;

    function shadowed(Reflect) {
      const localGet = Reflect.get;
      const { apply: localApply } = Reflect;
      localGet(value, "id");
      localApply(target, null, args);
    }

    function shadowedGlobal(globalThis) {
      const localGet = globalThis.Reflect.get;
      localGet(value, "id");
    }

    mutableGet(value, "id");
    mutableApply(target, null, args);
    mutableReflect.get(value, "id");
    mutableReflect.apply(target, null, args);
    unrelatedGet(value, "id");
    unrelatedApply(target, null, args);
    Reflect[dynamicGet](value, "id");
    Reflect[dynamicApply](target, null, args);
    construct(Date, []);
    fakeGlobalGet(value, "id");
    mutableGlobalReflect.get(value, "id");
    void shadowed;
    void shadowedGlobal;
  `);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /anti-slop\(no-reflect-(?:get|apply)\)/);
});
