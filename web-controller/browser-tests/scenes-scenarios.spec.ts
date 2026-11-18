import { expect, test, type Locator, type Page } from "@playwright/test";
import { mmToSvg, svgToMm } from "../scene/mapView";
import { copyMapLayout, createProject, newAction, newTrack, validateProject } from "../scene/model";
import { addDoorAt, addGate, renameFixture } from "../scene/mapEditFixtures";
import { compilePlan, samplePlan } from "../scene/timedPlan";
import { SCENARIO_CATALOG, SIXTEEN_SCENARIO_IDS } from "../scene/scenarioLibrary";
import type { AppendRequest, SceneHistoryRecord } from "../scene/historyTypes";
import type { SceneProject } from "../scene/types";
import { cellsOf, openScenes, waitSaved } from "./helpers";
import { timelineMap } from "./timeline-fixture";

async function mockHistory(page: Page, project: SceneProject) {
  let record: SceneHistoryRecord = {
    revision: 1, id: "scenario-test", timestamp: new Date().toISOString(), label: "seed", hash: "test",
    restoredFrom: null, project,
  };
  // Keep the user's running server and saved projects untouched.
  await page.route("**/api/scenes/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/scenes/latest" && request.method() === "GET") {
      await route.fulfill({ json: record });
    } else if (pathname === "/api/scenes/history" && request.method() === "POST") {
      const body = request.postDataJSON() as AppendRequest;
      expect(body.expectedRevision).toBe(record.revision);
      record = { ...record, revision: record.revision + 1, id: body.id, label: body.label, project: validateProject(body.project) };
      await route.fulfill({ status: 201, json: record });
    } else {
      throw new Error(`Unexpected scene API request: ${request.method()} ${pathname}`);
    }
  });
  return () => record;
}

async function mapPoint(dialog: Locator, point: { x: number; y: number }) {
  return dialog.locator('svg[role="img"]').evaluate((node, at) => {
    if (!(node instanceof SVGSVGElement)) throw new Error("Missing picker map");
    const matrix = node.getScreenCTM();
    if (!matrix) throw new Error("Missing map transform");
    const result = new DOMPoint(at.x, at.y).matrixTransform(matrix);
    return { x: result.x, y: result.y };
  }, mmToSvg(point));
}

async function expectMarker(dialog: Locator, point: { x: number; y: number }) {
  const at = await dialog.getByTestId("picker-marker").evaluate((node) => {
    if (!(node instanceof SVGGElement)) throw new Error("Missing picker marker");
    const matrix = node.transform.baseVal.consolidate()?.matrix;
    if (!matrix) throw new Error("Missing marker transform");
    return { x: matrix.e, y: matrix.f };
  });
  const actual = svgToMm(at);
  expect(Math.abs(actual.x - point.x)).toBeLessThan(3);
  expect(Math.abs(actual.y - point.y)).toBeLessThan(3);
}

