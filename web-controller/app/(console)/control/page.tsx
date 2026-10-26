"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Square,
  Search, Check, Camera, Video, VideoOff, Play, RotateCcw, TriangleAlert,
} from "lucide-react";
import { useFleetSocket, type VehicleImage } from "@/hooks/useFleetSocket";
import type { DriveCommand, ExpressionId, DisplayLayoutMode, VehicleTelemetry } from "@/fleet/protocol";
import styles from "../console.module.css";

const EXPRESSIONS: { label: string; id: ExpressionId }[] = [
  { label: "通常", id: "neutral" }, { label: "嬉しい", id: "happy" },
  { label: "楽しい", id: "fun" }, { label: "笑う", id: "laugh" },
  { label: "驚き", id: "surprised" }, { label: "好奇心", id: "curious" },
  { label: "考え中", id: "thinking" }, { label: "ウインク", id: "wink" },
  { label: "悲しい", id: "worried" }, { label: "怒り", id: "angry" },
  { label: "眠い", id: "sleepy" }, { label: "大好き", id: "love" },
  { label: "ショック", id: "shocked" }, { label: "ギブアップ", id: "giveup" },
  { label: "照れる", id: "shy" }, { label: "余裕", id: "composed" },
];

// テレメトリのPWM(0-255)を、前進回転を正・逆回転を負とする符号付き表示に変換する。
// 右旋回(c)は右モーター逆回転、左旋回(d)は左モーター逆回転(esp32_rc_car.inoのapplyMotorControlと同期)。
const MOTOR_DIRECTION: Record<DriveCommand, [number, number]> = {
  a: [1, 1], b: [-1, -1], c: [1, -1], d: [-1, 1], e: [0, 0],
};

function motorOutput(telemetry: VehicleTelemetry | null | undefined): { left: string; right: string } {
  if (!telemetry) return { left: "--", right: "--" };
  const [left, right] = MOTOR_DIRECTION[telemetry.cmd] ?? [0, 0];
  const format = (pwm: number, sign: number) => {
    const value = pwm * sign;
    return value > 0 ? `+${value}` : `${value}`;
  };
  return { left: format(telemetry.speedL, left), right: format(telemetry.speedR, right) };
}

const DIRECTIONS = [
  { cmd: "a", label: "前進", Icon: ArrowUp, position: styles.forward },
  { cmd: "d", label: "左旋回", Icon: ArrowLeft, position: styles.left },
  { cmd: "c", label: "右旋回", Icon: ArrowRight, position: styles.right },
  { cmd: "b", label: "後退", Icon: ArrowDown, position: styles.backward },
] as const;

function DrivePad({ targetKey, enabled, speed, sendCommand }: {
  targetKey: string;
  enabled: boolean;
  speed: number;
  sendCommand: ReturnType<typeof useFleetSocket>["sendCommand"];
}) {
  const [active, setActive] = useState<DriveCommand>("e");
  const held = useRef<{ ids: string[]; cmd: DriveCommand; speed: number } | null>(null);
  const inputOwner = useRef<string | null>(null);

  const stop = useCallback(() => {
    const drive = held.current;
    held.current = null;
    inputOwner.current = null;
    if (drive) sendCommand(drive.ids, "e", 0, 0);
    setActive("e");
  }, [sendCommand]);

  const begin = useCallback((cmd: DriveCommand, owner: string) => {
    if (!enabled || held.current) return;
    const ids = JSON.parse(targetKey) as string[];
    if (!ids.length) return;
    inputOwner.current = owner;
    held.current = { ids, cmd, speed };
    sendCommand(ids, cmd, speed, speed);
    setActive(cmd);
  }, [enabled, targetKey, speed, sendCommand]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const drive = held.current;
      if (drive) sendCommand(drive.ids, drive.cmd, drive.speed, drive.speed);
    }, 200);
    const onHidden = () => { if (document.hidden) stop(); };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", onHidden);
      stop();
    };
  }, [targetKey, enabled, speed, sendCommand, stop]);

  return (
    <div className={styles.drivePad} role="group" aria-label="走行操作">
      {DIRECTIONS.map(({ cmd, label, Icon, position }) => (
        <button key={cmd} className={`${styles.direction} ${position}`}
          aria-label={label} title={label} aria-pressed={active === cmd} disabled={!enabled}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            begin(cmd, `pointer:${event.pointerId}`);
          }}
          onPointerUp={(event) => { if (inputOwner.current === `pointer:${event.pointerId}`) stop(); }}
          onPointerCancel={stop} onLostPointerCapture={stop} onBlur={stop}
          onKeyDown={(event) => {
            if (event.key !== " " && event.key !== "Enter") return;
            event.preventDefault();
            if (!event.repeat) begin(cmd, `key:${event.key}`);
          }}
          onKeyUp={(event) => {
            if (inputOwner.current === `key:${event.key}`) {
              event.preventDefault();
              stop();
            }
          }}>
          <Icon aria-hidden="true" /><span>{label}</span>
        </button>
      ))}
      <button className={styles.padStop} aria-label="選択ロボットを停止" title="選択ロボットを停止"
        disabled={!enabled} onClick={() => { stop(); sendCommand(JSON.parse(targetKey), "e", 0, 0); }}>
        <Square aria-hidden="true" /><span>停止</span>
      </button>
    </div>
  );
}

