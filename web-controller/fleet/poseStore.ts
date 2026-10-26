import type {
  FieldConfig, LocalizerHelloMessage, LocalizerMarkerPose, LocalizerState, PoseFrameMessage,
  PoseStateMessage, RobotDefinition, RobotPoseState,
} from "./protocol";

// 最新フレームがこの時間届かなければstale(座標を使わない)。周期の実測後に再設定する暫定値。
export const POSE_STALE_MS = 500;
// 外れ値ゲート: 直前の有効姿勢から「最大速度×経過時間＋余裕」を超える移動を棄却する。
export const OUTLIER_MAX_SPEED_MMPS = 500;
const OUTLIER_MARGIN_MM = 30;
const OUTLIER_REACQUIRE_MS = 1500;
const OUTLIER_CONFIRM_FRAMES = 3;
const OUTLIER_CONFIRM_RADIUS_MM = 40;
const STATS_WINDOW = 20;
const MAX_MARKERS_PER_FRAME = 8;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isMarkerId = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 3;

export function parseLocalizerHello(value: Record<string, unknown>): LocalizerHelloMessage | null {
  if (typeof value.camera !== "string" || value.camera.length > 128
    || !Number.isInteger(value.width) || (value.width as number) < 1 || (value.width as number) > 8192
    || !Number.isInteger(value.height) || (value.height as number) < 1 || (value.height as number) > 8192) return null;
  return { type: "localizerHello", camera: value.camera, width: value.width as number, height: value.height as number };
}

export function parsePoseFrame(value: Record<string, unknown>): PoseFrameMessage | null {
  if (!Number.isInteger(value.frameId) || (value.frameId as number) < 0 || !isFiniteNumber(value.capturedAt)
    || !Number.isInteger(value.referenceCount) || (value.referenceCount as number) < 0 || (value.referenceCount as number) > 4
    || typeof value.extrinsicsOk !== "boolean" || !Array.isArray(value.markers)
    || value.markers.length > MAX_MARKERS_PER_FRAME) return null;
  const markers: LocalizerMarkerPose[] = [];
  for (const raw of value.markers as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object" || !isMarkerId(raw.markerId) || typeof raw.valid !== "boolean") return null;
    if (raw.valid) {
      const bounded = (n: unknown) => isFiniteNumber(n) && Math.abs(n) <= 100000;
      if (!bounded(raw.x) || !bounded(raw.y) || !bounded(raw.yawDeg)) return null;
      markers.push({ markerId: raw.markerId, valid: true, x: raw.x as number, y: raw.y as number,
        yawDeg: raw.yawDeg as number, insideField: raw.insideField === true });
    } else {
      markers.push({ markerId: raw.markerId, valid: false });
    }
  }
  return { type: "poseFrame", frameId: value.frameId as number, capturedAt: value.capturedAt as number,
    referenceCount: value.referenceCount as number, extrinsicsOk: value.extrinsicsOk, markers };
}

interface TrackedPose {
  xMm: number;
  yMm: number;
  headingDeg: number;
  insideField: boolean;
  at: number;
}

interface MarkerTrack {
  current: TrackedPose | null;
  lastAccepted: TrackedPose | null;
  pending: { xMm: number; yMm: number; count: number } | null;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

// 俯瞰カメラのposeFrameを保持し、ロボットごとの追跡状態(tracking/stale/lost/unassigned)を判定する。
export class PoseStore {
  private tracks = new Map<number, MarkerTrack>();
  private connected = false;
  private running = false;
  private camera: string | undefined;
  private stopReason: string | undefined;
  private referenceCount = 0;
  private extrinsicsOk = false;
  private lastFrameAt: number | null = null;
  private frameTimes: number[] = [];
  private latencies: number[] = [];

  constructor(private now: () => number = Date.now) {}

  onHello(hello: LocalizerHelloMessage): void {
    this.reset();
    this.connected = true;
    this.running = true;
    this.camera = hello.camera;
  }

  onStatus(state: "running" | "stopped", reason?: string): void {
    this.running = state === "running";
    this.stopReason = this.running ? undefined : reason;
    if (!this.running) this.clearCurrent();
  }

  onClosed(): void {
    this.connected = false;
    this.running = false;
    this.clearCurrent();
  }

