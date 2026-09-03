import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import {
  gunzip as gunzipCallback,
  gzip as gzipCallback,
} from "node:zlib";

import {
  ADAPTIVE_USAGE_RESOLUTIONS_SECONDS,
  coarsenUsageBuckets,
  SNAPSHOT_SCHEMA_VERSION,
  usageBucketStats,
  usageBuckets,
} from "./token-ledger-usage.mjs";

const DURABLE_LEDGER_BASENAME = "token-ledger-ledger.sqlite";
const DURABLE_LEDGER_PATH_SUFFIXES = Object.freeze([
  DURABLE_LEDGER_BASENAME,
  `${DURABLE_LEDGER_BASENAME}.writer-lock.sqlite`,
  `${DURABLE_LEDGER_BASENAME}-journal`,
  `${DURABLE_LEDGER_BASENAME}-wal`,
  `${DURABLE_LEDGER_BASENAME}-shm`,
]);
const PRIVATE_STATE_DIRECTORY = resolve(homedir(), ".token-ledger");
const TEST_PRIVATE_STATE_DIRECTORY =
  process.env.NODE_TEST_CONTEXT && process.env.TOKEN_LEDGER_TEST_STATE_ROOT
    ? resolve(process.env.TOKEN_LEDGER_TEST_STATE_ROOT)
    : null;
const PRIVATE_STATE_DIRECTORIES = Object.freeze([
  PRIVATE_STATE_DIRECTORY,
  ...(TEST_PRIVATE_STATE_DIRECTORY ? [TEST_PRIVATE_STATE_DIRECTORY] : []),
]);

export const DEFAULT_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_TARGET_BYTES = 12 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_MAX_JSON_BYTES = 64 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_TARGET_JSON_BYTES = 48 * 1024 * 1024;

const PRECOMPACT_BUCKET_COUNT = 50_000;
const SNAPSHOT_READ_CHUNK_BYTES = 64 * 1024;
const SNAPSHOT_TEMP_HASH_LENGTH = 16;
const SNAPSHOT_TEMP_UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

function snapshotEncoding(path) {
  return path.toLowerCase().endsWith(".gz") ? "gzip" : "json";
}

function snapshotDestinationHash(destination) {
  return createHash("sha256")
    .update(destination)
    .digest("hex")
    .slice(0, SNAPSHOT_TEMP_HASH_LENGTH);
}

function snapshotTemporaryName(destination) {
  return `.token-ledger-${snapshotDestinationHash(destination)}-${process.pid}-${randomUUID()}.tmp`;
}

function snapshotDestinationError(destination) {
  const error = new Error(
    `Snapshot destination is reserved for durable ledger state: ${destination}`,
  );
  error.code = "ERR_SNAPSHOT_RESERVED_PATH";
  return error;
}

function pathIsInside(directory, destination) {
  const child = relative(directory, destination);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function assertSnapshotDestination(destination, reservedPaths) {
  const explicitlyReserved = new Set(
    reservedPaths.map((path) => resolve(path)),
  );
  if (
    explicitlyReserved.has(destination) ||
    (
      PRIVATE_STATE_DIRECTORIES.some((directory) =>
        pathIsInside(directory, destination),
      ) &&
      DURABLE_LEDGER_PATH_SUFFIXES.includes(basename(destination))
    )
  ) {
    throw snapshotDestinationError(destination);
  }
}

function processIsDemonstrablyGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function removeOrphanedSnapshotCandidates(destination) {
  const directory = dirname(destination);
  const destinationHash = snapshotDestinationHash(destination);
  const currentUid = process.getuid instanceof Function
    ? process.getuid()
    : null;
  const candidatePattern = new RegExp(
    `^\\.token-ledger-${destinationHash}-([1-9][0-9]*)-${SNAPSHOT_TEMP_UUID_PATTERN}\\.tmp$`,
  );
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return;
    throw error;
  }
  for (const name of names) {
    const match = name.match(candidatePattern);
    if (!match) continue;
    const ownerPid = Number(match[1]);
    if (
      !Number.isSafeInteger(ownerPid) ||
      ownerPid === process.pid ||
      !processIsDemonstrablyGone(ownerPid)
    ) continue;
    const candidate = resolve(directory, name);
    let candidateStat;
    try {
      candidateStat = await lstat(candidate);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) continue;
      throw error;
    }
    // Only unlink an ordinary, single-link candidate. Symlinks, directories,
    // hard links, and targets that race away are left untouched.
    if (
      !candidateStat.isFile() ||
      Number(candidateStat.nlink) !== 1 ||
      (currentUid !== null && Number(candidateStat.uid) !== currentUid)
    ) continue;
    let confirmedStat;
    try {
      confirmedStat = await lstat(candidate);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) continue;
      throw error;
    }
    if (
      !confirmedStat.isFile() ||
      Number(confirmedStat.nlink) !== 1 ||
      Number(confirmedStat.dev) !== Number(candidateStat.dev) ||
      Number(confirmedStat.ino) !== Number(candidateStat.ino) ||
      (currentUid !== null && Number(confirmedStat.uid) !== currentUid)
    ) continue;
    try {
      await rm(candidate, { force: true });
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM"].includes(
          error?.code,
        )
      ) continue;
      throw error;
    }
  }
}

function formatMebibytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function snapshotWithStorageMetadata(snapshot, buckets, adaptiveResolutionSeconds) {
  const stats = usageBucketStats(buckets);
  return {
    ...snapshot,
    coverage: {
      ...snapshot.coverage,
      observedModelCalls: stats.callCount,
      usageBucketCount: stats.bucketCount,
      maximumUsageResolutionSeconds: stats.maximumResolutionSeconds,
    },
    storage: {
      format: "bounded-usage-buckets",
      modelCalls: stats.callCount,
      usageBuckets: stats.bucketCount,
      maximumResolutionSeconds: stats.maximumResolutionSeconds,
      adaptiveResolutionSeconds,
    },
    events: buckets,
  };
}

async function encodeSnapshot(snapshot, encoding) {
  const serialized = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
  const encoded = encoding === "gzip" ? await gzip(serialized) : serialized;
  return { serialized, encoded };
}

async function boundedEncoding(
  snapshot,
  encoding,
  targetBytes,
  targetJsonBytes,
) {
  if (
    snapshot?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    !Array.isArray(snapshot?.events)
  ) {
    const result = await encodeSnapshot(snapshot, encoding);
    return { ...result, snapshot, adaptiveResolutionSeconds: 0 };
  }

  let buckets = usageBuckets(snapshot);
  let adaptiveResolutionSeconds = 0;
  if (buckets.length > PRECOMPACT_BUCKET_COUNT) {
    adaptiveResolutionSeconds = ADAPTIVE_USAGE_RESOLUTIONS_SECONDS[0];
    buckets = coarsenUsageBuckets(buckets, adaptiveResolutionSeconds);
  }
  let candidate = snapshotWithStorageMetadata(
    snapshot,
    buckets,
    adaptiveResolutionSeconds,
  );
  let result = await encodeSnapshot(candidate, encoding);
  for (const resolutionSeconds of ADAPTIVE_USAGE_RESOLUTIONS_SECONDS) {
    if (
      result.encoded.byteLength <= targetBytes &&
      result.serialized.byteLength <= targetJsonBytes
    ) {
      break;
    }
    if (resolutionSeconds <= adaptiveResolutionSeconds) continue;
    buckets = coarsenUsageBuckets(buckets, resolutionSeconds);
    adaptiveResolutionSeconds = resolutionSeconds;
    candidate = snapshotWithStorageMetadata(
      snapshot,
      buckets,
      adaptiveResolutionSeconds,
    );
    result = await encodeSnapshot(candidate, encoding);
  }
  return {
    ...result,
    snapshot: candidate,
    adaptiveResolutionSeconds,
  };
}

function snapshotSizeLimitError(message) {
  const error = new Error(message);
  error.code = "ERR_SNAPSHOT_SIZE_LIMIT";
  return error;
}

function snapshotNotRegularFileError() {
  const error = new Error("Snapshot input must be a regular file.");
  error.code = "ERR_SNAPSHOT_NOT_REGULAR";
  return error;
}

function snapshotCandidateChangedError() {
  const error = new Error(
    "Snapshot candidate changed before it could be published.",
  );
  error.code = "ERR_SNAPSHOT_CANDIDATE_CHANGED";
  return error;
}

function isSameSnapshotCandidate(candidate, pinned) {
  return Boolean(
    candidate?.isFile() &&
      Number(candidate.nlink) === 1 &&
      Number(candidate.dev) === Number(pinned.dev) &&
      Number(candidate.ino) === Number(pinned.ino),
  );
}

