"use client";

import { mergedDoors } from "@/scene/equipment";
import { FLOOR_MATERIALS, ROOM_KINDS } from "@/scene/mapColors";
import type { MapEditSession, Rotation } from "@/scene/mapEditSession";
import { REGION_COLORS } from "@/scene/mapEditRegions";
import type { Material, RoomKind } from "@/scene/types";
import consoleStyles from "../console.module.css";
import { ColorField, SelectField, TextCommit, ToggleButton } from "./MapEditorFields";
import { FURNITURE_LABELS } from "./MapEditorTools";
import styles from "./mapEditor.module.css";

const KIND_LABELS: Record<RoomKind, string> = { room: "部屋", corridor: "廊下" };
const MATERIAL_LABELS: Record<Material, string> = { wood: "木", tile: "タイル", carpet: "カーペット", concrete: "コンクリート" };
const ROTATIONS = ([0, 90, 180, 270] as Rotation[]).map((value) => ({ value, label: `${value}°` }));
const DOOR_KINDS = [{ value: "automatic" as const, label: "自動ドア" }, { value: "flapper" as const, label: "フラッパー" }];

export function MapEditorSidebar({ session }: { session: MapEditSession }) {
  const map = session.draft();
  const version = session.version();
  const room = map.rooms.find((item) => item.id === session.selectedRoomId());
  const itemId = session.selectedItemId();
  const plan = map.floorPlan;
  const furniture = plan?.furniture.find((item) => item.id === itemId);
  const door = plan?.doors.find((item) => item.id === itemId);
  const wall = plan?.walls?.find((item) => item.id === itemId);
  const named = door ?? wall;
  const group = door ? mergedDoors(map).find((item) => item.memberIds.includes(door.id)) : undefined;
  const hasItem = !!(furniture || named || plan?.chargingZones?.some((zone) => zone.id === itemId));

  return <aside className={styles.sidebar} aria-label="設定パネル">
    <section className={styles.panel} aria-labelledby="me-region-title">
      <h3 id="me-region-title">領域</h3>
      <SelectField label="領域を選択" value={room?.id ?? ""} disabled={map.rooms.length === 0}
        options={map.rooms.length === 0 ? [{ value: "", label: "領域がありません" }]
          : map.rooms.map((item) => ({ value: item.id, label: `${KIND_LABELS[item.kind]} · ${item.name}` }))}
        onChange={session.selectRoom} />
      <div className={styles.row}>
        <button type="button" className={consoleStyles.secondary} onClick={session.addRegionOfTool}>＋新しい領域</button>
        <button type="button" className={consoleStyles.secondary} disabled={!room} onClick={session.deleteRegion}>領域を削除</button>
      </div>
      <TextCommit label="領域名" value={room?.name ?? ""} syncKey={version} disabled={!room}
        onCommit={(name) => session.setRoomProps({ name })} />
      <SelectField label="種類" value={room?.kind ?? "room"} disabled={!room}
        options={ROOM_KINDS.map((value) => ({ value, label: KIND_LABELS[value] }))} onChange={(kind) => session.setRoomProps({ kind })} />
      <SelectField label="床材" value={room?.material ?? "concrete"} disabled={!room}
        options={FLOOR_MATERIALS.map((value) => ({ value, label: MATERIAL_LABELS[value] }))}
        onChange={(material) => session.setRoomProps({ material })} />
      <ColorField label="アクセント色" value={room?.color ?? REGION_COLORS[0]} disabled={!room}
        onCommit={(color) => session.setRoomProps({ color })} />
      <ToggleButton pressed={plan?.showRoomLabels === true} onClick={() => session.setRoomLabels(plan?.showRoomLabels !== true)}>部屋名を表示</ToggleButton>
    </section>
    <section className={styles.panel} aria-labelledby="me-item-title">
      <h3 id="me-item-title">選択中の配置物</h3>
      {!hasItem && <p className={styles.hint}>部屋編集モードの「選択」で、家具・ドア・壁・充電スペースを選びます。</p>}
      {named && <TextCommit label="設備名" value={named.name ?? ""} syncKey={version} onCommit={session.renameSelected} />}
      {door && <SelectField label="ドア種別" value={door.kind ?? "automatic"} options={DOOR_KINDS} onChange={session.setSelectedDoorKind} />}
      {group && <p className={styles.hint}>幅 {Math.round(Math.hypot(group.opening.x2 - group.opening.x1, group.opening.y2 - group.opening.y1))}mm の有効な開口</p>}
      {furniture && <>
        <SelectField label="種類" value={furniture.type}
          options={Object.entries(FURNITURE_LABELS).map(([value, label]) => ({ value: value as keyof typeof FURNITURE_LABELS, label }))}
          onChange={session.setSelectedFurnitureType} />
        <SelectField label="向き" value={furniture.rotation} options={ROTATIONS} onChange={session.setSelectedRotation} />
        <button type="button" className={consoleStyles.secondary} onClick={session.rotateSelected}>90°回転</button>
      </>}
      <button type="button" className={consoleStyles.secondary} disabled={!hasItem} onClick={session.deleteSelected}>選択物を削除</button>
    </section>
  </aside>;
}
