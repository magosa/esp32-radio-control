"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  Radio,
  Wifi,
  WifiOff,
  Users,
  PlayCircle,
  StopCircle,
  RotateCcw,
  Camera,
  Video,
  VideoOff,
} from "lucide-react";
import { useFleetSocket, type VehicleImage } from "@/hooks/useFleetSocket";
import type { DisplayLayoutMode, DriveCommand, ExpressionId } from "@/fleet/protocol";

const SPEED = 190;

const DIRECTIONS: { label: string; cmd: DriveCommand }[] = [
  { label: "▲ 前進", cmd: "a" },
  { label: "▼ 後退", cmd: "b" },
  { label: "▶ 右旋回", cmd: "c" },
  { label: "◀ 左旋回", cmd: "d" },
  { label: "■ 停止", cmd: "e" },
];

const EXPRESSIONS: { label: string; id: ExpressionId }[] = [
  { label: "😐 通常", id: "neutral" },
  { label: "😊 嬉しい", id: "happy" },
  { label: "😄 楽しい", id: "fun" },
  { label: "😆 笑う", id: "laugh" },
  { label: "😮 驚き", id: "surprised" },
  { label: "🧐 好奇心", id: "curious" },
  { label: "🤔 考え中", id: "thinking" },
  { label: "😉 ウインク", id: "wink" },
  { label: "😢 悲しい", id: "worried" },
  { label: "😠 怒り", id: "angry" },
  { label: "😴 眠い", id: "sleepy" },
  { label: "🥰 大好き", id: "love" },
  { label: "😱 ショック", id: "shocked" },
  { label: "🙅 ギブアップ", id: "giveup" },
  { label: "☺️ 照れる", id: "shy" },
  { label: "😏 余裕", id: "composed" },
];

const DISPLAY_LAYOUTS: { label: string; id: DisplayLayoutMode }[] = [
  { label: "分割", id: "split" },
  { label: "全画面", id: "full" },
  { label: "自動", id: "auto" },
];

function VehicleSnapshot({ image }: { image?: VehicleImage }) {
  if (!image) return null;
  return (
    <div className="mt-2 rounded-lg overflow-hidden border border-slate-800 bg-black/40">
      {/* OV2640はJPEG(センサー内蔵エンコード)を直接送信するため、data URIをそのままimgに設定するだけで表示できる */}
      <img
        src={`data:image/jpeg;base64,${image.dataB64}`}
        alt="snapshot"
        width={image.width}
        height={image.height}
        className="w-full h-auto block"
      />
      <div className="text-[10px] font-mono text-slate-500 px-2 py-1">
        {new Date(image.capturedAt).toLocaleTimeString()} 取得
      </div>
    </div>
  );
}

