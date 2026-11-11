import test from "node:test";
import assert from "node:assert/strict";
import { cellIndex } from "../../scene/grid";
import { createProject, newAction, newTrack, projectForSave, validateProject } from "../../scene/model";
import { actionPreview, addFacingTurns, compilePlan, samplePlan } from "../../scene/timedPlan";
import type { Action, ActionType, Room, SceneMap, Track, TrackKind } from "../../scene/types";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const ALL = Array.from({ length: 1705 }, (_, i) => i);
const rect = (col: number, row: number, width: number, height: number) =>
  Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => cellIndex(col + c, row + r))).flat();
const region = (id: string, cells: number[], kind: Room["kind"] = "room"): Room =>
  ({ id, name: id, cells, kind, material: "wood", color: "#123456" });

function fixture(rooms: Room[] = [region("room", ALL)]) {
  let n = 0;
  const makeId = () => `id-${++n}`;
  const project = createProject("p", makeId), map = project.maps[0];
  Object.assign(map, { doorMode: "strict", rooms, floorPlan: { doors: [], furniture: [] } });
  const track = (kind: TrackKind, initial: { x: number; y: number; yaw?: number; roomId?: string } = { x: 90, y: 90 }) => {
    const t = newTrack(map, kind, makeId);
    if (t.initial) Object.assign(t.initial, { yaw: 0, roomId: rooms[0].id }, initial);
    if (kind === "room") t.roomId = rooms[0].id;
    map.tracks.push(t);
    return t;
  };
  const action = (owner: Track, type: ActionType, props: Partial<Action> = {}) => {
    const a = Object.assign(newAction(map, owner, type, makeId), props);
    owner.actions.push(a);
    return a;
  };
  return { project, map, makeId, track, action };
}

test("fixed timeline uses exact bar start/end and keeps mm segments as the planned trajectory", () => {
  const { project, map, track, action } = fixture(), t = track("robot");
  const move = action(t, "move", { position: 2, runSeconds: 4, x: 230, y: 90 });
  const turn = action(t, "move", { position: 8, runSeconds: 2, motion: "rotate", yaw: 90 });
  validateProject(project);
  const plan = compilePlan(map), state = samplePlan(plan, 4);
  close(state.actors[0].x, 160);
  close(state.actionStates[move.id].start!, 2); close(state.actionStates[move.id].end!, 6);
  close(state.actionStates[turn.id].start!, 8); close(state.actionStates[turn.id].end!, 10);
  close(samplePlan(plan, 9).actors[0].yaw, 45);
  close(samplePlan(plan, 9).actors[0].x, 230);
  assert.equal(samplePlan(plan, 10).actionStates[move.id].result.status, "success");
  assert.deepEqual(plan.entries.find((e) => e.action.id === move.id)!.segments,
    [{ start: 2, end: 6, from: { x: 90, y: 90 }, to: { x: 230, y: 90 } }]);
  assert.deepEqual(plan.errors, []);
  close(plan.duration, 10);
});

test("untrusted initial keys cannot override actor identity in samplePlan", () => {
  const { map, track } = fixture(), robot = track("robot");
  robot.robotId = "robot-a";
  Object.assign(robot.initial!, { id: "other", kind: "human", robotId: "r9", name: "spoof", count: 99 });
  const [actor] = samplePlan(compilePlan(map), 0).actors;
  assert.equal(actor.id, robot.id);
  assert.equal(actor.kind, "robot");
  assert.equal(actor.robotId, "robot-a");
  assert.equal(actor.name, robot.name);
  assert.equal(actor.count, 1);
  assert.deepEqual([actor.x, actor.y, actor.yaw, actor.roomId], [90, 90, 0, "room"]);
});

test("same-row overlap is an error and does not slip the bar or block other rows", () => {
  const { map, track, action } = fixture(), t = track("display"), other = track("display");
  action(t, "wait", { position: 2, runSeconds: 5 });
  const b = action(t, "wait", { position: 4, runSeconds: 2 });
  const after = action(t, "wait", { position: 10, runSeconds: 1 });
  const independent = action(other, "wait", { position: 3, runSeconds: 1 });
  let plan = compilePlan(map), state = samplePlan(plan, 20);
  assert.match(state.actionStates[b.id].reason, /重な/);
  assert.equal(state.actionStates[b.id].start, null);
  assert.ok(plan.errors.some((e) => /重な/.test(e)));
  assert.equal(state.actionStates[after.id].status, "blocked");
  assert.match(state.actionStates[after.id].reason, /成功/);
  close(state.actionStates[independent.id].start!, 3); close(state.actionStates[independent.id].end!, 4);
  b.position = 7;
  plan = compilePlan(map);
  assert.deepEqual(plan.errors, []);
  close(samplePlan(plan, 0).actionStates[b.id].start!, 7);
});

