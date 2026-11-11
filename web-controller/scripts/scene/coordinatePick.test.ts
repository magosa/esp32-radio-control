import test from "node:test";
import assert from "node:assert/strict";
import { mergedDoors, placeDoor } from "../../scene/equipment";
import { cellIndex } from "../../scene/grid";
import {
  constrainAxis, normalizeYaw180, pickPoint, pickProblem, pickRoom,
} from "../../scene/coordinatePick";
import type { EditGridMm } from "../../scene/units";
import type { Room, SceneMap, Track } from "../../scene/types";

const region = (id: string, cells: number[], kind: Room["kind"] = "room"): Room => ({
  id, name: id, cells, kind, color: "#739a81", material: "concrete",
});
// Rows count from the bottom.
const rect = (x: number, y: number, width: number, height: number) =>
  Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, col) => cellIndex(x + col, y + row))).flat();
const map = (...rooms: Room[]): SceneMap => ({
  id: "map", name: "Plan", editGridMm: 20, doorMode: "story", tracks: [], rooms,
  floorPlan: { doors: [], furniture: [], walls: [] },
});
const open = () => map(region("room", rect(0, 0, 55, 31)));
const fp = (m: SceneMap) => m.floorPlan!;
const track = (id: string, kind: Track["kind"], x: number, y: number): Track => ({
  id, kind, name: id, color: "#93ead1", muted: false, locked: false, actions: [],
  initial: { x, y, yaw: 0, roomId: "room" },
});
// Runs the call and proves the input was left untouched; returns the call's result.
const pure = <T>(m: SceneMap, call: () => T): T => {
  const before = structuredClone(m);
  try {
    return call();
  } finally {
    assert.deepEqual(m, before);
  }
};
const withGrid = (m: SceneMap, grid: EditGridMm): SceneMap => ({ ...m, editGridMm: grid });
const BAD_YAW = "初期の向きは -180〜180° で指定してください。";

test("pickPoint grid mode snaps to the centre of the 20mm cell", () => {
  const m = open();
  assert.deepEqual(pure(m, () => pickPoint(m, { x: 35, y: 70 }, "grid")), { x: 30, y: 70, roomId: "room" });
  assert.deepEqual(pickPoint(m, { x: 0, y: 0 }, "grid"), { x: 10, y: 10, roomId: "room" });
  assert.deepEqual(pickPoint(m, { x: 19.99, y: 20 }, "grid"), { x: 10, y: 30, roomId: "room" });
  assert.deepEqual(pickPoint(m, { x: 1100, y: 620 }, "grid"), { x: 1090, y: 610, roomId: "room" });
});

test("pickPoint grid mode uses the map's edit grid and keeps the top-right remainder inside the area", () => {
  const base = open();
  assert.deepEqual(pickPoint(withGrid(base, 40), { x: 45, y: 10 }, "grid"), { x: 60, y: 20, roomId: "room" });
  assert.deepEqual(pickPoint(withGrid(base, 40), { x: 1095, y: 615 }, "grid"), { x: 1090, y: 610, roomId: "room" });
  assert.deepEqual(pickPoint(withGrid(base, 60), { x: 100, y: 100 }, "grid"), { x: 90, y: 90, roomId: "room" });
  assert.deepEqual(pickPoint(withGrid(base, 60), { x: 1099, y: 619 }, "grid"), { x: 1090, y: 610, roomId: "room" });
  assert.deepEqual(pickPoint(withGrid(base, 80), { x: 1095, y: 10 }, "grid"), { x: 1070, y: 40, roomId: "room" });
  assert.deepEqual(pickPoint(withGrid(base, 80), { x: 79.9, y: 80 }, "grid"), { x: 40, y: 120, roomId: "room" });
  assert.deepEqual(pickPoint(withGrid(base, 100), { x: 1050, y: 615 }, "grid"), { x: 1050, y: 610, roomId: "room" });
  assert.deepEqual(pickPoint(withGrid(base, 100), { x: 99, y: 99 }, "grid"), { x: 50, y: 50, roomId: "room" });
});

