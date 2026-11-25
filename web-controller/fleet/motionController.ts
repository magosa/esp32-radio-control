import type { DriveCommand, FieldConfig, RobotMotionCalibration } from "./protocol";
import { normalizeYaw, shortestTurn } from "../scene/units";

export interface Pose { x: number; y: number; yaw: number }

export interface Goal extends Pose {
  // Turn on the spot to `yaw`; the position is ignored.
  rotate: boolean;
  // Planned travel speed (mm/s), distance divided by the bar length.
  speedMmS: number;
  // Enable smooth reverse drive when goal is behind the robot.
  allowReverse?: boolean;
}

export interface Drive {
  cmd: DriveCommand;
  speedL: number;
  speedR: number;
  // 指定時間が経過したら自律停止するパルス幅(ms)
  durationMs?: number;
}

export type DrivePhase = "stop" | "spin" | "creep" | "softStart" | "cruise" | "decelerate" | "geofenceBrake";

export interface AdaptiveRuntimeContext {
  // 静止からの連続直進ステップ数（0 = 停止からの走り出し1歩目 -> ソフトスタート適用）
  consecutiveLinearSteps?: number;
  // 走行中のリアルタイム自動補正で学習した左右トリム追加分（正で右車輪を強化）
  dynamicTrimRatio?: number;
  // 走行中のリアルタイム自動補正で学習した速度倍率（電池低下時は <1.0 -> 出力/パルス幅を自動補正）
  dynamicSpeedScale?: number;
  // 直前のパルスで静止摩擦に負けて動かなかった場合の自動出力ブースト (PWM, 0〜35)
  stallBoostPwm?: number;
  // カメラ測位遅延 (ms)
  cameraLatencyMs?: number;
  // フィールド寸法（予測型ジオフェンスによる飛び出し防止用）
  field?: Pick<FieldConfig, "widthMm" | "heightMm">;
}

export interface TrajectoryPrediction {
  endX: number;
  endY: number;
  endYaw: number;
  travelMm: number;
  insideSafeZone: boolean;
  insideSlowZone: boolean;
}

export interface Control {
  drive: Drive;
  posErrMm: number;
  // Signed: positive means the robot must turn counter-clockwise.
  yawErrDeg: number;
  phase?: DrivePhase;
  prediction?: TrajectoryPrediction;
}

export const STOP: Drive = { cmd: "e", speedL: 0, speedR: 0 };

// Default torque limits for uncalibrated / simulated robots.
export const DRIVE_LIMITS = { maxSpeedMmS: 200, minPwm: 80, maxPwm: 220, minTurnPwm: 80, maxTurnPwm: 200 };

// 予測型ジオフェンスの安全マージン（基準マーカー中心の内側からさらに確保する絶対防衛ライン）
export const GEOFENCE_SAFE_MARGIN_MM = 130;
export const GEOFENCE_SLOW_MARGIN_MM = 200;

// クリープ走行および早めの自然減速アプローチの境界距離
export const CREEP_RADIUS_MM = 80;
export const SLOW_RADIUS_MM = 200;
// 実機の安全巡航PWM上限（急発進・過速によるオーバーランやギア負荷を構造的に防ぐ）
export const SAFE_REAL_MAX_PWM = 170;

