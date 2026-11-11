import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { appAlert, latestRevision, openScenes, renameProject, waitSaved } from "./helpers";

test.describe.configure({ mode: "serial" });

test("JSON export downloads a fleet-scene/v1 file; importing it restores the project", async ({ page }) => {
  await openScenes(page);
  await renameProject(page, "出力テスト");
  await waitSaved(page);

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "JSON保存" }).click()]);
  expect(download.suggestedFilename()).toBe("出力テスト.fleet-scene.json");
  const file = path.join(os.tmpdir(), `scene-e2e-${Date.now()}.json`);
  await download.saveAs(file);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(saved.schema).toBe("fleet-scene/v1");

  await renameProject(page, "上書きされる名前");
  await waitSaved(page);
  const before = await latestRevision(page);
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByLabel("プロジェクト名")).toHaveValue("出力テスト");
  await waitSaved(page, before + 1);
  fs.rmSync(file, { force: true });
});

test("importing a broken, legacy or oversized file changes nothing and explains why", async ({ page }) => {
  await openScenes(page);
  const name = await page.getByLabel("プロジェクト名").inputValue();
  const revisions = await latestRevision(page);
  const input = page.locator('input[type="file"]');

  await input.setInputFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from("{ not json") });
  await expect(appAlert(page)).toBeVisible();

  await input.setInputFiles({ name: "legacy.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ schema: "robot-scene/v5", name: "x", maps: [] })) });
  await expect(appAlert(page)).toContainText("S3");

  await input.setInputFiles({ name: "huge.json", mimeType: "application/json", buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 32) });
  await expect(appAlert(page)).toContainText(/10/);

  await expect(page.getByLabel("プロジェクト名")).toHaveValue(name);
  expect(await latestRevision(page)).toBe(revisions);
});

test("the history dialog lists newest first and applying a past state appends a new revision", async ({ page }) => {
  await openScenes(page);
  await renameProject(page, "履歴の古い名前");
  await waitSaved(page);
  const oldRev = await latestRevision(page);
  await renameProject(page, "履歴の新しい名前");
  await waitSaved(page);
  const before = await latestRevision(page);

  await page.getByRole("button", { name: "編集履歴" }).click();
  const dialog = page.getByRole("dialog", { name: "編集履歴" });
  await expect(dialog).toBeVisible();
  const first = dialog.getByRole("listitem").first();
  await expect(first).toContainText(`#${before}`);

  await dialog.getByRole("button", { name: `リビジョン #${oldRev} のこの状態を適用` }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("プロジェクト名")).toHaveValue("履歴の古い名前");
  await waitSaved(page, before + 1);

  await page.getByRole("button", { name: "編集履歴" }).click();
  await expect(page.getByRole("dialog", { name: "編集履歴" }).getByRole("listitem").first()).toContainText(`#${oldRev} から復元`);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "編集履歴" })).toBeHidden();

  await page.keyboard.press("Control+z");
  await expect(page.getByLabel("プロジェクト名")).toHaveValue("履歴の新しい名前");
});

test("apply buttons are disabled while a conflict is shown", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await openScenes(a);
  await openScenes(b);
  await renameProject(a, "競合A");
  await waitSaved(a);
  await renameProject(b, "競合B");
  await expect(b.getByText("他の画面で更新されました").first()).toBeVisible();
  await b.getByRole("button", { name: "編集履歴" }).click();
  const dialog = b.getByRole("dialog", { name: "編集履歴" });
  await expect(dialog.getByRole("alert")).toContainText("他の画面で更新されました");
  for (const button of await dialog.getByRole("button", { name: /この状態を適用/ }).all()) await expect(button).toBeDisabled();
  await a.context().close();
  await b.context().close();
});
