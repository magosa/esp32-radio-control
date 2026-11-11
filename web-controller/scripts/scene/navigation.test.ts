import test from "node:test";
import assert from "node:assert/strict";
import { cellIndex, type Edge } from "../../scene/grid";
import { equipmentRectangle, placeDoor, placeGate } from "../../scene/equipment";
import { createProject, projectForSave, validateProject } from "../../scene/model";
import { buildNavigation } from "../../scene/navigation";
import { validateFloorPlan } from "../../scene/floorPlan";
import type { Room, SceneMap, Segment } from "../../scene/types";

const EDGES: Edge[] = ["top", "bottom", "left", "right"];
const ids = (prefix = "nav") => {
  let next = 0;
  return () => `${prefix}-${++next}`;
};
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
const fp = (m: SceneMap) => m.floorPlan!;
const length = (s: Segment) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
const hasWall = (walls: Segment[], wall: Segment) => walls.some((w) => w.x1 === wall.x1 && w.y1 === wall.y1 && w.x2 === wall.x2 && w.y2 === wall.y2);

test("navigation uses the mm bottom-left contract with 1705 cells", () => {
  const n = buildNavigation(map(region("room", [0])));
  assert.equal(n.schema, "fleet-floor-navigation/v1");
  assert.equal(n.units, "mm");
  assert.equal(n.width, 1100);
  assert.equal(n.height, 620);
  assert.deepEqual(n.grid, { columns: 55, rows: 31, cellMm: 20, indexOrigin: "bottom-left" });
  assert.equal(n.cells.length, 1705);
  assert.deepEqual(n.cells[0], { cell: 0, roomId: "room", traversable: true, reason: "floor" });
  assert.deepEqual(n.cells[1704], { cell: 1704, roomId: null, traversable: false, reason: "unassigned" });
  assert.ok(n.cells.every((cell, index) => cell.cell === index));
});

test("top-right cell and its walls stay inside the area", () => {
  const n = buildNavigation(map(region("corner", [1704])));
  assert.equal(n.cells[1704].reason, "floor");
  assert.ok(hasWall(n.walls, { x1: 1080, y1: 620, x2: 1100, y2: 620 }));
  assert.ok(hasWall(n.walls, { x1: 1100, y1: 600, x2: 1100, y2: 620 }));
});

test("multi-cell furniture blocks every occupied navigation cell", () => {
  const p = map(region("room", rect(0, 0, 3, 3)));
  for (const type of ["desk", "chair", "plant"] as const) {
    fp(p).furniture = [{ id: "item", roomId: "room", cell: 0, cells: [0, 1, 55, 56], type, rotation: 0 }];
    const before = structuredClone(p);
    const n = buildNavigation(p);
    assert.deepEqual(n.obstacles[0], { id: "item", type, roomId: "room", cell: 0, x: 0, y: 0, width: 40, height: 40, rotation: 0 });
    for (const cell of [0, 1, 55, 56]) assert.deepEqual(n.cells[cell], { cell, roomId: "room", traversable: false, reason: "furniture" });
    assert.equal(n.cells[2].traversable, true);
    assert.deepEqual(p, before);
  }
});

test("adjacent doors merge into one opening without a central wall", () => {
  const p = map(region("room", [0, 1, 2, 55, 110]));
  fp(p).doors = [
    { id: "b", roomId: "room", cell: 1, edge: "bottom" },
    { id: "a", roomId: "room", cell: 0, edge: "bottom" },
  ];
  const before = structuredClone(p);
  const n = buildNavigation(p);
  assert.equal(n.doors.length, 1);
  assert.deepEqual(n.doors[0].memberIds, ["a", "b"]);
  assert.deepEqual(n.doors[0].opening, { x1: 4, y1: 0, x2: 36, y2: 0 });
  assert.equal(n.walls.some((w) => w.y1 === 0 && w.y2 === 0 && w.x1 < 36 && w.x2 > 4), false);
  assert.deepEqual(p, before);
  fp(p).doors = [
    { id: "a", roomId: "room", cell: 0, edge: "left" },
    { id: "b", roomId: "room", cell: 55, edge: "left" },
  ];
  assert.deepEqual(buildNavigation(p).doors[0].opening, { x1: 0, y1: 4, x2: 0, y2: 36 });
});

