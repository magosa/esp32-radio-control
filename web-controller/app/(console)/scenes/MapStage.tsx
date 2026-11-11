"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { roomAnchor } from "@/scene/floorPlan";
import { mergedDoors } from "@/scene/equipment";
import { snapToEditGrid } from "@/scene/grid";
import { MAP_COLORS } from "@/scene/mapColors";
import {
  ROBOT_SIDE_MM, VIEW_BOX, VIEW_HEIGHT, VIEW_WIDTH, ZOOMS, cellPath, clampToArea, clientToMm, displayLayout, doorLayout,
  furnitureLayout, gridLines, headingArrow, isTap, mapSummary, pxPerMm, svgAngle, svgY, textMm, zoomWidth, type Matrix, type ZoomId,
} from "@/scene/mapView";
import { compilePlan, samplePlan, type SceneActor, type ScenePlan } from "@/scene/timedPlan";
import type { Material, SceneMap } from "@/scene/types";
import { HUMAN_RADIUS_MM, SAFETY_RADIUS_MM, type EditGridMm } from "@/scene/units";
import styles from "./mapStage.module.css";

export interface MapStageProps {
  map: SceneMap;
  time: number;
  showGrid: boolean;
  gridMm: EditGridMm;
  onPick?: (p: { x: number; y: number }) => void;
  // Drawn inside the SVG above the map, in the SVG's own units (use svgY for y).
  overlay?: ReactNode;
  // Single-finger touches draw instead of scrolling; only pinch gestures stay with the browser.
  drawing?: boolean;
}

const MATERIALS: readonly Material[] = ["wood", "tile", "carpet", "concrete"];
const WALL_MM = 4;
const DOOR_LEAF_MM = 3;
const ARROW_TIP_MM = 56;
const ARROW_HEAD_MM = 16;

// Compiled once per map reference so tabs showing the same map share one plan.
const planCache = new WeakMap<SceneMap, ScenePlan>();
function planFor(map: SceneMap): ScenePlan {
  let plan = planCache.get(map);
  if (!plan) {
    plan = compilePlan(map);
    planCache.set(map, plan);
  }
  return plan;
}

function Floor({ map }: { map: SceneMap }) {
  return (
    <g>
      {MATERIALS.map((material) => {
        const cells = map.rooms.filter((room) => room.material === material).flatMap((room) => room.cells);
        return cells.length ? <path key={material} d={cellPath(cells)} fill={MAP_COLORS.floor[material]} /> : null;
      })}
    </g>
  );
}

function Furniture({ map }: { map: SceneMap }) {
  return (
    <g>
      {(map.floorPlan?.furniture ?? []).map((item) => {
        const l = furnitureLayout(item);
        return (
          <g key={item.id} transform={`translate(${l.x} ${l.y}) rotate(${l.rotation})`}>
            {item.type === "plant"
              ? <circle r={Math.min(l.width, l.height) / 2} fill={MAP_COLORS.furniture.plant} stroke={MAP_COLORS.wall} strokeWidth={1} />
              : <rect x={-l.width / 2} y={-l.height / 2} width={l.width} height={l.height} rx={2}
                fill={MAP_COLORS.furniture[item.type]} stroke={MAP_COLORS.wall} strokeWidth={1} />}
            {item.type !== "plant" && (
              <line x1={-l.width / 2} y1={-l.height / 2} x2={l.width / 2} y2={-l.height / 2} stroke={MAP_COLORS.wall} strokeWidth={3} />
            )}
          </g>
        );
      })}
    </g>
  );
}

function Doors({ map, openness }: { map: SceneMap; openness: Map<string, number> }) {
  return (
    <g>
      {mergedDoors(map).map((door) => {
        const l = doorLayout(door.opening);
        const open = Math.max(0, Math.min(1, openness.get(door.id) ?? 0));
        const color = open >= 0.5 ? MAP_COLORS.doorOpen : MAP_COLORS.doorClosed;
        return (
          <g key={door.id} transform={`translate(${l.x} ${l.y}) rotate(${l.rotate})`}>
            <line x1={0} y1={0} x2={l.length} y2={0} stroke={MAP_COLORS.wall} strokeWidth={1} strokeDasharray="2 2" />
            <line x1={0} y1={0} x2={l.length} y2={0} stroke={color} strokeWidth={DOOR_LEAF_MM} strokeLinecap="butt"
              transform={`rotate(${-90 * open})`} />
          </g>
        );
      })}
    </g>
  );
}

