import test from "node:test";
import assert from "node:assert/strict";
import {
  cellAt,
  cellCenter,
  cellColRow,
  cellIndex,
  cellNeighbor,
  editBlockCells,
  rectangleCells,
  snapToEditGrid,
} from "../../scene/grid";

test("cellIndex counts rows from the bottom and rejects out-of-range", () => {
  assert.equal(cellIndex(0, 0), 0);
  assert.equal(cellIndex(54, 30), 1704);
  assert.equal(cellIndex(55, 0), -1);
  assert.deepEqual(cellColRow(1704), { col: 54, row: 30 });
});

test("cellCenter returns mm centers", () => {
  assert.deepEqual(cellCenter(0), { x: 10, y: 10 });
  assert.deepEqual(cellCenter(1704), { x: 1090, y: 610 });
});

test("cellAt includes the right and top edges", () => {
  assert.equal(cellAt(1100, 620), 1704);
  assert.equal(cellAt(1100.01, 10), -1);
  assert.equal(cellAt(0, 0), 0);
  assert.equal(cellAt(10, 620.01), -1);
  assert.equal(cellAt(-0.01, 10), -1);
});

test("cellNeighbor uses top = row + 1", () => {
  assert.equal(cellNeighbor(0, "top"), 55);
  assert.equal(cellNeighbor(1704, "top"), -1);
  assert.equal(cellNeighbor(0, "left"), -1);
  assert.equal(cellNeighbor(55, "bottom"), 0);
  assert.equal(cellNeighbor(1704, "right"), -1);
});

test("editBlockCells clips partial blocks at the right and top edges", () => {
  assert.deepEqual(editBlockCells(1090, 10, 40), [54, 109]);
  assert.equal(editBlockCells(10, 10, 80).length, 16);
  assert.deepEqual(editBlockCells(1090, 610, 80), [1592, 1593, 1594, 1647, 1648, 1649, 1702, 1703, 1704]);
  assert.deepEqual(editBlockCells(1100, 620, 20), [1704]);
  assert.deepEqual(editBlockCells(1100, 620, 100), [1700, 1701, 1702, 1703, 1704]);
  assert.deepEqual(editBlockCells(1100.01, 10, 40), []);
});

test("snapToEditGrid returns the center of the in-range block", () => {
  assert.deepEqual(snapToEditGrid(1095, 615, 40), { x: 1090, y: 610 });
  assert.deepEqual(snapToEditGrid(5, 5, 20), { x: 10, y: 10 });
});

test("rectangleCells returns the inclusive rectangle in ascending order", () => {
  assert.deepEqual(rectangleCells(cellIndex(3, 2), cellIndex(2, 1)), [57, 58, 112, 113]);
  assert.deepEqual(rectangleCells(1704, 1704), [1704]);
});
