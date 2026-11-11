"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Confirm } from "./editorTypes";
import consoleStyles from "../console.module.css";
import styles from "./confirm.module.css";

interface Pending {
  title: string;
  message: string;
  danger: boolean;
  confirmLabel: string;
  resolve(answer: boolean): void;
}

// One shared confirmation <dialog> for the whole page; call `confirm(...)` and await the answer.
export function useConfirm(): { confirm: Confirm; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const live = useRef<Pending | null>(null);
  live.current = pending;

  const confirm = useCallback<Confirm>((title, message, options) => new Promise<boolean>((resolve) => {
    live.current?.resolve(false);
    setPending({ title, message, danger: options?.danger ?? true, confirmLabel: options?.confirmLabel ?? "削除する", resolve });
  }), []);

  useEffect(() => {
    const element = ref.current;
    if (!element || !pending) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, [pending]);

  const answer = (value: boolean) => {
    const current = live.current;
    setPending(null);
    current?.resolve(value);
  };

  const dialog = pending && <dialog ref={ref} className={styles.dialog} aria-labelledby="confirm-title"
    onCancel={(event) => { event.preventDefault(); answer(false); }}
    onKeyDown={(event) => event.stopPropagation()}>
    <h2 id="confirm-title">{pending.title}</h2>
    <p>{pending.message}</p>
    <div className={styles.row}>
      <button type="button" className={consoleStyles.secondary} autoFocus onClick={() => answer(false)}>キャンセル</button>
      <button type="button" className={pending.danger ? styles.danger : consoleStyles.primary} onClick={() => answer(true)}>{pending.confirmLabel}</button>
    </div>
  </dialog>;

  return { confirm, dialog };
}
