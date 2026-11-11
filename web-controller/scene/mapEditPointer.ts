import { cellAt, cellColRow, cellIndex, type Edge } from "./grid";
import { doorWidthOk, equipmentRectangle } from "./equipment";
import { CELL_COUNT, CELL_MM, COLUMNS, ROWS, type EditGridMm } from "./units";

export type DrawMode = "brush" | "rectangle";

const validCell = (cell: number) => Number.isInteger(cell) && cell >= 0 && cell < CELL_COUNT;

export function pointerCell(mm: { x: number; y: number }, _gridMm: EditGridMm): number {
  return cellAt(mm.x, mm.y);
}

// Block coordinates (in edit-grid units) of the block containing a valid cell.
function blockOf(cell: number, gridMm: EditGridMm): { bx: number; by: number } {
  const k = gridMm / CELL_MM;
  const { col, row } = cellColRow(cell);
  return { bx: Math.floor(col / k), by: Math.floor(row / k) };
}

// Cells of the block-coordinate box [bx0..bx1] x [by0..by1], clipped to the area, ascending.
function boxCells(bx0: number, by0: number, bx1: number, by1: number, gridMm: EditGridMm): number[] {
  const k = gridMm / CELL_MM;
  const cells: number[] = [];
  for (let row = by0 * k; row < Math.min((by1 + 1) * k, ROWS); row++) {
    for (let col = bx0 * k; col < Math.min((bx1 + 1) * k, COLUMNS); col++) cells.push(cellIndex(col, row));
  }
  return cells;
}

export function blockCells(cell: number, gridMm: EditGridMm): number[] {
  if (!validCell(cell)) return [];
  const { bx, by } = blockOf(cell, gridMm);
  return boxCells(bx, by, bx, by, gridMm);
}

export function rectangleBlocks(startCell: number, endCell: number, gridMm: EditGridMm): number[] {
  if (!validCell(startCell) || !validCell(endCell)) return [];
  const a = blockOf(startCell, gridMm), b = blockOf(endCell, gridMm);
  return boxCells(Math.min(a.bx, b.bx), Math.min(a.by, b.by), Math.max(a.bx, b.bx), Math.max(a.by, b.by), gridMm);
}

export function strokeBlocks(fromCell: number, toCell: number, gridMm: EditGridMm): number[] {
  if (!validCell(fromCell) || !validCell(toCell)) return [];
  let a = blockOf(fromCell, gridMm), b = blockOf(toCell, gridMm);
  // Canonical order keeps the rounding, and so the result, symmetric.
  if (a.bx > b.bx || (a.bx === b.bx && a.by > b.by)) [a, b] = [b, a];
  const dx = b.bx - a.bx, dy = b.by - a.by;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const seen = new Set<number>();
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const bx = Math.round(a.bx + dx * t), by = Math.round(a.by + dy * t);
    for (const cell of boxCells(bx, by, bx, by, gridMm)) seen.add(cell);
  }
  return Array.from(seen).sort((x, y) => x - y);
}

export function entranceRect(startCell: number, endCell: number, entrance: Edge, doorCells: number): number[] | null {
  if (!doorWidthOk(doorCells) || !validCell(startCell) || !validCell(endCell)) return null;
  try {
    return equipmentRectangle(startCell, endCell, entrance, true, doorCells);
  } catch {
    return null;
  }
}
