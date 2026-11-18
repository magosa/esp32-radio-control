import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:3000/ws/client");

ws.on("open", () => {
  console.log("WebSocket connected to /ws/client");
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "fleetState") {
    console.log("\n=== Fleet State ===");
    console.log("Vehicles:", msg.vehicles.map((v: any) => `${v.deviceId} (${v.name}): ${v.status} mode=${v.mode}`));
    console.log("Robots:", msg.robots.map((r: any) => `${r.robotId}: markerId=${r.markerId} status=${r.status}`));
  } else if (msg.type === "poseState") {
    console.log("\n=== Pose State ===");
    console.log("Localizer:", msg.localizer);
    console.log("Poses:", msg.poses.map((p: any) => `${p.robotId}: tracking=${p.tracking} x=${Math.round(p.xMm ?? 0)} y=${Math.round(p.yMm ?? 0)} yaw=${Math.round(p.headingDeg ?? 0)}°`));
    process.exit(0);
  }
});

setTimeout(() => {
  console.log("Timeout waiting for state");
  process.exit(1);
}, 5000);
