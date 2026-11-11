import type { Page } from "@playwright/test";
import { cellsOf, seedMap } from "./helpers";

export const act = (id: string, name: string, type: string, position: number, runSeconds: number, extra: Record<string, unknown> = {}) => ({
  id, name, type, position, runSeconds, x: 210, y: 110, yaw: 0, roomId: "r1", targetId: `t-${id}`, text: "", state: "meeting", ...extra,
});
export const track = (id: string, kind: string, name: string, color: string, actions: unknown[], extra: Record<string, unknown> = {}) =>
  ({ id, kind, name, color, muted: false, locked: false, actions, ...extra });
export const room = { id: "r1", name: "会議室", color: "#8d9bff", kind: "room", material: "concrete", cells: cellsOf(2, 2, 50, 28) };

export const timelineMap = (over: { locked?: boolean } = {}) => seedMap({
  rooms: [room],
  tracks: [
    track("rb", "robot", "ロボット 1", "#8d9bff", [
      act("m1", "移動A", "move", 1, 6, { x: 410 }),
      act("m2", "移動B", "move", 9, 4, { x: 610 }),
      act("m3", "移動C", "move", 16, 3, { x: 810 }),
    ], { initial: { x: 110, y: 110, yaw: 0, roomId: "r1" }, robotId: "rb1", robotRole: "cleaning" }),
    track("hm", "human", "人 1", "#58d8ca", [act("h1", "歩く", "move", 2, 5, { y: 310 })],
      { initial: { x: 110, y: 510, yaw: 0, roomId: "r1" }, count: 3 }),
    track("rm", "room", "会議室", "#ffbd70", [act("e1", "会議", "event-start", 4, 8)], { roomId: "r1" }),
    track("ds", "display", "表示", "#ec87c7", [act("s1", "案内", "show", 3, 5, { text: "hi" })], { locked: over.locked ?? true }),
  ],
});

interface SavedAction { id: string; position: number; runSeconds: number }
interface SavedTrack { id: string; locked: boolean; muted: boolean; actions: SavedAction[] }

// The last saved project (what the history API holds), not what the page currently draws.
export async function savedTracks(page: Page): Promise<SavedTrack[]> {
  const res = await page.request.get("/api/scenes/latest");
  return (await res.json()).project.maps[0].tracks;
}
export async function savedAction(page: Page, id: string): Promise<SavedAction> {
  const found = (await savedTracks(page)).flatMap((t) => t.actions).find((a) => a.id === id);
  if (!found) throw new Error(`action ${id} is not saved`);
  return found;
}
