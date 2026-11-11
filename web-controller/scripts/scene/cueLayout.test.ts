import assert from "node:assert/strict";
import test from "node:test";
import { layoutCue, layoutCues, wrapLabel } from "../../scene/cueLayout";
import type { Presentation, PresentationCue } from "../../scene/types";

const cue = (over: Partial<PresentationCue> & Pick<PresentationCue, "kind">): PresentationCue =>
  ({ start: 0, end: 10, label: "ラベル", color: "#ff8800", ...over });
const area = { x: 100, y: 200, width: 300, height: 120 };

test("wrapLabel breaks by character, keeps whole code points and never returns no line", () => {
  assert.deepEqual(wrapLabel("あいうえおかきく", 3), ["あいう", "えおか", "きく"]);
  assert.deepEqual(wrapLabel("😀😀😀😀", 2), ["😀😀", "😀😀"]);
  assert.deepEqual(wrapLabel("", 5), [""]);
});

test("a rectangular cue is flipped into SVG space, y measured from the top", () => {
  const shape = layoutCue(cue({ kind: "zone", ...area }), 0, 0);
  if (shape.kind !== "zone") throw new Error("not a zone");
  assert.deepEqual([shape.x, shape.y, shape.width, shape.height], [100, 620 - 200 - 120, 300, 120]);
  assert.equal(shape.dashed, true);
  assert.deepEqual(shape.marks, []);
  assert.equal(shape.body, null);
});

test("only a zone is dashed; dirt, crowd, fire and scan get twelve marks, other kinds none", () => {
  for (const kind of ["dirt", "crowd", "fire", "scan"] as const) {
    const shape = layoutCue(cue({ kind, ...area }), 0, 0);
    if (shape.kind === "notice" || shape.kind === "route") throw new Error("unexpected");
    assert.equal(shape.dashed, false, kind);
    assert.equal(shape.marks.length, 12, kind);
    assert.ok(shape.marks.every((m) => m.x > area.x && m.x < area.x + area.width && m.y > shape.y && m.y < shape.y + area.height), kind);
    assert.ok(shape.marks.every((m) => m.shape === (kind === "scan" ? "cross" : "dot")), kind);
  }
  for (const kind of ["zone", "car"] as const) {
    const shape = layoutCue(cue({ kind, ...area }), 0, 0);
    if (shape.kind === "notice" || shape.kind === "route") throw new Error("unexpected");
    assert.equal(shape.marks.length, 0, kind);
  }
});

test("marks are deterministic, so a redraw does not make them jump", () => {
  const a = layoutCue(cue({ kind: "dirt", ...area }), 0, 0);
  const b = layoutCue(cue({ kind: "dirt", ...area }), 0, 0);
  assert.deepEqual(a, b);
});

test("a crowd draws uniform dots and dirt draws dots of several sizes", () => {
  const sizes = (kind: "crowd" | "dirt") => {
    const shape = layoutCue(cue({ kind, ...area }), 0, 0);
    if (shape.kind === "notice" || shape.kind === "route") throw new Error("unexpected");
    return new Set(shape.marks.map((m) => m.r.toFixed(4)));
  };
  assert.equal(sizes("crowd").size, 1);
  assert.equal(sizes("dirt").size, 4);
});

test("a car has a body inside its frame", () => {
  const shape = layoutCue(cue({ kind: "car", ...area }), 0, 0);
  if (shape.kind === "notice" || shape.kind === "route" || !shape.body) throw new Error("no body");
  assert.ok(shape.body.x > shape.x && shape.body.x + shape.body.width < shape.x + shape.width);
  assert.ok(shape.body.y > shape.y && shape.body.y + shape.body.height <= shape.y + shape.height);
});

test("a long label wraps inside the width and keeps every character", () => {
  const label = "あ".repeat(40);
  const shape = layoutCue(cue({ kind: "zone", label, ...area }), 0, 0);
  assert.ok(shape.text.lines.length > 1);
  assert.equal(shape.text.lines.join(""), label);
  assert.ok(shape.text.lines.every((line) => line.length * shape.text.size <= area.width));
});

