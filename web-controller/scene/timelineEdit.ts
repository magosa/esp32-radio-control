import type { SceneMap, Track } from "./types";

const MAX_SECONDS = 86400;

export interface TimelineAlignment {
  value: number;
  time: number;
  distance: number;
  name: string;
}

export function checkSequence(track: Pick<Track, "name" | "actions">): void {
  const actions = [...track.actions].sort((a, b) => a.position - b.position);
  let end = 0;
  for (const action of actions) {
    if (!Number.isFinite(action.position) || action.position < 0 ||
      !Number.isFinite(action.runSeconds) || action.runSeconds < 0 || action.runSeconds > MAX_SECONDS) {
      throw new Error(`${track.name} / ${action.name}: 開始時刻・秒数が不正です。`);
    }
    if (action.position < end - 1e-7) throw new Error(`${track.name} / ${action.name}: 同じ行のバーが重なっています。`);
    end = action.position + action.runSeconds;
  }
}

export function adjustTimeline(map: SceneMap, actionIds: string[], offset: number, durationOffset = 0): SceneMap {
  if (!actionIds.length || !Number.isFinite(offset) || !Number.isFinite(durationOffset)) {
    throw new Error("調整するブロックと有限の秒数を指定してください。");
  }
  const result = structuredClone(map), ids = new Set(actionIds), found = new Set<string>();
  for (const track of result.tracks) {
    const actions = track.actions.filter((action) => ids.has(action.id));
    if (!actions.length) continue;
    if (track.locked) throw new Error(`${track.name} は編集ロック中です。`);
    for (const action of actions) {
      found.add(action.id);
      action.position = Math.round((action.position + offset) * 1e6) / 1e6;
      if (durationOffset) {
        const seconds = action.runSeconds + durationOffset;
        if (seconds < 0.1) throw new Error("調整後の秒数は0.1秒以上にしてください。");
        action.runSeconds = seconds;
        if (action.motion === "rotate") action.rotationSeconds = seconds;
      }
    }
    checkSequence(track);
  }
  if (found.size !== ids.size) throw new Error("選択したブロックが見つかりません。選び直してください。");
  return result;
}

export function reorderSequence(track: Track, actionId: string, direction: -1 | 1): void {
  if (track.locked) throw new Error("この行はロックされています。");
  const actions = [...track.actions].sort((a, b) => a.position - b.position);
  const index = actions.findIndex((action) => action.id === actionId), other = index + direction;
  if (index < 0) throw new Error("入れ替えるブロックがありません。");
  if (other < 0 || other >= actions.length) throw new Error("これ以上移動できません。");
  const left = Math.min(index, other), right = Math.max(index, other);
  const start = actions[left].position;
  const gap = Math.max(0, actions[right].position - start - actions[left].runSeconds);
  [actions[left], actions[right]] = [actions[right], actions[left]];
  actions[left].position = start;
  actions[right].position = start + actions[left].runSeconds + gap;
  track.actions = actions;
  checkSequence(track);
}

// Shift-snap: `value` is a start (or a duration when resize) aligned to other bars' edges within 8 screen px.
export function timelineAlignment(
  map: Pick<SceneMap, "tracks">,
  actionId: string,
  value: number,
  duration: number,
  pixelsPerSecond: number,
  { resize = false, min = 0, max = 3500 }: { resize?: boolean; min?: number; max?: number } = {},
): TimelineAlignment | null {
  let best: TimelineAlignment | null = null;
  for (const track of map.tracks) for (const action of track.actions) {
    if (action.id === actionId) continue;
    for (const time of [action.position, action.position + action.runSeconds]) {
      for (const offset of resize ? [duration] : [0, duration]) {
        const aligned = time - offset, distance = Math.abs(aligned - value) * pixelsPerSecond;
        if (aligned < min || aligned > max || distance > 8) continue;
        if (!best || distance < best.distance) best = { value: aligned, time, distance, name: `${track.name} / ${action.name}` };
      }
    }
  }
  return best;
}