test("pickPoint grid mode clamps points outside the area before snapping", () => {
  const m = open();
  assert.deepEqual(pickPoint(m, { x: -10, y: 700 }, "grid"), { x: 10, y: 610, roomId: "room" });
  assert.deepEqual(pickPoint(m, { x: 5000, y: -5000 }, "grid"), { x: 1090, y: 10, roomId: "room" });
});

test("pickPoint free mode keeps mm as is and clamps to the area", () => {
  const m = open();
  assert.deepEqual(pure(m, () => pickPoint(m, { x: 229.17, y: 139.4 }, "free")), { x: 229.17, y: 139.4, roomId: "room" });
  assert.deepEqual(pickPoint(m, { x: -10, y: 621 }, "free"), { x: 0, y: 620, roomId: "room" });
  assert.deepEqual(pickPoint(m, { x: 1100.5, y: -3 }, "free"), { x: 1100, y: 0, roomId: "room" });
  assert.deepEqual(pickPoint(m, { x: 1100, y: 620 }, "free"), { x: 1100, y: 620, roomId: "room" });
});

test("pickPoint reports the containing region, an empty id outside every region, and the first region on a shared edge", () => {
  const left = region("left", rect(0, 0, 10, 31)), right = region("right", rect(10, 0, 10, 31));
  const m = map(left, right);
  assert.equal(pickPoint(m, { x: 100, y: 100 }, "free").roomId, "left");
  assert.equal(pickPoint(m, { x: 300, y: 100 }, "free").roomId, "right");
  assert.equal(pickPoint(m, { x: 600, y: 100 }, "free").roomId, "");
  assert.equal(pickPoint(m, { x: 600, y: 100 }, "grid").roomId, "");
  assert.equal(pickPoint(m, { x: 200, y: 100 }, "free").roomId, "left");
  assert.equal(pickPoint(map(right, left), { x: 200, y: 100 }, "free").roomId, "right");
  // The 40mm block [200,240] has its centre on a cell border; both cells belong to "right".
  assert.equal(pickPoint(withGrid(m, 40), { x: 205, y: 50 }, "grid").roomId, "right");
  assert.equal(pickPoint(map(region("empty", [])), { x: 5, y: 5 }, "free").roomId, "");
});

test("pickPoint rejects non-finite coordinates and unknown modes in Japanese", () => {
  const m = open();
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => pickPoint(m, { x: bad, y: 1 }, "free"), /有限/);
    assert.throws(() => pickPoint(m, { x: 1, y: bad }, "grid"), /有限/);
  }
  assert.throws(() => pickPoint(m, { x: 1, y: 1 }, "polar" as "free"), /モード/);
});

test("constrainAxis moves only the axis with the larger movement", () => {
  const origin = { x: 100, y: 100 };
  assert.deepEqual(constrainAxis(origin, { x: 300, y: 120 }), { x: 300, y: 100 });
  assert.deepEqual(constrainAxis(origin, { x: 120, y: 300 }), { x: 100, y: 300 });
  assert.deepEqual(constrainAxis(origin, { x: -50, y: 120 }), { x: -50, y: 100 });
  assert.deepEqual(constrainAxis(origin, { x: 120, y: -50 }), { x: 100, y: -50 });
});

test("constrainAxis measures each axis from its own origin coordinate", () => {
  assert.deepEqual(constrainAxis({ x: 100, y: 400 }, { x: 130, y: 200 }), { x: 100, y: 200 });
  assert.deepEqual(constrainAxis({ x: 400, y: 100 }, { x: 200, y: 130 }), { x: 200, y: 100 });
  assert.deepEqual(constrainAxis({ x: 100, y: 400 }, { x: 300, y: 380 }), { x: 300, y: 400 });
});

test("constrainAxis on equal movements keeps the horizontal axis (upstream: |dx| >= |dy| moves x)", () => {
  const origin = { x: 100, y: 100 };
  assert.deepEqual(constrainAxis(origin, { x: 150, y: 150 }), { x: 150, y: 100 });
  assert.deepEqual(constrainAxis(origin, { x: 50, y: 150 }), { x: 50, y: 100 });
  assert.deepEqual(constrainAxis(origin, { x: 50, y: 50 }), { x: 50, y: 100 });
  assert.deepEqual(constrainAxis(origin, { x: 150.5, y: 150 }), { x: 150.5, y: 100 });
  assert.deepEqual(constrainAxis(origin, { x: 150, y: 150.5 }), { x: 100, y: 150.5 });
});

