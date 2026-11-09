import type { Edge } from "./grid";
import type { EditGridMm } from "./units";

export const SCENE_SCHEMA = "fleet-scene/v1";

export type TrackKind = "robot" | "human" | "room" | "display";
export type ActionType = "move" | "wait" | "show" | "hide" | "event-start" | "event-end" | "unlock";
export type CoordinateMode = "grid" | "free";
export type RoomState = "meeting" | "fire" | "outage";
export type DisplayTemplate = "label" | "card" | "sign";
export type HatchStyle = "diagonal" | "cross" | "dots";
export type RobotRole = "cleaning" | "security" | "delivery";
export type DoorMode = "story" | "strict";
export type RoomKind = "room" | "corridor";
export type Material = "wood" | "tile" | "carpet" | "concrete";
export type RoomAppearance = "standard" | "elevator" | "continuing-hall";
export type FurnitureType = "desk" | "chair" | "plant" | "reception-monitor";
export type CueKind = "zone" | "dirt" | "crowd" | "fire" | "scan" | "route" | "notice" | "car";

export interface Room {
  id: string;
  name: string;
  color: string;
  kind: RoomKind;
  material: Material;
  cells: number[];
  appearance?: RoomAppearance;
  entranceEdge?: Edge;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Door extends Partial<Segment> {
  id: string;
  roomId: string;
  name?: string;
  kind?: "automatic" | "flapper";
  openingId?: string;
  equipmentId?: string;
  // Edge doors use cell+edge; wall doors use the segment and wallId.
  cell?: number;
  edge?: Edge;
  wallId?: string;
}

export interface Furniture {
  id: string;
  roomId: string;
  cell: number;
  // Multi-cell footprint; `cell` is its lowest index.
  cells?: number[];
  type: FurnitureType;
  rotation: 0 | 90 | 180 | 270;
}

export interface ChargingZone {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Wall extends Segment {
  id: string;
  roomId: string;
  name?: string;
  equipmentId?: string;
}

export interface FloorPlan {
  doors: Door[];
  furniture: Furniture[];
  chargingZones?: ChargingZone[];
  walls?: Wall[];
  showRoomLabels?: boolean;
}

export interface PresentationCue {
  kind: CueKind;
  start: number;
  end: number;
  label: string;
  color: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  points?: [number, number][];
}

export interface Presentation {
  version: 1;
  scenarioId: string;
  cues: PresentationCue[];
}

export interface Pose {
  x: number;
  y: number;
  yaw: number;
  roomId: string;
  coordinateMode?: CoordinateMode;
}

export interface Action {
  id: string;
  name: string;
  type: ActionType;
  position: number;
  runSeconds: number;
  x: number;
  y: number;
  yaw: number;
  coordinateMode?: CoordinateMode;
  roomId: string;
  targetId: string;
  text: string;
  state: RoomState;
  motion?: "rotate";
  rotationSeconds?: number;
  facingFor?: string;
  displayTemplate?: DisplayTemplate;
  hatchStyle?: HatchStyle;
  hatchColor?: string;
  doorId?: string;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  color: string;
  muted: boolean;
  locked: boolean;
  actions: Action[];
  initial?: Pose;
  robotId?: string;
  robotRole?: RobotRole;
  count?: number;
  roomId?: string;
}

export interface SceneMap {
  id: string;
  name: string;
  editGridMm: EditGridMm;
  doorMode: DoorMode;
  rooms: Room[];
  tracks: Track[];
  floorPlan?: FloorPlan;
  presentation?: Presentation;
  facingTurns?: boolean;
  navigation?: unknown;
}

export interface SceneProject {
  schema: typeof SCENE_SCHEMA;
  name: string;
  maps: SceneMap[];
  facingTurns?: boolean;
}
