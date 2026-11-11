"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { availableTypes, setMotion, validateAction } from "@/scene/actionEdit";
import { newAction } from "@/scene/model";
import { actionPreview } from "@/scene/timedPlan";
import { checkSequence, reorderSequence } from "@/scene/timelineEdit";
import { actionTypeLabel, replaceTrack, updateTrack } from "@/scene/trackEdit";
import type { Action, ActionType, Pose, RobotRole, SceneMap, Track } from "@/scene/types";
import { normalizeYaw } from "@/scene/units";
import consoleStyles from "../console.module.css";
import { ActionForm, EditorShell, Marker, PreviewPane, fmt, messageOf, pickValueOf } from "./ActionDialog";
import type { ActionEditRequest, EditMap, PickRequest } from "./editorTypes";
import { SelectField, TextCommit } from "./MapEditorFields";
import styles from "./editors.module.css";

export interface SequenceDialogProps {
  request: ActionEditRequest;
  map: SceneMap;
  edit: EditMap;
  requestPick(request: PickRequest): void;
  onClose(): void;
}

const ROLE_OPTIONS: { value: RobotRole; label: string }[] = [
  { value: "cleaning", label: "清掃" },
  { value: "security", label: "警備" },
  { value: "delivery", label: "配送" },
];
const ROTATE_SECONDS = 1;
const ROTATE_STEP_DEG = 90;

type NewKind = ActionType | "rotate";

const bySequence = (track: Track): Action[] => [...track.actions].sort((a, b) => a.position - b.position);
const endOf = (track: Track): number => Math.max(0, ...track.actions.map((action) => action.position + action.runSeconds));
const isRotation = (action: Action): boolean => action.type === "move" && action.motion === "rotate";
const actionLabel = (action: Action): string => `${isRotation(action) ? "回転" : actionTypeLabel(action.type)} · ${action.name}`;

// Appends to the end of the sequence; "rotate" is the robot-only turn on the spot, a move with motion "rotate".
function addAction(map: SceneMap, track: Track, kind: NewKind, overrides: Partial<Omit<Action, "id" | "type">> = {}): { track: Track; action: Action } {
  let action: Action = { ...newAction(map, track, kind === "rotate" ? "move" : kind), position: endOf(track) };
  if (kind === "rotate") {
    action = setMotion({ ...action, runSeconds: ROTATE_SECONDS }, "rotate");
    action.yaw = normalizeYaw(action.yaw + ROTATE_STEP_DEG);
  }
  action = { ...action, ...structuredClone(overrides) };
  if (action.motion === "rotate" && action.rotationSeconds === undefined) action.rotationSeconds = action.runSeconds;
  return { track: { ...track, actions: [...track.actions, action] }, action };
}

type Opened =
  | { ok: true; track: Track; activeId: string | null; askInitial: boolean; baseline: string }
  | { ok: false; error: string };

