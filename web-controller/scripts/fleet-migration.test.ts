import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RobotStore } from "../fleet/robotStore";
import { VehicleRegistry } from "../fleet/registry";
import { FleetHub } from "../fleet/hub";
import type { WebSocket } from "ws";

test("camera assignments survive restart and reject duplicate or unsupported devices", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-migration-"));
  try {
    const filePath = path.join(directory, "fleet.json");
    const store = new RobotStore(filePath);
    store.register({ deviceId: "drive-1", name: "Robot 1", fw: "test", capabilities: ["drive", "display"] });
    store.register({ deviceId: "drive-2", name: "Robot 2", fw: "test", capabilities: ["drive"] });
    store.register({ deviceId: "camera-1", name: "Camera", fw: "test", capabilities: ["camera"] });
    store.assignCamera("robot-drive-1", "camera-1");
    assert.equal(new RobotStore(filePath).getRobots()[0].cameraDeviceId, "camera-1");
    assert.throws(() => store.assignCamera("robot-drive-2", "camera-1"), /already assigned/);
    assert.throws(() => store.assignCamera("robot-drive-2", "drive-1"), /Camera unavailable/);
    assert.throws(() => store.assignCamera("missing", "camera-1"), /Robot not found/);
    assert.equal(new RobotStore(filePath).getRobots()[1].cameraDeviceId, null);
    store.assignCamera("robot-drive-1", null);
    store.assignCamera("robot-drive-2", "camera-1");
    assert.equal(new RobotStore(filePath).getRobots()[1].cameraDeviceId, "camera-1");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid persisted configuration is not silently overwritten", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-migration-"));
  try {
    const filePath = path.join(directory, "fleet.json");
    fs.writeFileSync(filePath, '{"version":2}');
    assert.throws(() => new RobotStore(filePath), /Invalid fleet configuration/);
    assert.equal(fs.readFileSync(filePath, "utf8"), '{"version":2}');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fakeSocket() {
  const messages: Record<string, unknown>[] = [];
  const handlers = new Map<string, (...args: any[]) => void>();
  const state = { terminated: false };
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0,
    send: (data: string) => messages.push(JSON.parse(data)),
    on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler),
    terminate: () => { state.terminated = true; handlers.get("close")?.(); },
    close: () => handlers.get("close")?.(),
  } as unknown as WebSocket;
  return { socket, messages, state, receive: (value: unknown) => handlers.get("message")?.(Buffer.from(JSON.stringify(value))) };
}

