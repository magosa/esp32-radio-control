import test from "node:test";
import assert from "node:assert/strict";
import {
  addProblem, addRequest, barStatus, contrastRatio, inkFor, INK_DARK, INK_LIGHT, moveOffset, previewDrop, rangeIds, resizeOffset,
} from "../../scene/timelineDrag";
import { COLORS } from "../../scene/model";
import type { Action, SceneMap, Track, TrackKind } from "../../scene/types";

const act = (id: string, position: number, runSeconds: number, extra: Partial<Action> = {}): Action => ({
  id, name: id.toUpperCase(), type: "wait", position, runSeconds, x: 10, y: 10, yaw: 0,
  roomId: "", targetId: `t-${id}`, text: "", state: "meeting", ...extra,
});
const row = (id: string, actions: Action[], extra: Partial<Track> = {}, kind: TrackKind = "display"): Track =>
  ({ id, kind, name: id, color: "#123456", muted: false, locked: false, actions, ...extra });
const scene = (tracks: Track[]): SceneMap =>
  ({ id: "m", name: "m", editGridMm: 20, doorMode: "story", rooms: [], tracks });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("moveOffset quantizes to 0.1 / 0.5 s and never pushes a bar before 0", () => {
  const a = act("a", 2, 2);
  const map = scene([row("r", [a])]);
  close(moveOffset(map, a, [a], 26 * 1.04, 26, { fine: true, snap: false }).offset, 1);
  close(moveOffset(map, a, [a], 26 * 0.74, 26, { fine: false, snap: false }).offset, 0.5);
  close(moveOffset(map, a, [a], -26 * 9, 26, { fine: true, snap: false }).offset, -2);
});

test("moveOffset keeps a group together: the earliest bar bounds the left move, the latest bounds the right", () => {
  const a = act("a", 1, 1), b = act("b", 5, 1), c = act("c", 3400, 1);
  const map = scene([row("r1", [a, b]), row("r2", [c])]);
  close(moveOffset(map, b, [a, b], -26 * 4.9, 26, { fine: true, snap: false }).offset, -1);
  close(moveOffset(map, a, [a, b, c], 26 * 500, 26, { fine: true, snap: false }).offset, 100);
});

test("moveOffset snaps to another bar's edge only when asked, and reports its name", () => {
  const a = act("a", 0, 2), other = act("o", 5, 2);
  const map = scene([row("r", [a]), row("q", [other])]);
  const plain = moveOffset(map, a, [a], 26 * 4.9, 26, { fine: true, snap: false });
  close(plain.offset, 4.9);
  assert.equal(plain.match, null);
  const snapped = moveOffset(map, a, [a], 26 * 4.9, 26, { fine: true, snap: true });
  close(snapped.offset, 5);
  assert.equal(snapped.match?.name, "q / O");
  close(snapped.match?.time ?? -1, 5);
});

test("moveOffset ignores the other selected bars when snapping, so a group never snaps to itself", () => {
  const a = act("a", 0, 2), b = act("b", 5, 2);
  const map = scene([row("r", [a]), row("q", [b])]);
  const result = moveOffset(map, a, [a, b], 26 * 4.9, 26, { fine: true, snap: true });
  assert.equal(result.match, null);
  close(result.offset, 4.9);
});

test("resizeOffset clamps to 0.5..3600 s and snaps the end to another bar", () => {
  const a = act("a", 0, 2), other = act("o", 5, 2);
  const map = scene([row("r", [a]), row("q", [other])]);
  close(resizeOffset(map, a, 26 * 1.04, 26, { fine: true, snap: false }).offset, 1);
  close(resizeOffset(map, a, -26 * 5, 26, { fine: true, snap: false }).offset, -1.5);
  close(resizeOffset(map, a, 26 * 5000, 26, { fine: true, snap: false }).offset, 3598);
  const snapped = resizeOffset(map, a, 26 * 2.9, 26, { fine: true, snap: true });
  close(snapped.offset, 3);
  assert.equal(snapped.match?.name, "q / O");
});

test("rangeIds takes the bars between two clicks in start order, in either direction", () => {
  const track = row("r", [act("c", 6, 1), act("a", 0, 1), act("b", 3, 1)]);
  assert.deepEqual(rangeIds(track, "a", "c"), ["a", "b", "c"]);
  assert.deepEqual(rangeIds(track, "c", "b"), ["b", "c"]);
  assert.deepEqual(rangeIds(track, "a", "a"), ["a"]);
  assert.deepEqual(rangeIds(track, "missing", "b"), ["b"]);
});

