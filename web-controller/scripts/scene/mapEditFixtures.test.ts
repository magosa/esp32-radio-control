import test from "node:test";
import assert from "node:assert/strict";
import { cellIndex } from "../../scene/grid";
import { regionBounds, validateFloorPlan } from "../../scene/floorPlan";
import { mergedDoors } from "../../scene/equipment";
import {
  addChargingZone, addDoorAt, addFurniture, addGate, addPartitionWall, deleteFixture, previewDoorAt,
  renameFixture, rotateFurnitureBy, setDoorKind, setFurnitureRotation,
} from "../../scene/mapEditFixtures";
import { createSafety, pathProblem } from "../../scene/safety";
import type { Room, SceneMap } from "../../scene/types";

const ids = (prefix = "fx") => {
  let next = 0;
  return () => `${prefix}-${++next}`;
};
const region = (id: string, cells: number[], kind: Room["kind"] = "room"): Room => ({
  id, name: id, cells, kind, color: "#739a81", material: "concrete",
});
// Rows count from the bottom.
const rect = (x: number, y: number, width: number, height: number) =>
  Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, col) => cellIndex(x + col, y + row))).flat();
const plan = (cells: number[]): SceneMap => ({
  id: "map", name: "Plan", editGridMm: 20, doorMode: "story", tracks: [],
  rooms: [region("floor", cells)], floorPlan: { walls: [], doors: [], furniture: [] },
});
const fp = (map: SceneMap) => map.floorPlan!;
// Runs the call and proves the input was left untouched; returns the call's result.
const pure = <T>(map: SceneMap, call: () => T): T => {
  const before = structuredClone(map);
  try {
    return call();
  } finally {
    assert.deepEqual(map, before);
  }
};
const DOOR_OPTS = { roomId: "floor", edge: "bottom" as const, maxDistance: 24 };
// Clicking the bottom-left of cell (2,2) of rect(2,2,14,14).
const addBottomDoor = (map: SceneMap, cells: number, makeId = ids()) =>
  addDoorAt(map, 50, 40, { ...DOOR_OPTS, cells }, makeId);

test("doors of 7 and 12 cells are placed as one opening; 6 and 13 are rejected without changes", () => {
  for (const cells of [7, 12]) {
    const map = plan(rect(2, 2, 14, 14));
    const placed = pure(map, () => addBottomDoor(map, cells));
    assert.equal(fp(placed.map).doors.length, cells);
    assert.equal(placed.roomId, "floor");
    assert.equal(placed.doorId, fp(placed.map).doors[0].id);
    validateFloorPlan(placed.map);
    const groups = mergedDoors(placed.map);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].memberIds.length, cells);
  }
  for (const cells of [6, 13]) {
    const map = plan(rect(2, 2, 14, 14));
    pure(map, () => assert.throws(() => addBottomDoor(map, cells)));
  }
});

test("previewDoorAt returns segments where addDoorAt succeeds and null (never throws) where it fails", () => {
  const map = plan(rect(2, 2, 14, 14));
  const segments = pure(map, () => previewDoorAt(map, 50, 40, { ...DOOR_OPTS, cells: 7 }));
  assert.equal(segments!.length, 7);
  assert.deepEqual(segments![0], { x1: 40, y1: 40, x2: 60, y2: 40 });
  assert.deepEqual(segments![6], { x1: 160, y1: 40, x2: 180, y2: 40 });
  // Far from every wall.
  assert.throws(() => addDoorAt(map, 160, 160, { ...DOOR_OPTS, cells: 7 }));
  assert.equal(previewDoorAt(map, 160, 160, { ...DOOR_OPTS, cells: 7 }), null);
  // Out-of-range width.
  assert.throws(() => addBottomDoor(map, 6));
  assert.equal(previewDoorAt(map, 50, 40, { ...DOOR_OPTS, cells: 6 }), null);
  // Seven cells do not fit along a five-cell edge.
  const small = plan(rect(2, 2, 5, 5));
  assert.throws(() => addBottomDoor(small, 7));
  assert.equal(previewDoorAt(small, 50, 40, { ...DOOR_OPTS, cells: 7 }), null);
});

