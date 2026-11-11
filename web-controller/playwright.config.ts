import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3117);
const runDir = path.join(os.tmpdir(), `scene-e2e-${process.pid}`);

export default defineConfig({
  testDir: "./browser-tests",
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, channel: "msedge", trace: "retain-on-failure" },
  webServer: {
    command: "npx tsx server.ts",
    url: `http://localhost:${PORT}/api/scenes/history`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT: String(PORT),
      SCENE_HISTORY_DIR: path.join(runDir, "history"),
      FLEET_DATA_DIR: path.join(runDir, "data"),
    },
  },
});
