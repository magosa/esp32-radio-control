"use client";

import { Crosshair, ExternalLink, Monitor, Pause, Play, SkipBack, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { useFleetSocket } from "@/hooks/useFleetSocket";
import { exhibitTime } from "@/scene/exhibitSession";
import { formatTime } from "@/scene/timelineView";
import type { SceneMap } from "@/scene/types";
import consoleStyles from "../console.module.css";
import styles from "./exhibitControls.module.css";

const TICK_MS = 250;

export function ExhibitControls({ map, duration }: { map: SceneMap; duration: number }) {
  const { status, exhibit, exhibitOp, sendExhibit } = useFleetSocket();
  const [now, setNow] = useState(() => Date.now());
  const session = exhibit?.session ?? null;
  const running = session?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  const connected = status === "connected";
  const showing = session !== null && session.mapId === map.id;
  const elsewhere = session !== null && session.mapId !== null && !showing;
  const time = showing && exhibit ? exhibitTime(session, (running ? now : Date.now()) + exhibit.offsetMs, duration) : 0;
  const summary = showing
    ? `展示中: ${map.name}（${formatTime(time)} / ${formatTime(duration)}、${running ? "再生中" : "一時停止中"}）`
    : elsewhere ? "展示中: 別のマップ" : "展示: 未選択";

  return <div className={styles.group} role="group" aria-label="展示">
    <p className={styles.status} role="status"><Monitor aria-hidden="true" />{summary}</p>
    <div className={styles.buttons}>
      <button type="button" className={consoleStyles.secondary} disabled={!connected}
        onClick={() => sendExhibit({ type: "open", mapId: map.id })}>この地図を展示に出す</button>
      <button type="button" className={consoleStyles.secondary} disabled={!connected || !showing || duration === 0}
        onClick={() => sendExhibit({ type: running ? "pause" : "play" })}>
        {running ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{running ? "展示を一時停止" : "展示を再生"}
      </button>
      <button type="button" className={consoleStyles.secondary} disabled={!connected || !showing}
        onClick={() => sendExhibit({ type: "seek", time: 0 })}><SkipBack aria-hidden="true" />展示を先頭へ</button>
      <button type="button" className={consoleStyles.secondary} disabled={!connected || session?.mapId == null}
        onClick={() => sendExhibit({ type: "close" })}><Square aria-hidden="true" />展示を終了</button>
      <a className={consoleStyles.secondary} href="/exhibit" target="_blank" rel="noopener noreferrer">
        <ExternalLink aria-hidden="true" />展示画面を開く
      </a>
      <a className={consoleStyles.secondary} href="/exhibit?align=1" target="_blank" rel="noopener noreferrer">
        <Crosshair aria-hidden="true" />位置合わせ表示を開く
      </a>
    </div>
    {exhibitOp?.error && <p className={styles.error} role="alert">{exhibitOp.error}</p>}
  </div>;
}
