import { furnitureCells, regionBounds } from "./floorPlan";
import type { MapStroke } from "./mapEditSession";
import type { SceneMap } from "./types";

export interface StatusInput {
  map: SceneMap;
  selectedRoomId: string | null;
  selectedItemId: string | null;
  stroke: MapStroke | null;
}

export function statusText({ map, selectedRoomId, selectedItemId, stroke }: StatusInput): string {
  const total = map.rooms.reduce((sum, room) => sum + room.cells.length, 0);
  const selected = map.rooms.find((room) => room.id === selectedRoomId);
  let text = `${map.rooms.length} 領域 / ${total} セル　·　` +
    (selected ? `${selected.name}: ${selected.cells.length} セル` : "「新しい領域」を追加してください");
  if (selectedItemId) text += "　·　配置物を選択中";
  const furniture = map.floorPlan?.furniture.find((item) => item.id === selectedItemId);
  const sized = stroke?.tool === "furniture" && stroke.cells.length > 0 ? stroke.cells : furniture ? furnitureCells(furniture) : null;
  if (sized) {
    const { width, height } = regionBounds(Array.from(sized));
    text += `　·　${width / 20} × ${height / 20} セル / 約 ${width} × ${height} mm`;
  }
  return text;
}
