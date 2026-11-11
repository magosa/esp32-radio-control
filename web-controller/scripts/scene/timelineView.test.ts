import test from "node:test";
import assert from "node:assert/strict";
import {
  LANE_PAD_PX, MAX_HORIZON_S, MIN_HORIZON_S, PX_DEFAULT, PX_MAX, PX_MIN,
  barBox, fitPx, formatTime, pxToTime, quantize, rulerTicks, timeToPx, timelineHorizon,
} from "../../scene/timelineView";
import type { Action, SceneMap, Track } from "../../scene/types";

const action = (id: string, position: number, runSeconds: number): Action => ({
  id, name: id, type: "wait", position, runSeconds, x: 0, y: 0, yaw: 0,
  roomId: "", targetId: "", text: "", state: "meeting",
});
const track = (id: string, actions: Action[]): Track => ({
  id, kind: "human", name: id, color: "#112233", muted: false, locked: false, actions,
});
const mapOf = (tracks: Track[]): SceneMap => ({
  id: "m", name: "M", editGridMm: 20, doorMode: "story", rooms: [], tracks,
});

test("constants match the plan", () => {
  assert.equal(MIN_HORIZON_S, 30);
  assert.equal(MAX_HORIZON_S, 7200);
  assert.equal(PX_MIN, 10);
  assert.equal(PX_MAX, 120);
  assert.equal(PX_DEFAULT, 26);
  assert.equal(LANE_PAD_PX, 16);
});

test("timelineHorizon: empty map is 30 seconds", () => {
  assert.equal(timelineHorizon(mapOf([]), 0), 30);
});

test("timelineHorizon: last bar end + 4 wins once it exceeds 30", () => {
  assert.equal(timelineHorizon(mapOf([track("a", [action("x", 20, 6)])]), 0), 30);
  assert.equal(timelineHorizon(mapOf([track("a", [action("x", 20, 6.5)])]), 0), 30.5);
  const m = mapOf([track("a", [action("x", 10, 5)]), track("b", [action("y", 50, 10)])]);
  assert.equal(timelineHorizon(m, 0), 64);
});

test("timelineHorizon: plan duration + 8 wins, capped at 3600", () => {
  assert.equal(timelineHorizon(mapOf([]), 40), 48);
  assert.equal(timelineHorizon(mapOf([]), 22), 30);
  assert.equal(timelineHorizon(mapOf([]), 10000), 3600);
  assert.equal(timelineHorizon(mapOf([]), Infinity), 3600);
  assert.equal(timelineHorizon(mapOf([]), NaN), 30);
});

test("timelineHorizon: capped at 7200", () => {
  assert.equal(timelineHorizon(mapOf([track("a", [action("x", 9000, 5)])]), 0), 7200);
  assert.equal(timelineHorizon(mapOf([track("a", [action("x", 7195, 1)])]), 0), 7200);
  assert.equal(timelineHorizon(mapOf([track("a", [action("x", 7190, 1)])]), 0), 7195);
});

