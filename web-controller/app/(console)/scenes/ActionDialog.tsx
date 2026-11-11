"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  actionFields, applyUnlockTarget, endTargets, openActionDraft, setMotion, unlockTargets, validateAction, type FieldSpec,
} from "@/scene/actionEdit";
import { shortcutAction } from "@/scene/editorShortcuts";
import { roomAnchor } from "@/scene/floorPlan";
import { ROBOT_SIDE_MM, cellPath, headingArrow, svgAngle, svgY } from "@/scene/mapView";
import { actionPreview, type ActionPreview } from "@/scene/timedPlan";
import { actionTypeLabel, addActionToTrack, replaceAction, setInitialPose } from "@/scene/trackEdit";
import type { Action, Pose, SceneMap, Track, TrackKind } from "@/scene/types";
import { HUMAN_RADIUS_MM, SAFETY_RADIUS_MM } from "@/scene/units";
import consoleStyles from "../console.module.css";
import type { ActionEditRequest, EditMap, PickRequest, PickValue } from "./editorTypes";
import { ColorField, SelectField, TextCommit, ToggleButton } from "./MapEditorFields";
import { MapStage } from "./MapStage";
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

export interface EditorShellProps {
  label: string;
  title: string;
  // Unapplied changes: cancelling then asks before discarding.
  dirty: boolean;
  onApply?: () => void;
  applyDisabled?: boolean;
  error?: string | null;
  hint?: string;
  onClose(): void;
  children: ReactNode;
}

// Full-screen modal shared by both editors; the same shape as the S2b map editor dialog.
export function EditorShell({ label, title, dirty, onApply, applyDisabled, error, hint, onClose, children }: EditorShellProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const confirmTitle = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  const requestClose = () => { if (dirty) setConfirming(true); else onClose(); };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    // The page behind the dialog listens on window for undo and redo.
    if (shortcutAction(event.nativeEvent)) event.stopPropagation();
  };

  return <dialog ref={dialog} className={styles.dialog} aria-label={label} onKeyDown={onKeyDown}
    onCancel={(event) => {
      event.preventDefault();
      if (confirming) setConfirming(false); else requestClose();
    }}>
    <header className={styles.header}>
      <h2 className={styles.title}>{title}</h2>
      <div className={styles.actions}>
        <button type="button" className={consoleStyles.secondary} onClick={requestClose}>キャンセル</button>
        {onApply && <button type="button" className={consoleStyles.primary} disabled={applyDisabled} onClick={onApply}>適用</button>}
      </div>
    </header>
    <div className={styles.body}>{children}</div>
    <footer className={styles.footer}>
      {hint && <p className={styles.hint}>{hint}</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </footer>
    {confirming && <div className={styles.confirm} role="alertdialog" aria-labelledby={confirmTitle}>
      <div className={styles.confirmBox}>
        <h3 id={confirmTitle}>適用していない変更があります</h3>
        <p>破棄して閉じますか?</p>
        <div className={styles.actions}>
          <button type="button" className={consoleStyles.primary} autoFocus onClick={() => setConfirming(false)}>編集を続ける</button>
          <button type="button" className={consoleStyles.secondary} onClick={onClose}>破棄して閉じる</button>
        </div>
      </div>
    </div>}
  </dialog>;
}

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

export function Marker({ kind, pose, fill, stroke, opacity = 1 }: {
  kind: TrackKind; pose: { x: number; y: number; yaw: number }; fill: string; stroke: string; opacity?: number;
}) {
  const at = `translate(${pose.x} ${svgY(pose.y)})`;
  if (kind === "human") {
    return <g transform={at} opacity={opacity}><circle r={HUMAN_RADIUS_MM} fill={fill} stroke={stroke} strokeWidth={2} /></g>;
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

function ActionOverlay({ map, track, action, preview }: { map: SceneMap; track: Track; action: Action; preview: ActionPreview | null }) {
  const room = (action.type === "event-start" || action.type === "event-end" || action.type === "unlock")
    ? map.rooms.find((item) => item.id === roomOfAction(map, track, action))
    : undefined;
  const color = action.hatchColor ?? track.color;
  const from = preview?.from ?? null;
  const rotating = action.type === "move" && action.motion === "rotate";
  const bad = !!preview?.geometryProblem;
  const actor = track.kind === "robot" || track.kind === "human";
  const finite = Number.isFinite(action.x) && Number.isFinite(action.y);
  return <g className={styles.overlay}>
    {room && room.cells.length > 0 && <path d={cellPath(room.cells)} fill={color} fillOpacity={action.type === "event-end" ? 0.15 : 0.3} stroke={color} strokeWidth={3} />}
    {actor && from && <Marker kind={track.kind} pose={from} fill="#cbd5e1" stroke={MARK_GRAY} opacity={0.85} />}
    {actor && from && action.type === "move" && !rotating && <Caption x={from.x} y={from.y} text="移動前" />}
    {actor && from && action.type === "move" && !rotating && finite && <>
      <line x1={from.x} y1={svgY(from.y)} x2={action.x} y2={svgY(action.y)} stroke={bad ? MARK_RED : MARK_GREEN} strokeWidth={4} strokeDasharray="10 6" />
      <Marker kind={track.kind} pose={{ x: action.x, y: action.y, yaw: from.yaw }} fill={bad ? "#fecaca" : "#bbf7d0"} stroke={bad ? MARK_RED : MARK_GREEN} />
      <Caption x={action.x} y={action.y} text="移動後" />
    </>}
    {actor && from && rotating && Number.isFinite(action.yaw) && <>
      <Marker kind={track.kind} pose={{ x: from.x, y: from.y, yaw: action.yaw }} fill="#bbf7d0" stroke={MARK_GREEN} />
      <Caption x={from.x} y={from.y} text={`回転後 ${fmt(action.yaw)}°`} />
    </>}
    {track.kind === "display" && action.type === "show" && finite && <g transform={`translate(${action.x} ${svgY(action.y)})`}>
      <circle r={14} fill="#0ea5e9" stroke="#0c4a6e" strokeWidth={3} />
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
    }
  })();
  return preview?.warning ? `${base} ${preview.warning}` : base;
}

