import { mergedDoors, type MergedDoor } from "./equipment";
import { collisionWarnings, positionAt, type ActorKind, type Point, type Trajectory, type TrajectorySegment } from "./safety";
import type { Action, SceneMap, Segment, Track } from "./types";
import { HUMAN_RADIUS_MM, SAFETY_RADIUS_MM } from "./units";

export const DOOR_TRANSITION_SECONDS = 0.6;
// Upstream 10 ratio units.
const CLEARANCE_PAD_MM = 7;
// Upstream 4 * CELL_SIZE = 200 ratio units.
const SENSOR_REACH_MM = 138;
// Upstream 2 * CELL_SIZE = 100 ratio units.
const SENSOR_RAMP_MM = 69;

export interface DoorPlanEntry {
  track: Track;
  action: Pick<Action, "id" | "name" | "type" | "position" | "roomId"> & Partial<Pick<Action, "motion" | "doorId">>;
  start: number | null;
  end: number | null;
  // End position of a move entry.
  to?: Point;
  segments: TrajectorySegment[];
  blocked: boolean;
  reason?: string;
  outcome?: "success" | "failure" | null;
}

export interface PlanWarning {
  code: string;
  message: string;
  actionId?: string;
  trackIds?: [string, string];
  at?: number;
}

export type DoorPath = Trajectory & { radius: number };

export interface DoorPassage {
  actorId: string;
  start: number;
  end: number;
  openingStart: number;
  openBy: number;
}

export interface DoorWindow {
  start: number;
  end: number;
  heldUntil: number;
}

export type PlannedDoor = MergedDoor & { passages: DoorPassage[]; windows: DoorWindow[] };

export interface DoorPlanInput {
  map: SceneMap;
  entries: DoorPlanEntry[];
  errors: string[];
  warnings: PlanWarning[];
  log?: { entry: DoorPlanEntry }[];
  duration?: number;
  doorPaths?: DoorPath[];
  doorPlan?: PlannedDoor[];
}

export interface DoorSample {
  id: string;
  unlocked: boolean;
  held: boolean;
  openness: number;
  actorIds: string[];
}

const radiusOf = (kind: string) => kind === "robot" ? SAFETY_RADIUS_MM : HUMAN_RADIUS_MM;

function distanceToOpening(opening: Segment, point: Point): number {
  const dx = opening.x2 - opening.x1, dy = opening.y2 - opening.y1, length = dx * dx + dy * dy;
  const along = length ? Math.max(0, Math.min(1, ((point.x - opening.x1) * dx + (point.y - opening.y1) * dy) / length)) : 0;
  return Math.hypot(point.x - opening.x1 - along * dx, point.y - opening.y1 - along * dy);
}

export function automaticDoorOpenness(opening: Segment, actors: { kind: string; x: number; y: number }[]): number {
  let openness = 0;
  for (const actor of actors) {
    if (actor.kind !== "robot" && actor.kind !== "human") continue;
    const distance = distanceToOpening(opening, actor);
    // Same position always gives the same openness, fully open before the body arrives.
    openness = Math.max(openness, Math.max(0, Math.min(1,
      (radiusOf(actor.kind) + SENSOR_REACH_MM - distance) / SENSOR_RAMP_MM)));
  }
  return openness;
}

function trajectories(plan: DoorPlanInput): DoorPath[] {
  return plan.map.tracks.filter((t) => t.initial && !t.muted && (t.kind === "robot" || t.kind === "human")).map((track) => {
    let from: Point = track.initial!, cursor = 0;
    const segments: TrajectorySegment[] = [];
    for (const entry of plan.entries.filter((e) => e.track.id === track.id && e.action.type === "move" &&
      !e.blocked && e.start !== null).sort((a, b) => a.start! - b.start!)) {
      if (entry.start! > cursor) segments.push({ start: cursor, end: entry.start!, from, to: from });
      segments.push(...entry.segments);
      cursor = entry.end!;
      from = entry.to!;
    }
    segments.push({ start: cursor, end: Infinity, from, to: from });
    const kind = track.kind as ActorKind;
    return { id: track.id, name: track.name, kind, radius: radiusOf(kind), segments };
  });
}

