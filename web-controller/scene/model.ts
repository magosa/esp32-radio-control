import { CELL_COUNT, AREA_HEIGHT_MM, AREA_WIDTH_MM, EDIT_GRID_OPTIONS } from "./units";
import { snapToEditGrid } from "./grid";
import { validateFloorPlan } from "./floorPlan";
import { defaultId, type IdFactory } from "./ids";
import { buildNavigation } from "./navigation";
import { validatePresentation } from "./presentation";
import {
  SCENE_SCHEMA,
  type Action,
  type ActionType,
  type DisplayTemplate,
  type HatchStyle,
  type SceneMap,
  type SceneProject,
  type Track,
  type TrackKind,
} from "./types";

export { defaultId, type IdFactory };

export const COLORS = ["#8d9bff", "#58d8ca", "#ffbd70", "#ec87c7", "#73bafa", "#bd9afa"];
export const KINDS: Record<TrackKind, string> = { robot: "ロボット", human: "人", room: "部屋", display: "画面表示" };
export const DISPLAY_TEMPLATES: readonly DisplayTemplate[] = ["label", "card", "sign"];
export const HATCH_STYLES: readonly HatchStyle[] = ["diagonal", "cross", "dots"];

const ACTION_TYPES: Record<TrackKind, readonly ActionType[]> = {
  robot: ["move", "show", "hide", "wait"],
  human: ["move", "show", "hide", "wait"],
  room: ["event-start", "event-end", "unlock", "wait"],
  display: ["show", "hide", "wait"],
};
const ACTION_NAMES: Record<ActionType, string> = {
  move: "移動", wait: "待機", show: "表示", hide: "非表示",
  "event-start": "イベント開始", "event-end": "イベント終了", unlock: "解錠",
};
const MAX_SECONDS = 86400;
const isActor = (kind: TrackKind) => kind === "robot" || kind === "human";
const byPosition = (track: Track) => [...track.actions].sort((a, b) => a.position - b.position);

function defaultRunSeconds(type: ActionType): number {
  if (type === "move") return 6;
  if (type === "wait" || type === "show" || type === "event-start" || type === "unlock") return 3;
  return 0.5;
}

export function createProject(name: string, makeId: IdFactory = defaultId): SceneProject {
  const map: SceneMap = { id: makeId(), name: "マップ 1", editGridMm: 20, doorMode: "story", rooms: [], tracks: [] };
  return { schema: SCENE_SCHEMA, name, maps: [map] };
}

export function newTrack(map: SceneMap, kind: TrackKind, makeId: IdFactory = defaultId): Track {
  if (!Object.hasOwn(KINDS, kind)) throw new Error("unsupported track kind");
  const peers = map.tracks.filter((track) => track.kind === kind);
  const names = new Set(peers.map((track) => track.name));
  let ordinal = 1;
  while (names.has(`${KINDS[kind]} ${ordinal}`)) ordinal++;
  const track: Track = {
    id: makeId(), kind, name: `${KINDS[kind]} ${ordinal}`,
    color: COLORS[map.tracks.length % COLORS.length], muted: false, locked: false, actions: [],
  };
  // Upstream ratio start: x = 160 + n*100 (mod 1400), y = 160.
  if (isActor(kind)) track.initial = { ...snapToEditGrid(111 + ((peers.length * 69) % 969), 111, map.editGridMm), yaw: 0, roomId: "" };
  if (kind === "human") track.count = 1;
  if (kind === "room") track.roomId = map.rooms[0]?.id ?? "";
  return track;
}

export function newAction(map: SceneMap, track: Track, type: ActionType = ACTION_TYPES[track.kind][0], makeId: IdFactory = defaultId): Action {
  if (!ACTION_TYPES[track.kind].includes(type)) throw new Error(`action type ${type} is not allowed on ${track.kind} tracks`);
  const sequence = byPosition(track);
  const previous = sequence.at(-1);
  const matching = type === "hide" ? "show" : "event-start";
  const target = [...sequence].reverse().find((action) => action.type === matching) ??
    (type === "event-end"
      ? map.tracks.filter((owner) => owner.kind === "room" && owner.roomId === track.roomId)
        .flatMap((owner) => owner.actions).findLast((action) => action.type === matching)
      : undefined);
  const from = [...sequence].reverse().find((action) => action.type === "move" && action.motion !== "rotate") ?? track.initial;
  const coordinateMode = from?.coordinateMode ?? "grid";
  const x = from?.x ?? AREA_WIDTH_MM / 2;
  const y = from?.y ?? AREA_HEIGHT_MM / 2;
  const point = coordinateMode === "grid" ? snapToEditGrid(x, y, map.editGridMm) : { x, y };
  const roomName = map.rooms.find((room) => room.id === track.roomId)?.name ?? "部屋";
  return {
    id: makeId(),
    name: type === "unlock" ? `${roomName}解錠` : ACTION_NAMES[type],
    type,
    position: previous ? previous.position + previous.runSeconds : 0,
    runSeconds: defaultRunSeconds(type),
    ...point,
    yaw: from?.yaw ?? 0,
    ...(coordinateMode === "free" ? { coordinateMode } : {}),
    roomId: track.roomId ?? from?.roomId ?? "",
    targetId: (type === "hide" || type === "event-end") && target ? target.targetId : makeId(),
    text: "",
    state: "meeting",
  };
}