test("a narrow cue still wraps at five characters or more", () => {
  const shape = layoutCue(cue({ kind: "zone", label: "あいうえおかきくけこ", x: 0, y: 0, width: 20, height: 40 }), 0, 0);
  assert.deepEqual(shape.text.lines, ["あいうえお", "かきくけこ"]);
});

test("a route flips its points, puts an arrow on every point after the first, and points them along the leg", () => {
  const shape = layoutCue(cue({ kind: "route", points: [[100, 100], [300, 100], [300, 300]] }), 0, 0);
  if (shape.kind !== "route") throw new Error("not a route");
  assert.deepEqual(shape.points, [{ x: 100, y: 520 }, { x: 300, y: 520 }, { x: 300, y: 320 }]);
  assert.equal(shape.arrows.length, 2);
  assert.ok(Math.abs(shape.arrows[0].angle - 0) < 1e-9, "east");
  assert.ok(Math.abs(shape.arrows[1].angle - -90) < 1e-9, "up on screen is -90 in SVG");
  assert.ok(shape.text.x <= 1000 * 1100 / 1600);
});

test("notices stack downward from the top, each in its own row", () => {
  const first = layoutCue(cue({ kind: "notice" }), 0, 0), second = layoutCue(cue({ kind: "notice" }), 1, 0);
  if (first.kind !== "notice" || second.kind !== "notice") throw new Error("not a notice");
  assert.ok(second.y > first.y + first.height);
  assert.ok(first.x > 0 && first.x + first.width < 1100);
});

test("text never gets smaller than the legible size on a small view, and is never larger than designed on a large one", () => {
  const big = layoutCue(cue({ kind: "zone", ...area }), 0, 10);
  const small = layoutCue(cue({ kind: "zone", ...area }), 0, 0.2);
  assert.ok(small.text.size >= 12 / 0.2 - 1e-9);
  assert.ok(big.text.size < small.text.size);
});

test("layoutCues shows only the cues active at the time and numbers notices in order", () => {
  const presentation: Presentation = { version: 1, scenarioId: "s", cues: [
    cue({ kind: "notice", start: 0, end: 5, label: "a" }),
    cue({ kind: "zone", start: 3, end: 8, ...area }),
    cue({ kind: "notice", start: 4, end: 9, label: "b" }),
    cue({ kind: "dirt", start: 8, end: 12, ...area }),
  ] };
  assert.deepEqual(layoutCues(presentation, 1, 0).map((s) => s.kind), ["notice"]);
  assert.deepEqual(layoutCues(presentation, 4, 0).map((s) => s.kind), ["notice", "zone", "notice"]);
  const [a, , b] = layoutCues(presentation, 4, 0);
  if (a.kind !== "notice" || b.kind !== "notice") throw new Error("not notices");
  assert.ok(b.y > a.y);
  assert.deepEqual(layoutCues(presentation, 8, 0).map((s) => s.kind), ["notice", "dirt"], "the zone has ended; the notice has not");
  assert.deepEqual(layoutCues(presentation, 9, 0).map((s) => s.kind), ["dirt"], "end is exclusive");
  assert.deepEqual(layoutCues(undefined, 4, 0), []);
});

test("a notice can be pulled in from both sides so it stays clear of the corners", () => {
  const plain = layoutCue(cue({ kind: "notice" }), 0, 0), inset = layoutCue(cue({ kind: "notice" }), 0, 0, 73);
  if (plain.kind !== "notice" || inset.kind !== "notice") throw new Error("not a notice");
  assert.equal(inset.x, 73);
  assert.equal(inset.x + inset.width, 1100 - 73);
  assert.ok(inset.text.x > inset.x);
  assert.equal(layoutCue(cue({ kind: "notice" }), 0, 0, 3).kind === "notice" && (layoutCue(cue({ kind: "notice" }), 0, 0, 3) as { x: number }).x, plain.x, "a small inset never moves it outward");
  assert.equal((layoutCues({ version: 1, scenarioId: "s", cues: [cue({ kind: "notice" })] }, 1, 0, 73)[0] as { x: number }).x, 73);
});