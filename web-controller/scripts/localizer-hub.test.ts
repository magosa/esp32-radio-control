import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { FleetHub } from "../fleet/hub";
import { FieldConfigStore, DEFAULT_FIELD_CONFIG } from "../fleet/fieldConfigStore";
import { isTrustedLocalizerRequest } from "../fleet/localizerAccess";
import { parsePoseFrame, PoseStore, POSE_STALE_MS } from "../fleet/poseStore";
import { RobotStore } from "../fleet/robotStore";
import type { PoseFrameMessage, RobotDefinition } from "../fleet/protocol";

const field = { cameraHeightMm: 800, widthMm: 1600, heightMm: 900, referenceSizeMm: 33 };
const robot = (markerId: number | null): RobotDefinition => ({ robotId: "robot-a", driveDeviceId: "a", cameraDeviceId: null, markerId, markerHeightMm: 90 });
function connectedStore(): PoseStore {
  const store = new PoseStore();
  store.onHello({ type: "localizerHello", camera: "cam", width: 1920, height: 1080 });
  return store;
}
const frame = (x: number, y: number, extra: Partial<PoseFrameMessage> = {}, markerId = 0): PoseFrameMessage => ({
  type: "poseFrame", frameId: 1, capturedAt: Date.now(), referenceCount: 4, referenceIds: [40, 41, 42, 43], extrinsicsOk: true,
  markers: [{ markerId, valid: true, x, y, yawDeg: 30, insideField: true }], ...extra,
});

test("PoseStore converts ratio coordinates to mm and tracks only fresh frames", (context) => {
  context.mock.timers.enable({ apis: ["Date"] });
  const store = connectedStore();
  const wide = { ...field, widthMm: 1106.93, heightMm: 622.65 };
  store.ingest(frame(800, 450), wide);
  const [pose] = store.snapshot([robot(0)], wide).poses;
  assert.equal(pose.tracking, "tracking");
  assert.ok(Math.abs(pose.xMm! - 553.465) < 1e-6 && Math.abs(pose.yMm! - 311.325) < 1e-6);
  assert.equal(pose.headingDeg, 30);

  context.mock.timers.tick(POSE_STALE_MS + 1);
  assert.equal(store.snapshot([robot(0)], wide).poses[0].tracking, "stale");
  assert.equal(store.snapshot([robot(null)], wide).poses[0].tracking, "unassigned");
});

test("PoseStore reports lost when a fresh frame lacks the marker, never reusing old positions", () => {
  const store = connectedStore();
  store.ingest(frame(100, 100), field);
  store.ingest(frame(100, 100, { markers: [{ markerId: 0, valid: false }] }), field);
  const [pose] = store.snapshot([robot(0)], field).poses;
  assert.equal(pose.tracking, "lost");
  assert.equal(pose.xMm, undefined);
});

test("PoseStore rejects impossible jumps until the new position repeats", (context) => {
  context.mock.timers.enable({ apis: ["Date"] });
  const store = connectedStore();
  const tracking = () => store.snapshot([robot(0)], field).poses[0];
  store.ingest(frame(100, 100), field);
  context.mock.timers.tick(100);
  store.ingest(frame(1200, 700), field);
  assert.equal(tracking().tracking, "lost");
  context.mock.timers.tick(100);
  store.ingest(frame(1202, 701), field);
  assert.equal(tracking().tracking, "lost");
  context.mock.timers.tick(100);
  store.ingest(frame(1201, 700), field);
  assert.equal(tracking().tracking, "tracking");
  assert.equal(Math.round(tracking().xMm!), 1201);
});

test("PoseStore accepts any position after a long gap and ordinary motion immediately", (context) => {
  context.mock.timers.enable({ apis: ["Date"] });
  const store = connectedStore();
  store.ingest(frame(100, 100), field);
  context.mock.timers.tick(100);
  store.ingest(frame(130, 100), field);
  assert.equal(store.snapshot([robot(0)], field).poses[0].tracking, "tracking");
  context.mock.timers.tick(3000);
  store.ingest(frame(1500, 800), field);
  assert.equal(store.snapshot([robot(0)], field).poses[0].tracking, "tracking");
});

