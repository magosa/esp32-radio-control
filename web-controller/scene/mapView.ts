import { furnitureCells, regionBounds } from "./floorPlan";
import type { Furniture, SceneMap, Segment } from "./types";
import { AREA_HEIGHT_MM, AREA_WIDTH_MM, CELL_MM } from "./units";
import { cellColRow } from "./grid";

export const VIEW_WIDTH = AREA_WIDTH_MM;
export const VIEW_HEIGHT = AREA_HEIGHT_MM;
export const VIEW_BOX = `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`;
export const ROBOT_SIDE_MM = 80;
export const MIN_TEXT_PX = 12;
// Pointer movement (px) up to which a press and release still count as a tap.
const TAP_SLOP_PX = 8;
const DISPLAY_MAX_CHARS = 22;
const DISPLAY_MAX_LINES = 5;

export interface Point {
  x: number;
  y: number;
}

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export const svgY = (y: number): number => VIEW_HEIGHT - y;
export const mmToSvg = (p: Point): Point => ({ x: p.x, y: svgY(p.y) });
export const svgToMm = (p: Point): Point => ({ x: p.x, y: svgY(p.y) });
// Upstream yaw is counter-clockwise; SVG rotation is clockwise.
export const svgAngle = (yaw: number): number => 0 - yaw;

export function clampToArea(p: Point): Point {
  return { x: clamp(p.x, 0, VIEW_WIDTH), y: clamp(p.y, 0, VIEW_HEIGHT) };
}

export function applyMatrix(m: Matrix, x: number, y: number): Point {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

// `inverse` is the inverse of the svg's getScreenCTM().
export function clientToMm(client: Point, inverse: Matrix): Point {
  const svg = applyMatrix(inverse, client.x, client.y);
  return clampToArea(svgToMm(svg));
}

export function isTap(down: Point, up: Point, slop = TAP_SLOP_PX): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= slop;
}

export type ZoomId = "fit" | "150" | "200" | "400";
export const ZOOMS: readonly { id: ZoomId; label: string; factor: number }[] = [
  { id: "fit", label: "全体", factor: 1 },
  { id: "150", label: "150%", factor: 1.5 },
  { id: "200", label: "200%", factor: 2 },
  { id: "400", label: "400%", factor: 4 },
];

// Share of the scroll viewport's width; "fit" keeps the whole area visible.
export function zoomWidth(id: ZoomId): string {
  const zoom = ZOOMS.find((item) => item.id === id) ?? ZOOMS[0];
  return `${zoom.factor * 100}%`;
}

export function pxPerMm(width: number, height: number): number {
  const scale = Math.min(width / VIEW_WIDTH, height / VIEW_HEIGHT);
  return Number.isFinite(scale) && scale > 0 ? scale : 0;
}

export function textMm(designMm: number, scale: number, minPx = MIN_TEXT_PX): number {
  return scale > 0 ? Math.max(designMm, minPx / scale) : designMm;
}

export function cellPath(cells: readonly number[]): string {
  return cells.map((cell) => {
    const { col, row } = cellColRow(cell);
    return `M${col * CELL_MM} ${svgY((row + 1) * CELL_MM)}h${CELL_MM}v${CELL_MM}h${-CELL_MM}Z`;
  }).join("");
}

// Interior lines only; the area border is drawn separately.
export function gridLines(gridMm: number): { xs: number[]; ys: number[] } {
  const lines = (limit: number) => {
    const values: number[] = [];
    for (let v = gridMm; v < limit; v += gridMm) values.push(v);
    return values;
  };
  return { xs: lines(VIEW_WIDTH), ys: lines(VIEW_HEIGHT) };
}

