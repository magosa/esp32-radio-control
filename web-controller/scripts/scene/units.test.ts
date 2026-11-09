import test from "node:test";
import assert from "node:assert/strict";
import {
  AREA_HEIGHT_MM,
  AREA_WIDTH_MM,
  CELL_MM,
  COLUMNS,
  ROWS,
  mmToRatio,
  normalizeYaw,
  ratioToMm,
  shortestTurn,
} from "../../scene/units";

const near = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test("ratioToMm maps the ratio corner to the field size", () => {
  const point = ratioToMm(1600, 900);
  near(point.x, 1106.93);
  near(point.y, 622.65);
});

test("mmToRatio inverts ratioToMm", () => {
  const mm = ratioToMm(123.4, 567.8);
  const ratio = mmToRatio(mm.x, mm.y);
  near(ratio.x, 123.4);
  near(ratio.y, 567.8);
});

test("normalizeYaw returns (-180, 180]", () => {
  assert.equal(normalizeYaw(180), 180);
  assert.equal(normalizeYaw(-180), 180);
  assert.equal(normalizeYaw(540), 180);
  assert.equal(normalizeYaw(-190), 170);
});

test("shortestTurn crosses ±180 and prefers clockwise at exactly 180", () => {
  assert.equal(shortestTurn(179, -179), 2);
  assert.equal(shortestTurn(0, 180), -180);
  assert.equal(shortestTurn(10, -170), -180);
});

test("cell grid exactly covers the drawable area", () => {
  assert.equal(COLUMNS * CELL_MM, AREA_WIDTH_MM);
  assert.equal(ROWS * CELL_MM, AREA_HEIGHT_MM);
});
