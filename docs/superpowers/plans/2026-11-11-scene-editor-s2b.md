# シーンエディター S2b（マップ作成）実装計画

> **エージェント向け:** 必須の下位スキル: superpowers:subagent-driven-development（推奨）または superpowers:executing-plans。各ステップはチェックボックス（`- [ ]`）で進捗を管理する。

**Goal:** マップ編集の全ダイアログ（ゾーニング／部屋編集の 2 モード・10 ツール・領域の追加と削除・元に戻す／やり直し 100 段階・適用／キャンセル）を、mm 座標・20mm マスで `/scenes` に移植する。

**Architecture:** 編集操作は DOM に依存しない純粋関数（`scene/mapEdit*.ts`）として、`SceneMap` を受け取り新しい `SceneMap` を返す形で作る。ダイアログは作業コピー（draft）に対してのみ操作し、「適用」で 1 回の `commit` にまとめる（適用まで元のマップと履歴は変わらない）。ポインターのセル変換とドラッグ範囲は `scene/mapEditPointer.ts` の純粋関数にする。

**Tech Stack:** Next.js 14、React 18、TypeScript、CSS Modules（`.fleet` スコープ）、lucide-react、`tsx --test`、`@playwright/test`（導入済み）。

**Spec:** [設計書](../specs/2026-11-09-scene-editor-port-design.md)（D8〜D10・D17）。前段: [S2a](2026-11-11-scene-editor-s2a.md)。

**上流:** `C:\Users\1600028\Desktop\Developments\minirobo-editor-ref`（`e937be4`）。主な参照: `public/map-editor.js`（全体 約 790 行）、`public/map-editor.css`、`browser-tests/studio.spec.js`（map 関連）。

## 所有者の決定（2026-11-11）

- 画面は**全画面ダイアログ**（上流と同じ作業コピー方式）。ページに直接組み込まない。
- 編集グリッド（20/40/60/80/100mm）の切替は**マップエディターの中だけ**。保存は `SceneMap.editGridMm`。
- ドア・ゲート・EV の入口幅は 10 マス固定をやめ、**最小 140mm・最大 240mm・20mm 刻み（7〜12 マス）の可変**にする。幅は壁の切り欠きの長さで、枠（4mm×2）を引いた有効な開口は 132〜232mm になる。最小の有効な開口 132mm は安全円の直径 120mm より広く、**ロボットが通れる**（120mm の切り欠きは有効 112mm となり通れない）。
- 枠（`DOOR_FRAME_MM = 4`）は**残す**。
- 実装順は一任。

## 私の判断（計画書の確認時に覆せる）

- **入口幅の根拠**: 実測（現行コード、枠 4mm）で、切り欠き 120mm（6 マス）は有効 112mm となり安全判定が「狭すぎるドアに接触します」と拒否し、140mm（7 マス）は有効 132mm で通行可だった。所有者が最小を 140mm に決めた。
- **間仕切り壁**: 上流は「2 セル以上」だったため踏襲する（20mm マスなら 40mm 以上）。安全円の直径 120mm より短い壁は、通行の障害として意味が小さいので、**置けるが警告を出す**（上流は無警告）。
- **ゾーニングの色**: 上流の 5 色パレット（`#8d9bff #58d8ca #ffbd70 #73bafa #bd9afa`）を踏襲する。
- **壁の位置**: マスの中心線（上流と同じ）。
- **領域の上限**: 100（上流と同じ）。トラック上限 128（領域を足すと部屋トラックが増える）も上流と同じ検査を残す。

## Global Constraints

