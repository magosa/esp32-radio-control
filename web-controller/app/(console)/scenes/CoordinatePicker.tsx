"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AlertTriangle, X } from "lucide-react";
import { constrainAxis, pickPoint, pickProblem, pickRoom } from "@/scene/coordinatePick";
import { shortcutAction } from "@/scene/editorShortcuts";
import { roomAnchor } from "@/scene/floorPlan";
import { ROBOT_SIDE_MM, cellPath, clientToMm, headingArrow, isTap, svgAngle, svgY, type Matrix, type Point } from "@/scene/mapView";
import type { CoordinateMode, SceneMap, TrackKind } from "@/scene/types";
import { HUMAN_RADIUS_MM } from "@/scene/units";
import consoleStyles from "../console.module.css";
import type { PickRequest, PickValue } from "./editorTypes";
import { MapStage } from "./MapStage";
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
const MARKER_HIT_PX = 22;
const ARROW_TIP_MM = 56;
const ARROW_HEAD_MM = 16;
const ROOM_HINT = "対象の部屋・廊下の内部をクリックしてください。";
const DEFAULT_HELP: Record<PickRequest["mode"], string> = {
  move: "マップでは何度でも選び直せます。",
  initial: "マップでは何度でも選び直せます。向きは数値で指定します。",
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
  following: boolean;
}

