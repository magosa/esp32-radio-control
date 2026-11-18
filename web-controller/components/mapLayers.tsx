import { useId, type ReactNode } from "react";
import { layoutCues, CUE_ROUTE_STROKE_MM, CUE_STROKE_MM, type CueShape } from "@/scene/cueLayout";
import { mergedDoors } from "@/scene/equipment";
import { roomAnchor } from "@/scene/floorPlan";
import { MAP_COLORS } from "@/scene/mapColors";
import { wallSegments } from "@/scene/navigation";
import {
  ROBOT_SIDE_MM, VIEW_HEIGHT, VIEW_WIDTH, WAYPOINT_RADIUS_MM, axisTicks, cellPath, displayLayout, doorLayout, furnitureLayout, gridLines,
  headingArrow, humanGroupLayout, moveMarkers, svgAngle, svgY, textMm, type Point,
} from "@/scene/mapView";
import type { SceneSelection } from "@/scene/sceneSelection";
import type { RoomActivity, SceneActor, SceneDisplay, SceneEvent, ScenePlan } from "@/scene/timedPlan";
import type { DisplayTemplate, Material, SceneMap } from "@/scene/types";
import { SAFETY_RADIUS_MM } from "@/scene/units";

// The map's SVG layers, shared by the editor's stage and the exhibit screen so both draw the same floor, doors and cues.

const MATERIALS: readonly Material[] = ["wood", "tile", "carpet", "concrete"];
const WALL_MM = 4;
const DOOR_PANEL_DEPTH_MM = 6;
const ARROW_TIP_MM = 56;
const ARROW_HEAD_MM = 16;
const CUE_INK = "#121923";
const NOTICE_FILL = "#101922";
const CAR_BODY = "#263d55";
const ACTIVITY_COLOR = MAP_COLORS.safetyCircle;