- 座標は mm・左下原点・Y 上。マス番号は `row * 55 + col`、row 0 が最下段。描ける範囲は 1100×620mm（55×31 マス）。
- 編集グリッドは `[20, 40, 60, 80, 100]`。粗いグリッドで塗る・消す・ドラッグするときは `editBlockCells` でまとめ、範囲外は無視する。
- 入口幅は 7〜12 マス（`DOOR_MIN_CELLS = 7`、`DOOR_MAX_CELLS = 12`）。**既存データの設備は読み込み時にも保存時にも変更しない**（200mm・192mm の既存ドアはそのまま有効）。
- 安全半径 60mm 固定（`SAFETY_RADIUS_MM`）。最小入口幅の有効な開口 `DOOR_MIN_CELLS × CELL_MM − 2 × DOOR_FRAME_MM`（= 132mm）が `2 × SAFETY_RADIUS_MM`（= 120mm）以上であることを、**テストで不変条件として検査する**（定数を変えたときに通れない最小幅になるのを防ぐ）。
- 編集操作の関数は入力を変更せず、失敗時は理由を `Error` で投げる（呼び出し側が画面に表示する）。成功時だけ新しい `SceneMap` を返す。
- ダイアログは `<dialog>` + `showModal()`。`window.alert/confirm/prompt` を使わない。取消（Esc・キャンセル）は draft を捨てる。未適用の変更があるときの取消は確認ダイアログを出す。
- 見た目はフリート画面（ガラス調・ライト／ダーク）。マップの描画色は `scene/mapColors.ts`（テーマ非依存）。文字 24/20/16/14/12px、操作部品 44px 以上、`focus-visible` を維持。
- 対象画面は幅 768px 以上。マウスとタッチ（Pointer Events）の両方で描画できること。
- web-controller は CJS（tsx）。テストにトップレベル await・`import.meta` を使わない。
- 日本語を含むファイルを PowerShell 5.1 の `Get-Content -Raw`→`Set-Content` で書き換えない（文字化けする）。編集ツールを使う。
- 既存テスト（`test:scene`・`test:fleet`・`test:localization`・`test:appearance`・`test:browser`）と `tsc --noEmit` を壊さない。

## Review Focus

1. 最上段・最右列（row 30 / col 54）と、粗いグリッドの半端（40mm で右端 x=1080〜1100、上端 y=600〜620）での塗り・消し・ドラッグが範囲外へはみ出す、または取りこぼすこと。
2. 最小幅（140mm・7 マス）の入口に置いたドア・ゲート・EV で、ロボットが実際に通行可と判定されること。120mm（6 マス）以下は選べないこと。
3. 最後の 1 セルを消せてしまい、参照されている領域が空になること（トラックの初期位置・動作が参照する領域は削除も不可）。
4. EV を廊下の上に塗ったとき、廊下の全セルを覆ってしまう、または他の部屋を侵食すること。
5. 取消（Esc・キャンセル・ドラッグ中の中断・ポインター喪失）で draft や元のマップが変わること、ドラッグが途中で残ること。
6. 適用後に元に戻す（S2a の `undo`）で、マップ編集 1 回分が 1 操作として戻ること。

---

## ファイル構成

```text
web-controller/
  scene/equipment.ts            入口幅を可変にする（変更）
  scene/mapEditPointer.ts       ポインター→マス、ドラッグ範囲、補間、粗いグリッド対応（純粋）
  scene/mapEditRegions.ts       領域の追加・削除・塗る・消す・EV 切り出し・属性変更（純粋）
  scene/mapEditFixtures.ts      ドア・ゲート・間仕切り壁・家具・回転・削除・充電（純粋）
  scene/mapEditSession.ts       作業コピー・100 段階の元に戻す／やり直し・選択状態（純粋、React 非依存）
  app/(console)/scenes/MapEditorDialog.tsx        全画面ダイアログの骨組み・適用／キャンセル・モード切替
  app/(console)/scenes/MapEditorCanvas.tsx        編集用 SVG（MapStage の描画を再利用し、グリッド・選択・プレビューを重ねる）
  app/(console)/scenes/MapEditorTools.tsx         ツールバー・領域選択・描画モード・入口方向・入口幅
  app/(console)/scenes/MapEditorSidebar.tsx       部屋の属性・設備名・家具の種類と向き・削除・回転
  app/(console)/scenes/mapEditor.module.css
  app/(console)/scenes/page.tsx                    「マップを編集」ボタンを追加（変更）
  scripts/scene/mapEdit*.test.ts
  browser-tests/scenes-mapeditor.spec.ts
```

---

### Task 1: 入口幅を可変にする

**Files:**
- Modify: `web-controller/scene/equipment.ts`、`web-controller/scene/floorPlan.ts`（定数の参照のみ。必要がなければ触らない）、`web-controller/scripts/scene/equipment.test.ts`（影響は定数 `DOOR_CELLS`・`DOOR_MM` を参照する箇所。**`DOOR_FRAME_MM`・`navigation.ts` は変更しない**）

