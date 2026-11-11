import test from "node:test";
import assert from "node:assert/strict";
import { cellIndex } from "../../scene/grid";
import { regionBounds, validateFloorPlan } from "../../scene/floorPlan";
import {
  DOOR_CELLS, DOOR_DEFAULT_CELLS, DOOR_FRAME_MM, DOOR_MAX_CELLS, DOOR_MIN_CELLS, doorWidthOk, equipmentRectangle,
  mergedDoors, nearestDoorWall, placeDoor, placeElevator, placeGate,
} from "../../scene/equipment";
import { createProject, projectForSave, validateProject } from "../../scene/model";
import { createSafety, pathProblem } from "../../scene/safety";
import type { Edge } from "../../scene/grid";
import type { Room, SceneMap } from "../../scene/types";
import { CELL_MM, SAFETY_RADIUS_MM } from "../../scene/units";

const EDGES: Edge[] = ["top", "bottom", "left", "right"];
const ids = (prefix = "equipment") => {
  let next = 0;
  return () => `${prefix}-${++next}`;
};
const region = (id: string, cells: number[], kind: Room["kind"] = "corridor", extras: Partial<Room> = {}): Room => ({
  id, name: id, cells, kind, color: "#739a81", material: "concrete", ...extras,
});
// Rows count from the bottom.
const rect = (x: number, y: number, width: number, height: number) =>
  Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, col) => cellIndex(x + col, y + row))).flat();
const plan = (cells: number[]): SceneMap => ({
  id: "map", name: "Plan", editGridMm: 20, doorMode: "story", tracks: [],
  rooms: [region("floor", cells)], floorPlan: { walls: [], doors: [], furniture: [] },
});
const fp = (map: SceneMap) => map.floorPlan!;
const length = (p: { x1: number; y1: number; x2: number; y2: number }) => Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
const addGate = (map: SceneMap, gate: ReturnType<typeof placeGate>) => {
  fp(map).walls!.push(...gate.walls);
  fp(map).doors.push(gate.door);
};
const newEv = () => region("new-ev", [], "room", { appearance: "elevator" });

test("new EVs keep entrance width exactly ten cells in every orientation and drag direction", () => {
  const start = cellIndex(20, 12);
  for (const entrance of EDGES) {
    for (const end of [cellIndex(3, 4), cellIndex(32, 16)]) {
      const bounds = regionBounds(equipmentRectangle(start, end, entrance, true));
      const horizontal = entrance === "top" || entrance === "bottom";
      assert.equal(horizontal ? bounds.width : bounds.height, 200);
      assert.equal(horizontal ? bounds.height : bounds.width,
        horizontal ? (Math.abs(Math.floor(end / 55) - 12) + 1) * 20 : (Math.abs((end % 55) - 20) + 1) * 20);
    }
  }
  assert.equal(equipmentRectangle(0, 0, "bottom", true).length, DOOR_CELLS);
  assert.throws(() => equipmentRectangle(cellIndex(54, 0), cellIndex(54, 0), "top", true), /10-cell/);
  assert.throws(() => equipmentRectangle(cellIndex(0, 30), cellIndex(0, 30), "left", true), /10-cell/);
  assert.throws(() => equipmentRectangle(-1, 0), /invalid/);
});

test("new boundary doors atomically add ten contiguous cells as one opening", () => {
  const starts: Record<Edge, number> = {
    bottom: cellIndex(2, 2), top: cellIndex(2, 13), left: cellIndex(2, 2), right: cellIndex(13, 2),
  };
  for (const edge of EDGES) {
    const map = plan(rect(2, 2, 12, 12)), before = structuredClone(map);
    const doors = placeDoor(map, { roomId: "floor", cell: starts[edge], edge }, ids());
    assert.deepEqual(map, before);
    assert.equal(doors.length, DOOR_CELLS);
    fp(map).doors.push(...doors);
    validateFloorPlan(map);
    const groups = mergedDoors(map);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].memberIds.length, DOOR_CELLS);
    const [x1, y1, x2, y2] = groups[0].points;
    assert.equal(length({ x1, y1, x2, y2 }), 200);
  }
});

