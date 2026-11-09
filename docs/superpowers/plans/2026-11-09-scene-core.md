# シーン中核（S0〜S1）実装計画

> **エージェント向け:** 必須の下位スキル: superpowers:subagent-driven-development（推奨）または superpowers:executing-plans。各ステップはチェックボックス（`- [ ]`）で進捗を管理する。

**Goal:** minirobo-editor の DOM に依存しない中核処理（マップ・通行・安全判定・扉・固定時間軸の計画）を、mm 座標と 20mm マスへ作り直して `web-controller/scene/` に TypeScript で移植する。

**Architecture:** 移植元 `public/*.js` の挙動を、座標を「1600×900 比率座標・32×18 マス・左上起点」から「mm・55×31 マス（20mm）・左下起点」へ変換しながら TS に移す。旧互換（v1〜v3、トリガー、合流、ordered モード、廊下待ちの収束計算）は移植しない。ブラウザーと Hub の双方から import できる純粋関数のみで構成する。

**Tech Stack:** TypeScript 5（`web-controller/tsconfig.json`）、`tsx --test`（Node 標準テストランナー、CJS）、追加依存なし。

**Spec:** [docs/superpowers/specs/2026-11-09-scene-editor-port-design.md](../specs/2026-11-09-scene-editor-port-design.md)

**移植元:** `C:\Users\1600028\Desktop\Developments\minirobo-editor-ref`（リポジトリ外、コミット `e937be4`）。以下「上流」と呼ぶ。

## Global Constraints

- 世界座標は mm。原点左下、X 右、Y 上。yaw は右 0°・反時計回り正・範囲 (-180, 180]。
- 描ける範囲: 幅 1100mm × 高さ 620mm。保存マス 20mm、55 列 × 31 行 = 1705 マス。
- マス番号 = `row * 55 + col`、`row 0` が**最下段**（上流の左上起点は採用しない）。マス中心 = `(col*20+10, row*20+10)`。
- 編集グリッドは `[20, 40, 60, 80, 100]` mm のいずれか。原点からそろえ、右端・上端の半端を許す。
- 安全半径: 全台 60mm 固定（`SAFETY_RADIUS_MM = 60`）。外形はこの層では扱わない。
- 走行面の実寸: 1106.93 × 622.65mm（`data/field.json` 既定値と同じ）。比率座標との変換はこの値で行う。
- 上流の比率座標の長さ定数のうち本書で値を指定していないものは、`× 1106.93 / 1600`（= 0.691831）で mm へ換算し 1mm 単位に丸める。換算した定数には元の値を 1 行コメントで残す。
- 保存形式の識別子: `fleet-scene/v1`。上限: マップ 8、アクション合計 2000、時刻 0〜86400 秒、演出 cue 160。
- `scene/` 配下は `window`・`document`・Node の組み込みモジュールを使わない。ID 生成は引数 `makeId` で差し替えられるようにし、既定値だけ `globalThis.crypto.randomUUID()` を使う。
- web-controller は CJS（tsx）。テストでトップレベル await・`import.meta` を使わない。
- 既存テスト（`test:fleet`・`test:localization`・`test:appearance`）を壊さない。

## Review Focus

1. 最上段・最右列（row 30 / col 54、y=600〜620 / x=1080〜1100）のマス判定とマス番号の上下反転ミス。
2. 粗い編集グリッドの半端（40mm で x=1080〜1100、y=600〜620）でまとめ塗りが範囲外へはみ出す、または取りこぼすこと。
3. 安全円の直径 120mm より狭い開口・通路を、通れると判定すること。
4. yaw の ±180° 境界（179°→-179° の最短回転、-180 の正規化）。
5. 長さ 0 のバー（消去・イベント終了だけ許す）、同じ行での同時刻の複数バー、開始時刻が負のバー。

---

## ファイル構成

