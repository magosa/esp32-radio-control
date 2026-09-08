"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientInboundMessage,
  ClientOutboundMessage,
  DriveCommand,
  RouteStatusMessage,
  VehicleMode,
  VehicleState,
} from "@/fleet/protocol";

export type FleetConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface RouteInfo {
  id: string;
  label: string;
}

export function useFleetSocket() {
  const [status, setStatus] = useState<FleetConnectionStatus>("disconnected");
  const [vehicles, setVehicles] = useState<VehicleState[]>([]);
  const [routeStatus, setRouteStatus] = useState<RouteStatusMessage | null>(null);
  const [availableRoutes, setAvailableRoutes] = useState<RouteInfo[]>([]);

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

  return {
    status,
    vehicles,
    routeStatus,
    availableRoutes,
    sendCommand,
    setMode,
    setVehicleName,
    startRoute,
    stopRoute,
  };
}
