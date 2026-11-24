import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { appAlert, latestRevision, openScenes, openSeeded, renameProject, seedMap, waitSaved } from "./helpers";

test.describe.configure({ mode: "serial" });

test("JSON export can be imported as additional maps without replacing the project", async ({ page }) => {
  await openSeeded(page, [seedMap()]);
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
  const dialog = page.getByRole("dialog", { name: "JSONからマップを追加" });
  await expect(dialog.locator("svg[data-map-preview]")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "選択したマップを追加" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "e2e map" }).check();
  await dialog.getByRole("button", { name: "選択したマップを追加" }).click();
  await expect(page.getByLabel("プロジェクト名")).toHaveValue("上書きされる名前");
  await expect(page.getByRole("tab", { name: "e2e map", exact: true })).toHaveCount(2);
  await waitSaved(page, before + 1);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.getByRole("tab", { name: "e2e map", exact: true })).toHaveCount(1);
  await waitSaved(page, before + 2);
  await page.getByRole("button", { name: "やり直し", exact: true }).click();
  await waitSaved(page, before + 3);
  await page.reload();
  await expect(page.getByRole("tab", { name: "e2e map", exact: true })).toHaveCount(2);
  fs.rmSync(file, { force: true });
});

test("choosing maps preserves their sequences and cancel does not change history", async ({ page }) => {
  await openSeeded(page, [seedMap()]);
  const before = await latestRevision(page);
  const actor = {
    id: "actor", kind: "human", name: "person", color: "#123456", muted: false, locked: false, count: 1,
    initial: { x: 100, y: 100, yaw: 0, roomId: "" },
    actions: [{ id: "action", name: "wait", type: "wait", position: 3, runSeconds: 2, x: 100, y: 100,
      yaw: 0, roomId: "", targetId: "target", text: "", state: "meeting" }],
  };
  const file = { name: "maps.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({
    schema: "fleet-scene/v1", name: "source", maps: [
      seedMap({ name: "選択するマップ", tracks: [actor] }), seedMap({ id: "other", name: "選択しないマップ" }),
      seedMap({ id: "another", name: "もう一つのマップ" }),
    ],
  })) };
  const input = page.locator('input[type="file"]');
  await input.setInputFiles(file);
  let dialog = page.getByRole("dialog", { name: "JSONからマップを追加" });
  await expect(dialog.locator("svg[data-map-preview]")).toHaveCount(3);
  await dialog.getByRole("checkbox", { name: "選択するマップ" }).check();
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  expect(await latestRevision(page)).toBe(before);
  await input.setInputFiles(file);
  dialog = page.getByRole("dialog", { name: "JSONからマップを追加" });
  await dialog.getByRole("checkbox", { name: "選択するマップ" }).check();
  await dialog.getByRole("checkbox", { name: "もう一つのマップ" }).check();
  await dialog.getByRole("button", { name: "選択したマップを追加" }).click();
  await waitSaved(page, before + 1);
  await page.reload();
  await expect(page.getByRole("tab", { name: "選択するマップ", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "もう一つのマップ", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "選択しないマップ", exact: true })).toHaveCount(0);
  const response = await page.request.get("/api/scenes/latest");
  const saved = await response.json();
  expect(saved.project.name).toBe("e2e");
  expect(saved.project.maps).toHaveLength(3);
  expect(saved.project.maps[0].id).toBe("map-e2e");
  expect(saved.project.maps[1].id).not.toBe("map-e2e");
  expect(saved.project.maps[1].tracks[0].actions[0]).toMatchObject({ name: "wait", position: 3, runSeconds: 2 });
});

test("selection exceeding the eight-map limit cannot be added", async ({ page }) => {
  await openSeeded(page, Array.from({ length: 7 }, (_, i) => seedMap({ id: `existing-${i}`, name: `既存${i}` })));
  const before = await latestRevision(page);
  await page.locator('input[type="file"]').setInputFiles({ name: "maps.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ schema: "fleet-scene/v1", name: "source", maps: [
      seedMap({ id: "one", name: "候補1" }), seedMap({ id: "two", name: "候補2" }),
    ] })) });
  const dialog = page.getByRole("dialog", { name: "JSONからマップを追加" });
  await dialog.getByRole("checkbox", { name: "候補1" }).check();
  await dialog.getByRole("checkbox", { name: "候補2" }).check();
  await expect(dialog.getByRole("alert")).toContainText("上限");
  await expect(dialog.getByRole("button", { name: "選択したマップを追加" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "候補2" }).uncheck();
  await dialog.getByRole("button", { name: "選択したマップを追加" }).click();
  await waitSaved(page, before + 1);
  await expect(page.getByRole("tab", { name: "候補1", exact: true })).toBeVisible();
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
