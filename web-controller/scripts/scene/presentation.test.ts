import test from "node:test";
import assert from "node:assert/strict";
import { createProject, validateProject } from "../../scene/model";
import { presentationAt, validatePresentation } from "../../scene/presentation";
import type { Presentation, PresentationCue } from "../../scene/types";

const base = (): Presentation => ({
  version: 1,
  scenarioId: "garbage",
  cues: [
    { kind: "dirt", start: 2, end: 10, label: "豎壹ｌ", color: "#a0522d", x: 100, y: 100, width: 200, height: 150 },
    { kind: "route", start: 0, end: 5, label: "邨瑚ｷｯ", color: "#58d8ca", points: [[0, 0], [550, 310], [1100, 620]] },
    { kind: "notice", start: 0, end: 86400, label: "SIMULATION ONLY", color: "#ffbd70" },
  ],
});

test("validatePresentation accepts mm cues on the drawable area edges", () => {
  const value = base();
  assert.equal(validatePresentation(value), value);
  const edge = base();
  Object.assign(edge.cues[0], { x: 1000, y: 520, width: 100, height: 100 });
  assert.doesNotThrow(() => validatePresentation(edge));
});

// upstream scenario-library: "presentation input rejects malformed times, geometry, styling and excessive cue counts"
test("validatePresentation rejects malformed times, geometry, styling and excessive cue counts", () => {
  const changes: Partial<PresentationCue>[] = [
    { start: -1 }, { end: Infinity }, { kind: "script" as PresentationCue["kind"] }, { color: "url(https://invalid)" },
    { label: "<script>".repeat(100) }, { kind: "dirt", x: 1090, y: 0, width: 100, height: 100 },
    { kind: "route", points: [[0, 0], [Infinity, 2]] },
  ];
  for (const change of changes) {
    const value = base();
    Object.assign(value.cues[0], change);
    assert.throws(() => validatePresentation(value), Error, JSON.stringify(change));
  }
  assert.throws(() => validatePresentation({ ...base(), cues: Array(161).fill(base().cues[0]) }));
  assert.doesNotThrow(() => validatePresentation({ ...base(), cues: Array(160).fill(base().cues[0]) }));
});

test("validatePresentation enforces mm bounds, time window and route point counts", () => {
  const reject: [number, Partial<PresentationCue>][] = [
    [0, { height: 521 }], [0, { width: 0 }], [0, { x: -1 }], [0, { y: 620, height: 1 }],
    [0, { start: 5, end: 5 }], [0, { end: 86401 }], [0, { start: 6, end: 4 }],
    [1, { points: [[0, 0]] }], [1, { points: Array.from({ length: 41 }, (): [number, number] => [1, 1]) }],
    [1, { points: [[0, 0], [1100.1, 0]] }], [1, { points: [[0, 0], [0, 620.1]] }],
    [2, { label: "x".repeat(181) }], [2, { color: "#fff" }],
  ];
  for (const [index, change] of reject) {
    const value = base();
    Object.assign(value.cues[index], change);
    assert.throws(() => validatePresentation(value), Error, JSON.stringify(change));
  }
  const accept = base();
  Object.assign(accept.cues[1], { points: Array.from({ length: 40 }, (): [number, number] => [1100, 620]) });
  Object.assign(accept.cues[2], { label: "x".repeat(180) });
  assert.doesNotThrow(() => validatePresentation(accept));
  assert.throws(() => validatePresentation({ ...base(), version: 2 }));
  assert.throws(() => validatePresentation({ ...base(), scenarioId: "Bad Id" }));
  assert.throws(() => validatePresentation(null));
});

test("validateProject rejects maps with an invalid presentation", () => {
  const project = createProject("p", (() => { let n = 0; return () => `id-${++n}`; })());
  project.maps[0].presentation = base();
  assert.doesNotThrow(() => validateProject(project));
  project.maps[0].presentation.cues[0].x = 1050;
  assert.throws(() => validateProject(project));
});

test("presentationAt uses [start, end) and is independent of call order", () => {
  const value = base();
  const [dirt, route, notice] = value.cues;
  assert.deepEqual(presentationAt(value, 0), [route, notice]);
  assert.ok(presentationAt(value, dirt.start).includes(dirt));
  assert.ok(!presentationAt(value, dirt.end).includes(dirt));
  assert.ok(!presentationAt(value, route.end).includes(route));
  const before = presentationAt(value, 6);
  presentationAt(value, 86399.9);
  assert.deepEqual(presentationAt(value, 6), before);
  assert.deepEqual(presentationAt(undefined, 1), []);
});
