import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { handleSceneRequest } from "../../fleet/sceneHttp";
import { SceneHistoryStore } from "../../fleet/sceneHistoryStore";
import { createProject, projectForSave } from "../../scene/model";

const MAX_BODY = 10 * 1024 * 1024;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

interface Harness {
  dir: string;
  store: SceneHistoryStore;
  origin: string;
  call(method: string, urlPath: string, options?: { headers?: Record<string, string>; body?: string | Buffer; origin?: string | null }): Promise<Reply>;
  post(body: unknown, headers?: Record<string, string>, origin?: string | null): Promise<Reply>;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-http-"));
  const store = SceneHistoryStore.open(dir);
  const server = http.createServer((req, res) => {
    handleSceneRequest(req, res, store).then((handled) => {
      if (!handled) {
        res.statusCode = 418;
        res.end("next");
      }
    }, () => {
      res.statusCode = 599;
      res.end("unhandled");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  function call(method: string, urlPath: string, options: { headers?: Record<string, string>; body?: string | Buffer; origin?: string | null } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      const originValue = options.origin === undefined ? (method === "POST" ? origin : null) : options.origin;
      if (originValue !== null) headers.Origin = originValue;
      let settled = false;
      const request = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        const finish = () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
        };
        response.on("end", finish);
        response.on("close", finish);
      });
      // 413 などの早期応答でサーバーが本文を受け取らない場合の書込みエラーは無視する。
      request.on("error", (error) => {
        if (!settled) { settled = true; reject(error); }
      });
      if (options.body !== undefined) request.write(options.body);
      request.end();
    });
  }

  return {
    dir, store, origin, call,
    post(body, headers = { "Content-Type": "application/json" }, origin_?: string | null) {
      return call("POST", "/api/scenes/history", { headers, body: typeof body === "string" ? body : JSON.stringify(body), origin: origin_ });
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

function project(name = "p") {
  let n = 0;
  return projectForSave(createProject(name, () => `id-${++n}`));
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await harness();
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

const files = (dir: string) => fs.readdirSync(dir).filter((name) => name !== "writer.lock");

test("empty history: list 200, latest 204, unknown revision 404", () => withHarness(async (h) => {
  const list = await h.call("GET", "/api/scenes/history");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, { records: [] });
  assert.match(String(list.headers["content-type"]), /^application\/json/);
  assert.equal((await h.call("GET", "/api/scenes/latest")).status, 204);
  assert.equal((await h.call("GET", "/api/scenes/history/1")).status, 404);
}));

test("POST creates (201), repeats as duplicate (200), then GET serves it", () => withHarness(async (h) => {
  const body = { expectedRevision: 0, id: "e1", label: "初回", project: project() };
  const created = await h.post(body);
  assert.equal(created.status, 201);
  assert.equal(created.json.revision, 1);
  assert.equal(created.json.id, "e1");
  assert.equal(created.json.restoredFrom, null);
  assert.equal(created.json.project.schema, "fleet-scene/v1");

  const again = await h.post(body);
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, created.json);

  const list = await h.call("GET", "/api/scenes/history");
  assert.equal(list.status, 200);
  assert.equal(list.json.records.length, 1);
  assert.equal("project" in list.json.records[0], false);
  assert.equal(list.json.records[0].hash, created.json.hash);

  const one = await h.call("GET", "/api/scenes/history/1");
  assert.equal(one.status, 200);
  assert.deepEqual(one.json, created.json);
  const latest = await h.call("GET", "/api/scenes/latest");
  assert.equal(latest.status, 200);
  assert.deepEqual(latest.json, created.json);
}));

test("conflicts: stale expectedRevision and reused id with other content return 409", () => withHarness(async (h) => {
  assert.equal((await h.post({ expectedRevision: 0, id: "a", label: "a", project: project("a") })).status, 201);
  const stale = await h.post({ expectedRevision: 0, id: "b", label: "b", project: project("b") });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.latestRevision, 1);
  const reused = await h.post({ expectedRevision: 1, id: "a", label: "a", project: project("other") });
  assert.equal(reused.status, 409);
  assert.equal(reused.json.latestRevision, 1);
  assert.equal(h.store.list().length, 1);
}));

