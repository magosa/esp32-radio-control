import type { HistoryClient } from "./historyClient";
import type { SaveState } from "./historyTypes";
import { canRedo, canUndo, initHistory, pushEdit, redo, undo, type EditorHistory } from "./editorHistory";
import { createProject, validateProject, type IdFactory } from "./model";
import type { SceneProject } from "./types";

export type Commit = (edit: (draft: SceneProject) => void, label: string) => string | null;

export interface SceneSession {
  start(): Promise<void>;
  current(): SceneProject | null;
  loadError(): string | null;
  activeMapId(): string | null;
  setActiveMap(id: string): void;
  commit: Commit;
  undo(): string | null;
  redo(): string | null;
  apply(revision: number): Promise<string | null>;
  canUndo(): boolean;
  canRedo(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface SceneSessionOptions {
  client: HistoryClient;
  getSaveState: () => SaveState;
  makeId: IdFactory;
}

const CONFLICT_MESSAGE = "他の画面で更新されたため、編集できません。再読込してください。";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createSceneSession(opts: SceneSessionOptions): SceneSession {
  let history: EditorHistory<SceneProject> | null = null;
  let error: string | null = null;
  let active: string | null = null;
  let starting: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const blocked = () => (opts.getSaveState().kind === "conflict" ? CONFLICT_MESSAGE : null);

  async function load() {
    try {
      const record = await opts.client.load();
      if (!record) {
        const project = createProject("新しいシーン", opts.makeId);
        history = initHistory(project);
        opts.client.record(project, "新規作成");
      } else {
        history = initHistory(validateProject(record.project));
      }
    } catch (e) {
      error = messageOf(e);
    }
    notify();
  }

  const accept = (next: SceneProject, label: string, restoredFrom: number | null = null) => {
    history = pushEdit(history!, next);
    opts.client.record(next, label, restoredFrom);
    notify();
  };

  return {
    start() { return (starting ??= load()); },
    current: () => history?.present ?? null,
    loadError: () => error,
    activeMapId() {
      const maps = history?.present.maps ?? [];
      return maps.find((map) => map.id === active)?.id ?? maps[0]?.id ?? null;
    },
    setActiveMap(id) {
      if (active === id) return;
      active = id;
      notify();
    },
    commit(edit, label) {
      if (!history) return "読み込み中です。";
      const refusal = blocked();
      if (refusal) return refusal;
      try {
        const draft = structuredClone(history.present);
        edit(draft);
        accept(validateProject(draft), label);
        return null;
      } catch (e) {
        return messageOf(e);
      }
    },
    undo() {
      if (!history || !canUndo(history)) return null;
      const refusal = blocked();
      if (refusal) return refusal;
      history = undo(history);
      opts.client.record(history.present, "元に戻す");
      notify();
      return null;
    },
    redo() {
      if (!history || !canRedo(history)) return null;
      const refusal = blocked();
      if (refusal) return refusal;
      history = redo(history);
      opts.client.record(history.present, "やり直し");
      notify();
      return null;
    },
    async apply(revision) {
      if (!history) return "読み込み中です。";
      const refusal = blocked();
      if (refusal) return refusal;
      try {
        const record = await opts.client.get(revision);
        accept(validateProject(record.project), `履歴 #${revision} を適用`, revision);
        return null;
      } catch (e) {
        return messageOf(e);
      }
    },
    canUndo: () => !!history && canUndo(history),
    canRedo: () => !!history && canRedo(history),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
