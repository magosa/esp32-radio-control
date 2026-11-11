import test from "node:test";
import assert from "node:assert/strict";
import { cellIndex } from "../../scene/grid";
import { MAP_UNDO_LIMIT, createMapEditSession, type MapEditSession } from "../../scene/mapEditSession";
import { toJapanese } from "../../scene/mapEditMessages";
import { validateProject } from "../../scene/model";
import type { Room, SceneMap, Track } from "../../scene/types";

const rect = (c0: number, r0: number, c1: number, r1: number) => {
  const cells: number[] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(cellIndex(c, r));
  return cells;
};
const room = (id: string, cells: number[], extras: Partial<Room> = {}): Room => ({
  id, name: id, color: "#739a81", kind: "room", material: "concrete", cells, ...extras,
});
const emptyMap = (...rooms: Room[]): SceneMap => ({
  id: "map-1", name: "Plan", editGridMm: 20, doorMode: "story", rooms, tracks: [],
  floorPlan: { doors: [], furniture: [], walls: [] },
});
let seq = 0;
const ids = () => `s-${++seq}`;
const session = (map: SceneMap = emptyMap()) => createMapEditSession(map, ids);
// Drags a rectangle with the current tool (draw mode "rectangle").
function drag(s: MapEditSession, from: number, to: number) {
  s.strokeBegin(from);
  s.strokeMove(to);
  s.strokeEnd(to);
}
function paintRoom(s: MapEditSession, c0 = 0, r0 = 0, c1 = 9, r1 = 9) {
  s.setTool("room");
  s.addRegionOfTool();
  s.setDrawMode("rectangle");
  drag(s, cellIndex(c0, r0), cellIndex(c1, r1));
}
const track = (extras: Partial<Track>): Track => ({
  id: "t", kind: "human", name: "t", color: "#ffffff", muted: false, locked: false, actions: [], ...extras,
});

test("initial state: clean, no undo, first room selected", () => {
  const s = session(emptyMap(room("a", [0, 1])));
  assert.equal(s.isDirty(), false);
  assert.equal(s.canUndo(), false);
  assert.equal(s.canRedo(), false);
  assert.equal(s.selectedRoomId(), "a");
  assert.equal(s.mode(), "zoning");
  assert.equal(s.tool(), "room");
  assert.equal(s.stroke(), null);
  assert.equal(s.error(), null);
});

test("source map is never changed", () => {
  const source = emptyMap(room("a", rect(0, 0, 3, 3)));
  const before = structuredClone(source);
  const s = session(source);
  s.setDrawMode("rectangle");
  drag(s, cellIndex(5, 5), cellIndex(8, 8));
  s.setName("Other");
  s.setGrid(40);
  s.undo();
  assert.deepEqual(source, before);
});

test("a rectangle drag is one operation and undo/redo restores it", () => {
  const s = session();
  s.addRegionOfTool();
  s.setDrawMode("rectangle");
  const afterAdd = structuredClone(s.draft());
  s.strokeBegin(cellIndex(0, 0));
  s.strokeMove(cellIndex(2, 0));
  s.strokeMove(cellIndex(3, 2));
  assert.equal(s.stroke()?.cells.length, 12);
  assert.deepEqual(s.draft(), afterAdd);
  s.strokeEnd(cellIndex(3, 2));
  assert.equal(s.stroke(), null);
  assert.equal(s.draft().rooms[0].cells.length, 12);
  s.undo();
  assert.deepEqual(s.draft(), afterAdd);
  assert.equal(s.canRedo(), true);
  s.redo();
  assert.equal(s.draft().rooms[0].cells.length, 12);
});

test("brush strokes interpolate cells of fast drags", () => {
  const s = session();
  s.addRegionOfTool();
  s.strokeBegin(cellIndex(0, 5));
  s.strokeMove(cellIndex(40, 5));
  s.strokeEnd(cellIndex(40, 5));
  assert.equal(s.draft().rooms[0].cells.length, 41);
});

