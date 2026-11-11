import type { FurnitureType, Material, RoomKind } from "./types";

export const FLOOR_MATERIALS: readonly Material[] = ["wood", "tile", "carpet", "concrete"];
export const FURNITURE_TYPES: readonly FurnitureType[] = ["desk", "chair", "plant", "reception-monitor"];
export const ROOM_KINDS: readonly RoomKind[] = ["room", "corridor"];

// Fixed hex values only (no CSS variables) so canvas and SVG render identically.
export const MAP_COLORS = {
  floor: {
    wood: "#c2a983",
    tile: "#dbe3df",
    carpet: "#718796",
    concrete: "#bfc9c8",
  } satisfies Record<Material, string>,
  roomKind: {
    room: "#dbe3df",
    corridor: "#c5cfc4",
  } satisfies Record<RoomKind, string>,
  furniture: {
    desk: "#d5ad62",
    chair: "#89a7a0",
    plant: "#6b9a62",
    "reception-monitor": "#34424b",
  } satisfies Record<FurnitureType, string>,
  doorClosed: "#b36b37",
  doorOpen: "#94e3d3",
  // Darker than upstream #505c54 so it holds 3:1 against the carpet floor.
  wall: "#2b352f",
  charging: "#3de0c2",
  robotBody: "#0b3350",
  robotOutline: "#f8fbf6",
  safetyCircle: "#e9a65a",
  human: "#7a4fb5",
  path: "#1f7a6b",
  grid: "#a0b6ac",
};
