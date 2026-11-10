import {
  prepareDoorPlan, sampleDoorPlan, type DoorPlanEntry, type DoorPlanInput, type DoorSample, type PlanWarning,
} from "./doors";
import { roomContainsPoint } from "./floorPlan";
import { defaultId, type IdFactory } from "./ids";
import { newAction } from "./model";
import {
  collisionWarnings, createSafety, pathProblem, pathSections, positionAt,
  type ActorKind, type Point, type Safety, type Trajectory, type TrajectorySegment,
} from "./safety";
import { cellAt } from "./grid";
import type {
  Action, ActionType, CoordinateMode, DisplayTemplate, HatchStyle, Pose, RobotRole, RoomState, SceneMap, Track, TrackKind,
} from "./types";
import { normalizeYaw, shortestTurn } from "./units";

export interface PlanPose extends Point {
  yaw: number;
  roomId?: string;
  coordinateMode?: CoordinateMode;
}

export interface PlanEntry extends DoorPlanEntry {
  track: Track;
  action: Action;
  from?: PlanPose;
  to?: PlanPose;
  travel?: number;
  roomId?: string;
  geometryFailure?: boolean;
  trafficFailure?: boolean;
}

export interface PlanLogEvent {
  at: number;
  kind: "start" | "arrival" | "complete";
  entry: PlanEntry;
}

export interface ScenePlan extends DoorPlanInput {
  entries: PlanEntry[];
  log: PlanLogEvent[];
  duration: number;
}

export interface SceneActor extends PlanPose {
  id: string;
  kind: ActorKind;
  name: string;
  color: string;
  count: number;
  robotRole?: RobotRole;
  robotId: string | null;
  roomId: string;
  aggregated: boolean;
  moving: boolean;
}

export interface SceneDisplay {
  actionId: string;
  targetId: string;
  text: string;
  x: number;
  y: number;
  color: string;
  displayTemplate?: DisplayTemplate;
  actorId?: string;
}

export interface SceneEvent {
  actionId: string;
  targetId: string;
  roomId: string;
  state: RoomState;
  text: string;
  color: string;
  hatchColor?: string;
  hatchStyle?: HatchStyle;
}

export interface ActionResult {
  schema: "scene-action-result/v1";
  actionId: string;
  trackId: string;
  robotId: string | null;
  source: "simulation";
  status: "blocked" | "pending" | "running" | "success" | "failed";
  elapsedSeconds: number;
  startedAtSeconds: number | null;
  endedAtSeconds: number | null;
  simulatedPosition: PlanPose | null;
  measuredPosition: null;
  reason: string;
}

export interface ActionState {
  status: "blocked" | "waiting" | "running" | "complete" | "failed";
  start: number | null;
  end: number | null;
  reason: string;
  result: ActionResult;
}

export interface RoomActivity {
  roomId: string;
  text: string;
  actorIds: string[];
}

export interface SceneState {
  actors: SceneActor[];
  displays: SceneDisplay[];
  events: SceneEvent[];
  actionStates: Record<string, ActionState>;
  roomActivities: RoomActivity[];
  doors: DoorSample[];
  duration: number;
  errors: string[];
  warnings: PlanWarning[];
}

export interface ActionPreview {
  from: PlanPose | null;
  geometryProblem: string;
  start: number | null;
  end: number | null;
  warning: string;
}

interface Reservation {
  trackId: string;
  name: string;
  start: number;
  end: number;
}

interface Parked extends Reservation {
  zone: string;
}

interface Schedule {
  entries: PlanEntry[];
  log: PlanLogEvent[];
  errors: string[];
  warnings: PlanWarning[];
  duration: number;
  trajectories: Trajectory[];
}

const EPS = 1e-7;
const FACING_DEG_PER_SECOND = 90;
const ZERO_LENGTH_ALLOWED: ReadonlySet<ActionType> = new Set<ActionType>(["hide", "event-end"]);
const ROLE_LABELS: Record<RobotRole, string> = { cleaning: "掃除中", security: "監視中", delivery: "配送中" };
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const isActor = (kind: TrackKind): kind is ActorKind => kind === "robot" || kind === "human";
const byPosition = (track: Track) => [...track.actions].sort((a, b) => a.position - b.position);
const heading = (dx: number, dy: number) => normalizeYaw(Math.atan2(dy, dx) * 180 / Math.PI);
const moved = (a: Point, b: Point) => a.x !== b.x || a.y !== b.y;

