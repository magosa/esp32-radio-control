import test from "node:test";
import assert from "node:assert/strict";
import { nearestDoorWall, type WallDoorCandidate } from "../../scene/equipment";
import { cellIndex } from "../../scene/grid";
import {
  collisionWarnings, coordinatePoint, createSafety, pathProblem, pathSections, positionAt,
  type Trajectory,
} from "../../scene/safety";
import type { Room, SceneMap } from "../../scene/types";

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

test("grid coordinates snap to edit-grid centers at all edges", () => {
  assert.deepEqual(coordinatePoint(0, 0, "grid", 20), { x: 10, y: 10 });
  assert.deepEqual(coordinatePoint(1100, 620, "grid", 20), { x: 1090, y: 610 });
  assert.deepEqual(coordinatePoint(35, 70, "grid", 20), { x: 30, y: 70 });
  assert.deepEqual(coordinatePoint(-10, 700, "grid", 20), { x: 10, y: 610 });
  assert.deepEqual(coordinatePoint(1095, 615, "grid", 40), { x: 1090, y: 610 });
  assert.throws(() => coordinatePoint(Number.NaN, 0, "grid", 20));
});

test("free coordinates preserve decimals, constrain axes from the origin, and validate explicitly", () => {
  const origin = { x: 90, y: 120 };
  assert.deepEqual(coordinatePoint(229.17, 139.4, "free", 20), { x: 229.17, y: 139.4 });
  assert.deepEqual(coordinatePoint(229.17, 139.4, "grid", 20), { x: 230, y: 130 });
  assert.deepEqual(coordinatePoint(229.17, 139.4, "free", 20, origin, true), { x: 229.17, y: 120 });
  assert.deepEqual(coordinatePoint(90.6, 346.9, "free", 20, origin, true), { x: 90, y: 346.9 });
  assert.deepEqual(coordinatePoint(-10, 621, "free", 20), { x: 0, y: 620 });
  assert.throws(() => coordinatePoint(Number.NaN, 1, "free", 20));
  assert.throws(() => coordinatePoint(1, 1, "polar" as "free", 20), /モード/);
});

test("walls, furniture, unassigned cells and swept body clearance block paths", () => {
  const m = map(region("left", rect(0, 0, 15, 31)));
  let s = createSafety(m);
  assert.equal(s.robotRadius, 60);
  assert.match(pathProblem(s, { x: 90, y: 90 }, { x: 430, y: 90 }), /壁|通行/);
  assert.match(pathProblem(s, { x: 20, y: 90 }, { x: 90, y: 90 }), /MAP外/);
  assert.match(pathProblem(s, { x: 90, y: 20 }, { x: 90, y: 90 }), /MAP外/);
  assert.equal(pathProblem(s, { x: 90, y: 90 }, { x: 230, y: 90 }), "");
  assert.match(pathProblem(s, { x: 59, y: 90 }, { x: 59, y: 230 }), /MAP外/);
  assert.equal(pathProblem(s, { x: 60, y: 90 }, { x: 60, y: 230 }), "");
  fp(m).furniture.push({ id: "desk", roomId: "left", type: "desk", cell: cellIndex(5, 10), rotation: 0 });
  s = createSafety(m);
  assert.match(pathProblem(s, { x: 70, y: 150 }, { x: 230, y: 150 }), /家具/);
  assert.equal(pathProblem(s, { x: 70, y: 140 }, { x: 230, y: 140 }), "");
  assert.match(pathProblem(s, { x: 70, y: 141 }, { x: 230, y: 141 }), /家具/);
});

test("human clearance uses the 14mm radius", () => {
  const s = createSafety(open());
  assert.equal(pathProblem(s, { x: 14, y: 14 }, { x: 14, y: 300 }, "human"), "");
  assert.match(pathProblem(s, { x: 13, y: 14 }, { x: 13, y: 300 }, "human"), /MAP外/);
  assert.match(pathProblem(s, { x: 14, y: 14 }, { x: 14, y: 300 }), /MAP外/);
});

test("openings into unassigned cells are rejected by the cell check", () => {
  const m = map(region("left", rect(0, 0, 20, 31)));
  for (let row = 10; row < 20; row++) fp(m).doors.push({ id: `d${row}`, roomId: "left", cell: cellIndex(19, row), edge: "right" });
  const s = createSafety(m);
  assert.equal(pathProblem(s, { x: 300, y: 300 }, { x: 330, y: 300 }), "");
  assert.match(pathProblem(s, { x: 300, y: 300 }, { x: 460, y: 300 }), /通行/);
});

test("wall clearance of exactly 60mm is allowed and 59mm is rejected", () => {
  const m = open();
  fp(m).walls = [{ id: "partition", roomId: "room", x1: 200, y1: 300, x2: 900, y2: 300 }];
  const s = createSafety(m);
  assert.equal(pathProblem(s, { x: 100, y: 240 }, { x: 1000, y: 240 }), "");
  assert.match(pathProblem(s, { x: 100, y: 241 }, { x: 1000, y: 241 }), /壁/);
  assert.equal(pathProblem(s, { x: 140, y: 400 }, { x: 140, y: 200 }), "");
  assert.match(pathProblem(s, { x: 141, y: 400 }, { x: 141, y: 200 }), /壁/);
});