test("strokeCancel changes neither the draft nor the history", () => {
  const s = session();
  s.addRegionOfTool();
  s.setDrawMode("rectangle");
  const before = structuredClone(s.draft());
  s.strokeBegin(cellIndex(0, 0));
  s.strokeMove(cellIndex(4, 4));
  s.strokeCancel();
  assert.equal(s.stroke(), null);
  assert.deepEqual(s.draft(), before);
  s.undo();
  assert.equal(s.draft().rooms.length, 0);
  assert.equal(s.canUndo(), false);
});

test("undo during a drag only cancels the drag", () => {
  const s = session();
  s.addRegionOfTool();
  s.setDrawMode("rectangle");
  s.strokeBegin(cellIndex(0, 0));
  s.strokeMove(cellIndex(3, 3));
  s.undo();
  assert.equal(s.stroke(), null);
  assert.equal(s.draft().rooms.length, 1);
  assert.equal(s.canUndo(), true);
});

test("undo keeps 100 steps and drops the oldest at the 101st", () => {
  assert.equal(MAP_UNDO_LIMIT, 100);
  const s = session();
  for (let i = 0; i < 101; i++) s.setName(`name ${i}`);
  let steps = 0;
  while (s.canUndo()) { s.undo(); steps++; }
  assert.equal(steps, 100);
  assert.equal(s.draft().name, "name 0");
  assert.equal(s.isDirty(), true);
});

test("a new operation discards redo; an identical operation is not recorded", () => {
  const s = session();
  s.setName("a");
  s.setName("b");
  s.undo();
  assert.equal(s.canRedo(), true);
  s.setName("c");
  assert.equal(s.canRedo(), false);
  s.setName("c");
  s.undo();
  assert.equal(s.draft().name, "a");
});

test("isDirty returns to false when undo reaches the start", () => {
  const s = session();
  assert.equal(s.isDirty(), false);
  s.setName("changed");
  assert.equal(s.isDirty(), true);
  s.undo();
  assert.equal(s.isDirty(), false);
});

test("failed operations keep the draft and history and report a Japanese reason", () => {
  const s = session(emptyMap(room("a", rect(0, 0, 3, 3)), room("b", rect(5, 0, 8, 3))));
  s.setDrawMode("rectangle");
  s.selectRoom("b");
  const before = structuredClone(s.draft());
  drag(s, cellIndex(2, 1), cellIndex(6, 2));
  assert.match(s.error() ?? "", /重なっています/);
  assert.deepEqual(s.draft(), before);
  assert.equal(s.canUndo(), false);
  s.setTool("erase");
  drag(s, cellIndex(0, 0), cellIndex(3, 3));
  assert.match(s.error() ?? "", /最後のセル/);
  assert.deepEqual(s.draft(), before);
  assert.equal(s.canUndo(), false);
});

test("a successful operation clears the previous error", () => {
  const s = session(emptyMap(room("a", rect(0, 0, 3, 3))));
  s.setTool("erase");
  s.setDrawMode("rectangle");
  drag(s, cellIndex(0, 0), cellIndex(3, 3));
  assert.notEqual(s.error(), null);
  drag(s, cellIndex(0, 0), cellIndex(0, 0));
  assert.equal(s.error(), null);
});

test("a partition warning is cleared by the next action, whether it succeeds or fails", () => {
  const floor = () => session(emptyMap(room("floor", rect(0, 0, 30, 20))));
  const shortWall = (s: MapEditSession) => {
    s.setMode("room");
    s.setTool("partition");
    drag(s, cellIndex(5, 5), cellIndex(8, 5));
    assert.match(s.notice() ?? "", /安全円/);
  };
  const ok = floor();
  shortWall(ok);
  ok.deleteSelected();
  assert.equal(ok.error(), null);
  assert.equal(ok.notice(), null);
  const bad = floor();
  shortWall(bad);
  bad.setTool("select");
  bad.selectItem(null);
  bad.rotateSelected();
  assert.notEqual(bad.error(), null);
  assert.equal(bad.notice(), null);
});