export function projectForSave(project: SceneProject): SceneProject {
  validateProject(project);
  const saved = structuredClone(project);
  for (const map of saved.maps) map.navigation = buildNavigation(map);
  return saved;
}

type Obj = Record<string, unknown>;

export function copyMapLayout(source: SceneMap, name: string, makeId: IdFactory = defaultId): SceneMap {
  const copy = structuredClone(source);
  copy.id = makeId();
  copy.name = name;
  copy.tracks = [];
  delete copy.presentation;
  delete copy.navigation;
  const resolve = (ids: Map<string, string>, old: string, what: string) => {
    const next = ids.get(old);
    if (next === undefined) throw new Error(`${what} ${old} does not resolve`);
    return next;
  };
  const rooms = new Map(copy.rooms.map((room) => [room.id, makeId()]));
  for (const room of copy.rooms) room.id = resolve(rooms, room.id, "room");
  const plan = copy.floorPlan;
  if (!plan) return copy;
  const walls = new Map((plan.walls ?? []).map((wall) => [wall.id, makeId()]));
  const shared = new Map<string, string>();
  const share = (old: string) => {
    if (!shared.has(old)) shared.set(old, makeId());
    return shared.get(old)!;
  };
  for (const wall of plan.walls ?? []) {
    wall.id = resolve(walls, wall.id, "wall");
    wall.roomId = resolve(rooms, wall.roomId, "room");
    if (wall.equipmentId !== undefined) wall.equipmentId = share(wall.equipmentId);
  }
  for (const item of plan.furniture) {
    item.id = makeId();
    item.roomId = resolve(rooms, item.roomId, "room");
  }
  for (const door of plan.doors) {
    door.id = makeId();
    door.roomId = resolve(rooms, door.roomId, "room");
    if (door.wallId !== undefined) door.wallId = resolve(walls, door.wallId, "wall");
    if (door.openingId !== undefined) door.openingId = share(door.openingId);
    if (door.equipmentId !== undefined) door.equipmentId = share(door.equipmentId);
  }
  for (const zone of plan.chargingZones ?? []) zone.id = makeId();
  return copy;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const has = (value: Obj, key: string) => Object.hasOwn(value, key);
const finite = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const safeId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 100 &&
  !["$start", "__proto__", "constructor", "prototype"].includes(value);
const isCell = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) < CELL_COUNT;
const EDGES = ["top", "bottom", "left", "right"];

function num(value: unknown, min: number, max: number, label: string) {
  check(finite(value, min, max), `${label} must be a finite number in ${min}..${max}`);
}
function text(value: unknown, label: string, max = 120) {
  check(typeof value === "string" && value.length <= max, `${label} must be a string of at most ${max} chars`);
}
function color(value: unknown, label: string) {
  check(typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value), `${label} must be #RRGGBB`);
}
function oneOf(value: unknown, options: readonly unknown[], label: string) {
  check(options.includes(value), `${label} is invalid`);
}
function time(value: unknown, label: string) {
  num(value, 0, MAX_SECONDS, label);
}
function point(value: Obj, label: string) {
  num(value.x, 0, AREA_WIDTH_MM, `${label}.x`);
  num(value.y, 0, AREA_HEIGHT_MM, `${label}.y`);
}
function yaw(value: unknown, label: string) {
  check(finite(value, -180, 180) && value !== -180, `${label}.yaw must be in (-180, 180]`);
}
function cell(value: unknown, label: string) {
  check(isCell(value), `${label} cell must be an integer in 0..${CELL_COUNT - 1}`);
}
function roomRef(value: unknown, rooms: Set<string>, label: string) {
  check(value === "" || (typeof value === "string" && rooms.has(value)), `${label}.roomId does not resolve`);
}
function segment(value: Obj, label: string) {
  num(value.x1, 0, AREA_WIDTH_MM, `${label}.x1`);
  num(value.y1, 0, AREA_HEIGHT_MM, `${label}.y1`);
  num(value.x2, 0, AREA_WIDTH_MM, `${label}.x2`);
  num(value.y2, 0, AREA_HEIGHT_MM, `${label}.y2`);
}

