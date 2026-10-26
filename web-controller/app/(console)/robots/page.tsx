"use client";

import { TriangleAlert } from "lucide-react";
import { useFleetSocket } from "@/hooks/useFleetSocket";
import styles from "../console.module.css";

export default function RobotsPage() {
  const { status, devices, robots, assignment, assignCamera } = useFleetSocket();
  const connected = status === "connected";
  const cameras = devices.filter((device) => device.capabilities.includes("camera"));

  return <div className={styles.preferences}>
    {!robots.length && <p className={styles.empty}>{connected ? "登録済みのロボットはありません" : "ロボット一覧を取得できません"}</p>}
    {robots.map((robot) => {
      const camera = devices.find((device) => device.deviceId === robot.cameraDeviceId);
      const robotAssignment = assignment?.robotId === robot.robotId ? assignment : null;
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
      </section>;
    })}
  </div>;
}