test("zero-length bars are rejected except hide and event-end; negative starts are rejected", () => {
  const cases: [TrackKind, ActionType, Partial<Action>][] = [
    ["robot", "move", { x: 230, y: 90 }], ["robot", "move", { motion: "rotate", yaw: 90 }], ["robot", "wait", {}],
    ["display", "show", {}], ["room", "event-start", {}], ["room", "unlock", {}],
  ];
  for (const [kind, type, props] of cases) {
    const { map, track, action } = fixture(), t = track(kind);
    const bar = action(t, type, { position: 1, runSeconds: 0, ...props, roomId: "room" });
    const plan = compilePlan(map);
    assert.ok(plan.errors.some((e) => /長さ0/.test(e)), `${type} ${props.motion ?? ""}`);
    assert.equal(samplePlan(plan, 5).actionStates[bar.id].status, "blocked");
  }
  const { map, track, action } = fixture(), display = track("display"), room = track("room");
  const show = action(display, "show", { position: 0, runSeconds: 5, text: "hi" });
  const hide = action(track("display"), "hide", { position: 3, runSeconds: 0, targetId: show.targetId });
  const start = action(room, "event-start", { position: 0, runSeconds: 5 });
  action(track("room"), "event-end", { position: 2, runSeconds: 0, targetId: start.targetId });
  let plan = compilePlan(map);
  assert.deepEqual(plan.errors, []);
  assert.equal(samplePlan(plan, 2.999).displays.length, 1);
  assert.equal(samplePlan(plan, 3).displays.length, 0);
  assert.equal(samplePlan(plan, 3).actionStates[hide.id].status, "complete");
  assert.equal(samplePlan(plan, 1.999).events.length, 1);
  assert.equal(samplePlan(plan, 2).events.length, 0);
  const late = action(display, "wait", { position: -1, runSeconds: 1 });
  plan = compilePlan(map);
  assert.ok(plan.errors.some((e) => /開始時刻/.test(e)));
  assert.equal(samplePlan(plan, 0).actionStates[late.id].status, "blocked");
});

test("display and room events end exactly at the right edge of their bars", () => {
  const { map, track, action } = fixture(), t = track("display"), room = track("room");
  action(t, "show", { position: 2, runSeconds: 3, text: "hello" });
  action(room, "event-start", { position: 1, runSeconds: 5, roomId: "room" });
  const plan = compilePlan(map);
  assert.equal(samplePlan(plan, 1.999).displays.length, 0);
  assert.equal(samplePlan(plan, 4.999).displays.length, 1);
  assert.equal(samplePlan(plan, 5).displays.length, 0);
  assert.equal(samplePlan(plan, 5.999).events.length, 1);
  assert.equal(samplePlan(plan, 6).events.length, 0);
});

test("display targets update in place, hide removes only its target, and templates reach the state", () => {
  const { project, map, track, action } = fixture();
  const one = track("display"), two = track("display"), three = track("display");
  const first = action(one, "show", { position: 2, runSeconds: 1, text: "FIRST", displayTemplate: "card" });
  const update = action(one, "show", { position: 3, runSeconds: 3, text: "UPDATED", targetId: first.targetId });
  const other = action(two, "show", { position: 3, runSeconds: 5, text: "OTHER" });
  action(three, "hide", { position: 5, runSeconds: 0, targetId: first.targetId });
  validateProject(project);
  const plan = compilePlan(map);
  assert.equal(samplePlan(plan, 1.99).displays.length, 0);
  assert.equal(samplePlan(plan, 2).displays[0].text, "FIRST");
  assert.equal(samplePlan(plan, 2).displays[0].displayTemplate, "card");
  assert.equal(samplePlan(plan, 2).displays[0].actionId, first.id);
  assert.deepEqual(samplePlan(plan, 3).displays.map((d) => d.actionId), [update.id, other.id]);
  assert.deepEqual(samplePlan(plan, 5).displays.map((d) => d.text), ["OTHER"]);
  assert.deepEqual(samplePlan(plan, 6).displays.map((d) => d.text), ["OTHER"]);
});

