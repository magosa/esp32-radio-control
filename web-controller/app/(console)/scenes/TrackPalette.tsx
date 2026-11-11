"use client";

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useRef, type DragEvent } from "react";
import { availableTypes } from "@/scene/actionEdit";
import { actionTypeLabel } from "@/scene/trackEdit";
import type { ActionType, Track, TrackKind } from "@/scene/types";
import consoleStyles from "../console.module.css";
import styles from "./timeline.module.css";

const KIND_BUTTONS: { kind: TrackKind; label: string }[] = [
  { kind: "robot", label: "ロボット" }, { kind: "human", label: "人" }, { kind: "room", label: "部屋" }, { kind: "display", label: "画面表示" },
];

export interface TrackPaletteProps {
  track: Track | null;
  selectedBlocks: number;
  onAddTrack(kind: TrackKind): void;
  onAddAction(type: ActionType): void;
  onMoveTrack(direction: -1 | 1): void;
  onDeleteTrack(): void;
  onDeleteActions(): void;
  // Which action type is being dragged from here; the lanes read it because dragover cannot read dataTransfer.
  onDragType(type: ActionType | null): void;
}

export function TrackPalette(props: TrackPaletteProps) {
  const { track } = props;
  const pointerType = useRef("mouse");
  // HTML5 drag and drop does not work with touch; touch uses the buttons and the double tap instead.
  const start = (event: DragEvent<HTMLButtonElement>, type: ActionType) => {
    if (pointerType.current === "touch") { event.preventDefault(); return; }
    event.dataTransfer.setData("application/x-scene-action", type);
    event.dataTransfer.effectAllowed = "copy";
    props.onDragType(type);
  };

  return <div className={styles.palette} onPointerDownCapture={(event) => { pointerType.current = event.pointerType; }}>
    <div className={styles.group} role="group" aria-labelledby="tl-add-track">
      <span id="tl-add-track" className={styles.groupTitle}>行を追加</span>
      {KIND_BUTTONS.map(({ kind, label }) => <button key={kind} type="button" className={consoleStyles.secondary}
        onClick={() => props.onAddTrack(kind)}>＋ {label}</button>)}
    </div>
    <div className={styles.group} role="group" aria-labelledby="tl-add-action">
      <span id="tl-add-action" className={styles.groupTitle}>{track ? `動作を追加（${track.name}）` : "動作を追加"}</span>
      {track ? availableTypes(track).map((type) => <button key={type} type="button" className={consoleStyles.secondary}
        draggable onDragStart={(event) => start(event, type)} onDragEnd={() => props.onDragType(null)}
        onClick={() => props.onAddAction(type)}>＋ {actionTypeLabel(type)}</button>)
        : <span className={styles.hint}>行を選ぶと追加できます</span>}
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
