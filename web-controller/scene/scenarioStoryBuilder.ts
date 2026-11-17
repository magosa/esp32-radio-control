import { roomContainsPoint } from "./floorPlan";
import { cellIndex } from "./grid";
import type { IdFactory } from "./ids";
import { newAction, newTrack } from "./model";
import type { Action, ActionType, CueKind, FloorPlan, PresentationCue, RobotRole, Room, SceneMap, Track } from "./types";
import { normalizeYaw, shortestTurn } from "./units";

export const PALETTE = { security: "#8daeff", cleaning: "#64dcb2", delivery: "#ffcb81" };
const ROLE_NAMES = { security: "警備ロボット", cleaning: "清掃ロボット", delivery: "配送ロボット" };
export type Point = [number, number];

export function cells(x1: number, y1: number, x2: number, y2: number): number[] {
  const result: number[] = [];
  for (let y = y1; y < y2; y += 20) {
    for (let x = x1; x < x2; x += 20) result.push(cellIndex(x / 20, y / 20));
  }
  return result;
}

export function createScenarioStoryBuilder(map: SceneMap, id: string, makeId: IdFactory) {
  const plan: FloorPlan = { doors: [], furniture: [], walls: [], chargingZones: [], showRoomLabels: true };
  map.floorPlan = plan;
  map.doorMode = "strict";
  map.rooms = [];
  map.tracks = [];
  const cues: PresentationCue[] = [];
  map.presentation = { version: 1, scenarioId: id, cues };
  const presentation = map.presentation;
  const location = (x: number, y: number) => {
    const room = map.rooms.find((item) => roomContainsPoint(item, x, y));
    if (!room) throw new Error(`${id}: マップ外の座標です (${x}, ${y})`);
    return room.id;
  };
  const region = (name: string, kind: Room["kind"], area: number[], color: string): Room => {
    const room: Room = { id: makeId(), name, kind, material: "tile", color, cells: area };
    map.rooms.push(room);
    return room;
  };
  const note = (start: number, end: number, label: string, color = "#ffffff") =>
    cues.push({ kind: "notice", start, end, label, color });
  const zone = (kind: Exclude<CueKind, "notice" | "route">, start: number, end: number, label: string, color: string,
    x: number, y: number, width: number, height: number) =>
    cues.push({ kind, start, end, label, color, x, y, width, height });
  const route = (start: number, end: number, label: string, color: string, points: Point[]) =>
    cues.push({ kind: "route", start, end, label, color, points });
  const action = (track: Track, type: ActionType, start: number, seconds: number, name: string, extra: Partial<Action> = {}) => {
    const item = { ...newAction(map, track, type, makeId), position: start, runSeconds: seconds, name, ...extra };
    track.actions.push(item);
    return item;
  };
  const robot = (role: RobotRole, x: number, y: number, name = ROLE_NAMES[role]) => {
    const track = newTrack(map, "robot", makeId);
    Object.assign(track, { name, robotRole: role, color: PALETTE[role],
      initial: { x, y, yaw: 0, roomId: location(x, y), coordinateMode: "free" } });
    map.tracks.push(track);
    return track;
  };
  const human = (x: number, y: number, name = "会議参加者", count = 4) => {
    const track = newTrack(map, "human", makeId);
    Object.assign(track, { name, count, initial: { x, y, yaw: 0, roomId: location(x, y), coordinateMode: "free" } });
    map.tracks.push(track);
    return track;
  };
  const travel = (track: Track, start: number, points: Point[], name: string, speed = 96) => {
    let time = Math.max(start, ...track.actions.map((item) => item.position + item.runSeconds));
    let from = track.actions.findLast((item) => item.type === "move") ?? track.initial;
    if (!from) throw new Error(`${id}: ${track.name} の初期位置がありません`);
    for (const [x, y] of points) {
      const distance = Math.hypot(x - from.x, y - from.y);
      if (distance < .01) continue;
      const yaw = track.kind === "human" ? 0 : normalizeYaw(Math.atan2(y - from.y, x - from.x) * 180 / Math.PI);
      const delta = Math.abs(shortestTurn(from.yaw, yaw));
      if (track.kind === "robot" && delta > .01) {
        const seconds = Math.max(.5, delta / 180);
        action(track, "move", time, seconds, `進行方向へ旋回 · ${name}`,
          { x: from.x, y: from.y, yaw, motion: "rotate", rotationSeconds: seconds, roomId: location(from.x, from.y), coordinateMode: "free" });
        time += seconds;
      }
      const seconds = Math.max(1, distance / speed);
      from = action(track, "move", time, seconds, name, { x, y, yaw, roomId: location(x, y), coordinateMode: "free" });
      time += seconds;
    }
    return time;
  };
  const wait = (track: Track, start: number, seconds: number, name: string) => action(track, "wait", start, seconds, name);
  const doorTrack = (room: Room, windows: Point[], doorId?: string) => {
    const track = newTrack(map, "room", makeId);
    track.name = `建物連携 · ${room.name}の解錠`;
    track.roomId = room.id;
    map.tracks.push(track);
    for (const [start, end] of windows) {
      action(track, "unlock", start, end - start, "通行許可", { roomId: room.id, ...(doorId ? { doorId } : {}) });
    }
  };
  const boundaryDoor = (room: Room, x: number, y: number, edge: "left" | "right" | "bottom", count: number) => {
    const openingId = makeId();
    for (let i = 0; i < count; i++) {
      plan.doors.push({
        id: makeId(), openingId, roomId: room.id, kind: "automatic",
        cell: cellIndex(x / 20 + (edge === "bottom" ? i : 0), y / 20 + (edge === "bottom" ? 0 : i)), edge,
      });
    }
  };
  const building = () => {
    const entrance = region("エントランス", "corridor", cells(0, 0, 280, 620), "#d8d1bd");
    const meeting = region("会議室", "room", cells(440, 200, 660, 420), "#c9b8a5");
    const elevator = region("EV", "room", cells(660, 200, 860, 420), "#c3cdd0");
    elevator.appearance = "elevator";
    elevator.entranceEdge = "bottom";
    const occupied = new Set(map.rooms.flatMap((room) => room.cells));
    region("口の字廊下", "corridor", cells(0, 0, 1100, 620).filter((cell) => !occupied.has(cell)), "#bac5c1");
    boundaryDoor(entrance, 260, 200, "right", 11);
    boundaryDoor(meeting, 440, 200, "left", 11);
    boundaryDoor(elevator, 660, 200, "bottom", 10);
    plan.chargingZones = [
      { id: makeId(), name: "警備充電", x: 70, y: 20, width: 180, height: 170 },
      { id: makeId(), name: "清掃充電", x: 70, y: 430, width: 180, height: 180 },
      { id: makeId(), name: "室内配送充電", x: 900, y: 220, width: 160, height: 180 },
    ];
    for (const room of [entrance, meeting, elevator]) doorTrack(room, [[0, 240]]);
  };
  const finish = (end: number) => {
    for (const track of map.tracks) {
      for (const item of track.actions) {
        if (item.type === "unlock") item.runSeconds = Math.min(item.runSeconds, end - item.position);
      }
    }
    presentation.cues = cues.filter((item) => item.start < end).map((item) => ({ ...item, end: Math.min(item.end, end) }));
    presentation.cues.push({ kind: "notice", start: 0, end,
      label: "SIMULATION ONLY · 検知・判断・建物連携・遠隔操作は説明用の自動再生", color: "#b6c1cc" });
    const clock = newTrack(map, "display", makeId);
    clock.name = "デモ終端・説明保持";
    map.tracks.push(clock);
    wait(clock, 0, end, "シナリオ再生時間");
  };
  return { plan, region, note, zone, route, robot, human, travel, wait, doorTrack, building, finish };
}
