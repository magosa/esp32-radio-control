// node-localizer (robot_pose/v3) のgeometry.jsをTS化したもの。DOM非依存で、ブラウザーとNodeの両方で使う。
export const SCHEMA = "robot_pose/v3" as const;

export type Point = [number, number];

// corners は画像座標の [左上, 右上, 右下, 左下]
export interface Detection {
  id: number;
  corners: Point[];
}

export interface RobotMarkerConfig {
  id: number;
  height: number;
  size: number;
}

export interface LocalizerConfig {
  cameraHeight: number;
  width: number;
  height: number;
  referenceSize: number;
  robots: RobotMarkerConfig[];
}

export type RobotPose =
  | { id: number; valid: false; reason: "reference_missing" | "not_detected" }
  | { id: number; valid: true; x: number; y: number; yaw_deg: number; measured_size_mm: number; inside_field: boolean };

export interface PoseEstimate {
  schema: typeof SCHEMA;
  timestamp_ms: number;
  referenceCount: number;
  complete: boolean;
  extrinsics_ok: boolean;
  robots: RobotPose[];
}

export const REFERENCE_IDS = [40, 41, 42, 43] as const;
export const MAX_ROBOTS = 4;
export const MAX_ROBOT_MARKER_ID = 3;

type Matrix3 = number[];

const mean = (points: Point[]): Point => [0, 1].map((i) => points.reduce((s, p) => s + p[i], 0) / points.length) as Point;

export function validateConfig(c: LocalizerConfig): void {
  if (!(c.cameraHeight > 0 && c.width > 0 && c.height > 0 && c.referenceSize > 0)) {
    throw new Error("Camera height, field dimensions and reference size must be positive.");
  }
  if (!Array.isArray(c.robots) || c.robots.length < 1 || c.robots.length > MAX_ROBOTS
    || new Set(c.robots.map((r) => r.id)).size !== c.robots.length
    || c.robots.some((r) => !Number.isInteger(r.id) || r.id < 0 || r.id > MAX_ROBOT_MARKER_ID
      || !Number.isFinite(r.height) || r.height < 0 || r.height >= c.cameraHeight || !(r.size > 0))) {
    throw new Error(`1 to ${MAX_ROBOTS} unique robot IDs (0..${MAX_ROBOT_MARKER_ID}) and valid marker heights/sizes are required.`);
  }
  for (const value of [c.cameraHeight, c.width, c.height, c.referenceSize, ...c.robots.map((r) => r.size)]) {
    if (!Number.isFinite(value)) throw new Error("All dimensions must be finite.");
  }
}

function solve(matrix: number[][], rhs: number[]): number[] {
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let i = 0; i < rhs.length; i++) {
    let pivot = i;
    for (let j = i + 1; j < rhs.length; j++) {
      if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    }
    if (Math.abs(a[pivot][i]) < 1e-10) throw new Error("Degenerate reference layout.");
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const d = a[i][i];
    a[i] = a[i].map((v) => v / d);
    for (let j = 0; j < rhs.length; j++) {
      if (j === i) continue;
      const f = a[j][i];
      a[j] = a[j].map((v, k) => v - f * a[i][k]);
    }
  }
  return a.map((row) => row[row.length - 1]);
}

function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  return Array.from({ length: 9 }, (_, i) => {
    const row = Math.floor(i / 3), col = i % 3;
    return [0, 1, 2].reduce((s, k) => s + a[row * 3 + k] * b[k * 3 + col], 0);
  });
}

export function homography(source: Point[], target: Point[]): Matrix3 {
  if (source.length < 4 || source.length !== target.length
    || [...source, ...target].some((p) => p.length !== 2 || !p.every(Number.isFinite))) {
    throw new Error("At least four finite point pairs are required.");
  }
  // 座標を正規化し、mm・画像pxの桁差による連立方程式の不安定化を抑える。
  const normalize = (pts: Point[]) => {
    const center = mean(pts);
    const scale = Math.sqrt(2) / (pts.reduce((s, p) => s + Math.hypot(p[0] - center[0], p[1] - center[1]), 0) / pts.length);
    if (!Number.isFinite(scale)) throw new Error("Degenerate reference layout.");
    return { center, scale, points: pts.map((p) => p.map((v, i) => (v - center[i]) * scale) as Point) };
  };
  const s = normalize(source), t = normalize(target);
  const rows: number[][] = [], rhs: number[] = [];
  s.points.forEach(([x, y], i) => {
    const [u, v] = t.points[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]);
    rhs.push(u, v);
  });
  const normal = Array.from({ length: 8 }, (_, i) =>
    Array.from({ length: 8 }, (_, j) => rows.reduce((sum, r) => sum + r[i] * r[j], 0)));
  const b = normal.map((_, i) => rows.reduce((sum, r, j) => sum + r[i] * rhs[j], 0));
  const h = [...solve(normal, b), 1];
  const ns = [s.scale, 0, -s.center[0] * s.scale, 0, s.scale, -s.center[1] * s.scale, 0, 0, 1];
  const ntInv = [1 / t.scale, 0, t.center[0], 0, 1 / t.scale, t.center[1], 0, 0, 1];
  return multiply(multiply(ntInv, h), ns);
}

