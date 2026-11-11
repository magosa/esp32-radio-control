import test from "node:test";
import assert from "node:assert/strict";
import { cellIndex } from "../../scene/grid";
import { COLORS, KINDS, newAction, newTrack, validateProject } from "../../scene/model";
import { addDoorAt } from "../../scene/mapEditFixtures";
import { createSafety, pathProblem } from "../../scene/safety";
import {
  MAX_TRACKS, actionTypeLabel, addActionToTrack, addTrack, deleteActions, deleteTrack, duplicateAction,
  moveTrack, moveTrackBy, replaceAction, replaceTrack, setInitialPose, setTrackFlag, trackKindLabel, updateTrack,
} from "../../scene/trackEdit";
import { SCENE_SCHEMA, type Action, type ActionType, type Room, type SceneMap, type Track, type TrackKind } from "../../scene/types";
import { CELL_MM } from "../../scene/units";

let counter = 0;
const mk = () => `n${++counter}`;
const rect = (x: number, y: number, width: number, height: number) =>
  Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, col) => cellIndex(x + col, y + row))).flat();
const room = (id: string, cells: number[], kind: Room["kind"] = "room"): Room =>
  ({ id, name: id, cells, kind, color: "#739a81", material: "concrete" });
// One room covering the whole 55 x 31 area.
const base = (cells = rect(0, 0, 55, 31)): SceneMap => ({
  id: "map", name: "Plan", editGridMm: 20, doorMode: "story", rooms: [room("floor", cells)], tracks: [],
  floorPlan: { walls: [], doors: [], furniture: [] },
});
const valid = (map: SceneMap) => validateProject({ schema: SCENE_SCHEMA, name: "p", maps: [map] });
// Runs the call and proves the input was left untouched; returns the call's result.
const pure = <T>(map: SceneMap, call: () => T): T => {
  const before = structuredClone(map);
  try {
    return call();
  } finally {
    assert.deepEqual(map, before);
  }
};
const rejects = (map: SceneMap, call: () => unknown, message?: RegExp) =>
  pure(map, () => assert.throws(call, (error: Error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, message ?? /[^\x00-\x7f]/);
    return true;
  }));
const build = (...kinds: TrackKind[]) => {
  let map = base();
  const trackIds: string[] = [];
  for (const kind of kinds) {
    const added = addTrack(map, kind, {}, mk);
    map = added.map;
    trackIds.push(added.trackId);
  }
  return { map, trackIds };
};
const track = (map: SceneMap, id: string): Track => map.tracks.find((t) => t.id === id)!;
const lock = (map: SceneMap, id: string) => setTrackFlag(map, id, "locked", true);
const withAction = (map: SceneMap, trackId: string, type: ActionType, overrides: Partial<Action> = {}) =>
  addActionToTrack(map, trackId, type, overrides, mk);
const names = (map: SceneMap) => map.tracks.map((t) => t.name);

test("addTrack names, colors and defaults follow the track kind", () => {
  const empty = base();
  const robot = pure(empty, () => addTrack(empty, "robot", {}, mk));
  assert.equal(robot.map.tracks.length, 1);
  assert.equal(robot.map.tracks[0].id, robot.trackId);
  assert.equal(robot.map.tracks[0].name, "ロボット 1");
  assert.equal(robot.map.tracks[0].color, COLORS[0]);
  const second = addTrack(robot.map, "robot", {}, mk);
  assert.equal(track(second.map, second.trackId).name, "ロボット 2");
  assert.equal(track(second.map, second.trackId).color, COLORS[1]);
  const human = addTrack(second.map, "human", {}, mk);
  assert.equal(track(human.map, human.trackId).name, "人 1");
  assert.equal(track(human.map, human.trackId).count, 1);
  assert.ok(track(human.map, human.trackId).initial);
  const room1 = addTrack(human.map, "room", {}, mk);
  assert.equal(track(room1.map, room1.trackId).roomId, "floor");
  assert.equal(track(room1.map, room1.trackId).initial, undefined);
  const display = addTrack(room1.map, "display", {}, mk);
  assert.equal(track(display.map, display.trackId).name, "画面表示 1");
  assert.equal(track(display.map, display.trackId).initial, undefined);
  assert.equal(display.map.tracks.length, 5);
  valid(display.map);
});

