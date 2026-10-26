import test from "node:test";
import assert from "node:assert/strict";
import { codes } from "./fixtures/arucoDict4x4_50";
import { initializeOpenCv, createDetector, type Detector, type OpenCv } from "../localization/detector";
import { estimate, project, homography, validateConfig, type Detection, type LocalizerConfig, type Point } from "../localization/geometry";

type CvWithBlur = OpenCv & {
  Size: new (width: number, height: number) => unknown;
  BORDER_DEFAULT: number;
  GaussianBlur(source: unknown, destination: unknown, size: unknown, sigmaX: number, sigmaY: number, border: number): void;
};

let cv: CvWithBlur;
let detector: Detector;
test.before(async () => {
  cv = (await initializeOpenCv(require("@techstark/opencv-js"))).cv as CvWithBlur;
  detector = createDetector(cv);
});
test.after(() => detector.delete());

test("runtime startup failures are explicit", async () => {
  await assert.rejects(initializeOpenCv(null), /読み込み/);
  await assert.rejects(initializeOpenCv({}, 1), /タイムアウト/);
  await assert.rejects(initializeOpenCv(Promise.reject(new Error("failed")) as never), /failed/);
});

const config: LocalizerConfig = { cameraHeight: 800, width: 1106.93, height: 622.65, referenceSize: 33,
  robots: [0, 1, 2, 3].map((id) => ({ id, height: id === 3 ? 120 : 90, size: 40 })) };
const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
const offsets: Point[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

function corners(x: number, y: number, size: number, yaw = 0): Point[] {
  const a = yaw * Math.PI / 180;
  return offsets.map(([u, v]) => [x + size / 2 * (u * Math.cos(a) - v * Math.sin(a)),
    y + size / 2 * (u * Math.sin(a) + v * Math.cos(a))] as Point);
}

function scene(x: number, y: number, yaw = 30, id = 0): Detection[] {
  const centers: Point[] = [[0, 0], [config.width, 0], [config.width, config.height], [0, config.height]];
  const nadir = [config.width / 2, config.height / 2];
  const toImage = (p: Point): Point => [960 + (p[0] - nadir[0]) * 1.375, 540 + (p[1] - nadir[1]) * 1.375];
  const refs: Detection[] = centers.map((p, i) => ({ id: 40 + i, corners: corners(...p, 33).map(toImage) }));
  const gain = 1 / (1 - config.robots[id].height / config.cameraHeight);
  refs.push({ id, corners: corners(x, y, 40, yaw).map((p) => toImage(p.map((v, i) => nadir[i] + (v - nadir[i]) * gain) as Point)) });
  return refs;
}

for (const id of [0, 3]) for (const [x, y] of [[100, 100], [1000, 100], [1000, 520], [100, 520], [553.465, 311.325]]) {
  test(`projection roundtrip height ${config.robots[id].height} at ${x},${y}`, () => {
    const result = estimate(scene(x, y, 30, id), config, 1920, 1080);
    assert.equal(result.complete, true);
    const robot = result.robots.find((r) => r.id === id);
    assert.ok(robot?.valid);
    close(robot.x, x / config.width * 1600); close(robot.y, (1 - y / config.height) * 900);
    close(robot.yaw_deg, -30); close(robot.measured_size_mm, 40);
  });
}

test("three-reference fallback and missing-reference invalidation", () => {
  const markers = scene(400, 200);
  const three = estimate(markers.filter((m) => m.id !== 42), config, 1920, 1080);
  assert.equal(three.complete, false); assert.equal(three.extrinsics_ok, true);
  const first = three.robots[0];
  assert.ok(first.valid);
  close(first.x, 400 / config.width * 1600);
  const two = estimate(markers.filter((m) => m.id < 42), config, 1920, 1080);
  assert.equal(two.extrinsics_ok, false); assert.ok(two.robots.every((r) => !r.valid));
});

test("lost robots never reuse prior positions", () => {
  const result = estimate(scene(400, 200).filter((m) => m.id >= 40), config, 1920, 1080);
  assert.ok(result.robots.every((r) => !r.valid && !("x" in r)));
});

test("boundaries, outside values, yaw sign and 180 normalization", () => {
  for (const [x, y] of [[0, 0], [config.width, config.height], [-100, 900]]) {
    const r = estimate(scene(x, y, -90), config, 1920, 1080).robots[0];
    assert.ok(r.valid);
    close(r.x, x / config.width * 1600); close(r.y, (1 - y / config.height) * 900); close(r.yaw_deg, 90);
  }
  const edge = estimate(scene(500, 300, 180), config, 1920, 1080).robots[0];
  assert.ok(edge.valid);
  close(edge.yaw_deg, 180);
});

test("projective homography, not only affine transforms", () => {
  const h = [1.2, 0.1, 100, -0.2, 0.9, 200, 0.0001, -0.0002, 1];
  const points: Point[] = [[0, 0], [1100, 0], [1100, 600], [0, 600]];
  const recovered = homography(points, points.map((p) => project(h, p)));
  const actual = project(recovered, [300, 250]), expected = project(h, [300, 250]);
  actual.forEach((v, i) => close(v, expected[i]));
});

test("invalid geometry raises explicit errors", () => {
  assert.throws(() => validateConfig({ ...config, cameraHeight: 90 }));
  assert.throws(() => validateConfig({ ...config, width: Infinity }));
  assert.throws(() => homography([[0, 0], [0, 0], [0, 0], [0, 0]], [[1, 1], [1, 1], [1, 1], [1, 1]]));
  assert.throws(() => estimate([...scene(400, 200), scene(400, 200)[0]], config, 1920, 1080), /Duplicate/);
});

test("one to four robots are accepted, others and out-of-range IDs are rejected", () => {
  validateConfig({ ...config, robots: [config.robots[1]] });
  assert.throws(() => validateConfig({ ...config, robots: [] }));
  assert.throws(() => validateConfig({ ...config, robots: [...config.robots, { id: 4, height: 90, size: 40 }] }));
  assert.throws(() => validateConfig({ ...config, robots: [{ id: 40, height: 90, size: 40 }] }));
  assert.throws(() => validateConfig({ ...config, robots: [config.robots[0], config.robots[0]] }));
});

// OpenCVの実際の4x4セルコードをRGBA化し、IDと回転後のコーナー順まで検証する。
for (let id = 0; id < codes.length; id++) for (let rotation = 0; rotation < 4; rotation++) {
  test(`DICT_4X4_50 ID${id} rotation ${rotation}`, () => {
    const width = 240, data = new Uint8ClampedArray(width * width * 4).fill(255);
    const side = 120, origin = 60, cell = 20;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      let u = Math.floor(x / cell), v = Math.floor(y / cell);
      for (let k = 0; k < rotation; k++) [u, v] = [v, 5 - u];
      const white = u > 0 && u < 5 && v > 0 && v < 5 && ((codes[id] >> (15 - ((v - 1) * 4 + u - 1))) & 1);
      const index = ((origin + y) * width + origin + x) * 4;
      data[index] = data[index + 1] = data[index + 2] = white ? 255 : 0;
    }
    const found = detector.detect({ width, height: width, data });
    assert.equal(found.length, 1); assert.equal(found[0].id, id);
    const start = found[0].corners[0];
    const expected = [[60, 60], [179, 60], [179, 179], [60, 179]][rotation];
    close(start[0], expected[0], 2); close(start[1], expected[1], 2);
  });
}

