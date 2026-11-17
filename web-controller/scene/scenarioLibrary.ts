import { cellIndex } from "./grid";
import { defaultId, type IdFactory } from "./ids";
import { projectForSave, validateProject } from "./model";
import { populateScenarioStory } from "./scenarioStories";
import { SCENE_SCHEMA, type Action, type Door, type Room, type SceneMap, type SceneProject, type Track } from "./types";

export interface ScenarioMeta {
  id: string;
  title: string;
  category: "demo" | "daily" | "tutorial" | "usecase";
  summary: string;
}

export const SCENARIO_CATALOG: readonly ScenarioMeta[] = [
  { id: "fleet-demo", title: "最新テストマップ（会議・清掃連携）", category: "demo", summary: "エントランス・Z字廊下・会議室・充電スペースを備えた標準テストマップ" },
  { id: "office-demo", title: "オフィステスト（直線廊下・受付・EV）", category: "demo", summary: "受付・直線廊下・オフィス・EVを備えたオフィス巡回マップ" },
  { id: "daily-security", title: "1. 日常運用：夜間警備巡回", category: "daily", summary: "昼は3役割が待機。夜になると警備が口の字廊下を一周し、充電場所へ戻ります" },
  { id: "daily-cleaning", title: "2. 日常運用：夜間清掃", category: "daily", summary: "昼は充電待機。夜に清掃がエントランスの一部と廊下を清掃し、他の2台は待機します" },
  { id: "daily-delivery", title: "3. 日常運用：荷物受取とEV乗車", category: "daily", summary: "室内充電場所→セキュリティ扉→荷物受取→扉→EV呼出待機→乗車" },
  { id: "tutorial-passage", title: "4. 基本：通路の優先管理", category: "tutorial", summary: "群管理なしの対向停止と、B待機→A通行→B通行を同じマップで比較します" },
  { id: "tutorial-door", title: "5. 基本：扉の優先管理", category: "tutorial", summary: "扉IN/OUTの対向停止と、A通過→一度閉扉→再開扉→B通過を比較します" },
  { id: "tutorial-fire", title: "6. 基本：火災時の役割分担", category: "tutorial", summary: "口の字通路を反時計回りに走行。火災後、警備は誘導・清掃は退避します" },
  { id: "tutorial-crowd", title: "7. 基本：見えない混雑を回避", category: "tutorial", summary: "建物がロボット視野外の混雑を把握。予定の左回りを右回りへ変更します" },
  { id: "tutorial-dirt", title: "8. 基本：利用跡だけ清掃", category: "tutorial", summary: "会議参加者が退館後、人がいた会議室とエントランスの一部だけを清掃します" },
  { id: "tutorial-vip", title: "9. 基本：VIPお迎え", category: "tutorial", summary: "模擬車番認識→歓迎→扉連動→VIPと同行→EV目的階呼出" },
  { id: "bcp", title: "10. 応用：異常時対応（BCP）", category: "usecase", summary: "警備は異常エリアへ直行。清掃・配送は別々の待機場所へ退避します" },
  { id: "garbage", title: "11. 応用：ゴミ検知→清掃出動", category: "usecase", summary: "カメラによるゴミ検知を可視化し、清掃ロボットが対象ゾーンだけを清掃します" },
  { id: "occupancy", title: "12. 応用：人流変化→清掃出動", category: "usecase", summary: "在室→退室→空室の色変化を表示し、利用終了後に清掃します" },
  { id: "learning", title: "13. 応用：拡張していくビル", category: "usecase", summary: "模擬の蓄積データから需要を予測し、清掃ルート・頻度・警備の役割を切り替えます" },
  { id: "hospitality", title: "14. 応用：おもてなしの進化", category: "usecase", summary: "模擬回答→案内先をハイライト→配送ロボットが対応ゾーンへ移動します" },
  { id: "environment", title: "15. 応用：警備巡回→空調連動", category: "usecase", summary: "巡回地点で環境をスキャン。建物へのデータ通知と空調状態の変化を表示します" },
  { id: "remote", title: "16. 応用：トラブル時の遠隔就労", category: "usecase", summary: "エラー→通知→ゲーム風HUDと操作指示→復旧の自動再生。実操縦ではありません" },
];

export const SIXTEEN_SCENARIO_IDS = SCENARIO_CATALOG.filter((item) => item.category !== "demo").map((item) => item.id);

