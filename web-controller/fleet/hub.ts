import type { IncomingMessage } from "http";
import path from "node:path";
import type { WebSocket, WebSocketServer } from "ws";
import { VehicleRegistry } from "./registry";
import { RouteEngine } from "./routeEngine";
import { isDeviceDescription, RobotStore } from "./robotStore";
import { FieldConfigStore, isFieldConfig } from "./fieldConfigStore";
import { parseLocalizerHello, parsePoseFrame, PoseStore } from "./poseStore";
import type {
  ClientInboundMessage,
  ClientOutboundMessage,
  DeviceInboundMessage,
  DisplayLayoutMode,
  DriveCommand,
  ExpressionId,
  FleetStateMessage,
  PoseStateMessage,
} from "./protocol";

const SWEEP_INTERVAL_MS = 1000;
// poseFrameは約10Hzで届くため、UIへのposeState配信はこの間隔に間引く。
const POSE_BROADCAST_INTERVAL_MS = 100;

function defaultDataDir(): string {
  return process.env.FLEET_DATA_DIR || path.join(process.cwd(), "data");
}

// ESP32群(デバイス)と操作UI(クライアント)の両方のWebSocket接続を仲介するフリートハブ。
export class FleetHub {
  private registry: VehicleRegistry;
  private store: RobotStore;
  private routeEngine: RouteEngine;
  private clients = new Set<WebSocket>();
  private streamingDeviceIds = new Set<string>();
  private sweepTimer: NodeJS.Timeout;
  private fieldStore: FieldConfigStore;
  private poses = new PoseStore();
  private localizerWs: WebSocket | null = null;
  private poseBroadcastTimer: NodeJS.Timeout | null = null;

  constructor(store = new RobotStore(path.join(defaultDataDir(), "fleet.json")),
    fieldStore = new FieldConfigStore(path.join(defaultDataDir(), "field.json"))) {
    this.store = store;
    this.fieldStore = fieldStore;
    this.registry = new VehicleRegistry(store.getDevices());
    this.routeEngine = new RouteEngine({
      sendDrive: (deviceId, cmd, speedL, speedR) => this.sendDriveToDevice(deviceId, cmd, speedL, speedR),
      onStatus: (status) => this.broadcastToClients({ type: "routeStatus", ...status }),
    });

    this.sweepTimer = setInterval(() => {
      const timedOutSockets = this.registry.sweepOffline();
      if (timedOutSockets.length > 0) {
        if (this.registry.getAllStates().some((state) => state.status === "offline" && state.mode === "auto")) {
          this.routeEngine.stop();
        }
        this.broadcastFleetState();
        timedOutSockets.forEach((ws) => ws.terminate());
      }
      this.streamingDeviceIds.forEach((deviceId) => {
        const device = this.registry.getDeviceState(deviceId);
        if (device?.status !== "online") this.stopStream(deviceId);
        else this.sendToDevice(deviceId, { type: "ping" }, "camera");
      });
      // frameが途絶えたときもstaleへの遷移をUIへ届ける。
      this.broadcastPoseState();
    }, SWEEP_INTERVAL_MS);
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    if (this.poseBroadcastTimer) clearTimeout(this.poseBroadcastTimer);
    this.routeEngine.stop();
    Array.from(this.streamingDeviceIds).forEach((deviceId) => this.stopStream(deviceId));
  }

