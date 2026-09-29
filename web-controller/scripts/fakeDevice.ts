// フリートUI/ルートエンジンの検証用に、実機なしで複数の疑似ESP32を接続するシミュレータ。
// 使い方: tsx scripts/fakeDevice.ts <deviceId> <name>
import WebSocket from "ws";
import jpeg from "jpeg-js";
import type { DriveCommand } from "../fleet/protocol";

const [, , idArg, nameArg] = process.argv;
const deviceId = idArg || `rc-sim${Math.floor(Math.random() * 1000)}`;
const name = nameArg || deviceId;
const host = process.env.FLEET_HUB_HOST || "localhost";
const port = process.env.FLEET_HUB_PORT || "3000";

let currentCmd: DriveCommand = "e";
let speedL = 0;
let speedR = 0;

// OV2640(JPEG出力)を模した疑似フレームを都度生成する(グラデーション柄のQVGA JPEG)
const CAM_WIDTH = 320;
const CAM_HEIGHT = 240;

function buildDummyJpegB64(): string {
  const frameData = Buffer.alloc(CAM_WIDTH * CAM_HEIGHT * 4);
  const t = Date.now() / 500;
  for (let y = 0; y < CAM_HEIGHT; y++) {
    for (let x = 0; x < CAM_WIDTH; x++) {
      const o = (y * CAM_WIDTH + x) * 4;
      frameData[o] = Math.floor(((x / CAM_WIDTH) * 255 + t * 10) % 255); // R
      frameData[o + 1] = Math.floor((y / CAM_HEIGHT) * 255); // G
      frameData[o + 2] = 128; // B
      frameData[o + 3] = 255; // A
    }
  }
  const encoded = jpeg.encode({ data: frameData, width: CAM_WIDTH, height: CAM_HEIGHT }, 60);
  return Buffer.from(encoded.data).toString("base64");
}

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
    } else if (msg.type === "captureImage") {
      console.log(`[${deviceId}] captureImage -> sending dummy JPEG frame`);
      ws.send(
        JSON.stringify({
          type: "imageFrame",
          deviceId,
          width: CAM_WIDTH,
          height: CAM_HEIGHT,
          format: "jpeg",
          dataB64: buildDummyJpegB64(),
        })
      );
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