async function dragMarker(page: Page, dialog: Locator, from: { x: number; y: number }, to: { x: number; y: number }) {
  const start = await mapPoint(dialog, from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const end = await mapPoint(dialog, to);
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
}

async function actorPose(actor: Locator) {
  return actor.evaluate((node) => {
    if (!(node instanceof SVGGElement)) throw new Error("Missing actor");
    const matrix = node.transform.baseVal.consolidate()?.matrix;
    if (!matrix) throw new Error("Missing actor transform");
    return { x: matrix.e, y: 620 - matrix.f };
  });
}

function fixtureEditingProject() {
  const project = createProject("設備の配置確認");
  project.maps[0].rooms = [{
    id: "floor", name: "床", kind: "corridor", material: "concrete", color: "#739a81",
    cells: Array.from({ length: 1705 }, (_, i) => i),
  }];
  project.maps[0].floorPlan = {
    doors: [], furniture: [], walls: [{ id: "wall", roomId: "floor", x1: 200, y1: 300, x2: 900, y2: 300 }],
  };
  return project;
}

test("equipment rows select fixtures, save open windows, reopen from row management and replay after reload", async ({ page }) => {
  const project = fixtureEditingProject();
  const options = { roomId: "floor", edge: "auto" as const, cells: 10, maxDistance: 24 };
  const first = addDoorAt(project.maps[0], 300, 300, options);
  const second = addDoorAt(first.map, 700, 300, options);
  const gate = addGate(second.map, cellsOf(10, 5, 19, 5), "bottom", 10);
  project.maps[0] = renameFixture(renameFixture(renameFixture(gate.map, first.doorId, "自動ドア A"), second.doorId, "自動ドア B"), gate.doorId, "ゲート C");
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  const sequence = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  const apply = sequence.getByRole("button", { name: "適用", exact: true });
  for (const target of [
    { kind: "自動ドア", id: second.doorId, start: 2, end: 5 },
    { kind: "フラッパーゲート", id: gate.doorId, start: 3, end: 6 },
  ]) {
    await page.getByRole("combobox", { name: `${target.kind}の対象設備`, exact: true }).selectOption(target.id);
    await page.getByRole("button", { name: `＋ ${target.kind}`, exact: true }).click();
    await expect(sequence).toBeVisible();
    await sequence.getByLabel("開始（秒）", { exact: true }).fill("3.2");
    await sequence.getByLabel("終了（秒）", { exact: true }).fill("3.3");
    await expect(apply).toBeEnabled();
    await sequence.getByLabel("開始（秒）", { exact: true }).focus();
    await expect(sequence.getByLabel("終了（秒）", { exact: true })).toHaveValue("3.3");
    await sequence.getByLabel("開始（秒）", { exact: true }).fill(String(target.start));
    await sequence.getByLabel("終了（秒）", { exact: true }).fill("1");
    await expect(apply).toBeDisabled();
    await sequence.getByLabel("終了（秒）", { exact: true }).fill(String(target.end));
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(sequence).toBeHidden();
    await waitSaved(page);
    const owner = saved().project.maps[0].tracks.find((track) => track.doorId === target.id)!;
    expect(owner.kind).toBe("door");
    expect(owner.actions).toHaveLength(1);
    expect(owner.actions[0]).toMatchObject({ type: "door-open", doorId: target.id, position: target.start, runSeconds: target.end - target.start });
  }
  await expect(page.getByRole("button", { name: "＋ フラッパーゲート", exact: true })).toBeDisabled();
  const stage = page.getByRole("region", { name: "マップ", exact: true });
  const leaf = (id: string) => stage.locator(`[data-door-id="${id}"] [data-part="door-leaf"]`);
  const time = page.getByRole("slider", { name: "再生位置", exact: true });
  for (const [at, automaticOpen, gateOpen] of [
    [0, 0, 0], [2, 0, 0], [2.3, 0.5, 0], [2.6, 1, 0], [3, 1, 0], [3.3, 1, 0.5],
    [3.6, 1, 1], [5, 1, 1], [5.3, 0.5, 1], [5.6, 0, 1], [6, 0, 1], [6.3, 0, 0.5], [6.6, 0, 0], [3, 1, 0], [0, 0, 0],
  ]) {
    await time.fill(String(at));
    await expect(leaf(first.doorId)).toHaveAttribute("data-openness", "0");
    await expect(leaf(second.doorId)).toHaveAttribute("data-openness", String(automaticOpen));
    await expect(leaf(gate.doorId)).toHaveAttribute("data-openness", String(gateOpen));
  }
  await page.getByRole("combobox", { name: "速度", exact: true }).selectOption("4");
  await page.getByRole("button", { name: "再生", exact: true }).click();
  await expect(leaf(gate.doorId)).toHaveAttribute("data-openness", "1");
  await expect(leaf(gate.doorId)).toHaveAttribute("data-openness", "0");
  await expect(page.getByRole("button", { name: "再生", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "＋ 開閉指示", exact: true }).click();
  await sequence.getByLabel("開始（秒）", { exact: true }).fill("8");
  await sequence.getByLabel("終了（秒）", { exact: true }).fill("10");
  await sequence.getByRole("button", { name: "キャンセル", exact: true }).click();
  await sequence.getByRole("button", { name: "破棄して閉じる", exact: true }).click();
  const savedGate = () => saved().project.maps[0].tracks.find((track) => track.doorId === gate.doorId)!;
  expect(savedGate().actions).toHaveLength(1);
  await page.getByRole("button", { name: "＋ 開閉指示", exact: true }).click();
  await sequence.getByLabel("開始（秒）", { exact: true }).fill("8");
  await sequence.getByLabel("終了（秒）", { exact: true }).fill("10");
  await apply.click();
  await waitSaved(page);
  expect(savedGate().actions).toHaveLength(2);
  await time.fill("9");
  await expect(leaf(gate.doorId)).toHaveAttribute("data-openness", "1");
  await time.fill("10.6");
  await expect(leaf(gate.doorId)).toHaveAttribute("data-openness", "0");
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await waitSaved(page);
  expect(savedGate().actions).toHaveLength(1);
  await page.locator(`[role="button"][data-action-id="${savedGate().actions[0].id}"]`).dblclick();
  await sequence.getByLabel("終了（秒）", { exact: true }).fill("7");
  await apply.click();
  await waitSaved(page);
  expect(savedGate().actions[0].runSeconds).toBe(4);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await waitSaved(page);
  expect(savedGate().actions[0].runSeconds).toBe(3);
  await page.getByRole("button", { name: "やり直し", exact: true }).click();
  await waitSaved(page);
  expect(savedGate().actions[0].runSeconds).toBe(4);
  for (const role of ["button", "slider"] as const) {
    const target = page.locator(`[role="${role}"][data-action-id="${savedGate().actions[0].id}"]`);
    const box = (await target.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 26, y, { steps: 5 });
    await page.mouse.up();
    await waitSaved(page);
    expect(savedGate().actions[0]).toMatchObject({ position: 4, runSeconds: role === "button" ? 4 : 5 });
  }
  for (let count = 0; count < 2; count++) {
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await waitSaved(page);
  }
  expect(savedGate().actions[0]).toMatchObject({ position: 3, runSeconds: 4 });
  await page.getByRole("button", { name: "ゲート C 除外", exact: true }).click();
  await time.fill("4");
  await expect(leaf(gate.doorId)).toHaveAttribute("data-openness", "0");
  await page.getByRole("button", { name: "ゲート C 除外", exact: true }).click();
  await expect(leaf(gate.doorId)).toHaveAttribute("data-openness", "1");
  await page.getByRole("button", { name: "ゲート C 固定", exact: true }).click();
  await expect(page.getByRole("button", { name: "＋ 開閉指示", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "ゲート C 固定", exact: true }).click();
  await waitSaved(page);
  await page.reload();
  await expect(page.getByRole("group", { name: "ゲート C の動作", exact: true })).toBeVisible();
  await time.fill("6");
  await expect(leaf(gate.doorId)).toHaveAttribute("data-openness", "1");
  await time.fill("7.6");
  await expect(leaf(gate.doorId)).toHaveAttribute("data-openness", "0");
  await time.fill("4");
  await page.screenshot({ path: test.info().outputPath("equipment-windows.png") });
});

test("plant rectangle dragging keeps its full wide footprint visible after apply and reload", async ({ page }) => {
  const saved = await mockHistory(page, fixtureEditingProject());
  await openScenes(page, 1600);
  await page.getByRole("button", { name: "マップを編集", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "マップを編集", exact: true });
  await editor.getByRole("button", { name: "部屋編集", exact: true }).click();
  await editor.getByRole("button", { name: "家具", exact: true }).click();
  await editor.getByRole("combobox", { name: "家具の種類", exact: true }).selectOption("plant");
  const start = await mapPoint(editor, { x: 110, y: 110 });
  const end = await mapPoint(editor, { x: 250, y: 130 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  const ellipse = editor.locator("[data-furniture-id] ellipse");
  await expect(ellipse).toHaveAttribute("rx", "80");
  await expect(ellipse).toHaveAttribute("ry", "20");
  await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(ellipse).toHaveCount(0);
  await editor.getByRole("button", { name: "やり直し", exact: true }).click();
  await expect(ellipse).toBeVisible();
  await dragMarker(page, editor, { x: 350, y: 110 }, { x: 370, y: 250 });
  await expect(ellipse.nth(1)).toHaveAttribute("rx", "20");
  await expect(ellipse.nth(1)).toHaveAttribute("ry", "80");
  await editor.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect(editor).toBeHidden();
  await waitSaved(page);
  expect(saved().project.maps[0].floorPlan!.furniture[0].cells).toHaveLength(16);
  await page.reload();
  const reloaded = page.getByRole("region", { name: "マップ", exact: true }).locator("[data-furniture-id] ellipse");
  await expect(reloaded).toHaveCount(2);
  await expect(reloaded.first()).toHaveAttribute("rx", "80");
  await expect(reloaded.nth(1)).toHaveAttribute("ry", "80");
});

for (const tool of ["自動ドア", "フラッパーゲート"] as const) {
  test(`${tool} follows the cursor, rejects invalid spots and commits on pointer release`, async ({ page }) => {
    const saved = await mockHistory(page, fixtureEditingProject());
    await openScenes(page, 1600);
    await page.getByRole("button", { name: "マップを編集", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "マップを編集", exact: true });
    await editor.getByRole("button", { name: "部屋編集", exact: true }).click();
    await editor.getByRole("button", { name: tool, exact: true }).click();
    await editor.getByRole("combobox", { name: "入口幅", exact: true }).selectOption("7");
    const gate = tool === "フラッパーゲート";
    if (gate) await editor.getByRole("combobox", { name: "ゲートの奥行き", exact: true }).selectOption("3");
    const preview = editor.locator(`[data-part="${gate ? "gate" : "door"}-placement-preview"]`);
    const move = async (x: number, y: number) => {
      const at = await mapPoint(editor, { x, y });
      await page.mouse.move(at.x, at.y, { steps: 3 });
      return at;
    };
    const y = gate ? 150 : 300;
    await move(400, y);
    await expect(preview).toBeAttached();
    await expect(preview).toHaveCSS("stroke", /rgb\(/);
    if (gate) await expect(preview).toHaveAttribute("data-valid", "true");
    const first = await preview.getAttribute(gate ? "x" : "d");
    await move(600, y);
    await expect(preview).not.toHaveAttribute(gate ? "x" : "d", first!);
    await expect(editor.locator("[data-door-id]")).toHaveCount(0);
    await page.mouse.down();
    await move(700, y);
    await page.mouse.up();
    if (gate) {
      await expect(editor.locator("[data-door-id]")).toHaveCount(1);
      await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
    }
    await expect(editor.locator("[data-door-id]")).toHaveCount(0);
    const bad = await move(500, gate ? 300 : 150);
    if (gate) await expect(preview).toHaveAttribute("data-valid", "false");
    else await expect(preview).toHaveCount(0);
    await page.mouse.click(bad.x, bad.y);
    await expect(editor.getByRole("alert")).toBeVisible();
    await expect(editor.locator("[data-door-id]")).toHaveCount(0);
    const good = await move(600, y);
    await expect(preview).toBeAttached();
    await page.mouse.click(good.x, good.y);
    await expect(editor.locator("[data-door-id]")).toHaveCount(1);
    await expect(preview).toHaveCount(0);
    await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(editor.locator("[data-door-id]")).toHaveCount(0);
    await editor.getByRole("button", { name: "やり直し", exact: true }).click();
    await expect(editor.locator("[data-door-id]")).toHaveCount(1);
    await editor.getByRole("button", { name: "マップに適用", exact: true }).click();
    await expect(editor).toBeHidden();
    await waitSaved(page);
    expect(saved().project.maps[0].floorPlan!.doors).toHaveLength(1);
    expect(saved().project.maps[0].floorPlan!.doors[0].kind).toBe(gate ? "flapper" : "automatic");
    if (gate) expect(saved().project.maps[0].floorPlan!.walls).toHaveLength(4);
  });
}

test("automatic doors highlight every side of a newly drawn room and persist the clicked opening", async ({ page }) => {
  const saved = await mockHistory(page, createProject("部屋の自動ドア"));
  await openScenes(page, 1600);
  await page.getByRole("button", { name: "マップを編集", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "マップを編集", exact: true });
  await editor.getByRole("button", { name: "＋新しい領域", exact: true }).click();
  await editor.getByRole("button", { name: "長方形ドラッグ", exact: true }).click();
  await dragMarker(page, editor, { x: 110, y: 110 }, { x: 490, y: 490 });
  await editor.getByRole("button", { name: "部屋編集", exact: true }).click();
  await editor.getByRole("button", { name: "自動ドア", exact: true }).click();
  const preview = editor.locator('[data-part="door-placement-preview"]');
  for (const point of [{ x: 300, y: 98 }, { x: 300, y: 102 }, { x: 498, y: 300 }, { x: 502, y: 300 },
    { x: 300, y: 498 }, { x: 300, y: 502 }, { x: 98, y: 300 }, { x: 102, y: 300 }]) {
    const at = await mapPoint(editor, point);
    await page.mouse.move(at.x, at.y, { steps: 2 });
    await expect(preview).toBeAttached();
    await expect(preview).toHaveCSS("stroke", /rgb\(/);
    await expect(editor.locator("[data-door-id]")).toHaveCount(0);
  }
  const at = await mapPoint(editor, { x: 300, y: 102 });
  await page.mouse.click(at.x, at.y);
  await expect(editor.locator("[data-door-id]")).toHaveCount(1);
  const openingBlocked = await editor.locator('[data-part="floor-walls"] line').evaluateAll((lines) => lines.some((line) => {
    const coordinate = (name: string) => Number(line.getAttribute(name));
    return coordinate("y1") === 520 && coordinate("y2") === 520 && coordinate("x1") <= 300 && coordinate("x2") >= 300;
  }));
  expect(openingBlocked).toBe(false);
  await editor.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect(editor).toBeHidden();
  await waitSaved(page);
  expect(saved().project.maps[0].floorPlan!.doors).toHaveLength(10);
  await page.reload();
  await expect(page.getByRole("region", { name: "マップ", exact: true }).locator("[data-door-id]")).toHaveCount(1);
});

for (const entrance of ["bottom", "left"] as const) {
  test(`new floor gate ${entrance} varies width by dragging while keeping compact side frames`, async ({ page }) => {
    const project = fixtureEditingProject();
    project.maps[0].floorPlan!.walls = [];
    const saved = await mockHistory(page, project);
    await openScenes(page, 1600);
    await page.getByRole("button", { name: "マップを編集", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "マップを編集", exact: true });
    await editor.getByRole("button", { name: "部屋編集", exact: true }).click();
    await editor.getByRole("button", { name: "フラッパーゲート", exact: true }).click();
    await editor.getByRole("combobox", { name: "入口の向き", exact: true }).selectOption(entrance);
    await expect(editor.getByRole("combobox", { name: "ゲートの奥行き", exact: true })).toHaveValue("1");
    const vertical = entrance === "left";
    const preview = editor.locator('[data-part="gate-placement-preview"]');
    const start = await mapPoint(editor, { x: 410, y: 310 });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const [width, end] of [
      [240, { x: vertical ? 430 : 630, y: vertical ? 530 : 330 }],
      [140, { x: vertical ? 430 : 530, y: vertical ? 430 : 330 }],
      [240, { x: vertical ? 430 : 630, y: vertical ? 530 : 330 }],
    ] as const) {
      const at = await mapPoint(editor, end);
      await page.mouse.move(at.x, at.y, { steps: 3 });
      await expect(preview).toHaveAttribute("data-valid", "true");
      await expect(preview).toHaveAttribute(vertical ? "height" : "width", String(width));
      await expect(preview).toHaveAttribute(vertical ? "width" : "height", "20");
      await expect(editor.locator("[data-door-id]")).toHaveCount(0);
    }
    await page.mouse.up();
    await expect(preview).toHaveCount(0);
    await expect(editor.locator("[data-door-id]")).toHaveCount(1);
    await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(editor.locator("[data-door-id]")).toHaveCount(0);
    await editor.getByRole("button", { name: "やり直し", exact: true }).click();
    await expect(editor.locator("[data-door-id]")).toHaveCount(1);
    const cancelAt = await mapPoint(editor, { x: 110, y: 110 });
    await page.mouse.move(cancelAt.x, cancelAt.y);
    await page.mouse.down();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(editor).toBeVisible();
    await expect(preview).toHaveCount(0);
    await expect(editor.locator("[data-door-id]")).toHaveCount(1);
    await page.mouse.move(cancelAt.x, cancelAt.y);
    await page.mouse.down();
    const outside = await mapPoint(editor, { x: 1150, y: 110 });
    await page.mouse.move(outside.x, outside.y);
    await page.mouse.up();
    await expect(editor.locator("[data-door-id]")).toHaveCount(1);
    await editor.getByRole("button", { name: "マップに適用", exact: true }).click();
    await expect(editor).toBeHidden();
    await waitSaved(page);
    const plan = saved().project.maps[0].floorPlan!;
    const door = plan.doors[0];
    expect(Math.hypot(door.x2! - door.x1!, door.y2! - door.y1!)).toBe(240);
    expect(plan.walls!.slice(0, 2).every((wall) => Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1) === 20)).toBe(true);
    await page.reload();
    await expect(page.getByRole("region", { name: "マップ", exact: true }).locator('[data-door-kind="flapper"]')).toHaveCount(1);
  });

  test(`floor flapper ${entrance} slides both panels apart and closes like an automatic door`, async ({ page }) => {
    const project = fixtureEditingProject();
    const vertical = entrance === "left";
    let map = project.maps[0];
    map.doorMode = "strict";
    map.floorPlan!.walls = [];
    const gate = addGate(map, vertical ? cellsOf(13, 2, 16, 11) : cellsOf(10, 13, 19, 16), entrance, 10);
    map = gate.map;
    map.floorPlan!.walls!.push({
      id: "automatic-wall", roomId: "floor",
      ...(vertical ? { x1: 300, y1: 340, x2: 300, y2: 540 } : { x1: 700, y1: 300, x2: 900, y2: 300 }),
    });
    const automatic = addDoorAt(map, vertical ? 300 : 800, vertical ? 440 : 300,
      { roomId: "floor", edge: "auto", cells: 10, maxDistance: 24 });
    map = automatic.map;
    (vertical ? [140, 440] : [300, 800]).forEach((across, index) => {
      const robot = newTrack(map, "robot");
      robot.initial = { x: vertical ? 100 : across, y: vertical ? across : 100, yaw: vertical ? 0 : 90, roomId: "floor" };
      robot.robotId = `door-test-${index}`;
      const move = newAction(map, robot, "move");
      Object.assign(move, { position: 2, runSeconds: 4, x: vertical ? 500 : across, y: vertical ? across : 500,
        yaw: vertical ? 0 : 90, roomId: "floor" });
      robot.actions = [move];
      map.tracks.push(robot);
    });
    const control = newTrack(map, "room");
    const unlock = newAction(map, control, "unlock");
    Object.assign(unlock, { position: 0, runSeconds: 10, roomId: "floor" });
    control.actions = [unlock];
    map.tracks.push(control);
    project.maps[0] = map;
    const plan = compilePlan(map);
    expect(plan.errors).toEqual([]);
    await mockHistory(page, project);
    await openScenes(page, 1600);
    const stage = page.getByRole("region", { name: "マップ", exact: true });
    const gateLeaf = stage.locator(`[data-door-id="${gate.doorId}"] [data-part="door-leaf"]`);
    const automaticLeaf = stage.locator(`[data-door-id="${automatic.doorId}"] [data-part="door-leaf"]`);
    const time = page.getByRole("slider", { name: "再生位置", exact: true });
    for (const at of [0, 2.4, 4, 5.6, 7, 2.4, 0]) {
      const openness = samplePlan(plan, at).doors.find((door) => door.id === gate.doorId)!.openness;
      if (at === 0 || at === 7) expect(openness).toBe(0);
      else if (at === 4) expect(openness).toBe(1);
      else { expect(openness).toBeGreaterThan(0); expect(openness).toBeLessThan(1); }
      await time.fill(String(at));
      for (const leaf of [gateLeaf, automaticLeaf]) {
        await expect(leaf).toHaveAttribute("data-openness", String(openness));
        const start = leaf.locator('[data-part="door-panel-start"]');
        const end = leaf.locator('[data-part="door-panel-end"]');
        await expect(leaf).toHaveAttribute("data-material", "glass");
        const half = Number(await start.getAttribute("width"));
        await expect(start).toHaveAttribute("transform", `translate(${-half * openness} 0)`);
        await expect(end).toHaveAttribute("transform", `translate(${half * openness} 0)`);
        expect(Number(await end.getAttribute("x"))).toBe(half);
        expect(Number(await end.getAttribute("width"))).toBe(half);
        const pixels = await leaf.evaluate(async (node) => {
          const defs = node.parentElement?.querySelector("defs");
          const end = node.querySelector('[data-part="door-panel-end"]');
          if (!defs || !end) throw new Error("Missing door panels or their frame clipping");
          const length = Number(end.getAttribute("x")) + Number(end.getAttribute("width"));
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("width", String(length * 2));
          svg.setAttribute("height", "8");
          svg.setAttribute("viewBox", `${-length / 2} -4 ${length * 2} 8`);
          svg.append(defs.cloneNode(true), node.cloneNode(true));
          const image = new Image();
          image.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = length * 2; canvas.height = 8;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas is unavailable");
          context.drawImage(image, 0, 0);
          const row = context.getImageData(0, 4, canvas.width, 1).data;
          let outside = 0, visible = 0, maxAlpha = 0;
          for (let x = 0; x < canvas.width; x++) {
            if (!row[x * 4 + 3]) continue;
            visible++;
            maxAlpha = Math.max(maxAlpha, row[x * 4 + 3]);
            if (x + 1 <= length / 2 || x >= length * 1.5) outside++;
          }
          return { outside, visible, maxAlpha };
        });
        expect(pixels.outside).toBe(0);
        expect(Math.abs(pixels.visible - half * 2 * (1 - openness))).toBeLessThanOrEqual(2);
        if (openness === 1) expect(pixels.visible).toBe(0);
        else {
          expect(pixels.maxAlpha).toBeGreaterThan(0);
          expect(pixels.maxAlpha).toBeLessThan(255);
        }
      }
      await expect(gateLeaf).toHaveAttribute("stroke", (await automaticLeaf.getAttribute("stroke"))!);
    }
    await page.reload();
    await expect(gateLeaf).toHaveAttribute("data-openness", "0");
    await expect(stage.locator('[data-door-kind="flapper"]')).toHaveCount(1);
  });
}

test("map reuse selects thumbnail previews and copies only the chosen layout without changing its source", async ({ page }) => {
  const first = validateProject({ schema: "fleet-scene/v1", name: "元の配置", maps: [timelineMap()] }).maps[0];
  const second = copyMapLayout(first, "別の配置");
  second.rooms[0].cells = cellsOf(2, 2, 20, 20);
  const project = validateProject({ schema: "fleet-scene/v1", name: "マップ再利用確認", maps: [first, second] });
  const original = structuredClone(project);
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  await waitSaved(page);
  await page.getByRole("button", { name: "マップを追加", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "マップを追加", exact: true });
  await expect(dialog.getByRole("radio")).toHaveCount(3);
  const preview = dialog.locator(`[data-map-preview="${first.id}"]`);
  const other = dialog.locator(`[data-map-preview="${second.id}"]`);
  await expect(preview).toBeVisible();
  await expect(other).toBeVisible();
  const bounds = await preview.boundingBox();
  expect(bounds!.width).toBeGreaterThanOrEqual(160);
  expect(bounds!.height).toBeGreaterThanOrEqual(90);
  expect(Math.abs(bounds!.width / bounds!.height - 1100 / 620)).toBeLessThan(0.1);
  expect(await preview.locator("path").first().getAttribute("d")).not.toBe(await other.locator("path").first().getAttribute("d"));
  await expect(dialog.locator("[data-actor-id]")).toHaveCount(0);
  await preview.click();
  await expect(dialog.getByRole("radio", { name: `「${first.name}」の配置をコピー`, exact: true })).toBeChecked();
  await dialog.getByLabel("マップ名", { exact: true }).fill("サムネイルから再利用");
  await dialog.getByRole("button", { name: "追加", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("dialog", { name: "マップを編集", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { selected: true })).toHaveText("サムネイルから再利用");
  await waitSaved(page);
  const copied = saved().project.maps[2];
  expect(copied.rooms[0].cells).toEqual(first.rooms[0].cells);
  expect(copied.rooms[0].id).not.toBe(first.rooms[0].id);
  expect(copied.tracks).toEqual([]);
  expect(saved().project.maps.slice(0, 2)).toEqual(original.maps);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await waitSaved(page);
  expect(saved().project.maps).toEqual(original.maps);
});

test("drawing a new map immediately opens the new map's editor and keeps source maps untouched", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "新規マップ確認", maps: [timelineMap()] });
  const original = structuredClone(project.maps[0]);
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  await waitSaved(page);
  const add = async (name: string) => {
    await page.getByRole("button", { name: "マップを追加", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "マップを追加", exact: true });
    await dialog.getByRole("radio", { name: "新しくマップを描く", exact: true }).check();
    await dialog.getByLabel("マップ名", { exact: true }).fill(name);
    await dialog.getByRole("button", { name: "追加", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "マップを編集", exact: true });
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("マップ名", { exact: true })).toHaveValue(name);
    return editor;
  };
  const cancelled = await add("白紙マップ");
  await cancelled.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByRole("tab", { selected: true })).toHaveText("白紙マップ");
  await waitSaved(page);
  expect(saved().project.maps[1].rooms).toEqual([]);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await waitSaved(page);
  const editor = await add("新規描画");
  await editor.getByLabel("マップ名", { exact: true }).fill("編集した新規マップ");
  await editor.getByRole("button", { name: "＋新しい領域", exact: true }).click();
  await editor.getByRole("button", { name: "長方形ドラッグ", exact: true }).click();
  const from = await mapPoint(editor, { x: 110, y: 110 });
  const to = await mapPoint(editor, { x: 310, y: 310 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await editor.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect(editor).toBeHidden();
  await waitSaved(page);
  await expect(page.getByRole("tab", { selected: true })).toHaveText("編集した新規マップ");
  expect(saved().project.maps[0]).toEqual(original);
  expect(saved().project.maps[1].name).toBe("編集した新規マップ");
  expect(saved().project.maps[1].rooms[0].cells).toHaveLength(121);
});

test("scenario selection adds complete stories with visible robots, supports undo and preserves the existing map", async ({ page }) => {
  test.setTimeout(120_000);
  const project = createProject("シナリオ確認");
  const original = structuredClone(project.maps[0]);
  const saved = await mockHistory(page, project);
  await openScenes(page);
  await waitSaved(page);
  for (const id of SIXTEEN_SCENARIO_IDS) {
    await page.getByRole("button", { name: "テストシナリオ集", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "テストシナリオ集" });
    await expect(dialog).toBeVisible();
    const background = await dialog.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(background).not.toMatch(/rgba\([^)]*,\s*0(?:\.\d+)?\)$/);
    await dialog.getByLabel("シナリオを選択").selectOption(id);
    await dialog.getByRole("button", { name: "マップとして追加" }).click();
    await expect(dialog).toBeHidden();
    await waitSaved(page);
    const title = SCENARIO_CATALOG.find((item) => item.id === id)!.title;
    await expect(page.getByRole("tab", { selected: true })).toHaveText(title);
    await expect(page.getByRole("tab")).toHaveCount(2);
    expect(saved().project.maps[0]).toEqual(original);
    const map = saved().project.maps[1];
    const actors = map.tracks.filter((track) => track.initial);
    const stage = page.getByRole("region", { name: "マップ", exact: true });
    await expect(stage.locator("[data-actor-id]")).toHaveCount(actors.length);
    for (const track of actors) await expect(stage.locator(`[data-actor-id="${track.id}"]`)).toBeVisible();
    await expect(stage.locator('[data-scenario-cue="notice"]').filter({ hasText: "SIMULATION ONLY" })).toBeVisible();
    if (id === "daily-security") {
      await page.getByRole("button", { name: "全画面プレビュー", exact: true }).click();
      const preview = page.getByRole("dialog", { name: "全画面プレビュー", exact: true });
      await expect(preview.locator("[data-actor-id]")).toHaveCount(3);
      await preview.getByRole("button", { name: "閉じる", exact: true }).click();
    }
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await waitSaved(page);
  }
});

test("scene edit commands and both shared modal shells preserve apply, discard and undo behavior", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "編集確認", maps: [timelineMap()] });
  const saved = await mockHistory(page, project);
  const savedTrack = (id: string) => saved().project.maps[0].tracks.find((track) => track.id === id)!;
  await openScenes(page, 1600);
  await waitSaved(page);
  const stage = page.getByRole("region", { name: "マップ", exact: true });
  const robot = stage.locator('[data-actor-id="rb"]');
  await robot.dblclick();
  const sequence = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await sequence.getByLabel("名称（120文字まで）").fill("破棄する変更");
  await sequence.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(sequence.getByRole("alertdialog")).toBeVisible();
  expect(savedTrack("rb").name).toBe("ロボット 1");
  await sequence.getByRole("button", { name: "破棄して閉じる", exact: true }).click();
  await expect(sequence).toBeHidden();

  await robot.dblclick();
  await sequence.getByLabel("名称（120文字まで）").fill("編集したロボット");
  await sequence.getByRole("button", { name: "適用", exact: true }).click();
  await expect(sequence).toBeHidden();
  await waitSaved(page);
  expect(savedTrack("rb").name).toBe("編集したロボット");
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await waitSaved(page);
  expect(savedTrack("rb").name).toBe("ロボット 1");

  const humanAction = page.locator('[role="button"][data-action-id="h1"]');
  await humanAction.dblclick();
  const action = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await action.getByLabel("アクション名").fill("歩行を確認");
  await action.getByRole("button", { name: "キャンセル", exact: true }).click();
  await action.getByRole("button", { name: "編集を続ける", exact: true }).click();
  await action.getByRole("button", { name: "適用", exact: true }).click();
  await expect(action).toBeHidden();
  await waitSaved(page);
  expect(savedTrack("hm").actions[0].name).toBe("歩行を確認");

  await humanAction.click();
  await page.getByRole("heading", { name: "ステージ", exact: true }).click();
  await page.keyboard.press("Control+d");
  await waitSaved(page);
  expect(savedTrack("hm").actions).toHaveLength(2);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await waitSaved(page);
  expect(savedTrack("hm").actions).toHaveLength(1);
  await humanAction.click();
  await page.getByRole("heading", { name: "ステージ", exact: true }).click();
  await page.keyboard.press("Delete");
  const confirmation = page.getByRole("dialog", { name: "動作の削除", exact: true });
  await confirmation.getByRole("button", { name: "削除", exact: true }).click();
  await waitSaved(page);
  expect(savedTrack("hm").actions).toHaveLength(0);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await waitSaved(page);
  expect(savedTrack("hm").actions[0].name).toBe("歩行を確認");
});

