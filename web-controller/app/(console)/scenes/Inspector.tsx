"use client";

import type { EditorShared, PlaybackControls } from "./editorTypes";
import consoleStyles from "../console.module.css";
import styles from "./scenes.module.css";

// STUB: replaced by Task 9 (inspector). Keep the props contract.
export interface InspectorProps extends EditorShared {
  playback: PlaybackControls;
  // Opens the S2b map editor dialog (region shape, floor material, furniture).
  onEditMap(): void;
}

export function Inspector(_props: InspectorProps) {
  return <aside className={`${consoleStyles.preferenceCard} ${styles.sideCard}`} aria-label="設定">
    <h2>設定</h2>
    <p>行と動作の編集は、実装中です。</p>
  </aside>;
}
