"use client";

import type { EditorShared, PlaybackControls } from "./editorTypes";
import consoleStyles from "../console.module.css";
import styles from "./scenes.module.css";

// STUB: replaced by Task 6 (timeline). Keep the props contract.
export interface TimelineCardProps extends EditorShared {
  playback: PlaybackControls;
}

export function TimelineCard(_props: TimelineCardProps) {
  return <section className={`${consoleStyles.preferenceCard} ${styles.timelineCard}`} aria-label="時間軸">
    <h2>時間軸</h2>
    <p>バーの編集は、実装中です。</p>
  </section>;
}