```text
web-controller/scene/
  units.ts          比率座標⇔mm、角度正規化、定数（範囲・マス・安全半径）
  grid.ts           マス番号⇔座標、編集グリッドのまとめ塗り、スナップ
  types.ts          fleet-scene/v1 の型定義
  model.ts          プロジェクト生成・検証・保存用整形・ID生成
  floorPlan.ts      部屋・家具・壁・床の検証と幾何
  equipment.ts      扉・EV・ゲート・充電スペースの配置と統合
  navigation.ts     通行データの生成
  safety.ts         安全円による壁・家具・軌跡の判定
  doors.ts          扉の解錠期間・開度（描画用）
  timedPlan.ts      固定時間軸の計画とサンプリング、旋回の自動挿入
  timelineEdit.ts   バーの一括調整・並べ替え
  presentation.ts   演出 cue の検証と時刻抽出
web-controller/scripts/scene/
  *.test.ts         上の各ファイルの単体テスト
  upstream-parity.md 上流テストとの対応表（Task 11 で作成）
```

---

### Task 0: 上流の取得とベースライン（S0）— 実施済み

- [x] 上流を `..\minirobo-editor-ref` へ clone（`e937be4`）。
- [x] `node --test`（`HISTORY_MODE=off`）: tests 240 / pass 240 / fail 0（2026-11-09、Node v24.17.0）。

### Task 1: テストの土台、単位と定数

**Files:**
- Create: `web-controller/scene/units.ts`
- Create: `web-controller/scripts/scene/units.test.ts`
- Modify: `web-controller/package.json`（scripts に追加）

**Interfaces:**
- Produces:
  - `AREA_WIDTH_MM = 1100`, `AREA_HEIGHT_MM = 620`, `CELL_MM = 20`, `COLUMNS = 55`, `ROWS = 31`, `CELL_COUNT = 1705`
  - `FIELD_WIDTH_MM = 1106.93`, `FIELD_HEIGHT_MM = 622.65`, `RATIO_WIDTH = 1600`, `RATIO_HEIGHT = 900`
  - `SAFETY_RADIUS_MM = 60`, `HUMAN_RADIUS_MM = 14`, `EDIT_GRID_OPTIONS = [20, 40, 60, 80, 100] as const`
  - `ratioToMm(x: number, y: number): { x: number; y: number }` / `mmToRatio(x, y)`
  - `normalizeYaw(deg: number): number`（結果は (-180, 180]）
  - `shortestTurn(fromDeg: number, toDeg: number): number`（ちょうど 180° 差は時計回り＝負）

- [ ] **Step 1:** `package.json` に `"test:scene": "tsx --test scripts/scene/*.test.ts"` を追加。PowerShell からグロブが展開されずに渡ることを `npm --prefix web-controller run test:scene` で確認（0 件で成功終了すれば可。展開されない場合はファイル列挙に変える）。
- [ ] **Step 2: 失敗するテストを書く** — `units.test.ts`
  - `ratioToMm(1600, 900)` が `{x: 1106.93, y: 622.65}`（誤差 1e-9）
  - `mmToRatio(ratioToMm(123.4, 567.8))` の往復誤差 < 1e-9
  - `normalizeYaw(180) === 180`、`normalizeYaw(-180) === 180`、`normalizeYaw(540) === 180`、`normalizeYaw(-190) === 170`
  - `shortestTurn(179, -179) === 2`、`shortestTurn(0, 180) === -180`、`shortestTurn(10, -170) === -180`
  - `COLUMNS * CELL_MM === AREA_WIDTH_MM` かつ `ROWS * CELL_MM === AREA_HEIGHT_MM`
- [ ] **Step 3:** 実行して失敗を確認: `cd web-controller; npx tsx --test --test-reporter=tap scripts/scene/units.test.ts` → モジュール未定義で FAIL。
- [ ] **Step 4:** `units.ts` を実装（上流 `safety.js` の角度処理と `floor-plan.js:8-13` を参照）。
- [ ] **Step 5:** 同コマンドで PASS を確認。`npx tsc --noEmit --incremental false -p tsconfig.json` もエラーなし。
- [ ] **Step 6:** コミット `feat(scene): add mm units and field constants`

### Task 2: マスと編集グリッド

**Files:**
- Create: `web-controller/scene/grid.ts`, `web-controller/scripts/scene/grid.test.ts`

