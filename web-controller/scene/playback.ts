export interface PlaybackState {
  time: number;
  running: boolean;
  looping: boolean;
  speed: number;
}

export const SPEEDS = [0.5, 1, 2, 4];

export function initialPlayback(): PlaybackState {
  return { time: 0, running: false, looping: false, speed: 1 };
}

const clampTime = (time: number, duration: number) => {
  if (!(duration > 0) || !Number.isFinite(time)) return 0;
  return Math.min(duration, Math.max(0, time));
}

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
