import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { WebSocket } from "ws";
import { FieldConfigStore } from "../fleet/fieldConfigStore";
import { FleetHub } from "../fleet/hub";
import { RobotStore } from "../fleet/robotStore";

function fakeSocket() {
  const messages: Record<string, unknown>[] = [];
  const handlers = new Map<string, (...args: any[]) => void>();
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0,
    send: (data: string) => messages.push(JSON.parse(data)),
    on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler),
    terminate: () => handlers.get("close")?.(),
    close: () => handlers.get("close")?.(),
  } as unknown as WebSocket;
  return { socket, messages, receive: (value: unknown) => handlers.get("message")?.(Buffer.from(JSON.stringify(value))) };
}

function withHub(run: (connect: () => ReturnType<typeof fakeSocket>) => void, context: TestContext) {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "exhibit-hub-"));
  const hub = new FleetHub(new RobotStore(path.join(directory, "fleet.json")), new FieldConfigStore(path.join(directory, "field.json")));
  try {
    let accept: (socket: WebSocket, request: { url: string }) => void = () => {};
    hub.attach({ on: (_event: string, handler: typeof accept) => { accept = handler; } } as never);
    run(() => {
      const client = fakeSocket();
      accept(client.socket, { url: "/ws/client" });
      return client;
    });
  } finally {
    hub.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const exhibitStates = (client: ReturnType<typeof fakeSocket>) => client.messages.filter((m) => m.type === "exhibitState") as any[];
const results = (client: ReturnType<typeof fakeSocket>) => client.messages.filter((m) => m.type === "operationResult") as any[];

test("a new client receives the exhibit state, idle until a map is opened", (context) => {
  withHub((connect) => {
    const client = connect();
    const [state] = exhibitStates(client);
    assert.equal(state.session.mapId, null);
    assert.equal(state.session.running, false);
    assert.equal(typeof state.serverNow, "number");
  }, context);
});

test("an exhibit command reaches every client, and the sender gets an acknowledgement", (context) => {
  withHub((connect) => {
    const operator = connect(), screen = connect();
    operator.receive({ type: "exhibitCommand", requestId: "x1", command: { type: "open", mapId: "map-a" } });
    operator.receive({ type: "exhibitCommand", requestId: "x2", command: { type: "play" } });
    for (const client of [operator, screen]) assert.equal(exhibitStates(client).at(-1).session.mapId, "map-a");
    assert.equal(exhibitStates(screen).at(-1).session.running, true);
    assert.deepEqual(results(operator).map((m) => [m.requestId, m.ok]), [["x1", true], ["x2", true]]);
    assert.equal(results(screen).length, 0, "other clients get no acknowledgement");
  }, context);
});

test("the clock the screen sees follows the Hub's time, and a screen that connects later sees the same session", (context) => {
  withHub((connect) => {
    const operator = connect();
    operator.receive({ type: "exhibitCommand", requestId: "o", command: { type: "open", mapId: "m" } });
    operator.receive({ type: "exhibitCommand", requestId: "p", command: { type: "play" } });
    const started = exhibitStates(operator).at(-1).session.startedAt;
    context.mock.timers.tick(5000);
    operator.receive({ type: "exhibitCommand", requestId: "s", command: { type: "pause" } });
    assert.equal(exhibitStates(operator).at(-1).session.position, 5);
    const late = connect();
    const state = exhibitStates(late)[0];
    assert.equal(state.session.mapId, "m");
    assert.equal(state.session.running, false);
    assert.equal(state.session.position, 5);
    assert.ok(state.session.startedAt >= started);
  }, context);
});

test("invalid exhibit commands are refused with an error and change nothing", (context) => {
  withHub((connect) => {
    const client = connect();
    const before = exhibitStates(client).length;
    client.receive({ type: "exhibitCommand", requestId: "a", command: { type: "open", mapId: "" } });
    client.receive({ type: "exhibitCommand", requestId: "b", command: { type: "seek", time: -1 } });
    client.receive({ type: "exhibitCommand", requestId: "c", command: "play" });
    client.receive({ type: "exhibitCommand", requestId: "d", command: { type: "play" } });
    client.receive({ type: "exhibitCommand", command: { type: "close" } });
    assert.deepEqual(results(client).map((m) => [m.requestId, m.ok]), [["a", false], ["b", false], ["c", false], ["d", false], ["", false]]);
    assert.match(String(results(client)[3].error), /マップ/);
    assert.equal(exhibitStates(client).length, before);
  }, context);
});

test("repeating a command that changes nothing does not broadcast again", (context) => {
  withHub((connect) => {
    const client = connect();
    client.receive({ type: "exhibitCommand", requestId: "o", command: { type: "open", mapId: "m" } });
    client.receive({ type: "exhibitCommand", requestId: "p1", command: { type: "pause" } });
    assert.equal(exhibitStates(client).length, 2);
    assert.equal(results(client).at(-1).ok, true);
  }, context);
});
