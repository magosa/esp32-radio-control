import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SceneHistoryStore } from "../../fleet/sceneHistoryStore";
import { createProject, projectForSave } from "../../scene/model";
import type { SceneProject } from "../../scene/types";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scene-history-"));
}

function project(name = "p"): SceneProject {
  let n = 0;
  return projectForSave(createProject(name, () => `id-${++n}`));
}

const fixedNow = () => new Date("2026-11-11T00:00:00.000Z");

test("empty folder has no latest and the first append is revision 1", () => {
  const dir = tempDir();
  const store = SceneHistoryStore.open(dir, fixedNow);
  try {
    assert.equal(store.latest(), null);
    assert.deepEqual(store.list(), []);
    assert.equal(store.get(1), null);
    const result = store.append({ expectedRevision: 0, id: "e1", label: "初回", project: project() });
    assert.equal(result.status, "created");
    assert.ok(result.status === "created");
    assert.equal(result.record.revision, 1);
    assert.equal(result.record.timestamp, "2026-11-11T00:00:00.000Z");
    assert.equal(result.record.restoredFrom, null);
    assert.equal(result.record.hash, createHash("sha256").update(JSON.stringify(result.record.project)).digest("hex"));
    assert.ok(fs.existsSync(path.join(dir, "0000000001.json")));
    assert.equal(store.latest()?.revision, 1);
  } finally {
    store.close();
  }
});

test("stale expectedRevision conflicts with the latest revision", () => {
  const store = SceneHistoryStore.open(tempDir());
  try {
    store.append({ expectedRevision: 0, id: "a", label: "a", project: project("a") });
    const result = store.append({ expectedRevision: 0, id: "b", label: "b", project: project("b") });
    assert.deepEqual(result, { status: "conflict", latestRevision: 1 });
    assert.equal(store.list().length, 1);
  } finally {
    store.close();
  }
});

test("same id and same project is a duplicate; same id with another project conflicts", () => {
  const store = SceneHistoryStore.open(tempDir());
  try {
    const first = store.append({ expectedRevision: 0, id: "dup", label: "x", project: project("a") });
    assert.ok(first.status === "created");
    const again = store.append({ expectedRevision: 0, id: "dup", label: "x", project: project("a") });
    assert.ok(again.status === "duplicate");
    assert.equal(again.record.revision, 1);
    assert.deepEqual(again.record, first.record);
    const other = store.append({ expectedRevision: 1, id: "dup", label: "x", project: project("b") });
    assert.deepEqual(other, { status: "conflict", latestRevision: 1 });
    assert.equal(store.list().length, 1);
  } finally {
    store.close();
  }
});

test("append rejects invalid projects and bad request fields without writing", () => {
  const dir = tempDir();
  const store = SceneHistoryStore.open(dir);
  try {
    const bad = { ...project(), schema: "robot-scene/v5" };
    assert.throws(() => store.append({ expectedRevision: 0, id: "x", label: "x", project: bad }));
    assert.throws(() => store.append({ expectedRevision: 0, id: "has space", label: "x", project: project() }));
    assert.throws(() => store.append({ expectedRevision: 0, id: "a".repeat(81), label: "x", project: project() }));
    assert.throws(() => store.append({ expectedRevision: 0, id: "x", label: "", project: project() }));
    assert.throws(() => store.append({ expectedRevision: 0, id: "x", label: "l".repeat(121), project: project() }));
    assert.throws(() => store.append({ expectedRevision: -1, id: "x", label: "x", project: project() }));
    assert.throws(() => store.append({ expectedRevision: 1.5, id: "x", label: "x", project: project() }));
    assert.throws(() => store.append({ expectedRevision: 0, id: "x", label: "x", project: project(), restoredFrom: 1 }));
    assert.throws(() => store.append({ expectedRevision: 0, id: 5 as unknown as string, label: "x", project: project() }));
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== "writer.lock"), []);
    const ok = store.append({ expectedRevision: 0, id: "ok", label: "l".repeat(120), project: project() });
    assert.ok(ok.status === "created");
    const restored = store.append({ expectedRevision: 1, id: "r", label: "復元", project: project(), restoredFrom: 1 });
    assert.ok(restored.status === "created");
    assert.equal(restored.record.restoredFrom, 1);
  } finally {
    store.close();
  }
});

test("reopening yields the same history", () => {
  const dir = tempDir();
  const first = SceneHistoryStore.open(dir);
  first.append({ expectedRevision: 0, id: "a", label: "a", project: project("a") });
  first.append({ expectedRevision: 1, id: "b", label: "b", project: project("b") });
  const listed = first.list();
  const latest = first.latest();
  first.close();
  const second = SceneHistoryStore.open(dir);
  try {
    assert.deepEqual(second.list(), listed);
    assert.deepEqual(second.latest(), latest);
    assert.equal(second.get(1)?.id, "a");
    assert.equal(second.get(3), null);
    assert.equal(second.get(0), null);
  } finally {
    second.close();
  }
});