test("actor-attached displays identify their owner by track ID", () => {
  const { map, track, action } = fixture(), robot = track("robot"), human = track("human", { x: 410, y: 90 });
  action(robot, "move", { position: 0, runSeconds: 2, x: 230, y: 90 });
  action(robot, "show", { position: 2, runSeconds: 2, text: "robot" });
  action(human, "show", { position: 1, runSeconds: 2, text: "human" });
  const plan = compilePlan(map);
  assert.deepEqual(samplePlan(plan, 2).displays.map((d) => d.actorId), [human.id, robot.id]);
  close(samplePlan(plan, 2).actors[0].x, 230);
  assert.equal(samplePlan(plan, 4).displays.length, 0);
});

test("room events update stable targets and unrelated ends do not clear other states", () => {
  const { project, map, track, action } = fixture(), one = track("room"), two = track("room"), three = track("room");
  const meeting = action(one, "event-start", { position: 0, runSeconds: 1, text: "MEETING", hatchStyle: "cross", hatchColor: "#12abcd" });
  const fire = action(one, "event-start", { position: 1, runSeconds: 3, state: "fire", targetId: meeting.targetId });
  const outage = action(two, "event-start", { position: 1, runSeconds: 4, state: "outage" });
  action(three, "event-end", { position: 2, runSeconds: 0, targetId: meeting.targetId });
  validateProject(project);
  const plan = compilePlan(map);
  const first = samplePlan(plan, 0).events[0];
  assert.equal(first.roomId, "room");
  assert.equal(first.actionId, meeting.id);
  assert.equal(first.hatchStyle, "cross");
  assert.equal(first.hatchColor, "#12abcd");
  assert.deepEqual(samplePlan(plan, 1).events.map((e) => e.actionId), [fire.id, outage.id]);
  assert.deepEqual(samplePlan(plan, 2).events.map((e) => e.state), ["outage"]);
});

test("same-timestamp effects have deterministic track/action order (later track wins)", () => {
  const { map, track, action } = fixture();
  const owner = track("display");
  const show = action(owner, "show", { position: 0, runSeconds: 3, text: "FIRST" });
  const hide = action(owner, "hide", { position: 3, runSeconds: 0, targetId: show.targetId });
  owner.actions.reverse();
  let plan = compilePlan(map);
  assert.deepEqual(plan.errors, []);
  assert.equal(samplePlan(plan, 3).displays.length, 0);
  assert.equal(samplePlan(plan, 3).actionStates[hide.id].status, "complete");

  const next = track("display");
  action(next, "show", { position: 0, runSeconds: 3, targetId: show.targetId, text: "LAST" });
  plan = compilePlan(map);
  assert.deepEqual(samplePlan(plan, 0).displays.map((d) => d.text), ["LAST"]);
  assert.deepEqual(compilePlan(map), plan);
  map.tracks.reverse();
  assert.deepEqual(samplePlan(compilePlan(map), 0).displays.map((d) => d.text), ["FIRST"]);

  const swap = fixture(), a = swap.track("display"), b = swap.track("display");
  const shown = swap.action(a, "show", { position: 2, runSeconds: 3, text: "SHOWN" });
  swap.action(b, "hide", { position: 2, runSeconds: 0, targetId: shown.targetId });
  assert.equal(samplePlan(compilePlan(swap.map), 2).displays.length, 0);
  swap.map.tracks.reverse();
  assert.deepEqual(samplePlan(compilePlan(swap.map), 2).displays.map((d) => d.text), ["SHOWN"]);
});

function twoRooms() {
  return fixture([region("room", rect(0, 0, 27, 31)), region("hall", rect(27, 0, 28, 31))]);
}

