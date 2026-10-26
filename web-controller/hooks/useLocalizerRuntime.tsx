"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useFleetSocket } from "@/hooks/useFleetSocket";
import { createDetector, initializeOpenCv, type Detector } from "@/localization/detector";
import { estimate, SCHEMA, type Detection, type LocalizerConfig, type PoseEstimate } from "@/localization/geometry";
import type { LocalizerInboundMessage } from "@/fleet/protocol";

export type LocalizerRuntimeStatus = "idle" | "loading" | "running" | "error";

export interface LocalizerFrameSummary {
  frameId: number;
  width: number;
  height: number;
  referenceCount: number;
  referenceIds: number[];
  complete: boolean;
  extrinsicsOk: boolean;
  detectedIds: number[];
  robots: PoseEstimate["robots"];
  processingMs: number;
}

export interface CameraOption {
  deviceId: string;
  label: string;
}

const ROBOT_MARKER_SIZE_MM = 40;
const FRAME_TIMEOUT_MS = 3000;
// Hubが別の測位を優先して拒否(close 1013)した場合の再試行回数。半開き接続の失効待ちを見込む。
const MAX_REJECTIONS = 5;
const CSV_ROW_LIMIT = 100000;
const CSV_HEADER = "schema,timestamp_ms,frame_id,robot_id,valid,x,y,yaw_deg,measured_size_mm,inside_field,extrinsics_ok";
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

let detectorPromise: Promise<Detector> | null = null;

// 約11MBのOpenCV.jsは初回の測位開始時にだけ読み込む。
function loadDetector(): Promise<Detector> {
  detectorPromise ??= (async () => {
    const holder = window as unknown as { cv?: Parameters<typeof initializeOpenCv>[0] };
    if (!holder.cv) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/vendor/opencv.js";
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("OpenCV.jsを読み込めません。"));
        document.head.append(script);
      });
    }
    const { cv } = await initializeOpenCv(holder.cv);
    return createDetector(cv);
  })().catch((error) => { detectorPromise = null; throw error; });
  return detectorPromise;
}

