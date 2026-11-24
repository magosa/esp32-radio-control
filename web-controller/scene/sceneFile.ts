import { defaultId, type IdFactory } from "./ids";
import { MAX_MAPS } from "./mapTabsLogic";
import { validateProject } from "./model";
import { buildNavigation } from "./navigation";
import type { SceneMap, SceneProject } from "./types";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const LEGACY_MESSAGE = "移植元の旧形式です。変換機能(S3)で取り込んでください。";
export const TOO_LARGE_MESSAGE = "ファイルが大きすぎます(上限 10 MiB)。";

const SUFFIX = ".fleet-scene.json";

export function fileNameFor(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 80).trim();
  return `${cleaned || "scene"}${SUFFIX}`;
}

export type ParseResult = { ok: true; project: SceneProject } | { ok: false; error: string };

export function parseSceneFile(text: string): ParseResult {
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) return { ok: false, error: TOO_LARGE_MESSAGE };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "JSON として読み込めません。" };
  }
  const schema = typeof value === "object" && value !== null ? (value as { schema?: unknown }).schema : undefined;
  if (typeof schema === "string" && schema.startsWith("robot-scene/")) return { ok: false, error: LEGACY_MESSAGE };
  try {
    return { ok: true, project: validateProject(value) };
  } catch (error) {
    return { ok: false, error: `読み込めません: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function appendSceneMaps(draft: SceneProject, maps: readonly SceneMap[], makeId: IdFactory = defaultId): void {
  if (maps.length === 0) throw new Error("追加するマップを選択してください。");
  if (draft.maps.length + maps.length > MAX_MAPS) throw new Error(`マップは最大${MAX_MAPS}枚です。`);
  const copies = maps.map((source) => {
    const map = structuredClone(source);
    const ids = new Map<string, string>();
    const remap = (id: string) => {
      if (!ids.has(id)) ids.set(id, makeId());
      return ids.get(id)!;
    };
    const roomRef = (id: string) => id === "" ? "" : remap(id);
    map.id = remap(map.id);
    for (const room of map.rooms) room.id = remap(room.id);
    const plan = map.floorPlan;
    for (const wall of plan?.walls ?? []) {
      wall.id = remap(wall.id);
      wall.roomId = roomRef(wall.roomId);
      if (wall.equipmentId !== undefined) wall.equipmentId = remap(wall.equipmentId);
    }
    for (const item of plan?.furniture ?? []) {
      item.id = remap(item.id);
      item.roomId = roomRef(item.roomId);
    }
    for (const door of plan?.doors ?? []) {
      door.id = remap(door.id);
      door.roomId = roomRef(door.roomId);
      if (door.wallId !== undefined) door.wallId = remap(door.wallId);
      if (door.openingId !== undefined) door.openingId = remap(door.openingId);
      if (door.equipmentId !== undefined) door.equipmentId = remap(door.equipmentId);
    }
    for (const zone of plan?.chargingZones ?? []) zone.id = remap(zone.id);
    for (const track of map.tracks) {
      track.id = remap(track.id);
      if (track.roomId !== undefined) track.roomId = roomRef(track.roomId);
      if (track.doorId !== undefined) track.doorId = remap(track.doorId);
      if (track.initial) track.initial.roomId = roomRef(track.initial.roomId);
      for (const action of track.actions) {
        action.id = remap(action.id);
        action.roomId = roomRef(action.roomId);
        action.targetId = remap(action.targetId);
        if (action.doorId !== undefined) action.doorId = remap(action.doorId);
        if (action.facingFor !== undefined) action.facingFor = remap(action.facingFor);
      }
    }
    if (map.navigation) map.navigation = buildNavigation(map);
    return map;
  });
  validateProject({ ...draft, maps: [...draft.maps, ...copies] });
  draft.maps.push(...copies);
}

export function replaceProject(draft: SceneProject, loaded: SceneProject): void {
  const target = draft as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, structuredClone(loaded));
}
