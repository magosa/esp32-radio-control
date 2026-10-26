import fs from "node:fs";
import path from "node:path";
import type { DeviceCapability, DeviceDescription, RobotDefinition } from "./protocol";

interface StoredFleet {
  version: 1;
  devices: DeviceDescription[];
  robots: RobotDefinition[];
}

const CAPABILITIES: DeviceCapability[] = ["drive", "display", "camera"];
export const DEFAULT_MARKER_HEIGHT_MM = 90;
export const MAX_MARKER_ID = 3;
const MAX_MARKER_HEIGHT_MM = 1000;

export function isDeviceDescription(value: unknown): value is DeviceDescription {
  if (!value || typeof value !== "object") return false;
  const device = value as DeviceDescription;
  return typeof device.deviceId === "string" && device.deviceId.length > 0 && device.deviceId.length <= 64
    && typeof device.name === "string" && device.name.length <= 128
    && typeof device.fw === "string" && device.fw.length <= 64
    && Array.isArray(device.capabilities) && device.capabilities.length > 0
    && device.capabilities.every((capability) => CAPABILITIES.includes(capability))
    && new Set(device.capabilities).size === device.capabilities.length;
}

export class RobotStore {
  private data: StoredFleet = { version: 1, devices: [], robots: [] };

  constructor(private filePath: string) {
    if (!fs.existsSync(filePath)) return;
    const loaded = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredFleet;
    if (loaded.version !== 1 || !Array.isArray(loaded.devices) || !Array.isArray(loaded.robots)
      || !loaded.devices.every(isDeviceDescription)
      || new Set(loaded.devices.map((device) => device.deviceId)).size !== loaded.devices.length) {
      throw new Error("Invalid fleet configuration");
    }
    this.validateRobots(loaded);
    // version 1の旧ファイルにはマーカー項目がないため既定値で補う。
    loaded.robots = loaded.robots.map((robot) => ({ ...robot, markerId: robot.markerId ?? null,
      markerHeightMm: robot.markerHeightMm ?? DEFAULT_MARKER_HEIGHT_MM }));
    this.data = loaded;
  }

  getDevices(): DeviceDescription[] {
    return structuredClone(this.data.devices);
  }

  getRobots(): RobotDefinition[] {
    return structuredClone(this.data.robots);
  }

  register(device: DeviceDescription): void {
    if (!isDeviceDescription(device)) throw new Error("Invalid device description");
    const next = structuredClone(this.data);
    next.devices = next.devices.filter((known) => known.deviceId !== device.deviceId);
    next.devices.push(structuredClone(device));
    if (device.capabilities.includes("drive") && !next.robots.some((robot) => robot.driveDeviceId === device.deviceId)) {
      next.robots.push({ robotId: `robot-${device.deviceId}`, driveDeviceId: device.deviceId, cameraDeviceId: null,
        markerId: null, markerHeightMm: DEFAULT_MARKER_HEIGHT_MM });
    }
    this.validateRobots(next);
    if (JSON.stringify(this.data) !== JSON.stringify(next)) this.save(next);
  }

  assignCamera(robotId: string, cameraDeviceId: string | null): void {
    const next = structuredClone(this.data);
    const robot = next.robots.find((candidate) => candidate.robotId === robotId);
    if (!robot) throw new Error("Robot not found");
    robot.cameraDeviceId = cameraDeviceId;
    this.validateRobots(next);
    this.save(next);
  }

  // markerHeightMm省略時は現在の高さを維持する。
  assignMarker(robotId: string, markerId: number | null, markerHeightMm?: number): void {
    const next = structuredClone(this.data);
    const robot = next.robots.find((candidate) => candidate.robotId === robotId);
    if (!robot) throw new Error("Robot not found");
    robot.markerId = markerId;
    if (markerHeightMm !== undefined) robot.markerHeightMm = markerHeightMm;
    this.validateRobots(next);
    this.save(next);
  }

  private validateRobots(data: StoredFleet): void {
    const robotIds = new Set<string>();
    const driveIds = new Set<string>();
    const cameraIds = new Set<string>();
    const markerIds = new Set<number>();
    for (const robot of data.robots) {
      if (!robot || typeof robot.robotId !== "string" || !robot.robotId || robotIds.has(robot.robotId)
        || typeof robot.driveDeviceId !== "string" || driveIds.has(robot.driveDeviceId)
        || !data.devices.some((device) => device.deviceId === robot.driveDeviceId && device.capabilities.includes("drive"))) {
        throw new Error("Invalid robot controller");
      }
      robotIds.add(robot.robotId);
      driveIds.add(robot.driveDeviceId);
      if (robot.markerId !== undefined && robot.markerId !== null) {
        if (!Number.isInteger(robot.markerId) || robot.markerId < 0 || robot.markerId > MAX_MARKER_ID
          || markerIds.has(robot.markerId)) throw new Error("Marker ID invalid or already assigned");
        markerIds.add(robot.markerId);
      }
      if (robot.markerHeightMm !== undefined && !(Number.isFinite(robot.markerHeightMm)
        && robot.markerHeightMm > 0 && robot.markerHeightMm <= MAX_MARKER_HEIGHT_MM)) throw new Error("Invalid marker height");
      if (robot.cameraDeviceId !== null) {
        if (typeof robot.cameraDeviceId !== "string" || cameraIds.has(robot.cameraDeviceId)
          || !data.devices.some((device) => device.deviceId === robot.cameraDeviceId && device.capabilities.includes("camera"))) {
          throw new Error("Camera unavailable or already assigned");
        }
        cameraIds.add(robot.cameraDeviceId);
      }
    }
  }

  private save(next: StoredFleet): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    this.data = next;
  }
}