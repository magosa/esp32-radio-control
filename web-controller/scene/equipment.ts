import { cellColRow, cellNeighbor, type Edge } from "./grid";
import { boundaryEdge, furnitureCells, regionBounds, validateFloorPlan, type Bounds } from "./floorPlan";
import { defaultId, type IdFactory } from "./ids";
import type { Door, SceneMap, Segment, Wall } from "./types";
import { CELL_COUNT, CELL_MM, COLUMNS, ROWS } from "./units";

// Nearest 20mm multiple to upstream EQUIPMENT_ENTRANCE_CELLS = 6 (≈207.5mm).
export const DOOR_CELLS = 10;
// Upstream 6 ratio units.
export const DOOR_FRAME_MM = 4;
// Upstream 35 ratio units.
const DOOR_SNAP_MM = 24;
const DOOR_MM = DOOR_CELLS * CELL_MM;
const EDGES: readonly Edge[] = ["top", "bottom", "left", "right"];

export type EdgeDoorCandidate = { roomId: string; cell: number; edge: Edge };
export type WallDoorCandidate = Segment & { roomId: string; wallId: string; independent: true };
export type DoorCandidate = EdgeDoorCandidate | WallDoorCandidate;
export type MergedDoor = Door & {
  points: [number, number, number, number];
  adjacentRoomId: string | null;
  memberIds: string[];
  opening: Segment;
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const isCell = (cell: number) => Number.isInteger(cell) && cell >= 0 && cell < CELL_COUNT;
const isHorizontal = (edge: Edge) => edge === "top" || edge === "bottom";
const isRectangle = (cells: readonly number[], bounds: Bounds) =>
  (bounds.width * bounds.height) / CELL_MM ** 2 === new Set(cells).size;
const touchesWall = (map: SceneMap, b: Bounds) => {
  const right = b.x + b.width, top = b.y + b.height;
  return (map.floorPlan?.walls ?? []).some((wall) =>
    (wall.x1 < right && wall.x2 > b.x && wall.y1 <= top && wall.y2 >= b.y) ||
    (wall.y1 < top && wall.y2 > b.y && wall.x1 <= right && wall.x2 >= b.x));
};

// Placement-only constraint; loading and saving never resize existing equipment.
export function equipmentRectangle(start: number, end: number, entrance: Edge = "bottom", elevator = false): number[] {
  check(isCell(start) && isCell(end) && EDGES.includes(entrance), "equipment range or entrance edge is invalid");
  const a = cellColRow(start), b = cellColRow(end);
  let { col: x2, row: y2 } = b;
  if (elevator) {
    if (isHorizontal(entrance)) x2 = a.col + (x2 < a.col ? 1 - DOOR_CELLS : DOOR_CELLS - 1);
    else y2 = a.row + (y2 < a.row ? 1 - DOOR_CELLS : DOOR_CELLS - 1);
  }
  check(x2 >= 0 && x2 < COLUMNS && y2 >= 0 && y2 < ROWS,
    `cannot fit a ${DOOR_CELLS}-cell entrance; drag from inside the map`);
  const cells: number[] = [];
  for (let y = Math.min(a.row, y2); y <= Math.max(a.row, y2); y++) {
    for (let x = Math.min(a.col, x2); x <= Math.max(a.col, x2); x++) cells.push(y * COLUMNS + x);
  }
  return cells;
}

export function placeDoor(map: SceneMap, candidate: DoorCandidate | null, makeId: IdFactory = defaultId): Door[] {
  check(candidate, "click near a wall");
  check(map.floorPlan, "map has no floor plan");
  if ("independent" in candidate) {
    const wall = map.floorPlan.walls?.find((item) => item.id === candidate.wallId);
    check(wall, "independent door wall not found");
    const horizontal = wall.y1 === wall.y2;
    const low = horizontal ? wall.x1 : wall.y1, high = horizontal ? wall.x2 : wall.y2;
    check(high - low >= DOOR_MM, `automatic doors need a continuous ${DOOR_CELLS}-cell (${DOOR_MM}mm) wall`);
    const center = horizontal ? (candidate.x1 + candidate.x2) / 2 : (candidate.y1 + candidate.y2) / 2;
    const from = Math.max(low, Math.min(high - DOOR_MM, low + Math.floor((center - low - DOOR_MM / 2) / CELL_MM) * CELL_MM));
    const door: Door = {
      id: makeId(), roomId: wall.roomId, wallId: wall.id, kind: "automatic",
      x1: horizontal ? from : wall.x1, y1: horizontal ? wall.y1 : from,
      x2: horizontal ? from + DOOR_MM : wall.x1, y2: horizontal ? wall.y1 : from + DOOR_MM,
    };
    const trial = structuredClone(map);
    trial.floorPlan!.doors.push(door);
    validateFloorPlan(trial);
    return [door];
  }
  const room = map.rooms.find((item) => item.id === candidate.roomId);
  check(room, "door room not found");
  const horizontal = isHorizontal(candidate.edge);
  const step = horizontal ? 1 : COLUMNS, openingId = makeId(), doors: Door[] = [];
  const adjacentOwner = (cell: number) =>
    map.rooms.find((item) => item.cells.includes(cellNeighbor(cell, candidate.edge)))?.id ?? null;
  const adjacent = adjacentOwner(candidate.cell);
  for (let i = 0; i < DOOR_CELLS; i++) {
    const cell = candidate.cell + i * step;
    check(isCell(cell) && (!horizontal || cellColRow(cell).row === cellColRow(candidate.cell).row) &&
      boundaryEdge(room, cell, candidate.edge), `automatic doors need ${DOOR_CELLS} contiguous cells on the same outer edge`);
    check(adjacentOwner(cell) === adjacent, `the ${DOOR_CELLS} door cells must face the same adjacent region`);
    doors.push({ id: makeId(), openingId, roomId: room.id, cell, edge: candidate.edge });
  }
  const trial = structuredClone(map);
  trial.floorPlan!.doors.push(...doors);
  validateFloorPlan(trial);
  return doors;
}

export function placeElevator(map: SceneMap, roomId: string, cells: number[], entrance: Edge, makeId: IdFactory = defaultId): SceneMap {
  const trial = structuredClone(map), room = trial.rooms.find((item) => item.id === roomId);
  check(room?.appearance === "elevator" && room.cells.length === 0,
    "only a new, empty elevator region can be placed; existing elevators are not resized");
  check(EDGES.includes(entrance), "elevator entrance edge is invalid");
  const bounds = regionBounds(cells);
  check((isHorizontal(entrance) ? bounds.width : bounds.height) === DOOR_MM && isRectangle(cells, bounds),
    `new elevators must be a rectangle with a ${DOOR_CELLS}-cell entrance`);
  const occupied = new Set(cells);
  const overlaps = trial.rooms.filter((item) => item !== room && item.cells.some((cell) => occupied.has(cell)));
  check(!overlaps.some((item) => item.kind !== "corridor" || item.cells.every((cell) => occupied.has(cell))),
    "elevators may only cover blank cells or part of a corridor, not another room or a whole corridor");
  check(!touchesWall(trial, bounds), "elevators must not overlap existing walls or gates");
  for (const corridor of overlaps) corridor.cells = corridor.cells.filter((cell) => !occupied.has(cell));
  room.cells = [...cells];
  room.entranceEdge = entrance;
  const boundary = room.cells.filter((cell) => boundaryEdge(room, cell, entrance));
  trial.floorPlan!.doors.push(...placeDoor(trial, { roomId: room.id, cell: Math.min(...boundary), edge: entrance }, makeId));
  validateFloorPlan(trial);
  return trial;
}

export function placeGate(map: SceneMap, cells: number[], entrance: Edge = "bottom", makeId: IdFactory = defaultId): { walls: Wall[]; door: Door } {
  check(EDGES.includes(entrance), "gate entrance edge is invalid");
  const bounds = regionBounds(cells);
  check(isRectangle(cells, bounds), "gates must be dragged as a rectangle");
  const room = map.rooms.find((item) => cells.every((cell) => item.cells.includes(cell)));
  check(room, "the whole gate must lie inside the same room or corridor");
  check(!(map.floorPlan?.furniture ?? []).some((item) => furnitureCells(item).some((cell) => cells.includes(cell))),
    "gates must not overlap furniture");
  check(!touchesWall(map, bounds), "gates must not overlap existing walls or gates");
  const { x, y } = bounds, right = x + bounds.width, top = y + bounds.height;
  const equipmentId = makeId();
  const segments = isHorizontal(entrance)
    ? [[x, y, x, top], [right, y, right, top], [x, (y + top) / 2, right, (y + top) / 2]]
    : [[x, y, right, y], [x, top, right, top], [(x + right) / 2, y, (x + right) / 2, top]];
  const walls: Wall[] = segments.map(([x1, y1, x2, y2]) => ({
    id: makeId(), equipmentId, roomId: room.id, name: "Flapper gate", x1, y1, x2, y2,
  }));
  const door: Door = { ...walls[2], id: makeId(), wallId: walls[2].id, kind: "flapper" };
  const trial = structuredClone(map);
  trial.floorPlan ??= { doors: [], furniture: [] };
  trial.floorPlan.walls ??= [];
  trial.floorPlan.walls.push(...walls);
  trial.floorPlan.doors.push(door);
  validateFloorPlan(trial);
  return { walls, door };
}

export function edgePoints(cell: number, edge: Edge): [number, number, number, number] {
  const { col, row } = cellColRow(cell);
  const x = col * CELL_MM, y = row * CELL_MM;
  if (edge === "top") return [x, y + CELL_MM, x + CELL_MM, y + CELL_MM];
  if (edge === "bottom") return [x, y, x + CELL_MM, y];
  if (edge === "left") return [x, y, x, y + CELL_MM];
  return [x + CELL_MM, y, x + CELL_MM, y + CELL_MM];
}

export function nearestDoorWall(
  map: SceneMap, x: number, y: number,
  { roomId = "", edge = "auto", maxDistance = DOOR_SNAP_MM }: { roomId?: string; edge?: Edge | "auto"; maxDistance?: number } = {},
): DoorCandidate | null {
  check(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(maxDistance) && maxDistance >= 0 &&
    (edge === "auto" || EDGES.includes(edge)), "door position is invalid");
  let nearest: DoorCandidate | null = null, distance = maxDistance ** 2;
  const rooms = [...map.rooms].sort((a, b) => Number(b.id === roomId) - Number(a.id === roomId));
  for (const room of rooms) for (const cell of room.cells) for (const side of EDGES) {
    if ((edge !== "auto" && side !== edge) || !boundaryEdge(room, cell, side)) continue;
    const [x1, y1, x2, y2] = edgePoints(cell, side);
    const px = Math.max(x1, Math.min(x2, x)), py = Math.max(y1, Math.min(y2, y));
    const candidate = (x - px) ** 2 + (y - py) ** 2;
    if (candidate <= distance && (!nearest || candidate < distance)) {
      distance = candidate;
      nearest = { roomId: room.id, cell, edge: side };
    }
  }
  for (const wall of map.floorPlan?.walls ?? []) {
    const horizontal = wall.y1 === wall.y2;
    const low = horizontal ? wall.x1 : wall.y1, high = horizontal ? wall.x2 : wall.y2;
    const span = Math.min(DOOR_MM, high - low);
    const coordinate = Math.max(low, Math.min(high, horizontal ? x : y));
    const candidate = (x - (horizontal ? coordinate : wall.x1)) ** 2 + (y - (horizontal ? wall.y1 : coordinate)) ** 2;
    if (candidate > distance) continue;
    const start = Math.max(low, Math.min(high - span, low + Math.floor((coordinate - low - span / 2) / CELL_MM) * CELL_MM));
    distance = candidate;
    nearest = {
      roomId: wall.roomId, wallId: wall.id, independent: true,
      x1: horizontal ? start : wall.x1, y1: horizontal ? wall.y1 : start,
      x2: horizontal ? start + span : wall.x1, y2: horizontal ? wall.y1 : start + span,
    };
  }
  return nearest;
}

function inset([x1, y1, x2, y2]: readonly number[]): Segment {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / length, uy = (y2 - y1) / length;
  return {
    x1: x1 + ux * DOOR_FRAME_MM, y1: y1 + uy * DOOR_FRAME_MM,
    x2: x2 - ux * DOOR_FRAME_MM, y2: y2 - uy * DOOR_FRAME_MM,
  };
}

export function mergedDoors(map: SceneMap): MergedDoor[] {
  const owners = new Map(map.rooms.flatMap((room) => room.cells.map((cell) => [cell, room.id] as const)));
  const doors = map.floorPlan?.doors ?? [];
  const isSegment = (door: Door) => Object.hasOwn(door, "x1");
  const groups: Omit<MergedDoor, "opening">[] = [];
  const sorted = doors.filter((door) => !isSegment(door)).map((door) => ({
    ...door, points: edgePoints(door.cell!, door.edge!),
    adjacentRoomId: owners.get(cellNeighbor(door.cell!, door.edge!)) ?? null,
  })).sort((a, b) => a.points[1] - b.points[1] || a.points[0] - b.points[0]);
  for (const door of sorted) {
    const horizontal = door.points[1] === door.points[3];
    const group = groups.find((g) => (door.openingId
      ? g.openingId === door.openingId
      : !g.openingId && !g.name && !g.kind && !door.name && !door.kind) &&
      g.roomId === door.roomId && g.edge === door.edge && g.adjacentRoomId === door.adjacentRoomId &&
      (horizontal ? g.points[1] === door.points[1] && g.points[2] === door.points[0]
        : g.points[0] === door.points[0] && g.points[3] === door.points[1]));
    if (group) {
      group.points[2] = door.points[2];
      group.points[3] = door.points[3];
      group.memberIds.push(door.id);
    } else groups.push({ ...door, memberIds: [door.id] });
  }
  for (const door of doors.filter(isSegment)) {
    groups.push({ ...door, points: [door.x1!, door.y1!, door.x2!, door.y2!], adjacentRoomId: null, memberIds: [door.id] });
  }
  return groups.map((group) => ({ ...group, opening: inset(group.points) }));
}