// Tracks and actors would only clutter the layout, and an empty region fails the plan's floor-plan validation.
function useLayout(layout: SceneMap): SceneMap {
  return useMemo(() => ({ ...layout, tracks: [], rooms: layout.rooms.filter((room) => room.cells.length > 0) }), [layout]);
}

export function PreviewPane({ layout, overlay, note, problem }: { layout: SceneMap; overlay: ReactNode; note?: string; problem?: string }) {
  const stageMap = useLayout(layout);
  return <div className={styles.preview}>
    <MapStage map={stageMap} time={0} showGrid={false} gridMm={layout.editGridMm} overlay={overlay} />
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

export function ActionForm({ map, layout, track, action, update, requestPick }: ActionFormProps) {
  const [fieldError, setFieldError] = useState<string | null>(null);
  const finite = [action.x, action.y, action.yaw, action.position, action.runSeconds].every(Number.isFinite);
  const preview = useMemo(() => {
    if (!finite) return null;
    try { return actionPreview(map, track.id, action); } catch { return null; }
  }, [map, track.id, action, finite]);
  const fields = useMemo<FieldSpec[]>(() => {
    try { return actionFields(action, track.kind); } catch { return []; }
  }, [action, track.kind]);

  const change = (patch: Partial<Action>) => { setFieldError(null); update((current) => ({ ...current, ...patch })); };
  const withPoint = (current: Action, value: PickValue): Action => {
    const { coordinateMode: _dropped, ...rest } = current;
    return { ...rest, x: value.x, y: value.y, roomId: value.roomId ?? "", ...(value.coordinateMode === "free" ? { coordinateMode: "free" as const } : {}) };
  };

  const pickPoint = (title: string, help: string) => requestPick({
    mode: "move", kind: track.kind, title, help, color: track.color,
    value: { x: action.x, y: action.y, roomId: action.roomId, ...(action.coordinateMode ? { coordinateMode: action.coordinateMode } : {}) },
    onSelect: (value) => { setFieldError(null); update((current) => withPoint(current, value)); return null; },
  });
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
  return <div className={styles.formGrid}>
    <div className={styles.fields}>
      {fields.slice(0, 1).map(renderField)}
      <NumberField key={`start-${action.id}`} label="開始（秒）" value={action.position} min={0} max={86400} step="any"
        onChange={(value) => change({ position: value })} />
      {action.type === "move" && track.kind === "robot" && <div role="group" aria-label="移動の種類" className={styles.motion}>
        <ToggleButton pressed={!rotating} onClick={() => switchMotion("linear")}>↗ 移動</ToggleButton>
        <ToggleButton pressed={rotating} onClick={() => switchMotion("rotate")}>↻ 回転</ToggleButton>
      </div>}
      {fields.slice(1).map(renderField)}
      {action.type === "move" && !rotating && <div className={styles.pickRow}>
        <span data-testid="target-coords">移動先 X {fmt(action.x)} / Y {fmt(action.y)} mm</span>
        <button type="button" className={consoleStyles.secondary}
          onClick={() => pickPoint("移動先を指定", "マップで移動後の位置を決めます。")}>マップで指定</button>
      </div>}
      {action.type === "show" && track.kind === "display" && <div className={styles.pickRow}>
        <span data-testid="target-coords">表示位置 X {fmt(action.x)} / Y {fmt(action.y)} mm</span>
        <button type="button" className={consoleStyles.secondary}
          onClick={() => pickPoint("表示位置を指定", "マップで表示する位置を決めます。")}>マップで指定</button>
      </div>}
      {action.type === "event-start" && <div className={styles.pickRow}>
        <span data-testid="target-room">対象の領域: {roomName ?? "未選択"}</span>
        <button type="button" className={consoleStyles.secondary} onClick={pickRoom}>領域をマップで選ぶ</button>
      </div>}
      {fieldError && <p className={styles.error} data-testid="field-error">{fieldError}</p>}
    </div>
    <PreviewPane layout={layout} overlay={<ActionOverlay map={map} track={track} action={action} preview={preview} />}
      note={previewNote(map, track, action, preview)} problem={preview?.geometryProblem} />
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
      mode: "initial", kind: track.kind, title: "初期位置をどこにしますか？", color: track.color,
      help: "マップで何度でも選び直せます。決定すると動作の設定へ進みます。",
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
