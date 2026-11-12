import { expect, test } from "@playwright/test";
import { cellsOf, openSeeded, seedMap } from "./helpers";
import { act, track } from "./timeline-fixture";

const room = { id: "r1", name: "会議室", color: "#8d9bff", kind: "room", material: "wood", cells: cellsOf(2, 2, 50, 28) };
const map = () => seedMap({
  rooms: [room],
  presentation: { version: 1, scenarioId: "e2e", cues: [
    { kind: "notice", start: 0, end: 4, label: "最初のお知らせ", color: "#ff9a3d" },
    { kind: "zone", start: 0, end: 20, label: "ゾーン", color: "#58d8ca", x: 60, y: 60, width: 220, height: 120 },
    { kind: "dirt", start: 5, end: 8, label: "汚れ", color: "#c9a26b", x: 320, y: 60, width: 220, height: 120 },
    { kind: "route", start: 5, end: 8, label: "経路", color: "#7ee081", points: [[400, 300], [600, 300], [600, 450]] },
  ] },
  tracks: [track("rb", "robot", "ロボット 1", "#8d9bff", [act("mv", "移動", "move", 0, 10, { x: 410, y: 110 })],
    { initial: { x: 110, y: 110, yaw: 0, roomId: "r1" }, robotId: "rb1", robotRole: "cleaning" })],
});

const stage = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "マップ" });
const cue = (page: import("@playwright/test").Page, kind: string) => stage(page).locator(`[data-scenario-cue="${kind}"]`);

test("the map stage draws the cues that are active at the playback time, and they come and go as it moves", async ({ page }) => {
  await openSeeded(page, [map()], 1280);
  await expect(cue(page, "zone")).toHaveCount(1);
  await expect(cue(page, "notice")).toHaveCount(1);
  await expect(cue(page, "dirt")).toHaveCount(0);
  await page.getByLabel("再生位置").fill("5.5");
  await expect(cue(page, "dirt")).toHaveCount(1);
  await expect(cue(page, "route")).toHaveCount(1);
  await expect(cue(page, "notice")).toHaveCount(0);
  await expect(cue(page, "zone")).toHaveCount(1);
  await page.getByLabel("再生位置").fill("9");
  await expect(cue(page, "dirt")).toHaveCount(0);
  await expect(cue(page, "route")).toHaveCount(0);
});

test("the full-screen preview draws the same cues", async ({ page }) => {
  await openSeeded(page, [map()], 1280);
  await page.getByRole("button", { name: "全画面プレビュー" }).click();
  const preview = page.getByRole("dialog", { name: "全画面プレビュー" });
  await expect(preview.locator('[data-scenario-cue="zone"]')).toHaveCount(1);
  await expect(preview.locator('[data-scenario-cue="notice"]')).toHaveCount(1);
});

test("the editor draws notices full width, and cues never intercept the pointer", async ({ page }) => {
  await openSeeded(page, [map()], 1280);
  const bar = cue(page, "notice").locator("rect");
  const svg = stage(page).locator("svg[role=img]");
  const [barBox, svgBox] = [(await bar.boundingBox())!, (await svg.boundingBox())!];
  // The fit-sized map is letterboxed inside the svg, so compare with the width the map is actually drawn at.
  const [, , vbW, vbH] = (await svg.getAttribute("viewBox"))!.split(/\s+/).map(Number);
  const drawnWidth = Math.min(svgBox.width, svgBox.height * (vbW / vbH));
  expect(barBox.width).toBeGreaterThan(drawnWidth * 0.9);
  await expect(cue(page, "zone")).toHaveAttribute("pointer-events", "none");
});