**Interfaces:**
- Produces:
  - `DOOR_MIN_CELLS = 7`、`DOOR_MAX_CELLS = 12`、`DOOR_DEFAULT_CELLS = 10`（既存の見た目・テストと揃える）
  - `DOOR_FRAME_MM = 4`（変更なし）
  - `doorWidthOk(cells: number): boolean`（整数かつ 7〜12）
  - `placeDoor(map, candidate, makeId?, cells?: number): Door[]`（`cells` 省略時は 10）
  - `placeElevator(map, roomId, cells, entrance, makeId?)`（入口幅は与えた矩形の入口側の長さから決め、7〜12 マス以外は拒否）
  - `placeGate(map, cells, entrance?, makeId?)`（ゲートの入口側の長さが 7〜12 マス以外は拒否）
  - `equipmentRectangle(start, end, entrance?, elevator?, cells?: number): number[]`（EV の入口側の長さを `cells` に固定する。省略時は 10）
  - `nearestDoorWall(map, x, y, opts?)`（独立壁の候補の長さを `opts.cells`（省略時 10）にする）

- [ ] **Step 1: 失敗するテストを書く**（`equipment.test.ts` に追加・更新）
  - 幅 7・8・10・12 マスのドアで、`mergedDoors` の切り欠きが 140・160・200・240mm、有効な開口（`opening` の長さ）が 132・152・192・232mm。
  - **不変条件**: `DOOR_MIN_CELLS * CELL_MM - 2 * DOOR_FRAME_MM >= 2 * SAFETY_RADIUS_MM`。
  - 幅 7 マス（有効 132mm）のドアを通る直線（開口の中心線上）を `pathProblem(createSafety(map), …, "robot")` が `""` にする（`safety.test.ts` の補助関数と同じ構成でよい）。幅 6 マス（有効 112mm）は `placeDoor` が拒否する（実測で通行不可になる幅を作らせない）。
  - 幅 6 と 13 は `placeDoor` が例外（理由に「7〜12」を含む）。`doorWidthOk` が 6 → false、7 → true、12 → true、13 → false、7.5 → false。
  - ゲート・EV でも 7 と 12 は置ける、6 と 13 は拒否される。EV の入口側の長さが選んだ幅になる。
  - 既存の 10 マスのテストは変更しない（枠 4mm のまま、開口 192mm）。
  - **既存データ互換**: 保存済みの 10 マス（200mm・有効 192mm）のドアは、`validateFloorPlan` を通り、開口の長さも変わらない。範囲外の幅（たとえば 5 マスで保存済みのデータ）も、読み込み時には拒否しない（配置時のみ検査）。
- [ ] **Step 2:** `cd web-controller; npx tsx --test --test-reporter=tap scripts/scene/equipment.test.ts` で FAIL を確認。
- [ ] **Step 3:** 実装。`DOOR_MM` を `cells * CELL_MM` の関数にし、固定の `DOOR_CELLS` を引数に置き換える。入口幅の範囲（7〜12 マス）は**配置時だけ**検査し、`validateFloorPlan` には課さない（既存データを読み込めなくしない。検証の下限は既存の `MIN_DOOR_MM = 8` のまま）。
- [ ] **Step 4:** PASS、`test:scene` 全件、`tsc --noEmit`、`test:browser`（既存の S2a の 23 件が壊れていないこと）。
- [ ] **Step 5:** コミット `feat(scene): make door width selectable (140-240mm)`

### Task 2: ポインターとドラッグ範囲（並列 A）

**Files:**
- Create: `web-controller/scene/mapEditPointer.ts`、`web-controller/scripts/scene/mapEditPointer.test.ts`

**Interfaces:**
- Consumes: `grid.ts` の `cellAt`・`cellColRow`・`cellIndex`・`editBlockCells`・`snapToEditGrid`、`mapView.ts` の `clientToMm`・`isTap`・`clampToArea`
- Produces:
  - `type DrawMode = "brush" | "rectangle"`
  - `pointerCell(mm: {x:number;y:number}, gridMm: EditGridMm): number`（範囲外は -1）
  - `blockCells(cell: number, gridMm: EditGridMm): number[]`（そのマスを含む編集ブロックの、範囲内の 20mm マス）
  - `rectangleBlocks(startCell: number, endCell: number, gridMm: EditGridMm): number[]`（2 点を対角とする矩形。粗いグリッドではブロック単位、半端は範囲内に切り詰め）
  - `strokeBlocks(fromCell: number, toCell: number, gridMm: EditGridMm): number[]`（自由描画の補間。高速ドラッグでイベント間のマスを抜かさない。上流は DDA 補間）
  - `entranceRect(startCell: number, endCell: number, entrance: Edge, cells: number): number[] | null`（EV の入口幅固定の矩形。範囲外は `null`）

