"use client";

import { CircleCheck, CircleX, Download, Pause, Play, RotateCcw, Square, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useFleetSocket } from "@/hooks/useFleetSocket";
import { useSceneProject } from "@/hooks/useSceneProject";
import { idleSnapshot, type RobotRunStatus, type RunEvasion, type RunPhase, type RunRobot, type RunSnapshot } from "@/scene/runTypes";
import { headingArrow, svgY } from "@/scene/mapView";
import { SAFETY_RADIUS_MM } from "@/scene/units";
import consoleStyles from "../console.module.css";
import { MapStage } from "../scenes/MapStage";
import styles from "./run.module.css";

const PHASE: Record<RunPhase, string> = {
  idle: "待機", arming: "確認中", running: "実行中", waiting: "完了待ち", halted: "停止中", finished: "完了", aborted: "中止",
};
const ROBOT_STATUS: Record<RobotRunStatus, string> = {
  idle: "待機", driving: "走行中", arrived: "到着済み", waiting: "到着待ち", evading: "退避中", lost: "見失い", failed: "失敗", excluded: "対象外",
};
const POSITION: Record<string, string> = { waiting: "待機中", moving: "移動中", arrived: "到着済み", failed: "動かせません" };

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
const mark = (ok: boolean, warn?: boolean) => warn ? <TriangleAlert aria-label="警告" /> : ok ? <CircleCheck aria-label="満たしています" /> : <CircleX aria-label="満たしていません" />;

function RunOverlay({ robots, evasions }: { robots: RunRobot[]; evasions: RunEvasion[] }) {
  return <g pointerEvents="none">
    {evasions.map((e) => <g key={`${e.yielder}-${e.priority}`} data-part="evasion-band">
      <line x1={e.band.from.x} y1={svgY(e.band.from.y)} x2={e.band.to.x} y2={svgY(e.band.to.y)} stroke="#ffbd70" strokeOpacity={0.35}
        strokeWidth={e.band.halfWidthMm * 2} strokeLinecap="round" />
      <circle cx={e.spot.x} cy={svgY(e.spot.y)} r={SAFETY_RADIUS_MM / 2} fill="none" stroke="#ffbd70" strokeWidth={4} />
    </g>)}
    {robots.map((robot) => {
      const color = robot.status === "lost" || robot.status === "failed" ? "#ff7b83" : "#58d8ca";
      const arrow = robot.pose ? headingArrow(robot.pose.yaw, SAFETY_RADIUS_MM, 18) : null;
      return <g key={robot.trackId}>
        {robot.target && <circle cx={robot.target.x} cy={svgY(robot.target.y)} r={SAFETY_RADIUS_MM / 2} fill="none" stroke={color} strokeWidth={4} strokeDasharray="10 8" />}
        {robot.pose && arrow && <g>
          <circle cx={robot.pose.x} cy={svgY(robot.pose.y)} r={SAFETY_RADIUS_MM} fill="none" stroke={color} strokeWidth={5} />
          <line x1={robot.pose.x} y1={svgY(robot.pose.y)} x2={robot.pose.x + arrow.tip.x} y2={svgY(robot.pose.y) - arrow.tip.y} stroke={color} strokeWidth={5} />
        </g>}
      </g>;
    })}
  </g>;
}

function Progress({ run }: { run: RunSnapshot }) {
  const names = Array.from(new Set(run.rows.map((row) => row.robot)));
  const span = Math.max(run.duration, 1);
  return <section className={styles.card} aria-label="進行">
    <h3>進行</h3>
    {names.map((name) => <div key={name} className={styles.lane} role="group" aria-label={`${name} の進行`}>
      <span>{name}</span>
      <div className={styles.track}>
        {run.rows.filter((row) => row.robot === name).map((row) => <span key={`${row.trackId}-${row.action}-${row.planStart}`} className={styles.chip}
          data-status={row.status} title={`${row.action} ${row.planStart.toFixed(1)}〜${row.planEnd.toFixed(1)}秒`}
          style={{ left: `${row.planStart / span * 100}%`, width: `${Math.max(1, (row.planEnd - row.planStart) / span * 100)}%` }}>{row.action}</span>)}
        <i className={styles.head} style={{ left: `${Math.min(100, run.clock / span * 100)}%` }} />
      </div>
    </div>)}
  </section>;
}