async function readBoundedSnapshot(source, sourceLimit, encoding) {
  const handle = await open(
    source,
    fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const sourceStats = await handle.stat();
    if (!sourceStats.isFile()) {
      throw snapshotNotRegularFileError();
    }
    if (sourceStats.size > sourceLimit) {
      throw snapshotSizeLimitError(
        `Snapshot input is ${formatMebibytes(sourceStats.size)}, exceeding the ${formatMebibytes(sourceLimit)} ${encoding === "gzip" ? "compressed" : "JSON"} read limit.`,
      );
    }

    const chunks = [];
    let bytesRead = 0;
    while (bytesRead < sourceLimit) {
      const chunkLength = Math.min(
        SNAPSHOT_READ_CHUNK_BYTES,
        sourceLimit - bytesRead,
      );
      const chunk = Buffer.allocUnsafe(chunkLength);
      const result = await handle.read(
        chunk,
        0,
        chunkLength,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }
    if (bytesRead >= sourceLimit) {
      const extra = Buffer.allocUnsafe(1);
      const result = await handle.read(extra, 0, 1, bytesRead);
      if (result.bytesRead > 0) {
        throw snapshotSizeLimitError(
          `Snapshot input exceeds the ${formatMebibytes(sourceLimit)} ${encoding === "gzip" ? "compressed" : "JSON"} read limit.`,
        );
      }
    }
    const finalStats = await handle.stat();
    if (finalStats.size > sourceLimit) {
      throw snapshotSizeLimitError(
        `Snapshot input grew beyond the ${formatMebibytes(sourceLimit)} ${encoding === "gzip" ? "compressed" : "JSON"} read limit.`,
      );
    }
    return Buffer.concat(chunks, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readPrivateSnapshot(
  input,
  {
    maxBytes = DEFAULT_SNAPSHOT_MAX_BYTES,
    maxJsonBytes = DEFAULT_SNAPSHOT_MAX_JSON_BYTES,
  } = {},
) {
  const source = resolve(input);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Snapshot size limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes < 1) {
    throw new Error("Snapshot JSON safety limit must be a positive safe integer.");
  }
  const encoding = snapshotEncoding(source);
  const sourceLimit = encoding === "gzip" ? maxBytes : maxJsonBytes;
  const encoded = await readBoundedSnapshot(source, sourceLimit, encoding);
  let decoded;
  if (encoding === "gzip") {
    try {
      decoded = await gunzip(encoded, { maxOutputLength: maxJsonBytes });
    } catch (cause) {
      if (cause?.code !== "ERR_BUFFER_TOO_LARGE") throw cause;
      const error = new Error(
        `Snapshot expands beyond the ${formatMebibytes(maxJsonBytes)} JSON read limit.`,
        { cause },
      );
      error.code = "ERR_SNAPSHOT_SIZE_LIMIT";
      throw error;
    }
  } else {
    decoded = encoded;
  }
  if (decoded.byteLength > maxJsonBytes) {
    throw snapshotSizeLimitError(
      `Snapshot JSON representation is ${formatMebibytes(decoded.byteLength)}, exceeding the ${formatMebibytes(maxJsonBytes)} read limit.`,
    );
  }
  return JSON.parse(decoded.toString("utf8"));
}

export async function stagePrivateSnapshot(
  output,
  snapshot,
  {
    maxBytes = DEFAULT_SNAPSHOT_MAX_BYTES,
    targetBytes = Math.min(DEFAULT_SNAPSHOT_TARGET_BYTES, maxBytes),
    maxJsonBytes = DEFAULT_SNAPSHOT_MAX_JSON_BYTES,
    targetJsonBytes = Math.min(
      DEFAULT_SNAPSHOT_TARGET_JSON_BYTES,
      maxJsonBytes,
    ),
    reservedPaths = [],
  } = {},
) {
  const destination = resolve(output);
  assertSnapshotDestination(destination, reservedPaths);
  const directory = dirname(destination);
  const temporary = resolve(
    directory,
    snapshotTemporaryName(destination),
  );
  const encoding = snapshotEncoding(destination);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Snapshot size limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 1 || targetBytes > maxBytes) {
    throw new Error("Snapshot target size must be a positive safe integer at or below the safety limit.");
  }
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes < 1) {
    throw new Error("Snapshot JSON safety limit must be a positive safe integer.");
  }
  if (
    !Number.isSafeInteger(targetJsonBytes) ||
    targetJsonBytes < 1 ||
    targetJsonBytes > maxJsonBytes
  ) {
    throw new Error(
      "Snapshot JSON target size must be a positive safe integer at or below its safety limit.",
    );
  }
  const {
    serialized,
    encoded,
    snapshot: storedSnapshot,
    adaptiveResolutionSeconds,
  } = await boundedEncoding(
    snapshot,
    encoding,
    targetBytes,
    targetJsonBytes,
  );
  if (serialized.byteLength > maxJsonBytes) {
    const error = new Error(
      `Snapshot JSON representation would be ${formatMebibytes(serialized.byteLength)}, exceeding the ${formatMebibytes(maxJsonBytes)} in-memory safety limit. Use --since or --no-archived to reduce high-cardinality history.`,
    );
    error.code = "ERR_SNAPSHOT_SIZE_LIMIT";
    throw error;
  }
  if (encoded.byteLength > maxBytes) {
    const error = new Error(
      `Snapshot would be ${formatMebibytes(encoded.byteLength)}, exceeding the ${formatMebibytes(maxBytes)} safety limit. Use a .json.gz output plus --since or --no-archived to reduce the snapshot.`,
    );
    error.code = "ERR_SNAPSHOT_SIZE_LIMIT";
    throw error;
  }

  await mkdir(directory, { recursive: true });
  await removeOrphanedSnapshotCandidates(destination);
  let candidateHandle = null;
  let candidateIdentity = null;
  try {
    candidateHandle = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await candidateHandle.writeFile(encoded);
    await candidateHandle.chmod(0o600);
    await candidateHandle.sync();
    candidateIdentity = await candidateHandle.stat();
    if (!candidateIdentity.isFile() || Number(candidateIdentity.nlink) !== 1) {
      throw snapshotCandidateChangedError();
    }
  } catch (error) {
    await candidateHandle?.close();
    await rm(temporary, { force: true });
    throw error;
  }

  let published = false;
  let discarded = false;
  const publish = async () => {
    if (published) return;
    if (discarded) {
      throw new Error("Cannot publish a discarded snapshot candidate.");
    }
    let currentIdentity;
    try {
      currentIdentity = await lstat(temporary);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) {
        throw snapshotCandidateChangedError();
      }
      throw error;
    }
    if (!isSameSnapshotCandidate(currentIdentity, candidateIdentity)) {
      throw snapshotCandidateChangedError();
    }
    await rename(temporary, destination);
    const publishedIdentity = await lstat(destination);
    if (!isSameSnapshotCandidate(publishedIdentity, candidateIdentity)) {
      await rm(destination, { force: true });
      throw snapshotCandidateChangedError();
    }
    await candidateHandle.close();
    candidateHandle = null;
    published = true;
  };
  const discard = async () => {
    if (published || discarded) return;
    discarded = true;
    await candidateHandle?.close();
    candidateHandle = null;
    let currentIdentity;
    try {
      currentIdentity = await lstat(temporary);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) return;
      throw error;
    }
    if (isSameSnapshotCandidate(currentIdentity, candidateIdentity)) {
      await rm(temporary, { force: true });
    }
  };

  return {
    publish,
    discard,
    encoding,
    bytesWritten: encoded.byteLength,
    jsonBytes: serialized.byteLength,
    maxBytes,
    targetBytes,
    maxJsonBytes,
    targetJsonBytes,
    adaptiveResolutionSeconds,
    snapshot: storedSnapshot,
  };
}

export async function writePrivateSnapshot(output, snapshot, options = {}) {
  const staged = await stagePrivateSnapshot(output, snapshot, options);
  try {
    await staged.publish();
    return {
      encoding: staged.encoding,
      bytesWritten: staged.bytesWritten,
      jsonBytes: staged.jsonBytes,
      maxBytes: staged.maxBytes,
      targetBytes: staged.targetBytes,
      maxJsonBytes: staged.maxJsonBytes,
      targetJsonBytes: staged.targetJsonBytes,
      adaptiveResolutionSeconds: staged.adaptiveResolutionSeconds,
      snapshot: staged.snapshot,
    };
  } finally {
    await staged.discard();
  }
}