test("addTrack inserts at the requested index and rejects an invalid index", () => {
  const { map } = build("robot", "display");
  const first = pure(map, () => addTrack(map, "human", { index: 0 }, mk));
  assert.equal(first.map.tracks[0].id, first.trackId);
  const middle = addTrack(map, "human", { index: 1 }, mk);
  assert.equal(middle.map.tracks[1].id, middle.trackId);
  const end = addTrack(map, "human", { index: 2 }, mk);
  assert.equal(end.map.tracks[2].id, end.trackId);
  for (const index of [-1, 3, 0.5, Number.NaN]) rejects(map, () => addTrack(map, "human", { index }, mk), /挿入位置/);
});

test("addTrack accepts 128 tracks and rejects the 129th", () => {
  let map = base();
  for (let i = 0; i < MAX_TRACKS; i++) map = addTrack(map, "display", {}, mk).map;
  assert.equal(map.tracks.length, 128);
  rejects(map, () => addTrack(map, "display", {}, mk), /トラックは最大128本です。/);
  rejects(map, () => addTrack(map, "room", {}, mk), /トラックは最大128本です。/);
});

test("a room track needs a region; roomId must resolve", () => {
  rejects(base(), () => addTrack(base(), "bogus" as TrackKind, {}, mk), /種類/);
  const none = { ...base(), rooms: [] } as SceneMap;
  rejects(none, () => addTrack(none, "room", {}, mk), /先にマップ編集で部屋・廊下を作成してください。/);
  const two: SceneMap = { ...base(rect(0, 0, 10, 10)), rooms: [room("a", rect(0, 0, 10, 10)), room("b", rect(12, 0, 10, 10))] };
  const added = pure(two, () => addTrack(two, "room", { roomId: "b" }, mk));
  assert.equal(track(added.map, added.trackId).roomId, "b");
  assert.equal(track(addTrack(two, "room", {}, mk).map, "n" + counter).roomId, "a");
  rejects(two, () => addTrack(two, "room", { roomId: "nope" }, mk), /部屋/);
});

test("initial positions land on the first free cell, clear of walls and of other actors", () => {
  const { map: one } = build("robot");
  // Cells nearer than the robot radius (60mm) to the area edge are not usable.
  assert.deepEqual(track(one, one.tracks[0].id).initial, { x: 70, y: 70, yaw: 0, roomId: "floor" });
  const human = build("human");
  assert.deepEqual(human.map.tracks[0].initial, { x: 30, y: 30, yaw: 0, roomId: "floor" });
  // robot-robot clearance 60 + 60 + 5 = 125.
  const robots = build("robot", "robot");
  assert.deepEqual(robots.map.tracks[1].initial, { x: 210, y: 70, yaw: 0, roomId: "floor" });
  // robot then human: 60 + 14 + 5 = 79.
  const robotHuman = build("robot", "human");
  assert.deepEqual(robotHuman.map.tracks[1].initial, { x: 150, y: 30, yaw: 0, roomId: "floor" });
  // human then robot.
  const humanRobot = build("human", "robot");
  assert.deepEqual(humanRobot.map.tracks[1].initial, { x: 110, y: 70, yaw: 0, roomId: "floor" });
  // human then human: 14 + 14 + 5 = 33.
  const humans = build("human", "human");
  assert.deepEqual(humans.map.tracks[1].initial, { x: 70, y: 30, yaw: 0, roomId: "floor" });
});

test("the clearance between initial positions is inclusive (>= radius sum + 5mm)", () => {
  const { map, trackIds } = build("robot");
  for (const [x, expected] of [[65, 190], [66, 210]] as const) {
    const moved = setInitialPose(map, trackIds[0], { x, y: 70, yaw: 0, roomId: "floor" });
    const added = addTrack(moved, "robot", {}, mk);
    assert.deepEqual(track(added.map, added.trackId).initial, { x: expected, y: 70, yaw: 0, roomId: "floor" });
  }
});

