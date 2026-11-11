import { availableTypes } from "./actionEdit";
import { addActionToTrack, actionTypeLabel } from "./trackEdit";
import { timelineAlignment, type TimelineAlignment } from "./timelineEdit";
import { quantize } from "./timelineView";
import type { Action, ActionType, SceneMap, Track, TrackKind } from "./types";

export const MAX_START_S = 3500;
export const MAX_RUN_S = 3600;
export const MIN_RESIZE_S = 0.5;
export const KEY_RESIZE_STEP_S = 0.5;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

export interface Dragged {
  offset: number;
  match: TimelineAlignment | null;
}

// Group move: `anchor` is the bar under the pointer; the others keep their distance to it. Shift snaps to other bars' edges.
export function moveOffset(map: SceneMap, anchor: Action, group: readonly Action[], dxPx: number, px: number,
  { fine, snap }: { fine: boolean; snap: boolean }): Dragged {
  const ids = new Set(group.map((action) => action.id));
  const first = Math.min(...group.map((action) => action.position));
  const last = Math.max(...group.map((action) => action.position));
  const raw = anchor.position + dxPx / px;
  const targets = { tracks: map.tracks.map((track) => ({ ...track, actions: track.actions.filter((action) => action.id === anchor.id || !ids.has(action.id)) })) };
  const match = snap ? timelineAlignment(targets, anchor.id, raw, anchor.runSeconds, px) : null;
  const wanted = match?.value ?? quantize(raw, fine);
  return { offset: round6(clamp(wanted - anchor.position, -first, MAX_START_S - last)), match };
}

// Resize by the right-edge handle; the result is a change of the run time shared by every selected bar.
export function resizeOffset(map: SceneMap, anchor: Action, dxPx: number, px: number,
  { fine, snap }: { fine: boolean; snap: boolean }): Dragged {
  const raw = anchor.runSeconds + dxPx / px;
  const match = snap ? timelineAlignment(map, anchor.id, raw, anchor.position, px, { resize: true, min: MIN_RESIZE_S, max: MAX_RUN_S }) : null;
  const next = match?.value ?? clamp(quantize(raw, fine), MIN_RESIZE_S, MAX_RUN_S);
  return { offset: round6(next - anchor.runSeconds), match };
}

export const byStart = (track: Pick<Track, "actions">): Action[] => [...track.actions].sort((a, b) => a.position - b.position);

// Shift-click: every bar of the row between the anchor and the target, in start order.
export function rangeIds(track: Pick<Track, "actions">, anchorId: string, targetId: string): string[] {
  const ordered = byStart(track);
  const from = ordered.findIndex((action) => action.id === anchorId);
  const to = ordered.findIndex((action) => action.id === targetId);
  if (from < 0 || to < 0) return [targetId];
  return ordered.slice(Math.min(from, to), Math.max(from, to) + 1).map((action) => action.id);
}

const DEFAULT_TYPE: Record<TrackKind, ActionType> = { robot: "move", human: "move", room: "event-start", display: "show" };

export interface ActionRequest {
  trackId: string;
  actionId: null;
  type: ActionType;
  overrides: { position: number };
}

export function addRequest(track: Pick<Track, "id" | "kind">, position: number, fine: boolean, type?: ActionType): ActionRequest {
  return { trackId: track.id, actionId: null, type: type ?? DEFAULT_TYPE[track.kind], overrides: { position: quantize(position, fine) } };
}

// Why an action of `type` cannot be added to this row at all (row-level reasons only).
export function addProblem(track: Pick<Track, "name" | "kind" | "locked">, type: ActionType): string {
  if (track.locked) return "この行はロックされています。";
  if (!availableTypes(track).includes(type)) return `${track.name} に「${actionTypeLabel(type)}」は配置できません。`;
  return "";
}

export type DropPreview = { ok: true; runSeconds: number } | { ok: false; reason: string };

// A dry run of the real edit, so the preview refuses exactly what the edit would refuse (overlap included).
export function previewDrop(map: SceneMap, trackId: string, type: ActionType, position: number): DropPreview {
  try {
    const { map: next, actionId } = addActionToTrack(map, trackId, type, { position }, () => "drop-preview");
    const added = next.tracks.flatMap((track) => track.actions).find((action) => action.id === actionId);
    return { ok: true, runSeconds: added?.runSeconds ?? 0 };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

// WCAG 2.x relative luminance; picks the ink with the larger contrast against a #rrggbb background.
export const INK_LIGHT = "#ffffff";
export const INK_DARK = "#000000";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

export function inkFor(background: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(background)) return INK_DARK;
  return contrastRatio(background, INK_LIGHT) >= contrastRatio(background, INK_DARK) ? INK_LIGHT : INK_DARK;
}

export type BarStatus = "blocked" | "waiting" | "running" | "complete" | "failed";

// The plan is sampled once at its end, so `blocked` and `failed` are the verdict for the whole run.
// A bar the plan expects to fail says so before it starts too, instead of looking merely "waiting".
export function barStatus(state: { status: string; start: number | null; end: number | null } | undefined, time: number): BarStatus {
  if (!state) return "waiting";
  if (state.status === "blocked") return "blocked";
  if (state.status === "failed") return "failed";
  if (state.start === null || time < state.start) return "waiting";
  if (state.end !== null && time < state.end) return "running";
  return "complete";
}