"use client";

import { useCallback, useEffect, useState } from "react";
import { roomContainsPoint } from "@/scene/floorPlan";
import type { StageHit } from "@/scene/mapView";
import type { Commit } from "@/scene/sceneSession";
import { EMPTY_SELECTION, pruneSelection, type SceneSelection } from "@/scene/sceneSelection";
import { addProblem, addRequest } from "@/scene/timelineDrag";
import { addTrack, deleteActions, deleteTrack, duplicateAction } from "@/scene/trackEdit";
import { removeRegionChecked } from "@/scene/mapEditRegions";
import type { ActionType, SceneMap } from "@/scene/types";
import type { ActionEditRequest, Confirm, EditMap, PickRequest, PlaybackControls, SceneContextRequest } from "./editorTypes";

export function useSceneEditor({ map, mapId, commit, playback, confirm }: {
  map: SceneMap;
  mapId: string;
  commit: Commit;
  playback: PlaybackControls;
  confirm: Confirm;
}) {
  const [selection, setSelection] = useState<SceneSelection>(EMPTY_SELECTION);
  const [actionRequest, setActionRequest] = useState<ActionEditRequest | null>(null);
  const [pickRequest, setPickRequest] = useState<PickRequest | null>(null);
  const [notice, setNotice] = useState("");
  const [dragActionType, setDragActionType] = useState<ActionType | null>(null);
  const [contextMenu, setContextMenu] = useState<SceneContextRequest | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => { setSelection((current) => pruneSelection(current, map)); }, [map]);
  useEffect(() => { setSelection(EMPTY_SELECTION); setActionRequest(null); setPickRequest(null); }, [mapId]);
  useEffect(closeContextMenu, [map, closeContextMenu]);

  const requestAction = useCallback((request: ActionEditRequest) => {
    if (playback.running) playback.toggle();
    setActionRequest(request);
  }, [playback]);
  const requestContextMenu = useCallback((request: SceneContextRequest) => {
    if (playback.running) playback.toggle();
    setContextMenu(request);
  }, [playback]);

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
      requestAction({ trackId: hit.trackId, actionId: hit.actionId });
      return;
    }
    if (hit.kind === "display") {
      setSelection({ trackId: hit.trackId, actionId: hit.actionId, blocks: [hit.actionId], roomId: null });
      return;
    }
    if (hit.kind === "actor") {
      setSelection({ trackId: hit.trackId, actionId: null, blocks: [], roomId: null });
      if (doubleClick) requestAction({ trackId: hit.trackId, actionId: null, editor: "sequence" });
      return;
    }
    setSelection({ trackId: null, actionId: null, blocks: [], roomId: hit.roomId });
  }, [requestAction]);

  const onStageContextMenu = useCallback((hit: StageHit, point: { x: number; y: number }) => {
    if (!hit) return;
    requestContextMenu({
      ...point, target: hit.kind === "room" ? { kind: "room", roomId: hit.roomId } : { kind: "track", trackId: hit.trackId },
    });
  }, [requestContextMenu]);

  const openSequenceTarget = (target: SceneContextRequest["target"]) => {
    closeContextMenu();
    const trackId = target.kind === "track" ? target.trackId
      : map.tracks.find((track) => track.kind === "room" && track.roomId === target.roomId)?.id;
    if (!trackId && target.kind === "room") {
      try {
        const added = addTrack(map, "room", { roomId: target.roomId });
        const draftTrack = added.map.tracks[added.map.tracks.length - 1];
        requestAction({ trackId: added.trackId, actionId: null, editor: "sequence", draftTrack });
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (trackId) {
      setSelection({ trackId, actionId: null, blocks: [], roomId: null });
      requestAction({ trackId, actionId: null, editor: "sequence" });
    }
  };
  const openContextSequence = () => { if (contextMenu) openSequenceTarget(contextMenu.target); };
  const deleteContextTarget = async () => {
    if (!contextMenu) return;
    const { target } = contextMenu;
    closeContextMenu();
    if (target.kind === "track") {
      const track = map.tracks.find((item) => item.id === target.trackId);
      if (!track) { setNotice("削除する行が見つかりません。"); return; }
      if (await confirm("行の削除", `「${track.name}」の行と動作 ${track.actions.length} 件を削除します。`, { danger: true, confirmLabel: "削除" })) {
        edit((current) => deleteTrack(current, track.id), "行の削除");
      }
    } else {
      const room = map.rooms.find((item) => item.id === target.roomId);
      if (!room) { setNotice("削除する領域が見つかりません。"); return; }
      if (await confirm("領域の削除", `「${room.name}」を削除します。行・動作から参照されている領域は削除できません。`, { danger: true, confirmLabel: "削除" })) {
        edit((current) => removeRegionChecked(current, room.id), "領域の削除");
      }
    }
  };

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
    requestAction({
      ...req,
      overrides: { ...req.overrides, x: point.x, y: point.y, ...(room ? { roomId: room.id } : {}) },
    });
  }, [dragActionType, map, selection.trackId, playback.time, requestAction]);

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
        ownerId = res.map.tracks.find((track) => track.actions.some((item) => item.id === created))?.id ?? ownerId;
        return res.map;
      }, "動作の複製");
      if (reason === null && created) setSelection({ trackId: ownerId, actionId: created, blocks: [created], roomId: null });
      return;
    }
    if (action === "delete") {
      if (selection.blocks.length > 0) {
        const ids = [...selection.blocks];
        const first = map.tracks.flatMap((track) => track.actions).find((item) => item.id === ids[0]);
        const text = ids.length === 1 ? `「${first?.name ?? "動作"}」を削除します。` : `選択した ${ids.length} 件の動作を削除します。`;
        if (await confirm("動作の削除", text, { danger: true, confirmLabel: "削除" })) {
          edit((current) => deleteActions(current, ids), "動作の削除");
        }
      } else if (selection.trackId) {
        const track = map.tracks.find((item) => item.id === selection.trackId);
        if (!track) return;
        if (await confirm("行の削除", `「${track.name}」の行を削除します。`, { danger: true, confirmLabel: "削除" })) {
          if (edit((current) => deleteTrack(current, track.id), "行の削除") === null) setSelection(EMPTY_SELECTION);
        }
      }
    }
  }, [playback, selection, map.tracks, confirm, edit]);

  return {
    selection, setSelection, actionRequest, setActionRequest, pickRequest, setPickRequest,
    notice, dragActionType, setDragActionType, edit, onStageHit, onStageDrop, onShortcut, onStageContextMenu,
    contextMenu, closeContextMenu, openContextSequence, openSequenceTarget, deleteContextTarget,
    shared: { map, selection, onSelect: setSelection, edit, confirm, requestAction, requestPick: setPickRequest, requestContextMenu },
  };
}