export function validateProject(value: unknown): SceneProject {
  check(isObj(value), "project must be an object");
  check(value.schema === SCENE_SCHEMA, `schema must be ${SCENE_SCHEMA}`);
  text(value.name, "project.name");
  if (has(value, "facingTurns")) check(typeof value.facingTurns === "boolean", "project.facingTurns must be boolean");
  check(Array.isArray(value.maps) && value.maps.length >= 1 && value.maps.length <= 8, "maps must contain 1..8 maps");
  const ids = new Set<string>();
  const identifier = (id: unknown, label: string) => {
    check(safeId(id) && !ids.has(id), `${label}.id is invalid or duplicated`);
    ids.add(id);
  };
  let total = 0;
  for (const map of value.maps as unknown[]) total = validateMap(map, identifier, total);
  return value as unknown as SceneProject;
}

function validateMap(map: unknown, identifier: (id: unknown, label: string) => void, total: number): number {
  check(isObj(map), "map must be an object");
  identifier(map.id, "map");
  text(map.name, "map.name");
  oneOf(map.editGridMm, EDIT_GRID_OPTIONS, "map.editGridMm");
  oneOf(map.doorMode, ["story", "strict"], "map.doorMode");
  if (has(map, "facingTurns")) check(typeof map.facingTurns === "boolean", "map.facingTurns must be boolean");
  check(Array.isArray(map.rooms) && map.rooms.length <= 100, "map.rooms must be an array of at most 100");
  check(Array.isArray(map.tracks) && map.tracks.length <= 128, "map.tracks must be an array of at most 128");

  const rooms = new Set<string>();
  for (const room of map.rooms as unknown[]) {
    check(isObj(room), "room must be an object");
    identifier(room.id, "room");
    rooms.add(room.id as string);
    text(room.name, "room.name");
    color(room.color, "room.color");
    oneOf(room.kind, ["room", "corridor"], "room.kind");
    oneOf(room.material, ["wood", "tile", "carpet", "concrete"], "room.material");
    if (has(room, "appearance")) oneOf(room.appearance, ["standard", "elevator", "continuing-hall"], "room.appearance");
    if (has(room, "entranceEdge")) oneOf(room.entranceEdge, EDGES, "room.entranceEdge");
    check(Array.isArray(room.cells) && room.cells.length > 0, "room.cells must be a non-empty array");
    for (const item of room.cells) cell(item, "room");
    check(new Set(room.cells).size === room.cells.length, "room cell is duplicated");
  }
  const doors = has(map, "floorPlan") ? validateFloorPlanShape(map.floorPlan, rooms, identifier) : new Map<string, string>();
  if (has(map, "presentation")) validatePresentation(map.presentation);
  validateFloorPlan(map as unknown as SceneMap);

  const robotIds = new Set<string>();
  for (const track of map.tracks as unknown[]) {
    check(isObj(track), "track must be an object");
    identifier(track.id, "track");
    text(track.name, "track.name");
    color(track.color, "track.color");
    check(typeof track.kind === "string" && Object.hasOwn(KINDS, track.kind), "track.kind is invalid");
    const kind = track.kind as TrackKind;
    check(typeof track.muted === "boolean" && typeof track.locked === "boolean", "track.muted/locked must be boolean");
    if (isActor(kind)) {
      check(isObj(track.initial), "track.initial is required");
      point(track.initial, "track.initial");
      yaw(track.initial.yaw, "track.initial");
      roomRef(track.initial.roomId, rooms, "track.initial");
      if (has(track.initial, "coordinateMode")) oneOf(track.initial.coordinateMode, ["grid", "free"], "track.initial.coordinateMode");
    }
    if (kind === "robot") {
      if (has(track, "robotId")) {
        check(safeId(track.robotId) && !robotIds.has(track.robotId), "track.robotId is invalid or duplicated");
        robotIds.add(track.robotId);
      }
      if (has(track, "robotRole")) oneOf(track.robotRole, ["cleaning", "security", "delivery"], "track.robotRole");
    }
    if (kind === "human") check(Number.isInteger(track.count) && finite(track.count, 1, 10000), "track.count must be an integer in 1..10000");
    if (kind === "room") roomRef(track.roomId, rooms, "track");
    check(Array.isArray(track.actions), "track.actions must be an array");
    total += track.actions.length;
    check(total <= 2000, "actions must total at most 2000");
    // hide/event-end close by targetId map-wide at runtime; an unresolved target is a no-op (upstream parity).
    for (const action of track.actions as unknown[]) validateAction(action, kind, rooms, doors, identifier);
  }
  return total;
}