// Inside these the robot stops commanding; arrival (20 mm / 15 deg) is judged by the runner with a margin above them.
const POS_DEAD_MM = 20;
const YAW_DEAD_DEG = 10;
const TURN_FIRST_DEG = 30;
const STEER_GAIN = 1.0;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// 走行指示前の軌道予測（Forward Simulation）：
// 指定した駆動コマンドを実行した場合に「パルス時間＋カメラ遅延＋惰走制動距離」で到達する最悪停止位置を予測する。
export function predictTrajectory(
  pose: Pose,
  drive: Drive,
  calibration?: RobotMotionCalibration | null,
  runtime?: AdaptiveRuntimeContext
): TrajectoryPrediction {
  const fieldW = runtime?.field?.widthMm ?? 1106.93;
  const fieldH = runtime?.field?.heightMm ?? 622.65;
  const effectiveYaw = calibration ? normalizeYaw(pose.yaw - calibration.yawOffsetDeg) : pose.yaw;

  if (drive.cmd === "e") {
    const insideSafeZone =
      pose.x >= GEOFENCE_SAFE_MARGIN_MM && pose.x <= fieldW - GEOFENCE_SAFE_MARGIN_MM &&
      pose.y >= GEOFENCE_SAFE_MARGIN_MM && pose.y <= fieldH - GEOFENCE_SAFE_MARGIN_MM;
    const insideSlowZone =
      pose.x >= GEOFENCE_SLOW_MARGIN_MM && pose.x <= fieldW - GEOFENCE_SLOW_MARGIN_MM &&
      pose.y >= GEOFENCE_SLOW_MARGIN_MM && pose.y <= fieldH - GEOFENCE_SLOW_MARGIN_MM;
    return { endX: pose.x, endY: pose.y, endYaw: effectiveYaw, travelMm: 0, insideSafeZone, insideSlowZone };
  }

  const pulseSec = (drive.durationMs ?? 100) / 1000;
  // ハードウェア側durationMsタイマーがない場合も想定し、カメラ遅延の半分を安全余裕として加算
  const latencySec = Math.min(0.25, Math.max(0, (runtime?.cameraLatencyMs ?? 90) / 1000) * 0.35);
  const activeSec = pulseSec + latencySec;

  if (drive.cmd === "c" || drive.cmd === "d") {
    const rate = drive.cmd === "c"
      ? (calibration?.turnRateLeftDegS ?? 140)
      : -(calibration?.turnRateRightDegS ?? 140);
    const endYaw = normalizeYaw(effectiveYaw + rate * activeSec);
    const insideSafeZone =
      pose.x >= GEOFENCE_SAFE_MARGIN_MM && pose.x <= fieldW - GEOFENCE_SAFE_MARGIN_MM &&
      pose.y >= GEOFENCE_SAFE_MARGIN_MM && pose.y <= fieldH - GEOFENCE_SAFE_MARGIN_MM;
    const insideSlowZone =
      pose.x >= GEOFENCE_SLOW_MARGIN_MM && pose.x <= fieldW - GEOFENCE_SLOW_MARGIN_MM &&
      pose.y >= GEOFENCE_SLOW_MARGIN_MM && pose.y <= fieldH - GEOFENCE_SLOW_MARGIN_MM;
    return { endX: pose.x, endY: pose.y, endYaw, travelMm: 0, insideSafeZone, insideSlowZone };
  }

  const baseSpeed = (calibration?.speedMmS ?? DRIVE_LIMITS.maxSpeedMmS) * (runtime?.dynamicSpeedScale ?? 1.0);
  const minPwm = calibration?.minDrivePwm ?? DRIVE_LIMITS.minPwm;
  const maxPwm = Math.min(calibration?.maxDrivePwm ?? DRIVE_LIMITS.maxPwm, calibration ? SAFE_REAL_MAX_PWM : DRIVE_LIMITS.maxPwm);
  const meanPwm = (drive.speedL + drive.speedR) / 2;
  const pwmRatio = maxPwm > minPwm ? clamp((meanPwm - minPwm) / (maxPwm - minPwm), 0.25, 1.0) : 0.7;
  const estSpeedMmS = baseSpeed * (0.55 + 0.45 * pwmRatio);
  // ソフトストップ＋フリーラン自然停止時の余裕距離（実測値または安全側デフォルト45mm）
  const brakingMm = Math.max(40, calibration?.brakingDistanceMm ?? 45) * (0.5 + 0.5 * pwmRatio);
  const travelMm = estSpeedMmS * activeSec + brakingMm;
  const sign = drive.cmd === "b" ? -1 : 1;
  const rad = (effectiveYaw * Math.PI) / 180;
  const endX = pose.x + sign * travelMm * Math.cos(rad);
  const endY = pose.y + sign * travelMm * Math.sin(rad);

  const insideSafeZone =
    endX >= GEOFENCE_SAFE_MARGIN_MM && endX <= fieldW - GEOFENCE_SAFE_MARGIN_MM &&
    endY >= GEOFENCE_SAFE_MARGIN_MM && endY <= fieldH - GEOFENCE_SAFE_MARGIN_MM;
  const insideSlowZone =
    endX >= GEOFENCE_SLOW_MARGIN_MM && endX <= fieldW - GEOFENCE_SLOW_MARGIN_MM &&
    endY >= GEOFENCE_SLOW_MARGIN_MM && endY <= fieldH - GEOFENCE_SLOW_MARGIN_MM;

  return { endX, endY, endYaw: effectiveYaw, travelMm, insideSafeZone, insideSlowZone };
}

