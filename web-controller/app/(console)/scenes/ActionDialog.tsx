"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { HumanFigure, MapLabel } from "@/components/mapLayers";
import {
  actionFields, applyUnlockTarget, endTargets, openActionDraft, setMotion, unlockTargets, validateAction, type FieldSpec,
} from "@/scene/actionEdit";
import { pickPoint, pickRoom as resolvePickRoom } from "@/scene/coordinatePick";
import { roomAnchor } from "@/scene/floorPlan";
import { mergedDoors } from "@/scene/equipment";
import { ROBOT_SIDE_MM, VIEW_HEIGHT, cellPath, clientToMm, headingArrow, svgAngle, svgY, type Point } from "@/scene/mapView";
import { actionPreview, type ActionPreview } from "@/scene/timedPlan";
import { actionTypeLabel, addActionToTrack, replaceAction, setInitialPose } from "@/scene/trackEdit";
import type { Action, Pose, SceneMap, Track, TrackKind } from "@/scene/types";
import { AREA_HEIGHT_MM, AREA_WIDTH_MM, SAFETY_RADIUS_MM, normalizeYaw } from "@/scene/units";
import consoleStyles from "../console.module.css";
import type { ActionEditRequest, EditMap, PickRequest, PickValue } from "./editorTypes";
import { ColorField, SelectField, TextCommit, ToggleButton } from "./MapEditorFields";
import { MapStage } from "./MapStage";
import { EditorShell } from "./EditorShell";
import styles from "./editors.module.css";

export interface ActionDialogProps {
  request: ActionEditRequest;
  map: SceneMap;
  edit: EditMap;
  requestPick(request: PickRequest): void;
  onClose(): void;
}

export const messageOf = (error: unknown): string => error instanceof Error ? error.message : "操作を完了できませんでした。";
export const fmt = (value: number): string => Number.isFinite(value) ? String(Math.round(value * 10) / 10) : "—";
export const pickValueOf = (pose: Pose): PickValue => ({
  x: pose.x, y: pose.y, yaw: pose.yaw, roomId: pose.roomId, ...(pose.coordinateMode ? { coordinateMode: pose.coordinateMode } : {}),
});

interface NumberFieldProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number | "any";
  onChange(value: number): void;
}

// Keeps what is typed, so a half-written number is neither lost nor snapped; an empty box reports NaN.
function NumberField({ label, value, min, max, step, onChange }: NumberFieldProps) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : "");
  const editing = useRef(false);
  useEffect(() => { if (!editing.current && Number.isFinite(value)) setText(String(value)); }, [value]);
  return <label className={styles.field}>
    <span>{label}</span>
    <input type="number" inputMode="decimal" value={text} min={min} max={max} step={step ?? "any"}
      onFocus={() => { editing.current = true; }}
      onBlur={() => { editing.current = false; if (Number.isFinite(value)) setText(String(value)); }}
      onChange={(event) => {
        setText(event.target.value);
        onChange(event.target.value === "" ? NaN : Number(event.target.value));
      }} />
  </label>;
}

