import test from "node:test";
import assert from "node:assert/strict";
import {
  SPEEDS, clampTo, home, initialPlayback, seek, setSpeed, step, toggle, toggleLoop,
  type PlaybackState,
} from "../../scene/playback";

const state = (over: Partial<PlaybackState> = {}): PlaybackState => ({
  time: 0, running: false, looping: false, speed: 1, ...over,
});

test("initialPlayback is stopped at 0 with speed 1 and no loop", () => {
  assert.deepEqual(initialPlayback(), { time: 0, running: false, looping: false, speed: 1 });
  assert.deepEqual(SPEEDS, [0.5, 1, 2, 4]);
});

test("step advances by deltaMs * speed for every speed", () => {
  for (const speed of SPEEDS) {
    const next = step(state({ running: true, speed }), 500, 100);
    assert.equal(next.time, 0.5 * speed);
    assert.equal(next.running, true);
  }
});

test("step does not move a paused state", () => {
  assert.deepEqual(step(state({ time: 3 }), 1000, 10), state({ time: 3 }));
});

test("step stops at the end without loop", () => {
  const next = step(state({ time: 9.5, running: true }), 1000, 10);
  assert.equal(next.time, 10);
  assert.equal(next.running, false);
});

test("step reaching the end exactly stops", () => {
  const next = step(state({ time: 9, running: true }), 1000, 10);
  assert.equal(next.time, 10);
  assert.equal(next.running, false);
});

test("step wraps to 0 with loop and keeps running", () => {
  const next = step(state({ time: 9.5, running: true, looping: true }), 1000, 10);
  assert.equal(next.time, 0);
  assert.equal(next.running, true);
});

test("step with a huge delta stays in range", () => {
  const stop = step(state({ running: true, speed: 4 }), 3_600_000, 10);
  assert.equal(stop.time, 10);
  assert.equal(stop.running, false);
  const loop = step(state({ running: true, looping: true, speed: 4 }), 3_600_000, 10);
  assert.ok(loop.time >= 0 && loop.time <= 10);
  assert.equal(loop.running, true);
});

test("step with duration 0 does not move and stops", () => {
  const next = step(state({ running: true, looping: true }), 1000, 0);
  assert.equal(next.time, 0);
  assert.equal(next.running, false);
});

test("step ignores negative and non-finite deltas", () => {
  assert.equal(step(state({ time: 2, running: true }), -500, 10).time, 2);
  assert.equal(step(state({ time: 2, running: true }), NaN, 10).time, 2);
});

test("step does not mutate its input", () => {
  const s = state({ time: 1, running: true });
  const frozen = Object.freeze({ ...s });
  const next = step(frozen, 1000, 10);
  assert.notEqual(next, frozen);
  assert.equal(frozen.time, 1);
});

test("toggle pauses a running state", () => {
  const next = toggle(state({ time: 4, running: true }), 10);
  assert.equal(next.running, false);
  assert.equal(next.time, 4);
});

test("toggle starts from the middle", () => {
  const next = toggle(state({ time: 4 }), 10);
  assert.equal(next.running, true);
  assert.equal(next.time, 4);
});

test("toggle at the end restarts from the beginning", () => {
  const next = toggle(state({ time: 10 }), 10);
  assert.equal(next.running, true);
  assert.equal(next.time, 0);
});

test("toggle does nothing useful when the duration is 0", () => {
  const next = toggle(state(), 0);
  assert.equal(next.running, false);
  assert.equal(next.time, 0);
});

test("seek clamps to 0..duration and keeps the other fields", () => {
  const s = state({ running: true, looping: true, speed: 2 });
  assert.equal(seek(s, 5, 10).time, 5);
  assert.equal(seek(s, -3, 10).time, 0);
  assert.equal(seek(s, 99, 10).time, 10);
  assert.equal(seek(s, NaN, 10).time, 0);
  assert.equal(seek(s, 5, 0).time, 0);
  assert.deepEqual({ ...seek(s, 5, 10), time: 0 }, { ...s, time: 0 });
});

test("home goes to 0 and pauses", () => {
  const next = home(state({ time: 7, running: true, looping: true, speed: 2 }));
  assert.deepEqual(next, state({ time: 0, running: false, looping: true, speed: 2 }));
});

test("setSpeed accepts only SPEEDS", () => {
  for (const s of SPEEDS) assert.equal(setSpeed(state(), s).speed, s);
  for (const bad of [0, 3, -1, NaN, 1.5]) {
    assert.throws(() => setSpeed(state(), bad), /再生速度/);
  }
});

test("toggleLoop flips looping", () => {
  assert.equal(toggleLoop(state()).looping, true);
  assert.equal(toggleLoop(state({ looping: true })).looping, false);
});

test("clampTo pulls the time into a shrunken duration", () => {
  assert.equal(clampTo(state({ time: 20 }), 10).time, 10);
  assert.equal(clampTo(state({ time: 5 }), 10).time, 5);
  const zero = clampTo(state({ time: 5, running: true }), 0);
  assert.equal(zero.time, 0);
  assert.equal(zero.running, false);
});

test("clampTo keeps a running state running while it still has time", () => {
  assert.equal(clampTo(state({ time: 5, running: true }), 10).running, true);
});
