import path from "path";
import assert from "node:assert/strict";
import { SceneHistoryStore } from "../fleet/sceneHistoryStore";
import { SceneRunner } from "../fleet/sceneRunner";
import { SimRobot } from "./simRobot";
import type { DriveCommand, PoseStateMessage, RobotDefinition, RobotPoseState } from "../fleet/protocol";

async function main() {
  const historyDir = path.join(process.cwd(), "data", "scene-history");
  const store = SceneHistoryStore.open(historyDir);
  const latest = store.latest();
  store.close();

  if (!latest) throw new Error("No latest project");
  const map = latest.project.maps.find((m) => m.id === "map-quad-and-spiral");
  if (!map) throw new Error("Test map not found");

  console.log(`Testing scenario: ${map.name}`);

  let nowMs = 1000;
  const robot0 = new SimRobot(450, 310, 0);
  const robot1 = new SimRobot(650, 310, 0);

  const driveCommands: Record<string, { cmd: DriveCommand; speedL: number; speedR: number }> = {
    "rc-a5f848": { cmd: "e", speedL: 0, speedR: 0 },
    "rc-a50a28": { cmd: "e", speedL: 0, speedR: 0 },
  };

  const runner = new SceneRunner({
    now: () => nowMs,
    sendDrive: (devId, drive) => {
      driveCommands[devId] = drive;
      if (devId === "rc-a5f848") robot0.command(drive.cmd, drive.speedL, drive.speedR, nowMs);
      if (devId === "rc-a50a28") robot1.command(drive.cmd, drive.speedL, drive.speedR, nowMs);
    },
  });

  const prepareErr = runner.prepare(map);
  if (prepareErr) throw new Error(`Prepare failed: ${prepareErr}`);

  const robots: RobotDefinition[] = [
    { robotId: "robot-rc-a5f848", driveDeviceId: "rc-a5f848", cameraDeviceId: null, markerId: 0, markerHeightMm: 90 },
    { robotId: "robot-rc-a50a28", driveDeviceId: "rc-a50a28", cameraDeviceId: null, markerId: 1, markerHeightMm: 90 },
  ];

  const getPoses = (): PoseStateMessage => ({
    type: "poseState",
    localizer: { connected: true, running: true, camera: "test", referenceCount: 4, referenceIds: [40, 41, 42, 43], extrinsicsOk: true, frameAgeMs: 20, fps: 15, latencyMs: 20 },
    field: { cameraHeightMm: 800, widthMm: 1107, heightMm: 623, referenceSizeMm: 33 },
    poses: [
      { robotId: "robot-rc-a5f848", deviceId: "rc-a5f848", markerId: 0, tracking: "tracking", xMm: robot0.x, yMm: robot0.y, headingDeg: robot0.yaw, insideField: true, ageMs: 20 },
      { robotId: "robot-rc-a50a28", deviceId: "rc-a50a28", markerId: 1, tracking: "tracking", xMm: robot1.x, yMm: robot1.y, headingDeg: robot1.yaw, insideField: true, ageMs: 20 },
    ],
  });

  const step = (dtMs: number) => {
    nowMs += dtMs;
    robot0.step(dtMs, nowMs);
    robot1.step(dtMs, nowMs);
    runner.tick({
      poses: getPoses(),
      robots,
      online: () => true,
    });
  };

  // 1. Initial tick
  step(100);
  console.log("Phase after prepare:", runner.snapshot().phase);

  // 2. Position
  const posErr = runner.position();
  if (posErr) throw new Error(`Position failed: ${posErr}`);

  console.log("Positioning robots to initial...");
  for (let i = 0; i < 50; i++) {
    step(100);
    const snap = runner.snapshot();
    if (snap.canStart) break;
  }
  console.log("Can start after positioning:", runner.snapshot().canStart);
  console.log("Checks:", runner.snapshot().checks);
  assert.equal(runner.snapshot().canStart, true);

  // 3. Start run
  const startErr = runner.start();
  if (startErr) throw new Error(`Start failed: ${startErr}`);

  console.log("Running scenario...");
  let maxSteps = 1000;
  while (maxSteps-- > 0) {
    step(100);
    const snap = runner.snapshot();
    if (snap.phase === "finished" || snap.phase === "aborted" || snap.phase === "halted") {
      console.log(`Run completed with phase: ${snap.phase}, clock: ${snap.clock.toFixed(1)}s`);
      if (snap.phase === "halted") {
        console.error("Halted reason:", snap.reason, "halt:", snap.halt, "alerts:", snap.alerts);
      }
      break;
    }
  }

  const finalSnap = runner.snapshot();
  assert.equal(finalSnap.phase, "finished", `Expected finished but got ${finalSnap.phase}`);
  console.log("Scenario verified successfully! Both robots completed all actions.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
