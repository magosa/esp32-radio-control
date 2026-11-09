import { AREA_HEIGHT_MM, AREA_WIDTH_MM } from "./units";
import type { CueKind, Presentation, PresentationCue } from "./types";

const KINDS: readonly CueKind[] = ["zone", "dirt", "crowd", "fire", "scan", "route", "notice", "car"];
const MAX_SECONDS = 86400;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function validatePresentation(value: unknown): Presentation {
  check(isObj(value) && value.version === 1, "presentation.version must be 1");
  check(typeof value.scenarioId === "string" && /^[a-z0-9-]{1,60}$/.test(value.scenarioId), "presentation.scenarioId is invalid");
  check(Array.isArray(value.cues) && value.cues.length <= 160, "presentation.cues must be an array of at most 160");
  for (const cue of value.cues as unknown[]) {
    check(isObj(cue) && KINDS.includes(cue.kind as CueKind), "cue.kind is invalid");
    const { start, end } = cue;
    check(finite(start) && finite(end) && start >= 0 && end > start && end <= MAX_SECONDS,
      `cue.start/end must satisfy 0 <= start < end <= ${MAX_SECONDS}`);
    check(typeof cue.label === "string" && cue.label.length <= 180, "cue.label must be a string of at most 180 chars");
    check(typeof cue.color === "string" && /^#[0-9a-f]{6}$/i.test(cue.color), "cue.color must be #RRGGBB");
    if (cue.kind === "route") {
      check(Array.isArray(cue.points) && cue.points.length >= 2 && cue.points.length <= 40, "cue.points must have 2..40 points");
      for (const p of cue.points as unknown[]) {
        check(Array.isArray(p) && p.length === 2 && finite(p[0]) && p[0] >= 0 && p[0] <= AREA_WIDTH_MM &&
          finite(p[1]) && p[1] >= 0 && p[1] <= AREA_HEIGHT_MM, "cue point must be [x, y] within the area");
      }
    } else if (cue.kind !== "notice") {
      const { x, y, width, height } = cue;
      check(finite(x) && finite(y) && finite(width) && finite(height) && x >= 0 && y >= 0 && width > 0 && height > 0 &&
        x + width <= AREA_WIDTH_MM && y + height <= AREA_HEIGHT_MM, "cue x/y/width/height must lie within the area");
    }
  }
  return value as unknown as Presentation;
}

export function presentationAt(presentation: Presentation | undefined, time: number): PresentationCue[] {
  return (presentation?.cues ?? []).filter((cue) => cue.start <= time && time < cue.end);
}
