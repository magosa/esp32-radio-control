import { expect, test, type Page } from "@playwright/test";
import { connectRobot, exhibitCommand, startLocalizer } from "./fleet-sim";
import { cellsOf, openSeeded, pixelAt, seedMap } from "./helpers";
import { act, track } from "./timeline-fixture";

test.describe.configure({ mode: "serial" });

const VIEW = { width: 1280, height: 720 };
const FIELD = { width: 1106.93, height: 622.65 };
const SCALE = VIEW.width / FIELD.width;
const room = { id: "r1", name: "会議室", color: "#8d9bff", kind: "room", material: "wood", cells: cellsOf(2, 2, 50, 28) };
const ROBOT_ID = "robot-e2e1";

const exhibitMap = () => seedMap({
  id: "map-exhibit", name: "展示用マップ", rooms: [room],
  presentation: { version: 1, scenarioId: "e2e", cues: [
    { kind: "zone", start: 0, end: 60, label: "ゾーン", color: "#58d8ca", x: 60, y: 60, width: 220, height: 120 },
    { kind: "notice", start: 0, end: 60, label: "お知らせです", color: "#ff9a3d" },
  ] },
  tracks: [
    track("rb", "robot", "ロボット 1", "#8d9bff", [
      act("sh", "ラベル", "show", 0, 1, { text: "R1 label", x: 210, y: 310 }),
      act("mv", "移動", "move", 2, 4, { x: 410, y: 310 }),
    ], { initial: { x: 210, y: 310, yaw: 0, roomId: "r1" }, robotId: ROBOT_ID, robotRole: "cleaning" }),
    track("hm", "human", "人 1", "#58d8ca", [act("hs", "ラベル", "show", 0, 1, { text: "H label", x: 110, y: 110 })],
      { initial: { x: 110, y: 110, yaw: 0, roomId: "r1" }, count: 1 }),
  ],
});

const exhibitPage = async (page: Page, query = "") => {
  await page.setViewportSize(VIEW);
  await page.goto(`/exhibit${query}`);
  await expect(page.locator('svg[aria-label="展示画面"]')).toBeVisible();
};
const textBox = (page: Page, text: string) => page.evaluate((value) => {
  const node = Array.from(document.querySelectorAll("svg text")).find((item) => item.textContent === value);
  const rect = node?.parentElement?.querySelector("rect")?.getBoundingClientRect();
  return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
}, text);

let robot: Awaited<ReturnType<typeof connectRobot>>;
let camera: Awaited<ReturnType<typeof startLocalizer>> | null = null;

test.beforeAll(async () => {
  robot = await connectRobot("e2e1", 0);
});
test.afterAll(() => { robot?.close(); });
test.beforeEach(async () => { await exhibitCommand({ type: "close" }); });
test.afterEach(() => { camera?.close(); camera = null; });

async function openExhibitControls(page: Page) {
  await openSeeded(page, [exhibitMap()], 1280);
  await page.getByRole("button", { name: "展示 ▾" }).click();
}

async function showOnExhibit(page: Page) {
  await openExhibitControls(page);
  await page.getByRole("button", { name: "この地図を展示に出す" }).click();
  await expect(page.getByRole("group", { name: "展示" }).getByRole("status")).toContainText("展示中: 展示用マップ");
}

test("with nothing selected the exhibit is black, apart from a dim waiting message", async ({ page }) => {
  await exhibitPage(page);
  await expect(page.locator('[data-state="idle"]')).toBeVisible();
  await expect(page.getByText("展示待機中")).toBeVisible({ timeout: 30_000 }); // the first load compiles the page
  for (const [x, y] of [[4, 4], [VIEW.width - 4, 4], [4, VIEW.height - 4], [VIEW.width - 4, VIEW.height - 4], [200, 600]]) {
    expect(await pixelAt(page, x, y)).toEqual([0, 0, 0]);
  }
});

