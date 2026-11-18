import path from "path";
import { defaultId } from "../scene/ids";
import { cellIndex } from "../scene/grid";
import { SceneHistoryStore } from "../fleet/sceneHistoryStore";
import { projectForSave, validateProject } from "../scene/model";
import { compilePlan } from "../scene/timedPlan";
import { createSafety } from "../scene/safety";
import type { Action, Room, SceneMap, SceneProject, Track } from "../scene/types";

function rectCells(c0: number, r0: number, c1: number, r1: number): number[] {
  const out: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) out.push(cellIndex(c, r));
  }
  return out;
}

function moveAct(name: string, pos: number, dur: number, x: number, y: number, yaw: number, roomId: string): Action {
  return {
    id: defaultId(),
    name,
    type: "move",
    position: pos,
    runSeconds: dur,
    x,
    y,
    yaw,
    roomId,
    targetId: defaultId(),
    text: "",
    state: "meeting",
  };
}

async function main() {
  const historyDir = path.join(process.cwd(), "data", "scene-history");
  const store = SceneHistoryStore.open(historyDir);
  const latest = store.latest();
  if (!latest) {
    console.error("No scene history found!");
    process.exit(1);
  }

  const arenaId = "room-arena-quad";
  const arenaRoom: Room = {
    id: arenaId,
    name: "テストアリーナ（全面）",
    color: "#60a5fa",
    kind: "room",
    material: "tile",
    cells: rectCells(1, 1, 53, 29),
  };

  const robot0TrackId = "track-robot-quad-0";
  const robot1TrackId = "track-robot-spiral-1";

  // ロボット0: 中心 (450, 310) を起点に四隅と中心を行き来
  // 1. 左下 (180, 150)
  // 2. 左上 (180, 470)
  // 3. 右下 (920, 150)
  // 4. 右上 (920, 470)
  const r0Actions: Action[] = [
    moveAct("中心集合", 0, 2.5, 450, 310, 0, arenaId),
    moveAct("左下へ", 3.5, 4, 180, 150, -150, arenaId),
    moveAct("中心へ戻る(1)", 8.5, 4, 450, 310, 30, arenaId),
    moveAct("左上へ", 13.5, 4, 180, 470, 150, arenaId),
    moveAct("中心へ戻る(2)", 18.5, 4, 450, 310, -30, arenaId),
    moveAct("右下へ", 23.5, 4.5, 920, 150, -30, arenaId),
    moveAct("中心へ戻る(3)", 29, 4.5, 450, 310, 150, arenaId),
    moveAct("右上へ", 34.5, 4.5, 920, 470, 30, arenaId),
    moveAct("中心へ戻る(4)", 40, 4.5, 450, 310, -150, arenaId),
  ];

  // ロボット1: 中心 (650, 310) を起点にらせん状に範囲内を走る
  // 150mm以上の離隔を保ちながら外側へ拡大
  const r1Actions: Action[] = [
    moveAct("中心集合", 0, 2.5, 650, 310, 0, arenaId),
    moveAct("らせん1 (右)", 3.5, 3, 750, 310, 0, arenaId),
    moveAct("らせん2 (上)", 7, 3, 750, 450, 90, arenaId),
    moveAct("らせん3 (左)", 10.5, 3.5, 580, 450, 180, arenaId),
    moveAct("らせん4 (下)", 14.5, 4, 580, 170, -90, arenaId),
    moveAct("らせん5 (右)", 19, 4, 830, 170, 0, arenaId),
    moveAct("らせん6 (上)", 23.5, 4.5, 830, 490, 90, arenaId),
    moveAct("らせん7 (左)", 28.5, 4.5, 320, 490, 180, arenaId),
    moveAct("らせん8 (下)", 33.5, 4, 320, 130, -90, arenaId),
    moveAct("らせん9 (右)", 38, 5, 950, 130, 0, arenaId),
  ];

  const tracks: Track[] = [
    {
      id: robot0TrackId,
      name: "ロボット 0 (四隅往復)",
      kind: "robot",
      robotId: "robot-rc-a5f848",
      color: "#3b82f6",
      muted: false,
      locked: false,
      initial: { x: 450, y: 310, yaw: 0, roomId: arenaId },
      actions: r0Actions,
    },
    {
      id: robot1TrackId,
      name: "ロボット 1 (らせん走行)",
      kind: "robot",
      robotId: "robot-rc-a50a28",
      color: "#10b981",
      muted: false,
      locked: false,
      initial: { x: 650, y: 310, yaw: 0, roomId: arenaId },
      actions: r1Actions,
    },
  ];

  const newMap: SceneMap = {
    id: "map-quad-and-spiral",
    name: "実機テスト（四隅往復・らせん走行）",
    editGridMm: 20,
    doorMode: "story",
    rooms: [arenaRoom],
    tracks,
  };

  const plan = compilePlan(newMap);
  console.log(`Plan compiled: ${plan.entries.length} entries, duration: ${plan.duration}s`);
  const blocked = plan.entries.filter((e) => e.blocked);
  if (blocked.length > 0) {
    console.error("Blocked entries found:", blocked);
    process.exit(1);
  }

  const existingProject = latest.project;
  const filteredMaps = existingProject.maps.filter((m) => m.id !== newMap.id);
  const updatedProject: SceneProject = {
    ...existingProject,
    maps: [newMap, ...filteredMaps],
  };

  validateProject(updatedProject);

  const result = store.append({
    expectedRevision: latest.revision,
    id: `add-test-scenario-${Date.now()}`,
    label: "実機テストシナリオ追加（四隅往復・らせん走行）",
    project: updatedProject,
  });

  store.close();
  console.log("Successfully appended new revision:", result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
