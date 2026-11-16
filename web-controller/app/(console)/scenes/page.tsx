"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { roomContainsPoint } from "@/scene/floorPlan";
import type { StageHit } from "@/scene/mapView";
import { EMPTY_SELECTION, pruneSelection, type SceneSelection } from "@/scene/sceneSelection";
import { compilePlan } from "@/scene/timedPlan";
import { addProblem, addRequest } from "@/scene/timelineDrag";
import { deleteActions, deleteTrack, duplicateAction } from "@/scene/trackEdit";
import type { ActionType, SceneMap } from "@/scene/types";
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
  const [showPaths, setShowPaths] = useState(true);
  const [mapEditing, setMapEditing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selection, setSelection] = useState<SceneSelection>(EMPTY_SELECTION);
  const [actionRequest, setActionRequest] = useState<ActionEditRequest | null>(null);
  const [pickRequest, setPickRequest] = useState<PickRequest | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [exhibitOpen, setExhibitOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [dragActionType, setDragActionType] = useState<ActionType | null>(null);
  const [paletteSlot, setPaletteSlot] = useState<HTMLElement | null>(null);
  const [zoomSlot, setZoomSlot] = useState<HTMLElement | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const pageHeight = useFillViewport(pageRef);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const duration = useMemo(() => compilePlan(map).duration, [map]);
  const playback = usePlayback(duration, map);

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
    else setNotice(reason);
    return reason;
  }, [commit, mapId]);

  const onStageHit = useCallback((hit: StageHit, doubleClick: boolean) => {
    if (!hit) {
      setSelection(EMPTY_SELECTION);
      return;
    }
    if (hit.kind === "waypoint") {
      setSelection({ trackId: hit.trackId, actionId: hit.actionId, blocks: [hit.actionId], roomId: null });
      setActionRequest({ trackId: hit.trackId, actionId: hit.actionId });
      return;
    }
    if (hit.kind === "display") {
      setSelection({ trackId: hit.trackId, actionId: hit.actionId, blocks: [hit.actionId], roomId: null });
      return;
    }
    if (hit.kind === "actor") {
      setSelection({ trackId: hit.trackId, actionId: null, blocks: [], roomId: null });
      if (doubleClick && hit.actorKind === "robot") {
        setActionRequest({ trackId: hit.trackId, actionId: null });
      }
      return;
    }
    setSelection({ trackId: null, actionId: null, blocks: [], roomId: hit.roomId });
  }, []);

  const onStageDrop = useCallback((point: { x: number; y: number }) => {
    const type = dragActionType;
    setDragActionType(null);
    if (!type) return;
    const track = map.tracks.find((item) => item.id === selection.trackId) ?? map.tracks[0];
    if (!track) { setNotice("配置先の行を選択してください。"); return; }
    const problem = addProblem(track, type);
    if (problem) { setNotice(problem); return; }
    const room = map.rooms.find((item) => roomContainsPoint(item, point.x, point.y));
    const req = addRequest(track, playback.time, true, type);
    setSelection({ trackId: track.id, actionId: null, blocks: [], roomId: null });
    setActionRequest({
      ...req,
      overrides: { ...req.overrides, x: point.x, y: point.y, ...(room ? { roomId: room.id } : {}) },
    });
  }, [dragActionType, map, selection.trackId, playback.time]);

  const onShortcut = useCallback(async (action: "togglePlay" | "delete" | "duplicate") => {
    if (action === "togglePlay") {
      playback.toggle();
      return;
    }
    if (action === "duplicate") {
      const targetId = selection.actionId ?? selection.blocks[0];
      if (!targetId) { setNotice("複製する動作を選択してください。"); return; }
      let created = "";
      let ownerId = selection.trackId;
      const reason = edit((current) => {
        const res = duplicateAction(current, targetId);
        created = res.actionId;
        ownerId = res.map.tracks.find((t) => t.actions.some((a) => a.id === created))?.id ?? ownerId;
        return res.map;
      }, "動作の複製");
      if (reason === null && created) setSelection({ trackId: ownerId, actionId: created, blocks: [created], roomId: null });
      return;
    }
    if (action === "delete") {
      if (selection.blocks.length > 0) {
        const ids = [...selection.blocks];
        const first = map.tracks.flatMap((t) => t.actions).find((a) => a.id === ids[0]);
        const text = ids.length === 1 ? `「${first?.name ?? "動作"}」を削除します。` : `選択した ${ids.length} 件の動作を削除します。`;
        if (await confirm("動作の削除", text, { danger: true, confirmLabel: "削除" })) {
          edit((current) => deleteActions(current, ids), "動作の削除");
        }
      } else if (selection.trackId) {
        const track = map.tracks.find((t) => t.id === selection.trackId);
        if (!track) return;
        if (await confirm("行の削除", `「${track.name}」の行を削除します。`, { danger: true, confirmLabel: "削除" })) {
          if (edit((current) => deleteTrack(current, track.id), "行の削除") === null) setSelection(EMPTY_SELECTION);
        }
      }
    }
  }, [playback, selection, map.tracks, confirm, edit]);

  const shared = {
    map, selection, onSelect: setSelection, edit, confirm,
    requestAction: setActionRequest, requestPick: setPickRequest,
  };
  const actionTrack = actionRequest ? map.tracks.find((track) => track.id === actionRequest.trackId) : undefined;
  const editMap = () => { setLibraryOpen(false); setMapEditing(true); };

  return <div ref={pageRef} className={styles.page} style={{ height: pageHeight, ...(scene.locked ? { gridTemplateRows: "auto auto auto minmax(0, 1fr) auto" } : {}) }}>
    {scene.locked && <p className={styles.runBanner} role="status">
      シーンを実行中です。編集するには実行を終了してください（<Link href="/run">実行画面を開く ▸</Link>）
    </p>}
    <ProjectBar project={project} commit={scene.commit} undo={scene.undo} redo={scene.redo} canUndo={scene.canUndo}
      canRedo={scene.canRedo} saveState={scene.saveState} history={scene.history} reload={scene.reload}
      confirm={confirm} onShortcut={(action) => { void onShortcut(action); }} />
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
          <div className={styles.stageBody}>
            <MapStage map={map} time={playback.time} showGrid={showGrid} showPaths={showPaths} showAxis
              selection={selection} gridMm={map.editGridMm} onStageHit={onStageHit} onStageDrop={onStageDrop} toolbarSlot={zoomSlot} />
          </div>
          <div className={styles.stageControls}>
            <PlaybackBar playback={playback} onFullscreen={() => setPreviewOpen(true)} />
          </div>
        </section>
        <TimelineCard {...shared} playback={playback} paletteSlot={paletteSlot} dragActionType={dragActionType} onDragActionType={setDragActionType} />
      </div>
      <div className={styles.controls}>
        <section className={`${consoleStyles.preferenceCard}`} aria-label="行と動作の追加">
          <h2>行の管理</h2>
          <div ref={setPaletteSlot} className={timeline.paletteColumn} />
        </section>
        <Inspector {...shared} playback={playback} onEditMap={editMap} onDragActionType={setDragActionType} />
      </div>
    </div>
    <StatusBar notice={notice} map={map} saveState={scene.saveState} locked={scene.locked} />
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