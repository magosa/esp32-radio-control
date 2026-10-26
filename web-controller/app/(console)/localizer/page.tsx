"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Square, TriangleAlert, Download, Circle, RefreshCw } from "lucide-react";
import { useFleetSocket } from "@/hooks/useFleetSocket";
import { useLocalizerRuntime } from "@/hooks/useLocalizerRuntime";
import type { FieldConfig } from "@/fleet/protocol";
import styles from "../console.module.css";

const FIELD_INPUTS: { key: keyof FieldConfig; label: string }[] = [
  { key: "cameraHeightMm", label: "カメラ高さ (mm)" },
  { key: "widthMm", label: "領域幅 (mm)" },
  { key: "heightMm", label: "領域高さ (mm)" },
  { key: "referenceSizeMm", label: "基準黒部 (mm)" },
];

function FieldForm({ field, saving, error, done, disabled, onSave }: {
  field: FieldConfig; saving: boolean; error?: string; done?: boolean; disabled: boolean; onSave: (config: FieldConfig) => void;
}) {
  const serialized = JSON.stringify(field);
  const [draft, setDraft] = useState<Record<keyof FieldConfig, string>>(() => toDraft(field));
  const [synced, setSynced] = useState(serialized);
  if (synced !== serialized) {
    setSynced(serialized);
    setDraft(toDraft(field));
  }
  const parsed = Object.fromEntries(FIELD_INPUTS.map(({ key }) => [key, Number(draft[key])])) as unknown as FieldConfig;
  const valid = FIELD_INPUTS.every(({ key }) => draft[key].trim() !== "" && Number.isFinite(parsed[key]) && parsed[key] > 0);
  return <form className={styles.fieldForm} onSubmit={(event) => { event.preventDefault(); if (valid) onSave(parsed); }}>
    {FIELD_INPUTS.map(({ key, label }) => <label key={key}>{label}
      <input type="number" inputMode="decimal" step="any" min="0" value={draft[key]} disabled={disabled}
        onChange={(event) => setDraft((previous) => ({ ...previous, [key]: event.target.value }))} />
    </label>)}
    <button className={styles.primary} type="submit" disabled={disabled || saving || !valid}>設定を保存</button>
    {(saving || error || done) && <p className={styles.assignmentStatus} role={error ? "alert" : "status"}>
      {saving ? "保存中…" : error || "保存しました"}
    </p>}
  </form>;
}

function toDraft(field: FieldConfig): Record<keyof FieldConfig, string> {
  return { cameraHeightMm: String(field.cameraHeightMm), widthMm: String(field.widthMm),
    heightMm: String(field.heightMm), referenceSizeMm: String(field.referenceSizeMm) };
}

