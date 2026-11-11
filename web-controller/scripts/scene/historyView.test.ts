import test from "node:test";
import assert from "node:assert/strict";
import { formatTimestamp, restoredLabel, sortNewestFirst } from "../../scene/historyView";

const rec = (revision: number) => ({ revision });

test("sortNewestFirst handles empty and unsorted input without mutating", () => {
  assert.deepEqual(sortNewestFirst([]), []);
  const input = [rec(2), rec(5), rec(1)];
  assert.deepEqual(sortNewestFirst(input).map((r) => r.revision), [5, 2, 1]);
  assert.deepEqual(input.map((r) => r.revision), [2, 5, 1]);
});

test("formatTimestamp uses local time as YYYY/MM/DD HH:mm", () => {
  const date = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(formatTimestamp(date.toISOString()), "2026/01/02 03:04");
});

test("formatTimestamp returns the raw string when invalid", () => {
  assert.equal(formatTimestamp("not a date"), "not a date");
  assert.equal(formatTimestamp(""), "");
});

test("restoredLabel", () => {
  assert.equal(restoredLabel(null), "");
  assert.equal(restoredLabel(undefined), "");
  assert.equal(restoredLabel(3), "#3 から復元");
});