test("restoredFrom is stored and validated", () => withHarness(async (h) => {
  await h.post({ expectedRevision: 0, id: "a", label: "a", project: project("a") });
  const ok = await h.post({ expectedRevision: 1, id: "b", label: "復元", project: project("a"), restoredFrom: 1 });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.restoredFrom, 1);
  const missing = await h.post({ expectedRevision: 2, id: "c", label: "x", project: project("a"), restoredFrom: 9 });
  assert.equal(missing.status, 400);
  const wrongType = await h.post({ expectedRevision: 2, id: "c", label: "x", project: project("a"), restoredFrom: "1" });
  assert.equal(wrongType.status, 400);
}));

test("invalid bodies return 400 with an error message and write nothing", () => withHarness(async (h) => {
  const good = { expectedRevision: 0, id: "ok", label: "x", project: project() };
  const cases: Array<[string, unknown]> = [
    ["wrong schema", { ...good, project: { ...project(), schema: "robot-scene/v5" } }],
    ["project missing", { expectedRevision: 0, id: "ok", label: "x" }],
    ["project is a string", { ...good, project: "nope" }],
    ["project is an array", { ...good, project: [] }],
    ["expectedRevision string", { ...good, expectedRevision: "0" }],
    ["expectedRevision negative", { ...good, expectedRevision: -1 }],
    ["expectedRevision fraction", { ...good, expectedRevision: 0.5 }],
    ["id with slash", { ...good, id: "../x" }],
    ["id too long", { ...good, id: "a".repeat(81) }],
    ["id number", { ...good, id: 7 }],
    ["label empty", { ...good, label: "" }],
    ["label too long", { ...good, label: "あ".repeat(121) }],
    ["label number", { ...good, label: 1 }],
    ["body array", [good]],
    ["body null", null],
    ["body string", "x"],
  ];
  for (const [name, body] of cases) {
    const reply = await h.post(JSON.stringify(body));
    assert.equal(reply.status, 400, name);
    assert.equal(typeof reply.json?.error, "string", name);
  }
  const broken = await h.post("{not json");
  assert.equal(broken.status, 400);
  assert.equal(typeof broken.json?.error, "string");
  const badUtf8 = await h.call("POST", "/api/scenes/history", { headers: JSON_HEADERS, body: Buffer.from([0x7b, 0xff, 0x7d]) });
  assert.equal(badUtf8.status, 400);
  assert.deepEqual(files(h.dir), []);
  assert.equal((await h.post(good)).status, 201);
}));

test("POST without a matching Origin is rejected with 403", () => withHarness(async (h) => {
  const body = { expectedRevision: 0, id: "o", label: "x", project: project() };
  assert.equal((await h.post(body, JSON_HEADERS, "http://evil.example")).status, 403);
  assert.equal((await h.post(body, JSON_HEADERS, null)).status, 403);
  assert.equal((await h.post(body, JSON_HEADERS, "null")).status, 403);
  assert.equal((await h.post(body, JSON_HEADERS, "not a url")).status, 403);
  assert.equal((await h.post(body, JSON_HEADERS, h.origin.replace(/:\d+$/, ":1"))).status, 403);
  assert.equal((await h.post(body, JSON_HEADERS, "ftp://" + h.origin.slice("http://".length))).status, 403);
  // Origin は Content-Type より先に検査する。
  assert.equal((await h.post(body, { "Content-Type": "text/plain" }, "http://evil.example")).status, 403);
  assert.deepEqual(files(h.dir), []);
  assert.equal((await h.post(body, JSON_HEADERS, h.origin)).status, 201);
}));

test("Origin must match the Host header, not the socket address", () => withHarness(async (h) => {
  const body = JSON.stringify({ expectedRevision: 0, id: "h", label: "x", project: project() });
  const same = await h.call("POST", "/api/scenes/history", { headers: { ...JSON_HEADERS, Host: "hub.local:3000" }, body, origin: "http://hub.local:3000" });
  assert.equal(same.status, 201);
  const other = await h.call("POST", "/api/scenes/history", { headers: { ...JSON_HEADERS, Host: "hub.local:3000" }, body, origin: "http://hub.local:3001" });
  assert.equal(other.status, 403);
}));