- [ ] **Step 1: 失敗するテストを書く**
  - 20mm: `pointerCell({x:0,y:0})===0`、`{x:1100,y:620}===1704`、`{x:1100.01,y:10}===-1`、`{x:10,y:-0.01}===-1`。
  - 40mm: 右端ブロック（x=1080〜1100）のセルをクリックすると 20mm マス 2 個のみ（1 列×2 行）、右上隅は 1 列×1 行のブロック（x=1080〜1100、y=600〜620 の 2 マス）。80mm: 右上隅ブロックは 3 列×3 行 = 9 マス（x=1040〜1100、y=560〜620）。
  - `rectangleBlocks`: 20mm で (0,0)-(2,2) が 9 マス、始点と終点を入れ替えても同じ、同一点は 1 マス、40mm の半端を含む矩形が範囲外のセルを返さない。
  - `strokeBlocks`: 斜めに 10 マス離れた 2 点の間に抜けがなく、すべて 8 近傍で連続する。逆向きでも同じ集合。同一点は 1 ブロック。
  - `entranceRect`: 下入口・幅 7・始点 (10,10) → 7 列×(始点〜終点の行数)。上入口で反対向きにドラッグしても同じ。範囲外にはみ出す幅は `null`。
- [ ] **Step 2〜4:** FAIL 確認 → 実装 → PASS・型チェック。
- [ ] **Step 5:** コミット `feat(scene): add map-edit pointer and drag-range helpers`

### Task 3: 領域の編集ロジック（並列 B）

**Files:**
- Create: `web-controller/scene/mapEditRegions.ts`、`web-controller/scripts/scene/mapEditRegions.test.ts`

**Interfaces:**
- Consumes: `floorPlan.ts` の `regionBounds`・`removeRegion`・`validateFloorPlan`・`furnitureCells`・`boundaryEdge`、`equipment.ts` の `placeElevator`
- Produces（すべて純粋。第 1 引数 `map` は変更しない）:
  - `MAX_ROOMS = 100`、`REGION_COLORS = ["#8d9bff","#58d8ca","#ffbd70","#73bafa","#bd9afa"] as const`
  - `addRegion(map, kind: "room" | "corridor" | "elevator", makeId?): { map: SceneMap; roomId: string }`（名前は「部屋 N」「廊下 N」「エレベーター N」、色はパレットの巡回、100 件で拒否）
  - `paintCells(map, roomId, cells: number[], kind: "room" | "corridor"): SceneMap`（別の領域と重なると「別の領域と重なっています。消しゴムで空けるか別のセルを選んでください。」。EV 専用領域のときだけ、重なる相手が廊下で、その廊下の全セルを覆わない場合に限り廊下から切り出す。塗り終えたら領域の種類をツールに合わせ、枠が外れた家具・外周でなくなったドアを削除する）
  - `eraseCells(map, cells: number[]): SceneMap`（領域の最後の 1 セルを消す操作は「『<名前>』の最後のセルは消せません。参照保護のため領域を維持します。」で拒否し、何も変えない）
  - `dropInvalidFixtures(map): { map: SceneMap; removed: number }`（領域外になった家具、外周でなくなったドア・壁に紐づくドアを削除。1 件でも消したら呼び出し側が「形状変更により領域外になった家具・外周でなくなったドアを作業コピーから削除しました。」を出す）
  - `setRoomProps(map, roomId, patch: Partial<Pick<Room,"name"|"kind"|"material"|"color">>): SceneMap`（名前 120 文字以内・色 `#rrggbb`）
  - `removeRegionChecked(map, roomId): SceneMap`（`removeRegion` を包み、参照されている領域・最後の領域は拒否。既存の拒否理由を日本語に直す）
  - `commitElevator(map, roomId, cells: number[], entrance: Edge, doorCells: number, makeId?): SceneMap`（`placeElevator` を包む。入口幅 `doorCells` が 7〜12 でなければ拒否）