export function compilePlan(map: SceneMap): ScenePlan {
  const safety = createSafety(map);
  const limit = Math.min(32, map.tracks.reduce((n, t) => n + t.actions.length, 0) + 2);
  let parked: Parked[] = [];
  for (let iteration = 0; ; iteration++) {
    const { trajectories, ...result } = schedule(map, safety, parked);
    const next = parkedInZones(safety, trajectories, result.duration);
    if (signature(next) === signature(parked)) {
      result.warnings.push(...collisionWarnings(trajectories));
      const plan: ScenePlan = { map, ...result };
      prepareDoorPlan(plan);
      return plan;
    }
    if (iteration >= limit) {
      const reason = "狭い廊下の停車計画が収束しません。開始時刻・退出先を調整してください。";
      for (const e of result.entries) Object.assign(e, { blocked: true, reason, start: null, end: null, outcome: null, segments: [] });
      const plan: ScenePlan = { map, entries: result.entries, log: [], errors: [...result.errors, reason], warnings: [], duration: 0 };
      prepareDoorPlan(plan);
      return plan;
    }
    parked = next;
  }
}

// A robot standing still in a one-at-a-time section holds it; end Infinity means it never leaves.
function parkedInZones(safety: Safety, trajectories: Trajectory[], duration: number): Parked[] {
  const parked: Parked[] = [];
  for (const t of trajectories) if (t.kind === "robot") for (const s of t.segments) {
    if (moved(s.from, s.to)) continue;
    const zone = safety.cellZones.get(cellAt(s.from.x, s.from.y));
    if (zone) parked.push({ zone, trackId: t.id, name: t.name, start: s.start, end: s.end >= duration ? Infinity : s.end });
  }
  return parked;
}

const signature = (list: Parked[]) => JSON.stringify(list.map((r) =>
  [r.zone, r.trackId, Math.round(r.start * 1e6), Number.isFinite(r.end) ? Math.round(r.end * 1e6) : "forever"]));

