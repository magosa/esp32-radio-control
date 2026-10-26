"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ClientInboundMessage,
  ClientOutboundMessage,
  DisplayLayoutMode,
  DriveCommand,
  ExpressionId,
  FieldConfig,
  PhysicalDeviceState,
  PoseStateMessage,
  RobotState,
  RouteStatusMessage,
  VehicleMode,
  VehicleState,
} from "@/fleet/protocol";

export type FleetConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface RouteInfo {
  id: string;
  label: string;
}

export interface VehicleImage {
  dataB64: string;
  width: number;
  height: number;
  format: "jpeg";
  capturedAt: number;
}

// 保存系操作(割当・設定)の進行状況。HubのoperationResultで確定する。
export interface PendingOperation {
  requestId: string;
  pending: boolean;
  error?: string;
  done?: boolean;
}

function useFleetSocketConnection() {
  const [status, setStatus] = useState<FleetConnectionStatus>("disconnected");
  const [vehicles, setVehicles] = useState<VehicleState[]>([]);
  const [devices, setDevices] = useState<PhysicalDeviceState[]>([]);
  const [robots, setRobots] = useState<RobotState[]>([]);
  const [assignment, setAssignment] = useState<{ requestId: string; robotId: string; pending: boolean; error?: string } | null>(null);
  const [routeStatus, setRouteStatus] = useState<RouteStatusMessage | null>(null);
  const [availableRoutes, setAvailableRoutes] = useState<RouteInfo[]>([]);
  const [images, setImages] = useState<Record<string, VehicleImage>>({});
  const [poseState, setPoseState] = useState<PoseStateMessage | null>(null);
  const [markerAssignment, setMarkerAssignment] = useState<PendingOperation & { robotId: string } | null>(null);
  const [fieldSave, setFieldSave] = useState<PendingOperation | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const assignmentSequence = useRef(0);

  useEffect(() => {
    fetch("/api/routes")
      .then((res) => res.json())
      .then((data) => setAvailableRoutes(data.routes ?? []))
      .catch(() => setAvailableRoutes([]));
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    const connect = () => {
      setStatus("connecting");
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${protocol}://${window.location.host}/ws/client`);
      wsRef.current = ws;
      ws.onopen = () => { if (!disposed) setStatus("connected"); };
      ws.onclose = () => {
        if (disposed) return;
        setStatus("disconnected");
        setImages({});
        setAssignment((previous) => previous?.pending ? { ...previous, pending: false, error: "接続が切れました。保存状態を確認してください" } : previous);
        setMarkerAssignment((previous) => previous?.pending ? { ...previous, pending: false, error: "接続が切れました。保存状態を確認してください" } : previous);
        setFieldSave((previous) => previous?.pending ? { ...previous, pending: false, error: "接続が切れました。保存状態を確認してください" } : previous);
        setPoseState(null);
        reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => { if (!disposed) setStatus("error"); };
      ws.onmessage = (event) => {
      if (disposed) return;
      let msg: ClientOutboundMessage;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "fleetState") {
        setVehicles(msg.vehicles);
        setDevices(msg.devices ?? []);
        setRobots(msg.robots ?? []);
        const onlineIds = new Set((msg.devices ?? []).filter((device) => device.status === "online").map((device) => device.deviceId));
        setImages((previous) => Object.fromEntries(Object.entries(previous).filter(([deviceId]) => onlineIds.has(deviceId))));
      } else if (msg.type === "operationResult") {
        setAssignment((previous) => previous?.requestId === msg.requestId
          ? { ...previous, pending: false, error: msg.ok ? undefined : msg.error || "保存に失敗しました" } : previous);
        setMarkerAssignment((previous) => previous?.requestId === msg.requestId
          ? { ...previous, pending: false, done: msg.ok, error: msg.ok ? undefined : msg.error || "保存に失敗しました" } : previous);
        setFieldSave((previous) => previous?.requestId === msg.requestId
          ? { ...previous, pending: false, done: msg.ok, error: msg.ok ? undefined : msg.error || "保存に失敗しました" } : previous);
      } else if (msg.type === "poseState") {
        setPoseState(msg);
      } else if (msg.type === "routeStatus") {
        setRouteStatus(msg);
      } else if (msg.type === "imageFrame") {
        setImages((prev) => ({
          ...prev,
          [msg.deviceId]: {
            dataB64: msg.dataB64,
            width: msg.width,
            height: msg.height,
            format: msg.format,
            capturedAt: msg.capturedAt,
          },
        }));
      }
      };
    };
    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!assignment?.pending) return;
    const timer = setTimeout(() => setAssignment((previous) => previous?.pending
      ? { ...previous, pending: false, error: "保存結果を確認できませんでした。接続を確認してください" } : previous), 8000);
    return () => clearTimeout(timer);
  }, [assignment]);

  useEffect(() => {
    if (!markerAssignment?.pending) return;
    const timer = setTimeout(() => setMarkerAssignment((previous) => previous?.pending
      ? { ...previous, pending: false, error: "保存結果を確認できませんでした。接続を確認してください" } : previous), 8000);
    return () => clearTimeout(timer);
  }, [markerAssignment]);

  useEffect(() => {
    if (!fieldSave?.pending) return;
    const timer = setTimeout(() => setFieldSave((previous) => previous?.pending
      ? { ...previous, pending: false, error: "保存結果を確認できませんでした。接続を確認してください" } : previous), 8000);
    return () => clearTimeout(timer);
  }, [fieldSave]);

  const send = useCallback((msg: ClientInboundMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  const assignCamera = useCallback((robotId: string, cameraDeviceId: string | null) => {
    const requestId = `${Date.now()}-${++assignmentSequence.current}`;
    const sent = send({ type: "assignCamera", requestId, robotId, cameraDeviceId });
    setAssignment({ requestId, robotId, pending: sent, error: sent ? undefined : "ハブ未接続" });
  }, [send]);

  const assignMarker = useCallback((robotId: string, markerId: number | null, markerHeightMm?: number) => {
    const requestId = `${Date.now()}-${++assignmentSequence.current}`;
    const sent = send({ type: "assignMarker", requestId, robotId, markerId, markerHeightMm });
    setMarkerAssignment({ requestId, robotId, pending: sent, error: sent ? undefined : "ハブ未接続" });
  }, [send]);

  const saveFieldConfig = useCallback((config: FieldConfig) => {
    const requestId = `${Date.now()}-${++assignmentSequence.current}`;
    const sent = send({ type: "setFieldConfig", requestId, config });
    setFieldSave({ requestId, pending: sent, error: sent ? undefined : "ハブ未接続" });
  }, [send]);

  const sendCommand = useCallback(
    (targetDeviceIds: string[] | "all", cmd: DriveCommand, speedL: number, speedR: number) => {
      send({ type: "clientCommand", targetDeviceIds, cmd, speedL, speedR });
    },
    [send]
  );

  const setMode = useCallback(
    (deviceId: string, mode: VehicleMode) => {
      send({ type: "setMode", deviceId, mode });
    },
    [send]
  );

  const setVehicleName = useCallback(
    (deviceId: string, name: string) => {
      send({ type: "setVehicleName", deviceId, name });
    },
    [send]
  );

  const startRoute = useCallback(
    (routeId: string) => {
      send({ type: "routeStart", routeId });
    },
    [send]
  );

  const stopRoute = useCallback(() => {
    send({ type: "routeStop" });
  }, [send]);

  const requestSnapshot = useCallback(
    (deviceId: string) => {
      send({ type: "clientCaptureRequest", targetDeviceIds: [deviceId] });
    },
    [send]
  );

  const requestStream = useCallback(
    (deviceId: string, action: "start" | "stop") => {
      send({ type: "clientStreamRequest", deviceId, action });
    },
    [send]
  );

  const requestExpression = useCallback(
    (targetDeviceIds: string[] | "all", expression: ExpressionId, durationMs?: number) => {
      send({ type: "clientExpressionRequest", targetDeviceIds, expression, durationMs });
    },
    [send]
  );

  const requestDisplayLayout = useCallback(
    (targetDeviceIds: string[] | "all", layout: DisplayLayoutMode) => {
      send({ type: "clientDisplayLayoutRequest", targetDeviceIds, layout });
    },
    [send]
  );

  // 操作パッドが保持中の入力を破棄できるよう、全台停止ごとに世代を進める。
  const [emergencyEpoch, setEmergencyEpoch] = useState(0);
  const emergencyStop = useCallback(() => {
    setEmergencyEpoch((previous) => previous + 1);
    send({ type: "routeStop" });
    send({ type: "clientCommand", targetDeviceIds: "all", cmd: "e", speedL: 0, speedR: 0 });
  }, [send]);

  return {
    status,
    vehicles,
    devices,
    robots,
    assignment,
    assignCamera,
    poseState,
    markerAssignment,
    assignMarker,
    fieldSave,
    saveFieldConfig,
    routeStatus,
    availableRoutes,
    images,
    sendCommand,
    setMode,
    setVehicleName,
    startRoute,
    stopRoute,
    requestSnapshot,
    requestStream,
    requestExpression,
    requestDisplayLayout,
    emergencyEpoch,
    emergencyStop,
  };
}

type FleetSocket = ReturnType<typeof useFleetSocketConnection>;
const FleetSocketContext = createContext<FleetSocket | null>(null);

// 画面遷移してもHubへのWebSocketを1本に保つため、シェルで1度だけ接続する。
export function FleetSocketProvider({ children }: { children: ReactNode }) {
  const socket = useFleetSocketConnection();
  return <FleetSocketContext.Provider value={socket}>{children}</FleetSocketContext.Provider>;
}

export function useFleetSocket(): FleetSocket {
  const socket = useContext(FleetSocketContext);
  if (!socket) throw new Error("useFleetSocket must be used inside FleetSocketProvider");
  return socket;
}
