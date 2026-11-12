import { expect, test, type Page } from "@playwright/test";
import { appAlert, cellsOf, latestRevision, openSeeded, pixelAt, ratio, renameProject, seedMap, textAndBackground, waitSaved } from "./helpers";

test.describe.configure({ mode: "serial" });

const room = (id: string, name: string, cells: number[], extra: Record<string, unknown> = {}) =>
  ({ id, name, color: "#8d9bff", kind: "room", material: "concrete", cells, ...extra });

const ROBOT = {
  id: "t-robot", kind: "robot", name: "ロボットA", color: "#8d9bff", muted: false, locked: false, robotRole: "cleaning", robotId: "r1",
  initial: { x: 130, y: 130, yaw: 0, roomId: "r1" },
  actions: [{ id: "a-move", name: "移動", type: "move", position: 1, runSeconds: 6, x: 500, y: 400, yaw: 0, roomId: "r1", targetId: "tg1", text: "", state: "meeting" }],
};
const seed = () => seedMap({
  rooms: [room("r1", "会議室", cellsOf(3, 3, 30, 25)), room("r2", "廊下", cellsOf(34, 3, 50, 12), { kind: "corridor" })],
  tracks: [ROBOT],
});

const panel = (page: Page) => page.getByRole("complementary", { name: "設定" });
const preview = (page: Page) => page.getByRole("dialog", { name: "全画面プレビュー" });
const pageBar = (page: Page) => page.getByRole("region", { name: "マップ" }).getByRole("toolbar", { name: "再生" });
const readout = (bar: ReturnType<typeof pageBar>) => bar.locator("output");

// Clicks a point of the page's map (mm, y up); the region under it becomes the selection.
async function clickMap(page: Page, x: number, y: number) {
  const svg = page.getByRole("region", { name: "マップ" }).locator("svg[role=img]");
  const box = await svg.boundingBox();
  if (!box) throw new Error("map svg is not visible");
  // The fit-sized map is letterboxed (centred) inside the svg box.
  const [, , vbW, vbH] = (await svg.getAttribute("viewBox"))!.split(/\s+/).map(Number);
  const scale = Math.min(box.width / vbW, box.height / vbH);
  const left = box.x + (box.width - vbW * scale) / 2;
  const top = box.y + (box.height - vbH * scale) / 2;
  await page.mouse.click(left + (x / 1100) * vbW * scale, top + ((620 - y) / 620) * vbH * scale);
}
const pickConference = (page: Page) => clickMap(page, 300, 300);