test("EV placement cuts only corridor cells, adds the oriented entrance and preserves legacy EVs", () => {
  for (const entrance of EDGES) {
    const map = plan(rect(0, 0, 30, 20));
    map.rooms.push(newEv());
    const before = structuredClone(map);
    const cells = equipmentRectangle(cellIndex(4, 4), cellIndex(16, 8), entrance, true);
    const placed = placeElevator(map, "new-ev", cells, entrance, ids());
    assert.deepEqual(map, before);
    validateFloorPlan(placed);
    assert.equal(placed.rooms.reduce((sum, room) => sum + room.cells.length, 0), 600);
    assert.deepEqual(placed.rooms[1].cells, cells);
    assert.equal(placed.rooms[1].entranceEdge, entrance);
    assert.equal(fp(placed).doors.length, DOOR_CELLS);
    assert.equal(mergedDoors(placed)[0].edge, entrance);
    assert.throws(() => placeElevator(placed, "new-ev", cells, entrance, ids()), /existing elevator/);
  }
});

test("EV placement rejects blocked footprints without deleting existing furniture or walls", () => {
  const map = plan(rect(0, 0, 30, 20)), cells = rect(4, 4, 10, 3);
  map.rooms.push(newEv());
  fp(map).furniture.push({ id: "desk", roomId: "floor", type: "desk", rotation: 0, cell: cells[0] });
  const before = structuredClone(map);
  assert.throws(() => placeElevator(map, "new-ev", cells, "bottom", ids()), /furniture/);
  assert.deepEqual(map, before);
  fp(map).furniture = [];
  fp(map).walls!.push({ id: "wall", roomId: "floor", x1: 110, y1: 60, x2: 110, y2: 120 });
  assert.throws(() => placeElevator(map, "new-ev", cells, "bottom", ids()), /walls/);
  assert.throws(() => placeElevator(map, "new-ev", rect(4, 4, 6, 3), "bottom", ids()), /7-12-cell/);
});

test("short, wrapping, interrupted and already occupied boundaries reject without partial writes", () => {
  const interrupted = [0, 1, 2, 3, 5, 6, 7, 8, 9, 10];
  for (const cells of [rect(0, 0, 9, 2), rect(48, 0, 7, 2), interrupted]) {
    const map = plan(cells), before = structuredClone(map);
    assert.throws(() => placeDoor(map, { roomId: "floor", cell: cells[0], edge: "bottom" }, ids()), /10 contiguous/);
    assert.deepEqual(map, before);
  }
  const map = plan(rect(0, 0, 14, 4));
  fp(map).doors.push({ id: "legacy", roomId: "floor", cell: 3, edge: "bottom", kind: "automatic" });
  const before = structuredClone(map);
  assert.throws(() => placeDoor(map, { roomId: "floor", cell: 0, edge: "bottom" }, ids()), /only one door/);
  assert.deepEqual(map, before);
});

test("ten-cell door cannot cross different adjacent regions", () => {
  const map = plan(rect(0, 1, 12, 2));
  map.rooms.push(region("neighbor-a", rect(0, 0, 3, 1)), region("neighbor-b", rect(3, 0, 9, 1)));
  assert.throws(() => placeDoor(map, { roomId: "floor", cell: cellIndex(0, 1), edge: "bottom" }, ids()),
    /same adjacent region/);
  assert.equal(fp(map).doors.length, 0);
});

test("independent automatic doors are ten cells, never clipped to a short wall", () => {
  const map = plan(rect(0, 0, 30, 20));
  fp(map).walls!.push({ id: "wall", roomId: "floor", x1: 60, y1: 60, x2: 560, y2: 60 });
  const candidate = nearestDoorWall(map, 300, 60);
  const [door] = placeDoor(map, candidate, ids());
  assert.equal(door.x2! - door.x1!, 200);
  assert.equal(fp(map).doors.length, 0);
  fp(map).walls![0].x2 = 240;
  assert.throws(() => placeDoor(map, candidate, ids()), /10-cell/);
});

test("rectangular gate overlays reuse walls and flapper door without carving the floor", () => {
  for (const entrance of EDGES) {
    const map = plan(rect(0, 0, 30, 20)), before = structuredClone(map.rooms);
    const cells = equipmentRectangle(cellIndex(4, 3), cellIndex(11, 9), entrance);
    const gate = placeGate(map, cells, entrance, ids());
    assert.equal(gate.walls.length, 3);
    assert.equal(gate.door.kind, "flapper");
    const horizontal = entrance === "top" || entrance === "bottom";
    assert.equal(gate.door.y1 === gate.door.y2, horizontal);
    assert.deepEqual([gate.door.x1, gate.door.y1, gate.door.x2, gate.door.y2],
      horizontal ? [80, 130, 240, 130] : [160, 60, 160, 200]);
    addGate(map, gate);
    validateFloorPlan(map);
    assert.deepEqual(map.rooms, before);
  }
});