test("a successful action clears a stale error", () => {
  const s = session(emptyMap(room("floor", rect(0, 0, 30, 20))));
  s.setMode("room");
  s.deleteSelected();
  assert.notEqual(s.error(), null);
  s.setTool("partition");
  drag(s, cellIndex(5, 5), cellIndex(15, 5));
  assert.equal(s.error(), null);
  s.setTool("select");
  s.rotateSelected();
  assert.notEqual(s.error(), null);
  s.deleteSelected();
  assert.equal(s.error(), null);
});

test("the region limit is reported without changing the map", () => {
  const rooms = Array.from({ length: 100 }, (_, i) => room(`r${i}`, [i]));
  const s = session(emptyMap(...rooms));
  s.addRegionOfTool();
  assert.match(s.error() ?? "", /100件/);
  assert.equal(s.draft().rooms.length, 100);
  assert.equal(s.canUndo(), false);
});

test("changing the tool drops a drag in progress", () => {
  const s = session();
  s.addRegionOfTool();
  s.setDrawMode("rectangle");
  s.strokeBegin(cellIndex(0, 0));
  s.strokeMove(cellIndex(3, 3));
  s.setTool("erase");
  assert.equal(s.stroke(), null);
  s.strokeEnd(cellIndex(3, 3));
  assert.equal(s.draft().rooms[0].cells.length, 0);
});

test("the mode decides the tool: room mode selects, zoning follows the region kind", () => {
  const s = session(emptyMap(room("c", [0, 1], { kind: "corridor" })));
  s.setMode("room");
  assert.equal(s.tool(), "select");
  s.setMode("zoning");
  assert.equal(s.tool(), "corridor");
  s.setTool("door");
  assert.equal(s.mode(), "room");
  s.setTool("elevator");
  assert.equal(s.mode(), "zoning");
});

test("the elevator tool creates a waiting region; the entrance drag commits it", () => {
  const s = session(emptyMap(room("hall", rect(0, 0, 30, 10), { kind: "corridor" })));
  s.setTool("elevator");
  assert.equal(s.draft().rooms.length, 2);
  assert.equal(s.draft().rooms[1].appearance, "elevator");
  s.setTool("elevator");
  assert.equal(s.draft().rooms.length, 2);
  s.setDoorCells(7);
  s.setEntrance("bottom");
  s.strokeBegin(cellIndex(2, 3));
  s.strokeMove(cellIndex(2, 8));
  assert.equal(s.stroke()?.invalid, false);
  assert.equal(s.stroke()?.cells.length, 7 * 6);
  s.strokeEnd(cellIndex(2, 8));
  assert.equal(s.error(), null);
  assert.equal(s.draft().rooms[1].cells.length, 42);
  assert.equal(s.draft().rooms[1].entranceEdge, "bottom");
  assert.equal(s.tool(), "room");
  assert.equal(s.draft().floorPlan?.doors.length, 7);
  s.undo();
  assert.equal(s.draft().rooms[1].cells.length, 0);
});

test("an elevator drag that cannot fit is marked invalid and commits nothing", () => {
  const s = session(emptyMap(room("hall", rect(0, 0, 30, 10), { kind: "corridor" })));
  s.setTool("elevator");
  s.setDoorCells(12);
  s.strokeBegin(cellIndex(50, 3));
  assert.equal(s.stroke()?.invalid, true);
  assert.match(s.error() ?? "", /入口幅12マス/);
  const rooms = structuredClone(s.draft().rooms);
  s.strokeEnd(cellIndex(50, 3));
  assert.deepEqual(s.draft().rooms, rooms);
  assert.match(s.error() ?? "", /入口幅12マス/);
  assert.equal(s.stroke(), null);
});

test("door width is limited to 7-12 cells", () => {
  const s = session();
  for (const width of [6, 13, 7.5]) {
    s.setDoorCells(width);
    assert.notEqual(s.error(), null);
    assert.equal(s.doorCells(), 10);
  }
  s.setDoorCells(7);
  assert.equal(s.doorCells(), 7);
  assert.equal(s.error(), null);
});

