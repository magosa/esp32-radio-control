"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientInboundMessage,
  ClientOutboundMessage,
  DisplayLayoutMode,
  DriveCommand,
  ExpressionId,
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

export function useFleetSocket() {
  const [status, setStatus] = useState<FleetConnectionStatus>("disconnected");
  const [vehicles, setVehicles] = useState<VehicleState[]>([]);
  const [routeStatus, setRouteStatus] = useState<RouteStatusMessage | null>(null);
  const [availableRoutes, setAvailableRoutes] = useState<RouteInfo[]>([]);
  const [images, setImages] = useState<Record<string, VehicleImage>>({});

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    fetch("/api/fleet/routes")
      .then((res) => res.json())
      .then((data) => setAvailableRoutes(data.routes ?? []))
      .catch(() => setAvailableRoutes([]));
  }, []);

  useEffect(() => {
    setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws/client`);
    wsRef.current = ws;

    ws.onopen = () => setStatus("connected");
    ws.onclose = () => setStatus("disconnected");
    ws.onerror = () => setStatus("error");

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as ClientOutboundMessage;
      if (msg.type === "fleetState") {
        setVehicles(msg.vehicles);
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

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const send = useCallback((msg: ClientInboundMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

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

  return {
    status,
    vehicles,
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
  };
}
