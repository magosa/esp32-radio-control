import assert from "node:assert/strict";
import test from "node:test";
import {
  ALIGNMENT_PITCH_MM, EXHIBIT_MAP_OFFSET_Y, EXHIBIT_VIEW_BOX, alignmentCrosses, exhibitScene, nearestCross,
} from "../../scene/exhibitView";
import { cellIndex } from "../../scene/grid";
import { createProject, newAction, newTrack } from "../../scene/model";
import { compilePlan, samplePlan } from "../../scene/timedPlan";
import type { Action, ActionType, Room, Track, TrackKind } from "../../scene/types";

const rect = (col: number, row: number, width: number, height: number) =>
  Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => cellIndex(col + c, row + r))).flat();
const region = (id: string, cells: number[]): Room => ({ id, name: id, cells, kind: "room", material: "wood", color: "#123456" });

function fixture() {
  let n = 0;
  const makeId = () => `id-${++n}`;
  const map = createProject("p", makeId).maps[0];
  Object.assign(map, { doorMode: "story", rooms: [region("left", rect(0, 0, 27, 31)), region("right", rect(27, 0, 28, 31))], floorPlan: { doors: [], furniture: [] } });
  const track = (kind: TrackKind, initial: { x: number; y: number }, robotId?: string) => {
    const t = newTrack(map, kind, makeId);
    Object.assign(t.initial!, { yaw: 0, roomId: "left" }, initial);
    if (robotId) { t.robotId = robotId; t.robotRole = "cleaning"; }
    map.tracks.push(t);
    return t;
  };
  const action = (owner: Track, type: ActionType, props: Partial<Action> = {}) => {
    const a = Object.assign(newAction(map, owner, type, makeId), props);
    owner.actions.push(a);
    return a;
  };
  return { map, track, action };
}

const stateAt = (map: ReturnType<typeof fixture>["map"], time: number) => samplePlan(compilePlan(map), time);

test("the exhibit view box is the whole surface and the map sits on its bottom edge", () => {
  assert.equal(EXHIBIT_VIEW_BOX, "0 0 1106.93 622.65");
  assert.ok(Math.abs(EXHIBIT_MAP_OFFSET_Y - 2.65) < 1e-9);
});

test("robots that are not tracked are not drawn; tracked ones use the measured pose and room", () => {
  const { map, track } = fixture();
  track("robot", { x: 210, y: 310 }, "r1");
  track("robot", { x: 210, y: 110 }, "r2");
  track("human", { x: 110, y: 110 });
  const scene = exhibitScene(stateAt(map, 0), map, [{ robotId: "r1", x: 810, y: 210, yaw: 90 }]);
  const robots = scene.actors.filter((a) => a.kind === "robot");
  assert.equal(robots.length, 1);
  assert.deepEqual([robots[0].robotId, robots[0].x, robots[0].y, robots[0].yaw, robots[0].roomId], ["r1", 810, 210, 90, "right"]);
  assert.equal(scene.actors.filter((a) => a.kind === "human").length, 1);
});

test("a measured pose for an unknown robot is ignored", () => {
  const { map, track } = fixture();
  track("robot", { x: 210, y: 310 }, "r1");
  const scene = exhibitScene(stateAt(map, 0), map, [{ robotId: "ghost", x: 10, y: 10, yaw: 0 }]);
  assert.equal(scene.actors.length, 0);
});

test("a robot's label follows the measured pose and vanishes while it is not tracked; a person's label stays", () => {
  const { map, track, action } = fixture();
  const robot = track("robot", { x: 210, y: 310 }, "r1");
  const human = track("human", { x: 110, y: 110 });
  action(robot, "show", { position: 0, runSeconds: 5, x: 210, y: 310, text: "robot label" });
  action(human, "show", { position: 0, runSeconds: 5, x: 110, y: 110, text: "human label" });
  const state = stateAt(map, 1);
  assert.equal(state.displays.length, 2);
  const tracked = exhibitScene(state, map, [{ robotId: "r1", x: 450, y: 250, yaw: 0 }]);
  const robotLabel = tracked.displays.find((d) => d.text === "robot label")!;
  assert.deepEqual([robotLabel.x, robotLabel.y], [450, 250]);
  const lost = exhibitScene(state, map, []);
  assert.deepEqual(lost.displays.map((d) => d.text), ["human label"]);
  assert.deepEqual(lost.displays[0] && [lost.displays[0].x, lost.displays[0].y], [110, 110]);
});

test("room activity follows where the robot is measured, not where the plan puts it", () => {
  const { map, track } = fixture();
  track("robot", { x: 210, y: 310 }, "r1");
  const state = stateAt(map, 0);
  assert.deepEqual(state.roomActivities.map((a) => a.roomId), ["left"]);
  const moved = exhibitScene(state, map, [{ robotId: "r1", x: 810, y: 210, yaw: 0 }]);
  assert.deepEqual(moved.roomActivities.map((a) => [a.roomId, a.text]), [["right", "掃除中"]]);
  assert.deepEqual(exhibitScene(state, map, []).roomActivities, []);
});

test("a travelling robot and one parked on a charging pad do not show room activity", () => {
  const { map, track, action } = fixture();
  const robot = track("robot", { x: 210, y: 310 }, "r1");
  action(robot, "move", { position: 0, runSeconds: 10, x: 410, y: 310 });
  const midway = stateAt(map, 5);
  assert.deepEqual(midway.travelling, [robot.id]);
  assert.deepEqual(exhibitScene(midway, map, [{ robotId: "r1", x: 300, y: 310, yaw: 0 }]).roomActivities, []);
  const resting = stateAt(map, 20);
  assert.equal(exhibitScene(resting, map, [{ robotId: "r1", x: 410, y: 310, yaw: 0 }]).roomActivities.length, 1);
  map.floorPlan!.chargingZones = [{ id: "pad", name: "pad", x: 360, y: 260, width: 100, height: 100 }];
  assert.deepEqual(exhibitScene(stateAt(map, 20), map, [{ robotId: "r1", x: 410, y: 310, yaw: 0 }]).roomActivities, []);
});

test("events and doors pass through unchanged", () => {
  const { map, track } = fixture();
  track("robot", { x: 210, y: 310 }, "r1");
  const state = stateAt(map, 0);
  const scene = exhibitScene(state, map, []);
  assert.equal(scene.events, state.events);
  assert.equal(scene.doors, state.doors);
});

test("alignment crosses sit on a 100 mm pitch with a margin from every edge", () => {
  const crosses = alignmentCrosses();
  assert.equal(ALIGNMENT_PITCH_MM, 100);
  assert.equal(crosses.length, 10 * 5);
  assert.deepEqual(crosses[0], { x: 100, y: 100 });
  assert.deepEqual(crosses[crosses.length - 1], { x: 1000, y: 500 });
});

test("nearestCross reports the signed offset of a measured robot", () => {
  const near = nearestCross(312, 196);
  assert.deepEqual(near.cross, { x: 300, y: 200 });
  assert.equal(near.dx, 12);
  assert.equal(near.dy, -4);
  assert.ok(Math.abs(near.distance - Math.hypot(12, 4)) < 1e-9);
  assert.deepEqual(nearestCross(5, 5).cross, { x: 100, y: 100 });
  assert.deepEqual(nearestCross(1100, 620).cross, { x: 1000, y: 500 });
  const tie = nearestCross(450, 250);
  assert.deepEqual([tie.cross.x, tie.cross.y, tie.dx, tie.dy], [500, 300, -50, -50]);
});
