import test from "node:test";
import assert from "node:assert/strict";
import { createProject, newAction, newTrack, projectForSave, validateProject } from "../../scene/model";
import type { SceneMap, SceneProject } from "../../scene/types";

function seqIds() {
  let n = 0;
  return () => `id-${++n}`;
}

function sample(): SceneProject {
  const makeId = seqIds();
  const project = createProject("p", makeId);
  const map = project.maps[0];
  map.rooms.push({ id: "room-a", name: "会議室", color: "#73bafa", kind: "room", material: "wood", cells: [0, 1, 55, 56] });
  map.floorPlan = {
    doors: [{ id: "door-a", roomId: "room-a", cell: 1, edge: "right" }],
    furniture: [],
    chargingZones: [],
    walls: [],
  };
  const robot = newTrack(map, "robot", makeId);
  map.tracks.push(robot);
  robot.actions.push(newAction(map, robot, "move", makeId));
  const display = newTrack(map, "display", makeId);
  map.tracks.push(display);
  display.actions.push(newAction(map, display, "show", makeId));
  display.actions.push(newAction(map, display, "hide", makeId));
  const room = newTrack(map, "room", makeId);
  map.tracks.push(room);
  room.actions.push(newAction(map, room, "event-start", makeId));
  room.actions.push(newAction(map, room, "event-end", makeId));
  const unlock = newAction(map, room, "unlock", makeId);
  unlock.doorId = "door-a";
  room.actions.push(unlock);
  return project;
}

function rejects(mutate: (project: SceneProject, map: SceneMap) => void, pattern?: RegExp) {
  const project = sample();
  mutate(project, project.maps[0]);
  assert.throws(() => validateProject(JSON.parse(JSON.stringify(project))), pattern ?? Error);
}

test("createProject yields one empty valid fleet-scene/v1 map", () => {
  const project = createProject("p", seqIds());
  assert.equal(validateProject(project), project);
  assert.equal(project.schema, "fleet-scene/v1");
  assert.equal(project.maps.length, 1);
  assert.equal(project.maps[0].editGridMm, 20);
  assert.equal(project.maps[0].doorMode, "story");
  assert.equal(project.maps[0].tracks.length, 0);
  assert.equal(project.maps[0].id, "id-1");
});

test("sample project with tracks, rooms and doors is valid", () => {
  const project = sample();
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(project))));
  const [robot, display, room] = project.maps[0].tracks;
  assert.equal(robot.robotId, undefined);
  assert.equal(display.actions[1].targetId, display.actions[0].targetId);
  assert.equal(room.roomId, "room-a");
  assert.equal(room.actions[1].targetId, room.actions[0].targetId);
  assert.equal(room.actions[0].position, 0);
  assert.equal(room.actions[1].position, room.actions[0].runSeconds);
});

test("rejects wrong schema", () => {
  rejects((p) => { (p as { schema: string }).schema = "robot-scene/v5"; }, /schema/);
});

test("rejects more than 8 maps", () => {
  rejects((p) => {
    for (let i = 0; i < 8; i++) p.maps.push({ ...createProject("x").maps[0], id: `extra-${i}` });
  }, /maps/);
});

test("accepts 2000 actions and rejects 2001", () => {
  const build = (count: number) => {
    const makeId = seqIds();
    const project = createProject("p", makeId);
    const map = project.maps[0];
    const track = newTrack(map, "display", makeId);
    map.tracks.push(track);
    for (let i = 0; i < count; i++) {
      const action = newAction(map, track, "wait", makeId);
      action.position = i;
      action.runSeconds = 1;
      track.actions.push(action);
    }
    return project;
  };
  assert.doesNotThrow(() => validateProject(build(2000)));
  assert.throws(() => validateProject(build(2001)), /2000/);
});

test("rejects times outside 0..86400", () => {
  rejects((_, m) => { m.tracks[0].actions[0].runSeconds = 86401; }, /runSeconds/);
  rejects((_, m) => { m.tracks[0].actions[0].position = -1; }, /position/);
});

test("rejects editGridMm outside the options", () => {
  rejects((_, m) => { (m as { editGridMm: number }).editGridMm = 30; }, /editGridMm/);
});

test("rejects cell indices outside 0..1704", () => {
  const project = sample();
  project.maps[0].rooms[0].cells.push(1704);
  assert.doesNotThrow(() => validateProject(project));
  rejects((_, m) => { m.rooms[0].cells.push(1705); }, /cell/);
  rejects((_, m) => { m.rooms[0].cells.push(1.5); }, /cell/);
});

test("rejects yaw -180 and coordinates outside the drawable area", () => {
  rejects((_, m) => { m.tracks[0].actions[0].yaw = -180; }, /yaw/);
  rejects((_, m) => { m.tracks[0].actions[0].x = 1100.1; }, /x/);
  rejects((_, m) => { m.tracks[0].initial!.y = 621; }, /y/);
});

test("rejects join actions and trigger properties", () => {
  rejects((_, m) => { (m.tracks[0].actions[0] as { type: string }).type = "join"; }, /type/);
  rejects((_, m) => { Object.assign(m.tracks[0].actions[0], { trigger: { mode: "all", sources: [] } }); }, /trigger/);
});

test("rejects duplicate ids and unresolved references", () => {
  rejects((_, m) => { m.tracks[1].id = m.tracks[0].id; }, /id/);
  rejects((_, m) => { m.tracks[1].actions[1].targetId = ""; }, /targetId/);
  rejects((_, m) => { m.tracks[2].actions[2].doorId = "missing"; }, /door/);
  rejects((_, m) => { m.tracks[2].actions[2].roomId = ""; }, /room/);
});

test("hide/event-end with unresolved or cross-track targetId are harmless no-ops", () => {
  const unresolved = sample();
  unresolved.maps[0].tracks[1].actions[1].targetId = "no-such-show";
  unresolved.maps[0].tracks[2].actions[1].targetId = "no-such-event";
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(unresolved))));

  const makeId = seqIds();
  const cross = sample();
  const map = cross.maps[0];
  const other = newTrack(map, "display", makeId);
  other.id = "display-b";
  map.tracks.push(other);
  const hide = map.tracks[1].actions.pop()!;
  hide.id = "hide-b";
  other.actions.push(hide);
  assert.ok(!map.tracks[1].actions.some((a) => a.type === "hide"));
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(cross))));
});

test("rejects a room track whose roomId does not exist", () => {
  rejects((_, m) => { m.tracks[2].roomId = "missing"; }, /roomId/);
});

test("rejects an actor initial.roomId that is non-empty and does not exist", () => {
  const project = sample();
  project.maps[0].tracks[0].initial!.roomId = "room-a";
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(project))));
  rejects((_, m) => { m.tracks[0].initial!.roomId = "missing"; }, /initial\.roomId/);
});

test.todo("projectForSave output survives a JSON roundtrip through validateProject", () => {
  const project = sample();
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(projectForSave(project)))));
});
