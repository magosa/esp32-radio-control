import test from "node:test";
import assert from "node:assert/strict";
import { MAX_FILE_BYTES, fileNameFor, parseSceneFile, replaceProject } from "../../scene/sceneFile";
import { createProject, projectForSave } from "../../scene/model";

test("parseSceneFile rejects invalid JSON", () => {
  const result = parseSceneFile("{not json");
  assert.equal(result.ok, false);
});

test("parseSceneFile rejects oversize text", () => {
  const result = parseSceneFile(" ".repeat(MAX_FILE_BYTES + 1));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /10 MiB/);
});

test("parseSceneFile reports the legacy robot-scene format", () => {
  const result = parseSceneFile(JSON.stringify({ schema: "robot-scene/v5", name: "x", maps: [] }));
  assert.deepEqual(result, { ok: false, error: "移植元の旧形式です。変換機能(S3)で取り込んでください。" });
});

test("parseSceneFile rejects a fleet-scene/v1 file with a bad field", () => {
  const project = projectForSave(createProject("x")) as unknown as Record<string, unknown>;
  project.name = 123;
  const result = parseSceneFile(JSON.stringify(project));
  assert.equal(result.ok, false);
});

test("parseSceneFile rejects non-objects and unknown schemas", () => {
  assert.equal(parseSceneFile("null").ok, false);
  assert.equal(parseSceneFile("[]").ok, false);
  assert.equal(parseSceneFile(JSON.stringify({ schema: "other/v1" })).ok, false);
});

test("parseSceneFile accepts a saved project round trip", () => {
  const saved = projectForSave(createProject("x"));
  const result = parseSceneFile(JSON.stringify(saved, null, 2));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.project, saved);
});

test("fileNameFor sanitises forbidden characters", () => {
  assert.equal(fileNameFor("a/b:c*?"), "a_b_c__.fleet-scene.json");
  assert.equal(fileNameFor('q"<>|\\x\u0001y'), "q_____x_y.fleet-scene.json");
});

test("fileNameFor falls back and caps length", () => {
  assert.equal(fileNameFor(""), "scene.fleet-scene.json");
  assert.equal(fileNameFor("   "), "scene.fleet-scene.json");
  assert.equal(fileNameFor("a".repeat(200)), `${"a".repeat(80)}.fleet-scene.json`);
});

test("replaceProject keeps the draft identity and replaces every field", () => {
  const draft = createProject("old");
  draft.facingTurns = true;
  const loaded = createProject("new");
  const same = draft;
  replaceProject(draft, loaded);
  assert.equal(draft, same);
  assert.equal(draft.name, "new");
  assert.deepEqual(draft.maps, loaded.maps);
  assert.equal("facingTurns" in draft, false);
});
