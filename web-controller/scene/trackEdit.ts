import { cellCenter } from "./grid";
import { defaultId, type IdFactory } from "./ids";
import { KINDS, newAction, newTrack, validateProject } from "./model";
import { createSafety, pathProblem } from "./safety";
import { checkSequence } from "./timelineEdit";
import { SCENE_SCHEMA, type Action, type ActionType, type Pose, type SceneMap, type Track, type TrackKind } from "./types";
import { HUMAN_RADIUS_MM, SAFETY_RADIUS_MM } from "./units";

export const MAX_TRACKS = 128;

const MAX_COUNT = 1000;
const MAX_NAME = 120;
const COPY_OFFSET_S = 6;
const COPY_SUFFIX = " copy";
const CLEARANCE_MM = 5;
const EDITABLE = ["name", "color", "count", "robotRole", "robotId", "roomId"] as const;
const ROLES = ["cleaning", "security", "delivery"];
const RESERVED_IDS = ["$start", "__proto__", "constructor", "prototype"];

const ALLOWED: Record<TrackKind, readonly ActionType[]> = {
  robot: ["move", "show", "hide", "wait"],
  human: ["move", "show", "hide", "wait"],
  room: ["event-start", "event-end", "unlock", "wait"],
  display: ["show", "hide", "wait"],
};
const ACTION_LABELS: Record<ActionType, string> = {
  move: "移動", show: "表示", hide: "表示を消去", "event-start": "イベント発生",
  "event-end": "イベント終了", unlock: "ドア解錠", wait: "待機",
};

export const trackKindLabel = (kind: TrackKind): string => KINDS[kind];
export const actionTypeLabel = (type: ActionType): string => ACTION_LABELS[type] ?? String(type);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function trackAt(map: SceneMap, trackId: string): number {
  const index = map.tracks.findIndex((track) => track.id === trackId);
  check(index >= 0, "行が見つかりません。");
  return index;
}

const unlocked = (track: Track) => check(!track.locked, `${track.name} は編集ロック中です。`);

// Final guard shared with project loading, so no edit can produce a map the validator rejects.
function finish(map: SceneMap): SceneMap {
  try {
    validateProject({ schema: SCENE_SCHEMA, name: "scene", maps: [map] });
  } catch (error) {
    throw new Error(`マップの内容が不正です。(${(error as Error).message})`);
  }
  return map;
}

const radiusOf = (kind: TrackKind) => (kind === "robot" ? SAFETY_RADIUS_MM : HUMAN_RADIUS_MM);

function freeInitial(map: SceneMap, kind: "robot" | "human"): Pose {
  const safety = createSafety(map);
  for (const cell of safety.navigation.cells) {
    const point = cellCenter(cell.cell);
    const clear = map.tracks.every((other) => !other.initial ||
      Math.hypot(other.initial.x - point.x, other.initial.y - point.y) >= radiusOf(other.kind) + radiusOf(kind) + CLEARANCE_MM);
    if (clear && pathProblem(safety, point, point, kind) === "") return { ...point, yaw: 0, roomId: cell.roomId ?? "" };
  }
  throw new Error("初期位置を配置できる空きがありません。先にマップ編集で部屋・廊下を広げてください。");
}

export function addTrack(
  map: SceneMap, kind: TrackKind, opts: { roomId?: string; index?: number } = {}, makeId: IdFactory = defaultId,
): { map: SceneMap; trackId: string } {
  check(Object.hasOwn(KINDS, kind), "行の種類が不正です。");
  check(map.tracks.length < MAX_TRACKS, `トラックは最大${MAX_TRACKS}本です。`);
  if (kind === "room") check(map.rooms.length > 0, "先にマップ編集で部屋・廊下を作成してください。");
  const index = opts.index ?? map.tracks.length;
  check(Number.isInteger(index) && index >= 0 && index <= map.tracks.length, "挿入位置が不正です。");
  const result = structuredClone(map);
  const added = newTrack(result, kind, makeId);
  if (kind === "room" && opts.roomId !== undefined) {
    check(result.rooms.some((room) => room.id === opts.roomId), "指定された部屋が見つかりません。");
    added.roomId = opts.roomId;
  }
  if (kind === "robot" || kind === "human") added.initial = freeInitial(result, kind);
  result.tracks.splice(index, 0, added);
  return { map: finish(result), trackId: added.id };
}

// A row that sits anywhere in the moved span would be shifted, so every one of them must be unlocked.
export function moveTrack(map: SceneMap, trackId: string, toIndex: number): SceneMap {
  const from = trackAt(map, trackId);
  check(Number.isInteger(toIndex) && toIndex >= 0 && toIndex < map.tracks.length, "これ以上移動できません。");
  for (let i = Math.min(from, toIndex); i <= Math.max(from, toIndex); i++) {
    check(!map.tracks[i].locked, `${map.tracks[i].name} は編集ロック中のため入れ替えられません。`);
  }
  const result = structuredClone(map);
  const [moved] = result.tracks.splice(from, 1);
  result.tracks.splice(toIndex, 0, moved);
  return result;
}

export function moveTrackBy(map: SceneMap, trackId: string, direction: -1 | 1): SceneMap {
  return moveTrack(map, trackId, trackAt(map, trackId) + direction);
}

export function setTrackFlag(map: SceneMap, trackId: string, flag: "muted" | "locked", value: boolean): SceneMap {
  check(flag === "muted" || flag === "locked", "変更できない項目です。");
  check(typeof value === "boolean", "設定値が不正です。");
  const result = structuredClone(map);
  result.tracks[trackAt(result, trackId)][flag] = value;
  return result;
}

