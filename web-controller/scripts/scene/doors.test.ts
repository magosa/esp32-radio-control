import test from "node:test";
import assert from "node:assert/strict";
import {
  automaticDoorOpenness, DOOR_TRANSITION_SECONDS, prepareDoorPlan, sampleDoorPlan,
  type DoorPlanEntry, type DoorPlanInput,
} from "../../scene/doors";
import { cellIndex } from "../../scene/grid";
import { positionAt, type Point } from "../../scene/safety";
import type { DoorMode, Room, SceneMap, Track } from "../../scene/types";

const horizontal = { x1: 340, y1: 310, x2: 560, y2: 310 };
const vertical = { x1: 450, y1: 200, x2: 450, y2: 420 };
const RADIUS = { robot: 60, human: 14 };

test("door transition is 0.6 seconds", () => {
  assert.equal(DOOR_TRANSITION_SECONDS, 0.6);
});

test("automatic doors detect robots and humans from both sides in world coordinates", () => {
  for (const kind of ["human", "robot"]) {
    for (const sign of [-1, 1]) {
      assert.equal(automaticDoorOpenness(horizontal, [{ kind, x: 450, y: 310 + sign * 69 }]), 1);
      assert.equal(automaticDoorOpenness(vertical, [{ kind, x: 450 + sign * 69, y: 310 }]), 1);
      assert.equal(automaticDoorOpenness(horizontal, [{ kind, x: 450, y: 310 + sign * 346 }]), 0);
    }
  }
});

test("door sensor uses footprint clearance, opens progressively and stays open during passage", () => {
  for (const kind of ["robot", "human"] as const) {
    const size = RADIUS[kind];
    const actor = (distance: number) => [{ kind, x: 450, y: 310 + distance }];
    assert.equal(automaticDoorOpenness(horizontal, actor(size + 138)), 0);
    assert.ok(Math.abs(automaticDoorOpenness(horizontal, actor(size + 103.5)) - 0.5) < 1e-10);
    assert.ok(Math.abs(automaticDoorOpenness(horizontal, actor(size + 69)) - 1) < 1e-10);
    assert.equal(automaticDoorOpenness(horizontal, actor(0)), 1);
  }
});

test("empty, removed and distant actors close the door; the nearest actor holds it open", () => {
  assert.equal(automaticDoorOpenness(horizontal, []), 0);
  assert.equal(automaticDoorOpenness(horizontal, [{ kind: "display", x: 450, y: 310 }]), 0);
  assert.equal(automaticDoorOpenness(horizontal, [
    { kind: "robot", x: 35, y: 35 }, { kind: "human", x: 450, y: 310 },
  ]), 1);
  assert.equal(automaticDoorOpenness(horizontal, [{ kind: "human", x: 69, y: 310 }]), 0);
});

const region = (id: string, cells: number[]): Room => ({
  id, name: id, cells, kind: "room", color: "#123456", material: "tile",
});
const rect = (x: number, y: number, width: number, height: number) =>
  Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, col) => cellIndex(x + col, y + row))).flat();
const track = (id: string, kind: Track["kind"], extra: Partial<Track> = {}): Track => ({
  id, kind, name: id, color: "#000000", muted: false, locked: false, actions: [], ...extra,
});
const at = (x: number, y = 300): Point => ({ x, y });

function move(owner: Track, id: string, position: number, start: number, end: number, from: Point, to: Point,
  rotate = false): DoorPlanEntry {
  return {
    track: owner, start, end, to, segments: [{ from, to, start, end }], blocked: false, outcome: "success",
    action: { id, name: id, type: "move", position, roomId: "", ...(rotate ? { motion: "rotate" as const } : {}) },
  };
}
function unlockEntry(owner: Track, start: number, end: number, roomId = "right", doorId?: string): DoorPlanEntry {
  return {
    track: owner, start, end, segments: [], blocked: false, outcome: "success",
    action: { id: `unlock-${start}`, name: "unlock", type: "unlock", position: start, roomId, doorId },
  };
}