function clearAt(opening: Segment, path: DoorPath, at: number): number {
  const clearance = path.radius + CLEARANCE_PAD_MM;
  if (distanceToOpening(opening, positionAt(path.segments, at)) > clearance) return at;
  for (const segment of path.segments.filter((s) => s.end > at)) {
    if (distanceToOpening(opening, segment.to) <= clearance) continue;
    // The region near the opening is convex, so one exit point per straight segment suffices.
    let low = Math.max(segment.start, at), high = segment.end;
    for (let i = 0; i < 40; i++) {
      const mid = (low + high) / 2;
      if (distanceToOpening(opening, positionAt([segment], mid)) <= clearance) low = mid;
      else high = mid;
    }
    return high;
  }
  return Infinity;
}

function crossingTime(opening: Segment, segment: TrajectorySegment, radius: number): { enter: number; at: number } | null {
  const horizontal = opening.y1 === opening.y2, key = horizontal ? "y" : "x";
  const boundary = horizontal ? opening.y1 : opening.x1;
  const delta = segment.to[key] - segment.from[key];
  if (!delta) return null;
  const t = (boundary - segment.from[key]) / delta;
  if (t < 0 || t > 1) return null;
  const coordinate = horizontal ? segment.from.x + (segment.to.x - segment.from.x) * t
    : segment.from.y + (segment.to.y - segment.from.y) * t;
  const a = horizontal ? opening.x1 : opening.y1, b = horizontal ? opening.x2 : opening.y2;
  if (coordinate < Math.min(a, b) || coordinate > Math.max(a, b)) return null;
  const at = segment.start + (segment.end - segment.start) * t;
  const enter = Math.max(segment.start, at - (radius + CLEARANCE_PAD_MM) * (segment.end - segment.start) / Math.abs(delta));
  return { enter, at };
}

function doorWindows(plan: DoorPlanInput, doors: MergedDoor[], paths: DoorPath[]): PlannedDoor[] {
  const unlocks = plan.entries.filter((e) => e.action.type === "unlock" && !e.blocked && e.outcome === "success" &&
    e.start !== null && e.end !== null && e.end > e.start);
  return doors.map((door) => ({
    ...door,
    passages: paths.flatMap((path) => path.segments.flatMap((segment) => {
      if (!Number.isFinite(segment.end)) return [];
      const crossing = crossingTime(door.opening, segment, path.radius);
      if (!crossing) return [];
      return [{
        actorId: path.id, start: segment.start, end: segment.end,
        openingStart: Math.max(0, segment.start - DOOR_TRANSITION_SECONDS),
        openBy: segment.start > 0 ? segment.start : Math.min(DOOR_TRANSITION_SECONDS, crossing.enter),
      }];
    })),
    windows: unlocks.filter((e) => e.action.doorId ? door.memberIds.includes(e.action.doorId) : e.action.roomId === door.roomId)
      .map((entry) => ({
        start: entry.start!, end: entry.end!,
        heldUntil: Math.max(entry.end!, ...paths.map((path) => clearAt(door.opening, path, entry.end!))),
      })),
  }));
}

const allowed = (door: PlannedDoor, at: number) => door.windows.some((w) => at >= w.start && at < w.heldUntil);

