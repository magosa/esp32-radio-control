import { defaultId, type IdFactory } from "./ids";
import { DISPLAY_TEMPLATES, HATCH_STYLES, KINDS, newAction } from "./model";
import { actionPreview } from "./timedPlan";
import { checkSequence } from "./timelineEdit";
import type { Action, ActionType, DisplayTemplate, HatchStyle, RoomState, SceneMap, Track, TrackKind } from "./types";
import { AREA_HEIGHT_MM, AREA_WIDTH_MM, normalizeYaw, shortestTurn } from "./units";

// Same table as model.ts (not exported there).
const ACTION_TYPES: Record<TrackKind, readonly ActionType[]> = {
  robot: ["move", "show", "hide", "wait"],
  human: ["move", "show", "hide", "wait"],
  room: ["event-start", "event-end", "unlock", "wait"],
  display: ["show", "hide", "wait"],
};
const ACTION_NAMES: Record<ActionType, string> = {
  move: "移動", wait: "待機", show: "表示", hide: "表示を消去",
  "event-start": "イベント発生", "event-end": "イベント終了", unlock: "ドア解錠",
};
const TEMPLATE_LABELS: Record<DisplayTemplate, string> = { label: "テキスト", card: "案内カード", sign: "サイン / ピル" };
const HATCH_LABELS: Record<HatchStyle, string> = { diagonal: "斜線", cross: "クロス", dots: "ドット" };
const STATES: readonly RoomState[] = ["meeting", "outage", "fire"];
const STATE_LABELS: Record<RoomState, string> = { meeting: "会議中", outage: "停電", fire: "火災" };

const MAX_SECONDS = 86400;
const MIN_TIMED_SECONDS = 0.1;
const ROTATION_DEG_PER_SECOND = 90;
const MAX_NAME = 120;
const MAX_TEXT = 500;

const byPosition = (track: Track) => [...track.actions].sort((a, b) => a.position - b.position);
const inRange = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
// Bars that must last (move, wait, unlock) need at least 0.1 s; show/hide/event bars may be instant.
const minSeconds = (type: ActionType) => type === "move" || type === "wait" || type === "unlock" ? MIN_TIMED_SECONDS : 0;

export type FieldKind = "text" | "number" | "select" | "color" | "textarea";

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldSpec {
  // The Action property the input edits; "unlockTarget" is applied through applyUnlockTarget.
  key: string;
  label: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  step?: number | "any";
  maxLength?: number;
  options?: FieldOption[];
  // Selects without fixed options take them from endTargets / unlockTargets.
  optionsFrom?: "endTargets" | "unlockTargets";
}

export interface EndTarget {
  value: string;
  label: string;
  roomId?: string;
}

export function availableTypes(track: Pick<Track, "kind">): ActionType[] {
  return [...ACTION_TYPES[track.kind]];
}

function editableTrack(map: SceneMap, trackId: string): Track {
  const track = map.tracks.find((item) => item.id === trackId);
  if (!track) throw new Error("対象の行が見つかりません。");
  if (track.locked) throw new Error(`${track.name} はロックされています。`);
  return track;
}

export function openActionDraft(
  map: SceneMap,
  trackId: string,
  actionId: string | null,
  type?: ActionType,
  overrides: Partial<Omit<Action, "id" | "type">> = {},
  makeId: IdFactory = defaultId,
): { action: Action; needsInitialPose: boolean } {
  const track = editableTrack(map, trackId);
  let action: Action;
  if (actionId !== null) {
    const found = track.actions.find((item) => item.id === actionId);
    if (!found) throw new Error("編集する動作が見つかりません。");
    action = structuredClone(found);
  } else {
    const chosen = type ?? availableTypes(track)[0];
    if (!availableTypes(track).includes(chosen)) {
      throw new Error(`${KINDS[track.kind]}の行には「${ACTION_NAMES[chosen]}」を配置できません。`);
    }
    action = newAction(map, track, chosen, makeId);
  }
  Object.assign(action, structuredClone(overrides));
  if (action.type === "move" && action.motion === "rotate" && action.rotationSeconds === undefined) {
    const from = actionPreview(map, trackId, action).from;
    const angle = Math.abs(shortestTurn(from?.yaw ?? 0, action.yaw));
    const seconds = overrides.runSeconds ?? Math.max(MIN_TIMED_SECONDS, angle / ROTATION_DEG_PER_SECOND);
    action.rotationSeconds = seconds;
    action.runSeconds = seconds;
  }
  const earliest = track.actions.reduce<Action | undefined>((best, item) => (!best || item.position < best.position ? item : best), undefined);
  const needsInitialPose = actionId === null && track.initial !== undefined && (!earliest || action.position < earliest.position);
  return { action, needsInitialPose };
}