test("addRequest picks move for robots and people, event-start for rooms, show for displays; the time is snapped", () => {
  assert.equal(addRequest(row("r", [], {}, "robot"), 3.04, true).type, "move");
  assert.equal(addRequest(row("h", [], {}, "human"), 3, true).type, "move");
  assert.equal(addRequest(row("o", [], {}, "room"), 3, true).type, "event-start");
  assert.equal(addRequest(row("d", [], {}, "display"), 3, true).type, "show");
  close(addRequest(row("d", [], {}, "display"), 3.04, true).overrides.position, 3);
  close(addRequest(row("d", [], {}, "display"), 3.3, false).overrides.position, 3.5);
  assert.equal(addRequest(row("d", [], {}, "display"), -4, true).overrides.position, 0);
  assert.equal(addRequest(row("d", [], {}, "display"), 1, true, "wait").type, "wait");
});

test("addProblem refuses locked rows and types the row kind does not allow", () => {
  assert.match(addProblem(row("r", [], { locked: true }, "robot"), "move"), /ロックされています/);
  assert.match(addProblem(row("d", [], {}, "display"), "move"), /配置できません/);
  assert.equal(addProblem(row("d", [], {}, "display"), "show"), "");
});

test("previewDrop reports the default length, and refuses overlap, locked rows and the wrong type", () => {
  const map = scene([row("d", [act("a", 2, 4)]), row("l", [], { locked: true })]);
  const ok = previewDrop(map, "d", "show", 8);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.runSeconds > 0, true);
  const overlap = previewDrop(map, "d", "show", 3);
  assert.equal(overlap.ok, false);
  assert.match(overlap.ok ? "" : overlap.reason, /重なっています/);
  const locked = previewDrop(map, "l", "show", 0);
  assert.match(locked.ok ? "" : locked.reason, /ロック/);
  const wrong = previewDrop(map, "d", "move", 20);
  assert.equal(wrong.ok, false);
  assert.equal(map.tracks[0].actions.length, 1, "the dry run does not touch the map");
});

test("inkFor picks the readable ink: at least 4.5:1 for every track colour and for extreme colours", () => {
  for (const color of [...COLORS, "#000000", "#ffffff", "#777777", "#808080", "#ff0000", "#00ff00", "#0000ff", "#ffff00"]) {
    const ink = inkFor(color);
    assert.ok(ink === INK_LIGHT || ink === INK_DARK);
    assert.ok(contrastRatio(color, ink) >= 4.5, `${color} with ${ink}: ${contrastRatio(color, ink)}`);
  }
  assert.equal(inkFor("#ffffff"), INK_DARK);
  assert.equal(inkFor("#000000"), INK_LIGHT);
  assert.equal(inkFor("not-a-colour"), INK_DARK);
});

const planned = (status: "blocked" | "waiting" | "running" | "complete" | "failed", start: number | null, end: number | null) => ({ status, start, end });

test("barStatus follows the clock for a healthy action", () => {
  const state = planned("complete", 2, 6);
  assert.equal(barStatus(state, 0), "waiting");
  assert.equal(barStatus(state, 1.99), "waiting");
  assert.equal(barStatus(state, 2), "running");
  assert.equal(barStatus(state, 5.99), "running");
  assert.equal(barStatus(state, 6), "complete");
  assert.equal(barStatus(state, 100), "complete");
});

test("barStatus shows a blocked action as blocked at every time, even before it starts", () => {
  const state = planned("blocked", null, null);
  for (const time of [0, 3, 100]) assert.equal(barStatus(state, time), "blocked");
});

test("barStatus shows an action the plan expects to fail as failed before, during and after it", () => {
  const state = planned("failed", 17, 18);
  for (const time of [0, 16.9, 17, 17.5, 18, 100]) assert.equal(barStatus(state, time), "failed", `at ${time}`);
});

test("barStatus without a plan entry is waiting", () => {
  assert.equal(barStatus(undefined, 5), "waiting");
});

test("barStatus with a missing start is waiting for a healthy action and does not throw", () => {
  assert.equal(barStatus(planned("complete", null, null), 5), "waiting");
  assert.equal(barStatus(planned("running", 2, null), 5), "complete");
});