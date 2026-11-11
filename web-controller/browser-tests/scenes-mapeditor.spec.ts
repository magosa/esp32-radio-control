import { expect, test, type Page } from "@playwright/test";
import { appAlert, cellsOf, latestRevision, openSeeded, ratio, renameProject, seedMap, textAndBackground, waitSaved } from "./helpers";

test.describe.configure({ mode: "serial" });

const editor = (page: Page) => page.getByRole("dialog", { name: "マップを編集" });
const status = (page: Page) => editor(page).getByRole("status").first();
const button = (page: Page, name: string | RegExp, exact = true) => editor(page).getByRole("button", { name, exact });

async function openEditor(page: Page) {
  await page.getByRole("button", { name: "マップを編集" }).click();
  await expect(editor(page)).toBeVisible();
}

// Cell centre in mm -> page pixels, through the live svg box (y axis points up in mm).
async function px(page: Page, x: number, y: number) {
  const box = await editor(page).locator("svg[role=img]").boundingBox();
  if (!box) throw new Error("map svg is not visible");
  return { x: box.x + (x / 1100) * box.width, y: box.y + ((620 - y) / 620) * box.height };
}
const centre = (col: number, row: number) => ({ x: col * 20 + 10, y: row * 20 + 10 });

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const a = await px(page, from.x, from.y), b = await px(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}
async function click(page: Page, at: { x: number; y: number }) {
  const p = await px(page, at.x, at.y);
  await page.mouse.click(p.x, p.y);
}

const room = (id: string, name: string, cells: number[], extra: Record<string, unknown> = {}) =>
  ({ id, name, color: "#8d9bff", kind: "room", material: "concrete", cells, ...extra });

test("draw a room by rectangle drag, apply it, and it survives a reload", async ({ page }) => {
  await openSeeded(page, [seedMap()]);
  const base = await latestRevision(page);
  await openEditor(page);
  await expect(status(page)).toContainText("0 領域");
  await button(page, /新しい領域/, false).click();
  await button(page, "長方形ドラッグ").click();
  await drag(page, centre(5, 5), centre(15, 15));
  await expect(status(page)).toContainText("1 領域 / 121 セル");
  await button(page, "マップに適用").click();
  await expect(editor(page)).toBeHidden();
  await waitSaved(page, base + 1);
  expect(await latestRevision(page)).toBe(base + 1);

  await page.reload();
  await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 30_000 });
  await openEditor(page);
  await expect(status(page)).toContainText("1 領域 / 121 セル");
});

test("apply is refused with a reason until the map has a region", async ({ page }) => {
  await openSeeded(page, [seedMap()]);
  const base = await latestRevision(page);
  await openEditor(page);
  await button(page, "マップに適用").click();
  await expect(appAlert(page)).toHaveText("1つ以上の領域を描いてください。");
  await expect(editor(page)).toBeVisible();
  expect(await latestRevision(page)).toBe(base);
});

test("cancel keeps the map and history; Esc with changes asks first; Ctrl+Z inside the dialog does not undo the project", async ({ page }) => {
  await openSeeded(page, [seedMap({ rooms: [room("r1", "会議室", cellsOf(5, 5, 7, 7))] })]);
  // The page needs something of its own to undo, otherwise a leaked Ctrl+Z would change nothing.
  await renameProject(page, "ページ側の変更");
  await waitSaved(page);
  const base = await latestRevision(page);
  await openEditor(page);
  await button(page, "キャンセル").click();
  await expect(editor(page)).toBeHidden();
  expect(await latestRevision(page)).toBe(base);

  await openEditor(page);
  await button(page, "長方形ドラッグ").click();
  await drag(page, centre(10, 5), centre(12, 7));
  await expect(status(page)).toContainText("1 領域 / 18 セル");
  await page.keyboard.press("Control+z");
  await expect(status(page)).toContainText("1 領域 / 9 セル");
  await page.keyboard.press("Control+y");
  await expect(status(page)).toContainText("1 領域 / 18 セル");
  await page.waitForTimeout(500);
  expect(await latestRevision(page)).toBe(base);
  await expect(page.getByLabel("プロジェクト名")).toHaveValue("ページ側の変更");

  await page.keyboard.press("Escape");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "編集を続ける" }).click();
  await expect(confirm).toBeHidden();
  await expect(editor(page)).toBeVisible();
  await expect(status(page)).toContainText("18 セル");

  await page.keyboard.press("Escape");
  await confirm.getByRole("button", { name: "破棄して閉じる" }).click();
  await expect(editor(page)).toBeHidden();
  expect(await latestRevision(page)).toBe(base);
  await openEditor(page);
  await expect(status(page)).toContainText("1 領域 / 9 セル");
});

test("after applying, Ctrl+Z on the page undoes the whole map edit as one step", async ({ page }) => {
  await openSeeded(page, [seedMap()]);
  const base = await latestRevision(page);
  await openEditor(page);
  await button(page, /新しい領域/, false).click();
  await button(page, "長方形ドラッグ").click();
  await drag(page, centre(5, 5), centre(8, 8));
  await button(page, "マップに適用").click();
  await expect(editor(page)).toBeHidden();
  await waitSaved(page, base + 1);

  await page.keyboard.press("Control+z");
  await waitSaved(page, base + 2);
  await openEditor(page);
  await expect(status(page)).toContainText("0 領域");
});