function VehicleSnapshot({ image }: { image?: VehicleImage }) {
  if (!image) return <div className={styles.noImage}>映像未受信</div>;
  return <figure className={styles.snapshot}>
    <img src={`data:image/jpeg;base64,${image.dataB64}`} alt="選択ロボットのカメラ映像"
      width={image.width} height={image.height} />
    <figcaption>{new Date(image.capturedAt).toLocaleTimeString()} 取得</figcaption>
  </figure>;
}

export default function ControlPage() {
  const { status, vehicles, devices, robots, routeStatus, availableRoutes, images, sendCommand, setMode,
    startRoute, stopRoute, requestSnapshot, requestStream, requestExpression, requestDisplayLayout, emergencyEpoch } = useFleetSocket();
  const [selectionMode, setSelectionMode] = useState<"single" | "group">("single");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [speed, setSpeed] = useState(190);
  const [selectedRouteId, setSelectedRouteId] = useState("");
  const streamingIds = new Set(devices.filter((device) => device.streaming).map((device) => device.deviceId));
  const streamingRef = useRef(streamingIds);
  streamingRef.current = streamingIds;

  useEffect(() => () => {
    streamingRef.current.forEach((deviceId) => requestStream(deviceId, "stop"));
  }, [requestStream]);

  const connected = status === "connected";
  const online = vehicles.filter((vehicle) => vehicle.status === "online");
  const focused = vehicles.find((vehicle) => vehicle.deviceId === focusedId);
  const focusedRobot = robots.find((robot) => robot.driveDeviceId === focusedId);
  const camera = devices.find((device) => device.deviceId === focusedRobot?.cameraDeviceId);
  const cameraReady = connected && camera?.status === "online";
  const targets = vehicles.filter((vehicle) => selectionMode === "single"
    ? vehicle.deviceId === focusedId : selectedIds.has(vehicle.deviceId));
  const targetKey = JSON.stringify(targets.map((vehicle) => vehicle.deviceId).sort());
  const canDrive = connected && targets.length > 0 && targets.every((vehicle) =>
    vehicle.status === "online" && vehicle.mode === "manual");
  const filtered = vehicles.filter((vehicle) => `${vehicle.name} ${vehicle.deviceId}`
    .toLowerCase().includes(query.toLowerCase()));

  const changeSelectionMode = (mode: "single" | "group") => {
    setSelectionMode(mode);
    setSelectedIds(new Set());
    setFocusedId(null);
  };
  const toggleSelect = (deviceId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(deviceId)) next.delete(deviceId); else next.add(deviceId);
      return next;
    });
  };
  const toggleStream = (deviceId: string) => {
    requestStream(deviceId, streamingIds.has(deviceId) ? "stop" : "start");
  };
  const blockReason = !connected ? "ハブ未接続" : !targets.length ? "操作対象未選択"
    : targets.some((vehicle) => vehicle.status !== "online") ? "操作対象に未接続のロボットがあります"
    : targets.some((vehicle) => vehicle.mode !== "manual") ? "操作対象を手動モードに切り替えてください" : null;
  const showSelectionWarning = blockReason === "操作対象未選択";

  return <>
    <div className={styles.workspace}>
      <aside className={styles.roster} data-mode={selectionMode} aria-label="ロボット選択">
        <div className={styles.sectionHeading}><h2>ロボット</h2><span>{connected ? online.length : 0} / {vehicles.length} 台接続</span></div>
        <div className={styles.segmented} role="group" aria-label="操作対象の選択方式">
          <button aria-pressed={selectionMode === "single"} onClick={() => changeSelectionMode("single")}>個別制御</button>
          <button aria-pressed={selectionMode === "group"} onClick={() => changeSelectionMode("group")}>複数制御</button>
        </div>
        <label className={styles.search}><Search aria-hidden="true" />
          <input aria-label="ロボットを検索" placeholder="名前・IDで検索" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {selectionMode === "group" && <div className={styles.batchSelection}>
          <label><input type="checkbox" aria-label="接続中の全ロボットを選択"
            checked={online.length > 0 && online.every((vehicle) => selectedIds.has(vehicle.deviceId))}
            disabled={!connected || !online.length}
            onChange={(event) => setSelectedIds(event.target.checked ? new Set(online.map((vehicle) => vehicle.deviceId)) : new Set())} />接続中を全選択</label>
          <button className={styles.iconButton} title="選択を解除" aria-label="選択を解除" onClick={() => setSelectedIds(new Set())}><RotateCcw /></button>
        </div>}
        <div className={styles.vehicleList}>
          {filtered.map((vehicle) => {
            const selected = selectionMode === "single" ? focusedId === vehicle.deviceId : selectedIds.has(vehicle.deviceId);
            const contents = <><div className={styles.vehicleTitle}><strong>{vehicle.name}</strong>
              {selected && <Check aria-hidden="true" />}</div>
              <span className={styles.deviceId}>{vehicle.deviceId}</span>
              <span className={styles.vehicleStatus}><i data-online={connected && vehicle.status === "online"} />
                {connected && vehicle.status === "online" ? "接続中" : "未接続"}<span>{vehicle.mode === "manual" ? "手動" : "自動"}</span>
              </span></>;
            return selectionMode === "single" ? <button key={vehicle.deviceId} className={styles.vehicle}
              aria-pressed={selected} onClick={() => setFocusedId(vehicle.deviceId)}>{contents}</button>
              : <label key={vehicle.deviceId} className={styles.groupVehicle} data-selected={selected}>
                <input type="checkbox" checked={selected} disabled={!connected || (vehicle.status !== "online" && !selected)}
                  onChange={() => toggleSelect(vehicle.deviceId)} aria-label={`${vehicle.name}を選択`} />
                <div>{contents}</div>
              </label>;
          })}
          {!filtered.length && <p className={styles.empty}>{vehicles.length ? "一致するロボットはありません" : connected ? "接続中のロボットはありません" : "ロボット一覧を取得できません"}</p>}
        </div>
      </aside>

      <section className={styles.control} aria-label="ロボット操作">
        <div className={styles.controlHeading}>
          <div><h2>{selectionMode === "group" ? `選択中の ${targets.length} 台` : focused?.name || "ロボット未選択"}</h2>
            {targets.length > 0 && <p>{selectionMode === "group" ? targets.map((vehicle) => vehicle.name).join("、") : focused?.deviceId}</p>}
            {showSelectionWarning && <span className={styles.selectionWarning} role="status"><TriangleAlert aria-hidden="true" /><span>操作対象未選択</span></span>}
          </div>
          <span className={styles.targetBadge}>{selectionMode === "single" ? "個別制御" : "複数制御"}</span>
        </div>
        {blockReason && !showSelectionWarning && <div className={styles.notice} role="status"><TriangleAlert aria-hidden="true" /><span>{blockReason}</span></div>}
        <div className={styles.controlBody}>
          <div className={styles.driving}>
            <div className={styles.sectionHeading}><h3>走行</h3><span>{canDrive ? "操作可能" : "操作不可"}</span></div>
            <DrivePad key={emergencyEpoch} targetKey={targetKey} enabled={canDrive} speed={speed} sendCommand={sendCommand} />
            <label className={styles.speed}><span>速度 <output>{Math.round(speed / 255 * 100)}<small>%</small></output></span>
              <input type="range" min="0" max="255" step="1" value={speed} aria-label="走行速度"
                onChange={(event) => setSpeed(Number(event.target.value))} />
              <span className={styles.rangeLabels}><span>0</span><span>100%</span></span>
            </label>
          </div>
          <div className={styles.inspector}>
            <h3>制御モード</h3>
            {targets.length > 0 ? targets.map((vehicle) => <div key={vehicle.deviceId} className={styles.modeRow}>
              {selectionMode === "group" && <strong>{vehicle.name}</strong>}
              <div className={styles.segmented} role="group" aria-label={`${vehicle.name}の制御モード`}>
                <button aria-pressed={vehicle.mode === "manual"} disabled={!connected || vehicle.status !== "online"}
                  onClick={() => setMode(vehicle.deviceId, "manual")}>手動</button>
                <button aria-pressed={vehicle.mode === "auto"} disabled={!connected || vehicle.status !== "online"}
                  onClick={() => {
                    sendCommand([vehicle.deviceId], "e", 0, 0);
                    setMode(vehicle.deviceId, "auto");
                  }}>自動</button>
              </div>
            </div>) : <p className={styles.muted}>未選択</p>}
            {selectionMode === "single" && focused && <div className={styles.telemetry}>
              <h3>モーター出力</h3>
              <dl><div><dt>左</dt><dd>{motorOutput(connected && focused.status === "online" ? focused.telemetry : null).left}</dd></div>
                <div><dt>右</dt><dd>{motorOutput(connected && focused.status === "online" ? focused.telemetry : null).right}</dd></div></dl>
            </div>}
            {targets.length > 0 && <details className={styles.settings}>
              <summary>ディスプレイ設定</summary>
              <label>表情<select aria-label="表情" defaultValue="" disabled={!connected || !targets.length || targets.some((vehicle) => vehicle.status !== "online")}
                onChange={(event) => { if (event.target.value) requestExpression(JSON.parse(targetKey), event.target.value as ExpressionId); event.target.value = ""; }}>
                <option value="" disabled>表情を送信…</option>{EXPRESSIONS.map((expression) => <option key={expression.id} value={expression.id}>{expression.label}</option>)}
              </select></label>
              <label>画面レイアウト<select aria-label="画面レイアウト" defaultValue="" disabled={!connected || !targets.length || targets.some((vehicle) => vehicle.status !== "online")}
                onChange={(event) => { if (event.target.value) requestDisplayLayout(JSON.parse(targetKey), event.target.value as DisplayLayoutMode); event.target.value = ""; }}>
                <option value="" disabled>レイアウトを送信…</option><option value="split">分割</option><option value="full">全画面</option><option value="auto">自動</option>
              </select></label>
            </details>}
            {selectionMode === "single" && focused && focusedRobot && <details className={styles.settings}>
              <summary>カメラ</summary>
              {!focusedRobot.cameraDeviceId && <p className={styles.muted}>カメラは<Link href="/robots">ロボット構成</Link>で紐付けます。</p>}
              {focusedRobot.cameraDeviceId && !cameraReady && <p className={styles.cameraWarning} role="status"><TriangleAlert aria-hidden="true" />カメラ未接続</p>}
              <div className={styles.cameraActions}>
                <button className={styles.secondary} disabled={!cameraReady} onClick={() => camera && requestSnapshot(camera.deviceId)}><Camera />撮影</button>
                <button className={styles.secondary} disabled={!cameraReady} aria-pressed={!!camera && streamingIds.has(camera.deviceId)} onClick={() => camera && toggleStream(camera.deviceId)}>
                  {camera && streamingIds.has(camera.deviceId) ? <VideoOff /> : <Video />}{camera && streamingIds.has(camera.deviceId) ? "配信停止" : "ライブ"}
                </button>
              </div><VehicleSnapshot image={cameraReady && camera ? images[camera.deviceId] : undefined} />
            </details>}
          </div>
        </div>
        <section className={styles.routes} aria-label="自動ルート">
          <div className={styles.sectionHeading}><h3>自動ルート</h3><span>{routeStatus?.running ? `実行中 · ${Math.floor(routeStatus.elapsedMs / 1000)}秒` : "停止中"}</span></div>
          <div className={styles.routeActions}>
            <select aria-label="自動ルートを選択" value={selectedRouteId} disabled={!connected || routeStatus?.running}
              onChange={(event) => setSelectedRouteId(event.target.value)}>
              <option value="">ルートを選択</option>{availableRoutes.map((route) => <option key={route.id} value={route.id}>{route.label}</option>)}
            </select>
            <button className={styles.primary} disabled={!connected || !selectedRouteId || !!routeStatus?.running || !online.some((vehicle) => vehicle.mode === "auto")}
              onClick={() => startRoute(selectedRouteId)}><Play />開始</button>
            <button className={styles.secondary} disabled={!connected || !routeStatus?.running} onClick={stopRoute}><Square />停止</button>
          </div>
          <p className={styles.muted}>対象: {online.filter((vehicle) => vehicle.mode === "auto").map((vehicle) => vehicle.name).join("、") || "自動モードのロボットなし"}</p>
        </section>
      </section>
    </div>
  </>;
}