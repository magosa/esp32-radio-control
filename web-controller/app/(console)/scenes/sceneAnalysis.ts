import { compilePlan, samplePlan } from "@/scene/timedPlan";
import type { SceneMap } from "@/scene/types";

function analyze(map: SceneMap) {
  const plan = compilePlan(map);
  const done = samplePlan(plan, plan.duration);
  return { plan, duration: plan.duration, states: done.actionStates, warnings: done.warnings, errors: done.errors };
}

// Scene edits replace the map object; views of the same immutable map share one analysis.
const cache = new WeakMap<SceneMap, ReturnType<typeof analyze>>();

export function sceneAnalysis(map: SceneMap): ReturnType<typeof analyze> {
  let result = cache.get(map);
  if (!result) {
    result = analyze(map);
    cache.set(map, result);
  }
  return result;
}
