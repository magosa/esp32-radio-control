"use client";

import { useMemo } from "react";
import { compilePlan } from "@/scene/timedPlan";
import type { SceneMap } from "@/scene/types";
import styles from "./scenes.module.css";

// Bottom of the workbench: the result of the last operation and the state of the plan.
export function StatusBar({ notice, map }: { notice: string; map: SceneMap }) {
  const plan = useMemo(() => compilePlan(map), [map]);
  const problems = plan.errors.length + plan.warnings.length;
  return <footer className={styles.statusBar} aria-label="ステータス">
    <p className={styles.grow} role="status">{notice || "準備完了。行を追加し、動作を時間軸へドラッグします。"}</p>
    <p data-part="plan-state">計画 {plan.duration.toFixed(1)}秒 ・ {problems === 0 ? "問題なし" : `警告 ${plan.warnings.length} 件 / エラー ${plan.errors.length} 件`}</p>
  </footer>;
}
