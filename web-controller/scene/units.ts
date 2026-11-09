export const AREA_WIDTH_MM = 1100;
export const AREA_HEIGHT_MM = 620;
export const CELL_MM = 20;
export const COLUMNS = 55;
export const ROWS = 31;
export const CELL_COUNT = 1705;

export const FIELD_WIDTH_MM = 1106.93;
export const FIELD_HEIGHT_MM = 622.65;
export const RATIO_WIDTH = 1600;
export const RATIO_HEIGHT = 900;

export const SAFETY_RADIUS_MM = 60;
export const HUMAN_RADIUS_MM = 14;
export const EDIT_GRID_OPTIONS = [20, 40, 60, 80, 100] as const;

export function ratioToMm(x: number, y: number): { x: number; y: number } {
  return { x: (x / RATIO_WIDTH) * FIELD_WIDTH_MM, y: (y / RATIO_HEIGHT) * FIELD_HEIGHT_MM };
}

export function mmToRatio(x: number, y: number): { x: number; y: number } {
  return { x: (x / FIELD_WIDTH_MM) * RATIO_WIDTH, y: (y / FIELD_HEIGHT_MM) * RATIO_HEIGHT };
}

export function normalizeYaw(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

export function shortestTurn(fromDeg: number, toDeg: number): number {
  const delta = normalizeYaw(toDeg - fromDeg);
  return delta === 180 ? -180 : delta;
}