test("initial positions skip furniture and unassigned cells, and fail when nothing is free", () => {
  const map = base();
  map.floorPlan!.furniture.push({ id: "desk", roomId: "floor", cell: cellIndex(3, 3), type: "desk", rotation: 0 });
  const added = pure(map, () => addTrack(map, "robot", {}, mk));
  const { x, y, roomId } = track(added.map, added.trackId).initial!;
  assert.notDeepEqual({ x, y }, { x: 70, y: 70 });
  assert.equal(roomId, "floor");
  const safety = createSafety(map);
  assert.notEqual(pathProblem(safety, { x: 70, y: 70 }, { x: 70, y: 70 }), "");
  assert.equal(pathProblem(safety, { x, y }, { x, y }), "");
  // Every earlier cell (in index order) is unusable.
  for (let cell = 0; cell < Math.floor(y / CELL_MM) * 55 + Math.floor(x / CELL_MM); cell++) {
    const p = { x: (cell % 55) * CELL_MM + 10, y: Math.floor(cell / 55) * CELL_MM + 10 };
    assert.notEqual(pathProblem(safety, p, p), "", `cell ${cell} should be unusable`);
  }
  const tiny = base(rect(0, 0, 3, 3));
  rejects(tiny, () => addTrack(tiny, "robot", {}, mk), /初期位置を配置できる空きがありません。先にマップ編集で部屋・廊下を広げてください。/);
  const noRooms = { ...base(), rooms: [] } as SceneMap;
  rejects(noRooms, () => addTrack(noRooms, "human", {}, mk), /空きがありません/);
});

test("moveTrack and moveTrackBy reorder and agree with each other", () => {
  const { map, trackIds: [a, b, c, d] } = build("robot", "robot", "display", "human");
  const moved = pure(map, () => moveTrack(map, a, 2));
  assert.deepEqual(moved.tracks.map((t) => t.id), [b, c, a, d]);
  assert.deepEqual(moveTrack(map, d, 0).tracks.map((t) => t.id), [d, a, b, c]);
  assert.deepEqual(moveTrack(map, b, 1).tracks.map((t) => t.id), [a, b, c, d]);
  for (const id of [a, b, c, d]) {
    const index = map.tracks.findIndex((t) => t.id === id);
    for (const step of [-1, 1] as const) {
      const to = index + step;
      if (to < 0 || to >= 4) continue;
      assert.deepEqual(moveTrackBy(map, id, step), moveTrack(map, id, to));
    }
  }
  assert.deepEqual(moveTrackBy(map, b, 1).tracks.map((t) => t.id), [a, c, b, d]);
  assert.deepEqual(moveTrackBy(map, b, -1).tracks.map((t) => t.id), [b, a, c, d]);
});

test("moveTrack rejects ends, bad indices and unknown tracks", () => {
  const { map, trackIds: [a, , , d] } = build("robot", "robot", "display", "human");
  rejects(map, () => moveTrackBy(map, a, -1), /これ以上移動できません。/);
  rejects(map, () => moveTrackBy(map, d, 1), /これ以上移動できません。/);
  for (const to of [-1, 4, 1.5, Number.NaN]) rejects(map, () => moveTrack(map, a, to), /これ以上移動できません。/);
  rejects(map, () => moveTrack(map, "nope", 1), /見つかりません/);
  rejects(map, () => moveTrackBy(map, "nope", 1), /見つかりません/);
});

