// ESP32 <-> フリートハブ <-> 操作UI 間で共有するJSONメッセージ仕様。
// ESP32ファームウェア側 (esp32_rc_car/esp32_rc_car.ino) のコメントと同期させること。

export type DriveCommand = "a" | "b" | "c" | "d" | "e";
export type VehicleMode = "manual" | "auto";
export type VehicleStatus = "online" | "offline";

// ---- Device (ESP32) -> Server ----

export interface HelloMessage {
  type: "hello";
  deviceId: string;
  name: string;
  fw: string;
}

export interface TelemetryMessage {
  type: "telemetry";
  deviceId: string;
  cmd: DriveCommand;
  speedL: number;
  speedR: number;
  heap: number;
  uptimeMs: number;
}

export type DeviceInboundMessage = HelloMessage | TelemetryMessage;

// ---- Server -> Device (ESP32) ----

export interface DriveMessage {
  type: "drive";
  cmd: DriveCommand;
  speedL: number;
  speedR: number;
}

export interface SetNameMessage {
  type: "setName";
  name: string;
}

export type DeviceOutboundMessage = DriveMessage | SetNameMessage;

// ---- 車両状態(フリートレジストリの1台分) ----

export interface VehicleTelemetry {
  cmd: DriveCommand;
  speedL: number;
  speedR: number;
  heap: number;
  uptimeMs: number;
}

export interface VehiclePosition {
  x: number;
  y: number;
  heading: number;
}

export interface VehicleState {
  deviceId: string;
  name: string;
  status: VehicleStatus;
  mode: VehicleMode;
  lastSeen: number;
  telemetry: VehicleTelemetry | null;
  // 外部トラッキング(将来拡張)導入時に位置情報を格納するための予約フィールド。現時点では未使用。
  position?: VehiclePosition;
}

// ---- 操作UI -> Server ----

export interface ClientCommandMessage {
  type: "clientCommand";
  targetDeviceIds: string[] | "all";
  cmd: DriveCommand;
  speedL: number;
  speedR: number;
}

export interface SetModeMessage {
  type: "setMode";
  deviceId: string;
  mode: VehicleMode;
}

export interface SetVehicleNameMessage {
  type: "setVehicleName";
  deviceId: string;
  name: string;
}

export interface RouteStartMessage {
  type: "routeStart";
  routeId: string;
}

export interface RouteStopMessage {
  type: "routeStop";
}

export type ClientInboundMessage =
  | ClientCommandMessage
  | SetModeMessage
  | SetVehicleNameMessage
  | RouteStartMessage
  | RouteStopMessage;

// ---- Server -> 操作UI ----

export interface FleetStateMessage {
  type: "fleetState";
  vehicles: VehicleState[];
}

export interface RouteStatusMessage {
  type: "routeStatus";
  routeId: string;
  running: boolean;
  elapsedMs: number;
  perVehicle: { deviceId: string; stepIndex: number }[];
}

export type ClientOutboundMessage = FleetStateMessage | RouteStatusMessage;
