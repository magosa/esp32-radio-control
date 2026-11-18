import test from "node:test";
import assert from "node:assert/strict";
import { compilePlan, samplePlan } from "../../scene/timedPlan";
import { copyMapLayout, validateProject } from "../../scene/model";
import { SCENARIO_CATALOG, SIXTEEN_SCENARIO_IDS, buildScenarioMap, buildScenarioProject } from "../../scene/scenarioLibrary";
import { presentationAt } from "../../scene/presentation";
import type { SceneMap } from "../../scene/types";
import { shortestTurn } from "../../scene/units";

test("the library contains sixteen distinct scenarios plus the two demo presets", () => {
  assert.equal(SIXTEEN_SCENARIO_IDS.length, 16);
  assert.equal(new Set(SIXTEEN_SCENARIO_IDS).size, 16);
  assert.equal(SCENARIO_CATALOG.length, 18);
});

test("every scenario and demo preset roundtrips through validateProject and compiles with no errors or collision warnings", () => {
  for (const meta of SCENARIO_CATALOG) {
    const project = buildScenarioProject(meta.id);
    const roundtripped = validateProject(JSON.parse(JSON.stringify(project)));
    assert.equal(roundtripped.maps.length, 1, meta.id);
    const map = roundtripped.maps[0];
    const plan = compilePlan(map);
    assert.deepEqual(plan.errors, [], `${meta.id} plan errors`);
    assert.deepEqual(plan.warnings, [], `${meta.id} plan warnings`);
    const end = samplePlan(plan, plan.duration);
    assert.deepEqual(end.errors, [], `${meta.id} sample errors`);
  }
});

test("rejects unknown scenario IDs", () => {
  assert.throws(() => buildScenarioMap("unknown-scenario"), /未対応/);
});

for (const id of SIXTEEN_SCENARIO_IDS) {
  test(`${id}: schema roundtrip, complete playback, facing and collision safety`, () => {
    const map = buildScenarioMap(id);
    const plan = compilePlan(map);
    assert.ok(plan.duration >= 15 && plan.duration <= 90, `${plan.duration}s`);
    assert.ok(map.presentation?.cues.some((cue) => cue.label.includes("SIMULATION ONLY")));
    assert.equal(plan.duration, Math.max(...map.tracks.flatMap((track) => track.actions.map((action) => action.position + action.runSeconds))));
    for (let tick = 0; tick <= Math.ceil(plan.duration * 10); tick++) {
      const state = samplePlan(plan, Math.min(tick / 10, plan.duration));
      assert.deepEqual(state.errors, [], `${id} at ${tick / 10}s`);
      assert.deepEqual(state.warnings, [], `${id} at ${tick / 10}s`);
      for (const actor of state.actors) assert.ok(Number.isFinite(actor.x) && Number.isFinite(actor.y));
    }
    const final = samplePlan(plan, plan.duration);
    for (const track of map.tracks.filter((track) => track.initial)) {
      let from = track.initial!;
      let end = 0;
      for (const action of track.actions) {
        assert.ok(action.position >= end - 1e-6, `${track.name}: overlapping actions`);
        end = action.position + action.runSeconds;
        if (action.type !== "move") continue;
        if (track.kind === "robot" && action.motion !== "rotate") {
          const heading = Math.atan2(action.y - from.y, action.x - from.x) * 180 / Math.PI;
          assert.ok(Math.abs(shortestTurn(from.yaw, heading)) < .001, `${action.name}: not facing destination`);
        }
        if (action.motion === "rotate") {
          assert.deepEqual([action.x, action.y], [from.x, from.y], "turns must stay in place");
        }
        if (track.kind === "human") assert.notEqual(action.motion, "rotate");
        from = action;
      }
      const actor = final.actors.find((item) => item.id === track.id)!;
      assert.ok(Math.hypot(actor.x - from.x, actor.y - from.y) < .001, `${track.name}: missed final position`);
    }
    const before = presentationAt(map.presentation, 6);
    presentationAt(map.presentation, plan.duration - .1);
    assert.deepEqual(presentationAt(map.presentation, 6), before);
    assert.equal(copyMapLayout(map, "配置のみ").presentation, undefined);
  });
}

test("generated stories have independent IDs and can coexist without changing existing maps", () => {
  const first = buildScenarioMap("garbage");
  const snapshot = structuredClone(first);
  const second = buildScenarioMap("garbage");
  assert.notEqual(first.id, second.id);
  assert.doesNotThrow(() => validateProject({ schema: "fleet-scene/v1", name: "independent", maps: [first, second] }));
  assert.deepEqual(first, snapshot);
});

