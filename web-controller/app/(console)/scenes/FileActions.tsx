"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Download, FilePlus2, Upload } from "lucide-react";
import { MAX_FILE_BYTES, TOO_LARGE_MESSAGE, fileNameFor, parseSceneFile, replaceProject } from "@/scene/sceneFile";
import { createProject, projectForSave } from "@/scene/model";
import type { Commit } from "@/scene/sceneSession";
import type { SceneProject } from "@/scene/types";
import consoleStyles from "../console.module.css";
import type { Confirm } from "./editorTypes";
import styles from "./dialog.module.css";

export interface FileActionsProps {
  project: SceneProject;
  commit: Commit;
  confirm?: Confirm;
  saveSignal?: number;
}

export function FileActions({ project, commit, confirm, saveSignal = 0 }: FileActionsProps) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSignal = useRef(saveSignal);

  const save = useCallback(() => {
    try {
      const blob = new Blob([JSON.stringify(projectForSave(project), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileNameFor(project.name);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (cause) {
      setError(`保存できません: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [project]);

  useEffect(() => {
    if (saveSignal !== lastSignal.current) {
      lastSignal.current = saveSignal;
      save();
    }
  }, [saveSignal, save]);

  const resetProject = async () => {
    if (confirm) {
      const ok = await confirm("新規プロジェクト", "現在のプロジェクトを空の新規プロジェクトで置き換えます。元に戻せます。", {
        danger: true,
        confirmLabel: "新規作成",
      });
      if (!ok) return;
    }
    setError(commit((draft) => replaceProject(draft, createProject("新規プロジェクト")), "新規プロジェクト"));
  };

  const open = async (event: ChangeEvent<HTMLInputElement>) => {
    const target = event.currentTarget;
    const file = target.files?.[0];
    target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setError(TOO_LARGE_MESSAGE); return; }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError("ファイルを読み込めません。");
      return;
    }
    const parsed = parseSceneFile(text);
    if (!parsed.ok) { setError(parsed.error); return; }
    setError(commit((draft) => replaceProject(draft, parsed.project), "JSON読込"));
  };

  return <>
    <button type="button" className={consoleStyles.secondary} onClick={() => { void resetProject(); }}>
      <FilePlus2 aria-hidden="true" />新規
    </button>
    <button type="button" className={consoleStyles.secondary} onClick={save}>
      <Download aria-hidden="true" />JSON保存
    </button>
    <button type="button" className={consoleStyles.secondary} onClick={() => input.current?.click()}>
      <Upload aria-hidden="true" />JSON読込
    </button>
    <input ref={input} type="file" accept=".json,application/json" hidden onChange={open} />
    {error && <p className={styles.fileError} role="alert">{error}</p>}
  </>;
}
