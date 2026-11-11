import { DOOR_DEFAULT_CELLS, doorWidthOk } from "./equipment";
import { canRedo, canUndo, initHistory, pushEdit, redo, undo, type EditorHistory } from "./editorHistory";
import { furnitureCells, validateFloorPlan } from "./floorPlan";
import { cellColRow, cellIndex, type Edge } from "./grid";
import { defaultId, type IdFactory } from "./ids";
import {
  addChargingZone, addDoorAt, addFurniture, addGate, addPartitionWall, deleteFixture, previewDoorAt,
  renameFixture, rotateFurnitureBy, setDoorKind, setFurnitureRotation, setFurnitureType,
} from "./mapEditFixtures";
import { toJapanese } from "./mapEditMessages";
import { validateMapName } from "./mapTabsLogic";
import { blockCells, entranceRect, rectangleBlocks, strokeBlocks, type DrawMode } from "./mapEditPointer";
import {
  addRegion, commitElevator, eraseCells, paintCells, removeRegionChecked, setRoomProps,
} from "./mapEditRegions";
import { newTrack } from "./model";
import type { FurnitureType, Room, SceneMap, Segment } from "./types";
import { CELL_COUNT, EDIT_GRID_OPTIONS, type EditGridMm } from "./units";

export const MAP_UNDO_LIMIT = 100;
const MAX_TRACKS = 128;

export type MapTool =
  "room" | "corridor" | "erase" | "elevator" | "select" | "door" | "gate" | "partition" | "furniture" | "charging";
export type EditorMode = "zoning" | "room";
export type DoorEdge = Edge | "auto";
export type Rotation = 0 | 90 | 180 | 270;
export type { DrawMode };

export const ZONING_TOOLS: readonly MapTool[] = ["room", "corridor", "erase", "elevator"];
export const ROOM_TOOLS: readonly MapTool[] = ["select", "door", "gate", "partition", "furniture", "charging"];
const STROKE_TOOLS: readonly MapTool[] = ["room", "corridor", "erase", "elevator", "gate", "partition", "furniture", "charging"];

export interface MapStroke {
  tool: MapTool;
  cells: readonly number[];
  invalid: boolean;
}

export type MapEditResult = { ok: true; map: SceneMap } | { ok: false; error: string };

