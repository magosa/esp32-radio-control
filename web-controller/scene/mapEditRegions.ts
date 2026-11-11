import { boundaryEdge, furnitureCells, regionBounds, removeRegion } from "./floorPlan";
import type { Edge } from "./grid";
import { defaultId, type IdFactory } from "./ids";
import { DOOR_MAX_CELLS, DOOR_MIN_CELLS, doorWidthOk, placeElevator } from "./equipment";
import type { Room, SceneMap } from "./types";
import { CELL_COUNT, CELL_MM } from "./units";

export const MAX_ROOMS = 100;
export const REGION_COLORS = ["#8d9bff", "#58d8ca", "#ffbd70", "#73bafa", "#bd9afa"] as const;

const OVERLAP_MESSAGE = "別の領域と重なっています。消しゴムで空けるか別のセルを選んでください。";
const KINDS: readonly string[] = ["room", "corridor"];
const MATERIALS: readonly string[] = ["wood", "tile", "carpet", "concrete"];

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const validCells = (cells: readonly number[]) =>
  cells.every((cell) => Number.isInteger(cell) && cell >= 0 && cell < CELL_COUNT);

export function addRegion(
  map: SceneMap, kind: "room" | "corridor" | "elevator", makeId: IdFactory = defaultId,
): { map: SceneMap; roomId: string } {
  const result = structuredClone(map);
  const last = result.rooms[result.rooms.length - 1];
  if (last?.appearance === "elevator" && last.cells.length === 0) return { map: result, roomId: last.id };
  check(result.rooms.length < MAX_ROOMS, `領域は${MAX_ROOMS}件までです。`);
  const label = kind === "corridor" ? "廊下" : kind === "elevator" ? "エレベーター" : "部屋";
  const room: Room = {
    id: makeId(), name: `${label} ${result.rooms.length + 1}`,
    color: REGION_COLORS[result.rooms.length % REGION_COLORS.length], cells: [],
    kind: kind === "corridor" ? "corridor" : "room",
    material: kind === "corridor" ? "tile" : "concrete",
    ...(kind === "elevator" ? { appearance: "elevator" as const } : {}),
  };
  result.rooms.push(room);
  return { map: result, roomId: room.id };
}

export function dropInvalidFixtures(map: SceneMap): { map: SceneMap; removed: number } {
  const result = structuredClone(map);
  const plan = result.floorPlan;
  if (!plan) return { map: result, removed: 0 };
  const rooms = new Map(result.rooms.map((room) => [room.id, room]));
  const before = plan.furniture.length + plan.doors.length;
  plan.furniture = plan.furniture.filter((item) => {
    const room = rooms.get(item.roomId);
    return room !== undefined && furnitureCells(item).every((cell) => room.cells.includes(cell));
  });
  const wallIds = new Set((plan.walls ?? []).map((wall) => wall.id));
  plan.doors = plan.doors.filter((door) => {
    if (Object.hasOwn(door, "x1")) return door.wallId !== undefined && wallIds.has(door.wallId);
    const room = rooms.get(door.roomId);
    return room !== undefined && door.cell !== undefined && door.edge !== undefined && boundaryEdge(room, door.cell, door.edge);
  });
  return { map: result, removed: before - plan.furniture.length - plan.doors.length };
}

export function paintCells(map: SceneMap, roomId: string, cells: number[], kind: "room" | "corridor"): SceneMap {
  check(map.rooms.some((item) => item.id === roomId), "先に「新しい領域」を追加してください。");
  check(validCells(cells), "セルが範囲外です。");
  const result = structuredClone(map);
  const room = result.rooms.find((item) => item.id === roomId)!;
  const painted = new Set(cells);
  const overlaps = result.rooms.filter((item) => item !== room && item.cells.some((cell) => painted.has(cell)));
  if (overlaps.length > 0) {
    // Elevators may only cut a piece out of a corridor, never consume it entirely.
    check(room.appearance === "elevator" &&
      !overlaps.some((item) => item.kind !== "corridor" || item.cells.every((cell) => painted.has(cell))), OVERLAP_MESSAGE);
    for (const corridor of overlaps) corridor.cells = corridor.cells.filter((cell) => !painted.has(cell));
  }
  room.cells = Array.from(new Set([...room.cells, ...cells])).sort((a, b) => a - b);
  room.kind = kind;
  return dropInvalidFixtures(result).map;
}

