import { cellAt, cellCenter, cellColRow, cellIndex, cellNeighbor, snapToEditGrid, type Edge } from "./grid";
import { buildNavigation, type SceneNavigation } from "./navigation";
import type { SceneMap } from "./types";
import { AREA_HEIGHT_MM, AREA_WIDTH_MM, CELL_COUNT, CELL_MM, COLUMNS, HUMAN_RADIUS_MM, ROWS, SAFETY_RADIUS_MM, type EditGridMm } from "./units";

export interface Point {
  x: number;
  y: number;
}

export type ActorKind = "robot" | "human";

export interface SafetyZone {
  id: string;
  name: string;
  cells: Set<number>;
}

export interface Safety {
  navigation: SceneNavigation;
  zones: Map<string, SafetyZone>;
  cellZones: Map<number, string>;
  robotRadius: number;
}

export interface PathSection {
  from: number;
  to: number;
  zone: string | null;
}

export interface TrajectorySegment {
  from: Point;
  to: Point;
  start: number;
  end: number;
}

export interface Trajectory {
  id: string;
  name: string;
  kind: ActorKind;
  segments: TrajectorySegment[];
}

export interface CollisionWarning {
  code: "collision";
  trackIds: [string, string];
  at: number;
  message: string;
}

// Passable width below two safety circles (240mm) admits one robot at a time.
const ONE_AT_A_TIME_CELLS = 11;
// Upstream sampled every 10 ratio units.
const SAMPLE_MM = 7;
const EPS = 1e-7;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export function coordinatePoint(
  x: number, y: number, mode: "grid" | "free", gridMm: EditGridMm, origin: Point | null = null, axisLock = false,
): Point {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("座標は有限数で指定してください。");
  if (mode !== "grid" && mode !== "free") throw new Error("座標指定モードが不正です。");
  x = clamp(x, 0, AREA_WIDTH_MM);
  y = clamp(y, 0, AREA_HEIGHT_MM);
  if (mode === "grid") return snapToEditGrid(x, y, gridMm);
  if (axisLock && origin) {
    if (Math.abs(x - origin.x) >= Math.abs(y - origin.y)) y = origin.y;
    else x = origin.x;
  }
  return { x, y };
}

const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

function pointDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy;
  const t = d ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / d, 0, 1) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const separated = Math.max(a.x, b.x) < Math.min(c.x, d.x) - EPS ||
    Math.max(c.x, d.x) < Math.min(a.x, b.x) - EPS ||
    Math.max(a.y, b.y) < Math.min(c.y, d.y) - EPS ||
    Math.max(c.y, d.y) < Math.min(a.y, b.y) - EPS;
  if (!separated && cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) return 0;
  return Math.min(pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b));
}

function rectangleDistance(a: Point, b: Point, r: { x: number; y: number; width: number; height: number }): number {
  const inside = (p: Point) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
  if (inside(a) || inside(b)) return 0;
  const corners = [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }];
  return Math.min(...corners.map((p, i) => segmentDistance(a, b, p, corners[(i + 1) % 4])));
}

export function createSafety(map: SceneMap): Safety {
  const navigation = buildNavigation(map), zones = new Map<string, SafetyZone>(), cellZones = new Map<number, string>();
  const available = new Set(navigation.cells.filter((c) => c.traversable).map((c) => c.cell));
  for (const room of map.rooms.filter((r) => r.kind === "corridor")) {
    const cells = new Set(room.cells.filter((c) => available.has(c))), narrow = new Set<number>();
    const run = (cell: number, one: Edge, two: Edge) => {
      let n = 1;
      for (const edge of [one, two]) {
        let next = cellNeighbor(cell, edge);
        while (cells.has(next)) { n++; next = cellNeighbor(next, edge); }
      }
      return n;
    };
    for (const cell of Array.from(cells)) {
      if (Math.min(run(cell, "left", "right"), run(cell, "top", "bottom")) <= ONE_AT_A_TIME_CELLS) narrow.add(cell);
    }
    while (narrow.size) {
      const start = narrow.values().next().value!, queue = [start];
      narrow.delete(start);
      for (let i = 0; i < queue.length; i++) for (const edge of ["left", "right", "top", "bottom"] as const) {
        const next = cellNeighbor(queue[i], edge);
        if (narrow.delete(next)) queue.push(next);
      }
      const id = `${room.id}:${start}`;
      zones.set(id, { id, name: room.name, cells: new Set(queue) });
      queue.forEach((cell) => cellZones.set(cell, id));
    }
  }
  return { navigation, zones, cellZones, robotRadius: SAFETY_RADIUS_MM };
}