function schedule(map: SceneMap, safety: Safety, parked: Parked[]): Schedule {
  const entries: PlanEntry[] = map.tracks.flatMap((track) => track.actions.map((action) => ({
    track, action, start: null, end: null, blocked: track.muted, outcome: null, segments: [],
    reason: track.muted ? `${track.name} はプレビュー対象外です。` : "",
  })));
  const byId = new Map(entries.map((e) => [e.action.id, e]));
  const previous = new Map<string, PlanEntry>();
  for (const track of map.tracks) {
    byPosition(track).forEach((action, i, sorted) => { if (i) previous.set(action.id, byId.get(sorted[i - 1].id)!); });
  }
  const errors: string[] = [], warnings: PlanWarning[] = [], log: PlanLogEvent[] = [];
  const reservations = new Map<string, Reservation[]>(), latest = new Map<string, PlanEntry>();
  for (const { zone, ...r } of parked) reservations.set(zone, [...(reservations.get(zone) ?? []), r]);
  const block = (e: PlanEntry, reason: string, report = false) => {
    e.blocked = true;
    e.reason = reason;
    if (report) errors.push(`${e.track.name} / ${e.action.name}: ${reason}`);
  };
  for (const track of map.tracks) {
    if (!track.initial || track.muted || !isActor(track.kind)) continue;
    const problem = pathProblem(safety, track.initial, track.initial, track.kind);
    if (!problem) continue;
    const reason = `${track.name} の初期位置: ${problem}`;
    errors.push(reason);
    for (const e of entries) if (e.track === track) block(e, reason);
  }

  const reserve = (e: PlanEntry): boolean => {
    const from = e.from!, to = e.to!, run = e.action.runSeconds, start = e.start!;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const margin = distance ? safety.robotRadius / distance : 0;
    const claims = pathSections(safety, from, to).filter((s) => s.zone).map((s) => ({
      zone: s.zone!, start: start + run * Math.max(0, s.from - margin), end: start + run * Math.min(1, s.to + margin),
    }));
    for (const claim of claims) {
      const cause = (reservations.get(claim.zone) ?? []).find((r) => r.trackId !== e.track.id &&
        claim.start < r.end - EPS && claim.end > r.start + EPS);
      if (cause) {
        e.reason = Number.isFinite(cause.end)
          ? `${cause.name} と狭い廊下の通行時刻が重なっています。バーの配置時刻を調整してください。`
          : `${cause.name} が狭い廊下内に停止し、退出予定がないため通行できません。退出する動作を追加してください。`;
        return false;
      }
    }
    for (const { zone, start: s, end } of claims) {
      reservations.set(zone, [...(reservations.get(zone) ?? []), { trackId: e.track.id, name: e.track.name, start: s, end }]);
    }
    return true;
  };

  const fail = (e: PlanEntry) => {
    e.outcome = "failure";
    e.to = e.from;
    e.end = e.start;
    e.travel = 0;
    e.segments = [];
    e.roomId = map.rooms.find((room) => roomContainsPoint(room, e.to!.x, e.to!.y))?.id ?? "";
    errors.push(`${e.track.name} / ${e.action.name}: ${e.reason}`);
  };

  const order = entries.map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.action.position - b.e.action.position || a.i - b.i).map(({ e }) => e);
  for (const e of order) {
    if (e.blocked) continue;
    const a = e.action, track = e.track, pred = previous.get(a.id);
    if (pred && (pred.blocked || pred.outcome !== "success")) {
      block(e, `${pred.track.name} / ${pred.action.name} が成功していないため停止しています。`);
      continue;
    }
    if (!(a.position >= 0)) { block(e, "開始時刻が負のバーは置けません。", true); continue; }
    if (!(a.runSeconds >= 0)) { block(e, "バーの長さが不正です。", true); continue; }
    if (a.runSeconds === 0 && !ZERO_LENGTH_ALLOWED.has(a.type)) {
      block(e, "長さ0のバーは非表示・イベント終了だけに置けます。", true);
      continue;
    }
    if (pred && pred.end! > a.position + EPS) {
      block(e, `同じ行のバーが重なっています。${pred.action.name} の終了以降へ配置してください。`, true);
      continue;
    }
    e.start = a.position;
    e.outcome = "success";
    const prior = latest.get(track.id);
    if (track.initial) e.from = prior?.to ?? track.initial;
    if (a.type === "move" && e.from && isActor(track.kind)) {
      const rotate = a.motion === "rotate";
      e.to = rotate ? { ...e.from, yaw: normalizeYaw(a.yaw) } : { x: a.x, y: a.y, yaw: e.from.yaw };
      e.roomId = rotate ? prior?.roomId ?? track.initial!.roomId : a.roomId;
      const problem = pathProblem(safety, e.from, e.to, track.kind);
      if (problem) {
        e.geometryFailure = true;
        e.reason = problem;
        fail(e);
      } else if (!rotate && track.kind === "robot" && !reserve(e)) {
        e.trafficFailure = true;
        fail(e);
      } else {
        e.travel = a.runSeconds;
        e.end = e.start + a.runSeconds;
        e.segments = [{ start: e.start, end: e.end, from: { x: e.from.x, y: e.from.y }, to: { x: e.to.x, y: e.to.y } }];
      }
      latest.set(track.id, e);
      log.push({ at: e.end!, kind: "arrival", entry: e });
    } else e.end = e.start + a.runSeconds;
    log.push({ at: e.start, kind: "start", entry: e });
    if (e.outcome === "success") log.push({ at: e.end!, kind: "complete", entry: e });
  }
  for (const e of entries) if (e.start === null) {
    warnings.push({ code: "blocked", actionId: e.action.id, message: `${e.track.name} / ${e.action.name}: ${e.reason}` });
  }

  const priority = { start: 0, arrival: 1, complete: 2 };
  const index = new Map<PlanEntry, number>();
  for (const event of log) if (!index.has(event.entry)) index.set(event.entry, index.size);
  log.sort((a, b) => a.at - b.at || index.get(a.entry)! - index.get(b.entry)! || priority[a.kind] - priority[b.kind]);
  const duration = Math.max(0, ...entries.map((e) => e.end ?? 0));
  const trajectories: Trajectory[] = map.tracks.filter((t) => t.initial && !t.muted && isActor(t.kind)).map((t) => {
    let from: Point = t.initial!, cursor = 0;
    const segments: TrajectorySegment[] = [];
    for (const e of entries.filter((e) => e.track === t && e.action.type === "move" && e.start !== null)
      .sort((a, b) => a.start! - b.start!)) {
      if (e.start! > cursor) segments.push({ start: cursor, end: e.start!, from, to: from });
      segments.push(...e.segments);
      cursor = e.end!;
      from = e.to!;
    }
    segments.push({ start: cursor, end: Math.max(cursor, duration) + 0.001, from, to: from });
    return { id: t.id, name: t.name, kind: t.kind as ActorKind, segments };
  });
  return { entries, log, errors, warnings, duration, trajectories };
}