test("pose frames with invalid values are rejected", () => {
  const valid = { frameId: 1, capturedAt: 1, referenceCount: 4, referenceIds: [40, 41, 42, 43], extrinsicsOk: true,
    markers: [{ markerId: 0, valid: true, x: 1, y: 2, yawDeg: 3 }] };
  assert.ok(parsePoseFrame(valid));
  assert.equal(parsePoseFrame({ ...valid, markers: [{ markerId: 9, valid: false }] }), null);
  assert.equal(parsePoseFrame({ ...valid, markers: [{ markerId: 0, valid: true, x: NaN, y: 2, yawDeg: 3 }] }), null);
  assert.equal(parsePoseFrame({ ...valid, referenceCount: 5 }), null);
  assert.equal(parsePoseFrame({ ...valid, referenceIds: [40, 40] }), null);
  assert.equal(parsePoseFrame({ ...valid, referenceIds: [3] }), null);
  assert.equal(parsePoseFrame({ ...valid, referenceIds: undefined }), null);
  assert.equal(parsePoseFrame({ ...valid, markers: new Array(9).fill({ markerId: 0, valid: false }) }), null);
});

test("localizer sockets are limited to loopback pages of this Hub", () => {
  const request = (remoteAddress: string, origin?: string) => ({ headers: { origin }, socket: { remoteAddress } });
  assert.equal(isTrustedLocalizerRequest(request("127.0.0.1", "http://localhost:3000"), 3000), true);
  assert.equal(isTrustedLocalizerRequest(request("::ffff:127.0.0.1", "http://127.0.0.1:3000"), 3000), true);
  assert.equal(isTrustedLocalizerRequest(request("::1", "http://[::1]:3000"), 3000), true);
  assert.equal(isTrustedLocalizerRequest(request("127.0.0.1", "https://evil.example"), 3000), false);
  assert.equal(isTrustedLocalizerRequest(request("127.0.0.1", "http://localhost:3001"), 3000), false);
  assert.equal(isTrustedLocalizerRequest(request("127.0.0.1"), 3000), false);
  assert.equal(isTrustedLocalizerRequest(request("192.168.0.5", "http://localhost:3000"), 3000), false);
  assert.equal(isTrustedLocalizerRequest(request("192.168.0.5"), 3000, true), true);
});

function withTempDir<T>(run: (directory: string) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-localizer-"));
  try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("marker assignments persist, stay unique and fall back for legacy files", () => withTempDir((directory) => {
  const filePath = path.join(directory, "fleet.json");
  const store = new RobotStore(filePath);
  store.register({ deviceId: "a", name: "A", fw: "t", capabilities: ["drive"] });
  store.register({ deviceId: "b", name: "B", fw: "t", capabilities: ["drive"] });
  store.assignMarker("robot-a", 0, 120);
  assert.throws(() => store.assignMarker("robot-b", 0), /already assigned/);
  assert.throws(() => store.assignMarker("robot-b", 4), /invalid/);
  assert.throws(() => store.assignMarker("robot-b", 1.5), /invalid/);
  assert.throws(() => store.assignMarker("robot-b", 1, -5), /Invalid marker height/);
  assert.throws(() => store.assignMarker("missing", 1), /Robot not found/);
  const reloaded = new RobotStore(filePath).getRobots();
  assert.deepEqual([reloaded[0].markerId, reloaded[0].markerHeightMm, reloaded[1].markerId], [0, 120, null]);
  store.assignMarker("robot-a", null);
  store.assignMarker("robot-b", 0);
  assert.equal(new RobotStore(filePath).getRobots()[1].markerId, 0);
  assert.equal(new RobotStore(filePath).getRobots()[0].markerHeightMm, 120);

  const legacy = path.join(directory, "legacy.json");
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, devices: [{ deviceId: "a", name: "A", fw: "t", capabilities: ["drive"] }],
    robots: [{ robotId: "robot-a", driveDeviceId: "a", cameraDeviceId: null }] }));
  const [legacyRobot] = new RobotStore(legacy).getRobots();
  assert.deepEqual([legacyRobot.markerId, legacyRobot.markerHeightMm], [null, 90]);
}));

