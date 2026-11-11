"use client";

import { DOOR_MAX_CELLS, DOOR_MIN_CELLS } from "@/scene/equipment";
import type { Edge } from "@/scene/grid";
import { FURNITURE_TYPES } from "@/scene/mapColors";
import { ROOM_TOOLS, ZONING_TOOLS, type DoorEdge, type MapEditSession, type MapTool, type Rotation } from "@/scene/mapEditSession";
import type { FurnitureType } from "@/scene/types";
import { EDIT_GRID_OPTIONS } from "@/scene/units";
import { Group, SelectField, ToggleButton } from "./MapEditorFields";
import styles from "./mapEditor.module.css";

export const TOOL_LABELS: Record<MapTool, string> = {
  room: "部屋", corridor: "廊下", erase: "消しゴム", elevator: "エレベーター",
  select: "選択", door: "自動ドア", gate: "フラッパーゲート", partition: "間仕切り壁", furniture: "家具", charging: "充電スペース",
};
export const FURNITURE_LABELS: Record<FurnitureType, string> = {
  desk: "机", chair: "椅子", plant: "植物", "reception-monitor": "受付モニター",
};
const EDGE_LABELS: Record<Edge, string> = { bottom: "下", top: "上", left: "左", right: "右" };
const WIDTHS = Array.from({ length: DOOR_MAX_CELLS - DOOR_MIN_CELLS + 1 }, (_, i) => {
  const cells = DOOR_MIN_CELLS + i;
  return { value: cells, label: `${cells * 20}mm(${cells}マス)` };
});
const EDGES = (Object.keys(EDGE_LABELS) as Edge[]).map((value) => ({ value, label: EDGE_LABELS[value] }));
const DOOR_EDGES: { value: DoorEdge; label: string }[] = [{ value: "auto", label: "自動" }, ...EDGES];
const ROTATIONS = ([0, 90, 180, 270] as Rotation[]).map((value) => ({ value, label: `${value}°` }));

export function MapEditorTools({ session }: { session: MapEditSession }) {
  const mode = session.mode();
  const tool = session.tool();
  const tools = mode === "zoning" ? ZONING_TOOLS : ROOM_TOOLS;
  const needsWidth = tool === "door" || tool === "gate" || tool === "elevator";
  return <div className={styles.tools}>
    <Group label="モード">
      <ToggleButton pressed={mode === "zoning"} onClick={() => session.setMode("zoning")}>ゾーニング</ToggleButton>
      <ToggleButton pressed={mode === "room"} onClick={() => session.setMode("room")}>部屋編集</ToggleButton>
    </Group>
    <Group label="ツール">
      {tools.map((item) => <ToggleButton key={item} pressed={tool === item} onClick={() => session.setTool(item)}>{TOOL_LABELS[item]}</ToggleButton>)}
    </Group>
    {mode === "zoning" && (tool === "room" || tool === "corridor" || tool === "erase") && <Group label="描き方">
      <ToggleButton pressed={session.drawMode() === "brush"} onClick={() => session.setDrawMode("brush")}>自由に塗る</ToggleButton>
      <ToggleButton pressed={session.drawMode() === "rectangle"} onClick={() => session.setDrawMode("rectangle")}>長方形ドラッグ</ToggleButton>
    </Group>}
    {needsWidth && <SelectField label="入口幅" value={session.doorCells()} options={WIDTHS} onChange={session.setDoorCells} />}
    {(tool === "gate" || tool === "elevator") && <SelectField label="入口の向き" value={session.entrance()} options={EDGES} onChange={session.setEntrance} />}
    {tool === "door" && <SelectField label="ドアの辺" value={session.doorEdge()} options={DOOR_EDGES} onChange={session.setDoorEdge} />}
    {tool === "furniture" && <>
      <SelectField label="家具の種類" value={session.furnitureType()}
        options={FURNITURE_TYPES.map((value) => ({ value, label: FURNITURE_LABELS[value] }))} onChange={session.setFurnitureType} />
      <SelectField label="置く向き" value={session.placementRotation()} options={ROTATIONS} onChange={session.setSelectedRotation} />
    </>}
    <SelectField label="編集グリッド" value={session.draft().editGridMm}
      options={EDIT_GRID_OPTIONS.map((value) => ({ value, label: `${value}mm` }))} onChange={session.setGrid} />
  </div>;
}