export default function FleetDashboardPage() {
  const {
    status,
    vehicles,
    routeStatus,
    availableRoutes,
    images,
    sendCommand,
    setMode,
    startRoute,
    stopRoute,
    requestSnapshot,
    requestStream,
    requestExpression,
    requestDisplayLayout,
  } = useFleetSocket();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedRouteId, setSelectedRouteId] = useState<string>("");
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set());
  const streamingIdsRef = useRef(streamingIds);
  streamingIdsRef.current = streamingIds;

  // 配信の止め忘れでESP32が撮影し続けないよう、アンマウント時に全配信を停止する
  useEffect(() => {
    return () => {
      streamingIdsRef.current.forEach((deviceId) => requestStream(deviceId, "stop"));
    };
  }, [requestStream]);

  const toggleStream = (deviceId: string) => {
    setStreamingIds((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) {
        next.delete(deviceId);
        requestStream(deviceId, "stop");
      } else {
        next.add(deviceId);
        requestStream(deviceId, "start");
      }
      return next;
    });
  };

  const onlineCount = useMemo(() => vehicles.filter((v) => v.status === "online").length, [vehicles]);

  const toggleSelect = (deviceId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  };

  const sendToSelected = (cmd: DriveCommand) => {
    if (selectedIds.size === 0) return;
    sendCommand(Array.from(selectedIds), cmd, cmd === "e" ? 0 : SPEED, cmd === "e" ? 0 : SPEED);
  };

  const sendToAll = (cmd: DriveCommand) => {
    sendCommand("all", cmd, cmd === "e" ? 0 : SPEED, cmd === "e" ? 0 : SPEED);
  };

  // 前進/後退/旋回ボタンは押している間だけ駆動し、離すと即停止する(実機RCコントローラー同様のホールド操作)
  const holdProps = (cmd: DriveCommand, sender: (cmd: DriveCommand) => void) => ({
    onMouseDown: () => sender(cmd),
    onMouseUp: () => sender("e" as DriveCommand),
    onMouseLeave: () => sender("e" as DriveCommand),
    onTouchStart: () => sender(cmd),
    onTouchEnd: () => sender("e" as DriveCommand),
    onTouchCancel: () => sender("e" as DriveCommand),
  });

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-4 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-cyan-400" />
          <div>
            <h1 className="text-sm font-bold tracking-wider font-mono">FLEET DASHBOARD</h1>
            <p className="text-[10px] text-slate-400 font-mono">WebSocket フリート管理</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-mono text-slate-400">
            接続中: {onlineCount}/{vehicles.length}
          </span>
          {status === "connected" ? (
            <Wifi className="w-4 h-4 text-emerald-400" />
          ) : (
            <WifiOff className="w-4 h-4 text-rose-400" />
          )}
          <Link
            href="/"
            className="text-[11px] font-mono px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 flex items-center gap-1"
          >
            <Radio className="w-3.5 h-3.5" />
            レガシー接続(BLE)へ
          </Link>
        </div>
      </header>

      {/* 一括操作 */}
      <section className="rounded-xl bg-slate-900/70 border border-slate-800 p-3 mb-4">
        <h2 className="text-xs font-bold font-mono text-slate-300 mb-2">一括操作 (全車両)</h2>
        <div className="flex flex-wrap gap-2">
          {DIRECTIONS.map((d) => (
            <button
              key={d.cmd}
              {...(d.cmd === "e" ? { onClick: () => sendToAll(d.cmd) } : holdProps(d.cmd, sendToAll))}
              className="px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-xs font-mono select-none touch-none"
            >
              {d.label}
            </button>
          ))}
        </div>
        {selectedIds.size > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-800">
            <h3 className="text-xs font-bold font-mono text-amber-300 mb-2">
              選択中の{selectedIds.size}台へ送信
            </h3>
            <div className="flex flex-wrap gap-2">
              {DIRECTIONS.map((d) => (
                <button
                  key={d.cmd}
                  {...(d.cmd === "e" ? { onClick: () => sendToSelected(d.cmd) } : holdProps(d.cmd, sendToSelected))}
                  className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-xs font-mono select-none touch-none"
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ルート(集合→帰投)実行 */}
      <section className="rounded-xl bg-slate-900/70 border border-slate-800 p-3 mb-4">
        <h2 className="text-xs font-bold font-mono text-slate-300 mb-2">
          自動ルート実行 (autoモードの車両が対象)
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedRouteId}
            onChange={(e) => setSelectedRouteId(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs font-mono"
          >
            <option value="">ルートを選択...</option>
            {availableRoutes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => selectedRouteId && startRoute(selectedRouteId)}
            disabled={!selectedRouteId}
            className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-xs font-mono flex items-center gap-1 disabled:opacity-40"
          >
            <PlayCircle className="w-3.5 h-3.5" />
            開始
          </button>
          <button
            onClick={stopRoute}
            className="px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-xs font-mono flex items-center gap-1"
          >
            <StopCircle className="w-3.5 h-3.5" />
            停止
          </button>
        </div>
        {routeStatus && (
          <div className="mt-2 text-[11px] font-mono text-slate-400">
            {routeStatus.running
              ? `実行中: ${routeStatus.routeId} (${Math.round(routeStatus.elapsedMs / 1000)}s経過)`
              : "停止中"}
          </div>
        )}
      </section>

      {/* 車両一覧 */}
      <section className="space-y-2">
        {vehicles.length === 0 && (
          <p className="text-xs font-mono text-slate-500">
            接続中の車両がありません。ESP32の電源を入れるか、疑似デバイス(scripts/fakeDevice.ts)で検証してください。
          </p>
        )}
        {vehicles.map((v) => (
          <div
            key={v.deviceId}
            className={`rounded-xl border p-3 flex flex-col gap-2 ${
              v.status === "online" ? "border-slate-800 bg-slate-900/70" : "border-slate-900 bg-slate-950/60 opacity-60"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 flex-1 min-w-0">
                <input
                  type="checkbox"
                  checked={selectedIds.has(v.deviceId)}
                  onChange={() => toggleSelect(v.deviceId)}
                  disabled={v.status !== "online"}
                />
                <div className="min-w-0">
                  <div className="text-xs font-bold font-mono truncate">{v.name}</div>
                  <div className="text-[10px] font-mono text-slate-500 truncate">
                    {v.deviceId} · {v.status === "online" ? "ONLINE" : "OFFLINE"}
                    {v.telemetry && ` · cmd=${v.telemetry.cmd} L=${v.telemetry.speedL} R=${v.telemetry.speedR}`}
                  </div>
                </div>
              </label>
              <button
                onClick={() => requestSnapshot(v.deviceId)}
                disabled={v.status !== "online"}
                className="px-2.5 py-1 rounded-lg text-[11px] font-mono flex items-center gap-1 border bg-slate-800 border-slate-700 text-slate-300 disabled:opacity-40"
              >
                <Camera className="w-3 h-3" />
                スナップショット
              </button>
              <button
                onClick={() => toggleStream(v.deviceId)}
                disabled={v.status !== "online"}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-mono flex items-center gap-1 border disabled:opacity-40 ${
                  streamingIds.has(v.deviceId)
                    ? "bg-rose-500/20 border-rose-500/40 text-rose-300"
                    : "bg-slate-800 border-slate-700 text-slate-300"
                }`}
              >
                {streamingIds.has(v.deviceId) ? <VideoOff className="w-3 h-3" /> : <Video className="w-3 h-3" />}
                {streamingIds.has(v.deviceId) ? "ライブ停止" : "ライブ映像"}
              </button>
              <button
                onClick={() => setMode(v.deviceId, v.mode === "auto" ? "manual" : "auto")}
                disabled={v.status !== "online"}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-mono flex items-center gap-1 border ${
                  v.mode === "auto"
                    ? "bg-purple-500/20 border-purple-500/40 text-purple-300"
                    : "bg-slate-800 border-slate-700 text-slate-300"
                }`}
              >
                <RotateCcw className="w-3 h-3" />
                {v.mode === "auto" ? "AUTO" : "MANUAL"}
              </button>
            </div>
            <VehicleSnapshot image={images[v.deviceId]} />
            <div className="flex flex-wrap gap-1.5 pt-1 border-t border-slate-800/60">
              {EXPRESSIONS.map((ex) => (
                <button
                  key={ex.id}
                  onClick={() => requestExpression([v.deviceId], ex.id)}
                  disabled={v.status !== "online"}
                  className="px-2 py-1 rounded-lg text-[11px] font-mono border bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-40"
                >
                  {ex.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1 border-t border-slate-800/60">
              <span className="text-[10px] font-mono text-slate-500 self-center">画面レイアウト:</span>
              {DISPLAY_LAYOUTS.map((layout) => (
                <button
                  key={layout.id}
                  onClick={() => requestDisplayLayout([v.deviceId], layout.id)}
                  disabled={v.status !== "online"}
                  className="px-2 py-1 rounded-lg text-[11px] font-mono border bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-40"
                >
                  {layout.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
