import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:3000/ws/client");

ws.on("open", () => {
  console.log("緊急停止コマンドを送信します...");
  ws.send(JSON.stringify({ type: "emergencyStop" }));
  ws.send(JSON.stringify({ type: "driveCommand", targetDeviceIds: "all", cmd: "e", speedL: 0, speedR: 0 }));
  setTimeout(() => {
    console.log("全機体停止完了");
    ws.close();
    process.exit(0);
  }, 500);
});

ws.on("error", (err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
