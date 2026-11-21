// Run: node --test app/reading.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { addSession, clock, streaks } from "./reading.ts";

const GOAL = 300;
const today = new Date("2026-11-20T15:00");

test("clock formats minutes and hours", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(75.9), "1:15");
  assert.equal(clock(3675), "1:01:15");
});

test("streak survives until today's goal is missed for a whole day", () => {
  const log = { "2026-11-18": 300, "2026-11-19": 900, "2026-11-20": 10 };
  assert.deepEqual(streaks(log, GOAL, today), { current: 2, record: 2 });
  assert.equal(streaks({ ...log, "2026-11-20": 300 }, GOAL, today).current, 3);
});

test("a gap resets the current streak but keeps the record", () => {
  const log = {
    "2026-10-30": 300,
    "2026-10-31": 300,
    "2026-11-01": 300, // crosses a month boundary
    "2026-11-17": 299, // under goal
    "2026-11-20": 300,
  };
  assert.deepEqual(streaks(log, GOAL, today), { current: 1, record: 3 });
  assert.deepEqual(streaks({}, GOAL, today), { current: 0, record: 0 });
});

test("a session crossing midnight is split between the two days", () => {
  const start = new Date("2026-11-20T23:50").getTime();
  const end = new Date("2026-11-21T00:20").getTime();
  assert.deepEqual(addSession({ "2026-11-20": 60 }, start, end), {
    "2026-11-20": 660,
    "2026-11-21": 1200,
  });
  assert.deepEqual(addSession({}, end, end), {});
});
