import "./scene/ids";
import { createServer } from "http";
import path from "path";
import next from "next";
import { WebSocketServer } from "ws";
import { FleetHub } from "./fleet/hub";
import { isTrustedLocalizerRequest } from "./fleet/localizerAccess";
import { SceneHistoryStore } from "./fleet/sceneHistoryStore";
import { handleSceneRequest } from "./fleet/sceneHttp";

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

// 履歴が破損・番号抜け・二重起動のときは例外で起動を止める。
const sceneStore = SceneHistoryStore.open(process.env.SCENE_HISTORY_DIR || path.join(process.cwd(), "data", "scene-history"));
let activeWss: WebSocketServer | null = null;
let activeHub: FleetHub | null = null;
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
  process.on(signal, () => {
    try { activeHub?.dispose(); } catch {}
    try { activeWss?.clients.forEach((ws) => { try { ws.close(1001, "Restarting"); } catch {} }); } catch {}
    setTimeout(() => {
      try { activeWss?.clients.forEach((ws) => { try { ws.terminate(); } catch {} }); } catch {}
      process.exit(0);
    }, 150).unref?.();
  });
}
process.on("exit", () => sceneStore.close());

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handleSceneRequest(req, res, sceneStore).then((handled) => {
      if (!handled) handle(req, res);
    }, (error) => {
      console.error("[scene-http]", error);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 600000 });
  const hub = new FleetHub(undefined, undefined, (id) => sceneStore.latest()?.project.maps.find((map) => map.id === id) ?? null);
  activeWss = wss;
  activeHub = hub;
  hub.attach(wss);

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => { try { socket.destroy(); } catch {} });
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === "/ws/localizer" && !isTrustedLocalizerRequest(req, port, process.env.FLEET_LOCALIZER_ALLOW_REMOTE === "1")) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    } else if (pathname === "/ws/device" || pathname === "/ws/client" || pathname === "/ws/localizer") {
      const tcpSocket = socket as import("net").Socket;
      tcpSocket.setNoDelay?.(true);
      tcpSocket.setKeepAlive?.(true, 3000);
      if (pathname === "/ws/device") {
        console.log(`[server] upgrade /ws/device from ${req.socket.remoteAddress}:${req.socket.remotePort}`);
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(port, () => {
    console.log(`[fleet-hub] ready on http://localhost:${port} (ws: /ws/device, /ws/client, /ws/localizer)`);
  });
});
