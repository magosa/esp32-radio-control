import test from "node:test";
import assert from "node:assert/strict";
import { cellCenter, cellIndex } from "../../scene/grid";
import {
  boundaryEdge, furnitureCells, regionBounds, removeRegion, roomAnchor, roomContainsPoint, rotateFurniture,
  validateFloorPlan,
} from "../../scene/floorPlan";
import type { Door, Furniture, Room, SceneMap, Track } from "../../scene/types";
import { ROWS } from "../../scene/units";

// Upstream rows count from the top; T(col, k) is the k-th row below the top row.
const T = (col: number, k: number) => cellIndex(col, ROWS - 1 - k);
const region = (id: string, cells: number[], extras: Partial<Room> = {}): Room => ({
  id, name: id, color: "#739a81", kind: "room", material: "concrete", cells: [...cells], ...extras,
});
const map = (...rooms: Room[]): SceneMap => ({
  id: "map", name: "Plan", editGridMm: 20, doorMode: "story", rooms, tracks: [],
  floorPlan: { doors: [], furniture: [] },
});
const plan = (value: SceneMap) => value.floorPlan!;
const L_SHAPE = [T(0, 0), T(0, 1), T(0, 2), T(1, 2), T(2, 2)];

test("grid bounds use bottom-row indices and bottom-left mm", () => {
  assert.deepEqual(regionBounds([0]), { x: 0, y: 0, width: 20, height: 20 });
  assert.deepEqual(regionBounds([1704]), { x: 1080, y: 600, width: 20, height: 20 });
  assert.deepEqual(regionBounds([T(0, 0), T(1, 0), T(0, 1), T(0, 2)]), { x: 0, y: 560, width: 40, height: 60 });
  assert.deepEqual(regionBounds([0, 1704]), { x: 0, y: 0, width: 1100, height: 620 });
  for (const cells of [[], [1705], [-1], [1.5], ["1"], [NaN], [Infinity], null]) {
    assert.throws(() => regionBounds(cells as number[]));
  }
});

test("top-row room bounds sit at y=600 with height 20", () => {
  assert.deepEqual(regionBounds([T(3, 0), T(4, 0)]), { x: 60, y: 600, width: 40, height: 20 });
});

test("actual L-shaped occupancy excludes the missing bbox corner", () => {
  const room = region("L", L_SHAPE);
  assert.equal(roomContainsPoint(room, 10, 610), true);
  assert.equal(roomContainsPoint(room, 50, 570), true);
  assert.equal(roomContainsPoint(room, 50, 610), false);
  assert.equal(roomContainsPoint(room, 30, 590), false);
  assert.equal(roomContainsPoint(room, -1, 610), false);
  assert.equal(roomContainsPoint(room, Infinity, 0), false);
  assert.equal(roomContainsPoint(room, 0, NaN), false);
  assert.equal(roomContainsPoint(room, "10" as unknown as number, 610), false);
  const anchor = roomAnchor(room);
  assert.equal(roomContainsPoint(room, anchor.x, anchor.y), true);
  assert.deepEqual(anchor, { x: 10, y: 590 });
});

test("L-shaped room rejects the empty cell center inside its bounding box", () => {
  const room = region("L", L_SHAPE);
  const empty = cellCenter(T(1, 0));
  assert.equal(roomContainsPoint(room, empty.x, empty.y), false);
});

test("anchor selects a cell interior even for a ring with a hole", () => {
  const room = region("ring", [T(0, 0), T(1, 0), T(2, 0), T(0, 1), T(2, 1), T(0, 2), T(1, 2), T(2, 2)]);
  assert.equal(roomContainsPoint(room, 30, 590), false);
  const anchor = roomAnchor(room);
  assert.equal(roomContainsPoint(room, anchor.x, anchor.y), true);
  assert.ok(room.cells.some((cell) => cellCenter(cell).x === anchor.x && cellCenter(cell).y === anchor.y));
  assert.equal((anchor.x - 30) ** 2 + (anchor.y - 590) ** 2, 400);
});

