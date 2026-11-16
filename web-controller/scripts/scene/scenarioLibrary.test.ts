import test from "node:test";
import assert from "node:assert/strict";
import { compilePlan, samplePlan } from "../../scene/timedPlan";
import { validateProject } from "../../scene/model";
import { SCENARIO_CATALOG, SIXTEEN_SCENARIO_IDS, buildScenarioMap, buildScenarioProject } from "../../scene/scenarioLibrary";

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
