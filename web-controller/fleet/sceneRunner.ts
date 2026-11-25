import { compilePlan, type PlanEntry, type ScenePlan } from "../scene/timedPlan";
import { createSafety, findDetourPath, type Point, type Safety } from "../scene/safety";
import type { SceneMap, Track } from "../scene/types";
import { normalizeYaw, shortestTurn } from "../scene/units";
import {
  idleSnapshot, type HaltKind, type InitialMismatch, type PositionState, type RobotRunStatus, type RunCheck, type RunCondition, type RunLogEntry,
  type RunResultFile, type RunResultRow, type RunRobot, type RunSnapshot,
} from "../scene/runTypes";
import { control, DRIVE_LIMITS, GEOFENCE_SAFE_MARGIN_MM, STOP, type AdaptiveRuntimeContext, type Drive } from "./motionController";
import type { PoseStateMessage, RobotDefinition, RobotMotionCalibration, RobotPoseState } from "./protocol";
import { BAND_HALF_MM, CONFLICT_MM, decide, distance, findConflicts, findEvasion, hasPassed, type Mover } from "./trafficManager";
import type { RunEvasion } from "../scene/runTypes";

// D7: arrival is judged on position, heading and a short hold.
export const ARRIVE_POS_MM = 20;
export const ARRIVE_YAW_DEG = 15;
export const ARRIVE_HOLD_MS = 100;
const RESEND_MS = 400;
const WAIT_TIMEOUT_MS = 30_000;
const STUCK_WINDOW_MS = 3500;
const STUCK_MIN_MM = 10;
const RESUME_RADIUS_MM = 60;
const RESUME_HOLD_MS = 1000;
const STALE_FRAME_MS = 1500;
const POSITION_TIMEOUT_MS = 60_000;
const POSITION_SPEED_MMS = 80;
const MAX_LOG = 200;
const EPS = 1e-6;

export interface RunnerDeps {
  now(): number;
  sendDrive(deviceId: string, drive: Drive): void;
  // The exhibit screen follows this clock: scene time, and whether it is advancing.
  onClock?(position: number, running: boolean): void;
}

export interface RunnerInput {
  poses: PoseStateMessage;
  robots: readonly RobotDefinition[];
  online(deviceId: string): boolean;
}

interface Evasion {
  yielder: Bot;
  priority: Bot;
  origin: { x: number; y: number };
  spot: { x: number; y: number };
  stage: "going" | "waiting" | "returning";
  why: RunEvasion["reason"];
}

const EVADE_COOLDOWN_MS = 3000;

interface Arrival { at: number; posErrMm: number; yawErrDeg: number }

interface PulseObservation {
  cmd: Drive["cmd"];
  startX: number;
  startY: number;
  startYaw: number;
  durationMs: number;
  expectedMm: number;
}

interface Bot {
  track: Track;
  // シーン内のロボット行の1始まり連番（ロボット 1 -> 1, ロボット 2 -> 2 ...）
  slot: number;
  // track.robotId または /robots の sceneSlot から解決された実機ロボットID
  resolvedRobotId: string | null;
  moves: PlanEntry[];
  arrivals: Map<string, Arrival>;
  waited: Map<string, number>;
  within: number | null;
  stuck: { at: number; x: number; y: number; yaw: number; retried: boolean } | null;
  lost: { x: number; y: number } | null;
  lastDrive: Drive | null;
  lastSentAt: number;
  position: { state: PositionState; detail: string; startedAt: number | null };
  // 初期位置への移動時に壁・障害物・他機体を迂回するための経由点列（末尾が init）
  positionPath: Point[];
  positionReplans: number;
  status: RobotRunStatus;
  posErr: number | null;
  yawErr: number | null;
  pose: RobotPoseState | null;
  priority: number | null;
  goalEntry: PlanEntry | null;
  motion: RobotMotionCalibration | null;
  spinStartedAt: number | null;
  spinPauseUntil: number | null;
  drivePulseStartedAt: number | null;
  drivePauseUntil: number | null;
  positionLostAt: number | null;
  aligningYaw: boolean;
  // ソフトスタート用の連続直進パルスステップ数（停止や旋回が入ると0にリセット）
  consecutiveLinearSteps: number;
  // 走行中のリアルタイム自動補正で逐次学習する左右トリム（正=右出力強化）
  dynamicTrimRatio: number;
  // 走行中のリアルタイム自動補正で逐次学習する実速度スケール（電池消耗時は <1.0）
  dynamicSpeedScale: number;
  // 直前のパルスで静止摩擦に負けて動かなかった場合の自動出力ブースト (PWM, 0〜35)
  stallBoostPwm: number;
  // 停止完了後に「新しいカメラフレーム（停止後撮影）」が到着するまで次パルスを保留する基準時刻
  pauseWaitFreshAfter: number | null;
  // 連続巡航(cont=true)中の静止摩擦スタック監視用チェックポイント
  contCheck: { at: number; x: number; y: number } | null;
  // 直前の駆動種別（STOP挟み込み後の linear <-> turn 切替を正しく検知してブースト持ち越しをクリアする）
  lastMotionKind: "linear" | "turn" | null;
  // 直前の駆動パルス開始時の姿勢と予測移動量（整定完了後に実移動量と比較して自動学習する）
  pendingObservation: PulseObservation | null;
}

const sameDrive = (a: Drive | null, b: Drive) =>
  !!a && a.cmd === b.cmd && a.speedL === b.speedL && a.speedR === b.speedR && a.durationMs === b.durationMs;
const plannedSpeed = (e: PlanEntry) => e.travel && e.from && e.to ? Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y) / e.travel : 0;

export class SceneRunner {
  private map: SceneMap | null = null;
  private plan: ScenePlan | null = null;
  private safety: Safety | null = null;
  private bots: Bot[] = [];
  private phase: RunSnapshot["phase"] = "idle";
  private clock = 0;
  private lastTick = 0;
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  private waitedMs = 0;
  private waitingSince: number | null = null;
  private halt: { kind: HaltKind; since: number; okSince: number | null } | null = null;
  private haltText = "";
  private positioning = { active: false, avoidWalls: true };
  private checks: RunCheck[] = [];
  private log: RunLogEntry[] = [];
  private input: RunnerInput | null = null;
  private waitTimeoutMs: number;
  private lostSince = new Map<Bot, number>();

  constructor(private deps: RunnerDeps, private options: { waitTimeoutMs?: number } = {}) {
    this.waitTimeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  }

  private orderOf(a: Bot, b: Bot): number {
    const pa = a.priority ?? Infinity, pb = b.priority ?? Infinity;
    if (pa !== pb) return pa - pb;
    return (a.pose?.markerId ?? 99) - (b.pose?.markerId ?? 99);
  }