test("constrainAxis returns the origin for the same point, never mutates, and rejects non-finite input", () => {
  const origin = Object.freeze({ x: 100, y: 100 }), point = Object.freeze({ x: 100, y: 100 });
  assert.deepEqual(constrainAxis(origin, point), { x: 100, y: 100 });
  assert.notEqual(constrainAxis(origin, point), point);
  for (const bad of [Number.NaN, Infinity]) {
    assert.throws(() => constrainAxis({ x: bad, y: 0 }, { x: 1, y: 1 }), /有限/);
    assert.throws(() => constrainAxis({ x: 0, y: 0 }, { x: 1, y: bad }), /有限/);
  }
});

test("pickProblem allows an open point and rejects points outside the area", () => {
  const m = open();
  assert.equal(pure(m, () => pickProblem(m, "robot", { x: 300, y: 300 })), "");
  assert.equal(pickProblem(m, "robot", { x: 60, y: 60 }), "");
  assert.match(pickProblem(m, "robot", { x: 59, y: 300 }), /MAP外/);
  assert.match(pickProblem(m, "robot", { x: 300, y: 561 }), /MAP外/);
  assert.match(pickProblem(m, "robot", { x: -5, y: 300 }), /MAP外/);
  assert.match(pickProblem(m, "robot", { x: 1200, y: 300 }), /MAP外/);
});

test("pickProblem uses the 60mm robot radius and the 14mm human radius", () => {
  const m = open();
  assert.equal(pickProblem(m, "human", { x: 14, y: 14 }), "");
  assert.match(pickProblem(m, "human", { x: 13, y: 14 }), /MAP外/);
  assert.match(pickProblem(m, "robot", { x: 14, y: 14 }), /MAP外/);
  fp(m).walls = [{ id: "partition", roomId: "room", x1: 200, y1: 300, x2: 900, y2: 300 }];
  assert.equal(pickProblem(m, "robot", { x: 300, y: 240 }), "");
  assert.match(pickProblem(m, "robot", { x: 300, y: 241 }), /壁/);
  assert.equal(pickProblem(m, "human", { x: 300, y: 286 }), "");
  assert.match(pickProblem(m, "human", { x: 300, y: 287 }), /壁/);
  assert.match(pickProblem(m, "robot", { x: 300, y: 270 }), /壁/);
  assert.equal(pickProblem(m, "human", { x: 300, y: 270 }), "");
});

test("pickProblem rejects points inside a wall and inside furniture", () => {
  const m = map(region("left", rect(0, 0, 15, 31)));
  fp(m).furniture.push({ id: "desk", roomId: "left", type: "desk", cell: cellIndex(5, 10), rotation: 0 });
  fp(m).walls = [{ id: "partition", roomId: "left", x1: 20, y1: 500, x2: 280, y2: 500 }];
  assert.match(pickProblem(m, "robot", { x: 150, y: 500 }), /壁/);
  assert.match(pickProblem(m, "robot", { x: 110, y: 210 }), /家具/);
  assert.match(pickProblem(m, "robot", { x: 110, y: 141 }), /家具/);
  assert.equal(pickProblem(m, "robot", { x: 110, y: 140 }), "");
  assert.equal(pickProblem(m, "human", { x: 110, y: 185 }), "");
  assert.match(pickProblem(m, "human", { x: 110, y: 187 }), /家具/);
});

test("pickProblem rejects a point outside every region", () => {
  const m = map(region("left", rect(0, 0, 15, 31)));
  assert.equal(pickProblem(m, "robot", { x: 150, y: 300 }), "");
  assert.match(pickProblem(m, "robot", { x: 500, y: 300 }), /通行/);
  assert.match(pickProblem(m, "human", { x: 500, y: 300 }), /通行/);
});

