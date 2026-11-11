import type { Action, ActionType, CoordinateMode, SceneMap, TrackKind } from "@/scene/types";
import type { SceneSelection } from "@/scene/sceneSelection";

export { EMPTY_SELECTION, type SceneSelection } from "@/scene/sceneSelection";

// Applies a pure map edit as one project commit (one undo step). Returns a Japanese reason when it fails, null on success.
export type EditMap = (edit: (map: SceneMap) => SceneMap, label: string) => string | null;

// Resolves true when the user confirms. Rendered by the page as a <dialog>; never use window.confirm.
export type Confirm = (title: string, message: string, options?: { danger?: boolean; confirmLabel?: string }) => Promise<boolean>;

// Asks the page to open the editor for one action: a single-action dialog, or the batch sequence dialog for robot rows.
export interface ActionEditRequest {
  trackId: string;
  actionId: string | null;
  type?: ActionType;
  overrides?: Partial<Omit<Action, "id" | "type">>;
}

export interface PickValue {
  x: number;
  y: number;
  yaw?: number;
  roomId?: string;
  coordinateMode?: CoordinateMode;
}

// Asks the page to open the map coordinate picker. `onSelect` returns a Japanese reason to keep the picker open.
export interface PickRequest {
  mode: "move" | "initial" | "room";
  kind: TrackKind;
  title: string;
  help?: string;
  color?: string;
  value: PickValue;
  onSelect(value: PickValue): string | null;
}

export interface PlaybackControls {
  time: number;
  running: boolean;
  looping: boolean;
  speed: number;
  duration: number;
  toggle(): void;
  home(): void;
  seek(time: number): void;
  setSpeed(speed: number): void;
  toggleLoop(): void;
}

export interface EditorShared {
  map: SceneMap;
  selection: SceneSelection;
  onSelect(selection: SceneSelection): void;
  edit: EditMap;
  confirm: Confirm;
  requestAction(request: ActionEditRequest): void;
  requestPick(request: PickRequest): void;
}
