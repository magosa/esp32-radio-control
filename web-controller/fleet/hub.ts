import type { IncomingMessage } from "http";
import type { WebSocket, WebSocketServer } from "ws";
import { VehicleRegistry } from "./registry";
import { RouteEngine } from "./routeEngine";
import type {
  ClientInboundMessage,
  ClientOutboundMessage,
  DeviceInboundMessage,
  DisplayLayoutMode,
  DriveCommand,
  ExpressionId,
} from "./protocol";

const SWEEP_INTERVAL_MS = 1000;

// ESP32群(デバイス)と操作UI(クライアント)の両方のWebSocket接続を仲介するフリートハブ。
export class FleetHub {
  private registry = new VehicleRegistry();
  private routeEngine: RouteEngine;
  private clients = new Set<WebSocket>();
  private streamingDeviceIds = new Set<string>();

  constructor() {
    this.routeEngine = new RouteEngine({
      sendDrive: (deviceId, cmd, speedL, speedR) => this.sendDriveToDevice(deviceId, cmd, speedL, speedR),
      onStatus: (status) => this.broadcastToClients({ type: "routeStatus", ...status }),
    });

    setInterval(() => {
      if (this.registry.sweepOffline()) this.broadcastFleetState();
    }, SWEEP_INTERVAL_MS);
  }

  attach(wss: WebSocketServer): void {
    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const pathname = new URL(req.url ?? "", "http://localhost").pathname;
      if (pathname === "/ws/device") {
        this.handleDeviceConnection(ws);
      } else if (pathname === "/ws/client") {
        this.handleClientConnection(ws);
      } else {
        ws.close();
      }
    });
  }

  listRoutes() {
    return this.routeEngine.listRoutes();
  }

  private handleDeviceConnection(ws: WebSocket): void {
    let deviceId: string | undefined;

    ws.on("message", (raw) => {
      const msg = this.parseJson<DeviceInboundMessage>(raw.toString());
      if (!msg) return;

      if (msg.type === "hello") {
        deviceId = msg.deviceId;
        this.registry.registerHello(msg.deviceId, msg.name, ws);
        this.broadcastFleetState();
      } else if (msg.type === "telemetry") {
        this.registry.updateTelemetry(msg.deviceId, {
          cmd: msg.cmd,
          speedL: msg.speedL,
          speedR: msg.speedR,
          heap: msg.heap,
          uptimeMs: msg.uptimeMs,
        });
        this.broadcastFleetState();
      } else if (msg.type === "imageFrame") {
        const capturedAt = Date.now();
        this.registry.updateLastImage(msg.deviceId, capturedAt);
        this.broadcastFleetState();
        this.broadcastToClients({ ...msg, capturedAt });
      }
    });

    ws.on("close", () => {
      this.registry.markDisconnected(ws);
      if (deviceId) this.streamingDeviceIds.delete(deviceId);
      this.broadcastFleetState();
    });
  }

  private handleClientConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.sendToClient(ws, { type: "fleetState", vehicles: this.registry.getAllStates() });

    ws.on("message", (raw) => {
      const msg = this.parseJson<ClientInboundMessage>(raw.toString());
      if (!msg) return;
      this.handleClientMessage(msg);
    });

    ws.on("close", () => {
      this.clients.delete(ws);
    });
  }

  private handleClientMessage(msg: ClientInboundMessage): void {
    switch (msg.type) {
      case "clientCommand": {
        const requested =
          msg.targetDeviceIds === "all" ? this.registry.getOnlineDeviceIds() : msg.targetDeviceIds;
        // autoモード中の車両はルートエンジンが制御しているため、手動コマンドは無視する
        const targets = requested.filter((id) => this.registry.getMode(id) !== "auto");
        targets.forEach((deviceId) => this.sendDriveToDevice(deviceId, msg.cmd, msg.speedL, msg.speedR));
        break;
      }
      case "setMode": {
        this.registry.setMode(msg.deviceId, msg.mode);
        if (msg.mode === "manual") {
          // ルート実行中に手動へ切り替えた場合、対象車両をまず安全に停止させる
          this.sendDriveToDevice(msg.deviceId, "e", 0, 0);
        }
        this.broadcastFleetState();
        break;
      }
      case "setVehicleName": {
        const ws = this.registry.getWs(msg.deviceId);
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "setName", name: msg.name }));
        }
        break;
      }
      case "routeStart": {
        const autoDeviceIds = this.registry
          .getAllStates()
          .filter((v) => v.status === "online" && v.mode === "auto")
          .map((v) => v.deviceId);
        this.routeEngine.start(msg.routeId, autoDeviceIds);
        break;
      }
      case "routeStop": {
        this.routeEngine.stop();
        break;
      }
      case "clientCaptureRequest": {
        const targets =
          msg.targetDeviceIds === "all" ? this.registry.getOnlineDeviceIds() : msg.targetDeviceIds;
        targets.forEach((deviceId) => this.sendCaptureRequestToDevice(deviceId));
        break;
      }
      case "clientStreamRequest": {
        if (msg.action === "start") {
          this.startStream(msg.deviceId);
        } else {
          this.stopStream(msg.deviceId);
        }
        break;
      }
      case "clientExpressionRequest": {
        const targets =
          msg.targetDeviceIds === "all" ? this.registry.getOnlineDeviceIds() : msg.targetDeviceIds;
        targets.forEach((deviceId) => this.sendExpressionToDevice(deviceId, msg.expression, msg.durationMs));
        break;
      }
      case "clientDisplayLayoutRequest": {
        const targets =
          msg.targetDeviceIds === "all" ? this.registry.getOnlineDeviceIds() : msg.targetDeviceIds;
        targets.forEach((deviceId) => this.sendDisplayLayoutToDevice(deviceId, msg.layout));
        break;
      }
    }
  }

  private startStream(deviceId: string): void {
    if (this.streamingDeviceIds.has(deviceId)) return; // すでに配信中
    const ws = this.registry.getWs(deviceId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "streamStart" }));
    this.streamingDeviceIds.add(deviceId);
  }

  private stopStream(deviceId: string): void {
    if (!this.streamingDeviceIds.has(deviceId)) return;
    this.streamingDeviceIds.delete(deviceId);
    const ws = this.registry.getWs(deviceId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "streamStop" }));
  }

  private sendCaptureRequestToDevice(deviceId: string): void {
    const ws = this.registry.getWs(deviceId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "captureImage" }));
  }

  private sendExpressionToDevice(deviceId: string, expression: ExpressionId, durationMs?: number): void {
    const ws = this.registry.getWs(deviceId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "setExpression", expression, durationMs }));
  }

  private sendDisplayLayoutToDevice(deviceId: string, layout: DisplayLayoutMode): void {
    const ws = this.registry.getWs(deviceId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "setDisplayLayout", layout }));
  }

  private sendDriveToDevice(deviceId: string, cmd: DriveCommand, speedL: number, speedR: number): void {
    const ws = this.registry.getWs(deviceId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "drive", cmd, speedL, speedR }));
  }

  private broadcastFleetState(): void {
    this.broadcastToClients({ type: "fleetState", vehicles: this.registry.getAllStates() });
  }

  private broadcastToClients(msg: ClientOutboundMessage): void {
    const payload = JSON.stringify(msg);
    this.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    });
  }

  private sendToClient(ws: WebSocket, msg: ClientOutboundMessage): void {
    ws.send(JSON.stringify(msg));
  }

  private parseJson<T>(text: string): T | null {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
}