test("locked rows cannot be moved, be swapped with, or be shifted by a move", () => {
  const { map, trackIds: [a, b, c, d] } = build("robot", "robot", "display", "human");
  const lockedA = lock(map, a);
  rejects(lockedA, () => moveTrack(lockedA, a, 1), /ロック/);
  rejects(lockedA, () => moveTrackBy(lockedA, a, 1), /ロック/);
  rejects(lockedA, () => moveTrack(lockedA, a, 0), /ロック/);
  // The destination row is locked.
  rejects(lockedA, () => moveTrackBy(lockedA, b, -1), /ロック/);
  rejects(lockedA, () => moveTrack(lockedA, c, 0), /ロック/);
  // A row between the source and the destination would be shifted.
  const lockedB = lock(map, b);
  rejects(lockedB, () => moveTrack(lockedB, a, 2), /ロック/);
  rejects(lockedB, () => moveTrack(lockedB, d, 0), /ロック/);
  // A locked row outside the span is untouched, so the move works.
  assert.deepEqual(moveTrack(lockedA, d, 1).tracks.map((t) => t.id), [a, d, b, c]);
  assert.deepEqual(moveTrackBy(lockedB, c, 1).tracks.map((t) => t.id), [a, b, d, c]);
});

test("setTrackFlag toggles muted and locked, even on a locked row", () => {
  const { map, trackIds: [a] } = build("robot");
  const muted = pure(map, () => setTrackFlag(map, a, "muted", true));
  assert.equal(track(muted, a).muted, true);
  assert.equal(track(muted, a).locked, false);
  const locked = setTrackFlag(map, a, "locked", true);
  assert.equal(track(locked, a).locked, true);
  assert.equal(track(locked, a).muted, false);
  assert.equal(track(setTrackFlag(locked, a, "muted", true), a).muted, true);
  const unlocked = setTrackFlag(locked, a, "locked", false);
  assert.equal(track(unlocked, a).locked, false);
  assert.equal(track(setTrackFlag(muted, a, "muted", false), a).muted, false);
  rejects(map, () => setTrackFlag(map, "nope", "muted", true), /見つかりません/);
  rejects(map, () => setTrackFlag(map, a, "kind" as "muted", true), /[^\x00-\x7f]/);
  rejects(map, () => setTrackFlag(map, a, "muted", "yes" as unknown as boolean), /[^\x00-\x7f]/);
});

test("updateTrack applies valid attributes", () => {
  const { map, trackIds: [robot, human, roomTrack] } = build("robot", "human", "room");
  const updated = pure(map, () => updateTrack(map, robot, { name: "A".repeat(120), color: "#AbCdEf", robotRole: "security", robotId: "7" }));
  assert.equal(track(updated, robot).name, "A".repeat(120));
  assert.equal(track(updated, robot).color, "#AbCdEf");
  assert.equal(track(updated, robot).robotRole, "security");
  assert.equal(track(updated, robot).robotId, "7");
  // Setting its own id again is not a duplicate.
  assert.equal(track(updateTrack(updated, robot, { robotId: "7" }), robot).robotId, "7");
  assert.equal(track(updateTrack(map, human, { count: 1 }), human).count, 1);
  assert.equal(track(updateTrack(map, human, { count: 1000 }), human).count, 1000);
  assert.equal(track(updateTrack(map, human, { name: "x" }), human).name, "x");
  // An undefined field means "unchanged".
  const partial = updateTrack(map, human, { name: undefined, count: 3 });
  assert.equal(track(partial, human).name, track(map, human).name);
  assert.equal(track(partial, human).count, 3);
  assert.equal(track(updateTrack(map, roomTrack, { roomId: "floor" }), roomTrack).roomId, "floor");
  valid(updated);
});