function rectCells(c0: number, r0: number, c1: number, r1: number): number[] {
  const out: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) out.push(cellIndex(c, r));
  }
  return out;
}

function boundaryDoors(makeId: IdFactory, roomId: string, horizontal: boolean, c0: number, r0: number, length = 10): Door[] {
  const openingId = makeId();
  const edge = horizontal ? "top" : "right";
  const out: Door[] = [];
  for (let i = 0; i < length; i++) {
    const col = horizontal ? c0 + i : c0;
    const row = horizontal ? r0 : r0 + i;
    out.push({ id: makeId(), roomId, openingId, cell: cellIndex(col, row), edge, kind: "automatic" });
  }
  return out;
}

function moveAction(
  makeId: IdFactory,
  name: string,
  position: number,
  runSeconds: number,
  x: number,
  y: number,
  yaw: number,
  roomId: string,
  motion?: "linear" | "rotate",
): Action {
  return {
    id: makeId(),
    name,
    type: "move",
    position,
    runSeconds,
    ...(motion === "rotate" ? { motion: "rotate", rotationSeconds: runSeconds } : {}),
    x,
    y,
    yaw,
    roomId,
    targetId: makeId(),
    text: "",
    state: "meeting",
  };
}

function baseBuilding(makeId: IdFactory): { rooms: Room[]; doors: Door[] } {
  // 55 x 31 grid (1100 x 620 mm).
  // Bottom row rooms (r=2..11): Entrance (c=2..17), Meeting 1 (c=18..36), Meeting 2 (c=37..52)
  // Middle corridor (r=12..19): Corridor (c=2..52)
  // Top row rooms (r=20..28): Office A (c=2..26), Office B (c=27..52)
  const entranceId = "room-entrance";
  const meeting1Id = "room-meeting1";
  const meeting2Id = "room-meeting2";
  const corridorId = "room-corridor";
  const officeAId = "room-office-a";
  const officeBId = "room-office-b";

  const rooms: Room[] = [
    { id: entranceId, name: "エントランス", color: "#73bafa", kind: "room", material: "tile", cells: rectCells(2, 2, 17, 11) },
    { id: meeting1Id, name: "会議室 1", color: "#8d9bff", kind: "room", material: "carpet", cells: rectCells(18, 2, 36, 11) },
    { id: meeting2Id, name: "会議室 2", color: "#58d8ca", kind: "room", material: "wood", cells: rectCells(37, 2, 52, 11) },
    { id: corridorId, name: "メイン廊下", color: "#9aa3a0", kind: "corridor", material: "concrete", cells: rectCells(2, 12, 52, 19) },
    { id: officeAId, name: "オフィス A", color: "#ffbd70", kind: "room", material: "carpet", cells: rectCells(2, 20, 26, 28) },
    { id: officeBId, name: "オフィス B", color: "#bd9afa", kind: "room", material: "wood", cells: rectCells(27, 20, 52, 28) },
  ];

  // 10-cell (200mm) automatic doors on the shared walls with the corridor
  const doors: Door[] = [
    ...boundaryDoors(makeId, entranceId, true, 5, 11, 10),
    ...boundaryDoors(makeId, meeting1Id, true, 22, 11, 10),
    ...boundaryDoors(makeId, meeting2Id, true, 40, 11, 10),
    ...boundaryDoors(makeId, corridorId, true, 5, 19, 10),
    ...boundaryDoors(makeId, corridorId, true, 34, 19, 10),
  ];

  return { rooms, doors };
}

