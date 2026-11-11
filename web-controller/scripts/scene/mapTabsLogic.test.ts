import test from "node:test";
import assert from "node:assert/strict";
import { MAX_MAPS, afterDelete, canAddMap, canDeleteMap, neighbourTab, nextMapName, validateMapName } from "../../scene/mapTabsLogic";

test("MAX_MAPS is 8", () => assert.equal(MAX_MAPS, 8));

test("nextMapName fills the first unused number", () => {
  assert.equal(nextMapName([]), "マップ 1");
  assert.equal(nextMapName(["マップ 1"]), "マップ 2");
  assert.equal(nextMapName(["マップ 1", "マップ 3"]), "マップ 2");
  assert.equal(nextMapName(["マップ 2", "別名"]), "マップ 1");
});

test("validateMapName trims and bounds the length", () => {
  assert.deepEqual(validateMapName("  会議室  "), { ok: true, name: "会議室" });
  const empty = validateMapName("   ");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error, /入力/);
  assert.equal(validateMapName("あ".repeat(60)).ok, true);
  const long = validateMapName("あ".repeat(61));
  assert.equal(long.ok, false);
  if (!long.ok) assert.match(long.error, /60/);
});

test("validateMapName counts code points, not UTF-16 units", () => {
  assert.equal(validateMapName("😀".repeat(60)).ok, true);
  assert.equal(validateMapName("😀".repeat(61)).ok, false);
});

test("validateMapName still returns the trimmed name when it equals existing", () => {
  const same = validateMapName(" マップ 1 ", "マップ 1");
  assert.deepEqual(same, { ok: true, name: "マップ 1" });
});

test("canAddMap / canDeleteMap boundaries", () => {
  assert.equal(canAddMap(7), true);
  assert.equal(canAddMap(8), false);
  assert.equal(canAddMap(9), false);
  assert.equal(canDeleteMap(1), false);
  assert.equal(canDeleteMap(2), true);
  assert.equal(canDeleteMap(0), false);
});

test("neighbourTab moves with wrap-around", () => {
  const ids = ["a", "b", "c"];
  assert.equal(neighbourTab(ids, "a", "ArrowRight"), "b");
  assert.equal(neighbourTab(ids, "c", "ArrowRight"), "a");
  assert.equal(neighbourTab(ids, "a", "ArrowLeft"), "c");
  assert.equal(neighbourTab(ids, "b", "ArrowLeft"), "a");
  assert.equal(neighbourTab(ids, "b", "Home"), "a");
  assert.equal(neighbourTab(ids, "b", "End"), "c");
  assert.equal(neighbourTab(["a"], "a", "ArrowRight"), "a");
  assert.equal(neighbourTab(ids, "zzz", "ArrowRight"), "a");
});

test("afterDelete picks the first remaining id only when the active map is deleted", () => {
  assert.equal(afterDelete(["a", "b", "c"], "b", "a"), null);
  assert.equal(afterDelete(["a", "b", "c"], "a", "a"), "b");
  assert.equal(afterDelete(["a", "b", "c"], "c", "c"), "a");
  assert.equal(afterDelete(["a"], "a", "a"), null);
});
