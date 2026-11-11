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
