"use client";

import { Bot, DoorOpen, Monitor, User } from "lucide-react";
import type { SceneSelection } from "@/scene/sceneSelection";
import { trackKindLabel } from "@/scene/trackEdit";
import type { SceneMap, TrackKind } from "@/scene/types";
import type { SceneContextRequest } from "./editorTypes";
import consoleStyles from "../console.module.css";
import styles from "./library.module.css";

const ICONS = { robot: Bot, human: User, room: DoorOpen, display: Monitor, door: DoorOpen } as const satisfies Record<TrackKind, unknown>;

export interface LibraryPanelProps {
  map: SceneMap;
  selection: SceneSelection;
  open: boolean;
  // The page owns where the column sits (inline, or a drawer on narrow screens).
  className: string;
  onSelect(selection: SceneSelection): void;
  onEditMap(): void;
  onEdit(target: SceneContextRequest["target"]): void;
  requestContextMenu?(request: SceneContextRequest): void;
}

// The left column: what the map and the scene contain, one click from the thing it names.
export function LibraryPanel({ map, selection, open, className, onSelect, onEditMap, onEdit, requestContextMenu }: LibraryPanelProps) {
  const rooms = map.rooms.filter((room) => room.cells.length > 0);
  return <aside className={`${consoleStyles.preferenceCard} ${className}`} aria-label="ライブラリ" data-open={open}>
    <h2>ライブラリ</h2>
    <section className={styles.section} aria-label="マップの情報">
      <h3>マップ</h3>
      <p className={styles.name}>{map.name}</p>
      <p className={styles.meta}>グリッド {map.editGridMm}mm ・ 領域 {rooms.length} ・ 行 {map.tracks.length}</p>
      <button type="button" className={consoleStyles.secondary} onClick={onEditMap}>マップを編集</button>
    </section>
    <section className={styles.section} aria-label="部屋と領域">
      <h3>部屋と領域（{rooms.length}）</h3>
      {rooms.length === 0 && <p className={styles.meta}>領域がありません。「マップを編集」で作成します。</p>}
      <ul>
        {rooms.map((room) => <li key={room.id}>
          <button type="button" className={styles.item} aria-pressed={selection.roomId === room.id}
            onDoubleClick={() => onEdit({ kind: "room", roomId: room.id })}
            onContextMenu={(event) => {
              if (!requestContextMenu) return;
              event.preventDefault();
              requestContextMenu({ x: event.clientX, y: event.clientY, target: { kind: "room", roomId: room.id } });
            }}
            onClick={() => onSelect({ trackId: null, actionId: null, blocks: [], roomId: room.id })}>
            <i className={styles.swatch} style={{ background: room.color }} aria-hidden="true" />
            <span>{room.name}<small>{room.kind === "corridor" ? "廊下" : "部屋"} · {room.cells.length}マス</small></span>
          </button>
        </li>)}
      </ul>
    </section>
    <section className={styles.section} aria-label="シーン内のオブジェクト">
      <h3>シーン内のオブジェクト（{map.tracks.length}）</h3>
      {map.tracks.length === 0 && <p className={styles.meta}>行がありません。右の「行と動作を追加」から追加します。</p>}
      <ul>
        {map.tracks.map((track) => {
          const Icon = ICONS[track.kind];
          const detail = track.kind === "robot"
            ? `${trackKindLabel(track.kind)}${track.robotId ? ` (${track.robotId})` : ""} · 動作 ${track.actions.length}件`
            : track.kind === "human"
              ? `${track.count ?? 1}人 · 動作 ${track.actions.length}件`
              : `${trackKindLabel(track.kind)} · 動作 ${track.actions.length}件`;
          return <li key={track.id}>
            <button type="button" className={styles.item} aria-pressed={selection.trackId === track.id && !selection.actionId && !selection.roomId}
              onDoubleClick={() => onEdit({ kind: "track", trackId: track.id })}
              onContextMenu={(event) => {
                if (!requestContextMenu) return;
                event.preventDefault();
                requestContextMenu({ x: event.clientX, y: event.clientY, target: { kind: "track", trackId: track.id } });
              }}
              style={{ ["--item-color" as string]: track.color }}
              onClick={() => onSelect({ trackId: track.id, actionId: null, blocks: [], roomId: null })}>
              <Icon aria-hidden="true" />
              <span>{track.name}<small>{detail}</small></span>
            </button>
          </li>;
        })}
      </ul>
    </section>
  </aside>;
}
