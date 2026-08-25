import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

export const DEFAULT_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_TARGET_BYTES = 12 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_MAX_JSON_BYTES = 64 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_TARGET_JSON_BYTES = 48 * 1024 * 1024;

const PRECOMPACT_BUCKET_COUNT = 50_000;
const SNAPSHOT_READ_CHUNK_BYTES = 64 * 1024;

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

function snapshotEncoding(path) {
  return path.toLowerCase().endsWith(".gz") ? "gzip" : "json";
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

export async function writePrivateSnapshot(
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
  } = {},
) {
  const destination = resolve(output);
  const directory = dirname(destination);
  const temporary = resolve(
    directory,
    `.token-ledger-${process.pid}-${randomUUID()}.tmp`,
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
  try {
    await writeFile(temporary, encoded, {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }

  return {
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
