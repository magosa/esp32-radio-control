import assert from "node:assert/strict";
import test from "node:test";
import { applyExhibit, exhibitTime, initialExhibit, parseExhibitCommand, type ExhibitSession } from "../../scene/exhibitSession";

const open = (now = 1000): ExhibitSession => applyExhibit(initialExhibit(0), { type: "open", mapId: "m1" }, now) as ExhibitSession;

test("opening a map starts paused at 0 and raises the revision", () => {
  const session = open();
  assert.equal(session.mapId, "m1");
  assert.equal(session.running, false);
  assert.equal(exhibitTime(session, 99_999), 0);
  assert.equal(session.revision, 1);
});

test("play advances the time with the clock; pause freezes it", () => {
  const playing = applyExhibit(open(1000), { type: "play" }, 1000) as ExhibitSession;
  assert.equal(exhibitTime(playing, 4500), 3.5);
  const paused = applyExhibit(playing, { type: "pause" }, 4500) as ExhibitSession;
  assert.equal(paused.position, 3.5);
  assert.equal(exhibitTime(paused, 60_000), 3.5);
});

test("play after a pause resumes from the paused time", () => {
  const playing = applyExhibit(open(0), { type: "play" }, 0) as ExhibitSession;
  const paused = applyExhibit(playing, { type: "pause" }, 2000) as ExhibitSession;
  const again = applyExhibit(paused, { type: "play" }, 10_000) as ExhibitSession;
  assert.equal(exhibitTime(again, 11_000), 3);
});

test("seek while playing keeps playing from the new time", () => {
  const playing = applyExhibit(open(0), { type: "play" }, 0) as ExhibitSession;
  const sought = applyExhibit(playing, { type: "seek", time: 20 }, 5000) as ExhibitSession;
  assert.equal(sought.running, true);
  assert.equal(exhibitTime(sought, 7000), 22);
});

test("the clock stops at the scene duration and never goes below 0", () => {
  const playing = applyExhibit(open(0), { type: "play" }, 0) as ExhibitSession;
  assert.equal(exhibitTime(playing, 100_000, 30), 30);
  assert.equal(exhibitTime(playing, -5000), 0);
});

test("play and seek are refused while no map is open; close resets", () => {
  const idle = initialExhibit(0);
  assert.equal(typeof applyExhibit(idle, { type: "play" }, 0), "string");
  assert.equal(typeof applyExhibit(idle, { type: "seek", time: 3 }, 0), "string");
  const closed = applyExhibit(open(), { type: "close" }, 2000) as ExhibitSession;
  assert.equal(closed.mapId, null);
  assert.equal(closed.running, false);
  assert.equal(closed.position, 0);
});

test("repeating play or pause changes nothing (no new revision)", () => {
  const playing = applyExhibit(open(0), { type: "play" }, 0) as ExhibitSession;
  assert.equal(applyExhibit(playing, { type: "play" }, 500), playing);
  const paused = open();
  assert.equal(applyExhibit(paused, { type: "pause" }, 500), paused);
});

test("opening another map resets the time and stops", () => {
  const playing = applyExhibit(open(0), { type: "play" }, 0) as ExhibitSession;
  const other = applyExhibit(playing, { type: "open", mapId: "m2" }, 9000) as ExhibitSession;
  assert.equal(other.mapId, "m2");
  assert.equal(other.running, false);
  assert.equal(other.position, 0);
});

test("parseExhibitCommand accepts the five commands and rejects bad input", () => {
  assert.deepEqual(parseExhibitCommand({ type: "open", mapId: "abc" }), { type: "open", mapId: "abc" });
  assert.deepEqual(parseExhibitCommand({ type: "play" }), { type: "play" });
  assert.deepEqual(parseExhibitCommand({ type: "pause", extra: 1 }), { type: "pause" });
  assert.deepEqual(parseExhibitCommand({ type: "close" }), { type: "close" });
  assert.deepEqual(parseExhibitCommand({ type: "seek", time: 12.5 }), { type: "seek", time: 12.5 });
  for (const bad of [null, 5, "play", {}, { type: "nope" }, { type: "open" }, { type: "open", mapId: "" },
    { type: "open", mapId: "x".repeat(101) }, { type: "open", mapId: 7 }, { type: "seek" }, { type: "seek", time: -1 },
    { type: "seek", time: NaN }, { type: "seek", time: Infinity }, { type: "seek", time: 86_401 }, { type: "seek", time: "3" }]) {
    assert.equal(parseExhibitCommand(bad), null, JSON.stringify(bad));
  }
});
