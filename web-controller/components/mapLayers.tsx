import { type ReactNode } from "react";
import { layoutCues, CUE_ROUTE_STROKE_MM, CUE_STROKE_MM, type CueShape } from "@/scene/cueLayout";
import { mergedDoors } from "@/scene/equipment";
import { roomAnchor } from "@/scene/floorPlan";
import { MAP_COLORS } from "@/scene/mapColors";
import {
  ROBOT_SIDE_MM, VIEW_HEIGHT, VIEW_WIDTH, cellPath, displayLayout, doorLayout, furnitureLayout, gridLines, headingArrow, svgAngle, svgY, textMm,
} from "@/scene/mapView";
import type { RoomActivity, SceneActor, SceneDisplay, SceneEvent, ScenePlan } from "@/scene/timedPlan";
import type { Material, SceneMap } from "@/scene/types";
import { HUMAN_RADIUS_MM, SAFETY_RADIUS_MM } from "@/scene/units";

// The map's SVG layers, shared by the editor's stage and the exhibit screen so both draw the same floor, doors and cues.

const MATERIALS: readonly Material[] = ["wood", "tile", "carpet", "concrete"];
const WALL_MM = 4;
const DOOR_LEAF_MM = 3;
const ARROW_TIP_MM = 56;
const ARROW_HEAD_MM = 16;
const CUE_INK = "#121923";
const NOTICE_FILL = "#101922";
const CAR_BODY = "#263d55";
const ACTIVITY_COLOR = MAP_COLORS.safetyCircle;

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

function CueText({ shape }: { shape: CueShape }) {
  const { text, color } = shape;
  return (
    <text x={text.x} y={text.y} fill={color} fontSize={text.size} fontWeight={700} stroke={CUE_INK} strokeWidth={text.size / 4.5} paintOrder="stroke">
      {text.lines.map((line, i) => <tspan key={i} x={text.x} dy={i === 0 ? 0 : text.lineHeight}>{line}</tspan>)}
    </text>
  );
}

function Cue({ shape }: { shape: CueShape }) {
  if (shape.kind === "notice") {
    return (
      <g data-scenario-cue="notice" pointerEvents="none">
        <rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={5} fill={NOTICE_FILL} opacity={0.9} stroke={shape.color} />
        <CueText shape={shape} />
      </g>
    );
  }
  if (shape.kind === "route") {
    return (
      <g data-scenario-cue="route" pointerEvents="none">
        <polyline points={shape.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={shape.color}
          strokeWidth={CUE_ROUTE_STROKE_MM} strokeDasharray="11 7" opacity={0.8} />
        {shape.arrows.map((arrow, i) => (
          <path key={i} d="M-15 -9L0 0L-15 9" fill="none" stroke={shape.color} strokeWidth={CUE_ROUTE_STROKE_MM}
            transform={`translate(${arrow.x} ${arrow.y}) rotate(${arrow.angle})`} />
        ))}
        <CueText shape={shape} />
      </g>
    );
  }
  return (
    <g data-scenario-cue={shape.kind} pointerEvents="none">
      <rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={8} fill={shape.color} fillOpacity={0.2}
        stroke={shape.color} strokeWidth={CUE_STROKE_MM} strokeDasharray={shape.dashed ? "8 5" : undefined} />
      {shape.marks.map((mark, i) => mark.shape === "cross"
        ? <path key={i} d={`M${mark.x - mark.r} ${mark.y}h${2 * mark.r}M${mark.x} ${mark.y - mark.r}v${2 * mark.r}`} stroke={shape.color} strokeWidth={2} />
        : <circle key={i} cx={mark.x} cy={mark.y} r={mark.r} fill={shape.color} opacity={0.75} />)}
      {shape.body && <rect x={shape.body.x} y={shape.body.y} width={shape.body.width} height={shape.body.height} rx={14}
        fill={CAR_BODY} stroke={shape.color} strokeWidth={3} />}
      <CueText shape={shape} />
    </g>
  );
}

export interface MapBodyScene {
  actors: readonly SceneActor[];
  displays: readonly SceneDisplay[];
  events: readonly SceneEvent[];
  doors: readonly { id: string; openness: number }[];
}

export interface MapBodyProps {
  map: SceneMap;
  scene: MapBodyScene;
  time: number;
  scale: number;
  showGrid?: boolean;
  gridMm?: number;
  // The editor shows the planned routes and the robot bodies; the exhibit shows neither (the robots are physically there).
  plan?: ScenePlan;
  drawRobots?: boolean;
  roomActivities?: readonly RoomActivity[];
  // Notices start this far from each side of the map.
  noticeInset?: number;
  overlay?: ReactNode;
}

export function MapBody({ map, scene, time, scale, showGrid = false, gridMm = 20, plan, drawRobots = true, roomActivities = [], noticeInset = 0, overlay }: MapBodyProps) {
  const openness = new Map(scene.doors.map((door) => [door.id, door.openness]));
  const floorPlan = map.floorPlan;
  const cues = layoutCues(map.presentation, time, scale, noticeInset);
  return (
    <>
      <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={MAP_COLORS.roomKind.corridor} />
      <Floor map={map} />
      {scene.events.map((event) => {
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
      {plan && <Paths plan={plan} />}
      {scene.actors.filter((actor) => drawRobots || actor.kind !== "robot").map((actor) => <Actor key={actor.id} actor={actor} scale={scale} />)}
      {floorPlan?.showRoomLabels && map.rooms.filter((room) => room.cells.length).map((room) => {
        const at = roomAnchor(room);
        return <text key={room.id} x={at.x} y={svgY(at.y)} textAnchor="middle" fontSize={textMm(12, scale)} fill={MAP_COLORS.wall}>{room.name}</text>;
      })}
      {roomActivities.map((activity) => {
        const room = map.rooms.find((r) => r.id === activity.roomId);
        const at = room?.cells.length ? roomAnchor(room) : null;
        return at ? <Label key={`activity-${activity.roomId}`} text={activity.text} x={at.x} y={at.y} scale={scale} color={ACTIVITY_COLOR} /> : null;
      })}
      {scene.displays.map((display) => (
        <Label key={display.actionId} text={display.text} x={display.x} y={display.y} scale={scale} color={display.color} />
      ))}
      {scene.events.filter((event) => event.text).map((event) => {
        const room = map.rooms.find((r) => r.id === event.roomId);
        const at = room?.cells.length ? roomAnchor(room) : null;
        return at ? <Label key={event.actionId} text={event.text} x={at.x} y={at.y} scale={scale} color={event.color} /> : null;
      })}
      {cues.map((shape, i) => <Cue key={i} shape={shape} />)}
      {overlay}
    </>
  );
}
