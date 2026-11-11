"use client";

import { useEffect, useMemo, useState } from "react";
import { availableTypes } from "@/scene/actionEdit";
import { setRoomProps } from "@/scene/mapEditRegions";
import { compilePlan, samplePlan, type ActionState } from "@/scene/timedPlan";
import { adjustTimeline } from "@/scene/timelineEdit";
import { formatTime } from "@/scene/timelineView";
import {
  actionTypeLabel, addTrack, deleteActions, deleteTrack, duplicateAction, moveTrackBy, setInitialPose, trackKindLabel, updateTrack,
} from "@/scene/trackEdit";
import type { Action, Material, Room, RoomKind, RobotRole, SceneMap, Track } from "@/scene/types";
import consoleStyles from "../console.module.css";
import { EMPTY_SELECTION, type EditorShared, type PlaybackControls } from "./editorTypes";
import { ColorField, Group, SelectField, TextCommit, ToggleButton } from "./MapEditorFields";
import own from "./inspector.module.css";
import styles from "./scenes.module.css";

export interface InspectorProps extends EditorShared {
  playback: PlaybackControls;
  // Opens the S2b map editor dialog (region shape, floor material, furniture).
  onEditMap(): void;
}

const LOCK_REASON = "この行は編集ロック中のため、変更できません。時間軸でロックを解除すると編集できます。";
const KIND_LABELS: Record<RoomKind, string> = { room: "部屋", corridor: "廊下" };
const MATERIAL_OPTIONS: readonly { value: Material; label: string }[] = [
  { value: "wood", label: "木" }, { value: "tile", label: "タイル" },
  { value: "carpet", label: "カーペット" }, { value: "concrete", label: "コンクリート" },
];
const ROLE_OPTIONS: readonly { value: RobotRole; label: string }[] = [
  { value: "cleaning", label: "清掃" }, { value: "security", label: "警備" }, { value: "delivery", label: "配送" },
];
const STATUS_LABELS: Record<ActionState["status"], string> = {
  waiting: "待機", running: "実行中", complete: "完了", blocked: "実行不可", failed: "失敗",
};

interface Ctx extends InspectorProps {
  // Bumped after every attempt so a rejected text field snaps back to the real value.
  rev: number;
  // Applies one edit; a failure becomes the panel's single alert. Resolves true on success.
  run(change: (map: SceneMap) => SceneMap, label: string): boolean;
  fail(message: string): void;
}

const trackSelection = (trackId: string) => ({ trackId, actionId: null, blocks: [], roomId: null });

export function Inspector(props: InspectorProps) {
  const { map, selection } = props;
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => { setError(null); }, [selection]);

  const ctx: Ctx = {
    ...props, rev,
    run: (change, label) => {
      const failure = props.edit(change, label);
      setRev((n) => n + 1);
      setError(failure);
      return failure === null;
    },
    fail: (message) => { setRev((n) => n + 1); setError(message); },
  };

  const room = selection.roomId ? map.rooms.find((item) => item.id === selection.roomId) : undefined;
  const track = selection.trackId ? map.tracks.find((item) => item.id === selection.trackId) : undefined;
  const action = track && selection.actionId ? track.actions.find((item) => item.id === selection.actionId) : undefined;

  let body;
  if (room) body = <RegionPanel key={room.id} ctx={ctx} room={room} />;
  else if (selection.blocks.length > 1) body = <MultiPanel ctx={ctx} />;
  else if (track && action) body = <ActionPanel key={action.id} ctx={ctx} track={track} action={action} />;
  else if (track) body = <TrackPanel key={track.id} ctx={ctx} track={track} />;
  else body = <Guidance />;

  return <aside className={`${consoleStyles.preferenceCard} ${styles.sideCard}`} aria-label="設定">
    <h2>設定</h2>
    <div className={own.body}>
      {error && <p role="alert" className={own.alert}>{error}</p>}
      {body}
    </div>
  </aside>;
}

