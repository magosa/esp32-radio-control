import fs from "fs";
import path from "path";
import type { DriveCommand } from "./protocol";

export interface RouteStep {
  cmd: DriveCommand;
  speedL: number;
  speedR: number;
  durationMs: number;
}

export interface VehicleProgram {
  slot: string;
  toRendezvous: RouteStep[];
  rendezvousHoldMs: number;
  toDestination: RouteStep[];
}

export interface RouteDefinition {
  id: string;
  label: string;
  programs: VehicleProgram[];
}

export interface RouteStatus {
  routeId: string;
  running: boolean;
  elapsedMs: number;
  perVehicle: { deviceId: string; stepIndex: number }[];
}

// Next.jsのバンドル環境では __dirname がビルド出力側を指してしまうため、
// プロジェクトルート(process.cwd())基準でルート定義ディレクトリを解決する。
const ROUTES_DIR = path.join(process.cwd(), "fleet", "routes");
// ESP32側フェイルセーフ(1.5秒無通信で自動停止)より十分短い間隔で同一コマンドを再送し続ける。
const KEEPALIVE_INTERVAL_MS = 800;

// APIルート等、RouteEngineのインスタンスを持たない場所からも一覧取得できるようにするための単体関数。
export function listAvailableRoutes(): { id: string; label: string }[] {
  if (!fs.existsSync(ROUTES_DIR)) return [];
  return fs
    .readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const def = JSON.parse(fs.readFileSync(path.join(ROUTES_DIR, f), "utf-8")) as RouteDefinition;
      return { id: def.id, label: def.label };
    });
}

type SendDriveFn = (deviceId: string, cmd: DriveCommand, speedL: number, speedR: number) => void;
type StatusCallback = (status: RouteStatus) => void;

// オープンループ(時間ベース事前定義)ルートを複数車両へ同時スケジュール実行するエンジン。
// 将来的に外部トラッキングによる位置補正を導入する場合は、この上位に補正レイヤーを追加する想定。
export class RouteEngine {
  private timers: NodeJS.Timeout[] = [];
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private running = false;
  private startedAt = 0;
  private currentRouteId: string | null = null;
  private currentStepByDevice = new Map<string, RouteStep>();
  private stepIndexByDevice = new Map<string, number>();

  constructor(private deps: { sendDrive: SendDriveFn; onStatus: StatusCallback }) {}

  listRoutes(): { id: string; label: string }[] {
    return listAvailableRoutes();
  }

  isRunning(): boolean {
    return this.running;
  }

  start(routeId: string, deviceIds: string[]): void {
    this.stop();

    const def = this.readRouteFile(`${routeId}.json`);
    this.running = true;
    this.currentRouteId = routeId;
    this.startedAt = Date.now();

    deviceIds.forEach((deviceId, index) => {
      const program = def.programs[index];
      if (!program) return; // 車両数が定義済みプログラム数を超えた分は待機のまま
      this.scheduleVehicle(deviceId, program);
    });

    this.keepAliveTimer = setInterval(() => {
      this.currentStepByDevice.forEach((step, deviceId) => {
        this.deps.sendDrive(deviceId, step.cmd, step.speedL, step.speedR);
      });
      this.emitStatus();
    }, KEEPALIVE_INTERVAL_MS);

    this.emitStatus();
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;

    // 実行中だった車両は全停止させてから状態をクリアする
    this.currentStepByDevice.forEach((_step, deviceId) => this.deps.sendDrive(deviceId, "e", 0, 0));
    this.currentStepByDevice.clear();
    this.stepIndexByDevice.clear();

    this.running = false;
    this.emitStatus();
  }

  private scheduleVehicle(deviceId: string, program: VehicleProgram): void {
    let offset = 0;
    const applyStep = (step: RouteStep, stepIndex: number) => {
      const timer = setTimeout(() => {
        this.currentStepByDevice.set(deviceId, step);
        this.stepIndexByDevice.set(deviceId, stepIndex);
        this.deps.sendDrive(deviceId, step.cmd, step.speedL, step.speedR);
      }, offset);
      this.timers.push(timer);
    };

    program.toRendezvous.forEach((step, idx) => {
      applyStep(step, idx);
      offset += step.durationMs;
    });

    // 集合地点で待機 (停止して同期を取る)
    const holdStepIndex = program.toRendezvous.length;
    applyStep({ cmd: "e", speedL: 0, speedR: 0, durationMs: program.rendezvousHoldMs }, holdStepIndex);
    offset += program.rendezvousHoldMs;

    program.toDestination.forEach((step, idx) => {
      applyStep(step, holdStepIndex + 1 + idx);
      offset += step.durationMs;
    });

    const finalTimer = setTimeout(() => {
      this.currentStepByDevice.set(deviceId, { cmd: "e", speedL: 0, speedR: 0, durationMs: 0 });
      this.deps.sendDrive(deviceId, "e", 0, 0);
    }, offset);
    this.timers.push(finalTimer);
  }

  private emitStatus(): void {
    this.deps.onStatus({
      routeId: this.currentRouteId ?? "",
      running: this.running,
      elapsedMs: this.running ? Date.now() - this.startedAt : 0,
      perVehicle: Array.from(this.stepIndexByDevice.entries()).map(([deviceId, stepIndex]) => ({
        deviceId,
        stepIndex,
      })),
    });
  }

  private readRouteFile(fileName: string): RouteDefinition {
    const filePath = path.join(ROUTES_DIR, fileName);
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as RouteDefinition;
  }
}
