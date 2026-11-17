"use client";

import { useState } from "react";
import { equipmentTargets } from "@/scene/equipment";
import type { SceneMap, Track, TrackKind } from "@/scene/types";
import { SelectField } from "./MapEditorFields";
import consoleStyles from "../console.module.css";
import styles from "./timeline.module.css";

const KIND_BUTTONS: { kind: TrackKind; label: string }[] = [
  { kind: "robot", label: "ロボット" }, { kind: "human", label: "人" }, { kind: "display", label: "画面表示" },
];

export interface TrackPaletteProps {
  onAddTrack(kind: TrackKind, roomId?: string): void;
  map: SceneMap;
  selectedTrack?: Track;
  onAddDoor(doorId: string): void;
  onAddOpen(): void;
}

export function TrackPalette(props: TrackPaletteProps) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const targets = equipmentTargets(props.map).filter((target) =>
    !props.map.tracks.some((track) => track.kind === "door" && target.memberIds.includes(track.doorId ?? "")));
  return <div className={styles.palette}>
    <div className={styles.group} role="group" aria-labelledby="tl-add-track">
      <span id="tl-add-track" className={styles.groupTitle}>行を追加</span>
      {KIND_BUTTONS.map(({ kind, label }) => <button key={kind} type="button" className={consoleStyles.secondary}
        onClick={() => props.onAddTrack(kind)}>＋ {label}</button>)}
    </div>
    <div className={`${styles.group} ${styles.equipmentGroup}`} role="group" aria-label="設備の行を追加">
      {(["automatic", "flapper"] as const).map((kind) => {
        const name = kind === "automatic" ? "自動ドア" : "フラッパーゲート";
        const options = targets.filter((target) => target.kind === kind);
        const value = options.some((target) => target.doorId === picked[kind]) ? picked[kind] : options[0]?.doorId ?? "";
        return <div key={kind}>
          <SelectField label={`${name}の対象設備`} value={value}
            options={options.length ? options.map((target) => ({ value: target.doorId, label: target.label })) : [{ value: "", label: "追加できる設備なし" }]}
            disabled={!options.length} onChange={(value) => setPicked((current) => ({ ...current, [kind]: value }))} />
          <button type="button" className={consoleStyles.secondary} disabled={!value} onClick={() => props.onAddDoor(value)}>＋ {name}</button>
        </div>;
      })}
      <p className={styles.hint}>マップに配置済みの設備を選びます。各設備の行は1本ずつ追加できます。</p>
    </div>
    {props.selectedTrack?.kind === "door" && <div className={`${styles.group} ${styles.equipmentGroup}`} role="group" aria-label="設備の開閉指示">
      <span>{props.selectedTrack.name}</span>
      <button type="button" className={consoleStyles.secondary} disabled={props.selectedTrack.locked} onClick={props.onAddOpen}>＋ 開閉指示</button>
      <p className={styles.hint}>開始時刻に開き始め、終了時刻に閉じ始めます。</p>
    </div>}
  </div>;
}
