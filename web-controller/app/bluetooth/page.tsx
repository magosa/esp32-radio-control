"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useWebBluetooth } from "@/hooks/useWebBluetooth";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AlertTriangle,
  Activity,
  Bluetooth,
  BluetoothOff,
  Gauge,
  Radio,
  Square,
  Terminal,
  Users,
  Zap,
} from "lucide-react";
import { useFleetAppearance } from "@/hooks/useFleetAppearance";
import fleetStyles from "../fleet/fleet.module.css";
import styles from "./bluetooth.module.css";

type Direction = "forward" | "backward" | "left" | "right" | "stop";

export default function ControllerPage() {
  const {
    status,
    deviceName,
    errorMessage,
    isSupported,
    telemetry,
    connect,
    disconnect,
    sendPacket,
  } = useWebBluetooth();

  const [speed, setSpeed] = useState<number>(180);
  const [activeDirection, setActiveDirection] = useState<Direction>("stop");
  const [motorL, setMotorL] = useState<number>(0);
  const [motorR, setMotorR] = useState<number>(0);
  const { appearance, theme, style } = useFleetAppearance();
  const connectionLabel = status === "connected" ? "接続中"
    : status === "connecting" ? "検索中"
      : status === "error" ? "接続エラー"
        : isSupported ? "未接続" : "非対応";

  // Send move command
  const sendDriveCommand = useCallback(
    (dir: Direction, currentSpeed: number) => {
      let cmd = "e";
      let left = 0;
      let right = 0;

      switch (dir) {
        case "forward":
          cmd = "a";
          left = currentSpeed;
          right = currentSpeed;
          break;
        case "backward":
          cmd = "b";
          left = currentSpeed;
          right = currentSpeed;
          break;
        case "right":
          cmd = "c";
          left = currentSpeed;
          right = currentSpeed;
          break;
        case "left":
          cmd = "d";
          left = currentSpeed;
          right = currentSpeed;
          break;
        case "stop":
        default:
          cmd = "e";
          left = 0;
          right = 0;
          break;
      }

      setMotorL(left);
      setMotorR(right);
      sendPacket(`${cmd},${left},${right};`);
    },
    [sendPacket]
  );

  // Handle pointer down (touch or mouse press)
  const handlePointerDown = (dir: Direction) => {
    setActiveDirection(dir);
    sendDriveCommand(dir, speed);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(20);
    }
  };

  // Handle pointer up / cancel
  const handlePointerUp = () => {
    setActiveDirection("stop");
    sendDriveCommand("stop", 0);
  };

  // Emergency stop
  const handleEmergencyStop = () => {
    setActiveDirection("stop");
    sendDriveCommand("stop", 0);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate([60, 40, 60]);
    }
  };

  // Keyboard controls for desktop testing
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") {
        handlePointerDown("forward");
      } else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") {
        handlePointerDown("backward");
      } else if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
        handlePointerDown("left");
      } else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
        handlePointerDown("right");
      } else if (e.key === " " || e.key === "Escape") {
        handleEmergencyStop();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d", "W", "A", "S", "D"];
      if (keys.includes(e.key)) {
        handlePointerUp();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [speed, sendDriveCommand]);

  // Periodic Heartbeat / Keepalive (500ms)
  // Keeps BLE link actively alive without saturating the GATT queue
  useEffect(() => {
    if (status !== "connected") return;

    const interval = setInterval(() => {
      sendDriveCommand(activeDirection, activeDirection === "stop" ? 0 : speed);
    }, 500);

    return () => clearInterval(interval);
  }, [status, activeDirection, speed, sendDriveCommand]);

  return (
    <main className={`${fleetStyles.fleet} ${styles.bluetooth}`} data-theme={theme} data-motion={appearance.motion ? "on" : "off"} style={style}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.brand}>
            <div>
              <h1>Bluetoothコントローラー</h1>
              <p>{status === "connected" ? deviceName || "ESP32_RC_Car" : "Web Bluetooth SPP"}</p>
            </div>
            <span className={fleetStyles.connection} role="status">
              <Radio aria-hidden="true" data-connected={status === "connected"} />{connectionLabel}
            </span>
          </div>

          <nav className={fleetStyles.headerActions} aria-label="コントローラーナビゲーション">
            <Link
              href="/fleet"
              className={fleetStyles.secondary}
            >
              <Users aria-hidden="true" />
              フリート
            </Link>
            {status === "connected" ? (
              <button
                onClick={disconnect}
                className={fleetStyles.secondary}
              >
                <BluetoothOff aria-hidden="true" />
                切断
              </button>
            ) : (
              <button
                onClick={connect}
                disabled={status === "connecting" || !isSupported}
                className={fleetStyles.primary}
              >
                <Bluetooth aria-hidden="true" />
                {status === "connecting" ? "検索中…" : "Bluetooth接続"}
              </button>
            )}
          </nav>
        </div>
        {errorMessage && (
          <div className={`${fleetStyles.notice} ${styles.errorNotice}`} role="alert">
            <AlertTriangle aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        )}
      </header>

      <div className={styles.content}>
      <section className={styles.metrics} aria-label="接続テレメトリ">
        <article className={`${fleetStyles.preferenceCard} ${styles.metric}`}>
          <span className={styles.metricLabel}><Activity aria-hidden="true" />接続状態</span>
          <strong data-connected={status === "connected"}>{connectionLabel}</strong>
          <small>{status === "connected" ? deviceName || "ESP32_RC_Car" : "Web Bluetooth SPP"}</small>
        </article>
        <article className={`${fleetStyles.preferenceCard} ${styles.metric}`}>
          <span className={styles.metricLabel}><Gauge aria-hidden="true" />応答時間</span>
          <strong>{status === "connected" ? `${telemetry.latencyMs ?? 15} ms` : "--"}</strong>
          <small>レイテンシ</small>
        </article>
        <article className={`${fleetStyles.preferenceCard} ${styles.metric}`}>
          <span className={styles.metricLabel}><Zap aria-hidden="true" />送信数</span>
          <strong>{telemetry.packetsSentCount}</strong>
          <small>パケット</small>
        </article>
      </section>

      <div className={styles.controlGrid}>
      <section className={`${fleetStyles.driving} ${styles.drivePanel}`} aria-labelledby="bluetooth-drive-heading">
        <div className={styles.panelHeading}><h2 id="bluetooth-drive-heading">走行</h2><span>左右モーター出力</span></div>
        <div className={styles.motorReadings}>
          <span>左 <strong>{motorL}</strong><small>PWM</small></span>
          <span>右 <strong>{motorR}</strong><small>PWM</small></span>
        </div>
        <div className={styles.motorTracks}>
          <div className={styles.motorTrack}>
            <div
              className={styles.motorFill}
              style={{ width: `${(motorL / 255) * 100}%` }}
            />
          </div>
          <div className={styles.motorTrack}>
            <div
              className={styles.motorFill}
              style={{ width: `${(motorR / 255) * 100}%` }}
            />
          </div>
        </div>

        <div className={`${fleetStyles.drivePad} ${styles.dpad}`} role="group" aria-label="走行操作">
          <button
            onPointerDown={() => handlePointerDown("forward")}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className={`${fleetStyles.direction} ${fleetStyles.forward}`}
            aria-label="前進"
            title="前進"
            aria-pressed={activeDirection === "forward"}
          >
            <ArrowUp aria-hidden="true" />
            <span>前進</span>
          </button>
          <button
            onPointerDown={() => handlePointerDown("left")}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className={`${fleetStyles.direction} ${fleetStyles.left}`}
            aria-label="左旋回"
            title="左旋回"
            aria-pressed={activeDirection === "left"}
          >
            <ArrowLeft aria-hidden="true" />
            <span>左旋回</span>
          </button>
          <button
            onClick={handleEmergencyStop}
            className={fleetStyles.padStop}
            aria-label="停止"
            title="停止"
          >
            <Square aria-hidden="true" />
            <span>停止</span>
          </button>
          <button
            onPointerDown={() => handlePointerDown("right")}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className={`${fleetStyles.direction} ${fleetStyles.right}`}
            aria-label="右旋回"
            title="右旋回"
            aria-pressed={activeDirection === "right"}
          >
            <ArrowRight aria-hidden="true" />
            <span>右旋回</span>
          </button>
          <button
            onPointerDown={() => handlePointerDown("backward")}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className={`${fleetStyles.direction} ${fleetStyles.backward}`}
            aria-label="後退"
            title="後退"
            aria-pressed={activeDirection === "backward"}
          >
            <ArrowDown aria-hidden="true" />
            <span>後退</span>
          </button>
        </div>

        <div className={styles.emergencyRow}>
          <button
            onClick={handleEmergencyStop}
            className={fleetStyles.emergency}
          >
            <AlertTriangle aria-hidden="true" />
            緊急停止
          </button>
        </div>
      </section>

      <aside className={styles.sidePanel}>
      <section className={`${fleetStyles.inspector} ${styles.speedPanel}`} aria-labelledby="bluetooth-speed-heading">
        <h2 id="bluetooth-speed-heading">速度</h2>
        <div className={`${fleetStyles.speed} ${styles.speedControl}`}>
          <span>
            <label htmlFor="bluetooth-speed"><Gauge aria-hidden="true" />PWM出力</label>
            <output htmlFor="bluetooth-speed">{speed}<small>PWM</small></output>
          </span>
          <input
            id="bluetooth-speed"
            type="range"
            min="100"
            max="255"
            value={speed}
            aria-label="走行速度"
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
          <div className={fleetStyles.rangeLabels}><span>100</span><span>255</span></div>
        </div>
        <div className={`${fleetStyles.segmented} ${styles.presets}`} role="group" aria-label="速度プリセット">
          <button
            onClick={() => setSpeed(140)}
            aria-pressed={speed === 140}
          >
            低速
          </button>
          <button
            onClick={() => setSpeed(190)}
            aria-pressed={speed === 190}
          >
            標準
          </button>
          <button
            onClick={() => setSpeed(255)}
            aria-pressed={speed === 255}
          >
            高速
          </button>
        </div>
      </section>

      <section className={`${fleetStyles.routes} ${styles.packetPanel}`} aria-labelledby="bluetooth-packet-heading">
        <div className={styles.panelHeading}>
          <h2 id="bluetooth-packet-heading">通信</h2>
          <Terminal aria-hidden="true" />
        </div>
        <dl className={styles.packetData}>
          <div><dt>送信パケット</dt><dd>{telemetry.lastPacketSent || "--"}</dd></div>
          <div><dt>送信数</dt><dd>{telemetry.packetsSentCount}</dd></div>
        </dl>
      </section>
      </aside>
      </div>
      </div>
    </main>
  );
}