export default function LocalizerPage() {
  const { status, robots, poseState, fieldSave, saveFieldConfig } = useFleetSocket();
  const runtime = useLocalizerRuntime();
  const container = useRef<HTMLDivElement>(null);
  const connected = status === "connected";
  const running = runtime.status === "running";
  const { summary } = runtime;
  const localizer = poseState?.localizer;

  useEffect(() => {
    const canvas = runtime.getCanvas();
    const host = container.current;
    host?.append(canvas);
    return () => { if (canvas.parentElement === host) canvas.remove(); };
  }, [runtime]);

  const robotName = (markerId: number) => robots.find((robot) => robot.markerId === markerId)?.name ?? "—";

  return <div className={styles.localizerPage}>
    {!runtime.isLocalHost && <div className={styles.notice} role="status"><TriangleAlert aria-hidden="true" />
      <span>測位はHub実行PCのlocalhostで開いたページからのみ開始できます（カメラのセキュリティ制約とHubの接続制限）。</span></div>}
    {runtime.warning && <div className={styles.notice} role="status"><TriangleAlert aria-hidden="true" /><span>{runtime.warning}</span></div>}
    <section className={styles.fieldCard} aria-label="測位の操作">
      <div className={styles.sectionHeading}><h2>俯瞰カメラ</h2><span>{running ? "測位中" : runtime.status === "loading" ? "準備中" : "停止中"}</span></div>
      <div className={styles.localizerControls}>
        <label>カメラ
          <select aria-label="カメラ" value={runtime.selectedCamera} disabled={running || runtime.status === "loading"}
            onChange={(event) => runtime.setSelectedCamera(event.target.value)}>
            <option value="">既定のカメラ</option>
            {runtime.cameras.map((camera) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>)}
          </select>
        </label>
        <button className={styles.secondary} disabled={running} onClick={() => void runtime.refreshCameras()}><RefreshCw aria-hidden="true" />一覧更新</button>
        {running
          ? <button className={styles.secondary} onClick={runtime.stop}><Square aria-hidden="true" />停止</button>
          : <button className={styles.primary} disabled={!runtime.isLocalHost || !connected || runtime.status === "loading"} onClick={() => void runtime.start()}>
            <Play aria-hidden="true" />開始</button>}
        <button className={styles.secondary} disabled={!running} aria-pressed={runtime.recording} onClick={runtime.toggleRecording}>
          <Circle aria-hidden="true" />{runtime.recording ? "CSV記録停止" : "CSV記録開始"}</button>
        <button className={styles.secondary} disabled={!runtime.recordedRows} onClick={() => runtime.downloadCsv()}>
          <Download aria-hidden="true" />CSV保存{runtime.recordedRows ? ` (${runtime.recordedRows}行)` : ""}</button>
      </div>
      <p className={styles.localizerStatus} role="status" data-state={runtime.status}>{runtime.message}</p>
      {summary && <dl className={styles.localizerStats}>
        <div><dt>解像度</dt><dd>{summary.width}×{summary.height}</dd></div>
        <div><dt>基準</dt><dd>{summary.referenceCount}/4{[40, 41, 42, 43].some((id) => !summary.referenceIds.includes(id))
          && <span className={styles.missingRef}> 未検出: {[40, 41, 42, 43].filter((id) => !summary.referenceIds.includes(id)).join(", ")}</span>}</dd></div>
        <div><dt>検出ID</dt><dd>{summary.detectedIds.join(", ") || "なし"}</dd></div>
        <div><dt>処理</dt><dd>{summary.processingMs.toFixed(0)} ms</dd></div>
        <div><dt>周期(Hub)</dt><dd>{localizer?.fps ? `${localizer.fps.toFixed(1)} fps` : "—"}</dd></div>
        <div><dt>遅延(Hub)</dt><dd>{localizer?.latencyMs != null ? `${localizer.latencyMs.toFixed(0)} ms` : "—"}</dd></div>
      </dl>}
      {summary && !summary.complete && <p className={styles.cameraWarning} role="status"><TriangleAlert aria-hidden="true" />
        {summary.extrinsicsOk ? "基準が3枚のみです。暫定推定のため精度が低下します。" : "基準マーカーが不足しています。座標は無効です。"}</p>}
    </section>
    <section className={styles.fieldCard} aria-label="カメラ映像">
      <div ref={container} className={styles.localizerPreview} />
      {!running && <p className={styles.empty}>測位を開始すると映像と検出結果が表示されます。</p>}
    </section>
    <section className={styles.fieldCard} aria-label="検出結果">
      <table className={styles.poseTable}>
        <thead><tr><th>ID</th><th>ロボット</th><th>状態</th><th>X</th><th>Y</th><th>yaw °</th></tr></thead>
        <tbody>
          {summary?.robots.map((robot) => <tr key={robot.id}>
            <td>{robot.id}</td><td>{robotName(robot.id)}</td>
            <td>{robot.valid ? (robot.inside_field ? "検出" : "領域外") : "未検出"}</td>
            <td>{robot.valid ? robot.x.toFixed(1) : "—"}</td><td>{robot.valid ? robot.y.toFixed(1) : "—"}</td>
            <td>{robot.valid ? robot.yaw_deg.toFixed(1) : "—"}</td>
          </tr>)}
        </tbody>
      </table>
      <p className={styles.muted}>X/Yは領域左下(0,0)・右上(1600,900)の比率座標です。基準ID 40=左上、41=右上、42=右下、43=左下。マーカー画像の右方向をロボット前方に合わせます。</p>
    </section>
    <section className={styles.fieldCard} aria-label="領域設定">
      <div className={styles.sectionHeading}><h2>領域設定</h2></div>
      {poseState?.field ? <FieldForm field={poseState.field} disabled={!connected || running} saving={!!fieldSave?.pending}
        error={fieldSave?.error} done={fieldSave?.done} onSave={saveFieldConfig} />
        : <p className={styles.empty}>{connected ? "設定を取得しています…" : "ハブ未接続"}</p>}
      {running && <p className={styles.muted}>設定の変更は測位を停止してから行います。ロボットごとのマーカー高さは「ロボット」画面で設定します。</p>}
    </section>
  </div>;
}