export function setMotion(action: Action, motion: "linear" | "rotate"): Action {
  if (action.type !== "move") throw new Error("回転にできるのは移動の動作だけです。");
  const next = structuredClone(action);
  if (motion === "linear") {
    delete next.motion;
    delete next.rotationSeconds;
    delete next.facingFor;
    return next;
  }
  const seconds = Math.max(MIN_TIMED_SECONDS, next.runSeconds);
  return Object.assign(next, { motion: "rotate" as const, runSeconds: seconds, rotationSeconds: seconds, yaw: normalizeYaw(next.yaw) });
}

const seconds = (label: string, min: number): FieldSpec => ({ key: "runSeconds", label, kind: "number", min, max: MAX_SECONDS, step: "any" });
const targetField: FieldSpec = { key: "targetId", label: "終了する項目", kind: "select", optionsFrom: "endTargets" };
const textField: FieldSpec = { key: "text", label: "表示する言葉", kind: "textarea", maxLength: MAX_TEXT };

export function actionFields(action: Action, trackKind: TrackKind): FieldSpec[] {
  if (!ACTION_TYPES[trackKind].includes(action.type)) {
    throw new Error(`${KINDS[trackKind]}の行には「${ACTION_NAMES[action.type]}」は置けません。`);
  }
  const fields: FieldSpec[] = [{ key: "name", label: "アクション名", kind: "text", maxLength: MAX_NAME }];
  switch (action.type) {
    case "move":
      if (action.motion === "rotate") {
        fields.push(
          { key: "yaw", label: "回転後の角度（°）", kind: "number", min: -180, max: 180, step: "any" },
          seconds("回転にかける秒数", MIN_TIMED_SECONDS),
        );
      } else fields.push(seconds("実行にかける秒数", MIN_TIMED_SECONDS));
      break;
    case "wait":
      fields.push(seconds("待機する秒数", MIN_TIMED_SECONDS));
      break;
    case "show":
      fields.push(seconds("実行にかける秒数", 0), {
        key: "displayTemplate", label: "表示テンプレート", kind: "select",
        options: DISPLAY_TEMPLATES.map((value) => ({ value, label: TEMPLATE_LABELS[value] })),
      }, textField);
      break;
    case "hide":
    case "event-end":
      fields.push(seconds("実行にかける秒数", 0), targetField);
      break;
    case "event-start":
      fields.push(
        seconds("実行にかける秒数", 0),
        { key: "state", label: "イベント", kind: "select", options: STATES.map((value) => ({ value, label: STATE_LABELS[value] })) },
        { key: "hatchColor", label: "色", kind: "color" },
        { key: "hatchStyle", label: "模様", kind: "select", options: HATCH_STYLES.map((value) => ({ value, label: HATCH_LABELS[value] })) },
        textField,
      );
      break;
    case "unlock":
      fields.push(
        seconds("解錠する秒数", MIN_TIMED_SECONDS),
        { key: "unlockTarget", label: "解錠する部屋・設備", kind: "select", optionsFrom: "unlockTargets" },
      );
      break;
  }
  return fields;
}

export function endTargets(map: SceneMap, type: ActionType): EndTarget[] {
  const start = type === "hide" ? "show" : type === "event-end" ? "event-start" : null;
  if (start === null) return [];
  return map.tracks.flatMap((track) => byPosition(track).filter((action) => action.type === start).map((action) => ({
    value: action.targetId,
    label: `${track.name} / ${action.name}`,
    ...(start === "event-start" ? { roomId: action.roomId || track.roomId || "" } : {}),
  })));
}

export function unlockTargets(map: SceneMap): { value: string; label: string }[] {
  // Members of one opening share a name; list the opening once.
  const openings = new Set<string>();
  const doors = (map.floorPlan?.doors ?? []).filter((door) => {
    if (!door.name) return false;
    const key = door.openingId ?? door.id;
    if (openings.has(key)) return false;
    openings.add(key);
    return true;
  });
  return [
    ...map.rooms.map((room) => ({ value: room.id, label: room.name })),
    ...doors.map((door) => ({ value: `door:${door.id}`, label: `設備：${door.name}` })),
  ];
}

