"use client";

import { useEffect, useRef, useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import { useFleetSocket } from "@/hooks/useFleetSocket";
import { TRACKING_LABEL } from "../tracking";
import styles from "../console.module.css";

const ROBOT_SIZE_MM = 60;
const TRAIL_POINTS = 60;
const REFERENCE_LABELS = [
  { id: 40, top: true, left: true },
  { id: 41, top: true, left: false },
  { id: 42, top: false, left: false },
  { id: 43, top: false, left: true },
];

export default function FieldPage() {
  const { status, robots, poseState } = useFleetSocket();
  const [trails, setTrails] = useState<Record<string, [number, number][]>>({});
  const last = useRef<Record<string, string>>({});
  const connected = status === "connected";
  const field = poseState?.field;
  const localizer = poseState?.localizer;

  useEffect(() => {
    if (!poseState) return;
    setTrails((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const pose of poseState.poses) {
        if (pose.tracking !== "tracking" || pose.xMm === undefined || pose.yMm === undefined) continue;
        const key = `${pose.xMm.toFixed(0)},${pose.yMm.toFixed(0)}`;
        if (last.current[pose.robotId] === key) continue;
        last.current[pose.robotId] = key;
        next[pose.robotId] = [...(next[pose.robotId] ?? []), [pose.xMm, pose.yMm] as [number, number]].slice(-TRAIL_POINTS);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [poseState]);

  const nameOf = (robotId: string) => robots.find((robot) => robot.robotId === robotId)?.name ?? robotId;
  const warnings: string[] = [];
  if (!connected) warnings.push("ハブ未接続");
  else if (!localizer?.connected || !localizer.running) {
    warnings.push(`測位カメラが動作していません${localizer?.stopReason ? `（${localizer.stopReason}）` : ""}。「測位」画面で開始してください。`);
  } else if (!localizer.extrinsicsOk) warnings.push("基準マーカーが不足しています。座標は無効です。");
  else if (localizer.referenceCount < 4) warnings.push(`基準マーカーが${localizer.referenceCount}/4枚です。精度が低下します。`);
  const outside = poseState?.poses.filter((pose) => pose.tracking === "tracking" && pose.insideField === false) ?? [];
  if (outside.length) warnings.push(`領域外: ${outside.map((pose) => nameOf(pose.robotId)).join("、")}`);

  // 閉じた警告は条件が解消されるまで非表示にし、再発生時に再び出す。
  const [dismissed, setDismissed] = useState<string[]>([]);
  const warningKey = warnings.join("\n");
  useEffect(() => {
    setDismissed((previous) => {
      const kept = previous.filter((text) => warningKey.split("\n").includes(text));
      return kept.length === previous.length ? previous : kept;
    });
  }, [warningKey]);
  const visibleWarnings = warnings.filter((text) => !dismissed.includes(text));

  return <div className={styles.fieldPage}>
    <section className={styles.fieldCard} aria-label="フロアマップ">
      {field ? <svg className={styles.fieldMap} viewBox={`${-20} ${-20} ${field.widthMm + 40} ${field.heightMm + 40}`} role="img"
        aria-label="走行領域とロボットの位置">
        <rect className={styles.fieldSurface} x={0} y={0} width={field.widthMm} height={field.heightMm} />
        {REFERENCE_LABELS.map((reference) => <g key={reference.id}>
          <rect className={styles.fieldReference} x={(reference.left ? 0 : field.widthMm) - 16} y={(reference.top ? 0 : field.heightMm) - 16} width={32} height={32} />
          <text className={styles.fieldLabel} x={(reference.left ? 0 : field.widthMm) + (reference.left ? 24 : -24)}
            y={(reference.top ? 0 : field.heightMm) + (reference.top ? 36 : -24)} textAnchor={reference.left ? "start" : "end"}>{reference.id}</text>
        </g>)}
        {Object.entries(trails).map(([robotId, points]) => points.length > 1 && <polyline key={robotId} className={styles.fieldTrail}
          points={points.map(([x, y]) => `${x},${field.heightMm - y}`).join(" ")} />)}
        {poseState?.poses.map((pose) => {
          if (pose.tracking !== "tracking" || pose.xMm === undefined || pose.yMm === undefined || pose.headingDeg === undefined) return null;
          const radians = pose.headingDeg * Math.PI / 180;
          const cx = pose.xMm, cy = field.heightMm - pose.yMm;
          return <g key={pose.robotId} className={styles.fieldRobot} data-outside={pose.insideField === false}>
            <rect x={cx - ROBOT_SIZE_MM / 2} y={cy - ROBOT_SIZE_MM / 2} width={ROBOT_SIZE_MM} height={ROBOT_SIZE_MM} rx={6}
              transform={`rotate(${-pose.headingDeg} ${cx} ${cy})`} />
            <line x1={cx} y1={cy} x2={cx + Math.cos(radians) * 55} y2={cy - Math.sin(radians) * 55} />
            <text x={cx} y={cy - 44} textAnchor="middle">{nameOf(pose.robotId)}</text>
          </g>;
        })}
      </svg> : <p className={styles.empty}>{connected ? "測位設定を取得しています…" : "ハブ未接続"}</p>}
    </section>
    <section className={styles.fieldCard} aria-label="ロボットの位置一覧">
      <table className={styles.poseTable}>
        <thead><tr><th>ロボット</th><th>マーカー</th><th>状態</th><th>X mm</th><th>Y mm</th><th>向き °</th></tr></thead>
        <tbody>
          {poseState?.poses.map((pose) => <tr key={pose.robotId}>
            <td>{nameOf(pose.robotId)}</td>
            <td>{pose.markerId === null ? "—" : `ID ${pose.markerId}`}</td>
            <td>{pose.tracking !== "tracking" && <TriangleAlert aria-hidden="true" />}{TRACKING_LABEL[pose.tracking]}{pose.insideField === false ? "（領域外）" : ""}</td>
            <td>{pose.xMm?.toFixed(0) ?? "—"}</td><td>{pose.yMm?.toFixed(0) ?? "—"}</td><td>{pose.headingDeg?.toFixed(0) ?? "—"}</td>
          </tr>)}
        </tbody>
      </table>
      {!poseState?.poses.length && <p className={styles.empty}>登録済みのロボットはありません</p>}
    </section>
    <div className={styles.toastStack} aria-live="polite">
      {visibleWarnings.map((text) => <div key={text} className={styles.toast} role="status">
        <TriangleAlert aria-hidden="true" /><span>{text}</span>
        <button className={styles.iconButton} aria-label="警告を閉じる" title="閉じる"
          onClick={() => setDismissed((previous) => [...previous, text])}><X aria-hidden="true" /></button>
      </div>)}
    </div>
  </div>;
}
