"use client";

import { Bot, DoorOpen, Maximize2, Monitor, User } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { compilePlan, samplePlan, type ActionState } from "@/scene/timedPlan";
import {
  addProblem, addRequest, moveOffset, previewDrop, rangeIds, resizeOffset, KEY_RESIZE_STEP_S, MAX_RUN_S, MIN_RESIZE_S,
  type Dragged, type DropPreview,
} from "@/scene/timelineDrag";
import { adjustTimeline, type TimelineAlignment } from "@/scene/timelineEdit";
import {
  fitPx, PX_DEFAULT, PX_MAX, PX_MIN, pxToTime, quantize, rulerTicks, timeToPx, timelineHorizon,
} from "@/scene/timelineView";
import { actionTypeLabel, addTrack, deleteActions, deleteTrack, moveTrack, moveTrackBy, replaceAction, setTrackFlag, trackKindLabel } from "@/scene/trackEdit";
import type { Action, ActionType, SceneMap, Track, TrackKind } from "@/scene/types";
import consoleStyles from "../console.module.css";
import type { EditorShared, PlaybackControls } from "./editorTypes";
import styles from "./scenes.module.css";
import { TimelineBar, type BarStatus } from "./TimelineBar";
import timeline from "./timeline.module.css";
import { TrackPalette } from "./TrackPalette";

export interface TimelineCardProps extends EditorShared {
  playback: PlaybackControls;
}

const LABEL_W = 232;
const LANE_TAIL_PX = 160;
const TAP_MS = 400;
const ICONS = { robot: Bot, human: User, room: DoorOpen, display: Monitor } as const;
const LOCKED = "この行はロックされています。";

interface DragView {
  kind: "move" | "resize";
  ids: ReadonlySet<string>;
  offset: number;
  match: TimelineAlignment | null;
}

interface DropView {
  key: string;
  trackId: string;
  position: number;
  type: ActionType;
  preview: DropPreview;
}

function statusAt(state: ActionState | undefined, time: number): BarStatus {
  if (!state) return "waiting";
  if (state.status === "blocked") return "blocked";
  if (state.start === null || time < state.start) return "waiting";
  if (state.end !== null && time < state.end) return "running";
  return state.status === "failed" ? "failed" : "complete";
}

const barTitle = (action: Action, state: ActionState | undefined) =>
  `${action.name} / 予定 ${action.position.toFixed(2)}秒 / 実行 ${state?.start?.toFixed(2) ?? "不可"}〜${state?.end?.toFixed(2) ?? "不可"}秒` +
  (state?.reason ? ` / ${state.reason}` : "");