test("events aggregate stationary actors inside the room; moving or outside actors wait for arrival; end releases", () => {
  const { map, track, action } = twoRooms();
  const inside = track("human", { x: 210, y: 310 });
  const mover = track("robot", { x: 90, y: 110 });
  action(mover, "move", { position: 0, runSeconds: 4, x: 390, y: 110 });
  const outside = track("human", { x: 810, y: 310, roomId: "room" });
  const room = track("room");
  action(room, "event-start", { position: 1, runSeconds: 5 });
  const plan = compilePlan(map);
  assert.deepEqual(samplePlan(plan, 0.5).actors.map((a) => a.aggregated), [false, false, false]);
  assert.deepEqual(samplePlan(plan, 1).actors.map((a) => a.aggregated), [true, false, false]);
  assert.equal(samplePlan(plan, 2).actors[1].moving, true);
  assert.deepEqual(samplePlan(plan, 4).actors.map((a) => a.aggregated), [true, true, false]);
  assert.deepEqual(samplePlan(plan, 6).actors.map((a) => a.aggregated), [false, false, false]);
  assert.equal(outside.initial!.roomId, "room");
  assert.equal(inside.initial!.roomId, "room");
});

test("rotation is motion for room aggregation until the turn has finished", () => {
  const { map, track, action } = fixture(), t = track("robot", { x: 210, y: 310 });
  action(t, "move", { position: 0, runSeconds: 4, motion: "rotate", yaw: 90 });
  action(track("room"), "event-start", { position: 1, runSeconds: 5 });
  const plan = compilePlan(map);
  const during = samplePlan(plan, 2).actors[0];
  assert.equal(during.moving, true);
  assert.equal(during.aggregated, false);
  assert.equal(samplePlan(plan, 4).actors[0].aggregated, true);
  assert.equal(samplePlan(plan, 4).actors[0].moving, false);
});

test("179 to -179 explicit rotation takes the shortest 2 degree arc over the bar length and keeps the room", () => {
  const { map, track, action } = twoRooms(), t = track("robot", { x: 210, y: 310, yaw: 179 });
  action(t, "move", { position: 0, runSeconds: 2, motion: "rotate", yaw: -179, x: 990, y: 590, roomId: "hall" });
  const plan = compilePlan(map);
  close(samplePlan(plan, 0.5).actors[0].yaw, 179.5);
  close(samplePlan(plan, 1).actors[0].yaw, 180);
  close(samplePlan(plan, 2).actors[0].yaw, -179);
  const end = samplePlan(plan, 2).actors[0];
  close(end.x, 210); close(end.y, 310);
  assert.equal(end.roomId, "room");
  assert.equal(plan.entries[0].roomId, "room");
});

test("consecutive moves form straight segments, keep yaw and the initial pose persists without actions", () => {
  const { map, track, action } = fixture(), t = track("robot", { x: 110, y: 110, yaw: 45 });
  action(t, "move", { position: 1, runSeconds: 1, x: 210, y: 110 });
  action(t, "move", { position: 2, runSeconds: 1, x: 210, y: 210 });
  const plan = compilePlan(map), at = (time: number) => samplePlan(plan, time).actors[0];
  close(at(0).x, 110); close(at(0).yaw, 45);
  close(at(1.5).x, 160); close(at(1.5).y, 110);
  close(at(2.5).x, 210); close(at(2.5).y, 160); close(at(2.5).yaw, 45);
});

test("invalid initial poses block the row explicitly; muted rows report no errors", () => {
  const { project, map, track, action } = fixture(), t = track("robot", { x: 30, y: 90 });
  const wait = action(t, "wait", { position: 0, runSeconds: 3 });
  validateProject(project);
  const state = samplePlan(compilePlan(map), 20);
  assert.ok(state.errors.some((e) => e.includes("初期位置") && e.includes("MAP外")));
  assert.equal(state.actionStates[wait.id].result.status, "blocked");
  assert.match(state.actionStates[wait.id].reason, /初期位置/);
  t.muted = true;
  const muted = samplePlan(compilePlan(map), 20);
  assert.equal(muted.errors.length, 0);
  assert.equal(muted.actors.length, 0);
  assert.equal(muted.actionStates[wait.id].status, "blocked");
});

test("geometry failures stop at the start pose and block what follows on the row", () => {
  const { map, track, action } = twoRooms();
  map.rooms = [map.rooms[0]];
  const t = track("robot", { x: 210, y: 310 });
  const move = action(t, "move", { position: 0, runSeconds: 2, x: 810, y: 310 });
  const next = action(t, "wait", { position: 2, runSeconds: 1 });
  const plan = compilePlan(map), state = samplePlan(plan, 10);
  assert.ok(plan.errors.some((e) => e.includes(move.name)));
  assert.equal(plan.entries[0].geometryFailure, true);
  assert.equal(state.actionStates[move.id].status, "failed");
  assert.equal(state.actionStates[move.id].result.status, "failed");
  close(state.actionStates[move.id].result.simulatedPosition!.x, 210);
  assert.equal(state.actionStates[move.id].result.measuredPosition, null);
  assert.equal(state.actionStates[next.id].status, "blocked");
  assert.match(state.actionStates[next.id].reason, /成功/);
  close(state.actors[0].x, 210);
});