test("the operator sends a map to the exhibit; the screen shows it without the robot's body", async ({ page, context }) => {
  const screen = await context.newPage();
  await exhibitPage(screen);
  await showOnExhibit(page);
  await expect(screen.locator('[data-state="playing"]')).toBeVisible();
  await expect(screen.getByText("展示待機中")).toHaveCount(0);
  await expect(screen.locator('rect[fill="#0b3350"]')).toHaveCount(0);
  await expect(page.locator('rect[fill="#0b3350"]').first()).toBeVisible();
  await expect(screen.locator('[data-scenario-cue="zone"]')).toHaveCount(1);
  await expect(screen.locator('[data-scenario-cue="notice"]')).toHaveCount(1);
  await expect(screen.getByText("H label")).toBeVisible();
  await screen.screenshot({ path: "test-results/exhibit-map.png" });
});

test("the map fills the surface from its bottom-left corner and the strip beyond it stays black", async ({ page, context }) => {
  const screen = await context.newPage();
  await exhibitPage(screen);
  await showOnExhibit(page);
  await expect(screen.locator('[data-state="playing"]')).toBeVisible();
  const [r, g, b] = await pixelAt(screen, 640, 360);
  expect(r + g + b).toBeGreaterThan(150);
  expect(await pixelAt(screen, VIEW.width - 2, 360)).toEqual([0, 0, 0]);
  const [rr, gg, bb] = await pixelAt(screen, VIEW.width - Math.round(3 * SCALE) - 6, 360);
  expect(rr + gg + bb).toBeGreaterThan(0);
});

test("the four corners stay blank around the reference markers", async ({ page, context }) => {
  const screen = await context.newPage();
  await exhibitPage(screen);
  await showOnExhibit(page);
  await expect(screen.locator('[data-state="playing"]')).toBeVisible();
  const clearance = Math.round((33 + 40) * SCALE);
  for (const [x, y] of [[8, 8], [VIEW.width - 8, 8], [8, VIEW.height - 8], [VIEW.width - 8, VIEW.height - 8],
    [clearance - 6, clearance - 6], [VIEW.width - clearance + 6, VIEW.height - clearance + 6]]) {
    expect(await pixelAt(screen, x, y), `${x},${y}`).toEqual([0, 0, 0]);
  }
  const [r, g, b] = await pixelAt(screen, clearance + 40, clearance + 40);
  expect(r + g + b).toBeGreaterThan(150);
});

test("play and pause follow the Hub; the screen's clock advances only while playing", async ({ page, context }) => {
  const screen = await context.newPage();
  await exhibitPage(screen);
  await showOnExhibit(page);
  const clock = async () => Number(await screen.locator("[data-time]").getAttribute("data-time"));
  expect(await clock()).toBe(0);
  await page.getByRole("button", { name: "展示を再生" }).click();
  await expect.poll(clock).toBeGreaterThan(0.8);
  await page.getByRole("button", { name: "展示を一時停止" }).click();
  const paused = await clock();
  await page.waitForTimeout(800);
  expect(await clock()).toBe(paused);
  await page.getByRole("button", { name: "展示を先頭へ" }).click();
  await expect.poll(clock).toBe(0);
  await page.getByRole("button", { name: "展示を終了" }).click();
  await expect(screen.locator('[data-state="idle"]')).toBeVisible();
  await expect(page.getByRole("group", { name: "展示" }).getByRole("status")).toContainText("未選択");
});

test("a robot's label is drawn at the position the camera measures, and goes when the robot is lost", async ({ page, context }) => {
  camera = await startLocalizer();
  camera.set(0, { x: 800, y: 450, yawDeg: 0 });
  const screen = await context.newPage();
  await exhibitPage(screen);
  await showOnExhibit(page);
  await expect.poll(() => textBox(screen, "R1 label")).not.toBeNull();
  const at = (await textBox(screen, "R1 label"))!;
  expect(Math.abs(at.x - (553.465 * SCALE))).toBeLessThan(3);
  expect(Math.abs(at.y - (311.325 * SCALE))).toBeLessThan(3);
  expect(await textBox(screen, "H label")).not.toBeNull();
  await expect(screen.locator('rect[fill="#0b3350"]')).toHaveCount(0); // a tracked robot is still not drawn
  camera.set(0, null);
  await expect.poll(() => textBox(screen, "R1 label"), { timeout: 5000 }).toBeNull();
  expect(await textBox(screen, "H label")).not.toBeNull();
});

