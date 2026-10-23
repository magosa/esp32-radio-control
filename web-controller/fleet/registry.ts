import type { WebSocket } from "ws";
import type { DeviceCapability, DeviceDescription, PhysicalDeviceState, VehicleMode, VehicleState, VehicleTelemetry } from "./protocol";

interface VehicleRecord {
  ws?: WebSocket;
  state: VehicleState;
}

// telemetryは約1秒間隔で届く想定。この時間途絶えたらオフライン扱いにする。
const OFFLINE_TIMEOUT_MS = 10000;

// 接続中のESP32群(フリート)の状態を保持するインメモリレジストリ。
export class VehicleRegistry {
  private vehicles = new Map<string, VehicleRecord>();

  constructor(devices: DeviceDescription[] = []) {
    devices.forEach((device) => this.vehicles.set(device.deviceId, {
      state: { ...device, status: "offline", mode: "manual", lastSeen: 0, telemetry: null },
    }));
  }

  registerHello(deviceId: string, name: string, ws: WebSocket, capabilities: DeviceCapability[] = ["drive", "display"], fw = "legacy"): void {
    const existing = this.vehicles.get(deviceId);
    if (existing?.ws && existing.ws !== ws) existing.ws.close(1000, "Device reconnected");
    this.vehicles.set(deviceId, {
      ws,
      state: {
        deviceId,
        name,
        capabilities,
        fw,
        status: "online",
        mode: "manual",
        lastSeen: Date.now(),
        telemetry: existing?.state.telemetry ?? null,
        lastImageAt: existing?.state.lastImageAt,
      },
    });
  }

  updateTelemetry(deviceId: string, telemetry: VehicleTelemetry): void {
    const record = this.vehicles.get(deviceId);
    if (!record) return;
    record.state.status = "online";
    record.state.lastSeen = Date.now();
    record.state.telemetry = telemetry;
  }

  updateLastImage(deviceId: string, timestamp: number): void {
    const record = this.vehicles.get(deviceId);
    if (!record) return;
    record.state.lastImageAt = timestamp;
    this.touch(deviceId);
  }

  touch(deviceId: string): void {
    const record = this.vehicles.get(deviceId);
    if (!record) return;
    record.state.lastSeen = Date.now();
    record.state.status = "online";
  }

  hasCapability(deviceId: string, capability: DeviceCapability): boolean {
    return this.vehicles.get(deviceId)?.state.capabilities.includes(capability) ?? false;
  }

  getDeviceState(deviceId: string): VehicleState | undefined {
    return this.vehicles.get(deviceId)?.state;
  }

  markDisconnected(ws: WebSocket): void {
    for (const record of Array.from(this.vehicles.values())) {
      if (record.ws === ws) {
        record.state.status = "offline";
      }
    }
  }

  // 一定時間telemetryが届いていないオンライン車両をオフラインに倒す。変化があればtrueを返す。
  sweepOffline(): WebSocket[] {
    const now = Date.now();
    const timedOutSockets: WebSocket[] = [];
    for (const record of Array.from(this.vehicles.values())) {
      if (record.state.status === "online" && now - record.state.lastSeen > OFFLINE_TIMEOUT_MS) {
        record.state.status = "offline";
        const ws = record.ws;
        if (ws && ws.readyState === ws.OPEN) timedOutSockets.push(ws);
      }
    }
    return timedOutSockets;
  }

  setMode(deviceId: string, mode: VehicleMode): void {
    const record = this.vehicles.get(deviceId);
    if (record?.state.capabilities.includes("drive")) record.state.mode = mode;
  }

  getMode(deviceId: string): VehicleMode | undefined {
    return this.vehicles.get(deviceId)?.state.mode;
  }

  getWs(deviceId: string): WebSocket | undefined {
    return this.vehicles.get(deviceId)?.ws;
  }

  getAllStates(): VehicleState[] {
    return Array.from(this.vehicles.values()).map((record) => record.state)
      .filter((state) => state.capabilities.includes("drive"));
  }

  getAllDeviceStates(): PhysicalDeviceState[] {
    return Array.from(this.vehicles.values()).map(({ state }) => ({
      deviceId: state.deviceId, name: state.name, fw: state.fw,
      capabilities: state.capabilities, status: state.status, lastSeen: state.lastSeen,
    }));
  }

  getOnlineDeviceIds(): string[] {
    return this.getAllStates()
      .filter((v) => v.status === "online")
      .map((v) => v.deviceId);
  }
}
