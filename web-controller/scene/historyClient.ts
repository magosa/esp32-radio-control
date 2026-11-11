import type { SceneProject } from "./types";
import type { SaveState, SceneHistoryMeta, SceneHistoryRecord } from "./historyTypes";

interface QueuedRecord {
  id: string;
  label: string;
  project: SceneProject;
  restoredFrom: number | null;
}

export interface HistoryClientOptions {
  fetch: typeof fetch;
  baseUrl?: string;
  makeId: () => string;
  onState: (s: SaveState) => void;
}

export interface HistoryClient {
  load(): Promise<SceneHistoryRecord | null>;
  record(project: SceneProject, label: string, restoredFrom?: number | null): void;
  retry(): void;
  list(): Promise<SceneHistoryMeta[]>;
  get(revision: number): Promise<SceneHistoryRecord>;
}

type Mode = "idle" | "sending" | "conflict" | "error";

export function createHistoryClient(opts: HistoryClientOptions): HistoryClient {
  const base = opts.baseUrl ?? "";
  const url = (path: string) => `${base}/api/scenes/${path}`;
  const queue: QueuedRecord[] = [];
  let revision = 0;
  let mode: Mode = "idle";
  let latestConflict = 0;
  let lastMessage = "";

  async function readJson(res: Response): Promise<any> {
    try { return await res.json(); } catch { return {}; }
  }

  function emitCurrent() {
    if (mode === "conflict") opts.onState({ kind: "conflict", latestRevision: latestConflict });
    else if (mode === "error") opts.onState({ kind: "error", message: lastMessage, count: queue.length });
    else if (queue.length === 0) opts.onState({ kind: "saved", revision });
    else opts.onState({ kind: "pending", count: queue.length });
  }

  async function drain(): Promise<void> {
    if (mode === "sending" || mode === "conflict") return;
    mode = "sending";
    while (queue.length > 0) {
      const head = queue[0];
      let res: Response;
      try {
        res = await opts.fetch(url("history"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedRevision: revision,
            id: head.id,
            label: head.label,
            project: head.project,
            restoredFrom: head.restoredFrom,
          }),
        });
      } catch (error) {
        mode = "error";
        lastMessage = error instanceof Error ? error.message : String(error);
        emitCurrent();
        return;
      }
      const body = await readJson(res);
      if (res.status === 201 || res.status === 200) {
        revision = body.revision;
        queue.shift();
        if (queue.length > 0) opts.onState({ kind: "pending", count: queue.length });
        continue;
      }
      if (res.status === 409) {
        mode = "conflict";
        latestConflict = typeof body.latestRevision === "number" ? body.latestRevision : revision;
        emitCurrent();
        return;
      }
      mode = "error";
      lastMessage = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
      emitCurrent();
      return;
    }
    mode = "idle";
    emitCurrent();
  }

  return {
    async load() {
      const res = await opts.fetch(url("latest"), { cache: "no-store" });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`履歴の読込に失敗しました (HTTP ${res.status})`);
      const record = (await res.json()) as SceneHistoryRecord;
      revision = record.revision;
      return record;
    },
    record(project, label, restoredFrom = null) {
      queue.push({ id: opts.makeId(), label, project: structuredClone(project), restoredFrom });
      emitCurrent();
      if (mode === "idle") void drain();
    },
    retry() {
      if (mode !== "error") return;
      mode = "idle";
      void drain();
    },
    async list() {
      const res = await opts.fetch(url("history"), { cache: "no-store" });
      if (!res.ok) throw new Error(`履歴一覧の取得に失敗しました (HTTP ${res.status})`);
      return ((await res.json()) as { records: SceneHistoryMeta[] }).records;
    },
    async get(rev) {
      const res = await opts.fetch(url(`history/${rev}`), { cache: "no-store" });
      if (!res.ok) throw new Error(`履歴 #${rev} の取得に失敗しました (HTTP ${res.status})`);
      return (await res.json()) as SceneHistoryRecord;
    },
  };
}