export function pathProblem(safety: Safety, from: Point, to: Point, kind: ActorKind = "robot"): string {
  const radius = kind === "robot" ? safety.robotRadius : HUMAN_RADIUS_MM;
  for (const p of [from, to]) {
    if (p.x < radius || p.x > AREA_WIDTH_MM - radius || p.y < radius || p.y > AREA_HEIGHT_MM - radius) {
      return "車体・人物の占有範囲がMAP外にはみ出します。";
    }
  }
  for (const wall of safety.navigation.walls) {
    if (segmentDistance(from, to, { x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 }) < radius - EPS) {
      return "移動経路が壁または狭すぎるドアに接触します。経路または開口幅を修正してください。";
    }
  }
  for (const obstacle of safety.navigation.obstacles) {
    if (rectangleDistance(from, to, obstacle) < radius - EPS) return "移動経路が家具の占有範囲に接触します。";
  }
  const count = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / SAMPLE_MM));
  for (let i = 0; i <= count; i++) {
    const cell = cellAt(from.x + (to.x - from.x) * i / count, from.y + (to.y - from.y) * i / count);
    if (!safety.navigation.cells[cell]?.traversable) return "移動経路に通行不可・未定義のグリッドがあります。";
  }
  return "";
}

// 初期位置への移動用: MAP上の壁・家具・通行不可領域および他のロボットを迂回する経路をA*で探索し、
// 見通し線（Line-of-Sight）で不要な経由点を間引いた経由点リスト（末尾が to）を返す。到達不可なら null。
export function findDetourPath(
  safety: Safety,
  from: Point,
  to: Point,
  others: readonly Point[] = [],
  robotClearanceMm = 145,
): Point[] | null {
  const segmentClear = (a: Point, b: Point): boolean =>
    pathProblem(safety, a, b, "robot") === "" &&
    others.every((o) => pointDistance(o, a, b) >= robotClearanceMm - EPS);

  if (segmentClear(from, to)) return [to];

  const radius = safety.robotRadius;
  const safe = new Uint8Array(CELL_COUNT);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    if (!safety.navigation.cells[cell]?.traversable) continue;
    const p = cellCenter(cell);
    if (p.x < radius || p.x > AREA_WIDTH_MM - radius || p.y < radius || p.y > AREA_HEIGHT_MM - radius) continue;
    let ok = true;
    for (const wall of safety.navigation.walls) {
      if (pointDistance(p, { x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 }) < radius - EPS) { ok = false; break; }
    }
    if (!ok) continue;
    for (const obs of safety.navigation.obstacles) {
      if (rectangleDistance(p, p, obs) < radius - EPS) { ok = false; break; }
    }
    if (!ok) continue;
    for (const o of others) {
      if (Math.hypot(p.x - o.x, p.y - o.y) < robotClearanceMm - EPS) { ok = false; break; }
    }
    if (ok) safe[cell] = 1;
  }

  const nearestSafeCell = (p: Point, maxDistMm: number): number => {
    const direct = cellAt(p.x, p.y);
    if (direct >= 0 && safe[direct]) return direct;
    let best = -1, bestD = maxDistMm;
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (!safe[cell]) continue;
      const c = cellCenter(cell);
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) { bestD = d; best = cell; }
    }
    return best;
  };

  const startCell = nearestSafeCell(from, 200);
  const goalCell = nearestSafeCell(to, 60);
  if (startCell < 0 || goalCell < 0) return null;

  const gScore = new Float64Array(CELL_COUNT).fill(Infinity);
  const fScore = new Float64Array(CELL_COUNT).fill(Infinity);
  const cameFrom = new Int32Array(CELL_COUNT).fill(-1);
  const closed = new Uint8Array(CELL_COUNT);
  const goalCR = cellColRow(goalCell);
  const heuristic = (cell: number) => {
    const { col, row } = cellColRow(cell);
    return Math.hypot(col - goalCR.col, row - goalCR.row);
  };

  gScore[startCell] = 0;
  fScore[startCell] = heuristic(startCell);
  const open: number[] = [startCell];
  const inOpen = new Uint8Array(CELL_COUNT);
  inOpen[startCell] = 1;

  const dirs: readonly [number, number, number][] = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];

  let found = false;
  while (open.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (fScore[open[i]] < fScore[open[bestIdx]]) bestIdx = i;
    }
    const current = open[bestIdx];
    open[bestIdx] = open[open.length - 1];
    open.pop();
    inOpen[current] = 0;
    if (current === goalCell) { found = true; break; }
    closed[current] = 1;

    const { col, row } = cellColRow(current);
    for (const [dc, dr, cost] of dirs) {
      const nc = col + dc, nr = row + dr;
      if (nc < 0 || nc >= COLUMNS || nr < 0 || nr >= ROWS) continue;
      const next = cellIndex(nc, nr);
      if (next < 0 || closed[next] || !safe[next]) continue;
      if (dc !== 0 && dr !== 0) {
        const adj1 = cellIndex(col + dc, row);
        const adj2 = cellIndex(col, row + dr);
        if (adj1 < 0 || adj2 < 0 || !safe[adj1] || !safe[adj2]) continue;
      }
      const tentative = gScore[current] + cost;
      if (tentative < gScore[next]) {
        cameFrom[next] = current;
        gScore[next] = tentative;
        fScore[next] = tentative + heuristic(next);
        if (!inOpen[next]) {
          open.push(next);
          inOpen[next] = 1;
        }
      }
    }
  }

  if (!found) return null;

  const rawCells: number[] = [];
  for (let cur = goalCell; cur !== -1; cur = cameFrom[cur]) rawCells.push(cur);
  rawCells.reverse();

  const rawPoints: Point[] = [from, ...rawCells.map(cellCenter), to];
  const smoothed: Point[] = [];
  let idx = 0;
  while (idx < rawPoints.length - 1) {
    let nextIdx = idx + 1;
    for (let j = rawPoints.length - 1; j > idx + 1; j--) {
      if (segmentClear(rawPoints[idx], rawPoints[j])) {
        nextIdx = j;
        break;
      }
    }
    smoothed.push(rawPoints[nextIdx]);
    idx = nextIdx;
  }
  return smoothed.length > 0 ? smoothed : [to];
}

