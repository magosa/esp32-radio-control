import test from "node:test";
import assert from "node:assert/strict";
import { saveStateLabel, shortcutAction } from "../../scene/editorShortcuts";

const key = (init: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>, target: unknown = null) =>
  ({ key: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target, ...init });
const el = (tagName: string, extra: object = {}) => ({ tagName, isContentEditable: false, ...extra });

test("Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo (Cmd on macOS too)", () => {
  assert.equal(shortcutAction(key({ key: "z", ctrlKey: true })), "undo");
  assert.equal(shortcutAction(key({ key: "Z", ctrlKey: true, shiftKey: true })), "redo");
  assert.equal(shortcutAction(key({ key: "y", ctrlKey: true })), "redo");
  assert.equal(shortcutAction(key({ key: "z", metaKey: true })), "undo");
});

test("plain keys, Alt combinations and other shortcuts are ignored", () => {
  assert.equal(shortcutAction(key({ key: "z" })), null);
  assert.equal(shortcutAction(key({ key: "z", ctrlKey: true, altKey: true })), null);
  assert.equal(shortcutAction(key({ key: "s", ctrlKey: true })), null);
});

test("text fields keep their own undo", () => {
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.equal(shortcutAction(key({ key: "z", ctrlKey: true }, el(tag))), null);
  }
  assert.equal(shortcutAction(key({ key: "z", ctrlKey: true }, el("DIV", { isContentEditable: true }))), null);
  assert.equal(shortcutAction(key({ key: "z", ctrlKey: true }, el("BUTTON"))), "undo");
});

test("save state labels show revision, pending count and failure counts", () => {
  assert.deepEqual(saveStateLabel({ kind: "saved", revision: 3 }), { text: "保存済み #3", tone: "ok" });
  assert.deepEqual(saveStateLabel({ kind: "pending", count: 2 }), { text: "保存中 2件", tone: "busy" });
  assert.deepEqual(saveStateLabel({ kind: "error", message: "x", count: 4 }), { text: "保存に失敗 4件", tone: "warn" });
  assert.deepEqual(saveStateLabel({ kind: "conflict", latestRevision: 9 }),
    { text: "他の画面で更新されました。再読込してください", tone: "warn" });
});