test("invalid gate overlays reject blank cells, multiple rooms, furniture, walls and non-rectangles atomically", () => {
  const map = plan(rect(0, 0, 12, 12)), cells = rect(2, 2, 7, 3);
  assert.throws(() => placeGate(map, rect(11, 11, 2, 2)), /same room/);
  assert.throws(() => placeGate(map, [0, 1, 55]), /rectangle/);
  fp(map).furniture.push({ id: "plant", type: "plant", roomId: "floor", cell: cells[0], rotation: 0 });
  const before = structuredClone(map);
  assert.throws(() => placeGate(map, cells), /furniture/);
  assert.deepEqual(map, before);
  fp(map).furniture = [];
  fp(map).walls!.push({ id: "wall", roomId: "floor", x1: 20, y1: 60, x2: 80, y2: 60 });
  assert.throws(() => placeGate(map, cells), /walls/);
});

test("save and validation preserve old equipment sizes and new opening groups", () => {
  const project = createProject("p", ids("project")), map = project.maps[0];
  Object.assign(map, plan(rect(0, 0, 30, 20)), { id: map.id });
  map.rooms.push(region("old-ev", rect(40, 2, 3, 4), "room", { appearance: "elevator" }));
  fp(map).doors.push({ id: "old-door", roomId: "floor", cell: cellIndex(15, 0), edge: "bottom" });
  const legacyRoom = structuredClone(map.rooms[1]), legacyDoor = structuredClone(fp(map).doors[0]);
  fp(map).doors.push(...placeDoor(map, { roomId: "floor", cell: 0, edge: "bottom" }, ids()));
  addGate(map, placeGate(map, rect(3, 3, 4, 7), "left", ids("gate")));
  const saved = validateProject(JSON.parse(JSON.stringify(projectForSave(project))));
  assert.deepEqual(saved.maps[0].rooms[1], legacyRoom);
  assert.deepEqual(fp(saved.maps[0]).doors[0], legacyDoor);
  assert.equal(mergedDoors(saved.maps[0]).length, 3);
  for (const door of fp(saved.maps[0]).doors.filter((item) => item.openingId)) {
    door.name = "Entrance";
    door.kind = "automatic";
  }
  assert.equal(mergedDoors(saved.maps[0]).find((door) => door.openingId)!.memberIds.length, DOOR_CELLS);
});

test("adjacent doors merge into a continuous opening without a central wall", () => {
  const p = plan([0, 1, 2, 55, 110]);
  fp(p).doors = [
    { id: "b", roomId: "floor", cell: 1, edge: "bottom" },
    { id: "a", roomId: "floor", cell: 0, edge: "bottom" },
  ];
  const before = structuredClone(p);
  assert.deepEqual(mergedDoors(p)[0].memberIds, ["a", "b"]);
  assert.deepEqual(mergedDoors(p)[0].opening, { x1: 4, y1: 0, x2: 36, y2: 0 });
  assert.deepEqual(p, before);
  fp(p).doors.push({ id: "c", roomId: "floor", cell: 2, edge: "bottom" });
  assert.equal(mergedDoors(p)[0].memberIds.length, 3);
  fp(p).doors = [
    { id: "a", roomId: "floor", cell: 0, edge: "left" },
    { id: "b", roomId: "floor", cell: 55, edge: "left" },
    { id: "c", roomId: "floor", cell: 2, edge: "bottom" },
  ];
  assert.equal(mergedDoors(p).length, 2);
  assert.deepEqual(mergedDoors(p).find((door) => door.memberIds.length === 2)!.opening, { x1: 0, y1: 4, x2: 0, y2: 36 });
  fp(p).doors = [
    { id: "a", roomId: "floor", cell: 0, edge: "bottom" },
    { id: "b", roomId: "floor", cell: 2, edge: "bottom" },
  ];
  assert.equal(mergedDoors(p).length, 2);
});