export function project(h: Matrix3, [x, y]: Point): Point {
  const z = h[6] * x + h[7] * y + h[8];
  if (!Number.isFinite(z) || Math.abs(z) < 1e-12) throw new Error("Invalid projective mapping.");
  const p: Point = [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z];
  if (!p.every(Number.isFinite)) throw new Error("Non-finite coordinates.");
  return p;
}

export function estimate(detections: Detection[], config: LocalizerConfig, imageWidth: number, imageHeight: number): PoseEstimate {
  validateConfig(config);
  const centers: Point[] = [[0, 0], [config.width, 0], [config.width, config.height], [0, config.height]];
  const refs = detections.filter((m) => m.id >= 40 && m.id <= 43);
  if (new Set(refs.map((m) => m.id)).size !== refs.length) {
    throw new Error("Duplicate reference marker IDs.");
  }
  const base = { schema: SCHEMA, timestamp_ms: Date.now(), referenceCount: refs.length, complete: refs.length === 4 };
  if (refs.length < 3) {
    return { ...base, extrinsics_ok: false, robots: config.robots.map((r): RobotPose => ({ id: r.id, valid: false, reason: "reference_missing" })) };
  }
  const object: Point[] = [], image: Point[] = [];
  const offsets: Point[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const m of refs) {
    const c = centers[m.id - 40];
    if (refs.length === 4) {
      object.push(c); image.push(mean(m.corners));
    } else {
      object.push(...offsets.map((p) => [c[0] + p[0] * config.referenceSize / 2, c[1] + p[1] * config.referenceSize / 2] as Point));
      image.push(...m.corners);
    }
  }
  const inverse = homography(image, object);
  const nadir = project(inverse, [imageWidth / 2, imageHeight / 2]);
  const unit = (v: Point): Point => {
    const n = Math.hypot(...v);
    if (n < 1e-9) throw new Error("Degenerate robot marker.");
    return [v[0] / n, v[1] / n];
  };
  const robots = config.robots.map((r): RobotPose => {
    const marker = detections.find((m) => m.id === r.id);
    if (!marker) return { id: r.id, valid: false, reason: "not_detected" };
    // H_hの逆写像はH_0の逆写像後にnadir中心で(1-h/Z)縮小する。
    const corners = marker.corners.map((p) => {
      const q = project(inverse, p);
      return [0, 1].map((i) => nadir[i] + (q[i] - nadir[i]) * (1 - r.height / config.cameraHeight)) as Point;
    });
    const center = mean(corners);
    const [tl, tr, br, bl] = corners;
    const ax = unit([tr[0] - tl[0] + br[0] - bl[0], -(tr[1] - tl[1] + br[1] - bl[1])]);
    const ay = unit([bl[0] - tl[0] + br[0] - tr[0], -(bl[1] - tl[1] + br[1] - tr[1])]);
    let yaw = Math.atan2(ax[1] + ay[0], ax[0] - ay[1]) * 180 / Math.PI;
    if (yaw <= -180) yaw = 180;
    const measured = corners.reduce((s, p, i) => s + Math.hypot(p[0] - corners[(i + 1) % 4][0], p[1] - corners[(i + 1) % 4][1]), 0) / 4;
    return {
      id: r.id, valid: true, x: center[0] / config.width * 1600,
      y: (1 - center[1] / config.height) * 900, yaw_deg: yaw, measured_size_mm: measured,
      inside_field: center[0] >= 0 && center[0] <= config.width && center[1] >= 0 && center[1] <= config.height,
    };
  });
  return { ...base, extrinsics_ok: true, robots };
}
