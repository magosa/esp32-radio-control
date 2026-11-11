import test from "node:test";
import assert from "node:assert/strict";
import { cellIndex } from "../../scene/grid";
import {
  MAX_ROOMS, REGION_COLORS, addRegion, commitElevator, dropInvalidFixtures, eraseCells, paintCells,
  removeRegionChecked, setRoomProps,
} from "../../scene/mapEditRegions";
import type { Room, SceneMap, Track } from "../../scene/types";

const room = (id: string, cells: number[], extras: Partial<Room> = {}): Room => ({
  id, name: id, color: "#739a81", kind: "room", material: "concrete", cells: [...cells], ...extras,
});
const map = (...rooms: Room[]): SceneMap => ({
  id: "map", name: "Plan", editGridMm: 20, doorMode: "story", rooms, tracks: [],
  floorPlan: { doors: [], furniture: [], walls: [] },
});
const rect = (c0: number, r0: number, c1: number, r1: number) => {
  const cells: number[] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(cellIndex(c, r));
  return cells;
};
let seq = 0;
const ids = () => `id-${++seq}`;
const track = (extras: Partial<Track>): Track => ({
  id: "t", kind: "human", name: "t", color: "#fff", muted: false, locked: false, actions: [], ...extras,
});
const action = (roomId: string) => ({
  id: "a", name: "a", type: "move" as const, position: 0, runSeconds: 1, x: 0, y: 0, yaw: 0,
  roomId, targetId: "", text: "", state: "meeting" as const,
});
// Runs fn and asserts the input map is deep-equal to its pre-call clone.
function pure<T>(input: SceneMap, fn: (m: SceneMap) => T): T {
  const before = structuredClone(input);
  try { return fn(input); } finally { assert.deepEqual(input, before); }
}
const failPure = (input: SceneMap, fn: (m: SceneMap) => unknown, message: string | RegExp) =>
  pure(input, (m) => assert.throws(() => fn(m), typeof message === "string" ? { message } : { message }));

test("addRegion names, colours and defaults", () => {
  let m = map();
  const kinds = ["room", "corridor", "elevator", "room", "room", "room"] as const;
  const names = ["部屋 1", "廊下 2", "エレベーター 3", "部屋 4", "部屋 5", "部屋 6"];
  for (const kind of kinds) {
    const before = m;
    const r = pure(before, (x) => addRegion(x, kind, ids));
    m = r.map;
    // Elevator placeholders block the next add, so fill it first.
    if (kind === "elevator") m.rooms[m.rooms.length - 1].cells = [0];
  }
  assert.deepEqual(m.rooms.map((x) => x.name), names);
  assert.deepEqual(m.rooms.map((x) => x.color), [...REGION_COLORS, REGION_COLORS[0]]);
  assert.equal(m.rooms[1].kind, "corridor");
  assert.equal(m.rooms[1].material, "tile");
  assert.equal(m.rooms[0].kind, "room");
  assert.equal(m.rooms[0].material, "concrete");
  assert.equal(m.rooms[0].appearance, undefined);
  assert.equal(m.rooms[2].appearance, "elevator");
  assert.equal(m.rooms[2].kind, "room");
  assert.deepEqual(m.rooms[0].cells, []);
});

test("addRegion returns the new room id", () => {
  const { map: m, roomId } = addRegion(map(), "room", () => "fixed");
  assert.equal(roomId, "fixed");
  assert.equal(m.rooms[0].id, "fixed");
});

test("addRegion enforces the 100 region limit", () => {
  assert.equal(MAX_ROOMS, 100);
  let m = map();
  for (let i = 0; i < 100; i++) m = addRegion(m, "room", ids).map;
  assert.equal(m.rooms.length, 100);
  failPure(m, (x) => addRegion(x, "room", ids), "領域は100件までです。");
});

test("addRegion does not duplicate an empty elevator placeholder", () => {
  const first = addRegion(map(), "elevator", ids);
  const again = pure(first.map, (x) => addRegion(x, "elevator", ids));
  assert.equal(again.roomId, first.roomId);
  assert.deepEqual(again.map, first.map);
  assert.equal(again.map.rooms.length, 1);
  const other = pure(first.map, (x) => addRegion(x, "room", ids));
  assert.equal(other.roomId, first.roomId);
});

test("paintCells fills an empty region and sorts and dedupes", () => {
  const m = map(room("a", []));
  const r = pure(m, (x) => paintCells(x, "a", [5, 3, 5, 4], "room"));
  assert.deepEqual(r.rooms[0].cells, [3, 4, 5]);
  const r2 = paintCells(r, "a", [4, 10], "room");
  assert.deepEqual(r2.rooms[0].cells, [3, 4, 5, 10]);
});