test("ownership validates cell polygons instead of overlapping bounding boxes", () => {
  const a = region("a", L_SHAPE);
  const b = region("b", [T(1, 0), T(2, 0), T(1, 1), T(2, 1)]);
  assert.equal(validateFloorPlan(map(a, b)).rooms.length, 2);
  assert.throws(() => validateFloorPlan(map(a, region("b", [T(0, 1), T(1, 1)]))), /overlap/);
  assert.throws(() => validateFloorPlan(map(region("a", [0, 0]))), /duplicated/);
  assert.throws(() => validateFloorPlan(map({ ...a, cells: [] })), /cells/);
  assert.throws(() => validateFloorPlan(map({ ...a, cells: [1705] })), /cells/);
});

test("doors belong to occupied cell boundaries and shared-wall doors are unique", () => {
  const room = region("a", [T(0, 0), T(1, 0), T(0, 1)]);
  assert.equal(boundaryEdge(room, T(0, 0), "top"), true);
  assert.equal(boundaryEdge(room, T(0, 0), "right"), false);
  assert.equal(boundaryEdge(room, T(0, 0), "bottom"), false);
  assert.equal(boundaryEdge(room, T(1, 0), "bottom"), true);
  assert.equal(boundaryEdge(room, T(1, 1), "top"), false);
  const value = map(room, region("b", [T(2, 0)]));
  plan(value).doors.push({ id: "door", roomId: "a", cell: T(1, 0), edge: "right" });
  assert.equal(validateFloorPlan(value), value);
  plan(value).doors.push({ id: "other", roomId: "b", cell: T(2, 0), edge: "left" });
  assert.throws(() => validateFloorPlan(value), /one door per/);
  for (const change of [
    { edge: "inside" }, { edge: "left", cell: T(1, 0) }, { cell: T(1, 1) }, { cell: 0.5 },
    { roomId: "missing" }, { cell: String(T(1, 0)) },
  ]) {
    const trial = map(room);
    plan(trial).doors = [{ id: "door", roomId: "a", cell: T(1, 0), edge: "top", ...change } as Door];
    assert.throws(() => validateFloorPlan(trial));
  }
});

test("furniture validates occupancy and unique cell", () => {
  const value = map(region("a", L_SHAPE));
  for (const [index, type] of [[0, "desk"], [1, "chair"], [2, "plant"]] as const) {
    plan(value).furniture.push({ id: `item-${index}`, roomId: "a", cell: T(0, index), type, rotation: (index * 90) as Furniture["rotation"] });
  }
  assert.equal(validateFloorPlan(value), value);
  for (const change of [{ cell: T(1, 0) }, { cell: -1 }, { cell: Infinity }, { cell: String(T(0, 0)) }, { roomId: "missing" }]) {
    const trial = structuredClone(value);
    Object.assign(plan(trial).furniture[0], change);
    assert.throws(() => validateFloorPlan(trial));
  }
  plan(value).furniture.push({ id: "duplicate", roomId: "a", cell: T(0, 0), type: "desk", rotation: 0 });
  assert.throws(() => validateFloorPlan(value), /one furniture item per cell/);
});

