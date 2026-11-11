import test from "node:test";
import assert from "node:assert/strict";
import { cellIndex } from "../../scene/grid";
import type { Furniture, SceneMap } from "../../scene/types";
import {
  VIEW_BOX, ZOOMS, applyMatrix, cellPath, clampToArea, clientToMm, displayLayout, doorLayout, furnitureLayout, gridLines,
  headingArrow, isTap, mapSummary, mmToSvg, pxPerMm, svgAngle, svgToMm, svgY, textMm, wrapDisplayText, zoomWidth,
} from "../../scene/mapView";

const near = (actual: number, expected: number, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);

test("the view box is the 1100 x 620 mm area", () => {
  assert.equal(VIEW_BOX, "0 0 1100 620");
});

test("y is flipped at both edges of the area", () => {
  assert.equal(svgY(0), 620);
  assert.equal(svgY(620), 0);
  assert.deepEqual(mmToSvg({ x: 30, y: 100 }), { x: 30, y: 520 });
  assert.deepEqual(svgToMm({ x: 30, y: 520 }), { x: 30, y: 100 });
});

test("angles are negated because svg y points down", () => {
  assert.equal(svgAngle(90), -90);
  assert.equal(svgAngle(-45), 45);
  assert.equal(svgAngle(0), 0);
});

test("the top-right cell lands in the top-right corner of the svg", () => {
  assert.equal(cellPath([cellIndex(54, 30)]), "M1080 0h20v20h-20Z");
  assert.equal(cellPath([0]), "M0 600h20v20h-20Z");
  assert.equal(cellPath([0, 1]), "M0 600h20v20h-20ZM20 600h20v20h-20Z");
});

test("a 90 degree yaw arrow points up on screen", () => {
  const arrow = headingArrow(90, 52, 10);
  near(arrow.tip.x, 0);
  near(arrow.tip.y, -52);
  near(arrow.barbs[0].x + arrow.barbs[1].x, 0);
  near(arrow.barbs[0].y, arrow.barbs[1].y);
  assert.ok(arrow.barbs[0].y > arrow.tip.y, "barbs sit behind the tip");
  const east = headingArrow(0, 52, 10);
  near(east.tip.x, 52);
  near(east.tip.y, 0);
  const west = headingArrow(180, 52, 10);
  near(west.tip.x, -52);
});

test("client to mm converts through the inverse matrix and round-trips", () => {
  // svg is drawn at 0.8 px/mm with its origin at client (100, 50).
  const forward = { a: 0.8, b: 0, c: 0, d: 0.8, e: 100, f: 50 };
  const inverse = { a: 1.25, b: 0, c: 0, d: 1.25, e: -125, f: -62.5 };
  const target = { x: 250, y: 410 };
  const svg = mmToSvg(target);
  const client = applyMatrix(forward, svg.x, svg.y);
  const back = clientToMm(client, inverse);
  near(back.x, target.x);
  near(back.y, target.y);
  // y = 0 sits on the bottom edge of the drawing.
  const bottom = clientToMm(applyMatrix(forward, 0, 620), inverse);
  near(bottom.y, 0);
});

test("points outside the area are clamped", () => {
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  assert.deepEqual(clientToMm({ x: -40, y: -10 }, identity), { x: 0, y: 620 });
  assert.deepEqual(clientToMm({ x: 5000, y: 900 }, identity), { x: 1100, y: 0 });
  assert.deepEqual(clampToArea({ x: 1200, y: -5 }), { x: 1100, y: 0 });
});

test("a tap tolerates small movement and rejects a drag", () => {
  assert.equal(isTap({ x: 10, y: 10 }, { x: 14, y: 12 }), true);
  assert.equal(isTap({ x: 10, y: 10 }, { x: 40, y: 10 }), false);
});

test("zoom levels are all, 150, 200 and 400 percent of the parent width", () => {
  assert.deepEqual(ZOOMS.map((zoom) => zoom.label), ["全体", "150%", "200%", "400%"]);
  assert.deepEqual(ZOOMS.map((zoom) => zoomWidth(zoom.id)), ["100%", "150%", "200%", "400%"]);
});