test("compilePlan is deterministic and sampling does not depend on call order or mutate the map", () => {
  const { map, track, action } = fixture(), t = track("robot");
  action(t, "move", { position: 1, runSeconds: 4, x: 410, y: 90 });
  action(t, "move", { position: 6, runSeconds: 1, motion: "rotate", yaw: -90 });
  action(track("display"), "show", { position: 2, runSeconds: 2, text: "x" });
  const before = JSON.stringify(map);
  assert.deepEqual(compilePlan(map), compilePlan(map));
  const plan = compilePlan(map), times = [0, 0.5, 2, 3.3, 5, 6.5, 10, 50];
  const ascending = times.map((time) => samplePlan(plan, time));
  const descending = [...times].reverse().map((time) => samplePlan(plan, time)).reverse();
  assert.deepEqual(descending, ascending);
  assert.equal(JSON.stringify(map), before);
  assert.throws(() => samplePlan(plan, -1), /再生時刻/);
  assert.throws(() => samplePlan(plan, NaN), /再生時刻/);
});

test("collision warnings are reported for crossing robots", () => {
  const { map, track, action } = fixture();
  const a = track("robot", { x: 110, y: 310 }), b = track("robot", { x: 550, y: 110 });
  action(a, "move", { position: 0, runSeconds: 10, x: 990, y: 310 });
  action(b, "move", { position: 0, runSeconds: 10, x: 550, y: 510 });
  const plan = compilePlan(map);
  assert.ok(plan.warnings.some((w) => w.code === "collision"));
  assert.deepEqual(plan.errors, []);
});

function corridor() {
  const data = fixture([
    region("left", rect(0, 0, 14, 31)), region("hall", rect(14, 10, 27, 10), "corridor"), region("right", rect(41, 0, 14, 31)),
  ]);
  data.map.doorMode = "story";
  for (let row = 10; row < 20; row++) {
    data.map.floorPlan!.doors.push({ id: `l-${row}`, roomId: "left", cell: cellIndex(13, row), edge: "right" });
    data.map.floorPlan!.doors.push({ id: `r-${row}`, roomId: "right", cell: cellIndex(41, row), edge: "left" });
  }
  return data;
}

test("fixed timeline reports narrow corridor conflicts instead of adding invisible waiting time", () => {
  let { map, track, action } = corridor();
  const a = track("robot", { x: 210, y: 310, roomId: "left" }), b = track("robot", { x: 890, y: 310, roomId: "right" });
  action(a, "move", { position: 0, runSeconds: 10, x: 890, y: 310, roomId: "right" });
  action(b, "move", { position: 0, runSeconds: 10, x: 210, y: 310, roomId: "left" });
  const plan = compilePlan(map);
  assert.ok(plan.errors.some((e) => /廊下/.test(e)));
  assert.ok(plan.entries.every((e) => e.end === null || e.end <= e.action.position + e.action.runSeconds));
  ({ map, track, action } = corridor());
  const c = track("robot", { x: 210, y: 310, roomId: "left" }), d = track("robot", { x: 890, y: 310, roomId: "right" });
  action(c, "move", { position: 0, runSeconds: 10, x: 890, y: 310, roomId: "right" });
  action(d, "move", { position: 10, runSeconds: 10, x: 210, y: 310, roomId: "left" });
  assert.deepEqual(compilePlan(map).errors, []);
});

