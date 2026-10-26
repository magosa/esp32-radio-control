import { createServer } from "http";
import next from "next";
import { WebSocketServer } from "ws";
import { FleetHub } from "./fleet/hub";
import { isTrustedLocalizerRequest } from "./fleet/localizerAccess";

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 600000 });
  const hub = new FleetHub();
  hub.attach(wss);

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "", "http://localhost").pathname;
    if (pathname === "/ws/localizer" && !isTrustedLocalizerRequest(req, port, process.env.FLEET_LOCALIZER_ALLOW_REMOTE === "1")) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    } else if (pathname === "/ws/device" || pathname === "/ws/client" || pathname === "/ws/localizer") {
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
