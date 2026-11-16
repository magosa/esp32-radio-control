"use client";

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import type { ActionType, Track, TrackKind } from "@/scene/types";
import consoleStyles from "../console.module.css";
import styles from "./timeline.module.css";

const KIND_BUTTONS: { kind: TrackKind; label: string }[] = [
  { kind: "robot", label: "ロボット" }, { kind: "human", label: "人" }, { kind: "room", label: "部屋" }, { kind: "display", label: "画面表示" },
];

export interface TrackPaletteProps {
  track: Track | null;
  selectedBlocks: number;
  onAddTrack(kind: TrackKind, roomId?: string): void;
  onAddAction(type: ActionType): void;
  onMoveTrack(direction: -1 | 1): void;
  onDeleteTrack(): void;
  onDeleteActions(): void;
  onDragType(type: ActionType | null): void;
}

export function TrackPalette(props: TrackPaletteProps) {
  const { track } = props;

  return <div className={styles.palette}>
    <div className={styles.group} role="group" aria-labelledby="tl-add-track">
      <span id="tl-add-track" className={styles.groupTitle}>行を追加</span>
      {KIND_BUTTONS.map(({ kind, label }) => <button key={kind} type="button" className={consoleStyles.secondary}
        onClick={() => props.onAddTrack(kind)}>＋ {label}</button>)}
      <button type="button" className={consoleStyles.secondary} disabled={!track}
        onClick={() => { if (track) props.onAddTrack(track.kind, track.roomId); }}>
        ＋ 選択中と同種の行を追加
      </button>
    </div>
    <div className={styles.group} role="group" aria-labelledby="tl-row-ops">
      <span id="tl-row-ops" className={styles.groupTitle}>選択した行・動作</span>
      <button type="button" className={consoleStyles.secondary} disabled={!track} onClick={() => props.onMoveTrack(-1)}>
        <ArrowUp aria-hidden="true" />上へ
      </button>
      <button type="button" className={consoleStyles.secondary} disabled={!track} onClick={() => props.onMoveTrack(1)}>
        <ArrowDown aria-hidden="true" />下へ
      </button>
      <button type="button" className={consoleStyles.secondary} disabled={!track} onClick={props.onDeleteTrack}>
        <Trash2 aria-hidden="true" />行を削除
      </button>
      <button type="button" className={consoleStyles.secondary} disabled={props.selectedBlocks === 0} onClick={props.onDeleteActions}>
        <Trash2 aria-hidden="true" />動作を削除{props.selectedBlocks > 1 ? `（${props.selectedBlocks}）` : ""}
      </button>
    </div>
  </div>;
}
