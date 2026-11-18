import WebSocket from "ws";

// 引数解析
const args = process.argv.slice(2);
const getArg = (key: string, def: string) => {
  const idx = args.indexOf(key);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
};

const targetDevice = getArg("--target", "rc-a5f848"); // rc-a5f848 = ロボット0, rc-a50a28 = ロボット1
const pwm = Math.min(220, Math.max(100, parseInt(getArg("--pwm", "175"), 10)));
const durationMs = Math.min(1000, Math.max(100, parseInt(getArg("--duration", "350"), 10)));
const cmd = getArg("--cmd", "a") as "a" | "b" | "c" | "d";

const CMD_NAMES: Record<string, string> = {
  a: "前進 (Forward)",
  b: "後退 (Backward)",
  c: "右旋回 (Turn Right)",
  d: "左旋回 (Turn Left)",
};

async function main() {
  console.log(`\n======================================================`);
  console.log(`  安全パルステスト: 【${CMD_NAMES[cmd] ?? cmd}】`);
  console.log(`  対象: ${targetDevice} | PWM: ${pwm} | 時間: ${durationMs}ms`);
  console.log(`======================================================\n`);

  const ws = new WebSocket("ws://localhost:3000/ws/client");

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  // 1. 開始前の姿勢を取得
  let startPose: { x: number; y: number; yaw: number } | null = null;
  let deviceOnline = false;

  const waitInitialState = new Promise<void>((resolve) => {
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "fleetState") {
        const v = msg.vehicles.find((item: any) => item.deviceId === targetDevice);
        if (v?.status === "online") deviceOnline = true;
      }
      if (msg.type === "poseState") {
        const p = msg.poses.find((item: any) => item.deviceId === targetDevice);
        if (p?.tracking === "tracking" && p.xMm !== undefined && p.yMm !== undefined && p.headingDeg !== undefined) {
          startPose = { x: p.xMm, y: p.yMm, yaw: p.headingDeg };
          if (deviceOnline) {
            ws.off("message", handler);
            resolve();
          }
        }
      }
    };
    ws.on("message", handler);
  });

  console.log("機体とカメラ測位の接続を確認中...");
  await Promise.race([
    waitInitialState,
    new Promise((_, reject) => setTimeout(() => reject(new Error("接続待機タイムアウト")), 5000)),
  ]).catch((err) => {
    console.error("❌ エラー:", err.message);
    ws.close();
    process.exit(1);
  });

  if (!startPose) {
    console.error("❌ カメラで機体が見つかりません。マーカーが映っているか確認してください。");
    ws.close();
    process.exit(1);
  }

  const p0 = startPose as { x: number; y: number; yaw: number };
  console.log(`[開始姿勢] 座標: (${p0.x.toFixed(1)}, ${p0.y.toFixed(1)}) mm | 向き: ${p0.yaw.toFixed(1)}°`);

  // 端に近い場合の安全ガード (120mm以内は警告)
  if (p0.x < 120 || p0.x > 980 || p0.y < 100 || p0.y > 520) {
    console.warn("⚠️ 警告: 機体がフィールドの端に近すぎます。安全のためフィールド中央付近へ置き直してください。");
  }

  // 2. 超短時間パルス駆動
  console.log(`\n>> コマンド送信: cmd='${cmd}', PWM=${pwm} を ${durationMs}ms だけ出力します...`);
  ws.send(JSON.stringify({
    type: "clientCommand",
    targetDeviceIds: [targetDevice],
    cmd,
    speedL: pwm,
    speedR: pwm,
  }));

  // durationMs 待機後、確実に停止
  await new Promise((r) => setTimeout(r, durationMs));

  // 確実に停止コマンドを連打送信
  ws.send(JSON.stringify({ type: "clientCommand", targetDeviceIds: [targetDevice], cmd: "e", speedL: 0, speedR: 0 }));
  ws.send(JSON.stringify({ type: "clientCommand", targetDeviceIds: [targetDevice], cmd: "e", speedL: 0, speedR: 0 }));
  console.log(">> 停止コマンド (cmd='e') 送信完了。静止を待機中...");

  // 機体が完全に静止し、最新フレームが届くまで1秒待機
  await new Promise((r) => setTimeout(r, 1200));

  // 3. 停止後の姿勢を取得
  let endPose: { x: number; y: number; yaw: number } | null = null;
  await new Promise<void>((resolve) => {
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "poseState") {
        const p = msg.poses.find((item: any) => item.deviceId === targetDevice);
        if (p?.tracking === "tracking" && p.xMm !== undefined && p.yMm !== undefined && p.headingDeg !== undefined) {
          endPose = { x: p.xMm, y: p.yMm, yaw: p.headingDeg };
          ws.off("message", handler);
          resolve();
        }
      }
    };
    ws.on("message", handler);
    setTimeout(resolve, 3000);
  });

  if (!endPose) {
    console.error("❌ 停止後の姿勢を取得できませんでした。");
    ws.close();
    process.exit(1);
  }

  const p1 = endPose as { x: number; y: number; yaw: number };
  console.log(`[停止姿勢] 座標: (${p1.x.toFixed(1)}, ${p1.y.toFixed(1)}) mm | 向き: ${p1.yaw.toFixed(1)}°`);

  // 4. 解析結果の表示
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.hypot(dx, dy);
  let dYaw = p1.yaw - p0.yaw;
  while (dYaw > 180) dYaw -= 360;
  while (dYaw < -180) dYaw += 360;

  console.log(`\n------------------ 【測定・校正結果】 ------------------`);
  console.log(`  移動距離:   ${dist.toFixed(1)} mm`);
  console.log(`  推定速度:   ${(dist / (durationMs / 1000)).toFixed(1)} mm/s`);
  console.log(`  旋回変化:   ${dYaw > 0 ? "+" : ""}${dYaw.toFixed(1)}°`);

  if (cmd === "a" || cmd === "b") {
    if (dist < 8) {
      console.log(`  判定:       【トルク不足 / 静止】 モーターが回りませんでした（PWM ${pwm} では摩擦に負けています）。`);
      console.log(`  推奨アクション: PWMを +10 上げて再テストしてください（例: --pwm ${pwm + 10}）。`);
    } else {
      const moveBearing = Math.atan2(dy, dx) * 180 / Math.PI;
      let offset = moveBearing - p0.yaw;
      while (offset > 180) offset -= 360;
      while (offset < -180) offset += 360;
      console.log(`  実移動方向: ${moveBearing.toFixed(1)}° （マーカー向き ${p0.yaw.toFixed(1)}° に対するズレ: ${offset.toFixed(1)}°）`);
      console.log(`  判定:       【良好】 安全に進んでピタッと停止しました！`);
      if (Math.abs(offset) > 30) {
        console.warn(`  ⚠️ 注意: マーカーの貼り付け向きと車体の前進方向に約 ${Math.abs(offset).toFixed(0)}° のオフセットがあります。`);
      }
    }
  } else {
    // 旋回
    if (Math.abs(dYaw) < 5) {
      console.log(`  判定:       【トルク不足 / 旋回不能】 タイヤが滑らず回れませんでした。`);
      console.log(`  推奨アクション: PWMを +10 上げて再テストしてください（例: --pwm ${pwm + 10}）。`);
    } else {
      console.log(`  旋回レート: 約 ${(Math.abs(dYaw) / (durationMs / 1000)).toFixed(1)} °/s`);
      console.log(`  回転方向:   ${dYaw > 0 ? "反時計回り (左)" : "時計回り (右)"}`);
      console.log(`  判定:       【良好】 旋回してピタッと停止しました！`);
    }
  }
  console.log(`--------------------------------------------------------\n`);

  ws.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