function TextAreaField({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  return <label className={styles.field}>
    <span>{label}</span>
    <textarea rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
  </label>;
}

const MARK_GRAY = "#64748b";
const MARK_GREEN = "#15803d";
const MARK_RED = "#b91c1c";
const ARROW_TIP_MM = 56;
const ARROW_HEAD_MM = 16;
const CAPTION_MM = 24;
const ROTATION_HANDLE_MM = 100;

export function Marker({ kind, pose, fill, stroke, opacity = 1, count }: {
  kind: TrackKind; pose: { x: number; y: number; yaw: number }; fill: string; stroke: string; opacity?: number; count?: number;
}) {
  const at = `translate(${pose.x} ${svgY(pose.y)})`;
  if (kind === "human") {
    return <g transform={at} opacity={opacity}><HumanFigure fill={fill} stroke={stroke} count={count} position={pose} /></g>;
  }
  const arrow = headingArrow(pose.yaw, ARROW_TIP_MM, ARROW_HEAD_MM);
  const half = ROBOT_SIDE_MM / 2;
  return <g transform={at} opacity={opacity}>
    <circle r={SAFETY_RADIUS_MM} fill="none" stroke={stroke} strokeWidth={1.5} strokeDasharray="5 4" />
    <rect x={-half} y={-half} width={ROBOT_SIDE_MM} height={ROBOT_SIDE_MM} rx={4} transform={`rotate(${svgAngle(pose.yaw)})`}
      fill={fill} stroke={stroke} strokeWidth={2} />
    <path d={`M0 0L${arrow.tip.x} ${arrow.tip.y}M${arrow.barbs[0].x} ${arrow.barbs[0].y}L${arrow.tip.x} ${arrow.tip.y}L${arrow.barbs[1].x} ${arrow.barbs[1].y}`}
      fill="none" stroke={stroke} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
  </g>;
}

export function Caption({ x, y, text }: { x: number; y: number; text: string }) {
  return <text x={x} y={svgY(y) - 52} textAnchor="middle" fontSize={CAPTION_MM} fill="#0f172a" stroke="#ffffff" strokeWidth={5} paintOrder="stroke">{text}</text>;
}

function roomOfAction(map: SceneMap, track: Track, action: Action): string {
  if (action.type === "event-end") {
    return endTargets(map, "event-end").find((target) => target.value === action.targetId)?.roomId ?? action.roomId;
  }
  return action.roomId || track.roomId || "";
}

function ActionOverlay({ map, track, action, preview, scale }: {
  map: SceneMap; track: Track; action: Action; preview: ActionPreview | null; scale: number;
}) {
  const room = (action.type === "event-start" || action.type === "event-end" || action.type === "unlock")
    ? map.rooms.find((item) => item.id === roomOfAction(map, track, action))
    : undefined;
  const color = action.hatchColor ?? track.color;
  const from = preview?.from ?? null;
  const rotating = action.type === "move" && action.motion === "rotate";
  const direction = headingArrow(action.yaw, 1, 0).tip;
  const pivotY = from ? svgY(from.y) : 0;
  const rotationRadius = from ? Math.max(0, Math.min(ROTATION_HANDLE_MM,
    Math.abs(direction.x) > 1e-7 ? (direction.x > 0 ? AREA_WIDTH_MM - 24 - from.x : from.x - 24) / Math.abs(direction.x) : ROTATION_HANDLE_MM,
    Math.abs(direction.y) > 1e-7 ? (direction.y > 0 ? AREA_HEIGHT_MM - 24 - pivotY : pivotY - 24) / Math.abs(direction.y) : ROTATION_HANDLE_MM,
  )) : ROTATION_HANDLE_MM;
  const rotationTip = headingArrow(action.yaw, rotationRadius, 0).tip;
  const bad = !!preview?.geometryProblem;
  const actor = track.kind === "robot" || track.kind === "human";
  const finite = Number.isFinite(action.x) && Number.isFinite(action.y);
  const door = action.type === "door-open" ? mergedDoors(map).find((door) => door.memberIds.includes(action.doorId ?? "")) : undefined;
  return <g className={styles.overlay}>
    {door && <line x1={door.opening.x1} y1={svgY(door.opening.y1)} x2={door.opening.x2} y2={svgY(door.opening.y2)}
      stroke={track.color} strokeWidth={8} />}
    {room && room.cells.length > 0 && <path d={cellPath(room.cells)} fill={color} fillOpacity={action.type === "event-end" ? 0.15 : 0.3} stroke={color} strokeWidth={3} />}
    {actor && from && <Marker kind={track.kind} pose={from} fill="#cbd5e1" stroke={MARK_GRAY} opacity={0.85} count={track.count} />}
    {actor && from && action.type === "move" && !rotating && <Caption x={from.x} y={from.y} text="移動前" />}
    {actor && from && action.type === "move" && !rotating && finite && <>
      <line x1={from.x} y1={svgY(from.y)} x2={action.x} y2={svgY(action.y)} stroke={bad ? MARK_RED : MARK_GREEN} strokeWidth={4} strokeDasharray="10 6" />
      <g className={styles.dragHandle} data-placement-handle="position" data-testid="action-position-handle">
        <title>移動先をドラッグして変更</title>
        <circle cx={action.x} cy={svgY(action.y)} r={SAFETY_RADIUS_MM} fill="transparent" />
        <Marker kind={track.kind} pose={{ x: action.x, y: action.y, yaw: from.yaw }} fill={bad ? "#fecaca" : "#bbf7d0"} stroke={bad ? MARK_RED : MARK_GREEN} count={track.count} />
      </g>
      <Caption x={action.x} y={action.y} text="移動後" />
    </>}
    {actor && from && rotating && Number.isFinite(action.yaw) && <>
      <Marker kind={track.kind} pose={{ x: from.x, y: from.y, yaw: action.yaw }} fill="#bbf7d0" stroke={MARK_GREEN} count={track.count} />
      <Caption x={from.x} y={from.y} text={`回転後 ${fmt(action.yaw)}°`} />
      <g transform={`translate(${from.x} ${svgY(from.y)})`}>
        <circle r={rotationRadius} className={styles.rotationRing} />
        <g transform={`translate(${rotationTip.x} ${rotationTip.y})`}
          className={styles.dragHandle} data-placement-handle="rotation" data-testid="action-rotation-handle">
          <title>丸いハンドルをドラッグして回転</title>
          <circle r={24} className={styles.rotationKnob} />
        </g>
      </g>
    </>}
    {track.kind === "display" && action.type === "show" && finite && <g transform={`translate(${action.x} ${svgY(action.y)})`}
      className={styles.dragHandle} data-placement-handle="position" data-testid="action-position-handle">
      <title>表示位置をドラッグして変更</title>
      <circle r={30} fill="transparent" />
      <MapLabel x={0} y={VIEW_HEIGHT} text={action.text} template={action.displayTemplate} color={track.color} scale={scale} />
      <Caption x={action.x} y={action.y} text="表示位置" />
    </g>}
  </g>;
}

function previewNote(map: SceneMap, track: Track, action: Action, preview: ActionPreview | null): string {
  const from = preview?.from;
  const base = (() => {
    switch (action.type) {
      case "move":
        if (!from) return "出発位置が決まらないため、経路は参考表示です。";
        return action.motion === "rotate"
          ? `回転前 ${fmt(from.yaw)}° → 回転後 ${fmt(action.yaw)}° / ${fmt(action.runSeconds)}秒`
          : `移動前 (X ${fmt(from.x)}, Y ${fmt(from.y)}) → 移動後 (X ${fmt(action.x)}, Y ${fmt(action.y)})`;
      case "wait": return `現在位置で ${fmt(action.runSeconds)}秒待機します。`;
      case "show": return track.kind === "display" ? `X ${fmt(action.x)} / Y ${fmt(action.y)} に表示します。` : "この表示は対象のロボット・人に追従します。";
      case "hide": return "選んだ表示をこの時刻に消します。";
      case "event-start": return `${map.rooms.find((room) => room.id === roomOfAction(map, track, action))?.name ?? "部屋"}で、イベントを発生させます。`;
      case "event-end": return "選んだイベントをこの時刻に終了します。";
      case "unlock": return "このバーの間だけ、対象のドアが接近に反応します。";
      case "door-open": return `開始 ${fmt(action.position)}秒に開き始め、終了 ${fmt(action.position + action.runSeconds)}秒に閉じ始めます。通過中は安全のため閉鎖を待ちます。`;
    }
  })();
  return preview?.warning ? `${base} ${preview.warning}` : base;
}

// Tracks and actors would only clutter the layout, and an empty region fails the plan's floor-plan validation.
function useLayout(layout: SceneMap): SceneMap {
  return useMemo(() => ({ ...layout, tracks: [], rooms: layout.rooms.filter((room) => room.cells.length > 0) }), [layout]);
}

export function PreviewPane({ layout, overlay, note, problem, onPick, drawing = false }: {
  layout: SceneMap;
  overlay: ReactNode | ((scale: number) => ReactNode);
  note?: string;
  problem?: string;
  onPick?: (p: { x: number; y: number }) => void;
  drawing?: boolean;
}) {
  const stageMap = useLayout(layout);
  return <div className={styles.preview}>
    <MapStage map={stageMap} time={0} showGrid={!drawing} drawing={drawing} gridMm={layout.editGridMm} overlay={overlay} onPick={onPick} />
    {note && <p className={styles.note} data-testid="preview-note">{note}</p>}
    {problem && <p className={styles.problem} data-testid="geometry-problem">経路の問題: {problem}</p>}
  </div>;
}

export interface ActionFormProps {
  // The map the action is checked against; for a batch edit it holds the working copy of the row.
  map: SceneMap;
  // The map that is drawn.
  layout: SceneMap;
  track: Track;
  action: Action;
  update(change: (current: Action) => Action): void;
  requestPick(request: PickRequest): void;
}

const DEFAULTS: Record<string, string> = { displayTemplate: "label", hatchStyle: "diagonal" };
type PlacementTarget = { kind: "position"; offset: Point } | { kind: "rotation"; pivot: Point; startAngle: number };

export function ActionForm({ map, layout, track, action, update, requestPick }: ActionFormProps) {
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number; action: Action;
    target: PlacementTarget;
  } | null>(null);
  const finite = [action.x, action.y, action.yaw, action.position, action.runSeconds].every(Number.isFinite);
  const preview = useMemo(() => {
    if (!finite) return null;
    try { return actionPreview(map, track.id, action); } catch { return null; }
  }, [map, track.id, action, finite]);
  const fields = useMemo<FieldSpec[]>(() => {
    try { return actionFields(action, track.kind); } catch { return []; }
  }, [action, track.kind]);

  const change = (patch: Partial<Action>) => { setFieldError(null); update((current) => ({ ...current, ...patch })); };
  const pointerPoint = (event: PointerEvent<HTMLDivElement>) => {
    const inverse = event.currentTarget.querySelector<SVGSVGElement>('svg[role="img"]')?.getScreenCTM()?.inverse();
    return inverse ? clientToMm({ x: event.clientX, y: event.clientY }, inverse) : null;
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current || !event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return;
    const handle = event.target.closest("[data-placement-handle]")?.getAttribute("data-placement-handle");
    const point = pointerPoint(event);
    if (!point) return;
    let target: PlacementTarget;
    if (handle === "position") target = { kind: "position", offset: { x: point.x - action.x, y: point.y - action.y } };
    else if (handle === "rotation" && preview?.from) {
      const pivot = { x: preview.from.x, y: preview.from.y };
      target = { kind: "rotation", pivot, startAngle: Math.atan2(point.y - pivot.y, point.x - pivot.x) * 180 / Math.PI };
    } else return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    drag.current = { pointerId: event.pointerId, action, target };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const point = pointerPoint(event);
    if (!point) return;
    if (current.target.kind === "position") {
      const next = pickPoint(layout, { x: point.x - current.target.offset.x, y: point.y - current.target.offset.y }, "free");
      change({ ...next, coordinateMode: "free" });
    } else {
      const { pivot, startAngle } = current.target;
      if (Math.hypot(point.x - pivot.x, point.y - pivot.y) < 1) return;
      const angle = Math.atan2(point.y - pivot.y, point.x - pivot.x) * 180 / Math.PI;
      change({ yaw: normalizeYaw(current.action.yaw + angle - startAngle) });
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    onPointerMove(event);
    drag.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const cancelDrag = () => {
    const current = drag.current;
    if (current) { setFieldError(null); update(() => current.action); }
    drag.current = null;
    setDragging(false);
  };
  const pickRoom = () => {
    const current = map.rooms.find((room) => room.id === roomOfAction(map, track, action));
    const at = current && current.cells.length > 0 ? roomAnchor(current) : { x: 550, y: 310 };
    requestPick({
      mode: "room", kind: track.kind, title: "対象の領域を選ぶ", help: "イベントを起こす部屋・廊下をマップで選びます。", color: track.color,
      value: { ...at, roomId: current?.id },
      onSelect: (value) => {
        if (!value.roomId) return "部屋・廊下の内側を選んでください。";
        setFieldError(null);
        update((currentAction) => ({ ...currentAction, roomId: value.roomId! }));
        return null;
      },
    });
  };
  const switchMotion = (motion: "linear" | "rotate") => {
    try {
      const next = setMotion(action, motion);
      setFieldError(null);
      update(() => next);
    } catch (error) { setFieldError(messageOf(error)); }
  };

  const raw = (key: string) => (action as unknown as Record<string, unknown>)[key];
  const renderField = (spec: FieldSpec) => {
    switch (spec.kind) {
      case "text":
        return <TextCommit key={spec.key} label={spec.label} value={String(raw(spec.key) ?? "")} syncKey={0}
          onCommit={(text) => change({ [spec.key]: text } as Partial<Action>)} />;
      case "textarea":
        return <TextAreaField key={spec.key} label={spec.label} value={String(raw(spec.key) ?? "")}
          onChange={(text) => change({ [spec.key]: text } as Partial<Action>)} />;
      case "number":
        return <NumberField key={spec.key} label={spec.label} value={Number(raw(spec.key))} min={spec.min} max={spec.max} step={spec.step}
          onChange={(value) => change({ [spec.key]: value, ...(spec.key === "runSeconds" && action.motion === "rotate" ? { rotationSeconds: value } : {}) } as Partial<Action>)} />;
      case "color":
        return <ColorField key={spec.key} label={spec.label} value={String(raw(spec.key) ?? track.color)}
          onCommit={(color) => change({ [spec.key]: color } as Partial<Action>)} />;
      case "select":
        break;
    }
    if (spec.key === "targetId") {
      const targets = endTargets(map, action.type);
      const value = targets.some((target) => target.value === action.targetId) ? action.targetId : "";
      return <SelectField key={spec.key} label={spec.label} value={value}
        options={[{ value: "", label: "対象を選択" }, ...targets.map((target) => ({ value: target.value, label: target.label }))]}
        onChange={(picked) => {
          const target = targets.find((item) => item.value === picked);
          change({ targetId: picked, ...(action.type === "event-end" && target?.roomId ? { roomId: target.roomId } : {}) });
        }} />;
    }
    if (spec.key === "unlockTarget") {
      const targets = unlockTargets(map);
      const current = action.doorId ? `door:${action.doorId}` : action.roomId;
      const value = targets.some((target) => target.value === current) ? current : "";
      return <SelectField key={spec.key} label={spec.label} value={value}
        options={[{ value: "", label: "選択してください" }, ...targets]}
        onChange={(picked) => {
          if (picked === "") return;
          try {
            const next = applyUnlockTarget(action, picked, map);
            setFieldError(null);
            update(() => next);
          } catch (error) { setFieldError(messageOf(error)); }
        }} />;
    }
    return <SelectField key={spec.key} label={spec.label} value={String(raw(spec.key) ?? DEFAULTS[spec.key] ?? "")}
      options={spec.options ?? []} onChange={(picked) => change({ [spec.key]: picked } as Partial<Action>)} />;
  };

  const rotating = action.type === "move" && action.motion === "rotate";
  const roomName = map.rooms.find((room) => room.id === roomOfAction(map, track, action))?.name;
  const onDirectMapPick = action.type === "event-start"
    ? (p: { x: number; y: number }) => {
      const checked = { ...layout, rooms: layout.rooms.filter((room) => room.cells.length > 0) };
      const hit = resolvePickRoom(checked, p);
      if (hit) {
        setFieldError(null);
        update((current) => ({ ...current, roomId: hit.roomId }));
      }
    }
    : undefined;
  return <div className={styles.formGrid}>
    <div className={styles.fields}>
      {fields.slice(0, 1).map(renderField)}
      <NumberField key={`start-${action.id}`} label="開始（秒）" value={action.position} min={0} max={86400} step="any"
        onChange={(value) => change({ position: value })} />
      {action.type === "door-open" && <NumberField label="終了（秒）" value={Math.round((action.position + action.runSeconds) * 1e6) / 1e6} min={0} max={86400} step="any"
        onChange={(value) => change({ runSeconds: Math.round((value - action.position) * 1e6) / 1e6 })} />}
      {action.type === "move" && track.kind === "robot" && <div role="group" aria-label="移動の種類" className={styles.motion}>
        <ToggleButton pressed={!rotating} onClick={() => switchMotion("linear")}>↗ 移動</ToggleButton>
        <ToggleButton pressed={rotating} onClick={() => switchMotion("rotate")}>↻ 回転</ToggleButton>
      </div>}
      {fields.slice(1).map(renderField)}
      {action.type === "move" && !rotating && <div className={styles.pickRow}>
        <span data-testid="target-coords">移動先 X {fmt(action.x)} / Y {fmt(action.y)} mm</span>
        <span className={styles.hint}>プレビューの「移動後」をドラッグして変更</span>
      </div>}
      {action.type === "show" && track.kind === "display" && <div className={styles.pickRow}>
        <span data-testid="target-coords">表示位置 X {fmt(action.x)} / Y {fmt(action.y)} mm</span>
        <span className={styles.hint}>プレビューのマーカーをドラッグして変更</span>
      </div>}
      {action.type === "event-start" && <div className={styles.pickRow}>
        <span data-testid="target-room">対象の領域: {roomName ?? "未選択"}</span>
        <button type="button" className={consoleStyles.secondary} onClick={pickRoom}>領域をマップで選ぶ</button>
      </div>}
      {fieldError && <p className={styles.error} data-testid="field-error">{fieldError}</p>}
    </div>
    <div className={styles.placement} tabIndex={-1} data-dragging={dragging}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag.current) {
          event.preventDefault();
          event.stopPropagation();
          cancelDrag();
        }
      }}>
      <PreviewPane layout={layout} overlay={(scale) => <ActionOverlay map={map} track={track} action={action} preview={preview} scale={scale} />}
        drawing={action.type === "move" || (track.kind === "display" && action.type === "show")}
        note={`${previewNote(map, track, action, preview)}${rotating ? " 丸いハンドルをドラッグして向きを変更します。" : ""}`}
        problem={preview?.geometryProblem} onPick={onDirectMapPick} />
    </div>
  </div>;
}

