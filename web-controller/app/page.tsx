"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import {
  useWebBluetooth,
  ConnectionStatus,
} from "@/hooks/useWebBluetooth";
import {
  Bluetooth,
  BluetoothConnected,
  BluetoothOff,
  AlertTriangle,
  Zap,
  Gauge,
  Terminal,
  RotateCcw,
  Activity,
  Radio,
  Keyboard,
  Users,
} from "lucide-react";

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
    <main className="min-h-screen cockpit-grid flex flex-col justify-between p-4 max-w-lg mx-auto select-none">
      {/* 1. Header & Connection Bar */}
      <header className="rounded-2xl bg-slate-900/90 border border-slate-800 p-3 shadow-xl backdrop-blur-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio className={`w-5 h-5 ${status === "connected" ? "text-cyan-400 animate-pulse" : "text-slate-500"}`} />
            <div>
              <h1 className="text-sm font-bold tracking-wider text-slate-100 flex items-center gap-1.5 font-mono">
                ESP32 COCKPIT
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-300 border border-slate-600/50">
                  レガシー / BLEフォールバック
                </span>
              </h1>
              <p className="text-[10px] text-slate-400 font-mono">
                {status === "connected" ? deviceName || "ESP32_RC_Car" : "Web Bluetooth SPP"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/fleet"
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-cyan-300 border border-cyan-500/30 flex items-center gap-1.5 transition active:scale-95"
            >
              <Users className="w-3.5 h-3.5" />
              フリート
            </Link>
            {status === "connected" ? (
              <button
                onClick={disconnect}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-rose-400 border border-rose-500/30 flex items-center gap-1.5 transition active:scale-95"
              >
                <BluetoothOff className="w-3.5 h-3.5" />
                切断
              </button>
            ) : (
              <button
                onClick={connect}
                disabled={status === "connecting" || !isSupported}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition active:scale-95 ${
                  status === "connecting"
                    ? "bg-slate-800 text-amber-300 animate-pulse border border-amber-500/40"
                    : "bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold glow-cyan"
                }`}
              >
                <Bluetooth className="w-3.5 h-3.5" />
                {status === "connecting" ? "スキャン中..." : "接続"}
              </button>
            )}
          </div>
        </div>

        {/* Warning if unsupported or error */}
        {errorMessage && (
          <div className="mt-2.5 p-2 rounded-lg bg-rose-950/50 border border-rose-800 text-rose-300 text-[11px] flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}
      </header>

      {/* 2. Telemetry Gauge Bar */}
      <section className="my-3 grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-slate-900/80 border border-slate-800/80 p-2.5 text-center">
          <div className="text-[10px] font-mono text-slate-400 flex items-center justify-center gap-1">
            <Activity className="w-3 h-3 text-cyan-400" />
            STATUS
          </div>
          <div className="mt-1 text-xs font-bold font-mono">
            {status === "connected" ? (
              <span className="text-emerald-400">ONLINE</span>
            ) : (
              <span className="text-slate-500">OFFLINE</span>
            )}
          </div>
        </div>

        <div className="rounded-xl bg-slate-900/80 border border-slate-800/80 p-2.5 text-center">
          <div className="text-[10px] font-mono text-slate-400 flex items-center justify-center gap-1">
            <Gauge className="w-3 h-3 text-amber-400" />
            LATENCY
          </div>
          <div className="mt-1 text-xs font-bold font-mono text-amber-300">
            {status === "connected" ? `${telemetry.latencyMs || 15}ms` : "--"}
          </div>
        </div>

        <div className="rounded-xl bg-slate-900/80 border border-slate-800/80 p-2.5 text-center">
          <div className="text-[10px] font-mono text-slate-400 flex items-center justify-center gap-1">
            <Zap className="w-3 h-3 text-purple-400" />
            PACKETS
          </div>
          <div className="mt-1 text-xs font-bold font-mono text-purple-300">
            {telemetry.packetsSentCount}
          </div>
        </div>
      </section>

      {/* 3. Motor Power Dual Meters */}
      <section className="rounded-xl bg-slate-900/60 border border-slate-800/70 p-3 mb-3">
        <div className="flex justify-between text-[11px] font-mono text-slate-400 mb-1">
          <span>LEFT MOTOR: {motorL} PWM</span>
          <span>RIGHT MOTOR: {motorR} PWM</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-400 transition-all duration-75"
              style={{ width: `${(motorL / 255) * 100}%` }}
            />
          </div>
          <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-400 transition-all duration-75"
              style={{ width: `${(motorR / 255) * 100}%` }}
            />
          </div>
        </div>
      </section>

      {/* 4. Main Controller: D-Pad and E-STOP */}
      <section className="flex flex-col items-center justify-center my-auto py-2">
        {/* D-Pad Container */}
        <div className="grid grid-cols-3 gap-3 w-64 h-64 p-3 rounded-3xl bg-slate-900/90 border-2 border-slate-800 shadow-2xl relative backdrop-blur-xl">
          {/* Top: Forward */}
          <div />
          <button
            onPointerDown={() => handlePointerDown("forward")}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className={`rounded-2xl flex items-center justify-center text-xl font-bold transition active:scale-95 select-none ${
              activeDirection === "forward"
                ? "bg-cyan-500 text-slate-950 glow-cyan scale-95"
                : "bg-slate-800 hover:bg-slate-750 text-cyan-300 border border-slate-700"
            }`}
          >
            ▲
          </button>
          <div />

          {/* Middle: Left, Center Stop / Indicator, Right */}
          <button
            onPointerDown={() => handlePointerDown("left")}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className={`rounded-2xl flex items-center justify-center text-xl font-bold transition active:scale-95 select-none ${
              activeDirection === "left"
                ? "bg-cyan-500 text-slate-950 glow-cyan scale-95"
                : "bg-slate-800 hover:bg-slate-750 text-cyan-300 border border-slate-700"
            }`}
          >
            ◀
          </button>

          <button
            onClick={handleEmergencyStop}
            className="rounded-2xl bg-rose-600/30 hover:bg-rose-600/40 border border-rose-500/50 flex flex-col items-center justify-center text-rose-300 text-[10px] font-mono font-bold active:scale-90 transition"
          >
            <span className="text-sm">⏹</span>
            BRAKE
          </button>

          <button
            onPointerDown={() => handlePointerDown("right")}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className={`rounded-2xl flex items-center justify-center text-xl font-bold transition active:scale-95 select-none ${
              activeDirection === "right"
                ? "bg-cyan-500 text-slate-950 glow-cyan scale-95"
                : "bg-slate-800 hover:bg-slate-750 text-cyan-300 border border-slate-700"
            }`}
          >
            ▶
          </button>

          {/* Bottom: Backward */}
          <div />
          <button
            onPointerDown={() => handlePointerDown("backward")}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className={`rounded-2xl flex items-center justify-center text-xl font-bold transition active:scale-95 select-none ${
              activeDirection === "backward"
                ? "bg-cyan-500 text-slate-950 glow-cyan scale-95"
                : "bg-slate-800 hover:bg-slate-750 text-cyan-300 border border-slate-700"
            }`}
          >
            ▼
          </button>
          <div />
        </div>

        {/* Emergency Stop Button (Prominent) */}
        <div className="mt-4 w-full">
          <button
            onClick={handleEmergencyStop}
            className="w-full py-2.5 rounded-xl bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white font-bold text-xs font-mono tracking-wider flex items-center justify-center gap-2 glow-rose active:scale-98 transition shadow-lg"
          >
            <AlertTriangle className="w-4 h-4" />
            EMERGENCY STOP (E-STOP)
          </button>
        </div>
      </section>

      {/* 5. Speed Throttle Control (shadcn Slider style) */}
      <section className="rounded-2xl bg-slate-900/80 border border-slate-800 p-4 mt-2 shadow-lg">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-mono text-slate-300 flex items-center gap-1.5">
            <Gauge className="w-4 h-4 text-cyan-400" />
            THROTTLE (PWM: {speed})
          </span>
          <span className="text-xs font-bold font-mono text-cyan-300">
            {Math.round((speed / 255) * 100)}%
          </span>
        </div>

        <input
          type="range"
          min="100"
          max="255"
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="w-full"
        />

        {/* Speed Presets */}
        <div className="grid grid-cols-3 gap-2 mt-3">
          <button
            onClick={() => setSpeed(140)}
            className={`py-1 rounded-lg text-[11px] font-mono border transition ${
              speed === 140
                ? "bg-slate-800 text-cyan-300 border-cyan-500"
                : "bg-slate-950/60 text-slate-400 border-slate-800 hover:bg-slate-800"
            }`}
          >
            SLOW (140)
          </button>
          <button
            onClick={() => setSpeed(190)}
            className={`py-1 rounded-lg text-[11px] font-mono border transition ${
              speed === 190
                ? "bg-slate-800 text-cyan-300 border-cyan-500"
                : "bg-slate-950/60 text-slate-400 border-slate-800 hover:bg-slate-800"
            }`}
          >
            NORMAL (190)
          </button>
          <button
            onClick={() => setSpeed(255)}
            className={`py-1 rounded-lg text-[11px] font-mono border transition ${
              speed === 255
                ? "bg-rose-950 text-rose-300 border-rose-500 font-bold"
                : "bg-slate-950/60 text-slate-400 border-slate-800 hover:bg-slate-800"
            }`}
          >
            TURBO (255)
          </button>
        </div>
      </section>

      {/* 6. Live Packet Console */}
      <footer className="mt-3 p-2.5 rounded-xl bg-slate-950/90 border border-slate-800/80 font-mono text-[10px] text-slate-400 flex items-center justify-between">
        <div className="flex items-center gap-1.5 overflow-hidden">
          <Terminal className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="text-slate-500 shrink-0">TX:</span>
          <span className="text-cyan-300 font-bold truncate">
            {telemetry.lastPacketSent}
          </span>
        </div>
        <div className="flex items-center gap-1 text-slate-500 text-[9px] shrink-0">
          <Keyboard className="w-3 h-3" />
          <span>WASD / 矢印キー操作対応</span>
        </div>
      </footer>
    </main>
  );
}
