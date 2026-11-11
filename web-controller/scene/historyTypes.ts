import type { SceneProject } from "./types";

export interface SceneHistoryMeta {
  revision: number;
  id: string;
  timestamp: string;
  label: string;
  restoredFrom: number | null;
  hash: string;
}

export interface SceneHistoryRecord extends SceneHistoryMeta {
  project: SceneProject;
}

export type SaveState =
  | { kind: "saved"; revision: number }
  | { kind: "pending"; count: number }
  | { kind: "conflict"; latestRevision: number }
  | { kind: "error"; message: string; count: number };

export interface AppendRequest {
  expectedRevision: number;
  id: string;
  label: string;
  project: unknown;
  restoredFrom?: number | null;
}