test("daily stories share the building, show three roles and move only the selected role", () => {
  const maps = ["daily-security", "daily-cleaning", "daily-delivery"].map((id) => buildScenarioMap(id));
  const geometry = (map: SceneMap) => map.rooms.map(({ name, cells, appearance }) => ({ name, cells, appearance }));
  assert.deepEqual(geometry(maps[0]), geometry(maps[1]));
  assert.deepEqual(geometry(maps[0]), geometry(maps[2]));
  for (const [index, role] of Array.from(["security", "cleaning", "delivery"].entries())) {
    const map = maps[index];
    const robots = map.tracks.filter((track) => track.kind === "robot");
    assert.equal(robots.length, 3);
    assert.equal(presentationAt(map.presentation, 0).filter((cue) => cue.kind === "route").length, 3);
    const plan = compilePlan(map);
    for (const track of robots) {
      assert.equal(track.actions.some((action) => action.type === "move"), track.robotRole === role);
      if (track.robotRole !== role) {
        const final = samplePlan(plan, plan.duration).actors.find((actor) => actor.id === track.id)!;
        assert.deepEqual([final.x, final.y], [track.initial!.x, track.initial!.y], "standby robot moved");
      }
    }
  }
  for (const map of maps.slice(0, 2)) {
    const active = map.tracks.find((track) => track.actions.some((action) => action.type === "move"))!;
    assert.equal(active.actions[0].type, "wait");
    assert.equal(active.actions[0].runSeconds, 8);
    const final = samplePlan(compilePlan(map), compilePlan(map).duration).actors.find((actor) => actor.id === active.id)!;
    assert.deepEqual([final.x, final.y], [active.initial!.x, active.initial!.y], "must return to charging");
  }
  const courier = maps[2].tracks.find((track) => track.robotRole === "delivery")!;
  assert.ok(courier.actions.some((action) => action.type === "wait" && action.name.includes("荷物受取")));
  assert.ok(courier.actions.some((action) => action.type === "wait" && action.name.includes("EV")));
  assert.equal(courier.actions.at(-1)!.roomId, maps[2].rooms.find((room) => room.appearance === "elevator")!.id);
});

test("passage and door stories demonstrate opposing approach, B yielding, then sequential crossing", () => {
  for (const id of ["tutorial-passage", "tutorial-door"]) {
    const map = buildScenarioMap(id);
    const [a, b] = map.tracks.filter((track) => track.kind === "robot");
    const plan = compilePlan(map);
    const stopped = samplePlan(plan, 9);
    const ax = stopped.actors.find((actor) => actor.id === a.id)!.x;
    const bx = stopped.actors.find((actor) => actor.id === b.id)!.x;
    assert.ok(ax < bx);
    const yieldMove = b.actions.findLast((action) => action.name === "Bは入口の待機場所へ")!;
    const aCross = a.actions.find((action) => action.name === "Aが優先通行")!;
    const bCross = b.actions.find((action) => action.name === "Bが通行")!;
    assert.ok(yieldMove.position + yieldMove.runSeconds < aCross.position);
    assert.ok(bCross.position > aCross.position + aCross.runSeconds);
    assert.ok(aCross.x > bx && bCross.x < ax);
  }
  const map = buildScenarioMap("tutorial-door");
  const plan = compilePlan(map);
  const controls = map.tracks.find((track) => track.kind === "room")!.actions;
  assert.equal(controls.length, 3);
  const [, a, b] = controls;
  const gap = a.position + a.runSeconds + 1;
  assert.ok(gap < b.position);
  assert.equal(samplePlan(plan, gap).doors[0].openness, 0);
  for (const window of [a, b]) {
    assert.ok(Array.from({ length: Math.floor(window.runSeconds * 10) }, (_, tick) =>
      samplePlan(plan, window.position + tick / 10).doors[0].openness).some((open) => open > .5));
  }
});

test("dirt disappears only after the cleaner works inside each partial dirty zone", () => {
  for (const id of ["garbage", "tutorial-dirt", "occupancy", "daily-cleaning"]) {
    const map = buildScenarioMap(id);
    const plan = compilePlan(map);
    const dirt = map.presentation!.cues.filter((cue) => cue.kind === "dirt");
    const cleaner = map.tracks.find((track) => track.robotRole === "cleaning")!;
    assert.ok(dirt.length > 0);
    for (const cue of dirt) {
      assert.ok(cue.width! * cue.height! < 220 * 220);
      assert.ok(presentationAt(map.presentation, cue.start).includes(cue));
      assert.ok(!presentationAt(map.presentation, cue.end).includes(cue));
      const work = cleaner.actions.find((action) => action.type === "wait" &&
        Math.abs(action.position + action.runSeconds - cue.end) < .001);
      assert.ok(work, `${id}: dirty zone must end with cleaning work`);
      const actor = samplePlan(plan, cue.end - .01).actors.find((item) => item.id === cleaner.id)!;
      assert.ok(actor.x >= cue.x! && actor.x <= cue.x! + cue.width! && actor.y >= cue.y! && actor.y <= cue.y! + cue.height!);
    }
    if (id === "tutorial-dirt" || id === "occupancy") {
      const people = map.tracks.find((track) => track.kind === "human")!;
      const exit = people.actions.at(-1)!;
      assert.ok(cleaner.actions[0].position >= exit.position + exit.runSeconds + 2 - 1e-6, "cleaner must wait for people to leave");
    }
  }
});