test("timeline fullscreen preserves zoom, selection and editing, and reports unavailable fullscreen", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "全画面確認", maps: [timelineMap()] });
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  await waitSaved(page);
  await expect(page.getByRole("button", { name: "＋ 選択中と同種の行を追加", exact: true })).toHaveCount(0);
  const axis = page.getByRole("region", { name: "時間軸", exact: true });
  const zoom = axis.getByRole("slider", { name: "ズーム", exact: true });
  await zoom.fill("53");
  const action = axis.locator('[role="button"][data-action-id="h1"]');
  await action.click();
  const expand = axis.getByRole("button", { name: "シーケンスを全画面表示", exact: true });
  await expand.click();
  await expect.poll(() => axis.evaluate(node => document.fullscreenElement === node)).toBe(true);
  await expect.poll(() => axis.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    return Math.abs(bounds.x) < 1 && Math.abs(bounds.y) < 1 &&
      Math.abs(bounds.width - innerWidth) < 2 && Math.abs(bounds.height - innerHeight) < 2;
  })).toBe(true);
  await expect(zoom).toHaveValue("53");
  await expect(action).toHaveAttribute("aria-pressed", "true");
  await action.dblclick();
  const sequence = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await expect(sequence).toBeVisible();
  await sequence.getByRole("button", { name: "キャンセル", exact: true }).click();
  await action.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "人 1 の操作", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "シーケンス一括設定", exact: true }).click();
  await sequence.getByLabel("人数（人）", { exact: true }).fill("5");
  await sequence.getByRole("button", { name: "適用", exact: true }).click();
  await expect(sequence).toBeHidden();
  await expect.poll(() => saved().project.maps[0].tracks.find(track => track.id === "hm")?.count).toBe(5);
  await action.click();
  await axis.getByRole("button", { name: "元の表示に戻す", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(expand).toHaveAttribute("aria-pressed", "false");
  await expect(zoom).toHaveValue("53");
  await expect(axis.locator('[data-action-id="h1"][role="button"]')).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 900, height: 900 });
  await expand.click();
  await expect.poll(() => axis.evaluate(node => document.fullscreenElement === node)).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect(expand).toHaveAttribute("aria-pressed", "false");
  await axis.evaluate(node => Object.defineProperty(node, "requestFullscreen", {
    configurable: true, value: () => Promise.reject(new Error("Fullscreen denied")),
  }));
  await expand.click();
  await expect(axis.getByRole("alert")).toContainText("時間軸の全画面表示を切り替えられませんでした: Fullscreen denied");
  await expect(expand).toHaveAttribute("aria-pressed", "false");
});