test("independent-wall doors preview and place at the requested width", () => {
  const map = plan(rect(0, 0, 40, 25));
  fp(map).walls!.push({ id: "wall", roomId: "floor", x1: 60, y1: 200, x2: 660, y2: 200 });
  const opts = { roomId: "floor", edge: "auto" as const, cells: 7, maxDistance: 24 };
  const segments = pure(map, () => previewDoorAt(map, 300, 200, opts));
  assert.equal(segments!.length, 1);
  assert.equal(segments![0].x2 - segments![0].x1, 140);
  const placed = addDoorAt(map, 300, 200, opts, ids());
  assert.equal(fp(placed.map).doors[0].wallId, "wall");
  assert.equal(fp(placed.map).doors[0].x1, segments![0].x1);
});

test("a robot passes a 7-cell door placed between two rooms", () => {
  const map = plan([]);
  map.rooms = [region("left", rect(0, 5, 20, 20)), region("right", rect(20, 5, 20, 20))];
  const placed = addDoorAt(map, 400, 250, { roomId: "left", edge: "right", cells: 7, maxDistance: 24 }, ids());
  const [group] = mergedDoors(placed.map);
  assert.equal(group.memberIds.length, 7);
  const y = (group.opening.y1 + group.opening.y2) / 2;
  assert.equal(pathProblem(createSafety(placed.map), { x: 300, y }, { x: 500, y }, "robot"), "");
});

test("gates of 7 and 12 cells are placed with three walls and a door; 6, 13 and mismatches are rejected", () => {
  for (const [cells, entrance] of [[7, "bottom"], [12, "bottom"], [7, "left"]] as const) {
    const map = plan(rect(0, 0, 40, 25));
    const gateCells = entrance === "bottom" ? rect(4, 3, cells, 4) : rect(4, 3, 4, cells);
    const placed = pure(map, () => addGate(map, gateCells, entrance, cells, ids()));
    assert.equal(fp(placed.map).walls!.length, 3);
    assert.equal(fp(placed.map).doors.length, 1);
    assert.equal(fp(placed.map).doors[0].id, placed.doorId);
    assert.equal(fp(placed.map).doors[0].kind, "flapper");
    assert.equal(placed.roomId, "floor");
    validateFloorPlan(placed.map);
  }
  for (const cells of [6, 13]) {
    const map = plan(rect(0, 0, 40, 25));
    pure(map, () => assert.throws(() => addGate(map, rect(4, 3, cells, 4), "bottom", cells, ids()),
      /入口幅は7〜12マスで指定してください。/));
  }
  const map = plan(rect(0, 0, 40, 25));
  pure(map, () => assert.throws(() => addGate(map, rect(4, 3, 8, 4), "bottom", 7, ids()), /入口幅が指定と一致しません。/));
});

test("partition walls lie on the cell centre line and round to horizontal or vertical", () => {
  const map = plan(rect(0, 0, 30, 20));
  assert.throws(() => addPartitionWall(map, cellIndex(3, 3), cellIndex(3, 3)), /2セル以上/);
  const horizontal = pure(map, () => addPartitionWall(map, cellIndex(3, 3), cellIndex(10, 5), ids()));
  const wall = fp(horizontal.map).walls![0];
  assert.deepEqual([wall.x1, wall.y1, wall.x2, wall.y2], [70, 70, 210, 70]);
  assert.equal(wall.name, "Partition wall 1");
  assert.equal(wall.roomId, "floor");
  assert.equal(horizontal.wallId, wall.id);
  const vertical = addPartitionWall(horizontal.map, cellIndex(3, 3), cellIndex(4, 9), ids("v"));
  const second = fp(vertical.map).walls![1];
  assert.deepEqual([second.x1, second.y1, second.x2, second.y2], [70, 70, 70, 190]);
  assert.equal(second.name, "Partition wall 2");
  validateFloorPlan(vertical.map);
  assert.throws(() => addPartitionWall(map, cellIndex(40, 3), cellIndex(45, 3)), /領域を選択/);
});

