import { mergedDoors } from "./equipment";
import { furnitureCells } from "./floorPlan";
import { cellAt } from "./grid";
import type { SceneMap } from "./types";

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** The item under a point in mm, or null. Doors win over the wall they sit on; furniture is hit by cell. */
export function hitItem(map: SceneMap, x: number, y: number, toleranceMm: number): string | null {
  const nearest = (segments: { id: string; x1: number; y1: number; x2: number; y2: number }[]) => {
    let best: string | null = null;
    let bestDistance = toleranceMm;
    for (const s of segments) {
      const d = distanceToSegment(x, y, s.x1, s.y1, s.x2, s.y2);
      if (d <= bestDistance) {
        best = s.id;
        bestDistance = d;
      }
    }
    return best;
  };
  const door = nearest(mergedDoors(map).map((d) => ({ id: d.id, x1: d.opening.x1, y1: d.opening.y1, x2: d.opening.x2, y2: d.opening.y2 })));
  if (door) return door;
  const wall = nearest(map.floorPlan?.walls ?? []);
  if (wall) return wall;
  const cell = cellAt(x, y);
  const furniture = cell < 0 ? undefined : map.floorPlan?.furniture.find((item) => furnitureCells(item).includes(cell));
  if (furniture) return furniture.id;
  return map.floorPlan?.chargingZones?.find((zone) =>
    x >= zone.x && x <= zone.x + zone.width && y >= zone.y && y <= zone.y + zone.height)?.id ?? null;
}