export function buildScenarioMap(scenarioId: string, makeId: IdFactory = defaultId): SceneMap {
  const meta = SCENARIO_CATALOG.find((item) => item.id === scenarioId);
  if (!meta) throw new Error(`未対応のシナリオIDです: ${scenarioId}`);
  if (meta.category !== "demo") {
    const map: SceneMap = { id: makeId(), name: meta.title, editGridMm: 20, doorMode: "strict", rooms: [], tracks: [] };
    populateScenarioStory(map, scenarioId, makeId);
    return projectForSave({ schema: SCENE_SCHEMA, name: meta.title, maps: [map] }).maps[0];
  }
  const { rooms, doors } = baseBuilding(makeId);

  const tracks: Track[] = [];

  const addRobot = (
    name: string,
    color: string,
    role: "cleaning" | "security" | "delivery",
    robotId: string,
    init: { x: number; y: number; yaw: number; roomId: string },
    actions: Action[],
  ) => {
    tracks.push({
      id: makeId(),
      kind: "robot",
      name,
      color,
      muted: false,
      locked: false,
      robotRole: role,
      robotId,
      initial: init,
      actions,
    });
  };

  const addUnlock = (roomId: string, roomName: string, duration = 25) => {
    tracks.push({
      id: makeId(),
      kind: "room",
      name: roomName,
      color: "#73bafa",
      muted: false,
      locked: false,
      roomId,
      actions: [{
        id: makeId(),
        name: `${roomName}解錠`,
        type: "unlock",
        position: 0,
        runSeconds: duration,
        x: 0,
        y: 0,
        yaw: 0,
        roomId,
        targetId: makeId(),
        text: "",
        state: "meeting",
      }],
    });
  };

  for (const room of rooms) {
    addUnlock(room.id, room.name, 25);
  }

  switch (scenarioId) {
    case "fleet-demo": {
      addRobot("清掃ロボット 1", "#58d8ca", "cleaning", "robot-1", { x: 200, y: 120, yaw: 90, roomId: "room-entrance" }, [
        moveAction(makeId, "エントランスから廊下へ", 1, 3, 200, yFor(15), 90, "room-corridor"),
        moveAction(makeId, "東向きへ旋回", 4.5, 1, 200, yFor(15), 0, "room-corridor", "rotate"),
        moveAction(makeId, "廊下を東へ移動", 6, 4, 540, yFor(15), 0, "room-corridor"),
        moveAction(makeId, "南へ旋回", 10.5, 1, 540, yFor(15), -90, "room-corridor", "rotate"),
        moveAction(makeId, "会議室1へ入室", 12, 3, 540, 140, -90, "room-meeting1"),
      ]);
      addRobot("警備ロボット 1", "#8d9bff", "security", "robot-2", { x: 780, y: 480, yaw: -90, roomId: "room-office-b" }, [
        moveAction(makeId, "オフィスB内巡回", 1, 4, 900, 480, 0, "room-office-b"),
      ]);
      tracks.push({
        id: makeId(),
        kind: "human",
        name: "会議参加者",
        color: "#ffbd70",
        muted: false,
        locked: false,
        count: 4,
        initial: { x: 860, y: 140, yaw: 90, roomId: "room-meeting2" },
        actions: [
          moveAction(makeId, "会議室2内移動", 1, 3, 860, 180, 90, "room-meeting2"),
        ],
      });
      break;
    }
    case "office-demo": {
      addRobot("配送ロボット 1", "#ffbd70", "delivery", "robot-1", { x: 260, y: 310, yaw: 0, roomId: "room-corridor" }, [
        moveAction(makeId, "廊下を直進", 1, 5, 780, 310, 0, "room-corridor"),
        moveAction(makeId, "北向きへ旋回", 6.5, 1, 780, 310, 90, "room-corridor", "rotate"),
        moveAction(makeId, "オフィスBへ配送", 8, 4, 780, 490, 90, "room-office-b"),
        moveAction(makeId, "南向きへ旋回", 12.5, 2, 780, 490, -90, "room-office-b", "rotate"),
        moveAction(makeId, "廊下へ帰還", 15, 4, 780, 310, -90, "room-corridor"),
      ]);
      break;
    }
    default:
      throw new Error(`未対応のデモIDです: ${scenarioId}`);
  }

  const map: SceneMap = {
    id: makeId(),
    name: meta.title,
    editGridMm: 20,
    doorMode: "story",
    rooms,
    floorPlan: {
      doors,
      furniture: [],
      walls: [],
      chargingZones: [
        { id: makeId(), name: "充電 1", x: 80, y: 60, width: 100, height: 100 },
      ],
      showRoomLabels: true,
    },
    tracks,
  };

  const validated = validateProject(projectForSave({ schema: SCENE_SCHEMA, name: meta.title, maps: [map] }));
  return validated.maps[0];
}

function yFor(row: number): number {
  return row * 20 + 10;
}

export function buildScenarioProject(scenarioId: string, makeId: IdFactory = defaultId): SceneProject {
  const map = buildScenarioMap(scenarioId, makeId);
  return projectForSave({ schema: SCENE_SCHEMA, name: map.name, maps: [map] });
}