test("POST requires Content-Type application/json (415)", () => withHarness(async (h) => {
  const body = JSON.stringify({ expectedRevision: 0, id: "t", label: "x", project: project() });
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/jsonx", "application/json-patch+json", "multipart/form-data"]) {
    const reply = await h.call("POST", "/api/scenes/history", { headers: { "Content-Type": type }, body });
    assert.equal(reply.status, 415, type);
  }
  const none = await h.call("POST", "/api/scenes/history", { body });
  assert.equal(none.status, 415);
  assert.deepEqual(files(h.dir), []);
  const withCharset = await h.call("POST", "/api/scenes/history", { headers: { "Content-Type": "application/json; charset=utf-8" }, body });
  assert.equal(withCharset.status, 201);
}));

test("bodies over 10 MiB return 413; exactly 10 MiB is read", () => withHarness(async (h) => {
  const tooBig = Buffer.alloc(MAX_BODY + 1, 0x20);
  const rejected = await h.call("POST", "/api/scenes/history", { headers: JSON_HEADERS, body: tooBig });
  assert.equal(rejected.status, 413);
  assert.equal(typeof rejected.json?.error, "string");

  // Content-Length を偽らない chunked でも上限で止まる。
  const chunked = await new Promise<number>((resolve, reject) => {
    const request = http.request(h.origin + "/api/scenes/history", { method: "POST", headers: { ...JSON_HEADERS, Origin: h.origin, "Transfer-Encoding": "chunked" } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    for (let i = 0; i < 11; i++) request.write(chunk);
    request.end();
  });
  assert.equal(chunked, 413);

  // 上限ちょうどは 413 にならず、中身の検証（JSON として不正→400）まで進む。
  const atLimit = await h.call("POST", "/api/scenes/history", { headers: JSON_HEADERS, body: Buffer.alloc(MAX_BODY, 0x20) });
  assert.equal(atLimit.status, 400);
  assert.deepEqual(files(h.dir), []);
}));

test("GET ignores Origin and other methods are rejected", () => withHarness(async (h) => {
  assert.equal((await h.call("GET", "/api/scenes/history", { origin: "http://evil.example" })).status, 200);
  const del = await h.call("DELETE", "/api/scenes/history");
  assert.equal(del.status, 405);
  assert.match(String(del.headers.allow), /GET/);
  assert.equal((await h.call("PUT", "/api/scenes/history", { headers: JSON_HEADERS, body: "{}" })).status, 405);
  assert.equal((await h.call("POST", "/api/scenes/latest", { headers: JSON_HEADERS, body: "{}", origin: h.origin })).status, 405);
  assert.equal((await h.call("GET", "/api/scenes/unknown")).status, 404);
}));

test("revision path accepts only plain positive integers", () => withHarness(async (h) => {
  await h.post({ expectedRevision: 0, id: "a", label: "a", project: project() });
  for (const bad of ["/api/scenes/history/0", "/api/scenes/history/2", "/api/scenes/history/abc", "/api/scenes/history/-1", "/api/scenes/history/1.5", "/api/scenes/history/..%2Fx", "/api/scenes/history/1/extra", "/api/scenes/history/00000000001"]) {
    assert.equal((await h.call("GET", bad)).status, 404, bad);
  }
  assert.equal((await h.call("GET", "/api/scenes/history/1")).status, 200);
  assert.equal((await h.call("GET", "/api/scenes/history/1?x=1")).status, 200);
}));

test("paths outside /api/scenes/ are left to the next handler", () => withHarness(async (h) => {
  for (const p of ["/api/routes", "/api/scenesX", "/scenes", "/", "/api/scenes"]) {
    const reply = await h.call("GET", p);
    assert.equal(reply.status, 418, p);
    assert.equal(reply.text, "next", p);
  }
  assert.equal((await h.call("POST", "/api/routes", { headers: JSON_HEADERS, body: "{}" })).status, 418);
}));
