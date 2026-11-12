import { compilePlan, type PlanEntry, type ScenePlan } from "../scene/timedPlan";
import { createSafety, pathProblem, type Safety } from "../scene/safety";
import type { SceneMap, Track } from "../scene/types";
import { shortestTurn } from "../scene/units";
import {
  idleSnapshot, type HaltKind, type PositionState, type RobotRunStatus, type RunCheck, type RunCondition, type RunLogEntry,
  type RunResultFile, type RunResultRow, type RunRobot, type RunSnapshot,
} from "../scene/runTypes";
import { control, STOP, type Drive } from "./motionController";
import type { PoseStateMessage, RobotDefinition, RobotPoseState } from "./protocol";
import { BAND_HALF_MM, CONFLICT_MM, decide, distance, findConflicts, findEvasion, hasPassed, type Mover } from "./trafficManager";
import { DRIVE_LIMITS } from "./motionController";
import type { RunEvasion } from "../scene/runTypes";

// D7: arrival is judged on position, heading and a short hold.
export const ARRIVE_POS_MM = 20;
export const ARRIVE_YAW_DEG = 5;
export const ARRIVE_HOLD_MS = 300;
const RESEND_MS = 400;
const WAIT_TIMEOUT_MS = 30_000;
const STUCK_WINDOW_MS = 2000;
const STUCK_MIN_MM = 10;
const RESUME_RADIUS_MM = 60;
const RESUME_HOLD_MS = 1000;
const STALE_FRAME_MS = 1500;
const POSITION_TIMEOUT_MS = 40_000;
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

interface Bot {
  track: Track;
  moves: PlanEntry[];
  arrivals: Map<string, Arrival>;
  waited: Map<string, number>;
  within: number | null;
  stuck: { at: number; x: number; y: number; retried: boolean } | null;
  lost: { x: number; y: number } | null;
  lastDrive: Drive | null;
  lastSentAt: number;
  position: { state: PositionState; detail: string; startedAt: number | null };
  status: RobotRunStatus;
  posErr: number | null;
  yawErr: number | null;
  pose: RobotPoseState | null;
  priority: number | null;
  goalEntry: PlanEntry | null;
}