export interface MapEditSession {
  draft(): SceneMap;
  mode(): EditorMode;
  tool(): MapTool;
  drawMode(): DrawMode;
  entrance(): Edge;
  doorEdge(): DoorEdge;
  doorCells(): number;
  furnitureType(): FurnitureType;
  placementRotation(): Rotation;
  selectedRoomId(): string | null;
  selectedItemId(): string | null;
  error(): string | null;
  notice(): string | null;
  stroke(): MapStroke | null;
  doorPreview(): readonly Segment[] | null;
  isDirty(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  version(): number;
  subscribe(listener: () => void): () => void;

  setMode(mode: EditorMode): void;
  setTool(tool: MapTool): void;
  setDrawMode(mode: DrawMode): void;
  setEntrance(edge: Edge): void;
  setDoorEdge(edge: DoorEdge): void;
  setDoorCells(cells: number): void;
  setFurnitureType(type: FurnitureType): void;
  selectRoom(id: string): void;
  selectItem(id: string | null): void;
  pick(cell: number, hitItemId?: string | null): void;
  setGrid(gridMm: number): void;
  strokeBegin(cell: number): void;
  strokeMove(cell: number): void;
  strokeEnd(cell?: number): void;
  strokeCancel(): void;
  placeDoorAt(x: number, y: number, maxDistance: number): void;
  hoverDoor(x: number, y: number, maxDistance: number): void;
  addRegionOfTool(): void;
  deleteRegion(): void;
  setRoomProps(patch: Partial<Pick<Room, "name" | "kind" | "material" | "color">>): void;
  rotateSelected(): void;
  setSelectedRotation(rotation: Rotation): void;
  setSelectedFurnitureType(type: FurnitureType): void;
  renameSelected(name: string): void;
  setSelectedDoorKind(kind: "automatic" | "flapper"): void;
  deleteSelected(): void;
  setName(name: string): void;
  setRoomLabels(show: boolean): void;
  undo(): void;
  redo(): void;
  result(): MapEditResult;
}

const validCell = (cell: number) => Number.isInteger(cell) && cell >= 0 && cell < CELL_COUNT;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface ActiveStroke {
  tool: MapTool;
  start: number;
  last: number;
  cells: Set<number>;
  invalid: boolean;
}

export function createMapEditSession(source: SceneMap, makeId: IdFactory = defaultId): MapEditSession {
  const original = structuredClone(source);
  const originalJson = JSON.stringify(original);
  const originalRoomIds = new Set(original.rooms.map((room) => room.id));
  let hist: EditorHistory<SceneMap> = initHistory(structuredClone(original));

  let mode: EditorMode = "zoning";
  let tool: MapTool = "room";
  let drawMode: DrawMode = "brush";
  let entrance: Edge = "bottom";
  let doorEdge: DoorEdge = "auto";
  let doorCells = DOOR_DEFAULT_CELLS;
  let furnitureType: FurnitureType = "desk";
  let placementRotation: Rotation = 0;
  let roomId: string | null = original.rooms[0]?.id ?? null;
  let itemId: string | null = null;
  let error: string | null = null;
  let notice: string | null = null;
  let active: ActiveStroke | null = null;
  let strokeView: MapStroke | null = null;
  let preview: readonly Segment[] | null = null;
  let revision = 0;
  let dirtyFor: SceneMap | null = null;
  let dirtyValue = false;
  const listeners = new Set<() => void>();

  const draft = () => hist.present;
  const bump = () => { revision++; listeners.forEach((listener) => listener()); };
  const roomById = (id: string | null) => draft().rooms.find((room) => room.id === id);
  const pendingElevator = () =>
    [...draft().rooms].reverse().find((room) => room.appearance === "elevator" && room.cells.length === 0);

  function setStroke(next: ActiveStroke | null) {
    active = next;
    strokeView = next && { tool: next.tool, cells: Array.from(next.cells).sort((a, b) => a - b), invalid: next.invalid };
  }

  function commit(next: SceneMap) {
    if (!sameJson(next, draft())) hist = pushEdit(hist, next, MAP_UNDO_LIMIT);
  }

  // Runs an edit; a failure leaves the draft untouched and reports the reason.
  function attempt(action: () => void): boolean {
    notice = null;
    try {
      action();
      error = null;
      return true;
    } catch (e) {
      error = toJapanese(e);
      return false;
    }
  }

  function sanitizeSelection() {
    const map = draft();
    if (roomId !== null && !roomById(roomId)) roomId = map.rooms[map.rooms.length - 1]?.id ?? null;
    if (itemId !== null) {
      const plan = map.floorPlan;
      const exists = !!plan && [...plan.furniture, ...plan.doors, ...(plan.walls ?? []), ...(plan.chargingZones ?? [])]
        .some((item) => item.id === itemId);
      if (!exists) itemId = null;
    }
  }

  function ownerRoomOf(id: string): string | null {
    const plan = draft().floorPlan;
    if (!plan) return null;
    return [...plan.furniture, ...plan.doors, ...(plan.walls ?? [])].find((item) => item.id === id)?.roomId ?? null;
  }

  function selectedFurniture() {
    return draft().floorPlan?.furniture.find((item) => item.id === itemId);
  }

  function snappedPartitionEnd(start: number, end: number): number {
    const a = cellColRow(start), b = cellColRow(end);
    return Math.abs(b.col - a.col) >= Math.abs(b.row - a.row) ? cellIndex(b.col, a.row) : cellIndex(a.col, b.row);
  }

  // The lower-left cell of the edit-grid block that holds the cell.
  function blockOrigin(cell: number): number {
    const k = draft().editGridMm / 20;
    const { col, row } = cellColRow(cell);
    return cellIndex(Math.floor(col / k) * k, Math.floor(row / k) * k);
  }

  function updateStroke(cell: number) {
    const s = active!;
    const grid = draft().editGridMm;
    s.invalid = false;
    if (s.tool === "gate" || s.tool === "elevator") {
      const cells = entranceRect(blockOrigin(s.start), blockOrigin(cell), entrance, doorCells);
      if (cells) {
        s.cells = new Set(cells);
        error = null;
      } else {
        s.cells = new Set();
        s.invalid = true;
        error = toJapanese(new Error(`cannot fit a ${doorCells}-cell entrance`));
      }
    } else if (s.tool === "partition") {
      s.cells = new Set(rectangleBlocks(blockOrigin(s.start), snappedPartitionEnd(blockOrigin(s.start), blockOrigin(cell)), 20));
    } else if (s.tool === "furniture" || s.tool === "charging" || drawMode === "rectangle") {
      s.cells = new Set(rectangleBlocks(s.start, cell, grid));
    } else if (s.cells.size === 0) {
      s.cells = new Set(blockCells(cell, grid));
    } else {
      for (const c of strokeBlocks(s.last, cell, grid)) s.cells.add(c);
    }
    s.last = cell;
    setStroke(s);
  }

  function finishStroke(s: ActiveStroke) {
    const map = draft();
    const cells = Array.from(s.cells).sort((a, b) => a - b);
    if (s.tool === "room" || s.tool === "corridor") {
      commit(paintCells(map, roomId ?? "", cells, s.tool));
    } else if (s.tool === "erase") {
      commit(eraseCells(map, cells));
    } else if (s.tool === "elevator") {
      const pending = pendingElevator();
      if (!pending) throw new Error("先に「新しい領域」でエレベーター領域を追加してください。");
      commit(commitElevator(map, pending.id, cells, entrance, doorCells, makeId));
      roomId = pending.id;
      itemId = null;
      tool = "room";
    } else if (s.tool === "gate") {
      const placed = addGate(map, cells, entrance, doorCells, makeId);
      commit(placed.map);
      roomId = placed.roomId;
      itemId = placed.doorId;
    } else if (s.tool === "partition") {
      const placed = addPartitionWall(map, blockOrigin(s.start), snappedPartitionEnd(blockOrigin(s.start), blockOrigin(s.last)), makeId);
      commit(placed.map);
      roomId = placed.roomId;
      itemId = placed.wallId;
      notice = placed.warning;
    } else if (s.tool === "furniture") {
      const placed = addFurniture(map, cells, furnitureType, placementRotation, makeId);
      commit(placed.map);
      roomId = placed.roomId;
      itemId = placed.itemId;
    } else if (s.tool === "charging") {
      const placed = addChargingZone(map, cells, makeId);
      commit(placed.map);
      itemId = placed.zoneId;
    }
  }

  function createRegion() {
    const kind = tool === "corridor" ? "corridor" : tool === "elevator" ? "elevator" : "room";
    const placed = addRegion(draft(), kind, makeId);
    commit(placed.map);
    roomId = placed.roomId;
    itemId = null;
    if (tool !== "room" && tool !== "corridor" && tool !== "elevator") tool = kind === "corridor" ? "corridor" : "room";
  }

  function history(direction: "undo" | "redo") {
    if (active) {
      setStroke(null);
      bump();
      return;
    }
    const can = direction === "undo" ? canUndo(hist) : canRedo(hist);
    if (!can) return;
    hist = direction === "undo" ? undo(hist) : redo(hist);
    error = null;
    notice = null;
    sanitizeSelection();
    bump();
  }

  function withSelectedItem(label: string, action: (id: string) => SceneMap) {
    if (attempt(() => {
      if (itemId === null) throw new Error(label);
      commit(action(itemId));
    })) sanitizeSelection();
    bump();
  }

  return {
    draft,
    mode: () => mode,
    tool: () => tool,
    drawMode: () => drawMode,
    entrance: () => entrance,
    doorEdge: () => doorEdge,
    doorCells: () => doorCells,
    furnitureType: () => furnitureType,
    placementRotation: () => placementRotation,
    selectedRoomId: () => roomId,
    selectedItemId: () => itemId,
    error: () => error,
    notice: () => notice,
    stroke: () => strokeView,
    doorPreview: () => preview,
    isDirty() {
      if (dirtyFor !== hist.present) {
        dirtyFor = hist.present;
        dirtyValue = JSON.stringify(hist.present) !== originalJson;
      }
      return dirtyValue;
    },
    canUndo: () => canUndo(hist),
    canRedo: () => canRedo(hist),
    version: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    setMode(next) {
      setStroke(null);
      itemId = null;
      mode = next;
      tool = next === "room" ? "select" : roomById(roomId)?.kind ?? "room";
      preview = null;
      error = null;
      notice = null;
      bump();
    },
    setTool(next) {
      setStroke(null);
      mode = ZONING_TOOLS.includes(next) ? "zoning" : "room";
      tool = next;
      preview = null;
      error = null;
      notice = null;
      if (next === "elevator" && !pendingElevator()) attempt(createRegion);
      bump();
    },
    setDrawMode(next) {
      drawMode = next;
      bump();
    },
    setEntrance(edge) {
      entrance = edge;
      setStroke(null);
      bump();
    },
    setDoorEdge(edge) {
      doorEdge = edge;
      preview = null;
      bump();
    },
    setDoorCells(cells) {
      if (!doorWidthOk(cells)) {
        error = "入口幅は7〜12マス(140〜240mm)で指定してください。";
      } else {
        doorCells = cells;
        error = null;
        setStroke(null);
        preview = null;
      }
      bump();
    },
    setFurnitureType(type) {
      furnitureType = type;
      bump();
    },
    selectRoom(id) {
      const room = roomById(id);
      if (!room) return;
      roomId = id;
      itemId = null;
      if (mode === "zoning" && (tool === "room" || tool === "corridor")) tool = room.kind;
      error = null;
      bump();
    },
    selectItem(id) {
      itemId = id;
      if (id !== null) roomId = ownerRoomOf(id) ?? roomId;
      sanitizeSelection();
      error = null;
      bump();
    },
    pick(cell, hitItemId = null) {
      const map = draft();
      const room = map.rooms.find((item) => item.cells.includes(cell));
      const hit = hitItemId ?? map.floorPlan?.furniture.find((item) => furnitureCells(item).includes(cell))?.id ?? null;
      itemId = hit;
      if (room) roomId = room.id;
      else if (hit !== null) roomId = ownerRoomOf(hit) ?? roomId;
      sanitizeSelection();
      error = null;
      notice = null;
      bump();
    },
    setGrid(gridMm) {
      if (!(EDIT_GRID_OPTIONS as readonly number[]).includes(gridMm)) {
        error = "編集グリッドは20・40・60・80・100mmから選んでください。";
      } else {
        setStroke(null);
        commit({ ...draft(), editGridMm: gridMm as EditGridMm });
        error = null;
      }
      bump();
    },

    strokeBegin(cell) {
      if (!validCell(cell)) return;
      error = null;
      notice = null;
      if (!STROKE_TOOLS.includes(tool)) return;
      if (tool === "elevator") {
        const pending = pendingElevator();
        if (!pending) {
          error = "先に「新しい領域」でエレベーター領域を追加してください。";
          bump();
          return;
        }
        roomId = pending.id;
      }
      setStroke({ tool, start: cell, last: cell, cells: new Set(), invalid: false });
      updateStroke(cell);
      bump();
    },
    strokeMove(cell) {
      if (!active || !validCell(cell) || cell === active.last) return;
      updateStroke(cell);
      bump();
    },
    strokeEnd(cell) {
      if (!active) return;
      if (cell !== undefined && validCell(cell) && cell !== active.last) updateStroke(cell);
      const finished = active;
      setStroke(null);
      if (!finished.invalid) {
        if (attempt(() => finishStroke(finished))) sanitizeSelection();
      }
      bump();
    },
    strokeCancel() {
      if (!active) return;
      setStroke(null);
      error = null;
      bump();
    },

    placeDoorAt(x, y, maxDistance) {
      if (attempt(() => {
        const placed = addDoorAt(draft(), x, y, {
          roomId: roomId ?? undefined, edge: doorEdge, cells: doorCells, maxDistance,
        }, makeId);
        commit(placed.map);
        roomId = placed.roomId;
        itemId = placed.doorId;
      })) sanitizeSelection();
      notice = null;
      preview = null;
      bump();
    },
    hoverDoor(x, y, maxDistance) {
      let next: readonly Segment[] | null = null;
      try {
        next = previewDoorAt(draft(), x, y, { roomId: roomId ?? undefined, edge: doorEdge, cells: doorCells, maxDistance });
      } catch {
        next = null;
      }
      if (!sameJson(next, preview)) {
        preview = next;
        bump();
      }
    },
    addRegionOfTool() {
      attempt(createRegion);
      bump();
    },
    deleteRegion() {
      if (attempt(() => {
        commit(removeRegionChecked(draft(), roomId ?? ""));
        const map = draft();
        roomId = map.rooms[0]?.id ?? null;
        itemId = null;
        setStroke(null);
      })) sanitizeSelection();
      bump();
    },
    setRoomProps(patch) {
      attempt(() => {
        commit(setRoomProps(draft(), roomId ?? "", patch));
        if (patch.kind && (tool === "room" || tool === "corridor")) tool = patch.kind;
      });
      bump();
    },
    rotateSelected() {
      withSelectedItem("回転する家具を「選択」でクリックしてください。", (id) => rotateFurnitureBy(draft(), id, 1));
    },
    setSelectedRotation(rotation) {
      placementRotation = rotation;
      const furniture = selectedFurniture();
      if (furniture) {
        attempt(() => { commit(setFurnitureRotation(draft(), furniture.id, rotation)); });
      } else {
        error = null;
      }
      bump();
    },
    setSelectedFurnitureType(type) {
      furnitureType = type;
      const furniture = selectedFurniture();
      if (furniture) {
        attempt(() => { commit(setFurnitureType(draft(), furniture.id, type)); });
      } else {
        error = null;
      }
      bump();
    },
    renameSelected(name) {
      withSelectedItem("名前を変更するドアまたは壁を「選択」でクリックしてください。", (id) => renameFixture(draft(), id, name));
    },
    setSelectedDoorKind(kind) {
      withSelectedItem("種類を変更するドアを「選択」でクリックしてください。", (id) => setDoorKind(draft(), id, kind));
    },
    deleteSelected() {
      if (attempt(() => {
        commit(deleteFixture(draft(), itemId));
        itemId = null;
      })) sanitizeSelection();
      bump();
    },
    setName(name) {
      commit({ ...draft(), name });
      bump();
    },
    setRoomLabels(show) {
      const map = draft();
      commit({ ...map, floorPlan: { ...(map.floorPlan ?? { doors: [], furniture: [] }), showRoomLabels: show } });
      bump();
    },
    undo: () => history("undo"),
    redo: () => history("redo"),

    result() {
      const fail = (message: string): MapEditResult => {
        error = message;
        bump();
        return { ok: false, error: message };
      };
      if (active) return fail("ドラッグを終了してから適用してください。");
      const map = draft();
      const named = validateMapName(map.name);
      if (!named.ok) return fail(named.error);
      const name = named.name;
      if (map.rooms.length === 0) return fail("1つ以上の領域を描いてください。");
      const added = map.rooms.filter((room) => !originalRoomIds.has(room.id));
      if (map.tracks.length + added.length > MAX_TRACKS) {
        return fail(`新しい領域の部屋トラックを含めると${MAX_TRACKS}本を超えます。領域を追加する前にトラックを減らしてください。`);
      }
      const empty = map.rooms.find((room) => room.cells.length === 0);
      if (empty) return fail(`「${empty.name}」を1セル以上描いてください。`);
      const next = structuredClone(map);
      try {
        validateFloorPlan(next);
      } catch (e) {
        return fail(toJapanese(e));
      }
      next.name = name;
      // Room tracks follow their region's rename and every new region gets its own track.
      for (const track of next.tracks) {
        if (track.kind !== "room") continue;
        const before = original.rooms.find((room) => room.id === track.roomId);
        const after = next.rooms.find((room) => room.id === track.roomId);
        if (before && after && track.name === before.name) track.name = after.name;
      }
      for (const room of added) {
        const track = newTrack(next, "room", makeId);
        track.name = room.name;
        track.roomId = room.id;
        track.color = room.color;
        next.tracks.push(track);
      }
      error = null;
      return { ok: true, map: next };
    },
  };
}