**Interfaces:**
- Consumes: Task 1 の定数
- Produces:
  - `cellIndex(col: number, row: number): number`（範囲外は -1）
  - `cellColRow(cell: number): { col: number; row: number }`
  - `cellCenter(cell: number): { x: number; y: number }`
  - `cellAt(x: number, y: number): number`（範囲外は -1。上端 y=620・右端 x=1100 は最終マスに含める）
  - `cellNeighbor(cell: number, edge: Edge): number`（`Edge = "top" | "bottom" | "left" | "right"`、top は row+1）
  - `editBlockCells(x: number, y: number, gridMm: EditGridMm): number[]`（点 (x, y) を含む編集ブロックに入る、範囲内の 20mm マスのみ。`EditGridMm = typeof EDIT_GRID_OPTIONS[number]`）
  - `snapToEditGrid(x: number, y: number, gridMm: EditGridMm): { x: number; y: number }`（ブロック中心。半端ブロックは半端部分の中心）
  - `rectangleCells(a: number, b: number): number[]`（2 マスを対角とする矩形）

- [ ] **Step 1: 失敗するテストを書く** — `grid.test.ts`
  - `cellIndex(0,0) === 0`、`cellIndex(54,30) === 1704`、`cellIndex(55,0) === -1`
  - `cellCenter(0)` が `{x:10,y:10}`、`cellCenter(1704)` が `{x:1090,y:610}`
  - `cellAt(1100, 620) === 1704`、`cellAt(1100.01, 10) === -1`、`cellAt(0, 0) === 0`
  - `cellNeighbor(0, "top") === 55`、`cellNeighbor(1704, "top") === -1`、`cellNeighbor(0, "left") === -1`
  - `editBlockCells(1090, 10, 40)`（右端 x=1080〜1100）は 20mm マス 2 個（1 列 × 2 行）のみ返す
  - `editBlockCells(10, 10, 80)` は 16 マス、`editBlockCells(1090, 610, 80)` は 3 列 × 3 行 = 9 マス（x=1040〜1100、y=560〜620）
  - `snapToEditGrid(1095, 615, 40)` が `{x:1090, y:610}`（半端部分の中心）
  - `snapToEditGrid(5, 5, 20)` が `{x:10, y:10}`
- [ ] **Step 2:** 実行して FAIL を確認（コマンドは Task 1 と同形式）。
- [ ] **Step 3:** `grid.ts` を実装。上流 `floor-plan.js:151-230`（`regionBounds`・`cellNeighbor`・`rectangleCells`）を参照するが、行は下から数える。
- [ ] **Step 4:** PASS と型チェックを確認。
- [ ] **Step 5:** コミット `feat(scene): add 20mm cell grid with selectable edit grid`

### Task 3: 保存形式の型とプロジェクトの生成・検証

**Files:**
- Create: `web-controller/scene/types.ts`, `web-controller/scene/model.ts`, `web-controller/scripts/scene/model.test.ts`

**Interfaces:**
- Produces（`types.ts`）: 上流の `Project / Map / Room / Track / Action / FloorPlan / Presentation` を次の差分で型にする。
  - `SceneProject { schema: "fleet-scene/v1"; name: string; maps: SceneMap[]; facingTurns?: boolean }`
  - `SceneMap` から `executionMode`・`timelineOnly`・`background` を除く。`editGridMm: EditGridMm` を追加（既定 20）。`doorMode: "story" | "strict"`（既定 story）。
  - `Room.cells: number[]` を必須にする（矩形 x/y/width/height 形式は保存しない）。
  - `Track.robotId?: string`（`fleet.json` のロボット ID。上流の整数 ID ではない）。
  - `Action.type` は `"move" | "wait" | "show" | "hide" | "event-start" | "event-end" | "unlock"`。`trigger`・`join`・`timeoutSeconds`・`simulationOutcome`・`plannedDuration`・`speed`・`angularSpeed` を除く。`motion?: "rotate"`、`runSeconds` 必須。
  - 座標を持つフィールドはすべて mm。
- Produces（`model.ts`）:
  - `type IdFactory = () => string`
  - `createProject(name: string, makeId?: IdFactory): SceneProject`（空の 1 マップ）
  - `newTrack(map, kind, makeId?)`、`newAction(map, track, type, makeId?)`
  - `validateProject(value: unknown): SceneProject`（不正なら `Error` を投げる。上限: マップ 8・アクション 2000・時刻 0〜86400・yaw 範囲・座標が描ける範囲内・マス番号 0〜1704・`editGridMm` が選択肢内）
  - `projectForSave(project): SceneProject`（複製し、各マップの `navigation` を Task 6 の `buildNavigation` で付ける）

