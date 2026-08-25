const DAY_MS = 24 * 60 * 60 * 1_000;
const BOUNDARY_SEARCH_RADIUS_MS = 3 * DAY_MS;
const BOUNDARY_SAMPLE_STEP_MS = 6 * 60 * 60 * 1_000;
const BOUNDARY_PROBE_STEP_MS = 60 * 60 * 1_000;
const MAX_BOUNDARY_PROBES = 72;
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dateStringFromParts(year, month, day) {
  return [year, month, day]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

function parseCalendarDate(dateString) {
  if (!CALENDAR_DATE_PATTERN.test(dateString)) {
    throw new Error(`Invalid calendar date: ${dateString}`);
  }
  const [year, month, day] = dateString.split("-").map(Number);
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  check.setUTCHours(0, 0, 0, 0);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${dateString}`);
  }
  return { year, month, day };
}

function calendarDate(dateString) {
  const { year, month, day } = parseCalendarDate(dateString);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function utcMilliseconds(year, month, day, hour, minute, second) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function numericDateTimeParts(timestampMs, formatter) {
  const parts = formatter.formatToParts(new Date(timestampMs));
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal" && part.type !== "timeZoneName")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function timeZoneOffsetMs(timestampMs, formatter) {
  const values = numericDateTimeParts(timestampMs, formatter);
  const instantSecondMs = Math.floor(timestampMs / 1_000) * 1_000;
  return (
    utcMilliseconds(
      values.year,
      values.month,
      values.day,
      values.hour,
      values.minute,
      values.second,
    ) - instantSecondMs
  );
}

function localDateStringWithFormatter(timestampMs, formatter) {
  const values = numericDateTimeParts(timestampMs, formatter);
  return dateStringFromParts(values.year, values.month, values.day);
}

function findEarliestLocalDateInstant(candidateMs, dateString, formatter) {
  let high = candidateMs;
  let low = high - BOUNDARY_PROBE_STEP_MS;
  let probes = 0;
  while (
    localDateStringWithFormatter(low, formatter) === dateString &&
    probes < MAX_BOUNDARY_PROBES
  ) {
    high = low;
    low -= BOUNDARY_PROBE_STEP_MS;
    probes += 1;
  }
  if (localDateStringWithFormatter(low, formatter) === dateString) {
    throw new Error(`Could not find the start of local date ${dateString}.`);
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDateStringWithFormatter(middle, formatter) === dateString) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return high;
}

function candidateOffsets(utcGuess, formatter) {
  // Keep both sides of a nearby offset transition available. A fixed-point
  // midnight guess alone can land in the preceding local date when midnight
  // was skipped.
  const offsets = new Set();
  for (
    let delta = -BOUNDARY_SEARCH_RADIUS_MS;
    delta <= BOUNDARY_SEARCH_RADIUS_MS;
    delta += BOUNDARY_SAMPLE_STEP_MS
  ) {
    offsets.add(timeZoneOffsetMs(utcGuess + delta, formatter));
  }

  let probe = utcGuess;
  for (let index = 0; index < 8; index += 1) {
    const offset = timeZoneOffsetMs(probe, formatter);
    offsets.add(offset);
    const next = utcGuess - offset;
    if (next === probe) break;
    probe = next;
  }
  return offsets;
}

export function createTimeZoneFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

export function validateTimeZone(timeZone) {
  try {
    createTimeZoneFormatter(timeZone);
  } catch {
    throw new Error(`Unknown IANA timezone: ${timeZone}`);
  }
}

export function shiftCalendarDate(dateString, amount) {
  const { year, month, day } = parseCalendarDate(dateString);
  const delta = Number(amount);
  if (!Number.isSafeInteger(delta)) {
    throw new Error(`Calendar date shift must be an integer: ${amount}`);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day + delta);
  date.setUTCHours(0, 0, 0, 0);
  return dateStringFromParts(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

export function localDateString(timestampMs, timeZone, formatter) {
  const dateFormatter = formatter ?? createTimeZoneFormatter(timeZone);
  return localDateStringWithFormatter(timestampMs, dateFormatter);
}

export function todayInTimeZone(timeZone, formatter) {
  return localDateString(Date.now(), timeZone, formatter);
}

// The boundary is the first valid instant belonging to the requested local
// date. If a time-zone transition skips the entire date, the boundary is
// collapsed onto the next representable date, so the skipped date is empty.
// When midnight is repeated, the earliest occurrence is selected.
export function localDateBoundary(dateString, timeZone, formatter) {
  parseCalendarDate(dateString);
  const dateFormatter = formatter ?? createTimeZoneFormatter(timeZone);
  let boundaryDateString = dateString;

  for (let skippedDays = 0; skippedDays <= 370; skippedDays += 1) {
    const utcGuess = calendarDate(boundaryDateString).getTime();
    const starts = [];
    for (const offset of candidateOffsets(utcGuess, dateFormatter)) {
      const candidateMs = utcGuess - offset;
      if (
        localDateStringWithFormatter(candidateMs, dateFormatter) !==
        boundaryDateString
      ) {
        continue;
      }
      starts.push(
        findEarliestLocalDateInstant(
          candidateMs,
          boundaryDateString,
          dateFormatter,
        ),
      );
    }
    if (starts.length > 0) return new Date(Math.min(...starts));
    boundaryDateString = shiftCalendarDate(boundaryDateString, 1);
  }

  throw new Error(`Could not resolve a local calendar boundary near ${dateString}.`);
}

export function formatCalendarDate(dateString, options) {
  return new Intl.DateTimeFormat("en-US", {
    ...options,
    timeZone: "UTC",
  }).format(calendarDate(dateString));
}

export function calendarDateParts(dateString, options) {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...options,
    timeZone: "UTC",
  }).formatToParts(calendarDate(dateString));
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}
