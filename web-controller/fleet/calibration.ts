import type { DriveCommand, RobotMotionCalibration, CalibrationStep, CalibrationProgressMessage } from "./protocol";
import { normalizeYaw, shortestTurn } from "../scene/units";
import { STOP } from "./motionController";

export interface CalibrationPose {
  x: number;
  y: number;
  yaw: number;
  tracking: "tracking" | "stale" | "lost" | "unassigned";
}

export interface CalibrationDeps {
  now(): number;
  sendDrive(deviceId: string, cmd: DriveCommand, speedL: number, speedR: number): void;
  getPose(robotId: string): CalibrationPose | null;
  sleep(ms: number): Promise<void>;
  onProgress?(progress: CalibrationProgressMessage): void;
}

export interface CalibrationOptions {
  fieldWidthMm?: number;
  fieldHeightMm?: number;
  edgeMarginMm?: number;
  maxWaitPoseMs?: number;
}

const DEFAULT_OPTIONS: Required<CalibrationOptions> = {
  fieldWidthMm: 1106.93,
  fieldHeightMm: 622.65,
  edgeMarginMm: 100,
  maxWaitPoseMs: 3000,
};

export class CalibrationRunner {
  private aborted = false;

  constructor(private deps: CalibrationDeps, private options: CalibrationOptions = {}) {}

  abort(): void {
    this.aborted = true;
  }

