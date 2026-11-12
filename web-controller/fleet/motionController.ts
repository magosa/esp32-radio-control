import type { DriveCommand } from "./protocol";
import { normalizeYaw, shortestTurn } from "../scene/units";

export interface Pose { x: number; y: number; yaw: number }

export interface Goal extends Pose {
  // Turn on the spot to `yaw`; the position is ignored.
  rotate: boolean;
  // Planned travel speed (mm/s), distance divided by the bar length.
  speedMmS: number;
}

export interface Drive { cmd: DriveCommand; speedL: number; speedR: number }

export interface Control {
  drive: Drive;
  posErrMm: number;
  // Signed: positive means the robot must turn counter-clockwise.
  yawErrDeg: number;
}

export const STOP: Drive = { cmd: "e", speedL: 0, speedR: 0 };

// shortcut: fixed speed/PWM figures until S7 measures the real robot, then replace with the calibration.
export const DRIVE_LIMITS = { maxSpeedMmS: 200, minPwm: 80, maxPwm: 220, minTurnPwm: 80, maxTurnPwm: 200 };
// Inside these the robot stops commanding; arrival (20 mm / 5 deg) is judged by the runner with a margin above them.
const POS_DEAD_MM = 10;
const YAW_DEAD_DEG = 3;
const TURN_FIRST_DEG = 25;
const STEER_GAIN = 2.2;
const SLOW_RADIUS_MM = 100;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function spin(err: number): Drive {
  const pwm = Math.round(clamp(60 + Math.abs(err) * 1.5, DRIVE_LIMITS.minTurnPwm, DRIVE_LIMITS.maxTurnPwm));
  return { cmd: err > 0 ? "c" : "d", speedL: pwm, speedR: pwm };
}

export function control(pose: Pose, goal: Goal): Control {
  const dx = goal.x - pose.x, dy = goal.y - pose.y;
  const posErrMm = goal.rotate ? 0 : Math.hypot(dx, dy);
  const yawErrDeg = shortestTurn(pose.yaw, goal.yaw);
  const base = { posErrMm, yawErrDeg };
  if (goal.rotate || posErrMm <= POS_DEAD_MM) {
    return { ...base, drive: Math.abs(yawErrDeg) <= YAW_DEAD_DEG ? STOP : spin(yawErrDeg) };
  }
  const bearing = normalizeYaw(Math.atan2(dy, dx) * 180 / Math.PI);
  const bearingErr = shortestTurn(pose.yaw, bearing);
  if (Math.abs(bearingErr) > TURN_FIRST_DEG) return { ...base, drive: spin(bearingErr) };
  const speed = Math.min(goal.speedMmS, Math.max(40, posErrMm * 1.5));
  const slowed = posErrMm < SLOW_RADIUS_MM ? speed : goal.speedMmS;
  const pwm = clamp(Math.round(slowed / DRIVE_LIMITS.maxSpeedMmS * 255), DRIVE_LIMITS.minPwm, DRIVE_LIMITS.maxPwm);
  const steer = bearingErr * STEER_GAIN;
  const left = Math.round(clamp(pwm - steer, 0, 255)), right = Math.round(clamp(pwm + steer, 0, 255));
  return { ...base, drive: { cmd: "a", speedL: left, speedR: right } };
}
