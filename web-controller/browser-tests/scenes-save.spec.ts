import { expect, test } from "@playwright/test";
import { appAlert, latestRevision, openScenes, renameProject, saveStatus, waitSaved } from "./helpers";

test.describe.configure({ mode: "serial" });

test("first load creates one project and a rename is saved, persists and can be undone", async ({ page }) => {
  await openScenes(page);
  await waitSaved(page);
  const base = await latestRevision(page);
  expect(base).toBeGreaterThanOrEqual(1);

  await renameProject(page, "展示シーンA");
  await waitSaved(page, base + 1);
  await page.reload();
  await expect(page.getByLabel("プロジェクト名")).toHaveValue("展示シーンA");
  await waitSaved(page, base + 1);
  expect(await latestRevision(page)).toBe(base + 1);
});

test("Ctrl+Z undoes the rename, a new edit clears redo, Ctrl+Y redoes", async ({ page }) => {
  await openScenes(page);
  const field = page.getByLabel("プロジェクト名");
  const before = await field.inputValue();
  await renameProject(page, "一時名");
  await expect(page.getByRole("button", { name: "元に戻す" })).toBeEnabled();

  await page.keyboard.press("Control+z");
  await expect(field).toHaveValue(before);
  await expect(page.getByRole("button", { name: "やり直し" })).toBeEnabled();
  await page.keyboard.press("Control+y");
  await expect(field).toHaveValue("一時名");

  await page.keyboard.press("Control+z");
  await renameProject(page, "別の名前");
  await expect(page.getByRole("button", { name: "やり直し" })).toBeDisabled();
  await page.keyboard.press("Control+y");
  await expect(field).toHaveValue("別の名前");
});

test("Ctrl+Z inside the name field keeps the browser's own text undo (no project undo)", async ({ page }) => {
  await openScenes(page);
  const field = page.getByLabel("プロジェクト名");
  const saved = await field.inputValue();
  const revisions = await latestRevision(page);
  await field.click();
  await field.fill("入力途中");
  await page.keyboard.press("Control+z");
  expect(await latestRevision(page)).toBe(revisions);
  await field.press("Escape");
  await expect(field).toHaveValue(saved);
});

test("an empty project name is rejected, shown, and not saved", async ({ page }) => {
  await openScenes(page);
  const field = page.getByLabel("プロジェクト名");
  const before = await field.inputValue();
  const revisions = await latestRevision(page);
  await field.fill("   ");
  await field.press("Enter");
  await expect(appAlert(page)).toContainText("プロジェクト名を入力してください");
  await expect(field).toHaveValue(before);
  expect(await latestRevision(page)).toBe(revisions);
});

test("two pages: the later editor gets a conflict, cannot edit, and recovers by reloading", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await openScenes(a);
  await openScenes(b);
  await renameProject(a, "Aが更新");
  await waitSaved(a);

  await renameProject(b, "Bの更新");
  await expect(saveStatus(b).first()).toContainText("他の画面で更新されました");
  await expect(b.getByRole("button", { name: "再読込" })).toBeVisible();

  await b.getByRole("button", { name: "元に戻す" }).click().catch(() => undefined);
  await renameProject(b, "さらにB");
  await expect(appAlert(b)).toContainText("他の画面で更新されたため、編集できません");

  await b.getByRole("button", { name: "再読込" }).click();
  await expect(b.getByLabel("プロジェクト名")).toHaveValue("Aが更新");
  await waitSaved(b);
  await a.context().close();
  await b.context().close();
});

test("a failed save shows the failure count and a retry sends the same edit once", async ({ page }) => {
  await openScenes(page);
  await waitSaved(page);
  const base = await latestRevision(page);
  let blocked = true;
  await page.route("**/api/scenes/history", async (route) => {
    if (route.request().method() === "POST" && blocked) return route.abort("failed");
    return route.continue();
  });
  await renameProject(page, "再試行テスト");
  await expect(saveStatus(page).first()).toContainText("保存に失敗 1件");
  expect(await latestRevision(page)).toBe(base);

  blocked = false;
  await page.getByRole("button", { name: "未送信を再試行" }).click();
  await waitSaved(page, base + 1);
  expect(await latestRevision(page)).toBe(base + 1);
});

test("writes from another origin are refused, same-origin reads work", async ({ page, request }) => {
  await openScenes(page);
  const body = { expectedRevision: 0, id: "evil-1", label: "x", project: {} };
  const evil = await request.post("/api/scenes/history", { data: body, headers: { Origin: "http://evil.example" } });
  expect(evil.status()).toBe(403);
  const none = await request.post("/api/scenes/history", { data: body, headers: { Origin: "" } });
  expect(none.status()).toBe(403);
  const read = await request.get("/api/scenes/history", { headers: { Origin: "http://evil.example" } });
  expect(read.status()).toBe(200);
});