test("multi-cell furniture roundtrips and rejects overlap and malformed footprints", () => {
  const p = map(region("room", [0, 1, 2].flatMap((k) => [T(0, k), T(1, k), T(2, k)])));
  const footprint = [T(0, 1), T(1, 1), T(0, 0), T(1, 0)];
  for (const type of ["desk", "chair", "plant"] as const) {
    plan(p).furniture = [{ id: "item", roomId: "room", cell: T(0, 1), cells: footprint, type, rotation: 0 }];
    const before = structuredClone(p);
    assert.deepEqual(validateFloorPlan(JSON.parse(JSON.stringify(p))), before);
    const overlapping = structuredClone(p);
    plan(overlapping).furniture.push({ id: "other", roomId: "room", cell: T(1, 1), type: "plant", rotation: 0 });
    assert.throws(() => validateFloorPlan(overlapping), /one furniture item per cell/);
    for (const cells of [[], null, [T(0, 1), T(0, 1)], [T(0, 1), T(1, 0)], [T(0, 1), T(1, 1), T(0, 0)], [T(0, 1), 1705], [T(1, 1), T(2, 1)]]) {
      const trial = structuredClone(p);
      plan(trial).furniture[0].cells = cells as number[];
      assert.throws(() => validateFloorPlan(trial));
    }
  }
  plan(p).furniture[0].cells = [T(2, 0), T(3, 0)];
  plan(p).furniture[0].cell = T(2, 0);
  assert.throws(() => validateFloorPlan(p), /within one room/);
});

test("furniture cannot cross a room boundary or a hole", () => {
  const p = map(region("a", [T(0, 0), T(0, 1)]), region("b", [T(1, 0), T(1, 1)]));
  plan(p).furniture = [{ id: "item", roomId: "a", cell: T(0, 0), cells: [T(0, 0), T(1, 0)], type: "desk", rotation: 0 }];
  assert.throws(() => validateFloorPlan(p), /within one room/);
  const hole = map(region("a", [T(0, 0), T(1, 0), T(0, 1)]));
  hole.floorPlan = plan(p);
  Object.assign(plan(hole).furniture[0], { cell: T(0, 1), cells: [T(0, 1), T(1, 1), T(0, 0), T(1, 0)] });
  assert.throws(() => validateFloorPlan(hole), /within one room/);
});

test("rotation swaps the footprint and rejects blocked or out-of-map results", () => {
  const item: Furniture = { id: "item", roomId: "room", cell: T(0, 0), cells: [T(0, 0), T(1, 0), T(2, 0)], type: "desk", rotation: 0 };
  const before = structuredClone(item);
  const rotated = rotateFurniture(item, 90);
  assert.deepEqual(rotated.cells, [T(0, 2), T(0, 1), T(0, 0)]);
  assert.equal(rotated.cell, T(0, 2));
  assert.deepEqual(rotateFurniture(rotated, 0), item);
  assert.deepEqual(item, before);
  const p = map(region("room", [T(0, 0), T(1, 0), T(2, 0), T(0, 1), T(0, 2)]));
  plan(p).furniture = [rotated];
  assert.equal(validateFloorPlan(p), p);
  plan(p).furniture.push({ id: "other", roomId: "room", cell: T(0, 1), type: "plant", rotation: 0 });
  assert.throws(() => validateFloorPlan(p), /one furniture item per cell/);
  assert.throws(() => rotateFurniture({ ...item, cell: 0, cells: [0, 1, 2] }, 90), /outside the map/);
  assert.deepEqual(furnitureCells({ cell: 10 }), [10]);
});

test("furniture rotated 90 degrees out of its room is rejected", () => {
  const p = map(region("room", [T(0, 0), T(1, 0), T(2, 0)]));
  const item: Furniture = { id: "item", roomId: "room", cell: T(0, 0), cells: [T(0, 0), T(1, 0), T(2, 0)], type: "desk", rotation: 0 };
  plan(p).furniture = [item];
  assert.equal(validateFloorPlan(p), p);
  plan(p).furniture = [rotateFurniture(item, 90)];
  assert.throws(() => validateFloorPlan(p), /within one room/);
});

