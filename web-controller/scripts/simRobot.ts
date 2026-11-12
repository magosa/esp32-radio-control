import type { DriveCommand } from "../fleet/protocol";
import { normalizeYaw } from "../scene/units";

// Kinematics of a simulated robot: PWM in, pose out. Real figures come from the S7 calibration.
export const SIM = { maxSpeedMmS: 200, turnRateDegS: 120, failSafeMs: 1000 };

export class SimRobot {
  private cmd: DriveCommand = "e";
  private left = 0;
  private right = 0;
  private commandedAt = 0;

  constructor(public x: number, public y: number, public yaw: number) {}

  command(cmd: DriveCommand, left: number, right: number, nowMs: number): void {
    this.cmd = cmd;
    this.left = left;
    this.right = right;
    this.commandedAt = nowMs;
  }

  // Positive yaw is counter-clockwise; the faster right wheel turns the robot left.
  step(dtMs: number, nowMs: number): void {
    if (nowMs - this.commandedAt > SIM.failSafeMs) this.cmd = "e";
    const dt = dtMs / 1000;
    const mean = (this.left + this.right) / 2 / 255;
    let speed = 0, turn = 0;
    if (this.cmd === "a") { speed = mean * SIM.maxSpeedMmS; turn = (this.right - this.left) / 255 * SIM.turnRateDegS; }
    else if (this.cmd === "b") { speed = -mean * SIM.maxSpeedMmS; turn = (this.left - this.right) / 255 * SIM.turnRateDegS; }
    else if (this.cmd === "c") turn = mean * SIM.turnRateDegS;
    else if (this.cmd === "d") turn = -mean * SIM.turnRateDegS;
    this.yaw = normalizeYaw(this.yaw + turn * dt);
    const rad = this.yaw * Math.PI / 180;
    this.x += speed * Math.cos(rad) * dt;
    this.y += speed * Math.sin(rad) * dt;
  }
}
