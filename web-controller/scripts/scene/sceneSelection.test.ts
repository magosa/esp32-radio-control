import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SELECTION, pruneSelection, type SceneSelection } from "../../scene/sceneSelection";
import type { Action, SceneMap, Track } from "../../scene/types";

const action = (id: string): Action => ({
  id, name: id, type: "wait", position: 0, runSeconds: 1, x: 0, y: 0, yaw: 0, roomId: "", targetId: id, text: "", state: "meeting",
});
const track = (id: string, actions: string[]): Track => ({
  id, kind: "human", name: id, color: "#ffffff", muted: false, locked: false, count: 1, actions: actions.map(action),
});
const map = (): SceneMap => ({
  id: "m", name: "m", editGridMm: 20, doorMode: "story",
  rooms: [{ id: "r1", name: "r1", color: "#ffffff", kind: "room", material: "tile", cells: [0] }],
  tracks: [track("t1", ["a1", "a2"]), track("t2", ["b1"])],
});
const sel = (over: Partial<SceneSelection>): SceneSelection => ({ ...EMPTY_SELECTION, ...over });

test("a selection that is still valid is returned unchanged (same reference)", () => {
  const current = sel({ trackId: "t1", actionId: "a1", blocks: ["a1", "a2"], roomId: "r1" });
  assert.equal(pruneSelection(current, map()), current);
  assert.equal(pruneSelection(EMPTY_SELECTION, map()), EMPTY_SELECTION);
});

test("a deleted track clears the track, its action and its blocks", () => {
  const m = map();
  m.tracks = m.tracks.filter((item) => item.id !== "t1");
  const out = pruneSelection(sel({ trackId: "t1", actionId: "a1", blocks: ["a1", "a2"] }), m);
  assert.deepEqual(out, EMPTY_SELECTION);
});

test("a deleted action keeps the track but drops the action and the missing blocks", () => {
  const m = map();
  m.tracks[0].actions = m.tracks[0].actions.filter((item) => item.id !== "a1");
  const out = pruneSelection(sel({ trackId: "t1", actionId: "a1", blocks: ["a1", "a2", "b1"] }), m);
  assert.deepEqual(out, sel({ trackId: "t1", actionId: null, blocks: ["a2", "b1"] }));
});

test("blocks from other tracks survive as long as they exist; an action moved to a different track selects that track", () => {
  const out = pruneSelection(sel({ trackId: "t1", actionId: "b1", blocks: ["b1"] }), map());
  assert.deepEqual(out, sel({ trackId: "t2", actionId: "b1", blocks: ["b1"] }));
});

test("a deleted region clears the region", () => {
  const m = map();
  m.rooms = [];
  assert.deepEqual(pruneSelection(sel({ roomId: "r1", trackId: "t2" }), m), sel({ trackId: "t2" }));
});

test("an action id that is no longer in blocks is added back so the two stay consistent", () => {
  const out = pruneSelection(sel({ trackId: "t1", actionId: "a1", blocks: [] }), map());
  assert.deepEqual(out.blocks, ["a1"]);
});

test("input selection is not mutated", () => {
  const current = sel({ trackId: "t1", actionId: "zzz", blocks: ["zzz", "a1"] });
  const before = structuredClone(current);
  pruneSelection(current, map());
  assert.deepEqual(current, before);
});
