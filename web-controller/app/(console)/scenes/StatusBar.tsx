"use client";

import { saveStateLabel } from "@/scene/editorShortcuts";
import type { SaveState } from "@/scene/historyTypes";
import type { SceneMap } from "@/scene/types";
import styles from "./scenes.module.css";
import { sceneAnalysis } from "./sceneAnalysis";

// Bottom of the workbench (F2): operation notice, plan state, history save state, storage location and active run status.
export function StatusBar({ notice, map, saveState, locked }: { notice: string; map: SceneMap; saveState?: SaveState; locked?: boolean }) {
  const { plan } = sceneAnalysis(map);
  const problems = plan.errors.length + plan.warnings.length;
  const save = saveState ? saveStateLabel(saveState) : null;
  return <footer className={styles.statusBar} aria-label="ステータス">
    <p className={styles.grow} role="status">{notice || "準備完了。行を追加し、動作を時間軸へドラッグします。"}</p>
    {locked && <p data-part="run-lock">シーン実行中（編集ロック）</p>}
    <p data-part="plan-state">計画 {plan.duration.toFixed(1)}秒 ・ {problems === 0 ? "問題なし" : `警告 ${plan.warnings.length} 件 / エラー ${plan.errors.length} 件`}</p>
    {save && <p data-part="history-state">履歴: {save.text} ・ 保存先: data/scene-history</p>}
  </footer>;
}