- [ ] **Step 1: 失敗するテストを書く** — `model.test.ts`
  - `createProject("p", seqIds)` が `validateProject` を通り、`schema === "fleet-scene/v1"`、`maps[0].editGridMm === 20`
  - マップ 9 個・アクション 2001 個・`runSeconds = 86401`・`editGridMm = 30`・マス番号 1705・`schema: "robot-scene/v5"` をそれぞれ拒否
  - `Action.type === "join"` と `trigger` を持つアクションを拒否
  - `validateProject(JSON.parse(JSON.stringify(projectForSave(p))))` が成功（保存往復）
- [ ] **Step 2:** FAIL を確認。
- [ ] **Step 3:** 実装。上流 `model.js` の `createProject`・`newTrack`・`newAction`・`validateProject`・`projectForSave` を参照し、旧互換の分岐（v2/v3・ordered・trigger・join）は持ち込まない。Task 6 未実装の間は `projectForSave` のテストを `test.todo` にしておき、Task 6 で有効にする。
- [ ] **Step 4:** PASS と型チェック。
- [ ] **Step 5:** コミット `feat(scene): add fleet-scene/v1 types and project validation`

### Task 4: 部屋・家具・壁の幾何と検証

**Files:**
- Create: `web-controller/scene/floorPlan.ts`, `web-controller/scripts/scene/floorPlan.test.ts`

**Interfaces:**
- Consumes: Task 2 の `cellNeighbor`・`cellCenter`・`cellAt`
- Produces: `regionBounds(cells): {x,y,width,height}`（mm、左下基準）、`furnitureCells(item)`、`rotateFurniture(item, turns)`、`roomContainsPoint(room, x, y)`、`roomAnchor(room)`、`boundaryEdge(room, cell, edge)`、`removeRegion(map, roomId)`、`validateFloorPlan(map): SceneMap`
- 壁 `floorPlan.walls[]` の線分は **mm・Y 上**で保存する（上流の Y 下保存は採用しない）。

- [ ] **Step 1: 失敗するテストを書く**（上流 `test/floor-plan.test.js` の家具・部屋・回転・重なり拒否のケースを mm に換算して移す）。追加で:
  - L 字の部屋で、外接矩形内の空白マス中心 → `roomContainsPoint === false`
  - 最上段の部屋（row 30）の `regionBounds` が `y=600, height=20`
  - 家具を 90° 回転して部屋の外へはみ出す場合に拒否
- [ ] **Step 2:** FAIL を確認。
- [ ] **Step 3:** 上流 `floor-plan.js:151-480` を参照して実装（DOM 描画 `renderFloorPlan` は対象外）。
- [ ] **Step 4:** PASS と型チェック。
- [ ] **Step 5:** コミット `feat(scene): port floor plan geometry to mm grid`

### Task 5: 扉・EV・ゲート・充電スペース

**Files:**
- Create: `web-controller/scene/equipment.ts`, `web-controller/scripts/scene/equipment.test.ts`

**Interfaces:**
- Produces: `DOOR_CELLS = 10`（200mm）、`DOOR_FRAME_MM = 4`、`placeDoor(map, candidate, makeId?)`、`placeElevator(map, roomId, cells, entrance, makeId?)`、`placeGate(map, cells, entrance, makeId?)`、`nearestDoorWall(map, x, y, opts?)`（`maxDistance` 既定 24mm）、`mergedDoors(map)`
- 値の根拠（実装者の判断として記録）: 上流の 6 マス（≒207.5mm）に最も近い 20mm の倍数が 200mm。枠を除く有効開口 192mm は安全円の直径 120mm を通す。

- [ ] **Step 1: 失敗するテストを書く**（上流 `test/equipment-sizing.test.js`・`test/door-controls.test.js` の配置ケースを換算して移す）。追加で:
  - 有効開口 `200 - 2*4 = 192` が `mergedDoors` の開口線分長と一致
  - 壁の長さが 10 マスに満たない位置への扉配置を拒否（理由文字列を返す）
  - 隣接する扉の統合で `memberIds` に元 ID が残る
