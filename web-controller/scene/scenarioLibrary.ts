import { cellIndex } from "./grid";
import { defaultId, type IdFactory } from "./ids";
import { projectForSave, validateProject } from "./model";
import { SCENE_SCHEMA, type Action, type Door, type Presentation, type Room, type SceneMap, type SceneProject, type Track } from "./types";

export interface ScenarioMeta {
  id: string;
  title: string;
  category: "demo" | "daily" | "tutorial" | "usecase";
  summary: string;
}

export const SCENARIO_CATALOG: readonly ScenarioMeta[] = [
  { id: "fleet-demo", title: "最新テストマップ（会議・清掃連携）", category: "demo", summary: "エントランス・Z字廊下・会議室・充電スペースを備えた標準テストマップ" },
  { id: "office-demo", title: "オフィステスト（直線廊下・受付・EV）", category: "demo", summary: "受付・直線廊下・オフィス・EVを備えたオフィス巡回マップ" },
  { id: "daily-security", title: "1. 日常警備巡回", category: "daily", summary: "警備ロボットが各部屋と廊下を巡回し、待機機は充電スペースに留まります" },
  { id: "daily-cleaning", title: "2. 日常清掃ルート", category: "daily", summary: "清掃ロボットが会議室と廊下を順番に清掃して充電スペースへ戻ります" },
  { id: "daily-delivery", title: "3. 日常配送ルート", category: "daily", summary: "配送ロボットが受付からオフィスへ荷物を届けて帰還します" },
  { id: "tutorial-passage", title: "4. 基本：廊下の通過", category: "tutorial", summary: "旋回してから直進する基本動作のチュートリアル" },
  { id: "tutorial-door", title: "5. 基本：自動ドアの解錠と通過", category: "tutorial", summary: "部屋の解錠バーに合わせてドアを通過するチュートリアル" },
  { id: "tutorial-fire", title: "6. 基本：火災発生と退避・確認", category: "tutorial", summary: "火災イベント発生時に清掃機が退避し、警備機が確認に向かいます" },
  { id: "tutorial-crowd", title: "7. 基本：混雑情報の通知と迂回", category: "tutorial", summary: "混雑エリアの表示に先行して別ルートで目的地へ向かいます" },
  { id: "tutorial-dirt", title: "8. 基本：汚れ検知と清掃完了", category: "tutorial", summary: "汚れ表示があるエリアを清掃し、完了とともに汚れ表示が消えます" },
  { id: "tutorial-vip", title: "9. 基本：来客（VIP）の案内", category: "tutorial", summary: "受付から会議室まで来客グループを先導して案内します" },
  { id: "bcp", title: "10. 応用：停電・BCP避難誘導", category: "usecase", summary: "停電発生時に案内表示を出しながら避難経路を確保します" },
  { id: "garbage", title: "11. 応用：各室ゴミ回収巡回", category: "usecase", summary: "複数の部屋を回って回収作業を行い集積場所へ運びます" },
  { id: "occupancy", title: "12. 応用：会議室利用後の自動清掃", category: "usecase", summary: "会議終了と退室を待ってから清掃ロボットが入室します" },
  { id: "learning", title: "13. 応用：巡回ルートの検証走行", category: "usecase", summary: "複数のチェックポイントを定速で回り通行安全を確認します" },
  { id: "hospitality", title: "14. 応用：おもてなし・会議室準備", category: "usecase", summary: "来客到着前に会議室の清掃と案内表示を完了させます" },
  { id: "environment", title: "15. 応用：環境計測パトロール", category: "usecase", summary: "各部屋の温度・空気質を計測しながらステータスを表示します" },
  { id: "remote", title: "16. 応用：遠隔点検・夜間見回り", category: "usecase", summary: "夜間の施錠エリアを順番に解錠しながら点検します" },
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
  const { rooms, doors } = baseBuilding(makeId);

  const tracks: Track[] = [];
  let presentation: Presentation | undefined;

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
    case "daily-security": {
      addRobot("警備ロボット", "#8d9bff", "security", "robot-sec", { x: 260, y: 310, yaw: 0, roomId: "room-corridor" }, [
        moveAction(makeId, "東端まで巡回", 1, 6, 780, 310, 0, "room-corridor"),
        moveAction(makeId, "北へ旋回", 7.5, 1, 780, 310, 90, "room-corridor", "rotate"),
        moveAction(makeId, "オフィスB確認", 9, 4, 780, 480, 90, "room-office-b"),
      ]);
      addRobot("待機清掃機", "#58d8ca", "cleaning", "robot-cln", { x: 140, y: 120, yaw: 0, roomId: "room-entrance" }, []);
      break;
    }
    case "daily-cleaning": {
      addRobot("清掃ロボット", "#58d8ca", "cleaning", "robot-cln", { x: 540, y: 310, yaw: -90, roomId: "room-corridor" }, [
        moveAction(makeId, "会議室1へ入室", 1, 4, 540, 140, -90, "room-meeting1"),
        moveAction(makeId, "北へ旋回", 5.5, 2, 540, 140, 90, "room-meeting1", "rotate"),
        moveAction(makeId, "廊下へ戻る", 8, 4, 540, 310, 90, "room-corridor"),
      ]);
      break;
    }
    case "daily-delivery": {
      addRobot("配送ロボット", "#ffbd70", "delivery", "robot-dlv", { x: 200, y: 140, yaw: 90, roomId: "room-entrance" }, [
        moveAction(makeId, "エントランスから廊下へ", 1, 4, 200, 310, 90, "room-corridor"),
        moveAction(makeId, "オフィスAへ移動", 5.5, 4, 200, 480, 90, "room-office-a"),
      ]);
      break;
    }
    case "tutorial-dirt": {
      addRobot("清掃ロボット", "#58d8ca", "cleaning", "robot-cln", { x: 260, y: 310, yaw: 0, roomId: "room-corridor" }, [
        moveAction(makeId, "汚れ箇所へ移動", 1, 5, 640, 310, 0, "room-corridor"),
      ]);
      presentation = {
        version: 1,
        scenarioId: "tutorial-dirt",
        cues: [
          { kind: "dirt", start: 0, end: 6, label: "清掃対象エリア", color: "#c9a26b", x: 560, y: 260, width: 160, height: 100 },
          { kind: "notice", start: 6, end: 10, label: "清掃が完了しました", color: "#58d8ca" },
        ],
      };
      break;
    }
    case "tutorial-crowd": {
      addRobot("案内ロボット", "#73bafa", "delivery", "robot-nav", { x: 260, y: 310, yaw: 0, roomId: "room-corridor" }, [
        moveAction(makeId, "迂回ルート移動", 2, 6, 780, 310, 0, "room-corridor"),
      ]);
      presentation = {
        version: 1,
        scenarioId: "tutorial-crowd",
        cues: [
          { kind: "zone", start: 0, end: 9, label: "混雑検知エリア", color: "#ff9a3d", x: 420, y: 420, width: 200, height: 120 },
          { kind: "route", start: 1, end: 8, label: "推奨迂回ルート", color: "#58d8ca", points: [[260, 310], [780, 310]] },
        ],
      };
      break;
    }
    default: {
      // Deterministic distinct route per scenario index so all 16 scenarios are distinct and collision-safe
      const idx = Math.max(0, SIXTEEN_SCENARIO_IDS.indexOf(scenarioId));
      const startX = 200 + (idx % 4) * 60;
      const endX = 620 + (idx % 5) * 60;
      addRobot(`${meta.title} ロボット`, "#8d9bff", idx % 2 === 0 ? "security" : "cleaning", `robot-${idx + 1}`, {
        x: startX, y: 310, yaw: 0, roomId: "room-corridor",
      }, [
        moveAction(makeId, `${meta.title} 移動`, 1, 5 + (idx % 3), endX, 310, 0, "room-corridor"),
      ]);
      presentation = {
        version: 1,
        scenarioId,
        cues: [
          { kind: "notice", start: 0, end: 6, label: meta.summary, color: "#73bafa" },
        ],
      };
      break;
    }
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
    ...(presentation ? { presentation } : {}),
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
