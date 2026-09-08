// フリートUI/ルートエンジンの検証用に、実機なしで複数の疑似ESP32を接続するシミュレータ。
// 使い方: tsx scripts/fakeDevice.ts <deviceId> <name>
import WebSocket from "ws";
import type { DriveCommand } from "../fleet/protocol";

const [, , idArg, nameArg] = process.argv;
const deviceId = idArg || `rc-sim${Math.floor(Math.random() * 1000)}`;
const name = nameArg || deviceId;
const host = process.env.FLEET_HUB_HOST || "localhost";
const port = process.env.FLEET_HUB_PORT || "3000";

let currentCmd: DriveCommand = "e";
let speedL = 0;
let speedR = 0;

function connect(): void {
  const ws = new WebSocket(`ws://${host}:${port}/ws/device`);

  ws.on("open", () => {
    console.log(`[${deviceId}] connected`);
    ws.send(JSON.stringify({ type: "hello", deviceId, name, fw: "sim-1.0.0" }));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "drive") {
      currentCmd = msg.cmd;
      speedL = msg.speedL;
      speedR = msg.speedR;
      console.log(`[${deviceId}] drive -> ${currentCmd} L=${speedL} R=${speedR}`);
    } else if (msg.type === "setName") {
      console.log(`[${deviceId}] setName -> ${msg.name}`);
    }
  });

  const telemetryTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "telemetry",
          deviceId,
          cmd: currentCmd,
          speedL,
          speedR,
          heap: 150000,
          uptimeMs: Math.round(process.uptime() * 1000),
        })
      );
    }
  }, 1000);

  ws.on("close", () => {
    clearInterval(telemetryTimer);
    console.log(`[${deviceId}] disconnected, retrying in 3s`);
    setTimeout(connect, 3000);
  });

  ws.on("error", (err) => {
    console.error(`[${deviceId}] error`, err.message);
  });
}

console.log(`Simulating device ${deviceId} (${name}) -> ws://${host}:${port}/ws/device`);
connect();
