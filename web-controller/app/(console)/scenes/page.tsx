"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { roomContainsPoint } from "@/scene/floorPlan";
import { EMPTY_SELECTION, pruneSelection, type SceneSelection } from "@/scene/sceneSelection";
import { compilePlan } from "@/scene/timedPlan";
import type { SceneMap } from "@/scene/types";
import { usePlayback } from "@/hooks/usePlayback";
import { useSceneProject, type SceneProjectApi } from "@/hooks/useSceneProject";
import consoleStyles from "../console.module.css";
import { ActionDialog } from "./ActionDialog";
import { CoordinatePicker } from "./CoordinatePicker";
import type { ActionEditRequest, EditMap, PickRequest } from "./editorTypes";
import { ExhibitControls } from "./ExhibitControls";
import { Inspector } from "./Inspector";
import { LibraryPanel } from "./LibraryPanel";
import { MapEditorDialog } from "./MapEditorDialog";
import { MapStage } from "./MapStage";
import { MapTabs } from "./MapTabs";
import { PlaybackBar } from "./PlaybackBar";
import { PreviewDialog } from "./PreviewDialog";
import { ProjectBar } from "./ProjectBar";
import { SequenceDialog } from "./SequenceDialog";
import { StatusBar } from "./StatusBar";
import { TimelineCard } from "./TimelineCard";
import { useConfirm } from "./useConfirm";
import { useFillViewport } from "./useFillViewport";
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
  const [mapEditing, setMapEditing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selection, setSelection] = useState<SceneSelection>(EMPTY_SELECTION);
  const [actionRequest, setActionRequest] = useState<ActionEditRequest | null>(null);
  const [pickRequest, setPickRequest] = useState<PickRequest | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [exhibitOpen, setExhibitOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [paletteSlot, setPaletteSlot] = useState<HTMLElement | null>(null);
  const [zoomSlot, setZoomSlot] = useState<HTMLElement | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const pageHeight = useFillViewport(pageRef);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const duration = useMemo(() => compilePlan(map).duration, [map]);
  const playback = usePlayback(duration);

  // An edit, an undo or switching maps can remove what was selected.
  useEffect(() => { setSelection((current) => pruneSelection(current, map)); }, [map]);
  useEffect(() => { setSelection(EMPTY_SELECTION); setActionRequest(null); setPickRequest(null); }, [mapId]);

  const { commit } = scene;
  const edit = useCallback<EditMap>((change, label) => {
    const reason = commit((draft) => {
      const index = draft.maps.findIndex((item) => item.id === mapId);
      if (index < 0) throw new Error("編集中のマップが見つかりません。");
      draft.maps[index] = change(draft.maps[index]);
    }, label);
    if (reason === null) setNotice(`${label}（元に戻せます）`);
    return reason;
  }, [commit, mapId]);

  const pickRegion = useCallback((point: { x: number; y: number }) => {
    const room = map.rooms.find((item) => roomContainsPoint(item, point.x, point.y));
    setSelection((current) => ({ ...current, roomId: room?.id ?? null }));
  }, [map]);

  const shared = {
    map, selection, onSelect: setSelection, edit, confirm,
    requestAction: setActionRequest, requestPick: setPickRequest,
  };
  const actionTrack = actionRequest ? map.tracks.find((track) => track.id === actionRequest.trackId) : undefined;
  const editMap = () => { setLibraryOpen(false); setMapEditing(true); };

  return <div ref={pageRef} className={styles.page} style={{ height: pageHeight }}>
    <ProjectBar project={project} commit={scene.commit} undo={scene.undo} redo={scene.redo} canUndo={scene.canUndo}
      canRedo={scene.canRedo} saveState={scene.saveState} history={scene.history} reload={scene.reload} />
    <MapTabs project={project} activeMapId={mapId} onSelect={scene.setActiveMap} commit={scene.commit} />
    <div className={styles.workspace}>
      <LibraryPanel className={styles.library} open={libraryOpen} map={map} selection={selection} onSelect={(next) => { setSelection(next); setLibraryOpen(false); }}
        onEditMap={editMap} />
      <div className={styles.center}>
        <section className={`${consoleStyles.preferenceCard} ${styles.stageCard}`} aria-label="マップ">
          <div className={styles.stageHead}>
            <h2>ステージ</h2>
            <button type="button" className={`${consoleStyles.secondary} ${styles.libraryOnly}`} aria-expanded={libraryOpen}
              onClick={() => setLibraryOpen((open) => !open)}>ライブラリ</button>
            <button type="button" className={`${consoleStyles.secondary} ${styles.libraryOnly}`} onClick={editMap}>マップを編集</button>
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
          </div>
          <div className={styles.stageBody}>
            <MapStage map={map} time={playback.time} showGrid={showGrid} gridMm={map.editGridMm} onPick={pickRegion} toolbarSlot={zoomSlot} />
          </div>
          <div className={styles.stageControls}>
            <PlaybackBar playback={playback} onFullscreen={() => setPreviewOpen(true)} />
          </div>
        </section>
        <TimelineCard {...shared} playback={playback} paletteSlot={paletteSlot} />
      </div>
      <div className={styles.controls}>
        <section className={`${consoleStyles.preferenceCard}`} aria-label="行と動作の追加">
          <h2>行と動作を追加</h2>
          <div ref={setPaletteSlot} className={timeline.paletteColumn} />
        </section>
        <Inspector {...shared} playback={playback} onEditMap={editMap} />
      </div>
    </div>
    <StatusBar notice={notice} map={map} />
    <MapEditorDialog map={map} open={mapEditing} onClose={() => setMapEditing(false)}
      onApply={(next) => edit(() => next, "マップの編集")} />
    {actionRequest && actionTrack?.kind === "robot" && (
      <SequenceDialog request={actionRequest} map={map} edit={edit} requestPick={setPickRequest} onClose={() => setActionRequest(null)} />
    )}
    {actionRequest && actionTrack && actionTrack.kind !== "robot" && (
      <ActionDialog request={actionRequest} map={map} edit={edit} requestPick={setPickRequest} onClose={() => setActionRequest(null)} />
    )}
    {pickRequest && <CoordinatePicker request={pickRequest} map={map} onClose={() => setPickRequest(null)} />}
    <PreviewDialog open={previewOpen} map={map} playback={playback} onClose={() => setPreviewOpen(false)} />
    {confirmDialog}
  </div>;
}