test("door snapping finds walls from either side, outer border and shared walls", () => {
  const p = plan([]);
  p.rooms = [region("left", [56, 111], "room"), region("right", [57, 112], "room")];
  assert.deepEqual(nearestDoorWall(p, 39, 30), { roomId: "left", cell: 56, edge: "right" });
  assert.deepEqual(nearestDoorWall(p, 41, 30, { roomId: "left" }), { roomId: "left", cell: 56, edge: "right" });
  assert.deepEqual(nearestDoorWall(p, 19, 30), { roomId: "left", cell: 56, edge: "left" });
  assert.equal(nearestDoorWall(p, 500, 500), null);
  assert.equal(nearestDoorWall(p, 39, 40, { edge: "bottom", maxDistance: 7 }), null);
  const border = plan([0]);
  assert.deepEqual(nearestDoorWall(border, 0, 10), { roomId: "floor", cell: 0, edge: "left" });
  assert.deepEqual(nearestDoorWall(border, 44, 10), { roomId: "floor", cell: 0, edge: "right" });
  assert.equal(nearestDoorWall(border, 45, 10), null);
  assert.throws(() => nearestDoorWall(p, NaN, 0));
});

test("independent wall snapping proposes a grid-aligned 200mm candidate", () => {
  const p = plan(rect(0, 0, 55, 31));
  fp(p).walls = [{ id: "partition", roomId: "floor", name: "Corridor divider", x1: 20, y1: 300, x2: 360, y2: 300 }];
  const candidate = nearestDoorWall(p, 190, 300, { maxDistance: 1 });
  assert.ok(candidate && "independent" in candidate);
  assert.deepEqual([candidate.x1, candidate.y1, candidate.x2, candidate.y2], [80, 300, 280, 300]);
  fp(p).doors.push(...placeDoor(p, candidate, ids()));
  validateFloorPlan(p);
});

test("effective opening 200 - 2*4 = 192mm matches the merged opening and fits the safety circle", () => {
  assert.equal(DOOR_CELLS * 20 - 2 * DOOR_FRAME_MM, 192);
  const map = plan(rect(0, 0, 30, 20));
  fp(map).doors.push(...placeDoor(map, { roomId: "floor", cell: 0, edge: "bottom" }, ids()));
  fp(map).walls!.push({ id: "wall", roomId: "floor", x1: 60, y1: 200, x2: 560, y2: 200 });
  fp(map).doors.push(...placeDoor(map, nearestDoorWall(map, 300, 200), ids("wall-door")));
  const groups = mergedDoors(map);
  assert.equal(groups.length, 2);
  for (const group of groups) {
    assert.equal(length(group.opening), 192);
    assert.ok(length(group.opening) > 2 * SAFETY_RADIUS_MM);
  }
});

test("doors on walls shorter than ten cells are rejected with a reason", () => {
  const short = plan(rect(0, 0, 9, 3));
  assert.throws(() => placeDoor(short, { roomId: "floor", cell: 0, edge: "bottom" }, ids()),
    { message: "automatic doors need 10 contiguous cells on the same outer edge" });
  const walled = plan(rect(0, 0, 30, 20));
  fp(walled).walls!.push({ id: "wall", roomId: "floor", x1: 60, y1: 60, x2: 240, y2: 60 });
  assert.throws(() => placeDoor(walled, nearestDoorWall(walled, 150, 60), ids()),
    { message: "automatic doors need a continuous 10-cell (200mm) wall" });
});

test("merging adjacent doors keeps the original IDs in memberIds", () => {
  const map = plan(rect(0, 0, 30, 20));
  const doors = placeDoor(map, { roomId: "floor", cell: cellIndex(0, 19), edge: "top" }, ids());
  fp(map).doors.push(...doors);
  const [group] = mergedDoors(map);
  assert.deepEqual(group.memberIds, doors.map((door) => door.id));
  assert.equal(group.id, doors[0].id);
  assert.equal(group.openingId, doors[0].openingId);
});

test("selectable door width: 7..12 cells (140..240mm), 20mm steps, 10 by default", () => {
  assert.deepEqual([DOOR_MIN_CELLS, DOOR_MAX_CELLS, DOOR_DEFAULT_CELLS, DOOR_CELLS], [7, 12, 10, 10]);
  assert.equal(DOOR_FRAME_MM, 4);
  for (const cells of [7, 8, 9, 10, 11, 12]) assert.equal(doorWidthOk(cells), true, `${cells}`);
  for (const cells of [-1, 0, 5, 6, 13, 7.5, NaN, Infinity]) assert.equal(doorWidthOk(cells), false, `${cells}`);
});

test("the narrowest allowed opening still fits the safety circle (invariant for any constant change)", () => {
  assert.ok(DOOR_MIN_CELLS * CELL_MM - 2 * DOOR_FRAME_MM >= 2 * SAFETY_RADIUS_MM);
  assert.equal(DOOR_MIN_CELLS * CELL_MM - 2 * DOOR_FRAME_MM, 132);
  assert.ok((DOOR_MIN_CELLS - 1) * CELL_MM - 2 * DOOR_FRAME_MM < 2 * SAFETY_RADIUS_MM);
});

