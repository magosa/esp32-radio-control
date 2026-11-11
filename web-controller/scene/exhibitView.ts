import { roomContainsPoint } from "./floorPlan";
import { roomActivitiesOf, type RoomActivity, type SceneActor, type SceneDisplay, type SceneEvent, type SceneState } from "./timedPlan";
import type { SceneMap } from "./types";
import { AREA_HEIGHT_MM, AREA_WIDTH_MM, FIELD_HEIGHT_MM, FIELD_WIDTH_MM } from "./units";

// The exhibit fills the whole 50-inch surface (the field), so one screen pixel is the same distance on both axes.
export const EXHIBIT_VIEW_BOX = `0 0 ${FIELD_WIDTH_MM} ${FIELD_HEIGHT_MM}`;
// The map's SVG puts its top edge at y = 0; on the field its bottom edge sits on the bottom of the surface.
export const EXHIBIT_MAP_OFFSET_Y = FIELD_HEIGHT_MM - AREA_HEIGHT_MM;

export interface MeasuredPose {
  robotId: string;
  x: number;
  y: number;
  yaw: number;
}

export interface ExhibitScene {
  actors: SceneActor[];
  displays: SceneDisplay[];
  events: SceneEvent[];
  roomActivities: RoomActivity[];
  doors: SceneState["doors"];
}

const roomAt = (map: SceneMap, x: number, y: number): string => map.rooms.find((room) => roomContainsPoint(room, x, y))?.id ?? "";

// The robots are real and already on the surface, so the exhibit draws no robot body. What belongs to a robot
// (its labels, the work shown in a room) follows the measured position, and disappears while the robot is not tracked.
export function exhibitScene(state: SceneState, map: SceneMap, poses: readonly MeasuredPose[]): ExhibitScene {
  const measured = new Map(poses.map((pose) => [pose.robotId, pose]));
  const robots = state.actors.flatMap((actor): SceneActor[] => {
    const pose = actor.kind === "robot" && actor.robotId !== null ? measured.get(actor.robotId) : undefined;
    return pose ? [{ ...actor, x: pose.x, y: pose.y, yaw: pose.yaw, roomId: roomAt(map, pose.x, pose.y) }] : [];
  });
  const humans = state.actors.filter((actor) => actor.kind === "human");
  const trackedRobot = new Map(robots.map((actor) => [actor.id, actor]));
  const robotIds = new Set(state.actors.filter((actor) => actor.kind === "robot").map((actor) => actor.id));
  const displays = state.displays.flatMap((display): SceneDisplay[] => {
    if (!display.actorId || !robotIds.has(display.actorId)) return [display];
    const robot = trackedRobot.get(display.actorId);
    return robot ? [{ ...display, x: robot.x, y: robot.y }] : [];
  });
  return {
    actors: [...humans, ...robots],
    displays,
    events: state.events,
    roomActivities: roomActivitiesOf(map, robots, new Set(state.travelling)),
    doors: state.doors,
  };
}

// ---- Position check: crosses on a 100 mm pitch and the offset of a measured robot from the nearest one ----

export const ALIGNMENT_PITCH_MM = 100;

export interface Cross {
  x: number;
  y: number;
}

export function alignmentCrosses(): Cross[] {
  const crosses: Cross[] = [];
  for (let y = ALIGNMENT_PITCH_MM; y <= AREA_HEIGHT_MM - ALIGNMENT_PITCH_MM; y += ALIGNMENT_PITCH_MM) {
    for (let x = ALIGNMENT_PITCH_MM; x <= AREA_WIDTH_MM - ALIGNMENT_PITCH_MM; x += ALIGNMENT_PITCH_MM) crosses.push({ x, y });
  }
  return crosses;
}

export interface CrossOffset {
  cross: Cross;
  // Measured minus the cross, in mm: positive dx is to the right of the cross, positive dy above it.
  dx: number;
  dy: number;
  distance: number;
}

export function nearestCross(x: number, y: number): CrossOffset {
  const snap = (value: number, extent: number) => {
    const last = Math.floor((extent - ALIGNMENT_PITCH_MM) / ALIGNMENT_PITCH_MM) * ALIGNMENT_PITCH_MM;
    return Math.min(last, Math.max(ALIGNMENT_PITCH_MM, Math.round(value / ALIGNMENT_PITCH_MM) * ALIGNMENT_PITCH_MM));
  };
  const cross = { x: snap(x, AREA_WIDTH_MM), y: snap(y, AREA_HEIGHT_MM) };
  const dx = x - cross.x, dy = y - cross.y;
  return { cross, dx, dy, distance: Math.hypot(dx, dy) };
}