test("crowd detection outside local view precedes changing the planned route", () => {
  const map = buildScenarioMap("tutorial-crowd");
  const crowd = map.presentation!.cues.find((cue) => cue.kind === "crowd")!;
  const sensor = map.presentation!.cues.find((cue) => cue.kind === "scan")!;
  const routes = map.presentation!.cues.filter((cue) => cue.kind === "route");
  assert.equal(routes.length, 2);
  assert.ok(crowd.x! + crowd.width! < sensor.x!);
  assert.ok(crowd.start < routes[1].start && routes[0].end <= routes[1].start);
  const delivery = map.tracks.find((track) => track.robotRole === "delivery")!;
  assert.ok(delivery.actions.filter((action) => action.type === "move").every((action) => action.y < crowd.y!));
  assert.ok(routes[0].points!.some(([, y]) => y >= crowd.y!), "original plan must use the upper route");
});

test("fire and BCP assign security to the incident and other roles to separate refuge areas", () => {
  for (const id of ["tutorial-fire", "bcp"]) {
    const map = buildScenarioMap(id);
    const fire = map.presentation!.cues.find((cue) => cue.kind === "fire")!;
    const robots = map.tracks.filter((track) => track.kind === "robot");
    assert.equal(robots.length, id === "bcp" ? 3 : 2);
    const security = robots.find((track) => track.robotRole === "security")!;
    const cleaner = robots.find((track) => track.robotRole === "cleaning")!;
    assert.ok(security.actions.some((action) => action.position > fire.start && action.name === "異常エリアへ直行"));
    assert.ok(cleaner.actions.some((action) => action.position > fire.start && action.name.includes("退避")));
    const state = samplePlan(compilePlan(map), fire.end);
    const cleaning = state.actors.find((actor) => actor.id === cleaner.id)!;
    const refuge = map.presentation!.cues.find((cue) => cue.label === "清掃 待機・退避")!;
    assert.ok(cleaning.x >= refuge.x! && cleaning.x <= refuge.x! + refuge.width! &&
      cleaning.y >= refuge.y! && cleaning.y <= refuge.y! + refuge.height!);
    if (id === "bcp") {
      const delivery = robots.find((track) => track.robotRole === "delivery")!;
      const actor = state.actors.find((item) => item.id === delivery.id)!;
      assert.ok(Math.hypot(actor.x - cleaning.x, actor.y - cleaning.y) > 120);
      assert.ok(delivery.actions.some((action) => action.name.includes("配送専用待機")));
    }
  }
});

test("VIP, prediction, hospitality, environment and remote have their own actors and timed interactions", () => {
  const vip = buildScenarioMap("tutorial-vip");
  assert.ok(vip.tracks.some((track) => track.kind === "human" && track.count === 1));
  assert.ok(vip.presentation!.cues.some((cue) => cue.kind === "car"));
  const guide = vip.tracks.find((track) => track.robotRole === "security")!;
  assert.equal(guide.actions.at(-1)!.roomId, vip.rooms.find((room) => room.appearance === "elevator")!.id);

  const learning = buildScenarioMap("learning");
  assert.equal(learning.tracks.filter((track) => track.kind === "robot").length, 2);
  assert.ok(learning.tracks.flatMap((track) => track.actions).some((action) => action.name === "高頻度ゾーンを再巡回"));
  assert.ok(learning.presentation!.cues.some((cue) => cue.kind === "dirt"));

  const hospitality = buildScenarioMap("hospitality");
  const destination = hospitality.presentation!.cues.find((cue) => cue.kind === "zone")!;
  const courier = hospitality.tracks.find((track) => track.kind === "robot")!;
  assert.ok(destination.start < courier.actions[0].position, "answer must highlight the destination before departure");
  assert.ok(hospitality.presentation!.cues.some((cue) => cue.kind === "route"));

  const environment = buildScenarioMap("environment");
  const scans = environment.presentation!.cues.filter((cue) => cue.kind === "scan");
  assert.equal(scans.length, 3);
  const measurements = environment.tracks.flatMap((track) => track.actions).filter((action) => action.name === "環境スキャン・空調連動");
  assert.equal(measurements.length, 3);
  for (const [index, scan] of Array.from(scans.entries())) assert.equal(scan.start, measurements[index].position);

  const remote = buildScenarioMap("remote");
  const robot = remote.tracks.find((track) => track.kind === "robot")!;
  const stop = robot.actions.find((action) => action.type === "wait")!;
  const plan = compilePlan(remote);
  const at = (time: number) => {
    const actor = samplePlan(plan, time).actors.find((item) => item.id === robot.id)!;
    return [actor.x, actor.y];
  };
  assert.deepEqual(at(stop.position), at(stop.position + stop.runSeconds - .01));
  assert.ok(presentationAt(remote.presentation, stop.position + 5).some((cue) => cue.label.includes("REMOTE HUD")));
  assert.ok(robot.actions.some((action) => action.position >= stop.position + stop.runSeconds && action.name === "REMOTE: UP / LEFT"));
});