test("adding a robot opens placement immediately and only marker dragging changes its position", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "ロボット配置", maps: [timelineMap()] });
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  await page.getByRole("region", { name: "行と動作の追加", exact: true })
    .getByRole("button", { name: "＋ ロボット", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "ロボット 2 の初期位置", exact: true });
  await expect(picker).toBeVisible();
  await expect.poll(() => saved().project.maps[0].tracks.length).toBe(5);
  const added = saved().project.maps[0].tracks[4];
  const initial = added.initial!;
  await expect(picker.getByRole("button", { name: "適用", exact: true })).toBeEnabled();
  const blank = await mapPoint(picker, { x: 800, y: 400 });
  await page.mouse.move(blank.x, blank.y);
  await page.mouse.click(blank.x, blank.y);
  await expectMarker(picker, initial);

  const start = await mapPoint(picker, { x: initial.x + 12, y: initial.y + 8 });
  const end = await mapPoint(picker, { x: 462, y: 478 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await expect(picker.getByRole("button", { name: "適用", exact: true })).toBeDisabled();
  expect(saved().project.maps[0].tracks[4].initial).toEqual(initial);
  await page.mouse.up();
  await expectMarker(picker, { x: 450, y: 470 });
  await page.mouse.move(blank.x, blank.y);
  await expectMarker(picker, { x: 450, y: 470 });
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  const sequence = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await expect(sequence).toBeVisible();
  await expect.poll(() => Math.abs(saved().project.maps[0].tracks[4].initial!.x - 450)).toBeLessThan(3);
  expect(saved().project.maps[0].tracks[4].initial!.coordinateMode).toBe("free");
  await sequence.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.getByRole("button", { name: "＋ ロボット", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "ロボット 3 の初期位置", exact: true })).toBeVisible();
});