export function eraseCells(map: SceneMap, cells: number[]): SceneMap {
  const erased = new Set(cells);
  const result = structuredClone(map);
  for (const room of result.rooms) {
    if (room.cells.length === 0) continue;
    const remaining = room.cells.filter((cell) => !erased.has(cell));
    check(remaining.length > 0, `「${room.name}」の最後のセルは消せません。参照保護のため領域を維持します。`);
    room.cells = remaining;
  }
  return dropInvalidFixtures(result).map;
}

export function setRoomProps(
  map: SceneMap, roomId: string, patch: Partial<Pick<Room, "name" | "kind" | "material" | "color">>,
): SceneMap {
  const result = structuredClone(map);
  const room = result.rooms.find((item) => item.id === roomId);
  check(room, "領域が見つかりません。");
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    check(name.length >= 1 && name.length <= 120, "領域名は1〜120文字で入力してください。");
    room.name = name;
  }
  if (patch.kind !== undefined) {
    check(KINDS.includes(patch.kind), "領域の種類が正しくありません。");
    room.kind = patch.kind;
  }
  if (patch.material !== undefined) {
    check(MATERIALS.includes(patch.material), "床材が正しくありません。");
    room.material = patch.material;
  }
  if (patch.color !== undefined) {
    check(typeof patch.color === "string" && /^#[0-9a-f]{6}$/i.test(patch.color), "色は#rrggbb形式で指定してください。");
    room.color = patch.color;
  }
  return result;
}

export function removeRegionChecked(map: SceneMap, roomId: string): SceneMap {
  check(map.rooms.some((room) => room.id === roomId), "削除する領域を選択してください。");
  check(map.rooms.length > 1, "最後の領域は削除できません。");
  try {
    return removeRegion(map, roomId);
  } catch {
    throw new Error("この領域はトラックまたは動作から参照されているため削除できません。");
  }
}

const ELEVATOR_ERRORS: readonly (readonly [string, string])[] = [
  ["only a new, empty elevator", "新しい空のエレベーター領域にのみ配置できます。"],
  ["entrance edge is invalid", "エレベーターの入口の向きが正しくありません。"],
  ["new elevators must be a rectangle", `エレベーターは長方形で、入口幅${DOOR_MIN_CELLS}〜${DOOR_MAX_CELLS}マスにしてください。`],
  ["elevators may only cover", "エレベーターは空きセルか廊下の一部にのみ置けます(他の領域や廊下全体は不可)。"],
  ["walls or gates", "エレベーターは壁やゲートと重ねて置けません。"],
];

export function commitElevator(
  map: SceneMap, roomId: string, cells: number[], entrance: Edge, doorCells: number, makeId: IdFactory = defaultId,
): SceneMap {
  check(doorWidthOk(doorCells), `入口幅は${DOOR_MIN_CELLS}〜${DOOR_MAX_CELLS}マスで指定してください。`);
  check(Array.isArray(cells) && validCells(cells) && cells.length > 0, "セルが範囲外です。");
  const bounds = regionBounds(cells);
  const horizontal = entrance === "top" || entrance === "bottom";
  check((horizontal ? bounds.width : bounds.height) / CELL_MM === doorCells, "入口幅が指定と一致しません。");
  const trial = structuredClone(map);
  trial.floorPlan ??= { doors: [], furniture: [] };
  try {
    return placeElevator(trial, roomId, cells, entrance, makeId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const known = ELEVATOR_ERRORS.find(([needle]) => message.includes(needle));
    throw new Error(known ? known[1] : `エレベーターを配置できません: ${message}`);
  }
}
