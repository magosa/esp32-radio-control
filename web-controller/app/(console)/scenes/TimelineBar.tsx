"use client";

import { memo, type KeyboardEvent, type PointerEvent } from "react";
import { inkFor, KEY_RESIZE_STEP_S, MAX_RUN_S, MIN_RESIZE_S } from "@/scene/timelineDrag";
import { barBox, formatTime } from "@/scene/timelineView";
import { actionTypeLabel } from "@/scene/trackEdit";
import type { Action } from "@/scene/types";
import styles from "./timeline.module.css";

export type BarStatus = "blocked" | "waiting" | "running" | "complete" | "failed";

// Words, not just colours: a blocked move says so on the bar itself.
export function statusText(status: BarStatus, type: Action["type"]): string {
  if (status === "blocked") return type === "move" ? "通行不可" : "実行不可";
  return { waiting: "待機中", running: "実行中", complete: "完了", failed: "失敗" }[status];
}

export const kindText = (action: Pick<Action, "type" | "motion">): string =>
  action.type === "move" && action.motion === "rotate" ? "向き変更" : actionTypeLabel(action.type);

export interface TimelineBarProps {
  action: Action;
  trackId: string;
  color: string;
  // Live values: while a drag is in progress they differ from the stored action.
  position: number;
  runSeconds: number;
  px: number;
  selected: boolean;
  dragging: boolean;
  status: BarStatus;
  title: string;
  onBarPointerDown(event: PointerEvent<HTMLElement>, trackId: string, actionId: string): void;
  onHandlePointerDown(event: PointerEvent<HTMLElement>, trackId: string, actionId: string): void;
  onOpen(trackId: string, actionId: string): void;
  onDelete(trackId: string, actionId: string): void;
  onResizeKey(trackId: string, actionId: string, delta: number): void;
}

function TimelineBarView(props: TimelineBarProps) {
  const { action, trackId, color, position, runSeconds, px, selected, dragging, status } = props;
  const box = barBox({ position, runSeconds }, px);
  const end = position + runSeconds;
  const state = statusText(status, action.type);
  const label = `${action.name}、${kindText(action)}、${position.toFixed(1)}〜${end.toFixed(1)}秒、${state}`;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter") { event.preventDefault(); props.onOpen(trackId, action.id); }
    else if (event.key === "Delete") { event.preventDefault(); props.onDelete(trackId, action.id); }
  };
  const onHandleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    props.onResizeKey(trackId, action.id, event.key === "ArrowRight" ? KEY_RESIZE_STEP_S : -KEY_RESIZE_STEP_S);
  };

  return <div className={styles.barWrap} data-selected={selected} data-dragging={dragging}
    style={{ left: box.left, width: box.width, ["--bar-ink" as string]: inkFor(color) }}>
    <div className={styles.bar} role="button" tabIndex={0} aria-pressed={selected} aria-label={label} title={props.title}
      data-action-id={action.id} data-status={status} data-type={action.type}
      style={{ background: color, color: inkFor(color) }}
      onPointerDown={(event) => props.onBarPointerDown(event, trackId, action.id)}
      onDoubleClick={() => props.onOpen(trackId, action.id)}
      onKeyDown={onKeyDown}>
      <strong>{action.name}</strong>
      <small>{kindText(action)} · {position.toFixed(1)}〜{end.toFixed(1)}秒</small>
      <span className={styles.meta}>
        <span data-part="length">{runSeconds.toFixed(1)}s</span>
        <span className={styles.state} data-part="status">{state}</span>
      </span>
    </div>
    <div className={styles.handle} role="slider" tabIndex={0} aria-orientation="horizontal"
      aria-label={`${action.name} の長さ`} aria-valuemin={MIN_RESIZE_S} aria-valuemax={MAX_RUN_S}
      aria-valuenow={Number(runSeconds.toFixed(2))} aria-valuetext={`${formatTime(runSeconds)}（${runSeconds.toFixed(1)}秒）`}
      data-action-id={action.id}
      onPointerDown={(event) => props.onHandlePointerDown(event, trackId, action.id)}
      onKeyDown={onHandleKeyDown} />
  </div>;
}

export const TimelineBar = memo(TimelineBarView);