// Left/right rooms split at x=540; a 10-cell door on the right room's left edge spans y=200..400.
function fixture(unlockEnd: number | null, kind: "human" | "robot" = "human", doorMode: DoorMode = "strict") {
  const actor = track("actor", kind, { initial: { x: 90, y: 300, yaw: 0, roomId: "left" } });
  const doors = track("doors", "room", { roomId: "right" });
  const map: SceneMap = {
    id: "map", name: "Plan", editGridMm: 20, doorMode, tracks: [actor, doors],
    rooms: [region("left", rect(0, 0, 27, 31)), region("right", rect(27, 0, 28, 31))],
    floorPlan: { furniture: [], walls: [], doors: Array.from({ length: 10 }, (_, i) => ({
      id: `door-${i}`, roomId: "right", cell: cellIndex(27, 10 + i), edge: "left" as const,
    })) },
  };
  const walk = move(actor, "walk", 0, 0, 10, at(90), at(990));
  const unlock = unlockEntry(doors, 0, unlockEnd ?? 0);
  const plan: DoorPlanInput = { map, entries: unlockEnd === null ? [walk] : [walk, unlock], errors: [], warnings: [] };
  return { map, actor, doors, walk, unlock, plan };
}
const sampleAt = (plan: DoorPlanInput, time: number) => sampleDoorPlan(plan, time)[0];
const actorX = (plan: DoorPlanInput, time: number) => positionAt(plan.doorPaths![0].segments, time).x;

test("unlock bars have exact duration and use only their owning room", () => {
  let { plan, walk, unlock } = fixture(8);
  plan.log = [{ entry: walk }, { entry: unlock }];
  prepareDoorPlan(plan);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.duration, 10);
  assert.equal(sampleAt(plan, 7.999).unlocked, true);
  assert.equal(sampleAt(plan, 8).unlocked, false);
  assert.equal(sampleAt(plan, 8).held, false);
  ({ plan, walk, unlock } = fixture(8));
  unlock.action.roomId = "left";
  plan.log = [{ entry: walk }, { entry: unlock }];
  prepareDoorPlan(plan);
  assert.match(plan.errors.join(" "), /施錠/);
  assert.equal(plan.entries[0].blocked, true);
  assert.equal(plan.entries[0].start, null);
  assert.deepEqual(plan.log.map((item) => item.entry), [unlock]);
  assert.equal(plan.duration, 8);
  assert.equal(actorX(plan, 10), 90);
});

test("expiry during passage holds safely until clear and is deterministic when seeking", () => {
  const { plan } = fixture(5);
  prepareDoorPlan(plan);
  assert.deepEqual(plan.errors, []);
  assert.equal(sampleAt(plan, 5).unlocked, false);
  assert.equal(sampleAt(plan, 5).held, true);
  assert.equal(sampleAt(plan, 5).openness, 1);
  assert.equal(sampleAt(plan, 6).held, false);
  assert.equal(sampleAt(plan, 5).held, true);
  assert.equal(sampleAt(plan, 0).unlocked, true);
});

test("unlocked doors advertise only actors whose current path crosses that doorway", () => {
  let { plan, actor } = fixture(10);
  prepareDoorPlan(plan);
  assert.deepEqual(sampleAt(plan, 3).actorIds, [actor.id]);
  assert.deepEqual(sampleAt(plan, 10).actorIds, []);
  ({ plan, actor } = fixture(10));
  actor.initial = { x: 420, y: 230, yaw: 90, roomId: "left" };
  plan.entries[0] = move(actor, "walk", 0, 0, 10, at(420, 230), at(420, 430));
  prepareDoorPlan(plan);
  assert.deepEqual(plan.errors, []);
  assert.equal(sampleAt(plan, 3).unlocked, true);
  assert.deepEqual(sampleAt(plan, 3).actorIds, []);
  assert.deepEqual(sampleDoorPlan(plan, 3), sampleDoorPlan(plan, 3));
  assert.equal(sampleAt(plan, 3).openness, 0);
});

