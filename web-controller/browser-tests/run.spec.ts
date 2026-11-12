import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import { DEFAULT_FIELD_CONFIG } from "../fleet/fieldConfigStore";
import { SimRobot } from "../scripts/simRobot";
import { openSeeded, seedMap } from "./helpers";
import { act, room, track } from "./timeline-fixture";

// One simulated robot: a device socket that obeys drive commands, and a localizer that reports where it is.
async function startSim(port: string) {
  const sim = new SimRobot(110, 110, 0);
  const device = new WebSocket(`ws://localhost:${port}/ws/device`);
  await new Promise((resolve) => device.once("open", resolve));
  device.send(JSON.stringify({ type: "hello", deviceId: "sim0", name: "sim0", fw: "t", capabilities: ["drive", "display"] }));
  device.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "drive") sim.command(m.cmd, m.speedL, m.speedR, Date.now());
  });
  const client = new WebSocket(`ws://localhost:${port}/ws/client`);
  await new Promise((resolve) => client.once("open", resolve));
  client.send(JSON.stringify({ type: "assignMarker", requestId: "m", robotId: "robot-sim0", markerId: 0 }));
  const localizer = new WebSocket(`ws://localhost:${port}/ws/localizer`, { origin: `http://localhost:${port}` });
  await new Promise((resolve) => localizer.once("open", resolve));
  localizer.send(JSON.stringify({ type: "localizerHello", camera: "t", width: 1920, height: 1080 }));
  let frame = 0, last = Date.now(), tick = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    sim.step(now - last, now);
    last = now;
    if (++tick % 2 === 0) {
      localizer.send(JSON.stringify({ type: "poseFrame", frameId: ++frame, capturedAt: now, referenceCount: 4, referenceIds: [40, 41, 42, 43], extrinsicsOk: true,
        markers: [{ markerId: 0, valid: true, x: sim.x / DEFAULT_FIELD_CONFIG.widthMm * 1600, y: sim.y / DEFAULT_FIELD_CONFIG.heightMm * 900, yawDeg: sim.yaw, insideField: true }] }));
      device.send(JSON.stringify({ type: "telemetry", deviceId: "sim0", cmd: "e", speedL: 0, speedR: 0, heap: 1, uptimeMs: 1 }));
    }
  }, 50);
  return () => { clearInterval(timer); device.close(); client.close(); localizer.close(); };
}

test("a scene runs from /run to the end with a simulated robot; the editor is locked meanwhile", async ({ page }, testInfo) => {
  const port = new URL(testInfo.project.use.baseURL ?? "http://localhost:3117").port;
  const stop = await startSim(port);
  try {
    const scene = seedMap({
      id: "run-map", name: "run map", rooms: [room],
      tracks: [track("rb", "robot", "ロボット 1", "#8d9bff", [act("m1", "移動A", "move", 1, 6, { x: 410, y: 110 })],
        { initial: { x: 110, y: 110, yaw: 0, roomId: "r1" }, robotId: "robot-sim0", robotRole: "cleaning" })],
    });
    await openSeeded(page, [scene], 1280);
    await page.goto("/run");
    await page.getByLabel("実行するシーン").selectOption("run-map");
    await expect(page.getByRole("region", { name: "実行前の確認" })).toBeVisible();
    await expect(page.getByRole("button", { name: "開始" })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole("button", { name: "開始" }).click();
    await expect(page.getByText("実行中", { exact: true })).toBeVisible();

    await page.goto("/scenes");
    await expect(page.getByText("シーンを実行中です")).toBeVisible();

    await page.goto("/run");
    await expect(page.getByText("完了", { exact: true })).toBeVisible({ timeout: 40_000 });
    await expect(page.getByRole("region", { name: "動作ごとの結果" }).getByText("到着確認")).toBeVisible();
  } finally {
    stop();
  }
});
