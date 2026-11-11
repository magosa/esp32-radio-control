"use client";

import type { Commit } from "@/scene/sceneSession";
import type { SceneProject } from "@/scene/types";
import styles from "./scenes.module.css";

export interface MapTabsProps {
  project: SceneProject;
  activeMapId: string;
  onSelect(id: string): void;
  commit: Commit;
}

// Task 6 で追加・名前変更・削除・配置コピーを実装する。props は変更しないこと。
export function MapTabs({ project, activeMapId, onSelect }: MapTabsProps) {
  return <div className={styles.tabs} role="tablist" aria-label="マップ">
    {project.maps.map((map) => <button key={map.id} type="button" role="tab" className={styles.tab}
      aria-selected={map.id === activeMapId} onClick={() => onSelect(map.id)}>{map.name}</button>)}
  </div>;
}