test("the last cell of a region cannot be erased, and a region used by a track cannot be deleted", async ({ page }) => {
  const track = { id: "t1", kind: "room", name: "会議室", color: "#8d9bff", muted: false, locked: false, actions: [], roomId: "r1" };
  await openSeeded(page, [seedMap({
    rooms: [room("r1", "会議室", cellsOf(5, 5, 7, 7)), room("r2", "倉庫", cellsOf(12, 5, 14, 7))], tracks: [track],
  })]);
  await openEditor(page);
  await button(page, "消しゴム").click();
  await button(page, "長方形ドラッグ").click();
  await drag(page, centre(5, 5), centre(7, 7));
  await expect(appAlert(page)).toContainText("最後のセル");
  await expect(status(page)).toContainText("2 領域 / 18 セル");

  await editor(page).getByLabel("領域を選択").selectOption({ label: "部屋 · 会議室" });
  await button(page, "領域を削除").click();
  await expect(appAlert(page)).toContainText("参照されている");
  await expect(status(page)).toContainText("2 領域");

  await editor(page).getByLabel("領域を選択").selectOption({ label: "部屋 · 倉庫" });
  await button(page, "領域を削除").click();
  await expect(status(page)).toContainText("1 領域 / 9 セル");
});

const BIG_ROOM = [room("r1", "\u4f1a\u8b70\u5ba4", cellsOf(5, 5, 24, 24))];

test("door widths offer only 140-240mm in 20mm steps; a 140mm door gives a 132mm opening; gate and elevator can be placed", async ({ page }) => {
  await openSeeded(page, [seedMap({ rooms: BIG_ROOM })]);
  await openEditor(page);
  await button(page, "\u90e8\u5c4b\u7de8\u96c6").click();
  await button(page, "\u81ea\u52d5\u30c9\u30a2").click();
  const width = editor(page).getByLabel("\u5165\u53e3\u5e45");
  const options = await width.locator("option").allTextContents();
  expect(options.map((text) => text.replace(/\(.*\)/, ""))).toEqual(["140mm", "160mm", "180mm", "200mm", "220mm", "240mm"]);
  expect(options.join("")).not.toMatch(/120mm|260mm/);
  await width.selectOption({ label: options[0] });
  await click(page, { x: 300, y: 100 });
  await expect(appAlert(page)).toHaveCount(0);
  await expect(editor(page).getByText(/\u5e45 132mm/)).toBeVisible();

  await button(page, "\u30d5\u30e9\u30c3\u30d1\u30fc\u30b2\u30fc\u30c8").click();
  await drag(page, centre(10, 12), centre(10, 16));
  await expect(appAlert(page)).toHaveCount(0);
  await expect(status(page)).toContainText("\u914d\u7f6e\u7269\u3092\u9078\u629e\u4e2d");

  await button(page, "\u30be\u30fc\u30cb\u30f3\u30b0").click();
  await button(page, "\u30a8\u30ec\u30d9\u30fc\u30bf\u30fc").click();
  await expect(status(page)).toContainText("2 \u9818\u57df");
  await drag(page, centre(35, 10), centre(35, 15));
  await expect(appAlert(page)).toHaveCount(0);
  await expect(status(page)).toContainText("2 \u9818\u57df / 442 \u30bb\u30eb");
});

test("furniture: place, rotate 90 degrees, delete; a short partition wall warns", async ({ page }) => {
  await openSeeded(page, [seedMap({ rooms: BIG_ROOM })]);
  await openEditor(page);
  await button(page, "\u90e8\u5c4b\u7de8\u96c6").click();
  await button(page, "\u5bb6\u5177").click();
  await drag(page, centre(8, 12), centre(10, 13));
  await expect(status(page)).toContainText("3 \u00d7 2 \u30bb\u30eb / \u7d04 60 \u00d7 40 mm");
  await editor(page).getByRole("button", { name: "90\u00b0\u56de\u8ee2" }).click();
  await expect(status(page)).toContainText("2 \u00d7 3 \u30bb\u30eb / \u7d04 40 \u00d7 60 mm");
  await editor(page).getByRole("button", { name: "\u9078\u629e\u7269\u3092\u524a\u9664" }).click();
  await expect(status(page)).not.toContainText("\u914d\u7f6e\u7269");

  await button(page, "\u9593\u4ed5\u5207\u308a\u58c1").click();
  await drag(page, centre(10, 18), centre(15, 18));
  await expect(editor(page).getByRole("status").filter({ hasText: "\u5b89\u5168\u5186" })).toBeVisible();
  await expect(appAlert(page)).toHaveCount(0);
});

test("a 40mm edit grid paints a 2 x 2 block with one click", async ({ page }) => {
  await openSeeded(page, [seedMap()]);
  await openEditor(page);
  await button(page, /\u65b0\u3057\u3044\u9818\u57df/, false).click();
  await editor(page).getByLabel("\u7de8\u96c6\u30b0\u30ea\u30c3\u30c9").selectOption("40");
  await click(page, centre(10, 10));
  await expect(status(page)).toContainText("1 \u9818\u57df / 4 \u30bb\u30eb");
});

