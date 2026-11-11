import type { Action, SceneMap } from "./types";

export const MIN_HORIZON_S = 30;
export const MAX_HORIZON_S = 7200;
export const PX_MIN = 10;
export const PX_MAX = 120;
export const PX_DEFAULT = 26;
export const LANE_PAD_PX = 16;
export const MIN_BAR_PX = 12;
// Space kept free for the track header when fitting the horizon into a viewport.
const FIT_MARGIN_PX = 180;

const finite = (value: number) => (Number.isFinite(value) ? value : 0);

export function timelineHorizon(map: SceneMap, planDuration: number): number {
  let horizon = MIN_HORIZON_S;
  for (const track of map.tracks) {
    for (const action of track.actions) {
      horizon = Math.max(horizon, finite(action.position) + finite(action.runSeconds) + 4);
    }
  }
  const plan = Number.isNaN(planDuration) ? 0 : planDuration;
  horizon = Math.max(horizon, Math.min(3600, Math.max(0, plan) + 8));
  return Math.min(MAX_HORIZON_S, horizon);
}

export function rulerTicks(horizon: number, px: number): { time: number; left: number; label: string }[] {
  const step = px < 30 ? 5 : 2;
  const ticks: { time: number; left: number; label: string }[] = [];
  for (let time = 0; time <= horizon; time += step) {
    ticks.push({ time, left: timeToPx(time, px), label: `${time}s` });
  }
  return ticks;
}

export function quantize(seconds: number, fine: boolean): number {
  if (!Number.isFinite(seconds)) return 0;
  const rounded = fine ? Math.round(seconds * 10) / 10 : Math.round(seconds * 2) / 2;
  return Math.max(0, rounded);
}

export function timeToPx(time: number, px: number): number {
  return time * px + LANE_PAD_PX;
}

export function pxToTime(x: number, px: number): number {
  return (x - LANE_PAD_PX) / px;
}

export function barBox(action: Pick<Action, "position" | "runSeconds">, px: number): { left: number; width: number } {
  return { left: timeToPx(action.position, px), width: Math.max(MIN_BAR_PX, action.runSeconds * px) };
}

export function fitPx(viewportPx: number, horizon: number): number {
  if (!Number.isFinite(viewportPx) || !Number.isFinite(horizon) || horizon <= 0) return PX_DEFAULT;
  return Math.min(PX_MAX, Math.max(PX_MIN, (viewportPx - FIT_MARGIN_PX) / horizon));
}

export function formatTime(seconds: number): string {
  const tenths = Math.round(Math.max(0, finite(seconds)) * 10);
  const minutes = Math.floor(tenths / 600);
  const secs = Math.floor(tenths / 10) % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}.${tenths % 10}`;
}