export function updateTrack(
  map: SceneMap, trackId: string,
  patch: Partial<Pick<Track, "name" | "color" | "count" | "robotRole" | "robotId" | "roomId">>,
): SceneMap {
  const result = structuredClone(map);
  const track = result.tracks[trackAt(result, trackId)];
  unlocked(track);
  const values: Record<string, unknown> = patch;
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value === undefined) continue;
    check((EDITABLE as readonly string[]).includes(key), "変更できない項目です。");
    if (key === "name") {
      check(typeof value === "string" && value.length >= 1 && value.length <= MAX_NAME, `名前は1〜${MAX_NAME}文字で指定してください。`);
      track.name = value;
    } else if (key === "color") {
      check(typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value), "色は#RRGGBB形式で指定してください。");
      track.color = value;
    } else if (key === "count") {
      check(track.kind === "human", "人数を設定できるのは人の行だけです。");
      check(Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_COUNT, `人数は1〜${MAX_COUNT}の整数で指定してください。`);
      track.count = value as number;
    } else if (key === "robotRole") {
      check(track.kind === "robot", "ロボットの役割を設定できるのはロボットの行だけです。");
      check(ROLES.includes(value as string), "ロボットの役割が不正です。");
      track.robotRole = value as Track["robotRole"];
    } else if (key === "robotId") {
      check(track.kind === "robot", "ロボットIDを設定できるのはロボットの行だけです。");
      check(typeof value === "string" && value.length >= 1 && value.length <= 100 && !RESERVED_IDS.includes(value),
        "ロボットIDは1〜100文字で、予約語以外を指定してください。");
      check(!result.tracks.some((other) => other.id !== track.id && other.robotId === value), "ロボットIDが他の行と重複しています。");
      track.robotId = value;
    } else {
      check(track.kind === "room", "部屋を設定できるのは部屋の行だけです。");
      check(result.rooms.some((room) => room.id === value), "指定された部屋が見つかりません。");
      track.roomId = value as string;
    }
  }
  return finish(result);
}

export function setInitialPose(map: SceneMap, trackId: string, pose: Pose): SceneMap {
  const result = structuredClone(map);
  const track = result.tracks[trackAt(result, trackId)];
  check(track.kind === "robot" || track.kind === "human", "初期位置を持つのはロボットと人の行だけです。");
  unlocked(track);
  const problem = pathProblem(createSafety(result), pose, pose, track.kind);
  check(!problem, problem);
  track.initial = { ...pose };
  return finish(result);
}

// Upstream parity: the validator lets a hide / event-end outlive its show / event-start, so the row is just removed.
export function deleteTrack(map: SceneMap, trackId: string): SceneMap {
  const result = structuredClone(map);
  const index = trackAt(result, trackId);
  unlocked(result.tracks[index]);
  result.tracks.splice(index, 1);
  return finish(result);
}

export function deleteActions(map: SceneMap, actionIds: string[]): SceneMap {
  check(actionIds.length > 0, "削除する動作を指定してください。");
  const result = structuredClone(map), ids = new Set(actionIds), found = new Set<string>();
  for (const track of result.tracks) {
    const hit = track.actions.filter((action) => ids.has(action.id));
    if (!hit.length) continue;
    unlocked(track);
    hit.forEach((action) => found.add(action.id));
    track.actions = track.actions.filter((action) => !ids.has(action.id));
  }
  check(found.size === ids.size, "選択した動作が見つかりません。選び直してください。");
  return finish(result);
}

export function duplicateAction(map: SceneMap, actionId: string, makeId: IdFactory = defaultId): { map: SceneMap; actionId: string } {
  const result = structuredClone(map);
  const owner = result.tracks.find((track) => track.actions.some((action) => action.id === actionId));
  check(owner, "動作が見つかりません。");
  unlocked(owner);
  const source = owner.actions.find((action) => action.id === actionId)!;
  const copy: Action = structuredClone(source);
  copy.id = makeId();
  copy.position = Math.round((source.position + COPY_OFFSET_S) * 1e6) / 1e6;
  copy.name = `${source.name.slice(0, MAX_NAME - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
  if (copy.type === "show" || copy.type === "event-start") copy.targetId = makeId();
  owner.actions.push(copy);
  checkSequence(owner);
  return { map: finish(result), actionId: copy.id };
}

export function addActionToTrack(
  map: SceneMap, trackId: string, type: ActionType, overrides: Partial<Action> = {}, makeId: IdFactory = defaultId,
): { map: SceneMap; actionId: string } {
  const result = structuredClone(map);
  const owner = result.tracks[trackAt(result, trackId)];
  unlocked(owner);
  check(ALLOWED[owner.kind].includes(type), `${trackKindLabel(owner.kind)}の行には「${actionTypeLabel(type)}」を追加できません。`);
  const created = newAction(result, owner, type, makeId);
  owner.actions.push({ ...created, ...overrides, id: created.id, type });
  checkSequence(owner);
  return { map: finish(result), actionId: created.id };
}

export function replaceAction(map: SceneMap, trackId: string, action: Action): SceneMap {
  const result = structuredClone(map);
  const owner = result.tracks[trackAt(result, trackId)];
  unlocked(owner);
  const index = owner.actions.findIndex((existing) => existing.id === action.id);
  check(index >= 0, "動作が見つかりません。");
  owner.actions[index] = structuredClone(action);
  checkSequence(owner);
  return finish(result);
}

export function replaceTrack(map: SceneMap, track: Track): SceneMap {
  const result = structuredClone(map);
  const index = trackAt(result, track.id);
  unlocked(result.tracks[index]);
  const next = structuredClone(track);
  checkSequence(next);
  result.tracks[index] = next;
  return finish(result);
}