function Grid({ gridMm }: { gridMm: number }) {
  const { xs, ys } = gridLines(gridMm);
  const d = xs.map((x) => `M${x} 0V${VIEW_HEIGHT}`).join("") + ys.map((y) => `M0 ${y}H${VIEW_WIDTH}`).join("");
  return <path d={d} stroke={MAP_COLORS.grid} strokeWidth={0.5} fill="none" opacity={0.7} />;
}

function Paths({ plan }: { plan: ScenePlan }) {
  const lines = plan.entries.flatMap((entry) => entry.segments.filter((s) => s.from.x !== s.to.x || s.from.y !== s.to.y).map((s) =>
    `M${s.from.x} ${svgY(s.from.y)}L${s.to.x} ${svgY(s.to.y)}`));
  return <path d={lines.join("")} fill="none" stroke={MAP_COLORS.path} strokeWidth={2} strokeDasharray="6 4" strokeLinecap="round" opacity={0.75} />;
}

function Actor({ actor, scale }: { actor: SceneActor; scale: number }) {
  const at = `translate(${actor.x} ${svgY(actor.y)})`;
  if (actor.kind === "human") {
    return (
      <g transform={at}>
        <circle r={HUMAN_RADIUS_MM} fill={MAP_COLORS.human} stroke={MAP_COLORS.robotOutline} strokeWidth={1.5} />
        {actor.count > 1 && (
          <text y={textMm(8, scale) * 0.35} textAnchor="middle" fontSize={textMm(8, scale)} fill={MAP_COLORS.robotOutline}>{actor.count}</text>
        )}
      </g>
    );
  }
  const arrow = headingArrow(actor.yaw, ARROW_TIP_MM, ARROW_HEAD_MM);
  const half = ROBOT_SIDE_MM / 2;
  return (
    <g transform={at}>
      <circle r={SAFETY_RADIUS_MM} fill="none" stroke={MAP_COLORS.safetyCircle} strokeWidth={1.5} strokeDasharray="5 4" />
      <rect x={-half} y={-half} width={ROBOT_SIDE_MM} height={ROBOT_SIDE_MM} rx={4} transform={`rotate(${svgAngle(actor.yaw)})`}
        fill={MAP_COLORS.robotBody} stroke={MAP_COLORS.robotOutline} strokeWidth={2} />
      <path d={`M0 0L${arrow.tip.x} ${arrow.tip.y}M${arrow.barbs[0].x} ${arrow.barbs[0].y}L${arrow.tip.x} ${arrow.tip.y}L${arrow.barbs[1].x} ${arrow.barbs[1].y}`}
        fill="none" stroke={MAP_COLORS.robotOutline} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

function Label({ text, x, y, scale, color }: { text: string; x: number; y: number; scale: number; color: string }) {
  const font = textMm(14, scale);
  const box = displayLayout(text, font, { x, y });
  const top = svgY(box.y) - box.height / 2;
  return (
    <g>
      <rect x={box.x - box.width / 2} y={top} width={box.width} height={box.height} rx={font / 3}
        fill={MAP_COLORS.robotOutline} stroke={color} strokeWidth={1.5} opacity={0.95} />
      {box.lines.map((line, i) => (
        <text key={i} x={box.x} y={top + font * 0.5 + box.lineHeight * (i + 0.8)} textAnchor="middle" fontSize={font} fill={MAP_COLORS.wall}>{line}</text>
      ))}
    </g>
  );
}

function useScale(): [RefObject<SVGSVGElement>, number] {
  const ref = useRef<SVGSVGElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const svg = ref.current;
    if (!svg || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const box = svg.getBoundingClientRect();
      setScale(pxPerMm(box.width, box.height));
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  return [ref, scale];
}

export function MapStage({ map, time, showGrid, gridMm, onPick, overlay, drawing }: MapStageProps) {
  const [zoom, setZoom] = useState<ZoomId>("fit");
  const [svgRef, scale] = useScale();
  const down = useRef<{ x: number; y: number } | null>(null);
  const plan = planFor(map);
  const state = useMemo(() => samplePlan(plan, time), [plan, time]);
  const openness = useMemo(() => new Map(state.doors.map((door) => [door.id, door.openness])), [state.doors]);
  const firstError = plan.errors[0];
  const floorPlan = map.floorPlan;

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const start = down.current;
    down.current = null;
    const inverse = svgRef.current?.getScreenCTM()?.inverse();
    if (!onPick || !start || !inverse || !isTap(start, { x: event.clientX, y: event.clientY })) return;
    const mm = clientToMm({ x: event.clientX, y: event.clientY }, inverse as Matrix);
    onPick(clampToArea(snapToEditGrid(mm.x, mm.y, gridMm)));
  };

  return (
    <div className={styles.stage}>
      <div className={styles.toolbar} role="toolbar" aria-label="表示倍率">
        {ZOOMS.map((item) => (
          <button key={item.id} type="button" className={styles.zoomButton} aria-pressed={zoom === item.id} onClick={() => setZoom(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className={drawing ? `${styles.scroll} ${styles.drawing}` : styles.scroll} tabIndex={onPick ? 0 : undefined}>
        <svg ref={svgRef} className={styles.map} viewBox={VIEW_BOX} style={{ width: zoomWidth(zoom) }} role="img"
          aria-label={mapSummary(map, { time, actors: state.actors })}
          onPointerDown={onPick ? (e) => { down.current = { x: e.clientX, y: e.clientY }; } : undefined}
          onPointerUp={onPick ? pick : undefined} onPointerCancel={() => { down.current = null; }}>
          <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={MAP_COLORS.roomKind.corridor} />
          <Floor map={map} />
          {state.events.map((event) => {
            const room = map.rooms.find((r) => r.id === event.roomId);
            return room ? <path key={event.actionId} d={cellPath(room.cells)} fill={event.color} opacity={0.3} /> : null;
          })}
          <g>
            {(floorPlan?.chargingZones ?? []).map((zone) => (
              <rect key={zone.id} x={zone.x} y={svgY(zone.y + zone.height)} width={zone.width} height={zone.height}
                fill={MAP_COLORS.charging} fillOpacity={0.35} stroke={MAP_COLORS.charging} strokeWidth={1.5} strokeDasharray="4 3" />
            ))}
          </g>
          <Furniture map={map} />
          <g stroke={MAP_COLORS.wall} strokeWidth={WALL_MM} strokeLinecap="square">
            {(floorPlan?.walls ?? []).map((wall) => (
              <line key={wall.id} x1={wall.x1} y1={svgY(wall.y1)} x2={wall.x2} y2={svgY(wall.y2)} />
            ))}
          </g>
          <Doors map={map} openness={openness} />
          {showGrid && <Grid gridMm={gridMm} />}
          <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="none" stroke={MAP_COLORS.wall} strokeWidth={WALL_MM} />
          <Paths plan={plan} />
          {state.actors.map((actor) => <Actor key={actor.id} actor={actor} scale={scale} />)}
          {floorPlan?.showRoomLabels && map.rooms.filter((room) => room.cells.length).map((room) => {
            const at = roomAnchor(room);
            return <text key={room.id} x={at.x} y={svgY(at.y)} textAnchor="middle" fontSize={textMm(12, scale)} fill={MAP_COLORS.wall}>{room.name}</text>;
          })}
          {state.displays.map((display) => (
            <Label key={display.actionId} text={display.text} x={display.x} y={display.y} scale={scale} color={display.color} />
          ))}
          {state.events.filter((event) => event.text).map((event) => {
            const room = map.rooms.find((r) => r.id === event.roomId);
            const at = room?.cells.length ? roomAnchor(room) : null;
            return at ? <Label key={event.actionId} text={event.text} x={at.x} y={at.y} scale={scale} color={event.color} /> : null;
          })}
          {overlay}
        </svg>
      </div>
      {firstError && <p className={styles.status} role="status">計画エラー: {firstError}</p>}
    </div>
  );
}