test("navigation exports wall stubs at door ends, reasons and obstacle rectangles", () => {
  const p = map(region("room", [0, 1, 55]));
  fp(p).doors.push({ id: "door", roomId: "room", cell: 0, edge: "bottom" });
  fp(p).furniture.push({ id: "desk", roomId: "room", cell: 1, type: "desk", rotation: 90 });
  const before = structuredClone(p), n = buildNavigation(p);
  assert.deepEqual(p, before);
  assert.equal(n.cells[0].traversable, true);
  assert.equal(n.cells[1].reason, "furniture");
  assert.deepEqual(n.cells[56], { cell: 56, roomId: null, traversable: false, reason: "unassigned" });
  assert.deepEqual(n.doors[0], {
    id: "door", roomId: "room", cell: 0, edge: "bottom", memberIds: ["door"], adjacentRoomId: null,
    opening: { x1: 4, y1: 0, x2: 16, y2: 0 }, state: "unspecified",
  });
  assert.ok(hasWall(n.walls, { x1: 0, y1: 0, x2: 4, y2: 0 }));
  assert.ok(hasWall(n.walls, { x1: 16, y1: 0, x2: 20, y2: 0 }));
  assert.deepEqual(n.obstacles[0], { id: "desk", type: "desk", roomId: "room", cell: 1, x: 20, y: 0, width: 20, height: 20, rotation: 90 });
  const shared = map(region("a", [0]), region("b", [1]));
  fp(shared).doors.push({ id: "between", roomId: "a", cell: 0, edge: "right" });
  assert.equal(buildNavigation(shared).doors[0].adjacentRoomId, "b");
});

test("shared walls between rooms are exported once", () => {
  const n = buildNavigation(map(region("a", [0]), region("b", [1])));
  assert.equal(n.walls.length, 7);
  assert.equal(n.walls.filter((w) => w.x1 === 20 && w.x2 === 20).length, 1);
});

test("maps without a floor plan still export cell-based navigation", () => {
  const p = map(region("room", [0]));
  delete p.floorPlan;
  const n = buildNavigation(p);
  assert.equal(n.cells[0].traversable, true);
  assert.deepEqual(n.doors, []);
  assert.deepEqual(n.obstacles, []);
  assert.equal(n.walls.length, 4);
});

test("named partition walls and corridor doors export navigation geometry", () => {
  const p = map(region("hall", rect(0, 0, 3, 2), "corridor"));
  fp(p).walls = [{ id: "partition", roomId: "hall", name: "Reception partition", x1: 0, y1: 20, x2: 60, y2: 20 }];
  fp(p).doors = [{
    id: "gate", roomId: "hall", wallId: "partition", name: "North entrance", kind: "flapper", x1: 20, y1: 20, x2: 40, y2: 20,
  }];
  const before = structuredClone(p), n = buildNavigation(p);
  assert.deepEqual(n.doors[0], {
    id: "gate", roomId: "hall", name: "North entrance", kind: "flapper", memberIds: ["gate"], adjacentRoomId: null,
    opening: { x1: 24, y1: 20, x2: 36, y2: 20 }, state: "unspecified",
  });
  assert.ok(hasWall(n.walls, { x1: 0, y1: 20, x2: 24, y2: 20 }));
  assert.ok(hasWall(n.walls, { x1: 36, y1: 20, x2: 60, y2: 20 }));
  assert.equal(n.walls.some((w) => w.y1 === 20 && w.y2 === 20 && w.x1 < 36 && w.x2 > 24), false);
  assert.deepEqual(p, before);
});

test("new boundary doors yield one navigation door with a 192mm opening", () => {
  const starts: Record<Edge, number> = {
    bottom: cellIndex(2, 2), top: cellIndex(2, 13), left: cellIndex(2, 2), right: cellIndex(13, 2),
  };
  for (const edge of EDGES) {
    const p = map(region("floor", rect(2, 2, 12, 12), "corridor"));
    fp(p).doors.push(...placeDoor(p, { roomId: "floor", cell: starts[edge], edge }, ids()));
    const n = buildNavigation(p);
    assert.equal(n.doors.length, 1);
    assert.equal(length(n.doors[0].opening), 192);
  }
});

