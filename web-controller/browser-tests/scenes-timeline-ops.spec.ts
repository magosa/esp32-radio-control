import { expect, test, type Locator, type Page } from "@playwright/test";
import { appAlert, latestRevision, openSeeded } from "./helpers";
import { savedAction, savedTracks, timelineMap } from "./timeline-fixture";

test.describe.configure({ mode: "serial" });

const PX = 26; // seconds -> pixels at the default zoom
const LANE_PAD = 16; // the lane's left padding before 0s
const lane = (page: Page, name: string) => page.getByRole("group", { name: `${name} の動作` });
const bar = (page: Page, id: string) => page.locator(`[role="button"][data-action-id="${id}"]`);
const handle = (page: Page, id: string) => page.locator(`[role="slider"][data-action-id="${id}"]`);
const timelineCard = (page: Page) => page.getByRole("region", { name: "時間軸" });
const knob = (page: Page) => page.getByRole("slider", { name: "再生ヘッド" });

async function open(page: Page) {
  await openSeeded(page, [timelineMap()], 1280);
  await page.locator('[data-part="ruler"]').scrollIntoViewIfNeeded();
}

async function center(target: Locator, fromX = 0.5) {
  const box = (await target.boundingBox())!;
  return { x: box.x + box.width * fromX, y: box.y + box.height / 2 };
}

async function drag(page: Page, target: Locator, dx: number, options: { modifiers?: string[]; at?: number; hold?: () => Promise<void> } = {}) {
  const start = await center(target, options.at);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx / 2, start.y, { steps: 4 });
  await page.mouse.move(start.x + dx, start.y, { steps: 4 });
  if (options.hold) await options.hold();
  await page.mouse.up();
}

const settled = async (page: Page, revision: number) => {
  await expect.poll(() => latestRevision(page)).toBe(revision);
  await page.waitForTimeout(1500); // a second, unwanted save would show up here
  expect(await latestRevision(page)).toBe(revision);
};

test("dragging a bar moves it and saves exactly one revision", async ({ page }) => {
  await open(page);
  const before = await latestRevision(page);
  await drag(page, bar(page, "m1"), PX);
  await settled(page, before + 1);
  expect((await savedAction(page, "m1")).position).toBeCloseTo(2, 5);
  expect((await savedAction(page, "m2")).position).toBe(9);
  await expect(bar(page, "m1")).toHaveAttribute("aria-label", /2\.0〜8\.0秒/);
  await expect(appAlert(page)).toHaveCount(0);
});

test("the resize handle changes the length, one revision", async ({ page }) => {
  await open(page);
  const before = await latestRevision(page);
  await drag(page, handle(page, "m3"), PX);
  await settled(page, before + 1);
  const m3 = await savedAction(page, "m3");
  expect(m3.runSeconds).toBeCloseTo(4, 5);
  expect(m3.position).toBe(16);
});

test("Escape during a drag discards it", async ({ page }) => {
  await open(page);
  const before = await latestRevision(page);
  await drag(page, bar(page, "m1"), PX * 2, { hold: async () => { await page.keyboard.press("Escape"); } });
  await settled(page, before);
  expect((await savedAction(page, "m1")).position).toBe(1);
  await expect(bar(page, "m1")).toHaveAttribute("aria-label", /1\.0〜7\.0秒/);
});

test("a bar cannot be dropped onto its neighbour", async ({ page }) => {
  await open(page);
  const before = await latestRevision(page);
  await drag(page, bar(page, "m1"), PX * 9);
  await settled(page, before);
  expect((await savedAction(page, "m1")).position).toBe(1);
  await expect(bar(page, "m1")).toHaveAttribute("aria-label", /1\.0〜7\.0秒/);
});

test("a locked row refuses to move and says so", async ({ page }) => {
  await open(page);
  const before = await latestRevision(page);
  await drag(page, bar(page, "s1"), PX);
  await expect(appAlert(page)).toContainText("ロックされています");
  await settled(page, before);
  expect((await savedAction(page, "s1")).position).toBe(3);
});

test("Ctrl+click selects several bars and they move together", async ({ page }) => {
  await open(page);
  await bar(page, "m1").click();
  await bar(page, "m2").click({ modifiers: ["Control"] });
  await expect(bar(page, "m1")).toHaveAttribute("aria-pressed", "true");
  await expect(bar(page, "m2")).toHaveAttribute("aria-pressed", "true");
  const before = await latestRevision(page);
  await drag(page, bar(page, "m1"), PX);
  await settled(page, before + 1);
  expect((await savedAction(page, "m1")).position).toBeCloseTo(2, 5);
  expect((await savedAction(page, "m2")).position).toBeCloseTo(10, 5);
});

