import assert from "node:assert/strict";
import { test } from "node:test";
import { createHistoryClient } from "../../scene/historyClient";
import type { SaveState } from "../../scene/historyTypes";
import { createProject } from "../../scene/model";

type Handler = (call: { url: string; body: any; index: number }) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function setup(handler: Handler) {
  const posts: { url: string; body: any }[] = [];
  const states: SaveState[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fakeFetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (init?.method === "POST") {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      posts.push({ url, body });
      try {
        await Promise.resolve();
        return await handler({ url, body, index: posts.length - 1 });
      } finally {
        inFlight--;
      }
    }
    return handler({ url, body, index: -1 });
  }) as typeof fetch;
  let n = 0;
  const client = createHistoryClient({
    fetch: fakeFetch,
    baseUrl: "http://hub",
    makeId: () => `id-${++n}`,
    onState: (s) => states.push(s),
  });
  return { client, posts, states, maxInFlight: () => maxInFlight };
}

async function settle(states: SaveState[], done: (s: SaveState) => boolean) {
  for (let i = 0; i < 200; i++) {
    const last = states[states.length - 1];
    if (last && done(last)) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`state did not settle: ${JSON.stringify(states)}`);
}

const ok = (body: any) => json(201, { revision: body.expectedRevision + 1, id: body.id, label: body.label });

test("records are posted one at a time in order with expectedRevision 0,1,2", async () => {
  const { client, posts, states, maxInFlight } = setup(({ body }) => ok(body));
  const project = createProject("p");
  client.record(project, "a");
  client.record(project, "b");
  client.record(project, "c");
  await settle(states, (s) => s.kind === "saved");
  assert.deepEqual(posts.map((p) => p.body.expectedRevision), [0, 1, 2]);
  assert.deepEqual(posts.map((p) => p.body.label), ["a", "b", "c"]);
  assert.equal(new Set(posts.map((p) => p.body.id)).size, 3);
  assert.equal(posts[0].url, "http://hub/api/scenes/history");
  assert.equal(maxInFlight(), 1);
  assert.deepEqual(states[states.length - 1], { kind: "saved", revision: 3 });
});

test("pending state includes the unsent count while sending", async () => {
  const { client, states } = setup(({ body }) => ok(body));
  const project = createProject("p");
  client.record(project, "a");
  client.record(project, "b");
  assert.deepEqual(states[0], { kind: "pending", count: 1 });
  assert.deepEqual(states[1], { kind: "pending", count: 2 });
  await settle(states, (s) => s.kind === "saved");
  assert.ok(states.some((s) => s.kind === "pending" && s.count === 1));
});

test("409 stops sending and later records only raise the pending count", async () => {
  const { client, posts, states } = setup(({ body, index }) =>
    index === 1 ? json(409, { latestRevision: 5 }) : ok(body));
  const project = createProject("p");
  client.record(project, "a");
  client.record(project, "b");
  client.record(project, "c");
  await settle(states, (s) => s.kind === "conflict");
  assert.deepEqual(states[states.length - 1], { kind: "conflict", latestRevision: 5 });
  assert.equal(posts.length, 2);
  client.record(project, "d");
  await new Promise((r) => setImmediate(r));
  assert.equal(posts.length, 2);
  assert.deepEqual(states[states.length - 1], { kind: "conflict", latestRevision: 5 });
  client.retry();
  await new Promise((r) => setImmediate(r));
  assert.equal(posts.length, 2);
});

test("network error stops with error state and retry() resends the same id", async () => {
  let failed = false;
  const { client, posts, states } = setup(({ body, index }) => {
    if (index === 1 && !failed) { failed = true; throw new TypeError("network down"); }
    return ok(body);
  });
  const project = createProject("p");
  client.record(project, "a");
  client.record(project, "b");
  client.record(project, "c");
  await settle(states, (s) => s.kind === "error");
  const err = states[states.length - 1];
  assert.equal(err.kind, "error");
  assert.equal(err.kind === "error" && err.count, 2);
  assert.equal(posts.length, 2);
  client.retry();
  await settle(states, (s) => s.kind === "saved");
  assert.equal(posts.length, 4);
  assert.equal(posts[2].body.id, posts[1].body.id);
  assert.equal(posts[2].body.expectedRevision, 1);
  assert.equal(posts[3].body.label, "c");
  assert.equal(posts[3].body.expectedRevision, 2);
  assert.deepEqual(states[states.length - 1], { kind: "saved", revision: 3 });
});

test("5xx is an error and the same id is retried", async () => {
  let first = true;
  const { client, posts, states } = setup(({ body }) => {
    if (first) { first = false; return json(503, { error: "busy" }); }
    return ok(body);
  });
  client.record(createProject("p"), "a");
  await settle(states, (s) => s.kind === "error");
  client.retry();
  await settle(states, (s) => s.kind === "saved");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.id, posts[1].body.id);
});

test("records during an error only raise the count and do not send", async () => {
  const { client, posts, states } = setup(() => { throw new TypeError("down"); });
  const project = createProject("p");
  client.record(project, "a");
  await settle(states, (s) => s.kind === "error");
  client.record(project, "b");
  await new Promise((r) => setImmediate(r));
  const last = states[states.length - 1];
  assert.equal(last.kind === "error" && last.count, 2);
  assert.equal(posts.length, 1);
});

test("record snapshots the project and forwards restoredFrom", async () => {
  const { client, posts, states } = setup(({ body }) => ok(body));
  const project = createProject("p");
  client.record(project, "restore", 4);
  project.name = "mutated later";
  await settle(states, (s) => s.kind === "saved");
  assert.equal(posts[0].body.restoredFrom, 4);
  assert.notEqual(posts[0].body.project.name, "mutated later");
});

test("load returns the latest record, continues numbering, and handles 204", async () => {
  const project = createProject("p");
  const loaded = setup(({ url, body }) => {
    if (url.endsWith("/api/scenes/latest")) return json(200, { revision: 7, id: "x", label: "l", project });
    return ok(body);
  });
  const rec = await loaded.client.load();
  assert.equal(rec?.revision, 7);
  loaded.client.record(project, "next");
  await settle(loaded.states, (s) => s.kind === "saved");
  assert.equal(loaded.posts[0].body.expectedRevision, 7);

  const empty = setup(() => new Response(null, { status: 204 }));
  assert.equal(await empty.client.load(), null);
});

test("load reports the loaded revision as saved so the screen shows it", async () => {
  const project = createProject("p");
  const loaded = setup(({ url }) => (url.endsWith("/api/scenes/latest") ? json(200, { revision: 7, id: "x", label: "l", project }) : json(500, {})));
  await loaded.client.load();
  assert.deepEqual(loaded.states.at(-1), { kind: "saved", revision: 7 });

  const empty = setup(() => new Response(null, { status: 204 }));
  await empty.client.load();
  assert.deepEqual(empty.states.at(-1), { kind: "saved", revision: 0 });
});

test("list and get call the history API", async () => {
  const seen: string[] = [];
  const { client } = setup(({ url }) => {
    seen.push(url);
    if (url.endsWith("/history")) return json(200, { records: [{ revision: 1 }] });
    return json(200, { revision: 2 });
  });
  assert.deepEqual(await client.list(), [{ revision: 1 }] as any);
  assert.equal((await client.get(2)).revision, 2);
  assert.deepEqual(seen, ["http://hub/api/scenes/history", "http://hub/api/scenes/history/2"]);
});
