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
  edgeMarginMm: 130,
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

      // 2. Forward step: minDrivePwm, speedMmS, yawOffsetDeg, leftRightTrimRatio, brakingDistanceMm, creepStepMm
      emit("forward", 25, "前進走行・最小クリープ量・左右ドリフト・制動距離を測定中…");
      
      // 動き出しPWM（およびクリープ1ステップ移動量）の探索
      let minDrivePwm = 120;
      let creepStepMm = 12;
      const creepPulseMs = 70;
      let moved = false;
      for (const pwm of [130, 145, 155, 165]) {
        checkAborted();
        const before = getValidPose();
        this.deps.sendDrive(deviceId, "a", pwm, pwm);
        await this.deps.sleep(180);
        stop();
        await this.deps.sleep(380);
        const after = getValidPose();
        const dist = Math.hypot(after.x - before.x, after.y - before.y);
        if (dist >= 5) {
          minDrivePwm = pwm;
          creepStepMm = Math.round(Math.max(4, Math.min(40, dist * (creepPulseMs / 180))) * 10) / 10;
          moved = true;
          break;
        }
      }
      if (!moved) minDrivePwm = 145;

      // 基準PWMでの前進測定（および停止コマンド直後〜完全整定までの制動距離測定）
      const fwdPwm = 165;
      const fwdDurationMs = 450;
      const fwdBefore = getValidPose();
      if (
        fwdBefore.x < opts.edgeMarginMm ||
        fwdBefore.x > opts.fieldWidthMm - opts.edgeMarginMm ||
        fwdBefore.y < opts.edgeMarginMm ||
        fwdBefore.y > opts.fieldHeightMm - opts.edgeMarginMm
      ) {
        stop();
        const msg = `前進測定前にフィールド端へ近づいたため安全中断しました（端から${opts.edgeMarginMm}mm以上必要）`;
        emit("aborted", 0, msg, undefined, msg);
        throw new Error(msg);
      }
      const fwdStart = this.deps.now();
      this.deps.sendDrive(deviceId, "a", fwdPwm, fwdPwm);
      await this.deps.sleep(fwdDurationMs);
      stop();
      const fwdActualDt = Math.max(0.1, (this.deps.now() - fwdStart) / 1000);
      const atStopCmd = getValidPose();
      await this.deps.sleep(450);
      const fwdAfter = getValidPose();
      const dx = fwdAfter.x - fwdBefore.x;
      const dy = fwdAfter.y - fwdBefore.y;
      const fwdDist = Math.hypot(dx, dy);
      const brakingDistanceMm = Math.round(Math.max(0, Math.min(150, Math.hypot(fwdAfter.x - atStopCmd.x, fwdAfter.y - atStopCmd.y))) * 10) / 10;

      // 直進速度 (mm/s)
      const speedMmS = Math.round(Math.max(10, (fwdDist / fwdActualDt) * 10)) / 10;
      // 進行ベクトルとマーカーyawの差（ヨーオフセット）および直進中のヨー角変化（左右モーター差によるドリフト）
      let yawOffsetDeg = 0;
      let leftRightTrimRatio = 0;
      if (fwdDist >= 15) {
        const moveBearing = normalizeYaw(Math.atan2(dy, dx) * (180 / Math.PI));
        yawOffsetDeg = Math.round(shortestTurn(moveBearing, fwdBefore.yaw) * 10) / 10;
        // +Y下向き座標系では前進時に L > R で yawDriftDeg > 0 となるため、右輪強化(正のトリム)が負帰還として正しい
        const yawDriftDeg = shortestTurn(fwdBefore.yaw, fwdAfter.yaw);
        leftRightTrimRatio = Math.round(Math.max(-0.25, Math.min(0.25, yawDriftDeg * 0.004)) * 1000) / 1000;
      }

      // 3. Left & Right Turn minTurnPwm probe (左右両方向で動き出しPWMを検証し、大きい方を採用)
      emit("turnLeft", 55, "左・右旋回の動き出しPWMと左旋回特性を測定中…");
      let minTurnLeft = 140;
      let turnedLeft = false;
      for (const pwm of [125, 140, 155, 165]) {
        checkAborted();
        const before = getValidPose();
        this.deps.sendDrive(deviceId, "c", pwm, pwm);
        await this.deps.sleep(180);
        stop();
        await this.deps.sleep(380);
        const after = getValidPose();
        const angle = Math.abs(shortestTurn(before.yaw, after.yaw));
        if (angle >= 4) {
          minTurnLeft = pwm;
          turnedLeft = true;
          break;
        }
      }
      if (!turnedLeft) minTurnLeft = 145;

      let minTurnRight = minTurnLeft;
      let turnedRight = false;
      for (const pwm of [125, 140, 155, 165]) {
        if (pwm < minTurnLeft) continue;
        checkAborted();
        const before = getValidPose();
        this.deps.sendDrive(deviceId, "d", pwm, pwm);
        await this.deps.sleep(180);
        stop();
        await this.deps.sleep(380);
        const after = getValidPose();
        const angle = Math.abs(shortestTurn(before.yaw, after.yaw));
        if (angle >= 4) {
          minTurnRight = pwm;
          turnedRight = true;
          break;
        }
      }
      const minTurnPwm = turnedRight ? Math.max(minTurnLeft, minTurnRight) : Math.max(minTurnLeft, 145);

      const turnPwm = 160;
      // 高速旋回機体(350〜450°/s)でも180°折り返しエイリアシングを起こさない260ms測定
      const turnDurationMs = 260;
      const turnLeftBefore = getValidPose();
      const turnLeftStart = this.deps.now();
      this.deps.sendDrive(deviceId, "c", turnPwm, turnPwm);
      await this.deps.sleep(turnDurationMs);
      stop();
      const leftDt = Math.max(0.1, (this.deps.now() - turnLeftStart) / 1000);
      await this.deps.sleep(450);
      const turnLeftAfter = getValidPose();
      const leftAngle = Math.abs(shortestTurn(turnLeftBefore.yaw, turnLeftAfter.yaw));
      const turnRateLeftDegS = Math.round(Math.max(10, (leftAngle / leftDt) * 10)) / 10;

      // 4. Right Turn: turnRateRightDegS
      emit("turnRight", 80, "右旋回特性を測定中…");
      const turnRightBefore = getValidPose();
      const turnRightStart = this.deps.now();
      this.deps.sendDrive(deviceId, "d", turnPwm, turnPwm);
      await this.deps.sleep(turnDurationMs);
      stop();
      const rightDt = Math.max(0.1, (this.deps.now() - turnRightStart) / 1000);
      await this.deps.sleep(450);
      const turnRightAfter = getValidPose();
      const rightAngle = Math.abs(shortestTurn(turnRightBefore.yaw, turnRightAfter.yaw));
      const turnRateRightDegS = Math.round(Math.max(10, (rightAngle / rightDt) * 10)) / 10;

      // 5. Done
      stop();
      const result: RobotMotionCalibration = {
        calibratedAt: this.deps.now(),
        minDrivePwm,
        maxDrivePwm: 170,
        speedMmS,
        minTurnPwm,
        maxTurnPwm: 165,
        turnRateLeftDegS,
        turnRateRightDegS,
        yawOffsetDeg,
        leftRightTrimRatio,
        brakingDistanceMm,
        creepPulseMs,
        creepStepMm,
      };

      emit("done", 100, "校正完了", result);
      return result;
    } catch (err) {
      stop();
      throw err;
    }
  }
}
