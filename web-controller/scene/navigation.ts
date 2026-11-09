import { boundaryEdge, furnitureCells, regionBounds, validateFloorPlan, type Bounds } from "./floorPlan";
import { edgePoints, mergedDoors, type MergedDoor } from "./equipment";
import type { Edge } from "./grid";
import type { Door, Furniture, SceneMap, Segment, Wall } from "./types";
import { AREA_HEIGHT_MM, AREA_WIDTH_MM, CELL_COUNT, CELL_MM, COLUMNS, ROWS } from "./units";

export const NAVIGATION_SCHEMA = "fleet-floor-navigation/v1";

export interface NavigationCell {
  cell: number;
  roomId: string | null;
  traversable: boolean;
  reason: "floor" | "furniture" | "unassigned";
}

export interface NavigationDoor {
  id: string;
  roomId: string;
  cell?: number;
  edge?: Edge;
  name?: string;
  kind?: Door["kind"];
  memberIds: string[];
  adjacentRoomId: string | null;
  opening: Segment;
  state: "unspecified";
}

export interface NavigationObstacle extends Bounds {
  id: string;
  type: Furniture["type"];
  roomId: string;
  cell: number;
  rotation: Furniture["rotation"];
}

export interface SceneNavigation {
  schema: typeof NAVIGATION_SCHEMA;
  units: "mm";
  width: number;
  height: number;
  grid: { columns: number; rows: number; cellMm: number; indexOrigin: "bottom-left" };
  cells: NavigationCell[];
  walls: Segment[];
  doors: NavigationDoor[];
  obstacles: NavigationObstacle[];
}

const EDGES: readonly Edge[] = ["top", "bottom", "left", "right"];
const isSegmentDoor = (door: Door) => Object.hasOwn(door, "x1");

// Door edges leave a gap equal to the opening, keeping DOOR_FRAME_MM of wall at each end.
function doorWallSegments(map: SceneMap, doors: MergedDoor[], walls: Map<string, Segment>): Segment[] {
  const keys = new Set((map.floorPlan?.doors ?? []).filter((door) => !isSegmentDoor(door))
    .map((door) => edgePoints(door.cell!, door.edge!).join(",")));
  const segments = Array.from(walls).filter(([key]) => !keys.has(key)).map(([, segment]) => segment);
  for (const { points: [x1, y1, x2, y2], opening } of doors.filter((door) => !isSegmentDoor(door))) {
    segments.push({ x1, y1, x2: opening.x1, y2: opening.y1 }, { x1: opening.x2, y1: opening.y2, x2, y2 });
  }
  return segments;
}

function independentWallSegments(wall: Wall, doors: MergedDoor[]): Segment[] {
  const horizontal = wall.y1 === wall.y2;
  const piece = (from: number, to: number): Segment => horizontal
    ? { x1: from, y1: wall.y1, x2: to, y2: wall.y1 } : { x1: wall.x1, y1: from, x2: wall.x1, y2: to };
  const cuts = doors.filter((door) => door.wallId === wall.id)
    .map(({ opening }) => horizontal ? [opening.x1, opening.x2] : [opening.y1, opening.y2])
    .sort((a, b) => a[0] - b[0]);
  const segments: Segment[] = [];
  let cursor = horizontal ? wall.x1 : wall.y1;
  for (const [start, end] of cuts) {
    if (start > cursor) segments.push(piece(cursor, start));
    cursor = Math.max(cursor, end);
  }
  const high = horizontal ? wall.x2 : wall.y2;
  if (cursor < high) segments.push(piece(cursor, high));
  return segments;
}

export function buildNavigation(map: SceneMap): SceneNavigation {
  validateFloorPlan(map);
  const owners = new Map(map.rooms.flatMap((room) => room.cells.map((cell) => [cell, room.id] as const)));
  const walls = new Map<string, Segment>();
  for (const room of map.rooms) for (const cell of room.cells) for (const edge of EDGES) {
    if (!boundaryEdge(room, cell, edge)) continue;
    const [x1, y1, x2, y2] = edgePoints(cell, edge);
    walls.set([x1, y1, x2, y2].join(","), { x1, y1, x2, y2 });
  }
  const plan = map.floorPlan ?? { doors: [], furniture: [] };
  const furniture = new Set(plan.furniture.flatMap(furnitureCells));
  const doors = mergedDoors(map);
  return {
    schema: NAVIGATION_SCHEMA, units: "mm", width: AREA_WIDTH_MM, height: AREA_HEIGHT_MM,
    grid: { columns: COLUMNS, rows: ROWS, cellMm: CELL_MM, indexOrigin: "bottom-left" },
    cells: Array.from({ length: CELL_COUNT }, (_, cell) => {
      const roomId = owners.get(cell) ?? null;
      const reason = roomId === null ? "unassigned" : furniture.has(cell) ? "furniture" : "floor";
      return { cell, roomId, traversable: reason === "floor", reason };
    }),
    walls: [
      ...doorWallSegments(map, doors, walls),
      ...(plan.walls ?? []).flatMap((wall) => independentWallSegments(wall, doors)),
    ],
    doors: doors.map((door) => ({
      id: door.id, roomId: door.roomId,
      ...(door.cell === undefined ? {} : { cell: door.cell, edge: door.edge }),
      ...(door.name === undefined ? {} : { name: door.name }),
      ...(door.kind === undefined ? {} : { kind: door.kind }),
      memberIds: door.memberIds, adjacentRoomId: door.adjacentRoomId, opening: door.opening, state: "unspecified",
    })),
    obstacles: plan.furniture.map((item) => ({
      id: item.id, type: item.type, roomId: item.roomId, cell: item.cell,
      ...regionBounds(furnitureCells(item)), rotation: item.rotation,
    })),
  };
}