test("paintCells accepts the top row and right column", () => {
  const m = map(room("a", []));
  const top = cellIndex(10, 30), right = cellIndex(54, 12), corner = 1704;
  const r = paintCells(m, "a", [top, right, corner], "room");
  assert.deepEqual(r.rooms[0].cells, [right, top, corner].sort((a, b) => a - b));
});

test("paintCells applies the kind", () => {
  const r = paintCells(map(room("a", [])), "a", [1], "corridor");
  assert.equal(r.rooms[0].kind, "corridor");
});

test("paintCells rejects unknown rooms, overlap and bad cells", () => {
  const m = map(room("a", [1]), room("b", [2, 3]));
  failPure(m, (x) => paintCells(x, "zz", [9], "room"), "先に「新しい領域」を追加してください。");
  failPure(m, (x) => paintCells(x, "a", [3, 9], "room"),
    "別の領域と重なっています。消しゴムで空けるか別のセルを選んでください。");
  for (const bad of [-1, 1705, 1.5, NaN]) failPure(m, (x) => paintCells(x, "a", [bad], "room"), "セルが範囲外です。");
});

test("paintCells lets an elevator cut part of a corridor", () => {
  const corridor = room("c", rect(0, 5, 20, 10), { kind: "corridor" });
  const m = map(corridor, room("e", [], { appearance: "elevator" }));
  const cut = rect(2, 6, 8, 8);
  const r = pure(m, (x) => paintCells(x, "e", cut, "room"));
  const c = r.rooms.find((x) => x.id === "c")!;
  assert.equal(c.cells.length, corridor.cells.length - cut.length);
  assert.ok(cut.every((cell) => !c.cells.includes(cell)));
  assert.deepEqual(r.rooms.find((x) => x.id === "e")!.cells, [...cut].sort((a, b) => a - b));
});

test("paintCells rejects elevator over a whole corridor or another room", () => {
  const msg = "別の領域と重なっています。消しゴムで空けるか別のセルを選んでください。";
  const whole = map(room("c", [1, 2], { kind: "corridor" }), room("e", [], { appearance: "elevator" }));
  failPure(whole, (x) => paintCells(x, "e", [1, 2, 3], "room"), msg);
  const other = map(room("r", [1, 2]), room("e", [], { appearance: "elevator" }));
  failPure(other, (x) => paintCells(x, "e", [1], "room"), msg);
  const mixed = map(room("c", [1, 2, 3], { kind: "corridor" }), room("r", [10]), room("e", [], { appearance: "elevator" }));
  failPure(mixed, (x) => paintCells(x, "e", [1, 10], "room"), msg);
});

test("paintCells drops furniture on cells carved out of a corridor", () => {
  const m = map(room("c", [1, 2, 3], { kind: "corridor" }), room("e", [], { appearance: "elevator" }));
  m.floorPlan!.furniture.push(
    { id: "f1", roomId: "c", cell: 1, type: "desk", rotation: 0 },
    { id: "f2", roomId: "c", cell: 3, type: "desk", rotation: 0 },
  );
  const r = pure(m, (x) => paintCells(x, "e", [1], "room"));
  assert.deepEqual(r.floorPlan!.furniture.map((x) => x.id), ["f2"]);
});

test("eraseCells erases across rooms", () => {
  const m = map(room("a", [1, 2, 3]), room("b", [10, 11, 12]));
  const r = pure(m, (x) => eraseCells(x, [2, 11, 999]));
  assert.deepEqual(r.rooms[0].cells, [1, 3]);
  assert.deepEqual(r.rooms[1].cells, [10, 12]);
});

test("eraseCells refuses to empty a room and changes nothing", () => {
  const m = map(room("a", [1, 2, 3]), room("b", [10]));
  const msg = "「b」の最後のセルは消せません。参照保護のため領域を維持します。";
  pure(m, (x) => assert.throws(() => eraseCells(x, [2, 10]), { message: msg }));
  assert.deepEqual(m.rooms[0].cells, [1, 2, 3]);
  assert.deepEqual(m.rooms[1].cells, [10]);
});

test("eraseCells ignores cells in no room and allows empty rooms", () => {
  const m = map(room("a", [1, 2]), room("empty", []));
  const r = pure(m, (x) => eraseCells(x, [500, 600]));
  assert.deepEqual(r, m);
});

