import { cellCenter, cellColRow, cellIndex, cellNeighbor, type Edge } from "./grid";
import type { Furniture, Room, SceneMap, Segment } from "./types";
import { AREA_HEIGHT_MM, AREA_WIDTH_MM, CELL_COUNT, CELL_MM, COLUMNS, ROWS } from "./units";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EDGES: readonly string[] = ["top", "bottom", "left", "right"];
// Upstream 12 ratio units.
const MIN_DOOR_MM = 8;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const isCell = (cell: unknown): cell is number => Number.isInteger(cell) && (cell as number) >= 0 && (cell as number) < CELL_COUNT;
const finite = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export function regionBounds(cells: readonly number[]): Bounds {
  check(Array.isArray(cells) && cells.length > 0 && cells.length <= CELL_COUNT && cells.every(isCell),
    `region cells must be 1..${CELL_COUNT} integers in 0..${CELL_COUNT - 1}`);
  let left = COLUMNS, right = -1, bottom = ROWS, top = -1;
  for (const cell of cells) {
    const { col, row } = cellColRow(cell);
    left = Math.min(left, col); right = Math.max(right, col);
    bottom = Math.min(bottom, row); top = Math.max(top, row);
  }
  return { x: left * CELL_MM, y: bottom * CELL_MM, width: (right - left + 1) * CELL_MM, height: (top - bottom + 1) * CELL_MM };
}

export function furnitureCells(item: Pick<Furniture, "cell" | "cells">): number[] {
  return Object.hasOwn(item, "cells") ? (item.cells as number[]) : [item.cell];
}

// Rotates about the footprint's top-left corner, matching the upstream screen behaviour.
export function rotateFurniture(item: Furniture, rotation: Furniture["rotation"]): Furniture {
  const cells = furnitureCells(item);
  const bounds = regionBounds(cells);
  const left = bounds.x / CELL_MM;
  const top = ROWS - (bounds.y + bounds.height) / CELL_MM;
  const width = bounds.width / CELL_MM;
  const height = bounds.height / CELL_MM;
  const turns = ((rotation - item.rotation + 360) % 360) / 90;
  check(Number.isInteger(turns), "furniture rotation must be a multiple of 90");
  const rotated = cells.map((cell) => {
    const { col, row } = cellColRow(cell);
    const x = col - left;
    const y = ROWS - 1 - row - top;
    const [dx, dy] = turns === 1 ? [y, width - 1 - x] :
      turns === 2 ? [width - 1 - x, height - 1 - y] :
        turns === 3 ? [height - 1 - y, x] : [x, y];
    check(left + dx < COLUMNS && top + dy < ROWS, "rotated furniture goes outside the map");
    return cellIndex(left + dx, ROWS - 1 - (top + dy));
  }).sort((a, b) => a - b);
  return { ...item, cell: rotated[0], ...(item.cells ? { cells: rotated } : {}), rotation };
}

export function roomContainsPoint(room: Room, x: number, y: number): boolean {
  if (!finite(x, 0, AREA_WIDTH_MM) || !finite(y, 0, AREA_HEIGHT_MM)) return false;
  // Shared edges belong to both rooms; empty cells inside the bounding box do not.
  return room.cells.some((cell) => {
    if (!isCell(cell)) return false;
    const { col, row } = cellColRow(cell);
    return x >= col * CELL_MM && x <= (col + 1) * CELL_MM && y >= row * CELL_MM && y <= (row + 1) * CELL_MM;
  });
}

export function roomAnchor(room: Room): { x: number; y: number } {
  const bounds = regionBounds(room.cells);
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  let nearest = cellCenter(room.cells[0]);
  let distance = Infinity;
  for (const cell of room.cells) {
    const point = cellCenter(cell);
    const candidate = (point.x - center.x) ** 2 + (point.y - center.y) ** 2;
    if (candidate < distance) { nearest = point; distance = candidate; }
  }
  return nearest;
}

