import { expect, test, type Page } from "@playwright/test";
import { appAlert, latestRevision, openSeeded, waitSaved } from "./helpers";
import { savedAction, savedTracks, timelineMap } from "./timeline-fixture";

test.describe.configure({ mode: "serial" });

const lane = (page: Page, name: string) => page.getByRole("group", { name: `${name} の動作` });
const bar = (page: Page, id: string) => page.locator(`[role="button"][data-action-id="${id}"]`);
const handle = (page: Page, id: string) => page.locator(`[role="slider"][data-action-id="${id}"]`);
const ruler = (page: Page) => page.locator('[data-part="ruler"]');

async function open(page: Page, width = 1280) {
  await openSeeded(page, [timelineMap()], width);
  await ruler(page).scrollIntoViewIfNeeded();
}

test("rows, bars and the ruler are shown", async ({ page }) => {
  await open(page);
  for (const name of ["ロボット 1", "人 1", "会議室", "表示"]) await expect(lane(page, name)).toBeVisible();
  for (const id of ["m1", "m2", "m3", "h1", "e1", "s1"]) await expect(bar(page, id)).toBeVisible();
  await expect(ruler(page)).toBeVisible();
  await expect(ruler(page).getByText("10s", { exact: true })).toBeVisible();
  await expect(bar(page, "m1")).toHaveAttribute("aria-label", /移動A.*1\.0〜7\.0秒/);
  await expect(appAlert(page)).toHaveCount(0);
});