- [ ] **Step 1: 失敗するテストを書く**
  - `addRegion`: 101 件目は拒否、色が 5 色で巡回、名前が連番、入力 map が変わらない。
  - `paintCells`: 空の領域に塗れる／別の領域との重なりは拒否／廊下ツールで種類が廊下になる／最上段・最右列のマスを塗れる／同じセルを 2 回塗っても重複しない／塗った結果の `regionBounds` が正しい。
  - EV: 既存の廊下の一部の上に EV を塗ると廊下から切り出される／廊下の全セルを覆う、または別の部屋に重なる場合は拒否。
  - `eraseCells`: 複数領域のセルをまとめて消せる／領域の最後の 1 セルは拒否され、**他の領域のセルも消えない**（原子的）／存在しないセルは無視。
  - 家具がある領域のセルを消すと、その家具が消え `removed` に数が入る。外周でなくなったドアも消える。
  - `removeRegionChecked`: トラックの `roomId`・`initial.roomId`・アクションの `roomId` から参照されている領域は拒否、最後の領域も拒否。
  - `setRoomProps`: 空文字の名前は拒否（トリム後）、121 文字は拒否、`red` は拒否、`#ABCDEF` は許可。
  - `commitElevator`: 幅 7 と 12 は通り、6 と 13 は拒否。
  - すべての関数で入力 map を `structuredClone` と比較し、不変であること。
- [ ] **Step 2〜4:** FAIL 確認 → 上流 `map-editor.js` の `createRegion`・`deleteRegion`・`commitStroke`・`removeInvalidFixtures` を参照して実装 → PASS・型チェック。
- [ ] **Step 5:** コミット `feat(scene): add region editing operations`

### Task 4: 設備・配置物の編集ロジック（並列 C）

**Files:**
- Create: `web-controller/scene/mapEditFixtures.ts`、`web-controller/scripts/scene/mapEditFixtures.test.ts`

**Interfaces:**
- Consumes: `equipment.ts`（Task 1 後の `placeDoor`・`placeGate`・`nearestDoorWall`・`mergedDoors`・`doorWidthOk`）、`floorPlan.ts`（`validateFloorPlan`・`rotateFurniture`・`furnitureCells`・`regionBounds`）、`grid.ts`（`cellCenter`・`cellColRow`）
- Produces（純粋。入力 map を変更しない。失敗は `Error`）:
  - `addDoorAt(map, x: number, y: number, opts: { roomId?: string; edge?: Edge | "auto"; cells: number; maxDistance: number }, makeId?): { map: SceneMap; doorId: string; roomId: string }`
  - `previewDoorAt(map, x, y, opts): Segment[] | null`（置けるときの線分。置けない場合は `null`。例外は投げない）
  - `addGate(map, cells: number[], entrance: Edge, doorCells: number, makeId?): { map: SceneMap; doorId: string; roomId: string }`
  - `addPartitionWall(map, startCell: number, endCell: number, makeId?): { map: SceneMap; wallId: string; roomId: string; warning: string | null }`（`startCell === endCell` は「間仕切り壁は2セル以上の距離でドラッグしてください。」。水平か垂直に丸める。長さが 120mm 未満なら `warning` に「安全円（直径120mm）より短い壁です。」。壁はマスの中心線）
  - `addFurniture(map, cells: number[], type: FurnitureType, rotation: 0|90|180|270, makeId?): { map: SceneMap; itemId: string; roomId: string }`（領域内でなければ「家具は領域内に配置してください。」）
  - `rotateFurnitureBy(map, itemId, turns: 1): SceneMap`（回転後にはみ出す・重なる場合は拒否して理由を返す）
  - `setFurnitureRotation(map, itemId, rotation): SceneMap`
  - `addChargingZone(map, cells: number[], makeId?): { map: SceneMap; zoneId: string }`（名前は `CHARGING N`、範囲は `regionBounds`）
  - `deleteFixture(map, itemId): SceneMap`（ドアは統合された組（`mergedDoors().memberIds`）をまとめて、`equipmentId` を共有する壁も一緒に、壁を消すとその壁のドアも、充電スペースも消す。該当が無ければ「削除する家具・ドアを「選択」でクリックしてください。」）
  - `renameFixture(map, itemId, name: string): SceneMap`（`openingId`・`equipmentId` を共有する全部材の名前を揃える）
  - `setDoorKind(map, itemId, kind: "automatic" | "flapper"): SceneMap`（`openingId` を共有する全部材）

