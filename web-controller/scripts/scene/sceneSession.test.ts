import test from "node:test";
import assert from "node:assert/strict";
import { createSceneSession, type SceneSession } from "../../scene/sceneSession";
import { createProject } from "../../scene/model";
import type { SaveState, SceneHistoryRecord } from "../../scene/historyTypes";
import type { HistoryClient } from "../../scene/historyClient";
import type { SceneProject } from "../../scene/types";

let n = 0;
const ids = () => `id-${++n}`;

function fakeClient(initial: SceneProject | null) {
  const calls: { project: SceneProject; label: string; restoredFrom: number | null }[] = [];
  const records = new Map<number, SceneHistoryRecord>();
  const client: HistoryClient = {
    async load() {
      return initial ? { revision: 1, id: "x", timestamp: "t", label: "l", restoredFrom: null, hash: "h", project: initial } : null;
    },
    record(project, label, restoredFrom = null) { calls.push({ project, label, restoredFrom }); },
    retry() { calls.push({ project: null as never, label: "retry", restoredFrom: null }); },
    async list() { return []; },
    async get(rev) { const r = records.get(rev); if (!r) throw new Error("no"); return r; },
  };
  return { client, calls, records };
}

async function start(initial: SceneProject | null, save: SaveState = { kind: "saved", revision: 0 }) {
  const f = fakeClient(initial);
  let state: SaveState = save;
  const session: SceneSession = createSceneSession({ client: f.client, getSaveState: () => state, makeId: ids });
  await session.start();
  return { ...f, session, setSave: (s: SaveState) => { state = s; } };
}

test("an empty store creates and records a first project", async () => {
  const { session, calls } = await start(null);
  assert.equal(session.current()!.maps.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, "新規作成");
});

test("loading an existing project records nothing", async () => {
  const { session, calls } = await start(createProject("既存", ids));
  assert.equal(session.current()!.name, "既存");
  assert.equal(calls.length, 0);
});

test("a stored project that fails validation is reported and not edited", async () => {
  const bad = { ...createProject("x", ids), schema: "robot-scene/v5" } as unknown as SceneProject;
  const { session } = await start(bad);
  assert.equal(session.current(), null);
  assert.match(session.loadError() ?? "", /schema/);
});

test("commit validates a clone, records once, and leaves the original untouched on failure", async () => {
  const { session, calls } = await start(createProject("p", ids));
  const before = session.current()!;
  assert.equal(session.commit((d) => { d.name = "新しい名前"; }, "名前変更"), null);
  assert.equal(session.current()!.name, "新しい名前");
  assert.equal(before.name, "p");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, "名前変更");
  const error = session.commit((d) => { d.maps = []; }, "壊す");
  assert.equal(typeof error, "string");
  assert.equal(session.current()!.name, "新しい名前");
  assert.equal(calls.length, 1);
});

test("an edit that throws is reported as an error string", async () => {
  const { session, calls } = await start(createProject("p", ids));
  const error = session.commit(() => { throw new Error("boom"); }, "x");
  assert.equal(error, "boom");
  assert.equal(calls.length, 0);
});

test("undo and redo restore the screen state and record the restored state", async () => {
  const { session, calls } = await start(createProject("p", ids));
  session.commit((d) => { d.name = "a"; }, "a");
  session.commit((d) => { d.name = "b"; }, "b");
  assert.equal(session.undo(), null);
  assert.equal(session.current()!.name, "a");
  assert.equal(calls.at(-1)!.label, "元に戻す");
  assert.equal(calls.at(-1)!.project.name, "a");
  assert.equal(session.redo(), null);
  assert.equal(session.current()!.name, "b");
  assert.equal(calls.at(-1)!.label, "やり直し");
  session.undo();
  session.commit((d) => { d.name = "c"; }, "c");
  assert.equal(session.canRedo(), false);
});

test("undo with nothing to undo records nothing", async () => {
  const { session, calls } = await start(createProject("p", ids));
  assert.equal(session.canUndo(), false);
  assert.equal(session.undo(), null);
  assert.equal(calls.length, 0);
});

test("a conflict blocks commit, undo, redo and apply", async () => {
  const { session, calls, setSave } = await start(createProject("p", ids));
  session.commit((d) => { d.name = "a"; }, "a");
  session.commit((d) => { d.name = "b"; }, "b");
  session.undo();
  assert.equal(session.canUndo() && session.canRedo(), true);
  setSave({ kind: "conflict", latestRevision: 5 });
  const count = calls.length;
  for (const result of [session.commit((d) => { d.name = "z"; }, "z"), session.undo(), session.redo()]) {
    assert.match(result ?? "", /他の画面/);
  }
  assert.match((await session.apply(1)) ?? "", /他の画面/);
  assert.equal(session.current()!.name, "a");
  assert.equal(calls.length, count);
});

test("apply adds a new edit with restoredFrom and keeps later history reachable by undo", async () => {
  const { session, calls, records } = await start(createProject("p", ids));
  const old = createProject("過去", ids);
  records.set(3, { revision: 3, id: "r3", timestamp: "t", label: "l", restoredFrom: null, hash: "h", project: old });
  assert.equal(await session.apply(3), null);
  assert.equal(session.current()!.name, "過去");
  assert.deepEqual([calls.at(-1)!.label, calls.at(-1)!.restoredFrom], ["履歴 #3 を適用", 3]);
  session.undo();
  assert.equal(session.current()!.name, "p");
});

test("apply reports a missing revision and an invalid stored project", async () => {
  const { session, records } = await start(createProject("p", ids));
  assert.match((await session.apply(9)) ?? "", /no/);
  records.set(2, { revision: 2, id: "r2", timestamp: "t", label: "l", restoredFrom: null, hash: "h",
    project: { schema: "bad" } as unknown as SceneProject });
  assert.match((await session.apply(2)) ?? "", /schema/);
  assert.equal(session.current()!.name, "p");
});

test("the active map follows the project and falls back to the first map", async () => {
  const { session } = await start(createProject("p", ids));
  const first = session.current()!.maps[0].id;
  assert.equal(session.activeMapId(), first);
  session.commit((d) => { d.maps.push({ ...structuredClone(d.maps[0]), id: "m2", name: "二" }); }, "追加");
  session.setActiveMap("m2");
  assert.equal(session.activeMapId(), "m2");
  session.commit((d) => { d.maps = d.maps.filter((m) => m.id !== "m2"); }, "削除");
  assert.equal(session.activeMapId(), first);
  session.setActiveMap("unknown");
  assert.equal(session.activeMapId(), first);
});

test("subscribers are notified on every state change and can unsubscribe", async () => {
  const { session } = await start(createProject("p", ids));
  let count = 0;
  const off = session.subscribe(() => { count++; });
  session.commit((d) => { d.name = "a"; }, "a");
  session.undo();
  assert.equal(count, 2);
  off();
  session.redo();
  assert.equal(count, 2);
});

test("start twice does not create two first projects", async () => {
  const f = fakeClient(null);
  const session = createSceneSession({ client: f.client, getSaveState: () => ({ kind: "saved", revision: 0 }), makeId: ids });
  await Promise.all([session.start(), session.start()]);
  assert.equal(f.calls.length, 1);
});
