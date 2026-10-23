// ESP32 <-> フリートハブ <-> 操作UI 間で共有するJSONメッセージ仕様。
// ESP32ファームウェア側 (esp32_rc_car/esp32_rc_car.ino) のコメントと同期させること。

export type DriveCommand = "a" | "b" | "c" | "d" | "e";
export type VehicleMode = "manual" | "auto";
export type VehicleStatus = "online" | "offline";

export type DeviceCapability = "drive" | "display" | "camera";

export interface DeviceDescription {
  deviceId: string;
  name: string;
  fw: string;
  capabilities: DeviceCapability[];
}

export interface RobotDefinition {
  robotId: string;
  driveDeviceId: string;
  cameraDeviceId: string | null;
}

// ロボット顔の表情ID (esp32_rc_car.ino の enum ExpressionId と同期させること)
export type ExpressionId =
  | "neutral"
  | "happy"
  | "fun"
  | "laugh"
  | "surprised"
  | "curious"
  | "thinking"
  | "wink"
  | "worried"
  | "angry"
  | "sleepy"
  | "love"
  | "shocked"
  | "giveup"
  | "shy"
  | "composed";

// ---- Device (ESP32) -> Server ----

export interface HelloMessage {
  type: "hello";
  deviceId: string;
  name: string;
  fw: string;
  capabilities?: DeviceCapability[];
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

// OV2640カメラのスナップショット (JPEG/Base64)
export interface ImageFrameMessage {
  type: "imageFrame";
  deviceId: string;
  width: number;
  height: number;
  format: "jpeg";
  dataB64: string;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  deviceId: string;
}

export type DeviceInboundMessage = HelloMessage | TelemetryMessage | ImageFrameMessage | HeartbeatMessage;

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

export interface CaptureImageMessage {
  type: "captureImage";
}

// 連続ライブ配信の開始/停止 (ESP32側がCore0タスクで自律連写する)
export interface StreamStartMessage {
  type: "streamStart";
}

export interface StreamStopMessage {
  type: "streamStop";
}

// 手動で表情を指定する (durationMs省略時はファームウェア側デフォルトで自動判定表情に復帰)
export interface SetExpressionMessage {
  type: "setExpression";
  expression: ExpressionId;
  durationMs?: number;
}

// 画面レイアウトの指定 (esp32_rc_car.ino の FaceLayoutMode/fleetLayoutOverride と同期させること)
// "split": 上半分顔+下半分センサー情報 / "full": 顔のみ全画面 / "auto": ファームウェアの自動判定に戻す
export type DisplayLayoutMode = "split" | "full" | "auto";

export interface SetDisplayLayoutMessage {
  type: "setDisplayLayout";
  layout: DisplayLayoutMode;
}

export type DeviceOutboundMessage =
  | DriveMessage
  | SetNameMessage
  | CaptureImageMessage
  | StreamStartMessage
  | StreamStopMessage
  | SetExpressionMessage
  | SetDisplayLayoutMessage;

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

export interface PhysicalDeviceState extends DeviceDescription {
  status: VehicleStatus;
  lastSeen: number;
  streaming?: boolean;
}

export interface RobotState extends RobotDefinition {
  name: string;
  status: VehicleStatus;
  cameraStatus: VehicleStatus | "unassigned";
}

export interface VehicleState extends PhysicalDeviceState {
  deviceId: string;
  name: string;
  status: VehicleStatus;
  mode: VehicleMode;
  lastSeen: number;
  telemetry: VehicleTelemetry | null;
  // 最新のスナップショットを受信した時刻(ms epoch)。未取得のuseundefined。
  lastImageAt?: number;
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

// 指定した車両にスナップショット撮影を要求する (カメラ搬載機のみ対象)
export interface ClientCaptureRequestMessage {
  type: "clientCaptureRequest";
  targetDeviceIds: string[] | "all";
}

// 指定した車両のライブ映像配信(定期captureImage送信)を開始/停止する
export interface ClientStreamRequestMessage {
  type: "clientStreamRequest";
  deviceId: string;
  action: "start" | "stop";
}

// 指定した車両に手動表情を要求する
export interface ClientExpressionRequestMessage {
  type: "clientExpressionRequest";
  targetDeviceIds: string[] | "all";
  expression: ExpressionId;
  durationMs?: number;
}

// 指定した車両に画面レイアウトの切り替えを要求する
export interface ClientDisplayLayoutRequestMessage {
  type: "clientDisplayLayoutRequest";
  targetDeviceIds: string[] | "all";
  layout: DisplayLayoutMode;
}

export type ClientInboundMessage =
  | ClientCommandMessage
  | SetModeMessage
  | SetVehicleNameMessage
  | RouteStartMessage
  | RouteStopMessage
  | ClientCaptureRequestMessage
  | ClientStreamRequestMessage
  | ClientExpressionRequestMessage
  | ClientDisplayLayoutRequestMessage
  | { type: "assignCamera"; requestId: string; robotId: string; cameraDeviceId: string | null };

// ---- Server -> 操作UI ----

export interface FleetStateMessage {
  type: "fleetState";
  vehicles: VehicleState[];
  devices: PhysicalDeviceState[];
  robots: RobotState[];
}

export interface RouteStatusMessage {
  type: "routeStatus";
  routeId: string;
  running: boolean;
  elapsedMs: number;
  perVehicle: { deviceId: string; stepIndex: number }[];
}

// デバイスから到着したimageFrameに受信時刻を付与してクライアントへ中継する
export interface ImageFrameBroadcastMessage extends ImageFrameMessage {
  capturedAt: number;
}

export interface OperationResultMessage {
  type: "operationResult";
  requestId: string;
  ok: boolean;
  error?: string;
}

export type ClientOutboundMessage = FleetStateMessage | RouteStatusMessage | ImageFrameBroadcastMessage | OperationResultMessage;
