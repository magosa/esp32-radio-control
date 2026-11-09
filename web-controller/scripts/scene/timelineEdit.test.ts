import test from "node:test";
import assert from "node:assert/strict";
import { adjustTimeline, checkSequence, reorderSequence, timelineAlignment } from "../../scene/timelineEdit";
import type { Action, SceneMap, Track } from "../../scene/types";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const act = (id: string, position: number, runSeconds: number, extra: Partial<Action> = {}): Action => ({
  id, name: id.toUpperCase(), type: "wait", position, runSeconds, x: 10, y: 10, yaw: 0,
  roomId: "", targetId: `t-${id}`, text: "", state: "meeting", ...extra,
});
const row = (id: string, actions: Action[], locked = false): Track =>
  ({ id, kind: "display", name: id, color: "#123456", muted: false, locked, actions });
const scene = (tracks: Track[]): SceneMap =>
  ({ id: "m", name: "m", editGridMm: 20, doorMode: "story", rooms: [], tracks });

// upstream scene-features: "bulk timeline validation preserves long timed durations ..."
test("checkSequence accepts long timed durations and rejects out-of-range seconds", () => {
  assert.doesNotThrow(() => checkSequence(row("Long", [act("w", 4000.123456, 86400)])));
  assert.throws(() => checkSequence(row("Long", [act("w", 0, 86401)])), /秒数が不正/);
  assert.throws(() => checkSequence(row("Neg", [act("w", -0.5, 1)])), /開始時刻/);
  assert.throws(() => checkSequence(row("Neg", [act("w", 0, -1)])), /秒数が不正/);
  assert.throws(() => checkSequence(row("NaN", [act("w", Number.NaN, 1)])), /不正/);
});

test("checkSequence rejects same-row overlap but allows touching and zero-length bars", () => {
  assert.doesNotThrow(() => checkSequence(row("r", [act("b", 2, 1), act("a", 0, 2), act("z", 3, 0)])));
  assert.throws(() => checkSequence(row("r", [act("a", 0, 2), act("b", 1.5, 1)])), /重なっています/);
});

// upstream scene-features: "batch timeline edits preserve relative starts and reject invalid edits atomically"
test("adjustTimeline shifts and resizes as a group and rejects invalid edits atomically", () => {
  const map = scene([
    row("one", [act("a", 2, 2), act("b", 8, 3)]),
    row("two", [act("c", 4, 2, { type: "move", motion: "rotate", rotationSeconds: 2 })]),
  ]);
  const before = structuredClone(map);
  const shifted = adjustTimeline(map, ["a", "c"], 2);
  assert.equal(shifted.tracks[0].actions[0].position, 4);
  assert.equal(shifted.tracks[1].actions[0].position, 6);
  assert.notEqual(shifted, map);
  const resized = adjustTimeline(map, ["a", "c"], 0, 1);
  assert.equal(resized.tracks[1].actions[0].rotationSeconds, 3);
  assert.equal(resized.tracks[1].actions[0].runSeconds, 3);
  assert.equal(resized.tracks[0].actions[0].runSeconds, 3);
  assert.equal(resized.tracks[0].actions[0].rotationSeconds, undefined);
  assert.throws(() => adjustTimeline(map, ["a"], -3), /不正/);
  assert.throws(() => adjustTimeline(map, ["a"], 5), /重な/);
  assert.throws(() => adjustTimeline(map, ["missing"], 1), /見つか/);
  assert.throws(() => adjustTimeline(map, ["a", "missing"], 1), /見つか/);
  assert.throws(() => adjustTimeline(map, ["a"], 0, -3), /0.1/);
  assert.throws(() => adjustTimeline(map, [], 1), /指定/);
  assert.throws(() => adjustTimeline(map, ["a"], Number.NaN), /指定/);
  assert.deepEqual(map, before);
  const locked = structuredClone(map);
  locked.tracks[1].locked = true;
  assert.throws(() => adjustTimeline(locked, ["a", "c"], 1), /ロック/);
  assert.equal(adjustTimeline(locked, ["a"], 1).tracks[0].actions[0].position, 3);
  assert.deepEqual(map, before);
});

test("adjustTimeline rounds starts to microseconds", () => {
  const map = scene([row("one", [act("a", 0.1, 1)])]);
  assert.equal(adjustTimeline(map, ["a"], 0.2).tracks[0].actions[0].position, 0.3);
});

// upstream scene-features: "sequence reordering changes chronological order without changing duration or gaps"
test("reorderSequence swaps order while keeping durations and the gap", () => {
  const track = row("One", [act("a", 2, 2), act("b", 8, 3)]);
  reorderSequence(track, "b", -1);
  assert.deepEqual(track.actions.map((a) => [a.id, a.position, a.runSeconds]), [["b", 2, 3], ["a", 9, 2]]);
  checkSequence(track);
  reorderSequence(track, "b", 1);
  assert.deepEqual(track.actions.map((a) => [a.id, a.position, a.runSeconds]), [["a", 2, 2], ["b", 8, 3]]);
});

test("reorderSequence rejects locked rows, missing bars and moves past the ends", () => {
  assert.throws(() => reorderSequence(row("r", [act("a", 0, 1), act("b", 1, 1)], true), "a", 1), /ロック/);
  const track = row("r", [act("a", 0, 1), act("b", 1, 1)]);
  assert.throws(() => reorderSequence(track, "missing", 1), /ありません/);
  assert.throws(() => reorderSequence(track, "a", -1), /これ以上/);
  assert.throws(() => reorderSequence(track, "b", 1), /これ以上/);
});

// upstream timed: "timeline alignment uses an eight-screen-pixel radius for either edge at every zoom"
test("timelineAlignment snaps either edge within eight screen pixels at every zoom", () => {
  const moving = act("moving", 2, 2.1), anchor = act("anchor", 8.3, 4.4);
  const other = row("other", [anchor]);
  const map = scene([row("t", [moving]), other]);
  for (const zoom of [12, 26, 60, 100]) for (const target of [8.3, 12.7]) {
    for (const edge of [0, moving.runSeconds]) {
      const desired = target - edge;
      const match = timelineAlignment(map, moving.id, desired + 6 / zoom, moving.runSeconds, zoom);
      assert.ok(match);
      close(match.value, desired);
      close(match.time, target);
      assert.match(match.name, /other \/ ANCHOR/);
    }
    const duration = target - moving.position;
    const match = timelineAlignment(map, moving.id, duration + 6 / zoom, moving.position, zoom,
      { resize: true, min: 0.5, max: 3600 });
    assert.ok(match);
    close(match.value, duration);
    close(match.time, target);
  }
  assert.equal(timelineAlignment(map, moving.id, 8.3 + 9 / 100, moving.runSeconds, 100), null);
  assert.equal(timelineAlignment(map, moving.id, -10, moving.runSeconds, 26), null);
  other.actions = [];
  assert.equal(timelineAlignment(map, moving.id, moving.position, moving.runSeconds, 26), null);
});

test("timelineAlignment ignores candidates outside min..max", () => {
  const map = scene([row("t", [act("moving", 5, 1)]), row("o", [act("anchor", 0.2, 1)])]);
  assert.equal(timelineAlignment(map, "moving", 0.2, 1, 100, { resize: true, min: 0.5, max: 3600 }), null);
  assert.equal(timelineAlignment(map, "moving", 0.2, 1, 100)?.value, 0.2);
});