function robotTurnFixture() {
  const { plan, actor, unlock } = fixture(9, "robot");
  actor.initial!.x = 225;
  unlock.start = 7; unlock.end = 16; unlock.action.position = 7;
  plan.entries = [
    move(actor, "approach", 8, 8, 11, at(225), at(454)),
    move(actor, "turn", 11, 11, 12, at(454), at(454), true),
    move(actor, "cross", 12, 12, 14.5, at(454), at(626)),
    unlock,
  ];
  return plan;
}

test("short robot passages open during the preceding turn and close gradually after arrival", () => {
  const plan = robotTurnFixture();
  prepareDoorPlan(plan);
  assert.deepEqual(plan.errors, []);
  const open = (time: number) => sampleAt(plan, time).openness;
  assert.equal(open(11.39), 0);
  assert.ok(open(11.55) > 0 && open(11.55) < open(11.7));
  assert.ok(open(11.7) < open(11.85) && open(11.85) < 1);
  assert.equal(open(12), 1);
  assert.equal(open(14.5), 1);
  assert.ok(open(14.65) > open(14.8) && open(14.8) > open(14.95));
  assert.equal(open(15.11), 0);
  for (let t = 10; t <= 16; t += 0.01) {
    assert.ok(Math.abs(open(t) - open(t - 0.01)) < 0.025, `開度が急変: ${t}`);
  }
  for (const t of [14.8, 11.7, 12, 14.8]) {
    const fresh = robotTurnFixture();
    prepareDoorPlan(fresh);
    assert.deepEqual(sampleDoorPlan(plan, t), sampleDoorPlan(fresh, t));
  }
});

test("meeting room doors remain continuous at arrival, waiting and departure boundaries", () => {
  const { plan, actor, unlock } = fixture(12);
  actor.initial!.x = 384;
  plan.entries = [
    move(actor, "enter", 0, 0, 3, at(384), at(625)),
    move(actor, "leave", 5, 5, 8, at(625), at(384)),
    unlock,
  ];
  prepareDoorPlan(plan);
  assert.deepEqual(plan.errors, []);
  const open = (time: number) => sampleAt(plan, time).openness;
  assert.equal(open(0), 0);
  assert.ok(open(3) > 0.9);
  assert.ok(open(3.2) > 0 && open(3.2) < open(3));
  assert.equal(open(4), 0);
  assert.ok(open(4.6) > 0 && open(4.6) < open(4.8));
  assert.ok(open(5) > 0.9);
  for (let t = 0.01; t <= 10; t += 0.01) {
    assert.ok(Math.abs(open(t) - open(t - 0.01)) < 0.025, `開度が急変: ${t}`);
  }
});

test("story-only mode warns for locked passages without stopping motion or opening doors", () => {
  const { plan } = fixture(0, "human", "story");
  prepareDoorPlan(plan);
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.warnings.some((w) => w.code === "door-preview" && w.message.includes("実機通行の許可ではありません")));
  assert.equal(actorX(plan, 10), 990);
  assert.equal(sampleAt(plan, 10).unlocked, false);
  assert.equal(sampleAt(plan, 5).openness, 0);
  const strict = fixture(0).plan;
  prepareDoorPlan(strict);
  assert.ok(strict.errors.some((e) => e.includes("施錠")));
});