test("the edit grid changes through the session as an edit", () => {
  const s = session(emptyMap(room("a", [0])));
  s.setGrid(40);
  assert.equal(s.draft().editGridMm, 40);
  assert.equal(s.canUndo(), true);
  s.setGrid(30);
  assert.notEqual(s.error(), null);
  assert.equal(s.draft().editGridMm, 40);
  s.setTool("room");
  s.strokeBegin(cellIndex(10, 10));
  assert.equal(s.stroke()?.cells.length, 4);
  s.strokeCancel();
});

test("gate: width snaps to the selected entrance width and places walls and a door", () => {
  const s = session(emptyMap(room("floor", rect(0, 0, 30, 20))));
  s.setMode("room");
  s.setTool("gate");
  s.setDoorCells(8);
  s.setEntrance("bottom");
  drag(s, cellIndex(5, 5), cellIndex(5, 9));
  assert.equal(s.error(), null);
  assert.equal(s.draft().floorPlan?.walls?.length, 3);
  assert.equal(s.draft().floorPlan?.doors.length, 1);
  assert.equal(s.selectedItemId(), s.draft().floorPlan?.doors[0].id);
  s.deleteSelected();
  assert.equal(s.draft().floorPlan?.walls?.length, 0);
  assert.equal(s.draft().floorPlan?.doors.length, 0);
});

test("partition wall: a short wall places with a warning that clears on the next action", () => {
  const s = session(emptyMap(room("floor", rect(0, 0, 30, 20))));
  s.setMode("room");
  s.setTool("partition");
  drag(s, cellIndex(5, 5), cellIndex(8, 5));
  assert.equal(s.draft().floorPlan?.walls?.length, 1);
  assert.match(s.notice() ?? "", /安全円/);
  drag(s, cellIndex(10, 8), cellIndex(20, 8));
  assert.equal(s.draft().floorPlan?.walls?.length, 2);
  assert.equal(s.notice(), null);
  drag(s, cellIndex(3, 3), cellIndex(3, 3));
  assert.equal(s.draft().floorPlan?.walls?.length, 2);
  assert.match(s.error() ?? "", /2セル以上/);
});

test("furniture: place, rotate with undo, then delete", () => {
  const s = session(emptyMap(room("floor", rect(0, 5, 9, 14))));
  s.setMode("room");
  s.setTool("furniture");
  s.setDrawMode("rectangle");
  drag(s, cellIndex(0, 12), cellIndex(2, 13));
  const id = s.selectedItemId();
  assert.ok(id);
  const before = structuredClone(s.draft());
  s.setSelectedRotation(90);
  assert.equal(s.draft().floorPlan?.furniture[0].rotation, 90);
  s.setSelectedRotation(180);
  s.rotateSelected();
  assert.equal(s.draft().floorPlan?.furniture[0].rotation, 270);
  s.undo();
  s.undo();
  s.undo();
  assert.deepEqual(s.draft(), before);
  s.deleteSelected();
  assert.equal(s.draft().floorPlan?.furniture.length, 0);
  assert.equal(s.selectedItemId(), null);
});

test("furniture: a rotation that leaves the map is rejected and the state is kept", () => {
  // Rotation pivots on the footprint's top-left corner (upstream behaviour), so a piece on the bottom edge cannot turn.
  const s = session(emptyMap(room("floor", rect(0, 0, 4, 1))));
  s.setMode("room");
  s.setTool("furniture");
  s.setDrawMode("rectangle");
  drag(s, cellIndex(0, 0), cellIndex(2, 1));
  const before = structuredClone(s.draft());
  s.rotateSelected();
  assert.match(s.error() ?? "", /領域|地図/);
  assert.deepEqual(s.draft(), before);
  s.setSelectedRotation(90);
  assert.notEqual(s.error(), null);
  assert.equal(s.draft().floorPlan?.furniture[0].rotation, 0);
});

test("operations on a missing selection report what to do", () => {
  const s = session(emptyMap(room("floor", rect(0, 0, 4, 4))));
  s.setMode("room");
  s.rotateSelected();
  assert.match(s.error() ?? "", /「選択」/);
  s.deleteSelected();
  assert.match(s.error() ?? "", /「選択」/);
  s.renameSelected("x");
  assert.match(s.error() ?? "", /「選択」/);
  s.setSelectedDoorKind("flapper");
  assert.match(s.error() ?? "", /「選択」/);
  assert.equal(s.canUndo(), false);
});