- [ ] **Step 1: 失敗するテストを書く**
  - ドア: 幅 7・12 で置ける／幅 6・13 は拒否／10 マス連続の外周が無い場所は拒否／ゲート・EV の入口幅が選んだ値になる。独立壁の上にも置ける。`previewDoorAt` は置けない位置で例外を投げず `null`。
  - **通行**: 幅 7 のドアを置いたマップで、ロボットが開口の中心線を通る経路が `pathProblem === ""`（Review Focus 2）。
  - 壁: 同じマス（`start===end`）は拒否／斜めにドラッグすると水平か垂直に丸められる／壁が領域外にはみ出す場合は拒否／長さ 100mm の壁は `warning` あり、120mm 以上は `warning === null`／座標がマスの中心線（`col*20+10`）。
  - 家具: 1×1・2×3 の長机・領域外・他の家具との重なりを拒否／回転で幅と高さが入れ替わる／回転して領域からはみ出す場合は拒否し元の状態を保つ。
  - 充電: 範囲が領域外にはみ出さない、名前が連番。
  - 削除: ゲートを消すと 3 本の壁とドアが全部消える／壁を消すとその壁のドアが消える／ドアの統合された組が 1 操作で全部消える／選択 ID が無いと拒否。
  - 名前・種別: `openingId` を共有する全部材に反映される。
  - 入力 map の不変性。
- [ ] **Step 2〜4:** FAIL → 上流 `placeDoor`・`placeGate`・`placeWall`・`placeFurniture`・`placeCharging`・`setRotation`・`deleteItem` を参照して実装 → PASS・型チェック。
- [ ] **Step 5:** コミット `feat(scene): add fixture editing operations`

### Task 5: 編集セッション（元に戻す 100 段階・選択状態）

**Files:**
- Create: `web-controller/scene/mapEditSession.ts`、`web-controller/scripts/scene/mapEditSession.test.ts`

**Interfaces:**
- Consumes: Task 2〜4 の関数、`editorHistory.ts`
- Produces:
  - `MAP_UNDO_LIMIT = 100`
  - `type MapTool = "room" | "corridor" | "erase" | "elevator" | "select" | "door" | "gate" | "partition" | "furniture" | "charging"`
  - `type EditorMode = "zoning" | "room"`
  - `createMapEditSession(source: SceneMap, makeId?): MapEditSession`
  - `MapEditSession`:
    - 状態の読み出し: `draft(): SceneMap`、`mode()`、`tool()`、`drawMode()`、`entrance()`、`doorCells()`、`selectedRoomId()`、`selectedItemId()`、`error()`、`stroke()`（進行中のドラッグ。`{ tool, cells: readonly number[], invalid: boolean } | null`）、`isDirty()`、`canUndo()`、`canRedo()`、`subscribe(listener)`
    - 操作: `setMode`、`setTool`（EV は領域を作って待機状態にする）、`setDrawMode`、`setEntrance`、`setDoorCells`、`selectRoom`、`selectItem`、`setGrid(gridMm)`、`strokeBegin(cell)`、`strokeMove(cell)`、`strokeEnd(cell)`、`strokeCancel()`、`placeDoorAt(x, y, maxDistance)`、`hoverDoor(x, y, maxDistance)`、`addRegionOfTool()`、`deleteRegion()`、`setRoomProps(patch)`、`rotateSelected()`、`setSelectedRotation(r)`、`renameSelected(name)`、`setSelectedDoorKind(kind)`、`deleteSelected()`、`setName(name)`、`undo()`、`redo()`、`result(): { ok: true; map: SceneMap } | { ok: false; error: string }`（適用の検証: ドラッグ中は「ドラッグを終了してから適用してください。」、名前が空は「マップ名を入力してください。」、121 文字以上は拒否、領域が 0 個は「1つ以上の領域を描いてください。」、空の領域があれば「「<名前>」を1セル以上描いてください。」、追加した領域でトラックが 128 本を超える場合の拒否、最後に `validateFloorPlan`）
  - **履歴の意味**: ドラッグ 1 回 = 1 操作（`strokeEnd` で確定）。`strokeCancel`・ポインター喪失・`pointercancel` は何も記録しない。`undo`・`redo` はドラッグ中なら、まずドラッグだけを取り消す。変更が無い操作（同じ状態）は履歴に積まない。新しい操作で `redo` を捨てる。101 個目で最古を捨てる。
  - 失敗した操作は draft を変えず、`error()` に理由を入れる。成功したらエラーを消す。

