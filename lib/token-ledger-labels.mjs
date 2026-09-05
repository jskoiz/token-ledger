// Shared export-label policy for local metadata and user-visible reports.

export const LOCAL_LABEL = "local";
export const LOCAL_PATH_PLACEHOLDER = "[local path]";

const QUOTED_LOCAL_PATH =
  /(["'])(?:file:\/\/|[A-Za-z]:[\\/]|(?:\\\\|\/\/)|\/(?!\/))[^\r\n]*?\1/gi;
const FILE_URL_PATH = /file:\/\/[^\s"'`<>(){}\x5b\x5d,;!?]+/gi;
const WINDOWS_DRIVE_PATH =
  /\b[A-Za-z]:[\\/][^\s"'`<>(){}\x5b\x5d,;!?]+/g;
const UNC_PATH =
  /(?<!:)(?:\\\\|\/\/)[^\s"'`<>(){}\x5b\x5d,;!?]+[\\/][^\s"'`<>(){}\x5b\x5d,;!?]+/g;
const POSIX_PATH =
  /(?<![\w/])\/(?!\/)[^\s"'`<>(){}\x5b\x5d,;!?]+/g;
const CREDENTIAL_LIKE_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|lin_api_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{16,})\b/g;

function boundedText(value, maximumLength = 2_000) {
  try {
    return String(value ?? "").slice(0, maximumLength);
  } catch {
    return "";
  }
}

function standaloneLocalPathRange(value) {
  const start = value.search(/\S/);
  if (start < 0) return null;
  const end = value.search(/\s*$/);
  const trimmed = value.slice(start, end);
  return /^(?:file:\/\/|[A-Za-z]:[\\/]|(?:\\\\|\/\/)|\/(?!\/))/i.test(trimmed)
    ? [start, end]
    : null;
}

export function redactLocalPathTokens(value) {
  const text = boundedText(value);
  const standalone = standaloneLocalPathRange(text);
  if (standalone) {
    const [start, end] = standalone;
    return `${text.slice(0, start)}${LOCAL_PATH_PLACEHOLDER}${text.slice(end)}`;
  }
  return text
    .replace(
      QUOTED_LOCAL_PATH,
      (_match, quote) => `${quote}${LOCAL_PATH_PLACEHOLDER}${quote}`,
    )
    .replace(FILE_URL_PATH, LOCAL_PATH_PLACEHOLDER)
    .replace(WINDOWS_DRIVE_PATH, LOCAL_PATH_PLACEHOLDER)
    .replace(UNC_PATH, LOCAL_PATH_PLACEHOLDER)
    .replace(POSIX_PATH, LOCAL_PATH_PLACEHOLDER);
}

export function containsLocalPath(value) {
  const text = boundedText(value);
  return text !== "" && redactLocalPathTokens(text) !== text;
}

export function safeExportLabel(value, maximumLength = 2_000, fallback = "") {
  const label = redactLocalPathTokens(value)
    .replace(CREDENTIAL_LIKE_TOKEN, "[redacted credential-like text]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
  return label || fallback;
}
