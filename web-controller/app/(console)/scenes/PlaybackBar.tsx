"use client";

import { Maximize2, Pause, Play, Repeat, SkipBack } from "lucide-react";
import { SPEEDS } from "@/scene/playback";
import { formatTime } from "@/scene/timelineView";
import consoleStyles from "../console.module.css";
import type { PlaybackControls } from "./editorTypes";
import styles from "./playback.module.css";

export function PlaybackBar({ playback, onFullscreen }: { playback: PlaybackControls; onFullscreen?: () => void }) {
  const { time, duration, running, looping, speed } = playback;
  return <div className={styles.bar} role="toolbar" aria-label="再生">
    <button type="button" className={consoleStyles.secondary} onClick={playback.toggle} disabled={duration === 0}
      aria-label={running ? "一時停止" : "再生"}>
      {running ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{running ? "一時停止" : "再生"}
    </button>
    <button type="button" className={consoleStyles.secondary} onClick={playback.home} aria-label="先頭へ">
      <SkipBack aria-hidden="true" />先頭へ
    </button>
    <button type="button" className={`${consoleStyles.secondary} ${styles.toggle}`} aria-pressed={looping} onClick={playback.toggleLoop}>
      <Repeat aria-hidden="true" />ループ
    </button>
    <label className={styles.speed}>
      <span>速度</span>
      <select value={String(speed)} onChange={(event) => playback.setSpeed(Number(event.target.value))}>
        {SPEEDS.map((value) => <option key={value} value={String(value)}>{value}x</option>)}
      </select>
    </label>
    <label className={styles.seek}>
      <span>時刻 <output>{formatTime(time)} / {formatTime(duration)}</output></span>
      <input type="range" min={0} max={duration} step={0.1} value={Math.min(time, duration)} disabled={duration === 0}
        aria-label="再生位置" onChange={(event) => playback.seek(Number(event.target.value))} />
    </label>
    {onFullscreen && <button type="button" className={consoleStyles.secondary} onClick={onFullscreen}>
      <Maximize2 aria-hidden="true" />全画面プレビュー
    </button>}
  </div>;
}