test("rectangular gate overlays keep floor cells and leave the flapper opening clear", () => {
  for (const entrance of EDGES) {
    const p = map(region("floor", rect(0, 0, 30, 20), "corridor"));
    const gate = placeGate(p, equipmentRectangle(cellIndex(4, 3), cellIndex(11, 9), entrance), entrance, ids());
    fp(p).walls!.push(...gate.walls);
    fp(p).doors.push(gate.door);
    const n = buildNavigation(p);
    assert.equal(n.cells.filter((cell) => cell.traversable).length, 600);
    assert.equal(n.doors.length, 1);
    assert.equal(n.doors[0].kind, "flapper");
    assert.equal(hasWall(n.walls, { x1: gate.door.x1!, y1: gate.door.y1!, x2: gate.door.x2!, y2: gate.door.y2! }), false);
  }
});

test("charging zones do not change navigation", () => {
  const p = map(region("room", rect(0, 0, 4, 4)));
  const without = buildNavigation(p);
  fp(p).chargingZones = [{ id: "zone", name: "Dock", x: 0, y: 0, width: 40, height: 40 }];
  assert.deepEqual(buildNavigation(p), without);
});

test("charging overlays preserve all navigation cells, walls and obstacles across JSON roundtrip", () => {
  const project = createProject("p", ids("project")), m = project.maps[0];
  m.rooms.push(region("room", rect(0, 0, 10, 10)));
  m.floorPlan = {
    doors: [{ id: "door", roomId: "room", cell: cellIndex(0, 4), edge: "left" }],
    furniture: [{ id: "desk", roomId: "room", cell: cellIndex(6, 6), type: "desk", rotation: 0 }],
    walls: [{ id: "partition", roomId: "room", x1: 0, y1: 100, x2: 60, y2: 100 }],
    chargingZones: [
      { id: "dock", name: "Dock", x: 20, y: 20, width: 60, height: 60 },
      { id: "corner", name: "Corner", x: 1040, y: 560, width: 60, height: 60 },
    ],
  };
  const without = structuredClone(m);
  delete without.floorPlan!.chargingZones;
  assert.deepEqual(buildNavigation(m), buildNavigation(without));
  assert.deepEqual(JSON.parse(JSON.stringify(projectForSave(project))).maps[0].floorPlan.chargingZones, m.floorPlan.chargingZones);
  assert.doesNotThrow(() => validateFloorPlan(m));
  for (const props of [{ x: -1 }, { width: 2000 }, { height: NaN }, { id: "room" }, { y: 600 }]) {
    const invalid = structuredClone(m);
    Object.assign(invalid.floorPlan!.chargingZones![0], props);
    assert.throws(() => validateFloorPlan(invalid), /charging|ID/, JSON.stringify(props));
    const saved = structuredClone(project);
    saved.maps[0] = invalid;
    assert.throws(() => validateProject(saved), /charging|chargingZone|id/i, JSON.stringify(props));
  }
});

test("save snapshot refreshes derived navigation without changing editable data", () => {
  const project = createProject("p", ids("project")), m = project.maps[0];
  m.rooms.push(region("room", [0, 1]));
  m.floorPlan = { doors: [], furniture: [] };
  const before = structuredClone(project);
  const first = projectForSave(project);
  assert.deepEqual(project, before);
  assert.equal(first.maps[0].navigation!.cells[0].traversable, true);
  const stale = structuredClone(first);
  stale.maps[0].navigation = { stale: true } as never;
  assert.equal(projectForSave(stale).maps[0].navigation!.schema, "fleet-floor-navigation/v1");
  m.floorPlan.furniture.push({ id: "plant", roomId: "room", cell: 0, cells: [0, 1], type: "plant", rotation: 0 });
  const reloaded = validateProject(JSON.parse(JSON.stringify(projectForSave(project))));
  assert.equal(reloaded.maps[0].navigation!.cells[1].traversable, false);
  assert.equal(reloaded.maps[0].navigation!.obstacles[0].width, 40);
  assert.equal(first.maps[0].navigation!.cells[1].traversable, true);
});