test("eraseCells drops furniture and doors that lose their footing", () => {
  const m = map(room("a", [1, 2, 3]));
  m.floorPlan!.furniture.push(
    { id: "f1", roomId: "a", cell: 1, type: "desk", rotation: 0 },
    { id: "f2", roomId: "a", cell: 3, type: "chair", rotation: 0 },
  );
  m.floorPlan!.doors.push({ id: "d1", roomId: "a", cell: 3, edge: "right" });
  const r = pure(m, (x) => eraseCells(x, [1, 3]));
  assert.deepEqual(r.rooms[0].cells, [2]);
  assert.equal(r.floorPlan!.furniture.length, 0);
  assert.equal(r.floorPlan!.doors.length, 0);
});

test("dropInvalidFixtures counts removals and keeps valid items", () => {
  const m = map(room("a", [1, 2, 3, 4]), room("b", [20]));
  const fp = m.floorPlan!;
  fp.furniture.push(
    { id: "ok", roomId: "a", cell: 1, type: "desk", rotation: 0 },
    { id: "multi", roomId: "a", cell: 3, cells: [3, 4], type: "desk", rotation: 0 },
    { id: "out", roomId: "a", cell: 20, type: "plant", rotation: 0 },
    { id: "nomulti", roomId: "b", cell: 20, cells: [20, 21], type: "desk", rotation: 0 },
    { id: "noroom", roomId: "zz", cell: 1, type: "plant", rotation: 0 },
  );
  fp.walls!.push({ id: "w", roomId: "a", x1: 0, y1: 0, x2: 40, y2: 0 });
  fp.doors.push(
    { id: "d-edge", roomId: "a", cell: 1, edge: "left" },
    { id: "d-inner", roomId: "a", cell: 2, edge: "top" },
    { id: "d-inner2", roomId: "a", cell: 2, edge: "right" },
    { id: "d-wall", roomId: "a", wallId: "w", x1: 0, y1: 0, x2: 40, y2: 0, kind: "automatic" },
    { id: "d-nowall", roomId: "a", wallId: "gone", x1: 0, y1: 0, x2: 40, y2: 0, kind: "automatic" },
    { id: "d-noroom", roomId: "zz", cell: 1, edge: "left" },
  );
  const before = structuredClone(m);
  const r = dropInvalidFixtures(m);
  assert.deepEqual(m, before);
  assert.deepEqual(r.map.floorPlan!.furniture.map((x) => x.id), ["ok", "multi"]);
  assert.deepEqual(r.map.floorPlan!.doors.map((x) => x.id), ["d-edge", "d-inner", "d-wall"]);
  assert.equal(r.map.floorPlan!.walls!.length, 1);
  assert.equal(r.removed, 3 + 3);
});

test("dropInvalidFixtures works without a floor plan", () => {
  const m = map(room("a", [1]));
  delete m.floorPlan;
  const r = dropInvalidFixtures(m);
  assert.equal(r.removed, 0);
  assert.equal(r.map.rooms.length, 1);
});

test("setRoomProps validates and applies", () => {
  const m = map(room("a", [1]));
  const r = pure(m, (x) => setRoomProps(x, "a", { name: "  新館  ", kind: "corridor", material: "wood", color: "#ABCDEF" }));
  assert.equal(r.rooms[0].name, "新館");
  assert.equal(r.rooms[0].kind, "corridor");
  assert.equal(r.rooms[0].material, "wood");
  assert.equal(r.rooms[0].color, "#ABCDEF");
  const nameMsg = "領域名は1〜120文字で入力してください。";
  failPure(m, (x) => setRoomProps(x, "a", { name: "" }), nameMsg);
  failPure(m, (x) => setRoomProps(x, "a", { name: "   " }), nameMsg);
  failPure(m, (x) => setRoomProps(x, "a", { name: "あ".repeat(121) }), nameMsg);
  assert.equal(setRoomProps(m, "a", { name: "あ".repeat(120) }).rooms[0].name.length, 120);
  failPure(m, (x) => setRoomProps(x, "a", { color: "red" }), "色は#rrggbb形式で指定してください。");
  failPure(m, (x) => setRoomProps(x, "zz", { name: "x" }), "領域が見つかりません。");
  assert.throws(() => setRoomProps(m, "a", { kind: "bogus" as never }));
  assert.throws(() => setRoomProps(m, "a", { material: "glass" as never }));
});