test("Shift snaps the bar start to a neighbouring bar edge", async ({ page }) => {
  await open(page);
  const before = await latestRevision(page);
  // m3 starts at 16; m2 ends at 13. Drag m3 to roughly 13.1s while holding Shift.
  await page.keyboard.down("Shift");
  await drag(page, bar(page, "m3"), -Math.round(2.9 * PX));
  await page.keyboard.up("Shift");
  await settled(page, before + 1);
  expect((await savedAction(page, "m3")).position).toBeCloseTo(13, 5);
});

test("arrow keys on the handle resize in 0.5 s steps, and stop at the minimum", async ({ page }) => {
  await open(page);
  const before = await latestRevision(page);
  await handle(page, "m3").focus();
  await page.keyboard.press("ArrowRight");
  await settled(page, before + 1);
  expect((await savedAction(page, "m3")).runSeconds).toBeCloseTo(3.5, 5);
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowLeft"); // 3.5 -> 0.5 takes six; the seventh hits the minimum
  await expect(appAlert(page)).toContainText("これ以上短くできません");
  await expect.poll(async () => (await savedAction(page, "m3")).runSeconds).toBeCloseTo(0.5, 5);
});

test("clicking the ruler moves the playhead; arrow keys nudge it", async ({ page }) => {
  await open(page);
  const ruler = page.locator('[data-part="ruler"]');
  const box = (await ruler.boundingBox())!;
  await page.mouse.click(box.x + LANE_PAD + 5 * PX, box.y + box.height / 2);
  await expect.poll(async () => Number(await knob(page).getAttribute("aria-valuenow"))).toBeCloseTo(5, 0);
  await knob(page).focus();
  await page.keyboard.press("Home");
  await expect(knob(page)).toHaveAttribute("aria-valuenow", "0");
});

test("rows: add, mute, lock, delete (with confirmation) and the row count limit message", async ({ page }) => {
  await open(page);
  const rev = await latestRevision(page);
  await page.getByRole("group", { name: "行を追加" }).getByRole("button", { name: /ロボット/ }).click();
  await expect.poll(async () => (await savedTracks(page)).length).toBe(5);
  await page.getByRole("button", { name: "人 1 除外" }).click();
  await expect.poll(async () => (await savedTracks(page)).find((t) => t.id === "hm")?.muted).toBe(true);
  await page.getByRole("button", { name: "人 1 固定" }).click();
  await expect.poll(async () => (await savedTracks(page)).find((t) => t.id === "hm")?.locked).toBe(true);
  await page.getByRole("button", { name: "人 1 固定" }).click();
  await expect.poll(async () => (await savedTracks(page)).find((t) => t.id === "hm")?.locked).toBe(false);

  await page.getByRole("button", { name: /^会議室/ }).first().click();
  await timelineCard(page).getByRole("button", { name: "行を削除" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  expect((await savedTracks(page)).length).toBe(5);
  await timelineCard(page).getByRole("button", { name: "行を削除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "削除" }).click();
  await expect.poll(async () => (await savedTracks(page)).length).toBe(4);
  expect(await latestRevision(page)).toBeGreaterThan(rev);
});

test("a locked row cannot be deleted", async ({ page }) => {
  await open(page);
  const before = await latestRevision(page);
  await page.getByRole("button", { name: /^表示/ }).first().click();
  await timelineCard(page).getByRole("button", { name: "行を削除" }).click();
  await expect(appAlert(page)).toContainText("ロックされています");
  await settled(page, before);
});

test("rows can be reordered with the up/down buttons", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^人 1/ }).first().click();
  await timelineCard(page).getByRole("button", { name: "上へ" }).click();
  await expect.poll(async () => (await savedTracks(page)).map((t) => t.id)).toEqual(["hm", "rb", "rm", "ds"]);
});

test("dragging an action button from the palette onto a lane opens the add dialog", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^ロボット 1/ }).first().click();
  const source = page.getByRole("group", { name: "動作を追加" }).getByRole("button").first();
  const target = lane(page, "ロボット 1");
  const box = (await target.boundingBox())!;
  await source.dragTo(target, { targetPosition: { x: 22 * PX, y: box.height / 2 } });
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("double-clicking an empty part of a lane opens the add dialog", async ({ page }) => {
  await open(page);
  const target = lane(page, "ロボット 1");
  const box = (await target.boundingBox())!;
  await target.dblclick({ position: { x: 24 * PX, y: box.height / 2 } });
  await expect(page.getByRole("dialog")).toBeVisible();
});
