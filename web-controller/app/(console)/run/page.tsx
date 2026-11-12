"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { SceneRunPanel } from "./SceneRunPanel";
import { SimpleRoutes } from "./SimpleRoutes";
import styles from "../console.module.css";

const TABS = [
  { id: "scene", label: "シーン実行" },
  { id: "routes", label: "簡易ルート" },
] as const;

export default function RunPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("scene");
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = (next + TABS.length) % TABS.length;
    setTab(TABS[target].id);
    buttons.current[target]?.focus();
  };

  return <>
    <div className={styles.segmented} role="tablist" aria-label="実行の種類">
      {TABS.map((item, index) => <button key={item.id} ref={(el) => { buttons.current[index] = el; }} role="tab" id={`run-tab-${item.id}`}
        aria-selected={tab === item.id} aria-controls={`run-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
        onClick={() => setTab(item.id)} onKeyDown={(event) => onKeyDown(event, index)}>{item.label}</button>)}
    </div>
    <div role="tabpanel" id={`run-panel-${tab}`} aria-labelledby={`run-tab-${tab}`}>
      {tab === "scene" ? <SceneRunPanel /> : <SimpleRoutes />}
    </div>
  </>;
}