function Guidance() {
  return <>
    <h3 className={own.title}>順番に、空間をつなぐ。</h3>
    <p className={own.help}>行を追加し、移動やイベントのバーを時間軸に置きます。バーの左端が開始、長さが実行時間です。</p>
    <p className={own.help}>バーは開始時刻と長さのとおりに実行されます。同じ行でバーが重なるときはエラーになります。</p>
    <p className={own.help}>地図をクリックすると領域を、時間軸の行やバーをクリックするとその設定を編集できます。</p>
  </>;
}

function pickInitial(ctx: Ctx, track: Track) {
  const initial = track.initial;
  if (!initial) return;
  ctx.requestPick({
    mode: "initial", kind: track.kind, title: `${track.name} の初期位置`, color: track.color,
    help: "地図をクリックして位置を決め、向きを指定します。「適用」するまで保存されません。",
    value: { x: initial.x, y: initial.y, yaw: initial.yaw, roomId: initial.roomId },
    onSelect: (value) => ctx.edit((map) => setInitialPose(map, track.id, {
      x: value.x, y: value.y, yaw: value.yaw ?? initial.yaw, roomId: value.roomId ?? initial.roomId,
    }), "初期位置の設定"),
  });
}

function initialText(track: Track): string | null {
  const pose = track.initial;
  return pose ? `初期位置 X ${Math.round(pose.x)}mm / Y ${Math.round(pose.y)}mm / 向き ${Math.round(pose.yaw)}°` : null;
}

function RegionPanel({ ctx, room }: { ctx: Ctx; room: Room }) {
  const { map, rev, run, onSelect, onEditMap } = ctx;
  const patch = (change: Partial<Pick<Room, "name" | "kind" | "material" | "color">>, label: string) =>
    run((current) => setRoomProps(current, room.id, change), label);
  const addRoomRow = () => {
    let id = "";
    const ok = run((current) => { const result = addTrack(current, "room", { roomId: room.id }); id = result.trackId; return result.map; }, "部屋の行の追加");
    if (ok) onSelect(trackSelection(id));
  };
  return <>
    <h3 className={own.title}>{room.name}</h3>
    <p className={own.help}>{KIND_LABELS[room.kind]} · {room.cells.length}マス · 地図の領域</p>
    <div className={own.fields}>
      <TextCommit label="領域名" value={room.name} syncKey={rev} onCommit={(name) => patch({ name }, "領域名の変更")} />
      <ColorField label="色" value={room.color} onCommit={(color) => patch({ color }, "領域の色の変更")} />
      <SelectField label="床材" value={room.material} options={MATERIAL_OPTIONS}
        onChange={(material) => patch({ material }, "床材の変更")} />
    </div>
    <Group label="種類">
      {(Object.keys(KIND_LABELS) as RoomKind[]).map((kind) => (
        <ToggleButton key={kind} pressed={room.kind === kind} onClick={() => { if (room.kind !== kind) patch({ kind }, "領域の種類の変更"); }}>
          {KIND_LABELS[kind]}
        </ToggleButton>
      ))}
    </Group>
    <div className={own.actions}>
      <button type="button" className={consoleStyles.primary} onClick={onEditMap}>部屋の形・床材・家具を編集</button>
      <button type="button" className={consoleStyles.secondary} onClick={addRoomRow} disabled={map.tracks.length >= 128}>部屋の行を追加</button>
    </div>
  </>;
}