function openSequence(map: SceneMap, request: ActionEditRequest): Opened {
  const original = map.tracks.find((item) => item.id === request.trackId);
  if (!original) return { ok: false, error: "編集する行がありません。" };
  if (original.locked) return { ok: false, error: `${original.name} はロックされています。` };
  if (request.actionId !== null && !original.actions.some((item) => item.id === request.actionId)) {
    return { ok: false, error: "編集する動作が見つかりません。" };
  }
  const baseline = JSON.stringify(original);
  let track = structuredClone(original);
  let activeId = request.actionId ?? bySequence(track)[0]?.id ?? null;
  let askInitial = false;
  if (request.type) {
    try {
      const earliest = bySequence(track)[0];
      const added = addAction(map, track, request.type, request.overrides);
      track = added.track;
      activeId = added.action.id;
      askInitial = track.initial !== undefined && (!earliest || added.action.position < earliest.position);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }
  return { ok: true, track, activeId, askInitial, baseline };
}

export function SequenceDialog(props: SequenceDialogProps) {
  const [opened] = useState(() => openSequence(props.map, props.request));
  if (!opened.ok) {
    return <EditorShell label="シーケンスを一括設定" title="シーケンスを一括設定" dirty={false} error={opened.error} onClose={props.onClose}>
      <p className={styles.empty}>この行は開けません。内容を確認して閉じてください。</p>
    </EditorShell>;
  }
  return <SequenceEditor {...props} opened={opened} />;
}

function SequenceEditor({ map, edit, requestPick, onClose, opened }: SequenceDialogProps & {
  opened: { track: Track; activeId: string | null; askInitial: boolean; baseline: string };
}) {
  const [track, setTrack] = useState<Track>(opened.track);
  const [activeId, setActiveId] = useState<string | null>(opened.activeId);
  const [applyError, setApplyError] = useState<string | null>(null);
  const baseline = useRef(opened.baseline);

  const workMap = useMemo<SceneMap>(() => ({ ...map, tracks: map.tracks.map((item) => item.id === track.id ? track : item) }), [map, track]);
  const ordered = useMemo(() => bySequence(track), [track]);
  const action = track.actions.find((item) => item.id === activeId) ?? null;
  const robot = track.kind === "robot";

  const change = (patch: (current: Track) => Track) => { setApplyError(null); setTrack(patch); };
  const guarded = (fn: () => void) => {
    setApplyError(null);
    try { fn(); } catch (error) { setApplyError(messageOf(error)); }
  };

  const pickInitial = () => {
    const pose = track.initial;
    if (!pose) return;
    requestPick({
      mode: "initial", kind: track.kind, title: "初期位置を配置", color: track.color,
      help: "マップで初期位置と向きを決めます。「適用」まで保存されません。",
      value: pickValueOf(pose),
      onSelect: (value) => {
        const next: Pose = {
          x: value.x, y: value.y, yaw: value.yaw ?? pose.yaw, roomId: value.roomId ?? "",
          ...(value.coordinateMode ? { coordinateMode: value.coordinateMode } : {}),
        };
        change((current) => ({ ...current, initial: next }));
        return null;
      },
    });
  };
  useEffect(() => { if (opened.askInitial) pickInitial(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (kind: NewKind) => guarded(() => {
    const added = addAction(workMap, track, kind);
    setTrack(added.track);
    setActiveId(added.action.id);
  });
  const reorder = (id: string, direction: -1 | 1) => guarded(() => {
    const next = structuredClone(track);
    reorderSequence(next, id, direction);
    setTrack(next);
  });
  const remove = (id: string) => {
    const rest = track.actions.filter((item) => item.id !== id);
    change((current) => ({ ...current, actions: current.actions.filter((item) => item.id !== id) }));
    if (activeId === id) setActiveId(bySequence({ ...track, actions: rest })[0]?.id ?? null);
  };
  const updateActive = (patch: (current: Action) => Action) => {
    if (!action) return;
    change((current) => ({ ...current, actions: current.actions.map((item) => item.id === action.id ? patch(item) : item) }));
  };

  const live = useMemo(() => {
    if (!action) return null;
    const check = validateAction(workMap, track.id, action);
    return check.ok ? null : check.error;
  }, [workMap, track.id, action]);

  const apply = () => {
    try {
      const draft = structuredClone(track);
      checkSequence(draft);
      const editing: SceneMap = { ...map, tracks: map.tracks.map((item) => item.id === draft.id ? draft : item) };
      for (const item of bySequence(draft)) {
        if (item.type !== "move") continue;
        const context = actionPreview(editing, draft.id, item);
        if (context.geometryProblem) throw new Error(`${item.name}: ${context.geometryProblem}`);
        if (item.motion === "rotate") item.rotationSeconds = item.runSeconds;
        else if (context.from) item.yaw = context.from.yaw;
      }
      for (const item of bySequence(draft)) {
        const check = validateAction(editing, draft.id, item);
        if (!check.ok) throw new Error(check.error);
      }
      const patch = { name: draft.name, ...(draft.kind === "robot" ? { robotRole: draft.robotRole, robotId: draft.robotId } : {}) };
      const failure = edit((current) => replaceTrack(updateTrack(current, draft.id, patch), draft), "シーケンスの一括設定");
      if (failure) setApplyError(failure); else onClose();
    } catch (error) {
      setApplyError(messageOf(error));
    }
  };

  const error = applyError ?? live;
  const initial = track.initial;
  return <EditorShell label="シーケンスを一括設定" title={`シーケンスを一括設定 · ${track.name}`}
    dirty={JSON.stringify(track) !== baseline.current} onClose={onClose} onApply={apply} error={error}
    hint="作業コピーを編集します。「適用」まで保存されません。↑↓で実行順を入れ替えます。">
    <div className={styles.sequence}>
      <section className={styles.seqMeta} aria-label="行の設定">
        <TextCommit label="名称（120文字まで）" value={track.name} syncKey={0}
          onCommit={(text) => change((current) => ({ ...current, name: text }))} />
        {robot && <SelectField label="ロボット種別" value={track.robotRole ?? "cleaning"} options={ROLE_OPTIONS}
          onChange={(role) => change((current) => ({ ...current, robotRole: role }))} />}
        {robot && <TextCommit label="ロボットID" value={track.robotId ?? ""} syncKey={0}
          onCommit={(text) => change((current) => ({ ...current, robotId: text }))} />}
      </section>
      {initial && <div className={styles.seqInitial}>
        <button type="button" className={consoleStyles.secondary} onClick={pickInitial}>初期位置をマップで配置</button>
        <span data-testid="initial-coords">初期位置 X {fmt(initial.x)} / Y {fmt(initial.y)} / {fmt(initial.yaw)}°</span>
      </div>}
      <div className={styles.seqWorkspace}>
        <div className={styles.seqList}>
          <ul className={styles.seqRows} aria-label="シーケンスの動作">
            {ordered.map((item) => <li key={item.id} className={styles.seqRow} data-active={item.id === activeId}
              data-sequence-action={item.id}>
              <button type="button" className={styles.seqSelect} aria-current={item.id === activeId ? "true" : undefined}
                onClick={() => setActiveId(item.id)}>
                <span>{actionLabel(item)}</span>
                <small>{fmt(item.position)}〜{fmt(item.position + item.runSeconds)}秒</small>
              </button>
              <button type="button" className={styles.seqIcon} aria-label={`${item.name} を前へ`} onClick={() => reorder(item.id, -1)}>↑</button>
              <button type="button" className={styles.seqIcon} aria-label={`${item.name} を後ろへ`} onClick={() => reorder(item.id, 1)}>↓</button>
              <button type="button" className={styles.seqIcon} aria-label={`${item.name} を削除`} onClick={() => remove(item.id)}>削除</button>
            </li>)}
          </ul>
          <div className={styles.seqAdditions} role="group" aria-label="動作を追加">
            {availableTypes(track).flatMap<NewKind>((type) => type === "move" && robot ? ["move", "rotate"] : [type]).map((kind) =>
              <button key={kind} type="button" className={styles.seqAdd} onClick={() => add(kind)}>
                ＋ {kind === "rotate" ? "回転" : actionTypeLabel(kind)}
              </button>)}
          </div>
        </div>
        <div className={styles.seqForm}>
          {action
            ? <ActionForm key={action.id} map={workMap} layout={map} track={track} action={action}
              update={updateActive} requestPick={requestPick} />
            : <PreviewPane layout={map} note="動作を追加し、マップで位置や経路を確認してください。「適用」まで保存されません。"
              overlay={initial && track.kind === "robot"
                ? <g className={styles.overlay}><Marker kind={track.kind} pose={initial} fill={track.color} stroke="#0f172a" /></g>
                : null} />}
        </div>
      </div>
    </div>
  </EditorShell>;
}