type Opened = { ok: true; action: Action; needsInitialPose: boolean } | { ok: false; error: string };

function openDraft(map: SceneMap, request: ActionEditRequest): Opened {
  try {
    return { ok: true, ...openActionDraft(map, request.trackId, request.actionId, request.type, request.overrides) };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

export function ActionDialog(props: ActionDialogProps) {
  const [opened] = useState(() => openDraft(props.map, props.request));
  const track = props.map.tracks.find((item) => item.id === props.request.trackId);
  if (!opened.ok || !track) {
    return <EditorShell label="動作を編集" title="動作を編集" dirty={false} error={opened.ok ? "対象の行が見つかりません。" : opened.error} onClose={props.onClose}>
      <p className={styles.empty}>この動作は開けません。内容を確認して閉じてください。</p>
    </EditorShell>;
  }
  return <ActionEditor {...props} track={track} opened={opened} />;
}

function ActionEditor({ request, map, edit, requestPick, onClose, track, opened }: ActionDialogProps & {
  track: Track;
  opened: { action: Action; needsInitialPose: boolean };
}) {
  const [action, setAction] = useState(opened.action);
  const baseline = useRef(JSON.stringify(opened.action));
  const [phase, setPhase] = useState<"initial" | "form">(opened.needsInitialPose ? "initial" : "form");
  const [chosen, setChosen] = useState<Pose | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const askInitialPose = () => {
    const pose = track.initial;
    if (!pose) return;
    requestPick({
      mode: "initial", kind: track.kind, trackId: track.id, title: "初期位置をどこにしますか？", color: track.color,
      help: "マーカーをドラッグして初期位置を決めます。決定すると動作の設定へ進みます。",
      value: pickValueOf(pose),
      onSelect: (value) => {
        const next: Pose = {
          x: value.x, y: value.y, yaw: value.yaw ?? pose.yaw, roomId: value.roomId ?? "",
          ...(value.coordinateMode ? { coordinateMode: value.coordinateMode } : {}),
        };
        const failure = edit((current) => setInitialPose(current, track.id, next), "初期位置の設定");
        if (failure) return failure;
        setChosen(next);
        return null;
      },
    });
  };
  useEffect(() => { if (opened.needsInitialPose) askInitialPose(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The new action starts from the pose just chosen, so it is opened again once the page has the new map.
  useEffect(() => {
    if (!chosen) return;
    const current = map.tracks.find((item) => item.id === track.id)?.initial;
    if (!current || current.x !== chosen.x || current.y !== chosen.y) return;
    const reopened = openDraft(map, request);
    if (reopened.ok) {
      setAction(reopened.action);
      baseline.current = JSON.stringify(reopened.action);
    } else setApplyError(reopened.error);
    setChosen(null);
    setPhase("form");
  }, [chosen, map, request, track.id]);

  const validation = useMemo(() => validateAction(map, track.id, action), [map, track.id, action]);
  const update = (change: (current: Action) => Action) => { setApplyError(null); setAction(change); };

  const apply = () => {
    const check = validateAction(map, track.id, action);
    if (!check.ok) { setApplyError(check.error); return; }
    const failure = request.actionId
      ? edit((current) => replaceAction(current, track.id, action), "動作の編集")
      : edit((current) => {
        const { id: _id, type, ...rest } = action;
        return addActionToTrack(current, track.id, type, rest).map;
      }, "動作の編集");
    if (failure) setApplyError(failure); else onClose();
  };

  const error = applyError ?? (phase === "form" && !validation.ok ? validation.error : null);
  return <EditorShell label="動作を編集" title={`${actionTypeLabel(action.type)} · ${track.name}`}
    dirty={JSON.stringify(action) !== baseline.current} onClose={onClose}
    onApply={phase === "form" ? apply : undefined} applyDisabled={!validation.ok} error={error}
    hint="「適用」まで保存されません。取り消しはページ全体の元に戻すから行えます。">
    {phase === "initial"
      ? <section className={styles.step} data-testid="initial-pose-step">
        <h3>初期位置をどこにしますか？</h3>
        <p>この行の最初の動作を置く前に、初期位置を決める必要があります。</p>
        <button type="button" className={consoleStyles.primary} onClick={askInitialPose}>初期位置をマップで指定</button>
      </section>
      : <ActionForm map={map} layout={map} track={track} action={action} update={update} requestPick={requestPick} />}
  </EditorShell>;
}
