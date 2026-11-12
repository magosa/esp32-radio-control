// What the Hub's scene runner reports to the run screen, and the commands the screen sends back.

export type RunPhase = "idle" | "arming" | "running" | "waiting" | "halted" | "finished" | "aborted";

export type HaltKind = "operator" | "lost" | "stuck" | "outside" | "localizer" | "references" | "device" | "timeout";

export type RunCommand =
  | { type: "prepare"; mapId: string }
  | { type: "position" }
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "abort" }
  | { type: "reset" };

export interface RunCheck {
  id: string;
  label: string;
  ok: boolean;
  // A warning does not block the start.
  warn?: boolean;
  detail: string;
}

export type PositionState = "waiting" | "moving" | "arrived" | "failed";

export type RobotRunStatus = "idle" | "driving" | "arrived" | "waiting" | "lost" | "failed" | "excluded";

export interface RunRobot {
  trackId: string;
  name: string;
  robotId: string | null;
  markerId: number | null;
  tracking: string;
  status: RobotRunStatus;
  bar: string | null;
  barStart: number | null;
  barEnd: number | null;
  posErrMm: number | null;
  yawErrDeg: number | null;
  settledSec: number;
  pose: { x: number; y: number; yaw: number } | null;
  target: { x: number; y: number; yaw: number } | null;
  note: string;
}

export interface RunLogEntry {
  clock: number;
  at: number;
  kind: "info" | "warn" | "error";
  text: string;
}

export interface RunCondition {
  label: string;
  ok: boolean;
  detail: string;
}

export interface RunResultRow {
  trackId: string;
  robot: string;
  action: string;
  planStart: number;
  planEnd: number;
  arrivedAt: number | null;
  posErrMm: number | null;
  yawErrDeg: number | null;
  waitedSec: number;
  status: "arrived" | "failed" | "pending";
  note: string;
}

export interface RunSnapshot {
  phase: RunPhase;
  mapId: string | null;
  mapName: string;
  // One line: why the clock is stopped, or the state.
  reason: string;
  halt: { kind: HaltKind; since: number } | null;
  resume: RunCondition[];
  clock: number;
  duration: number;
  realMs: number;
  waitedMs: number;
  checks: RunCheck[];
  canStart: boolean;
  positioning: { active: boolean; items: { trackId: string; name: string; state: PositionState; detail: string }[] };
  robots: RunRobot[];
  log: RunLogEntry[];
  rows: RunResultRow[];
}

export interface RunResultFile {
  schema: "scene-run-result/v1";
  mapId: string | null;
  mapName: string;
  outcome: "finished" | "aborted";
  startedAt: number | null;
  endedAt: number | null;
  realSeconds: number;
  planSeconds: number;
  waitedSeconds: number;
  rows: RunResultRow[];
  log: RunLogEntry[];
}

export function parseRunCommand(value: unknown): RunCommand | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  switch (item.type) {
    case "prepare":
      return typeof item.mapId === "string" && item.mapId.length > 0 && item.mapId.length <= 100 ? { type: "prepare", mapId: item.mapId } : null;
    case "position": case "start": case "pause": case "resume": case "abort": case "reset":
      return { type: item.type };
    default:
      return null;
  }
}
export const idleSnapshot = (): RunSnapshot => ({
  phase: "idle", mapId: null, mapName: "", reason: "シーンを選んでください。", halt: null, resume: [], clock: 0, duration: 0,
  realMs: 0, waitedMs: 0, checks: [], canStart: false, positioning: { active: false, items: [] }, robots: [], log: [], rows: [],
});

export const isRunActive = (phase: RunPhase): boolean => phase === "running" || phase === "waiting" || phase === "halted";
