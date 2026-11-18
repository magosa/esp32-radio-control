"use client";

import { useMemo, useRef, type PointerEvent } from "react";
import { mergedDoors } from "@/scene/equipment";
import { furnitureCells } from "@/scene/floorPlan";
import { cellAt } from "@/scene/grid";
import { hitItem } from "@/scene/mapEditHit";
import type { MapEditSession } from "@/scene/mapEditSession";
import { applyMatrix, cellPath, clampToArea, isTap, svgToMm, svgY } from "@/scene/mapView";
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
  const gate = session.gatePreview();
  const previewClass = stroke?.invalid ? styles.invalid : stroke?.tool === "erase" ? styles.erasePreview : styles.preview;
  return <g className={styles.overlay}>
    {room && room.cells.length > 0 && <path d={cellPath(room.cells)} className={styles.selection} />}
    {stroke && stroke.tool !== "gate" && stroke.cells.length > 0 && <path d={cellPath(stroke.cells)} className={previewClass} />}
    {furniture && <path d={cellPath(furnitureCells(furniture))} className={styles.itemSelection} />}
    {wall && <path d={line(wall.x1, wall.y1, wall.x2, wall.y2)} className={styles.itemSelection} />}
    {door && <path d={line(door.opening.x1, door.opening.y1, door.opening.x2, door.opening.y2)} className={styles.itemSelection} />}
    {zone && <rect x={zone.x} y={svgY(zone.y + zone.height)} width={zone.width} height={zone.height} className={styles.itemSelection} />}
    {preview && preview.length > 0 && <path data-part="door-placement-preview" d={preview.map((s) => line(s.x1, s.y1, s.x2, s.y2)).join("")} className={styles.doorPreview} />}
    {gate && <>
      <rect data-part="gate-placement-preview" data-valid={gate.valid} x={gate.bounds.x} y={svgY(gate.bounds.y + gate.bounds.height)}
        width={gate.bounds.width} height={gate.bounds.height} className={gate.valid ? styles.preview : styles.invalid} />
      {gate.valid && <path d={gate.segments.map((s) => line(s.x1, s.y1, s.x2, s.y2)).join("")} className={styles.doorPreview} />}
    </>}
  </g>;
}

export function MapEditorCanvas({ session }: { session: MapEditSession }) {
  const wrap = useRef<HTMLDivElement>(null);
  const click = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const draft = session.draft();
  const mode = session.mode();
  // Tracks and actors would only clutter the layout, and a just-added empty region fails the plan's floor-plan validation.
  const view = useMemo(() => ({ ...draft, tracks: [], rooms: draft.rooms.filter((item) => item.cells.length > 0) }), [draft]);
  const tool = session.tool();

  const locate = (event: PointerEvent<HTMLDivElement>) => {
    const svg = wrap.current?.querySelector<SVGSVGElement>('svg[role="img"]');
    const inverse = svg?.getScreenCTM()?.inverse();
    if (!svg || !inverse) return null;
    const raw = svgToMm(applyMatrix(inverse, event.clientX, event.clientY));
    const mm = clampToArea(raw);
    return { ...mm, inside: cellAt(raw.x, raw.y) >= 0, cell: cellAt(mm.x, mm.y), mmPerPx: Math.abs(inverse.a) };
  };

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!(event.target as Element).closest('svg[role="img"]')) return;
    const at = locate(event);
    if (!at || !at.inside || at.cell < 0) return;
    if (tool === "select") {
      session.pick(at.cell, hitItem(draft, at.x, at.y, Math.max(MIN_HIT_REACH_MM, HIT_REACH_PX * at.mmPerPx)));
    } else if (tool === "door") {
      click.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      session.hoverDoor(at.x, at.y, Math.max(MIN_DOOR_REACH_MM, DOOR_REACH_PX * at.mmPerPx));
    } else {
      event.currentTarget.setPointerCapture(event.pointerId);
      session.strokeBegin(at.cell);
    }
  };
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = locate(event);
    if (!at) return;
    if (session.stroke()) {
      if (at.inside && at.cell >= 0) session.strokeMove(at.cell);
    } else if (tool === "door" || tool === "gate") {
      if (!at.inside || at.cell < 0 || (click.current?.pointerId !== event.pointerId && !(event.target as Element).closest('svg[role="img"]'))) session.clearPlacementPreview();
      else if (tool === "door") session.hoverDoor(at.x, at.y, Math.max(MIN_DOOR_REACH_MM, DOOR_REACH_PX * at.mmPerPx));
      else session.hoverGate(at.x, at.y);
    }
  };
  const onUp = (event: PointerEvent<HTMLDivElement>) => {
    const pending = click.current;
    if (pending?.pointerId === event.pointerId) {
      click.current = null;
      const at = locate(event);
      if (at && at.inside && at.cell >= 0 && tool === "door" && isTap(pending, { x: event.clientX, y: event.clientY })) {
        session.placeDoorAt(at.x, at.y, Math.max(MIN_DOOR_REACH_MM, DOOR_REACH_PX * at.mmPerPx));
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (!session.stroke()) return;
    const at = locate(event);
    if (session.stroke()?.tool === "gate" && (!at || !at.inside || at.cell < 0)) session.strokeCancel();
    else session.strokeEnd(at && at.cell >= 0 ? at.cell : undefined);
  };
  const cancel = () => {
    click.current = null;
    session.strokeCancel();
    if (tool === "door" || tool === "gate") session.clearPlacementPreview();
  };

  return <div ref={wrap} className={styles.canvas} data-tool={tool}
    onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
    onPointerLeave={() => { if (!session.stroke() && (tool === "door" || tool === "gate")) session.clearPlacementPreview(); }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}>
    <MapStage map={view} time={0} showGrid showRoomLabels showRoomBoundaries={mode === "zoning"} gridMm={draft.editGridMm} drawing overlay={<Overlay session={session} />} />
  </div>;
}
