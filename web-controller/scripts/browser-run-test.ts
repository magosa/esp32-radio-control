import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

async function runTest() {
  console.log("=== Playwright 実機統合テスト開始 ===");
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    permissions: ["camera"],
  });
  const page = await context.newPage();

  const screenshotDir = path.join(process.cwd(), "public", "test-results");
  fs.mkdirSync(screenshotDir, { recursive: true });

  console.log("1. 測位画面 (http://localhost:3000/localizer) を確認します...");
  await page.goto("http://localhost:3000/localizer", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const refreshCamBtn = page.locator("section[aria-label='測位の操作'] button:has-text('一覧更新')");
  if (await refreshCamBtn.isVisible().catch(() => false) && await refreshCamBtn.isEnabled().catch(() => false)) {
    await refreshCamBtn.click();
    await page.waitForTimeout(800);
  }
  const camSelect = page.locator("select[aria-label='カメラ']");
  if (await camSelect.isVisible().catch(() => false) && await camSelect.isEnabled().catch(() => false)) {
    const camOptions = await camSelect.locator("option").allInnerTexts();
    console.log("検出カメラ一覧:", camOptions);
    const usbCam = camOptions.find((c) => c.includes("1080P") || c.includes("Web Camera") || c.includes("USB"));
    if (usbCam) {
      console.log(`カメラ「${usbCam}」を選択します...`);
      await camSelect.selectOption({ label: usbCam });
    }
  }
  const startLocBtn = page.getByRole("button", { name: "開始", exact: true });
  if (await startLocBtn.isVisible().catch(() => false) && await startLocBtn.isEnabled().catch(() => false)) {
    console.log("測位カメラを開始します...");
    await startLocBtn.click();
    for (let w = 0; w < 10; w++) {
      await page.waitForTimeout(1000);
      const locState = await page.locator("p[data-state]").innerText().catch(() => "");
      console.log(`  [測位起動待ち ${w + 1}s] ${locState}`);
      if (locState.includes("測位中") || locState.includes("別の測位") || locState.includes("Device in use") || locState.includes("開始失敗")) break;
    }
  }

  console.log("1b. ナビゲーションからシーン実行画面 (/run) へ遷移します...");
  const runNavLink = page.locator("nav[aria-label='フリートナビゲーション'] a[aria-label='実行']");
  if (await runNavLink.isVisible().catch(() => false)) {
    await runNavLink.click();
  } else {
    await page.goto("http://localhost:3000/run", { waitUntil: "networkidle" });
  }
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
  for (let waitReady = 0; waitReady < 15; waitReady++) {
    const items = await page.locator("section[aria-label='実行前の確認'] li").allInnerTexts().catch(() => []);
    const allTracked = items.some((t) => t.includes("全ロボットが追跡中（2/2）"));
    const allOnline = items.some((t) => t.includes("駆動デバイスが接続中（2/2）"));
    const camOk = items.some((t) => t.includes("測位カメラが動作中") && !t.includes("接続されていません"));
    if (allTracked && allOnline && camOk) break;
    console.log(`  [接続・追跡待機中 ${waitReady + 1}s] カメラ:${camOk ? "OK" : "NG"} 追跡2/2:${allTracked ? "OK" : "NG"} 駆動2/2:${allOnline ? "OK" : "NG"}`);
    await page.waitForTimeout(1000);
  }
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

  const startBtn = page.getByRole("button", { name: "開始", exact: true });
  let canStart = await startBtn.isVisible() && await startBtn.isEnabled();
  console.log(`開始ボタンの状態: ${canStart ? "有効 (開始可能)" : "無効"}`);

  const posBtn = page.locator("button:has-text('初期位置へ移動')");
  const canPos = await posBtn.isVisible() && await posBtn.isEnabled();

  if (!canStart && canPos) {
    console.log("\n4. 「初期位置へ移動」ボタンをクリックして自動配置を開始します...");
    await posBtn.click();
    await page.waitForTimeout(1000);
    let retryCount = 0;

    for (let i = 0; i < 90; i++) {
      const posStatus = await page.locator("section[aria-label='初期位置への移動'] span[data-phase='waiting']").innerText({ timeout: 500 }).catch(() => "");
      const items = await page.locator("section[aria-label='初期位置への移動'] table tbody tr").allInnerTexts().catch(() => []);
      const rowText = items.join(" / ").replace(/\n/g, " ");
      console.log(`  [初期位置移動中 ${i + 1}s] ${posStatus} | ${rowText}`);

      const startNow = await startBtn.isVisible() && await startBtn.isEnabled();
      if (startNow) {
        console.log("=> 全機体が初期位置に到達し、開始ボタンが有効になりました！");
        canStart = true;
        break;
      }
      if (!rowText && i > 2) {
        console.log("=> サーバー再起動等でシーン選択がリセットされたため、シーンを再選択して移動を再開します...");
        if (await select.isEnabled().catch(() => false)) {
          const opts = await select.locator("option").allInnerTexts();
          const tOpt = opts.find((opt) => opt.includes("実機テスト") || opt.includes("四隅"));
          if (tOpt) await select.selectOption({ label: tOpt });
          await page.waitForTimeout(1500);
          if (await posBtn.isEnabled().catch(() => false)) await posBtn.click();
        }
      }
      if (retryCount < 3 && !posStatus && rowText.includes("動かせません") && await posBtn.isEnabled().catch(() => false)) {
        const curChecks = await page.locator("section[aria-label='実行前の確認'] li").allInnerTexts().catch(() => []);
        const readyToRetry = curChecks.some((t) => t.includes("全ロボットが追跡中（2/2）")) && curChecks.some((t) => t.includes("駆動デバイスが接続中（2/2）"));
        if (readyToRetry) {
          retryCount++;
          console.log(`=> 初期位置への移動を再試行します (${retryCount}/3)...`);
          await posBtn.click();
        }
      }
      await page.waitForTimeout(1000);
    }
  }

  await page.screenshot({ path: path.join(screenshotDir, "step2_ready.png") });

  if (canStart) {
    console.log("\n5. 「開始」ボタンをクリックして走行を開始します！");
    await startBtn.click();
    await page.waitForTimeout(1500);

    console.log("6. 走行テストを監視します (最大220秒)...");
    for (let t = 0; t < 220; t++) {
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

      if ((statusText.includes("完了") && !statusText.includes("待ち")) || statusText.includes("finished")) {
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
        const resumeBtn = page.getByRole("button", { name: "再開", exact: true });
        if (await resumeBtn.isVisible().catch(() => false) && await resumeBtn.isEnabled().catch(() => false)) {
          console.log("  => 「再開」ボタンが有効なためクリックして再開します...");
          await resumeBtn.click();
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
