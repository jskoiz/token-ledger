#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const REQUIRED_ROOT_FILES = new Set(["LICENSE", "README.md", "package.json"]);
const REQUIRED_ROOT_DIRECTORIES = new Set(["bin", "lib"]);
const FORBIDDEN_PACKED_PATHS = [
  ".github/",
  "eslint.config.mjs",
  "package-lock.json",
  "tests/",
  "tools/",
  "tsconfig.json",
];

function normalizePath(value) {
  return value.split(sep).join("/");
}

function formatCommand(command, args) {
  return [command, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function run(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${formatCommand(command, args)} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr]
      .filter((value) => value.trim())
      .join("\n")
      .trim();
    throw new Error(
      `${formatCommand(command, args)} exited with status ${result.status}.\n${details}`,
    );
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const relativePath = normalizePath(join(prefix, entry.name));
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function expectedPackageFiles(packageJson) {
  const expected = new Set(REQUIRED_ROOT_FILES);
  for (const entry of packageJson.files ?? []) {
    const normalizedEntry = normalizePath(entry).replace(/\/$/, "");
    const absoluteEntry = resolve(REPO_ROOT, normalizedEntry);
    assert(
      absoluteEntry === REPO_ROOT || absoluteEntry.startsWith(`${REPO_ROOT}${sep}`),
      `Package files entry escapes the repository: ${entry}`,
    );
    const entryStats = await stat(absoluteEntry);
    if (entryStats.isDirectory()) {
      const files = await listFiles(absoluteEntry, normalizedEntry);
      for (const file of files) expected.add(file);
    } else if (entryStats.isFile()) {
      expected.add(normalizedEntry);
    } else {
      throw new Error(`Package files entry is not a file or directory: ${entry}`);
    }
  }
  return [...expected].sort();
}

function assertSameFiles(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(
    actualJson === expectedJson,
    `${label} differ.\nExpected: ${expectedJson}\nActual: ${actualJson}`,
  );
}

function parsePackMetadata(output) {
  try {
    const parsed = JSON.parse(output.trim());
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (error) {
    throw new Error(`npm pack did not return JSON metadata: ${error.message}\n${output}`);
  }
}

function assertNoForbiddenFiles(files) {
  const forbidden = files.filter((file) =>
    FORBIDDEN_PACKED_PATHS.some((prefix) => file === prefix || file.startsWith(prefix)),
  );
  assert(
    forbidden.length === 0,
    `Packed artifact contains source-only files: ${forbidden.join(", ")}`,
  );
}

function parentPackagePath(packagePath) {
  const nestedPackageMarker = "/node_modules/";
  const markerIndex = packagePath.lastIndexOf(nestedPackageMarker);
  return markerIndex === -1 ? "" : packagePath.slice(0, markerIndex);
}

function resolvePackagePath(packages, fromPackagePath, dependencyName) {
  let packagePath = fromPackagePath;
  while (true) {
    const candidate = `${packagePath ? `${packagePath}/` : ""}node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (packagePath === "") return null;
    packagePath = parentPackagePath(packagePath);
  }
}

function dependencyEntries(packageEntry) {
  const dependencies = new Map();
  for (const dependencyName of Object.keys(packageEntry.dependencies ?? {})) {
    dependencies.set(dependencyName, false);
  }
  for (const dependencyName of Object.keys(packageEntry.optionalDependencies ?? {})) {
    if (!dependencies.has(dependencyName)) dependencies.set(dependencyName, true);
  }
  for (const dependencyName of Object.keys(packageEntry.peerDependencies ?? {})) {
    if (!dependencies.has(dependencyName)) {
      dependencies.set(
        dependencyName,
        packageEntry.peerDependenciesMeta?.[dependencyName]?.optional === true,
      );
    }
  }
  return [...dependencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, optional]) => ({ name, optional }));
}

export function selectProductionPackageEntries(sourceLock, packageJson) {
  const sourcePackages = sourceLock.packages;
  assert(sourcePackages, "package-lock.json has no packages map.");

  const selectedPackages = new Map();
  const pendingPackages = [[`node_modules/${packageJson.name}`, packageJson]];
  for (let index = 0; index < pendingPackages.length; index += 1) {
    const [packagePath, packageEntry] = pendingPackages[index];
    for (const { name: dependencyName, optional } of dependencyEntries(packageEntry)) {
      const dependencyPath = resolvePackagePath(
        sourcePackages,
        packagePath,
        dependencyName,
      );
      if (dependencyPath === null) {
        if (optional) continue;
        throw new Error(
          `Production dependency "${dependencyName}" of "${packagePath}" is missing from package-lock.json.`,
        );
      }

      const dependencyEntry = sourcePackages[dependencyPath];
      assert(
        dependencyEntry.dev !== true,
        `Production dependency "${dependencyPath}" is marked as dev-only in package-lock.json.`,
      );
      if (selectedPackages.has(dependencyPath)) continue;
      selectedPackages.set(dependencyPath, dependencyEntry);
      pendingPackages.push([dependencyPath, dependencyEntry]);
    }
  }

  return Object.fromEntries(
    [...selectedPackages.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function writeSmokeFixture(path) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const fixture = {
    generatedAt: new Date(now - 5 * 60 * 1000).toISOString(),
    events: [
      {
        id: "release-alpha-inside",
        timestamp: new Date(now - hour).toISOString(),
        project: "Alpha",
        threadId: "release-alpha",
        model: "gpt-5.5",
        totalTokens: 1_200,
        inputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 200,
        useType: "sdk",
        rateCardCredits: 3,
      },
      {
        id: "release-beta-inside",
        timestamp: new Date(now - 2 * hour).toISOString(),
        project: "Beta",
        threadId: "release-beta",
        model: "gpt-5.6-luna",
        totalTokens: 800,
        inputTokens: 700,
        cachedInputTokens: 100,
        outputTokens: 100,
        useType: "tool",
        rateCardCredits: 2,
      },
      {
        id: "release-alpha-old",
        timestamp: new Date(now - 48 * hour).toISOString(),
        project: "Alpha",
        threadId: "release-alpha-old",
        model: "gpt-5.5",
        totalTokens: 9_000,
        inputTokens: 8_000,
        cachedInputTokens: 1_000,
        outputTokens: 1_000,
        useType: "sdk",
        rateCardCredits: 12,
      },
      {
        id: "release-beta-future",
        timestamp: new Date(now + hour).toISOString(),
        project: "Beta",
        threadId: "release-beta-future",
        model: "gpt-5.6-luna",
        totalTokens: 5_000,
        inputTokens: 4_500,
        cachedInputTokens: 500,
        outputTokens: 500,
        useType: "tool",
        rateCardCredits: 8,
      },
    ],
    threads: [
      { id: "release-alpha", project: "Alpha" },
      { id: "release-beta", project: "Beta" },
      { id: "release-alpha-old", project: "Alpha" },
      { id: "release-beta-future", project: "Beta" },
    ],
  };
  await writeFile(path, `${JSON.stringify(fixture)}\n`, "utf8");
}

async function writeCleanInstallProject(installDirectory, tarballPath, packageJson) {
  const sourceLock = JSON.parse(
    await readFile(join(REPO_ROOT, "package-lock.json"), "utf8"),
  );
  const tarballSpecifier = `file:${normalizePath(relative(installDirectory, tarballPath))}`;
  const installPackageJson = {
    name: "tledger-release-smoke",
    private: true,
    version: "0.0.0",
    dependencies: { [packageJson.name]: tarballSpecifier },
  };
  const installPackages = selectProductionPackageEntries(sourceLock, packageJson);
  installPackages[`node_modules/${packageJson.name}`] = {
    version: packageJson.version,
    resolved: tarballSpecifier,
    dependencies: packageJson.dependencies,
    optionalDependencies: packageJson.optionalDependencies,
    peerDependencies: packageJson.peerDependencies,
    peerDependenciesMeta: packageJson.peerDependenciesMeta,
    bin: packageJson.bin,
    engines: packageJson.engines,
    license: packageJson.license,
  };
  const installLock = {
    name: installPackageJson.name,
    version: installPackageJson.version,
    lockfileVersion: sourceLock.lockfileVersion,
    requires: true,
    packages: {
      "": installPackageJson,
      ...installPackages,
    },
  };
  await writeFile(
    join(installDirectory, "package.json"),
    `${JSON.stringify(installPackageJson)}\n`,
    "utf8",
  );
  await writeFile(
    join(installDirectory, "package-lock.json"),
    `${JSON.stringify(installLock)}\n`,
    "utf8",
  );
}

async function main() {
  const packageJson = JSON.parse(
    await readFile(join(REPO_ROOT, "package.json"), "utf8"),
  );
  const expectedFiles = await expectedPackageFiles(packageJson);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tledger-release-"));
  const temporaryDirectoryPrefix = `${resolve(tmpdir())}${sep}`;
  const temporaryRootIsSafe =
    temporaryRoot.startsWith(temporaryDirectoryPrefix) &&
    basename(temporaryRoot).startsWith("tledger-release-");

  try {
    assert(temporaryRootIsSafe, `Refusing to clean an unexpected temporary path: ${temporaryRoot}`);
    const packDirectory = join(temporaryRoot, "pack");
    const installDirectory = join(temporaryRoot, "install");
    const npmCacheDirectory = join(temporaryRoot, "npm-cache");
    await mkdir(packDirectory);
    await mkdir(installDirectory);
    await mkdir(npmCacheDirectory);

    const packOutput = run(
      NPM_COMMAND,
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--pack-destination",
        packDirectory,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          NPM_CONFIG_CACHE: npmCacheDirectory,
          npm_config_cache: npmCacheDirectory,
        },
      },
    );
    const packMetadata = parsePackMetadata(packOutput);
    assert(packMetadata?.filename, "npm pack did not report a tarball filename.");
    const tarballPath = join(packDirectory, packMetadata.filename);
    const tarballStats = await stat(tarballPath);
    assert(tarballStats.isFile(), `npm pack did not create ${packMetadata.filename}.`);

    const packedFiles = (packMetadata.files ?? [])
      .map((file) => normalizePath(file.path))
      .sort();
    assertSameFiles(packedFiles, expectedFiles, "Packed artifact contents");
    assertNoForbiddenFiles(packedFiles);
    for (const requiredFile of REQUIRED_ROOT_FILES) {
      assert(packedFiles.includes(requiredFile), `Packed artifact is missing ${requiredFile}.`);
    }
    for (const requiredDirectory of REQUIRED_ROOT_DIRECTORIES) {
      assert(
        packedFiles.some((file) => file.startsWith(`${requiredDirectory}/`)),
        `Packed artifact is missing ${requiredDirectory}/.`,
      );
    }

    await writeCleanInstallProject(installDirectory, tarballPath, packageJson);
    run(
      NPM_COMMAND,
      [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--offline",
        tarballPath,
      ],
      { cwd: installDirectory },
    );

    const installedPackageRoot = join(
      installDirectory,
      "node_modules",
      packageJson.name,
    );
    const installedFiles = await listFiles(installedPackageRoot);
    assertSameFiles(installedFiles, expectedFiles, "Installed package contents");
    assertNoForbiddenFiles(installedFiles);
    const installedPackageRealpath = await realpath(installedPackageRoot);
    const installDirectoryRealpath = await realpath(installDirectory);
    assert(
      installedPackageRealpath.startsWith(`${installDirectoryRealpath}${sep}`),
      "Installed package resolves outside the clean temporary directory.",
    );

    const installedPackageJson = JSON.parse(
      await readFile(join(installedPackageRoot, "package.json"), "utf8"),
    );
    assert(
      installedPackageJson.name === packageJson.name &&
        installedPackageJson.version === packageJson.version,
      "Installed package metadata does not match the packed package.",
    );

    const installedBinary = join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tledger.cmd" : "tledger",
    );
    const cleanHome = join(installDirectory, "home");
    const cleanCodexHome = join(installDirectory, "codex-home");
    await mkdir(cleanHome);
    await mkdir(cleanCodexHome);
    const cleanEnvironment = {
      CODEX_HOME: cleanCodexHome,
      HOME: cleanHome,
      NO_COLOR: "1",
      USERPROFILE: cleanHome,
    };

    const helpOutput = run(installedBinary, ["--help"], {
      cwd: installDirectory,
      env: cleanEnvironment,
    });
    assert(
      helpOutput.includes("Rolling 24-hour project breakdown") &&
        helpOutput.includes("--input") &&
        helpOutput.includes("--no-refresh") &&
        helpOutput.includes("--cache-rate"),
      "Installed tledger --help did not expose the expected release CLI options.",
    );

    const fixturePath = join(installDirectory, "release-smoke-fixture.json");
    await writeSmokeFixture(fixturePath);
    const smokeOutput = run(
      installedBinary,
      [
        "1d",
        "--input",
        fixturePath,
        "--no-refresh",
        "--static",
        "--plain",
        "--ascii",
        "--tz",
        "UTC",
        "--width",
        "120",
      ],
      { cwd: installDirectory, env: cleanEnvironment },
    );
    assert(
      smokeOutput.includes("LAST 24 HOURS") &&
        smokeOutput.includes("TOKENS BY PROJECT") &&
        /Alpha.*1\.20K/.test(smokeOutput) &&
        /Beta.*800/.test(smokeOutput) &&
        smokeOutput.includes("2.00K TOKENS"),
      `Installed tledger 1d smoke output was unexpected:\n${smokeOutput}`,
    );
    assert(
      !smokeOutput.includes(REPO_ROOT) && !smokeOutput.includes(fixturePath),
      "Installed smoke output exposed a source or fixture path.",
    );

    const cacheReportPath = join(installDirectory, "release-cache-report.png");
    const cacheReportOutput = run(
      installedBinary,
      [
        "report",
        "7d",
        "--cache-rate",
        "--input",
        fixturePath,
        "--no-open",
        "--tz",
        "UTC",
        "--image-output",
        cacheReportPath,
      ],
      { cwd: installDirectory, env: cleanEnvironment },
    );
    assert(
      cacheReportOutput.includes("Wrote cache report:") &&
        cacheReportOutput.includes("release-cache-report.png"),
      `Installed tledger cache-report smoke output was unexpected:\n${cacheReportOutput}`,
    );
    const cacheReportBytes = await readFile(cacheReportPath);
    assert(
      JSON.stringify([...cacheReportBytes.subarray(0, 8)]) ===
        JSON.stringify([137, 80, 78, 71, 13, 10, 26, 10]),
      "Installed tledger cache-report smoke did not write a PNG.",
    );

    console.log(`Packed ${packMetadata.id ?? `${packageJson.name}@${packageJson.version}`}.`);
    console.log(`Package contents verified (${packedFiles.length} files).`);
    console.log("Installed tarball in a clean temporary directory.");
    console.log("tledger --help: passed.");
    console.log("tledger 1d --static project smoke: passed (Alpha 1.20K, Beta 800, 2.00K total).");
    console.log("tledger report --cache-rate PNG smoke: passed.");
    console.log("Release verification passed.");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
