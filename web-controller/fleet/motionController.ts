import type { DriveCommand, RobotMotionCalibration } from "./protocol";
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

export interface Drive { cmd: DriveCommand; speedL: number; speedR: number }

export interface Control {
  drive: Drive;
  posErrMm: number;
  // Signed: positive means the robot must turn counter-clockwise.
  yawErrDeg: number;
}

export const STOP: Drive = { cmd: "e", speedL: 0, speedR: 0 };

// Default torque limits for uncalibrated / simulated robots.
export const DRIVE_LIMITS = { maxSpeedMmS: 200, minPwm: 80, maxPwm: 220, minTurnPwm: 80, maxTurnPwm: 200 };
// Inside these the robot stops commanding; arrival (20 mm / 15 deg) is judged by the runner with a margin above them.
const POS_DEAD_MM = 20;
const YAW_DEAD_DEG = 10;
const TURN_FIRST_DEG = 30;
const STEER_GAIN = 1.0;
const SLOW_RADIUS_MM = 100;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function spin(err: number, limits: { minTurnPwm: number; maxTurnPwm: number; isCalibrated: boolean }): Drive {
  const basePwm = limits.isCalibrated ? limits.minTurnPwm : 60;
  // 小さな誤差で急加速しないよう緩やかにトルクを付与
  const pwm = Math.round(clamp(basePwm + Math.min(10, Math.abs(err) * 0.3), limits.minTurnPwm, limits.maxTurnPwm));
  // Hardware-verified: on this vehicle chassis, 'c' turns counter-clockwise (left, err > 0) and 'd' turns clockwise (right, err < 0)
  return { cmd: err > 0 ? "c" : "d", speedL: pwm, speedR: pwm };
}

export function control(pose: Pose, goal: Goal, calibration?: RobotMotionCalibration | null): Control {
  const effectiveYaw = calibration ? normalizeYaw(pose.yaw - calibration.yawOffsetDeg) : pose.yaw;
  const isCalibrated = !!calibration;
  const limits = {
    minPwm: calibration?.minDrivePwm ?? DRIVE_LIMITS.minPwm,
    maxPwm: calibration?.maxDrivePwm ?? DRIVE_LIMITS.maxPwm,
    maxSpeedMmS: calibration?.speedMmS ?? DRIVE_LIMITS.maxSpeedMmS,
    minTurnPwm: calibration?.minTurnPwm ?? DRIVE_LIMITS.minTurnPwm,
    maxTurnPwm: calibration?.maxTurnPwm ?? DRIVE_LIMITS.maxTurnPwm,
    isCalibrated,
  };

  const dx = goal.x - pose.x, dy = goal.y - pose.y;
  const posErrMm = goal.rotate ? 0 : Math.hypot(dx, dy);
  const yawErrDeg = shortestTurn(effectiveYaw, goal.yaw);
  const base = { posErrMm, yawErrDeg };
  if (goal.rotate || posErrMm <= POS_DEAD_MM) {
    return { ...base, drive: Math.abs(yawErrDeg) <= YAW_DEAD_DEG ? STOP : spin(yawErrDeg, limits) };
  }

  const bearing = normalizeYaw(Math.atan2(dy, dx) * 180 / Math.PI);
  const forwardBearingErr = shortestTurn(effectiveYaw, bearing);

  // 後進は近距離（80mm以内）で行き過ぎて背後にある場合の戻り微調整に限定
  // 長距離（>80mm）は目標方向へ回頭して前進する
  const reverseCandidate = goal.allowReverse ? (posErrMm <= 80) : false;
  const useReverse = reverseCandidate && Math.abs(forwardBearingErr) > 90;
  const bearingErr = useReverse
    ? shortestTurn(effectiveYaw, normalizeYaw(bearing + 180))
    : forwardBearingErr;

  if (Math.abs(bearingErr) > TURN_FIRST_DEG) return { ...base, drive: spin(bearingErr, limits) };

  const speed = Math.min(goal.speedMmS, Math.max(40, posErrMm * 1.5));
  const slowed = posErrMm < SLOW_RADIUS_MM ? speed : goal.speedMmS;
  let pwm: number;
  if (isCalibrated) {
    const ratio = Math.min(1, Math.max(0, (posErrMm - POS_DEAD_MM) / (SLOW_RADIUS_MM - POS_DEAD_MM)));
    pwm = Math.round(limits.minPwm + (limits.maxPwm - limits.minPwm) * ratio);
  } else {
    pwm = clamp(Math.round(slowed / DRIVE_LIMITS.maxSpeedMmS * 255), DRIVE_LIMITS.minPwm, DRIVE_LIMITS.maxPwm);
  }

  const steer = bearingErr * STEER_GAIN;
  const minWheel = isCalibrated ? Math.round(limits.minPwm * 0.85) : 0;

  if (useReverse) {
    const left = Math.round(clamp(pwm + steer, minWheel, limits.maxPwm));
    const right = Math.round(clamp(pwm - steer, minWheel, limits.maxPwm));
    return { ...base, drive: { cmd: "b", speedL: left, speedR: right } };
  } else {
    const left = Math.round(clamp(pwm - steer, minWheel, limits.maxPwm));
    const right = Math.round(clamp(pwm + steer, minWheel, limits.maxPwm));
    return { ...base, drive: { cmd: "a", speedL: left, speedR: right } };
  }
}
