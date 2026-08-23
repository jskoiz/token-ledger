import assert from "node:assert/strict";
import test from "node:test";

import { selectProductionPackageEntries } from "../tools/verify-release.mjs";

test("selects only the tarball production dependency closure", () => {
  const sourceLock = {
    packages: {
      "node_modules/eslint": {
        version: "9.39.4",
        dev: true,
      },
      "node_modules/optional": {
        version: "1.0.0",
      },
      "node_modules/runtime": {
        version: "1.0.0",
        dependencies: {
          shared: "1.0.0",
        },
        optionalDependencies: {
          optional: "1.0.0",
        },
      },
      "node_modules/runtime/node_modules/shared": {
        version: "1.0.0",
        dependencies: {
          transitive: "1.0.0",
        },
      },
      "node_modules/runtime/node_modules/transitive": {
        version: "1.0.0",
      },
      "node_modules/shared": {
        version: "9.0.0",
        dev: true,
      },
    },
  };

  const entries = selectProductionPackageEntries(sourceLock, {
    name: "tledger",
    dependencies: {
      runtime: "1.0.0",
    },
    devDependencies: {
      eslint: "9.39.4",
    },
  });

  assert.deepEqual(Object.keys(entries), [
    "node_modules/optional",
    "node_modules/runtime",
    "node_modules/runtime/node_modules/shared",
    "node_modules/runtime/node_modules/transitive",
  ]);
  assert.equal(entries["node_modules/eslint"], undefined);
  assert.equal(entries["node_modules/shared"], undefined);
});

test("rejects a reachable dev-only package", () => {
  assert.throws(
    () =>
      selectProductionPackageEntries(
        {
          packages: {
            "node_modules/runtime": {
              version: "1.0.0",
              dependencies: {
                eslint: "9.39.4",
              },
            },
            "node_modules/eslint": {
              version: "9.39.4",
              dev: true,
            },
          },
        },
        {
          name: "tledger",
          dependencies: {
            runtime: "1.0.0",
          },
        },
      ),
    /marked as dev-only/,
  );
});

test("rejects a lockfile without a packages map", () => {
  assert.throws(
    () => selectProductionPackageEntries({}, { name: "tledger" }),
    /has no packages map/,
  );
});
