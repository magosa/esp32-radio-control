"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { copyMapLayout, createProject } from "@/scene/model";
import { MAX_MAPS, afterDelete, canAddMap, canDeleteMap, neighbourTab, nextMapName, validateMapName } from "@/scene/mapTabsLogic";
import type { Commit } from "@/scene/sceneSession";
import type { SceneMap, SceneProject } from "@/scene/types";
import consoleStyles from "../console.module.css";
import styles from "./mapTabs.module.css";

export interface MapTabsProps {
  project: SceneProject;
  activeMapId: string;
  onSelect(id: string): void;
  commit: Commit;
}

type DialogState = { kind: "add" } | { kind: "delete"; id: string } | null;

function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return <dialog ref={ref} className={styles.dialog} aria-labelledby="map-dialog-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2 id="map-dialog-title">{title}</h2>
    {children}
  </dialog>;
}

export function MapTabs({ project, activeMapId, onSelect, commit }: MapTabsProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [source, setSource] = useState("new");
  const [addName, setAddName] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const finished = useRef(false);
  const opener = useRef<HTMLElement | null>(null);

  const maps = project.maps;
  const ids = maps.map((map) => map.id);
  const addable = canAddMap(maps.length);
  const deletable = canDeleteMap(maps.length);

  const focusTab = (id: string) => requestAnimationFrame(() => tabRefs.current.get(id)?.focus());

  const startRename = (map: SceneMap) => {
    finished.current = false;
    setMessage(null);
    setDraftName(map.name);
    setEditingId(map.id);
  };

  const finishRename = (map: SceneMap, save: boolean, fromBlur = false) => {
    if (finished.current) return;
    if (!save) { finished.current = true; setEditingId(null); setMessage(null); focusTab(map.id); return; }
    const checked = validateMapName(draftName, map.name);
    if (!checked.ok) {
      setMessage(checked.error);
      if (fromBlur) { finished.current = true; setEditingId(null); }
      return;
    }
    finished.current = true;
    setEditingId(null);
    if (checked.name === map.name) { setMessage(null); focusTab(map.id); return; }
    const error = commit((draft) => {
      const target = draft.maps.find((item) => item.id === map.id);
      if (target) target.name = checked.name;
    }, "マップ名の変更");
    setMessage(error);
    if (!fromBlur) focusTab(map.id);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, map: SceneMap) => {
    if (event.key === "F2") { event.preventDefault(); startRename(map); return; }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = neighbourTab(ids, activeMapId, event.key);
    onSelect(next);
    focusTab(next);
  };

  const openDialog = (state: Exclude<DialogState, null>) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialogError(null);
    setMessage(null);
    if (state.kind === "add") {
      setSource("new");
      setAddName(nextMapName(maps.map((map) => map.name)));
    }
    setDialog(state);
  };

  const closeDialog = () => {
    setDialog(null);
    const back = opener.current;
    requestAnimationFrame(() => {
      if (back?.isConnected) back.focus();
      else tabRefs.current.get(activeMapId)?.focus();
    });
  };

  const applyAdd = () => {
    const checked = validateMapName(addName);
    if (!checked.ok) { setDialogError(checked.error); return; }
    if (!canAddMap(maps.length)) { setDialogError(`マップは最大${MAX_MAPS}枚です`); return; }
    let created: SceneMap;
    if (source === "new") {
      created = { ...createProject("x").maps[0], name: checked.name };
    } else {
      const from = maps.find((map) => map.id === source);
      if (!from) { setDialogError("コピー元のマップが見つかりません。"); return; }
      created = copyMapLayout(from, checked.name);
    }
    const error = commit((draft) => { draft.maps.push(created); }, "マップの追加");
    if (error) { setDialogError(error); return; }
    setDialog(null);
    onSelect(created.id);
    focusTab(created.id);
  };

  const applyDelete = (id: string) => {
    if (!canDeleteMap(maps.length)) { setDialogError("最後のマップは削除できません。"); return; }
    const next = afterDelete(ids, id, activeMapId);
    const error = commit((draft) => { draft.maps = draft.maps.filter((map) => map.id !== id); }, "マップの削除");
    if (error) { setDialogError(error); return; }
    setDialog(null);
    if (next) { onSelect(next); focusTab(next); }
    else focusTab(activeMapId);
  };

  const deleting = dialog?.kind === "delete" ? maps.find((map) => map.id === dialog.id) : undefined;

  return <div className={styles.wrap}>
    <div className={styles.tabs} role="tablist" aria-label="マップ">
      {maps.map((map) => {
        const active = map.id === activeMapId;
        return <div key={map.id} role="presentation" className={`${styles.group} ${active ? styles.selected : ""}`}>
          {editingId === map.id
            ? <input className={styles.renameInput} value={draftName} maxLength={120} autoFocus aria-label="マップ名"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={() => finishRename(map, true, true)}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); finishRename(map, true); }
                else if (event.key === "Escape") { event.preventDefault(); finishRename(map, false); }
              }} />
            : <button type="button" role="tab" className={styles.tab} aria-selected={active} tabIndex={active ? 0 : -1}
              title={map.name}
              ref={(node) => { if (node) tabRefs.current.set(map.id, node); else tabRefs.current.delete(map.id); }}
              onClick={() => onSelect(map.id)} onDoubleClick={() => startRename(map)}
              onKeyDown={(event) => onTabKeyDown(event, map)}>{map.name}</button>}
          <button type="button" className={styles.iconButton} aria-label={`マップ「${map.name}」の名前を変更`}
            onMouseDown={(event) => event.preventDefault()} onClick={() => startRename(map)}>名前変更</button>
          <button type="button" className={styles.iconButton} aria-label={`マップ「${map.name}」を削除`}
            disabled={!deletable} title={deletable ? undefined : "最後のマップは削除できません"}
            onClick={() => openDialog({ kind: "delete", id: map.id })}>削除</button>
        </div>;
      })}
      <button type="button" className={`${consoleStyles.secondary} ${styles.add}`} disabled={!addable}
        onClick={() => openDialog({ kind: "add" })}>マップを追加</button>
      {!addable && <span className={styles.limit}>マップは最大{MAX_MAPS}枚です</span>}
    </div>
    {message && <p className={styles.error} role="alert">{message}</p>}
    {dialog?.kind === "add" && <Modal title="マップを追加" onClose={closeDialog}>
      <form onSubmit={(event) => { event.preventDefault(); applyAdd(); }}>
        <fieldset className={styles.choices}>
          <legend>作り方</legend>
          <label className={styles.choice}>
            <input type="radio" name="map-source" checked={source === "new"} onChange={() => setSource("new")} />
            <span>新しくマップを描く</span>
          </label>
          {maps.map((map) => <label key={map.id} className={styles.choice}>
            <input type="radio" name="map-source" checked={source === map.id} onChange={() => setSource(map.id)} />
            <span>「{map.name}」の配置をコピー</span>
          </label>)}
        </fieldset>
        <label className={styles.field}>
          <span>マップ名</span>
          <input type="text" value={addName} onChange={(event) => setAddName(event.target.value)} />
        </label>
        {dialogError && <p className={styles.error} role="alert">{dialogError}</p>}
        <div className={styles.actions}>
          <button type="button" className={consoleStyles.secondary} onClick={closeDialog}>キャンセル</button>
          <button type="submit" className={consoleStyles.primary}>追加</button>
        </div>
      </form>
    </Modal>}
    {dialog?.kind === "delete" && <Modal title="マップの削除" onClose={closeDialog}>
      {deleting
        ? <>
          <p>マップ「{deleting.name}」を削除します。このマップの部屋・家具・タイムラインも削除されます。</p>
          {dialogError && <p className={styles.error} role="alert">{dialogError}</p>}
          <div className={styles.actions}>
            <button type="button" className={consoleStyles.secondary} onClick={closeDialog}>キャンセル</button>
            <button type="button" className={consoleStyles.primary} onClick={() => applyDelete(deleting.id)}>削除する</button>
          </div>
        </>
        : <>
          <p>対象のマップが見つかりません。</p>
          <div className={styles.actions}><button type="button" className={consoleStyles.secondary} onClick={closeDialog}>閉じる</button></div>
        </>}
    </Modal>}
  </div>;
}
