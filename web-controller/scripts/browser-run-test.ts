import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

async function runTest() {
  console.log("=== Playwright 実機統合テスト開始 ===");
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const screenshotDir = path.join(process.cwd(), "public", "test-results");
  fs.mkdirSync(screenshotDir, { recursive: true });

  console.log("1. シーン実行画面 (http://localhost:3000/run) を開きます...");
  await page.goto("http://localhost:3000/run", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  console.log("2. シーンを選択します...");
  const abortBtn = page.locator("button:has-text('中止')");
  if (await abortBtn.isVisible({ timeout: 1000 }).catch(() => false) && await abortBtn.isEnabled().catch(() => false)) {
    console.log("前の実行が残っているため中止します...");
    await abortBtn.click();
    await page.waitForTimeout(1000);
  }
  const resetBtn = page.locator("button:has-text('もう一度')");
  if (await resetBtn.isVisible({ timeout: 1000 }).catch(() => false) && await resetBtn.isEnabled().catch(() => false)) {
    console.log("「もう一度」をクリックして準備画面に戻します...");
    await resetBtn.click();
    await page.waitForTimeout(1000);
  }

  const select = page.locator("label:has-text('実行するシーン') select");
  await select.waitFor({ state: "visible", timeout: 8000 });
  if (await select.isEnabled()) {
    const options = await select.locator("option").allInnerTexts();
    console.log("利用可能なシーン一覧:", options);

    const testOption = options.find((opt) => opt.includes("実機テスト") || opt.includes("四隅"));
    if (testOption) {
      console.log(`「${testOption}」を選択します...`);
      await select.selectOption({ label: testOption });
    } else {
      await select.selectOption({ index: 1 });
    }
  } else {
    console.log("シーンは既に選択・準備されています");
  }

  await page.waitForTimeout(2000);

  console.log("\n3. 実行前の確認状態をチェックします...");
  const checkItems = await page.locator("section[aria-label='実行前の確認'] li").allInnerTexts().catch(() => []);
  console.log("【実行前の確認チェックリスト】");
  checkItems.forEach((item) => console.log(`  - ${item}`));

  const initialMismatches = await page.locator("section[aria-label='初期位置とのずれ'] table tbody tr").allInnerTexts().catch(() => []);
  if (initialMismatches.length > 0) {
    console.log("【初期位置とのずれ】");
    initialMismatches.forEach((item) => console.log(`  - ${item.replace(/\t/g, " | ")}`));
  } else {
    const okText = await page.locator("section[aria-label='初期位置とのずれ'] p").innerText().catch(() => "");
    console.log(`初期位置状態: ${okText}`);
  }

  const startBtn = page.locator("button:has-text('開始')");
  let canStart = await startBtn.isVisible() && await startBtn.isEnabled();
  console.log(`開始ボタンの状態: ${canStart ? "有効 (開始可能)" : "無効"}`);

  const posBtn = page.locator("button:has-text('初期位置へ移動')");
  const canPos = await posBtn.isVisible() && await posBtn.isEnabled();

  if (!canStart && canPos) {
    console.log("\n4. 「初期位置へ移動」ボタンをクリックして自動配置を開始します...");
    await posBtn.click();
    await page.waitForTimeout(1000);

    for (let i = 0; i < 80; i++) {
      const posStatus = await page.locator("section[aria-label='初期位置への移動'] span[data-phase='waiting']").innerText({ timeout: 500 }).catch(() => "");
      const items = await page.locator("section[aria-label='初期位置への移動'] table tbody tr").allInnerTexts().catch(() => []);
      console.log(`  [初期位置移動中 ${i + 1}s] ${posStatus} | ${items.join(" / ").replace(/\n/g, " ")}`);

      const startNow = await startBtn.isVisible() && await startBtn.isEnabled();
      if (startNow) {
        console.log("=> 全機体が初期位置に到達し、開始ボタンが有効になりました！");
        canStart = true;
        break;
      }
      await page.waitForTimeout(1000);
    }
  }

  await page.screenshot({ path: path.join(screenshotDir, "step2_ready.png") });

  if (canStart) {
    console.log("\n5. 「開始」ボタンをクリックして走行を開始します！");
    await startBtn.click();
    await page.waitForTimeout(1500);

    console.log("6. 走行テストを監視します (最大80秒)...");
    for (let t = 0; t < 80; t++) {
      const clockText = await page.locator("span[aria-label='進行時計']").innerText({ timeout: 500 }).catch(() => "");
      const statusText = await page.locator("strong[role='status']").first().innerText({ timeout: 500 }).catch(() => "");
      const reasonText = await page.locator("p[role='status']").first().innerText({ timeout: 500 }).catch(() => "");
      const alerts = await page.locator("p[class*='alertBanner']").allInnerTexts().catch(() => []);

      const robotCards = await page.locator("article[class*='card']").allInnerTexts().catch(() => []);
      const robotSummaries = robotCards.map((c) => c.split("\n").slice(0, 2).join(": ")).join(" | ");

      console.log(`[T+${t}s] フェーズ: ${statusText} | 時計: ${clockText} | 状態: ${reasonText} | ロボット: ${robotSummaries}`);
      if (alerts.length > 0) {
        console.log(`   [アラート]: ${alerts.join(", ")}`);
      }

      if (statusText.includes("完了") || statusText.includes("finished")) {
        console.log("🎉 シーン走行が正常に完了しました！");
        break;
      }
      if (statusText.includes("中止") || statusText.includes("aborted")) {
        console.log("⚠️ シーン走行が中止されました。");
        break;
      }
      if (statusText.includes("停止中") || statusText.includes("halted")) {
        console.log(`⚠️ シーンが一時停止またはhaltしました: ${reasonText}`);
        const resumeItems = await page.locator("section[aria-label='再開の条件'] li").allInnerTexts().catch(() => []);
        if (resumeItems.length > 0) {
          console.log("  再開の条件:", resumeItems);
        }
      }

      await page.waitForTimeout(1000);
    }

    await page.screenshot({ path: path.join(screenshotDir, "step3_result.png") });
    console.log(`結果スクリーンショットを保存しました: ${path.join(screenshotDir, "step3_result.png")}`);
  } else {
    console.log("\n⚠️ 開始ボタンが有効にならなかったため、走行を開始できませんでした。");
    console.log("チェックリストの ✗ を確認してください。");
  }

  console.log("\n=== テスト完了 ===");
  await page.waitForTimeout(5000);
  await browser.close();
}

runTest().catch((err) => {
  console.error("テスト実行エラー:", err);
  process.exit(1);
});
