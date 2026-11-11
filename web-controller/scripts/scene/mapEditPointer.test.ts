import test from "node:test";
import assert from "node:assert/strict";
import { blockCells, entranceRect, pointerCell, rectangleBlocks, strokeBlocks } from "../../scene/mapEditPointer";
import { cellColRow, cellIndex, editBlockCells } from "../../scene/grid";
import { CELL_COUNT, COLUMNS, EDIT_GRID_OPTIONS, ROWS, type EditGridMm } from "../../scene/units";

const sortedUnique = (cells: number[]) => cells.every((cell, i) => i === 0 || cells[i - 1] < cell);
const valid = (cell: number) => Number.isInteger(cell) && cell >= 0 && cell < CELL_COUNT;

test("pointerCell maps mm to 20mm cells and includes top/right edges", () => {
  assert.equal(pointerCell({ x: 1100, y: 620 }, 20), 1704);
  assert.equal(pointerCell({ x: 1100.01, y: 10 }, 20), -1);
  assert.equal(pointerCell({ x: 10, y: -0.01 }, 20), -1);
  assert.equal(pointerCell({ x: 0, y: 0 }, 20), 0);
  assert.equal(pointerCell({ x: NaN, y: 10 }, 20), -1);
  assert.equal(pointerCell({ x: 10, y: Infinity }, 20), -1);
  assert.equal(pointerCell({ x: -Infinity, y: 10 }, 20), -1);
});

test("blockCells at 20mm is the cell itself", () => {
  assert.deepEqual(blockCells(0, 20), [0]);
  assert.deepEqual(blockCells(1704, 20), [1704]);
});

test("blockCells clips ragged edges", () => {
  const right = pointerCell({ x: 1090, y: 10 }, 40);
  assert.deepEqual(blockCells(right, 40), [cellIndex(54, 0), cellIndex(54, 1)]);
  assert.deepEqual(blockCells(right, 40), editBlockCells(1090, 10, 40));
  const topRight = pointerCell({ x: 1090, y: 610 }, 40);
  const cells = blockCells(topRight, 40);
  assert.deepEqual(cells, editBlockCells(1090, 610, 40));
  assert.ok(cells.every(valid));
  assert.deepEqual(cells, [1704]);
});

test("blockCells at 80mm top-right is 3x3", () => {
  const cells = blockCells(1704, 80);
  assert.equal(cells.length, 9);
  assert.deepEqual(cells, editBlockCells(1090, 610, 80));
  for (const cell of cells) {
    const { col, row } = cellColRow(cell);
    assert.ok(col >= 52 && col <= 54 && row >= 28 && row <= 30);
  }
});

test("blockCells rejects invalid cells", () => {
  assert.deepEqual(blockCells(-1, 20), []);
  assert.deepEqual(blockCells(CELL_COUNT, 40), []);
  assert.deepEqual(blockCells(1.5, 40), []);
  assert.deepEqual(blockCells(NaN, 40), []);
});

test("rectangleBlocks 20mm", () => {
  const a = cellIndex(0, 0), b = cellIndex(2, 2);
  const cells = rectangleBlocks(a, b, 20);
  assert.equal(cells.length, 9);
  assert.deepEqual(rectangleBlocks(b, a, 20), cells);
  assert.deepEqual(rectangleBlocks(a, a, 20), [0]);
});

test("rectangleBlocks unions block bounding boxes", () => {
  const cells = rectangleBlocks(cellIndex(1, 1), cellIndex(2, 2), 40);
  assert.equal(cells.length, 16);
  assert.deepEqual(cells, rectangleBlocks(cellIndex(0, 0), cellIndex(3, 3), 20));
});

test("rectangleBlocks stays inside the area at the ragged edge", () => {
  const cells = rectangleBlocks(cellIndex(50, 26), 1704, 40);
  assert.ok(cells.length > 0);
  assert.ok(sortedUnique(cells));
  assert.ok(cells.every(valid));
  assert.ok(cells.every((cell) => cellColRow(cell).col < COLUMNS && cellColRow(cell).row < ROWS));
  assert.deepEqual(rectangleBlocks(1704, cellIndex(50, 26), 40), cells);
});

test("rectangleBlocks rejects invalid cells", () => {
  assert.deepEqual(rectangleBlocks(-1, 5, 20), []);
  assert.deepEqual(rectangleBlocks(5, CELL_COUNT, 20), []);
});

test("strokeBlocks single cell and invalid", () => {
  assert.deepEqual(strokeBlocks(100, 100, 20), [100]);
  assert.deepEqual(strokeBlocks(-1, 100, 20), []);
  assert.deepEqual(strokeBlocks(100, 9999, 20), []);
});

test("strokeBlocks diagonal has no gaps and is symmetric", () => {
  const a = cellIndex(5, 5), b = cellIndex(15, 15);
  const cells = strokeBlocks(a, b, 20);
  assert.equal(cells.length, 11);
  assert.deepEqual(strokeBlocks(b, a, 20), cells);
  assert.ok(sortedUnique(cells));
  for (const cell of cells) {
    const { col, row } = cellColRow(cell);
    assert.equal(col, row);
  }
});

