import { expect, test } from "@playwright/test";
import { startSimFleet } from "../scripts/simFleet";
import { openSeeded, seedMap } from "./helpers";
import { act, room, track } from "./timeline-fixture";

test("a scene runs from /run to the end with a simulated robot; the editor is locked meanwhile", async ({ page }, testInfo) => {
  const port = new URL(testInfo.project.use.baseURL ?? "http://localhost:3117").port;
  const fleet = await startSimFleet(port, [{ x: 110, y: 110 }]);
  try {
    const scene = seedMap({
      id: "run-map", name: "run map", rooms: [room],
      tracks: [track("rb", "robot", "ロボット 1", "#8d9bff", [act("m1", "移動A", "move", 1, 6, { x: 410, y: 110 })],
        { initial: { x: 110, y: 110, yaw: 0, roomId: "r1" }, robotId: "robot-sim0", robotRole: "cleaning" })],
    });
    await openSeeded(page, [scene], 1280);
    await page.goto("/run");
    await page.getByLabel("実行するシーン").selectOption("run-map");
    await expect(page.getByRole("region", { name: "実行前の確認" })).toBeVisible();
    await expect(page.getByRole("button", { name: "開始" })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole("button", { name: "開始" }).click();
    await expect(page.getByText("実行中", { exact: true })).toBeVisible();

    await page.goto("/scenes");
    await expect(page.getByText("シーンを実行中です")).toBeVisible();

    await page.goto("/run");
    await expect(page.getByText("完了", { exact: true })).toBeVisible({ timeout: 40_000 });
    await expect(page.getByRole("region", { name: "動作ごとの結果" }).getByText("到着確認")).toBeVisible();
  } finally {
    fleet.stop();
  }
});