test("pick selects furniture under the cell and the room that contains it", () => {
  const s = session(emptyMap(room("a", rect(0, 0, 4, 4)), room("b", rect(10, 0, 14, 4))));
  s.setMode("room");
  s.setTool("furniture");
  s.selectRoom("b");
  s.setDrawMode("rectangle");
  drag(s, cellIndex(11, 1), cellIndex(12, 2));
  const id = s.selectedItemId();
  s.setTool("select");
  s.pick(cellIndex(2, 2));
  assert.equal(s.selectedItemId(), null);
  assert.equal(s.selectedRoomId(), "a");
  s.pick(cellIndex(12, 2));
  assert.equal(s.selectedItemId(), id);
  assert.equal(s.selectedRoomId(), "b");
});

test("undo of an added region moves the selection to an existing region", () => {
  const s = session(emptyMap(room("a", [0, 1])));
  s.addRegionOfTool();
  const added = s.selectedRoomId();
  assert.notEqual(added, "a");
  s.undo();
  assert.equal(s.selectedRoomId(), "a");
});

test("region settings and deletion go through the session", () => {
  const s = session(emptyMap(room("a", [0, 1]), room("b", [5, 6])));
  s.selectRoom("b");
  s.setRoomProps({ name: "Meeting", material: "wood" });
  assert.equal(s.draft().rooms[1].name, "Meeting");
  s.deleteRegion();
  assert.equal(s.draft().rooms.length, 1);
  assert.equal(s.selectedRoomId(), "a");
  s.deleteRegion();
  assert.match(s.error() ?? "", /最後の領域/);
  assert.equal(s.draft().rooms.length, 1);
});

test("subscribe notifies on changes and stops after unsubscribe", () => {
  const s = session();
  let count = 0;
  const off = s.subscribe(() => count++);
  const v = s.version();
  s.setName("x");
  assert.ok(count > 0);
  assert.ok(s.version() > v);
  off();
  const seen = count;
  s.setName("y");
  assert.equal(count, seen);
});

test("hoverDoor does not notify when the preview is unchanged", () => {
  const s = session(emptyMap(room("floor", rect(0, 0, 30, 20))));
  s.setMode("room");
  s.setTool("door");
  s.setDoorCells(7);
  let count = 0;
  s.subscribe(() => count++);
  s.hoverDoor(300, 0, 24);
  const first = count;
  assert.ok(first > 0);
  assert.ok(s.doorPreview());
  s.hoverDoor(300, 0, 24);
  assert.equal(count, first);
  s.hoverDoor(300, 300, 5);
  assert.equal(s.doorPreview(), null);
});

test("placeDoorAt places a door of the selected width and selects it", () => {
  const s = session(emptyMap(room("floor", rect(0, 0, 30, 20))));
  s.setMode("room");
  s.setTool("door");
  s.setDoorCells(7);
  s.placeDoorAt(300, 0, 24);
  assert.equal(s.error(), null);
  assert.equal(s.draft().floorPlan?.doors.length, 7);
  assert.ok(s.selectedItemId());
  s.setSelectedDoorKind("flapper");
  assert.ok(s.draft().floorPlan?.doors.every((door) => door.kind === "flapper"));
  s.renameSelected("Main");
  assert.ok(s.draft().floorPlan?.doors.every((door) => door.name === "Main"));
  s.placeDoorAt(5000, 5000, 24);
  assert.match(s.error() ?? "", /壁の近く/);
});

