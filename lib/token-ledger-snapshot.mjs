import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
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

export const DEFAULT_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

function snapshotEncoding(path) {
  return path.toLowerCase().endsWith(".gz") ? "gzip" : "json";
}

function formatMebibytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export async function readPrivateSnapshot(input) {
  const source = resolve(input);
  const encoded = await readFile(source);
  const decoded = snapshotEncoding(source) === "gzip"
    ? await gunzip(encoded)
    : encoded;
  return JSON.parse(decoded.toString("utf8"));
}

export async function writePrivateSnapshot(
  output,
  snapshot,
  { maxBytes = DEFAULT_SNAPSHOT_MAX_BYTES } = {},
) {
  const destination = resolve(output);
  const directory = dirname(destination);
  const temporary = resolve(
    directory,
    `.token-ledger-${process.pid}-${randomUUID()}.tmp`,
  );
  const serialized = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
  const encoding = snapshotEncoding(destination);
  const encoded = encoding === "gzip" ? await gzip(serialized) : serialized;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Snapshot size limit must be a positive safe integer.");
  }
  if (encoded.byteLength > maxBytes) {
    throw new Error(
      `Snapshot would be ${formatMebibytes(encoded.byteLength)}, exceeding the ${formatMebibytes(maxBytes)} safety limit. Use a .json.gz output plus --since or --no-archived to reduce the snapshot.`,
    );
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
  };
}