function MultiPanel({ ctx }: { ctx: Ctx }) {
  const { map, selection, run, fail, onSelect } = ctx;
  const [seconds, setSeconds] = useState("1");
  const blocks = selection.blocks;
  const lockedNames = map.tracks.filter((track) => track.locked && track.actions.some((item) => blocks.includes(item.id))).map((track) => track.name);
  const locked = lockedNames.length > 0;
  const adjust = (duration: boolean) => {
    const amount = Number(seconds);
    if (!seconds.trim() || !Number.isFinite(amount)) { fail("調整する秒数を入力してください。"); return; }
    if (amount === 0) { fail("調整する秒数は 0 以外で入力してください。"); return; }
    run((current) => adjustTimeline(current, [...blocks], duration ? 0 : amount, duration ? amount : 0),
      duration ? "選択したバーの長さを調整" : "選択したバーの開始をずらす");
  };
  return <>
    <h3 className={own.title}>{blocks.length}件のバーを選択中</h3>
    <label className={own.number}>
      <span>まとめて調整する秒数</span>
      <input type="number" step={0.5} value={seconds} disabled={locked} onChange={(event) => setSeconds(event.target.value)} />
    </label>
    <div className={own.actions}>
      <button type="button" className={consoleStyles.secondary} disabled={locked} onClick={() => adjust(false)}>開始をずらす</button>
      <button type="button" className={consoleStyles.secondary} disabled={locked} onClick={() => adjust(true)}>長さを調整</button>
      <button type="button" className={consoleStyles.secondary} onClick={() => onSelect(EMPTY_SELECTION)}>選択を解除</button>
    </div>
    {locked && <p className={own.lock}>{lockedNames.join("、")} は編集ロック中のため、まとめて調整できません。時間軸でロックを解除してください。</p>}
    <p className={own.help}>負の秒数で前へずらす・短くします。Ctrl で追加選択、Shift で行内の範囲選択、選択後のドラッグで一括移動できます。</p>
  </>;
}

function TrackPanel({ ctx, track }: { ctx: Ctx; track: Track }) {
  const { map, rev, run, fail, confirm, onSelect, requestAction } = ctx;
  const locked = track.locked;
  const patch = (change: Parameters<typeof updateTrack>[2], label: string) => run((current) => updateTrack(current, track.id, change), label);
  const index = map.tracks.findIndex((item) => item.id === track.id);
  const commitCount = (text: string) => {
    const count = Number(text.trim());
    if (!text.trim() || !Number.isInteger(count)) { fail("人数は1〜1000の整数で入力してください。"); return; }
    patch({ count }, "人数の変更");
  };
  const remove = async () => {
    const ok = await confirm("行の削除", `「${track.name}」と、その動作 ${track.actions.length} 件を削除します。元に戻せます。`, { danger: true, confirmLabel: "削除する" });
    if (ok && run((current) => deleteTrack(current, track.id), "行の削除")) onSelect(EMPTY_SELECTION);
  };
  const initial = initialText(track);
  return <>
    <h3 className={own.title}>{track.name}</h3>
    <p className={own.help}>{trackKindLabel(track.kind)}の行 · {index + 1} / {map.tracks.length} 本目 · 動作 {track.actions.length} 件</p>
    {locked && <p className={own.lock}>{LOCK_REASON}</p>}
    <div className={own.fields}>
      <TextCommit label="行名" value={track.name} syncKey={rev} disabled={locked} onCommit={(name) => patch({ name }, "行名の変更")} />
      <ColorField label="色" value={track.color} disabled={locked} onCommit={(color) => patch({ color }, "行の色の変更")} />
      {track.kind === "human" && <TextCommit label="人数（人）" value={String(track.count ?? 1)} syncKey={rev} disabled={locked} onCommit={commitCount} />}
      {track.kind === "robot" && <TextCommit label="ロボットID" value={track.robotId ?? ""} syncKey={rev} disabled={locked}
        onCommit={(robotId) => patch({ robotId }, "ロボットIDの変更")} />}
      {track.kind === "room" && <SelectField label="対象の部屋" value={track.roomId ?? ""} disabled={locked}
        options={[...(track.roomId ? [] : [{ value: "", label: "選択してください" }]), ...map.rooms.map((room) => ({ value: room.id, label: room.name }))]}
        onChange={(roomId) => patch({ roomId }, "対象の部屋の変更")} />}
    </div>
    {track.kind === "robot" && <Group label="ロボット種別">
      {ROLE_OPTIONS.map((option) => (
        <ToggleButton key={option.value} pressed={(track.robotRole ?? "cleaning") === option.value} disabled={locked}
          onClick={() => { if ((track.robotRole ?? "cleaning") !== option.value) patch({ robotRole: option.value }, "ロボット種別の変更"); }}>
          {option.label}
        </ToggleButton>
      ))}
    </Group>}
    {initial && <section className={own.section}>
      <p className={own.summary}>{initial}</p>
      <div className={own.actions}>
        <button type="button" className={consoleStyles.secondary} disabled={locked} onClick={() => pickInitial(ctx, track)}>初期位置を設定</button>
      </div>
    </section>}
    <section className={own.section} aria-label="動作の追加">
      <h4 className={own.sectionTitle}>動作の追加</h4>
      <div className={own.actions}>
        {availableTypes(track).map((type) => (
          <button key={type} type="button" className={consoleStyles.secondary} disabled={locked}
            onClick={() => requestAction({ trackId: track.id, actionId: null, type })}>＋ {actionTypeLabel(type)}</button>
        ))}
      </div>
    </section>
    <section className={own.section} aria-label="行の操作">
      <div className={own.actions}>
        <button type="button" className={consoleStyles.secondary} disabled={locked} onClick={() => run((current) => moveTrackBy(current, track.id, -1), "行を上へ")}>↑ 上へ</button>
        <button type="button" className={consoleStyles.secondary} disabled={locked} onClick={() => run((current) => moveTrackBy(current, track.id, 1), "行を下へ")}>↓ 下へ</button>
        <button type="button" className={`${consoleStyles.secondary} ${own.danger}`} disabled={locked} onClick={remove}>行を削除</button>
      </div>
    </section>
  </>;
}

