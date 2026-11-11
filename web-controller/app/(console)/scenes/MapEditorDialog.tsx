"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Redo2, Undo2 } from "lucide-react";
import { shortcutAction } from "@/scene/editorShortcuts";
import { createMapEditSession, type MapEditSession } from "@/scene/mapEditSession";
import { statusText } from "@/scene/mapEditStatus";
import type { SceneMap } from "@/scene/types";
import consoleStyles from "../console.module.css";
import { MapEditorCanvas } from "./MapEditorCanvas";
import { TextCommit } from "./MapEditorFields";
import { MapEditorSidebar } from "./MapEditorSidebar";
import { MapEditorTools } from "./MapEditorTools";
import styles from "./mapEditor.module.css";

export interface MapEditorDialogProps {
  map: SceneMap;
  open: boolean;
  // Returns a message when the edit cannot be applied; the dialog then stays open.
  onApply(next: SceneMap): string | null;
  onClose(): void;
}

export function MapEditorDialog(props: MapEditorDialogProps) {
  // A fresh session per opening, so cancelling never leaks edits into the next one.
  return props.open ? <Editor map={props.map} onApply={props.onApply} onClose={props.onClose} /> : null;
}

function Editor({ map, onApply, onClose }: Omit<MapEditorDialogProps, "open">) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [session] = useState<MapEditSession>(() => createMapEditSession(map));
  const version = useSyncExternalStore(session.subscribe, session.version, session.version);
  const [confirming, setConfirming] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  useEffect(() => { setApplyError(null); }, [version]);

  const requestClose = () => {
    if (session.isDirty()) setConfirming(true); else onClose();
  };

  const apply = () => {
    setApplyError(null);
    const result = session.result();
    if (!result.ok) return;
    const failure = onApply(result.map);
    if (failure) setApplyError(failure); else onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    const action = shortcutAction(event.nativeEvent);
    if (!action) return;
    event.preventDefault();
    // The page behind the dialog listens on window for the same keys.
    event.stopPropagation();
    if (action === "undo") session.undo(); else session.redo();
  };

  const error = applyError ?? session.error();
  const draft = session.draft();

  return <dialog ref={dialog} className={styles.dialog} aria-label="マップを編集" data-version={version}
    onKeyDown={onKeyDown}
    onCancel={(event) => {
      event.preventDefault();
      if (confirming) setConfirming(false);
      else if (session.stroke()) session.strokeCancel();
      else requestClose();
    }}>
    <header className={styles.header}>
      <TextCommit label="マップ名" value={draft.name} syncKey={version} onCommit={session.setName} />
      <div className={styles.headerActions}>
        <button type="button" className={consoleStyles.secondary} disabled={!session.canUndo()} onClick={session.undo}>
          <Undo2 aria-hidden="true" />元に戻す
        </button>
        <button type="button" className={consoleStyles.secondary} disabled={!session.canRedo()} onClick={session.redo}>
          <Redo2 aria-hidden="true" />やり直し
        </button>
        <button type="button" className={consoleStyles.secondary} onClick={requestClose}>キャンセル</button>
        <button type="button" className={consoleStyles.primary} onClick={apply}>マップに適用</button>
      </div>
    </header>
    <MapEditorTools session={session} />
    <div className={styles.body}>
      <MapEditorCanvas session={session} />
      <MapEditorSidebar session={session} />
    </div>
    <footer className={styles.footer}>
      <p role="status" className={styles.statusLine}>
        {statusText({ map: draft, selectedRoomId: session.selectedRoomId(), selectedItemId: session.selectedItemId(), stroke: session.stroke() })}
      </p>
      {session.notice() && <p role="status" className={styles.notice}>{session.notice()}</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <p className={styles.hint}>1マス = 20mm、地図は 1100 × 620mm。ドラッグで描き、Ctrl+Z で元に戻します。</p>
    </footer>
    {confirming && <div className={styles.confirm} role="alertdialog" aria-labelledby="me-confirm-title">
      <div className={styles.confirmBox}>
        <h3 id="me-confirm-title">適用していない変更があります</h3>
        <p>破棄して閉じますか?</p>
        <div className={styles.row}>
          <button type="button" className={consoleStyles.primary} autoFocus onClick={() => setConfirming(false)}>編集を続ける</button>
          <button type="button" className={consoleStyles.secondary} onClick={onClose}>破棄して閉じる</button>
        </div>
      </div>
    </div>}
  </dialog>;
}