test("strokeBlocks shallow line is 8-neighbour connected and symmetric", () => {
  for (const grid of EDIT_GRID_OPTIONS) {
    const a = cellIndex(2, 3), b = cellIndex(50, 17);
    const cells = strokeBlocks(a, b, grid);
    assert.deepEqual(strokeBlocks(b, a, grid), cells);
    const k = grid / 20;
    const blocks = new Set(cells.map((cell) => {
      const { col, row } = cellColRow(cell);
      return `${Math.floor(col / k)},${Math.floor(row / k)}`;
    }));
    const list = Array.from(blocks).map((s) => s.split(",").map(Number)).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const dx = Math.abs(Math.floor(50 / k) - Math.floor(2 / k));
    assert.ok(list.length >= dx + 1);
    // Each block column along the line has at least one block and consecutive columns touch.
    for (let i = 1; i < list.length; i++) assert.ok(list[i][0] - list[i - 1][0] <= 1);
    const cols = new Set(list.map((p) => p[0]));
    for (let x = Math.floor(2 / k); x <= Math.floor(50 / k); x++) assert.ok(cols.has(x));
  }
});

test("strokeBlocks is symmetric on pairs where rounding differs by direction", () => {
  // Without the canonical start/end ordering these pairs round differently when reversed.
  const pairs: Array<[number, number, number, number, EditGridMm]> = [
    [54, 11, 32, 0, 20],
    [49, 1, 4, 23, 40],
  ];
  for (const [ac, ar, bc, br, grid] of pairs) {
    const a = cellIndex(ac, ar), b = cellIndex(bc, br);
    assert.deepEqual(strokeBlocks(a, b, grid), strokeBlocks(b, a, grid));
  }
});

test("strokeBlocks fast horizontal drag covers every column", () => {
  const cells = strokeBlocks(cellIndex(0, 10), cellIndex(54, 10), 20);
  assert.equal(cells.length, 55);
  assert.deepEqual(cells.map((cell) => cellColRow(cell).col), Array.from({ length: 55 }, (_, i) => i));
});

test("entranceRect bottom width 7", () => {
  const cells = entranceRect(cellIndex(10, 10), cellIndex(10, 14), "bottom", 7);
  assert.ok(cells);
  assert.equal(cells.length, 35);
  const cols = new Set(cells.map((cell) => cellColRow(cell).col));
  const rows = new Set(cells.map((cell) => cellColRow(cell).row));
  assert.equal(cols.size, 7);
  assert.equal(rows.size, 5);
  assert.deepEqual(Array.from(cols).sort((x, y) => x - y), [10, 11, 12, 13, 14, 15, 16]);
});

test("entranceRect top dragged left mirrors", () => {
  const left = entranceRect(cellIndex(20, 10), cellIndex(15, 14), "top", 7);
  const right = entranceRect(cellIndex(14, 10), cellIndex(30, 14), "top", 7);
  assert.ok(left && right);
  assert.deepEqual(left, right);
});

test("entranceRect left/right uses door height", () => {
  const cells = entranceRect(cellIndex(10, 10), cellIndex(14, 10), "left", 8);
  assert.ok(cells);
  assert.equal(cells.length, 40);
  const rows = new Set(cells.map((cell) => cellColRow(cell).row));
  const cols = new Set(cells.map((cell) => cellColRow(cell).col));
  assert.equal(rows.size, 8);
  assert.equal(cols.size, 5);
});

test("entranceRect rejects bad widths, overflow, invalid cells", () => {
  assert.equal(entranceRect(cellIndex(10, 10), cellIndex(10, 14), "bottom", 6), null);
  assert.equal(entranceRect(cellIndex(10, 10), cellIndex(10, 14), "bottom", 13), null);
  assert.equal(entranceRect(cellIndex(10, 10), cellIndex(10, 14), "bottom", 7.5), null);
  assert.equal(entranceRect(cellIndex(52, 10), cellIndex(54, 14), "bottom", 7), null);
  assert.equal(entranceRect(cellIndex(2, 10), cellIndex(0, 14), "top", 7), null);
  assert.equal(entranceRect(-1, 5, "bottom", 7), null);
  assert.equal(entranceRect(5, CELL_COUNT, "bottom", 7), null);
});

test("random pairs only yield valid unique ascending cells", () => {
  let seed = 12345;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (const grid of EDIT_GRID_OPTIONS as readonly EditGridMm[]) {
    for (let i = 0; i < 200; i++) {
      const a = next() % CELL_COUNT, b = next() % CELL_COUNT;
      for (const cells of [rectangleBlocks(a, b, grid), strokeBlocks(a, b, grid)]) {
        assert.ok(cells.length > 0);
        assert.ok(cells.every(valid));
        assert.ok(sortedUnique(cells));
      }
      assert.deepEqual(rectangleBlocks(b, a, grid), rectangleBlocks(a, b, grid));
      assert.deepEqual(strokeBlocks(b, a, grid), strokeBlocks(a, b, grid));
    }
  }
});