for (const kind of ["robot", "human"] as const) {
  test(`adding a ${kind} previews and validates other objects at its saved appearance time`, async ({ page }) => {
    const project = validateProject({ schema: "fleet-scene/v1", name: "表示開始確認", maps: [timelineMap()] });
    const future = project.maps[0].tracks.find(track => track.id === "hm")!;
    future.appearAt = 10;
    future.actions[0].position = 12;
    const saved = await mockHistory(page, project);
    await openScenes(page, 1600);
    await waitSaved(page);
    const label = kind === "robot" ? "ロボット" : "人";
    await page.getByRole("button", { name: `＋ ${label}`, exact: true }).click();
    const picker = page.getByRole("dialog", { name: `${label} 2 の初期位置`, exact: true });
    const time = picker.getByRole("spinbutton", { name: "表示開始（秒）", exact: true });
    const apply = picker.getByRole("button", { name: "適用", exact: true });
    await expect(time).toHaveValue("0");
    const otherRobot = picker.locator('[data-actor-id="rb"]');
    await expect(otherRobot).toBeVisible();
    await expect(picker.locator('[data-actor-id="hm"]')).toHaveCount(0);
    expect(await actorPose(otherRobot)).toEqual({ x: 110, y: 110 });
    await time.fill("4");
    await expect.poll(() => actorPose(otherRobot)).toEqual({ x: 260, y: 110 });
    await expect(picker.locator('[data-display-template="label"]')).toContainText("hi");
    await expect.poll(() => saved().project.maps[0].tracks.length).toBe(5);
    const added = saved().project.maps[0].tracks[4];
    await dragMarker(page, picker, added.initial!, { x: 260, y: 110 });
    await expect(apply).toBeDisabled();
    await expect(picker.getByTestId("picker-marker")).toHaveAttribute("data-invalid", "true");
    await time.fill("0");
    await expect(apply).toBeEnabled();
    await time.fill("10");
    await expect(picker.locator('[data-actor-id="hm"]')).toBeVisible();
    for (const invalid of ["", "-1", "86401"]) {
      await time.fill(invalid);
      await expect(apply).toBeDisabled();
      await expect(picker.getByText("指定できません:", { exact: false })).toContainText("表示開始");
    }
    await time.fill("8");
    await expect(apply).toBeEnabled();
    await expect.poll(() => actorPose(otherRobot)).toEqual({ x: 410, y: 110 });
    await apply.click();
    const sequence = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
    await expect(sequence.getByTestId("initial-coords")).toContainText("表示開始 8秒");
    await sequence.getByRole("button", { name: "＋ 移動", exact: true }).click();
    await expect(sequence.getByLabel("開始（秒）", { exact: true })).toHaveValue("8");
    await sequence.getByRole("button", { name: "適用", exact: true }).click();
    await expect(sequence).toBeHidden();
    await waitSaved(page);
    expect(saved().project.maps[0].tracks[4].appearAt).toBe(8);
    expect(saved().project.maps[0].tracks[4].actions[0].position).toBe(8);
    const actor = page.getByRole("region", { name: "マップ", exact: true }).locator(`[data-actor-id="${added.id}"]`);
    await expect(actor).toHaveCount(0);
    await page.getByRole("slider", { name: "再生位置", exact: true }).fill("8");
    await expect(actor).toBeVisible();
    await page.getByRole("slider", { name: "再生位置", exact: true }).fill("7.9");
    await expect(actor).toHaveCount(0);
    await page.reload();
    await waitSaved(page);
    await page.getByRole("slider", { name: "再生位置", exact: true }).fill("8");
    await expect(actor).toBeVisible();
  });
}

