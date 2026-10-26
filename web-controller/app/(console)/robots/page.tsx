"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useFleetSocket } from "@/hooks/useFleetSocket";
import type { RobotState } from "@/fleet/protocol";
import { TRACKING_LABEL } from "../tracking";
import styles from "../console.module.css";

const MARKER_IDS = [0, 1, 2, 3];

function MarkerHeight({ robot, disabled, onCommit }: { robot: RobotState; disabled: boolean; onCommit: (height: number) => void }) {
  const [draft, setDraft] = useState(String(robot.markerHeightMm));
  const [synced, setSynced] = useState(robot.markerHeightMm);
  if (synced !== robot.markerHeightMm) {
    setSynced(robot.markerHeightMm);
    setDraft(String(robot.markerHeightMm));
  }
  const value = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(value) && value > 0 && value <= 1000;
  const commit = () => { if (valid && value !== robot.markerHeightMm) onCommit(value); };
  return <label>マーカー高さ (mm)
    <input type="number" inputMode="decimal" min="1" max="1000" step="1" value={draft} disabled={disabled}
      aria-invalid={!valid} aria-label={`${robot.name}のマーカー高さ`}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />
    {!valid && <small role="alert">1〜1000の数値を入力してください</small>}
  </label>;
}

export default function RobotsPage() {
  const { status, devices, robots, assignment, assignCamera, poseState, markerAssignment, assignMarker } = useFleetSocket();
  const connected = status === "connected";
  const cameras = devices.filter((device) => device.capabilities.includes("camera"));

  return <div className={styles.preferences}>
    {!robots.length && <p className={styles.empty}>{connected ? "登録済みのロボットはありません" : "ロボット一覧を取得できません"}</p>}
    {robots.map((robot) => {
      const camera = devices.find((device) => device.deviceId === robot.cameraDeviceId);
      const robotAssignment = assignment?.robotId === robot.robotId ? assignment : null;
      const robotMarker = markerAssignment?.robotId === robot.robotId ? markerAssignment : null;
      const tracking = poseState?.poses.find((pose) => pose.robotId === robot.robotId)?.tracking ?? "stale";
      const online = connected && robot.status === "online";
      return <section key={robot.robotId} className={`${styles.preferenceCard} ${styles.robotCard}`} aria-label={`${robot.name}の構成`}>
        <h2>{robot.name}</h2>
        <span className={styles.deviceId}>{robot.driveDeviceId}</span>
        <span className={styles.vehicleStatus}><i data-online={online} />{online ? "接続中" : "未接続"}</span>
        <label>カメラの紐付け<select aria-label={`${robot.name}のカメラの紐付け`} value={robot.cameraDeviceId ?? ""}
          disabled={!connected || !!assignment?.pending}
          onChange={(event) => assignCamera(robot.robotId, event.target.value || null)}>
          <option value="">未割当</option>
          {cameras.map((device) => {
            const owner = robots.find((candidate) => candidate.cameraDeviceId === device.deviceId);
            return <option key={device.deviceId} value={device.deviceId} disabled={!!owner && owner.robotId !== robot.robotId}>
              {device.name} ({device.deviceId}){owner && owner.robotId !== robot.robotId ? ` · ${owner.name}に割当済み` : device.status === "offline" ? " · 未接続" : ""}
            </option>;
          })}
        </select></label>
        {robotAssignment && <p className={styles.assignmentStatus} role={robotAssignment.error ? "alert" : "status"}>
          {robotAssignment.pending ? "保存中…" : robotAssignment.error || "保存しました"}
        </p>}
        {robot.cameraDeviceId && camera?.status !== "online" && <p className={styles.cameraWarning} role="status">
          <TriangleAlert aria-hidden="true" />カメラ未接続</p>}
        <label>測位マーカーID<select aria-label={`${robot.name}の測位マーカーID`} value={robot.markerId ?? ""}
          disabled={!connected || !!markerAssignment?.pending}
          onChange={(event) => assignMarker(robot.robotId, event.target.value === "" ? null : Number(event.target.value))}>
          <option value="">未割当</option>
          {MARKER_IDS.map((id) => {
            const owner = robots.find((candidate) => candidate.markerId === id);
            return <option key={id} value={id} disabled={!!owner && owner.robotId !== robot.robotId}>
              ID {id}{owner && owner.robotId !== robot.robotId ? ` · ${owner.name}に割当済み` : ""}
            </option>;
          })}
        </select></label>
        <MarkerHeight robot={robot} disabled={!connected || !!markerAssignment?.pending}
          onCommit={(height) => assignMarker(robot.robotId, robot.markerId, height)} />
        {robotMarker && <p className={styles.assignmentStatus} role={robotMarker.error ? "alert" : "status"}>
          {robotMarker.pending ? "保存中…" : robotMarker.error || "保存しました"}
        </p>}
        <p className={styles.trackingLine} data-tracking={tracking} role="status">
          {tracking === "tracking" ? null : <TriangleAlert aria-hidden="true" />}測位: {TRACKING_LABEL[tracking]}
        </p>
      </section>;
    })}
  </div>;
}