function spin(
  err: number,
  limits: { minTurnPwm: number; maxTurnPwm: number; isCalibrated: boolean },
  calibration?: RobotMotionCalibration | null,
  stallBoostPwm = 0
): { drive: Drive; phase: DrivePhase } {
  const absErr = Math.abs(err);
  if (!limits.isCalibrated) {
    const pwm = Math.round(clamp(60 + absErr * 0.3, limits.minTurnPwm, limits.maxTurnPwm));
    return { drive: { cmd: err > 0 ? "c" : "d", speedL: pwm, speedR: pwm }, phase: "spin" };
  }

  // 実機の旋回：28°以内はクリープ旋回（最小旋回PWM＋短パルス）、大角度でも急加速させない
  const isCreepTurn = absErr <= 28;
  const extra = isCreepTurn ? 0 : Math.min(18, (absErr - 28) * 0.25);
  const boost = clamp(stallBoostPwm, 0, 35);
  const maxSafeTurnPwm = Math.min(limits.maxTurnPwm, SAFE_REAL_MAX_PWM);
  const pwm = Math.round(clamp(limits.minTurnPwm + extra + boost, limits.minTurnPwm, maxSafeTurnPwm));
  const rate = err > 0 ? (calibration?.turnRateLeftDegS ?? 150) : (calibration?.turnRateRightDegS ?? 150);
  // 1回のパルスで目標角度の約60%だけを回す（オーバーシュート防止）
  // ファームウェアのソフトスタート(約35ms)を考慮し、最小75msを確保して静止摩擦での空打ちを防ぐ
  const idealMs = (absErr * 0.6 / Math.max(40, rate)) * 1000;
  const durationMs = Math.round(clamp(idealMs, isCreepTurn ? 75 : 85, isCreepTurn ? 110 : 180));
  return {
    drive: { cmd: err > 0 ? "c" : "d", speedL: pwm, speedR: pwm, durationMs },
    phase: isCreepTurn ? "creep" : "spin",
  };
}