export function boundaryEdge(room: Room, cell: number, edge: Edge): boolean {
  return EDGES.includes(edge) && room.cells.includes(cell) && !room.cells.includes(cellNeighbor(cell, edge));
}

/** Returns a new map without the room and its fixtures; the input is not modified. */
export function removeRegion(map: SceneMap, roomId: string): SceneMap {
  check(map.rooms.some((room) => room.id === roomId), "room to remove not found");
  const referenced = map.tracks.some((track) => track.roomId === roomId || track.initial?.roomId === roomId ||
    (track.actions ?? []).some((action) => action.roomId === roomId));
  check(!referenced, "room is referenced by a track, initial pose or action and cannot be removed");
  const result = structuredClone(map);
  result.rooms = result.rooms.filter((room) => room.id !== roomId);
  if (result.floorPlan) {
    const walls = result.floorPlan.walls ?? [];
    const removedWalls = new Set(walls.filter((wall) => wall.roomId === roomId).map((wall) => wall.id));
    result.floorPlan.doors = result.floorPlan.doors.filter((door) =>
      door.roomId !== roomId && !(door.wallId !== undefined && removedWalls.has(door.wallId)));
    result.floorPlan.furniture = result.floorPlan.furniture.filter((item) => item.roomId !== roomId);
    result.floorPlan.walls = walls.filter((wall) => wall.roomId !== roomId);
  }
  return result;
}

function edgeKey(cell: number, edge: Edge): string {
  const { col, row } = cellColRow(cell);
  const x = col * CELL_MM, y = row * CELL_MM;
  if (edge === "top") return [x, y + CELL_MM, x + CELL_MM, y + CELL_MM].join(",");
  if (edge === "bottom") return [x, y, x + CELL_MM, y].join(",");
  if (edge === "left") return [x, y, x, y + CELL_MM].join(",");
  return [x + CELL_MM, y, x + CELL_MM, y + CELL_MM].join(",");
}

function validateSegment(item: Partial<Segment>, label: string): asserts item is Segment {
  const { x1, y1, x2, y2 } = item;
  check(finite(x1, 0, AREA_WIDTH_MM) && finite(x2, 0, AREA_WIDTH_MM) && finite(y1, 0, AREA_HEIGHT_MM) && finite(y2, 0, AREA_HEIGHT_MM) &&
    (x1 === x2 || y1 === y2) && (x1 !== x2 || y1 !== y2) && (x1! < x2! || y1! < y2!),
  `${label} must be a horizontal or vertical segment inside the area, ordered low to high`);
}

function segmentContains(wall: Segment, opening: Segment): boolean {
  if (wall.x1 === wall.x2 && opening.x1 === opening.x2 && wall.x1 === opening.x1) {
    return Math.min(opening.y1, opening.y2) >= Math.min(wall.y1, wall.y2) && Math.max(opening.y1, opening.y2) <= Math.max(wall.y1, wall.y2);
  }
  if (wall.y1 === wall.y2 && opening.y1 === opening.y2 && wall.y1 === opening.y1) {
    return Math.min(opening.x1, opening.x2) >= Math.min(wall.x1, wall.x2) && Math.max(opening.x1, opening.x2) <= Math.max(wall.x1, wall.x2);
  }
  return false;
}

function segmentsOverlap(a: Segment, b: Segment): boolean {
  if (a.x1 === a.x2 && b.x1 === b.x2 && a.x1 === b.x1) return Math.max(a.y1, b.y1) < Math.min(a.y2, b.y2);
  if (a.y1 === a.y2 && b.y1 === b.y2 && a.y1 === b.y1) return Math.max(a.x1, b.x1) < Math.min(a.x2, b.x2);
  return false;
}

function footprint(item: Furniture): number[] {
  const cells = furnitureCells(item);
  const bounds = regionBounds(cells);
  check(new Set(cells).size === cells.length && item.cell === Math.min(...cells),
    "furniture cells must be unique and start at the lowest cell");
  check(cells.length === (bounds.width * bounds.height) / CELL_MM ** 2, "furniture footprint must be a rectangle");
  return cells;
}