function Floor({ map }: { map: SceneMap }) {
  return (
    <g>
      <defs>
        <pattern id="wood-pattern" patternUnits="userSpaceOnUse" width="40" height="40">
          <rect width="40" height="40" fill="#c2a983" />
          <line x1="0" y1="8" x2="40" y2="8" stroke="#b39977" strokeWidth="1" opacity="0.4" />
          <line x1="0" y1="16" x2="40" y2="16" stroke="#b39977" strokeWidth="1" opacity="0.3" />
          <line x1="0" y1="24" x2="40" y2="24" stroke="#b39977" strokeWidth="1" opacity="0.4" />
          <line x1="0" y1="32" x2="40" y2="32" stroke="#b39977" strokeWidth="1" opacity="0.3" />
        </pattern>
        <pattern id="tile-pattern" patternUnits="userSpaceOnUse" width="40" height="40">
          <rect width="40" height="40" fill="#dbe3df" />
          <line x1="0" y1="40" x2="40" y2="40" stroke="#c5cfc4" strokeWidth="1" />
          <line x1="40" y1="0" x2="40" y2="40" stroke="#c5cfc4" strokeWidth="1" />
          <circle cx="20" cy="20" r="8" fill="none" stroke="#b8bfbb" strokeWidth="0.5" opacity="0.5" />
        </pattern>
        <pattern id="carpet-pattern" patternUnits="userSpaceOnUse" width="6" height="6">
          <rect width="6" height="6" fill="#718796" />
          <circle cx="2" cy="2" r="1" fill="#6a7a8a" opacity="0.3" />
          <circle cx="5" cy="4" r="1" fill="#6a7a8a" opacity="0.3" />
        </pattern>
        <pattern id="concrete-pattern" patternUnits="userSpaceOnUse" width="20" height="20">
          <rect width="20" height="20" fill="#bfc9c8" />
          <rect x="0" y="0" width="10" height="10" fill="#b5bfbe" opacity="0.3" />
          <rect x="10" y="10" width="10" height="10" fill="#b5bfbe" opacity="0.3" />
          <circle cx="8" cy="8" r="1.5" fill="#a5afae" opacity="0.2" />
          <circle cx="15" cy="15" r="1.5" fill="#a5afae" opacity="0.2" />
        </pattern>
      </defs>
      {MATERIALS.map((material) => {
        const cells = map.rooms.filter((room) => room.material === material).flatMap((room) => room.cells);
        const patternId = {
          wood: "url(#wood-pattern)",
          tile: "url(#tile-pattern)",
          carpet: "url(#carpet-pattern)",
          concrete: "url(#concrete-pattern)",
        }[material];
        return cells.length ? <path key={material} d={cellPath(cells)} fill={patternId} /> : null;
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
          <g key={item.id} data-furniture-id={item.id} transform={`translate(${l.x} ${l.y}) rotate(${l.rotation})`}>
            {item.type === "plant"
              ? <ellipse rx={l.width / 2} ry={l.height / 2} fill={MAP_COLORS.furniture.plant} stroke={MAP_COLORS.wall} strokeWidth={1} />
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
  const clipPrefix = useId();
  return (
    <g>
      {mergedDoors(map).map((door, index) => {
        const l = doorLayout(door.opening);
        const open = Math.max(0, Math.min(1, openness.get(door.id) ?? 0));
        const clipId = `${clipPrefix}-door-${index}`;
        const glassId = `${clipId}-glass`;
        return (
          <g key={door.id} data-door-id={door.id} data-door-kind={door.kind ?? "automatic"}
            transform={`translate(${l.x} ${l.y}) rotate(${l.rotate})`}>
            <defs>
              <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
                <rect x={0} y={-DOOR_PANEL_DEPTH_MM / 2} width={l.length} height={DOOR_PANEL_DEPTH_MM} />
              </clipPath>
              <linearGradient id={glassId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#518eaa" stopOpacity={0.8} />
                <stop offset="0.22" stopColor="#ffffff" stopOpacity={0.9} />
                <stop offset="0.4" stopColor="#b9e8f4" stopOpacity={0.45} />
                <stop offset="0.8" stopColor="#a4dbea" stopOpacity={0.55} />
                <stop offset="1" stopColor="#518eaa" stopOpacity={0.8} />
              </linearGradient>
            </defs>
            <line x1={0} y1={0} x2={l.length} y2={0} stroke={MAP_COLORS.wall} strokeWidth={1} strokeDasharray="2 2" />
            <g data-part="door-leaf" data-material="glass" data-openness={open} clipPath={`url(#${clipId})`}
              fill={`url(#${glassId})`} fillOpacity={0.75} stroke="none">
              <rect data-part="door-panel-start" x={0} y={-DOOR_PANEL_DEPTH_MM / 2} width={l.length / 2} height={DOOR_PANEL_DEPTH_MM}
                transform={`translate(${-l.length * open / 2} 0)`} />
              <rect data-part="door-panel-end" x={l.length / 2} y={-DOOR_PANEL_DEPTH_MM / 2} width={l.length / 2} height={DOOR_PANEL_DEPTH_MM}
                transform={`translate(${l.length * open / 2} 0)`} />
            </g>
            <path d={`M0 -3v6M${l.length} -3v6`} fill="none" stroke={MAP_COLORS.wall} strokeWidth={1} />
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

function Paths({ plan, scale, selectedActionId }: { plan: ScenePlan; scale: number; selectedActionId?: string | null }) {
  const lines = plan.entries.flatMap((entry) => entry.segments.filter((s) => s.from.x !== s.to.x || s.from.y !== s.to.y).map((s) =>
    `M${s.from.x} ${svgY(s.from.y)}L${s.to.x} ${svgY(s.to.y)}`));
  const markers = moveMarkers(plan);
  const font = textMm(10, scale);
  return (
    <g data-part="planned-paths">
      <path d={lines.join("")} fill="none" stroke={MAP_COLORS.path} strokeWidth={2} strokeDasharray="6 4" strokeLinecap="round" opacity={0.75} />
      {markers.map((m) => {
        const picked = selectedActionId === m.actionId;
        return (
          <g key={m.actionId} data-part="waypoint-marker" data-action-id={m.actionId} transform={`translate(${m.x} ${svgY(m.y)})`}>
            {picked && <circle r={WAYPOINT_RADIUS_MM + 5} fill="none" stroke="#ffd166" strokeWidth={3} />}
            <circle r={WAYPOINT_RADIUS_MM} fill={m.color} stroke={MAP_COLORS.robotOutline} strokeWidth={1.5} opacity={0.92} />
            <text y={font * 0.35} textAnchor="middle" fontSize={font} fontWeight={700} fill={MAP_COLORS.robotOutline}>{m.label}</text>
          </g>
        );
      })}
    </g>
  );
}

function AxisOverlay({ scale }: { scale: number }) {
  const { xs, ys } = axisTicks();
  const font = textMm(10, scale);
  return (
    <g data-part="axis-labels" pointerEvents="none" opacity={0.75}>
      {xs.map((x) => (
        <text key={`ax-${x}`} x={Math.min(VIEW_WIDTH - 18, Math.max(18, x))} y={VIEW_HEIGHT - 6}
          textAnchor="middle" fontSize={font} fill={MAP_COLORS.wall}>{x}</text>
      ))}
      {ys.filter((y) => y > 0).map((y) => (
        <text key={`ay-${y}`} x={8} y={Math.max(font + 4, svgY(y) + font * 0.35)}
          textAnchor="start" fontSize={font} fill={MAP_COLORS.wall}>{y}</text>
      ))}
    </g>
  );
}

export function HumanFigure({ fill, stroke, count = 1, position }: {
  fill: string; stroke: string; count?: number; position: Point;
}) {
  const layout = humanGroupLayout(count, position);
  const left = layout.x - position.x - layout.width / 2;
  const top = position.y - layout.y - layout.height / 2;
  return <g data-part="human-figure">
    <rect x={left} y={top} width={layout.width} height={layout.height} fill="transparent" />
    {Array.from({ length: count }, (_, index) => <g key={index} data-part="human-person"
      transform={`translate(${left + (index % layout.columns + 0.5) * layout.step} ${top + (Math.floor(index / layout.columns) + 0.5) * layout.step}) scale(${layout.step / 32})`}
      fill={fill} stroke={stroke} strokeWidth={1.5} strokeLinejoin="round">
      <circle cy={-7} r={5} />
      <path d="M-11 12V9a11 9 0 0 1 22 0v3Z" />
    </g>)}
  </g>;
}

function Actor({ actor, selected }: { actor: SceneActor; selected?: boolean }) {
  const at = `translate(${actor.x} ${svgY(actor.y)})`;
  if (actor.kind === "human") {
    const layout = humanGroupLayout(actor.count, actor);
    return (
      <g transform={at} data-actor-id={actor.id} data-selected={selected || undefined}>
        {selected && <rect x={layout.x - actor.x - layout.width / 2 - 4} y={actor.y - layout.y - layout.height / 2 - 4}
          width={layout.width + 8} height={layout.height + 8} rx={6} fill="none" stroke="#ffd166" strokeWidth={3} data-part="selected-actor" />}
        <HumanFigure fill={actor.color} stroke={MAP_COLORS.wall} count={actor.count} position={actor} />
      </g>
    );
  }
  const arrow = headingArrow(actor.yaw, ARROW_TIP_MM, ARROW_HEAD_MM);
  const half = ROBOT_SIDE_MM / 2;
  return (
    <g transform={at} data-actor-id={actor.id} data-selected={selected || undefined}>
      {selected && <circle r={SAFETY_RADIUS_MM + 8} fill="none" stroke="#ffd166" strokeWidth={3.5} data-part="selected-actor" />}
      <circle r={SAFETY_RADIUS_MM} fill="none" stroke={MAP_COLORS.safetyCircle} strokeWidth={1.5} strokeDasharray="5 4" />
      <rect x={-half} y={-half} width={ROBOT_SIDE_MM} height={ROBOT_SIDE_MM} rx={4} transform={`rotate(${svgAngle(actor.yaw)})`}
        fill={MAP_COLORS.robotBody} stroke={MAP_COLORS.robotOutline} strokeWidth={2} />
      <path d={`M0 0L${arrow.tip.x} ${arrow.tip.y}M${arrow.barbs[0].x} ${arrow.barbs[0].y}L${arrow.tip.x} ${arrow.tip.y}L${arrow.barbs[1].x} ${arrow.barbs[1].y}`}
        fill="none" stroke={MAP_COLORS.robotOutline} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

export function MapLabel({ text, x, y, scale, color, template = "label" }: {
  text: string; x: number; y: number; scale: number; color: string; template?: DisplayTemplate;
}) {
  const font = textMm(14, scale);
  const box = displayLayout(text, font, { x, y });
  const top = svgY(box.y) - box.height / 2;
  return (
    <g data-display-template={template}>
      <rect x={box.x - box.width / 2} y={top} width={box.width} height={box.height} rx={template === "sign" ? box.height / 2 : font / 3}
        fill={template === "card" ? "#f8fafc" : template === "sign" ? "#1d4ed8" : MAP_COLORS.robotOutline}
        stroke={color} strokeWidth={1.5} opacity={0.95} />
      {template === "card" && <path d={`M${box.x - box.width / 2 + 3} ${top + font / 3}V${top + box.height - font / 3}`}
        stroke={color} strokeWidth={3} />}
      {box.lines.map((line, i) => (
        <text key={i} x={box.x} y={top + font * 0.5 + box.lineHeight * (i + 0.8)} textAnchor="middle" fontSize={font}
          fill={template === "card" ? "#0f172a" : template === "sign" ? "#ffffff" : MAP_COLORS.wall}>{line}</text>
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
  showPaths?: boolean;
  showAxis?: boolean;
  showRoomLabels?: boolean;
  showRoomBoundaries?: boolean;
  selection?: SceneSelection;
  gridMm?: number;
  // The editor shows the planned routes and the robot bodies; the exhibit shows neither (the robots are physically there).
  plan?: ScenePlan;
  drawRobots?: boolean;
  roomActivities?: readonly RoomActivity[];
  // Notices start this far from each side of the map.
  noticeInset?: number;
  overlay?: ReactNode;
}

export function MapBody({
  map, scene, time, scale, showGrid = false, showPaths = true, showAxis = false, showRoomLabels = false, showRoomBoundaries = false, selection,
  gridMm = 20, plan, drawRobots = true, roomActivities = [], noticeInset = 0, overlay,
}: MapBodyProps) {
  const openness = new Map(scene.doors.map((door) => [door.id, door.openness]));
  const floorPlan = map.floorPlan;
  const doors = mergedDoors(map);
  const cues = layoutCues(map.presentation, time, scale, noticeInset);
  const selectedRoom = selection?.roomId ? map.rooms.find((r) => r.id === selection.roomId) : undefined;
  return (
    <>
      <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={MAP_COLORS.roomKind.corridor} />
      <Floor map={map} />
      {selectedRoom && selectedRoom.cells.length > 0 && (
        <path d={cellPath(selectedRoom.cells)} fill="none" stroke="#ffd166" strokeWidth={5} data-part="selected-room" />
      )}
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
      <g data-part="floor-walls" stroke={MAP_COLORS.wall} strokeWidth={WALL_MM} strokeLinecap="square">
        {(floorPlan?.walls ?? []).flatMap((wall) => wallSegments(wall, doors).map((segment, index) => (
          <line key={`${wall.id}-${index}`} x1={segment.x1} y1={svgY(segment.y1)} x2={segment.x2} y2={svgY(segment.y2)} />
        )))}
      </g>
      <Doors map={map} openness={openness} />
      {showRoomBoundaries && (
        <g stroke="#8884aa" strokeWidth={1.5} opacity={0.6} strokeDasharray="4 2">
          {map.rooms.map((room) => room.cells.length > 0 ? (
            <path key={`boundary-${room.id}`} d={cellPath(room.cells)} fill="none" />
          ) : null)}
        </g>
      )}
      {showGrid && <Grid gridMm={gridMm} />}
      <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="none" stroke={MAP_COLORS.wall} strokeWidth={WALL_MM} />
      {plan && showPaths && <Paths plan={plan} scale={scale} selectedActionId={selection?.actionId} />}
      {scene.actors.filter((actor) => drawRobots || actor.kind !== "robot").map((actor) => (
        <Actor key={actor.id} actor={actor} selected={selection?.trackId === actor.id} />
      ))}
      {(showRoomLabels || floorPlan?.showRoomLabels) && map.rooms.filter((room) => room.cells.length).map((room) => {
        const at = roomAnchor(room);
        return <text key={room.id} x={at.x} y={svgY(at.y)} textAnchor="middle" fontSize={textMm(12, scale)} fill={MAP_COLORS.wall}>{room.name}</text>;
      })}
      {roomActivities.map((activity) => {
        const room = map.rooms.find((r) => r.id === activity.roomId);
        const at = room?.cells.length ? roomAnchor(room) : null;
        return at ? <MapLabel key={`activity-${activity.roomId}`} text={activity.text} x={at.x} y={at.y} scale={scale} color={ACTIVITY_COLOR} /> : null;
      })}
      {scene.displays.map((display) => (
        <MapLabel key={display.actionId} text={display.text} x={display.x} y={display.y} scale={scale} color={display.color}
          template={display.displayTemplate} />
      ))}
      {scene.events.filter((event) => event.text).map((event) => {
        const room = map.rooms.find((r) => r.id === event.roomId);
        const at = room?.cells.length ? roomAnchor(room) : null;
        return at ? <MapLabel key={event.actionId} text={event.text} x={at.x} y={at.y} scale={scale} color={event.color} /> : null;
      })}
      {cues.map((shape, i) => <Cue key={i} shape={shape} />)}
      {showAxis && <AxisOverlay scale={scale} />}
      {overlay}
    </>
  );
}