test("region panel: name, kind, floor and colour are edited as one commit each and survive a reload", async ({ page }) => {
  await openSeeded(page, [seed()]);
  await expect(panel(page).getByText("順番に、空間をつなぐ。")).toBeVisible();
  const base = await latestRevision(page);
  await pickConference(page);
  await expect(panel(page).getByRole("heading", { name: "会議室" })).toBeVisible();

  await panel(page).getByLabel("領域名").fill("大会議室");
  await panel(page).getByLabel("領域名").press("Enter");
  await waitSaved(page, base + 1);
  await panel(page).getByRole("button", { name: "廊下", exact: true }).click();
  await waitSaved(page, base + 2);
  await panel(page).getByLabel("床材").selectOption({ label: "木" });
  await waitSaved(page, base + 3);
  await panel(page).getByLabel("色", { exact: true }).fill("#aa3366");
  await waitSaved(page, base + 4);
  expect(await latestRevision(page)).toBe(base + 4);
  await expect(panel(page).getByRole("heading", { name: "大会議室" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 30_000 });
  await pickConference(page);
  await expect(panel(page).getByLabel("領域名")).toHaveValue("大会議室");
  await expect(panel(page).getByRole("button", { name: "廊下", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel(page).getByLabel("床材")).toHaveValue("wood");
  await expect(panel(page).getByLabel("色", { exact: true })).toHaveValue("#aa3366");
});

test("region panel: a rejected name shows one alert, keeps the old value and saves nothing", async ({ page }) => {
  await openSeeded(page, [seed()]);
  const base = await latestRevision(page);
  await pickConference(page);
  await panel(page).getByLabel("領域名").fill("");
  await panel(page).getByLabel("領域名").press("Enter");
  await expect(appAlert(page)).toHaveCount(1);
  await expect(appAlert(page)).toHaveText("領域名は1〜120文字で入力してください。");
  await expect(panel(page).getByLabel("領域名")).toHaveValue("会議室");
  await page.waitForTimeout(500);
  expect(await latestRevision(page)).toBe(base);
  // Picking another place clears the message.
  await clickMap(page, 800, 500);
  await expect(appAlert(page)).toHaveCount(0);
  await expect(panel(page).getByText("順番に、空間をつなぐ。")).toBeVisible();
});

test("region panel: adding a room row selects the new row; the map editor opens from the panel", async ({ page }) => {
  await openSeeded(page, [seed()]);
  const base = await latestRevision(page);
  await pickConference(page);
  await panel(page).getByRole("button", { name: "部屋の行を追加" }).click();
  await waitSaved(page, base + 1);
  await expect(panel(page)).toContainText("部屋の行 · 2 / 2 本目 · 動作 0 件");
  await expect(panel(page).getByLabel("対象の部屋")).toHaveValue("r1");
  await expect(panel(page).getByRole("button", { name: "＋ イベント発生" })).toBeVisible();

  await pickConference(page);
  await panel(page).getByRole("button", { name: "部屋の形・床材・家具を編集" }).click();
  await expect(page.getByRole("dialog", { name: "マップを編集" })).toBeVisible();
});

test("fullscreen preview: opens, shares the page's time and playback, and closes with Esc or the button", async ({ page }) => {
  await openSeeded(page, [seed()]);
  await page.getByRole("slider", { name: "再生位置" }).fill("3");
  await expect(readout(pageBar(page))).toContainText("0:03.0");
  await page.getByRole("button", { name: "全画面プレビュー" }).click();
  await expect(preview(page)).toBeVisible();
  const bar = preview(page).getByRole("toolbar", { name: "再生" });
  await expect(readout(bar)).toContainText("0:03.0");
  await expect(preview(page).locator("svg[role=img]")).toBeVisible();
  // The preview map is drawn from the same time as the page's.
  const label = await preview(page).locator("svg[role=img]").getAttribute("aria-label");
  await page.keyboard.press("Escape");
  await expect(preview(page)).toBeHidden();
  expect(await page.getByRole("region", { name: "マップ" }).locator("svg[role=img]").getAttribute("aria-label")).toBe(label);

  await page.getByRole("button", { name: "全画面プレビュー" }).click();
  await preview(page).getByRole("slider", { name: "再生位置" }).fill("5");
  await expect(readout(preview(page).getByRole("toolbar", { name: "再生" }))).toContainText("0:05.0");
  await preview(page).getByRole("button", { name: "閉じる" }).click();
  await expect(preview(page)).toBeHidden();
  await expect(readout(pageBar(page))).toContainText("0:05.0");
  await expect(page.getByRole("slider", { name: "再生位置" })).toHaveValue("5");
});

test("fullscreen preview: playing in the dialog keeps playing on the page, and the two agree when paused", async ({ page }) => {
  await openSeeded(page, [seed()]);
  await page.getByRole("button", { name: "全画面プレビュー" }).click();
  const bar = preview(page).getByRole("toolbar", { name: "再生" });
  await bar.getByRole("button", { name: "再生", exact: true }).click();
  await expect(readout(bar)).not.toContainText("0:00.0 /");
  await page.keyboard.press("Escape");
  await expect(preview(page)).toBeHidden();
  await expect(pageBar(page).getByRole("button", { name: "一時停止" })).toBeVisible();
  await pageBar(page).getByRole("button", { name: "一時停止" }).click();
  await expect(pageBar(page).getByRole("button", { name: "再生", exact: true })).toBeVisible();
  const paused = await readout(pageBar(page)).textContent();
  expect(paused).not.toContain("0:00.0 /");

  await page.getByRole("button", { name: "全画面プレビュー" }).click();
  await expect(readout(preview(page).getByRole("toolbar", { name: "再生" }))).toHaveText(paused ?? "");
  await expect(preview(page).getByRole("toolbar", { name: "再生" }).getByRole("button", { name: "再生", exact: true })).toBeVisible();
  // Pausing in the dialog pauses the page, and the first button goes back to the start.
  await preview(page).getByRole("button", { name: "先頭へ" }).click();
  await expect(readout(preview(page).getByRole("toolbar", { name: "再生" }))).toContainText("0:00.0");
  await page.keyboard.press("Escape");
  await expect(readout(pageBar(page))).toContainText("0:00.0");
});

test("fullscreen preview: Ctrl+Z and Ctrl+Y inside the dialog do not undo the project behind it", async ({ page }) => {
  await openSeeded(page, [seed()]);
  await renameProject(page, "ページ側の変更");
  await waitSaved(page);
  const base = await latestRevision(page);
  await page.getByRole("button", { name: "全画面プレビュー" }).click();
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(600);
  expect(await latestRevision(page)).toBe(base);
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("プロジェクト名")).toHaveValue("ページ側の変更");
  // Outside the dialog the same key still undoes it.
  await page.getByRole("tab").first().focus();
  await page.keyboard.press("Control+z");
  await expect(page.getByLabel("プロジェクト名")).not.toHaveValue("ページ側の変更");
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} theme: the preview background is opaque and the text keeps 4.5:1 contrast`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("fleet-appearance", JSON.stringify({ theme: t, palette: "ocean", motion: false })), theme);
    await openSeeded(page, [seed()]);
    await expect(page.locator(`main[data-theme="${theme}"]`)).toBeVisible();
    await page.getByRole("button", { name: "全画面プレビュー" }).click();
    await expect(preview(page)).toBeVisible();
    await page.waitForTimeout(800);
    const expected = theme === "light" ? [245, 250, 255] : [23, 35, 56];
    const css = await preview(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(css).toBe(`rgb(${expected.join(", ")})`);
    for (const point of [[3, 3], [1270, 3], [3, 880]]) {
      const pixel = await pixelAt(page, point[0], point[1]);
      // A see-through dialog differs by tens; 1-3 is anti-aliasing noise at the screen edge.
      expect(Math.max(...pixel.map((v, i) => Math.abs(v - expected[i]))), `pixel at ${point}`).toBeLessThanOrEqual(4);
    }
    for (const selector of ["dialog[open] h2", "dialog[open] label span", "dialog[open] output"]) {
      const { fg, bg } = await textAndBackground(page, selector);
      expect(ratio(fg, bg), `${selector} (${theme}) fg=${fg} bg=${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test(`${theme} theme: the region panel's text keeps 4.5:1 contrast`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("fleet-appearance", JSON.stringify({ theme: t, palette: "ocean", motion: false })), theme);
    await openSeeded(page, [seed()]);
    await expect(page.locator(`main[data-theme="${theme}"]`)).toBeVisible();
    await pickConference(page);
    await expect(panel(page).getByRole("heading", { name: "会議室" })).toBeVisible();
    await panel(page).getByLabel("領域名").fill("");
    await panel(page).getByLabel("領域名").press("Enter");
    await expect(appAlert(page)).toBeVisible();
    await page.waitForTimeout(800);
    for (const selector of ['aside[aria-label="設定"] h3', 'aside[aria-label="設定"] p', 'aside[aria-label="設定"] label span', 'aside[aria-label="設定"] [role="alert"]']) {
      const { fg, bg } = await textAndBackground(page, selector);
      expect(ratio(fg, bg), `${selector} (${theme}) fg=${fg} bg=${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

for (const width of [768, 1280]) {
  test(`at ${width}px the preview and the region panel stay inside the screen`, async ({ page }) => {
    await openSeeded(page, [seed()], width);
    await pickConference(page);
    const box = await panel(page).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(await panel(page).evaluate((el) => el.scrollWidth - el.clientWidth), "panel horizontal overflow").toBeLessThanOrEqual(0);
    for (const control of await panel(page).locator("button, select, input").all()) {
      const rect = await control.boundingBox();
      expect(rect!.height).toBeGreaterThanOrEqual(44);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    }

    for (const height of [900, 640]) {
      await page.setViewportSize({ width, height });
      await page.getByRole("button", { name: "全画面プレビュー" }).click();
      await expect(preview(page)).toBeVisible();
      expect(await preview(page).evaluate((el) => el.scrollWidth - el.clientWidth), `dialog horizontal overflow at ${height}`).toBeLessThanOrEqual(0);
      const map = await preview(page).locator("svg[role=img]").boundingBox();
      expect(map!.x).toBeGreaterThanOrEqual(0);
      expect(map!.x + map!.width).toBeLessThanOrEqual(width);
      if (width >= 1024) expect(map!.y + map!.height, `map bottom at ${height}`).toBeLessThanOrEqual(height);
      for (const control of await preview(page).getByRole("toolbar", { name: "再生" }).getByRole("button").all()) {
        const rect = await control.boundingBox();
        expect(rect!.height).toBeGreaterThanOrEqual(44);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
        if (width >= 1024) expect(rect!.y + rect!.height, `playback bar bottom at ${height}`).toBeLessThanOrEqual(height);
      }
      await page.keyboard.press("Escape");
      await expect(preview(page)).toBeHidden();
    }
  });
}