test("named partition walls and corridor doors persist as mm Y-up segments", () => {
  const p = map(region("hall", [0, 1, 2].flatMap((col) => [T(col, 0), T(col, 1)]), { kind: "corridor" }));
  plan(p).walls = [{ id: "partition", roomId: "hall", name: "Reception partition", x1: 10, y1: 610, x2: 150, y2: 610 }];
  plan(p).doors = [{ id: "gate", roomId: "hall", wallId: "partition", name: "North entrance", kind: "flapper", x1: 50, y1: 610, x2: 90, y2: 610 }];
  const before = structuredClone(p);
  assert.deepEqual(validateFloorPlan(JSON.parse(JSON.stringify(p))), before);
  const door = plan(p).doors[0];
  const wall = plan(p).walls![0];
  assert.throws(() => validateFloorPlan({ ...p, floorPlan: { ...plan(p), doors: [{ ...door, wallId: "missing" }] } }), /wall not found/);
  assert.throws(() => validateFloorPlan({ ...p, floorPlan: { ...plan(p), walls: [{ ...wall, y2: 590 }] } }), /horizontal or vertical/);
  assert.throws(() => validateFloorPlan({ ...p, floorPlan: { ...plan(p), walls: [{ ...wall, y1: 621, y2: 621 }] } }), /horizontal or vertical/);
  assert.throws(() => validateFloorPlan({
    ...p, floorPlan: { ...plan(p), doors: [door, { ...door, id: "overlap", x1: 80, x2: 120 }] },
  }), /overlap/);
  assert.throws(() => validateFloorPlan({ ...p, floorPlan: { ...plan(p), doors: [{ ...door, x2: 58 }] } }), /longer than/);
  assert.throws(() => validateFloorPlan({ ...p, floorPlan: { ...plan(p), doors: [{ ...door, x1: 140, x2: 170 }] } }), /within its wall/);
});

test("JSON roundtrip preserves IDs, references, polygons and fixtures", () => {
  const value = map(region("a", L_SHAPE, { material: "wood" }));
  value.tracks.push({ id: "track", roomId: "a", initial: { roomId: "a" }, actions: [{ roomId: "a" }] } as unknown as Track);
  plan(value).doors.push({ id: "door", roomId: "a", cell: T(0, 0), edge: "left" });
  plan(value).furniture.push({ id: "plant", roomId: "a", cell: T(0, 2), type: "plant", rotation: 270 });
  const before = structuredClone(value);
  assert.deepEqual(validateFloorPlan(JSON.parse(JSON.stringify(value))), before);
  assert.deepEqual(value, before);
});

test("unreferenced region deletion removes fixtures without mutating the input", () => {
  const value = map(region("a", [T(0, 0)]), region("b", [T(1, 0)]));
  plan(value).doors.push({ id: "door", roomId: "a", cell: T(0, 0), edge: "top" });
  plan(value).furniture.push(
    { id: "plant", roomId: "a", cell: T(0, 0), type: "plant", rotation: 0 },
    { id: "desk", roomId: "b", cell: T(1, 0), type: "desk", rotation: 0 },
  );
  plan(value).walls = [{ id: "wall", roomId: "a", x1: 0, y1: 610, x2: 20, y2: 610 }];
  plan(value).doors.push({ id: "wall-door", roomId: "a", wallId: "wall", x1: 0, y1: 610, x2: 20, y2: 610 });
  const before = structuredClone(value);
  const result = removeRegion(value, "a");
  assert.deepEqual(result.rooms.map((room) => room.id), ["b"]);
  assert.deepEqual(plan(result).doors, []);
  assert.deepEqual(plan(result).walls, []);
  assert.deepEqual(plan(result).furniture.map((item) => item.id), ["desk"]);
  assert.equal(validateFloorPlan(result), result);
  assert.deepEqual(value, before);
  assert.throws(() => removeRegion(value, "missing"), /not found/);
});

test("region deletion protects direct track, initial and action room references", () => {
  for (const track of [{ roomId: "a" }, { initial: { roomId: "a" } }, { actions: [{ roomId: "b" }, { roomId: "a" }] }]) {
    const value = map(region("a", [T(0, 0)]), region("b", [T(1, 0)]));
    value.tracks.push(track as unknown as Track);
    const before = structuredClone(value);
    assert.throws(() => removeRegion(value, "a"), /referenced/);
    assert.deepEqual(value, before);
  }
});
