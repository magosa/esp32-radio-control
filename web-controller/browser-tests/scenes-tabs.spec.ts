import { expect, test, type Page } from "@playwright/test";
import { appAlert, openScenes, renameProject, waitSaved } from "./helpers";

test.describe.configure({ mode: "serial" });

const tabs = (page: Page) => page.getByRole("tab");

async function addMap(page: Page, name?: string, copyFrom?: string) {
  await page.getByRole("button", { name: "マップを追加" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  if (copyFrom) await dialog.getByLabel(`「${copyFrom}」の配置をコピー`).check();
  if (name !== undefined) await dialog.getByLabel("マップ名").fill(name);
  await dialog.getByRole("button", { name: "追加" }).click();
}

test("adds maps up to 8, then the add button is disabled with a visible reason", async ({ page }) => {
  await openScenes(page);
  while ((await tabs(page).count()) < 8) await addMap(page);
  await expect(tabs(page)).toHaveCount(8);
  await expect(page.getByRole("button", { name: "マップを追加" })).toBeDisabled();
  await expect(page.getByText("マップは最大8枚です")).toBeVisible();
  await waitSaved(page);
});

test("rename: Enter commits once, Escape cancels, empty is rejected, unchanged saves nothing", async ({ page }) => {
  await openScenes(page);
  const first = tabs(page).first();
  const original = (await first.textContent()) ?? "";
  const historyBefore = (await (await page.request.get("/api/scenes/history")).json()).records.length;

  await first.dblclick();
  const input = page.getByLabel("マップ名", { exact: true });
  await input.fill("北棟");
  await input.press("Enter");
  await expect(tabs(page).first()).toHaveText("北棟");
  await waitSaved(page);
  const afterRename = (await (await page.request.get("/api/scenes/history")).json()).records.length;
  expect(afterRename).toBe(historyBefore + 1);

  await tabs(page).first().dblclick();
  await page.getByLabel("マップ名", { exact: true }).fill("破棄する名前");
  await page.keyboard.press("Escape");
  await expect(tabs(page).first()).toHaveText("北棟");

  await tabs(page).first().dblclick();
  await page.getByLabel("マップ名", { exact: true }).fill("   ");
  await page.keyboard.press("Enter");
  await expect(appAlert(page)).toBeVisible();
  await expect(page.getByLabel("マップ名", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await tabs(page).first().dblclick();
  await page.keyboard.press("Enter");
  await waitSaved(page);
  expect((await (await page.request.get("/api/scenes/history")).json()).records.length).toBe(afterRename);
  await tabs(page).first().dblclick();
  await page.getByLabel("マップ名", { exact: true }).fill(original || "マップ 1");
  await page.keyboard.press("Enter");
  await waitSaved(page);
});

test("blur after typing commits exactly one history entry (no Enter+blur double fire)", async ({ page }) => {
  await openScenes(page);
  const before = (await (await page.request.get("/api/scenes/history")).json()).records.length;
  await tabs(page).first().dblclick();
  await page.getByLabel("マップ名", { exact: true }).fill("ブラー確定");
  await page.getByLabel("プロジェクト名").click();
  await expect(tabs(page).first()).toHaveText("ブラー確定");
  await waitSaved(page);
  expect((await (await page.request.get("/api/scenes/history")).json()).records.length).toBe(before + 1);
});

test("delete asks for confirmation, selects a remaining tab, and the last map cannot be deleted", async ({ page }) => {
  await openScenes(page);
  const count = await tabs(page).count();
  expect(count).toBeGreaterThan(1);
  const name = (await tabs(page).first().textContent()) ?? "";
  await page.getByRole("button", { name: `マップ「${name}」を削除` }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(name);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(tabs(page)).toHaveCount(count);

  await page.getByRole("button", { name: `マップ「${name}」を削除` }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "削除する" }).click();
  await expect(tabs(page)).toHaveCount(count - 1);
  await expect(page.getByRole("tab", { selected: true })).toHaveCount(1);

  while ((await tabs(page).count()) > 1) {
    const n = (await tabs(page).first().textContent()) ?? "";
    await page.getByRole("button", { name: `マップ「${n}」を削除` }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "削除する" }).click();
  }
  await expect(page.getByRole("button", { name: /^マップ「.*」を削除$/ })).toBeDisabled();
});

test("arrow keys move the selection; copying a layout creates a new independent map", async ({ page }) => {
  await openScenes(page);
  await addMap(page, "コピー先");
  await expect(page.getByRole("tab", { name: "コピー先" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { selected: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { selected: true })).not.toHaveText("コピー先");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { selected: true })).toHaveText("コピー先");

  const first = (await tabs(page).first().textContent()) ?? "";
  await addMap(page, "複製A", first);
  await expect(page.getByRole("tab", { name: "複製A" })).toBeVisible();
  await waitSaved(page);
});