function movementPosition(e: PlanEntry, time: number): PlanPose {
  time = Math.min(time, e.end ?? time);
  const from = e.from!, to = e.to ?? from;
  const progress = e.travel ? clamp((time - e.start!) / e.travel, 0, 1) : 1;
  const p = e.segments.length ? positionAt(e.segments, time)
    : { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
  return { x: p.x, y: p.y, yaw: normalizeYaw(from.yaw + shortestTurn(from.yaw, to.yaw) * progress) };
}

export function samplePlan(plan: ScenePlan, time: number): SceneState {
  if (!(Number.isFinite(time) && time >= 0)) throw new Error("再生時刻は0以上の有限数で指定してください。");
  const { map, entries, log } = plan;
  const actors: SceneActor[] = map.tracks.filter((t) => isActor(t.kind) && !t.muted && t.initial).map((t) => ({
    id: t.id, kind: t.kind as ActorKind, name: t.name, color: t.color,
    count: t.kind === "human" ? t.count ?? 1 : 1,
    ...(t.kind === "robot" ? { robotRole: t.robotRole ?? "cleaning" } : {}),
    robotId: t.kind === "robot" ? t.robotId ?? null : null,
    ...(t.initial as Pose), aggregated: false, moving: false,
  }));
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));
  const movements = new Map<string, PlanEntry>(), displays = new Map<string, SceneDisplay>();
  const events = new Map<string, SceneEvent>(), rooms = new Map(map.rooms.map((room) => [room.id, room]));
  const inside = (actor: SceneActor, roomId: string) => {
    const room = rooms.get(roomId);
    return actor.roomId === roomId && !!room && roomContainsPoint(room, actor.x, actor.y);
  };
  const inEvent = (actor: SceneActor) => Array.from(events.values()).some((event) => inside(actor, event.roomId));
  const aggregate = (actor: SceneActor) => { if (!actor.moving && inEvent(actor)) actor.aggregated = true; };
  const advance = (at: number) => {
    for (const [id, movement] of Array.from(movements)) {
      const actor = actorById.get(id)!;
      Object.assign(actor, movementPosition(movement, at));
      const segment = movement.segments.find((s) => at >= s.start && at < s.end);
      actor.moving = !!segment && (movement.action.motion === "rotate" || moved(segment.from, segment.to));
    }
  };
  for (const event of log) {
    if (event.at > time) break;
    advance(event.at);
    const { action, track } = event.entry, actor = actorById.get(track.id);
    if (event.kind === "complete") {
      if (action.type === "show" && displays.get(action.targetId)?.actionId === action.id) displays.delete(action.targetId);
      if (action.type === "event-start" && events.get(action.targetId)?.actionId === action.id) events.delete(action.targetId);
    }
    if (event.kind === "start" && action.type === "move") {
      if (!actor) continue;
      if (actor.roomId !== event.entry.roomId) actor.aggregated = false;
      movements.set(track.id, event.entry);
      actor.moving = (event.entry.travel ?? 0) > 0;
    } else if (event.kind === "arrival") {
      if (!actor) continue;
      Object.assign(actor, movementPosition(event.entry, event.at), { roomId: event.entry.roomId ?? "", moving: false });
      aggregate(actor);
    } else if (event.kind === "start" && event.entry.outcome === "success") {
      if (action.type === "show") displays.set(action.targetId, {
        actionId: action.id, targetId: action.targetId, text: action.text, x: action.x, y: action.y, color: track.color,
        ...(action.displayTemplate ? { displayTemplate: action.displayTemplate } : {}),
        ...(isActor(track.kind) ? { actorId: track.id } : {}),
      });
      if (action.type === "hide") displays.delete(action.targetId);
      if (action.type === "event-start") {
        events.set(action.targetId, {
          actionId: action.id, targetId: action.targetId, roomId: action.roomId || track.roomId || "",
          state: action.state, text: action.text, color: track.color,
          ...(action.hatchColor ? { hatchColor: action.hatchColor } : {}),
          ...(action.hatchStyle ? { hatchStyle: action.hatchStyle } : {}),
        });
        actors.forEach(aggregate);
      }
      if (action.type === "event-end") events.delete(action.targetId);
    }
  }
  advance(time);
  for (const actor of actors) if (!inEvent(actor)) actor.aggregated = false;

  const actionStates: Record<string, ActionState> = {};
  for (const e of entries) {
    const waiting = !e.blocked && time < e.start!, running = !e.blocked && !waiting && time < e.end!;
    const failed = e.outcome === "failure";
    const status = e.blocked ? "blocked" : waiting ? "waiting" : running ? "running" : failed ? "failed" : "complete";
    const reason = e.reason || (waiting ? `配置の開始時刻待ち（${e.start!.toFixed(2)}秒）` : "");
    actionStates[e.action.id] = {
      status, start: e.start, end: e.end, reason,
      result: {
        schema: "scene-action-result/v1", actionId: e.action.id, trackId: e.track.id,
        robotId: e.track.robotId ?? null, source: "simulation",
        status: e.blocked ? "blocked" : waiting ? "pending" : running ? "running" : failed ? "failed" : "success",
        elapsedSeconds: e.start === null ? 0 : Math.max(0, Math.min(time, e.end!) - e.start),
        startedAtSeconds: e.start, endedAtSeconds: e.end,
        simulatedPosition: e.from && e.start !== null && time >= e.start ? movementPosition(e, time) : null,
        measuredPosition: null, reason,
      },
    };
  }

  const travelling = new Set(entries.filter((e) => !e.blocked && e.action.type === "move" && e.start !== null &&
    time >= e.start && time < e.end! && (e.action.motion === "rotate" || moved(e.from!, e.to!))).map((e) => e.track.id));
  const chargers = map.floorPlan?.chargingZones ?? [];
  const roomActivities = map.rooms.filter((room) => room.kind === "room").flatMap((room) => {
    const robots = actors.filter((actor) => actor.kind === "robot" && !actor.moving && !travelling.has(actor.id) &&
      roomContainsPoint(room, actor.x, actor.y) && !chargers.some((zone) => actor.x >= zone.x &&
        actor.x <= zone.x + zone.width && actor.y >= zone.y && actor.y <= zone.y + zone.height));
    if (!robots.length) return [];
    const labels = Array.from(new Set(robots.map((robot) => ROLE_LABELS[robot.robotRole ?? "cleaning"])));
    return [{ roomId: room.id, text: labels.join(" / "), actorIds: robots.map((robot) => robot.id) }];
  });
  return {
    actors, displays: Array.from(displays.values()), events: Array.from(events.values()), actionStates, roomActivities,
    doors: sampleDoorPlan(plan, time), duration: plan.duration, errors: plan.errors, warnings: plan.warnings,
  };
}