export function applyUnlockTarget(action: Action, value: string, map: SceneMap): Action {
  if (action.type !== "unlock") throw new Error("解錠対象を設定できるのは解錠の動作だけです。");
  const next = structuredClone(action);
  if (value.startsWith("door:")) {
    const door = map.floorPlan?.doors.find((item) => item.id === value.slice("door:".length));
    if (!door) throw new Error("指定した設備がありません。");
    Object.assign(next, { doorId: door.id, roomId: door.roomId, name: `${door.name || "設備"}解錠`.slice(0, MAX_NAME) });
    return next;
  }
  const room = map.rooms.find((item) => item.id === value);
  if (!room) throw new Error("指定した部屋がありません。");
  delete next.doorId;
  Object.assign(next, { roomId: room.id, name: `${room.name}解錠`.slice(0, MAX_NAME) });
  return next;
}

function problem(map: SceneMap, trackId: string, action: Action): void {
  const track = editableTrack(map, trackId);
  if (!ACTION_TYPES[track.kind].includes(action.type)) {
    throw new Error(`${KINDS[track.kind]}の行には「${ACTION_NAMES[action.type]}」を配置できません。`);
  }
  const fail = (message: string): never => { throw new Error(`${track.name} / ${action.name}: ${message}`); };
  if (typeof action.name !== "string" || action.name.length > MAX_NAME) fail(`名前は${MAX_NAME}文字以内にしてください。`);
  if (!inRange(action.position, 0, MAX_SECONDS)) fail(`開始時刻は0〜${MAX_SECONDS}秒にしてください。`);
  const min = minSeconds(action.type);
  if (!inRange(action.runSeconds, min, MAX_SECONDS)) fail(`秒数は${min}〜${MAX_SECONDS}秒にしてください。`);
  if (!inRange(action.x, 0, AREA_WIDTH_MM)) fail(`X座標は0〜${AREA_WIDTH_MM}mmにしてください。`);
  if (!inRange(action.y, 0, AREA_HEIGHT_MM)) fail(`Y座標は0〜${AREA_HEIGHT_MM}mmにしてください。`);
  if (!inRange(action.yaw, -180, 180) || action.yaw === -180) fail("角度は-180°より大きく180°以下にしてください。");
  if (action.roomId !== "" && !map.rooms.some((room) => room.id === action.roomId)) fail("指定した部屋がありません。");
  if (typeof action.text !== "string" || action.text.length > (action.type === "show" || action.type === "event-start" ? MAX_TEXT : 4000)) {
    fail(`表示する言葉は${MAX_TEXT}文字以内にしてください。`);
  }
  if (action.displayTemplate !== undefined && !DISPLAY_TEMPLATES.includes(action.displayTemplate)) fail("表示テンプレートが不正です。");
  if (action.type === "event-start" && !STATES.includes(action.state)) fail("イベントの種類が不正です。");
  if (action.hatchStyle !== undefined && !HATCH_STYLES.includes(action.hatchStyle)) fail("模様の種類が不正です。");
  if (action.hatchColor !== undefined && !/^#[0-9a-f]{6}$/i.test(action.hatchColor)) fail("色は#RRGGBBの形式にしてください。");
  if (action.motion !== undefined && (action.type !== "move" || action.motion !== "rotate")) fail("回転の指定が不正です。");
  if (action.rotationSeconds !== undefined) {
    if (action.motion !== "rotate") fail("回転秒数は回転の動作でだけ指定できます。");
    if (!inRange(action.rotationSeconds, MIN_TIMED_SECONDS, MAX_SECONDS)) fail(`回転秒数は${MIN_TIMED_SECONDS}〜${MAX_SECONDS}秒にしてください。`);
  }
  if (action.type === "hide" || action.type === "event-end") {
    if (!endTargets(map, action.type).some((target) => target.value === action.targetId)) fail("終了する項目を選択してください。");
  } else if (typeof action.targetId !== "string" || action.targetId === "") fail("動作の識別子がありません。");
  if (action.type === "unlock" && action.roomId === "") fail("解錠する部屋・設備を選択してください。");
  if (action.doorId !== undefined) {
    if (action.type !== "unlock") fail("設備の指定は解錠の動作だけです。");
    if (!map.floorPlan?.doors.some((door) => door.id === action.doorId && door.roomId === action.roomId)) {
      fail("指定した設備がこの部屋にありません。");
    }
  }
  const actions = track.actions.some((item) => item.id === action.id)
    ? track.actions.map((item) => item.id === action.id ? action : item)
    : [...track.actions, action];
  checkSequence({ name: track.name, actions });
  if (action.type === "move") {
    const geometry = actionPreview(map, trackId, action).geometryProblem;
    if (geometry) fail(geometry);
  }
}

export function validateAction(map: SceneMap, trackId: string, action: Action): { ok: true } | { ok: false; error: string } {
  try {
    problem(map, trackId, action);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "動作を確認できませんでした。" };
  }
}
