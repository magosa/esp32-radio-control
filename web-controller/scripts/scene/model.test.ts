import test from "node:test";
import assert from "node:assert/strict";
import { createProject, KINDS, newAction, newTrack, projectForSave, validateProject } from "../../scene/model";
import type { ActionType, SceneMap, SceneProject, TrackKind } from "../../scene/types";

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

test("2000 action limit is global across maps, exact limit validates", () => {
  const makeId = seqIds();
  const project = createProject("p", makeId);
  const fill = (map: SceneMap, count: number) => {
    const track = newTrack(map, "display", makeId);
    map.tracks.push(track);
    for (let i = 0; i < count; i++) {
      const action = newAction(map, track, "wait", makeId);
      Object.assign(action, { position: i, runSeconds: 1 });
      track.actions.push(action);
    }
  };
  fill(project.maps[0], 1500);
  project.maps.push(createProject("q", makeId).maps[0]);
  fill(project.maps[1], 500);
  assert.doesNotThrow(() => validateProject(project));
  project.maps.push(createProject("r", makeId).maps[0]);
  fill(project.maps[2], 1);
  assert.throws(() => validateProject(project), /2000/);
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

test("projectForSave output survives a JSON roundtrip through validateProject", () => {
  const project = sample();
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(projectForSave(project)))));
});

// sample() plus robots with fleet IDs (tracks 0 and 3) and a human (track 4).
function richSample(): SceneProject {
  const project = sample(), map = project.maps[0];
  map.tracks[0].robotId = "robot-a";
  const second = newTrack(map, "robot", () => "robot-track-b");
  second.robotId = "robot-b";
  map.tracks.push(second);
  map.tracks.push(newTrack(map, "human", () => "human-track"));
  return project;
}

test("rich sample with two robots and a human is valid", () => {
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(richSample()))));
});

const G2: [string, (p: SceneProject, m: SceneMap) => void, RegExp][] = [
  ["empty maps", (p) => { p.maps = []; }, /maps/],
  ["null map", (p) => { (p.maps as unknown[])[0] = null; }, /map must be an object/],
  ["unsafe ID", (_, m) => { m.tracks[0].actions[0].id = "__proto__"; }, /action\.id/],
  ["reserved ID", (_, m) => { m.tracks[0].id = "$start"; }, /track\.id/],
  ["unknown kind", (_, m) => { (m.tracks[0] as { kind: string }).kind = "manual"; }, /track\.kind/],
  ["unsafe color", (_, m) => { m.tracks[0].color = "red;xxx"; }, /track\.color/],
  ["nonboolean mute", (_, m) => { (m.tracks[0] as { muted: unknown }).muted = 1; }, /muted/],
  ["duplicate robot", (_, m) => { m.tracks[3].robotId = m.tracks[0].robotId; }, /robotId/],
  ["human zero count", (_, m) => { m.tracks[4].count = 0; }, /count/],
  ["human fractional count", (_, m) => { m.tracks[4].count = 1.5; }, /count/],
  ["missing initial room", (_, m) => { delete (m.tracks[0].initial as { roomId?: string }).roomId; }, /initial\.roomId/],
  ["unknown action room", (_, m) => { m.tracks[0].actions[0].roomId = "missing"; }, /action\.roomId/],
  ["wrong action kind", (_, m) => { m.tracks[0].actions[0].type = "event-start"; }, /action\.type/],
  ["numeric string", (_, m) => { (m.tracks[0].actions[0] as { x: unknown }).x = "10"; }, /action\.x/],
  ["bad state", (_, m) => { (m.tracks[0].actions[0] as { state: string }).state = "unknown"; }, /action\.state/],
  ["bad text", (_, m) => { (m.tracks[0].actions[0] as { text: unknown }).text = {}; }, /action\.text/],
  ["long text", (_, m) => { m.tracks[0].actions[0].text = "x".repeat(4001); }, /action\.text/],
];
for (const [name, mutate, pattern] of G2) test(`validator rejects ${name}`, () => {
  const project = richSample();
  mutate(project, project.maps[0]);
  assert.throws(() => validateProject(JSON.parse(JSON.stringify(project))), pattern);
});

test("validator accepts text of exactly 4000 chars and a human count of 1", () => {
  const project = richSample(), map = project.maps[0];
  map.tracks[0].actions[0].text = "x".repeat(4000);
  map.tracks[4].count = 1;
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(project))));
});

test("door mode and door-specific unlock references validate", () => {
  const project = sample(), map = project.maps[0];
  map.rooms.push({ id: "other-room", name: "Other", color: "#123456", kind: "room", material: "tile", cells: [2] });
  map.floorPlan!.walls = [{ id: "wall", roomId: "room-a", x1: 0, y1: 40, x2: 40, y2: 40 }];
  map.floorPlan!.doors.push({ id: "wall-door", roomId: "room-a", wallId: "wall", name: "Lobby entrance", kind: "automatic", x1: 10, y1: 40, x2: 30, y2: 40 });
  map.tracks[2].actions[2].doorId = "wall-door";
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(project))));
  const unlock = (m: SceneMap) => m.tracks[2].actions[2];
  const cases: [(m: SceneMap) => void, RegExp][] = [
    [(m) => { (m as { doorMode: string }).doorMode = "loose"; }, /doorMode/],
    [(m) => { unlock(m).roomId = "other-room"; }, /doorId/],
    [(m) => { unlock(m).doorId = "missing"; }, /doorId/],
    [(m) => { unlock(m).type = "wait"; }, /doorId is only allowed on unlock/],
  ];
  for (const [mutate, pattern] of cases) {
    const trial = structuredClone(project);
    mutate(trial.maps[0]);
    assert.throws(() => validateProject(trial), pattern);
  }
});

