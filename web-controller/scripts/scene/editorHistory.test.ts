import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UNDO_LIMIT, canRedo, canUndo, initHistory, pushEdit, redo, undo,
  type EditorHistory,
} from "../../scene/editorHistory";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

test("undo limit is 40 and the oldest state is dropped", () => {
  assert.equal(UNDO_LIMIT, 40);
  let h = initHistory(0);
  for (let i = 1; i <= 41; i++) h = pushEdit(h, i);
  assert.equal(h.present, 41);
  assert.equal(h.past.length, 40);
  assert.equal(h.past[0], 1);
  assert.equal(h.past[39], 40);
});

test("undo and redo move through states", () => {
  let h = initHistory("a");
  h = pushEdit(h, "b");
  h = pushEdit(h, "c");
  assert.ok(canUndo(h));
  assert.ok(!canRedo(h));
  h = undo(h);
  assert.equal(h.present, "b");
  assert.deepEqual(h.future, ["c"]);
  assert.ok(canRedo(h));
  h = redo(h);
  assert.equal(h.present, "c");
  assert.deepEqual(h.past, ["a", "b"]);
});

test("pushEdit after undo clears the future", () => {
  let h = initHistory(1);
  h = pushEdit(h, 2);
  h = undo(h);
  h = pushEdit(h, 3);
  assert.deepEqual(h.future, []);
  assert.ok(!canRedo(h));
  assert.deepEqual(h.past, [1]);
  assert.equal(h.present, 3);
});

test("undo/redo on empty stacks return the same reference", () => {
  const h = initHistory(1);
  assert.equal(undo(h), h);
  assert.equal(redo(h), h);
  assert.ok(!canUndo(h));
  assert.ok(!canRedo(h));
});

test("functions do not mutate frozen input", () => {
  const h0: EditorHistory<{ n: number }> = deepFreeze(initHistory({ n: 0 }));
  const h1 = deepFreeze(pushEdit(h0, { n: 1 }));
  const h2 = deepFreeze(pushEdit(h1, { n: 2 }));
  const u = deepFreeze(undo(h2));
  const r = deepFreeze(redo(u));
  const p = pushEdit(u, { n: 9 });
  assert.equal(r.present.n, 2);
  assert.equal(p.present.n, 9);
  assert.equal(h0.past.length, 0);
  assert.equal(h2.past.length, 2);
  assert.equal(u.future.length, 1);
});