test("open throws on a revision gap", () => {
  const dir = tempDir();
  const first = SceneHistoryStore.open(dir);
  first.append({ expectedRevision: 0, id: "a", label: "a", project: project() });
  first.close();
  fs.renameSync(path.join(dir, "0000000001.json"), path.join(dir, "0000000002.json"));
  assert.throws(() => SceneHistoryStore.open(dir), /0000000002\.json/);
  assert.ok(!fs.existsSync(path.join(dir, "writer.lock")), "failed open must release the lock");
});

test("open throws on a missing middle revision", () => {
  const dir = tempDir();
  const first = SceneHistoryStore.open(dir);
  for (let i = 0; i < 3; i++) first.append({ expectedRevision: i, id: `i${i}`, label: "x", project: project() });
  first.close();
  fs.unlinkSync(path.join(dir, "0000000002.json"));
  assert.throws(() => SceneHistoryStore.open(dir), /0000000003\.json/);
});

test("open throws when the stored hash does not match", () => {
  const dir = tempDir();
  const first = SceneHistoryStore.open(dir);
  first.append({ expectedRevision: 0, id: "a", label: "a", project: project() });
  first.close();
  const file = path.join(dir, "0000000001.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.hash = "0".repeat(64);
  fs.writeFileSync(file, JSON.stringify(record));
  assert.throws(() => SceneHistoryStore.open(dir), /0000000001\.json/);
});

test("open throws on unparseable or tampered project content", () => {
  const dir = tempDir();
  const first = SceneHistoryStore.open(dir);
  first.append({ expectedRevision: 0, id: "a", label: "a", project: project() });
  first.close();
  const file = path.join(dir, "0000000001.json");
  fs.writeFileSync(file, "{not json");
  assert.throws(() => SceneHistoryStore.open(dir), /0000000001\.json/);
  const record = { revision: 1, id: "a", timestamp: "t", label: "a", restoredFrom: null, project: { schema: "x" }, hash: "" };
  record.hash = createHash("sha256").update(JSON.stringify(record.project)).digest("hex");
  fs.writeFileSync(file, JSON.stringify(record));
  assert.throws(() => SceneHistoryStore.open(dir), /0000000001\.json/);
});

test("a second open of the same folder is refused until close", () => {
  const dir = tempDir();
  const first = SceneHistoryStore.open(dir);
  assert.ok(fs.existsSync(path.join(dir, "writer.lock")));
  assert.throws(() => SceneHistoryStore.open(dir), /writer\.lock/);
  first.close();
  assert.ok(!fs.existsSync(path.join(dir, "writer.lock")));
  SceneHistoryStore.open(dir).close();
});

test("a writer.lock left by a dead process is taken over; unreadable or live locks are not", () => {
  const dir = tempDir();
  const lock = path.join(dir, "writer.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646, started: "2026-01-01T00:00:00.000Z" }));
  SceneHistoryStore.open(dir).close();
  fs.writeFileSync(lock, "garbage");
  assert.throws(() => SceneHistoryStore.open(dir), /writer\.lock/);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  assert.throws(() => SceneHistoryStore.open(dir), /writer\.lock/);
});

test("leftover *.tmp files are ignored on open", () => {
  const dir = tempDir();
  const first = SceneHistoryStore.open(dir);
  first.append({ expectedRevision: 0, id: "a", label: "a", project: project() });
  first.close();
  fs.writeFileSync(path.join(dir, "11111111-aaaa.tmp"), "{partial");
  const second = SceneHistoryStore.open(dir);
  try {
    assert.equal(second.list().length, 1);
    const next = second.append({ expectedRevision: 1, id: "b", label: "b", project: project("b") });
    assert.ok(next.status === "created");
  } finally {
    second.close();
  }
});

test("returned records are copies and cannot corrupt the store", () => {
  const store = SceneHistoryStore.open(tempDir());
  try {
    const input = project("a");
    const created = store.append({ expectedRevision: 0, id: "a", label: "a", project: input });
    assert.ok(created.status === "created");
    created.record.project.name = "mutated";
    input.name = "mutated-input";
    assert.equal(store.latest()?.project.name, "a");
    const latest = store.latest();
    assert.ok(latest);
    latest.project.name = "mutated-latest";
    assert.equal(store.get(1)?.project.name, "a");
  } finally {
    store.close();
  }
});