test("Hub terminates timed-out device sockets so ESP clients can reconnect", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-timeout-"));
  const hub = new FleetHub(new RobotStore(path.join(directory, "fleet.json")));
  try {
    const device = fakeSocket();
    const client = fakeSocket();
    let connect: (socket: WebSocket, request: { url: string }) => void = () => {};
    hub.attach({ on: (_event: string, handler: typeof connect) => { connect = handler; } } as any);
    connect(device.socket, { url: "/ws/device" });
    connect(client.socket, { url: "/ws/client" });
    device.receive({ type: "hello", deviceId: "camera", name: "Camera", fw: "test", capabilities: ["camera"] });

    context.mock.timers.tick(11000);

    assert.equal(device.state.terminated, true);
  const fleetState = client.messages.filter((message) => message.type === "fleetState").at(-1) as any;
  assert.equal(fleetState.devices[0].status, "offline");
  } finally {
    hub.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy drive and independent camera route commands by capability and survive camera disconnect", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-migration-"));
  const hub = new FleetHub(new RobotStore(path.join(directory, "fleet.json")));
  try {
    const peers = { drive: fakeSocket(), camera: fakeSocket(), client: fakeSocket() };
    let connect: (socket: WebSocket, request: { url: string }) => void = () => {};
    hub.attach({ on: (_event: string, handler: typeof connect) => { connect = handler; } } as any);
    connect(peers.drive.socket, { url: "/ws/device" });
    connect(peers.camera.socket, { url: "/ws/device" });
    connect(peers.client.socket, { url: "/ws/client" });
    peers.drive.receive({ type: "hello", deviceId: "drive", name: "Robot", fw: "old" });
    peers.camera.receive({ type: "hello", deviceId: "camera", name: "Camera", fw: "new", capabilities: ["camera"] });
    peers.client.receive({ type: "assignCamera", requestId: "save", robotId: "robot-drive", cameraDeviceId: "camera" });
    peers.client.receive({ type: "clientCommand", targetDeviceIds: "all", cmd: "a", speedL: 100, speedR: 100 });
    assert.equal(peers.drive.messages.at(-1)?.type, "drive");
    assert.equal(peers.camera.messages.length, 0);
    peers.client.receive({ type: "clientCaptureRequest", targetDeviceIds: ["drive", "camera"] });
    assert.equal(peers.camera.messages.at(-1)?.type, "captureImage");
    assert.equal(peers.drive.messages.at(-1)?.type, "drive");
    peers.client.receive({ type: "clientStreamRequest", deviceId: "camera", action: "start" });
    peers.camera.receive({ type: "heartbeat", deviceId: "camera" });
    const beforeDisconnect = peers.drive.messages.length;
    peers.camera.socket.close();
    assert.equal(peers.drive.messages.length, beforeDisconnect);
    const state = peers.client.messages.filter((message) => message.type === "fleetState").at(-1) as any;
    assert.equal(state.vehicles.length, 1);
    assert.equal(state.robots[0].cameraStatus, "offline");
    assert.equal(state.robots[0].status, "online");
    assert.equal(new RobotStore(path.join(directory, "fleet.json")).getRobots()[0].cameraDeviceId, "camera");
    peers.client.receive({ type: "setMode", deviceId: "drive", mode: "auto" });
    peers.client.receive({ type: "routeStart", routeId: "rendezvous-demo" });
    context.mock.timers.tick(1);
    assert.equal(peers.client.messages.filter((message) => message.type === "routeStatus").at(-1)?.running, true);
    assert.equal(peers.drive.messages.at(-1)?.type, "drive");
    assert.notEqual(peers.drive.messages.at(-1)?.cmd, "e");
    peers.client.receive({ type: "clientCommand", targetDeviceIds: "all", cmd: "e", speedL: 0, speedR: 0 });
    assert.equal(peers.drive.messages.at(-1)?.cmd, "e");
    const afterStop = peers.drive.messages.length;
    context.mock.timers.tick(60000);
    assert.equal(peers.drive.messages.length, afterStop);
    assert.equal(peers.client.messages.filter((message) => message.type === "routeStatus").at(-1)?.running, false);
  } finally {
    hub.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("stored devices start offline and camera heartbeat does not require motor telemetry", () => {
  const registry = new VehicleRegistry([{ deviceId: "camera", name: "Camera", fw: "test", capabilities: ["camera"] }]);
  assert.equal(registry.getAllDeviceStates()[0].status, "offline");
  registry.registerHello("camera", "Camera", fakeSocket().socket, ["camera"]);
  registry.touch("camera");
  assert.equal(registry.getAllDeviceStates()[0].status, "online");
  assert.deepEqual(registry.getOnlineDeviceIds(), []);
  assert.equal(registry.getDeviceState("camera")?.telemetry, null);
});

test("assignment errors preserve streams, unassignment stops them, and device identity cannot be spoofed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-migration-"));
  const filePath = path.join(directory, "fleet.json");
  const hub = new FleetHub(new RobotStore(filePath));
  try {
    const peers = { drive: fakeSocket(), other: fakeSocket(), camera: fakeSocket(), client: fakeSocket() };
    let connect: (socket: WebSocket, request: { url: string }) => void = () => {};
    hub.attach({ on: (_event: string, handler: typeof connect) => { connect = handler; } } as any);
    for (const [deviceId, peer] of Object.entries(peers)) {
      connect(peer.socket, { url: deviceId === "client" ? "/ws/client" : "/ws/device" });
      if (deviceId !== "client") peer.receive({ type: "hello", deviceId, name: deviceId, fw: "test",
        capabilities: deviceId === "camera" ? ["camera"] : ["drive", "display"] });
    }
    peers.client.receive({ type: "assignCamera", requestId: "first", robotId: "robot-drive", cameraDeviceId: "camera" });
    assert.equal(peers.client.messages.at(-1)?.ok, true);
    peers.client.receive({ type: "clientStreamRequest", deviceId: "camera", action: "start" });
    assert.equal(peers.camera.messages.at(-1)?.type, "streamStart");
    const beforeConflict = peers.camera.messages.length;
    peers.client.receive({ type: "assignCamera", requestId: "conflict", robotId: "robot-other", cameraDeviceId: "camera" });
    assert.deepEqual(peers.client.messages.at(-1), { type: "operationResult", requestId: "conflict", ok: false,
      error: "Camera unavailable or already assigned" });
    assert.equal(peers.camera.messages.length, beforeConflict);
    assert.equal(new RobotStore(filePath).getRobots()[0].cameraDeviceId, "camera");
    peers.client.receive({ type: "assignCamera", requestId: "remove", robotId: "robot-drive", cameraDeviceId: null });
    assert.equal(peers.camera.messages.at(-1)?.type, "streamStop");
    assert.equal(new RobotStore(filePath).getRobots()[0].cameraDeviceId, null);
    peers.camera.receive({ type: "telemetry", deviceId: "drive", cmd: "a", speedL: 255, speedR: 255 });
    const state = peers.client.messages.filter((message) => message.type === "fleetState").at(-1) as any;
    assert.equal(state.devices.find((device: any) => device.deviceId === "camera").status, "offline");
    assert.equal(state.vehicles.find((device: any) => device.deviceId === "drive").telemetry, null);
    assert.equal(state.robots[0].status, "online");
  } finally {
    hub.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});