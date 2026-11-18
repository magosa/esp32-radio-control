import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CalibrationRunner, type CalibrationDeps, type CalibrationPose } from "../fleet/calibration";
import type { DriveCommand, CalibrationProgressMessage } from "../fleet/protocol";

class MockRobotContext implements CalibrationDeps {
  currentTime = 1000;
  commands: { cmd: DriveCommand; speedL: number; speedR: number }[] = [];
  progresses: CalibrationProgressMessage[] = [];
  pose: CalibrationPose = { x: 500, y: 300, yaw: 0, tracking: "tracking" };

  now(): number {
    return this.currentTime;
  }

  sendDrive(_deviceId: string, cmd: DriveCommand, speedL: number, speedR: number): void {
    this.commands.push({ cmd, speedL, speedR });
  }

  getPose(_robotId: string): CalibrationPose | null {
    return { ...this.pose };
  }

  async sleep(ms: number): Promise<void> {
    this.currentTime += ms;
    const lastCmd = this.commands[this.commands.length - 1];
    if (lastCmd && lastCmd.cmd !== "e") {
      const dt = ms / 1000;
      if (lastCmd.cmd === "a") {
        // 前進: 100mm/s 相当で移動 (yaw 0° なので +X 方向)
        this.pose.x += 100 * dt;
      } else if (lastCmd.cmd === "c") {
        // 左旋回: 90 deg/s
        this.pose.yaw += 90 * dt;
      } else if (lastCmd.cmd === "d") {
        // 右旋回: 90 deg/s
        this.pose.yaw -= 90 * dt;
      }
    }
  }

  onProgress(progress: CalibrationProgressMessage): void {
    this.progresses.push(progress);
  }
}

describe("CalibrationRunner", () => {
  it("rejects when robot is too close to edge", async () => {
    const ctx = new MockRobotContext();
    ctx.pose.x = 50; // default edge margin is 100mm
    const runner = new CalibrationRunner(ctx);

    await assert.rejects(
      () => runner.run("robot-1", "device-1"),
      /フィールド端に近すぎます/
    );
    assert.equal(ctx.commands[ctx.commands.length - 1].cmd, "e");
  });

  it("completes full calibration cycle with expected figures", async () => {
    const ctx = new MockRobotContext();
    const runner = new CalibrationRunner(ctx);

    const result = await runner.run("robot-1", "device-1");

    assert.ok(result.calibratedAt > 0);
    assert.ok(result.minDrivePwm >= 60 && result.minDrivePwm <= 180);
    assert.ok(result.speedMmS > 50); // mock moves at ~100mm/s
    assert.ok(result.turnRateLeftDegS > 40);
    assert.ok(result.turnRateRightDegS > 40);
    assert.equal(ctx.commands[ctx.commands.length - 1].cmd, "e");

    const steps = ctx.progresses.map((p) => p.step);
    assert.ok(steps.includes("preparing"));
    assert.ok(steps.includes("forward"));
    assert.ok(steps.includes("turnLeft"));
    assert.ok(steps.includes("turnRight"));
    assert.ok(steps.includes("done"));
  });

  it("aborts safely when tracking is lost", async () => {
    const ctx = new MockRobotContext();
    const runner = new CalibrationRunner(ctx);

    // 途中で tracking を stale にする
    const originalSleep = ctx.sleep.bind(ctx);
    ctx.sleep = async (ms: number) => {
      await originalSleep(ms);
      if (ctx.currentTime > 1500) {
        ctx.pose.tracking = "stale";
      }
    };

    await assert.rejects(
      () => runner.run("robot-1", "device-1"),
      /Lost tracking during calibration/
    );
    assert.equal(ctx.commands[ctx.commands.length - 1].cmd, "e");
  });
});
