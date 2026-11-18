"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AlertTriangle, X } from "lucide-react";
import { HumanFigure, MapLabel } from "@/components/mapLayers";
import { DISPLAY_TEMPLATE_OPTIONS } from "@/scene/actionEdit";
import { normalizeYaw180, pickPoint, pickProblem, pickRoom } from "@/scene/coordinatePick";
import { shortcutAction } from "@/scene/editorShortcuts";
import { roomAnchor } from "@/scene/floorPlan";
import { MAX_SECONDS } from "@/scene/model";
import { samplePlan } from "@/scene/timedPlan";
import { ROBOT_SIDE_MM, VIEW_HEIGHT, cellPath, clientToMm, headingArrow, isTap, svgAngle, svgY, type Matrix, type Point } from "@/scene/mapView";
import type { DisplayTemplate, SceneMap, TrackKind } from "@/scene/types";
import { HUMAN_RADIUS_MM } from "@/scene/units";
import consoleStyles from "../console.module.css";
import type { PickRequest, PickValue } from "./editorTypes";
import { MapStage } from "./MapStage";
import { sceneAnalysis } from "./sceneAnalysis";
import styles from "./picker.module.css";

export interface CoordinatePickerProps {
  request: PickRequest;
  map: SceneMap;
  onClose(): void;
}

interface Spot extends Point {
  roomId: string;
}

const MARKER_MM = 26;
const MARKER_HIT_MM = 30;
const ARROW_TIP_MM = 56;
const ARROW_HEAD_MM = 16;
const ROOM_HINT = "対象の部屋・廊下の内部をクリックしてください。";
const DEFAULT_HELP: Record<PickRequest["mode"], string> = {
  move: "マーカーをドラッグして位置を調整し、「適用」で確定します。",
  initial: "ロボット・人をドラッグして初期位置を調整します。向きは数値で指定します。",
  room: "マップ上の部屋・廊下の内部をクリックして、対象を選びます。",
};

const finite = (value: number | undefined, fallback = 0) => value !== undefined && Number.isFinite(value) ? value : fallback;
const fmt = (value: number) => (Math.round(value * 10) / 10).toString();

interface MarkerProps {
  spot: Spot;
  mode: PickRequest["mode"];
  kind: TrackKind;
  color: string;
  yaw: number;
  invalid: boolean;
  dragging: boolean;
  display?: PickValue["display"];
  scale: number;
  count?: number;
}

function Marker({ spot, mode, kind, color, yaw, invalid, dragging, display, scale, count }: MarkerProps) {
  const arrow = headingArrow(Number.isFinite(yaw) ? yaw : 0, ARROW_TIP_MM, ARROW_HEAD_MM);
  const half = ROBOT_SIDE_MM / 2;
  return <g transform={`translate(${spot.x} ${svgY(spot.y)})`} className={mode === "room" ? undefined : styles.marker}
    data-testid="picker-marker" data-invalid={invalid ? "true" : "false"} data-dragging={dragging}>
    {mode !== "room" && <circle r={Math.max(MARKER_HIT_MM, kind === "human" ? HUMAN_RADIUS_MM : ROBOT_SIDE_MM / 2)}
      fill="transparent" />}
    {dragging && <circle r={MARKER_HIT_MM + 6} className={styles.ring} />}
    {mode === "initial" && (kind === "human"
      ? (count !== undefined && Number.isInteger(count) && count >= 1 && count <= 1000
        ? <HumanFigure fill={color} stroke="#252038" count={count} position={spot} /> : null)
      : <rect x={-half} y={-half} width={ROBOT_SIDE_MM} height={ROBOT_SIDE_MM} rx={4}
        transform={`rotate(${svgAngle(Number.isFinite(yaw) ? yaw : 0)})`} fill={color} className={styles.body} />)}
    {mode === "initial" && kind !== "human" && Number.isFinite(yaw) && <path className={styles.arrow}
      d={`M0 0L${arrow.tip.x} ${arrow.tip.y}M${arrow.barbs[0].x} ${arrow.barbs[0].y}L${arrow.tip.x} ${arrow.tip.y}L${arrow.barbs[1].x} ${arrow.barbs[1].y}`} />}
    {display && <MapLabel x={0} y={VIEW_HEIGHT} text={display.text} template={display.displayTemplate} color={color} scale={scale} />}
    {mode !== "initial" && !display && <circle r={14} className={styles.dot} />}
    {kind !== "human" && !display && <path d={`M${-MARKER_MM} 0H${MARKER_MM}M0 ${-MARKER_MM}V${MARKER_MM}`} className={styles.cross} />}
    {invalid && <>
      <circle r={MARKER_MM} className={styles.badRing} />
      <path d="M-14 -14L14 14M14 -14L-14 14" className={styles.badCross} />
    </>}
  </g>;
}

