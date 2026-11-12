"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createHistoryClient } from "@/scene/historyClient";
import type { SaveState, SceneHistoryMeta, SceneHistoryRecord } from "@/scene/historyTypes";
import { defaultId } from "@/scene/ids";
import { isRunActive } from "@/scene/runTypes";
import { createSceneSession, type Commit, type SceneSession } from "@/scene/sceneSession";
import type { SceneMap, SceneProject } from "@/scene/types";
import { useFleetSocket } from "./useFleetSocket";

const RUN_LOCKED = "シーンを実行中のため編集できません。";

export type { Commit };

export interface SceneHistoryApi {
  list(): Promise<SceneHistoryMeta[]>;
  get(revision: number): Promise<SceneHistoryRecord>;
  apply(revision: number): Promise<string | null>;
  retry(): void;
}

export interface SceneProjectApi {
  project: SceneProject | null;
  activeMap: SceneMap | null;
  activeMapId: string | null;
  loadError: string | null;
  setActiveMap(id: string): void;
  commit: Commit;
  // True while the Hub runs a scene: every edit is refused.
  locked: boolean;
  undo(): string | null;
  redo(): string | null;
  canUndo: boolean;
  canRedo: boolean;
  saveState: SaveState;
  history: SceneHistoryApi;
  reload(): void;
}

interface Runtime {
  session: SceneSession;
  retry(): void;
  list(): Promise<SceneHistoryMeta[]>;
  get(revision: number): Promise<SceneHistoryRecord>;
}

export function useSceneProject(): SceneProjectApi {
  const [saveState, setSaveState] = useState<SaveState>({ kind: "saved", revision: 0 });
  const saveRef = useRef(saveState);
  saveRef.current = saveState;
  const [generation, setGeneration] = useState(0);

  // StrictMode の二重実行でも最初のプロジェクトを二重作成しないよう、世代ごとに 1 つだけ作る。
  const runtimes = useRef(new Map<number, Runtime>());
  const runtime = useMemo(() => {
    const existing = runtimes.current.get(generation);
    if (existing) return existing;
    const client = createHistoryClient({
      fetch: (...args) => window.fetch(...args),
      makeId: defaultId,
      onState: setSaveState,
    });
    const created: Runtime = {
      session: createSceneSession({ client, getSaveState: () => saveRef.current, makeId: defaultId }),
      retry: () => client.retry(),
      list: () => client.list(),
      get: (revision) => client.get(revision),
    };
    runtimes.current.set(generation, created);
    return created;
  }, [generation]);

  const { session } = runtime;
  useEffect(() => { void session.start(); }, [session]);

  // 外部ストアとして購読し、毎回新しいオブジェクトを返さないよう参照で比較する。
  const project = useSyncExternalStore(session.subscribe, session.current, () => null);
  const loadError = useSyncExternalStore(session.subscribe, session.loadError, () => null);
  const activeMapId = useSyncExternalStore(session.subscribe, session.activeMapId, () => null);
  const canUndo = useSyncExternalStore(session.subscribe, session.canUndo, () => false);
  const canRedo = useSyncExternalStore(session.subscribe, session.canRedo, () => false);

  // 未送信の編集がある間に画面を閉じると失われるため、確認を出す。
  const unsaved = saveState.kind === "pending" || saveState.kind === "error";
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const history = useMemo<SceneHistoryApi>(() => ({
    list: runtime.list, get: runtime.get, apply: session.apply, retry: runtime.retry,
  }), [runtime, session]);

  const reload = useCallback(() => {
    setSaveState({ kind: "saved", revision: 0 });
    setGeneration((value) => value + 1);
  }, []);

  const activeMap = project?.maps.find((map) => map.id === activeMapId) ?? null;

  // The scene is read-only while the Hub runs it.
  const { runState } = useFleetSocket();
  const run = runState?.state;
  const locked = !!run && (isRunActive(run.phase) || run.positioning.active);
  const commit = useCallback<Commit>((edit, label) => locked ? RUN_LOCKED : session.commit(edit, label), [locked, session]);
  const undo = useCallback(() => locked ? RUN_LOCKED : session.undo(), [locked, session]);
  const redo = useCallback(() => locked ? RUN_LOCKED : session.redo(), [locked, session]);

  return {
    project, activeMap, activeMapId, loadError, setActiveMap: session.setActiveMap, commit, locked,
    undo, redo, canUndo, canRedo, saveState, history, reload,
  };
}