test("partition wall warns only when shorter than the 120mm safety circle", () => {
  const map = plan(rect(0, 0, 30, 20));
  const lengthAndWarning = (to: number) => {
    const result = addPartitionWall(map, cellIndex(3, 3), cellIndex(to, 3), ids());
    const wall = fp(result.map).walls![0];
    return { length: wall.x2 - wall.x1, warning: result.warning };
  };
  assert.deepEqual(lengthAndWarning(8), { length: 100, warning: "安全円(直径120mm)より短い壁です。" });
  assert.deepEqual(lengthAndWarning(9), { length: 120, warning: null });
  assert.deepEqual(lengthAndWarning(10), { length: 140, warning: null });
  assert.deepEqual(lengthAndWarning(4), { length: 20, warning: "安全円(直径120mm)より短い壁です。" });
});

test("furniture accepts 1x1, 2x3, top-row and right-column cells and rejects bad placements", () => {
  const map = plan(rect(0, 0, 30, 20));
  const one = pure(map, () => addFurniture(map, [cellIndex(5, 5)], "plant", 0, ids()));
  assert.deepEqual(fp(one.map).furniture[0], {
    id: one.itemId, roomId: "floor", cell: cellIndex(5, 5), cells: [cellIndex(5, 5)], type: "plant", rotation: 0,
  });
  const desk = addFurniture(one.map, rect(10, 5, 2, 3).reverse(), "desk", 90, ids("d"));
  const item = fp(desk.map).furniture[1];
  assert.deepEqual(item.cells, rect(10, 5, 2, 3));
  assert.equal(item.cell, cellIndex(10, 5));
  assert.equal(item.rotation, 90);
  assert.equal(desk.roomId, "floor");
  const edges = addFurniture(addFurniture(map, [cellIndex(10, 19)], "chair", 0, ids("t")).map,
    [cellIndex(29, 5)], "chair", 0, ids("r"));
  assert.equal(fp(edges.map).furniture.length, 2);
  pure(map, () => assert.throws(() => addFurniture(map, [cellIndex(40, 3)], "plant", 0, ids()), /領域内/));
  pure(one.map, () => assert.throws(() => addFurniture(one.map, [cellIndex(5, 5)], "plant", 0, ids("x"))));
  pure(map, () => assert.throws(() => addFurniture(map, rect(29, 5, 2, 1), "desk", 0, ids())));
});

test("rotating furniture swaps its footprint; a rotation that leaves the room is rejected and changes nothing", () => {
  const map = plan(rect(0, 0, 10, 10));
  const desk = addFurniture(map, rect(2, 2, 2, 3), "desk", 0, ids()).map;
  const itemId = fp(desk).furniture[0].id;
  const rotated = pure(desk, () => rotateFurnitureBy(desk, itemId, 1));
  const item = fp(rotated).furniture[0];
  assert.equal(item.rotation, 90);
  assert.deepEqual([regionBounds(item.cells!).width, regionBounds(item.cells!).height], [60, 40]);
  const twice = rotateFurnitureBy(desk, itemId, 2);
  assert.equal(fp(twice).furniture[0].rotation, 180);
  assert.deepEqual([regionBounds(fp(twice).furniture[0].cells!).width, regionBounds(fp(twice).furniture[0].cells!).height], [40, 60]);
  assert.equal(fp(rotateFurnitureBy(desk, itemId, -1)).furniture[0].rotation, 270);
  assert.equal(fp(setFurnitureRotation(desk, itemId, 180)).furniture[0].rotation, 180);
  pure(desk, () => assert.throws(() => rotateFurnitureBy(desk, "missing", 1), /回転する家具を「選択」でクリックしてください。/));
  pure(desk, () => assert.throws(() => setFurnitureRotation(desk, "missing", 90), /回転する家具/));
  const edge = addFurniture(map, rect(8, 5, 2, 3), "desk", 0, ids("e")).map;
  const edgeId = fp(edge).furniture[0].id;
  pure(edge, () => assert.throws(() => rotateFurnitureBy(edge, edgeId, 1)));
  pure(edge, () => assert.throws(() => setFurnitureRotation(edge, edgeId, 90)));
});

test("charging zones are named in sequence and use mm bounds", () => {
  const map = plan(rect(0, 0, 30, 20));
  const first = pure(map, () => addChargingZone(map, rect(3, 4, 5, 2), ids()));
  assert.deepEqual(fp(first.map).chargingZones, [
    { id: first.zoneId, name: "CHARGING 1", x: 60, y: 80, width: 100, height: 40 },
  ]);
  const second = addChargingZone(first.map, [cellIndex(0, 0)], ids("c"));
  assert.equal(fp(second.map).chargingZones![1].name, "CHARGING 2");
  assert.deepEqual(fp(second.map).chargingZones![1], { id: second.zoneId, name: "CHARGING 2", x: 0, y: 0, width: 20, height: 20 });
  validateFloorPlan(second.map);
});

