import { expect, test } from "@playwright/test";
import WebSocket from "ws";

// Eight robots, marker IDs 0..7, all seen in one frame. Self-contained: it talks to the Hub the way real devices and the camera page do.
test.describe.configure({ mode: "serial" });

const PORT = Number(process.env.E2E_PORT ?? 3117);
const HOST = `localhost:${PORT}`;
const COUNT = 8;
const names = Array.from({ length: COUNT }, (_, i) => `e8-${i}`);

const open = (url: string, options: WebSocket.ClientOptions = {}) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(url, options);
  ws.once("open", () => resolve(ws));
  ws.once("error", reject);
});

async function client<T>(run: (send: (message: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>, robots: () => { robotId: string; markerId: number | null }[]) => Promise<T>): Promise<T> {
  const ws = await open(`ws://${HOST}/ws/client`);
  let robots: { robotId: string; markerId: number | null }[] = [];
  const waiting = new Map<string, (result: { ok: boolean; error?: string }) => void>();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "fleetState") robots = msg.robots;
    if (msg.type === "operationResult") waiting.get(msg.requestId)?.(msg);
  });
  await new Promise((r) => setTimeout(r, 300));
  const send = (message: Record<string, unknown>) => new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    const requestId = `e8-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const timer = setTimeout(() => reject(new Error("no operationResult")), 5000);
    waiting.set(requestId, (result) => { clearTimeout(timer); resolve(result); });
    ws.send(JSON.stringify({ ...message, requestId }));
  });
  try { return await run(send, () => robots); } finally { ws.close(); }
}

const clearMarkers = () => client(async (send, robots) => {
  for (const robot of robots()) if (robot.markerId !== null) await send({ type: "assignMarker", robotId: robot.robotId, markerId: null });
});

const devices: WebSocket[] = [];
const timers: NodeJS.Timeout[] = [];
let camera: WebSocket | null = null;

test.beforeAll(async () => {
  for (const name of names) {
    const ws = await open(`ws://${HOST}/ws/device`);
    ws.send(JSON.stringify({ type: "hello", deviceId: name, name, fw: "e2e", capabilities: ["drive"] }));
    timers.push(setInterval(() => ws.send(JSON.stringify({ type: "heartbeat", deviceId: name })), 1000));
    devices.push(ws);
  }
  await new Promise((r) => setTimeout(r, 300));
  await clearMarkers();
  await client(async (send) => {
    for (let id = 0; id < COUNT; id++) {
      const result = await send({ type: "assignMarker", robotId: `robot-${names[id]}`, markerId: id, markerHeightMm: 90 });
      expect(result.ok, `marker ${id}: ${result.error}`).toBe(true);
    }
  });
  camera = await open(`ws://${HOST}/ws/localizer`, { origin: `http://localhost:${PORT}` });
  camera.send(JSON.stringify({ type: "localizerHello", camera: "e2e camera", width: 1920, height: 1080 }));
  let frameId = 0;
  timers.push(setInterval(() => {
    const markers = Array.from({ length: COUNT }, (_, markerId) => ({
      markerId, valid: true, x: 150 + markerId * 190, y: 250 + (markerId % 2) * 400, yawDeg: markerId * 20, insideField: true,
    }));
    camera!.send(JSON.stringify({ type: "poseFrame", frameId: ++frameId, capturedAt: Date.now(), referenceCount: 4,
      referenceIds: [40, 41, 42, 43], extrinsicsOk: true, markers }));
  }, 100));
});

test.afterAll(async () => {
  timers.forEach(clearInterval);
  camera?.close();
  await clearMarkers();
  devices.forEach((ws) => ws.close());
});

test("each of the eight robots can hold one of the eight marker IDs, and an ID in use is not offered twice", async ({ page }) => {
  await page.goto("/robots");
  for (let id = 0; id < COUNT; id++) {
    const select = page.getByLabel(`${names[id]}の測位マーカーID`);
    await expect(select).toHaveValue(String(id), { timeout: 30_000 }); // the first load compiles the page
    await expect(select.locator("option")).toHaveCount(COUNT + 1);
    const taken = select.locator(`option[value="${(id + 1) % COUNT}"]`);
    await expect(taken).toBeDisabled();
    await expect(select.locator(`option[value="${id}"]`)).toBeEnabled();
  }
});

test("a robot can be given marker ID 7 from the page once it is free", async ({ page }) => {
  await page.goto("/robots");
  const first = page.getByLabel(`${names[0]}の測位マーカーID`);
  await first.selectOption("");
  await expect(first).toHaveValue("");
  await page.getByLabel(`${names[7]}の測位マーカーID`).selectOption("");
  await first.selectOption("7");
  await expect(first).toHaveValue("7");
  await expect(page.getByText("保存しました").first()).toBeVisible();
  await page.getByLabel(`${names[7]}の測位マーカーID`).selectOption("0");
  await expect(page.getByLabel(`${names[7]}の測位マーカーID`)).toHaveValue("0");
});

test("the floor map and the pose table show all eight robots at once", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/field");
  const map = page.getByRole("img", { name: "走行領域とロボットの位置" });
  await expect(map.locator("line")).toHaveCount(COUNT, { timeout: 15_000 });
  const rows = page.getByRole("region", { name: "ロボットの位置一覧" }).locator("tbody tr");
  for (let id = 0; id < COUNT; id++) {
    const row = rows.filter({ hasText: names[id] });
    await expect(row).toContainText("追跡中");
  }
  await page.screenshot({ path: "test-results/field-eight.png" });
});
