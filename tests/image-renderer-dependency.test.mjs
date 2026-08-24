import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER_FILES = [
  resolve(ROOT, "bin/token-ledger-trend-image.mjs"),
  resolve(ROOT, "bin/token-ledger-cache-image.mjs"),
];

function relativeImports(source) {
  const imports = [];
  const pattern = /(?:^|\n)\s*import(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1].startsWith(".")) imports.push(match[1]);
  }
  return imports;
}

async function productionImportGraph() {
  const graph = new Map();
  const visit = async (file) => {
    if (graph.has(file)) return;
    const source = await readFile(file, "utf8");
    const children = relativeImports(source)
      .map((specifier) => resolve(dirname(file), specifier))
      .filter((child) => child.endsWith(".mjs"));
    graph.set(file, children);
    await Promise.all(children.map(visit));
  };
  await Promise.all(RENDERER_FILES.map(visit));
  return graph;
}

function findCycles(graph) {
  const cycles = [];
  const active = new Set();
  const visited = new Set();
  const stack = [];
  const visit = (file) => {
    if (active.has(file)) {
      const start = stack.indexOf(file);
      cycles.push([...stack.slice(start), file]);
      return;
    }
    if (visited.has(file)) return;
    active.add(file);
    stack.push(file);
    for (const child of graph.get(file) ?? []) visit(child);
    stack.pop();
    active.delete(file);
    visited.add(file);
  };
  for (const file of graph.keys()) visit(file);
  return cycles;
}

test("image renderer imports remain acyclic", async () => {
  const graph = await productionImportGraph();
  assert.deepEqual(findCycles(graph), []);

  const [trendSource, cacheSource] = await Promise.all(
    RENDERER_FILES.map((file) => readFile(file, "utf8")),
  );
  assert.doesNotMatch(
    trendSource,
    /from ["']\.\/token-ledger-cache-image\.mjs["']/,
  );
  assert.doesNotMatch(
    cacheSource,
    /from ["']\.\/token-ledger-trend-image\.mjs["']/,
  );
});