function download(run: RunSnapshot, result: unknown) {
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `scene-run-${run.mapName || "result"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function SceneRunPanel() {
  const { status, runState, runOp, sendRun } = useFleetSocket();
  const { project } = useSceneProject();
  const [mapId, setMapId] = useState("");
  const run = runState?.state ?? idleSnapshot();
  const connected = status === "connected";
  const selected = run.mapId ?? mapId;
  const map = project?.maps.find((item) => item.id === selected) ?? null;
  const busy = run.phase === "running" || run.phase === "waiting" || run.phase === "halted" || run.positioning.active;
  const resumable = run.resume.every((item) => item.ok);
  const positioning = run.positioning.active || run.positioning.items.some((item) => item.state !== "waiting");

  return <div className={styles.page}>
    <section className={styles.bar} aria-label="実行バー">
      <label>実行するシーン
        <select value={selected} disabled={!connected || busy} onChange={(event) => { setMapId(event.target.value); if (event.target.value) sendRun({ type: "prepare", mapId: event.target.value }); }}>
          <option value="">マップを選択</option>
          {project?.maps.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <strong className={styles.phase} data-phase={run.phase} role="status">{run.phase === "waiting" && run.evasions.length > 0 ? "退避中" : PHASE[run.phase]}</strong>
      <span aria-label="進行時計">{clock(run.clock)} / 計画 {clock(run.duration)}</span>
      <span>経過（実時間）{clock(run.realMs / 1000)}　止まっていた時間 +{(run.waitedMs / 1000).toFixed(1)}秒</span>
      <div className={styles.actions}>
        {run.phase === "arming" && <>
          <button type="button" className={consoleStyles.primary} disabled={!run.canStart} onClick={() => sendRun({ type: "start" })}><Play />開始</button>
          <button type="button" className={consoleStyles.secondary} disabled={run.positioning.active} onClick={() => sendRun({ type: "position" })}>初期位置へ移動</button>
          <button type="button" className={consoleStyles.secondary} onClick={() => sendRun({ type: "abort" })}><Square />中止</button>
        </>}
        {(run.phase === "running" || run.phase === "waiting") && <>
          <button type="button" className={consoleStyles.secondary} onClick={() => sendRun({ type: "pause" })}><Pause />一時停止</button>
          <button type="button" className={consoleStyles.secondary} onClick={() => sendRun({ type: "abort" })}><Square />中止</button>
        </>}
        {run.phase === "halted" && <>
          <button type="button" className={consoleStyles.primary} disabled={!resumable} onClick={() => sendRun({ type: "resume" })}><Play />再開</button>
          <button type="button" className={consoleStyles.secondary} onClick={() => sendRun({ type: "abort" })}><Square />中止</button>
        </>}
        {(run.phase === "finished" || run.phase === "aborted") && <>
          <button type="button" className={consoleStyles.primary} onClick={() => sendRun({ type: "reset" })}><RotateCcw />もう一度</button>
          <button type="button" className={consoleStyles.secondary} disabled={!runState?.result} onClick={() => download(run, runState?.result)}><Download />結果を保存</button>
        </>}
      </div>
    </section>
    {runOp?.error && <p className={styles.error} role="alert">{runOp.error}</p>}
    <p className={styles.reason} role="status">{run.reason}</p>

    {run.phase === "halted" && run.resume.length > 0 && <section className={styles.card} aria-label="再開の条件">
      <h3>再開の条件</h3>
      <ul>{run.resume.map((item) => <li key={item.label} data-ok={item.ok}>{mark(item.ok)}{item.label}（{item.detail}）</li>)}</ul>
      <p>位置が大きくずれている場合（人が動かしたなど）は、自動では再開しません。</p>
    </section>}

    {run.phase === "arming" && <section className={styles.card} aria-label="実行前の確認">
      <h3>実行前の確認</h3>
      <ul>{run.checks.map((item) => <li key={item.id} data-ok={item.ok || !!item.warn}>{mark(item.ok, item.warn && !item.ok)}{item.label}（{item.detail}）</li>)}</ul>
      {!run.canStart && run.checks.length > 0 && <p>✗ をすべて解消すると開始できます。</p>}
    </section>}

    {positioning && <section className={styles.card} aria-label="初期位置への移動">
      <h3>初期位置へ自動で動かす（1台ずつ、直線で）</h3>
      <table><thead><tr><th>ロボット</th><th>状態</th></tr></thead>
        <tbody>{run.positioning.items.map((item) => <tr key={item.trackId}><td>{item.name}</td><td>{POSITION[item.state]}{item.detail ? `（${item.detail}）` : ""}</td></tr>)}</tbody></table>
    </section>}

    {map && <section className={styles.card} aria-label="実行マップ">
      <h3>マップ（実線＝実機の測位位置、破線＝目標）</h3>
      <MapStage map={map} time={Math.min(run.clock, Math.max(run.duration, 0))} showGrid={false} gridMm={map.editGridMm} overlay={<RunOverlay robots={run.robots} evasions={run.evasions} />} />
    </section>}

    <section className={styles.cards} aria-label="ロボット別">
      {run.robots.map((robot) => <article key={robot.trackId} className={styles.card} data-status={robot.status}>
        <h3>{robot.name}<span>{ROBOT_STATUS[robot.status]}</span></h3>
        <p>追跡 {robot.tracking}{robot.markerId !== null ? ` ・ ID ${robot.markerId}` : ""}{robot.priority !== null ? ` ・ 優先 ${robot.priority}` : ""}</p>
        {robot.bar && <p>{robot.bar}（{robot.barStart?.toFixed(1)}〜{robot.barEnd?.toFixed(1)}秒）</p>}
        {robot.posErrMm !== null && <p>位置誤差 {robot.posErrMm.toFixed(1)}mm　向き誤差 {robot.yawErrDeg?.toFixed(1)}°　継続 {robot.settledSec.toFixed(1)} / 0.3秒</p>}
        {robot.note && <p>{robot.note}</p>}
      </article>)}
    </section>

    {run.rows.length > 0 && <Progress run={run} />}

    {(run.phase === "finished" || run.phase === "aborted") && <section className={styles.card} aria-label="動作ごとの結果">
      <h3>動作ごとの結果</h3>
      <table><thead><tr><th>ロボット</th><th>動作</th><th>計画（開始〜終了）</th><th>実際の到着</th><th>位置誤差</th><th>向き誤差</th><th>待たせた時間</th><th>結果</th></tr></thead>
        <tbody>{run.rows.map((row) => <tr key={`${row.trackId}-${row.action}-${row.planStart}`}>
          <td>{row.robot}</td><td>{row.action}</td><td>{row.planStart.toFixed(1)}〜{row.planEnd.toFixed(1)}</td>
          <td>{row.arrivedAt === null ? "—" : row.arrivedAt.toFixed(1)}</td><td>{row.posErrMm === null ? "—" : `${row.posErrMm.toFixed(1)}mm`}</td>
          <td>{row.yawErrDeg === null ? "—" : `${row.yawErrDeg.toFixed(1)}°`}</td><td>{row.waitedSec.toFixed(1)}秒</td>
          <td>{row.status === "arrived" ? "到着確認" : `失敗${row.note ? `: ${row.note}` : ""}`}</td></tr>)}</tbody></table>
    </section>}

    <section className={styles.card} aria-label="イベントログ">
      <h3>イベントログ</h3>
      <ol>{[...run.log].reverse().map((entry, index) => <li key={index} data-kind={entry.kind}>{clock(entry.clock)}　{entry.text}</li>)}</ol>
    </section>
  </div>;
}
