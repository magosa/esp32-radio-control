"use client";

import { Play, Square } from "lucide-react";
import { useState } from "react";
import { useFleetSocket } from "@/hooks/useFleetSocket";
import { isRunActive } from "@/scene/runTypes";
import styles from "../console.module.css";

// The time-driven route demo (no localizer). Moved here from the control screen.
export function SimpleRoutes() {
  const { status, vehicles, routeStatus, availableRoutes, runState, sendCommand, setMode, startRoute, stopRoute } = useFleetSocket();
  const [selectedRouteId, setSelectedRouteId] = useState("");
  const connected = status === "connected";
  const online = vehicles.filter((vehicle) => vehicle.status === "online");
  const run = runState?.state;
  const sceneRunning = !!run && (isRunActive(run.phase) || run.positioning.active);
  const auto = online.filter((vehicle) => vehicle.mode === "auto");

  return <div className={styles.preferences}>
    <p className={styles.muted}>測位を使わず、時間どおりに動かします。位置の補正・衝突の回避はありません。</p>
    <section className={styles.preferenceCard} aria-label="自動ルート">
      <div className={styles.sectionHeading}><h3>自動ルート</h3><span>{routeStatus?.running ? `実行中 · ${Math.floor(routeStatus.elapsedMs / 1000)}秒` : "停止中"}</span></div>
      <div className={styles.routeActions}>
        <select aria-label="自動ルートを選択" value={selectedRouteId} disabled={!connected || routeStatus?.running}
          onChange={(event) => setSelectedRouteId(event.target.value)}>
          <option value="">ルートを選択</option>{availableRoutes.map((route) => <option key={route.id} value={route.id}>{route.label}</option>)}
        </select>
        <button className={styles.primary} disabled={!connected || !selectedRouteId || !!routeStatus?.running || sceneRunning || auto.length === 0}
          onClick={() => startRoute(selectedRouteId)}><Play />開始</button>
        <button className={styles.secondary} disabled={!connected || !routeStatus?.running} onClick={stopRoute}><Square />停止</button>
      </div>
      {sceneRunning && <p className={styles.muted} role="status">シーン実行中は開始できません。</p>}
      <p className={styles.muted}>対象: {auto.map((vehicle) => vehicle.name).join("、") || "自動モードのロボットなし"}</p>
    </section>
    <section className={styles.preferenceCard} aria-label="対象のロボット">
      <div className={styles.sectionHeading}><h3>対象のロボット</h3><span>自動にした機体は制御画面では操作できません</span></div>
      {vehicles.map((vehicle) => <div key={vehicle.deviceId} className={styles.modeRow}>
        <strong>{vehicle.name}</strong>
        <span>{connected && vehicle.status === "online" ? "接続中" : "未接続"}</span>
        <div className={styles.segmented} role="group" aria-label={`${vehicle.name}の制御モード`}>
          <button aria-pressed={vehicle.mode === "manual"} disabled={!connected || vehicle.status !== "online" || sceneRunning}
            onClick={() => setMode(vehicle.deviceId, "manual")}>手動</button>
          <button aria-pressed={vehicle.mode === "auto"} disabled={!connected || vehicle.status !== "online" || sceneRunning}
            onClick={() => { sendCommand([vehicle.deviceId], "e", 0, 0); setMode(vehicle.deviceId, "auto"); }}>自動</button>
        </div>
      </div>)}
      {!vehicles.length && <p className={styles.empty}>{connected ? "接続中のロボットはありません" : "ロボット一覧を取得できません"}</p>}
    </section>
  </div>;
}
