import {
  DOOR_MAX_CELLS, DOOR_MIN_CELLS, doorWidthOk, edgePoints, mergedDoors, nearestDoorWall, placeDoor, placeGate,
} from "./equipment";
import { regionBounds, rotateFurniture, validateFloorPlan } from "./floorPlan";
import { cellColRow, type Edge } from "./grid";
import { defaultId, type IdFactory } from "./ids";
import type { Door, FurnitureType, SceneMap, Segment } from "./types";
import { CELL_MM } from "./units";

type Rotation = 0 | 90 | 180 | 270;

const SAFETY_DIAMETER_MM = 120;
const MAX_NAME_LENGTH = 120;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Returns a clone whose floorPlan (and its arrays) is guaranteed to exist.
function working(map: SceneMap): SceneMap {
  const trial = structuredClone(map);
  trial.floorPlan ??= { doors: [], furniture: [] };
  trial.floorPlan.walls ??= [];
  return trial;
}

const roomOf = (map: SceneMap, cell: number) => map.rooms.find((room) => room.cells.includes(cell));

export function addDoorAt(
  map: SceneMap, x: number, y: number,
  opts: { roomId?: string; edge?: Edge | "auto"; cells: number; maxDistance: number },
  makeId: IdFactory = defaultId,
): { map: SceneMap; doorId: string; roomId: string } {
  const candidate = nearestDoorWall(map, x, y, opts);
  const doors = placeDoor(map, candidate, makeId, opts.cells);
  const result = working(map);
  result.floorPlan!.doors.push(...doors);
  return { map: result, doorId: doors[0].id, roomId: doors[0].roomId };
}

export function previewDoorAt(
  map: SceneMap, x: number, y: number,
  opts: { roomId?: string; edge?: Edge | "auto"; cells: number; maxDistance: number },
): Segment[] | null {
  try {
    let next = 0;
    const candidate = nearestDoorWall(map, x, y, opts);
    if (!candidate) return null;
    const doors = placeDoor(map, candidate, () => `preview-${++next}`, opts.cells);
    return doors.map((door) => {
      if (door.cell === undefined || door.edge === undefined) return { x1: door.x1!, y1: door.y1!, x2: door.x2!, y2: door.y2! };
      const [x1, y1, x2, y2] = edgePoints(door.cell, door.edge);
      return { x1, y1, x2, y2 };
    });
  } catch {
    return null;
  }
}

export function addGate(
  map: SceneMap, cells: number[], entrance: Edge, doorCells: number, makeId: IdFactory = defaultId,
): { map: SceneMap; doorId: string; roomId: string } {
  check(doorWidthOk(doorCells), `入口幅は${DOOR_MIN_CELLS}〜${DOOR_MAX_CELLS}マスで指定してください。`);
  const bounds = regionBounds(cells);
  const side = entrance === "top" || entrance === "bottom" ? bounds.width : bounds.height;
  check(side / CELL_MM === doorCells, "入口幅が指定と一致しません。");
  const { walls, door } = placeGate(map, cells, entrance, makeId);
  const result = working(map);
  result.floorPlan!.walls!.push(...walls);
  result.floorPlan!.doors.push(door);
  return { map: result, doorId: door.id, roomId: door.roomId };
}

export function addPartitionWall(
  map: SceneMap, startCell: number, endCell: number, makeId: IdFactory = defaultId,
): { map: SceneMap; wallId: string; roomId: string; warning: string | null } {
  check(startCell !== endCell, "間仕切り壁は2セル以上の距離でドラッグしてください。");
  const room = roomOf(map, startCell);
  check(room, "間仕切り壁の領域を選択してください。");
  const a = cellColRow(startCell), b = cellColRow(endCell);
  const horizontal = Math.abs(b.col - a.col) >= Math.abs(b.row - a.row);
  const result = working(map);
  const walls = result.floorPlan!.walls!;
  const wall = {
    id: makeId(), roomId: room.id, name: `Partition wall ${walls.length + 1}`,
    ...(horizontal
      ? { x1: Math.min(a.col, b.col) * CELL_MM + CELL_MM / 2, y1: a.row * CELL_MM + CELL_MM / 2,
        x2: Math.max(a.col, b.col) * CELL_MM + CELL_MM / 2, y2: a.row * CELL_MM + CELL_MM / 2 }
      : { x1: a.col * CELL_MM + CELL_MM / 2, y1: Math.min(a.row, b.row) * CELL_MM + CELL_MM / 2,
        x2: a.col * CELL_MM + CELL_MM / 2, y2: Math.max(a.row, b.row) * CELL_MM + CELL_MM / 2 }),
  };
  walls.push(wall);
  validateFloorPlan(result);
  const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  return {
    map: result, wallId: wall.id, roomId: room.id,
    warning: length < SAFETY_DIAMETER_MM ? "安全円(直径120mm)より短い壁です。" : null,
  };
}

export function addFurniture(
  map: SceneMap, cells: number[], type: FurnitureType, rotation: Rotation, makeId: IdFactory = defaultId,
): { map: SceneMap; itemId: string; roomId: string } {
  const sorted = [...cells].sort((a, b) => a - b);
  const room = sorted.length ? roomOf(map, sorted[0]) : undefined;
  check(room, "家具は領域内に配置してください。");
  const result = working(map);
  const item = { id: makeId(), roomId: room.id, cell: sorted[0], cells: sorted, type, rotation };
  result.floorPlan!.furniture.push(item);
  validateFloorPlan(result);
  return { map: result, itemId: item.id, roomId: room.id };
}