test("all new kinds and actions validate; defaults are unique, chain locally, and never mutate input", () => {
  const makeId = seqIds();
  const project = createProject("p", makeId), map = project.maps[0];
  map.rooms.push({ id: "room-a", name: "会議室", color: "#73bafa", kind: "room", material: "wood", cells: [0, 1, 55, 56] });
  const pairs: Record<TrackKind, [ActionType, ActionType]> = {
    robot: ["move", "move"], human: ["move", "move"], room: ["event-start", "event-end"], display: ["show", "hide"],
  };
  for (const kind of Object.keys(KINDS) as TrackKind[]) {
    const before = structuredClone(map);
    const owner = newTrack(map, kind, makeId);
    assert.deepEqual(map, before);
    map.tracks.push(owner);
    const snapshot = structuredClone(map);
    const first = newAction(map, owner, pairs[kind][0], makeId);
    assert.deepEqual(map, snapshot);
    first.position = 2;
    owner.actions.push(first);
    const second = newAction(map, owner, pairs[kind][1], makeId);
    owner.actions.push(second);
    assert.notEqual(first.id, second.id);
    assert.equal(second.position, first.position + first.runSeconds);
    if (kind === "room" || kind === "display") assert.equal(second.targetId, first.targetId);
    else assert.notEqual(second.targetId, first.targetId);
  }
  assert.equal(validateProject(project), project);
  const secondRobot = newTrack(map, "robot", makeId);
  assert.notEqual(secondRobot.name, map.tracks[0].name);
  assert.notEqual(secondRobot.id, map.tracks[0].id);
  assert.equal(newAction(map, secondRobot, "move", makeId).position, 0);
  assert.equal(newAction(map, secondRobot, "show", makeId).type, "show");
  assert.throws(() => newTrack(map, "manual" as TrackKind, makeId), /kind/);
  assert.throws(() => newAction(map, secondRobot, "unsupported" as ActionType, makeId), /not allowed/);
  assert.throws(() => newAction(map, secondRobot, "event-start", makeId), /not allowed/);
  map.rooms = [];
  map.tracks = [];
  const room = newTrack(map, "room", makeId);
  assert.equal(room.roomId, "");
  map.tracks.push(room);
  room.actions.push(newAction(map, room, "event-start", makeId));
  assert.doesNotThrow(() => validateProject(project));
});

test("event-end defaults match last known local target and selected room, including other room tracks", () => {
  const makeId = seqIds();
  const project = createProject("p", makeId), map = project.maps[0];
  map.rooms.push(
    { id: "room-a", name: "A", color: "#73bafa", kind: "room", material: "wood", cells: [0, 1] },
    { id: "room-b", name: "B", color: "#73bafa", kind: "room", material: "wood", cells: [2, 3] },
  );
  const add = (owner: ReturnType<typeof newTrack>, type: ActionType) => {
    const action = newAction(map, owner, type, makeId);
    owner.actions.push(action);
    return action;
  };
  const owner = newTrack(map, "room", makeId);
  map.tracks.push(owner);
  add(owner, "event-start");
  const latest = add(owner, "event-start");
  const end = newAction(map, owner, "event-end", makeId);
  assert.equal(end.targetId, latest.targetId);
  assert.equal(end.roomId, "room-a");
  const other = newTrack(map, "room", makeId);
  map.tracks.push(other);
  const otherEnd = add(other, "event-end");
  assert.equal(otherEnd.targetId, latest.targetId);
  assert.equal(otherEnd.roomId, other.roomId);
  const elsewhere = newTrack(map, "room", makeId);
  elsewhere.roomId = "room-b";
  map.tracks.push(elsewhere);
  const elsewhereEnd = add(elsewhere, "event-end");
  assert.notEqual(elsewhereEnd.targetId, latest.targetId);
  assert.equal(elsewhereEnd.roomId, "room-b");
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(project))));
});

test("robot role accepts all three types, preserves old missing values and rejects unknown roles", () => {
  const project = sample(), robot = project.maps[0].tracks[0];
  assert.equal(robot.robotRole, undefined);
  assert.doesNotThrow(() => validateProject(project));
  assert.equal(Object.hasOwn(projectForSave(project).maps[0].tracks[0], "robotRole"), false);
  for (const role of ["cleaning", "security", "delivery"] as const) {
    robot.robotRole = role;
    assert.doesNotThrow(() => validateProject(project));
    const saved = validateProject(JSON.parse(JSON.stringify(projectForSave(project))));
    assert.equal(saved.maps[0].tracks[0].robotRole, role);
  }
  (robot as { robotRole: string }).robotRole = "other";
  assert.throws(() => validateProject(project), /robotRole/);
});

test("display templates and event hatch options persist and reject unknown values", () => {
  const project = sample(), map = project.maps[0];
  Object.assign(map.tracks[1].actions[0], { displayTemplate: "card", text: "<b>案内</b>" });
  Object.assign(map.tracks[2].actions[0], { hatchStyle: "cross", hatchColor: "#12abcd", text: "会議中" });
  const saved = JSON.parse(JSON.stringify(project));
  assert.deepEqual(validateProject(saved), project);
  const cases: [(m: SceneMap) => void, RegExp][] = [
    [(m) => { m.tracks[2].actions[0].hatchColor = "red"; }, /hatchColor/],
    [(m) => { (m.tracks[2].actions[0] as { hatchStyle: string }).hatchStyle = "script"; }, /hatchStyle/],
    [(m) => { (m.tracks[1].actions[0] as { displayTemplate: string }).displayTemplate = "script"; }, /displayTemplate/],
  ];
  for (const [mutate, pattern] of cases) {
    const trial = structuredClone(project);
    mutate(trial.maps[0]);
    assert.throws(() => validateProject(trial), pattern);
  }
});
