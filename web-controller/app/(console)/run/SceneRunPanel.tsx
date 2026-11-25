"use client";

import { CircleCheck, CircleX, Download, Pause, Play, RotateCcw, Square, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useFleetSocket } from "@/hooks/useFleetSocket";
import { useSceneProject } from "@/hooks/useSceneProject";
import { ARRIVE_HOLD_MS, ARRIVE_POS_MM, ARRIVE_YAW_DEG } from "@/fleet/sceneRunner";
import { idleSnapshot, type RobotRunStatus, type RunEvasion, type RunPhase, type RunResultRow, type RunRobot, type RunSnapshot } from "@/scene/runTypes";
import { VIEW_HEIGHT, VIEW_WIDTH, headingArrow, svgY } from "@/scene/mapView";
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
const BAR_SUFFIX: Record<RunResultRow["status"], string> = {
  pending: "", running: " 走行中", waiting: " 到着待ち", arrived: " ✓", failed: " ✗",
};
const CORNER_MM = 72;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
const mark = (ok: boolean, warn?: boolean) => warn ? <TriangleAlert aria-label="警告" /> : ok ? <CircleCheck aria-label="満たしています" /> : <CircleX aria-label="満たしていません" />;

function RunOverlay({ robots, excluded, evasions }: { robots: RunRobot[]; excluded: RunRobot[]; evasions: RunEvasion[] }) {
  return <g pointerEvents="none">
    {[[0, 0], [VIEW_WIDTH - CORNER_MM, 0], [0, VIEW_HEIGHT - CORNER_MM], [VIEW_WIDTH - CORNER_MM, VIEW_HEIGHT - CORNER_MM]].map(([x, y]) => (
      <rect key={`corner-${x}-${y}`} data-part="marker-clearance" x={x} y={y} width={CORNER_MM} height={CORNER_MM} fill="#121923" opacity={0.85} />
    ))}
    <text x={CORNER_MM + 12} y={VIEW_HEIGHT - 12} fontSize={14} fill="#121923" opacity={0.75}>四隅は基準マーカーのため空白</text>
    {evasions.map((e) => {
      const mx = (e.band.from.x + e.band.to.x) / 2;
      const my = svgY((e.band.from.y + e.band.to.y) / 2);
      return <g key={`${e.yielder}-${e.priority}`} data-part="evasion-band">
        <line x1={e.band.from.x} y1={svgY(e.band.from.y)} x2={e.band.to.x} y2={svgY(e.band.to.y)} stroke="#ffbd70" strokeOpacity={0.35}
          strokeWidth={e.band.halfWidthMm * 2} strokeLinecap="round" />
        <circle cx={e.spot.x} cy={svgY(e.spot.y)} r={SAFETY_RADIUS_MM / 2} fill="none" stroke="#ffbd70" strokeWidth={4} />
        <text x={mx} y={my - 10} textAnchor="middle" fontSize={14} fontWeight={700} fill="#121923">
          {`退避帯（${e.yielder} が ${e.priority} に道を譲る）`}
        </text>
      </g>;
    })}
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
    {excluded.map((robot) => robot.pose ? (
      <g key={robot.trackId} data-part="excluded-robot">
        <circle cx={robot.pose.x} cy={svgY(robot.pose.y)} r={SAFETY_RADIUS_MM} fill="none" stroke="#9aa3a0" strokeWidth={3} strokeDasharray="6 6" />
        <text x={robot.pose.x} y={svgY(robot.pose.y) + 5} textAnchor="middle" fontSize={14} fontWeight={700} fill="#121923">{robot.name}</text>
      </g>
    ) : null)}
  </g>;
}