test("adding a human places a person before opening its sequence and hides unwanted controls", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "人の追加", maps: [timelineMap()] });
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  const palette = page.getByRole("region", { name: "行と動作の追加", exact: true });
  await expect(palette.getByRole("group", { name: "選択した行・動作", exact: true })).toHaveCount(0);
  await expect(palette.getByRole("button", { name: "＋ 部屋", exact: true })).toHaveCount(0);
  await palette.getByRole("button", { name: "＋ 人", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "人 2 の初期位置", exact: true });
  await expect(picker.getByTestId("picker-marker").locator('[data-part="human-figure"]')).toBeVisible();
  await expect.poll(() => saved().project.maps[0].tracks.length).toBe(5);
  const initial = saved().project.maps[0].tracks[4].initial!;
  const people = picker.getByRole("spinbutton", { name: "人数（人）", exact: true });
  for (const invalid of ["", "0", "1.5", "1001"]) {
    await people.fill(invalid);
    await expect(picker.getByRole("button", { name: "適用", exact: true })).toBeDisabled();
  }
  await people.fill("12");
  await expect(picker.getByTestId("picker-marker").locator('[data-part="human-person"]')).toHaveCount(12);
  expect(saved().project.maps[0].tracks[4].count).toBe(1);
  await dragMarker(page, picker, initial, { x: 470, y: 450 });
  await expectMarker(picker, { x: 470, y: 450 });
  expect(saved().project.maps[0].tracks[4].initial).toEqual(initial);
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  const sequence = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await expect(sequence).toBeVisible();
  await expect(sequence.getByRole("spinbutton", { name: "人数（人）", exact: true })).toHaveValue("12");
  await expect.poll(() => saved().project.maps[0].tracks[4].count).toBe(12);
  await expect(sequence.locator('[data-part="human-figure"]')).toBeVisible();
  await expect(sequence.locator('[data-part="human-person"]')).toHaveCount(12);
  await expect(sequence.getByRole("button", { name: /^＋\s*表示$/ })).toHaveCount(0);
  await expect.poll(() => Math.abs(saved().project.maps[0].tracks[4].initial!.x - 470)).toBeLessThan(3);
  await sequence.getByRole("button", { name: "キャンセル", exact: true }).click();
  const added = saved().project.maps[0].tracks[4];
  const actor = page.getByRole("region", { name: "マップ", exact: true }).locator(`[data-actor-id="${added.id}"]`);
  await expect(actor.locator('[data-part="human-figure"]')).toBeVisible();
  expect(Math.abs((await actorPose(actor)).y - 450)).toBeLessThan(3);
  await expect(page.getByRole("complementary", { name: "設定", exact: true })).toHaveCount(0);
  await expect(actor.locator('[data-part="human-person"]')).toHaveCount(12);
  await page.getByRole("group", { name: `${added.name} の動作`, exact: true }).dblclick({ position: { x: 600, y: 10 } });
  await expect(sequence.locator("[data-sequence-action]")).toHaveCount(0);
  await sequence.getByRole("spinbutton", { name: "人数（人）", exact: true }).fill("1.5");
  await sequence.getByLabel("名称（120文字まで）").fill(added.name);
  await expect(sequence.getByRole("button", { name: "適用", exact: true })).toBeDisabled();
  await sequence.getByRole("spinbutton", { name: "人数（人）", exact: true }).fill("1000");
  await expect(sequence.locator('[data-part="human-person"]')).toHaveCount(1000);
  await expect(sequence.getByRole("button", { name: "適用", exact: true })).toBeEnabled();
  await sequence.getByRole("button", { name: "キャンセル", exact: true }).click();
  await sequence.getByRole("button", { name: "破棄して閉じる", exact: true }).click();
  expect(saved().project.maps[0].tracks[4].count).toBe(12);
  const library = page.getByRole("complementary", { name: "ライブラリ", exact: true });
  await library.getByRole("button", { name: new RegExp(`${added.name} 12人`) }).dblclick();
  await sequence.getByRole("spinbutton", { name: "人数（人）", exact: true }).fill("2");
  await sequence.getByRole("button", { name: "適用", exact: true }).click();
  await expect.poll(() => saved().project.maps[0].tracks[4].count).toBe(2);
  await expect(actor.locator('[data-part="human-person"]')).toHaveCount(2);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect.poll(() => saved().project.maps[0].tracks[4].count).toBe(12);
  await expect(actor.locator('[data-part="human-person"]')).toHaveCount(12);
});

test("side panels share stage glass and library items reopen editors at desktop and drawer widths", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "左右パネル", maps: [timelineMap({ locked: false })] });
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  const stage = page.getByRole("region", { name: "マップ", exact: true });
  const library = page.getByRole("complementary", { name: "ライブラリ", exact: true });
  const controls = page.getByRole("region", { name: "行と動作の追加", exact: true });
  const appearance = (panel: Locator) => panel.evaluate((element) => {
    const style = getComputedStyle(element);
    return { image: style.backgroundImage, color: style.backgroundColor, blur: style.backdropFilter };
  });
  for (const theme of ["light", "dark"]) {
    await page.locator("[data-theme]").first().evaluate((element, value) => element.setAttribute("data-theme", value), theme);
    const glass = await appearance(stage);
    expect(glass.image).toContain("linear-gradient");
    expect(glass.blur).toContain("blur(6px)");
    expect(glass.color).toBe("rgba(0, 0, 0, 0)");
    expect(await appearance(library)).toEqual(glass);
    expect(await appearance(controls)).toEqual(glass);
  }
  await expect(page.getByRole("complementary", { name: "設定", exact: true })).toHaveCount(0);
  const editor = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await library.getByRole("button", { name: "表示 画面表示 · 動作 1件", exact: true }).dblclick();
  await expect(editor.getByRole("textbox", { name: "表示する言葉", exact: true })).toHaveValue("hi");
  await editor.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.getByRole("button", { name: "ライブラリ", exact: true }).click();
  await library.getByRole("button", { name: "人 1 3人 · 動作 1件", exact: true }).dblclick();
  await expect(editor.getByRole("spinbutton", { name: "人数（人）", exact: true })).toHaveValue("3");
  await editor.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(library).toBeHidden();
  expect(saved().project).toEqual(project);
  await page.getByRole("button", { name: "マップを編集", exact: true }).click();
  const mapEditor = page.getByRole("dialog", { name: "マップを編集", exact: true });
  await mapEditor.getByRole("combobox", { name: "扉の確認モード", exact: true }).selectOption("strict");
  await mapEditor.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(mapEditor.getByRole("combobox", { name: "扉の確認モード", exact: true })).toHaveValue("story");
  await mapEditor.getByRole("combobox", { name: "扉の確認モード", exact: true }).selectOption("strict");
  await mapEditor.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect.poll(() => saved().project.maps[0].doorMode).toBe("strict");
});

test("adding a display previews its content and template on the map before saving its dragged position", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "画面表示の追加", maps: [timelineMap()] });
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  await page.getByRole("button", { name: "＋ 画面表示", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "画面表示 1 の表示位置と内容", exact: true });
  await expect(picker).toBeVisible();
  await expect.poll(() => saved().project.maps[0].tracks.length).toBe(5);
  const original = structuredClone(saved().project.maps[0].tracks[4]);
  const marker = picker.getByTestId("picker-marker");
  await expect(marker.locator('[data-display-template="label"]')).toContainText("表示テキスト");
  const text = "受付はこちら\n見学のご案内";
  await picker.getByRole("textbox", { name: "表示する言葉", exact: true }).fill(text);
  await picker.getByRole("combobox", { name: "表示項目", exact: true }).selectOption("sign");
  await expect(marker.locator('[data-display-template="sign"] rect')).toHaveAttribute("fill", "#1d4ed8");
  await expect(marker).toContainText("受付はこちら");
  await picker.getByRole("combobox", { name: "表示項目", exact: true }).selectOption("card");
  await expect(marker.locator('[data-display-template="card"] rect')).toHaveAttribute("fill", "#f8fafc");
  const start = await actorPose(marker);
  await dragMarker(page, picker, start, { x: 650, y: 400 });
  await expectMarker(picker, { x: 650, y: 400 });
  expect(saved().project.maps[0].tracks[4]).toEqual(original);
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  const sequence = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await expect(sequence).toBeVisible();
  await expect(sequence.locator('[data-display-template="card"]')).toContainText("見学のご案内");
  await expect(sequence.getByRole("textbox", { name: "表示する言葉", exact: true })).toHaveValue(text);
  await expect.poll(() => saved().project.maps[0].tracks[4].actions.length).toBe(1);
  const display = saved().project.maps[0].tracks[4].actions[0];
  expect(display.text).toBe(text);
  expect(display.displayTemplate).toBe("card");
  expect(Math.abs(display.x - 650)).toBeLessThan(3);
  expect(Math.abs(display.y - 400)).toBeLessThan(3);
  await sequence.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByRole("region", { name: "マップ", exact: true })
    .locator('[data-display-template="card"]')).toContainText("見学のご案内");
  await page.getByRole("button", { name: "＋ 画面表示", exact: true }).click();
  const cancelled = page.getByRole("dialog", { name: "画面表示 2 の表示位置と内容", exact: true });
  await cancelled.getByRole("textbox", { name: "表示する言葉", exact: true }).fill("キャンセルする表示");
  await cancelled.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect.poll(() => saved().project.maps[0].tracks.length).toBe(6);
  expect(saved().project.maps[0].tracks[5].actions).toHaveLength(0);
  expect(saved().project.maps[0].tracks[4].actions[0]).toEqual(display);
});