  attach(wss: WebSocketServer): void {
    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const pathname = new URL(req.url ?? "", "http://localhost").pathname;
      if (pathname === "/ws/device") {
        this.handleDeviceConnection(ws);
      } else if (pathname === "/ws/client") {
        this.handleClientConnection(ws);
      } else if (pathname === "/ws/localizer") {
        this.handleLocalizerConnection(ws);
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
        const description = { deviceId: msg.deviceId, name: msg.name, fw: msg.fw,
          capabilities: msg.capabilities ?? ["drive", "display"] };
        if (deviceId || !isDeviceDescription(description)) return ws.close(1008, "Invalid hello");
        try {
          this.store.register(description);
        } catch {
          return ws.close(1011, "Device registration failed");
        }
        deviceId = description.deviceId;
        this.registry.registerHello(deviceId, description.name, ws, description.capabilities, description.fw);
        this.broadcastFleetState();
      } else if (!deviceId || msg.deviceId !== deviceId || this.registry.getWs(deviceId) !== ws) {
        ws.close(1008, "Device identity mismatch");
      } else if (msg.type === "heartbeat") {
        this.registry.touch(deviceId);
        this.broadcastFleetState();
      } else if (msg.type === "telemetry" && this.registry.hasCapability(deviceId, "drive")) {
        this.registry.updateTelemetry(msg.deviceId, {
          cmd: msg.cmd,
          speedL: msg.speedL,
          speedR: msg.speedR,
          heap: msg.heap,
          uptimeMs: msg.uptimeMs,
        });
        this.broadcastFleetState();
      } else if (msg.type === "imageFrame" && this.registry.hasCapability(deviceId, "camera")
        && msg.format === "jpeg" && typeof msg.dataB64 === "string" && msg.dataB64.length <= 512000
        && Number.isInteger(msg.width) && msg.width > 0 && msg.width <= 4096
        && Number.isInteger(msg.height) && msg.height > 0 && msg.height <= 4096) {
        const capturedAt = Date.now();
        this.registry.updateLastImage(msg.deviceId, capturedAt);
        this.broadcastFleetState();
        this.broadcastToClients({ ...msg, capturedAt });
      }
    });

    ws.on("close", () => {
      if (deviceId && this.registry.getWs(deviceId) !== ws) return;
      this.registry.markDisconnected(ws);
      if (deviceId) {
        this.streamingDeviceIds.delete(deviceId);
        if (this.registry.hasCapability(deviceId, "drive") && this.routeEngine.isRunning()) this.routeEngine.stop();
      }
      this.broadcastFleetState();
    });
  }

  private handleClientConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.sendToClient(ws, this.getFleetState());
    this.sendToClient(ws, this.getPoseState());

    ws.on("message", (raw) => {
      const msg = this.parseJson<ClientInboundMessage>(raw.toString());
      if (!msg) return;
      try {
        this.handleClientMessage(msg, ws);
      } catch (error) {
        this.sendToClient(ws, { type: "operationResult", requestId: "requestId" in msg && typeof msg.requestId === "string" ? msg.requestId : "",
          ok: false, error: error instanceof Error ? error.message : "Request failed" });
      }
    });

    ws.on("close", () => {
      this.clients.delete(ws);
      if (this.clients.size === 0) Array.from(this.streamingDeviceIds).forEach((deviceId) => this.stopStream(deviceId));
    });
  }

  private handleLocalizerConnection(ws: WebSocket): void {
    // 俯瞰カメラは1つ。新しい接続が旧接続を置き換える。
    if (this.localizerWs && this.localizerWs !== ws) this.localizerWs.close(1000, "Localizer replaced");
    this.localizerWs = ws;
    let greeted = false;

    ws.on("message", (raw) => {
      if (this.localizerWs !== ws) return;
      const msg = this.parseJson<Record<string, unknown>>(raw.toString());
      if (!msg) return;
      if (msg.type === "localizerHello") {
        const hello = parseLocalizerHello(msg);
        if (!hello) return ws.close(1008, "Invalid hello");
        greeted = true;
        this.poses.onHello(hello);
        this.broadcastPoseState();
      } else if (!greeted) {
        ws.close(1008, "Hello required");
      } else if (msg.type === "poseFrame") {
        const frame = parsePoseFrame(msg);
        if (!frame) return;
        this.poses.ingest(frame, this.fieldStore.get());
        this.schedulePoseBroadcast();
      } else if (msg.type === "localizerStatus" && (msg.state === "running" || msg.state === "stopped")) {
        this.poses.onStatus(msg.state, typeof msg.reason === "string" ? msg.reason.slice(0, 200) : undefined);
        this.broadcastPoseState();
      }
    });

    ws.on("close", () => {
      if (this.localizerWs !== ws) return;
      this.localizerWs = null;
      this.poses.onClosed();
      this.broadcastPoseState();
    });
  }

  private handleClientMessage(msg: ClientInboundMessage, client: WebSocket): void {
    switch (msg.type) {
      case "assignMarker": {
        if (typeof msg.requestId !== "string" || typeof msg.robotId !== "string"
          || !(msg.markerId === null || Number.isInteger(msg.markerId))
          || !(msg.markerHeightMm === undefined || typeof msg.markerHeightMm === "number")) throw new Error("Invalid marker assignment");
        this.store.assignMarker(msg.robotId, msg.markerId, msg.markerHeightMm);
        this.broadcastFleetState();
        this.broadcastPoseState();
        this.sendToClient(client, { type: "operationResult", requestId: msg.requestId, ok: true });
        break;
      }
      case "setFieldConfig": {
        if (typeof msg.requestId !== "string" || !isFieldConfig(msg.config)) throw new Error("Invalid field configuration");
        this.fieldStore.set(msg.config);
        this.broadcastPoseState();
        this.sendToClient(client, { type: "operationResult", requestId: msg.requestId, ok: true });
        break;
      }
      case "assignCamera": {
        if (typeof msg.requestId !== "string" || typeof msg.robotId !== "string"
          || !(msg.cameraDeviceId === null || typeof msg.cameraDeviceId === "string")) throw new Error("Invalid assignment");
        const previous = this.store.getRobots().find((robot) => robot.robotId === msg.robotId)?.cameraDeviceId;
        this.store.assignCamera(msg.robotId, msg.cameraDeviceId);
        if (previous) this.stopStream(previous);
        if (msg.cameraDeviceId) this.stopStream(msg.cameraDeviceId);
        this.broadcastFleetState();
        this.sendToClient(client, { type: "operationResult", requestId: msg.requestId, ok: true });
        break;
      }
      case "clientCommand": {
        if (!["a", "b", "c", "d", "e"].includes(msg.cmd)
          || !Number.isInteger(msg.speedL) || msg.speedL < 0 || msg.speedL > 255
          || !Number.isInteger(msg.speedR) || msg.speedR < 0 || msg.speedR > 255) throw new Error("Invalid drive command");
        const requested =
          msg.targetDeviceIds === "all" ? this.registry.getOnlineDeviceIds() : msg.targetDeviceIds;
        if (!Array.isArray(requested) || !requested.every((id) => typeof id === "string")) throw new Error("Invalid targets");
        if (msg.cmd === "e" && (msg.targetDeviceIds === "all" || requested.some((id) => this.registry.getMode(id) === "auto"))) {
          this.routeEngine.stop();
        }
        // autoモード中の車両はルートエンジンが制御しているため、手動コマンドは無視する
        const targets = requested.filter((id) => msg.cmd === "e" || this.registry.getMode(id) !== "auto");
        targets.forEach((deviceId) => this.sendDriveToDevice(deviceId, msg.cmd, msg.speedL, msg.speedR));
        break;
      }
      case "setMode": {
        if (msg.mode !== "manual" && msg.mode !== "auto") throw new Error("Invalid mode");
        if (!this.registry.hasCapability(msg.deviceId, "drive")) return;
        if (msg.mode === "manual" && this.routeEngine.isRunning()) this.routeEngine.stop();
        this.registry.setMode(msg.deviceId, msg.mode);
        if (msg.mode === "manual") {
          // ルート実行中に手動へ切り替えた場合、対象車両をまず安全に停止させる
          this.sendDriveToDevice(msg.deviceId, "e", 0, 0);
        }
        this.broadcastFleetState();
        break;
      }
      case "setVehicleName": {
        if (typeof msg.name !== "string" || !msg.name.trim() || msg.name.length > 31) throw new Error("Invalid name");
        const ws = this.registry.getWs(msg.deviceId);
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "setName", name: msg.name }));
        }
        break;
      }
      case "routeStart": {
        if (typeof msg.routeId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(msg.routeId)) throw new Error("Invalid route ID");
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
          msg.targetDeviceIds === "all" ? this.registry.getAllDeviceStates().filter((device) => device.capabilities.includes("camera")).map((device) => device.deviceId) : msg.targetDeviceIds;
        targets.forEach((deviceId) => this.sendCaptureRequestToDevice(deviceId));
        break;
      }
      case "clientStreamRequest": {
        if (msg.action === "start") {
          this.startStream(msg.deviceId);
        } else {
          this.stopStream(msg.deviceId);
        }
        this.broadcastFleetState();
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
    if (!this.registry.hasCapability(deviceId, "camera") || this.registry.getDeviceState(deviceId)?.status !== "online"
      || !ws || ws.readyState !== ws.OPEN) return;
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
    this.sendToDevice(deviceId, { type: "captureImage" }, "camera");
  }

  private sendExpressionToDevice(deviceId: string, expression: ExpressionId, durationMs?: number): void {
    this.sendToDevice(deviceId, { type: "setExpression", expression, durationMs }, "display");
  }

  private sendDisplayLayoutToDevice(deviceId: string, layout: DisplayLayoutMode): void {
    this.sendToDevice(deviceId, { type: "setDisplayLayout", layout }, "display");
  }

  private sendDriveToDevice(deviceId: string, cmd: DriveCommand, speedL: number, speedR: number): void {
    this.sendToDevice(deviceId, { type: "drive", cmd, speedL, speedR }, "drive");
  }

  private sendToDevice(deviceId: string, message: object, capability: import("./protocol").DeviceCapability): void {
    const ws = this.registry.getWs(deviceId);
    if (!this.registry.hasCapability(deviceId, capability) || !ws || ws.readyState !== ws.OPEN
      || this.registry.getDeviceState(deviceId)?.status !== "online") return;
    ws.send(JSON.stringify(message));
  }

  private getFleetState(): FleetStateMessage {
    return { type: "fleetState", vehicles: this.registry.getAllStates(),
      devices: this.registry.getAllDeviceStates().map((device) => ({ ...device, streaming: device.status === "online" && this.streamingDeviceIds.has(device.deviceId) })),
      robots: this.store.getRobots().map((robot) => {
        const drive = this.registry.getDeviceState(robot.driveDeviceId);
        return { ...robot, name: drive?.name || robot.driveDeviceId, status: drive?.status ?? "offline",
          cameraStatus: robot.cameraDeviceId ? this.registry.getDeviceState(robot.cameraDeviceId)?.status ?? "offline" : "unassigned" };
      }) };
  }

  private broadcastFleetState(): void {
    this.broadcastToClients(this.getFleetState());
  }

  private getPoseState(): PoseStateMessage {
    return this.poses.snapshot(this.store.getRobots(), this.fieldStore.get());
  }

  private broadcastPoseState(): void {
    if (this.poseBroadcastTimer) {
      clearTimeout(this.poseBroadcastTimer);
      this.poseBroadcastTimer = null;
    }
    this.broadcastToClients(this.getPoseState());
  }

  private schedulePoseBroadcast(): void {
    if (this.poseBroadcastTimer) return;
    this.poseBroadcastTimer = setTimeout(() => {
      this.poseBroadcastTimer = null;
      this.broadcastToClients(this.getPoseState());
    }, POSE_BROADCAST_INTERVAL_MS);
  }

  private broadcastToClients(msg: ClientOutboundMessage): void {
    const payload = JSON.stringify(msg);
    this.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN && (!("type" in msg && msg.type === "imageFrame") || ws.bufferedAmount < 512000)) ws.send(payload);
    });
  }

  private sendToClient(ws: WebSocket, msg: ClientOutboundMessage): void {
    ws.send(JSON.stringify(msg));
  }

  private parseJson<T>(text: string): T | null {
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? value as T : null;
    } catch {
      return null;
    }
  }
}
