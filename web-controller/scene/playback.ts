import type { SceneMap } from "./types";

export interface PlaybackState {
  time: number;
  running: boolean;
  looping: boolean;
  speed: number;
}

export const SPEEDS = [0.5, 1, 2, 4];
const POINT_EPS = 1e-4;

export function initialPlayback(): PlaybackState {
  return { time: 0, running: false, looping: false, speed: 1 };
}

const clampTime = (time: number, duration: number) => {
  if (!(duration > 0) || !Number.isFinite(time)) return 0;
  return Math.min(duration, Math.max(0, time));
};

export function step(state: PlaybackState, deltaMs: number, duration: number): PlaybackState {
  if (!(duration > 0)) return { ...state, time: 0, running: false };
  if (!state.running) return { ...state };
  const delta = Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
  const time = state.time + (delta / 1000) * state.speed;
  if (time < duration) return { ...state, time: Math.max(0, time) };
  return state.looping ? { ...state, time: 0 } : { ...state, time: duration, running: false };
}

export function seek(state: PlaybackState, time: number, duration: number): PlaybackState {
  return { ...state, time: clampTime(time, duration) };
}

export function toggle(state: PlaybackState, duration: number): PlaybackState {
  if (state.running) return { ...state, running: false };
  if (!(duration > 0)) return { ...state, time: 0, running: false };
  return { ...state, time: state.time >= duration ? 0 : state.time, running: true };
}

export function pause(state: PlaybackState): PlaybackState {
  return state.running ? { ...state, running: false } : { ...state };
}

export function home(state: PlaybackState): PlaybackState {
  return { ...state, time: 0, running: false };
}

export function setSpeed(state: PlaybackState, speed: number): PlaybackState {
  if (!SPEEDS.includes(speed)) throw new Error("再生速度は 0.5・1・2・4 のいずれかにしてください。");
  return { ...state, speed };
}

export function toggleLoop(state: PlaybackState): PlaybackState {
  return { ...state, looping: !state.looping };
}

export function clampTo(state: PlaybackState, duration: number): PlaybackState {
  if (!(duration > 0)) return { ...state, time: 0, running: false };
  return { ...state, time: clampTime(state.time, duration) };
}

// Sorted, deduplicated bar start/end times (plus 0 and duration) for prev/next edit-point navigation (F20).
export function editPoints(map: Pick<SceneMap, "tracks">, duration: number): number[] {
  const maxTime = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const raw: number[] = [0];
  if (maxTime > 0) raw.push(maxTime);
  for (const track of map.tracks) {
    if (track.muted) continue;
    for (const action of track.actions) {
      if (Number.isFinite(action.position) && action.position >= 0) {
        raw.push(Math.min(maxTime || Infinity, Math.round(action.position * 1e6) / 1e6));
      }
      const end = action.position + action.runSeconds;
      if (Number.isFinite(end) && end >= 0) {
        raw.push(Math.min(maxTime || Infinity, Math.round(end * 1e6) / 1e6));
      }
    }
  }
  raw.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const t of raw) {
    if (unique.length === 0 || t - unique[unique.length - 1] > POINT_EPS) unique.push(t);
  }
  return unique;
}

export function prevEditPoint(points: readonly number[], time: number): number {
  const current = Number.isFinite(time) ? time : 0;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i] < current - POINT_EPS) return points[i];
  }
  return 0;
}

export function nextEditPoint(points: readonly number[], time: number): number {
  const current = Number.isFinite(time) ? time : 0;
  for (let i = 0; i < points.length; i++) {
    if (points[i] > current + POINT_EPS) return points[i];
  }
  return points.length > 0 ? points[points.length - 1] : 0;
}