test("initial placement supports touch drag, rejects invalid spots and discards cancelled changes", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "再配置", maps: [timelineMap()] });
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  await page.getByRole("region", { name: "マップ", exact: true }).locator('[data-actor-id="rb"]').dblclick();
  const sequence = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await sequence.getByRole("button", { name: "初期位置をマップで配置", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "初期位置を配置", exact: true });
  const apply = picker.getByRole("button", { name: "適用", exact: true });
  await expect(apply).toBeEnabled();
  const initial = saved().project.maps[0].tracks[0].initial!;
  const client = await page.context().newCDPSession(page);
  const start = await mapPoint(picker, initial);
  const end = await mapPoint(picker, { x: 125, y: 125 });
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] });
  await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...end, id: 1 }] });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expectMarker(picker, { x: 125, y: 125 });
  await expect(apply).toBeEnabled();
  await dragMarker(page, picker, { x: 125, y: 125 }, { x: 5, y: 5 });
  await expect(apply).toBeDisabled();
  await picker.getByRole("button", { name: "キャンセル", exact: true }).click();
  expect(saved().project.maps[0].tracks[0].initial).toEqual(initial);
  await sequence.getByRole("button", { name: "初期位置をマップで配置", exact: true }).click();
  await expectMarker(picker, initial);
  const from = await mapPoint(picker, initial);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(picker).toBeVisible();
  await expectMarker(picker, initial);
  await dragMarker(page, picker, initial, { x: 125, y: 125 });
  await apply.click();
  await sequence.getByRole("button", { name: "適用", exact: true }).click();
  await expect.poll(() => Math.abs(saved().project.maps[0].tracks[0].initial!.x - 125)).toBeLessThan(3);
  await client.detach();
});

test("robot, human and display destinations are dragged directly in their editor and saved only on apply", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "移動先", maps: [timelineMap({ locked: false })] });
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  for (const [id, destination] of [
    ["m1", { x: 445, y: 110 }], ["h1", { x: 210, y: 330 }], ["s1", { x: 740, y: 440 }],
  ] as const) {
    const action = () => saved().project.maps[0].tracks.flatMap((track) => track.actions).find((item) => item.id === id)!;
    const original = structuredClone(action());
    await page.locator(`[role="button"][data-action-id="${id}"]`).dblclick();
    const editor = page.getByRole("dialog", { name: id !== "s1" ? "シーケンスを一括設定" : "動作を編集", exact: true });
    if (id === "h1") {
      await expect(editor.getByRole("spinbutton", { name: "人数（人）", exact: true })).toHaveValue("3");
      await editor.getByRole("spinbutton", { name: "人数（人）", exact: true }).fill("5");
      await expect(editor.getByTestId("action-position-handle").locator('[data-part="human-person"]')).toHaveCount(5);
      await expect(editor.locator('[data-part="human-person"]')).toHaveCount(10);
    }
    await expect(editor.getByRole("button", { name: "マップで指定", exact: true })).toHaveCount(0);
    await expect(editor.getByTestId("action-position-handle")).toBeVisible();
    await dragMarker(page, editor, original, destination);
    await expect(editor.getByTestId("target-coords")).toContainText(`X ${destination.x}`);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    expect(action()).toEqual(original);
    await editor.getByRole("button", { name: "適用", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect.poll(() => Math.abs(action().x - destination.x)).toBeLessThan(3);
    expect(Math.abs(action().y - destination.y)).toBeLessThan(3);
    expect(action().coordinateMode).toBe("free");
    if (id === "h1") {
      await expect.poll(() => saved().project.maps[0].tracks.find((track) => track.id === "hm")?.count).toBe(5);
      await expect(page.getByRole("region", { name: "マップ", exact: true })
        .locator('[data-actor-id="hm"] [data-part="human-person"]')).toHaveCount(5);
    }
    if (id === "m1") {
      await page.locator('[data-part="ruler"]').click({ position: { x: 16 + 7 * 26, y: 10 } });
      const robot = page.getByRole("region", { name: "マップ", exact: true }).locator('[data-actor-id="rb"]');
      await expect.poll(async () => Math.abs((await actorPose(robot)).x - destination.x)).toBeLessThan(3);
    }
  }
});

test("every person in an edge-positioned group is visible and right-clicking its far member targets the group", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "人物グループ", maps: [timelineMap()] });
  project.maps[0].tracks[1].initial = { x: 60, y: 60, yaw: 0, roomId: "r1" };
  project.maps[0].tracks[1].count = 12;
  project.maps[0].tracks[1].actions = [];
  await mockHistory(page, project);
  await openScenes(page, 1600);
  const stage = page.getByRole("region", { name: "マップ", exact: true });
  const people = stage.locator('[data-actor-id="hm"] [data-part="human-person"]');
  await expect(people).toHaveCount(12);
  await people.last().click({ button: "right" });
  await expect(page.getByRole("menu")).toContainText("人 1");
  await page.getByRole("menuitem", { name: "シーケンス一括設定", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await expect(editor.getByRole("spinbutton", { name: "人数（人）", exact: true })).toHaveValue("12");
  await expect(editor.locator('[data-part="human-person"]')).toHaveCount(12);
});

test("sequence rotation is dragged around its actual start pose, normalizes angles and supports discard", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "回転編集", maps: [timelineMap()] });
  const saved = await mockHistory(page, project);
  const action = () => saved().project.maps[0].tracks[0].actions.find((item) => item.id === "m2")!;
  const original = structuredClone(action());
  await openScenes(page, 1600);
  await page.locator('[role="button"][data-action-id="m2"]').dblclick();
  const editor = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await editor.getByRole("button", { name: "↻ 回転", exact: true }).click();
  await expect(editor.getByTestId("action-rotation-handle")).toBeVisible();
  const angle = editor.getByLabel("回転後の角度（°）", { exact: true });
  // The preceding move ends at (410, 110), not the robot's initial pose or this action's old endpoint.
  await dragMarker(page, editor, { x: 510, y: 110 }, { x: 410, y: 210 });
  await expect.poll(async () => Math.abs(Number(await angle.inputValue()) - 90)).toBeLessThan(2);
  expect(action()).toEqual(original);
  const start = await mapPoint(editor, { x: 410, y: 210 });
  const left = await mapPoint(editor, { x: 310, y: 110 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(left.x, left.y, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(editor).toBeVisible();
  await expect.poll(async () => Math.abs(Number(await angle.inputValue()) - 90)).toBeLessThan(2);
  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] });
  await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...left, id: 1 }] });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => Math.abs(Math.abs(Number(await angle.inputValue())) - 180)).toBeLessThan(2);
  const finalAngle = Number(await angle.inputValue());
  expect(finalAngle).toBeGreaterThan(-180);
  expect(finalAngle).toBeLessThanOrEqual(180);
  await editor.getByRole("button", { name: "キャンセル", exact: true }).click();
  await editor.getByRole("button", { name: "破棄して閉じる", exact: true }).click();
  expect(action()).toEqual(original);

  await page.locator('[role="button"][data-action-id="m2"]').dblclick();
  await editor.getByRole("button", { name: "↻ 回転", exact: true }).click();
  await dragMarker(page, editor, { x: 510, y: 110 }, { x: 410, y: 10 });
  await expect.poll(async () => Math.abs(Number(await angle.inputValue()) + 90)).toBeLessThan(2);
  await editor.getByRole("button", { name: "適用", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect.poll(() => action().motion).toBe("rotate");
  expect(Math.abs(action().yaw + 90)).toBeLessThan(2);
  expect(action().rotationSeconds).toBe(action().runSeconds);
  expect([action().x, action().y]).toEqual([original.x, original.y]);
  await page.getByRole("slider", { name: "再生ヘッド", exact: true }).press("End");
  const body = page.getByRole("region", { name: "マップ", exact: true }).locator('[data-actor-id="rb"] rect');
  await expect.poll(async () => {
    const angle = await body.evaluate((node) => {
      if (!(node instanceof SVGGraphicsElement)) throw new Error("Missing robot body");
      const matrix = node.transform.baseVal.consolidate()?.matrix;
      if (!matrix) throw new Error("Missing robot rotation");
      return Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
    });
    return Math.abs(angle + action().yaw);
  }).toBeLessThan(2);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect.poll(() => action()).toEqual(original);
  await client.detach();
});