test("text never drops below 12 screen pixels", () => {
  near(pxPerMm(550, 310), 0.5);
  near(pxPerMm(1100, 100), 100 / 620);
  assert.equal(pxPerMm(0, 0), 0);
  near(textMm(10, 0.5), 24);
  near(textMm(10, 2), 10);
  near(textMm(10, 0), 10);
});

test("grid lines sit on multiples of the edit grid inside the area", () => {
  const hundred = gridLines(100);
  assert.deepEqual(hundred.xs, [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  assert.deepEqual(hundred.ys, [100, 200, 300, 400, 500, 600]);
  assert.equal(gridLines(20).xs.length, 54);
  assert.equal(gridLines(20).ys.length, 30);
});

test("furniture keeps its footprint centre and flips y", () => {
  const desk: Furniture = { id: "d", roomId: "r", cell: 0, type: "desk", rotation: 0 };
  assert.deepEqual(furnitureLayout(desk), { x: 10, y: 610, width: 20, height: 20, rotation: 0, long: false });
  const bench: Furniture = { id: "b", roomId: "r", cell: 0, cells: [0, 1], type: "chair", rotation: 0 };
  assert.deepEqual(furnitureLayout(bench), { x: 20, y: 610, width: 40, height: 20, rotation: 0, long: true });
});

test("a vertical long item is turned so its back follows the long side", () => {
  const tall: Furniture = { id: "t", roomId: "r", cell: 0, cells: [0, 55], type: "desk", rotation: 0 };
  assert.deepEqual(furnitureLayout(tall), { x: 10, y: 600, width: 40, height: 20, rotation: 90, long: true });
  const plant: Furniture = { id: "p", roomId: "r", cell: 0, cells: [0, 55], type: "plant", rotation: 0 };
  assert.deepEqual(furnitureLayout(plant), { x: 10, y: 600, width: 20, height: 40, rotation: 0, long: true });
});

test("door layout is anchored at the left or at the top in svg space", () => {
  assert.deepEqual(doorLayout({ x1: 100, y1: 200, x2: 140, y2: 200 }), { x: 100, y: 420, length: 40, rotate: 0 });
  assert.deepEqual(doorLayout({ x1: 100, y1: 200, x2: 100, y2: 240 }), { x: 100, y: 380, length: 40, rotate: 90 });
});

test("display text wraps at 22 characters and keeps five lines", () => {
  assert.deepEqual(wrapDisplayText("a\n\nb"), ["a", "", "b"]);
  assert.deepEqual(wrapDisplayText("x".repeat(23)), ["x".repeat(22), "x"]);
  const many = wrapDisplayText("1\n2\n3\n4\n5\n6");
  assert.equal(many.length, 5);
  assert.equal(many[4], "5…");
});

test("a display box is clamped inside the area", () => {
  const box = displayLayout("hello", 14, { x: 1095, y: 5 });
  assert.ok(box.x + box.width / 2 <= 1100);
  assert.ok(box.y + box.height / 2 <= 620);
  assert.ok(box.x - box.width / 2 >= 0);
  assert.ok(box.y - box.height / 2 >= 0);
  assert.deepEqual(box.lines, ["hello"]);
  const middle = displayLayout("hello", 14, { x: 500, y: 300 });
  assert.equal(middle.x, 500);
  assert.equal(middle.y, 300);
});

test("the summary counts rooms and actors for assistive technology", () => {
  const map: SceneMap = {
    id: "m", name: "本館", editGridMm: 20, doorMode: "story", rooms: [], tracks: [],
  };
  const text = mapSummary(map, {
    time: 2.345, actors: [{ kind: "robot", count: 1 }, { kind: "human", count: 3 }, { kind: "robot", count: 1 }],
  });
  assert.equal(text, "本館。部屋0室、ロボット2台、人3人、時刻2.3秒");
});
