"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { shortcutAction } from "@/scene/editorShortcuts";
import consoleStyles from "../console.module.css";
import styles from "./editors.module.css";

interface EditorShellProps {
  label: string;
  title: string;
  dirty: boolean;
  onApply?: () => void;
  applyDisabled?: boolean;
  error?: string | null;
  hint?: string;
  onClose(): void;
  children: ReactNode;
}

export function EditorShell({ label, title, dirty, onApply, applyDisabled, error, hint, onClose, children }: EditorShellProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const confirmTitle = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  const requestClose = () => { if (dirty) setConfirming(true); else onClose(); };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    // The page behind the dialog listens on window for undo and redo.
    if (shortcutAction(event.nativeEvent)) event.stopPropagation();
  };

  return <dialog ref={dialog} className={styles.dialog} aria-label={label} onKeyDown={onKeyDown}
    onCancel={(event) => {
      event.preventDefault();
      if (confirming) setConfirming(false); else requestClose();
    }}>
    <header className={styles.header}>
      <h2 className={styles.title}>{title}</h2>
      <div className={styles.actions}>
        <button type="button" className={consoleStyles.secondary} onClick={requestClose}>キャンセル</button>
        {onApply && <button type="button" className={consoleStyles.primary} disabled={applyDisabled} onClick={onApply}>適用</button>}
      </div>
    </header>
    <div className={styles.body}>{children}</div>
    <footer className={styles.footer}>
      {hint && <p className={styles.hint}>{hint}</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </footer>
    {confirming && <div className={styles.confirm} role="alertdialog" aria-labelledby={confirmTitle}>
      <div className={styles.confirmBox}>
        <h3 id={confirmTitle}>適用していない変更があります</h3>
        <p>破棄して閉じますか?</p>
        <div className={styles.actions}>
          <button type="button" className={consoleStyles.primary} autoFocus onClick={() => setConfirming(false)}>編集を続ける</button>
          <button type="button" className={consoleStyles.secondary} onClick={onClose}>破棄して閉じる</button>
        </div>
      </div>
    </div>}
  </dialog>;
}