test("removeRegionChecked rejects referenced, last and unknown rooms", () => {
  const msg = "この領域はトラックまたは動作から参照されているため削除できません。";
  const two = (t: Track) => ({ ...map(room("a", [1]), room("b", [2])), tracks: [t] });
  failPure(two(track({ roomId: "a" })), (x) => removeRegionChecked(x, "a"), msg);
  failPure(two(track({ initial: { x: 0, y: 0, yaw: 0, roomId: "a" } })), (x) => removeRegionChecked(x, "a"), msg);
  failPure(two(track({ actions: [action("a")] })), (x) => removeRegionChecked(x, "a"), msg);
  failPure(map(room("a", [1])), (x) => removeRegionChecked(x, "a"), "最後の領域は削除できません。");
  failPure(map(room("a", [1]), room("b", [2])), (x) => removeRegionChecked(x, "zz"), "削除する領域を選択してください。");
});

test("removeRegionChecked removes the room and its fixtures", () => {
  const m = map(room("a", [1, 2]), room("b", [10]));
  const fp = m.floorPlan!;
  fp.furniture.push({ id: "f", roomId: "a", cell: 1, type: "desk", rotation: 0 }, { id: "g", roomId: "b", cell: 10, type: "desk", rotation: 0 });
  fp.walls!.push({ id: "w", roomId: "a", x1: 0, y1: 0, x2: 40, y2: 0 });
  fp.doors.push({ id: "d", roomId: "a", cell: 1, edge: "left" }, { id: "dw", roomId: "a", wallId: "w", x1: 0, y1: 0, x2: 40, y2: 0 });
  const r = pure(m, (x) => removeRegionChecked(x, "a"));
  assert.deepEqual(r.rooms.map((x) => x.id), ["b"]);
  assert.deepEqual(r.floorPlan!.furniture.map((x) => x.id), ["g"]);
  assert.equal(r.floorPlan!.walls!.length, 0);
  assert.equal(r.floorPlan!.doors.length, 0);
});

function elevatorMap() {
  const m = map(room("c", rect(0, 2, 54, 28), { kind: "corridor" }));
  return addRegion(m, "elevator", ids);
}

test("commitElevator accepts widths 7 and 12 on a big corridor", () => {
  for (const width of [7, 12]) {
    const { map: m, roomId } = elevatorMap();
    const wide = rect(10, 10, 10 + width - 1, 14);
    const r = pure(m, (x) => commitElevator(x, roomId, wide, "bottom", width, ids));
    const e = r.rooms.find((x) => x.id === roomId)!;
    assert.deepEqual(e.cells, wide);
    assert.equal(e.entranceEdge, "bottom");
    assert.equal(r.floorPlan!.doors.length, width);
    const c = r.rooms.find((x) => x.id === "c")!;
    assert.equal(c.cells.length, 55 * 27 - wide.length);
  }
});

test("commitElevator rejects widths outside 7..12", () => {
  const msg = "入口幅は7〜12マスで指定してください。";
  for (const width of [6, 13]) {
    const { map: m, roomId } = elevatorMap();
    failPure(m, (x) => commitElevator(x, roomId, rect(10, 10, 9 + width, 14), "bottom", width, ids), msg);
  }
});

test("commitElevator rejects a rectangle that mismatches the declared width", () => {
  const { map: m, roomId } = elevatorMap();
  failPure(m, (x) => commitElevator(x, roomId, rect(10, 10, 16, 14), "bottom", 8, ids), "入口幅が指定と一致しません。");
  failPure(m, (x) => commitElevator(x, roomId, rect(10, 10, 14, 16), "left", 8, ids), "入口幅が指定と一致しません。");
});

test("commitElevator translates placement failures", () => {
  const { map: m, roomId } = elevatorMap();
  const msgs = new Set<string>();
  const grab = (fn: () => unknown) => {
    try { fn(); } catch (e) { msgs.add((e as Error).message); assert.match((e as Error).message, /[^\x00-\x7f]/); }
  };
  // Not a rectangle: L shape with 7 wide base.
  grab(() => commitElevator(m, roomId, [...rect(10, 10, 16, 11), cellIndex(10, 12)], "bottom", 7, ids));
  // Over a whole corridor.
  const small = addRegion(map(room("c", rect(10, 10, 16, 14), { kind: "corridor" })), "elevator", ids);
  grab(() => commitElevator(small.map, small.roomId, rect(10, 10, 16, 14), "bottom", 7, ids));
  // Not an elevator region.
  grab(() => commitElevator(m, "c", rect(10, 10, 16, 14), "bottom", 7, ids));
  assert.equal(msgs.size, 3);
});
