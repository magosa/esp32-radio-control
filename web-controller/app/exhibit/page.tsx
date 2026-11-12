"use client";

import { useEffect, useMemo, useState } from "react";
import { MapBody } from "@/components/mapLayers";
import { useFleetSocket } from "@/hooks/useFleetSocket";
import { alignmentCrosses, EXHIBIT_MAP_OFFSET_Y, EXHIBIT_VIEW_BOX, exhibitScene, nearestCross, type MeasuredPose } from "@/scene/exhibitView";
import { exhibitTime } from "@/scene/exhibitSession";
import { MAP_COLORS } from "@/scene/mapColors";
import { gridLines, svgY, VIEW_HEIGHT, VIEW_WIDTH } from "@/scene/mapView";
import { compilePlan, samplePlan } from "@/scene/timedPlan";
import type { SceneMap, SceneProject } from "@/scene/types";
import { FIELD_HEIGHT_MM, FIELD_WIDTH_MM } from "@/scene/units";
import styles from "./exhibit.module.css";

const POLL_MS = 3000;
// Blank margin around each reference marker, on top of the marker itself, so the picture never competes with it.
const CLEARANCE_MARGIN_MM = 20;
const MAX_CLEARANCE_MM = 300;

function useLatestProject(): SceneProject | null {
  const [project, setProject] = useState<SceneProject | null>(null);
  useEffect(() => {
    let disposed = false;
    let revision = -1;
    const load = async () => {
      try {
        const res = await fetch("/api/scenes/latest", { cache: "no-store" });
        if (res.status !== 200 || disposed) return;
        const record = await res.json();
        if (!disposed && record.revision !== revision) {
          revision = record.revision;
          setProject(record.project as SceneProject);
        }
      } catch { /* the next poll retries */ }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  return project;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let frame = 0;
    const tick = () => { setNow(Date.now()); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return now;
}

function useScale(): number {
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const update = () => setScale(Math.min(window.innerWidth / FIELD_WIDTH_MM, window.innerHeight / FIELD_HEIGHT_MM));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return scale;
}

function useAlign(): boolean {
  const [align, setAlign] = useState(false);
  useEffect(() => {
    setAlign(new URLSearchParams(window.location.search).get("align") === "1");
    const onKey = (event: KeyboardEvent) => { if (event.key === "a" || event.key === "A") setAlign((value) => !value); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return align;
}

// ?clear=<mm> overrides the blank margin around each reference marker (0 turns it off).
function useClearance(markerMm: number): number {
  const [override, setOverride] = useState<number | null>(null);
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("clear");
    const parsed = value === null || value.trim() === "" ? NaN : Number(value);
    setOverride(Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_CLEARANCE_MM ? parsed : null);
  }, []);
  return override ?? markerMm + 2 * CLEARANCE_MARGIN_MM;
}

function Alignment({ poses, scale }: { poses: readonly MeasuredPose[]; scale: number }) {
  const { xs, ys } = gridLines(20);
  const grid = xs.map((x) => `M${x} 0V${VIEW_HEIGHT}`).join("") + ys.map((y) => `M0 ${y}H${VIEW_WIDTH}`).join("");
  const arm = 8;
  const crosses = alignmentCrosses();
  const font = Math.max(10, 14 / Math.max(scale, 0.01));
  return (
    <g data-part="alignment">
      <path d={grid} stroke="#6f8f86" strokeWidth={0.4} fill="none" opacity={0.7} />
      {crosses.map((c) => (
        <path key={`${c.x}-${c.y}`} d={`M${c.x - arm} ${svgY(c.y)}h${2 * arm}M${c.x} ${svgY(c.y) - arm}v${2 * arm}`} stroke="#ffd166" strokeWidth={1.2} />
      ))}
      {poses.map((pose) => {
        const near = nearestCross(pose.x, pose.y);
        return (
          <g key={pose.robotId}>
            <circle cx={pose.x} cy={svgY(pose.y)} r={46} fill="none" stroke="#3de0c2" strokeWidth={1.5} />
            <line x1={pose.x} y1={svgY(pose.y)} x2={near.cross.x} y2={svgY(near.cross.y)} stroke="#3de0c2" strokeWidth={0.8} strokeDasharray="3 2" />
          </g>
        );
      })}
      <g transform={`translate(${FIELD_WIDTH_MM / 2} ${svgY(FIELD_HEIGHT_MM - 70)})`} data-part="alignment-readout">
        <text textAnchor="middle" fontSize={font} fill="#f5f7f2" stroke="#000" strokeWidth={font / 5} paintOrder="stroke">
          {poses.length === 0 ? "位置合わせ: 追跡中のロボットがありません" : "位置合わせ: 実機の測位値と最寄りの十字との差 (mm)"}
        </text>
        {poses.map((pose, i) => {
          const near = nearestCross(pose.x, pose.y);
          const sign = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
          return (
            <text key={pose.robotId} y={(i + 1) * font * 1.3} textAnchor="middle" fontSize={font} fill="#3de0c2" stroke="#000" strokeWidth={font / 5} paintOrder="stroke"
              data-part="alignment-offset">
              {`${pose.robotId}: 十字(${near.cross.x}, ${near.cross.y})  dx ${sign(near.dx)}  dy ${sign(near.dy)}  距離 ${near.distance.toFixed(1)}`}
            </text>
          );
        })}
      </g>
    </g>
  );
}

export default function ExhibitPage() {
  const { exhibit, poseState, runState, status } = useFleetSocket();
  const project = useLatestProject();
  const now = useNow();
  const scale = useScale();
  const align = useAlign();

  const map: SceneMap | null = useMemo(
    () => project?.maps.find((item) => item.id === exhibit?.session.mapId) ?? null, [project, exhibit?.session.mapId]);
  const plan = useMemo(() => (map ? compilePlan(map) : null), [map]);

  const poses: MeasuredPose[] = useMemo(() => (poseState?.poses ?? []).flatMap((pose) =>
    pose.tracking === "tracking" && pose.xMm !== undefined && pose.yMm !== undefined && pose.headingDeg !== undefined
      ? [{ robotId: pose.robotId, x: pose.xMm, y: pose.yMm, yaw: pose.headingDeg }] : []), [poseState]);

  const time = exhibit && plan ? exhibitTime(exhibit.session, now + exhibit.offsetMs, plan.duration) : 0;
  const state = useMemo(() => (plan ? samplePlan(plan, time) : null), [plan, time]);
  const scene = useMemo(() => (map && state ? exhibitScene(state, map, poses) : null), [map, state, poses]);

  const clearance = useClearance(poseState?.field.referenceSizeMm ?? 33);
  const idleText = align || status !== "connected" ? "" : exhibit?.session.mapId && !map ? "展示するマップが見つかりません" : "展示待機中";
  // Small and centred at the bottom, away from the corner markers.
  const runNotice = runState?.state.phase === "halted" ? "全台停止中（調整中です）" : runState?.state.phase === "waiting" ? "ロボットの到着を待っています" : "";

  return (
    <div className={styles.screen} data-state={map ? "playing" : "idle"} data-time={time.toFixed(2)}>
      <svg className={styles.surface} viewBox={EXHIBIT_VIEW_BOX} preserveAspectRatio="xMidYMid meet" role="img" aria-label="展示画面">
        <rect width={FIELD_WIDTH_MM} height={FIELD_HEIGHT_MM} fill="#000" />
        {map && scene && (
          <g transform={`translate(0 ${EXHIBIT_MAP_OFFSET_Y})`}>
            <MapBody map={map} scene={scene} time={time} scale={scale} drawRobots={false} roomActivities={scene.roomActivities} noticeInset={clearance} />
          </g>
        )}
        {align && <Alignment poses={poses} scale={scale} />}
        {[[0, 0], [FIELD_WIDTH_MM - clearance, 0], [0, FIELD_HEIGHT_MM - clearance], [FIELD_WIDTH_MM - clearance, FIELD_HEIGHT_MM - clearance]].map(([x, y]) => (
          <rect key={`${x}-${y}`} data-part="marker-clearance" x={x} y={y} width={clearance} height={clearance} fill="#000" />
        ))}
        {runNotice && (
          <text data-part="run-notice" x={FIELD_WIDTH_MM / 2} y={FIELD_HEIGHT_MM - 12} textAnchor="middle" fontSize={Math.max(10, 14 / Math.max(scale, 0.01))} fill={MAP_COLORS.grid} opacity={0.8}>
            {runNotice}
          </text>
        )}
        {!map && idleText && (
          <text x={FIELD_WIDTH_MM / 2} y={FIELD_HEIGHT_MM / 2} textAnchor="middle" fontSize={Math.max(14, 18 / Math.max(scale, 0.01))} fill={MAP_COLORS.grid} opacity={0.5}>
            {idleText}
          </text>
        )}
      </svg>
    </div>
  );
}