function Progress({ run }: { run: RunSnapshot }) {
  const names = Array.from(new Set(run.rows.map((row) => row.robot)));
  const span = Math.max(run.duration, 1);
  return <section className={styles.card} aria-label="進行">
    <h3>進行（計画の動作バーと、実機の到着状況。縦線＝進行時計）</h3>
    {names.map((name) => <div key={name} className={styles.lane} role="group" aria-label={`${name} の進行`}>
      <span>{name}</span>
      <div className={styles.track}>
        {run.rows.filter((row) => row.robot === name).map((row) => <span key={`${row.trackId}-${row.action}-${row.planStart}`} className={styles.chip}
          data-status={row.status} title={`${row.action} ${row.planStart.toFixed(1)}〜${row.planEnd.toFixed(1)}秒`}
          style={{ left: `${row.planStart / span * 100}%`, width: `${Math.max(1, (row.planEnd - row.planStart) / span * 100)}%` }}>
          {`${row.action}${BAR_SUFFIX[row.status]}`}
        </span>)}
        <i className={styles.head} style={{ left: `${Math.min(100, run.clock / span * 100)}%` }} />
      </div>
    </div>)}
    <p className={styles.legend}>灰=未着手　白＋太枠=実行中　青=完了待ち（全台が待つ）　緑=到着確認済　赤=失敗</p>
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

const anomalyRank = (status: RobotRunStatus): number =>
  status === "lost" || status === "failed" ? 0 : status === "waiting" || status === "evading" ? 1 : status === "driving" ? 2 : 3;

export function SceneRunPanel() {
  const { status, runState, runOp, sendRun } = useFleetSocket();
  const { project } = useSceneProject();
  const [mapId, setMapId] = useState("");
  const [avoidWalls, setAvoidWalls] = useState(true);
  const run = runState?.state ?? idleSnapshot();
  const connected = status === "connected";
  const selected = run.mapId ?? mapId;
  const map = project?.maps.find((item) => item.id === selected) ?? null;
  const busy = run.phase === "running" || run.phase === "waiting" || run.phase === "halted" || run.positioning.active;
  const resumable = run.resume.every((item) => item.ok);
  const mismatches = run.initialMismatches ?? [];
  const excluded = run.excludedRobots ?? [];
  const allRobots = [...run.robots, ...excluded].sort((a, b) => anomalyRank(a.status) - anomalyRank(b.status));
  const arrivedPositionCount = run.positioning.items.filter((item) => item.state === "arrived").length;

  return <div className={styles.page}>
    <section className={styles.bar} aria-label="実行バー">
      <span>プロジェクト: <strong>{project?.name ?? "—"}</strong></span>
      <label>実行するシーン
        <select value={selected} disabled={!connected || busy} onChange={(event) => { setMapId(event.target.value); if (event.target.value) sendRun({ type: "prepare", mapId: event.target.value }); }}>
          <option value="">マップを選択</option>
          {project?.maps.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <strong className={styles.phase} data-phase={run.phase} role="status">{run.phase === "waiting" && run.evasions.length > 0 ? "退避中" : PHASE[run.phase]}</strong>
      <span aria-label="進行時計">{clock(run.clock)} / 計画 {clock(run.duration)}</span>
      <span>経過（実時間）{clock(run.realMs / 1000)}　止まっていた時間 +{(run.waitedMs / 1000).toFixed(1)}秒</span>
      <label>待機上限(秒)
        <input type="number" min={5} max={300} step={5} value={run.waitTimeoutSec ?? 30} disabled={!connected}
          aria-label="到着待ちの上限秒数"
          onChange={(event) => {
            const sec = Number(event.target.value);
            if (Number.isFinite(sec) && sec >= 5 && sec <= 300) sendRun({ type: "setWaitTimeout", seconds: sec });
          }} />
      </label>
      <div className={styles.actions}>
        {run.phase === "arming" && <>
          <button type="button" className={consoleStyles.primary} disabled={!run.canStart} onClick={() => sendRun({ type: "start" })}><Play />開始</button>
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

    {run.phase === "halted" && run.resume.length > 0 && <section className={styles.card} aria-label="再開の条件">
      <h3>自動再開の条件（すべて満たして1秒続くと再開します）</h3>
      <ul>{run.resume.map((item) => <li key={item.label} data-ok={item.ok}>{mark(item.ok)}{item.label}（{item.detail}）</li>)}</ul>
      <p>位置が大きくずれている場合（人が動かしたなど）は、自動では再開しません。「再開」の前に、各機体は予定位置とのずれを補正します。</p>
    </section>}

    {run.phase === "arming" && <div className={styles.armingGrid}>
      <section className={styles.card} aria-label="実行前の確認">
        <h3>実行前の確認（満たしたものから ✓ になります）</h3>
        <ul>{run.checks.map((item) => <li key={item.id} data-ok={item.ok || !!item.warn}>{mark(item.ok, item.warn && !item.ok)}{item.label}（{item.detail}）</li>)}</ul>
        {!run.canStart && run.checks.length > 0 && <p>✗ をすべて解消すると開始できます。</p>}
      </section>
      <div className={styles.leftCol}>
        <section className={styles.card} aria-label="初期位置とのずれ">
          <h3>初期位置とのずれ（✗ のロボットだけ詳しく）</h3>
          {mismatches.length === 0
            ? <p>全ロボットが初期位置の判定（位置{ARRIVE_POS_MM}mm・向き{ARRIVE_YAW_DEG}°以内）を満たしています。</p>
            : <table>
              <thead><tr><th>ロボット</th><th>位置のずれ</th><th>向きのずれ</th><th>対処</th></tr></thead>
              <tbody>{mismatches.map((m) => <tr key={m.trackId}>
                <td>{m.name}</td>
                <td>{m.posErrMm === null ? "未検出 ✗" : `${Math.round(m.posErrMm)}mm ${m.posOk ? "✓" : "✗"}`}</td>
                <td>{m.yawErrDeg === null ? "未検出 ✗" : `${Math.round(m.yawErrDeg)}° ${m.yawOk ? "✓" : "✗"}`}</td>
                <td>マップの目印へ手で置き直すか、下の自動移動を使ってください</td>
              </tr>)}</tbody>
            </table>}
        </section>
        <section className={styles.card} aria-label="初期位置への移動">
          <h3>初期位置へ自動で動かす（1台ずつ順番に）</h3>
          <div className={styles.actions} style={{ marginLeft: 0, marginBottom: 8, flexWrap: "wrap" }}>
            <button type="button" className={consoleStyles.secondary} disabled={run.positioning.active} onClick={() => sendRun({ type: "position", avoidWalls })}>初期位置へ移動</button>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={avoidWalls} disabled={run.positioning.active} onChange={(event) => setAvoidWalls(event.target.checked)} />
              MAPの壁を迂回する
            </label>
            {run.positioning.active && <span className={styles.phase} data-phase="waiting">初期位置へ移動中 {arrivedPositionCount}/{run.positioning.items.length}</span>}
            <span>全台が到着判定を満たすと「開始」が有効になります</span>
          </div>
          {run.positioning.items.length > 0 && <table>
            <thead><tr><th>順</th><th>ロボット</th><th>状態</th></tr></thead>
            <tbody>{run.positioning.items.map((item, idx) => <tr key={item.trackId}>
              <td>{idx + 1}</td><td>{item.name}</td><td>{POSITION[item.state]}{item.detail ? `（${item.detail}）` : ""}</td>
            </tr>)}</tbody>
          </table>}
          <p>順番は「優先順位→マーカーID」。動かしていない機体は障害物として扱います。</p>
        </section>
      </div>
    </div>}

    <div className={styles.workbench}>
      <div className={styles.leftCol}>
        {map && <section className={styles.card} aria-label="実行マップ">
          <h3>マップ（計画=破線、実機の測位位置=実線、安全半径60mm、演出つき）</h3>
          <MapStage map={map} time={Math.min(run.clock, Math.max(run.duration, 0))} showGrid={false} gridMm={map.editGridMm}
            overlay={<RunOverlay robots={run.robots} excluded={excluded} evasions={run.evasions} />} />
        </section>}
        {run.rows.length > 0 && <Progress run={run} />}
      </div>
      <div className={styles.rightCol}>
        <section className={`${styles.card} ${styles.statusSticky}`} aria-label="いまの全体の状態">
          <h3>いまの全体の状態</h3>
          <p className={styles.reason} role="status">{run.reason}</p>
          {(run.alerts ?? []).map((alertText, index) => <p key={index} className={styles.alertBanner} role="status">{alertText}</p>)}
        </section>
        <section className={styles.card} aria-label="ロボット別">
          <details open>
            <summary>ロボット別（{allRobots.length}台）</summary>
            <div className={styles.cards} data-compact={allRobots.length > 4}>
              {allRobots.map((robot) => {
                const posOk = robot.posErrMm !== null && robot.posErrMm <= ARRIVE_POS_MM;
                const yawOk = robot.yawErrDeg !== null && robot.yawErrDeg <= ARRIVE_YAW_DEG;
                const holdPct = Math.min(100, Math.round((robot.settledSec / (ARRIVE_HOLD_MS / 1000)) * 100));
                return <article key={robot.trackId} className={styles.card} data-status={robot.status}>
                  <h3>{robot.name}<span>{ROBOT_STATUS[robot.status]}</span></h3>
                  <p>追跡 {robot.tracking}{robot.markerId !== null ? ` ・ ID ${robot.markerId}` : ""}{robot.priority !== null ? ` ・ 優先 ${robot.priority}` : ""}</p>
                  {robot.bar && <p>{robot.bar}（{robot.barStart?.toFixed(1)}〜{robot.barEnd?.toFixed(1)}秒）</p>}
                  {robot.posErrMm !== null && <>
                    <p>
                      位置誤差 {robot.posErrMm.toFixed(1)}mm {posOk ? "✓" : "✗"}　向き誤差 {robot.yawErrDeg?.toFixed(1)}° {yawOk ? "✓" : "✗"}　継続 {robot.settledSec.toFixed(1)} / 0.3秒
                    </p>
                    <div className={styles.meter} aria-hidden="true"><i style={{ width: `${holdPct}%` }} /></div>
                  </>}
                  {robot.note && <p>{robot.note}</p>}
                </article>;
              })}
            </div>
          </details>
        </section>
      </div>
    </div>

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
      <details open>
        <summary>イベントログ（新しい順）</summary>
        <ol className={styles.logList}>{[...run.log].reverse().map((entry, index) => <li key={index} data-kind={entry.kind}>{clock(entry.clock)}　{entry.text}</li>)}</ol>
      </details>
    </section>
  </div>;
}