- [ ] **Step 1: 失敗するテストを書く**
  - 100 操作で `canUndo`、101 操作目で最古が消える。undo→新しい操作で redo が消える。
  - ドラッグ: begin→move×N→end で 1 操作、途中の `strokeCancel` は draft も履歴も不変、ドラッグ中の `undo` はドラッグのみ取消。
  - 失敗した操作（重なり・最後の 1 セル・100 件上限）は draft・履歴とも不変で `error()` が出る。
  - `result()`: ドラッグ中・空の名前・121 文字・領域 0・空の領域・トラック 128 本超過を拒否、正常なら `ok` で draft の複製（以後の操作で変わらない）。
  - `isDirty()`: 何もしていないとき false、操作後 true、undo で最初に戻すと false。
  - 元の `source` が一切変更されない（`structuredClone` と比較）。
  - ツール切替で進行中のドラッグが捨てられる。EV ツールは領域を作り、入口幅と方向の矩形をドラッグで確定する。
- [ ] **Step 2〜4:** FAIL → 実装 → PASS・型チェック。
- [ ] **Step 5:** コミット `feat(scene): add map edit session with 100-step undo`

### Task 6: 編集ダイアログ（画面）

**Files:**
- Create: `app/(console)/scenes/MapEditorDialog.tsx`、`MapEditorCanvas.tsx`、`MapEditorTools.tsx`、`MapEditorSidebar.tsx`、`mapEditor.module.css`
- Modify: `app/(console)/scenes/page.tsx`（「マップを編集」ボタンを追加し、適用時に `commit((d) => { 置換 }, "マップの編集")` を呼ぶ）

**Interfaces:**
- Consumes: Task 5 の `MapEditSession`、S2a の `MapStage`、`Commit`
- Produces: `<MapEditorDialog map={SceneMap} open={boolean} onApply={(next: SceneMap) => string | null} onClose={() => void} />`
- 振る舞い:
  - 全画面の `<dialog>`。上段: マップ名・キャンセル・「マップに適用」。2 段目: モード切替（ゾーニング／部屋編集）・元に戻す・やり直し。
  - ゾーニングで使えるツール: 部屋・廊下・消しゴム・エレベーター。領域の選択、「＋新しい領域」、「領域を削除」、描画モード（自由に塗る／長方形ドラッグ）、部屋名表示の切替。
  - 部屋編集で使えるツール: 選択・自動ドア・フラッパーゲート・間仕切り壁・家具・充電スペース。右の設定パネル（領域名・種類・床材・アクセント色・部屋名表示、設備名・ドア種別・家具の種類と向き・90°回転・選択物を削除）。
  - 新規 EV・ゲート・ドアの**入口方向**と**入口幅（120〜240mm、20mm 刻み）**の選択を設ける。
  - **編集グリッド**（20/40/60/80/100mm）の選択を設け、変更は `session.setGrid` を通して draft の `editGridMm` に入る。
  - 下段: 状態表示（`N 領域 / M セル · <選択中の領域>: K セル`、家具・ドラッグ中は `W × H セル / 約 w × h mm`）、エラー表示（`role="alert"`）、座標の説明（20mm・1100×620mm）。
  - キー操作: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z（ダイアログ内。入力欄にフォーカスがあるときは入力欄の取消を優先）、Esc でキャンセル（未適用の変更があれば確認ダイアログ）。
  - 描画は Pointer Events（`setPointerCapture`、`pointercancel`・`lostpointercapture` でドラッグを捨てる）。タッチ: キャンバスは `touch-action: none`、ただし 2 本指のスクロール・拡大はブラウザーに任せる。
  - ドア・ゲート・EV のプレビューは置ける位置だけオレンジで表示。ドラッグ中のセルは薄い塗り（消しゴムは別色）。選択物は輪郭で強調。
  - 「マップに適用」は `session.result()` が `ok` のときだけ `onApply` を呼び、`onApply` がエラー文字列を返したらダイアログを閉じずに表示する。

- [ ] **Step 1:** ダイアログの骨組み（モーダル・適用／キャンセル・未適用の確認・モード切替）。
- [ ] **Step 2:** キャンバスとポインター（`MapStage` を土台に、グリッド・選択・プレビューを重ねる）。
- [ ] **Step 3:** ツールバーと設定パネル。
- [ ] **Step 4:** 型チェック、`test:scene`、実ブラウザーで手動確認（幅 768 / 1024 / 1280、ライト／ダーク）。確認できなかった点は報告に明記する。
- [ ] **Step 5:** コミット `feat(scenes): add the map editor dialog`

