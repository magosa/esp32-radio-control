import type { SceneMap } from "./types";

// What the timeline, inspector and dialogs share. The page owns this state.
export interface SceneSelection {
  trackId: string | null;
  actionId: string | null;
  // Bars picked together (Ctrl / Shift); always includes `actionId` when it is set.
  blocks: readonly string[];
  roomId: string | null;
}

export const EMPTY_SELECTION: SceneSelection = { trackId: null, actionId: null, blocks: [], roomId: null };

// Drops whatever an edit or an undo removed, so the UI never points at something that is gone.
// Returns the same object when nothing changed so React does not re-render.
export function pruneSelection(selection: SceneSelection, map: SceneMap): SceneSelection {
  const owner = new Map<string, string>();
  for (const track of map.tracks) for (const action of track.actions) owner.set(action.id, track.id);
  const trackExists = (id: string | null) => id !== null && map.tracks.some((track) => track.id === id);

  let actionId = selection.actionId !== null && owner.has(selection.actionId) ? selection.actionId : null;
  let trackId = trackExists(selection.trackId) ? selection.trackId : null;
  if (actionId !== null) trackId = owner.get(actionId) ?? trackId;
  if (trackId === null) actionId = null;
  const blocks = selection.blocks.filter((id) => owner.has(id));
  if (actionId !== null && !blocks.includes(actionId)) blocks.push(actionId);
  const roomId = selection.roomId !== null && map.rooms.some((room) => room.id === selection.roomId) ? selection.roomId : null;

  const same = trackId === selection.trackId && actionId === selection.actionId && roomId === selection.roomId &&
    blocks.length === selection.blocks.length && blocks.every((id, index) => id === selection.blocks[index]);
  return same ? selection : { trackId, actionId, blocks, roomId };
}
