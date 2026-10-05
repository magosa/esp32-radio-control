import type { WebSocket } from "ws";
import type { VehicleMode, VehicleState, VehicleTelemetry } from "./protocol";

interface VehicleRecord {
  ws: WebSocket;
  state: VehicleState;
}

// telemetryは約1秒間隔で届く想定。この時間途絶えたらオフライン扱いにする。
const OFFLINE_TIMEOUT_MS = 5000;

// 接続中のESP32群(フリート)の状態を保持するインメモリレジストリ。
export class VehicleRegistry {
  private vehicles = new Map<string, VehicleRecord>();

  registerHello(deviceId: string, name: string, ws: WebSocket): void {
    const existing = this.vehicles.get(deviceId);
    this.vehicles.set(deviceId, {
      ws,
      state: {
        deviceId,
        name,
        status: "online",
        mode: existing?.state.mode ?? "manual",
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
  }

  markDisconnected(ws: WebSocket): void {
    for (const record of Array.from(this.vehicles.values())) {
      if (record.ws === ws) {
        record.state.status = "offline";
      }
    }
  }

  // 一定時間telemetryが届いていないオンライン車両をオフラインに倒す。変化があればtrueを返す。
  sweepOffline(): boolean {
    const now = Date.now();
    let changed = false;
    for (const record of Array.from(this.vehicles.values())) {
      if (record.state.status === "online" && now - record.state.lastSeen > OFFLINE_TIMEOUT_MS) {
        record.state.status = "offline";
        changed = true;
      }
    }
    return changed;
  }

  setMode(deviceId: string, mode: VehicleMode): void {
    const record = this.vehicles.get(deviceId);
    if (record) record.state.mode = mode;
  }

  getMode(deviceId: string): VehicleMode | undefined {
    return this.vehicles.get(deviceId)?.state.mode;
  }

  getWs(deviceId: string): WebSocket | undefined {
    return this.vehicles.get(deviceId)?.ws;
  }

  getAllStates(): VehicleState[] {
    return Array.from(this.vehicles.values()).map((r) => r.state);
  }

  getOnlineDeviceIds(): string[] {
    return this.getAllStates()
      .filter((v) => v.status === "online")
      .map((v) => v.deviceId);
  }
}
