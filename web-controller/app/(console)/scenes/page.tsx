"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { SceneMap } from "@/scene/types";
import { usePlayback } from "@/hooks/usePlayback";
import { useSceneProject, type SceneProjectApi } from "@/hooks/useSceneProject";
import consoleStyles from "../console.module.css";
import { ActionDialog } from "./ActionDialog";
import { CoordinatePicker } from "./CoordinatePicker";
import { ExhibitControls } from "./ExhibitControls";
import { LibraryPanel } from "./LibraryPanel";
import { MapEditorDialog } from "./MapEditorDialog";
import { MapStage } from "./MapStage";
import { MapTabs } from "./MapTabs";
import { PlaybackBar } from "./PlaybackBar";
import { PreviewDialog } from "./PreviewDialog";
import { ProjectBar } from "./ProjectBar";
import { SequenceDialog } from "./SequenceDialog";
import { SceneContextMenu } from "./SceneContextMenu";
import { StatusBar } from "./StatusBar";
import { TimelineCard } from "./TimelineCard";
import { useConfirm } from "./useConfirm";
import { useFillViewport } from "./useFillViewport";
import { useSceneEditor } from "./useSceneEditor";
import { sceneAnalysis } from "./sceneAnalysis";
import timeline from "./timeline.module.css";
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

  return <Editor scene={scene} project={project} map={activeMap} mapId={activeMapId} />;
}

