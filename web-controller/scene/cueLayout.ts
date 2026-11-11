import { presentationAt } from "./presentation";
import { textMm } from "./mapView";
import type { Presentation, PresentationCue } from "./types";
import { AREA_HEIGHT_MM, AREA_WIDTH_MM } from "./units";

// Sizes below are the upstream design (1600 x 900 units) converted at 1100 mm / 1600 units.
const K = AREA_WIDTH_MM / 1600;
const STROKE = 5 * K;
const ROUTE_STROKE = 7 * K;
const SCATTER_COUNT = 12;
const LABEL_FONT = 20 * K;
const NOTICE_FONT = 22 * K;
const TITLE_FONT = 23 * K;
const NOTICE_X = 16 * K;
const NOTICE_Y = 16 * K;
const NOTICE_HEIGHT = 35 * K;
const NOTICE_PITCH = 39 * K;
const LABEL_PAD = 10 * K;

export const CUE_STROKE_MM = STROKE;
export const CUE_ROUTE_STROKE_MM = ROUTE_STROKE;

export interface CueText {
  x: number;
  y: number;
  size: number;
  lines: string[];
  lineHeight: number;
}

export interface CueMark {
  // A dot (dirt, crowd, fire) or a cross (scan).
  shape: "dot" | "cross";
  x: number;
  y: number;
  r: number;
}

export type CueShape =
  | { kind: "notice"; color: string; x: number; y: number; width: number; height: number; text: CueText }
  | { kind: "route"; color: string; points: { x: number; y: number }[]; arrows: { x: number; y: number; angle: number }[]; text: CueText }
  | { kind: "zone" | "dirt" | "crowd" | "fire" | "scan" | "car"; color: string; x: number; y: number; width: number; height: number;
    dashed: boolean; marks: CueMark[]; body: { x: number; y: number; width: number; height: number } | null; text: CueText };

const svgY = (y: number) => AREA_HEIGHT_MM - y;

// Wraps by character count: the labels are mostly Japanese, where one character is one em wide.
export function wrapLabel(label: string, capacity: number): string[] {
  const characters = Array.from(label);
  const lines: string[] = [];
  for (let offset = 0; offset < characters.length; offset += capacity) lines.push(characters.slice(offset, offset + capacity).join(""));
  return lines.length ? lines : [""];
}

function scatter(cue: PresentationCue & { x: number; y: number; width: number; height: number }, top: number): CueMark[] {
  if (!["dirt", "crowd", "fire", "scan"].includes(cue.kind)) return [];
  return Array.from({ length: SCATTER_COUNT }, (_, i) => {
    const x = cue.x + cue.width * (((i * 7) % 13 + 1) / 14);
    const y = top + cue.height * (((i * 5) % 11 + 1) / 12);
    if (cue.kind === "scan") return { shape: "cross" as const, x, y, r: 15 * K };
    return { shape: "dot" as const, x, y, r: (cue.kind === "crowd" ? 11 : 6 + (i % 4) * 3) * K };
  });
}

// The cue as plain geometry in the map's SVG units (y down). `scale` is px per mm; it only keeps text legible on a small view.
export function layoutCue(cue: PresentationCue, noticeIndex: number, scale: number): CueShape {
  if (cue.kind === "notice") {
    const font = textMm(NOTICE_FONT, scale);
    const y = NOTICE_Y + noticeIndex * NOTICE_PITCH;
    return { kind: "notice", color: cue.color, x: NOTICE_X, y, width: AREA_WIDTH_MM - 2 * NOTICE_X, height: NOTICE_HEIGHT,
      text: { x: 30 * K, y: y + 25 * K, size: font, lines: [cue.label], lineHeight: font } };
  }
  if (cue.kind === "route") {
    const points = (cue.points ?? []).map(([x, y]) => ({ x, y: svgY(y) }));
    const arrows = points.slice(1).map((point, i) => {
      const previous = points[i];
      return { x: point.x, y: point.y, angle: Math.atan2(point.y - previous.y, point.x - previous.x) * 180 / Math.PI };
    });
    const font = textMm(TITLE_FONT, scale);
    const first = points[0] ?? { x: 0, y: 0 };
    return { kind: "route", color: cue.color, points, arrows,
      text: { x: Math.min(first.x, 1000 * K), y: first.y - 25 * K, size: font, lines: [cue.label], lineHeight: font } };
  }
  const { x = 0, y = 0, width = 0, height = 0 } = cue;
  const top = svgY(y) - height;
  const font = textMm(LABEL_FONT, scale);
  const capacity = Math.max(5, Math.floor((width - LABEL_PAD) / LABEL_FONT));
  const kind = cue.kind;
  return {
    kind, color: cue.color, x, y: top, width, height, dashed: kind === "zone",
    marks: scatter({ ...cue, x, y, width, height }, top),
    body: kind === "car" ? { x: x + 15 * K, y: top + 25 * K, width: width - 30 * K, height: Math.max(20 * K, height - 65 * K) } : null,
    text: { x: x + LABEL_PAD, y: top + 25 * K, size: font, lines: wrapLabel(cue.label, capacity), lineHeight: 24 * K },
  };
}

export function layoutCues(presentation: Presentation | undefined, time: number, scale: number): CueShape[] {
  let notices = 0;
  return presentationAt(presentation, time).map((cue) => layoutCue(cue, cue.kind === "notice" ? notices++ : 0, scale));
}