export function control(
  pose: Pose,
  goal: Goal,
  calibration?: RobotMotionCalibration | null,
  runtime?: AdaptiveRuntimeContext
): Control {
  const effectiveYaw = calibration ? normalizeYaw(pose.yaw - calibration.yawOffsetDeg) : pose.yaw;
  const isCalibrated = !!calibration;
  const limits = {
    minPwm: calibration?.minDrivePwm ?? DRIVE_LIMITS.minPwm,
    maxPwm: isCalibrated
      ? Math.max(calibration?.minDrivePwm ?? DRIVE_LIMITS.minPwm, Math.min(calibration?.maxDrivePwm ?? SAFE_REAL_MAX_PWM, SAFE_REAL_MAX_PWM))
      : DRIVE_LIMITS.maxPwm,
    maxSpeedMmS: calibration?.speedMmS ?? DRIVE_LIMITS.maxSpeedMmS,
    minTurnPwm: calibration?.minTurnPwm ?? DRIVE_LIMITS.minTurnPwm,
    maxTurnPwm: calibration?.maxTurnPwm ?? DRIVE_LIMITS.maxTurnPwm,
    isCalibrated,
  };

  // 予測型ジオフェンスが有効な場合、目標座標自体も絶対防衛ラインの内側にクランプして安全を確保する
  const fieldW = runtime?.field?.widthMm;
  const fieldH = runtime?.field?.heightMm;
  const safeGoalX = isCalibrated && fieldW ? clamp(goal.x, GEOFENCE_SAFE_MARGIN_MM, fieldW - GEOFENCE_SAFE_MARGIN_MM) : goal.x;
  const safeGoalY = isCalibrated && fieldH ? clamp(goal.y, GEOFENCE_SAFE_MARGIN_MM, fieldH - GEOFENCE_SAFE_MARGIN_MM) : goal.y;

  const dx = safeGoalX - pose.x, dy = safeGoalY - pose.y;
  const posErrMm = goal.rotate ? 0 : Math.hypot(dx, dy);
  const yawErrDeg = shortestTurn(effectiveYaw, goal.yaw);
  const base = { posErrMm, yawErrDeg };

  if (goal.rotate || posErrMm <= POS_DEAD_MM) {
    if (Math.abs(yawErrDeg) <= YAW_DEAD_DEG) {
      return { ...base, drive: STOP, phase: "stop" };
    }
    const s = spin(yawErrDeg, limits, calibration, runtime?.stallBoostPwm ?? 0);
    return { ...base, drive: s.drive, phase: s.phase };
  }

  const bearing = normalizeYaw((Math.atan2(dy, dx) * 180) / Math.PI);
  const forwardBearingErr = shortestTurn(effectiveYaw, bearing);

  // 後進は近距離（80mm以内）で行き過ぎて背後にある場合のクリープ微調整に限定
  const reverseCandidate = (goal.allowReverse ?? true) && posErrMm <= CREEP_RADIUS_MM;
  const useReverse = reverseCandidate && Math.abs(forwardBearingErr) > 95;
  const bearingErr = useReverse
    ? shortestTurn(effectiveYaw, normalizeYaw(bearing + 180))
    : forwardBearingErr;

  // Stop-Turn-Go 原則：向きが22°以上大きくずれている場合のみその場旋回で合わせ直す（細かすぎる補正をしない）
  const turnFirstDeg = isCalibrated ? (posErrMm <= CREEP_RADIUS_MM ? 28 : 22) : TURN_FIRST_DEG;
  if (Math.abs(bearingErr) > turnFirstDeg) {
    const s = spin(bearingErr, limits, calibration, runtime?.stallBoostPwm ?? 0);
    return { ...base, drive: s.drive, phase: s.phase };
  }

  if (!isCalibrated) {
    const speed = Math.min(goal.speedMmS, Math.max(40, posErrMm * 1.5));
    const slowed = posErrMm < 100 ? speed : goal.speedMmS;
    const pwm = clamp(Math.round((slowed / DRIVE_LIMITS.maxSpeedMmS) * 255), DRIVE_LIMITS.minPwm, DRIVE_LIMITS.maxPwm);
    const steer = bearingErr * STEER_GAIN;
    if (useReverse) {
      const left = Math.round(clamp(pwm + steer, 0, limits.maxPwm));
      const right = Math.round(clamp(pwm - steer, 0, limits.maxPwm));
      return { ...base, drive: { cmd: "b", speedL: left, speedR: right }, phase: "cruise" };
    } else {
      const left = Math.round(clamp(pwm - steer, 0, limits.maxPwm));
      const right = Math.round(clamp(pwm + steer, 0, limits.maxPwm));
      return { ...base, drive: { cmd: "a", speedL: left, speedR: right }, phase: "cruise" };
    }
  }

  // ---- 実機（Calibrated）専用：ソフトスタート・クリープ・適応トリム・事前軌道予測制御 ----
  const consecutiveSteps = runtime?.consecutiveLinearSteps ?? 0;
  const speedScale = clamp(runtime?.dynamicSpeedScale ?? 1.0, 0.7, 1.35);
  // 電池低下時(speedScale < 1.0)は必要な出力を少し補い、過速時(speedScale > 1.0)は抑える。静止摩擦スタック時は stallBoostPwm を加算。
  const adaptiveBoost = Math.round((1.0 - speedScale) * 14) + clamp(runtime?.stallBoostPwm ?? 0, 0, 35);

  let phase: DrivePhase;
  let targetPwm: number;
  let durationMs: number;

  if (posErrMm <= CREEP_RADIUS_MM) {
    // ① クリープ走行領域（20mm〜80mm）：最小駆動PWM＋短パルスで慎重に寄せる（ファームウェアのソフトスタート約35msを考慮し最小75ms）
    phase = "creep";
    targetPwm = clamp(limits.minPwm + adaptiveBoost, limits.minPwm, limits.maxPwm);
    const baseCreepMs = calibration?.creepPulseMs ?? 70;
    const distRatio = clamp((posErrMm - POS_DEAD_MM) / (CREEP_RADIUS_MM - POS_DEAD_MM), 0.2, 1.0);
    const stallTimeBonus = Math.min(25, Math.round(clamp(runtime?.stallBoostPwm ?? 0, 0, 35) * 0.7));
    durationMs = Math.round(clamp(baseCreepMs * (0.95 + 0.45 * distRatio) + stallTimeBonus, 75, 115));
  } else if (consecutiveSteps < 3) {
    // ② ソフトスタート領域（走り出しの1〜3ステップ目）：いきなりフルスロットルにせず段階的に加速する
    phase = "softStart";
    const rampRatio = (consecutiveSteps + 1) / 4; // 0.25 -> 0.50 -> 0.75
    const distCapRatio = clamp((posErrMm - CREEP_RADIUS_MM) / (SLOW_RADIUS_MM - CREEP_RADIUS_MM), 0.3, 1.0);
    const effectiveRatio = Math.min(rampRatio, distCapRatio);
    targetPwm = Math.round(
      clamp(limits.minPwm + (limits.maxPwm - limits.minPwm) * effectiveRatio + adaptiveBoost, limits.minPwm, limits.maxPwm)
    );
    durationMs = Math.round(80 + 25 * consecutiveSteps); // 80ms -> 105ms -> 130ms
  } else if (posErrMm < SLOW_RADIUS_MM) {
    // ③ 減速アプローチ領域（85mm〜180mm）：目標に近づくにつれてPWMとパルス幅を滑らかに絞る
    phase = "decelerate";
    const ratio = clamp((posErrMm - CREEP_RADIUS_MM) / (SLOW_RADIUS_MM - CREEP_RADIUS_MM), 0.15, 0.85);
    targetPwm = Math.round(
      clamp(limits.minPwm + (limits.maxPwm - limits.minPwm) * ratio + adaptiveBoost, limits.minPwm, limits.maxPwm)
    );
    durationMs = Math.round(80 + 60 * ratio);
  } else {
    // ④ 巡航領域（>180mm）：ソフトスタート完了後の安定走行
    phase = "cruise";
    const plannedRatio = clamp(goal.speedMmS / Math.max(60, limits.maxSpeedMmS), 0.4, 1.0);
    targetPwm = Math.round(
      clamp(limits.minPwm + (limits.maxPwm - limits.minPwm) * plannedRatio + adaptiveBoost, limits.minPwm, limits.maxPwm)
    );
    durationMs = 150;
  }

  // 左右モーター特性差（事前校正トリム＋走行中のリアルタイム自動学習トリム）の適用
  const totalTrimRatio = clamp(
    (calibration?.leftRightTrimRatio ?? 0) + (runtime?.dynamicTrimRatio ?? 0),
    -0.2,
    0.2
  );
  const trimOffset = (targetPwm * totalTrimRatio) / 2;

  // 15°以内の細かな角度誤差に対して過剰にハンドルを切らず、大らかな不感帯＋緩やかな微調整のみに抑える
  const maxSteer = phase === "creep" ? 2 : 4;
  const effectiveSteerErr = Math.abs(bearingErr) <= 6 ? 0 : bearingErr;
  const steer = clamp(effectiveSteerErr * 0.25, -maxSteer, maxSteer);
  const minWheel = Math.round(limits.minPwm * 0.96);

  let left: number;
  let right: number;
  const cmd: DriveCommand = useReverse ? "b" : "a";

  if (useReverse) {
    left = Math.round(clamp(targetPwm - trimOffset + steer, minWheel, limits.maxPwm));
    right = Math.round(clamp(targetPwm + trimOffset - steer, minWheel, limits.maxPwm));
  } else {
    left = Math.round(clamp(targetPwm - trimOffset - steer, minWheel, limits.maxPwm));
    right = Math.round(clamp(targetPwm + trimOffset + steer, minWheel, limits.maxPwm));
  }

  let candidateDrive: Drive = { cmd, speedL: left, speedR: right, durationMs };

  // ⑤ 走行指示前の軌道予測と予測型ジオフェンス検証
  const prediction = predictTrajectory(pose, candidateDrive, calibration, runtime);
  if (runtime?.field) {
    const centerX = runtime.field.widthMm / 2;
    const centerY = runtime.field.heightMm / 2;
    const currentDistFromCenter = Math.hypot(pose.x - centerX, pose.y - centerY);
    const predictedDistFromCenter = Math.hypot(prediction.endX - centerX, prediction.endY - centerY);
    const movingOutward = predictedDistFromCenter > currentDistFromCenter;

    if (!prediction.insideSafeZone && movingOutward) {
      // 予測停止位置が絶対防衛ラインを超える場合、クリープ短パルスで安全領域内に収まるか再試行
      const safePwm = Math.round(clamp(limits.minPwm + clamp(runtime?.stallBoostPwm ?? 0, 0, 15), limits.minPwm, limits.maxPwm));
      const safeCreepDrive: Drive = {
        cmd,
        speedL: safePwm,
        speedR: safePwm,
        durationMs: 75,
      };
      const creepPred = predictTrajectory(pose, safeCreepDrive, calibration, runtime);
      if (creepPred.insideSafeZone) {
        return { ...base, drive: safeCreepDrive, phase: "creep", prediction: creepPred };
      }
      // それでも安全境界を超える場合はコマンド送信前に緊急停止に置換
      return { ...base, drive: STOP, phase: "geofenceBrake", prediction };
    }

    if (!prediction.insideSlowZone && movingOutward && phase !== "creep") {
      // 外周減速ゾーンに向かう場合は強制的にクリープ速度へ減速（ただしスタック自動ブーストは維持する）
      const slowCapPwm = Math.round(clamp(limits.minPwm + 8 + clamp(runtime?.stallBoostPwm ?? 0, 0, 20), limits.minPwm, limits.maxPwm));
      candidateDrive = {
        cmd,
        speedL: Math.min(left, slowCapPwm),
        speedR: Math.min(right, slowCapPwm),
        durationMs: Math.min(durationMs, 95),
      };
      phase = "creep";
    }
  }

  return { ...base, drive: candidateDrive, phase, prediction };
}