test("field configuration persists and rejects invalid files without overwriting", () => withTempDir((directory) => {
  const filePath = path.join(directory, "field.json");
  const store = new FieldConfigStore(filePath);
  assert.deepEqual(store.get(), DEFAULT_FIELD_CONFIG);
  store.set({ ...field, widthMm: 1200 });
  assert.equal(new FieldConfigStore(filePath).get().widthMm, 1200);
  assert.throws(() => store.set({ ...field, widthMm: -1 }), /Invalid field/);
  assert.throws(() => store.set({ ...field, heightMm: Infinity }), /Invalid field/);
  assert.equal(new FieldConfigStore(filePath).get().widthMm, 1200);
  fs.writeFileSync(filePath, '{"version":2}');
  assert.throws(() => new FieldConfigStore(filePath), /Invalid field/);
  assert.equal(fs.readFileSync(filePath, "utf8"), '{"version":2}');
}));

function fakeSocket() {
  const messages: Record<string, unknown>[] = [];
  const handlers = new Map<string, (...args: any[]) => void>();
  const state = { closedWith: undefined as number | undefined };
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0,
    send: (data: string) => messages.push(JSON.parse(data)),
    on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler),
    terminate: () => handlers.get("close")?.(),
    close: (code?: number) => { state.closedWith = code; handlers.get("close")?.(); },
  } as unknown as WebSocket;
  return { socket, messages, state, receive: (value: unknown) => handlers.get("message")?.(Buffer.from(JSON.stringify(value))) };
}

test("Hub maps localizer frames to robots, throttles broadcasts and goes stale on disconnect", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  withTempDir((directory) => {
    const hub = new FleetHub(new RobotStore(path.join(directory, "fleet.json")), new FieldConfigStore(path.join(directory, "field.json")));
    try {
      let connect: (socket: WebSocket, request: { url: string }) => void = () => {};
      hub.attach({ on: (_event: string, handler: typeof connect) => { connect = handler; } } as never);
      const device = fakeSocket(), client = fakeSocket(), localizer = fakeSocket();
      connect(device.socket, { url: "/ws/device" });
      connect(client.socket, { url: "/ws/client" });
      device.receive({ type: "hello", deviceId: "a", name: "A", fw: "t", capabilities: ["drive"] });
      client.receive({ type: "setFieldConfig", requestId: "f1", config: { ...field, widthMm: 1600, heightMm: 900 } });
      client.receive({ type: "assignMarker", requestId: "m1", robotId: "robot-a", markerId: 0, markerHeightMm: 90 });
      client.receive({ type: "assignMarker", requestId: "m2", robotId: "robot-a", markerId: 9 });
      const results = client.messages.filter((m) => m.type === "operationResult");
      assert.deepEqual(results.map((m) => [m.requestId, m.ok]), [["f1", true], ["m1", true], ["m2", false]]);

      connect(localizer.socket, { url: "/ws/localizer" });
      localizer.receive({ type: "poseFrame", frameId: 1, capturedAt: Date.now(), referenceCount: 4, referenceIds: [40, 41, 42, 43], extrinsicsOk: true,
        markers: [{ markerId: 0, valid: true, x: 800, y: 450, yawDeg: 90, insideField: true }] });
      assert.equal(localizer.state.closedWith, 1008, "hello is required first");
      const second = fakeSocket();
      connect(second.socket, { url: "/ws/localizer" });
      second.receive({ type: "localizerHello", camera: "cam", width: 1920, height: 1080 });
      const before = client.messages.length;
      for (let id = 2; id < 12; id++) {
        second.receive({ type: "poseFrame", frameId: id, capturedAt: Date.now(), referenceCount: 4, referenceIds: [40, 41, 42, 43], extrinsicsOk: true,
          markers: [{ markerId: 0, valid: true, x: 800, y: 450, yawDeg: 90, insideField: true }] });
      }
      context.mock.timers.tick(100);
      const poseStates = () => client.messages.filter((m) => m.type === "poseState") as any[];
      assert.ok(client.messages.length - before <= 2, "frames are coalesced into few broadcasts");
      const latest = poseStates().at(-1);
      assert.equal(latest.poses[0].tracking, "tracking");
      assert.equal(latest.poses[0].xMm, 800);
      assert.equal(latest.localizer.camera, "cam");
      assert.deepEqual(latest.localizer.referenceIds, [40, 41, 42, 43]);

      second.socket.close();
      assert.equal(poseStates().at(-1).poses[0].tracking, "stale");
      assert.equal(poseStates().at(-1).localizer.connected, false);
    } finally {
      hub.dispose();
    }
  });
});

