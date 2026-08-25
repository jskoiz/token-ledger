import assert from "node:assert/strict";
import test from "node:test";

import { dayBounds } from "../bin/token-ledger.mjs";
import {
  durationDayShares,
  multiDayBounds,
} from "../bin/token-ledger-trend.mjs";
import {
  localDateBoundary,
  localDateString,
} from "../lib/token-ledger-calendar.mjs";

function localDate(timestampMs, timeZone) {
  return localDateString(timestampMs, timeZone);
}

function hoursBetween(bounds) {
  return (bounds.end.getTime() - bounds.start.getTime()) / (60 * 60 * 1_000);
}

test("local date boundaries resolve skipped midnights to the first valid instant", () => {
  const cases = [
    ["America/Santiago", "2026-09-06", "2026-09-06T04:00:00.000Z"],
    ["America/Havana", "2026-03-08", "2026-03-08T05:00:00.000Z"],
    ["UTC", "2026-08-01", "2026-08-01T00:00:00.000Z"],
    ["Asia/Kathmandu", "2026-08-01", "2026-07-31T18:15:00.000Z"],
  ];

  for (const [timeZone, dateString, expectedIso] of cases) {
    const boundary = localDateBoundary(dateString, timeZone);
    assert.equal(boundary.toISOString(), expectedIso);
    assert.equal(localDate(boundary.getTime(), timeZone), dateString);
  }
});

test("calendar ranges preserve forward, backward, ordinary, and fractional days", () => {
  const springForward = dayBounds("2026-03-08", "America/New_York");
  assert.equal(localDate(springForward.start.getTime(), springForward.timeZone), "2026-03-08");
  assert.equal(localDate(springForward.end.getTime(), springForward.timeZone), "2026-03-09");
  assert.equal(hoursBetween(springForward), 23);

  const backwardAtMidnight = dayBounds("2026-11-01", "America/Havana");
  assert.equal(backwardAtMidnight.start.toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(hoursBetween(backwardAtMidnight), 25);

  const ordinary = dayBounds("2026-08-01", "UTC");
  assert.equal(hoursBetween(ordinary), 24);

  const fractional = dayBounds("2026-10-04", "Australia/Lord_Howe");
  assert.equal(hoursBetween(fractional), 23.5);

  const trend = multiDayBounds("2026-09-06", "America/Santiago", 1);
  assert.equal(localDate(trend.start.getTime(), trend.timeZone), "2026-09-06");
  assert.equal(localDate(trend.end.getTime(), trend.timeZone), "2026-09-07");
});

test("a completely skipped local date collapses to an empty interval", () => {
  const skippedBoundary = localDateBoundary("2011-12-30", "Pacific/Apia");
  assert.equal(skippedBoundary.toISOString(), "2011-12-30T10:00:00.000Z");
  assert.equal(localDate(skippedBoundary.getTime(), "Pacific/Apia"), "2011-12-31");

  const skippedDay = dayBounds("2011-12-30", "Pacific/Apia");
  assert.equal(skippedDay.start.getTime(), skippedDay.end.getTime());

  const multiDay = multiDayBounds("2011-12-31", "Pacific/Apia", 3);
  assert.equal(localDate(multiDay.start.getTime(), "Pacific/Apia"), "2011-12-29");
  assert.equal(localDate(multiDay.end.getTime(), "Pacific/Apia"), "2012-01-01");
  assert.equal(hoursBetween(multiDay), 48);
});

test("duration shares advance by local calendar boundaries", () => {
  const oneHourAcrossSkippedMidnight = durationDayShares(
    Date.parse("2026-09-06T03:00:00.000Z"),
    Date.parse("2026-09-06T04:00:00.000Z"),
    "America/Santiago",
  );
  assert.deepEqual([...oneHourAcrossSkippedMidnight], [["2026-09-05", 1]]);

  const santiagoShares = durationDayShares(
    localDateBoundary("2026-09-05", "America/Santiago").getTime(),
    localDateBoundary("2026-09-07", "America/Santiago").getTime(),
    "America/Santiago",
  );
  assert.deepEqual([...santiagoShares.keys()], ["2026-09-05", "2026-09-06"]);
  assert.ok(Math.abs(santiagoShares.get("2026-09-05") - 24 / 47) < 1e-12);
  assert.ok(Math.abs(santiagoShares.get("2026-09-06") - 23 / 47) < 1e-12);
  assert.ok(Math.abs([...santiagoShares.values()].reduce((sum, value) => sum + value, 0) - 1) < 1e-12);

  const apiaShares = durationDayShares(
    localDateBoundary("2011-12-29", "Pacific/Apia").getTime(),
    localDateBoundary("2012-01-01", "Pacific/Apia").getTime(),
    "Pacific/Apia",
  );
  assert.deepEqual([...apiaShares.keys()], ["2011-12-29", "2011-12-31"]);
  assert.deepEqual([...apiaShares.values()], [0.5, 0.5]);
});

test("three-digit years keep four-digit calendar date strings", () => {
  const boundary = localDateBoundary("0999-01-02", "UTC");
  assert.equal(boundary.toISOString(), "0999-01-02T00:00:00.000Z");
  assert.equal(localDate(boundary.getTime(), "UTC"), "0999-01-02");

  const day = dayBounds("0999-01-02", "UTC");
  assert.equal(hoursBetween(day), 24);

  const trend = multiDayBounds("0999-01-02", "UTC", 1);
  assert.equal(localDate(trend.start.getTime(), trend.timeZone), "0999-01-02");
});
