"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MapBody } from "@/components/mapLayers";
import { snapToEditGrid } from "@/scene/grid";
import {
  VIEW_BOX, ZOOMS, clampToArea, clientToMm, hitStageItem, isTap, mapSummary, pxPerMm, zoomWidth,
  type Matrix, type Point, type StageHit, type ZoomId,
} from "@/scene/mapView";
import type { SceneSelection } from "@/scene/sceneSelection";
import { samplePlan } from "@/scene/timedPlan";
import type { SceneMap } from "@/scene/types";
import { type EditGridMm } from "@/scene/units";
import styles from "./mapStage.module.css";
import { sceneAnalysis } from "./sceneAnalysis";

export interface MapStageProps {
  map: SceneMap;
  time: number;
  showGrid: boolean;
  showPaths?: boolean;
  showAxis?: boolean;
  showRoomLabels?: boolean;
  showRoomBoundaries?: boolean;
  drawRobots?: boolean;
  selection?: SceneSelection;
  gridMm: EditGridMm;
  onPick?: (p: { x: number; y: number }) => void;
  onStageHit?: (hit: StageHit, doubleClick: boolean) => void;
  onStageContextMenu?: (hit: StageHit, point: Point) => void;
  onStageDrop?: (p: { x: number; y: number }) => void;
  // Drawn inside the SVG above the map, in the SVG's own units (use svgY for y).
  overlay?: ReactNode | ((scale: number) => ReactNode);
  // Single-finger touches draw instead of scrolling; only pinch gestures stay with the browser.
  drawing?: boolean;
  // Where the zoom buttons are drawn. Undefined keeps them above the map; null waits for the slot to exist.
  toolbarSlot?: HTMLElement | null;
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

export function MapStage({
  map, time, showGrid, showPaths = true, showAxis = false, showRoomLabels = false, showRoomBoundaries = false, selection, gridMm,
  onPick, onStageHit, onStageDrop, onStageContextMenu, overlay, drawing, toolbarSlot, drawRobots = false,
}: MapStageProps) {
  const [zoom] = useState<ZoomId>("fit");
  const [cursor, setCursor] = useState<Point | null>(null);
  const [svgRef, scale] = useScale();
  const down = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const { plan } = sceneAnalysis(map);
  const state = useMemo(() => samplePlan(plan, time), [plan, time]);
  const firstError = plan.errors[0];
  const interactive = !!(onPick || onStageHit);

  const toMm = (clientX: number, clientY: number): Point | null => {
    const inverse = svgRef.current?.getScreenCTM()?.inverse();
    return inverse ? clientToMm({ x: clientX, y: clientY }, inverse as Matrix) : null;
  };

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const start = down.current;
    down.current = null;
    if (event.button !== 0 || !interactive || !start || !isTap(start, { x: event.clientX, y: event.clientY })) return;
    const mm = toMm(event.clientX, event.clientY);
    if (!mm) return;
    if (onStageHit) {
      const hit = hitStageItem(map, plan, state, mm, scale, showPaths);
      const now = performance.now();
      const key = hit?.kind === "actor" ? `actor:${hit.trackId}` : "";
      const isDouble = !!key && lastTap.current.key === key && now - lastTap.current.at < 400;
      lastTap.current = isDouble ? { key: "", at: 0 } : { key, at: now };
      onStageHit(hit, isDouble);
      return;
    }
    if (onPick) onPick(clampToArea(snapToEditGrid(mm.x, mm.y, gridMm)));
  };

  const onDoubleClick = (event: MouseEvent<SVGSVGElement>) => {
    if (!onStageHit) return;
    const mm = toMm(event.clientX, event.clientY);
    if (!mm) return;
    const hit = hitStageItem(map, plan, state, mm, scale, showPaths);
    if (hit) onStageHit(hit, true);
  };

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!showAxis) return;
    const mm = toMm(event.clientX, event.clientY);
    if (mm) setCursor({ x: Math.round(mm.x), y: Math.round(mm.y) });
  };

  const onDragOver = (event: DragEvent<SVGSVGElement>) => {
    if (!onStageDrop) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (event: DragEvent<SVGSVGElement>) => {
    if (!onStageDrop) return;
    event.preventDefault();
    const mm = toMm(event.clientX, event.clientY);
    if (!mm) return;
    onStageDrop(clampToArea(snapToEditGrid(mm.x, mm.y, gridMm)));
  };

  const toolbar = (
    <div className={styles.toolbar} role="toolbar" aria-label="表示">
      {showAxis && (
        <span className={styles.coords} data-part="cursor-coords" aria-live="off">
          {cursor ? `X ${cursor.x}mm / Y ${cursor.y}mm` : "X — / Y —"}
        </span>
      )}
    </div>
  );

  return (
    <div className={styles.stage}>
      {toolbarSlot === undefined ? toolbar : toolbarSlot && createPortal(toolbar, toolbarSlot)}
      <div className={drawing ? `${styles.scroll} ${styles.drawing}` : styles.scroll} tabIndex={interactive ? 0 : undefined}>
        <svg ref={svgRef} className={styles.map} viewBox={VIEW_BOX} style={{ width: "100%", height: "100%" }} role="img"
          aria-label={mapSummary(map, { time, actors: state.actors })}
          onPointerMove={showAxis ? onMove : undefined}
          onPointerLeave={showAxis ? () => setCursor(null) : undefined}
          onPointerDown={interactive ? (e) => { down.current = { x: e.clientX, y: e.clientY }; } : undefined}
          onPointerUp={interactive ? pick : undefined}
          onDoubleClick={onStageHit ? onDoubleClick : undefined}
          onContextMenu={onStageContextMenu ? (event) => {
            const point = toMm(event.clientX, event.clientY);
            if (!point) return;
            const hit = hitStageItem(map, plan, state, point, scale, showPaths);
            if (!hit) return;
            event.preventDefault();
            onStageContextMenu(hit, { x: event.clientX, y: event.clientY });
          } : undefined}
          onDragOver={onStageDrop ? onDragOver : undefined}
          onDrop={onStageDrop ? onDrop : undefined}
          onPointerCancel={() => { down.current = null; }}>
          <MapBody map={map} scene={state} time={time} scale={scale} showGrid={showGrid} showPaths={showPaths}
            showAxis={showAxis} showRoomLabels={showRoomLabels} showRoomBoundaries={showRoomBoundaries} selection={selection}             gridMm={gridMm} plan={plan} overlay={typeof overlay === "function" ? overlay(scale) : overlay}
            drawRobots={drawRobots} />
        </svg>
      </div>
      {firstError && <p className={styles.status} role="status">計画エラー: {firstError}</p>}
    </div>
  );
}
