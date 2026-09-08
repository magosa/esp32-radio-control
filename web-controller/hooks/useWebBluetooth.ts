"use client";

import { useState, useCallback, useRef, useEffect } from "react";

// Nordic UART Service (NUS) UUIDs
export const NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // Web -> ESP32 (Write)
export const NUS_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // ESP32 -> Web (Notify)

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface TelemetryData {
  lastPacketSent: string;
  lastPacketReceived: string;
  latencyMs: number;
  packetsSentCount: number;
}

export function useWebBluetooth() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [deviceName, setDeviceName] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [isSupported, setIsSupported] = useState<boolean>(true);
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    lastPacketSent: "NONE",
    lastPacketReceived: "NONE",
    latencyMs: 0,
    packetsSentCount: 0,
  });

  const deviceRef = useRef<BluetoothDevice | null>(null);
  const rxCharRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  const lastSendTimeRef = useRef<number>(0);

  // Check Web Bluetooth support on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const supported = "bluetooth" in navigator;
      setIsSupported(supported);
      if (!supported) {
        setErrorMessage("お使いのブラウザはWeb Bluetooth APIをサポートしていません。Android ChromeまたはPC Chrome/Edgeをご使用ください。");
      }
    }
  }, []);

  // Connect to ESP32 BLE
  const connect = useCallback(async () => {
    if (!("bluetooth" in navigator)) {
      setErrorMessage("Web Bluetooth APIがサポートされていません");
      return;
    }

    try {
      setStatus("connecting");
      setErrorMessage("");

      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { name: "ESP32_RC_Car" },
          { namePrefix: "ESP32" },
        ],
        optionalServices: [NUS_SERVICE_UUID],
      });

      deviceRef.current = device;
      setDeviceName(device.name || "ESP32_RC_Car");

      // Handle spontaneous disconnect
      device.addEventListener("gattserverdisconnected", () => {
        setStatus("disconnected");
        rxCharRef.current = null;
      });

      const server = await device.gatt?.connect();
      if (!server) throw new Error("GATTサーバーへの接続に失敗しました");

      const service = await server.getPrimaryService(NUS_SERVICE_UUID);
      const rxChar = await service.getCharacteristic(NUS_RX_UUID);
      const txChar = await service.getCharacteristic(NUS_TX_UUID);

      rxCharRef.current = rxChar;

      // Listen for incoming notifications from ESP32
      await txChar.startNotifications();
      txChar.addEventListener("characteristicvaluechanged", (event: Event) => {
        const target = event.target as unknown as { value: DataView };
        if (target && target.value) {
          const decoder = new TextDecoder("utf-8");
          const receivedText = decoder.decode(target.value);
          const now = performance.now();
          const latency = Math.round(now - lastSendTimeRef.current);
          setTelemetry((prev) => ({
            ...prev,
            lastPacketReceived: receivedText,
            latencyMs: latency > 0 && latency < 2000 ? latency : prev.latencyMs,
          }));
        }
      });

      setStatus("connected");
      // Haptic feedback on connection
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate([40, 60, 40]);
      }
    } catch (err: unknown) {
      console.error("Bluetooth connection error:", err);
      setStatus("error");
      const errObj = err as { name?: string; message?: string };
      if (errObj.name === "NotFoundError") {
        setErrorMessage("デバイス選択がキャンセルされました");
      } else {
        setErrorMessage(errObj.message || "BLE接続中にエラーが発生しました");
      }
    }
  }, []);

  // Disconnect
  const disconnect = useCallback(() => {
    if (deviceRef.current && deviceRef.current.gatt?.connected) {
      deviceRef.current.gatt.disconnect();
    }
    setStatus("disconnected");
    rxCharRef.current = null;
  }, []);

  const isWritingRef = useRef<boolean>(false);

  // Send packet to ESP32
  const sendPacket = useCallback(async (packet: string) => {
    if (!rxCharRef.current || status !== "connected") {
      // Allow simulation in disconnected state for testing UI
      setTelemetry((prev) => ({
        ...prev,
        lastPacketSent: packet,
        packetsSentCount: prev.packetsSentCount + 1,
      }));
      return;
    }

    if (isWritingRef.current) {
      // Skip if previous write is still in progress to avoid GATT lockup
      return;
    }

    try {
      isWritingRef.current = true;
      lastSendTimeRef.current = performance.now();
      const encoder = new TextEncoder();
      const data = encoder.encode(packet);
      await rxCharRef.current.writeValueWithoutResponse(data);

      setTelemetry((prev) => ({
        ...prev,
        lastPacketSent: packet,
        packetsSentCount: prev.packetsSentCount + 1,
      }));
    } catch (err) {
      console.error("Failed to write BLE characteristic:", err);
    } finally {
      isWritingRef.current = false;
    }
  }, [status]);

  return {
    status,
    deviceName,
    errorMessage,
    isSupported,
    telemetry,
    connect,
    disconnect,
    sendPacket,
  };
}