test("a 120mm corridor admits its centerline and a 100mm corridor does not", () => {
  const wide = createSafety(map(region("hall", rect(5, 10, 36, 6), "corridor")));
  assert.equal(pathProblem(wide, { x: 200, y: 260 }, { x: 600, y: 260 }), "");
  assert.match(pathProblem(wide, { x: 200, y: 261 }, { x: 600, y: 261 }), /壁/);
  const narrow = createSafety(map(region("hall", rect(5, 10, 36, 5), "corridor")));
  assert.match(pathProblem(narrow, { x: 200, y: 250 }, { x: 600, y: 250 }), /壁/);
});

test("independent corridor barriers stop unsafe paths and wide door openings permit passage", () => {
  const p = map(region("hall", rect(0, 0, 55, 31), "corridor"));
  fp(p).walls = [{ id: "partition", roomId: "hall", name: "Corridor divider", x1: 20, y1: 300, x2: 600, y2: 300 }];
  const from = { x: 300, y: 260 }, to = { x: 300, y: 360 };
  assert.match(pathProblem(createSafety(p), from, to), /壁/);
  const candidate = nearestDoorWall(p, 300, 300, { maxDistance: 1 }) as WallDoorCandidate;
  assert.deepEqual([candidate.x1, candidate.y1, candidate.x2, candidate.y2], [200, 300, 400, 300]);
  fp(p).doors.push({
    id: "entrance", roomId: "hall", wallId: "partition", name: "Entrance", kind: "automatic",
    x1: candidate.x1, y1: candidate.y1, x2: candidate.x2, y2: candidate.y2,
  });
  assert.equal(pathProblem(createSafety(p), from, to), "");
});

function corridorMap(width: number) {
  return map(
    region("left", rect(0, 0, 10, 31)),
    region("hall", rect(10, 10, 35, width), "corridor"),
    region("right", rect(45, 0, 10, 31)),
  );
}

test("corridors up to 11 cells wide form one-at-a-time zones; 12 cells do not", () => {
  const s = createSafety(corridorMap(11));
  assert.equal(s.zones.size, 1);
  const zone = Array.from(s.zones.values())[0];
  assert.equal(zone.name, "hall");
  assert.equal(zone.cells.size, 35 * 11);
  assert.equal(s.cellZones.get(cellIndex(10, 10)), zone.id);
  assert.equal(s.cellZones.get(cellIndex(0, 10)), undefined);
  assert.equal(createSafety(corridorMap(12)).zones.size, 0);
  assert.equal(createSafety(map(region("room", rect(10, 10, 35, 3)))).zones.size, 0);
});

test("path sections split at zone boundaries", () => {
  const s = createSafety(corridorMap(11));
  const sections = pathSections(s, { x: 100, y: 300 }, { x: 1000, y: 300 });
  const zone = Array.from(s.zones.keys())[0];
  assert.deepEqual(sections.map((section) => section.zone), [null, zone, null]);
  assert.ok(Math.abs(sections[1].from - 100 / 900) < 1e-9);
  assert.ok(Math.abs(sections[1].to - 800 / 900) < 1e-9);
  assert.equal(sections[0].from, 0);
  assert.equal(sections[2].to, 1);
});

test("positionAt interpolates segments and holds the final point", () => {
  const segments = [
    { from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, start: 0, end: 2 },
    { from: { x: 100, y: 0 }, to: { x: 100, y: 0 }, start: 2, end: 3 },
  ];
  assert.deepEqual(positionAt(segments, 1), { x: 50, y: 0 });
  assert.deepEqual(positionAt(segments, 10), { x: 100, y: 0 });
  assert.throws(() => positionAt([], 0));
});

const move = (from: { x: number; y: number }, to: { x: number; y: number }, start = 0, end = 1) => [{ from, to, start, end }];
const actor = (id: string, kind: Trajectory["kind"], segments: Trajectory["segments"]): Trajectory => ({ id, name: id, kind, segments });

test("continuous closest approach detects human/robot crossings and stationary actors", () => {
  const a = actor("a", "robot", move({ x: 0, y: 35 }, { x: 69, y: 35 }));
  const b = actor("b", "human", move({ x: 35, y: 0 }, { x: 35, y: 69 }));
  assert.equal(collisionWarnings([a, b]).length, 1);
  b.segments = move({ x: 35, y: 35 }, { x: 35, y: 35 });
  assert.equal(collisionWarnings([a, b]).length, 1);
  b.segments = move({ x: 35, y: 346 }, { x: 35, y: 415 });
  assert.equal(collisionWarnings([a, b]).length, 0);
});

test("collision thresholds are 120mm robot-robot and 74mm robot-human", () => {
  const still = actor("a", "robot", move({ x: 0, y: 0 }, { x: 0, y: 0 }));
  const pass = (kind: Trajectory["kind"], y: number) => collisionWarnings([still, actor("b", kind, move({ x: -100, y }, { x: 100, y }))]);
  const [warning] = pass("robot", 119);
  assert.deepEqual(warning.trackIds, ["a", "b"]);
  assert.ok(Math.abs(warning.at - 0.5) < 1e-9);
  assert.equal(pass("robot", 120).length, 0);
  assert.equal(pass("robot", 121).length, 0);
  assert.equal(pass("human", 73).length, 1);
  assert.equal(pass("human", 74).length, 0);
  const humans = [actor("h1", "human", move({ x: 0, y: 0 }, { x: 0, y: 0 })), actor("h2", "human", move({ x: 0, y: 0 }, { x: 0, y: 0 }))];
  assert.equal(collisionWarnings(humans).length, 0);
});