- [ ] **Step 2:** FAIL を確認。
- [ ] **Step 3:** 上流 `floor-plan.js:27-150`・`233-267`・`484-514` を参照して実装。
- [ ] **Step 4:** PASS と型チェック。
- [ ] **Step 5:** コミット `feat(scene): port doors, elevators and gates with 200mm openings`

### Task 6: 通行データ

**Files:**
- Create: `web-controller/scene/navigation.ts`, `web-controller/scripts/scene/navigation.test.ts`
- Modify: `web-controller/scripts/scene/model.test.ts`（Task 3 の `test.todo` を有効化）

**Interfaces:**
- Produces: `buildNavigation(map): SceneNavigation`。`schema: "fleet-floor-navigation/v1"`、`units: "mm"`、`width: 1100`、`height: 620`、`grid: { columns: 55, rows: 31, cellMm: 20, indexOrigin: "bottom-left" }`、`cells`（1705 件、`roomId`・`traversable`・`reason: "floor" | "furniture" | "unassigned"`）、`walls`、`doors`（`state: "unspecified"`）、`obstacles`。

- [ ] **Step 1: 失敗するテストを書く**（上流 `floor-plan.test.js` の navigation 出力ケースを換算）。追加で `cells.length === 1705`、未割当マスは `traversable: false, reason: "unassigned"`。
- [ ] **Step 2〜4:** FAIL 確認 → 上流 `floor-plan.js:590-635` を参照して実装 → PASS・型チェック。
- [ ] **Step 5:** コミット `feat(scene): build mm navigation data`

### Task 7: 安全判定

**Files:**
- Create: `web-controller/scene/safety.ts`, `web-controller/scripts/scene/safety.test.ts`

**Interfaces:**
- Consumes: Task 6 の `buildNavigation`、Task 1 の `SAFETY_RADIUS_MM`・`HUMAN_RADIUS_MM`
- Produces:
  - `createSafety(map): Safety`（`robotRadius` は常に 60）
  - `pathProblem(safety, from: Point, to: Point, kind: "robot" | "human"): string`（問題なしは `""`）
  - `pathSections(safety, from, to)`、`positionAt(segments, at)`、`collisionWarnings(trajectories)`
  - `coordinatePoint(x, y, mode: "grid" | "free", gridMm, origin?, axisLock?)`
- 1 台ずつ通す区間（上流の「廊下」ゾーン）の判定は、通路幅が 240mm（安全円 2 個分）未満、つまり 11 マス以下とする（実装者の判断）。

- [ ] **Step 1: 失敗するテストを書く**（上流 `timed.test.js` の壁・家具・領域外・マスの拒否ケースを換算）。追加で:
  - 壁との距離がちょうど 60mm は許可（接するだけは通れる）、59mm は拒否
  - 幅 6 マス（120mm）の通路の中心線上は通れる、幅 5 マス（100mm）は拒否
  - 2 台が中心間 119mm まで近づく軌跡は `collisionWarnings` を 1 件返し、121mm なら 0 件
- [ ] **Step 2〜4:** FAIL 確認 → 上流 `safety.js` 全体を参照して実装 → PASS・型チェック。
- [ ] **Step 5:** コミット `feat(scene): port safety checks with fixed 60mm radius`

### Task 8: 扉の解錠と開度（描画用）

**Files:**
- Create: `web-controller/scene/doors.ts`, `web-controller/scripts/scene/doors.test.ts`

**Interfaces:**
- Consumes: Task 5 の `mergedDoors`、Task 7 の `positionAt`
- Produces: `DOOR_TRANSITION_SECONDS = 0.6`、`automaticDoorOpenness(opening, actors): number`（0〜1）、`prepareDoorPlan(plan)`、`sampleDoorPlan(plan, time)`。距離のしきい値は Global Constraints の換算規則で mm にする。

- [ ] **Step 1: 失敗するテストを書く**（上流 `test/automatic-doors.test.js` と `door-controls.test.js` の開閉・保持ケースを換算）。
- [ ] **Step 2〜4:** FAIL 確認 → 上流 `automatic-doors.js`・`floor-plan.js:515-532` を参照して実装（`updateAutomaticDoors` の DOM 部分は対象外）→ PASS・型チェック。
- [ ] **Step 5:** コミット `feat(scene): port automatic door timing`