export function prepareDoorPlan(plan: DoorPlanInput): void {
  const doors = mergedDoors(plan.map);
  if (!doors.length) { plan.doorPlan = []; return; }
  const previous = new Map<string, DoorPlanEntry>();
  for (const track of plan.map.tracks) {
    const ordered = plan.entries.filter((e) => e.track.id === track.id).sort((a, b) => a.action.position - b.action.position);
    ordered.forEach((entry, i) => { if (i) previous.set(entry.action.id, ordered[i - 1]); });
  }
  let changed;
  do {
    changed = false;
    const states = doorWindows(plan, doors, trajectories(plan));
    for (const entry of plan.entries) {
      if (entry.blocked || entry.start === null) continue;
      let reason = "";
      if (entry.action.type === "move" && entry.action.motion !== "rotate") {
        const closed = states.find((door) => entry.segments.some((segment) => {
          const crossing = crossingTime(door.opening, segment, radiusOf(entry.track.kind));
          return crossing !== null && (!allowed(door, crossing.enter) || !allowed(door, crossing.at));
        }));
        if (closed) {
          const name = closed.name ?? plan.map.rooms.find((r) => r.id === closed.roomId)?.name ?? "部屋";
          reason = `${name}のドアが施錠中です。通過時刻を含む解錠コントロールを追加してください。`;
          if (plan.map.doorMode === "story") {
            if (!plan.warnings.some((w) => w.code === "door-preview" && w.actionId === entry.action.id)) {
              plan.warnings.push({
                code: "door-preview", actionId: entry.action.id,
                message: `${entry.track.name} / ${entry.action.name}: ストーリー確認のため移動を継続します。${reason} 実機通行の許可ではありません。`,
              });
            }
            reason = "";
          }
        }
      }
      if (!reason && previous.get(entry.action.id)?.blocked) reason = "前の項目が成功していないため停止しています。";
      if (reason) {
        Object.assign(entry, { blocked: true, reason, outcome: null, start: null, end: null, segments: [] });
        plan.errors.push(`${entry.track.name} / ${entry.action.name}: ${reason}`);
        changed = true;
      }
    }
  } while (changed);
  const paths = trajectories(plan);
  plan.doorPaths = paths;
  plan.doorPlan = doorWindows(plan, doors, paths);
  if (plan.log) plan.log = plan.log.filter((item) => !item.entry.blocked);
  plan.warnings = [...plan.warnings.filter((w) => w.code !== "collision"), ...collisionWarnings(paths)];
  plan.duration = Math.max(0, ...plan.entries.map((e) => e.end ?? 0));
}

export function sampleDoorPlan(plan: DoorPlanInput, time: number): DoorSample[] {
  const actors = new Map((plan.doorPaths ?? []).map((path) => [path.id, {
    ...positionAt(path.segments, time), kind: path.kind, radius: path.radius,
  }]));
  return (plan.doorPlan ?? []).map((door) => {
    const unlocked = door.windows.some((w) => time >= w.start && time < w.end);
    const held = door.windows.some((w) => time >= w.end && time < w.heldUntil);
    let openness = 0;
    for (const passage of door.passages) {
      if (time < passage.openingStart || time >= passage.end + DOOR_TRANSITION_SECONDS) continue;
      const actor = actors.get(passage.actorId);
      if (!actor) continue;
      const opening = passage.openBy > passage.openingStart
        ? (time - passage.openingStart) / (passage.openBy - passage.openingStart) : 1;
      const closing = time <= passage.end ? 1 : 1 - (time - passage.end) / DOOR_TRANSITION_SECONDS;
      // Bridges the preceding turn and post-arrival wait so the door never snaps at a boundary.
      openness = Math.max(openness, automaticDoorOpenness(door.opening, [actor]) * Math.max(0, Math.min(1, opening, closing)));
    }
    if (Array.from(actors.values()).some((actor) => distanceToOpening(door.opening, actor) <= actor.radius + CLEARANCE_PAD_MM)) {
      openness = 1;
    }
    return {
      id: door.id, unlocked, held,
      openness: held ? 1 : unlocked ? openness : 0,
      actorIds: door.passages.filter((p) => time >= p.start && time < p.end).map((p) => p.actorId),
    };
  });
}
