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
  // 遠距離(>100mm)かつ高FPS・安全領域内で、毎回の完全停止を挟まず連続巡航してよいか
  continuous?: boolean;
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
  // カメラ実測FPS（>= 4fps で連続巡航モード、< 4fps で安全な長ストローク間欠モードへ自動切替）
  cameraFps?: number | null;
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

// 予測型ジオフェンスの安全マージン（カメラ視野端からの見失いを防ぎつつ外周目標90mmへ到達可能な防衛ライン）
export const GEOFENCE_SAFE_MARGIN_MM = 75;
export const GEOFENCE_SLOW_MARGIN_MM = 120;

// クリープ走行および早めの自然減速アプローチの境界距離
export const CREEP_RADIUS_MM = 80;
export const SLOW_RADIUS_MM = 200;
// 実機の安全巡航PWM上限（急発進・過速によるオーバーランやギア負荷を構造的に防ぐ）
export const SAFE_REAL_MAX_PWM = 170;
// 静止摩擦スタック検知時(stallBoostPwm > 0)のみ段階的に許容する上限PWM（ESP32ソフトスタート保護あり）
export const STALL_BOOST_MAX_PWM = 215;

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

  const pulseSec = drive.continuous
    ? Math.min(0.20, (drive.durationMs ?? 200) / 1000)
    : (drive.durationMs ?? 100) / 1000;
  // 連続巡航(continuous)はサーバーからの停止指示遅延を加算。単発タイマー駆動(!continuous)はESP32側ハードウェアタイマーで自律停止するため遅延加算せずソフトスタート分を差し引く
  const meanPwmForRamp = (drive.speedL + drive.speedR) / 2;
  const rampSec = drive.continuous ? 0 : (Math.ceil(Math.max(0, meanPwmForRamp - 115) / 14) * 10) / 1000;
  const latencySec = drive.continuous
    ? Math.min(0.25, Math.max(0, (runtime?.cameraLatencyMs ?? 90) / 1000) * 0.35)
    : 0;
  const activeSec = drive.continuous
    ? pulseSec + latencySec
    : Math.max(0.02, pulseSec - rampSec * 0.5);

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
  // ソフトストップ＋フリーラン自然停止時の余裕距離（連続巡航時は100%、静止からの極短クリープパルスは運動エネルギー比でスケーリング）
  const pulseEnergy = drive.continuous ? 1.0 : clamp(pulseSec / 0.3, 0.25, 1.0);
  const brakingMm = Math.max(40, calibration?.brakingDistanceMm ?? 45) * (0.5 + 0.5 * pwmRatio) * pulseEnergy;
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

  // 実機の旋回：ESP32ソフトスタート(115PWMから10ms毎に+14PWM)の立ち上がり時間を加算し、
  // 校正済みminTurnPwmと角速度から連続的にホールド時間(14〜110ms)を算出して微調整時のオーバーシュートを防ぐ
  const isCreepTurn = absErr <= 30;
  const extra = isCreepTurn ? 0 : Math.min(12, (absErr - 30) * 0.16);
  const boost = clamp(stallBoostPwm, 0, 50);
  const effectiveMinTurnPwm = Math.max(125, limits.minTurnPwm);
  const maxSafeTurnPwm = boost > 0 ? Math.min(STALL_BOOST_MAX_PWM, 210) : Math.max(effectiveMinTurnPwm, Math.min(limits.maxTurnPwm, SAFE_REAL_MAX_PWM));
  const pwm = Math.round(clamp(effectiveMinTurnPwm + extra + boost, effectiveMinTurnPwm, maxSafeTurnPwm));
  const rampUpMs = Math.ceil(Math.max(0, pwm - 115) / 14) * 10;
  const rate = err > 0 ? (calibration?.turnRateLeftDegS ?? 150) : (calibration?.turnRateRightDegS ?? 150);
  const pwmSpeedFactor = pwm > effectiveMinTurnPwm ? 1 + (pwm - effectiveMinTurnPwm) / 80 : 1;
  const turnFraction = absErr > 45 ? 0.50 : 0.40;
  const idealHoldMs = (absErr * turnFraction / Math.max(40, rate * pwmSpeedFactor)) * 1000;
  const holdMs = Math.round(clamp(idealHoldMs, isCreepTurn ? 24 : 32, isCreepTurn ? 65 : 175));
  const durationMs = Math.min(220, rampUpMs + holdMs);
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

  // Stop-Turn-Go 原則：向きが大きくずれている場合はその場旋回で合わせ直す。高FPS連続巡航中(>100mm)は28°まで緩やかに車線維持して不要な途中停止を防ぐ
  const highFpsForTurn = (runtime?.cameraFps ?? 0) >= 4;
  const turnFirstDeg = isCalibrated
    ? (posErrMm <= CREEP_RADIUS_MM || highFpsForTurn ? 28 : 22)
    : TURN_FIRST_DEG;
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

  // ---- 実機（Calibrated）専用：連続巡航・台形減速・クリープ・予測ジオフェンス制御 ----
  const calibratedBrakeMm = calibration?.brakingDistanceMm ?? 55;
  const consecutiveSteps = runtime?.consecutiveLinearSteps ?? 0;
  const speedScale = clamp(runtime?.dynamicSpeedScale ?? 1.0, 0.7, 1.35);
  // カメラ遅延・FPS・実機速度から連続巡航の解除距離を物理算出（遅延混入済みの制動距離に依存せず滑らかに減速）
  const latencySec = clamp((runtime?.cameraLatencyMs ?? 100) / 1000, 0.06, 0.22);
  const fpsHalfPeriodSec = runtime?.cameraFps && runtime.cameraFps > 0
    ? clamp(0.5 / runtime.cameraFps, 0.03, 0.15)
    : 0.06;
  const exitSpeedMmS = limits.maxSpeedMmS * speedScale * 0.72;
  const estPhysicalCoastMm = clamp(limits.maxSpeedMmS * 0.12, 15, 50);
  const cruiseExitMm = clamp(
    Math.round(exitSpeedMmS * (0.10 + latencySec + fpsHalfPeriodSec) + estPhysicalCoastMm + 15),
    85,
    155
  );
  const dynamicSlowRadiusMm = Math.max(SLOW_RADIUS_MM, cruiseExitMm + 120);
  const stallBoost = clamp(runtime?.stallBoostPwm ?? 0, 0, 60);
  // 通常は limits.maxPwm(<=170) 上限、スタック検知時(stallBoost > 0)のみ最大215まで段階ブーストを許可
  const effectiveMaxPwm = stallBoost > 0 ? STALL_BOOST_MAX_PWM : limits.maxPwm;
  // 校正済み minDrivePwm を尊重しつつ、115PWMソフトスタートから確実に動き出せる最低フロア(125)を確保
  const effectiveMinPwm = Math.min(limits.maxPwm, Math.max(125, limits.minPwm));
  // 電池低下時(speedScale < 1.0)は必要な出力を少し補い、過速時(speedScale > 1.0)は抑える。静止摩擦スタック時は stallBoost を加算。
  const adaptiveBoost = Math.round((1.0 - speedScale) * 14) + stallBoost;
  const highFps = (runtime?.cameraFps ?? 0) >= 4;

  let phase: DrivePhase;
  let targetPwm: number;
  let durationMs: number;
  let continuous = false;

  if (posErrMm <= cruiseExitMm || useReverse) {
    // ① クリープ走行領域（<= cruiseExitMm、または近距離後進微調整）：
    // 静止摩擦突破フロア(28ms)＋速度正規化距離スケーリングで、40mm不感帯を飛び越えず1〜2歩で収束させる
    phase = "creep";
    const creepBoost = clamp(stallBoost, 0, 35);
    targetPwm = clamp(effectiveMinPwm + Math.round((1.0 - speedScale) * 14) + creepBoost, effectiveMinPwm, Math.min(effectiveMaxPwm, 195));
    const rampUpMs = Math.ceil(Math.max(0, targetPwm - 115) / 14) * 10;
    const creepEffSpeedMmS = Math.max(130, limits.maxSpeedMmS * speedScale);
    const speedRatio = clamp(200 / creepEffSpeedMmS, 0.55, 1.15);
    const distFrac = clamp((posErrMm - POS_DEAD_MM) / Math.max(40, cruiseExitMm - POS_DEAD_MM), 0, 1);
    const holdMs = Math.round(clamp(18 + (16 + 30 * distFrac) * speedRatio, 28, 60));
    durationMs = Math.min(115, rampUpMs + holdMs);
  } else if (highFps) {
    // ② 案A：高FPS時（>= 4fps）のスムーズ連続巡航（残り > cruiseExitMm は完全停止を挟まず滑らかに走行）
    // ESP32側には安全のため 400ms の自律停止タイマーを毎回付与し、走行中リフレッシュする
    const isApproach = posErrMm < dynamicSlowRadiusMm;
    phase = isApproach ? "decelerate" : "cruise";
    const baseRatio = isApproach
      ? clamp((posErrMm - cruiseExitMm) / Math.max(60, dynamicSlowRadiusMm - cruiseExitMm), 0.0, 0.65)
      : clamp(goal.speedMmS / Math.max(60, limits.maxSpeedMmS), 0.35, 0.9);
    const ratio = consecutiveSteps === 0 ? Math.min(0.35, baseRatio) : baseRatio;
    targetPwm = Math.round(
      clamp(effectiveMinPwm + (limits.maxPwm - effectiveMinPwm) * ratio + adaptiveBoost, effectiveMinPwm, effectiveMaxPwm)
    );
    durationMs = 400;
    continuous = true;
  } else {
    // ③ 案B：低FPS時（< 4fps）の安全フィードフォワード長ストローク（残り距離の約75%を1回で運び、最大420msで自律停止）
    const isApproach = posErrMm < dynamicSlowRadiusMm;
    phase = isApproach ? "decelerate" : (consecutiveSteps === 0 ? "softStart" : "cruise");
    const baseRatio = isApproach
      ? clamp((posErrMm - cruiseExitMm) / Math.max(60, dynamicSlowRadiusMm - cruiseExitMm), 0.15, 0.75)
      : clamp(goal.speedMmS / Math.max(60, limits.maxSpeedMmS), 0.35, 0.9);
    const ratio = consecutiveSteps === 0 ? Math.min(0.35, baseRatio) : baseRatio;
    targetPwm = Math.round(
      clamp(effectiveMinPwm + (limits.maxPwm - effectiveMinPwm) * ratio + adaptiveBoost, effectiveMinPwm, effectiveMaxPwm)
    );
    const effectiveSpeedMmS = Math.max(60, limits.maxSpeedMmS * speedScale);
    const brakeMm = Math.max(40, calibratedBrakeMm);
    const runnableDistMm = Math.max(25, posErrMm - brakeMm - 15);
    const ffMs = ((runnableDistMm * 0.75) / effectiveSpeedMmS) * 1000;
    durationMs = Math.round(clamp(ffMs, 140, 420));
  }

  // 左右モーター特性差（事前校正トリム＋走行中のリアルタイム自動学習トリム）の適用
  const totalTrimRatio = clamp(
    (calibration?.leftRightTrimRatio ?? 0) + (runtime?.dynamicTrimRatio ?? 0),
    -0.2,
    0.2
  );
  const trimOffset = (targetPwm * totalTrimRatio) / 2;

  // 角度不感帯(±6°)を保ちつつ、連続巡航中は緩やかな車線維持(±9 PWM)、クリープ中は±2 PWMに抑制
  const maxSteer = phase === "creep" ? 2 : (continuous ? 9 : 4);
  const effectiveSteerErr = Math.abs(bearingErr) <= 6 ? 0 : bearingErr;
  const steer = clamp(effectiveSteerErr * 0.25, -maxSteer, maxSteer);
  const minWheel = Math.max(115, effectiveMinPwm - 8);

  let left: number;
  let right: number;
  const cmd: DriveCommand = useReverse ? "b" : "a";

  // カメラ座標系(+Y下向き)では、前進時に L > R で yaw 増加(+)、R > L で yaw 減少(-)となる
  if (useReverse) {
    left = Math.round(clamp(targetPwm - trimOffset - steer, minWheel, effectiveMaxPwm));
    right = Math.round(clamp(targetPwm + trimOffset + steer, minWheel, effectiveMaxPwm));
  } else {
    left = Math.round(clamp(targetPwm - trimOffset + steer, minWheel, effectiveMaxPwm));
    right = Math.round(clamp(targetPwm + trimOffset - steer, minWheel, effectiveMaxPwm));
  }

  let candidateDrive: Drive = { cmd, speedL: left, speedR: right, durationMs, continuous };

  // ⑤ 走行指示前の軌道予測と予測型ジオフェンス検証
  const prediction = predictTrajectory(pose, candidateDrive, calibration, runtime);
  if (runtime?.field) {
    const fw = runtime.field.widthMm;
    const fh = runtime.field.heightMm;
    // 軸別の境界逸脱判定（長辺方向で中心距離が減りつつ壁外へ出る斜め移動も確実に検知する）
    const movingOutward =
      (prediction.endX < GEOFENCE_SAFE_MARGIN_MM && prediction.endX < pose.x - 1) ||
      (prediction.endX > fw - GEOFENCE_SAFE_MARGIN_MM && prediction.endX > pose.x + 1) ||
      (prediction.endY < GEOFENCE_SAFE_MARGIN_MM && prediction.endY < pose.y - 1) ||
      (prediction.endY > fh - GEOFENCE_SAFE_MARGIN_MM && prediction.endY > pose.y + 1);

    if (!prediction.insideSafeZone && movingOutward) {
      // 予測停止位置が絶対防衛ラインを超える場合、連続巡航を禁止し最短クリープ短パルスで安全領域内に収まるか再試行
      const safePwm = Math.round(clamp(effectiveMinPwm + clamp(stallBoost, 0, 35), effectiveMinPwm, effectiveMaxPwm));
      const safeRampMs = Math.ceil(Math.max(0, safePwm - 115) / 14) * 10;
      const safeDur = Math.min(70, safeRampMs + 16);
      const safeCreepDrive: Drive = {
        cmd,
        speedL: safePwm,
        speedR: safePwm,
        durationMs: safeDur,
        continuous: false,
      };
      const creepPred = predictTrajectory(pose, safeCreepDrive, calibration, runtime);
      if (creepPred.insideSafeZone) {
        return { ...base, drive: safeCreepDrive, phase: "creep", prediction: creepPred };
      }
      // それでも安全境界を超える場合はコマンド送信前に緊急停止に置換
      return { ...base, drive: STOP, phase: "geofenceBrake", prediction };
    }

    // 軸別減速ゾーン判定：実際に170mm以内の壁に向かって明確に接近(>15mm)している場合のみ連続巡航を解除
    const approachingSlowWall =
      (prediction.endX < GEOFENCE_SLOW_MARGIN_MM && prediction.endX < pose.x - 15) ||
      (prediction.endX > fw - GEOFENCE_SLOW_MARGIN_MM && prediction.endX > pose.x + 15) ||
      (prediction.endY < GEOFENCE_SLOW_MARGIN_MM && prediction.endY < pose.y - 15) ||
      (prediction.endY > fh - GEOFENCE_SLOW_MARGIN_MM && prediction.endY > pose.y + 15);

    if (approachingSlowWall && phase !== "creep") {
      // 外周減速ゾーンに向かう場合は連続巡航を解除し、安全なクリープ速度へ減速（スタック自動ブーストは維持）
      const slowCapPwm = Math.round(clamp(Math.max(145, limits.minPwm + 12) + clamp(stallBoost, 0, 25), limits.minPwm, effectiveMaxPwm));
      candidateDrive = {
        cmd,
        speedL: Math.min(left, slowCapPwm),
        speedR: Math.min(right, slowCapPwm),
        durationMs: Math.min(durationMs, 95),
        continuous: false,
      };
      phase = "creep";
    }
  }

  return { ...base, drive: candidateDrive, phase, prediction };
}
