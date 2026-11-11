import test from "node:test";
import assert from "node:assert/strict";
import { cellIndex } from "../../scene/grid";
import { hitItem } from "../../scene/mapEditHit";
import { statusText } from "../../scene/mapEditStatus";
import type { MapStroke } from "../../scene/mapEditSession";
import type { Room, SceneMap } from "../../scene/types";

const rect = (c0: number, r0: number, c1: number, r1: number) => {
  const cells: number[] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(cellIndex(c, r));
  return cells;
};
const room = (id: string, cells: number[], extras: Partial<Room> = {}): Room => ({
  id, name: id, color: "#739a81", kind: "room", material: "concrete", cells, ...extras,
});
const base = (): SceneMap => ({
  id: "m", name: "P", editGridMm: 20, doorMode: "story", tracks: [],
  rooms: [room("floor", rect(0, 0, 30, 20))],
  floorPlan: {
    doors: [], furniture: [], walls: [],
  },
});

test("hitItem finds furniture by cell, walls and charging zones by position", () => {
  const map = base();
  map.floorPlan!.furniture.push({ id: "desk", roomId: "floor", cell: cellIndex(5, 5), cells: rect(5, 5, 6, 6), type: "desk", rotation: 0 });
  map.floorPlan!.walls!.push({ id: "wall", roomId: "floor", x1: 210, y1: 210, x2: 410, y2: 210 });
  map.floorPlan!.chargingZones = [{ id: "charge", name: "CHARGING 1", x: 500, y: 100, width: 60, height: 40 }];
  assert.equal(hitItem(map, 110, 110, 10), "desk");
  assert.equal(hitItem(map, 300, 214, 10), "wall");
  assert.equal(hitItem(map, 300, 230, 10), null);
  assert.equal(hitItem(map, 520, 120, 10), "charge");
  assert.equal(hitItem(map, 570, 120, 10), null);
  assert.equal(hitItem(map, 1000, 400, 10), null);
});

test("hitItem prefers a door over the wall it lies on and selects a merged opening as one item", () => {
  const map = base();
  map.floorPlan!.walls!.push({ id: "wall", roomId: "floor", x1: 100, y1: 300, x2: 500, y2: 300 });
  map.floorPlan!.doors.push({ id: "door", roomId: "floor", wallId: "wall", kind: "automatic", x1: 200, y1: 300, x2: 340, y2: 300 });
  assert.equal(hitItem(map, 260, 302, 10), "door");
  assert.equal(hitItem(map, 420, 302, 10), "wall");
});

test("hitItem tolerance is respected on both sides", () => {
  const map = base();
  map.floorPlan!.walls!.push({ id: "wall", roomId: "floor", x1: 100, y1: 300, x2: 500, y2: 300 });
  assert.equal(hitItem(map, 300, 309, 10), "wall");
  assert.equal(hitItem(map, 300, 310, 10), "wall");
  assert.equal(hitItem(map, 300, 311, 10), null);
  assert.equal(hitItem(map, 505, 300, 10), "wall");
  assert.equal(hitItem(map, 520, 300, 10), null);
});

test("hitItem picks the nearest of several walls in reach, whatever their order", () => {
  const map = base();
  map.floorPlan!.walls!.push(
    { id: "far", roomId: "floor", x1: 100, y1: 300, x2: 500, y2: 300 },
    { id: "near", roomId: "floor", x1: 100, y1: 306, x2: 500, y2: 306 },
  );
  assert.equal(hitItem(map, 300, 305, 10), "near");
  assert.equal(hitItem(map, 300, 301, 10), "far");
  map.floorPlan!.walls!.reverse();
  assert.equal(hitItem(map, 300, 305, 10), "near");
  assert.equal(hitItem(map, 300, 301, 10), "far");
});

test("hitItem selects multi-cell furniture from any of its cells, not only the first", () => {
  const map = base();
  map.floorPlan!.furniture.push({ id: "desk", roomId: "floor", cell: cellIndex(5, 5), cells: rect(5, 5, 7, 6), type: "desk", rotation: 0 });
  for (const [col, row] of [[5, 5], [7, 5], [5, 6], [7, 6], [6, 5]]) {
    assert.equal(hitItem(map, col * 20 + 10, row * 20 + 10, 4), "desk", `cell ${col},${row}`);
  }
  assert.equal(hitItem(map, 8 * 20 + 10, 5 * 20 + 10, 4), null);
  assert.equal(hitItem(map, 5 * 20 + 10, 7 * 20 + 10, 4), null);
});

const session = (map: SceneMap, over: Partial<Parameters<typeof statusText>[0]> = {}) => ({
  map, selectedRoomId: "floor", selectedItemId: null, stroke: null as MapStroke | null, ...over,
});

test("statusText summarises regions, cells and the selected region", () => {
  const map = base();
  map.rooms.push(room("b", [900, 901]));
  assert.equal(statusText(session(map)), "2 領域 / 653 セル　·　floor: 651 セル");
  assert.equal(statusText(session(map, { selectedRoomId: null })), "2 領域 / 653 セル　·　「新しい領域」を追加してください");
  assert.equal(statusText(session(base(), { selectedItemId: "x" })), "1 領域 / 651 セル　·　floor: 651 セル　·　配置物を選択中");
});

test("statusText shows the size of a furniture stroke or selected furniture", () => {
  const map = base();
  map.floorPlan!.furniture.push({ id: "desk", roomId: "floor", cell: cellIndex(5, 5), cells: rect(5, 5, 7, 6), type: "desk", rotation: 0 });
  const withStroke = statusText(session(map, { stroke: { tool: "furniture", cells: rect(0, 0, 2, 1), invalid: false } }));
  assert.match(withStroke, /3 × 2 セル \/ 約 60 × 40 mm$/);
  const selected = statusText(session(map, { selectedItemId: "desk" }));
  assert.match(selected, /3 × 2 セル \/ 約 60 × 40 mm$/);
  const other = statusText(session(map, { stroke: { tool: "room", cells: rect(0, 0, 2, 1), invalid: false } }));
  assert.doesNotMatch(other, /mm$/);
});
