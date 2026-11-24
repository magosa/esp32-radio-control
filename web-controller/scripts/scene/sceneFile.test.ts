import test from "node:test";
import assert from "node:assert/strict";
import { MAX_FILE_BYTES, appendSceneMaps, fileNameFor, parseSceneFile, replaceProject } from "../../scene/sceneFile";
import { createProject, newAction, newTrack, projectForSave, validateProject } from "../../scene/model";

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

test("imported copies retain sequences and all internal references even when IDs overlap", () => {
  const project = createProject("current");
  const map = project.maps[0];
  map.rooms = [{ id: "room", name: "room", kind: "room", material: "tile", color: "#123456", cells: [0] }];
  map.floorPlan = { furniture: [], doors: [{ id: "door", roomId: "room", cell: 0, edge: "bottom", openingId: "opening" }] };
  const door = newTrack(map, "door");
  door.actions.push(newAction(map, door, "door-open"));
  const actor = newTrack(map, "robot");
  actor.robotId = "physical-robot";
  actor.initial!.roomId = "room";
  const move = newAction(map, actor, "move");
  move.roomId = "room";
  const rotate = { ...newAction(map, actor, "move"), motion: "rotate" as const, facingFor: move.id, roomId: "room" };
  actor.actions.push(rotate, move);
  const display = newTrack(map, "display");
  const show = newAction(map, display, "show");
  const hide = { ...newAction(map, display, "hide"), targetId: show.targetId };
  display.actions.push(show, hide);
  map.tracks.push(door, actor, display);
  const source = projectForSave(project).maps[0];
  const before = structuredClone(project);
  appendSceneMaps(project, [source, source]);
  assert.deepEqual(project.maps[0], before.maps[0]);
  assert.equal(project.name, "current");
  assert.doesNotThrow(() => validateProject(project));
  for (const copy of project.maps.slice(1)) {
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.tracks[0].doorId, copy.floorPlan!.doors[0].id);
    assert.equal(copy.tracks[0].actions[0].doorId, copy.floorPlan!.doors[0].id);
    assert.equal(copy.tracks[1].initial!.roomId, copy.rooms[0].id);
    assert.equal(copy.tracks[1].robotId, "physical-robot");
    assert.equal(copy.tracks[1].actions[0].facingFor, copy.tracks[1].actions[1].id);
    assert.equal(copy.tracks[2].actions[0].targetId, copy.tracks[2].actions[1].targetId);
    assert.equal(copy.navigation!.doors[0].id, copy.floorPlan!.doors[0].id);
    assert.equal(copy.navigation!.doors[0].roomId, copy.rooms[0].id);
  }
  assert.notEqual(project.maps[1].id, project.maps[2].id);
  assert.deepEqual(source, projectForSave(before).maps[0]);
});

test("empty selection and exceeding the map limit do not mutate the project", () => {
  const project = createProject("current");
  const before = structuredClone(project);
  assert.throws(() => appendSceneMaps(project, []), /選択/);
  assert.throws(() => appendSceneMaps(project, Array(8).fill(project.maps[0])), /最大8枚/);
  assert.deepEqual(project, before);
});