test("story mode keeps robot timing through locked doors; strict blocks the passage and what follows", () => {
  for (const withUnlock of [false, true]) {
    const story = fixture(withUnlock ? 1 : null, "robot", "story");
    if (withUnlock) { story.unlock.start = 7; story.unlock.end = 8; }
    const next: DoorPlanEntry = {
      track: story.actor, start: 10, end: 12, segments: [], blocked: false, outcome: "success",
      action: { id: "next", name: "next", type: "wait", position: 10, roomId: "" },
    };
    story.plan.entries.push(next);
    const strictPlan = structuredClone(story.plan);
    prepareDoorPlan(story.plan);
    assert.deepEqual(story.plan.errors, []);
    assert.ok(story.plan.warnings.some((w) => w.code === "door-preview"));
    assert.equal(story.walk.start, 0);
    assert.equal(story.walk.end, 10);
    assert.equal(next.start, 10);
    for (const time of [5, 10, 5]) {
      assert.equal(actorX(story.plan, time), 90 + 90 * time);
      assert.equal(sampleAt(story.plan, time).unlocked, false);
    }
    strictPlan.map.doorMode = "strict";
    prepareDoorPlan(strictPlan);
    assert.ok(strictPlan.entries.find((e) => e.action.id === "walk")!.blocked);
    assert.ok(strictPlan.entries.find((e) => e.action.id === "next")!.blocked);
  }
});

test("named independent gates unlock individually, not every gate owned by the corridor", () => {
  const { plan, map, actor, doors, unlock } = fixture(10);
  map.rooms = [region("left", rect(0, 0, 55, 31))];
  actor.initial!.roomId = "left";
  doors.roomId = "left";
  unlock.action.roomId = "left";
  map.floorPlan = { furniture: [], walls: [
    { id: "partition", roomId: "left", x1: 540, y1: 0, x2: 540, y2: 620 },
  ], doors: [
    { id: "entrance", name: "入口", kind: "automatic", roomId: "left", wallId: "partition", x1: 540, y1: 200, x2: 540, y2: 400 },
    { id: "other-gate", name: "別ゲート", kind: "flapper", roomId: "left", wallId: "partition", x1: 540, y1: 20, x2: 540, y2: 160 },
  ] };
  unlock.action.doorId = "entrance";
  const other = structuredClone(plan);
  prepareDoorPlan(plan);
  assert.deepEqual(plan.errors, []);
  const state = sampleDoorPlan(plan, 3);
  assert.equal(state.find((door) => door.id === "entrance")!.unlocked, true);
  assert.equal(state.find((door) => door.id === "other-gate")!.unlocked, false);
  other.entries[1].action.doorId = "other-gate";
  prepareDoorPlan(other);
  assert.ok(other.errors.some((error) => error.includes("施錠")));
});

test("unlock must be active before the leading footprint reaches the doorway", () => {
  const { plan, unlock, walk } = fixture(14.99);
  unlock.start = 4.99;
  prepareDoorPlan(plan);
  assert.equal(walk.blocked, true);
  assert.match(plan.errors.join(" "), /施錠/);
});

test("blocked and unsuccessful unlock entries never permit a passage", () => {
  for (const change of [(e: DoorPlanEntry) => { e.blocked = true; }, (e: DoorPlanEntry) => { e.outcome = null; }]) {
    const { plan, walk, unlock } = fixture(10);
    change(unlock);
    prepareDoorPlan(plan);
    assert.equal(walk.blocked, true);
    assert.equal(sampleAt(plan, 5).unlocked, false);
  }
});

test("maps without doors produce an empty door plan", () => {
  const { plan, map } = fixture(10);
  map.floorPlan!.doors = [];
  prepareDoorPlan(plan);
  assert.deepEqual(plan.doorPlan, []);
  assert.deepEqual(sampleDoorPlan(plan, 3), []);
});

test.todo("unlock bars have exact duration — actionStates.simulatedPosition needs Task 9 compilePlan");
test.todo("short robot passages — move entry scheduled at 12..14.5 needs Task 9 compilePlan");
test.todo("story default does not allow robots to cross walls outside a doorway — needs Task 9 compilePlan");
test.todo("muted, failed and invalid unlock controls never permit a passage — needs Task 9 compilePlan");
