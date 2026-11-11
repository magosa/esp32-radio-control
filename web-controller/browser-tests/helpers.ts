import { expect, type Page } from "@playwright/test";

export const SCENES = "/scenes";

export async function openScenes(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(SCENES);
  await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 30_000 });
}

export const saveStatus = (page: Page) => page.getByRole("status").filter({ hasText: /保存|他の画面/ });

// Next.js が常に挿入する空のルート通知要素と、閉じている <dialog> 内(利用者には見えない)の警告を除く。
export const appAlert = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__):visible');

export async function waitSaved(page: Page, revision?: number) {
  const text = revision === undefined ? /保存済み #\d+/ : new RegExp(`保存済み #${revision}$`);
  await expect(saveStatus(page).first()).toHaveText(text);
}

export async function latestRevision(page: Page): Promise<number> {
  const res = await page.request.get("/api/scenes/history");
  return (await res.json()).records.length;
}

export async function resetHistory(page: Page) {
  // サーバーは一時フォルダーを使うため、履歴を消さずに「いまの版」から相対で検証する。
  return latestRevision(page);
}

export async function renameProject(page: Page, name: string) {
  const field = page.getByLabel("プロジェクト名");
  await field.fill(name);
  await field.press("Enter");
}

export const cellsOf = (c0: number, r0: number, c1: number, r1: number) => {
  const cells: number[] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(r * 55 + c);
  return cells;
};

export const seedMap = (over: Record<string, unknown> = {}) => ({
  id: "map-e2e", name: "e2e map", editGridMm: 20, doorMode: "story", rooms: [], tracks: [],
  floorPlan: { doors: [], furniture: [], walls: [] }, ...over,
});

// Replaces the saved project with a known one so every test starts from the same state.
export async function openSeeded(page: Page, maps: unknown[], width = 1280) {
  await openScenes(page, width);
  await waitSaved(page);
  const expectedRevision = await latestRevision(page);
  const status = await page.evaluate(async ({ expectedRevision, maps }) => {
    const res = await fetch("/api/scenes/history", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision, id: `seed-${Date.now()}-${Math.floor(Math.random() * 1e9)}`, label: "e2e seed",
        project: { schema: "fleet-scene/v1", name: "e2e", maps } }),
    });
    return res.status;
  }, { expectedRevision, maps });
  expect(status, "seeding the project").toBeLessThan(300);
  await page.reload();
  await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 30_000 });
  await waitSaved(page);
}

function luminance(rgb: number[]) {
  const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const ratio = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

export async function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 1; c.height = 1;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(0, 0, 1, 1).data).slice(0, 3);
  }, png.toString("base64"));
}

// 半透明のカードやグラデーションが重なるため、色は計算せず、要素のすぐ外側の実ピクセルを背景とする。
export async function textAndBackground(page: Page, selector: string) {
  const info = await page.evaluate((sel) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const el = document.querySelector(sel)!;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { fg: parse(getComputedStyle(el).color), x: Math.max(0, Math.floor(r.left) - 2), y: Math.floor(r.top + r.height / 2) };
  }, selector);
  return { fg: info.fg, bg: await pixelAt(page, info.x, info.y) };
}