  setWaitTimeout(seconds: number): string | null {
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 300) return "到着待ちの時間切れは5〜300秒で指定してください。";
    this.waitTimeoutMs = Math.round(seconds * 1000);
    return null;
  }

  get active(): boolean { return this.phase === "running" || this.phase === "waiting" || this.phase === "halted" || this.positioning.active; }
  get prepared(): boolean { return this.phase !== "idle" && this.phase !== "finished" && this.phase !== "aborted"; }

  // The Hub takes over (and later hands back) the drive of exactly these devices.
  controlledDeviceIds(): string[] {
    return this.bots.map((b) => b.pose?.deviceId).filter((id): id is string => !!id);
  }

  prepare(map: SceneMap): string | null {
    if (this.active) return "実行中はシーンを選び直せません。";
    this.map = map;
    this.plan = compilePlan(map);
    this.safety = createSafety(map);
    this.bots = map.tracks.filter((t) => t.kind === "robot" && !t.muted && t.initial).map((track, idx) => ({
      track, slot: idx + 1, resolvedRobotId: track.robotId?.trim() || null,
      arrivals: new Map(), waited: new Map(), within: null, stuck: null, lost: null, lastDrive: null, lastSentAt: 0,
      spinStartedAt: null, spinPauseUntil: null, drivePulseStartedAt: null, drivePauseUntil: null, positionLostAt: null, aligningYaw: false,
      consecutiveLinearSteps: 0, dynamicTrimRatio: 0, dynamicSpeedScale: 1.0, stallBoostPwm: 0, pauseWaitFreshAfter: null, contCheck: null, lastMotionKind: null, pendingObservation: null,
      position: { state: "waiting", detail: "", startedAt: null }, positionPath: [], positionReplans: 0, status: "idle", posErr: null, yawErr: null, pose: null, priority: null, goalEntry: null, motion: null,
      moves: this.plan!.entries.filter((e) => e.track === track && e.action.type === "move" && !e.blocked && e.outcome === "success" && e.start !== null)
        .sort((a, b) => a.start! - b.start!),
    }));
    this.phase = "arming";
    this.clock = 0;
    this.startedAt = this.endedAt = null;
    this.waitedMs = 0;
    this.waitingSince = null;
    this.halt = null;
    this.positioning = { active: false, avoidWalls: true };
    this.log = [];
    this.evasions = [];
    this.cooldown.clear();
    this.lostSince.clear();
    this.lastTick = this.deps.now();
    return null;
  }

  reset(): string | null {
    return this.map && !this.active ? this.prepare(this.map) : "実行中はやり直せません。";
  }

  position(avoidWalls = true): string | null {
    if (this.phase !== "arming") return "実行前の確認中だけ初期位置へ動かせます。";
    this.positioning = { active: true, avoidWalls };
    for (const bot of this.bots) {
      bot.position = { state: "waiting", detail: "", startedAt: null };
      bot.positionPath = [];
      bot.positionReplans = 0;
      bot.aligningYaw = false;
      bot.within = null;
      bot.consecutiveLinearSteps = 0;
      bot.stallBoostPwm = 0;
      bot.spinStartedAt = null;
      bot.spinPauseUntil = null;
      bot.drivePulseStartedAt = null;
      bot.drivePauseUntil = null;
      bot.pauseWaitFreshAfter = null;
      bot.contCheck = null;
      bot.lastMotionKind = null;
      bot.pendingObservation = null;
    }
    this.note("info", avoidWalls ? "初期位置への移動を始めました（壁を迂回）。" : "初期位置への移動を始めました（直線移動）。");
    return null;
  }

  start(): string | null {
    if (this.phase !== "arming") return "実行前の確認中だけ開始できます。";
    this.evalChecks();
    if (!this.checks.every((c) => c.ok || c.warn)) return "実行前の確認に満たない項目があります。";
    this.positioning = { active: false, avoidWalls: true };
    for (const bot of this.bots) {
      bot.within = null;
      bot.stuck = null;
      bot.lost = null;
      bot.aligningYaw = false;
      bot.consecutiveLinearSteps = 0;
      bot.stallBoostPwm = 0;
      bot.spinStartedAt = null;
      bot.spinPauseUntil = null;
      bot.drivePulseStartedAt = null;
      bot.drivePauseUntil = null;
      bot.pauseWaitFreshAfter = null;
      bot.contCheck = null;
      bot.lastMotionKind = null;
      bot.pendingObservation = null;
    }
    this.phase = "running";
    this.clock = 0;
    this.startedAt = this.deps.now();
    this.note("info", "開始");
    this.deps.onClock?.(0, true);
    return null;
  }

  pause(): string | null {
    if (this.phase === "arming" && this.positioning.active) {
      this.positioning = { active: false, avoidWalls: true };
      this.stopAll(true);
      this.note("warn", "初期位置への移動を止めました");
      return null;
    }
    if (this.phase !== "running" && this.phase !== "waiting") return "実行中だけ一時停止できます。";
    this.stopAll(true);
    this.enterHalt("operator", "操作者が一時停止しました");
    return null;
  }

  resume(): string | null {
    if (this.phase !== "halted") return "停止中だけ再開できます。";
    if (!this.resumeConditions().every((c) => c.ok)) return "再開の条件を満たしていません。";
    this.leaveHalt();
    return null;
  }

  abort(): string | null {
    if (this.phase === "idle" || this.phase === "finished" || this.phase === "aborted") return "実行していません。";
    this.stopAll(true);
    this.positioning = { active: false, avoidWalls: true };
    this.endedAt = this.deps.now();
    this.phase = "aborted";
    this.evasions = [];
    this.halt = null;
    this.note("warn", this.startedAt === null ? "確認を中止しました" : "操作者が中止しました");
    if (this.startedAt !== null) this.deps.onClock?.(this.clock, false);
    return null;
  }

  tick(input: RunnerInput): void {
    const now = this.deps.now();
    const dt = Math.min(Math.max(0, now - this.lastTick), 250);
    this.lastTick = now;
    this.input = input;
    if (!this.prepared) return;
    this.bindPoses(input);
    if (this.phase === "arming") {
      this.evalChecks();
      if (this.positioning.active) this.stepPositioning(now);
    } else if (this.phase === "running" || this.phase === "waiting") {
      this.stepRun(now, dt);
    } else if (this.phase === "halted") {
      this.stepHalted(now);
    }
  }

  snapshot(): RunSnapshot {
    if (!this.map) return idleSnapshot();
    const now = this.deps.now();
    const end = this.endedAt ?? now;
    const sortedForPosition = [...this.bots].sort((a, b) => this.orderOf(a, b));
    return {
      phase: this.phase, mapId: this.map.id, mapName: this.map.name, reason: this.reason(),
      alerts: this.alerts(), waitTimeoutSec: Math.round(this.waitTimeoutMs / 1000),
      initialMismatches: this.initialMismatches(), excludedRobots: this.excludedViews(),
      halt: this.halt ? { kind: this.halt.kind, since: this.halt.since } : null,
      resume: this.phase === "halted" ? this.resumeConditions() : [],
      clock: this.clock, duration: this.plan?.duration ?? 0, realMs: this.startedAt === null ? 0 : end - this.startedAt, waitedMs: this.waitedMs,
      checks: this.checks, canStart: this.phase === "arming" && this.checks.length > 0 && this.checks.every((c) => c.ok || c.warn),
      positioning: {
        active: this.positioning.active, items: sortedForPosition
          .map((b) => ({ trackId: b.track.id, name: b.track.name, state: b.position.state, detail: b.position.detail }))
      },
      robots: this.bots.map((b) => this.robotView(b)), evasions: this.evasionViews(), log: this.log, rows: this.rows(true),
    };
  }

  result(): RunResultFile {
    const end = this.endedAt ?? this.deps.now();
    return {
      schema: "scene-run-result/v1", mapId: this.map?.id ?? null, mapName: this.map?.name ?? "",
      outcome: this.phase === "finished" ? "finished" : "aborted", startedAt: this.startedAt, endedAt: this.endedAt,
      realSeconds: this.startedAt === null ? 0 : (end - this.startedAt) / 1000, planSeconds: this.plan?.duration ?? 0,
      waitedSeconds: this.waitedMs / 1000, rows: this.rows(false), log: this.log,
    };
  }

  private bindPoses(input: RunnerInput): void {
    const anySlotConfigured = input.robots.some((r) => r.sceneSlot != null);
    const explicitIds = new Set(
      this.bots.map((b) => b.track.robotId?.trim()).filter((id): id is string => !!id)
    );
    const fallbackCandidates = anySlotConfigured
      ? []
      : [...input.robots]
        .filter((r) => r.markerId !== null && !explicitIds.has(r.robotId))
        .sort((a, b) => (a.markerId ?? 99) - (b.markerId ?? 99));
    let fallbackIdx = 0;

    for (const bot of this.bots) {
      const explicit = bot.track.robotId?.trim() || null;
      let resolvedId: string | null = explicit;
      if (!resolvedId) {
        if (anySlotConfigured) {
          resolvedId = input.robots.find((r) => r.sceneSlot === bot.slot)?.robotId ?? null;
        } else {
          resolvedId = fallbackCandidates[fallbackIdx++]?.robotId ?? null;
        }
      }
      bot.resolvedRobotId = resolvedId;
      bot.pose = resolvedId ? input.poses.poses.find((p) => p.robotId === resolvedId) ?? null : null;
      const robotDef = resolvedId ? input.robots.find((r) => r.robotId === resolvedId) : undefined;
      bot.priority = robotDef?.priority ?? null;
      bot.motion = robotDef?.motion ?? null;
    }
  }

  private tracked(bot: Bot): { x: number; y: number; yaw: number } | null {
    const p = bot.pose;
    return p && p.tracking === "tracking" && p.xMm !== undefined && p.yMm !== undefined && p.headingDeg !== undefined
      ? { x: p.xMm, y: p.yMm, yaw: p.headingDeg } : null;
  }

  private note(kind: RunLogEntry["kind"], text: string): void {
    this.log.push({ clock: this.clock, at: this.deps.now(), kind, text });
    if (this.log.length > MAX_LOG) this.log.shift();
  }

  private buildRuntimeContext(bot: Bot): AdaptiveRuntimeContext {
    const field = this.input?.poses.field;
    const latency = this.input?.poses.localizer.latencyMs ?? 90;
    return {
      consecutiveLinearSteps: bot.consecutiveLinearSteps,
      dynamicTrimRatio: bot.dynamicTrimRatio,
      dynamicSpeedScale: bot.dynamicSpeedScale,
      stallBoostPwm: bot.stallBoostPwm,
      cameraLatencyMs: latency,
      cameraFps: this.input?.poses.localizer.fps ?? null,
      field: field ? { widthMm: field.widthMm, heightMm: field.heightMm } : undefined,
    };
  }

  // 走行中のリアルタイム自動補正（カメラ整定後に直前の1ステップの実移動量・曲がり量を評価して次回出力を補正）
  private evaluateSettledObservation(bot: Bot, at: { x: number; y: number; yaw: number }): void {
    const obs = bot.pendingObservation;
    if (!obs || !bot.motion) return;
    bot.pendingObservation = null;

    if (obs.cmd === "c" || obs.cmd === "d") {
      const turnedDeg = Math.abs(shortestTurn(obs.startYaw, at.yaw));
      if (turnedDeg < 2.0) {
        bot.stallBoostPwm = Math.min(50, bot.stallBoostPwm + 12);
      } else if (turnedDeg >= 25.0) {
        // 大きく回転した後はオーバーシュート連鎖を防ぐためブーストを即座にリセット
        bot.stallBoostPwm = 0;
      } else if (turnedDeg >= 10.0) {
        bot.stallBoostPwm = Math.max(0, bot.stallBoostPwm - 20);
      } else {
        bot.stallBoostPwm = Math.max(0, bot.stallBoostPwm - 8);
      }
      return;
    }

    if (obs.cmd === "a" || obs.cmd === "b") {
      const actualMm = Math.hypot(at.x - obs.startX, at.y - obs.startY);
      if (actualMm < 2.5) {
        bot.stallBoostPwm = Math.min(45, bot.stallBoostPwm + 12);
      } else if (actualMm >= 12.0) {
        // 十分に動き出せたら次回クリープでの飛び出し(+79mm等)を防ぐためブーストを即座にリセット
        bot.stallBoostPwm = 0;
      } else {
        bot.stallBoostPwm = Math.max(0, bot.stallBoostPwm - 8);
      }
      if (obs.durationMs >= 150 && obs.expectedMm >= 10) {
        const ratio = Math.max(0.5, Math.min(1.6, actualMm / obs.expectedMm));
        // 指数移動平均(EMA)で電池消耗や路面摩擦に伴う実速度スケールを更新（短歩クリープでは歪むため150ms以上のみ）
        bot.dynamicSpeedScale = Math.max(0.7, Math.min(1.35, bot.dynamicSpeedScale * 0.75 + ratio * 0.25));
      }
      if (actualMm >= 18) {
        // +Y下向き座標系では前進時に L > R で yaw 増加(+)となるため、yawDrift > 0 のときは右輪強化(trimDelta > 0)が正
        const yawDrift = shortestTurn(obs.startYaw, at.yaw);
        const sign = obs.cmd === "b" ? -1 : 1;
        const trimDelta = sign * yawDrift * 0.0015;
        bot.dynamicTrimRatio = Math.max(-0.15, Math.min(0.15, bot.dynamicTrimRatio + trimDelta));
      }
    }
  }

  // 実機(isCalibrated)の「駆動(ACTUATE) -> 慣性整定待ち(SETTLE) -> カメラ観測(OBSERVE)」サイクル管理
  private drive(bot: Bot, rawDrive: Drive, force = false): void {
    const deviceId = bot.pose?.deviceId;
    if (!deviceId) return;
    const now = this.deps.now();

    let drive = rawDrive;
    const isCalibrated = bot.motion !== null;
    const isTurn = rawDrive.cmd === "c" || rawDrive.cmd === "d";
    const isLinear = rawDrive.cmd === "a" || rawDrive.cmd === "b";

    if (isCalibrated) {
      const at = this.tracked(bot);
      const latencyWait = Math.min(200, Math.max(80, this.input?.poses.localizer.latencyMs ?? 100));
      // 連続巡航からの停止はソフトストップ＋惰性分を考慮、単発パルス(fw 4.2.0即時遮断)は実機停止時刻基準で最短整定
      const cruiseSettleMs = Math.max(340, 220 + latencyWait);
      const cruiseFreshOffsetMs = 220;
      const pulseSettleMs = Math.max(240, 150 + latencyWait);
      const pulseFreshOffsetMs = 150;

      // 連続巡航(continuous)からクリープ・旋回・停止へ切り替わる瞬間は、必ず一度ソフトストップ＋整定待ちを挟む
      const wasContinuous = !!bot.lastDrive?.continuous && (bot.lastDrive.cmd === "a" || bot.lastDrive.cmd === "b");
      if (wasContinuous && !rawDrive.continuous) {
        bot.drivePauseUntil = now + cruiseSettleMs;
        bot.spinPauseUntil = now + cruiseSettleMs;
        bot.pauseWaitFreshAfter = now + cruiseFreshOffsetMs;
      }

      // 低FPS時でも「停止後に撮影された新しいカメラフレーム」が届くまで次パルスを待つ（最大1100msで安全解放）
      const poseCapturedAt = bot.pose?.ageMs !== undefined ? now - bot.pose.ageMs : now;
      const waitingForFreshFrame =
        bot.pauseWaitFreshAfter !== null &&
        poseCapturedAt < bot.pauseWaitFreshAfter &&
        now < bot.pauseWaitFreshAfter + 1100;

      if (isTurn) {
        if (bot.lastMotionKind === "linear") {
          bot.stallBoostPwm = 0; // 直進から旋回への切替時はブースト持ち越しをクリア
        }
        bot.contCheck = null;
        bot.consecutiveLinearSteps = 0;
        bot.drivePulseStartedAt = null;
        const spinWindowMs = Math.max(40, Math.min(220, rawDrive.durationMs ?? 80));
        if ((bot.spinPauseUntil !== null && now < bot.spinPauseUntil) || waitingForFreshFrame) {
          drive = STOP;
        } else if (bot.spinStartedAt === null) {
          bot.pauseWaitFreshAfter = null;
          if (at) this.evaluateSettledObservation(bot, at);
          bot.spinStartedAt = now;
          bot.lastMotionKind = "turn";
          if (at) {
            bot.pendingObservation = {
              cmd: rawDrive.cmd,
              startX: at.x,
              startY: at.y,
              startYaw: at.yaw,
              durationMs: spinWindowMs,
              expectedMm: 0,
            };
          }
        } else if (now - bot.spinStartedAt >= spinWindowMs) {
          const spinEnd = bot.spinStartedAt + spinWindowMs;
          bot.spinStartedAt = null;
          bot.spinPauseUntil = spinEnd + pulseSettleMs;
          bot.pauseWaitFreshAfter = spinEnd + pulseFreshOffsetMs;
          drive = STOP;
        } else {
          // 既に単発タイマー駆動を送信済みのため、途中tickで再送してESP32タイマーを再延長しない
          return;
        }
      } else if (isLinear && rawDrive.continuous) {
        // 案A：遠距離(>100mm)かつ高FPS・安全領域内の連続巡航（完全停止を挟まず滑らかに走行、durationMs=400msで自律安全保護）
        if (bot.lastMotionKind === "turn") {
          bot.stallBoostPwm = 0; // 旋回から巡航への切替時は旋回ブーストを持ち越さない
          bot.contCheck = null;
        }
        bot.lastMotionKind = "linear";
        bot.spinStartedAt = null;
        bot.drivePulseStartedAt = null;
        bot.drivePauseUntil = null;
        bot.pauseWaitFreshAfter = null;
        // 連続巡航中も450msごとの移動量を監視し、静止摩擦で止まっていたら自動で stallBoostPwm を加算する
        if (at) {
          if (!bot.contCheck) {
            bot.contCheck = { at: now, x: at.x, y: at.y };
          } else if (now - bot.contCheck.at >= 450) {
            const moved = Math.hypot(at.x - bot.contCheck.x, at.y - bot.contCheck.y);
            if (moved < 5) {
              bot.stallBoostPwm = Math.min(60, bot.stallBoostPwm + 15);
            } else {
              bot.stallBoostPwm = Math.max(0, bot.stallBoostPwm - 5);
            }
            bot.contCheck = { at: now, x: at.x, y: at.y };
          }
        }
        // 経過時間ベースでソフトスタートを段階解除（1ティックで即フルPWMに跳ね上がらないようにする）
        if (!bot.lastDrive?.continuous || now - bot.lastSentAt >= 200) {
          bot.consecutiveLinearSteps += 1;
        }
        drive = rawDrive;
      } else if (isLinear) {
        bot.contCheck = null;
        if (bot.lastMotionKind === "turn") {
          bot.stallBoostPwm = 0; // 旋回から直進・クリープへの切替時は旋回ブーストを持ち越さない
        }
        bot.spinStartedAt = null;
        const pulseWindowMs = Math.max(40, Math.min(420, rawDrive.durationMs ?? 100));
        if ((bot.drivePauseUntil !== null && now < bot.drivePauseUntil) || waitingForFreshFrame) {
          drive = STOP;
        } else if (bot.drivePulseStartedAt === null) {
          bot.pauseWaitFreshAfter = null;
          // 整定期間＋新フレーム確認が明けたので、直前のステップの実移動量を評価してリアルタイム補正を更新
          if (at) this.evaluateSettledObservation(bot, at);
          bot.drivePulseStartedAt = now;
          bot.lastMotionKind = "linear";
          bot.consecutiveLinearSteps += 1;
          if (at && bot.motion) {
            const durSec = (rawDrive.durationMs ?? 100) / 1000;
            const expectedMm = bot.motion.speedMmS * durSec * 0.75;
            bot.pendingObservation = {
              cmd: rawDrive.cmd,
              startX: at.x,
              startY: at.y,
              startYaw: at.yaw,
              durationMs: rawDrive.durationMs ?? 100,
              expectedMm,
            };
          }
        } else if (now - bot.drivePulseStartedAt >= pulseWindowMs) {
          const pulseEnd = bot.drivePulseStartedAt + pulseWindowMs;
          bot.drivePulseStartedAt = null;
          bot.drivePauseUntil = pulseEnd + pulseSettleMs;
          bot.pauseWaitFreshAfter = pulseEnd + pulseFreshOffsetMs;
          drive = STOP;
        } else {
          // 既に単発タイマー駆動を送信済みのため、途中tickで再送してESP32タイマーを再延長しない
          return;
        }
      } else {
        bot.spinStartedAt = null;
        bot.drivePulseStartedAt = null;
        bot.contCheck = null;
        bot.consecutiveLinearSteps = 0;
      }
    }

    const resendLimit = drive.continuous ? Math.min(RESEND_MS, 180) : RESEND_MS;
    if (!force && sameDrive(bot.lastDrive, drive) && now - bot.lastSentAt < resendLimit) return;
    bot.lastDrive = drive;
    bot.lastSentAt = now;
    this.deps.sendDrive(deviceId, drive);
  }

  private stopAll(force: boolean): void {
    for (const bot of this.bots) {
      bot.consecutiveLinearSteps = 0;
      this.drive(bot, STOP, force);
    }
  }

  // ---- arming ----

  private initialLimits(b: Bot): { posMm: number; yawDeg: number } {
    if (b.motion !== null && b.position.state === "arrived") {
      return { posMm: 50, yawDeg: 30 };
    }
    return { posMm: ARRIVE_POS_MM, yawDeg: b.motion !== null ? 22 : ARRIVE_YAW_DEG };
  }

  private evalChecks(): void {
    const input = this.input;
    if (!input || !this.plan) return;
    const loc = input.poses.localizer;
    const total = this.bots.length;
    const count = (pred: (b: Bot) => boolean) => this.bots.filter(pred).length;
    const inScene = new Set(this.bots.map((b) => b.resolvedRobotId).filter((id): id is string => !!id));
    const outsiders = input.poses.poses.filter((p) => p.tracking === "tracking" && !inScene.has(p.robotId));
    const atInitial = (b: Bot) => {
      const at = this.tracked(b);
      const init = b.track.initial!;
      if (!at) return false;
      b.posErr = Math.hypot(init.x - at.x, init.y - at.y);
      const effYaw = b.motion ? normalizeYaw(at.yaw - b.motion.yawOffsetDeg) : at.yaw;
      b.yawErr = Math.abs(shortestTurn(effYaw, init.yaw));
      const { posMm, yawDeg } = this.initialLimits(b);
      return b.posErr <= posMm && b.yawErr <= yawDeg;
    };
    const check = (id: string, label: string, ok: boolean, detail: string, warn = false): RunCheck => ({ id, label, ok, detail, ...(warn ? { warn } : {}) });
    this.checks = [
      check("localizer", "測位カメラが動作中", loc.connected && loc.running,
        loc.connected && loc.running ? `遅延 ${loc.latencyMs ?? "-"}ms / ${loc.fps?.toFixed(1) ?? "-"}fps` : "測位が接続されていません"),
      check("references", "基準マーカーが3枚以上", loc.referenceCount >= 3 && loc.extrinsicsOk, `${loc.referenceCount}/4`),
      check("assigned", "シーンの全ロボットにマーカーが割り当て済み", total > 0 && count((b) => b.pose?.markerId != null) === total, `${count((b) => b.pose?.markerId != null)}/${total}台`),
      check("tracking", "全ロボットが追跡中", total > 0 && count((b) => b.pose?.tracking === "tracking") === total, `${count((b) => b.pose?.tracking === "tracking")}/${total}`),
      check("devices", "駆動デバイスが接続中", total > 0 && count((b) => !!b.pose && input.online(b.pose.deviceId)) === total,
        `${count((b) => !!b.pose && input.online(b.pose.deviceId))}/${total}`),
      check("initial", `全ロボットが初期位置にいる（位置${ARRIVE_POS_MM}mm・向き${ARRIVE_YAW_DEG}°）`, total > 0 && count(atInitial) === total, `${count(atInitial)}/${total}`),
      check("plan", "計画にエラーがない", this.plan.errors.length === 0, this.plan.errors.length ? `${this.plan.errors.length}件: ${this.plan.errors[0]}` : "なし"),
      ...(outsiders.length ? [check("outsiders", "シーンに入っていないロボットが盤面にいます（動かない障害物として扱います）", false,
        outsiders.map((p) => p.robotId).join("、"), true)] : []),
    ];
  }

  private stepPositioning(now: number): void {
    const items = this.bots;
    const todo = items.filter((b) => b.position.state !== "arrived" && b.position.state !== "failed")
      .sort((a, b) => this.orderOf(a, b));
    for (const bot of items) if (!todo.includes(bot)) this.drive(bot, STOP);
    const bot = todo[0];
    for (const other of todo.slice(1)) this.drive(other, STOP);
    if (!bot) {
      this.positioning = { active: false, avoidWalls: true };
      this.note("info", items.some((b) => b.position.state === "failed") ? "初期位置への移動を終えました（動かせない機体があります）" : "全ロボットが初期位置に着きました");
      return;
    }
    const at = this.tracked(bot);
    const init = bot.track.initial!;
    const fail = (detail: string) => { bot.position = { state: "failed", detail, startedAt: null }; this.drive(bot, STOP, true); this.note("warn", `${bot.track.name}: ${detail}`); };
    if (!bot.pose?.deviceId || !this.input?.online(bot.pose.deviceId)) {
      return fail("駆動デバイスがオフラインです。電源とWi-Fi接続を確認してください");
    }
    if (!at) {
      if (bot.positionLostAt === null) bot.positionLostAt = now;
      const lostLimit = bot.motion !== null ? 4000 : 2000;
      if (now - bot.positionLostAt > lostLimit) return fail("追跡できません。手で初期位置へ置いてください");
      this.drive(bot, STOP);
      return;
    }
    bot.positionLostAt = null;
    const otherRobots: { x: number; y: number }[] = [
      ...items.filter((other) => other !== bot)
        .map((other) => this.tracked(other))
        .filter((p): p is { x: number; y: number; yaw: number } => !!p),
      ...this.obstacles(),
    ];
    if (bot.position.startedAt === null) {
      if (otherRobots.some((o) => Math.hypot(o.x - init.x, o.y - init.y) < CONFLICT_MM)) {
        return fail("初期位置付近に別のロボットがいます。手で置き直してください");
      }
      if (this.positioning.avoidWalls) {
        const detour = findDetourPath(this.safety!, at, init, otherRobots, 180)
          ?? findDetourPath(this.safety!, at, init, otherRobots, 145);
        if (!detour) {
          return fail("壁や障害物を迂回する経路が見つかりません。「MAPの壁を迂回する」をオフにするか手で置き直してください");
        }
        bot.positionPath = detour;
      } else {
        bot.positionPath = [init];
      }
      bot.position = { state: "moving", detail: "", startedAt: now };
      bot.within = null;
      bot.stuck = null;
      bot.consecutiveLinearSteps = 0;
    }
    while (
      bot.positionPath.length > 1 &&
      Math.hypot(bot.positionPath[0].x - at.x, bot.positionPath[0].y - at.y) <= 35
    ) {
      bot.positionPath.shift();
    }
    const isFinal = bot.positionPath.length <= 1;
    const wp = isFinal ? init : bot.positionPath[0];
    const distToInit = Math.hypot(init.x - at.x, init.y - at.y);
    let targetX = wp.x, targetY = wp.y;
    let rotate = false;
    if (isFinal) {
      if (distToInit <= ARRIVE_POS_MM) bot.aligningYaw = true;
      else if (distToInit > 42) bot.aligningYaw = false;
      rotate = (bot.motion !== null && bot.aligningYaw) || distToInit <= ARRIVE_POS_MM;
      if (!rotate && !this.positioning.avoidWalls && distToInit > 60) {
        const dx = init.x - at.x, dy = init.y - at.y;
        const len2 = dx * dx + dy * dy;
        const fieldW = this.input?.poses.field?.widthMm ?? 1100;
        const fieldH = this.input?.poses.field?.heightMm ?? 620;
        for (const oPos of otherRobots) {
          const t = Math.max(0.05, Math.min(0.95, ((oPos.x - at.x) * dx + (oPos.y - at.y) * dy) / len2));
          const qx = at.x + t * dx, qy = at.y + t * dy;
          const clearDist = Math.hypot(qx - oPos.x, qy - oPos.y);
          if (clearDist < 145) {
            const ux = clearDist > 1 ? (qx - oPos.x) / clearDist : -dy / distToInit;
            const uy = clearDist > 1 ? (qy - oPos.y) / clearDist : dx / distToInit;
            targetX = Math.max(150, Math.min(fieldW - 150, oPos.x + ux * 165));
            targetY = Math.max(150, Math.min(fieldH - 150, oPos.y + uy * 165));
            break;
          }
        }
      }
    } else {
      bot.aligningYaw = false;
    }
    const c = control(
      at,
      { x: targetX, y: targetY, yaw: init.yaw, rotate, speedMmS: POSITION_SPEED_MMS, allowReverse: isFinal },
      bot.motion,
      this.buildRuntimeContext(bot)
    );
    const truePosErr = isFinal ? (rotate ? 0 : distToInit) : Math.hypot(targetX - at.x, targetY - at.y);
    bot.posErr = distToInit;
    const effYaw = bot.motion ? normalizeYaw(at.yaw - bot.motion.yawOffsetDeg) : at.yaw;
    bot.yawErr = Math.abs(shortestTurn(effYaw, init.yaw));
    if (isFinal && c.phase === "geofenceBrake" && distToInit <= 48) {
      // 外周の初期位置付近でジオフェンスに阻まれた場合はその場で向き合わせへ移行してデッドロックを防ぐ
      bot.aligningYaw = true;
      this.drive(bot, STOP, true);
      return;
    }
    if (isFinal) {
      bot.position.detail = `残り ${Math.round(truePosErr)}mm`;
      if (this.arrived(bot, truePosErr, c.yawErrDeg, now)) {
        bot.position = { state: "arrived", detail: "到着済み", startedAt: null };
        bot.positionPath = [];
        this.drive(bot, STOP, true);
        return;
      }
    } else {
      let rem = Math.hypot(wp.x - at.x, wp.y - at.y);
      for (let i = 0; i < bot.positionPath.length - 1; i++) {
        rem += Math.hypot(
          bot.positionPath[i + 1].x - bot.positionPath[i].x,
          bot.positionPath[i + 1].y - bot.positionPath[i].y
        );
      }
      bot.position.detail = `迂回中（残り ${Math.round(rem)}mm）`;
    }
    if (c.drive.cmd === "a" || c.drive.cmd === "b") {
      const stepGoal = { x: targetX, y: targetY };
      const segLen = distance(at, stepGoal);
      if (segLen > 1) {
        const ahead = {
          x: at.x + (stepGoal.x - at.x) / segLen * Math.min(segLen, CONFLICT_MM),
          y: at.y + (stepGoal.y - at.y) / segLen * Math.min(segLen, CONFLICT_MM),
        };
        if (otherRobots.some((o) => distance(ahead, o) < CONFLICT_MM && distance(at, o) > distance(ahead, o))) {
          if (this.positioning.avoidWalls && bot.positionReplans < 2 && otherRobots.every((o) => distance(at, o) >= CONFLICT_MM)) {
            const replanned = findDetourPath(this.safety!, at, init, otherRobots, 185);
            const nextWp = replanned?.[0];
            if (replanned && nextWp && Math.hypot(nextWp.x - targetX, nextWp.y - targetY) > 15) {
              bot.positionReplans += 1;
              bot.positionPath = replanned;
              this.drive(bot, STOP, true);
              return;
            }
          }
          return fail("他のロボットと干渉するため移動できません。手で置き直してください");
        }
      }
    }
    if (now - bot.position.startedAt! > POSITION_TIMEOUT_MS) return fail("時間内に着けませんでした。手で置き直してください");
    if (this.stuckTwice(bot, c.drive, at, now)) return fail("進めません。手で置き直してください");
    this.drive(bot, c.drive);
  }

  // ---- running ----

  private refLostSince: number | null = null;

  private stepRun(now: number, dt: number): void {
    const plan = this.plan!, input = this.input!;
    const t = this.clock;
    const loc = input.poses.localizer;
    if (!loc.connected || !loc.running || loc.frameAgeMs === null || loc.frameAgeMs > STALE_FRAME_MS) return this.stopAndHalt("localizer", "測位が途切れました");
    if (loc.referenceCount < 3 || !loc.extrinsicsOk) {
      if (this.bots.some((b) => b.motion !== null)) {
        this.refLostSince ??= now;
        this.stopAll(false);
        if (now - this.refLostSince < 1200) return;
      }
      return this.stopAndHalt("references", "基準マーカーが3枚未満です");
    }
    this.refLostSince = null;
    for (const bot of this.bots) if (bot.pose && !input.online(bot.pose.deviceId)) return this.stopAndHalt("device", `${bot.track.name} の駆動デバイスが切断されました`);

    this.negotiate(now);
    if (this.phase === "halted") return;
    let lostCap = false;
    const field = input.poses.field;

    for (const bot of this.bots) {
      const at = this.tracked(bot);
      if (!at) {
        this.drive(bot, STOP);
        if (!this.lostSince.has(bot)) this.lostSince.set(bot, now);
        // 安全強化：前回位置が外周150mm付近だった場合は、視野外飛び出しを防ぐため猶予なしで即座に見失い停止とする
        const prev = this.lastKnown.get(bot);
        const nearEdge = prev && field && (
          prev.x < 150 || prev.x > field.widthMm - 150 ||
          prev.y < 150 || prev.y > field.heightMm - 150
        );
        const graceMs = nearEdge ? 350 : 800;
        if (bot.motion !== null && now - this.lostSince.get(bot)! < graceMs) {
          continue;
        }
        if (!bot.lost) {
          const last = bot.pose?.xMm !== undefined ? { x: bot.pose.xMm, y: bot.pose.yMm ?? 0 } : { x: bot.track.initial!.x, y: bot.track.initial!.y };
          bot.lost = this.lastKnown.get(bot) ?? last;
          this.note("error", `${bot.track.name} を見失いました（最後の位置 (${Math.round(bot.lost.x)}, ${Math.round(bot.lost.y)})）`);
        }
        bot.status = "lost";
        lostCap = true;
        continue;
      }
      this.lastKnown.set(bot, { x: at.x, y: at.y });
      if (!bot.lost) this.lostSince.delete(bot);
      if (bot.lost) { bot.lost = null; this.lostSince.delete(bot); this.note("info", `${bot.track.name} が追跡に戻りました`); }
      if (bot.pose?.insideField === false) return this.stopAndHalt("outside", `${bot.track.name} が領域の外に出ました`);
      const yielding = this.stepYielder(bot, at, now);
      if (yielding === "halt") return this.stopAndHalt("stuck", `${bot.track.name} が退避中に進めません（1回再試行しました）`);
      if (yielding === "handled") continue;
      const entry = bot.moves.find((e) => e.start! <= t + EPS && !bot.arrivals.has(e.action.id)) ?? null;
      bot.goalEntry = entry;
      if (!entry) { bot.status = "arrived"; bot.within = null; bot.posErr = bot.yawErr = null; this.drive(bot, STOP); continue; }
      const rawGoal = entry.to!;
      // 実機の場合は目標点が外周の危険領域にあっても、絶対防衛ライン(75mm)の内側(90mm)に安全クランプする
      const safeTargetMargin = GEOFENCE_SAFE_MARGIN_MM + 15;
      const goalX = bot.motion !== null && field ? Math.max(safeTargetMargin, Math.min(field.widthMm - safeTargetMargin, rawGoal.x)) : rawGoal.x;
      const goalY = bot.motion !== null && field ? Math.max(safeTargetMargin, Math.min(field.heightMm - safeTargetMargin, rawGoal.y)) : rawGoal.y;
      const rawDist = Math.hypot(goalX - at.x, goalY - at.y);
      if (rawDist <= ARRIVE_POS_MM) bot.aligningYaw = true;
      else if (rawDist > 42) bot.aligningYaw = false;
      const rotate = entry.action.motion === "rotate" || (bot.motion !== null && bot.aligningYaw);
      const c = control(
        at,
        { x: goalX, y: goalY, yaw: rawGoal.yaw, rotate, speedMmS: plannedSpeed(entry) },
        bot.motion,
        this.buildRuntimeContext(bot)
      );
      bot.posErr = entry.action.motion === "rotate" ? 0 : rawDist;
      bot.yawErr = Math.abs(c.yawErrDeg);
      if (this.arrived(bot, c.posErrMm, c.yawErrDeg, now)) {
        const reportedPosErr = entry.action.motion === "rotate" ? 0 : rawDist;
        bot.aligningYaw = false;
        bot.stuck = null;
        bot.consecutiveLinearSteps = 0;
        bot.arrivals.set(entry.action.id, { at: t, posErrMm: reportedPosErr, yawErrDeg: Math.abs(c.yawErrDeg) });
        this.note("info", `${bot.track.name} ${entry.action.name} 到着確認（位置 ${reportedPosErr.toFixed(1)}mm / 向き ${Math.abs(c.yawErrDeg).toFixed(1)}°）`);
        bot.status = "arrived";
        this.drive(bot, STOP, true);
        continue;
      }
      if ((c.drive.cmd === "a" || c.drive.cmd === "b") && this.blocked(at, { x: goalX, y: goalY })) {
        bot.status = "waiting";
        bot.stuck = null;
        this.drive(bot, STOP);
        continue;
      }
      if (c.phase === "geofenceBrake") {
        // 目標まで38mm以内で安全境界に阻まれた場合は、これ以上外周へ押し出さず向き合わせへ移行してデッドロックを防ぐ
        if (rawDist <= 38) {
          bot.aligningYaw = true;
          this.drive(bot, STOP, true);
          continue;
        }
        const warnText = `${bot.track.name} が安全境界（外周${GEOFENCE_SAFE_MARGIN_MM}mm）に接近したため予測ブレーキで保護停止しました`;
        const lastLog = this.log.at(-1);
        if (!lastLog || lastLog.text !== warnText || now - lastLog.at >= 3000) {
          this.note("warn", warnText);
        }
        this.drive(bot, STOP, true);
        continue;
      }
      if (this.stuckTwice(bot, c.drive, at, now)) return this.stopAndHalt("stuck", `${bot.track.name} が進めません（1回再試行しました）`);
      bot.status = t >= entry.end! - EPS ? "waiting" : "driving";
      this.drive(bot, c.drive);
    }

    const all = this.bots.flatMap((b) => b.moves.map((e) => ({ b, e })));
    const blocking = all.filter(({ b, e }) => e.end! <= t + EPS && !b.arrivals.has(e.action.id));
    const nextEnd = all.filter(({ b, e }) => e.end! > t + EPS && !b.arrivals.has(e.action.id)).reduce((m, { e }) => Math.min(m, e.end!), Infinity);
    if (lostCap) {
      // D12: the others run on to the next bar end, then everything stops.
      this.syncPoint ??= all.filter(({ e }) => e.end! > t + EPS).reduce((m, { e }) => Math.min(m, e.end!), t);
      if (t >= this.syncPoint - EPS) return this.stopAndHalt("lost", this.lostText());
    } else this.syncPoint = null;
    if (blocking.length > 0 || this.evasions.length > 0) {
      if (this.phase !== "waiting") { this.phase = "waiting"; this.waitingSince = now; this.deps.onClock?.(t, false); }
      this.waitedMs += dt;
      for (const { b, e } of blocking) b.waited.set(e.action.id, (b.waited.get(e.action.id) ?? 0) + dt / 1000);
      if (now - (this.waitingSince ?? now) > this.waitTimeoutMs) this.stopAndHalt("timeout", "到着待ちの時間切れ");
      return;
    }
    if (this.phase === "waiting") { this.phase = "running"; this.waitingSince = null; this.deps.onClock?.(t, true); }
    if (t >= plan.duration - EPS && all.every(({ b, e }) => b.arrivals.has(e.action.id))) return this.finish();
    // The clock never runs past the end of a bar whose robot has not arrived yet (D2, D3).
    this.clock = Math.min(t + dt / 1000, nextEnd, this.syncPoint ?? Infinity, plan.duration);
  }

  private syncPoint: number | null = null;

  private lastKnown = new Map<Bot, { x: number; y: number }>();

  private evasions: Evasion[] = [];
  private cooldown = new Map<string, number>();

  // ---- traffic (D14, D15) ----

  private moverOf(bot: Bot): Mover | null {
    const at = this.tracked(bot);
    if (!at) return null;
    const evasion = this.evasions.find((e) => e.yielder === bot);
    const entry = bot.goalEntry;
    let goal: { x: number; y: number } | null = null;
    let speed = entry ? plannedSpeed(entry) : 0;
    if (evasion) {
      goal = evasion.stage === "going" ? evasion.spot : evasion.stage === "returning" ? evasion.origin : null;
      speed = POSITION_SPEED_MMS;
    } else if (entry && entry.action.motion !== "rotate" && !bot.aligningYaw && !bot.arrivals.has(entry.action.id) && bot.status !== "arrived") goal = { x: entry.to!.x, y: entry.to!.y };
    return {
      id: bot.track.id, x: at.x, y: at.y, goal, speedMmS: Math.min(speed, bot.motion?.speedMmS ?? DRIVE_LIMITS.maxSpeedMmS),
      barEnd: entry?.end ?? Infinity, priority: bot.priority, markerId: bot.pose?.markerId ?? 99
    };
  }

  // Robots that are not in the scene, and a robot that was lost, stand still where they were seen.
  private obstacles(): { x: number; y: number }[] {
    const inScene = new Set(this.bots.map((b) => b.resolvedRobotId).filter((id): id is string => !!id));
    const outsiders = this.input!.poses.poses.filter((p) => p.tracking === "tracking" && !inScene.has(p.robotId) && p.xMm !== undefined && p.yMm !== undefined)
      .map((p) => ({ x: p.xMm!, y: p.yMm! }));
    return [...outsiders, ...this.bots.flatMap((b) => (b.lost ? [b.lost] : []))];
  }

  private negotiate(now: number): void {
    const movers = new Map<Bot, Mover>();
    for (const bot of this.bots) { const m = this.moverOf(bot); if (m) movers.set(bot, m); }
    const mover = (bot: Bot) => movers.get(bot)!;
    for (const e of [...this.evasions]) {
      const priorityStopped = e.priority.status === "arrived" || (movers.has(e.priority) && !mover(e.priority).goal);
      if (e.yielder.motion !== null && priorityStopped) {
        this.evasions = this.evasions.filter((x) => x !== e);
        this.cooldown.set([e.yielder.track.id, e.priority.track.id].sort().join("|"), now + EVADE_COOLDOWN_MS);
        e.yielder.within = null;
        e.yielder.status = "driving";
        this.note("info", `${e.priority.track.name} が到着したため、${e.yielder.track.name} は本来の経路へ復帰します`);
        continue;
      }
      if (e.stage === "waiting" && movers.has(e.priority) && movers.has(e.yielder) && hasPassed(mover(e.priority), mover(e.yielder))) {
        if (e.yielder.motion !== null) {
          this.evasions = this.evasions.filter((x) => x !== e);
          this.cooldown.set([e.yielder.track.id, e.priority.track.id].sort().join("|"), now + EVADE_COOLDOWN_MS);
          e.yielder.within = null;
          e.yielder.status = "driving";
          this.note("info", `${e.priority.track.name} が通過しました。${e.yielder.track.name} は本来の経路へ復帰します`);
        } else {
          e.stage = "returning";
          e.yielder.within = null;
          this.note("info", `${e.priority.track.name} が通過しました。${e.yielder.track.name} は元の位置へ戻ります`);
        }
      }
    }
    const busy = new Set(this.evasions.flatMap((e) => [e.yielder, e.priority]));
    const list = this.bots.filter((b) => movers.has(b));
    const byId = new Map(list.map((b) => [b.track.id, b]));
    const fixed = this.obstacles();
    for (const [a, b] of findConflicts(list.map((bot) => mover(bot)))) {
      const botA = byId.get(a.id)!, botB = byId.get(b.id)!;
      const key = [a.id, b.id].sort().join("|");
      if (busy.has(botA) || busy.has(botB) || (this.cooldown.get(key) ?? 0) > now) continue;
      if ((botA.motion !== null || botB.motion !== null) && (!a.goal || !b.goal)) {
        const moverBot = a.goal ? a : b;
        const stillBot = a.goal ? b : a;
        const g = moverBot.goal!;
        const dx = g.x - moverBot.x, dy = g.y - moverBot.y, len2 = dx * dx + dy * dy;
        const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((stillBot.x - moverBot.x) * dx + (stillBot.y - moverBot.y) * dy) / len2));
        const closestDist = Math.hypot(stillBot.x - (moverBot.x + dx * u), stillBot.y - (moverBot.y + dy * u));
        if (closestDist >= 115) continue;
      }
      const others = (self: Mover, other: Mover) => [...fixed, ...list.map((x) => mover(x)).filter((m) => m !== self && m !== other)];
      const spotA = findEvasion(this.safety!, a, b, others(a, b)), spotB = findEvasion(this.safety!, b, a, others(b, a));
      const decision = decide(a, b, !!spotA, !!spotB);
      if (!decision) return this.stopAndHalt("blocked", `${botA.track.name} と ${botB.track.name} が接近しますが、退避できる場所がありません`);
      const yielder = byId.get(decision.yielder.id)!, priority = byId.get(decision.priority.id)!;
      const spot = (decision.yielder === a ? spotA : spotB)!;
      const reason = { room: `${yielder.track.name} に退避できる場所がある`, earlier: `${priority.track.name} のバーの終了が早い`, fixed: "固定の優先順位" }[decision.why];
      this.evasions.push({ yielder, priority, origin: { x: decision.yielder.x, y: decision.yielder.y }, spot, stage: "going", why: reason });
      busy.add(yielder).add(priority);
      yielder.within = null;
      yielder.stuck = null;
      this.note("info", `退避: ${yielder.track.name} が ${priority.track.name} に道を譲ります（理由: ${reason}）`);
    }
  }

  // The yielder's own move while it steps out and back. True when it handled the robot this tick.
  private stepYielder(bot: Bot, at: { x: number; y: number; yaw: number }, now: number): "handled" | "halt" | null {
    const evasion = this.evasions.find((e) => e.yielder === bot);
    if (!evasion) return null;
    bot.status = "evading";
    if (evasion.stage === "waiting") { this.drive(bot, STOP); return "handled"; }
    const target = evasion.stage === "going" ? evasion.spot : evasion.origin;
    const c = control(
      at,
      { x: target.x, y: target.y, yaw: at.yaw, rotate: false, speedMmS: POSITION_SPEED_MMS },
      bot.motion,
      this.buildRuntimeContext(bot)
    );
    bot.posErr = c.posErrMm;
    bot.yawErr = null;
    if (this.arrived(bot, c.posErrMm, 0, now)) {
      this.drive(bot, STOP, true);
      bot.within = null;
      if (evasion.stage === "going") evasion.stage = "waiting";
      else {
        this.evasions = this.evasions.filter((e) => e !== evasion);
        this.cooldown.set([evasion.yielder.track.id, evasion.priority.track.id].sort().join("|"), now + EVADE_COOLDOWN_MS);
        this.note("info", `${bot.track.name} が元の位置に戻りました`);
        bot.status = "driving";
      }
      return "handled";
    }
    if (this.stuckTwice(bot, c.drive, at, now)) return "halt";
    this.drive(bot, c.drive);
    return "handled";
  }

  // A robot never drives into a stopped robot it cannot see past: it stops and the run waits (D12).
  private blocked(at: { x: number; y: number }, goal: { x: number; y: number }): boolean {
    const total = distance(at, goal);
    if (total === 0) return false;
    const ahead = { x: at.x + (goal.x - at.x) / total * Math.min(total, CONFLICT_MM), y: at.y + (goal.y - at.y) / total * Math.min(total, CONFLICT_MM) };
    return this.obstacles().some((o) => distance(ahead, o) < CONFLICT_MM && distance(at, o) > distance(ahead, o));
  }

  private evasionNote(bot: Bot): string {
    const yielding = this.evasions.find((e) => e.yielder === bot);
    if (yielding) {
      const where = yielding.stage === "returning" ? "元の位置へ戻っています" : yielding.stage === "going" ? "離脱点へ移動中" : "通過を待っています";
      return `${yielding.priority.track.name} に道を譲り、${where}`;
    }
    const priority = this.evasions.find((e) => e.priority === bot);
    return priority ? `${priority.yielder.track.name} が道を譲っています` : "";
  }

  private evasionViews(): RunEvasion[] {
    return this.evasions.flatMap((e) => {
      const p = this.moverOf(e.priority);
      if (!p) return [];
      return [{
        yielder: e.yielder.track.name, priority: e.priority.track.name, reason: e.why, stage: e.stage, spot: e.spot,
        band: { from: { x: p.x, y: p.y }, to: p.goal ?? { x: p.x, y: p.y }, halfWidthMm: BAND_HALF_MM }
      }];
    });
  }

  private lostText(): string {
    return `${this.bots.filter((b) => b.lost).map((b) => b.track.name).join("、")} を見失いました`;
  }

  private finish(): void {
    this.stopAll(true);
    this.endedAt = this.deps.now();
    this.phase = "finished";
    this.evasions = [];
    this.note("info", "最後まで実行しました");
    this.deps.onClock?.(this.clock, false);
  }

  private stopAndHalt(kind: HaltKind, text: string): void {
    this.stopAll(true);
    this.enterHalt(kind, text);
  }

  private enterHalt(kind: HaltKind, text: string): void {
    this.phase = "halted";
    this.halt = { kind, since: this.deps.now(), okSince: null };
    this.haltText = text;
    this.waitingSince = null;
    this.note(kind === "operator" ? "warn" : "error", `全台停止: ${text}`);
    this.deps.onClock?.(this.clock, false);
  }

  private leaveHalt(): void {
    this.phase = "running";
    this.halt = null;
    this.syncPoint = null;
    if (this.bots.some((b) => b.motion !== null)) this.evasions = [];
    for (const bot of this.bots) {
      bot.within = null; bot.stuck = null; bot.lost = null; bot.consecutiveLinearSteps = 0;
      bot.aligningYaw = false; bot.stallBoostPwm = 0; bot.spinStartedAt = null; bot.spinPauseUntil = null;
      bot.drivePulseStartedAt = null; bot.drivePauseUntil = null; bot.pauseWaitFreshAfter = null;
      bot.contCheck = null; bot.lastMotionKind = null; bot.pendingObservation = null;
    }
    this.note("info", "再開");
    this.deps.onClock?.(this.clock, true);
  }

  private stepHalted(now: number): void {
    this.stopAll(false);
    const h = this.halt!;
    const ok = this.resumeConditions().every((c) => c.ok);
    if ((h.kind === "lost" || h.kind === "references" || h.kind === "localizer") && ok) {
      h.okSince ??= now;
      if (now - h.okSince >= RESUME_HOLD_MS) { this.note("info", "条件が揃ったため自動で再開します"); this.leaveHalt(); }
    } else h.okSince = null;
  }

  // Why the run can or cannot continue after a stop (W4).
  private resumeConditions(): RunCondition[] {
    const input = this.input;
    if (!input || !this.halt || this.halt.kind === "operator") return [];
    const loc = input.poses.localizer;
    const tracking = this.bots.filter((b) => this.tracked(b));
    const conditions: RunCondition[] = [
      { label: "測位が動作中", ok: loc.connected && loc.running, detail: loc.connected && loc.running ? "動作中" : "未接続" },
      { label: "対象の全台が追跡中", ok: tracking.length === this.bots.length, detail: `${tracking.length}/${this.bots.length}` },
      { label: "基準マーカーが3枚以上", ok: loc.referenceCount >= 3 && loc.extrinsicsOk, detail: `${loc.referenceCount}/4` },
    ];
    if (this.halt.kind === "lost") {
      const now = this.deps.now();
      for (const bot of this.bots) {
        const last = this.lastKnown.get(bot), at = this.tracked(bot);
        if (!bot.lost || !last) continue;
        const since = this.lostSince.get(bot) ?? this.halt.since;
        const sec = Math.max(0, (now - since) / 1000).toFixed(1);
        conditions.push({ label: `${bot.track.name} が追跡中に戻った`, ok: at !== null, detail: at ? "追跡中" : `見失い ${sec}秒` });
        const d = at ? Math.hypot(at.x - last.x, at.y - last.y) : null;
        const allowedRadius = bot.motion ? 300 : RESUME_RADIUS_MM;
        conditions.push({ label: `${bot.track.name} が停止前の位置の${RESUME_RADIUS_MM}mm以内`, ok: d !== null && d <= allowedRadius, detail: d === null ? "未検出" : `${Math.round(d)}mm` });
      }
    }
    return conditions;
  }

  private alerts(): string[] {
    if (this.phase !== "running" && this.phase !== "waiting") return [];
    return this.bots.filter((b) => b.lost).map((b) => `${b.track.name} を見失い中: 次の同期点で全台停止します`);
  }

  private initialMismatches(): InitialMismatch[] {
    if (this.phase !== "arming") return [];
    const out: InitialMismatch[] = [];
    for (const bot of this.bots) {
      const { posMm, yawDeg } = this.initialLimits(bot);
      const posOk = bot.posErr !== null && bot.posErr <= posMm;
      const yawOk = bot.yawErr !== null && bot.yawErr <= yawDeg;
      if (!posOk || !yawOk) {
        out.push({ trackId: bot.track.id, name: bot.track.name, posErrMm: bot.posErr, yawErrDeg: bot.yawErr, posOk, yawOk });
      }
    }
    return out;
  }

  private excludedViews(): RunRobot[] {
    const input = this.input;
    if (!input) return [];
    const inScene = new Set(this.bots.map((b) => b.resolvedRobotId).filter((id): id is string => !!id));
    return input.poses.poses
      .filter((p) => p.tracking === "tracking" && !inScene.has(p.robotId))
      .map((p): RunRobot => {
        const def = input.robots.find((r) => r.robotId === p.robotId);
        return {
          trackId: `excluded-${p.robotId}`,
          name: p.robotId,
          robotId: p.robotId,
          markerId: p.markerId,
          priority: def?.priority ?? null,
          tracking: p.tracking,
          status: "excluded",
          bar: null,
          barStart: null,
          barEnd: null,
          posErrMm: null,
          yawErrDeg: null,
          settledSec: 0,
          pose: p.xMm !== undefined && p.yMm !== undefined && p.headingDeg !== undefined
            ? { x: p.xMm, y: p.yMm, yaw: p.headingDeg } : null,
          target: null,
          note: "シーンに入っていません。動かない障害物として扱います",
        };
      });
  }

  // ---- shared ----

  private arrived(bot: Bot, posErr: number, yawErr: number, now: number): boolean {
    if (bot.motion !== null) {
      // 実機は駆動・旋回パルスの途中や惰性整定前（停止後の新フレーム到着前）には到着確定しない
      const poseCapturedAt = bot.pose?.ageMs !== undefined ? now - bot.pose.ageMs : now;
      const waitingForFreshFrame =
        bot.pauseWaitFreshAfter !== null &&
        poseCapturedAt < bot.pauseWaitFreshAfter &&
        now < bot.pauseWaitFreshAfter + 1100;
      const settling =
        !!bot.lastDrive?.continuous ||
        bot.spinStartedAt !== null ||
        bot.drivePulseStartedAt !== null ||
        (bot.spinPauseUntil !== null && now < bot.spinPauseUntil) ||
        (bot.drivePauseUntil !== null && now < bot.drivePauseUntil) ||
        waitingForFreshFrame;
      if (settling) {
        bot.within = null;
        return false;
      }
      if (posErr <= ARRIVE_POS_MM && Math.abs(yawErr) <= 22) {
        return true;
      }
      bot.within = null;
      return false;
    }
    if (posErr <= ARRIVE_POS_MM && Math.abs(yawErr) <= ARRIVE_YAW_DEG) {
      bot.within ??= now;
      return now - bot.within >= ARRIVE_HOLD_MS;
    }
    bot.within = null;
    return false;
  }

  // First stuck: log and try again. Second: report it.
  private stuckTwice(bot: Bot, drive: Drive, at: { x: number; y: number; yaw?: number }, now: number): boolean {
    if (drive.cmd === "e") { bot.stuck = null; return false; }
    const isTurnCmd = drive.cmd === "c" || drive.cmd === "d";
    const isNearOrTurn = isTurnCmd || (bot.posErr !== null && bot.posErr <= 40);
    const windowMs = isNearOrTurn ? Math.round(STUCK_WINDOW_MS * 1.5) : STUCK_WINDOW_MS;
    const curYaw = at.yaw ?? 0;
    if (!bot.stuck) { bot.stuck = { at: now, x: at.x, y: at.y, yaw: curYaw, retried: false }; return false; }
    if (now - bot.stuck.at < windowMs) return false;
    const moved = Math.hypot(at.x - bot.stuck.x, at.y - bot.stuck.y);
    const turned = Math.abs(shortestTurn(bot.stuck.yaw, curYaw));
    const progressed = isTurnCmd ? turned >= 4 : moved >= (isNearOrTurn ? 3 : STUCK_MIN_MM);
    if (progressed) { bot.stuck = { at: now, x: at.x, y: at.y, yaw: curYaw, retried: bot.stuck.retried }; return false; }
    if (bot.stuck.retried) return true;
    this.note("warn", `${bot.track.name} が進みません。1回だけやり直します`);
    // スタック再試行時は速度スケール調整＋スタックブーストを効かせる
    bot.dynamicSpeedScale = Math.max(0.7, bot.dynamicSpeedScale - 0.15);
    bot.stallBoostPwm = Math.min(60, bot.stallBoostPwm + 20);
    bot.stuck = { at: now, x: at.x, y: at.y, yaw: curYaw, retried: true };
    return false;
  }

  private reason(): string {
    switch (this.phase) {
      case "idle": return "シーンを選んでください。";
      case "arming": return this.positioning.active ? "初期位置へ移動中" : this.checks.every((c) => c.ok || c.warn) && this.checks.length ? "開始できます" : "実行前の確認が終わっていません";
      case "running": return "進行時計が進んでいます";
      case "waiting": {
        if (this.evasions.length) return this.evasions.map((e) => `${e.yielder.track.name} が ${e.priority.track.name} に道を譲っています`).join(" / ");
        const late = this.bots.flatMap((b) => b.moves.filter((e) => e.end! <= this.clock + EPS && !b.arrivals.has(e.action.id)).map(() => b.track.name));
        return `全台が待っています: ${Array.from(new Set(late)).join("、")} が到着判定を満たすまで`;
      }
      case "halted": return `全台停止: ${this.haltText}`;
      case "finished": return "最後まで実行しました";
      case "aborted": return "中止しました（全台停止済み）";
    }
  }

  private robotView(bot: Bot): RunRobot {
    const at = this.tracked(bot);
    const entry = bot.goalEntry;
    const goal = this.phase === "arming" ? bot.track.initial! : entry?.to ?? null;
    const failed = bot.position.state === "failed";
    return {
      trackId: bot.track.id, name: bot.track.name, robotId: bot.resolvedRobotId, markerId: bot.pose?.markerId ?? null, priority: bot.priority,
      tracking: bot.pose?.tracking ?? "unassigned", status: failed ? "failed" : bot.status,
      bar: this.phase === "arming" ? null : entry?.action.name ?? null, barStart: entry?.start ?? null, barEnd: entry?.end ?? null,
      posErrMm: bot.posErr, yawErrDeg: bot.yawErr,
      settledSec: bot.within === null ? 0 : Math.min(ARRIVE_HOLD_MS, this.deps.now() - bot.within) / 1000,
      pose: at, target: goal ? { x: goal.x, y: goal.y, yaw: goal.yaw } : null,
      note: bot.lost ? "最後の位置を障害物として扱っています" : failed ? bot.position.detail : this.evasionNote(bot),
    };
  }

  private rows(live = false): RunResultRow[] {
    const activePhase = this.phase === "running" || this.phase === "waiting" || this.phase === "halted";
    return this.bots.flatMap((bot) => bot.moves.map((e): RunResultRow => {
      const a = bot.arrivals.get(e.action.id);
      let status: RunResultRow["status"] = "pending";
      if (a) status = "arrived";
      else if (this.phase === "aborted" || this.phase === "finished") status = "failed";
      else if (live && activePhase && e.end! <= this.clock + EPS) status = "waiting";
      else if (live && activePhase && e.start! <= this.clock + EPS) status = "running";
      return {
        trackId: bot.track.id, robot: bot.track.name, action: e.action.name, planStart: e.start!, planEnd: e.end!,
        arrivedAt: a?.at ?? null, posErrMm: a?.posErrMm ?? null, yawErrDeg: a?.yawErrDeg ?? null, waitedSec: bot.waited.get(e.action.id) ?? 0,
        status,
        note: a ? "" : this.phase === "aborted" ? "実行前に中止しました" : "",
      };
    }));
  }
}