test("undo and redo keep working beyond 100 steps; a new edit disables redo", async ({ page }) => {
  await openSeeded(page, [seedMap({ rooms: BIG_ROOM })]);
  await openEditor(page);
  const name = editor(page).getByLabel("\u30de\u30c3\u30d7\u540d");
  for (let i = 1; i <= 104; i++) {
    await name.fill(`name ${i}`);
    await name.press("Enter");
  }
  const undo = button(page, "\u5143\u306b\u623b\u3059"), redo = button(page, "\u3084\u308a\u76f4\u3057");
  let steps = 0;
  while (await undo.isEnabled()) {
    await undo.click();
    steps++;
  }
  expect(steps).toBe(100);
  await expect(name).toHaveValue("name 4");
  await redo.click();
  await expect(name).toHaveValue("name 5");
  await name.fill("fresh");
  await name.press("Enter");
  await expect(redo).toBeDisabled();
});

for (const width of [768, 1280]) {
  test(`at ${width}px the editor stays inside the screen and every control is reachable`, async ({ page }) => {
    await openSeeded(page, [seedMap({ rooms: BIG_ROOM })], width);
    await openEditor(page);
    const overflow = await editor(page).evaluate((el) => ({ x: el.scrollWidth - el.clientWidth, w: el.clientWidth }));
    expect(overflow.x, "horizontal overflow of the dialog").toBeLessThanOrEqual(0);
    for (const group of ["\u30e2\u30fc\u30c9", "\u30c4\u30fc\u30eb"]) {
      for (const item of await editor(page).getByRole("group", { name: group }).getByRole("button").all()) {
        const box = await item.boundingBox();
        expect(box, `${group} button`).not.toBeNull();
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
    }
    await button(page, "\u30de\u30c3\u30d7\u306b\u9069\u7528").scrollIntoViewIfNeeded();
    await expect(button(page, "\u30de\u30c3\u30d7\u306b\u9069\u7528")).toBeVisible();
    await button(page, "\u90e8\u5c4b\u7de8\u96c6").click();
    await button(page, "\u5bb6\u5177").click();
    await drag(page, centre(8, 12), centre(9, 12));
    await expect(status(page)).toContainText("\u914d\u7f6e\u7269\u3092\u9078\u629e\u4e2d");
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme} theme: status, error and field labels keep at least 4.5:1 contrast in the editor`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("fleet-appearance", JSON.stringify({ theme: t, palette: "ocean", motion: false })), theme);
    await openSeeded(page, [seedMap({ rooms: [room("r1", "\u4f1a\u8b70\u5ba4", cellsOf(5, 5, 7, 7))] })]);
    await expect(page.locator(`main[data-theme="${theme}"]`)).toBeVisible();
    await openEditor(page);
    await button(page, "\u6d88\u3057\u30b4\u30e0").click();
    await button(page, "\u9577\u65b9\u5f62\u30c9\u30e9\u30c3\u30b0").click();
    await drag(page, centre(5, 5), centre(7, 7));
    await expect(appAlert(page)).toBeVisible();
    await page.waitForTimeout(800);
    for (const selector of ['dialog [role="alert"]', 'dialog [role="status"]', "dialog label span", "dialog h3"]) {
      const { fg, bg } = await textAndBackground(page, selector);
      expect(ratio(fg, bg), `${selector} (${theme}) fg=${fg} bg=${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test("touch: a one-finger drag draws a rectangle, and pointercancel leaves no drag behind", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1024, height: 800 } });
  const page = await context.newPage();
  await openSeeded(page, [seedMap()], 1024);
  await openEditor(page);
  await button(page, /\u65b0\u3057\u3044\u9818\u57df/, false).click();
  await button(page, "\u9577\u65b9\u5f62\u30c9\u30e9\u30c3\u30b0").click();
  const cdp = await context.newCDPSession(page);
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", at: { x: number; y: number } | null) => cdp.send("Input.dispatchTouchEvent", {
    type, touchPoints: at ? [{ x: at.x, y: at.y, id: 1 }] : [],
  });
  const a = await px(page, centre(5, 5).x, centre(5, 5).y), b = await px(page, centre(9, 8).x, centre(9, 8).y);
  await touch("touchStart", a);
  await touch("touchMove", { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  await touch("touchMove", b);
  await touch("touchEnd", null);
  await expect(status(page)).toContainText("1 \u9818\u57df / 20 \u30bb\u30eb");

  await touch("touchStart", a);
  await touch("touchMove", b);
  await expect(status(page)).toContainText("20 \u30bb\u30eb");
  await touch("touchCancel", null);
  const cells = await status(page).innerText();
  expect(cells).toContain("1 \u9818\u57df / 20 \u30bb\u30eb");
  await button(page, "\u5143\u306b\u623b\u3059").click();
  await expect(status(page)).toContainText("1 \u9818\u57df / 0 \u30bb\u30eb");
  await context.close();
});