// Splitting at cell borders keeps short zone crossings independent of sampling.
export function pathSections(safety: Safety, from: Point, to: Point): PathSection[] {
  const cuts = new Set([0, 1]);
  for (const [axis, max] of [["x", AREA_WIDTH_MM], ["y", AREA_HEIGHT_MM]] as const) {
    if (to[axis] === from[axis]) continue;
    for (let v = CELL_MM; v < max; v += CELL_MM) {
      const t = (v - from[axis]) / (to[axis] - from[axis]);
      if (t > EPS && t < 1 - EPS) cuts.add(t);
    }
  }
  const values = Array.from(cuts).sort((a, b) => a - b), sections: PathSection[] = [];
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1], b = values[i], mid = (a + b) / 2;
    const zone = safety.cellZones.get(cellAt(from.x + (to.x - from.x) * mid, from.y + (to.y - from.y) * mid)) ?? null;
    const previous = sections.at(-1);
    if (previous?.zone === zone) previous.to = b;
    else sections.push({ from: a, to: b, zone });
  }
  return sections;
}

export function positionAt(segments: TrajectorySegment[], at: number): Point {
  const s = segments.find((segment) => at < segment.end) ?? segments.at(-1);
  if (!s) throw new Error("軌跡がありません。");
  const t = s.end === s.start ? 1 : clamp((at - s.start) / (s.end - s.start), 0, 1);
  return { x: s.from.x + (s.to.x - s.from.x) * t, y: s.from.y + (s.to.y - s.from.y) * t };
}

const actorRadius = (kind: ActorKind) => kind === "robot" ? SAFETY_RADIUS_MM : HUMAN_RADIUS_MM;

export function collisionWarnings(trajectories: Trajectory[]): CollisionWarning[] {
  const warnings: CollisionWarning[] = [];
  for (let i = 0; i < trajectories.length; i++) for (let j = i + 1; j < trajectories.length; j++) {
    const a = trajectories[i], b = trajectories[j];
    if (a.kind === "human" && b.kind === "human") continue;
    const clearance = actorRadius(a.kind) + actorRadius(b.kind);
    let hit: number | null = null, ai = 0, bi = 0;
    while (ai < a.segments.length && bi < b.segments.length) {
      const sa = a.segments[ai], sb = b.segments[bi];
      const begin = Math.max(sa.start, sb.start), end = Math.min(sa.end, sb.end);
      if (end >= begin) {
        const p = positionAt([sa], begin), q = positionAt([sb], begin);
        const velocity = (s: TrajectorySegment) => ({
          x: (s.to.x - s.from.x) / (s.end - s.start || 1), y: (s.to.y - s.from.y) / (s.end - s.start || 1),
        });
        const va = velocity(sa), vb = velocity(sb), dx = p.x - q.x, dy = p.y - q.y;
        const vx = va.x - vb.x, vy = va.y - vb.y, v2 = vx * vx + vy * vy;
        const dt = v2 ? clamp(-(dx * vx + dy * vy) / v2, 0, end - begin) : 0;
        if (Math.hypot(dx + vx * dt, dy + vy * dt) < clearance - EPS) { hit = begin + dt; break; }
      }
      if (sa.end <= sb.end) ai++; else bi++;
    }
    if (hit !== null) {
      warnings.push({
        code: "collision", trackIds: [a.id, b.id], at: hit,
        message: `${a.name} と ${b.name} が ${hit.toFixed(2)}秒付近で接触する予測です。開始時刻・待機・経路を調整してください。`,
      });
    }
  }
  return warnings;
}