test("deleteFixture removes gates, walls with their doors, merged door groups, furniture and charging zones", () => {
  const base = plan(rect(0, 0, 40, 25));
  const gate = addGate(base, rect(4, 3, 7, 4), "bottom", 7, ids("g"));
  const gateDeleted = pure(gate.map, () => deleteFixture(gate.map, gate.doorId));
  assert.equal(fp(gateDeleted).walls!.length, 0);
  assert.equal(fp(gateDeleted).doors.length, 0);

  const partition = addPartitionWall(base, cellIndex(3, 12), cellIndex(20, 12), ids("p"));
  const withDoor = addDoorAt(partition.map, 200, 250, { roomId: "floor", cells: 7, maxDistance: 5 }, ids("d"));
  assert.equal(fp(withDoor.map).doors.length, 1);
  assert.equal(fp(withDoor.map).doors[0].wallId, partition.wallId);
  const wallDeleted = pure(withDoor.map, () => deleteFixture(withDoor.map, partition.wallId));
  assert.equal(fp(wallDeleted).walls!.length, 0);
  assert.equal(fp(wallDeleted).doors.length, 0);

  const edgeDoor = addDoorAt(plan(rect(2, 2, 14, 14)), 50, 40, { ...DOOR_OPTS, cells: 7 }, ids("e"));
  const lastMember = fp(edgeDoor.map).doors[6].id;
  assert.equal(fp(deleteFixture(edgeDoor.map, lastMember)).doors.length, 0);

  const furniture = addFurniture(base, [cellIndex(5, 5)], "plant", 0, ids("f"));
  assert.equal(fp(deleteFixture(furniture.map, furniture.itemId)).furniture.length, 0);
  const zone = addChargingZone(base, [cellIndex(5, 5)], ids("z"));
  assert.equal(fp(deleteFixture(zone.map, zone.zoneId)).chargingZones!.length, 0);

  pure(base, () => assert.throws(() => deleteFixture(base, null), /削除する家具・ドアを「選択」でクリックしてください。/));
  pure(base, () => assert.throws(() => deleteFixture(base, "missing"), /削除する家具・ドア/));
});

test("renameFixture and setDoorKind apply to every member of an opening or gate", () => {
  const first = addDoorAt(plan(rect(2, 2, 14, 14)), 50, 40, { ...DOOR_OPTS, cells: 7 }, ids("a"));
  const second = addDoorAt(first.map, 50, 320, { roomId: "floor", edge: "top", cells: 7, maxDistance: 24 }, ids("b"));
  const doors = fp(second.map).doors;
  assert.equal(doors.length, 14);
  const renamed = pure(second.map, () => renameFixture(second.map, doors[3].id, "  Main entrance  "));
  const names = fp(renamed).doors.map((door) => door.name);
  assert.deepEqual(names.slice(0, 7), Array(7).fill("Main entrance"));
  assert.deepEqual(names.slice(7), Array(7).fill(undefined));
  const kinded = pure(second.map, () => setDoorKind(second.map, doors[3].id, "flapper"));
  assert.deepEqual(fp(kinded).doors.map((door) => door.kind), [...Array(7).fill("flapper"), ...Array(7).fill(undefined)]);
  pure(second.map, () => assert.throws(() => renameFixture(second.map, doors[0].id, "x".repeat(121)), /120文字以内/));
  pure(second.map, () => assert.throws(() => renameFixture(second.map, "missing", "x")));
  pure(second.map, () => assert.throws(() => setDoorKind(second.map, "missing", "automatic")));

  const gate = addGate(plan(rect(0, 0, 40, 25)), rect(4, 3, 7, 4), "bottom", 7, ids("g"));
  const gateRenamed = pure(gate.map, () => renameFixture(gate.map, gate.doorId, "Gate A"));
  assert.deepEqual([...fp(gateRenamed).walls!, ...fp(gateRenamed).doors].map((item) => item.name), Array(4).fill("Gate A"));
});