// Offsets from the actor centre in svg space.
export function headingArrow(yawDeg: number, tip: number, head: number): { tip: Point; barbs: [Point, Point] } {
  const at = (deg: number, length: number): Point => {
    const radians = deg * Math.PI / 180;
    return { x: Math.cos(radians) * length, y: -Math.sin(radians) * length };
  };
  const end = at(yawDeg, tip);
  const barb = (deg: number): Point => {
    const offset = at(deg, head);
    return { x: end.x + offset.x, y: end.y + offset.y };
  };
  return { tip: end, barbs: [barb(yawDeg + 150), barb(yawDeg - 150)] };
}

export interface FurnitureLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  long: boolean;
}

// Centre in svg space; width/height already account for the item's rotation.
export function furnitureLayout(item: Pick<Furniture, "cell" | "cells" | "type" | "rotation">): FurnitureLayout {
  const cells = furnitureCells(item);
  const bounds = regionBounds(cells);
  const sideways = item.rotation % 180 !== 0;
  let width = sideways ? bounds.height : bounds.width;
  let height = sideways ? bounds.width : bounds.height;
  const long = cells.length > 1;
  let rotation: number = item.rotation;
  // A vertical long item is drawn turned so its back runs along the long side.
  if (long && item.type !== "plant" && height > width) {
    [width, height] = [height, width];
    rotation += 90;
  }
  return { x: bounds.x + bounds.width / 2, y: svgY(bounds.y + bounds.height / 2), width, height, rotation, long };
}

export interface DoorLayout {
  x: number;
  y: number;
  length: number;
  rotate: 0 | 90;
}

// The door is drawn along local +x from its left (horizontal) or top (vertical) end.
export function doorLayout(opening: Segment): DoorLayout {
  if (opening.y1 === opening.y2) {
    return { x: Math.min(opening.x1, opening.x2), y: svgY(opening.y1), length: Math.abs(opening.x2 - opening.x1), rotate: 0 };
  }
  return { x: opening.x1, y: svgY(Math.max(opening.y1, opening.y2)), length: Math.abs(opening.y2 - opening.y1), rotate: 90 };
}

export function wrapDisplayText(text: string): string[] {
  const all = text.split("\n").flatMap((line) => {
    const chars = Array.from(line);
    return chars.length
      ? Array.from({ length: Math.ceil(chars.length / DISPLAY_MAX_CHARS) }, (_, i) =>
        chars.slice(i * DISPLAY_MAX_CHARS, (i + 1) * DISPLAY_MAX_CHARS).join(""))
      : [""];
  });
  const lines = all.slice(0, DISPLAY_MAX_LINES);
  if (all.length > DISPLAY_MAX_LINES) lines[DISPLAY_MAX_LINES - 1] += "…";
  return lines;
}

export interface DisplayLayout {
  lines: string[];
  // Centre in mm (y up), clamped so the whole box stays inside the area.
  x: number;
  y: number;
  width: number;
  height: number;
  lineHeight: number;
}

export function displayLayout(text: string, fontMm: number, center: Point): DisplayLayout {
  const lines = wrapDisplayText(text);
  const chars = Math.max(1, ...lines.map((line) => Array.from(line).length));
  const width = Math.min(VIEW_WIDTH, Math.max(fontMm * 5, (chars + 1) * fontMm));
  const lineHeight = fontMm * 1.3;
  const height = Math.min(VIEW_HEIGHT, lines.length * lineHeight + fontMm);
  return {
    lines, width, height, lineHeight,
    x: clamp(center.x, width / 2, VIEW_WIDTH - width / 2),
    y: clamp(center.y, height / 2, VIEW_HEIGHT - height / 2),
  };
}

export function mapSummary(
  map: Pick<SceneMap, "name" | "rooms">,
  state: { time: number; actors: readonly { kind: string; count: number }[] },
): string {
  const robots = state.actors.filter((actor) => actor.kind === "robot").length;
  const humans = state.actors.filter((actor) => actor.kind === "human").reduce((sum, actor) => sum + actor.count, 0);
  return `${map.name}。部屋${map.rooms.length}室、ロボット${robots}台、人${humans}人、時刻${state.time.toFixed(1)}秒`;
}