test("room activity appears where the robot is measured, and not for a robot that is not tracked", async ({ page, context }) => {
  const screen = await context.newPage();
  await exhibitPage(screen);
  await showOnExhibit(page);
  await expect(screen.locator('[data-state="playing"]')).toBeVisible();
  await expect(screen.getByText("掃除中")).toHaveCount(0);
  camera = await startLocalizer();
  camera.set(0, { x: 800, y: 450, yawDeg: 0 });
  await expect(screen.getByText("掃除中")).toBeVisible();
});

test("the position check shows each tracked robot's offset from the nearest cross", async ({ page, context }) => {
  camera = await startLocalizer();
  camera.set(0, { x: 800, y: 450, yawDeg: 0 });
  const screen = await context.newPage();
  await exhibitPage(screen, "?align=1");
  await expect(screen.locator('[data-part="alignment"]')).toBeVisible();
  await expect(screen.locator('[data-part="alignment-offset"]')).toContainText("十字(600, 300)");
  await expect(screen.locator('[data-part="alignment-offset"]')).toContainText("dx -46.5");
  await expect(screen.locator('[data-part="alignment-offset"]')).toContainText("dy +11.3");
  await screen.screenshot({ path: "test-results/exhibit-align.png" });
  await screen.keyboard.press("a");
  await expect(screen.locator('[data-part="alignment"]')).toHaveCount(0);
});

test("a 1920 x 1080 screen draws at the same scale on both axes", async ({ page, context }) => {
  const screen = await context.newPage();
  await screen.setViewportSize({ width: 1920, height: 1080 });
  await screen.goto("/exhibit");
  await showOnExhibit(page);
  await expect(screen.locator('[data-state="playing"]')).toBeVisible();
  const box = await screen.locator('svg[aria-label="展示画面"]').boundingBox();
  expect(box!.width).toBeCloseTo(1920, 0);
  expect(box!.height).toBeCloseTo(1080, 0);
  const sx = 1920 / FIELD.width, sy = 1080 / FIELD.height;
  expect(Math.abs(sx - sy)).toBeLessThan(0.001);
});

test("an operator's mistakes are reported, not silent", async ({ page }) => {
  await openExhibitControls(page);
  const controls = page.getByRole("group", { name: "展示" });
  await expect(controls.getByRole("button", { name: "展示を再生" })).toBeDisabled();
  await expect(controls.getByRole("button", { name: "展示を終了" })).toBeDisabled();
  expect((await exhibitCommand({ type: "play" })).ok).toBe(false);
  expect((await exhibitCommand({ type: "seek", time: -3 })).ok).toBe(false);
});

test("the blank corner margin can be changed or switched off from the address", async ({ page, context }) => {
  const screen = await context.newPage();
  await exhibitPage(screen, "?clear=0");
  await showOnExhibit(page);
  await expect(screen.locator('[data-state="playing"]')).toBeVisible();
  await expect(screen.locator('[data-part="marker-clearance"]').first()).toHaveAttribute("width", "0");
  const [r, g, b] = await pixelAt(screen, 8, VIEW.height - 8);
  expect(r + g + b).toBeGreaterThan(150);
  await screen.goto("/exhibit?clear=oops");
  await expect(screen.locator('[data-part="marker-clearance"]').first()).toHaveAttribute("width", "73");
  await screen.goto("/exhibit?clear=100");
  await expect(screen.locator('[data-part="marker-clearance"]').first()).toHaveAttribute("width", "100");
});

test("the notice bar stays inside the blank corners", async ({ page, context }) => {
  const screen = await context.newPage();
  await exhibitPage(screen);
  await showOnExhibit(page);
  const bar = screen.locator('[data-scenario-cue="notice"] rect');
  await expect(bar).toHaveCount(1);
  const box = (await bar.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(73 * SCALE - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(VIEW.width - 73 * SCALE + 1);
});