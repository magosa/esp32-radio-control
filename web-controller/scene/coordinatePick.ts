import { roomAnchor, roomContainsPoint } from "./floorPlan";
import { snapToEditGrid } from "./grid";
import { clampToArea } from "./mapView";
import { createSafety, pathProblem } from "./safety";
import type { CoordinateMode, Room, SceneMap, TrackKind } from "./types";
import { HUMAN_RADIUS_MM, SAFETY_RADIUS_MM, normalizeYaw } from "./units";

export type PickMode = CoordinateMode;

interface Point {
  x: number;
  y: number;
}

const BAD_YAW = "初期の向きは -180〜180° で指定してください。";
const EPS = 1e-7;

function requireFinite(point: Point): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("座標は有限数で指定してください。");
}

// Shared edges belong to both regions; the first one in map order wins.
const roomAt = (map: SceneMap, x: number, y: number): Room | undefined =>
  map.rooms.find((room) => roomContainsPoint(room, x, y));

export function pickPoint(map: SceneMap, mm: Point, mode: PickMode): { x: number; y: number; roomId: string } {
  requireFinite(mm);
  if (mode !== "grid" && mode !== "free") throw new Error("座標指定モードが不正です。");
  const clamped = clampToArea(mm);
  const point = mode === "grid" ? snapToEditGrid(clamped.x, clamped.y, map.editGridMm) : clamped;
  return { x: point.x, y: point.y, roomId: roomAt(map, point.x, point.y)?.id ?? "" };
}

// Upstream: the x axis wins when the movements are equal.
export function constrainAxis(origin: Point, point: Point): Point {
  requireFinite(origin);
  requireFinite(point);
  return Math.abs(point.x - origin.x) >= Math.abs(point.y - origin.y)
    ? { x: point.x, y: origin.y }
    : { x: origin.x, y: point.y };
}

export function normalizeYaw180(deg: number): number {
  if (!Number.isFinite(deg)) throw new Error("向きは有限数で指定してください。");
  return normalizeYaw(deg);
}

const radiusOf = (kind: TrackKind) => kind === "robot" ? SAFETY_RADIUS_MM : HUMAN_RADIUS_MM;

// An initial pose (yaw given) must not overlap another row's initial pose; the caller leaves the row being edited out of `map`.
function overlapProblem(map: SceneMap, kind: "robot" | "human", point: Point): string {
  for (const other of map.tracks) {
    if (!other.initial || (other.kind !== "robot" && other.kind !== "human")) continue;
    if (kind === "human" && other.kind === "human") continue;
    const clearance = radiusOf(kind) + radiusOf(other.kind);
    if (Math.hypot(other.initial.x - point.x, other.initial.y - point.y) < clearance - EPS) {
      return "他の行の初期位置と重なります。位置をずらしてください。";
    }
  }
  return "";
}

export function pickProblem(map: SceneMap, kind: TrackKind, point: Point, yaw?: number): string {
  requireFinite(point);
  if (yaw !== undefined && (!Number.isFinite(yaw) || yaw < -180 || yaw > 180)) return BAD_YAW;
  if (kind !== "robot" && kind !== "human") return "";
  const problem = pathProblem(createSafety(map), point, point, kind);
  if (problem) return problem;
  return yaw === undefined ? "" : overlapProblem(map, kind, point);
}

export function pickRoom(map: SceneMap, mm: Point): { roomId: string; anchor: Point } | null {
  requireFinite(mm);
  const room = roomAt(map, mm.x, mm.y);
  return room ? { roomId: room.id, anchor: roomAnchor(room) } : null;
}
