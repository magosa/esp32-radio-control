import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CalibrationRunner, type CalibrationDeps, type CalibrationPose } from "../fleet/calibration";
import { control, GEOFENCE_SAFE_MARGIN_MM, predictTrajectory } from "../fleet/motionController";
import { SceneRunner } from "../fleet/sceneRunner";
import type { DriveCommand, CalibrationProgressMessage, RobotMotionCalibration } from "../fleet/protocol";

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
    assert.equal(typeof result.leftRightTrimRatio, "number");
    assert.equal(typeof result.brakingDistanceMm, "number");
    assert.equal(typeof result.creepPulseMs, "number");
    assert.equal(typeof result.creepStepMm, "number");
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

  it("applies soft-start, creep mode, trim compensation, and geofence protection for calibrated real robots", () => {
    const cal: RobotMotionCalibration = {
      calibratedAt: 1000,
      minDrivePwm: 160,
      maxDrivePwm: 180,
      speedMmS: 120,
      minTurnPwm: 155,
      maxTurnPwm: 165,
      turnRateLeftDegS: 160,
      turnRateRightDegS: 160,
      yawOffsetDeg: 0,
      leftRightTrimRatio: 0.05,
      brakingDistanceMm: 25,
      creepPulseMs: 60,
      creepStepMm: 12,
    };
    const field = { widthMm: 1100, heightMm: 620 };

    // 1. ソフトスタート検証: 距離300mmでも走り出し1歩目(consecutiveLinearSteps=0)はフルスロットル(180)ではなく低速ランプアップから始まる
    const step0 = control(
      { x: 300, y: 310, yaw: 0 },
      { x: 600, y: 310, yaw: 0, rotate: false, speedMmS: 120 },
      cal,
      { consecutiveLinearSteps: 0, field }
    );
    const step3 = control(
      { x: 300, y: 310, yaw: 0 },
      { x: 600, y: 310, yaw: 0, rotate: false, speedMmS: 120 },
      cal,
      { consecutiveLinearSteps: 3, field }
    );
    assert.equal(step0.phase, "softStart");
    assert.equal(step3.phase, "cruise");
    const meanPwm0 = (step0.drive.speedL + step0.drive.speedR) / 2;
    const meanPwm3 = (step3.drive.speedL + step3.drive.speedR) / 2;
    assert.ok(meanPwm0 < meanPwm3, `soft-start PWM (${meanPwm0}) must be lower than cruise PWM (${meanPwm3})`);
    // 左右トリム(leftRightTrimRatio = +0.05)により右モーターが左モーターより強く出力されること
    assert.ok(step3.drive.speedR > step3.drive.speedL, `trim should boost right wheel: L=${step3.drive.speedL}, R=${step3.drive.speedR}`);

    // 2. クリープモード検証: 目標まで50mmの近距離では極短パルス(<=85ms)＋最小駆動PWM付近のcreepフェーズになること
    const creepCtrl = control(
      { x: 550, y: 310, yaw: 0 },
      { x: 600, y: 310, yaw: 0, rotate: false, speedMmS: 120 },
      cal,
      { consecutiveLinearSteps: 4, field }
    );
    assert.equal(creepCtrl.phase, "creep");
    assert.ok((creepCtrl.drive.durationMs ?? 100) <= 85, `creep pulse must be short, got ${creepCtrl.drive.durationMs}`);

    // 3. 予測型ジオフェンス検証: フィールド端(x=145mm, 左向き180°)からさらに外周(x=20mm)へ向かおうとしても、
    // 絶対防衛ライン(GEOFENCE_SAFE_MARGIN_MM=130mm)を超えるためコマンド送信前にソフトストップ停止に置換されること
    const edgeCtrl = control(
      { x: 145, y: 310, yaw: 180 },
      { x: 20, y: 310, yaw: 180, rotate: false, speedMmS: 120 },
      cal,
      { consecutiveLinearSteps: 2, field, cameraLatencyMs: 120 }
    );
    assert.equal(edgeCtrl.drive.cmd, "e", "geofence predictor must block outward drive near field boundary");
  });

  it("simulates a real robot with inertia, latency, battery drop, and wheel asymmetry without overshooting or leaving safe zone", () => {
    const cal: RobotMotionCalibration = {
      calibratedAt: 1000,
      minDrivePwm: 160,
      maxDrivePwm: 180,
      speedMmS: 120,
      minTurnPwm: 155,
      maxTurnPwm: 165,
      turnRateLeftDegS: 160,
      turnRateRightDegS: 160,
      yawOffsetDeg: 0,
      leftRightTrimRatio: 0,
      brakingDistanceMm: 22,
      creepPulseMs: 60,
      creepStepMm: 12,
    };

    // 物理特性シミュレータ（電池低下係数0.82、左曲がり癖+6 deg/s、停止後の惰走滑り付き）
    let now = 10_000;
    let x = 450, y = 310, yaw = 0;
    let lastDrive = { cmd: "e" as DriveCommand, speedL: 0, speedR: 0, durationMs: 0 };
    let driveSentAt = 0;
    const batteryScale = 0.82;
    const naturalDriftDegS = 6.0;

    const runner = new SceneRunner({
      now: () => now,
      sendDrive: (_id, d) => {
        lastDrive = { cmd: d.cmd, speedL: d.speedL, speedR: d.speedR, durationMs: d.durationMs ?? 120 };
        driveSentAt = now;
      },
    });

    // 意図的にフィールド端ギリギリ (x=50, y=310) を目標にしたマップを与え、安全境界内で止まるか検証
    const map = {
      id: "m-phys",
      name: "phys-test",
      editGridMm: 20,
      doorMode: "story",
      floorPlan: { doors: [], furniture: [], walls: [] },
      rooms: [{ id: "r1", name: "arena", color: "#60a5fa", kind: "room", material: "tile", cells: Array.from({ length: 55 * 31 }, (_, i) => i) }],
      tracks: [{
        id: "t0",
        name: "RealBot0",
        kind: "robot",
        robotId: "robot-rc-0",
        color: "#3b82f6",
        muted: false,
        locked: false,
        initial: { x: 450, y: 310, yaw: 0, roomId: "r1" },
        actions: [{
          id: "act1",
          name: "EdgeApproach",
          type: "move",
          position: 0,
          runSeconds: 4,
          x: 70,
          y: 310,
          yaw: 180,
          roomId: "r1",
          targetId: "tgt1",
          text: "",
          state: "meeting",
        }],
      }],
    } as any;

    assert.equal(runner.prepare(map), null);
    const stepSim = (dtMs: number) => {
      const steps = Math.max(1, Math.round(dtMs / 10));
      const subDt = dtMs / steps;
      for (let s = 0; s < steps; s++) {
        now += subDt;
        const active = lastDrive.cmd !== "e" && (now - driveSentAt <= (lastDrive.durationMs || 120));
        if (active) {
          const dt = subDt / 1000;
          if (lastDrive.cmd === "a" || lastDrive.cmd === "b") {
            const sign = lastDrive.cmd === "b" ? -1 : 1;
            const v = 115 * batteryScale * sign;
            // 左右モーター出力差 + 車体固有の左曲がりドリフト
            const steerTurn = ((lastDrive.speedR - lastDrive.speedL) * 1.8 + naturalDriftDegS) * dt;
            yaw += steerTurn;
            const rad = (yaw * Math.PI) / 180;
            // 惰走分(1.15倍)を含めて移動
            x += v * 1.15 * Math.cos(rad) * dt;
            y += v * 1.15 * Math.sin(rad) * dt;
          } else if (lastDrive.cmd === "c") {
            yaw += 150 * batteryScale * dt;
          } else if (lastDrive.cmd === "d") {
            yaw -= 150 * batteryScale * dt;
          }
        }
      }
      runner.tick({
        poses: {
          type: "poseState",
          localizer: { connected: true, running: true, referenceCount: 4, referenceIds: [40, 41, 42, 43], extrinsicsOk: true, frameAgeMs: 40, fps: 12, latencyMs: 110 },
          field: { cameraHeightMm: 1000, widthMm: 1100, heightMm: 620, referenceSizeMm: 75 },
          poses: [{ robotId: "robot-rc-0", deviceId: "rc-0", markerId: 0, tracking: "tracking", xMm: x, yMm: y, headingDeg: yaw, insideField: true, ageMs: 40 }],
        },
        robots: [{ robotId: "robot-rc-0", driveDeviceId: "rc-0", cameraDeviceId: null, markerId: 0, markerHeightMm: 90, motion: cal }],
        online: () => true,
      });
    };

    stepSim(100);
    assert.equal(runner.start(), null);
    for (let i = 0; i < 350; i++) {
      stepSim(100);
      // どの瞬間も絶対防衛ライン(90mm)を大きく割り込んでフィールド外へ飛び出さないこと
      assert.ok(x >= GEOFENCE_SAFE_MARGIN_MM - 18, `robot must never breach geofence: x=${x.toFixed(1)}mm`);
      if (runner.snapshot().phase === "finished") break;
    }
    assert.equal(runner.snapshot().phase, "finished", `calibrated robot safely finishes clamped goal inside geofence (final x=${x.toFixed(1)}, y=${y.toFixed(1)}, yaw=${yaw.toFixed(1)})`);
  });
});