test("1080p frame with small, blurred, low-contrast paper and robot markers", () => {
  const width = 1920, height = 1080;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 120 + Math.floor(x / width * 60);
    data[i + 3] = 255;
  }
  const placements = [[40, 210, 40, 46], [41, 1770, 80, 46], [42, 1750, 970, 46],
    [43, 180, 920, 46], [0, 1000, 520, 66], [1, 1700, 530, 66]];
  for (const [id, left, top, side] of placements) {
    for (let y = -10; y < side + 10; y++) for (let x = -10; x < side + 10; x++) {
      const u = Math.floor(x / side * 6), v = Math.floor(y / side * 6);
      const outside = x < 0 || y < 0 || x >= side || y >= side;
      const white = outside || (u > 0 && u < 5 && v > 0 && v < 5 &&
        ((codes[id] >> (15 - ((v - 1) * 4 + u - 1))) & 1));
      const i = ((top + y) * width + left + x) * 4;
      const level = white ? 120 + Math.floor((left + x) / width * 60) : 45;
      data[i] = data[i + 1] = data[i + 2] = level;
    }
  }
  const source = cv.matFromImageData({ width, height, data });
  const blurred = new cv.Mat();
  try {
    cv.GaussianBlur(source, blurred, new cv.Size(5, 5), 1.2, 1.2, cv.BORDER_DEFAULT);
    const found = detector.detect({ width, height, data: blurred.data });
    assert.deepEqual(found.map((m) => m.id).sort((a, b) => a - b), [0, 1, 40, 41, 42, 43]);
    for (const m of found) {
      const [, x, y, side] = placements.find((p) => p[0] === m.id)!;
      const center = m.corners.reduce((p, c) => [p[0] + c[0] / 4, p[1] + c[1] / 4], [0, 0]);
      close(center[0], x + (side - 1) / 2, 1); close(center[1], y + (side - 1) / 2, 1);
    }
    const result = estimate(found, config, width, height);
    assert.equal(result.complete, true);
    assert.equal(result.robots.filter((r) => r.valid).length, 2);
  } finally { source.delete(); blurred.delete(); }
});