export function actionPreview(map: SceneMap, trackId: string, action: Action): ActionPreview {
  const copy = structuredClone(map), track = copy.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error("プレビュー対象の行が見つかりません。");
  const index = track.actions.findIndex((a) => a.id === action.id);
  if (index < 0) track.actions.push(structuredClone(action));
  else track.actions[index] = structuredClone(action);
  const entry = compilePlan(copy).entries.find((e) => e.action.id === action.id)!;
  const sequence = byPosition(track);
  const precedingMove = sequence.slice(0, sequence.findIndex((a) => a.id === action.id))
    .findLast((a) => a.type === "move" && a.motion !== "rotate");
  // Blocked rows still get a geometry check from the nearest known pose.
  const from: PlanPose | null = entry.from ?? (precedingMove
    ? { x: precedingMove.x, y: precedingMove.y, yaw: precedingMove.yaw, roomId: precedingMove.roomId }
    : track.initial) ?? null;
  let geometryProblem = "";
  if (action.type === "move" && from && track.initial && isActor(track.kind)) {
    const safety = createSafety(copy);
    geometryProblem = pathProblem(safety, track.initial, track.initial, track.kind) ||
      pathProblem(safety, from, action.motion === "rotate" ? from : action, track.kind);
  }
  return {
    from, geometryProblem, start: entry.start, end: entry.end,
    warning: entry.reason || (entry.blocked ? "開始条件が成立しないため、開始位置は参考表示です。" : ""),
  };
}

