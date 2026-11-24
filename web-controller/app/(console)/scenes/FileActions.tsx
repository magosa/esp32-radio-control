"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Download, FilePlus2, Upload } from "lucide-react";
import { MapBody } from "@/components/mapLayers";
import { VIEW_BOX } from "@/scene/mapView";
import { MAX_MAPS } from "@/scene/mapTabsLogic";
import { MAX_FILE_BYTES, TOO_LARGE_MESSAGE, appendSceneMaps, fileNameFor, parseSceneFile, replaceProject } from "@/scene/sceneFile";
import { createProject, projectForSave } from "@/scene/model";
import type { Commit } from "@/scene/sceneSession";
import type { SceneProject } from "@/scene/types";
import consoleStyles from "../console.module.css";
import type { Confirm } from "./editorTypes";
import styles from "./dialog.module.css";
import mapStyles from "./mapTabs.module.css";

export interface FileActionsProps {
  project: SceneProject;
  commit: Commit;
  confirm?: Confirm;
  saveSignal?: number;
}

export function FileActions({ project, commit, confirm, saveSignal = 0 }: FileActionsProps) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [importProject, setImportProject] = useState<SceneProject | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const lastSignal = useRef(saveSignal);

  useEffect(() => {
    if (importProject && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [importProject]);

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
    setError(null);
    setSelected([]);
    setImportError(null);
    setImportProject(parsed.project);
  };

  const closeImport = () => {
    dialog.current?.close();
    setImportProject(null);
  };

  const addMaps = () => {
    if (!importProject) return;
    const maps = importProject.maps.filter((map) => selected.includes(map.id));
    const failure = commit((draft) => appendSceneMaps(draft, maps), "JSONからマップを追加");
    if (failure) { setImportError(failure); return; }
    closeImport();
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
    {importProject && <dialog ref={dialog} className={`${mapStyles.dialog} ${mapStyles.wideDialog}`}
      aria-labelledby="import-maps-title" onCancel={(event) => { event.preventDefault(); closeImport(); }}>
      <h2 id="import-maps-title">JSONからマップを追加</h2>
      <p>追加するマップを選択してください。シーケンスも一緒に追加され、既存のマップは変更されません。</p>
      <p>マップは最大{MAX_MAPS}枚です（現在 {project.maps.length}枚、選択中 {selected.length}枚）。同名のマップも別のマップとして追加します。</p>
      <fieldset className={mapStyles.choices}>
        <legend>追加するマップ</legend>
        {importProject.maps.map((map) => <label key={map.id} className={mapStyles.choice} data-selected={selected.includes(map.id)}>
          <input type="checkbox" checked={selected.includes(map.id)} onChange={(event) => {
            const checked = event.target.checked;
            setSelected((previous) => checked ? [...previous, map.id] : previous.filter((id) => id !== map.id));
            setImportError(null);
          }} />
          <svg className={mapStyles.thumbnail} viewBox={VIEW_BOX} aria-hidden="true" data-map-preview={map.id}>
            <MapBody map={{ ...map, presentation: undefined }} scene={{ actors: [], displays: [], events: [], doors: [] }}
              time={0} scale={0.25} showPaths={false} showRoomLabels />
          </svg>
          <span>{map.name}<br /><small>行 {map.tracks.length}件・動作 {map.tracks.reduce((count, track) => count + track.actions.length, 0)}件</small></span>
        </label>)}
      </fieldset>
      {selected.length + project.maps.length > MAX_MAPS && <p className={mapStyles.error} role="alert">追加後のマップ数が上限を超えます。選択を減らしてください。</p>}
      {importError && <p className={mapStyles.error} role="alert">{importError}</p>}
      <div className={mapStyles.actions}>
        <button type="button" className={consoleStyles.secondary} onClick={closeImport}>キャンセル</button>
        <button type="button" className={consoleStyles.primary} onClick={addMaps}
          disabled={selected.length === 0 || selected.length + project.maps.length > MAX_MAPS}>選択したマップを追加</button>
      </div>
    </dialog>}
  </>;
}