test("twelve-cell corridors are not exclusive and parked robots in narrow corridors block entry", () => {
  const wide = fixture([
    region("left", rect(0, 0, 14, 31)), region("hall", rect(14, 10, 27, 12), "corridor"), region("right", rect(41, 0, 14, 31)),
  ]);
  wide.map.doorMode = "story";
  for (let row = 10; row < 22; row++) {
    wide.map.floorPlan!.doors.push({ id: `l-${row}`, roomId: "left", cell: cellIndex(13, row), edge: "right" });
    wide.map.floorPlan!.doors.push({ id: `r-${row}`, roomId: "right", cell: cellIndex(41, row), edge: "left" });
  }
  wide.track("robot", { x: 550, y: 380, roomId: "hall" });
  const passer = wide.track("robot", { x: 210, y: 264, roomId: "left" });
  const pass = wide.action(passer, "move", { position: 0, runSeconds: 10, x: 890, y: 264, roomId: "right" });
  let plan = compilePlan(wide.map);
  assert.deepEqual(plan.errors, []);
  assert.equal(samplePlan(plan, 20).actionStates[pass.id].result.status, "success");

  let { map, track, action } = corridor();
  track("robot", { x: 550, y: 310, roomId: "hall" });
  const moving = track("robot", { x: 210, y: 310, roomId: "left" });
  const move = action(moving, "move", { position: 0, runSeconds: 10, x: 890, y: 310, roomId: "right" });
  const next = action(moving, "wait", { position: 10, runSeconds: 1 });
  plan = compilePlan(map);
  const state = samplePlan(plan, 20);
  assert.equal(state.actionStates[move.id].result.status, "failed");
  assert.match(state.actionStates[move.id].reason, /退出予定/);
  assert.equal(state.actionStates[next.id].status, "blocked");
  close(state.actors[1].x, 210);
  assert.ok(plan.errors.some((e) => /退出予定/.test(e)));

  ({ map, track, action } = corridor());
  const leaving = track("robot", { x: 550, y: 310, roomId: "hall" });
  action(leaving, "move", { position: 0, runSeconds: 4, x: 890, y: 310, roomId: "right" });
  const later = track("robot", { x: 210, y: 310, roomId: "left" });
  const enter = action(later, "move", { position: 4, runSeconds: 10, x: 750, y: 310, roomId: "hall" });
  plan = compilePlan(map);
  assert.deepEqual(plan.errors, []);
  assert.equal(samplePlan(plan, 20).actionStates[enter.id].result.status, "success");

  ({ map, track, action } = corridor());
  const resident = track("robot", { x: 550, y: 310, roomId: "hall" });
  action(resident, "move", { position: 6, runSeconds: 4, x: 890, y: 310, roomId: "right" });
  const early = track("robot", { x: 210, y: 310, roomId: "left" });
  action(early, "wait", { position: 0, runSeconds: 4 });
  const blocked = action(early, "move", { position: 4, runSeconds: 10, x: 750, y: 310, roomId: "hall" });
  plan = compilePlan(map);
  assert.match(samplePlan(plan, 20).actionStates[blocked.id].reason, /通行時刻が重なっています/);
});

test("room activities list stationary robots in rooms, excluding moving robots and charging zones", () => {
  const { map, track, action } = twoRooms();
  const guard = track("robot", { x: 210, y: 310 });
  guard.robotRole = "security";
  const mover = track("robot", { x: 210, y: 110 });
  action(mover, "move", { position: 0, runSeconds: 4, x: 410, y: 110 });
  const plan = compilePlan(map);
  assert.deepEqual(samplePlan(plan, 1).roomActivities, [{ roomId: "room", text: "監視中", actorIds: [guard.id] }]);
  assert.deepEqual(samplePlan(plan, 5).roomActivities, [{ roomId: "room", text: "監視中 / 掃除中", actorIds: [guard.id, mover.id] }]);
  map.floorPlan!.chargingZones = [{ id: "charger", name: "CHARGING", x: 150, y: 250, width: 120, height: 120 }];
  assert.deepEqual(samplePlan(compilePlan(map), 5).roomActivities[0].actorIds, [mover.id]);
  map.rooms[0].kind = "corridor";
  assert.deepEqual(samplePlan(compilePlan(map), 5).roomActivities, []);
});