### Task 7: Playwright（画面の自動テスト）

**Files:**
- Create: `web-controller/browser-tests/scenes-mapeditor.spec.ts`

**Interfaces:** `playwright.config.ts` は変更しない（ポート 3117・一時フォルダー）。

- [ ] **Step 1: テストを書く**（`browser-tests/helpers.ts` を再利用。ダイアログ内の要素は `getByRole("dialog", { name })`）
  - 開く → 部屋を長方形ドラッグで塗る → 適用 → 保存済みが 1 つ進み、マップに部屋が描かれ、再読込後も残る。
  - キャンセルで元のマップも履歴も変わらない。未適用の変更があるときに Esc を押すと確認が出て、「続ける」で戻れる。
  - 適用後に Ctrl+Z（ページ側）でマップ編集 1 回分が戻る。
  - 消しゴムで最後の 1 セルを消そうとするとエラーが出て、領域が残る。参照されている領域は削除できない（トラックを持つ領域を作るために、前提データは `/api/scenes/history` へ POST して用意する）。
  - ドア: 幅 140mm で置ける／選択肢に 120mm・260mm が無く、140〜240mm を 20mm 刻みで選べる。ゲートと EV を置ける。
  - 家具を置き、90° 回転し、削除できる。間仕切り壁が 100mm なら警告が出る。
  - 編集グリッドを 40mm に切り替えると 1 回のクリックで 2×2 マスが塗られる（セル数がステータスに出る）。
  - 元に戻す／やり直しが 100 段階を超えても動き、新しい操作で「やり直し」が無効になる。
  - 幅 768 / 1280 で、ダイアログがはみ出さず、ツールバーが折り返しても操作できる。両テーマでエラー文・状態表示のコントラストが 4.5:1 以上（実ピクセルで測る。`scenes-layout.spec.ts` の `textAndBackground` と同じ方式）。
  - タッチ（`hasTouch: true`）で長方形ドラッグができ、`pointercancel` でドラッグが残らない。
- [ ] **Step 2:** `npm --prefix web-controller run test:browser` で全件 PASS（S2a の 23 件を含む）。
- [ ] **Step 3:** 変異テスト（1 つ）: 「最後の 1 セルの保護」を一時的に外すと該当テストが失敗することを確認して戻す。日本語を含むファイルは編集ツールで直し、`Get-Content/Set-Content` を使わない。
- [ ] **Step 4:** 全回帰（`test:scene`・`test:fleet`・`test:localization`・`test:appearance`・`tsc`）と、文字化けの走査（`U+FFFD` が 0 件）。
- [ ] **Step 5:** コミット `test(scenes): add browser tests for the map editor`

---

## 並列実行（git worktree）

| 段階 | 担当 | 範囲 | 触るファイル |
|---|---|---|---|
| 0 | 私 | Task 1（入口幅。共有の定数に触るため先に済ませる） | `scene/equipment.ts`、`floorPlan.ts`、`equipment.test.ts` |
| 1 | A | Task 2 | `scene/mapEditPointer.ts`、そのテスト |
| 1 | B | Task 3 | `scene/mapEditRegions.ts`、そのテスト |
| 1 | C | Task 4 | `scene/mapEditFixtures.ts`、そのテスト |
| 2 | 私 | Task 5（A・B・C の統合後） | `scene/mapEditSession.ts`、そのテスト |
| 3 | 私 | Task 6 | `app/(console)/scenes/*` |
| 4 | 私 | Task 7 | `browser-tests/*` |

担当への依頼は、前回の教訓どおり「読むファイルを列挙」「触るファイルを限定」「完了前に必ずコミット」「報告は検証してから採用」とする。worktree は `C:\Users\1600028\Desktop\Developments\wt\` に作り、`node_modules` の junction（リポジトリ直下と `web-controller` の 2 つ）を張る。終了後はリンクを先に外してから削除する。

## 実装者に任せること（私の判断として記録）

- 各ファイルの内部分割と CSS のクラス名。ただし公開する関数名・型は上記を変えない。
- 補間の方式（DDA でも Bresenham でもよい）。

## 後続

- S2c（時間軸と動作の編集）は本計画の完了後に作成する。
