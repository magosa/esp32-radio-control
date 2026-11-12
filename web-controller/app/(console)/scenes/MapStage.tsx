"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { MapBody } from "@/components/mapLayers";
import { snapToEditGrid } from "@/scene/grid";
import {
  VIEW_BOX, ZOOMS, clampToArea, clientToMm, isTap, mapSummary, pxPerMm, zoomWidth, type Matrix, type ZoomId,
} from "@/scene/mapView";
import { compilePlan, samplePlan, type ScenePlan } from "@/scene/timedPlan";
import type { SceneMap } from "@/scene/types";
import { type EditGridMm } from "@/scene/units";
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
  const firstError = plan.errors[0];

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
          <MapBody map={map} scene={state} time={time} scale={scale} showGrid={showGrid} gridMm={gridMm} plan={plan} overlay={overlay} />
        </svg>
      </div>
      {firstError && <p className={styles.status} role="status">計画エラー: {firstError}</p>}
    </div>
  );
}
