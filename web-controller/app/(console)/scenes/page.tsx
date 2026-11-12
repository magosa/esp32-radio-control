"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { MapEditorDialog } from "./MapEditorDialog";
import { MapStage } from "./MapStage";
import { MapTabs } from "./MapTabs";
import { PlaybackBar } from "./PlaybackBar";
import { PreviewDialog } from "./PreviewDialog";
import { ProjectBar } from "./ProjectBar";
import { SequenceDialog } from "./SequenceDialog";
import { TimelineCard } from "./TimelineCard";
import { useConfirm } from "./useConfirm";
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
  const { confirm, dialog: confirmDialog } = useConfirm();
  const duration = useMemo(() => compilePlan(map).duration, [map]);
  const playback = usePlayback(duration);

  // An edit, an undo or switching maps can remove what was selected.
  useEffect(() => { setSelection((current) => pruneSelection(current, map)); }, [map]);
  useEffect(() => { setSelection(EMPTY_SELECTION); setActionRequest(null); setPickRequest(null); }, [mapId]);

  const { commit } = scene;
  const edit = useCallback<EditMap>((change, label) => commit((draft) => {
    const index = draft.maps.findIndex((item) => item.id === mapId);
    if (index < 0) throw new Error("編集中のマップが見つかりません。");
    draft.maps[index] = change(draft.maps[index]);
  }, label), [commit, mapId]);

  const pickRegion = useCallback((point: { x: number; y: number }) => {
    const room = map.rooms.find((item) => roomContainsPoint(item, point.x, point.y));
    setSelection((current) => ({ ...current, roomId: room?.id ?? null }));
  }, [map]);

  const shared = {
    map, selection, onSelect: setSelection, edit, confirm,
    requestAction: setActionRequest, requestPick: setPickRequest,
  };
  const actionTrack = actionRequest ? map.tracks.find((track) => track.id === actionRequest.trackId) : undefined;

  return <div className={styles.page}>
    <ProjectBar project={project} commit={scene.commit} undo={scene.undo} redo={scene.redo} canUndo={scene.canUndo}
      canRedo={scene.canRedo} saveState={scene.saveState} history={scene.history} reload={scene.reload} />
    <MapTabs project={project} activeMapId={mapId} onSelect={scene.setActiveMap} commit={scene.commit} />
    <div className={styles.workspace}>
      <section className={`${consoleStyles.preferenceCard} ${styles.stageCard}`} aria-label="マップ">
        <MapStage map={map} time={playback.time} showGrid={showGrid} gridMm={map.editGridMm} onPick={pickRegion} />
        <div className={styles.stageControls}>
          <PlaybackBar playback={playback} onFullscreen={() => setPreviewOpen(true)} />
          <label className={styles.gridToggle}>
            <input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} />
            グリッド {map.editGridMm}mm
          </label>
          <button type="button" className={consoleStyles.secondary} onClick={() => setMapEditing(true)}>マップを編集</button>
          <ExhibitControls map={map} duration={duration} />
        </div>
      </section>
      <Inspector {...shared} playback={playback} onEditMap={() => setMapEditing(true)} />
    </div>
    <TimelineCard {...shared} playback={playback} />
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