"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { SceneHistoryApi } from "@/hooks/useSceneProject";
import { formatTimestamp, restoredLabel, sortNewestFirst } from "@/scene/historyView";
import type { SaveState, SceneHistoryMeta } from "@/scene/historyTypes";
import consoleStyles from "../console.module.css";
import styles from "./dialog.module.css";

export interface HistoryDialogProps {
  open: boolean;
  onClose(): void;
  history: SceneHistoryApi;
  saveState: SaveState;
}

const CONFLICT_TEXT = "他の画面で更新されました。再読込してください";

export function HistoryDialog({ open, onClose, history, saveState }: HistoryDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const openRef = useRef(open);
  const generation = useRef(0);
  const [rows, setRows] = useState<SceneHistoryMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { openRef.current = open; }, [open]);

  const load = useCallback(() => {
    const mine = ++generation.current;
    const current = () => alive.current && openRef.current && generation.current === mine;
    setRows(null);
    setError(null);
    history.list().then(
      (list) => { if (current()) setRows(sortNewestFirst(list)); },
      (cause) => { if (current()) setError(cause instanceof Error ? cause.message : "履歴を取得できません。"); },
    );
  }, [history]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open) {
      if (!element.open) element.showModal();
      setBusy(null);
      load();
    } else {
      generation.current++;
      if (element.open) element.close();
    }
  }, [open, load]);

  const apply = async (revision: number) => {
    setBusy(revision);
    setError(null);
    let failure: string | null;
    try {
      failure = await history.apply(revision);
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : "適用できません。";
    }
    if (!alive.current || !openRef.current) return;
    setBusy(null);
    if (failure) setError(failure); else onClose();
  };

  const conflict = saveState.kind === "conflict";

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="history-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className={styles.head}>
      <h2 id="history-title">編集履歴</h2>
      <button type="button" className={consoleStyles.secondary} onClick={load}>
        <RefreshCw aria-hidden="true" />再読込
      </button>
      <button type="button" className={consoleStyles.secondary} onClick={onClose}>閉じる</button>
    </div>
    {conflict && <p className={styles.warn} role="alert">{CONFLICT_TEXT}</p>}
    {saveState.kind === "error" && <div className={styles.warn} role="alert">
      <span>{saveState.message}</span>
      <button type="button" className={consoleStyles.secondary} onClick={history.retry}>未送信を再試行</button>
    </div>}
    {error && <p className={styles.warn} role="alert">{error}</p>}
    {!rows && !error && <p role="status">読み込み中…</p>}
    {rows && rows.length === 0 && <p role="status">履歴はありません。</p>}
    {rows && rows.length > 0 && <ul className={styles.list}>
      {rows.map((row) => <li key={row.revision} className={styles.row}>
        <span className={styles.rev}>#{row.revision}</span>
        <span className={styles.meta}>
          <span>{formatTimestamp(row.timestamp)}</span>
          <span className={styles.label}>{row.label}</span>
          {row.restoredFrom !== null && <span className={styles.restored}>{restoredLabel(row.restoredFrom)}</span>}
        </span>
        <button type="button" className={consoleStyles.secondary} disabled={conflict || busy !== null}
          aria-label={`リビジョン #${row.revision} のこの状態を適用`} onClick={() => apply(row.revision)}>
          {busy === row.revision ? "適用中…" : "この状態を適用"}
        </button>
      </li>)}
    </ul>}
  </dialog>;
}
