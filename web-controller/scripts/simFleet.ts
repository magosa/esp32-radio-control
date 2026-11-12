// Simulated fleet for exercising the Hub and the run screen without hardware: robots that obey drive commands,
// and one localizer that reports where they are.
//   npm run sim:fleet -- --count=8     (Hub on FLEET_HUB_HOST:FLEET_HUB_PORT, default localhost:3000)
import WebSocket from "ws";
import { DEFAULT_FIELD_CONFIG } from "../fleet/fieldConfigStore";
import { MAX_ROBOTS } from "../localization/geometry";
import { SimRobot } from "./simRobot";

export interface SimStart { x: number; y: number; yaw?: number }

export interface SimFleet {
  robots: SimRobot[];
  // Marker `index` stops being reported (a lost marker) until shown again.
  hide(index: number): void;
  show(index: number): void;
  stop(): void;
}

const open = (ws: WebSocket) => new Promise<void>((resolve) => ws.once("open", () => resolve()));

export async function startSimFleet(port: string, starts: SimStart[], host = "localhost"): Promise<SimFleet> {
  const robots = starts.map((s) => new SimRobot(s.x, s.y, s.yaw ?? 0));
  const hidden = new Set<number>();
  const devices = await Promise.all(robots.map(async (robot, i) => {
    const ws = new WebSocket(`ws://${host}:${port}/ws/device`);
    await open(ws);
    ws.send(JSON.stringify({ type: "hello", deviceId: `sim${i}`, name: `sim${i}`, fw: "sim", capabilities: ["drive", "display"] }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "drive") robot.command(m.cmd, m.speedL, m.speedR, Date.now());
    });
    return ws;
  }));
  const client = new WebSocket(`ws://${host}:${port}/ws/client`);
  await open(client);
  robots.forEach((_, i) => client.send(JSON.stringify({ type: "assignMarker", requestId: `m${i}`, robotId: `robot-sim${i}`, markerId: i })));
  const localizer = new WebSocket(`ws://${host}:${port}/ws/localizer`, { origin: `http://${host}:${port}` });
  await open(localizer);
  localizer.send(JSON.stringify({ type: "localizerHello", camera: "simulated", width: 1920, height: 1080 }));

  let frame = 0, last = Date.now(), tick = 0;
  const { widthMm, heightMm } = DEFAULT_FIELD_CONFIG;
  const timer = setInterval(() => {
    const now = Date.now();
    robots.forEach((robot) => robot.step(now - last, now));
    last = now;
    if (++tick % 2 !== 0) return;
    localizer.send(JSON.stringify({ type: "poseFrame", frameId: ++frame, capturedAt: now, referenceCount: 4, referenceIds: [40, 41, 42, 43], extrinsicsOk: true,
      markers: robots.map((r, i) => hidden.has(i) ? { markerId: i, valid: false }
        : { markerId: i, valid: true, x: r.x / widthMm * 1600, y: r.y / heightMm * 900, yawDeg: r.yaw, insideField: true }) }));
    devices.forEach((ws, i) => ws.send(JSON.stringify({ type: "telemetry", deviceId: `sim${i}`, cmd: "e", speedL: 0, speedR: 0, heap: 1, uptimeMs: 1 })));
  }, 50);

  return {
    robots, hide: (i) => hidden.add(i), show: (i) => hidden.delete(i),
    stop: () => { clearInterval(timer); [...devices, client, localizer].forEach((ws) => ws.close()); },
  };
}

if (require.main === module) {
  const requested = Number(process.argv.find((arg) => arg.startsWith("--count="))?.slice("--count=".length));
  const count = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, MAX_ROBOTS) : 2;
  // A tidy grid; use /scenes to give the scene robots the ids robot-sim0, robot-sim1, ...
  const starts = Array.from({ length: count }, (_, i) => ({ x: 110 + (i % 4) * 250, y: 110 + Math.floor(i / 4) * 200 }));
  startSimFleet(process.env.FLEET_HUB_PORT || "3000", starts, process.env.FLEET_HUB_HOST || "localhost")
    .then(() => console.log(`[sim-fleet] ${count} robots connected (robot-sim0 ...). Ctrl+C to stop.`))
    .catch((error) => { console.error("[sim-fleet]", error.message); process.exit(1); });
}