function Editor({ scene, project, map, mapId }: {
  scene: SceneProjectApi;
  project: NonNullable<SceneProjectApi["project"]>;
  map: SceneMap;
  mapId: string;
}) {
  const [showGrid, setShowGrid] = useState(true);
  const [showPaths, setShowPaths] = useState(true);
  const [mapEditing, setMapEditing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [exhibitOpen, setExhibitOpen] = useState(false);
  const [paletteSlot, setPaletteSlot] = useState<HTMLElement | null>(null);
  const [zoomSlot, setZoomSlot] = useState<HTMLElement | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const pageHeight = useFillViewport(pageRef);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { duration, errors } = sceneAnalysis(map);
  const playback = usePlayback(duration, map);
  const {
    selection, setSelection, actionRequest, setActionRequest, pickRequest, setPickRequest, notice,
    dragActionType, setDragActionType, edit, onStageHit, onStageDrop, onShortcut, shared,
    contextMenu, closeContextMenu, openContextSequence, openSequenceTarget, deleteContextTarget, onStageContextMenu,
  } = useSceneEditor({ map, mapId, commit: scene.commit, playback, confirm });
  const actionTrack = actionRequest ? map.tracks.find((track) => track.id === actionRequest.trackId) ?? actionRequest.draftTrack : undefined;
  const sequenceRequested = actionTrack?.kind === "robot" || actionTrack?.kind === "human" || actionTrack?.kind === "door" || actionRequest?.editor === "sequence";
  const contextTarget = contextMenu?.target;
  const contextTrack = contextTarget?.kind === "track" ? map.tracks.find((track) => track.id === contextTarget.trackId) : undefined;
  const contextRoom = contextTarget?.kind === "room" ? map.rooms.find((room) => room.id === contextTarget.roomId) : undefined;
  const contextObject = contextTrack ?? contextRoom;
  const editMap = () => { setLibraryOpen(false); setMapEditing(true); };

  return <div ref={pageRef} className={styles.page} style={{ height: pageHeight, ...(scene.locked ? { gridTemplateRows: "auto auto auto minmax(0, 1fr) auto" } : {}) }}>
    {scene.locked && <p className={styles.runBanner} role="status">
      シーンを実行中です。編集するには実行を終了してください（<Link href="/run">実行画面を開く ▸</Link>）
    </p>}
    <ProjectBar project={project} commit={scene.commit} undo={scene.undo} redo={scene.redo} canUndo={scene.canUndo}
      canRedo={scene.canRedo} saveState={scene.saveState} history={scene.history} reload={scene.reload}
      confirm={confirm} onShortcut={(action) => { void onShortcut(action); }} />
    <MapTabs project={project} activeMapId={mapId} onSelect={scene.setActiveMap} onDrawNewMap={editMap} commit={scene.commit} />
    <div className={styles.workspace}>
      <LibraryPanel className={styles.library} open={libraryOpen} map={map} selection={selection} onSelect={setSelection}
        onEditMap={editMap} onEdit={(target) => { setLibraryOpen(false); openSequenceTarget(target); }} requestContextMenu={shared.requestContextMenu} />
      <div className={styles.center}>
        <section className={`${consoleStyles.preferenceCard} ${styles.stageCard}`} aria-label="マップ">
          <div className={styles.stageHead}>
            <h2>ステージ</h2>
            <button type="button" className={`${consoleStyles.secondary} ${styles.libraryOnly}`} aria-expanded={libraryOpen}
              onClick={() => setLibraryOpen((open) => !open)}>ライブラリ</button>
            <button type="button" className={`${consoleStyles.secondary} ${styles.libraryOnly}`} onClick={editMap}>マップを編集</button>
            <label className={styles.gridToggle}>
              <input type="checkbox" checked={showPaths} onChange={(event) => setShowPaths(event.target.checked)} />
              パス
            </label>
            <label className={styles.gridToggle}>
              <input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} />
              グリッド {map.editGridMm}mm
            </label>
            <div ref={setZoomSlot} />
            <span className={styles.spacer} />
            <div className={styles.anchor}>
              <button type="button" className={consoleStyles.secondary} aria-expanded={exhibitOpen} aria-haspopup="dialog"
                onClick={() => setExhibitOpen((open) => !open)}>展示 ▾</button>
              {exhibitOpen && <div className={styles.exhibitPopover}><ExhibitControls map={map} duration={duration} /></div>}
            </div>
            <Link href="/run" className={consoleStyles.secondary}>実行画面を開く ▸</Link>
          </div>
          {errors.length > 0 && <div className={styles.planProblems} role="alert" aria-label="シーンの再生エラー">
            <strong>設定どおりに再生できない動作があります。安全判定で停止するため、次の原因を解消してください。</strong>
            <ul>{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
          </div>}
          <div className={styles.stageBody}>
            <MapStage map={map} time={playback.time} showGrid={showGrid} showPaths={showPaths} showAxis drawRobots
              selection={selection} gridMm={map.editGridMm} onStageHit={onStageHit} onStageDrop={onStageDrop}
              onStageContextMenu={onStageContextMenu} toolbarSlot={zoomSlot} />
          </div>
          <div className={styles.stageControls}>
            <PlaybackBar playback={playback} onFullscreen={() => setPreviewOpen(true)} />
          </div>
        </section>
        <TimelineCard {...shared} playback={playback} paletteSlot={paletteSlot} toolbarSlot={zoomSlot} dragActionType={dragActionType} onDragActionType={setDragActionType} />
      </div>
      <section className={`${consoleStyles.preferenceCard} ${styles.controls}`} aria-label="行と動作の追加">
          <h2>行の管理</h2>
          <div ref={setPaletteSlot} className={timeline.paletteColumn} />
      </section>
    </div>
    <StatusBar notice={notice} map={map} saveState={scene.saveState} locked={scene.locked} />
    <MapEditorDialog map={map} open={mapEditing} onClose={() => setMapEditing(false)}
      onApply={(next) => edit(() => next, "マップの編集")} />
    {actionRequest && actionTrack && sequenceRequested && (
      <SequenceDialog request={actionRequest} map={map} edit={edit} requestPick={setPickRequest} onClose={() => setActionRequest(null)} />
    )}
    {actionRequest && actionTrack && !sequenceRequested && (
      <ActionDialog request={actionRequest} map={map} edit={edit} requestPick={setPickRequest} onClose={() => setActionRequest(null)} />
    )}
    {pickRequest && <CoordinatePicker request={pickRequest} map={map} onClose={() => setPickRequest(null)} />}
    <PreviewDialog open={previewOpen} map={map} playback={playback} onClose={() => setPreviewOpen(false)} />
    {confirmDialog}
    {contextMenu && contextObject && <SceneContextMenu request={contextMenu}
      name={contextObject.name} locked={contextTrack?.locked ?? false}
      onSequence={openContextSequence} onDelete={() => { void deleteContextTarget(); }} onClose={closeContextMenu} />}
  </div>;
}