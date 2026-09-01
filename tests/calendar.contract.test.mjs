import assert from "node:assert/strict";
import test from "node:test";

import { dayBounds } from "../bin/token-ledger.mjs";
import { durationDayShares } from "../bin/token-ledger-trend.mjs";
import {
  localDateBoundary,
  localDateString,
} from "../lib/token-ledger-calendar.mjs";

const HOUR_MS = 60 * 60 * 1_000;

function hoursBetween(bounds) {
  return (bounds.end.getTime() - bounds.start.getTime()) / HOUR_MS;
}

test("day boundaries cover ordinary and daylight-saving calendar days", () => {
  const cases = [
    {
      name: "ordinary UTC day",
      date: "2026-08-01",
      timeZone: "UTC",
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-02T00:00:00.000Z",
      endDate: "2026-08-02",
      hours: 24,
    },
    {
      name: "spring-forward day",
      date: "2026-03-08",
      timeZone: "America/New_York",
      start: "2026-03-08T05:00:00.000Z",
      end: "2026-03-09T04:00:00.000Z",
      endDate: "2026-03-09",
      hours: 23,
    },
    {
      name: "fall-back day",
      date: "2026-11-01",
      timeZone: "America/Havana",
      start: "2026-11-01T04:00:00.000Z",
      end: "2026-11-02T05:00:00.000Z",
      endDate: "2026-11-02",
      hours: 25,
    },
  ];

  for (const testCase of cases) {
    const bounds = dayBounds(testCase.date, testCase.timeZone);
    assert.equal(bounds.start.toISOString(), testCase.start, testCase.name);
    assert.equal(bounds.end.toISOString(), testCase.end, testCase.name);
    assert.equal(hoursBetween(bounds), testCase.hours, testCase.name);
    assert.equal(
      localDateString(bounds.start.getTime(), testCase.timeZone),
      testCase.date,
      testCase.name,
    );
    assert.equal(
      localDateString(bounds.end.getTime(), testCase.timeZone),
      testCase.endDate,
      testCase.name,
    );
  }
});

test("a completely skipped local date is an empty boundary interval", () => {
  const timeZone = "Pacific/Apia";
  const date = "2011-12-30";
  const boundary = localDateBoundary(date, timeZone);
  const bounds = dayBounds(date, timeZone);

  assert.equal(boundary.toISOString(), "2011-12-30T10:00:00.000Z");
  assert.equal(localDateString(boundary.getTime(), timeZone), "2011-12-31");
  assert.equal(bounds.start.getTime(), bounds.end.getTime());

  const shares = durationDayShares(
    localDateBoundary("2011-12-29", timeZone).getTime(),
    localDateBoundary("2012-01-01", timeZone).getTime(),
    timeZone,
  );
  assert.deepEqual([...shares.keys()], ["2011-12-29", "2011-12-31"]);
  assert.deepEqual([...shares.values()], [0.5, 0.5]);
});