function Marker({ spot, mode, kind, color, yaw, invalid, following }: MarkerProps) {
  const arrow = headingArrow(Number.isFinite(yaw) ? yaw : 0, ARROW_TIP_MM, ARROW_HEAD_MM);
  const half = ROBOT_SIDE_MM / 2;
  return <g transform={`translate(${spot.x} ${svgY(spot.y)})`} data-testid="picker-marker" data-invalid={invalid ? "true" : "false"}>
    {following && <circle r={MARKER_HIT_MM + 6} className={styles.ring} />}
    {mode === "initial" && (kind === "human"
      ? <circle r={HUMAN_RADIUS_MM} fill={color} className={styles.body} />
      : <rect x={-half} y={-half} width={ROBOT_SIDE_MM} height={ROBOT_SIDE_MM} rx={4}
        transform={`rotate(${svgAngle(Number.isFinite(yaw) ? yaw : 0)})`} fill={color} className={styles.body} />)}
    {mode === "initial" && Number.isFinite(yaw) && <path className={styles.arrow}
      d={`M0 0L${arrow.tip.x} ${arrow.tip.y}M${arrow.barbs[0].x} ${arrow.barbs[0].y}L${arrow.tip.x} ${arrow.tip.y}L${arrow.barbs[1].x} ${arrow.barbs[1].y}`} />}
    {mode !== "initial" && <circle r={14} className={styles.dot} />}
    <path d={`M${-MARKER_MM} 0H${MARKER_MM}M0 ${-MARKER_MM}V${MARKER_MM}`} className={styles.cross} />
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
  // Upstream measures the axis lock from the point the picker opened with.
  const origin = useRef<Point>({ x: finite(request.value.x), y: finite(request.value.y) }).current;
  const cursor = useRef<Point | null>(null);
  const down = useRef<Point | null>(null);

  // An empty region would fail the plan's floor-plan validation, and the layout looks clearer without the other rows.
  const checked = useMemo(() => ({ ...map, rooms: map.rooms.filter((room) => room.cells.length > 0) }), [map]);
  const view = useMemo(() => ({ ...checked, tracks: [] }), [checked]);

  const [coordinateMode, setCoordinateMode] = useState<CoordinateMode>(request.value.coordinateMode ?? "grid");
  const [spot, setSpot] = useState<Spot>(() => ({ ...origin, roomId: pickPoint(checked, origin, "free").roomId }));
  const [following, setFollowing] = useState(request.value.coordinateMode === "free");
  const [yawText, setYawText] = useState(() => String(finite(request.value.yaw)));
  const [roomId, setRoomId] = useState(request.value.roomId ?? "");
  const [roomHint, setRoomHint] = useState("");
  const [applyError, setApplyError] = useState<{ key: string; text: string } | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  const yaw = mode === "initial" ? (yawText.trim() ? Number(yawText) : Number.NaN) : undefined;
  const room = mode === "room" ? checked.rooms.find((item) => item.id === roomId) : undefined;
  const problem = useMemo(() => {
    if (mode === "room") return "";
    return pickProblem(checked, kind, spot, yaw);
  }, [checked, kind, mode, spot, yaw]);
  const blocked = mode === "room" ? !room : problem !== "";
  const notice = mode === "room" ? (roomHint || (room ? "" : ROOM_HINT)) : problem ? `指定できません: ${problem}` : "";

  const anchor: Point = room ? roomAnchor(room) : spot;
  const output: PickValue = mode === "room"
    ? { x: anchor.x, y: anchor.y, roomId, ...(request.value.coordinateMode ? { coordinateMode: request.value.coordinateMode } : {}) }
    : { x: spot.x, y: spot.y, roomId: spot.roomId, coordinateMode, ...(mode === "initial" ? { yaw } : {}) };
  const outputKey = JSON.stringify(output);
  const shownError = applyError && applyError.key === outputKey ? applyError.text : null;

  const locate = (clientX: number, clientY: number) => {
    const svg = canvas.current?.querySelector("svg");
    const inverse = svg?.getScreenCTM()?.inverse();
    if (!svg || !inverse) return null;
    return { mm: clientToMm({ x: clientX, y: clientY }, inverse as Matrix), mmPerPx: Math.abs(inverse.a) };
  };

  const freePoint = (mm: Point, shift: boolean): Spot => {
    const point = pickPoint(checked, mm, "free");
    return shift ? pickPoint(checked, constrainAxis(origin, point), "free") : point;
  };

  const chooseMode = (next: CoordinateMode) => {
    setCoordinateMode(next);
    if (next === "grid") {
      setFollowing(false);
      setSpot((current) => pickPoint(checked, current, "grid"));
    } else {
      setFollowing(true);
    }
  };

  const onTap = (event: PointerEvent<HTMLDivElement>) => {
    const at = locate(event.clientX, event.clientY);
    if (!at) return;
    if (mode === "room") {
      const hit = pickRoom(checked, at.mm);
      if (hit) { setRoomId(hit.roomId); setRoomHint(""); } else setRoomHint(ROOM_HINT);
      return;
    }
    if (coordinateMode === "grid") { setSpot(pickPoint(checked, at.mm, "grid")); return; }
    // A finger has no hover to follow, so a tap places the point directly.
    if (following || event.pointerType === "touch") {
      setSpot(freePoint(at.mm, event.shiftKey));
      setFollowing(false);
    } else if (Math.hypot(at.mm.x - spot.x, at.mm.y - spot.y) <= Math.max(MARKER_HIT_MM, MARKER_HIT_PX * at.mmPerPx)) {
      setFollowing(true);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    down.current = (event.target as Element).closest("svg") ? { x: event.clientX, y: event.clientY } : null;
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = down.current;
    down.current = null;
    // A drag is a scroll of the zoomed map, not a pick.
    if (start && isTap(start, { x: event.clientX, y: event.clientY })) onTap(event);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" || !(event.target as Element).closest("svg")) return;
    cursor.current = { x: event.clientX, y: event.clientY };
    if (mode === "room" || coordinateMode !== "free" || !following) return;
    const at = locate(event.clientX, event.clientY);
    if (at) setSpot(freePoint(at.mm, event.shiftKey));
  };

  const followWithShift = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Shift" || !cursor.current || mode === "room" || coordinateMode !== "free" || !following) return;
    const at = locate(cursor.current.x, cursor.current.y);
    if (at) setSpot(freePoint(at.mm, event.shiftKey));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    followWithShift(event);
    if (!shortcutAction(event.nativeEvent)) return;
    event.preventDefault();
    // The page behind the dialog listens on window for the same keys.
    event.stopPropagation();
  };

  const apply = () => {
    if (blocked) return;
    const result = request.onSelect(output);
    if (typeof result === "string") setApplyError({ key: outputKey, text: result || "適用できませんでした。" });
    else onClose();
  };

  const status = mode === "room"
    ? `対象エリア: ${room?.name ?? "未選択"}`
    : `X ${fmt(spot.x)} / Y ${fmt(spot.y)} mm · ${coordinateMode === "grid"
      ? `クリックでグリッド（${map.editGridMm}mm）の中央を指定`
      : following ? "カーソル追従中 · クリックで仮固定 · Shift で水平/垂直" : "仮固定中 · マーカーを再クリックして再指定"}`;
  const color = request.color ?? "#93ead1";

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} tabIndex={-1}
    onKeyDown={onKeyDown} onKeyUp={followWithShift}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className={styles.header}>
      <h2 id={titleId}>{request.title}</h2>
      <button type="button" className={consoleStyles.secondary} onClick={onClose}><X aria-hidden="true" />閉じる</button>
    </header>
    {mode !== "room" && <div className={styles.controls}>
      <div className={styles.modes} role="group" aria-label="座標の指定方法">
        <button type="button" className={styles.toggle} aria-pressed={coordinateMode === "grid"} onClick={() => chooseMode("grid")}>
          グリッド（{map.editGridMm}mm）
        </button>
        <button type="button" className={styles.toggle} aria-pressed={coordinateMode === "free"} onClick={() => chooseMode("free")}>
          自由座標
        </button>
      </div>
      {mode === "initial" && <label className={styles.field}>初期の向き（°）
        <input type="number" inputMode="decimal" step="any" min={-180} max={180} value={yawText} onChange={(event) => setYawText(event.target.value)} />
      </label>}
    </div>}
    <div ref={canvas} className={styles.canvas}
      onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerMove={onPointerMove}
      onPointerLeave={() => { cursor.current = null; }} onPointerCancel={() => { down.current = null; }}>
      <MapStage map={view} time={0} showGrid gridMm={map.editGridMm} overlay={<g className={styles.overlay}>
        {room && <path d={cellPath(room.cells)} className={styles.roomSelection} />}
        {(mode !== "room" || room) && <Marker spot={{ ...anchor, roomId: spot.roomId }} mode={mode} kind={kind} color={color}
          yaw={yaw ?? 0} invalid={mode !== "room" && problem !== ""} following={mode !== "room" && coordinateMode === "free" && following} />}
      </g>} />
    </div>
    <div className={styles.readout}>
      <p role="status" className={styles.status}>{status}</p>
      {notice && <p className={styles.problem}><AlertTriangle aria-hidden="true" />{notice}</p>}
    </div>
    <p className={styles.hint}>{request.help ?? DEFAULT_HELP[mode]}</p>
    <p className={styles.hint}>「適用」で元の画面に戻ります。元の画面でも「適用」を押すまで保存されません。</p>
    {shownError && <p role="alert" className={styles.error}>{shownError}</p>}
    <div className={styles.actions}>
      <button type="button" className={consoleStyles.secondary} onClick={onClose}>キャンセル</button>
      <button type="button" className={consoleStyles.primary} disabled={blocked} onClick={apply}>適用</button>
    </div>
  </dialog>;
}
