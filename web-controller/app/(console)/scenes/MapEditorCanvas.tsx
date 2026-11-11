"use client";

import { useMemo, useRef, type PointerEvent } from "react";
import { mergedDoors } from "@/scene/equipment";
import { furnitureCells } from "@/scene/floorPlan";
import { cellAt } from "@/scene/grid";
import { hitItem } from "@/scene/mapEditHit";
import type { MapEditSession } from "@/scene/mapEditSession";
import { cellPath, clientToMm, svgY, type Matrix } from "@/scene/mapView";
import { MapStage } from "./MapStage";
import styles from "./mapEditor.module.css";

const DOOR_REACH_PX = 12;
const HIT_REACH_PX = 10;
const MIN_DOOR_REACH_MM = 24;
const MIN_HIT_REACH_MM = 6;

const line = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${svgY(y1)}L${x2} ${svgY(y2)}`;

function Overlay({ session }: { session: MapEditSession }) {
  const map = session.draft();
  const room = map.rooms.find((item) => item.id === session.selectedRoomId());
  const stroke = session.stroke();
  const itemId = session.selectedItemId();
  const plan = map.floorPlan;
  const furniture = plan?.furniture.find((item) => item.id === itemId);
  const wall = plan?.walls?.find((item) => item.id === itemId);
  const zone = plan?.chargingZones?.find((item) => item.id === itemId);
  const door = itemId ? mergedDoors(map).find((item) => item.memberIds.includes(itemId)) : undefined;
  const preview = session.doorPreview();
  const previewClass = stroke?.invalid ? styles.invalid : stroke?.tool === "erase" ? styles.erasePreview : styles.preview;
  return <g className={styles.overlay}>
    {room && room.cells.length > 0 && <path d={cellPath(room.cells)} className={styles.selection} />}
    {stroke && stroke.cells.length > 0 && <path d={cellPath(stroke.cells)} className={previewClass} />}
    {furniture && <path d={cellPath(furnitureCells(furniture))} className={styles.itemSelection} />}
    {wall && <path d={line(wall.x1, wall.y1, wall.x2, wall.y2)} className={styles.itemSelection} />}
    {door && <path d={line(door.opening.x1, door.opening.y1, door.opening.x2, door.opening.y2)} className={styles.itemSelection} />}
    {zone && <rect x={zone.x} y={svgY(zone.y + zone.height)} width={zone.width} height={zone.height} className={styles.itemSelection} />}
    {preview && preview.length > 0 && <path d={preview.map((s) => line(s.x1, s.y1, s.x2, s.y2)).join("")} className={styles.doorPreview} />}
  </g>;
}

export function MapEditorCanvas({ session }: { session: MapEditSession }) {
  const wrap = useRef<HTMLDivElement>(null);
  const draft = session.draft();
  // Tracks and actors would only clutter the layout, and a just-added empty region fails the plan's floor-plan validation.
  const view = useMemo(() => ({ ...draft, tracks: [], rooms: draft.rooms.filter((item) => item.cells.length > 0) }), [draft]);
  const tool = session.tool();

  const locate = (event: PointerEvent<HTMLDivElement>) => {
    const svg = wrap.current?.querySelector("svg");
    const inverse = svg?.getScreenCTM()?.inverse();
    if (!svg || !inverse) return null;
    const mm = clientToMm({ x: event.clientX, y: event.clientY }, inverse as Matrix);
    return { ...mm, cell: cellAt(mm.x, mm.y), mmPerPx: Math.abs(inverse.a) };
  };

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!(event.target as Element).closest("svg")) return;
    const at = locate(event);
    if (!at || at.cell < 0) return;
    if (tool === "select") {
      session.pick(at.cell, hitItem(draft, at.x, at.y, Math.max(MIN_HIT_REACH_MM, HIT_REACH_PX * at.mmPerPx)));
    } else if (tool === "door") {
      session.placeDoorAt(at.x, at.y, Math.max(MIN_DOOR_REACH_MM, DOOR_REACH_PX * at.mmPerPx));
    } else {
      event.currentTarget.setPointerCapture(event.pointerId);
      session.strokeBegin(at.cell);
    }
  };
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = locate(event);
    if (!at) return;
    if (session.stroke()) {
      if (at.cell >= 0) session.strokeMove(at.cell);
    } else if (tool === "door" && event.pointerType === "mouse") {
      session.hoverDoor(at.x, at.y, Math.max(MIN_DOOR_REACH_MM, DOOR_REACH_PX * at.mmPerPx));
    }
  };
  const onUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!session.stroke()) return;
    const at = locate(event);
    session.strokeEnd(at && at.cell >= 0 ? at.cell : undefined);
  };

  return <div ref={wrap} className={styles.canvas} data-tool={tool}
    onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
    onPointerCancel={session.strokeCancel} onLostPointerCapture={session.strokeCancel}>
    <MapStage map={view} time={0} showGrid gridMm={draft.editGridMm} drawing overlay={<Overlay session={session} />} />
  </div>;
}