test("rulerTicks: 2 second steps at 40px, starting at 0", () => {
  const ticks = rulerTicks(10, 40);
  assert.deepEqual(ticks.map((t) => t.time), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(ticks[0], { time: 0, left: 16, label: "0s" });
  assert.deepEqual(ticks[2], { time: 4, left: 4 * 40 + 16, label: "4s" });
});

test("rulerTicks: the default 26px zoom uses 5 second steps", () => {
  const ticks = rulerTicks(10, 26);
  assert.deepEqual(ticks.map((t) => t.time), [0, 5, 10]);
  assert.deepEqual(ticks[1], { time: 5, left: 5 * 26 + 16, label: "5s" });
});

test("rulerTicks: 5 second steps below 30px, 2 seconds at 30px", () => {
  assert.deepEqual(rulerTicks(20, 20).map((t) => t.time), [0, 5, 10, 15, 20]);
  assert.deepEqual(rulerTicks(20, 29.9).map((t) => t.time), [0, 5, 10, 15, 20]);
  assert.deepEqual(rulerTicks(6, 30).map((t) => t.time), [0, 2, 4, 6]);
});

test("rulerTicks: does not exceed the horizon", () => {
  assert.deepEqual(rulerTicks(9, 40).map((t) => t.time), [0, 2, 4, 6, 8]);
  assert.deepEqual(rulerTicks(9, 26).map((t) => t.time), [0, 5]);
  assert.deepEqual(rulerTicks(0, 26).map((t) => t.time), [0]);
});

test("quantize fine rounds to 0.1 without float noise", () => {
  assert.equal(quantize(0.04, true), 0);
  assert.equal(quantize(0.05, true), 0.1);
  assert.equal(quantize(0.3, true), 0.3);
  assert.equal(quantize(0.1 + 0.2, true), 0.3);
  assert.equal(quantize(1.26, true), 1.3);
  assert.equal(quantize(2.74, true), 2.7);
});

test("quantize coarse rounds to 0.5", () => {
  assert.equal(quantize(0.24, false), 0);
  assert.equal(quantize(0.25, false), 0.5);
  assert.equal(quantize(0.74, false), 0.5);
  assert.equal(quantize(0.76, false), 1);
  assert.equal(quantize(3.2, false), 3);
});

test("quantize clamps negatives and non-finite values to 0", () => {
  assert.equal(quantize(-0.3, true), 0);
  assert.equal(quantize(-2, false), 0);
  assert.equal(quantize(NaN, true), 0);
  assert.ok(Object.is(quantize(-0.01, true), 0));
});

test("barBox places the bar at position*px + 16 with width runSeconds*px", () => {
  assert.deepEqual(barBox(action("a", 2, 5), 26), { left: 2 * 26 + 16, width: 5 * 26 });
  assert.deepEqual(barBox(action("a", 0, 10), 10), { left: 16, width: 100 });
});

test("barBox keeps a minimum width", () => {
  assert.equal(barBox(action("a", 1, 0), 26).width, 12);
  assert.equal(barBox(action("a", 1, 0.1), 10).width, 12);
  assert.equal(barBox(action("a", 1, 1), 10).width, 12);
  assert.equal(barBox(action("a", 1, 2), 10).width, 20);
});

test("timeToPx and pxToTime round-trip", () => {
  assert.equal(timeToPx(0, 26), 16);
  assert.equal(timeToPx(3, 26), 94);
  for (const px of [10, 26, 120]) for (const t of [0, 0.1, 7.5, 123.4]) {
    assert.ok(Math.abs(pxToTime(timeToPx(t, px), px) - t) < 1e-9);
  }
  assert.equal(pxToTime(94, 26), 3);
  assert.equal(barBox(action("a", 4.5, 2), 40).left, timeToPx(4.5, 40));
});

test("fitPx fits the horizon into the viewport and clamps to the zoom range", () => {
  assert.equal(fitPx(180 + 30 * 20, 30), 20);
  assert.equal(fitPx(200, 30), PX_MIN);
  assert.equal(fitPx(100000, 30), PX_MAX);
  assert.equal(fitPx(1000, 0), PX_DEFAULT);
  assert.equal(fitPx(NaN, 30), PX_DEFAULT);
});

test("formatTime uses m:ss.s with carry on rounding", () => {
  assert.equal(formatTime(0), "0:00.0");
  assert.equal(formatTime(59.96), "1:00.0");
  assert.equal(formatTime(59.94), "0:59.9");
  assert.equal(formatTime(125.04), "2:05.0");
  assert.equal(formatTime(3599.96), "60:00.0");
  assert.equal(formatTime(61.25), "1:01.3");
});

test("formatTime treats negative and non-finite values as 0", () => {
  assert.equal(formatTime(-5), "0:00.0");
  assert.equal(formatTime(NaN), "0:00.0");
  assert.equal(formatTime(Infinity), "0:00.0");
});

test("view helpers do not mutate their input", () => {
  const m = mapOf([track("a", [action("x", 3, 4)])]);
  const snapshot = JSON.stringify(m);
  timelineHorizon(m, 12);
  assert.equal(JSON.stringify(m), snapshot);
  const a = action("x", 3, 4);
  const aSnap = JSON.stringify(a);
  barBox(a, 26);
  assert.equal(JSON.stringify(a), aSnap);
});
