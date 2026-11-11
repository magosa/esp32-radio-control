import WebSocket from "ws";

const PORT = Number(process.env.E2E_PORT ?? 3117);
const HOST = `localhost:${PORT}`;
const ORIGIN = `http://localhost:${PORT}`;

const open = (url: string, options: WebSocket.ClientOptions = {}) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(url, options);
  ws.once("open", () => resolve(ws));
  ws.once("error", reject);
});

// Sends one client message and resolves when the Hub answers it with an operationResult.
export async function clientRequest(message: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const ws = await open(`ws://${HOST}/ws/client`);
  try {
    return await new Promise((resolve, reject) => {
      const requestId = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const timer = setTimeout(() => reject(new Error("no operationResult")), 5000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "operationResult" && msg.requestId === requestId) { clearTimeout(timer); resolve(msg); }
      });
      ws.send(JSON.stringify({ ...message, requestId }));
    });
  } finally {
    ws.close();
  }
}

export const exhibitCommand = (command: Record<string, unknown>) => clientRequest({ type: "exhibitCommand", command });

// A drive device that stays online, registered as robot-<deviceId> with a marker assigned.
export async function connectRobot(deviceId: string, markerId: number): Promise<{ robotId: string; close(): void }> {
  const ws = await open(`ws://${HOST}/ws/device`);
  const hello = { type: "hello", deviceId, name: deviceId, fw: "e2e", capabilities: ["drive"] };
  ws.send(JSON.stringify(hello));
  const beat = setInterval(() => ws.send(JSON.stringify({ type: "heartbeat", deviceId })), 1000);
  const robotId = `robot-${deviceId}`;
  let result: { ok: boolean; error?: string } = { ok: false };
  for (let attempt = 0; attempt < 10 && !result.ok; attempt++) {
    result = await clientRequest({ type: "assignMarker", robotId, markerId, markerHeightMm: 90 }).catch((error) => ({ ok: false, error: String(error) }));
    if (!result.ok) await new Promise((r) => setTimeout(r, 200));
  }
  if (!result.ok) throw new Error(`assignMarker failed: ${result.error}`);
  return { robotId, close: () => { clearInterval(beat); ws.close(); } };
}

export interface RatioPose { x: number; y: number; yawDeg: number }

// A stand-in overhead camera: the four reference markers are always seen; markers listed in `poses` are tracked.
export async function startLocalizer(): Promise<{ set(markerId: number, pose: RatioPose | null): void; close(): void }> {
  const ws = await open(`ws://${HOST}/ws/localizer`, { origin: ORIGIN });
  ws.send(JSON.stringify({ type: "localizerHello", camera: "e2e camera", width: 1920, height: 1080 }));
  const poses = new Map<number, RatioPose>();
  let frameId = 0;
  const send = () => {
    const markers = Array.from(poses.entries()).map(([markerId, pose]) => ({ markerId, valid: true, ...pose, insideField: true }));
    ws.send(JSON.stringify({ type: "poseFrame", frameId: ++frameId, capturedAt: Date.now(), referenceCount: 4,
      referenceIds: [40, 41, 42, 43], extrinsicsOk: true, markers }));
  };
  const timer = setInterval(send, 100);
  send();
  return {
    set: (markerId, pose) => { if (pose) poses.set(markerId, pose); else poses.delete(markerId); },
    close: () => { clearInterval(timer); ws.close(); },
  };
}
