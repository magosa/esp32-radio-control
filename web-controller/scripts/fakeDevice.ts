// フリートUI/ルートエンジンの検証用に、実機なしで複数の疑似ESP32を接続するシミュレータ。
// 使い方: tsx scripts/fakeDevice.ts <deviceId> <name>
import WebSocket from "ws";
import jpeg from "jpeg-js";
import type { DriveCommand } from "../fleet/protocol";

const [, , idArg, nameArg, roleArg = "drive"] = process.argv;
const host = process.env.FLEET_HUB_HOST || "localhost";
const port = process.env.FLEET_HUB_PORT || "3000";

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

function simulateDevice(deviceId: string, name: string, role: "drive" | "camera" | "legacy"): void {
  let currentCmd: DriveCommand = "e";
  let speedL = 0;
  let speedR = 0;
  let lastDrive = 0;
  let lastHubMessage = 0;
  let streaming = false;
  let displayName = name;
  function connect(): void {
  const ws = new WebSocket(`ws://${host}:${port}/ws/device`);

  ws.on("open", () => {
    console.log(`[${deviceId}] connected`);
    streaming = false;
    currentCmd = "e";
    speedL = speedR = 0;
    lastHubMessage = Date.now();
    ws.send(JSON.stringify({ type: "hello", deviceId, name: displayName, fw: "sim-2.0.0",
      ...(role === "legacy" ? {} : { capabilities: role === "camera" ? ["camera"] : ["drive", "display"] }) }));
  });

  const sendFrame = () => {
    if (ws.readyState !== ws.OPEN || role !== "camera") return;
    ws.send(JSON.stringify({ type: "imageFrame", deviceId, width: CAM_WIDTH,
      height: CAM_HEIGHT, format: "jpeg", dataB64: buildDummyJpegB64() }));
  };

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    lastHubMessage = Date.now();
    if (msg.type === "drive" && role !== "camera") {
      lastDrive = Date.now();
      currentCmd = msg.cmd;
      speedL = msg.speedL;
      speedR = msg.speedR;
      console.log(`[${deviceId}] drive -> ${currentCmd} L=${speedL} R=${speedR}`);
    } else if (msg.type === "setName") {
      displayName = msg.name;
      console.log(`[${deviceId}] setName -> ${msg.name}`);
    } else if (msg.type === "captureImage" && role === "camera") {
      console.log(`[${deviceId}] captureImage -> sending dummy JPEG frame`);
      sendFrame();
    } else if (msg.type === "streamStart" && role === "camera") {
      streaming = true;
    } else if (msg.type === "streamStop") {
      streaming = false;
    }
  });

  const streamTimer = setInterval(() => {
    if (streaming && Date.now() - lastHubMessage > 5000) streaming = false;
    if (streaming) sendFrame();
    if (role !== "camera" && currentCmd !== "e" && Date.now() - lastDrive > 1500) {
      currentCmd = "e";
      speedL = speedR = 0;
    }
  }, 200);

  const telemetryTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      if (role === "camera") {
        ws.send(JSON.stringify({ type: "heartbeat", deviceId }));
        return;
      }
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
    streaming = false;
    currentCmd = "e";
    speedL = speedR = 0;
    clearInterval(streamTimer);
    clearInterval(telemetryTimer);
    console.log(`[${deviceId}] disconnected, retrying in 3s`);
    setTimeout(connect, 3000);
  });

  ws.on("error", (err) => {
    console.error(`[${deviceId}] error`, err.message);
  });
  }

  console.log(`Simulating ${role} ${deviceId} (${name}) -> ws://${host}:${port}/ws/device`);
  connect();
}

if (idArg === "--fleet") {
  simulateDevice("demo-drive-1", "Robot One", "drive");
  simulateDevice("demo-drive-2", "Robot Two", "legacy");
  simulateDevice("demo-camera-1", "XIAO Camera", "camera");
} else {
  if (!["drive", "camera", "legacy"].includes(roleArg)) throw new Error("Role must be drive, camera or legacy");
  const deviceId = idArg || `rc-sim${Math.floor(Math.random() * 1000)}`;
  simulateDevice(deviceId, nameArg || deviceId, roleArg as "drive" | "camera" | "legacy");
}