function validateAction(
  action: unknown,
  kind: TrackKind,
  rooms: Set<string>,
  doors: Map<string, string>,
  identifier: (id: unknown, label: string) => void,
) {
  check(isObj(action), "action must be an object");
  check(!has(action, "trigger"), "action.trigger is not supported");
  identifier(action.id, "action");
  text(action.name, "action.name");
  oneOf(action.type, ACTION_TYPES[kind], "action.type");
  time(action.position, "action.position");
  time(action.runSeconds, "action.runSeconds");
  point(action, "action");
  yaw(action.yaw, "action");
  if (has(action, "coordinateMode")) oneOf(action.coordinateMode, ["grid", "free"], "action.coordinateMode");
  roomRef(action.roomId, rooms, "action");
  check(safeId(action.targetId), "action.targetId is invalid");
  text(action.text, "action.text", 4000);
  oneOf(action.state, ["meeting", "fire", "outage"], "action.state");
  if (has(action, "motion")) check(action.type === "move" && action.motion === "rotate", "action.motion is invalid");
  if (has(action, "rotationSeconds")) {
    check(action.motion === "rotate", "action.rotationSeconds requires motion rotate");
    time(action.rotationSeconds, "action.rotationSeconds");
  }
  if (has(action, "facingFor")) check(action.motion === "rotate" && safeId(action.facingFor), "action.facingFor is invalid");
  if (has(action, "displayTemplate")) oneOf(action.displayTemplate, DISPLAY_TEMPLATES, "action.displayTemplate");
  if (has(action, "hatchStyle")) oneOf(action.hatchStyle, HATCH_STYLES, "action.hatchStyle");
  if (has(action, "hatchColor")) color(action.hatchColor, "action.hatchColor");
  if (action.type === "unlock") check(typeof action.roomId === "string" && rooms.has(action.roomId), "unlock action.roomId does not resolve");
  if (has(action, "doorId")) {
    check(action.type === "unlock", "action.doorId is only allowed on unlock");
    check(doors.get(action.doorId as string) === action.roomId, "unlock action.doorId does not resolve to a door of its room");
  }
}

function validateFloorPlanShape(plan: unknown, rooms: Set<string>, identifier: (id: unknown, label: string) => void): Map<string, string> {
  check(isObj(plan), "floorPlan must be an object");
  check(Array.isArray(plan.doors) && Array.isArray(plan.furniture), "floorPlan.doors/furniture must be arrays");
  if (has(plan, "showRoomLabels")) check(typeof plan.showRoomLabels === "boolean", "floorPlan.showRoomLabels must be boolean");
  const walls = new Map<string, string>();
  if (has(plan, "walls")) {
    check(Array.isArray(plan.walls), "floorPlan.walls must be an array");
    for (const wall of plan.walls as unknown[]) {
      check(isObj(wall), "wall must be an object");
      identifier(wall.id, "wall");
      check(rooms.has(wall.roomId as string), "wall.roomId does not resolve");
      segment(wall, "wall");
      walls.set(wall.id as string, wall.roomId as string);
    }
  }
  if (has(plan, "chargingZones")) {
    check(Array.isArray(plan.chargingZones) && plan.chargingZones.length <= 64, "floorPlan.chargingZones must be an array of at most 64");
    for (const zone of plan.chargingZones as unknown[]) {
      check(isObj(zone), "chargingZone must be an object");
      identifier(zone.id, "chargingZone");
      text(zone.name, "chargingZone.name");
      point(zone, "chargingZone");
      num(zone.width, 1, AREA_WIDTH_MM - (zone.x as number), "chargingZone.width");
      num(zone.height, 1, AREA_HEIGHT_MM - (zone.y as number), "chargingZone.height");
    }
  }
  for (const item of plan.furniture as unknown[]) {
    check(isObj(item), "furniture must be an object");
    identifier(item.id, "furniture");
    check(rooms.has(item.roomId as string), "furniture.roomId does not resolve");
    cell(item.cell, "furniture");
    if (has(item, "cells")) {
      check(Array.isArray(item.cells), "furniture.cells must be an array");
      for (const value of item.cells) cell(value, "furniture");
    }
    oneOf(item.type, ["desk", "chair", "plant", "reception-monitor"], "furniture.type");
    oneOf(item.rotation, [0, 90, 180, 270], "furniture.rotation");
  }
  const doors = new Map<string, string>();
  for (const door of plan.doors as unknown[]) {
    check(isObj(door), "door must be an object");
    identifier(door.id, "door");
    check(rooms.has(door.roomId as string), "door.roomId does not resolve");
    if (has(door, "name")) text(door.name, "door.name");
    if (has(door, "kind")) oneOf(door.kind, ["automatic", "flapper"], "door.kind");
    for (const key of ["openingId", "equipmentId"]) if (has(door, key)) check(safeId(door[key]), `door.${key} is invalid`);
    if (has(door, "wallId")) {
      check(walls.get(door.wallId as string) === door.roomId, "door.wallId does not resolve to a wall of its room");
      segment(door, "door");
    } else {
      cell(door.cell, "door");
      oneOf(door.edge, EDGES, "door.edge");
    }
    doors.set(door.id as string, door.roomId as string);
  }
  return doors;
}
