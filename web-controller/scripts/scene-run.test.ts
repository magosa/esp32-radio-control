import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { WebSocket } from "ws";
import { DEFAULT_FIELD_CONFIG, FieldConfigStore } from "../fleet/fieldConfigStore";
import { FleetHub } from "../fleet/hub";
import { RobotStore } from "../fleet/robotStore";
import type { RunSnapshot } from "../scene/runTypes";
import type { SceneMap } from "../scene/types";
import { decide, type Mover } from "../fleet/trafficManager";
import { SimRobot } from "./simRobot";

function fakeSocket() {
  const messages: Record<string, any>[] = [];
  const handlers = new Map<string, (...args: any[]) => void>();
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0,
    send: (data: string) => messages.push(JSON.parse(data)),
    on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler),
    terminate: () => handlers.get("close")?.(), close: () => handlers.get("close")?.() } as unknown as WebSocket;
  return { socket, messages, receive: (value: unknown) => handlers.get("message")?.(Buffer.from(JSON.stringify(value))) };
}

const cells = (c0: number, r0: number, c1: number, r1: number) => {
  const out: number[] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(r * 55 + c);
  return out;
};
const move = (id: string, position: number, runSeconds: number, x: number, y: number) =>
  ({ id, name: id, type: "move", position, runSeconds, x, y, yaw: 0, roomId: "r1", targetId: `t-${id}`, text: "", state: "meeting" });
const robot = (id: string, robotId: string, y: number, actions: unknown[]) => ({
  id, kind: "robot", name: id, color: "#8d9bff", muted: false, locked: false, robotRole: "cleaning", robotId,
  initial: { x: 110, y, yaw: 0, roomId: "r1" }, actions,
});
const sceneOf = (tracks: unknown[]) => ({
  id: "m1", name: "scene", editGridMm: 20, doorMode: "story", floorPlan: { doors: [], furniture: [], walls: [] }, tracks,
  rooms: [{ id: "r1", name: "room", color: "#8d9bff", kind: "room", material: "concrete", cells: cells(2, 2, 50, 28) }],
}) as unknown as SceneMap;

// Two robots drive 300 mm in 6 s each (50 mm/s).
const easyScene = () => sceneOf([
  robot("A", "robot-d0", 110, [move("a1", 1, 6, 410, 110)]),
  robot("B", "robot-d1", 310, [move("b1", 1, 6, 410, 310)]),
]);

