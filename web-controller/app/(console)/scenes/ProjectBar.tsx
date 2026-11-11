"use client";

import { useEffect, useRef, useState } from "react";
import { History, Redo2, TriangleAlert, Undo2 } from "lucide-react";
import type { SceneProjectApi } from "@/hooks/useSceneProject";
import { saveStateLabel, shortcutAction } from "@/scene/editorShortcuts";
import consoleStyles from "../console.module.css";
import { FileActions } from "./FileActions";
import { HistoryDialog } from "./HistoryDialog";
import styles from "./scenes.module.css";

type Props = Pick<SceneProjectApi, "project" | "commit" | "undo" | "redo" | "canUndo" | "canRedo" | "saveState" | "history" | "reload">;

export function ProjectBar({ project, commit, undo, redo, canUndo, canRedo, saveState, history, reload }: Props) {
  const [draft, setDraft] = useState(project?.name ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const editing = useRef(false);

  useEffect(() => { if (!editing.current) setDraft(project?.name ?? ""); }, [project?.name]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = shortcutAction(event);
      if (!action) return;
      event.preventDefault();
      setMessage((action === "undo" ? undo : redo)());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const finish = () => {
    editing.current = false;
    const name = draft.trim();
    if (!project || name === project.name) { setDraft(project?.name ?? ""); return; }
    const error = name ? commit((d) => { d.name = name; }, "プロジェクト名の変更") : "プロジェクト名を入力してください。";
    setMessage(error);
    if (error) setDraft(project.name);
  };

  const state = saveStateLabel(saveState);
  const failed = saveState.kind === "error";
  const conflict = saveState.kind === "conflict";

  return <section className={`${consoleStyles.preferenceCard} ${styles.projectBar}`} aria-label="プロジェクト">
    <label className={styles.nameField}>
      <span>プロジェクト名</span>
      <input value={draft} maxLength={80} disabled={!project}
        onFocus={() => { editing.current = true; }}
        onChange={(event) => setDraft(event.target.value)} onBlur={finish}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") { setDraft(project?.name ?? ""); editing.current = false; event.currentTarget.blur(); }
        }} />
    </label>
    <div className={styles.barActions}>
      <button type="button" className={consoleStyles.secondary} disabled={!canUndo} onClick={() => setMessage(undo())}>
        <Undo2 aria-hidden="true" />元に戻す
      </button>
      <button type="button" className={consoleStyles.secondary} disabled={!canRedo} onClick={() => setMessage(redo())}>
        <Redo2 aria-hidden="true" />やり直し
      </button>
      <button type="button" className={consoleStyles.secondary} disabled={!project} onClick={() => setHistoryOpen(true)}>
        <History aria-hidden="true" />編集履歴
      </button>
      {project && <FileActions project={project} commit={commit} />}
    </div>
    <div className={styles.saveArea}>
      <span className={styles.saveState} data-tone={state.tone} role="status">
        {state.tone === "warn" && <TriangleAlert aria-hidden="true" />}{state.text}
      </span>
      {failed && <button type="button" className={consoleStyles.secondary} onClick={history.retry}>未送信を再試行</button>}
      {conflict && <button type="button" className={consoleStyles.primary} onClick={reload}>再読込</button>}
    </div>
    {message && <p className={styles.barMessage} role="alert">{message}</p>}
    <HistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} history={history} saveState={saveState} />
  </section>;
}
