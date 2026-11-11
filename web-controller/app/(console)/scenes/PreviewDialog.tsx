"use client";

import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { shortcutAction } from "@/scene/editorShortcuts";
import { VIEW_HEIGHT, VIEW_WIDTH } from "@/scene/mapView";
import type { SceneMap } from "@/scene/types";
import consoleStyles from "../console.module.css";
import type { PlaybackControls } from "./editorTypes";
import { MapStage } from "./MapStage";
import { PlaybackBar } from "./PlaybackBar";
import styles from "./preview.module.css";

export interface PreviewDialogProps {
  open: boolean;
  map: SceneMap;
  // The page's own playback: the dialog keeps no time or running state, so closing it never leaves the two out of step.
  playback: PlaybackControls;
  onClose(): void;
}

export function PreviewDialog({ open, map, playback, onClose }: PreviewDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    return () => { if (element.open) element.close(); };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (!shortcutAction(event.nativeEvent)) return;
    event.preventDefault();
    // The page behind the dialog listens on window for the same keys.
    event.stopPropagation();
  };

  return <dialog ref={dialog} className={styles.dialog} aria-label="全画面プレビュー" onKeyDown={onKeyDown}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    {open && <>
      <header className={styles.header}>
        <h2>{map.name}</h2>
        <button type="button" className={consoleStyles.primary} onClick={onClose}>閉じる</button>
      </header>
      <div className={styles.stage} style={{ "--aspect": VIEW_WIDTH / VIEW_HEIGHT } as CSSProperties}>
        <MapStage map={map} time={playback.time} showGrid={false} gridMm={map.editGridMm} />
      </div>
      <PlaybackBar playback={playback} />
    </>}
  </dialog>;
}