function rig(context: TestContext, map: SceneMap, starts: { x: number; y: number; yaw?: number }[]) {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scene-run-"));
  const hub = new FleetHub(new RobotStore(path.join(directory, "fleet.json")), new FieldConfigStore(path.join(directory, "field.json")),
    (id) => (id === map.id ? map : null));
  context.after(() => { hub.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  let accept: (socket: WebSocket, request: { url: string }) => void = () => {};
  hub.attach({ on: (_e: string, handler: typeof accept) => { accept = handler; } } as never);
  const connect = (url: string) => { const s = fakeSocket(); accept(s.socket, { url }); return s; };

  const sims = starts.map((s) => new SimRobot(s.x, s.y, s.yaw ?? 0));
  const devices = sims.map((_, i) => {
    const d = connect("/ws/device");
    d.receive({ type: "hello", deviceId: `d${i}`, name: `R${i}`, fw: "t", capabilities: ["drive", "display"] });
    return d;
  });
  const operator = connect("/ws/client");
  sims.forEach((_, i) => operator.receive({ type: "assignMarker", requestId: `m${i}`, robotId: `robot-d${i}`, markerId: i }));
  const localizer = connect("/ws/localizer");
  localizer.receive({ type: "localizerHello", camera: "t", width: 1920, height: 1080 });

  const hidden = new Set<number>();
  const seen = devices.map(() => 0);
  let frame = 0, sinceTelemetry = 0, request = 0, minGap = Infinity;
  const { widthMm, heightMm } = DEFAULT_FIELD_CONFIG;
  const step = () => {
    sims.forEach((sim, i) => {
      for (const m of devices[i].messages.slice(seen[i])) if (m.type === "drive") sim.command(m.cmd, m.speedL, m.speedR, Date.now());
      seen[i] = devices[i].messages.length;
    });
    for (let k = 0; k < 5; k++) { context.mock.timers.tick(20); sims.forEach((sim) => sim.step(20, Date.now())); }
    for (let i = 0; i < sims.length; i++) for (let j = i + 1; j < sims.length; j++) minGap = Math.min(minGap, Math.hypot(sims[i].x - sims[j].x, sims[i].y - sims[j].y));
    localizer.receive({ type: "poseFrame", frameId: ++frame, capturedAt: Date.now(), referenceCount: 4, referenceIds: [40, 41, 42, 43], extrinsicsOk: true,
      markers: sims.map((s, i) => hidden.has(i) ? { markerId: i, valid: false }
        : { markerId: i, valid: true, x: s.x / widthMm * 1600, y: s.y / heightMm * 900, yawDeg: s.yaw, insideField: true }) });
    if ((sinceTelemetry += 100) >= 1000) {
      sinceTelemetry = 0;
      devices.forEach((d, i) => d.receive({ type: "telemetry", deviceId: `d${i}`, cmd: "e", speedL: 0, speedR: 0, heap: 1, uptimeMs: 1 }));
    }
  };
  const state = (): RunSnapshot => operator.messages.filter((m) => m.type === "sceneRunState").at(-1)!.state;
  const command = (c: Record<string, unknown>) => { operator.receive({ type: "sceneRunCommand", requestId: `c${++request}`, command: c }); return operator.messages.at(-1)!; };
  // Runs until the condition holds (at most `seconds` of simulated time).
  const until = (done: (s: RunSnapshot) => boolean, seconds = 90) => {
    for (let i = 0; i < seconds * 10 && !done(state()); i++) step();
    return state();
  };
  for (let i = 0; i < 5; i++) step();
  return { sims, hidden, operator, state, command, until, step, devices, minGap: () => minGap };
}

test("a scene runs to the end: positioning first, control handed over, exhibit clock follows", (context) => {
  const r = rig(context, easyScene(), [{ x: 180, y: 110 }, { x: 110, y: 310 }]);
  assert.equal(r.command({ type: "prepare", mapId: "m1" }).ok, true);
  r.step();
  assert.equal(r.state().canStart, false, "robot A is 70 mm away from its start");
  assert.match(String(r.command({ type: "start" }).error), /満たない/);

  r.command({ type: "position" });
  assert.equal(r.state().phase, "arming");
  assert.equal(r.until((s) => s.canStart, 60).canStart, true);
  assert.equal(r.sims[0].x > 105 && r.sims[0].x < 125, true);

  assert.equal(r.command({ type: "start" }).ok, true);
  const done = r.until((s) => s.phase === "finished");
  assert.equal(done.phase, "finished");
  assert.deepEqual(done.rows.map((row) => row.status), ["arrived", "arrived"]);
  for (const sim of r.sims) assert.ok(Math.abs(sim.x - 410) <= 20, `x=${sim.x}`);
  const exhibit = r.operator.messages.filter((m) => m.type === "exhibitState").at(-1)!.session;
  assert.equal(exhibit.mapId, "m1");
  assert.equal(exhibit.running, false);
  const fleet = r.operator.messages.filter((m) => m.type === "fleetState").at(-1)!;
  assert.deepEqual(fleet.vehicles.map((v: { mode: string }) => v.mode), ["manual", "manual"]);
  assert.equal(r.operator.messages.filter((m) => m.type === "sceneRunState").at(-1)!.result.outcome, "finished");
});

test("the clock waits at a bar end for a robot that is late, then goes on", (context) => {
  // 300 mm in 1.25 s needs 240 mm/s; the robot tops out at 200 mm/s. The end (2.25 s) is not a multiple of the 0.1 s tick.
  const scene = sceneOf([robot("A", "robot-d0", 110, [move("a1", 1, 1.25, 410, 110), move("a2", 6, 3, 560, 110)])]);
  const r = rig(context, scene, [{ x: 110, y: 110 }]);
  r.command({ type: "prepare", mapId: "m1" });
  r.step();
  r.command({ type: "start" });
  const waiting = r.until((s) => s.phase === "waiting");
  assert.equal(waiting.phase, "waiting");
  assert.ok(Math.abs(waiting.clock - 2.25) < 0.01, `clock stops at the bar end, got ${waiting.clock}`);
  assert.match(waiting.reason, /全台が待っています/);
  assert.equal(r.operator.messages.filter((m) => m.type === "exhibitState").at(-1)!.session.running, false);
  const done = r.until((s) => s.phase === "finished");
  assert.equal(done.phase, "finished");
  assert.ok(done.waitedMs > 500);
  assert.ok(done.rows[0].waitedSec > 0.5);
});

test("losing a marker stops everything at the next bar end and the run resumes by itself", (context) => {
  const scene = sceneOf([
    robot("A", "robot-d0", 110, [move("a1", 1, 6, 410, 110), move("a2", 8, 6, 710, 110)]),
    robot("B", "robot-d1", 310, [move("b1", 1, 6, 410, 310), move("b2", 8, 6, 710, 310)]),
  ]);
  const r = rig(context, scene, [{ x: 110, y: 110 }, { x: 110, y: 310 }]);
  r.command({ type: "prepare", mapId: "m1" });
  r.step();
  r.command({ type: "start" });
  r.until((s) => s.clock >= 3);
  r.hidden.add(0);
  const halted = r.until((s) => s.phase === "halted");
  assert.equal(halted.halt?.kind, "lost");
  assert.ok(halted.clock <= 7.01, `stops at the first bar end, got ${halted.clock}`);
  assert.equal(halted.resume.some((c) => !c.ok), true);
  r.hidden.delete(0);
  assert.equal(r.until((s) => s.phase !== "halted", 10).phase, "running");
  assert.equal(r.until((s) => s.phase === "finished").phase, "finished");
});

test("an emergency stop halts the run, and a simple route cannot start while it is active", (context) => {
  const r = rig(context, easyScene(), [{ x: 110, y: 110 }, { x: 110, y: 310 }]);
  r.command({ type: "prepare", mapId: "m1" });
  r.step();
  r.command({ type: "start" });
  r.until((s) => s.clock >= 2);
  r.operator.receive({ type: "clientCommand", targetDeviceIds: "all", cmd: "e", speedL: 0, speedR: 0 });
  assert.equal(r.state().phase, "halted");
  assert.equal(r.state().halt?.kind, "operator");
  r.operator.receive({ type: "routeStart", requestId: "rs", routeId: "rendezvous-demo" });
  assert.equal(r.operator.messages.filter((m) => m.type === "operationResult").at(-1)!.ok, false);
  assert.equal(r.command({ type: "abort" }).ok, true);
  assert.equal(r.state().phase, "aborted");
});

test("two robots meeting head-on: one steps aside, lets the other pass, and both finish without touching", (context) => {
  const scene = sceneOf([
    robot("A", "robot-d0", 310, [move("a1", 1, 16, 910, 310)]),
    { ...robot("B", "robot-d1", 310, [move("b1", 1, 16, 110, 310)]), initial: { x: 910, y: 310, yaw: 180, roomId: "r1" } },
  ]);
  const r = rig(context, scene, [{ x: 110, y: 310 }, { x: 910, y: 310, yaw: 180 }]);
  r.command({ type: "prepare", mapId: "m1" });
  r.step();
  r.command({ type: "start" });
  const evading = r.until((s) => s.evasions.length > 0);
  assert.equal(evading.evasions.length, 1, `an evasion starts before they meet ${JSON.stringify({ p: evading.phase, r: evading.reason, c: evading.clock, l: evading.log.slice(-4).map((e) => e.text), ro: evading.robots.map((b) => [b.pose, b.status]) })}`);
  assert.equal(evading.evasions[0].yielder, "B", "the larger marker id gives way (fixed order)");
  assert.match(evading.reason, /道を譲っています/);
  const clockWhileEvading = evading.clock;
  r.step(); r.step();
  assert.equal(r.state().clock, clockWhileEvading, "the clock stands still while a robot steps aside");
  const done = r.until((s) => s.phase === "finished");
  assert.equal(done.phase, "finished");
  assert.ok(r.minGap() >= 115, `the robots stayed apart, closest ${r.minGap().toFixed(0)} mm`);
  assert.ok(done.log.some((entry) => /退避/.test(entry.text)));
  assert.ok(Math.abs(r.sims[0].x - 910) <= 20 && Math.abs(r.sims[1].x - 110) <= 20);
});

test("eight robots run one scene together", (context) => {
  // Alternate lanes are staggered so neighbours stay about 200 mm apart.
  const robots = Array.from({ length: 8 }, (_, i) => {
    const column = i % 2, lane = Math.floor(i / 2);
    const x = 110 + column * 500 + (lane % 2) * 150, y = 110 + lane * 130;
    return { start: { x, y }, track: robot(`R${i}`, `robot-d${i}`, y, [move(`m${i}`, 1, 6, x + 200, y)]) };
  });
  const scene = sceneOf(robots.map((entry) => ({ ...entry.track, initial: { x: entry.start.x, y: entry.start.y, yaw: 0, roomId: "r1" } })));
  const r = rig(context, scene, robots.map((entry) => entry.start));
  r.command({ type: "prepare", mapId: "m1" });
  r.step();
  assert.equal(r.state().canStart, true, JSON.stringify(r.state().checks.filter((c) => !c.ok)));
  r.command({ type: "start" });
  const done = r.until((s) => s.phase === "finished");
  assert.equal(done.phase, "finished");
  assert.equal(done.rows.length, 8);
  assert.ok(done.rows.every((row) => row.status === "arrived"));
  assert.equal(done.evasions.length, 0);
});

test("who yields: room first, then the earlier bar end, then the fixed order", () => {
  const m = (id: string, barEnd: number, priority: number | null, markerId: number): Mover => ({ id, x: 0, y: 0, goal: null, speedMmS: 0, barEnd, priority, markerId });
  assert.equal(decide(m("a", 5, null, 0), m("b", 5, null, 1), false, true)?.yielder.id, "b");
  assert.equal(decide(m("a", 9, null, 0), m("b", 5, null, 1), true, true)?.yielder.id, "a", "b ends earlier so b goes first");
  assert.equal(decide(m("a", 5, null, 3), m("b", 5, 1, 7), true, true)?.yielder.id, "a", "a set priority beats a lower marker id");
  assert.equal(decide(m("a", 5, null, 0), m("b", 5, null, 1), false, false), null);
});

test("a robot stops short of a stopped robot that is not in the scene, and the run gives up waiting", (context) => {
  const scene = sceneOf([robot("A", "robot-d0", 110, [move("a1", 1, 6, 410, 110)])]);
  const r = rig(context, scene, [{ x: 110, y: 110 }, { x: 300, y: 110 }]);
  r.command({ type: "prepare", mapId: "m1" });
  r.step();
  assert.equal(r.state().checks.find((c) => c.id === "outsiders")?.warn, true, "the other robot is reported, not a reason to refuse");
  r.command({ type: "start" });
  const stopped = r.until((s) => s.phase === "halted", 60);
  assert.equal(stopped.halt?.kind, "timeout");
  assert.ok(r.minGap() >= 115, `closest ${r.minGap().toFixed(0)} mm`);
  assert.ok(r.sims[0].x < 300, "it never got past the other robot");
});

test("robot settings: priority and footprint are saved, checked, and reported on the run", (context) => {
  const scene = sceneOf([robot("A", "robot-d0", 110, [move("a1", 1, 6, 410, 110)])]);
  const r = rig(context, scene, [{ x: 110, y: 110 }]);
  const reply = () => r.operator.messages.filter((m) => m.type === "operationResult").at(-1)!;
  r.operator.receive({ type: "setRobotSettings", requestId: "s1", robotId: "robot-d0", priority: 2, footprintMm: { w: 70, d: 80 } });
  assert.equal(reply().ok, true);
  const saved = r.operator.messages.filter((m) => m.type === "fleetState").at(-1)!.robots[0];
  assert.deepEqual([saved.priority, saved.footprintMm], [2, { w: 70, d: 80 }]);
  r.operator.receive({ type: "setRobotSettings", requestId: "s2", robotId: "robot-d0", priority: 100 });
  assert.equal(reply().ok, false);
  r.operator.receive({ type: "setRobotSettings", requestId: "s3", robotId: "robot-d0", priority: null, footprintMm: { w: 50, d: 80 } });
  assert.equal(reply().ok, false, "a footprint outside 60-80 mm is refused");
  r.command({ type: "prepare", mapId: "m1" });
  r.step();
  assert.equal(r.state().robots[0].priority, 2);
});