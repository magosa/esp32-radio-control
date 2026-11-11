import { expect, test, type Page } from "@playwright/test";
import { openScenes, ratio, textAndBackground } from "./helpers";

test.describe.configure({ mode: "serial" });

test("width 767 shows only the guidance; 768 shows the editor", async ({ page }) => {
  await page.setViewportSize({ width: 767, height: 900 });
  await page.goto("/scenes");
  await expect(page.getByRole("heading", { name: /768px以上/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("img", { name: /マップ/ })).toHaveCount(0);

  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page.getByRole("tab").first()).toBeVisible();
  await expect(page.getByRole("img").first()).toBeVisible();
  await page.setViewportSize({ width: 767, height: 900 });
  await expect(page.getByRole("heading", { name: /768px以上/ })).toBeVisible();
});

test("the header title never collapses between 701 and 1280px (title stays on one line)", async ({ page }) => {
  for (const width of [768, 900, 1100, 1180, 1181, 1280]) {
    await openScenes(page, width);
    const box = await page.locator("h1").boundingBox();
    expect(box, `h1 at ${width}`).not.toBeNull();
    expect(box!.height, `h1 height at ${width}`).toBeLessThan(50);
    expect(box!.width, `h1 width at ${width}`).toBeGreaterThan(100);
  }
});

test("the map svg is not clamped to the 18px icon size and fits the page without horizontal overflow", async ({ page }) => {
  for (const width of [768, 1024, 1280]) {
    await openScenes(page, width);
    const svg = await page.getByRole("img").first().boundingBox();
    expect(svg!.width, `svg at ${width}`).toBeGreaterThan(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow at ${width}`).toBeLessThanOrEqual(0);
  }
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} theme: key texts keep at least 4.5:1 contrast`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("fleet-appearance", JSON.stringify({ theme: t, palette: "ocean", motion: false })), theme);
    await openScenes(page);
    await expect(page.locator(`main[data-theme="${theme}"]`)).toBeVisible();
    // 色の遷移(.3s)が終わってから測る。
    await page.waitForTimeout(800);
    for (const selector of ["h1", '[role="tab"][aria-selected="true"]', 'label span']) {
      const { fg, bg } = await textAndBackground(page, selector);
      expect(ratio(fg, bg), `${selector} (${theme}) fg=${fg} bg=${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test("touch: zooming to 200% lets a one-finger drag scroll the map", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1024, height: 800 } });
  const page = await context.newPage();
  await page.goto("/scenes");
  await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "200%" }).tap();
  const scroller = page.locator("svg[role=img]").locator("xpath=ancestor::div[contains(@class,'scroll')][1]");
  await expect(scroller).toBeVisible();
  const style = await scroller.evaluate((el) => ({ touch: getComputedStyle(el).touchAction, overflow: getComputedStyle(el).overflowX,
    scrollable: el.scrollWidth > el.clientWidth }));
  expect(style.scrollable).toBe(true);
  expect(style.overflow).toBe("auto");
  expect(style.touch).toContain("pan-x");
  await scroller.evaluate((el) => { el.scrollLeft = 120; });
  expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await context.close();
});

test("zoom buttons expose pressed state and are at least 44px tall", async ({ page }) => {
  await openScenes(page);
  for (const label of ["全体", "150%", "200%", "400%"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});