test("room activity follows physical robot occupancy and excludes charging and muted robots", () => {
  const { map, track, action } = twoRooms();
  map.doorMode = "story";
  const guard = track("robot", { x: 210, y: 310 });
  guard.robotRole = "security";
  const cleaner = track("robot", { x: 210, y: 110 });
  action(cleaner, "move", { position: 0, runSeconds: 4, x: 810, y: 110, roomId: "hall" });
  map.floorPlan!.doors.push(...Array.from({ length: 10 }, (_, i) => ({
    id: `d-${i}`, roomId: "room", cell: cellIndex(26, i), edge: "right" as const,
  })));
  let plan = compilePlan(map);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(samplePlan(plan, 5).roomActivities, [
    { roomId: "room", text: "監視中", actorIds: [guard.id] },
    { roomId: "hall", text: "掃除中", actorIds: [cleaner.id] },
  ]);
  guard.muted = true;
  assert.deepEqual(samplePlan(compilePlan(map), 5).roomActivities, [{ roomId: "hall", text: "掃除中", actorIds: [cleaner.id] }]);
  cleaner.muted = true;
  assert.deepEqual(samplePlan(compilePlan(map), 5).roomActivities, []);

  map.tracks = (["cleaning", "cleaning", "security", "delivery"] as const).map((role, index) => ({
    ...guard, id: `activity-${index}`, robotId: `robot-${index}`, robotRole: role, muted: false, actions: [],
    initial: { x: 210, y: 310, yaw: 0, roomId: "hall" },
  }));
  plan = compilePlan(map);
  const combined = samplePlan(plan, 0).roomActivities;
  assert.deepEqual(combined, [{
    roomId: "room", text: "掃除中 / 監視中 / 配送中", actorIds: ["activity-0", "activity-1", "activity-2", "activity-3"],
  }]);
  assert.deepEqual(samplePlan(plan, 2).roomActivities, combined);
});

test("transit and turning robots never become room activities while crossing the entrance", () => {
  const { map, track, action } = corridor();
  const robot = track("robot", { x: 210, y: 310, yaw: 90, roomId: "left" });
  action(robot, "move", { position: 1, runSeconds: 1, motion: "rotate", yaw: 0 });
  action(robot, "move", { position: 2, runSeconds: 10, x: 890, y: 310, roomId: "right" });
  action(robot, "move", { position: 12, runSeconds: 1, motion: "rotate", yaw: 90 });
  const plan = compilePlan(map);
  assert.deepEqual(plan.errors, []);
  const trips = plan.entries.filter((e) => !e.blocked && e.action.type === "move");
  assert.equal(trips.length, 3);
  for (const trip of trips) {
    for (const at of [trip.start!, trip.start! + 0.01, (trip.start! + trip.end!) / 2, trip.end! - 0.01]) {
      assert.ok(!samplePlan(plan, at).roomActivities.some((a) => a.actorIds.includes(robot.id)), `${trip.action.name} at ${at}`);
    }
  }
  assert.deepEqual(samplePlan(plan, 0.5).roomActivities, [{ roomId: "left", text: "掃除中", actorIds: [robot.id] }]);
  assert.deepEqual(samplePlan(plan, 13).roomActivities, [{ roomId: "right", text: "掃除中", actorIds: [robot.id] }]);
});

test("action preview checks geometry regardless of muted rows, blocked predecessors and invalid initial poses", () => {
  for (const blockedBy of ["muted", "blocked", "initial"]) {
    const { map, track, action } = fixture(), t = track("robot");
    if (blockedBy === "muted") t.muted = true;
    if (blockedBy === "blocked") action(t, "wait", { position: 0, runSeconds: 0 });
    if (blockedBy === "initial") t.initial!.x = 30;
    const move = action(t, "move", { position: 1, runSeconds: 2, x: 30, y: 90 });
    assert.match(actionPreview(map, t.id, move).geometryProblem, /MAP外/);
    if (blockedBy !== "initial") {
      move.x = 230;
      assert.equal(actionPreview(map, t.id, move).geometryProblem, "");
    }
  }
});

test("action preview resolves the time-ordered start pose without mutating the map", () => {
  const { map, track, action } = fixture(), t = track("robot", { x: 110, y: 210, yaw: 30 });
  action(t, "move", { position: 0, runSeconds: 2, x: 310, y: 210 });
  const second = action(t, "move", { position: 2, runSeconds: 2, x: 310, y: 410 });
  t.actions.reverse();
  const before = structuredClone(map), preview = actionPreview(map, t.id, second);
  close(preview.from!.x, 310); close(preview.from!.y, 210); close(preview.from!.yaw, 30);
  close(preview.start!, 2); close(preview.end!, 4);
  assert.equal(preview.warning, "");
  assert.deepEqual(map, before);
  const edited = { ...second, position: 1 };
  assert.match(actionPreview(map, t.id, edited).warning, /重な/);
  t.muted = true;
  assert.match(actionPreview(map, t.id, second).warning, /プレビュー対象外/);
});