test("edge doors take the requested width and the opening shrinks by the frame on both ends", () => {
  for (const cells of [7, 8, 10, 12]) {
    const map = plan(rect(2, 2, 14, 14)), before = structuredClone(map);
    const doors = placeDoor(map, { roomId: "floor", cell: cellIndex(2, 2), edge: "bottom" }, ids(), cells);
    assert.deepEqual(map, before);
    assert.equal(doors.length, cells);
    fp(map).doors.push(...doors);
    validateFloorPlan(map);
    const [group] = mergedDoors(map);
    assert.equal(group.memberIds.length, cells);
    assert.equal(length(group.opening), cells * CELL_MM - 2 * DOOR_FRAME_MM);
  }
});

test("a door narrower than 7 or wider than 12 cells is refused before anything is written", () => {
  for (const cells of [5, 6, 13, 7.5]) {
    const map = plan(rect(2, 2, 14, 14)), before = structuredClone(map);
    assert.throws(() => placeDoor(map, { roomId: "floor", cell: cellIndex(2, 2), edge: "bottom" }, ids(), cells), /7-12/);
    assert.deepEqual(map, before);
  }
});

test("a robot passes the narrowest door along the centre line and a 6-cell opening is never offered", () => {
  const map = plan([]);
  map.rooms = [region("left", rect(0, 5, 20, 20), "room"), region("right", rect(20, 5, 20, 20), "room")];
  const doors = placeDoor(map, { roomId: "left", cell: cellIndex(19, 12), edge: "right" }, ids(), DOOR_MIN_CELLS);
  fp(map).doors.push(...doors);
  const [group] = mergedDoors(map);
  const y = (group.opening.y1 + group.opening.y2) / 2;
  assert.equal(pathProblem(createSafety(map), { x: 300, y }, { x: 500, y }, "robot"), "");
  assert.throws(() => placeDoor(plan(rect(0, 0, 20, 20)), { roomId: "floor", cell: 0, edge: "bottom" }, ids(), 6), /7-12/);
});

test("gates and EVs take a selectable entrance width and refuse out-of-range widths", () => {
  for (const cells of [7, 9, 12]) {
    const map = plan(rect(0, 0, 40, 25)), gateCells = rect(4, 3, cells, 4);
    const gate = placeGate(map, gateCells, "bottom", ids());
    assert.equal(gate.door.x2! - gate.door.x1!, cells * CELL_MM);
    const ev = plan(rect(0, 0, 40, 25));
    ev.rooms.push(newEv());
    const evCells = equipmentRectangle(cellIndex(4, 4), cellIndex(20, 8), "bottom", true, cells);
    assert.equal(regionBounds(evCells).width, cells * CELL_MM);
    const placed = placeElevator(ev, "new-ev", evCells, "bottom", ids());
    assert.equal(mergedDoors(placed)[0].memberIds.length, cells);
  }
  for (const cells of [6, 13]) {
    assert.throws(() => placeGate(plan(rect(0, 0, 40, 25)), rect(4, 3, cells, 4), "bottom", ids()), /7-12/);
    assert.throws(() => equipmentRectangle(cellIndex(4, 4), cellIndex(20, 8), "bottom", true, cells), /7-12/);
  }
});

test("independent-wall doors take the requested width, and 200mm legacy doors still validate", () => {
  const map = plan(rect(0, 0, 40, 25));
  fp(map).walls!.push({ id: "wall", roomId: "floor", x1: 60, y1: 200, x2: 660, y2: 200 });
  const candidate = nearestDoorWall(map, 300, 200, { cells: 7 });
  assert.ok(candidate && "independent" in candidate);
  assert.equal(candidate.x2 - candidate.x1, 7 * CELL_MM);
  const [door] = placeDoor(map, candidate, ids(), 7);
  assert.equal(door.x2! - door.x1!, 7 * CELL_MM);
  const legacy = plan(rect(0, 0, 30, 20));
  fp(legacy).doors.push(...Array.from({ length: 5 }, (_, i) =>
    ({ id: `five-${i}`, openingId: "five", roomId: "floor", cell: i, edge: "bottom" as Edge })));
  assert.doesNotThrow(() => validateFloorPlan(legacy));
  assert.equal(length(mergedDoors(legacy)[0].opening), 5 * CELL_MM - 2 * DOOR_FRAME_MM);
});