export function TimelineCard(props: TimelineCardProps) {
  const { map, selection, playback } = props;
  const [px, setPx] = useState(PX_DEFAULT);
  const [fine, setFine] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [view, setView] = useState<DragView | null>(null);
  const [drop, setDrop] = useState<DropView | null>(null);
  const [reorderOver, setReorderOver] = useState<string | null>(null);
  const [viewport, setViewport] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const latest = useRef({ ...props, px, fine });
  latest.current = { ...props, px, fine };
  const cleanup = useRef<(() => void) | null>(null);
  const paletteType = useRef<ActionType | null>(null);
  const reorderSource = useRef<string | null>(null);
  const dropCache = useRef<{ key: string; map: SceneMap; preview: DropPreview } | null>(null);
  const taps = useRef({ id: "", at: 0 });
  const laneTap = useRef({ id: "", at: 0 });
  const lastOpen = useRef(0);
  const lastAdd = useRef(0);

  const analysis = useMemo(() => {
    const plan = compilePlan(map);
    const done = samplePlan(plan, plan.duration);
    return { duration: plan.duration, states: done.actionStates, warnings: done.warnings, errors: done.errors };
  }, [map]);
  const horizon = timelineHorizon(map, analysis.duration);
  const laneWidth = Math.max(timeToPx(horizon, px) + LANE_TAIL_PX, viewport - LABEL_W);
  const selectedBlocks = useMemo(() => new Set(selection.blocks), [selection.blocks]);
  const selectedTrack = map.tracks.find((track) => track.id === selection.trackId) ?? null;

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 8000);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => setViewport(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => cleanup.current?.(), []);

  const run = useCallback((change: (map: SceneMap) => SceneMap, label: string): boolean => {
    const reason = latest.current.edit(change, label);
    setMessage(reason);
    return reason === null;
  }, []);

  const selectTrack = useCallback((trackId: string) => {
    const { selection: current, onSelect } = latest.current;
    onSelect({ trackId, actionId: null, blocks: [], roomId: current.roomId });
  }, []);

  const pause = useCallback(() => { if (latest.current.playback.running) latest.current.playback.toggle(); }, []);

  const lockedAmong = useCallback((ids: readonly string[]) =>
    latest.current.map.tracks.some((track) => track.locked && track.actions.some((action) => ids.includes(action.id))), []);

  const openAction = useCallback((trackId: string, actionId: string) => {
    const now = performance.now();
    if (now - lastOpen.current < TAP_MS) return;
    lastOpen.current = now;
    const { selection: current, onSelect, requestAction } = latest.current;
    onSelect({ trackId, actionId, blocks: current.blocks.includes(actionId) ? current.blocks : [actionId], roomId: current.roomId });
    setMessage(null);
    requestAction({ trackId, actionId });
  }, []);

  const registerTap = useCallback((trackId: string, actionId: string) => {
    const now = performance.now();
    if (taps.current.id === actionId && now - taps.current.at < TAP_MS) {
      taps.current = { id: "", at: 0 };
      openAction(trackId, actionId);
    } else taps.current = { id: actionId, at: now };
  }, [openAction]);

  const askDeleteActions = useCallback(async (anchorId?: string) => {
    const { map: current, selection: picked, confirm } = latest.current;
    const ids = anchorId && !picked.blocks.includes(anchorId) ? [anchorId] : [...picked.blocks];
    if (!ids.length) return;
    if (lockedAmong(ids)) { setMessage(ids.length > 1 ? "選択に編集ロック中の行が含まれます。" : LOCKED); return; }
    const first = current.tracks.flatMap((track) => track.actions).find((action) => action.id === ids[0]);
    const text = ids.length === 1 ? `「${first?.name ?? "動作"}」を削除します。` : `選択した ${ids.length} 件の動作を削除します。`;
    if (await confirm("動作の削除", text, { danger: true, confirmLabel: "削除" })) run((m) => deleteActions(m, ids), "動作の削除");
  }, [lockedAmong, run]);

  const beginDrag = useCallback((event: ReactPointerEvent<HTMLElement>, kind: "move" | "resize", trackId: string, anchor: Action, group: Action[]) => {
    const element = event.currentTarget;
    const { pointerId, pointerType, clientX: startX } = event;
    const host = scroller.current;
    const scroll0 = host?.scrollLeft ?? 0;
    const ids = group.map((action) => action.id);
    const idSet = new Set(ids);
    let x = startX, shift = event.shiftKey, moved = false, finished = false;
    let last: Dragged = { offset: 0, match: null };
    try { element.setPointerCapture(pointerId); } catch { /* the pointer is already gone */ }

    const compute = () => {
      const { map: current, px: scale, fine: tenths } = latest.current;
      const dx = x - startX + ((host?.scrollLeft ?? 0) - scroll0);
      const options = { fine: tenths, snap: shift };
      last = kind === "move" ? moveOffset(current, anchor, group, dx, scale, options) : resizeOffset(current, anchor, dx, scale, options);
      setView({ kind, ids: idSet, offset: last.offset, match: last.match });
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      x = e.clientX; shift = e.shiftKey;
      if (!moved && Math.abs(x - startX) < 3) return;
      moved = true;
      compute();
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (moved) { x = e.clientX; shift = e.shiftKey; compute(); }
      finish(false);
    };
    const onCancel = () => finish(true);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === "Shift") { shift = e.type === "keydown"; if (moved) compute(); }
    };
    function finish(cancelled: boolean) {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      element.removeEventListener("lostpointercapture", onCancel);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keyup", onKey, true);
      try { element.releasePointerCapture(pointerId); } catch { /* already released */ }
      cleanup.current = null;
      setView(null);
      if (cancelled) return;
      if (!moved) {
        if (pointerType === "touch" && kind === "move") registerTap(trackId, anchor.id);
        return;
      }
      if (last.offset === 0) return;
      const offset = last.offset;
      if (kind === "move") run((m) => adjustTimeline(m, ids, offset), "バーの移動");
      else run((m) => adjustTimeline(m, ids, 0, offset), "バーの長さの変更");
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    element.addEventListener("lostpointercapture", onCancel);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", onKey, true);
    cleanup.current = () => finish(true);
  }, [registerTap, run]);

  // Shared by the bar and its resize handle: updates the selection, refuses locked rows, then returns the group to drag.
  const pickForDrag = useCallback((trackId: string, actionId: string): { anchor: Action; group: Action[] } | null => {
    const { map: current, selection: picked, onSelect } = latest.current;
    const track = current.tracks.find((item) => item.id === trackId);
    const anchor = track?.actions.find((action) => action.id === actionId);
    if (!track || !anchor) return null;
    const blocks = picked.blocks.includes(actionId) ? picked.blocks : [actionId];
    onSelect({ trackId, actionId, blocks, roomId: picked.roomId });
    pause();
    setMessage(null);
    if (track.locked) { setMessage(LOCKED); return null; }
    if (lockedAmong(blocks)) { setMessage("選択に編集ロック中の行が含まれます。"); return null; }
    const group = current.tracks.flatMap((item) => item.actions).filter((action) => blocks.includes(action.id));
    return { anchor, group };
  }, [lockedAmong, pause]);

  const onBarPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, trackId: string, actionId: string) => {
    if (event.button !== 0) return;
    const { map: current, selection: picked, onSelect } = latest.current;
    const track = current.tracks.find((item) => item.id === trackId);
    if (!track) return;
    if (event.ctrlKey || event.metaKey) {
      pause();
      const blocks = picked.blocks.includes(actionId) ? picked.blocks.filter((id) => id !== actionId) : [...picked.blocks, actionId];
      const focus = blocks.includes(actionId) ? actionId : blocks.at(-1) ?? null;
      const owner = focus ? current.tracks.find((item) => item.actions.some((action) => action.id === focus)) : undefined;
      onSelect({ trackId: owner?.id ?? trackId, actionId: focus, blocks, roomId: picked.roomId });
      return;
    }
    if (event.shiftKey && picked.trackId === trackId && picked.actionId && !picked.blocks.includes(actionId)) {
      pause();
      const blocks = Array.from(new Set([...picked.blocks, ...rangeIds(track, picked.actionId, actionId)]));
      onSelect({ trackId, actionId, blocks, roomId: picked.roomId });
      return;
    }
    const target = pickForDrag(trackId, actionId);
    if (target) beginDrag(event, "move", trackId, target.anchor, target.group);
  }, [beginDrag, pause, pickForDrag]);

  const onHandlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, trackId: string, actionId: string) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    const target = pickForDrag(trackId, actionId);
    if (target) beginDrag(event, "resize", trackId, target.anchor, target.group);
  }, [beginDrag, pickForDrag]);

  const onResizeKey = useCallback((trackId: string, actionId: string, delta: number) => {
    const { map: current } = latest.current;
    const track = current.tracks.find((item) => item.id === trackId);
    const action = track?.actions.find((item) => item.id === actionId);
    if (!track || !action) return;
    if (track.locked) { setMessage(LOCKED); return; }
    const seconds = Math.min(MAX_RUN_S, Math.max(MIN_RESIZE_S, Math.round((action.runSeconds + delta) * 10) / 10));
    if (seconds === action.runSeconds) { setMessage(delta < 0 ? "これ以上短くできません。" : "これ以上長くできません。"); return; }
    const next: Action = { ...action, runSeconds: seconds, ...(action.motion === "rotate" ? { rotationSeconds: seconds } : {}) };
    run((m) => replaceAction(m, trackId, next), "バーの長さの変更");
  }, [run]);

  const askDeleteTrack = async () => {
    const track = selectedTrack;
    if (!track) return;
    if (track.locked) { setMessage(LOCKED); return; }
    const count = track.actions.length;
    const text = `「${track.name}」の行を削除します。${count ? `この行の動作 ${count} 件も削除されます。` : ""}`;
    if (await props.confirm("行の削除", text, { danger: true, confirmLabel: "削除" })) run((m) => deleteTrack(m, track.id), "行の削除");
  };

  const onAddTrack = (kind: TrackKind) => {
    let created = "";
    const roomId = kind === "room" && selection.roomId ? selection.roomId : undefined;
    const ok = run((m) => { const result = addTrack(m, kind, { roomId }); created = result.trackId; return result.map; }, `${trackKindLabel(kind)}の行を追加`);
    if (ok && created) props.onSelect({ trackId: created, actionId: null, blocks: [], roomId: selection.roomId });
  };

  const onAddAction = (type: ActionType) => {
    if (!selectedTrack) { setMessage("配置先の行を選択してください。"); return; }
    const problem = addProblem(selectedTrack, type);
    if (problem) { setMessage(problem); return; }
    setMessage(null);
    props.requestAction(addRequest(selectedTrack, playback.time, fine, type));
  };

  const addAt = (track: Track, clientX: number, lane: HTMLElement) => {
    const now = performance.now();
    if (now - lastAdd.current < TAP_MS) return;
    lastAdd.current = now;
    selectTrack(track.id);
    const problem = addProblem(track, addRequest(track, 0, fine).type);
    if (problem) { setMessage(problem); return; }
    setMessage(null);
    props.requestAction(addRequest(track, pxToTime(clientX - lane.getBoundingClientRect().left, px), fine));
  };

  const onLanePointerUp = (event: ReactPointerEvent<HTMLElement>, track: Track) => {
    if (event.pointerType !== "touch" || event.target !== event.currentTarget) return;
    const now = performance.now();
    if (laneTap.current.id === track.id && now - laneTap.current.at < TAP_MS) {
      laneTap.current = { id: "", at: 0 };
      addAt(track, event.clientX, event.currentTarget);
    } else laneTap.current = { id: track.id, at: now };
  };

  const dropPreviewFor = (track: Track, type: ActionType, position: number): DropView => {
    const key = `${track.id}|${type}|${position}`;
    const cached = dropCache.current;
    const preview = cached && cached.key === key && cached.map === map ? cached.preview : previewDrop(map, track.id, type, position);
    dropCache.current = { key, map, preview };
    return { key, trackId: track.id, position, type, preview };
  };
  const dropPosition = (event: DragEvent<HTMLElement>) =>
    quantize(pxToTime(event.clientX - event.currentTarget.getBoundingClientRect().left, px), fine);

  const onLaneDragOver = (event: DragEvent<HTMLDivElement>, track: Track) => {
    const type = paletteType.current;
    if (!type) return;
    event.preventDefault();
    const next = dropPreviewFor(track, type, dropPosition(event));
    event.dataTransfer.dropEffect = next.preview.ok ? "copy" : "none";
    setDrop((current) => (current?.key === next.key ? current : next));
  };
  const onLaneDrop = (event: DragEvent<HTMLDivElement>, track: Track) => {
    const type = paletteType.current;
    if (!type) return;
    event.preventDefault();
    const next = dropPreviewFor(track, type, dropPosition(event));
    setDrop(null);
    paletteType.current = null;
    if (!next.preview.ok) { setMessage(next.preview.reason); return; }
    selectTrack(track.id);
    setMessage(null);
    props.requestAction(addRequest(track, next.position, fine, type));
  };

  const onRowDragOver = (event: DragEvent<HTMLElement>, track: Track) => {
    if (!reorderSource.current) return;
    event.preventDefault();
    setReorderOver(track.id);
  };
  const onRowDrop = (event: DragEvent<HTMLElement>, index: number) => {
    const source = reorderSource.current;
    if (!source) return;
    event.preventDefault();
    reorderSource.current = null;
    setReorderOver(null);
    run((m) => moveTrack(m, source, index), "行の並べ替え");
  };
  const onLabelDragStart = (event: DragEvent<HTMLElement>, track: Track) => {
    if (track.locked) { event.preventDefault(); setMessage(LOCKED); return; }
    reorderSource.current = track.id;
    event.dataTransfer.setData("application/x-scene-reorder", track.id);
    event.dataTransfer.effectAllowed = "move";
  };

  const seekFrom = (event: ReactPointerEvent<HTMLElement>) => {
    playback.seek(pxToTime(event.clientX - event.currentTarget.getBoundingClientRect().left, px));
  };
  const onRulerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    pause();
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFrom(event);
  };
  const onKnobKey = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === "ArrowLeft" ? -KEY_RESIZE_STEP_S : event.key === "ArrowRight" ? KEY_RESIZE_STEP_S : 0;
    if (event.key === "Home") playback.seek(0);
    else if (event.key === "End") playback.seek(playback.duration);
    else if (step) playback.seek(playback.time + step);
    else return;
    event.preventDefault();
  };

  const onFit = () => {
    const width = scroller.current?.clientWidth ?? viewport;
    // fitPx reserves 180px for the header; the real label column is LABEL_W wide.
    setPx(Math.round(Math.min(PX_MAX, Math.max(PX_MIN, fitPx(width - LABEL_W + 164, horizon)))));
  };

  const ticks = useMemo(() => rulerTicks(horizon, px), [horizon, px]);
  const warnings = analysis.warnings.length + analysis.errors.length;
  const playheadLeft = timeToPx(Math.min(playback.time, Math.max(playback.duration, 0)), px);
  const handlers = { onBarPointerDown, onHandlePointerDown, onOpen: openAction, onDelete: askDeleteActions, onResizeKey };

  return <section className={`${consoleStyles.preferenceCard} ${styles.timelineCard} ${timeline.root}`} aria-label="時間軸">
    <div className={timeline.header}>
      <h2>時間軸</h2>
      <span className={timeline.count}>{map.tracks.length} TRACKS</span>
      <div className={timeline.toolbar} role="toolbar" aria-label="時間軸の表示">
        <label className={timeline.zoom}>
          <span>ズーム <output>{px}px/秒</output></span>
          <input type="range" min={PX_MIN} max={PX_MAX} step={1} value={px} aria-label="ズーム"
            onChange={(event) => setPx(Number(event.target.value))} />
        </label>
        <button type="button" className={consoleStyles.secondary} onClick={onFit}><Maximize2 aria-hidden="true" />全体表示</button>
        <div className={timeline.snap} role="group" aria-label="スナップ">
          <button type="button" className={consoleStyles.secondary} aria-pressed={fine} onClick={() => setFine(true)}>スナップ 0.1秒</button>
          <button type="button" className={consoleStyles.secondary} aria-pressed={!fine} onClick={() => setFine(false)}>スナップ 0.5秒</button>
        </div>
      </div>
    </div>
    <TrackPalette track={selectedTrack} selectedBlocks={selection.blocks.length} onAddTrack={onAddTrack} onAddAction={onAddAction}
      onMoveTrack={(direction) => { if (selectedTrack) run((m) => moveTrackBy(m, selectedTrack.id, direction), "行の並べ替え"); }}
      onDeleteTrack={askDeleteTrack} onDeleteActions={() => askDeleteActions()}
      onDragType={(type) => { paletteType.current = type; if (!type) setDrop(null); }} />
    <p className={timeline.hint}>
      バーはドラッグで移動、右端の取っ手で長さを変更。Shift を押しながらで他のバーの端に吸着。Ctrl/⌘ で追加選択、Shift で行内を範囲選択。
      レーンのダブルクリック（タッチはダブルタップ）、または動作ボタンのドラッグで動作を追加。
    </p>
    {message && <p className={timeline.alert} role="alert">{message}</p>}
    <div ref={scroller} className={timeline.scroller} role="region" aria-label="時間軸のスクロール領域" tabIndex={0}>
      <div className={timeline.canvas} style={{ width: LABEL_W + laneWidth, ["--px" as string]: `${px}px` }}>
        <div className={timeline.rulerRow}>
          <div className={timeline.corner}>秒</div>
          <div className={timeline.ruler} data-part="ruler" onPointerDown={onRulerDown}
            onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFrom(event); }}
            onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}>
            {ticks.map((tick) => <span key={tick.time} className={timeline.tick} style={{ left: tick.left }} aria-hidden="true">{tick.label}</span>)}
            <div className={timeline.knob} role="slider" tabIndex={0} aria-label="再生ヘッド" aria-orientation="horizontal"
              aria-valuemin={0} aria-valuemax={playback.duration} aria-valuenow={Number(playback.time.toFixed(1))}
              aria-valuetext={`${playback.time.toFixed(1)}秒`} style={{ left: playheadLeft }} onKeyDown={onKnobKey} />
          </div>
        </div>
        {map.tracks.length === 0 && <p className={timeline.empty}>行がありません。上の「＋ ロボット」などで追加してください。</p>}
        {map.tracks.map((track, index) => {
          const Icon = ICONS[track.kind];
          const isSelected = selection.trackId === track.id;
          const sub = `${track.kind === "human" ? `${track.count ?? 1}人 / GROUP` : trackKindLabel(track.kind)}${track.muted ? " · 除外中" : ""}${track.locked ? " · 固定" : ""}`;
          return <div key={track.id} className={timeline.row} data-track-id={track.id} data-selected={isSelected} data-over={reorderOver === track.id}
            onDragOver={(event) => onRowDragOver(event, track)} onDragLeave={() => setReorderOver((current) => (current === track.id ? null : current))}
            onDrop={(event) => onRowDrop(event, index)}>
            <div className={timeline.label} draggable onDragStart={(event) => onLabelDragStart(event, track)}
              onDragEnd={() => { reorderSource.current = null; setReorderOver(null); }}>
              <button type="button" className={timeline.labelMain} aria-pressed={isSelected} onClick={() => selectTrack(track.id)}
                style={{ ["--track-color" as string]: track.color }}>
                <Icon aria-hidden="true" />
                <span className={timeline.labelText}><strong>{track.name}</strong><small>{sub}</small></span>
              </button>
              <div className={timeline.flags}>
                <button type="button" aria-pressed={track.muted} aria-label={`${track.name} 除外`} title="プレビューから除外"
                  onClick={() => run((m) => setTrackFlag(m, track.id, "muted", !track.muted), track.muted ? "除外を解除" : "行を除外")}>除外</button>
                <button type="button" aria-pressed={track.locked} aria-label={`${track.name} 固定`} title="編集ロック（移動・削除・並べ替えを禁止）"
                  onClick={() => run((m) => setTrackFlag(m, track.id, "locked", !track.locked), track.locked ? "固定を解除" : "行を固定")}>固定</button>
              </div>
            </div>
            <div className={timeline.lane} role="group" aria-label={`${track.name} の動作`} data-track-id={track.id}
              data-muted={track.muted} data-locked={track.locked} data-selected={isSelected}
              onPointerDown={(event) => { if (event.target === event.currentTarget) selectTrack(track.id); }}
              onPointerUp={(event) => onLanePointerUp(event, track)}
              onDoubleClick={(event) => { if (event.target === event.currentTarget) addAt(track, event.clientX, event.currentTarget); }}
              onDragOver={(event) => onLaneDragOver(event, track)}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null); }}
              onDrop={(event) => onLaneDrop(event, track)}>
              {track.actions.map((action) => {
                const dragged = view?.ids.has(action.id) ?? false;
                const position = dragged && view?.kind === "move" ? action.position + view.offset : action.position;
                const runSeconds = dragged && view?.kind === "resize" ? Math.max(0.1, action.runSeconds + view.offset) : action.runSeconds;
                const state = analysis.states[action.id];
                return <TimelineBar key={action.id} action={action} trackId={track.id} color={track.color}
                  position={position} runSeconds={runSeconds} px={px} selected={selectedBlocks.has(action.id)} dragging={dragged}
                  status={statusAt(state, playback.time)} title={barTitle(action, state)} {...handlers} />;
              })}
              {track.actions.map((action) => {
                const state = analysis.states[action.id];
                if (!state || state.start === null || state.end === null || state.start <= action.position + 0.001 || view?.ids.has(action.id)) return null;
                return <span key={`actual-${action.id}`} className={timeline.actual} data-action-id={action.id}
                  style={{ left: timeToPx(state.start, px), width: Math.max(3, (state.end - state.start) * px), ["--track-color" as string]: track.color }}
                  title={barTitle(action, state)}><span>実 {state.start.toFixed(1)}s</span></span>;
              })}
              {drop?.trackId === track.id && <div className={timeline.dropPreview} role="status" data-invalid={!drop.preview.ok}
                style={{ left: timeToPx(drop.position, px), width: drop.preview.ok ? Math.max(120, drop.preview.runSeconds * px) : undefined }}>
                {drop.preview.ok ? `＋ ${actionTypeLabel(drop.type)} · ${drop.position.toFixed(1)}秒` : drop.preview.reason}
              </div>}
            </div>
          </div>;
        })}
        <div className={timeline.playhead} style={{ left: LABEL_W + playheadLeft }} aria-hidden="true" data-part="playhead" />
        {view?.match && <div className={timeline.guide} style={{ left: LABEL_W + timeToPx(view.match.time, px) }} data-part="guide">
          <span>{view.match.time.toFixed(2)}s · {view.match.name}</span>
        </div>}
      </div>
    </div>
    {warnings > 0 && <details className={timeline.notes}>
      <summary>計画の確認 · 警告 {analysis.warnings.length} 件 / エラー {analysis.errors.length} 件</summary>
      <ul>
        {analysis.errors.map((text, index) => <li key={`e${index}`}>{text}</li>)}
        {analysis.warnings.map((warning, index) => <li key={`w${index}`}>{warning.message}</li>)}
      </ul>
    </details>}
  </section>;
}