test("pickProblem treats a 132mm door as passable and a 112mm door as blocked", () => {
  const build = (keep: number) => {
    const m = map(region("left", rect(0, 5, 20, 20)), region("right", rect(20, 5, 20, 20)));
    let next = 0;
    const doors = placeDoor(m, { roomId: "left", cell: cellIndex(19, 12), edge: "right" }, () => `d-${++next}`, 7);
    fp(m).doors.push(...doors.slice(0, keep));
    const [group] = mergedDoors(m);
    const width = Math.hypot(group.opening.x2 - group.opening.x1, group.opening.y2 - group.opening.y1);
    return { m, width, centre: { x: 400, y: (group.opening.y1 + group.opening.y2) / 2 } };
  };
  const wide = build(7), narrow = build(6);
  assert.equal(wide.width, 132);
  assert.equal(narrow.width, 112);
  assert.equal(pure(wide.m, () => pickProblem(wide.m, "robot", wide.centre)), "");
  assert.match(pickProblem(narrow.m, "robot", narrow.centre), /壁|ドア/);
  assert.equal(pickProblem(narrow.m, "human", narrow.centre), "");
});

test("pickProblem validates the initial heading in -180..180 before anything else", () => {
  const m = open(), at = { x: 300, y: 300 };
  for (const yaw of [0, 90, -90, 180, -180, 179.5]) assert.equal(pickProblem(m, "robot", at, yaw), "");
  for (const yaw of [180.1, -180.1, 181, 360, -270, Number.NaN, Infinity, -Infinity]) {
    assert.equal(pickProblem(m, "robot", at, yaw), BAD_YAW);
    assert.equal(pickProblem(m, "human", at, yaw), BAD_YAW);
  }
  assert.equal(pickProblem(m, "robot", { x: -5, y: 300 }, 400), BAD_YAW);
  assert.match(pickProblem(m, "robot", { x: -5, y: 300 }, 0), /MAP外/);
  assert.equal(pickProblem(m, "robot", at, undefined), "");
  assert.equal(pickProblem(m, "robot", { x: 300, y: 300 }), "");
});

test("pickProblem rejects an initial pose overlapping another row's initial pose", () => {
  const m = open();
  m.tracks = [track("r1", "robot", 300, 300), track("h1", "human", 700, 300)];
  assert.match(pure(m, () => pickProblem(m, "robot", { x: 419, y: 300 }, 0)), /重な/);
  assert.equal(pickProblem(m, "robot", { x: 420, y: 300 }, 0), "");
  assert.match(pickProblem(m, "robot", { x: 300, y: 300 }, 0), /重な/);
  assert.match(pickProblem(m, "robot", { x: 300, y: 419 }, 0), /重な/);
  assert.equal(pickProblem(m, "robot", { x: 300, y: 420 }, 0), "");
  // robot (60) + human (14) = 74mm
  assert.match(pickProblem(m, "human", { x: 373, y: 300 }, 0), /重な/);
  assert.equal(pickProblem(m, "human", { x: 374, y: 300 }, 0), "");
  assert.match(pickProblem(m, "robot", { x: 700 - 73, y: 300 }, 0), /重な/);
  assert.equal(pickProblem(m, "robot", { x: 700 - 74, y: 300 }, 0), "");
  // two humans never block each other (collisions between humans are not warned either)
  assert.equal(pickProblem(m, "human", { x: 700, y: 300 }, 0), "");
  // a plain (non-initial) target is not compared with initial poses
  assert.equal(pickProblem(m, "robot", { x: 300, y: 300 }), "");
});

test("pickProblem ignores rows without an initial pose and non-actor tracks", () => {
  const m = open();
  const bare = track("r1", "robot", 300, 300);
  delete bare.initial;
  m.tracks = [bare, track("room1", "room", 300, 300), track("d1", "display", 300, 300)];
  assert.equal(pickProblem(m, "robot", { x: 300, y: 300 }, 0), "");
});