  async run(robotId: string, deviceId: string): Promise<RobotMotionCalibration> {
    const opts = { ...DEFAULT_OPTIONS, ...this.options };
    this.aborted = false;

    const stop = () => {
      this.deps.sendDrive(deviceId, STOP.cmd, STOP.speedL, STOP.speedR);
    };

    const emit = (step: CalibrationStep, pct: number, message: string, calibration?: RobotMotionCalibration, error?: string) => {
      this.deps.onProgress?.({
        type: "calibrationProgress",
        robotId,
        step,
        progressPct: pct,
        message,
        calibration,
        error,
      });
    };

    const checkAborted = () => {
      if (this.aborted) {
        stop();
        emit("aborted", 0, "校正が中断されました", undefined, "校正が中断されました");
        throw new Error("Calibration aborted");
      }
    };

    const getValidPose = (): CalibrationPose => {
      checkAborted();
      const p = this.deps.getPose(robotId);
      if (!p || p.tracking !== "tracking") {
        stop();
        emit("aborted", 0, "測位を見失ったため中断しました", undefined, "測位を見失いました");
        throw new Error("Lost tracking during calibration");
      }
      return p;
    };

    try {
      // 1. Preparing
      emit("preparing", 10, "初期位置と安全マージンを確認中…");
      await this.deps.sleep(200);
      const initPose = getValidPose();

      if (
        initPose.x < opts.edgeMarginMm ||
        initPose.x > opts.fieldWidthMm - opts.edgeMarginMm ||
        initPose.y < opts.edgeMarginMm ||
        initPose.y > opts.fieldHeightMm - opts.edgeMarginMm
      ) {
        stop();
        const msg = `フィールド端に近すぎます（端から${opts.edgeMarginMm}mm以上離してください）`;
        emit("aborted", 0, msg, undefined, msg);
        throw new Error(msg);
      }

      // 2. Forward step: minDrivePwm, speedMmS, yawOffsetDeg
      emit("forward", 25, "前進走行と速度・ヨーオフセットを測定中…");
      
      // 動き出しPWMの探索
      let minDrivePwm = 120;
      let moved = false;
      for (const pwm of [90, 110, 130, 150, 170]) {
        checkAborted();
        const before = getValidPose();
        this.deps.sendDrive(deviceId, "a", pwm, pwm);
        await this.deps.sleep(250);
        stop();
        await this.deps.sleep(200);
        const after = getValidPose();
        const dist = Math.hypot(after.x - before.x, after.y - before.y);
        if (dist >= 5) {
          minDrivePwm = pwm;
          moved = true;
          break;
        }
      }
      if (!moved) minDrivePwm = 130;

      // 基準PWMでの前進測定
      const fwdPwm = 190;
      const fwdDurationMs = 700;
      const fwdBefore = getValidPose();
      const fwdStart = this.deps.now();
      this.deps.sendDrive(deviceId, "a", fwdPwm, fwdPwm);
      await this.deps.sleep(fwdDurationMs);
      stop();
      await this.deps.sleep(300);
      const fwdAfter = getValidPose();
      const fwdActualDt = Math.max(0.1, (this.deps.now() - fwdStart) / 1000);
      const dx = fwdAfter.x - fwdBefore.x;
      const dy = fwdAfter.y - fwdBefore.y;
      const fwdDist = Math.hypot(dx, dy);

      // 直進速度 (mm/s)
      const speedMmS = Math.round(Math.max(10, (fwdDist / fwdActualDt) * 10)) / 10;
      // 進行ベクトルとマーカーyawの差（ヨーオフセット）
      let yawOffsetDeg = 0;
      if (fwdDist >= 15) {
        const moveBearing = normalizeYaw(Math.atan2(dy, dx) * (180 / Math.PI));
        yawOffsetDeg = Math.round(shortestTurn(moveBearing, fwdBefore.yaw) * 10) / 10;
      }

      // 3. Left Turn: minTurnPwm, turnRateLeftDegS
      emit("turnLeft", 55, "左旋回特性を測定中…");
      let minTurnPwm = 140;
      let turned = false;
      for (const pwm of [110, 130, 150, 170, 190]) {
        checkAborted();
        const before = getValidPose();
        this.deps.sendDrive(deviceId, "c", pwm, pwm);
        await this.deps.sleep(250);
        stop();
        await this.deps.sleep(200);
        const after = getValidPose();
        const angle = Math.abs(shortestTurn(before.yaw, after.yaw));
        if (angle >= 4) {
          minTurnPwm = pwm;
          turned = true;
          break;
        }
      }
      if (!turned) minTurnPwm = 140;

      const turnPwm = 175;
      const turnDurationMs = 500;
      const turnLeftBefore = getValidPose();
      const turnLeftStart = this.deps.now();
      this.deps.sendDrive(deviceId, "c", turnPwm, turnPwm);
      await this.deps.sleep(turnDurationMs);
      stop();
      await this.deps.sleep(300);
      const turnLeftAfter = getValidPose();
      const leftDt = Math.max(0.1, (this.deps.now() - turnLeftStart) / 1000);
      const leftAngle = Math.abs(shortestTurn(turnLeftBefore.yaw, turnLeftAfter.yaw));
      const turnRateLeftDegS = Math.round(Math.max(10, (leftAngle / leftDt) * 10)) / 10;

      // 4. Right Turn: turnRateRightDegS
      emit("turnRight", 80, "右旋回特性を測定中…");
      const turnRightBefore = getValidPose();
      const turnRightStart = this.deps.now();
      this.deps.sendDrive(deviceId, "d", turnPwm, turnPwm);
      await this.deps.sleep(turnDurationMs);
      stop();
      await this.deps.sleep(300);
      const turnRightAfter = getValidPose();
      const rightDt = Math.max(0.1, (this.deps.now() - turnRightStart) / 1000);
      const rightAngle = Math.abs(shortestTurn(turnRightBefore.yaw, turnRightAfter.yaw));
      const turnRateRightDegS = Math.round(Math.max(10, (rightAngle / rightDt) * 10)) / 10;

      // 5. Done
      stop();
      const result: RobotMotionCalibration = {
        calibratedAt: this.deps.now(),
        minDrivePwm,
        maxDrivePwm: 220,
        speedMmS,
        minTurnPwm,
        maxTurnPwm: 200,
        turnRateLeftDegS,
        turnRateRightDegS,
        yawOffsetDeg,
      };

      emit("done", 100, "校正完了", result);
      return result;
    } catch (err) {
      stop();
      throw err;
    }
  }
}
