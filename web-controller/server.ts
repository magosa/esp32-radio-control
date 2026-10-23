import { createServer } from "http";
import next from "next";
import { WebSocketServer } from "ws";
import { FleetHub } from "./fleet/hub";

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
    if (pathname === "/ws/device" || pathname === "/ws/client") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(port, () => {
    console.log(`[fleet-hub] ready on http://localhost:${port} (ws: /ws/device, /ws/client)`);
  });
});