const sameDrive = (a: Drive | null, b: Drive) => !!a && a.cmd === b.cmd && a.speedL === b.speedL && a.speedR === b.speedR;
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
  private positioning = { active: false };
  private checks: RunCheck[] = [];
  private log: RunLogEntry[] = [];
  private input: RunnerInput | null = null;

  constructor(private deps: RunnerDeps, private options: { waitTimeoutMs?: number } = {}) {}

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
    this.bots = map.tracks.filter((t) => t.kind === "robot" && !t.muted && t.initial).map((track) => ({
      track, arrivals: new Map(), waited: new Map(), within: null, stuck: null, lost: null, lastDrive: null, lastSentAt: 0,
      position: { state: "waiting", detail: "", startedAt: null }, status: "idle", posErr: null, yawErr: null, pose: null, priority: null, goalEntry: null,
      moves: this.plan!.entries.filter((e) => e.track === track && e.action.type === "move" && !e.blocked && e.outcome === "success" && e.start !== null)
        .sort((a, b) => a.start! - b.start!),
    }));
    this.phase = "arming";
    this.clock = 0;
    this.startedAt = this.endedAt = null;
    this.waitedMs = 0;
    this.waitingSince = null;
    this.halt = null;
    this.positioning = { active: false };
    this.log = [];
    this.evasions = [];
    this.cooldown.clear();
    this.lastTick = this.deps.now();
    return null;
  }

  reset(): string | null {
    return this.map && !this.active ? this.prepare(this.map) : "実行中はやり直せません。";
  }

  position(): string | null {
    if (this.phase !== "arming") return "実行前の確認中だけ初期位置へ動かせます。";
    this.positioning = { active: true };
    for (const bot of this.bots) bot.position = { state: "waiting", detail: "", startedAt: null };
    this.note("info", "初期位置への移動を始めました。");
    return null;
  }

  start(): string | null {
    if (this.phase !== "arming") return "実行前の確認中だけ開始できます。";
    this.evalChecks();
    if (!this.checks.every((c) => c.ok || c.warn)) return "実行前の確認に満たない項目があります。";
    this.positioning = { active: false };
    this.phase = "running";
    this.clock = 0;
    this.startedAt = this.deps.now();
    this.note("info", "開始");
    this.deps.onClock?.(0, true);
    return null;
  }

  pause(): string | null {
    if (this.phase === "arming" && this.positioning.active) {
      this.positioning = { active: false };
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
    this.positioning = { active: false };
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
    return {
      phase: this.phase, mapId: this.map.id, mapName: this.map.name, reason: this.reason(),
      halt: this.halt ? { kind: this.halt.kind, since: this.halt.since } : null,
      resume: this.phase === "halted" ? this.resumeConditions() : [],
      clock: this.clock, duration: this.plan?.duration ?? 0, realMs: this.startedAt === null ? 0 : end - this.startedAt, waitedMs: this.waitedMs,
      checks: this.checks, canStart: this.phase === "arming" && this.checks.length > 0 && this.checks.every((c) => c.ok || c.warn),
      positioning: { active: this.positioning.active, items: this.bots
        .map((b) => ({ trackId: b.track.id, name: b.track.name, state: b.position.state, detail: b.position.detail })) },
      robots: this.bots.map((b) => this.robotView(b)), evasions: this.evasionViews(), log: this.log, rows: this.rows(),
    };
  }

  result(): RunResultFile {
    const end = this.endedAt ?? this.deps.now();
    return {
      schema: "scene-run-result/v1", mapId: this.map?.id ?? null, mapName: this.map?.name ?? "",
      outcome: this.phase === "finished" ? "finished" : "aborted", startedAt: this.startedAt, endedAt: this.endedAt,
      realSeconds: this.startedAt === null ? 0 : (end - this.startedAt) / 1000, planSeconds: this.plan?.duration ?? 0,
      waitedSeconds: this.waitedMs / 1000, rows: this.rows(), log: this.log,
    };
  }

  private bindPoses(input: RunnerInput): void {
    for (const bot of this.bots) {
      bot.pose = input.poses.poses.find((p) => p.robotId === bot.track.robotId) ?? null;
      bot.priority = input.robots.find((r) => r.robotId === bot.track.robotId)?.priority ?? null;
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

  private drive(bot: Bot, drive: Drive, force = false): void {
    const deviceId = bot.pose?.deviceId;
    if (!deviceId) return;
    const now = this.deps.now();
    if (!force && sameDrive(bot.lastDrive, drive) && now - bot.lastSentAt < RESEND_MS) return;
    bot.lastDrive = drive;
    bot.lastSentAt = now;
    this.deps.sendDrive(deviceId, drive);
  }

  private stopAll(force: boolean): void {
    for (const bot of this.bots) this.drive(bot, STOP, force);
  }

  // ---- arming ----

  private evalChecks(): void {
    const input = this.input;
    if (!input || !this.plan) return;
    const loc = input.poses.localizer;
    const total = this.bots.length;
    const count = (pred: (b: Bot) => boolean) => this.bots.filter(pred).length;
    const inScene = new Set(this.bots.map((b) => b.track.robotId));
    const outsiders = input.poses.poses.filter((p) => p.tracking === "tracking" && !inScene.has(p.robotId));
    const atInitial = (b: Bot) => {
      const at = this.tracked(b);
      const init = b.track.initial!;
      if (!at) return false;
      b.posErr = Math.hypot(init.x - at.x, init.y - at.y);
      b.yawErr = Math.abs(shortestTurn(at.yaw, init.yaw));
      return b.posErr <= ARRIVE_POS_MM && b.yawErr <= ARRIVE_YAW_DEG;
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
      check("initial", "全ロボットが初期位置にいる（位置20mm・向き5°）", total > 0 && count(atInitial) === total, `${count(atInitial)}/${total}`),
      check("plan", "計画にエラーがない", this.plan.errors.length === 0, this.plan.errors.length ? `${this.plan.errors.length}件: ${this.plan.errors[0]}` : "なし"),
      ...(outsiders.length ? [check("outsiders", "シーンに入っていないロボットが盤面にいます（動かない障害物として扱います）", false,
        outsiders.map((p) => p.robotId).join("、"), true)] : []),
    ];
  }

  private stepPositioning(now: number): void {
    const items = this.bots;
    const todo = items.filter((b) => b.position.state !== "arrived" && b.position.state !== "failed")
      .sort((a, b) => (a.pose?.markerId ?? 99) - (b.pose?.markerId ?? 99));
    for (const bot of items) if (!todo.includes(bot)) this.drive(bot, STOP);
    const bot = todo[0];
    for (const other of todo.slice(1)) this.drive(other, STOP);
    if (!bot) {
      this.positioning = { active: false };
      this.note("info", items.some((b) => b.position.state === "failed") ? "初期位置への移動を終えました（動かせない機体があります）" : "全ロボットが初期位置に着きました");
      return;
    }
    const at = this.tracked(bot);
    const init = bot.track.initial!;
    const fail = (detail: string) => { bot.position = { state: "failed", detail, startedAt: null }; this.drive(bot, STOP, true); this.note("warn", `${bot.track.name}: ${detail}`); };
    if (!at) return fail("追跡できません。手で初期位置へ置いてください");
    if (bot.position.startedAt === null) {
      const problem = pathProblem(this.safety!, at, init, "robot");
      if (problem) return fail(`直線で動かせません（${problem}）。手で置き直してください`);
      bot.position = { state: "moving", detail: "", startedAt: now };
      bot.within = null;
      bot.stuck = null;
    }
    const c = control(at, { x: init.x, y: init.y, yaw: init.yaw, rotate: false, speedMmS: POSITION_SPEED_MMS });
    bot.posErr = c.posErrMm;
    bot.yawErr = Math.abs(c.yawErrDeg);
    bot.position.detail = `残り ${Math.round(c.posErrMm)}mm`;
    if (this.arrived(bot, c.posErrMm, c.yawErrDeg, now)) {
      bot.position = { state: "arrived", detail: "到着済み", startedAt: null };
      this.drive(bot, STOP, true);
      return;
    }
    if (now - bot.position.startedAt! > POSITION_TIMEOUT_MS) return fail("時間内に着けませんでした。手で置き直してください");
    if (this.stuckTwice(bot, c.drive, at, now)) return fail("進めません。手で置き直してください");
    this.drive(bot, c.drive);
  }

  // ---- running ----

  private stepRun(now: number, dt: number): void {
    const plan = this.plan!, input = this.input!;
    const t = this.clock;
    const loc = input.poses.localizer;
    if (!loc.connected || !loc.running || loc.frameAgeMs === null || loc.frameAgeMs > STALE_FRAME_MS) return this.stopAndHalt("localizer", "測位が途切れました");
    if (loc.referenceCount < 3 || !loc.extrinsicsOk) return this.stopAndHalt("references", "基準マーカーが3枚未満です");
    for (const bot of this.bots) if (bot.pose && !input.online(bot.pose.deviceId)) return this.stopAndHalt("device", `${bot.track.name} の駆動デバイスが切断されました`);

    this.negotiate(now);
    if (this.phase === "halted") return;
    let lostCap = false;
    for (const bot of this.bots) {
      const at = this.tracked(bot);
      if (!at) {
        if (!bot.lost) {
          const last = bot.pose?.xMm !== undefined ? { x: bot.pose.xMm, y: bot.pose.yMm ?? 0 } : { x: bot.track.initial!.x, y: bot.track.initial!.y };
          bot.lost = this.lastKnown.get(bot) ?? last;
          this.note("error", `${bot.track.name} を見失いました（最後の位置 (${Math.round(bot.lost.x)}, ${Math.round(bot.lost.y)})）`);
        }
        bot.status = "lost";
        this.drive(bot, STOP);
        lostCap = true;
        continue;
      }
      this.lastKnown.set(bot, { x: at.x, y: at.y });
      if (bot.lost) { bot.lost = null; this.note("info", `${bot.track.name} が追跡に戻りました`); }
      if (bot.pose?.insideField === false) return this.stopAndHalt("outside", `${bot.track.name} が領域の外に出ました`);
      const yielding = this.stepYielder(bot, at, now);
      if (yielding === "halt") return this.stopAndHalt("stuck", `${bot.track.name} が退避中に進めません（1回再試行しました）`);
      if (yielding === "handled") continue;
      const entry = bot.moves.find((e) => e.start! <= t + EPS && !bot.arrivals.has(e.action.id)) ?? null;
      bot.goalEntry = entry;
      if (!entry) { bot.status = "arrived"; bot.within = null; bot.posErr = bot.yawErr = null; this.drive(bot, STOP); continue; }
      const goal = entry.to!;
      const rotate = entry.action.motion === "rotate";
      const c = control(at, { x: goal.x, y: goal.y, yaw: goal.yaw, rotate, speedMmS: plannedSpeed(entry) });
      bot.posErr = c.posErrMm;
      bot.yawErr = Math.abs(c.yawErrDeg);
      if (this.arrived(bot, c.posErrMm, c.yawErrDeg, now)) {
        bot.arrivals.set(entry.action.id, { at: t, posErrMm: c.posErrMm, yawErrDeg: Math.abs(c.yawErrDeg) });
        this.note("info", `${bot.track.name} ${entry.action.name} 到着確認（位置 ${c.posErrMm.toFixed(1)}mm / 向き ${Math.abs(c.yawErrDeg).toFixed(1)}°）`);
        bot.status = "arrived";
        this.drive(bot, STOP, true);
        continue;
      }
      if (c.drive.cmd === "a" && this.blocked(at, goal)) {
        bot.status = "waiting";
        bot.stuck = null;
        this.drive(bot, STOP);
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
      if (now - (this.waitingSince ?? now) > (this.options.waitTimeoutMs ?? WAIT_TIMEOUT_MS)) this.stopAndHalt("timeout", "到着待ちの時間切れ");
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
    } else if (entry && entry.action.motion !== "rotate" && !bot.arrivals.has(entry.action.id) && bot.status !== "arrived") goal = { x: entry.to!.x, y: entry.to!.y };
    return { id: bot.track.id, x: at.x, y: at.y, goal, speedMmS: Math.min(speed, DRIVE_LIMITS.maxSpeedMmS),
      barEnd: entry?.end ?? Infinity, priority: bot.priority, markerId: bot.pose?.markerId ?? 99 };
  }

  // Robots that are not in the scene, and a robot that was lost, stand still where they were seen.
  private obstacles(): { x: number; y: number }[] {
    const inScene = new Set(this.bots.map((b) => b.track.robotId));
    const outsiders = this.input!.poses.poses.filter((p) => p.tracking === "tracking" && !inScene.has(p.robotId) && p.xMm !== undefined && p.yMm !== undefined)
      .map((p) => ({ x: p.xMm!, y: p.yMm! }));
    return [...outsiders, ...this.bots.flatMap((b) => (b.lost ? [b.lost] : []))];
  }

  private negotiate(now: number): void {
    const movers = new Map<Bot, Mover>();
    for (const bot of this.bots) { const m = this.moverOf(bot); if (m) movers.set(bot, m); }
    const mover = (bot: Bot) => movers.get(bot)!;
    for (const e of this.evasions) {
      if (e.stage === "waiting" && movers.has(e.priority) && movers.has(e.yielder) && hasPassed(mover(e.priority), mover(e.yielder))) {
        e.stage = "returning";
        e.yielder.within = null;
        this.note("info", `${e.priority.track.name} が通過しました。${e.yielder.track.name} は元の位置へ戻ります`);
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
    const c = control(at, { x: target.x, y: target.y, yaw: at.yaw, rotate: false, speedMmS: POSITION_SPEED_MMS });
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
      return [{ yielder: e.yielder.track.name, priority: e.priority.track.name, reason: e.why, stage: e.stage, spot: e.spot,
        band: { from: { x: p.x, y: p.y }, to: p.goal ?? { x: p.x, y: p.y }, halfWidthMm: BAND_HALF_MM } }];
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
    for (const bot of this.bots) { bot.within = null; bot.stuck = null; bot.lost = null; }
    this.note("info", "再開");
    this.deps.onClock?.(this.clock, true);
  }

  private stepHalted(now: number): void {
    this.stopAll(false);
    const h = this.halt!;
    const ok = this.resumeConditions().every((c) => c.ok);
    if (h.kind === "lost" && ok) {
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
      for (const bot of this.bots) {
        const last = this.lastKnown.get(bot), at = this.tracked(bot);
        if (!bot.lost || !last) continue;
        const d = at ? Math.hypot(at.x - last.x, at.y - last.y) : null;
        conditions.push({ label: `${bot.track.name} が停止前の位置の${RESUME_RADIUS_MM}mm以内`, ok: d !== null && d <= RESUME_RADIUS_MM, detail: d === null ? "未検出" : `${Math.round(d)}mm` });
      }
    }
    return conditions;
  }

  // ---- shared ----

  private arrived(bot: Bot, posErr: number, yawErr: number, now: number): boolean {
    if (posErr <= ARRIVE_POS_MM && Math.abs(yawErr) <= ARRIVE_YAW_DEG) {
      bot.within ??= now;
      return now - bot.within >= ARRIVE_HOLD_MS;
    }
    bot.within = null;
    return false;
  }

  // First stuck: log and try again. Second: report it.
  private stuckTwice(bot: Bot, drive: Drive, at: { x: number; y: number }, now: number): boolean {
    if (drive.cmd !== "a") { bot.stuck = null; return false; }
    if (!bot.stuck) { bot.stuck = { at: now, x: at.x, y: at.y, retried: false }; return false; }
    if (now - bot.stuck.at < STUCK_WINDOW_MS) return false;
    const moved = Math.hypot(at.x - bot.stuck.x, at.y - bot.stuck.y);
    if (moved >= STUCK_MIN_MM) { bot.stuck = { at: now, x: at.x, y: at.y, retried: bot.stuck.retried }; return false; }
    if (bot.stuck.retried) return true;
    this.note("warn", `${bot.track.name} が進みません。1回だけやり直します`);
    bot.stuck = { at: now, x: at.x, y: at.y, retried: true };
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
      trackId: bot.track.id, name: bot.track.name, robotId: bot.track.robotId ?? null, markerId: bot.pose?.markerId ?? null, priority: bot.priority,
      tracking: bot.pose?.tracking ?? "unassigned", status: failed ? "failed" : bot.status,
      bar: this.phase === "arming" ? null : entry?.action.name ?? null, barStart: entry?.start ?? null, barEnd: entry?.end ?? null,
      posErrMm: bot.posErr, yawErrDeg: bot.yawErr,
      settledSec: bot.within === null ? 0 : Math.min(ARRIVE_HOLD_MS, this.deps.now() - bot.within) / 1000,
      pose: at, target: goal ? { x: goal.x, y: goal.y, yaw: goal.yaw } : null,
      note: bot.lost ? "最後の位置を障害物として扱っています" : failed ? bot.position.detail : this.evasionNote(bot),
    };
  }

  private rows(): RunResultRow[] {
    return this.bots.flatMap((bot) => bot.moves.map((e): RunResultRow => {
      const a = bot.arrivals.get(e.action.id);
      return {
        trackId: bot.track.id, robot: bot.track.name, action: e.action.name, planStart: e.start!, planEnd: e.end!,
        arrivedAt: a?.at ?? null, posErrMm: a?.posErrMm ?? null, yawErrDeg: a?.yawErrDeg ?? null, waitedSec: bot.waited.get(e.action.id) ?? 0,
        status: a ? "arrived" : this.phase === "aborted" || this.phase === "finished" ? "failed" : "pending",
        note: a ? "" : this.phase === "aborted" ? "実行前に中止しました" : "",
      };
    }));
  }
}