test("updateTrack rejects invalid names, colors, counts and ids with specific messages", () => {
  const { map, trackIds: [r1, r2, human, roomTrack] } = build("robot", "robot", "human", "room");
  const withId = updateTrack(map, r1, { robotId: "7" });
  for (const name of ["", "A".repeat(121)]) rejects(map, () => updateTrack(map, r1, { name }), /名前は1〜120文字/);
  rejects(map, () => updateTrack(map, r1, { name: 5 as unknown as string }), /名前は1〜120文字/);
  for (const color of ["red", "#abc", "#12345g", "123456", "#1234567", ""]) {
    rejects(map, () => updateTrack(map, r1, { color }), /色は#RRGGBB形式/);
  }
  for (const count of [0, 1001, 1.5, -1, Number.NaN, "3" as unknown as number]) {
    rejects(map, () => updateTrack(map, human, { count }), /人数は1〜1000の整数/);
  }
  rejects(map, () => updateTrack(map, r1, { count: 2 }), /人/);
  rejects(map, () => updateTrack(map, human, { robotId: "1" }), /ロボット/);
  rejects(map, () => updateTrack(map, human, { robotRole: "cleaning" }), /ロボット/);
  rejects(withId, () => updateTrack(withId, r2, { robotId: "7" }), /重複/);
  for (const robotId of ["", "x".repeat(101), 7 as unknown as string, "__proto__", "constructor", "prototype", "$start"]) {
    rejects(map, () => updateTrack(map, r1, { robotId }), /ロボットID/);
  }
  rejects(map, () => updateTrack(map, r1, { robotRole: "pilot" as "cleaning" }), /役割/);
  rejects(map, () => updateTrack(map, roomTrack, { roomId: "nope" }), /部屋/);
  rejects(map, () => updateTrack(map, r1, { roomId: "floor" }), /部屋/);
  rejects(map, () => updateTrack(map, "nope", { name: "x" }), /見つかりません/);
  rejects(map, () => updateTrack(map, r1, { kind: "human" } as unknown as { name: string }), /変更できない/);
  // One bad field rejects the whole patch.
  rejects(map, () => updateTrack(map, r1, { name: "ok", color: "bad" }), /色は#RRGGBB形式/);
});

test("updateTrack and every other edit reject a locked row without changing the map", () => {
  const { map, trackIds: [a, b] } = build("robot", "robot");
  const withAction = addActionToTrack(map, a, "move", {}, mk);
  const locked = lock(withAction.map, a);
  const actionId = withAction.actionId;
  const pose = { x: 70, y: 70, yaw: 0, roomId: "floor" };
  rejects(locked, () => updateTrack(locked, a, { name: "x" }), /ロック/);
  rejects(locked, () => setInitialPose(locked, a, pose), /ロック/);
  rejects(locked, () => deleteTrack(locked, a), /ロック/);
  rejects(locked, () => deleteActions(locked, [actionId]), /ロック/);
  rejects(locked, () => duplicateAction(locked, actionId, mk), /ロック/);
  rejects(locked, () => addActionToTrack(locked, a, "wait", {}, mk), /ロック/);
  rejects(locked, () => replaceAction(locked, a, track(locked, a).actions[0]), /ロック/);
  rejects(locked, () => replaceTrack(locked, track(locked, a)), /ロック/);
  // The unlocked neighbour still works.
  assert.equal(track(updateTrack(locked, b, { name: "ok" }), b).name, "ok");
});

test("setInitialPose checks passability with the radius of the row's kind", () => {
  const { map, trackIds: [robot, human, roomTrack] } = build("robot", "human", "room");
  const pose = { x: 300, y: 300, yaw: 90, roomId: "floor" };
  const moved = pure(map, () => setInitialPose(map, robot, pose));
  assert.deepEqual(track(moved, robot).initial, pose);
  pose.x = 999;
  assert.equal(track(moved, robot).initial!.x, 300);
  // (30,30) is 30mm from the wall: fine for a person, too close for a robot.
  const near = { x: 30, y: 30, yaw: 0, roomId: "floor" };
  assert.deepEqual(track(setInitialPose(map, human, near), human).initial, near);
  rejects(map, () => setInitialPose(map, robot, near), /MAP外/);
  rejects(map, () => setInitialPose(map, robot, { x: 2000, y: 70, yaw: 0, roomId: "floor" }), /MAP外/);
  rejects(map, () => setInitialPose(map, roomTrack, pose), /初期位置/);
  rejects(map, () => setInitialPose(map, "nope", pose), /見つかりません/);
  rejects(map, () => setInitialPose(map, robot, { ...pose, yaw: 500 }));
  rejects(map, () => setInitialPose(map, robot, { ...pose, roomId: "nope" }));
  // Furniture blocks a point.
  const desk = structuredClone(map);
  desk.floorPlan!.furniture.push({ id: "desk", roomId: "floor", cell: cellIndex(15, 15), type: "desk", rotation: 0 });
  rejects(desk, () => setInitialPose(desk, robot, { x: 310, y: 310, yaw: 0, roomId: "floor" }), /家具/);
});

test("deleteTrack removes the row, and a dangling targetId is allowed by the project validator", () => {
  const { map, trackIds: [a, b, c] } = build("robot", "human", "display");
  const shown = addActionToTrack(map, a, "show", {}, mk);
  const target = track(shown.map, a).actions[0].targetId;
  const hidden = addActionToTrack(shown.map, b, "hide", { targetId: target }, mk);
  // Upstream parity: the validator accepts a hide whose show is gone, so the row is simply deleted.
  const removed = pure(hidden.map, () => deleteTrack(hidden.map, a));
  assert.deepEqual(removed.tracks.map((t) => t.id), [b, c]);
  assert.equal(track(removed, b).actions[0].targetId, target);
  valid(removed);
  assert.deepEqual(deleteTrack(hidden.map, c).tracks.map((t) => t.id), [a, b]);
  rejects(map, () => deleteTrack(map, "nope"), /見つかりません/);
});

test("deleting a room row keeps the regions, and an unlock keeps resolving its door and room", () => {
  const map = base(rect(2, 2, 14, 14));
  const door = addDoorAt(map, 50, 40, { roomId: "floor", edge: "bottom", maxDistance: 24, cells: 7 }, mk);
  const roomRow = addTrack(door.map, "room", {}, mk);
  const other = addTrack(roomRow.map, "room", {}, mk);
  const unlocked = addActionToTrack(other.map, other.trackId, "unlock", { roomId: "floor", doorId: door.doorId }, mk);
  valid(unlocked.map);
  const removed = deleteTrack(unlocked.map, roomRow.trackId);
  assert.deepEqual(removed.rooms, unlocked.map.rooms);
  assert.deepEqual(removed.floorPlan, unlocked.map.floorPlan);
  assert.equal(track(removed, other.trackId).actions[0].doorId, door.doorId);
  valid(removed);
});

test("deleteActions removes several actions across rows, or none", () => {
  const { map, trackIds: [a, b] } = build("robot", "human");
  const m1 = withAction(map, a, "move");
  const m2 = withAction(m1.map, a, "wait");
  const m3 = withAction(m2.map, b, "wait");
  const full = m3.map;
  const result = pure(full, () => deleteActions(full, [m1.actionId, m3.actionId]));
  assert.deepEqual(track(result, a).actions.map((x) => x.id), [m2.actionId]);
  assert.deepEqual(track(result, b).actions, []);
  assert.deepEqual(deleteActions(full, [m2.actionId, m2.actionId]).tracks[0].actions.map((x) => x.id), [m1.actionId]);
  // A locked row in the selection rejects everything: the unlocked action survives.
  const locked = lock(full, b);
  rejects(locked, () => deleteActions(locked, [m1.actionId, m3.actionId]), /ロック/);
  rejects(full, () => deleteActions(full, [m1.actionId, "nope"]), /見つかりません/);
  rejects(full, () => deleteActions(full, []), /動作/);
});

test("duplicateAction places the copy 6s later with a fresh id and copy name", () => {
  const { map, trackIds: [a] } = build("robot");
  const moved = withAction(map, a, "move", { position: 2, runSeconds: 4, name: "go" });
  const copy = pure(moved.map, () => duplicateAction(moved.map, moved.actionId, mk));
  const source = track(moved.map, a).actions[0];
  const actions = track(copy.map, a).actions;
  assert.equal(actions.length, 2);
  const added = actions.find((x) => x.id === copy.actionId)!;
  assert.notEqual(copy.actionId, moved.actionId);
  assert.equal(added.position, 8);
  assert.equal(added.name, "go copy");
  assert.equal(added.runSeconds, 4);
  assert.deepEqual({ ...added, id: "", position: 0, name: "" }, { ...source, id: "", position: 0, name: "" });
  valid(copy.map);
});

test("duplicateAction truncates long names to 120 chars and renews show/event-start targets only", () => {
  const { map, trackIds: [a, , roomTrack] } = build("robot", "human", "room");
  const long = withAction(map, a, "move", { name: "あ".repeat(120) });
  const longCopy = duplicateAction(long.map, long.actionId, mk);
  const name = track(longCopy.map, a).actions.find((x) => x.id === longCopy.actionId)!.name;
  assert.equal(name.length, 120);
  assert.ok(name.endsWith(" copy"));
  const show = withAction(map, a, "show", { runSeconds: 1 });
  const hide = withAction(show.map, a, "hide");
  const start = withAction(hide.map, roomTrack, "event-start", { runSeconds: 1 });
  const end = withAction(start.map, roomTrack, "event-end");
  const of = (m: SceneMap, t: string, id: string) => track(m, t).actions.find((x) => x.id === id)!;
  for (const [id, trackId, renewed] of [
    [show.actionId, a, true], [hide.actionId, a, false], [start.actionId, roomTrack, true], [end.actionId, roomTrack, false],
  ] as const) {
    const copy = duplicateAction(end.map, id, mk);
    const same = of(end.map, trackId, id).targetId === of(copy.map, trackId, copy.actionId).targetId;
    assert.equal(same, !renewed, `${id} renewed=${renewed}`);
  }
});

test("duplicateAction rejects overlapping copies and unknown actions", () => {
  const { map, trackIds: [a] } = build("robot");
  const long = withAction(map, a, "move", { runSeconds: 10 });
  rejects(long.map, () => duplicateAction(long.map, long.actionId, mk), /重なって/);
  const exact = withAction(map, a, "move", { runSeconds: 6 });
  assert.equal(track(duplicateAction(exact.map, exact.actionId, mk).map, a).actions.length, 2);
  rejects(map, () => duplicateAction(map, "nope", mk), /見つかりません/);
});

test("addActionToTrack appends after the previous action and respects overrides", () => {
  const { map, trackIds: [a] } = build("robot");
  const first = pure(map, () => withAction(map, a, "move"));
  assert.equal(track(first.map, a).actions[0].position, 0);
  assert.equal(track(first.map, a).actions[0].id, first.actionId);
  const second = withAction(first.map, a, "wait");
  const waited = track(second.map, a).actions.find((x) => x.id === second.actionId)!;
  assert.equal(waited.position, 6);
  const custom = withAction(second.map, a, "wait", { name: "pause", runSeconds: 2, position: 20, id: "hijack", type: "move" });
  const added = track(custom.map, a).actions.find((x) => x.id === custom.actionId)!;
  assert.deepEqual([added.name, added.runSeconds, added.position, added.type], ["pause", 2, 20, "wait"]);
  assert.notEqual(custom.actionId, "hijack");
  // hide closes the latest show.
  const show = withAction(map, a, "show");
  const hide = withAction(show.map, a, "hide");
  assert.equal(track(hide.map, a).actions.find((x) => x.id === hide.actionId)!.targetId, track(show.map, a).actions[0].targetId);
  valid(custom.map);
});

test("addActionToTrack allows only the types of each row kind and rejects overlaps", () => {
  const allowed: Record<TrackKind, ActionType[]> = {
    robot: ["move", "show", "hide", "wait"], human: ["move", "show", "hide", "wait"],
    room: ["event-start", "event-end", "unlock", "wait"], display: ["show", "hide", "wait"],
  };
  const all: ActionType[] = ["move", "wait", "show", "hide", "event-start", "event-end", "unlock"];
  const { map, trackIds } = build("robot", "human", "room", "display");
  const kinds: TrackKind[] = ["robot", "human", "room", "display"];
  kinds.forEach((kind, i) => {
    for (const type of all) {
      const owner = track(map, trackIds[i]);
      const permitted = allowed[kind].includes(type);
      // The helper table matches the model's own rule.
      let modelAllows = true;
      try { newAction(map, owner, type, mk); } catch { modelAllows = false; }
      assert.equal(modelAllows, permitted);
      if (permitted) assert.equal(track(withAction(map, owner.id, type).map, owner.id).actions[0].type, type);
      else rejects(map, () => withAction(map, owner.id, type), new RegExp(`${KINDS[kind]}.*${actionTypeLabel(type)}`));
    }
  });
  const { map: m, trackIds: [a] } = build("robot");
  const moved = withAction(m, a, "move", { runSeconds: 6 });
  rejects(moved.map, () => withAction(moved.map, a, "wait", { position: 3 }), /重なって/);
  rejects(m, () => withAction(m, "nope", "move"), /見つかりません/);
  rejects(m, () => withAction(m, a, "move", { x: 5000 }));
});

test("replaceAction swaps the edited action and validates it", () => {
  const { map, trackIds: [a, b] } = build("robot", "human");
  const one = withAction(map, a, "move");
  const two = withAction(one.map, a, "wait");
  const other = withAction(two.map, b, "wait");
  const edited = { ...track(other.map, a).actions[0], name: "renamed", runSeconds: 4, x: 300 };
  const result = pure(other.map, () => replaceAction(other.map, a, edited));
  assert.deepEqual(track(result, a).actions.find((x) => x.id === one.actionId), edited);
  assert.equal(track(result, a).actions.length, 2);
  edited.name = "later";
  assert.equal(track(result, a).actions[0].name, "renamed");
  assert.equal(track(replaceAction(other.map, a, { ...edited, type: "show" }), a).actions[0].type, "show");
  rejects(other.map, () => replaceAction(other.map, a, { ...edited, runSeconds: 7 }), /重なって/);
  rejects(other.map, () => replaceAction(other.map, a, { ...edited, type: "unlock" }));
  rejects(other.map, () => replaceAction(other.map, a, { ...edited, x: 5000 }));
  rejects(other.map, () => replaceAction(other.map, a, { ...edited, id: "nope" }), /見つかりません/);
  // The action belongs to another row.
  rejects(other.map, () => replaceAction(other.map, b, track(other.map, a).actions[0]), /見つかりません/);
  rejects(other.map, () => replaceAction(other.map, "nope", edited), /見つかりません/);
});

test("replaceTrack applies a work copy in one step and checks the sequence", () => {
  const { map, trackIds: [a, b] } = build("robot", "robot");
  const one = withAction(map, a, "move");
  const draft = structuredClone(track(one.map, a));
  draft.name = "batch";
  draft.actions.push({ ...draft.actions[0], id: "extra", position: 6, name: "extra" });
  const result = pure(one.map, () => replaceTrack(one.map, draft));
  assert.equal(track(result, a).name, "batch");
  assert.equal(track(result, a).actions.length, 2);
  draft.name = "later";
  draft.actions.length = 0;
  assert.equal(track(result, a).name, "batch");
  assert.equal(track(result, a).actions.length, 2);
  assert.deepEqual(result.tracks.map((t) => t.id), [a, b]);
  const overlap = structuredClone(track(result, a));
  overlap.actions[1].position = 3;
  rejects(result, () => replaceTrack(result, overlap), /重なって/);
  const clash = { ...structuredClone(track(result, b)), robotId: "same" };
  const withSame = updateTrack(result, a, { robotId: "same" });
  rejects(withSame, () => replaceTrack(withSame, clash), /[^\x00-\x7f]/);
  rejects(result, () => replaceTrack(result, { ...draft, id: "nope" }), /見つかりません/);
});

test("labels are the Japanese display names", () => {
  assert.deepEqual((["robot", "human", "room", "display"] as TrackKind[]).map(trackKindLabel), ["ロボット", "人", "部屋", "画面表示"]);
  assert.deepEqual(
    (["move", "show", "hide", "event-start", "event-end", "unlock", "wait"] as ActionType[]).map(actionTypeLabel),
    ["移動", "表示", "表示を消去", "イベント発生", "イベント終了", "ドア解錠", "待機"],
  );
  assert.equal(newTrack(base(), "robot", mk).kind, "robot");
  assert.deepEqual(names(build("robot", "human").map), ["ロボット 1", "人 1"]);
});