test("facing turns insert shared time, keep translation duration and are idempotent after edits", () => {
  const { project, map, makeId, track, action } = fixture();
  const robot = track("robot"), human = track("human", { x: 430, y: 90 });
  const move = action(robot, "move", { position: 2, runSeconds: 3, x: 90, y: 290 });
  const walk = action(human, "move", { position: 2, runSeconds: 3, x: 430, y: 290 });
  const unlock = action(track("room"), "unlock", { position: 0, runSeconds: 8, roomId: "room" });
  assert.equal(addFacingTurns(map, makeId), 1);
  assert.equal(move.position, 3);
  assert.equal(move.runSeconds, 3);
  assert.equal(walk.position, 3);
  assert.equal(unlock.runSeconds, 9);
  assert.equal(human.actions.some((a) => a.motion === "rotate"), false);
  const turn = robot.actions.find((a) => a.motion === "rotate")!;
  assert.deepEqual([turn.position, turn.runSeconds, turn.yaw, turn.facingFor, turn.x, turn.y], [2, 1, 90, move.id, 90, 90]);
  assert.equal(addFacingTurns(map, makeId), 0);
  const plan = compilePlan(map);
  assert.deepEqual(plan.errors, []);
  close(samplePlan(plan, 2.5).actors[0].yaw, 45);
  close(samplePlan(plan, 4.5).actors[0].y, 190);
  move.x = 290; move.y = 90;
  assert.equal(addFacingTurns(map, makeId), 0);
  assert.equal(turn.yaw, 0);
  validateProject(project);
  const restored = JSON.parse(JSON.stringify(projectForSave(project)));
  assert.equal(addFacingTurns(restored.maps[0], makeId), 0);
});

test("facing turns across ±180 use the shortest arc and round up to 0.1 seconds at 90 degrees per second", () => {
  for (const [from, seconds] of [[179, 0.1], [170, 0.3]] as const) {
    const { map, makeId, track, action } = fixture(), t = track("robot", { x: 590, y: 310, yaw: from });
    const rad = (180 - from) * Math.PI / 180;
    action(t, "move", { position: 2, runSeconds: 4, coordinateMode: "free",
      x: 590 - 400 * Math.cos(rad), y: 310 - 400 * Math.sin(rad) });
    assert.equal(addFacingTurns(map, makeId), 1);
    const turn = t.actions.find((a) => a.motion === "rotate")!;
    assert.equal(turn.runSeconds, seconds);
    close(turn.yaw, -from, 1e-9);
    const plan = compilePlan(map);
    close(samplePlan(plan, 2 + seconds / 2).actors[0].yaw, 180);
    close(samplePlan(plan, 2 + seconds).actors[0].yaw, -from);
  }
});

test("a 2000-action plan compiles within 2s, samples within a frame and matches fresh evaluation", (t) => {
  const { project, map, track, action } = fixture();
  for (let lane = 0; lane < 4; lane++) {
    const robot = track("robot", { x: 110, y: 110 + lane * 120 });
    for (let i = 0; i < 250; i++) action(robot, "move", { position: i, runSeconds: 1, x: i % 2 ? 110 : 990, y: 110 + lane * 120 });
  }
  for (let row = 0; row < 2; row++) {
    const display = track("display");
    for (let i = 0; i < 500; i++) action(display, "wait", { position: i, runSeconds: 1 });
  }
  validateProject(project);
  const before = JSON.stringify(map), begin = performance.now(), plan = compilePlan(map);
  const compileMs = performance.now() - begin;
  assert.deepEqual(plan.errors, []);
  for (const at of [0, 0.5, 120.25, 499.5, 600]) assert.deepEqual(samplePlan(plan, at), samplePlan(compilePlan(map), at));
  for (let i = 0; i < 5; i++) samplePlan(plan, i);
  const started = performance.now();
  for (let i = 0; i < 40; i++) samplePlan(plan, i * 12.5);
  const sampleMs = (performance.now() - started) / 40;
  t.diagnostic(`compile ${compileMs.toFixed(1)}ms, sample mean ${sampleMs.toFixed(2)}ms`);
  assert.ok(compileMs < 2000, `compile ${compileMs.toFixed(2)}ms`);
  assert.ok(sampleMs < 16, `sample ${sampleMs.toFixed(2)}ms`);
  assert.equal(JSON.stringify(map), before);
});
