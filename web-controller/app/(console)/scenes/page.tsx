"use client";

import { useEffect, useMemo, useState } from "react";
import { compilePlan } from "@/scene/timedPlan";
import { useSceneProject } from "@/hooks/useSceneProject";
import consoleStyles from "../console.module.css";
import { MapEditorDialog } from "./MapEditorDialog";
import { MapStage } from "./MapStage";
import { MapTabs } from "./MapTabs";
import { ProjectBar } from "./ProjectBar";
import styles from "./scenes.module.css";

const MIN_WIDTH_PX = 768;

function useWideEnough(): boolean | null {
  const [wide, setWide] = useState<boolean | null>(null);
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${MIN_WIDTH_PX}px)`);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

export default function ScenesPage() {
  const wide = useWideEnough();
  const scene = useSceneProject();
  const { project, activeMap, activeMapId } = scene;
  const [time, setTime] = useState(0);
  const [showGrid, setShowGrid] = useState(true);
  const [editing, setEditing] = useState(false);
  const duration = useMemo(() => (activeMap ? compilePlan(activeMap).duration : 0), [activeMap]);

  useEffect(() => { setTime((value) => Math.min(value, duration)); }, [duration]);

  if (wide === null) return <p className={styles.state} role="status">読み込み中…</p>;
  if (!wide) {
    return <section className={`${consoleStyles.preferenceCard} ${styles.narrow}`} role="status">
      <h2>幅{MIN_WIDTH_PX}px以上の画面で開いてください</h2>
      <p>シーンエディターは、マップと時間軸を同時に表示するため、タブレット以上の幅が必要です。</p>
    </section>;
  }
  if (scene.loadError) {
    return <section className={`${consoleStyles.preferenceCard} ${styles.narrow}`} role="alert">
      <h2>シーンを読み込めませんでした</h2>
      <p>{scene.loadError}</p>
      <button type="button" className={consoleStyles.primary} onClick={scene.reload}>再読込</button>
    </section>;
  }
  if (!project || !activeMap || !activeMapId) return <p className={styles.state} role="status">読み込み中…</p>;

  return <div className={styles.page}>
    <ProjectBar project={project} commit={scene.commit} undo={scene.undo} redo={scene.redo} canUndo={scene.canUndo}
      canRedo={scene.canRedo} saveState={scene.saveState} history={scene.history} reload={scene.reload} />
    <MapTabs project={project} activeMapId={activeMapId} onSelect={scene.setActiveMap} commit={scene.commit} />
    <div className={styles.workspace}>
      <section className={`${consoleStyles.preferenceCard} ${styles.stageCard}`} aria-label="マップ">
        <MapStage map={activeMap} time={time} showGrid={showGrid} gridMm={activeMap.editGridMm} />
        <div className={styles.stageControls}>
          <label className={styles.timeField}>
            <span>時刻 {time.toFixed(1)} / {duration.toFixed(1)} 秒</span>
            <input type="range" min={0} max={duration} step={0.1} value={time} disabled={duration === 0}
              onChange={(event) => setTime(Number(event.target.value))} />
          </label>
          <label className={styles.gridToggle}>
            <input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} />
            グリッド {activeMap.editGridMm}mm
          </label>
          <button type="button" className={consoleStyles.secondary} onClick={() => setEditing(true)}>マップを編集</button>
        </div>
      </section>
      <aside className={`${consoleStyles.preferenceCard} ${styles.sideCard}`} aria-label="設定">
        <h2>設定</h2>
        <p>動作と行為者の編集は、時間軸の実装（S2c）で追加します。</p>
      </aside>
    </div>
    <section className={`${consoleStyles.preferenceCard} ${styles.timelineCard}`} aria-label="時間軸">
      <h2>時間軸</h2>
      <p>バーの編集は、S2c で追加します。</p>
    </section>
    <MapEditorDialog map={activeMap} open={editing} onClose={() => setEditing(false)}
      onApply={(next) => scene.commit((draft) => {
        const index = draft.maps.findIndex((item) => item.id === next.id);
        if (index < 0) throw new Error("編集中のマップが見つかりません。");
        draft.maps[index] = next;
      }, "マップの編集")} />
  </div>;
}