const isSegmentDoor = (door: object) => ["x1", "y1", "x2", "y2"].some((key) => Object.hasOwn(door, key));
const FURNITURE_TYPES: readonly unknown[] = ["desk", "chair", "plant", "reception-monitor"];
const ROTATIONS: readonly unknown[] = [0, 90, 180, 270];
const RESERVED_IDS = ["$start", "__proto__", "constructor", "prototype"];

/** Checks geometry, references, IDs and furniture kinds; remaining field shapes are checked by validateProject. */
export function validateFloorPlan(map: SceneMap): SceneMap {
  const ids = new Set<string>();
  const identify = (id: unknown, label: string) => {
    check(typeof id === "string" && id.length > 0 && id.length <= 100 && !RESERVED_IDS.includes(id) && !ids.has(id),
      `${label} ID is invalid or duplicated`);
    ids.add(id);
  };
  const rooms = new Map<string, Room>();
  const owners = new Set<number>();
  for (const room of map.rooms) {
    identify(room.id, "room");
    rooms.set(room.id, room);
    regionBounds(room.cells);
    check(new Set(room.cells).size === room.cells.length, "room cells are duplicated");
    for (const cell of room.cells) {
      check(!owners.has(cell), "rooms overlap");
      owners.add(cell);
    }
  }
  if (!map.floorPlan) return map;
  const plan = map.floorPlan;
  check(plan.doors.length <= CELL_COUNT * 4 && plan.furniture.length <= CELL_COUNT && (plan.walls?.length ?? 0) <= CELL_COUNT * 4,
    "floor plan has too many doors, furniture or walls");

  const walls = new Map<string, Segment & { roomId: string }>();
  for (const wall of plan.walls ?? []) {
    identify(wall.id, "wall");
    check(rooms.has(wall.roomId), "wall room not found");
    validateSegment(wall, "wall");
    walls.set(wall.id, wall);
  }
  const occupied = new Set<number>();
  for (const item of plan.furniture) {
    identify(item.id, "furniture");
    check(FURNITURE_TYPES.includes(item.type), "furniture type is invalid");
    check(ROTATIONS.includes(item.rotation), "furniture rotation must be 0, 90, 180 or 270");
    const room = rooms.get(item.roomId);
    check(room && isCell(item.cell), "furniture must be placed on a cell of an existing room");
    const cells = footprint(item);
    check(cells.every((cell) => room.cells.includes(cell)), "furniture must lie entirely within one room");
    for (const cell of cells) {
      check(!occupied.has(cell), "only one furniture item per cell");
      occupied.add(cell);
    }
  }
  const edges = new Set<string>();
  for (const door of plan.doors) {
    identify(door.id, "door");
    const room = rooms.get(door.roomId);
    check(room, "door room not found");
    if (isSegmentDoor(door)) {
      validateSegment(door, "door");
      check(Math.hypot(door.x2 - door.x1, door.y2 - door.y1) > MIN_DOOR_MM, `door must be longer than ${MIN_DOOR_MM}mm`);
      const wall = door.wallId === undefined ? undefined : walls.get(door.wallId);
      check(wall, "door wall not found");
      check(wall.roomId === door.roomId, "door and wall rooms differ");
      check(segmentContains(wall, door), "door must lie within its wall");
      check(!plan.doors.some((other) => other !== door && isSegmentDoor(other) && segmentsOverlap(door, other as Segment)),
        "doors on the same wall must not overlap");
    } else {
      check(isCell(door.cell) && door.edge !== undefined && boundaryEdge(room, door.cell, door.edge),
        "edge door must sit on an outer edge of its room cells");
      const key = edgeKey(door.cell, door.edge);
      check(!edges.has(key), "only one door per wall edge");
      edges.add(key);
    }
  }
  return map;
}