export function CoordinatePicker(props: CoordinatePickerProps) {
  return <Picker {...props} />;
}

function Picker({ request, map, onClose }: CoordinatePickerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { mode, kind } = request;
  const origin = useRef<Point>({ x: finite(request.value.x), y: finite(request.value.y) }).current;
  const down = useRef<Point | null>(null);
  const drag = useRef<{ pointerId: number; from: Spot; offset: Point } | null>(null);

  // Exclude the edited row so its marker is not drawn or checked against itself.
  const checked = useMemo(() => ({
    ...map, rooms: map.rooms.filter((room) => room.cells.length > 0),
    tracks: map.tracks.filter((track) => track.id !== request.trackId),
  }), [map, request.trackId]);

  const [spot, setSpot] = useState<Spot>(() => pickPoint(checked, origin, "free"));
  const [dragging, setDragging] = useState(false);
  const [yawText, setYawText] = useState(() => String(finite(request.value.yaw)));
  const [countText, setCountText] = useState(String(request.count ?? 1));
  const [appearText, setAppearText] = useState(String(request.value.appearAt ?? 0));
  const [roomId, setRoomId] = useState(request.value.roomId ?? "");
  const [roomHint, setRoomHint] = useState("");
  const [displayText, setDisplayText] = useState(request.display?.text ?? "");
  const [displayTemplate, setDisplayTemplate] = useState<DisplayTemplate>(request.display?.displayTemplate ?? "label");
  const [applyError, setApplyError] = useState<{ key: string; text: string } | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  const yaw = mode === "initial" ? (yawText.trim() ? Number(yawText) : Number.NaN) : undefined;
  const human = mode === "initial" && kind === "human";
  const appearAt = Number(appearText);
  const validTime = appearText.trim() !== "" && Number.isFinite(appearAt) && appearAt >= 0 && appearAt <= MAX_SECONDS;
  const snapshot = useMemo(() => mode === "initial" && validTime
    ? samplePlan(sceneAnalysis(checked).plan, appearAt) : null, [checked, mode, validTime, appearAt]);
  const view = useMemo(() => mode === "initial" && validTime ? checked : { ...checked, tracks: [] }, [checked, mode, validTime]);
  const count = Number(countText);
  const room = mode === "room" ? checked.rooms.find((item) => item.id === roomId) : undefined;
  const problem = useMemo(() => {
    if (mode === "room") return "";
    if (mode === "initial" && !validTime) return `表示開始は0〜${MAX_SECONDS}秒の有限数で入力してください。`;
    if (human && (!countText.trim() || !Number.isInteger(count) || count < 1 || count > 1000)) return "人数は1〜1000の整数で入力してください。";
    return pickProblem(checked, kind, spot, yaw, snapshot?.actors);
  }, [checked, kind, mode, spot, yaw, human, count, countText, validTime, snapshot]);
  const blocked = mode === "room" ? !room : problem !== "";
  const notice = mode === "room" ? (roomHint || (room ? "" : ROOM_HINT)) : problem ? `指定できません: ${problem}` : "";

  const anchor: Point = room ? roomAnchor(room) : spot;
  const output: PickValue = mode === "room"
    ? { x: anchor.x, y: anchor.y, roomId, ...(request.value.coordinateMode ? { coordinateMode: request.value.coordinateMode } : {}) }
    : { x: spot.x, y: spot.y, roomId: spot.roomId, coordinateMode: "free",
      ...(request.display ? { display: { text: displayText, displayTemplate } } : {}),
      ...(human ? { count } : {}),
      ...(mode === "initial" ? { appearAt } : {}),
      ...(mode === "initial" && yaw !== undefined && Number.isFinite(yaw) ? { yaw: normalizeYaw180(yaw) } : {}) };
  const outputKey = JSON.stringify(output);
  const shownError = applyError && applyError.key === outputKey ? applyError.text : null;

  const locate = (clientX: number, clientY: number) => {
    const svg = canvas.current?.querySelector("svg");
    const inverse = svg?.getScreenCTM()?.inverse();
    if (!svg || !inverse) return null;
    return clientToMm({ x: clientX, y: clientY }, inverse as Matrix);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target as Element;
    if (mode === "room") {
      down.current = target.closest("svg") ? { x: event.clientX, y: event.clientY } : null;
      return;
    }
    if (drag.current || !target.closest('[data-testid="picker-marker"]')) return;
    const at = locate(event.clientX, event.clientY);
    if (!at) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, from: spot, offset: { x: at.x - spot.x, y: at.y - spot.y } };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const at = locate(event.clientX, event.clientY);
    if (at) setSpot(pickPoint(checked, { x: at.x - current.offset.x, y: at.y - current.offset.y }, "free"));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) {
      onPointerMove(event);
      drag.current = null;
      setDragging(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const start = down.current;
    down.current = null;
    if (mode !== "room" || !start || !isTap(start, { x: event.clientX, y: event.clientY })) return;
    const at = locate(event.clientX, event.clientY);
    if (!at) return;
    const hit = pickRoom(checked, at);
    if (hit) { setRoomId(hit.roomId); setRoomHint(""); } else setRoomHint(ROOM_HINT);
  };
  const cancelDrag = () => {
    if (drag.current) setSpot(drag.current.from);
    drag.current = null;
    down.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape" && drag.current) {
      cancelDrag();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!shortcutAction(event.nativeEvent)) return;
    event.preventDefault();
    // The page behind the dialog listens on window for the same keys.
    event.stopPropagation();
  };

  const apply = () => {
    if (blocked || dragging) return;
    const result = request.onSelect(output);
    if (typeof result === "string") setApplyError({ key: outputKey, text: result || "適用できませんでした。" });
    else onClose();
  };

  const status = mode === "room"
    ? `対象エリア: ${room?.name ?? "未選択"}`
    : `X ${fmt(spot.x)} / Y ${fmt(spot.y)} mm · ${dragging ? "ドラッグ中 · 離して位置を決めます" : "マーカーをドラッグして移動 ·「適用」で確定"}`;
  const color = request.color ?? "#93ead1";

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} tabIndex={-1}
    onKeyDown={onKeyDown}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className={styles.header}>
      <h2 id={titleId}>{request.title}</h2>
      <button type="button" className={consoleStyles.secondary} onClick={onClose}><X aria-hidden="true" />閉じる</button>
    </header>
    <div className={mode === "initial" ? styles.workspace : undefined}>
    {mode !== "room" && <div className={styles.controls}>
      {mode === "initial" && <label className={styles.field}>表示開始（秒）
        <input type="number" aria-label="表示開始（秒）" aria-describedby={`${titleId}-time-help`}
          min={0} max={MAX_SECONDS} step="any" value={appearText} onChange={(event) => setAppearText(event.target.value)} />
        <span id={`${titleId}-time-help`}>シーケンス上の時刻。0 は最初から表示</span>
      </label>}
      {human && <label className={styles.field}><span>人数（人）</span>
        <input type="number" min={1} max={1000} step={1} value={countText} onChange={(event) => setCountText(event.target.value)} />
      </label>}
      {request.display && <>
        <label className={styles.field}>表示項目
          <select value={displayTemplate} onChange={(event) => {
            const option = DISPLAY_TEMPLATE_OPTIONS.find((item) => item.value === event.target.value);
            if (option) setDisplayTemplate(option.value);
          }}>
            {DISPLAY_TEMPLATE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className={styles.field}>表示する言葉
          <textarea rows={2} maxLength={500} value={displayText} onChange={(event) => setDisplayText(event.target.value)} />
        </label>
      </>}
      {mode === "initial" && <label className={styles.field}>初期の向き（°）
        <input type="number" inputMode="decimal" step="any" min={-180} max={180} value={yawText} onChange={(event) => setYawText(event.target.value)} />
      </label>}
    </div>}
    <div ref={canvas} className={styles.canvas}
      onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerMove={onPointerMove}
      onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}>
      {mode === "initial" && validTime && <p className={styles.hint}>表示開始 {fmt(appearAt)}秒時点のマップ</p>}
      <MapStage map={view} time={snapshot ? appearAt : 0} drawRobots showGrid={false} drawing={mode !== "room"} gridMm={map.editGridMm} overlay={(scale) => <g className={styles.overlay}>
        {room && <path d={cellPath(room.cells)} className={styles.roomSelection} />}
        {(mode !== "room" || room) && <Marker spot={{ ...anchor, roomId: spot.roomId }} mode={mode} kind={kind} color={color}
          yaw={yaw ?? 0} invalid={mode !== "room" && problem !== ""} dragging={dragging} scale={scale} display={output.display} count={output.count} />}
      </g>} />
    </div>
    </div>
    <div className={styles.readout}>
      <p role="status" className={styles.status}>{status}</p>
      {notice && <p className={styles.problem}><AlertTriangle aria-hidden="true" />{notice}</p>}
    </div>
    <p className={styles.hint}>{request.help ?? DEFAULT_HELP[mode]}</p>
    <p className={styles.hint}>ドラッグ中は保存されません。「適用」で位置を確定し、元の画面に戻ります。</p>
    {shownError && <p role="alert" className={styles.error}>{shownError}</p>}
    <div className={styles.actions}>
      <button type="button" className={consoleStyles.secondary} onClick={onClose}>キャンセル</button>
      <button type="button" className={consoleStyles.primary} disabled={blocked || dragging} onClick={apply}>適用</button>
    </div>
  </dialog>;
}