const ROTATE_MESSAGE = "回転する家具を「選択」でクリックしてください。";

function applyRotation(map: SceneMap, itemId: string, rotation: (current: Rotation) => number): SceneMap {
  const result = working(map);
  const list = result.floorPlan!.furniture;
  const index = list.findIndex((item) => item.id === itemId);
  check(index >= 0, ROTATE_MESSAGE);
  list[index] = rotateFurniture(list[index], rotation(list[index].rotation) as Rotation);
  validateFloorPlan(result);
  return result;
}

export function rotateFurnitureBy(map: SceneMap, itemId: string, turns: number): SceneMap {
  return applyRotation(map, itemId, (current) => (((current + 90 * turns) % 360) + 360) % 360);
}

export function setFurnitureRotation(map: SceneMap, itemId: string, rotation: Rotation): SceneMap {
  return applyRotation(map, itemId, () => rotation);
}

const FURNITURE_TYPES: readonly FurnitureType[] = ["desk", "chair", "plant", "reception-monitor"];

export function setFurnitureType(map: SceneMap, itemId: string, type: FurnitureType): SceneMap {
  check(FURNITURE_TYPES.includes(type), "家具の種類が正しくありません。");
  const result = working(map);
  const item = result.floorPlan!.furniture.find((value) => value.id === itemId);
  check(item, "種類を変更する家具を「選択」でクリックしてください。");
  item.type = type;
  return result;
}

export function addChargingZone(
  map: SceneMap, cells: number[], makeId: IdFactory = defaultId,
): { map: SceneMap; zoneId: string } {
  const result = working(map);
  const zones = (result.floorPlan!.chargingZones ??= []);
  const zone = { id: makeId(), name: `CHARGING ${zones.length + 1}`, ...regionBounds(cells) };
  zones.push(zone);
  validateFloorPlan(result);
  return { map: result, zoneId: zone.id };
}

export function deleteFixture(map: SceneMap, itemId: string | null): SceneMap {
  const message = "削除する家具・ドアを「選択」でクリックしてください。";
  check(itemId !== null, message);
  const result = working(map);
  const plan = result.floorPlan!;
  const removedDoors = new Set<string>(), removedWalls = new Set<string>();
  if (plan.furniture.some((item) => item.id === itemId)) {
    plan.furniture = plan.furniture.filter((item) => item.id !== itemId);
  } else if (plan.chargingZones?.some((zone) => zone.id === itemId)) {
    plan.chargingZones = plan.chargingZones.filter((zone) => zone.id !== itemId);
  } else if (plan.doors.some((door) => door.id === itemId)) {
    const group = mergedDoors(result).find((g) => g.memberIds.includes(itemId));
    for (const id of group?.memberIds ?? [itemId]) removedDoors.add(id);
    const equipmentId = plan.doors.find((door) => door.id === itemId)!.equipmentId;
    if (equipmentId !== undefined) {
      for (const door of plan.doors) if (door.equipmentId === equipmentId) removedDoors.add(door.id);
      for (const wall of plan.walls!) if (wall.equipmentId === equipmentId) removedWalls.add(wall.id);
    }
  } else if (plan.walls!.some((wall) => wall.id === itemId)) {
    removedWalls.add(itemId);
  } else {
    throw new Error(message);
  }
  for (const door of plan.doors) if (door.wallId !== undefined && removedWalls.has(door.wallId)) removedDoors.add(door.id);
  plan.doors = plan.doors.filter((door) => !removedDoors.has(door.id));
  plan.walls = plan.walls!.filter((wall) => !removedWalls.has(wall.id));
  return result;
}

export function renameFixture(map: SceneMap, itemId: string, name: string): SceneMap {
  const trimmed = name.trim();
  check(trimmed.length <= MAX_NAME_LENGTH, `設備名は${MAX_NAME_LENGTH}文字以内で入力してください。`);
  const result = working(map);
  const { doors, walls } = result.floorPlan!;
  const selected = [...doors, ...walls!].find((item) => item.id === itemId);
  check(selected, "名前を変更するドアまたは壁を「選択」でクリックしてください。");
  const openingId = (selected as Door).openingId;
  for (const item of [...doors, ...walls!]) {
    const sameOpening = openingId !== undefined && (item as Door).openingId === openingId;
    const sameEquipment = selected.equipmentId !== undefined && item.equipmentId === selected.equipmentId;
    if (item === selected || sameOpening || sameEquipment) item.name = trimmed;
  }
  return result;
}

export function setDoorKind(map: SceneMap, itemId: string, kind: "automatic" | "flapper"): SceneMap {
  const result = working(map);
  const doors = result.floorPlan!.doors;
  const selected = doors.find((door) => door.id === itemId);
  check(selected, "種類を変更するドアを「選択」でクリックしてください。");
  for (const door of doors) {
    if (door === selected || (selected.openingId !== undefined && door.openingId === selected.openingId)) door.kind = kind;
  }
  return result;
}
