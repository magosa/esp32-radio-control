// 俯瞰カメラなしで測位UIを確認するための疑似localizer。
// 使い方: tsx scripts/fakeLocalizer.ts [--assign] [--drop]
//   --assign: 走行機の先頭2台にマーカーID0/1を割り当てる(未割当の場合のみ)
//   --drop:   マーカー1を周期的に隠し、未検出・復帰の挙動を確認する
import WebSocket from "ws";

const host = process.env.FLEET_HUB_HOST || "localhost";
const port = process.env.FLEET_HUB_PORT || "3000";
const assign = process.argv.includes("--assign");
const drop = process.argv.includes("--drop");
const origin = `http://localhost:${port}`;

if (assign) {
  const client = new WebSocket(`ws://${host}:${port}/ws/client`);
  client.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "fleetState") return;
    const robots = (msg.robots ?? []) as { robotId: string; markerId: number | null }[];
    robots.slice(0, 2).forEach((robot, index) => {
      if (robot.markerId === null) {
        client.send(JSON.stringify({ type: "assignMarker", requestId: `sim-${index}`, robotId: robot.robotId, markerId: index }));
      }
    });
    setTimeout(() => client.close(), 500);
    client.removeAllListeners("message");
  });
  client.on("error", (error) => console.error("[fake-localizer] client error", error.message));
}

function connect(): void {
  const ws = new WebSocket(`ws://${host}:${port}/ws/localizer`, { origin });
  let frameId = 0;
  let timer: NodeJS.Timeout | undefined;

  ws.on("open", () => {
    console.log("[fake-localizer] connected");
    ws.send(JSON.stringify({ type: "localizerHello", camera: "Simulated overhead camera", width: 1920, height: 1080 }));
    timer = setInterval(() => {
      const t = Date.now() / 1000;
      const markers = [0, 1].map((markerId) => {
        const angle = t * (0.5 + markerId * 0.2) + markerId * Math.PI;
        const hidden = drop && markerId === 1 && Math.floor(t / 4) % 2 === 1;
        // 比率座標(1600x900): 中心まわりの円運動。yawは進行方向(反時計回りなら接線)に合わせる。
        return hidden ? { markerId, valid: false }
          : { markerId, valid: true, x: 800 + 450 * Math.cos(angle), y: 450 + 250 * Math.sin(angle),
            yawDeg: ((angle * 180 / Math.PI + 90 + 180) % 360) - 180, insideField: true };
      });
      ws.send(JSON.stringify({ type: "poseFrame", frameId: ++frameId, capturedAt: Date.now(), referenceCount: 4, extrinsicsOk: true, markers }));
    }, 100);
  });
  ws.on("close", () => {
    if (timer) clearInterval(timer);
    console.log("[fake-localizer] disconnected, retrying in 3s");
    setTimeout(connect, 3000);
  });
  ws.on("error", (error) => console.error("[fake-localizer] error", error.message));
}

connect();