### Task 9: 固定時間軸の計画とサンプリング

**Files:**
- Create: `web-controller/scene/timedPlan.ts`, `web-controller/scripts/scene/timedPlan.test.ts`

**Interfaces:**
- Consumes: Task 3〜8
- Produces:
  - `compilePlan(map): ScenePlan`（`entries`・`errors`・`warnings`・`duration`。上流の `fixedTimeline: true` の挙動のみ。廊下待ちの反復収束は移植しない）
  - `samplePlan(plan, time): SceneState`（`actors`・`displays`・`events`・`actionStates`・`roomActivities`・`doors`・`duration`・`errors`・`warnings`）
  - `actionPreview(map, trackId, action): { from, geometryProblem, start, end, warning }`
  - `addFacingTurns(map): number`（旋回 90°/秒、0.1 秒単位で切り上げ）
  - `ScenePlan.entries[].segments` の座標は mm（Task 10 以降の実行系はこれを予定軌跡として使う）

- [ ] **Step 1: 失敗するテストを書く**（上流 `test/timed.test.js` 36 件のうち旧互換以外、`test/scene-features.test.js`、`test/model.test.js` の `compilePlan`/`samplePlan` 関連を換算して移す）。追加で:
  - 移動・旋回・待機の長さ 0 のバーは拒否（`hide`・`event-end` の 0 秒は許可）、同じ行での時間の重なりはエラー、開始時刻が負は拒否
  - 179°→-179° の旋回が 2° 分の時間で完了
  - 同じ map 参照で `compilePlan` を 2 回呼ぶと同じ結果（決定性）、`samplePlan(plan, t)` を時刻の昇順・降順で呼んでも同じ状態
  - 演出 cue の時刻抽出が `[start, end)` で動く
- [ ] **Step 2〜4:** FAIL 確認 → 上流 `timed-plan.js` と `model.js` の `compilePlan`/`samplePlan`/`actionPreview`/`addFacingTurns` を参照して実装 → PASS・型チェック。
- [ ] **Step 5:** 性能の回帰テスト: アクション 2000 件の計画が 2 秒未満、`samplePlan` の平均 16ms 未満（上流と同じ予算）。
- [ ] **Step 6:** コミット `feat(scene): port fixed-timeline planning`

### Task 10: タイムライン編集と演出

**Files:**
- Create: `web-controller/scene/timelineEdit.ts`, `web-controller/scene/presentation.ts`、各テスト

**Interfaces:**
- Produces: `checkSequence(track)`、`adjustTimeline(map, actionIds, offset, durationOffset?)`、`reorderSequence(track, actionId, direction)`、`validatePresentation(value)`、`presentationAt(presentation, time)`
- 演出 cue の座標・寸法は mm、範囲は描ける範囲内。

- [ ] **Step 1〜5:** 上流 `timeline-edit.js`・`scenario-presentation.js`（`renderPresentation` は対象外）と関連テストを移し、Task 9 と同じ手順で FAIL→実装→PASS→コミット `feat(scene): port timeline editing and presentation cues`。

### Task 11: 上流テストとの対応表と回帰確認

**Files:**
- Create: `web-controller/scripts/scene/upstream-parity.md`

- [ ] **Step 1:** 上流の 240 件を 1 件ずつ「移植済み（移植先のテスト名）」「対象外（理由: 旧互換 / DOM / 履歴サーバー / 起動スクリプト / 外部 API / S2 以降）」に分類した表を作る。
- [ ] **Step 2:** 未分類が 0 件であることを確認する。
- [ ] **Step 3:** 全回帰を実行: `npm --prefix web-controller run test:scene`、`test:fleet`、`test:localization`、`test:appearance`、`npx tsc --noEmit --incremental false -p web-controller/tsconfig.json`。すべて失敗 0。
- [ ] **Step 4:** コミット `test(scene): record upstream test parity`

---

## 後続の計画（本計画の対象外）

- S2 エディター画面、S3 旧データ変換と 16 シナリオ、S4 展示表示、S5 実行系のシミュレーション、S6 8 台対応は、本計画の完了後に個別の計画として作成する。