test("the sequence rotation handle stays reachable near the map edge", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "端での回転", maps: [timelineMap()] });
  project.maps[0].tracks[0].actions[0].x = 1010;
  await mockHistory(page, project);
  await openScenes(page, 1600);
  await page.locator('[role="button"][data-action-id="m2"]').dblclick();
  const editor = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await editor.getByRole("button", { name: "↻ 回転", exact: true }).click();
  await expect(editor.getByTestId("action-rotation-handle")).toBeVisible();
  await dragMarker(page, editor, { x: 1076, y: 110 }, { x: 1010, y: 210 });
  await expect.poll(async () => Math.abs(Number(await editor.getByLabel("回転後の角度（°）", { exact: true }).inputValue()) - 90)).toBeLessThan(2);
});

test("double-clicking robot row labels and empty lanes opens the existing sequence without adding actions", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "行操作", maps: [timelineMap()] });
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  const original = structuredClone(project);
  const editor = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await page.locator('[data-track-id="rb"]').getByRole("button", { name: /ロボット 1.*ロボット/ }).dblclick();
  await expect(editor).toBeVisible();
  await expect(editor.locator("[data-sequence-action]")).toHaveCount(3);
  await editor.getByRole("button", { name: "キャンセル", exact: true }).click();
  const lane = page.getByRole("group", { name: "ロボット 1 の動作", exact: true });
  await lane.dblclick({ position: { x: 600, y: 10 } });
  await expect(editor).toBeVisible();
  await expect(editor.locator("[data-sequence-action]")).toHaveCount(3);
  await editor.getByRole("button", { name: "キャンセル", exact: true }).click();
  expect(saved().project).toEqual(original);
});

test("object context menus open bulk editors, delete the clicked row with confirmation and honor locks", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "右クリック", maps: [timelineMap()] });
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  const stage = page.getByRole("region", { name: "マップ", exact: true });
  const editor = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  for (const id of ["rb", "hm"]) {
    const actor = stage.locator(`[data-actor-id="${id}"]`);
    await (id === "hm" ? actor.locator('[data-part="human-person"]').first() : actor).click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "削除", exact: true })).toBeVisible();
    await menu.getByRole("menuitem", { name: "シーケンス一括設定", exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(editor.getByRole("region", { name: "行の設定" })).toContainText(id === "rb" ? "ロボット種別" : "名称");
    await editor.getByRole("button", { name: "キャンセル", exact: true }).click();
  }
  await stage.locator('[data-part="waypoint-marker"][data-action-id="m1"]').click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(editor).toHaveCount(0);
  await page.getByRole("menuitem", { name: "シーケンス一括設定", exact: true }).click();
  await expect(editor.locator("[data-sequence-action]")).toHaveCount(3);
  await editor.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.getByRole("group", { name: "会議室 の動作", exact: true }).click({ button: "right", position: { x: 10, y: 10 } });
  await page.getByRole("menuitem", { name: "シーケンス一括設定", exact: true }).click();
  await expect(editor.locator("[data-sequence-action]")).toHaveCount(1);
  await editor.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.getByRole("region", { name: "部屋と領域", exact: true }).getByRole("button").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "シーケンス一括設定", exact: true }).click();
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.getByRole("group", { name: "表示 の動作", exact: true }).click({ button: "right", position: { x: 10, y: 10 } });
  await expect(page.getByRole("menuitem", { name: "削除", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "シーケンス一括設定", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  await stage.locator('[data-actor-id="hm"] [data-part="human-person"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "削除", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "行の削除", exact: true });
  await confirm.getByRole("button", { name: "キャンセル", exact: true }).click();
  expect(saved().project.maps[0].tracks).toHaveLength(4);
  await stage.locator('[data-actor-id="hm"] [data-part="human-person"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "削除", exact: true }).click();
  await confirm.getByRole("button", { name: "削除", exact: true }).click();
  await expect.poll(() => saved().project.maps[0].tracks.some((track) => track.id === "hm")).toBe(false);
  expect(saved().project.maps[0].tracks.some((track) => track.id === "rb")).toBe(true);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect.poll(() => saved().project.maps[0].tracks).toEqual(project.maps[0].tracks);
});

test("traffic blocks are explained before applying and playback resumes along the saved sequence after clearing the blocker", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "通路の停止原因", maps: [timelineMap()] });
  const map = project.maps[0];
  map.rooms = [{ id: "hall", name: "狭い廊下", kind: "corridor", material: "concrete", color: "#739a81", cells: cellsOf(0, 9, 54, 19) }];
  const robot = map.tracks[0];
  robot.initial = { x: 160, y: 290, yaw: 0, roomId: "hall", coordinateMode: "free" };
  robot.actions = [{ ...robot.actions[0], position: 0, runSeconds: 4, x: 940, y: 290, roomId: "hall", coordinateMode: "free" }];
  const parked = { ...structuredClone(robot), id: "parked", robotId: "parked-device", name: "待機ロボット", actions: [],
    initial: { x: 600, y: 290, yaw: 0, roomId: "hall" } };
  map.tracks = [robot, parked];
  const saved = await mockHistory(page, validateProject(project));
  await openScenes(page, 1600);
  const alert = page.getByRole("alert", { name: "シーンの再生エラー", exact: true });
  await expect(alert).toContainText("待機ロボット");
  await expect(alert).toContainText("狭い廊下");
  await page.locator('[data-track-id="rb"]').getByRole("button", { name: /ロボット 1.*ロボット/ }).dblclick();
  const editor = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await expect(editor.getByRole("alert")).toContainText("待機ロボット");
  await expect(editor.getByRole("button", { name: "適用", exact: true })).toBeDisabled();
  await editor.getByRole("button", { name: "キャンセル", exact: true }).click();
  const stage = page.getByRole("region", { name: "マップ", exact: true });
  await stage.locator('[data-actor-id="parked"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "削除", exact: true }).click();
  await page.getByRole("dialog", { name: "行の削除", exact: true }).getByRole("button", { name: "削除", exact: true }).click();
  await expect.poll(() => saved().project.maps[0].tracks.length).toBe(1);
  await expect(alert).toHaveCount(0);
  await page.getByRole("button", { name: "再生", exact: true }).click();
  const actor = stage.locator('[data-actor-id="rb"]');
  await expect.poll(async () => (await actorPose(actor)).x).toBeGreaterThan(180);
  await page.getByRole("button", { name: "一時停止", exact: true }).click();
  // The range property rounds to its 0.1s step; the attribute retains the rendered playback time.
  const time = Number(await page.getByRole("slider", { name: "再生位置", exact: true }).getAttribute("value"));
  expect(Math.abs((await actorPose(actor)).x - (160 + (940 - 160) * time / 4))).toBeLessThan(3);
  await page.getByRole("slider", { name: "再生ヘッド", exact: true }).press("End");
  await expect.poll(async () => (await actorPose(actor)).x).toBeCloseTo(940, 1);
});

test("room context actions preserve references and create a room sequence only when applied", async ({ page }) => {
  const project = validateProject({ schema: "fleet-scene/v1", name: "領域の操作", maps: [timelineMap()] });
  project.maps[0].tracks = project.maps[0].tracks.filter((track) => track.kind !== "room");
  project.maps[0].rooms.push({ ...structuredClone(project.maps[0].rooms[0]), id: "spare", name: "空き部屋", cells: [0] });
  const saved = await mockHistory(page, project);
  await openScenes(page, 1600);
  const rooms = page.getByRole("region", { name: "部屋と領域", exact: true });
  const roomButton = rooms.getByRole("button").filter({ hasText: "会議室" });
  const editor = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "シーケンス一括設定", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor.locator("[data-sequence-action]")).toHaveCount(0);
  await editor.getByRole("button", { name: "キャンセル", exact: true }).click();
  expect(saved().project.maps[0].tracks).toHaveLength(3);
  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "シーケンス一括設定", exact: true }).click();
  await editor.getByRole("button", { name: "適用", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect.poll(() => saved().project.maps[0].tracks.length).toBe(4);
  expect(saved().project.maps[0].tracks[3]).toMatchObject({ kind: "room", roomId: "r1" });
  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "削除", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "領域の削除", exact: true });
  await confirm.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.locator('footer[aria-label="ステータス"]')).toContainText("参照されているため削除できません");
  expect(saved().project.maps[0].rooms).toHaveLength(2);
  await rooms.getByRole("button").filter({ hasText: "空き部屋" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "削除", exact: true }).click();
  await confirm.getByRole("button", { name: "削除", exact: true }).click();
  await expect.poll(() => saved().project.maps[0].rooms.length).toBe(1);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect.poll(() => saved().project.maps[0].rooms.length).toBe(2);
});