  ingest(frame: PoseFrameMessage, field: FieldConfig): void {
    const now = this.now();
    this.lastFrameAt = now;
    this.referenceCount = frame.referenceCount;
    this.extrinsicsOk = frame.extrinsicsOk;
    this.frameTimes = [...this.frameTimes, now].slice(-STATS_WINDOW);
    const latency = now - frame.capturedAt;
    if (latency >= -50 && latency < 10000) this.latencies = [...this.latencies, Math.max(0, latency)].slice(-STATS_WINDOW);
    this.clearCurrent();
    for (const marker of frame.markers) {
      if (!marker.valid) continue;
      const track = this.track(marker.markerId);
      const xMm = (marker.x as number) / 1600 * field.widthMm;
      const yMm = (marker.y as number) / 900 * field.heightMm;
      const pose: TrackedPose = { xMm, yMm, headingDeg: marker.yawDeg as number, insideField: marker.insideField === true, at: now };
      if (this.accepts(track, pose)) {
        track.lastAccepted = pose;
        track.current = pose;
        track.pending = null;
      }
    }
  }

  snapshot(robots: RobotDefinition[], field: FieldConfig): PoseStateMessage {
    const now = this.now();
    const frameAgeMs = this.lastFrameAt === null ? null : now - this.lastFrameAt;
    const fresh = this.connected && this.running && frameAgeMs !== null && frameAgeMs <= POSE_STALE_MS;
    const poses = robots.map((robot): RobotPoseState => {
      const base = { robotId: robot.robotId, deviceId: robot.driveDeviceId, markerId: robot.markerId };
      if (robot.markerId === null) return { ...base, tracking: "unassigned" };
      if (!fresh) return { ...base, tracking: "stale" };
      const current = this.tracks.get(robot.markerId)?.current;
      if (!current) return { ...base, tracking: "lost" };
      return { ...base, tracking: "tracking", xMm: current.xMm, yMm: current.yMm,
        headingDeg: current.headingDeg, insideField: current.insideField, ageMs: now - current.at };
    });
    return { type: "poseState", localizer: this.localizerState(frameAgeMs), field, poses };
  }

  private localizerState(frameAgeMs: number | null): LocalizerState {
    const span = this.frameTimes.length > 1 ? this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0] : 0;
    const active = frameAgeMs !== null && frameAgeMs <= 1000 && span > 0;
    return { connected: this.connected, running: this.running, camera: this.camera,
      referenceCount: this.referenceCount, extrinsicsOk: this.extrinsicsOk, frameAgeMs,
      fps: active ? (this.frameTimes.length - 1) / (span / 1000) : null,
      latencyMs: this.latencies.length ? median(this.latencies) : null, stopReason: this.stopReason };
  }

  private accepts(track: MarkerTrack, pose: TrackedPose): boolean {
    const last = track.lastAccepted;
    if (!last || pose.at - last.at > OUTLIER_REACQUIRE_MS) return true;
    const distance = Math.hypot(pose.xMm - last.xMm, pose.yMm - last.yMm);
    if (distance <= OUTLIER_MAX_SPEED_MMPS * (pose.at - last.at) / 1000 + OUTLIER_MARGIN_MM) return true;
    // 飛んだ位置が同じ場所で連続した場合のみ、実際の移動(手で動かした等)として再受理する。
    const pending = track.pending;
    const count = pending && Math.hypot(pose.xMm - pending.xMm, pose.yMm - pending.yMm) <= OUTLIER_CONFIRM_RADIUS_MM
      ? pending.count + 1 : 1;
    track.pending = { xMm: pose.xMm, yMm: pose.yMm, count };
    return count >= OUTLIER_CONFIRM_FRAMES;
  }

  private track(markerId: number): MarkerTrack {
    let track = this.tracks.get(markerId);
    if (!track) {
      track = { current: null, lastAccepted: null, pending: null };
      this.tracks.set(markerId, track);
    }
    return track;
  }

  private clearCurrent(): void {
    this.tracks.forEach((track) => { track.current = null; });
  }

  private reset(): void {
    this.tracks.clear();
    this.lastFrameAt = null;
    this.frameTimes = [];
    this.latencies = [];
    this.referenceCount = 0;
    this.extrinsicsOk = false;
    this.stopReason = undefined;
  }
}
