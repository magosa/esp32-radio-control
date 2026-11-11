import test from "node:test";
import assert from "node:assert/strict";
import { cellIndex } from "../../scene/grid";
import {
  actionFields, applyUnlockTarget, availableTypes, endTargets, openActionDraft, setMotion, unlockTargets, validateAction,
  type FieldSpec,
} from "../../scene/actionEdit";
import { actionPreview } from "../../scene/timedPlan";
import type { Action, ActionType, Room, SceneMap, Track, TrackKind } from "../../scene/types";

const ids = (prefix = "id") => {
  let next = 0;
  return () => `${prefix}-${++next}`;
};
// Rows count from the bottom.
const rect = (x: number, y: number, width: number, height: number) =>
  Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, col) => cellIndex(x + col, y + row))).flat();
const room = (id: string, cells: number[]): Room => ({ id, name: `部屋 ${id}`, cells, kind: "room", color: "#739a81", material: "concrete" });
const act = (id: string, over: Partial<Action> = {}): Action => ({
  id, name: id, type: "move", position: 0, runSeconds: 2, x: 300, y: 300, yaw: 0, roomId: "floor",
  targetId: `target-${id}`, text: "", state: "meeting", ...over,
});
const track = (id: string, kind: TrackKind, actions: Action[] = [], over: Partial<Track> = {}): Track => ({
  id, kind, name: `行 ${id}`, color: "#8d9bff", muted: false, locked: false, actions,
  ...(kind === "robot" || kind === "human" ? { initial: { x: 300, y: 300, yaw: 0, roomId: "floor" } } : {}),
  ...(kind === "room" ? { roomId: "floor" } : {}),
  ...over,
});
// The floor is x 40..640, y 40..600.
const scene = (tracks: Track[], over: Partial<SceneMap> = {}): SceneMap => ({
  id: "map", name: "Plan", editGridMm: 20, doorMode: "story", rooms: [room("floor", rect(2, 2, 30, 27))], tracks, ...over,
});
// Runs the call and proves the input was left untouched; returns the call's result.
const pure = <T>(map: SceneMap, call: () => T): T => {
  const before = structuredClone(map);
  try {
    return call();
  } finally {
    assert.deepEqual(map, before);
  }
};
const keys = (fields: FieldSpec[]) => fields.map((field) => field.key);
const fieldOf = (fields: FieldSpec[], key: string) => fields.find((field) => field.key === key)!;
const near = (actual: number | undefined, expected: number) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`);

test("availableTypes lists the four row kinds", () => {
  assert.deepEqual(availableTypes(track("r", "robot")), ["move", "show", "hide", "wait"]);
  assert.deepEqual(availableTypes(track("h", "human")), ["move", "show", "hide", "wait"]);
  assert.deepEqual(availableTypes(track("m", "room")), ["event-start", "event-end", "unlock", "wait"]);
  assert.deepEqual(availableTypes(track("d", "display")), ["show", "hide", "wait"]);
});

test("availableTypes returns a copy that cannot corrupt the table", () => {
  availableTypes(track("r", "robot")).push("unlock");
  assert.deepEqual(availableTypes(track("r", "robot")), ["move", "show", "hide", "wait"]);
});

test("openActionDraft rejects types the row kind cannot hold", () => {
  const map = scene([track("r", "robot"), track("m", "room"), track("d", "display")]);
  const refused: [string, ActionType][] = [["r", "unlock"], ["r", "event-start"], ["m", "move"], ["m", "show"], ["d", "move"], ["d", "unlock"]];
  for (const [id, type] of refused) pure(map, () => assert.throws(() => openActionDraft(map, id, null, type), /配置できません/));
});

test("openActionDraft picks the first allowed type by default", () => {
  const map = scene([track("r", "robot"), track("m", "room"), track("d", "display")]);
  assert.equal(openActionDraft(map, "r", null).action.type, "move");
  assert.equal(openActionDraft(map, "m", null).action.type, "event-start");
  assert.equal(openActionDraft(map, "d", null).action.type, "show");
});

test("a new action starts where the latest action of the row ends", () => {
  const map = scene([track("r", "robot", [act("b", { position: 2, runSeconds: 3 }), act("a", { position: 0, runSeconds: 2 })])]);
  const { action } = pure(map, () => openActionDraft(map, "r", null, "wait", undefined, ids("n")));
  assert.equal(action.position, 5);
  assert.equal(action.type, "wait");
  assert.equal(action.id, "n-1");
  assert.equal(pure(scene([track("r", "robot")]), () => openActionDraft(scene([track("r", "robot")]), "r", null, "wait").action.position), 0);
});

test("overrides.position wins, including 0", () => {
  const map = scene([track("r", "robot", [act("a", { position: 0, runSeconds: 2 })])]);
  assert.equal(openActionDraft(map, "r", null, "move", { position: 7 }).action.position, 7);
  assert.equal(openActionDraft(map, "r", null, "move", { position: 0 }).action.position, 0);
  const { action } = openActionDraft(map, "r", null, "move", { x: 500, name: "go" });
  assert.equal(action.x, 500);
  assert.equal(action.name, "go");
});

test("needsInitialPose is true only for an actor row, only before its first action", () => {
  const first = act("first", { position: 5, runSeconds: 2 });
  const map = scene([
    track("empty", "robot"), track("human", "human"), track("busy", "robot", [first]),
    track("room", "room"), track("screen", "display"),
  ]);
  assert.equal(openActionDraft(map, "empty", null, "move").needsInitialPose, true);
  assert.equal(openActionDraft(map, "human", null, "move").needsInitialPose, true);
  assert.equal(openActionDraft(map, "busy", null, "move", { position: 0 }).needsInitialPose, true);
  assert.equal(openActionDraft(map, "busy", null, "move", { position: 4.9 }).needsInitialPose, true);
  assert.equal(openActionDraft(map, "busy", null, "move", { position: 5 }).needsInitialPose, false);
  assert.equal(openActionDraft(map, "busy", null, "move", { position: 10 }).needsInitialPose, false);
  assert.equal(openActionDraft(map, "busy", null, "move").needsInitialPose, false);
  assert.equal(openActionDraft(map, "room", null, "event-start").needsInitialPose, false);
  assert.equal(openActionDraft(map, "screen", null, "show").needsInitialPose, false);
});

test("needsInitialPose compares with the earliest action even when the row is stored out of order", () => {
  const map = scene([track("r", "robot", [act("late", { position: 10 }), act("early", { position: 5 })])]);
  assert.equal(openActionDraft(map, "r", null, "move", { position: 7 }).needsInitialPose, false);
  assert.equal(openActionDraft(map, "r", null, "move", { position: 3 }).needsInitialPose, true);
});

test("editing an existing action never asks for an initial pose", () => {
  const map = scene([track("busy", "robot", [act("first", { position: 5 })])]);
  const draft = openActionDraft(map, "busy", "first");
  assert.equal(draft.needsInitialPose, false);
  assert.equal(draft.action.id, "first");
});

test("editing an existing action returns a detached copy with overrides applied", () => {
  const map = scene([track("r", "robot", [act("a", { name: "orig" })])]);
  const draft = pure(map, () => openActionDraft(map, "r", "a", undefined, { name: "changed", runSeconds: 9 }));
  assert.equal(draft.action.name, "changed");
  assert.equal(draft.action.runSeconds, 9);
  assert.equal(draft.action.x, 300);
  draft.action.x = 1;
  assert.equal(map.tracks[0].actions[0].x, 300);
  assert.equal(map.tracks[0].actions[0].name, "orig");
});

test("openActionDraft rejects locked rows and unknown rows or actions", () => {
  const map = scene([track("locked", "robot", [act("a")], { locked: true }), track("r", "robot", [act("b")])]);
  pure(map, () => assert.throws(() => openActionDraft(map, "locked", null, "move"), /ロック/));
  pure(map, () => assert.throws(() => openActionDraft(map, "locked", "a"), /ロック/));
  pure(map, () => assert.throws(() => openActionDraft(map, "nope", null, "move"), /見つかりません/));
  pure(map, () => assert.throws(() => openActionDraft(map, "r", "missing"), /見つかりません/));
  pure(map, () => assert.throws(() => openActionDraft(map, "r", "a"), /見つかりません/));
});

test("a new rotation defaults to the turn at 90 deg/s (180 deg is 2 s)", () => {
  const map = scene([track("r", "robot")]);
  const turn = (yaw: number, over: Partial<Action> = {}) =>
    pure(map, () => openActionDraft(map, "r", null, "move", { motion: "rotate", yaw, ...over }).action);
  for (const [yaw, seconds] of [[180, 2], [90, 1], [-90, 1], [0, 0.1], [5, 0.1]] as const) {
    const action = turn(yaw);
    near(action.rotationSeconds, seconds);
    near(action.runSeconds, seconds);
  }
  near(turn(45).rotationSeconds, 0.5);
});

test("rotation seconds use the shortest turn from the pose before the action", () => {
  const map = scene([track("r", "robot", [act("m", { motion: "rotate", rotationSeconds: 2, yaw: 90, position: 0, runSeconds: 2 })])]);
  near(openActionDraft(map, "r", null, "move", { motion: "rotate", yaw: -90 }).action.rotationSeconds, 2);
  near(openActionDraft(map, "r", null, "move", { motion: "rotate", yaw: 135 }).action.rotationSeconds, 0.5);
  const wrap = scene([track("w", "robot", [], { initial: { x: 300, y: 300, yaw: -170, roomId: "floor" } })]);
  near(openActionDraft(wrap, "w", null, "move", { motion: "rotate", yaw: 170 }).action.rotationSeconds, 20 / 90);
});

test("explicit rotation seconds are kept; an explicit runSeconds fixes the rotation seconds", () => {
  const map = scene([track("r", "robot")]);
  const kept = openActionDraft(map, "r", null, "move", { motion: "rotate", yaw: 180, rotationSeconds: 5 }).action;
  assert.equal(kept.rotationSeconds, 5);
  const run = openActionDraft(map, "r", null, "move", { motion: "rotate", yaw: 180, runSeconds: 4 }).action;
  assert.equal(run.rotationSeconds, 4);
  assert.equal(run.runSeconds, 4);
  const linear = openActionDraft(map, "r", null, "move", { yaw: 180 }).action;
  assert.equal(linear.rotationSeconds, undefined);
  assert.equal(linear.runSeconds, 6);
});

test("setMotion switches to a rotation that lasts runSeconds, and back", () => {
  const original = act("a", { runSeconds: 3, yaw: 90, facingFor: "x" });
  const before = structuredClone(original);
  const turned = setMotion(original, "rotate");
  assert.deepEqual(original, before);
  assert.equal(turned.motion, "rotate");
  assert.equal(turned.rotationSeconds, 3);
  assert.equal(turned.runSeconds, 3);
  assert.equal(turned.yaw, 90);
  const back = setMotion(turned, "linear");
  assert.equal("motion" in back, false);
  assert.equal("rotationSeconds" in back, false);
  assert.equal("facingFor" in back, false);
  assert.equal(back.runSeconds, 3);
  assert.equal(back.yaw, 90);
  assert.deepEqual(setMotion(act("b"), "linear"), act("b"));
});

test("setMotion keeps yaw in (-180, 180] and rotation at least 0.1 s", () => {
  assert.equal(setMotion(act("a", { yaw: 190 }), "rotate").yaw, -170);
  assert.equal(setMotion(act("a", { yaw: -180 }), "rotate").yaw, 180);
  assert.equal(setMotion(act("a", { yaw: 180 }), "rotate").yaw, 180);
  assert.equal(setMotion(act("a", { yaw: -45 }), "rotate").yaw, -45);
  const slow = setMotion(act("a", { runSeconds: 0 }), "rotate");
  assert.equal(slow.runSeconds, 0.1);
  assert.equal(slow.rotationSeconds, 0.1);
});

test("setMotion refuses anything but a move", () => {
  assert.throws(() => setMotion(act("a", { type: "wait" }), "rotate"), /移動/);
});

test("actionFields: every row has a 120 character name first", () => {
  const types: [ActionType, TrackKind][] = [["move", "robot"], ["wait", "robot"], ["show", "display"], ["event-start", "room"], ["unlock", "room"]];
  for (const [type, kind] of types) {
    const [name] = actionFields(act("a", { type }), kind);
    assert.equal(name.key, "name");
    assert.equal(name.kind, "text");
    assert.equal(name.maxLength, 120);
  }
});

test("actionFields: move, rotation and wait", () => {
  const linear = actionFields(act("a"), "robot");
  assert.deepEqual(keys(linear), ["name", "runSeconds"]);
  assert.deepEqual([fieldOf(linear, "runSeconds").min, fieldOf(linear, "runSeconds").max, fieldOf(linear, "runSeconds").step], [0.1, 86400, "any"]);
  assert.equal(fieldOf(linear, "runSeconds").kind, "number");

  const rotating = actionFields(act("a", { motion: "rotate", rotationSeconds: 1 }), "robot");
  assert.deepEqual(keys(rotating), ["name", "yaw", "runSeconds"]);
  assert.deepEqual([fieldOf(rotating, "yaw").min, fieldOf(rotating, "yaw").max, fieldOf(rotating, "yaw").kind], [-180, 180, "number"]);
  assert.equal(fieldOf(rotating, "runSeconds").min, 0.1);
  assert.equal(fieldOf(rotating, "runSeconds").max, 86400);
  assert.notEqual(fieldOf(rotating, "runSeconds").label, fieldOf(linear, "runSeconds").label);

  const wait = actionFields(act("a", { type: "wait" }), "human");
  assert.deepEqual(keys(wait), ["name", "runSeconds"]);
  assert.equal(fieldOf(wait, "runSeconds").min, 0.1);
  assert.equal(fieldOf(wait, "runSeconds").max, 86400);
  assert.notEqual(fieldOf(wait, "runSeconds").label, fieldOf(linear, "runSeconds").label);
});

test("actionFields: show and hide", () => {
  const show = actionFields(act("a", { type: "show" }), "display");
  assert.deepEqual(keys(show), ["name", "runSeconds", "displayTemplate", "text"]);
  assert.equal(fieldOf(show, "runSeconds").min, 0);
  assert.equal(fieldOf(show, "runSeconds").max, 86400);
  assert.equal(fieldOf(show, "displayTemplate").kind, "select");
  assert.deepEqual(fieldOf(show, "displayTemplate").options!.map((o) => o.value), ["label", "card", "sign"]);
  assert.ok(fieldOf(show, "displayTemplate").options!.every((o) => o.label.length > 0));
  assert.equal(fieldOf(show, "text").kind, "textarea");
  assert.equal(fieldOf(show, "text").maxLength, 500);

  const hide = actionFields(act("a", { type: "hide" }), "robot");
  assert.deepEqual(keys(hide), ["name", "runSeconds", "targetId"]);
  assert.equal(fieldOf(hide, "runSeconds").min, 0);
  assert.equal(fieldOf(hide, "targetId").kind, "select");
  assert.equal(fieldOf(hide, "targetId").optionsFrom, "endTargets");
});

test("actionFields: room events and unlock", () => {
  const start = actionFields(act("a", { type: "event-start" }), "room");
  assert.deepEqual(keys(start), ["name", "runSeconds", "state", "hatchColor", "hatchStyle", "text"]);
  assert.equal(fieldOf(start, "runSeconds").min, 0);
  assert.deepEqual(fieldOf(start, "state").options!.map((o) => o.value), ["meeting", "outage", "fire"]);
  assert.equal(fieldOf(start, "hatchColor").kind, "color");
  assert.deepEqual(fieldOf(start, "hatchStyle").options!.map((o) => o.value), ["diagonal", "cross", "dots"]);
  assert.equal(fieldOf(start, "text").maxLength, 500);

  const end = actionFields(act("a", { type: "event-end" }), "room");
  assert.deepEqual(keys(end), ["name", "runSeconds", "targetId"]);
  assert.equal(fieldOf(end, "runSeconds").min, 0);
  assert.equal(fieldOf(end, "targetId").optionsFrom, "endTargets");

  const unlock = actionFields(act("a", { type: "unlock" }), "room");
  assert.deepEqual(keys(unlock), ["name", "runSeconds", "unlockTarget"]);
  assert.equal(fieldOf(unlock, "runSeconds").min, 0.1);
  assert.equal(fieldOf(unlock, "unlockTarget").kind, "select");
  assert.equal(fieldOf(unlock, "unlockTarget").optionsFrom, "unlockTargets");
});

test("actionFields refuses a type the row kind cannot hold", () => {
  assert.throws(() => actionFields(act("a", { type: "move" }), "room"), /置けません/);
  assert.throws(() => actionFields(act("a", { type: "unlock" }), "robot"), /置けません/);
});

const flowMap = () => scene([
  track("r", "robot", [act("s1", { type: "show", name: "案内", targetId: "t-show-1" })]),
  track("d", "display", [act("s2", { type: "show", name: "掲示", targetId: "t-show-2" }), act("h", { type: "hide", position: 5, targetId: "t-show-2" })]),
  track("m", "room", [
    act("e1", { type: "event-start", name: "停電", targetId: "t-event-1", roomId: "floor", state: "outage" }),
    act("e2", { type: "event-end", position: 9, targetId: "t-event-1" }),
  ]),
]);

test("endTargets lists the shows for hide and the event starts for event-end", () => {
  const map = flowMap();
  const hide = pure(map, () => endTargets(map, "hide"));
  assert.deepEqual(hide, [
    { value: "t-show-1", label: "行 r / 案内" },
    { value: "t-show-2", label: "行 d / 掲示" },
  ]);
  assert.deepEqual(endTargets(map, "event-end"), [{ value: "t-event-1", label: "行 m / 停電", roomId: "floor" }]);
  assert.deepEqual(endTargets(map, "move"), []);
  assert.deepEqual(endTargets(map, "wait"), []);
});

test("endTargets lists each row in start-time order", () => {
  const map = scene([track("r", "robot", [act("b", { type: "show", position: 5, name: "B" }), act("a", { type: "show", name: "A" })])]);
  assert.deepEqual(endTargets(map, "hide").map((target) => target.label), ["行 r / A", "行 r / B"]);
});

test("endTargets takes the event room from the row when the action has none", () => {
  const map = scene([track("m", "room", [act("e1", { type: "event-start", roomId: "" })], { roomId: "floor" })]);
  assert.equal(endTargets(map, "event-end")[0].roomId, "floor");
});

const doorMap = () => scene([], {
  rooms: [room("floor", rect(2, 2, 30, 27)), room("lab", rect(40, 2, 10, 10))],
  floorPlan: {
    furniture: [],
    doors: [
      { id: "d1", roomId: "floor", cell: cellIndex(10, 2), edge: "bottom", name: "正面扉", openingId: "o1" },
      { id: "d2", roomId: "floor", cell: cellIndex(11, 2), edge: "bottom", name: "正面扉", openingId: "o1" },
      { id: "d3", roomId: "floor", cell: cellIndex(20, 2), edge: "bottom" },
      { id: "d4", roomId: "lab", cell: cellIndex(41, 2), edge: "bottom", name: "裏口", kind: "flapper" },
    ],
  },
});

test("unlockTargets lists rooms and named equipment once per opening", () => {
  const map = doorMap();
  assert.deepEqual(pure(map, () => unlockTargets(map)), [
    { value: "floor", label: "部屋 floor" },
    { value: "lab", label: "部屋 lab" },
    { value: "door:d1", label: "設備：正面扉" },
    { value: "door:d4", label: "設備：裏口" },
  ]);
  assert.deepEqual(unlockTargets(scene([])), [{ value: "floor", label: "部屋 floor" }]);
});

test("applyUnlockTarget selects equipment: doorId, roomId and name follow", () => {
  const map = doorMap();
  const action = act("u", { type: "unlock", roomId: "floor", name: "x" });
  const next = pure(map, () => applyUnlockTarget(action, "door:d4", map));
  assert.equal(next.doorId, "d4");
  assert.equal(next.roomId, "lab");
  assert.equal(next.name, "裏口解錠");
  assert.equal(action.name, "x");
  assert.equal("doorId" in action, false);
});

test("applyUnlockTarget back to a room removes doorId", () => {
  const map = doorMap();
  const onDoor = applyUnlockTarget(act("u", { type: "unlock" }), "door:d4", map);
  const next = applyUnlockTarget(onDoor, "floor", map);
  assert.equal("doorId" in next, false);
  assert.equal(next.roomId, "floor");
  assert.equal(next.name, "部屋 floor解錠");
  assert.equal(onDoor.doorId, "d4");
});

test("applyUnlockTarget rejects unknown equipment, rooms and non-unlock actions", () => {
  const map = doorMap();
  const action = act("u", { type: "unlock" });
  assert.throws(() => applyUnlockTarget(action, "door:nope", map), /設備/);
  assert.throws(() => applyUnlockTarget(action, "nope", map), /部屋/);
  assert.throws(() => applyUnlockTarget(action, "", map), /部屋/);
  assert.throws(() => applyUnlockTarget(act("m"), "floor", map), /解錠/);
  assert.throws(() => applyUnlockTarget(action, "door:d1", scene([])), /設備/);
});

test("applyUnlockTarget keeps the action name within 120 characters", () => {
  const map = doorMap();
  map.floorPlan!.doors[3].name = "あ".repeat(120);
  assert.equal(applyUnlockTarget(act("u", { type: "unlock" }), "door:d4", map).name.length, 120);
  map.floorPlan!.doors[3].name = "";
  assert.equal(applyUnlockTarget(act("u", { type: "unlock" }), "door:d4", map).name, "設備解錠");
});

const robotMap = () => scene([track("r", "robot", [act("a", { position: 0, runSeconds: 2 })])]);
const check = (map: SceneMap, trackId: string, action: Action) => pure(map, () => validateAction(map, trackId, action));
const errorOf = (map: SceneMap, trackId: string, action: Action): string => {
  const result = check(map, trackId, action);
  assert.equal(result.ok, false);
  return result.ok ? "" : result.error;
};

test("validateAction accepts a valid action and does not modify its input", () => {
  const map = robotMap();
  const action = act("b", { position: 2, x: 500 });
  const before = structuredClone(action);
  assert.deepEqual(validateAction(map, "r", action), { ok: true });
  assert.deepEqual(action, before);
  assert.deepEqual(map, robotMap());
});

test("validateAction rejects overlapping bars but allows touching ones and its own old place", () => {
  const map = robotMap();
  assert.match(errorOf(map, "r", act("b", { position: 1 })), /重なっています/);
  assert.match(errorOf(map, "r", act("b", { position: 1.9 })), /重なっています/);
  assert.deepEqual(check(map, "r", act("b", { position: 2 })), { ok: true });
  assert.deepEqual(check(map, "r", act("a", { runSeconds: 3 })), { ok: true });
  const two = scene([track("r", "robot", [act("a", { runSeconds: 2 }), act("b", { position: 2, runSeconds: 2 })])]);
  assert.match(errorOf(two, "r", act("a", { runSeconds: 3 })), /重なっています/);
  assert.deepEqual(check(two, "r", act("a", { runSeconds: 2 })), { ok: true });
});

test("validateAction enforces second ranges per type", () => {
  const map = scene([track("r", "robot"), track("d", "display"), track("m", "room")]);
  const bad = (id: string, over: Partial<Action>) => errorOf(map, id, act("x", over));
  assert.match(bad("r", { runSeconds: 0 }), /秒/);
  assert.match(bad("r", { runSeconds: 0.05 }), /秒/);
  assert.deepEqual(check(map, "r", act("x", { runSeconds: 0.1 })), { ok: true });
  assert.match(bad("r", { type: "wait", runSeconds: 0 }), /秒/);
  assert.deepEqual(check(map, "r", act("x", { type: "wait", runSeconds: 0.1 })), { ok: true });
  assert.match(bad("m", { type: "unlock", runSeconds: 0.05 }), /秒/);
  assert.deepEqual(check(map, "d", act("x", { type: "show", runSeconds: 0 })), { ok: true });
  assert.match(bad("d", { type: "show", runSeconds: -1 }), /秒/);
  assert.deepEqual(check(map, "r", act("x", { type: "show", runSeconds: 86400 })), { ok: true });
  assert.match(bad("r", { type: "show", runSeconds: 86400.1 }), /秒/);
  assert.match(bad("r", { runSeconds: Number.NaN }), /秒/);
  assert.match(bad("r", { runSeconds: Number.POSITIVE_INFINITY }), /秒/);
});

test("validateAction enforces start time, name, text, position and angle ranges", () => {
  const map = scene([track("r", "robot"), track("d", "display")]);
  const bad = (id: string, over: Partial<Action>) => errorOf(map, id, act("x", over));
  assert.match(bad("r", { position: -0.1 }), /開始/);
  assert.match(bad("r", { position: 86401 }), /開始/);
  assert.match(bad("r", { position: Number.NaN }), /開始/);
  assert.match(bad("r", { name: "a".repeat(121) }), /名前/);
  assert.deepEqual(check(map, "r", act("x", { name: "a".repeat(120) })), { ok: true });
  assert.match(bad("d", { type: "show", text: "a".repeat(501) }), /言葉/);
  assert.deepEqual(check(map, "d", act("x", { type: "show", text: "a".repeat(500) })), { ok: true });
  assert.match(bad("r", { x: -1 }), /X座標/);
  assert.match(bad("r", { x: 1100.5 }), /X座標/);
  assert.match(bad("r", { y: -1 }), /Y座標/);
  assert.match(bad("r", { y: 620.5 }), /Y座標/);
  assert.match(bad("r", { yaw: 181 }), /角度/);
  assert.match(bad("r", { yaw: -180 }), /角度/);
  assert.match(bad("r", { yaw: Number.NaN }), /角度/);
  assert.deepEqual(check(map, "r", act("x", { yaw: 180 })), { ok: true });
  assert.deepEqual(check(map, "d", act("x", { type: "show", x: 0, y: 0 })), { ok: true });
  assert.deepEqual(check(map, "d", act("x", { type: "show", x: 1100, y: 620 })), { ok: true });
});

test("validateAction rejects an unknown room, display template, state, hatch and motion", () => {
  const map = scene([track("d", "display"), track("m", "room"), track("r", "robot")]);
  assert.match(errorOf(map, "d", act("x", { type: "show", roomId: "nope" })), /部屋/);
  assert.match(errorOf(map, "d", act("x", { type: "show", displayTemplate: "bogus" as never })), /テンプレート/);
  assert.deepEqual(check(map, "d", act("x", { type: "show", displayTemplate: "card" })), { ok: true });
  assert.match(errorOf(map, "m", act("x", { type: "event-start", state: "bogus" as never })), /イベント/);
  assert.match(errorOf(map, "m", act("x", { type: "event-start", hatchStyle: "bogus" as never })), /模様/);
  assert.match(errorOf(map, "m", act("x", { type: "event-start", hatchColor: "red" })), /色/);
  assert.match(errorOf(map, "m", act("x", { type: "event-start", hatchColor: "#fff" })), /色/);
  assert.match(errorOf(map, "m", act("x", { type: "event-start", hatchColor: "#1234567" })), /色/);
  assert.match(errorOf(map, "r", act("x", { targetId: "" })), /識別子/);
  assert.deepEqual(check(map, "r", act("x", { type: "wait", text: "a".repeat(600) })), { ok: true });
  assert.match(errorOf(map, "r", act("x", { type: "wait", text: "a".repeat(4001) })), /言葉/);
  assert.deepEqual(check(map, "m", act("x", { type: "event-start", hatchColor: "#FFaa00", hatchStyle: "dots", state: "fire" })), { ok: true });
  assert.match(errorOf(map, "r", act("x", { type: "wait", motion: "rotate" })), /回転/);
  assert.match(errorOf(map, "r", act("x", { rotationSeconds: 1 })), /回転/);
  assert.deepEqual(check(map, "r", act("x", { motion: "rotate", rotationSeconds: 1, runSeconds: 1 })), { ok: true });
  assert.match(errorOf(map, "r", act("x", { motion: "rotate", rotationSeconds: 0, runSeconds: 1 })), /回転/);
});

test("validateAction requires an existing target for hide and event-end", () => {
  const map = flowMap();
  const hide = (targetId: string) => act("x", { type: "hide", position: 20, runSeconds: 0.5, targetId });
  assert.match(errorOf(map, "d", hide("")), /終了する項目/);
  assert.match(errorOf(map, "d", hide("t-gone")), /終了する項目/);
  assert.match(errorOf(map, "d", hide("t-event-1")), /終了する項目/);
  assert.deepEqual(check(map, "d", hide("t-show-1")), { ok: true });
  const end = (targetId: string) => act("x", { type: "event-end", position: 20, runSeconds: 0.5, targetId });
  assert.match(errorOf(map, "m", end("")), /終了する項目/);
  assert.match(errorOf(map, "m", end("t-show-1")), /終了する項目/);
  assert.deepEqual(check(map, "m", end("t-event-1")), { ok: true });
});

test("validateAction requires an unlock target that resolves, and a door of that room", () => {
  const map = doorMap();
  map.tracks.push(track("m", "room"));
  const unlock = (over: Partial<Action>) => act("x", { type: "unlock", runSeconds: 1, ...over });
  assert.match(errorOf(map, "m", unlock({ roomId: "" })), /解錠/);
  assert.match(errorOf(map, "m", unlock({ roomId: "nope" })), /部屋/);
  assert.deepEqual(check(map, "m", unlock({ roomId: "floor" })), { ok: true });
  assert.deepEqual(check(map, "m", unlock({ roomId: "floor", doorId: "d1" })), { ok: true });
  assert.match(errorOf(map, "m", unlock({ roomId: "floor", doorId: "d4" })), /設備/);
  assert.match(errorOf(map, "m", unlock({ roomId: "floor", doorId: "nope" })), /設備/);
  assert.match(errorOf(map, "m", act("x", { type: "event-start", doorId: "d1" })), /設備/);
});

test("validateAction rejects a destination in a wall, with the reason actionPreview reports", () => {
  const map = robotMap();
  const outside = act("b", { position: 2, x: 900, y: 300 });
  const reason = pure(map, () => actionPreview(map, "r", outside).geometryProblem);
  assert.ok(reason.length > 0);
  assert.ok(errorOf(map, "r", outside).includes(reason));
  assert.deepEqual(check(map, "r", act("b", { position: 2, x: 500, y: 300 })), { ok: true });
  assert.deepEqual(check(map, "r", act("b", { position: 2, motion: "rotate", yaw: 90, x: 300, y: 300 })), { ok: true });
});

test("validateAction does not path-check non-moves or rows without a body", () => {
  const map = scene([track("r", "robot"), track("d", "display")]);
  assert.deepEqual(check(map, "r", act("x", { type: "show", x: 900, y: 300 })), { ok: true });
  assert.deepEqual(check(map, "d", act("x", { type: "show", x: 900, y: 300 })), { ok: true });
});

test("validateAction rejects locked rows, unknown rows and types the row cannot hold", () => {
  const map = scene([track("locked", "robot", [], { locked: true }), track("r", "robot")]);
  assert.match(errorOf(map, "locked", act("x")), /ロック/);
  assert.match(errorOf(map, "nope", act("x")), /見つかりません/);
  assert.match(errorOf(map, "r", act("x", { type: "unlock" })), /配置できません/);
});