function useLocalizerRuntimeState() {
  const { robots, poseState } = useFleetSocket();
  const [status, setStatus] = useState<LocalizerRuntimeStatus>("idle");
  const [message, setMessage] = useState("停止中。カメラを選んで開始してください。");
  const [warning, setWarning] = useState<string | null>(null);
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [selectedCamera, setSelectedCamera] = useState("");
  const [summary, setSummary] = useState<LocalizerFrameSummary | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordedRows, setRecordedRows] = useState(0);
  const [isLocalHost, setIsLocalHost] = useState(false);

  const configRef = useRef({ robots, field: poseState?.field });
  configRef.current = { robots, field: poseState?.field };
  const selectedRef = useRef(selectedCamera);
  selectedRef.current = selectedCamera;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const run = useRef({
    generation: 0, starting: false, stream: null as MediaStream | null, ws: null as WebSocket | null,
    wsTimer: 0 as number, rejections: 0, frameCallback: 0, pollTimer: 0 as number, watchdog: 0 as number, frameId: 0,
    lastFrameAt: 0, lastVideoTime: -1, recording: false, rows: [] as string[], width: 0, height: 0,
    camera: "", wakeLock: null as WakeLockSentinel | null,
  });

  useEffect(() => { setIsLocalHost(LOCAL_HOSTS.includes(window.location.hostname)); }, []);

  const publish = useCallback((message: LocalizerInboundMessage) => {
    const ws = run.current.ws;
    if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536) ws.send(JSON.stringify(message));
  }, []);

  const refreshCameras = useCallback(async () => {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
    setCameras(list.map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Camera ${index + 1}` })));
  }, []);

  const halt = useCallback((text: string, failed: boolean) => {
    const state = run.current;
    state.generation++;
    state.starting = false;
    if (state.frameCallback && videoRef.current?.cancelVideoFrameCallback) videoRef.current.cancelVideoFrameCallback(state.frameCallback);
    state.frameCallback = 0;
    clearTimeout(state.pollTimer);
    clearInterval(state.watchdog);
    clearTimeout(state.wsTimer);
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (state.ws) {
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: "localizerStatus", state: "stopped", reason: text } satisfies LocalizerInboundMessage));
      }
      state.ws.onclose = null;
      state.ws.close();
      state.ws = null;
    }
    void state.wakeLock?.release().catch(() => undefined);
    state.wakeLock = null;
    state.recording = false;
    setRecording(false);
    setSummary(null);
    setWarning(null);
    setStatus(failed ? "error" : "idle");
    setMessage(text);
  }, []);

  const buildConfig = (): LocalizerConfig => {
    const { robots: all, field } = configRef.current;
    if (!field) throw new Error("Hubの設定を取得できません。");
    const assigned = all.filter((robot) => robot.markerId !== null);
    if (!assigned.length) throw new Error("マーカーIDを割り当てたロボットがありません。「ロボット」画面で設定してください。");
    return { cameraHeight: field.cameraHeightMm, width: field.widthMm, height: field.heightMm, referenceSize: field.referenceSizeMm,
      robots: assigned.map((robot) => ({ id: robot.markerId as number, height: robot.markerHeightMm, size: ROBOT_MARKER_SIZE_MM })) };
  };

  const connectPublisher = useCallback((generation: number) => {
    const state = run.current;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws/localizer`);
    state.ws = ws;
    let openedAt = 0;
    ws.onopen = () => {
      openedAt = Date.now();
      ws.send(JSON.stringify({ type: "localizerHello", camera: state.camera, width: state.width, height: state.height } satisfies LocalizerInboundMessage));
    };
    ws.onclose = (event) => {
      if (generation !== state.generation) return;
      state.ws = null;
      if (event.code === 1013) {
        if (++state.rejections > MAX_REJECTIONS) {
          halt("別の測位がすでにHubへ接続しているため、この測位は開始できません。先にそちらを停止してください。", true);
          return;
        }
      } else if (openedAt && Date.now() - openedAt > 1500) {
        state.rejections = 0;
      }
      state.wsTimer = window.setTimeout(() => { if (generation === state.generation) connectPublisher(generation); }, 2000);
    };
  }, [halt]);

  const start = useCallback(async () => {
    const state = run.current;
    if (state.starting || status === "running") return;
    halt("開始しています…", false);
    state.starting = true;
    const generation = state.generation;
    setStatus("loading");
    try {
      if (!LOCAL_HOSTS.includes(window.location.hostname)) throw new Error("Hub実行PCのlocalhostで開いたページからのみ開始できます。");
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("このブラウザーではカメラを使用できません。");
      buildConfig();
      setMessage("OpenCV検出器を準備しています…");
      const detector = await loadDetector();
      if (generation !== state.generation) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        width: { ideal: 1920 }, height: { ideal: 1080 },
        ...(selectedRef.current ? { deviceId: { exact: selectedRef.current } } : {}),
      } });
      if (generation !== state.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
      state.stream = stream;
      const track = stream.getVideoTracks()[0];
      track.onended = () => halt("カメラ接続が終了しました。", true);
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      await refreshCameras();
      if (generation !== state.generation) return;
      const activeId = track.getSettings().deviceId;
      if (activeId) setSelectedCamera(activeId);
      state.camera = track.label || "camera";
      state.width = video.videoWidth;
      state.height = video.videoHeight;
      state.lastVideoTime = -1;
      state.lastFrameAt = performance.now();
      state.frameId = 0;
      state.rejections = 0;
      connectPublisher(generation);
      try { state.wakeLock = await navigator.wakeLock?.request("screen") ?? null; } catch { state.wakeLock = null; }
      state.starting = false;
      setStatus("running");
      setMessage("測位中");

      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const process = (metadata?: VideoFrameCallbackMetadata) => {
        const started = performance.now();
        const width = video.videoWidth, height = video.videoHeight;
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        ctx.drawImage(video, 0, 0);
        const found = detector.detect(ctx.getImageData(0, 0, width, height));
        const detections: Detection[] = found;
        const result = estimate(detections, buildConfig(), width, height);
        drawOverlay(ctx, detections, result);
        let capturedAt = Date.now();
        if (metadata?.captureTime !== undefined) {
          const candidate = performance.timeOrigin + metadata.captureTime;
          if (candidate <= capturedAt + 50 && candidate > capturedAt - 5000) capturedAt = candidate;
        }
        state.frameId++;
        state.width = width;
        state.height = height;
        const referenceIds = Array.from(new Set(found.map((marker) => marker.id).filter((id) => id >= 40 && id <= 43)));
        publish({ type: "poseFrame", frameId: state.frameId, capturedAt, referenceCount: result.referenceCount, referenceIds,
          extrinsicsOk: result.extrinsics_ok, markers: result.robots.map((robot) => robot.valid
            ? { markerId: robot.id, valid: true, x: robot.x, y: robot.y, yawDeg: robot.yaw_deg, insideField: robot.inside_field }
            : { markerId: robot.id, valid: false }) });
        setSummary({ frameId: state.frameId, width, height, referenceCount: result.referenceCount, referenceIds, complete: result.complete,
          extrinsicsOk: result.extrinsics_ok, detectedIds: found.map((marker) => marker.id), robots: result.robots,
          processingMs: performance.now() - started });
        if (state.recording) {
          if (state.rows.length + result.robots.length > CSV_ROW_LIMIT) {
            state.recording = false;
            setRecording(false);
            throw new Error("CSV記録上限100000行に達しました。保存して記録を再開してください。");
          }
          for (const robot of result.robots) state.rows.push([SCHEMA, result.timestamp_ms, state.frameId, robot.id,
            Number(robot.valid), robot.valid ? robot.x : "", robot.valid ? robot.y : "", robot.valid ? robot.yaw_deg : "",
            robot.valid ? robot.measured_size_mm : "", robot.valid ? Number(robot.inside_field) : "", Number(result.extrinsics_ok)].join(","));
          setRecordedRows(state.rows.length);
        }
      };
      const next = () => {
        if (generation !== state.generation) return;
        if (video.requestVideoFrameCallback) {
          state.frameCallback = video.requestVideoFrameCallback((_now, metadata) => onFrame(metadata));
        } else {
          state.pollTimer = window.setTimeout(() => {
            if (video.currentTime !== state.lastVideoTime) { state.lastVideoTime = video.currentTime; onFrame(undefined); } else next();
          }, 50);
        }
      };
      const onFrame = (metadata: VideoFrameCallbackMetadata | undefined) => {
        if (generation !== state.generation) return;
        try {
          state.lastFrameAt = performance.now();
          process(metadata);
        } catch (error) {
          halt(`測位停止：${error instanceof Error ? error.message : error}`, true);
          return;
        }
        next();
      };
      state.watchdog = window.setInterval(() => {
        if (performance.now() - state.lastFrameAt > FRAME_TIMEOUT_MS) halt("カメラ映像が3秒以上更新されていません。", true);
      }, 1000);
      next();
    } catch (error) {
      halt(`開始失敗：${error instanceof Error ? error.message : error}`, true);
    }
  }, [halt, connectPublisher, publish, refreshCameras, status]);

  const stop = useCallback(() => halt("停止中", false), [halt]);

  useEffect(() => {
    const onVisibility = () => {
      if (run.current.stream) setWarning(document.hidden ? "このウィンドウが背面または最小化されています。測位が遅れる・止まることがあります。" : null);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", stop);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", stop);
    };
  }, [stop]);

  const toggleRecording = useCallback(() => {
    const state = run.current;
    if (!state.stream) return;
    state.recording = !state.recording;
    setRecording(state.recording);
  }, []);

  const downloadCsv = useCallback(() => {
    const state = run.current;
    if (!state.rows.length) return false;
    const url = URL.createObjectURL(new Blob([`${CSV_HEADER}\r\n${state.rows.join("\r\n")}\r\n`], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `poses_v3_${Date.now()}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    state.rows = [];
    setRecordedRows(0);
    return true;
  }, []);

  const getCanvas = useCallback(() => {
    canvasRef.current ??= document.createElement("canvas");
    return canvasRef.current;
  }, []);

  useEffect(() => { getCanvas(); }, [getCanvas]);

  return { status, message, warning, cameras, selectedCamera, setSelectedCamera, summary, recording, recordedRows,
    isLocalHost, start, stop, refreshCameras, toggleRecording, downloadCsv, getCanvas, videoRef };
}

function drawOverlay(ctx: CanvasRenderingContext2D, detections: Detection[], result: PoseEstimate) {
  ctx.lineWidth = 3;
  ctx.font = "18px monospace";
  for (const marker of detections) {
    ctx.strokeStyle = marker.id >= 40 ? "#ff66ff" : "#00ff88";
    ctx.beginPath();
    marker.corners.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "#00ff88";
    const [x, y] = marker.corners[0];
    ctx.fillText(`ID ${marker.id}`, x, y - 8);
    const pose = result.robots.find((robot) => robot.id === marker.id);
    if (pose?.valid) ctx.fillText(`${pose.x.toFixed(1)}, ${pose.y.toFixed(1)} / ${pose.yaw_deg.toFixed(1)}deg`, x, y + 22);
  }
}

type LocalizerRuntime = ReturnType<typeof useLocalizerRuntimeState>;
const LocalizerRuntimeContext = createContext<LocalizerRuntime | null>(null);

// 検出ループを画面遷移から独立させるため、シェルに常駐させる。
export function LocalizerRuntimeProvider({ children }: { children: ReactNode }) {
  const runtime = useLocalizerRuntimeState();
  return <LocalizerRuntimeContext.Provider value={runtime}>
    <video ref={runtime.videoRef} muted playsInline aria-hidden="true"
      style={{ position: "fixed", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />
    {children}
  </LocalizerRuntimeContext.Provider>;
}

export function useLocalizerRuntime(): LocalizerRuntime {
  const runtime = useContext(LocalizerRuntimeContext);
  if (!runtime) throw new Error("useLocalizerRuntime must be used inside LocalizerRuntimeProvider");
  return runtime;
}
