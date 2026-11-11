import { expect, test, type Page } from "@playwright/test";
import { appAlert, cellsOf, latestRevision, openSeeded, seedMap, waitSaved } from "./helpers";

test.describe.configure({ mode: "serial" });

const act = (id: string, name: string, type: string, position: number, runSeconds: number, extra: Record<string, unknown> = {}) => ({
  id, name, type, position, runSeconds, x: 210, y: 110, yaw: 0, roomId: "r1", targetId: `t-${id}`, text: "", state: "meeting", ...extra,
});
const track = (id: string, kind: string, name: string, color: string, actions: unknown[], extra: Record<string, unknown> = {}) =>
  ({ id, kind, name, color, muted: false, locked: false, actions, ...extra });
const room = { id: "r1", name: "会議室", color: "#8d9bff", kind: "room", material: "concrete", cells: cellsOf(2, 2, 50, 28) };

export const timelineMap = (over: { locked?: boolean } = {}) => seedMap({
  rooms: [room],
  tracks: [
    track("rb", "robot", "ロボット 1", "#8d9bff", [
      act("m1", "移動A", "move", 1, 6, { x: 410 }),
      act("m2", "移動B", "move", 9, 4, { x: 610 }),
      act("m3", "移動C", "move", 16, 3, { x: 810 }),
    ], { initial: { x: 110, y: 110, yaw: 0, roomId: "r1" }, robotId: "rb1", robotRole: "cleaning" }),
    track("hm", "human", "人 1", "#58d8ca", [act("h1", "歩く", "move", 2, 5, { y: 310 })],
      { initial: { x: 110, y: 510, yaw: 0, roomId: "r1" }, count: 3 }),
    track("rm", "room", "会議室", "#ffbd70", [act("e1", "会議", "event-start", 4, 8)], { roomId: "r1" }),
    track("ds", "display", "表示", "#ec87c7", [act("s1", "案内", "show", 3, 5, { text: "hi" })], { locked: over.locked ?? true }),
  ],
});

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
