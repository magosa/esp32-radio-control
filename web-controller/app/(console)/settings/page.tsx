"use client";

import { useState } from "react";
import { Check, Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import { DEFAULT_FLEET_APPEARANCE, FLEET_PALETTES, useFleetAppearance, type FleetAppearance } from "@/hooks/useFleetAppearance";
import styles from "../console.module.css";

const THEMES = [
  { id: "light", label: "ライト", Icon: Sun },
  { id: "dark", label: "ダーク", Icon: Moon },
  { id: "system", label: "OS連動", Icon: Monitor },
] as const;

export default function SettingsPage() {
  const { appearance, updateAppearance } = useFleetAppearance();
  const [feedback, setFeedback] = useState("");
  const update = (patch: Partial<FleetAppearance>) => {
    setFeedback(updateAppearance(patch) ? "保存しました" : "適用しました（ブラウザーへの保存ができません）");
  };

  return <div className={styles.preferences}>
      <section className={styles.preferenceCard} aria-labelledby="theme-heading">
        <h2 id="theme-heading">テーマ</h2>
        <div className={styles.segmented} role="group" aria-label="テーマ">
          {THEMES.map(({ id, label, Icon }) => <button key={id} aria-pressed={appearance.theme === id} onClick={() => update({ theme: id })}>
            <Icon aria-hidden="true" />{label}
          </button>)}
        </div>
      </section>
      <section className={styles.preferenceCard} aria-labelledby="palette-heading">
        <h2 id="palette-heading">ベースカラー</h2>
        <div className={styles.paletteOptions} role="group" aria-label="ベースカラー">
          {FLEET_PALETTES.map((palette) => <button key={palette.id} className={styles.paletteOption} aria-pressed={appearance.palette === palette.id}
            onClick={() => update({ palette: palette.id })}>
            <span className={styles.swatch} style={{ backgroundColor: palette.primary }}>{appearance.palette === palette.id && <Check aria-hidden="true" />}</span>
            <span>{palette.label}</span><small>{palette.primary}</small>
          </button>)}
        </div>
      </section>
      <section className={styles.preferenceCard} aria-labelledby="motion-heading">
        <div className={styles.preferenceRow}>
          <h2 id="motion-heading">アニメーション</h2>
          <label className={styles.motionToggle}><input type="checkbox" role="switch" checked={appearance.motion} aria-label="アニメーション"
            onChange={(event) => update({ motion: event.target.checked })} /><span aria-hidden="true" /></label>
        </div>
      </section>
      <div className={styles.preferenceFooter}>
        <p role="status" aria-live="polite">{feedback}</p>
        <button className={styles.secondary} onClick={() => update(DEFAULT_FLEET_APPEARANCE)}><RotateCcw aria-hidden="true" />初期設定に戻す</button>
      </div>
    </div>;
}