test("result: rejects a drag in progress, bad names, empty maps and empty regions", () => {
  const s = session(emptyMap(room("a", [0, 1])));
  s.addRegionOfTool();
  s.setDrawMode("rectangle");
  s.strokeBegin(cellIndex(10, 10));
  assert.deepEqual(s.result(), { ok: false, error: "ドラッグを終了してから適用してください。" });
  s.strokeCancel();
  assert.deepEqual(s.result(), { ok: false, error: "「部屋 2」を1セル以上描いてください。" });
  s.undo();
  s.setName("   ");
  assert.deepEqual(s.result(), { ok: false, error: "マップ名を入力してください。" });
  s.setName("あ".repeat(121));
  const tooLong = s.result();
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.ok ? "" : tooLong.error, /120文字/);
  s.setName("あ".repeat(120));
  assert.equal(s.result().ok, true);
  const none = session(emptyMap());
  assert.deepEqual(none.result(), { ok: false, error: "1つ以上の領域を描いてください。" });
  assert.equal(none.error(), "1つ以上の領域を描いてください。");
});

test("result: returns a trimmed copy that later edits do not change", () => {
  const s = session(emptyMap(room("a", [0, 1])));
  s.setName("  Floor 1  ");
  const first = s.result();
  assert.ok(first.ok);
  assert.equal(s.draft().name, "  Floor 1  ");
  assert.notEqual(first.map, s.draft());
  first.map.rooms[0].cells.push(99);
  assert.deepEqual(s.draft().rooms[0].cells, [0, 1]);
  first.map.rooms[0].cells.pop();
  const snapshot = structuredClone(first.map);
  assert.equal(first.map.name, "Floor 1");
  s.setName("Other");
  s.setGrid(60);
  assert.deepEqual(first.map, snapshot);
});

test("result: new regions get room tracks, renamed regions rename their tracks", () => {
  const source = emptyMap(room("hall", rect(0, 0, 5, 5), { name: "Hall" }));
  source.tracks = [
    track({ id: "t-hall", kind: "room", name: "Hall", roomId: "hall", color: "#111111" }),
    track({ id: "t-custom", kind: "room", name: "My name", roomId: "hall" }),
  ];
  const s = session(source);
  s.selectRoom("hall");
  s.setRoomProps({ name: "Lobby" });
  s.setTool("room");
  s.addRegionOfTool();
  s.setDrawMode("rectangle");
  drag(s, cellIndex(10, 0), cellIndex(12, 2));
  const result = s.result();
  assert.ok(result.ok);
  const rooms = result.map.tracks.filter((t) => t.kind === "room");
  assert.equal(rooms.length, 3);
  assert.equal(rooms.find((t) => t.id === "t-hall")?.name, "Lobby");
  assert.equal(rooms.find((t) => t.id === "t-custom")?.name, "My name");
  const added = result.map.rooms[1];
  const created = rooms.find((t) => t.roomId === added.id);
  assert.ok(created);
  assert.equal(created.name, added.name);
  assert.equal(created.color, added.color);
  assert.equal(source.tracks.length, 2);
  assert.equal(validateProject({ schema: "fleet-scene/v1", name: "p", maps: [result.map] }).maps.length, 1);
});

test("result: refuses when the new region's track would exceed 128 tracks", () => {
  const source = emptyMap(room("a", [0, 1]));
  source.tracks = Array.from({ length: 128 }, (_, i) => track({ id: `t${i}`, name: `T${i}` }));
  const s = session(source);
  assert.equal(s.result().ok, true);
  s.addRegionOfTool();
  s.setDrawMode("rectangle");
  drag(s, cellIndex(10, 10), cellIndex(11, 11));
  const result = s.result();
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /128本/);
  assert.equal(source.tracks.length, 128);
});

test("toJapanese keeps Japanese, translates known validator messages, wraps the rest", () => {
  assert.equal(toJapanese(new Error("すでに日本語です。")), "すでに日本語です。");
  assert.match(toJapanese(new Error("click near a wall")), /壁の近く/);
  assert.match(toJapanese(new Error("automatic doors need a continuous 7-cell (140mm) wall")), /7マス\(140mm\)/);
  assert.match(toJapanese(new Error("only one furniture item per cell")), /重なって/);
  assert.match(toJapanese(new Error("something unknown")), /この操作はできません。\(something unknown\)/);
  assert.match(toJapanese("plain string"), /plain string/);
});
