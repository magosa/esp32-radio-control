"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { Download, Upload } from "lucide-react";
import { MAX_FILE_BYTES, TOO_LARGE_MESSAGE, fileNameFor, parseSceneFile, replaceProject } from "@/scene/sceneFile";
import { projectForSave } from "@/scene/model";
import type { Commit } from "@/scene/sceneSession";
import type { SceneProject } from "@/scene/types";
import consoleStyles from "../console.module.css";
import styles from "./dialog.module.css";

export interface FileActionsProps {
  project: SceneProject;
  commit: Commit;
}

export function FileActions({ project, commit }: FileActionsProps) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
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