test("pickProblem skips body checks for room and display rows", () => {
  const m = map(region("left", rect(0, 0, 15, 31)));
  assert.equal(pickProblem(m, "room", { x: 500, y: 300 }), "");
  assert.equal(pickProblem(m, "display", { x: 5, y: 5 }), "");
  assert.equal(pickProblem(m, "display", { x: 5, y: 5 }, 400), BAD_YAW);
});

test("pickProblem rejects non-finite points in Japanese", () => {
  const m = open();
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => pickProblem(m, "robot", { x: bad, y: 1 }), /有限/);
    assert.throws(() => pickProblem(m, "human", { x: 1, y: bad }, 0), /有限/);
  }
});

test("pickRoom returns the region and its anchor for points inside, null outside", () => {
  const m = map(region("left", rect(2, 2, 4, 4)), region("right", rect(10, 10, 3, 1)));
  const hit = pure(m, () => pickRoom(m, { x: 100, y: 100 }));
  assert.deepEqual(hit, { roomId: "left", anchor: { x: 70, y: 70 } });
  assert.deepEqual(pickRoom(m, { x: 230, y: 210 }), { roomId: "right", anchor: { x: 230, y: 210 } });
  assert.equal(pickRoom(m, { x: 10, y: 10 }), null);
  assert.equal(pickRoom(m, { x: 150, y: 100 }), null);
  assert.equal(pickRoom(m, { x: 100, y: 39.9 }), null);
  assert.equal(pickRoom(m, { x: 120.1, y: 100 }), null);
  assert.equal(pickRoom(m, { x: -1, y: 100 }), null);
  assert.equal(pickRoom(m, { x: 100, y: 700 }), null);
});

test("pickRoom handles shared edges, region borders and empty regions", () => {
  const a = region("a", rect(0, 0, 5, 5)), b = region("b", rect(5, 0, 5, 5));
  assert.equal(pickRoom(map(a, b), { x: 100, y: 50 })?.roomId, "a");
  assert.equal(pickRoom(map(b, a), { x: 100, y: 50 })?.roomId, "b");
  assert.equal(pickRoom(map(a, b), { x: 0, y: 0 })?.roomId, "a");
  assert.equal(pickRoom(map(a, b), { x: 200, y: 100 })?.roomId, "b");
  assert.equal(pickRoom(map(a, b), { x: 200.1, y: 100 }), null);
  const empty = region("empty", []);
  assert.equal(pickRoom(map(empty), { x: 5, y: 5 }), null);
  assert.equal(pickRoom(map(empty, a), { x: 50, y: 50 })?.roomId, "a");
  assert.equal(pickRoom(map(), { x: 50, y: 50 }), null);
});

test("pickRoom rejects non-finite coordinates in Japanese", () => {
  const m = open();
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => pickRoom(m, { x: bad, y: 1 }), /有限/);
    assert.throws(() => pickRoom(m, { x: 1, y: bad }), /有限/);
  }
});

test("normalizeYaw180 wraps into -180..180 and rejects non-finite values", () => {
  assert.equal(normalizeYaw180(0), 0);
  assert.equal(normalizeYaw180(90), 90);
  assert.equal(normalizeYaw180(190), -170);
  assert.equal(normalizeYaw180(-190), 170);
  assert.equal(normalizeYaw180(360), 0);
  assert.equal(normalizeYaw180(-360), 0);
  assert.equal(normalizeYaw180(720 + 45), 45);
  assert.equal(Math.abs(normalizeYaw180(180)), 180);
  assert.equal(Math.abs(normalizeYaw180(-180)), 180);
  assert.equal(Math.abs(normalizeYaw180(540)), 180);
  for (let deg = -1000; deg <= 1000; deg += 7.5) {
    const wrapped = normalizeYaw180(deg);
    assert.ok(wrapped >= -180 && wrapped <= 180, `${deg} -> ${wrapped}`);
    assert.ok(Math.abs((((wrapped - deg) % 360) + 360) % 360) < 1e-9 || Math.abs((((wrapped - deg) % 360) + 360) % 360 - 360) < 1e-9);
  }
  for (const bad of [Number.NaN, Infinity, -Infinity]) assert.throws(() => normalizeYaw180(bad), /有限/);
});
