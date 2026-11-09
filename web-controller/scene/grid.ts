import { AREA_HEIGHT_MM, AREA_WIDTH_MM, CELL_COUNT, CELL_MM, COLUMNS, ROWS, type EditGridMm } from "./units";

export type Edge = "top" | "bottom" | "left" | "right";

export function cellIndex(col: number, row: number): number {
  if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || col >= COLUMNS || row < 0 || row >= ROWS) {
    return -1;
  }
  return row * COLUMNS + col;
}

export function cellColRow(cell: number): { col: number; row: number } {
  return { col: cell % COLUMNS, row: Math.floor(cell / COLUMNS) };
}

export function cellCenter(cell: number): { x: number; y: number } {
  const { col, row } = cellColRow(cell);
  return { x: col * CELL_MM + CELL_MM / 2, y: row * CELL_MM + CELL_MM / 2 };
}

function inArea(x: number, y: number): boolean {
  return x >= 0 && x <= AREA_WIDTH_MM && y >= 0 && y <= AREA_HEIGHT_MM;
}

export function cellAt(x: number, y: number): number {
  if (!inArea(x, y)) return -1;
  return cellIndex(Math.min(Math.floor(x / CELL_MM), COLUMNS - 1), Math.min(Math.floor(y / CELL_MM), ROWS - 1));
}

function validCell(cell: number): boolean {
  return Number.isInteger(cell) && cell >= 0 && cell < CELL_COUNT;
}

export function cellNeighbor(cell: number, edge: Edge): number {
  if (!validCell(cell)) return -1;
  const { col, row } = cellColRow(cell);
  if (edge === "top") return cellIndex(col, row + 1);
  if (edge === "bottom") return cellIndex(col, row - 1);
  if (edge === "left") return cellIndex(col - 1, row);
  return cellIndex(col + 1, row);
}

// Returns the block's mm span clipped to [0, limit].
function blockSpan(value: number, gridMm: EditGridMm, limit: number): { start: number; end: number } {
  const index = Math.min(Math.floor(value / gridMm), Math.ceil(limit / gridMm) - 1);
  const start = index * gridMm;
  return { start, end: Math.min(start + gridMm, limit) };
}

export function editBlockCells(x: number, y: number, gridMm: EditGridMm): number[] {
  if (!inArea(x, y)) return [];
  const xs = blockSpan(x, gridMm, AREA_WIDTH_MM);
  const ys = blockSpan(y, gridMm, AREA_HEIGHT_MM);
  const cells: number[] = [];
  for (let row = ys.start / CELL_MM; row < ys.end / CELL_MM; row++) {
    for (let col = xs.start / CELL_MM; col < xs.end / CELL_MM; col++) cells.push(cellIndex(col, row));
  }
  return cells;
}

export function snapToEditGrid(x: number, y: number, gridMm: EditGridMm): { x: number; y: number } {
  const xs = blockSpan(x, gridMm, AREA_WIDTH_MM);
  const ys = blockSpan(y, gridMm, AREA_HEIGHT_MM);
  return { x: (xs.start + xs.end) / 2, y: (ys.start + ys.end) / 2 };
}

export function rectangleCells(a: number, b: number): number[] {
  if (!validCell(a) || !validCell(b)) return [];
  const first = cellColRow(a);
  const second = cellColRow(b);
  const cells: number[] = [];
  for (let row = Math.min(first.row, second.row); row <= Math.max(first.row, second.row); row++) {
    for (let col = Math.min(first.col, second.col); col <= Math.max(first.col, second.col); col++) {
      cells.push(cellIndex(col, row));
    }
  }
  return cells;
}
