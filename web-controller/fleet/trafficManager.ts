import { pathProblem, type Safety } from "../scene/safety";
import { SAFETY_RADIUS_MM } from "../scene/units";

export interface Point { x: number; y: number }

export interface Mover extends Point {
  id: string;
  // Where the robot is heading, null when it stands still.
  goal: Point | null;
  speedMmS: number;
  // End of the bar it is on (scene seconds), Infinity when it has none.
  barEnd: number;
  priority: number | null;
  markerId: number;
}

// D14: two centres closer than 2 radii plus a margin start a negotiation.
export const CONFLICT_MM = SAFETY_RADIUS_MM * 2 + 30;
export const LOOKAHEAD_S = 2;
const STEP_S = 0.25;
// The yielder must end up this far from the priority robot's remaining path, and from every other robot.
export const BAND_HALF_MM = SAFETY_RADIUS_MM * 2 + 40;
const SEARCH_RADIUS_MM = 500;
const GRID_MM = 20;
const PASSED_MM = 200;

export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function predict(m: Mover, seconds: number): Point {
  if (!m.goal) return m;
  const total = distance(m, m.goal);
  if (total === 0) return m;
  const travel = Math.min(total, m.speedMmS * seconds) / total;
  return { x: m.x + (m.goal.x - m.x) * travel, y: m.y + (m.goal.y - m.y) * travel };
}

// Pairs that will be closer than CONFLICT_MM within the look-ahead; at least one of them is moving.
export function findConflicts(movers: readonly Mover[]): [Mover, Mover][] {
  const pairs: [Mover, Mover][] = [];
  for (let i = 0; i < movers.length; i++) for (let j = i + 1; j < movers.length; j++) {
    const a = movers[i], b = movers[j];
    if (!a.goal && !b.goal) continue;
    for (let t = 0; t <= LOOKAHEAD_S + 1e-9; t += STEP_S) {
      if (distance(predict(a, t), predict(b, t)) < CONFLICT_MM) { pairs.push([a, b]); break; }
    }
  }
  return pairs;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return distance(p, { x: a.x + dx * t, y: a.y + dy * t });
}

// The nearest free cell centre outside the band around the priority robot's remaining path.
export function findEvasion(safety: Safety, yielder: Mover, priority: Mover, others: readonly Point[]): Point | null {
  const path = priority.goal ?? priority;
  const cx = Math.round(yielder.x / GRID_MM), cy = Math.round(yielder.y / GRID_MM), n = Math.ceil(SEARCH_RADIUS_MM / GRID_MM);
  const candidates: { p: Point; d: number }[] = [];
  for (let gx = cx - n; gx <= cx + n; gx++) for (let gy = cy - n; gy <= cy + n; gy++) {
    const p = { x: gx * GRID_MM + GRID_MM / 2, y: gy * GRID_MM + GRID_MM / 2 };
    const d = distance(yielder, p);
    if (d > SEARCH_RADIUS_MM || d < 1) continue;
    if (segmentDistance(p, priority, path) < BAND_HALF_MM) continue;
    if (others.some((o) => distance(o, p) < CONFLICT_MM)) continue;
    candidates.push({ p, d });
  }
  candidates.sort((a, b) => a.d - b.d || a.p.x - b.p.x || a.p.y - b.p.y);
  for (const { p } of candidates) {
    if (pathProblem(safety, p, p) || pathProblem(safety, yielder, p)) continue;
    // Do not slide through the priority robot on the way out.
    const steps = Math.ceil(distance(yielder, p) / GRID_MM);
    let clear = true;
    for (let i = 1; i <= steps && clear; i++) {
      const q = { x: yielder.x + (p.x - yielder.x) * i / steps, y: yielder.y + (p.y - yielder.y) * i / steps };
      if (distance(q, priority) < CONFLICT_MM) clear = false;
    }
    if (clear) return p;
  }
  return null;
}

// Fixed order of D15 step 3: a set priority first (small wins), then the marker ID.
const rank = (m: Mover) => [m.priority === null ? 1 : 0, m.priority ?? 0, m.markerId];
const before = (a: Mover, b: Mover) => {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i];
  return false;
};

export interface Decision { yielder: Mover; priority: Mover; why: "room" | "earlier" | "fixed" }

// D15: whoever has room to step aside yields; else the earlier bar end goes first; else the fixed order.
export function decide(a: Mover, b: Mover, aCanYield: boolean, bCanYield: boolean): Decision | null {
  if (!aCanYield && !bCanYield) return null;
  if (aCanYield !== bCanYield) {
    const [yielder, priority] = aCanYield ? [a, b] : [b, a];
    return { yielder, priority, why: "room" };
  }
  if (a.barEnd !== b.barEnd) {
    const [priority, yielder] = a.barEnd < b.barEnd ? [a, b] : [b, a];
    return { yielder, priority, why: "earlier" };
  }
  const [priority, yielder] = before(a, b) ? [a, b] : [b, a];
  return { yielder, priority, why: "fixed" };
}

// The priority robot has gone by once it is clear of the yielder and past it along its heading, or has stopped.
export function hasPassed(priority: Mover, yielder: Mover): boolean {
  if (!priority.goal) return distance(priority, yielder) >= CONFLICT_MM;
  const ahead = (yielder.x - priority.x) * (priority.goal.x - priority.x) + (yielder.y - priority.y) * (priority.goal.y - priority.y);
  return ahead < 0 && distance(priority, yielder) >= PASSED_MM;
}