export function addFacingTurns(map: SceneMap, makeId: IdFactory = defaultId): number {
  const robots = map.tracks.filter((track) => track.kind === "robot" && track.initial);
  for (const track of robots) {
    const moves = byPosition(track).filter((a) => a.type === "move");
    const stale = new Set(moves.filter((a, i) => a.facingFor && moves[i + 1]?.id !== a.facingFor).map((a) => a.id));
    track.actions = track.actions.filter((a) => !stale.has(a.id));
  }
  let added = 0;
  for (;;) {
    const needed: { track: Track; action: Action; from: Pose; yaw: number; delta: number }[] = [];
    for (const track of robots) {
      let from: Pose = { ...track.initial! };
      const actions = byPosition(track);
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        if (action.type !== "move") continue;
        if (action.motion === "rotate") {
          const target = actions.slice(i + 1).find((a) => a.type === "move");
          if (action.facingFor && action.facingFor === target?.id && target.motion !== "rotate") {
            const dx = target.x - from.x, dy = target.y - from.y;
            if (Math.hypot(dx, dy) > EPS) action.yaw = heading(dx, dy);
            Object.assign(action, { x: from.x, y: from.y, roomId: from.roomId ?? "" });
          }
          from.yaw = action.yaw;
          continue;
        }
        const dx = action.x - from.x, dy = action.y - from.y, yaw = heading(dx, dy);
        const delta = Math.abs(shortestTurn(from.yaw, yaw));
        if (Math.hypot(dx, dy) > EPS && delta > 1e-6) {
          needed.push({ track, action, from: { ...from }, yaw, delta });
          break;
        }
        from = { x: action.x, y: action.y, yaw: from.yaw, roomId: action.roomId,
          ...(action.coordinateMode ? { coordinateMode: action.coordinateMode } : {}) };
      }
    }
    if (!needed.length) return added;
    const at = Math.min(...needed.map((item) => item.action.position));
    const batch = needed.filter((item) => Math.abs(item.action.position - at) < EPS);
    const duration = Math.max(...batch.map((item) => Math.ceil(item.delta / FACING_DEG_PER_SECOND * 10) / 10));
    // Shifting every row keeps humans, events and unlocks in step with the inserted turn.
    for (const track of map.tracks) for (const action of track.actions) {
      if (action.position >= at - EPS) action.position += duration;
      else if (action.position + action.runSeconds > at + EPS) {
        action.runSeconds += duration;
        if (action.motion === "rotate") action.rotationSeconds = action.runSeconds;
      }
    }
    for (const { track, action, from, yaw } of batch) {
      const turn = newAction(map, track, "move", makeId);
      Object.assign(turn, {
        name: `進行方向へ旋回 · ${action.name}`.slice(0, 120), position: at, runSeconds: duration,
        motion: "rotate", rotationSeconds: duration, x: from.x, y: from.y, yaw, roomId: from.roomId ?? "",
        facingFor: action.id,
      });
      if (from.coordinateMode === "free") turn.coordinateMode = "free";
      track.actions.push(turn);
      added++;
    }
  }
}