function ActionPanel({ ctx, track, action }: { ctx: Ctx; track: Track; action: Action }) {
  const { map, playback, run, confirm, onSelect, requestAction } = ctx;
  const locked = track.locked;
  const plan = useMemo(() => compilePlan(map), [map]);
  const state = samplePlan(plan, playback.time).actionStates[action.id];
  const robot = track.kind === "robot";
  const initial = initialText(track);
  const duplicate = () => {
    let id = "";
    const ok = run((current) => { const result = duplicateAction(current, action.id); id = result.actionId; return result.map; }, "動作の複製");
    if (ok) onSelect({ trackId: track.id, actionId: id, blocks: [id], roomId: null });
  };
  const remove = async () => {
    const ok = await confirm("動作の削除", `「${action.name}」を削除します。元に戻せます。`, { danger: true, confirmLabel: "削除する" });
    if (ok && run((current) => deleteActions(current, [action.id]), "動作の削除")) onSelect(trackSelection(track.id));
  };
  return <>
    <h3 className={own.title}>{action.name}</h3>
    <p className={own.summary}>{actionTypeLabel(action.type)} · {track.name}</p>
    {state && <section className={own.section} aria-label="状態">
      <p className={own.summary}>状態: {STATUS_LABELS[state.status]}</p>
      {state.start === null || state.end === null
        ? <p className={own.help}>{state.reason || "実行不可: 通行・行内の重複・行の除外を確認してください。"}</p>
        : <p className={own.help}>模擬開始 {formatTime(state.start)} / 完了 {formatTime(state.end)}{state.reason ? ` · ${state.reason}` : ""}</p>}
    </section>}
    {locked && <p className={own.lock}>{LOCK_REASON}</p>}
    <div className={own.actions}>
      <button type="button" className={consoleStyles.primary} disabled={locked} onClick={() => requestAction({ trackId: track.id, actionId: action.id })}>
        {robot ? "シーケンスを一括設定" : "アクションを編集"}
      </button>
      {initial && <button type="button" className={consoleStyles.secondary} disabled={locked} onClick={() => pickInitial(ctx, track)}>初期位置を設定</button>}
      <button type="button" className={consoleStyles.secondary} disabled={locked} onClick={duplicate}>複製</button>
      <button type="button" className={`${consoleStyles.secondary} ${own.danger}`} disabled={locked} onClick={remove}>削除</button>
      <button type="button" className={consoleStyles.secondary} onClick={() => onSelect(trackSelection(track.id))}>行の設定</button>
    </div>
    {initial && <p className={own.help}>{initial}</p>}
  </>;
}
