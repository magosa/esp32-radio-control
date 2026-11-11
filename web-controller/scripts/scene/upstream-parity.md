# 上流テストとの対応表

移植元: minirobo-editor `e937be4` の `test/*.test.js`（240 件、`HISTORY_MODE=off` の `node --test --test-reporter=tap` で列挙）。移植先: `web-controller/scripts/scene/*.test.ts`。

## 集計

| 区分 | 件数 |
|---|---:|
| 移植済み | 123 |
| 一部移植（ギャップあり） | 0 |
| 未移植（ギャップ） | 0 |
| 対象外: 旧互換 | 60 |
| 対象外: DOM | 4 |
| 対象外: 履歴サーバー | 6 |
| 対象外: 起動スクリプト | 4 |
| 対象外: 外部API | 5 |
| 対象外: S2以降 | 38 |
| 合計 | 240 |

ギャップ G1〜G14 はすべて解消した（経緯は末尾の「未移植のギャップ」に記載）。

## 対応表

### automatic-doors.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 1 | automatic doors detect robots and humans from both sides in world coordinates | 移植済み | automatic doors detect robots and humans from both sides in world coordinates |  |
| 2 | door sensor uses footprint clearance, opens progressively and stays open during passage | 移植済み | door sensor uses footprint clearance, opens progressively and stays open during passage |  |
| 3 | empty, removed and distant actors close the door; the nearest actor holds it open | 移植済み | empty, removed and distant actors close the door; the nearest actor holds it open |  |

### demo-map.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 4 | fleet demo map is a valid, warning-free timed project | 対象外: S2以降 |  | デモ／シナリオ（S3 で作り直し） |
| 5 | demo layout contains the requested rooms and decorative charging spaces | 対象外: S2以降 |  | デモ／シナリオ（S3 で作り直し） |
| 6 | Z-corridor route uses two explicit, orthogonal bends in each direction | 対象外: S2以降 |  | デモ／シナリオ（S3 で作り直し） |
| 7 | main corridor doors clear the 100 mm robot footprint | 対象外: S2以降 |  | デモマップの寸法確認（扉 200mm の開口は equipment テストで確認） |
| 8 | default scenario visibly brings people to a meeting, releases them and then cleans | 対象外: S2以降 |  | デモ／シナリオ（S3 で作り直し） |
| 9 | short exhibition uses a two-second meeting and gives priority to robot coordination | 対象外: S2以降 |  | デモ／シナリオ（S3 で作り直し） |
| 10 | charging centers accept initial robot placement without bypassing walls or furniture | 対象外: S2以降 |  | デモマップ依存。点の通行判定自体は safety テストで移植 |
| 11 | saved demos upgrade once while preserving custom timings, IDs and other maps | 対象外: S2以降 |  | 保存済みデモの更新（旧データ変換、S3） |
| 12 | office demo covers the field with a straight corridor, reception, offices and EV | 対象外: S2以降 |  | デモ／シナリオ（S3 で作り直し） |
| 13 | office scenario has no collision, blocked door or timing warnings and returns to charging | 対象外: S2以降 |  | デモ／シナリオ（S3 で作り直し） |
| 14 | office actors finish rotating at rest before every translation | 対象外: S2以降 |  | デモ／シナリオ（S3 で作り直し） |
| 15 | fire coordination demo retreats cleaning before security enters the fire room | 対象外: S2以降 |  | デモ／シナリオ（S3 で作り直し） |
| 16 | yield coordination demo waits, retreats from the shared corridor and stays collision-free | 対象外: S2以降 |  | デモ／シナリオ（S3 で作り直し） |
| 17 | coordination demo rejects unsupported scenario names | 対象外: S2以降 |  | デモ／シナリオ（S3 で作り直し） |
| 18 | conflict companion is simulation-only and predicts a collision without plan errors | 対象外: S2以降 |  | デモ／シナリオ（S3 で作り直し） |
| 19 | room activity follows physical robot occupancy and excludes charging and muted robots | 移植済み | room activity follows physical robot occupancy and excludes charging and muted robots<br>room activities list stationary robots in rooms, excluding moving robots and charging zones | G13 で解消。デモマップの代わりに 2 部屋の小さなマップで検証 |
| 20 | transit and turning robots never become room activities while crossing the entrance | 移植済み | transit and turning robots never become room activities while crossing the entrance | G14 で解消。デモマップの代わりに廊下付きの小さなマップで検証 |

### door-controls.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 21 | unlock bars have exact duration and use only their owning room | 移植済み | unlock bars have exact duration and use only their owning room<br>compiled unlock bars have exact duration; a foreign room's unlock leaves the walker at its start |  |
| 22 | expiry during passage holds safely until clear and is deterministic when seeking | 移植済み | expiry during passage holds safely until clear and is deterministic when seeking |  |
| 23 | unlocked doors advertise only actors whose current path crosses that doorway | 移植済み | unlocked doors advertise only actors whose current path crosses that doorway |  |
| 24 | short robot passages open during the preceding turn and close gradually after arrival | 移植済み | short robot passages open during the preceding turn and close gradually after arrival<br>compiled short robot passages match the hand-built door plan and keep exact bar times |  |
| 25 | meeting room doors remain continuous at arrival, waiting and departure boundaries | 移植済み | meeting room doors remain continuous at arrival, waiting and departure boundaries |  |
| 26 | story-only mode warns for locked passages without stopping motion or opening doors | 移植済み | story-only mode warns for locked passages without stopping motion or opening doors |  |
| 27 | editor migration keeps robot timing through locked doors and preserves explicit strict mode | 移植済み | story mode keeps robot timing through locked doors; strict blocks the passage and what follows | 旧形式からの移行部分は旧互換 |
| 28 | story default does not allow robots to cross walls outside a doorway | 移植済み | story mode does not let robots cross walls outside a doorway |  |
| 29 | named independent gates unlock individually, not every gate owned by the corridor | 移植済み | named independent gates unlock individually, not every gate owned by the corridor |  |
| 30 | unlock must be active before the leading footprint reaches the doorway | 移植済み | unlock must be active before the leading footprint reaches the doorway |  |
| 31 | muted, failed and invalid unlock controls never permit a passage | 移植済み | blocked and unsuccessful unlock entries never permit a passage<br>muted and late unlock controls never permit a passage<br>rejects duplicate ids and unresolved references |  |
| 32 | layout reuse preserves the full appearance but creates independent IDs and empty sequences | 移植済み | copyMapLayout assigns new ids, keeps references consistent and leaves the source untouched<br>copyMapLayout works on frozen input and with the default id factory | S1 で関数を移植済み。マップ追加の複製操作は S2b |

### equipment-sizing.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 33 | new EVs keep entrance width exactly six cells in every orientation and drag direction | 移植済み | new EVs keep entrance width exactly ten cells in every orientation and drag direction |  |
| 34 | new boundary doors atomically add six contiguous cells as one opening | 移植済み | new boundary doors atomically add ten contiguous cells as one opening |  |
| 35 | EV placement cuts only corridor cells, adds the oriented entrance and preserves legacy EVs | 移植済み | EV placement cuts only corridor cells, adds the oriented entrance and preserves legacy EVs |  |
| 36 | EV placement rejects blocked footprints without deleting existing furniture or walls | 移植済み | EV placement rejects blocked footprints without deleting existing furniture or walls |  |
| 37 | short, wrapping, interrupted and already occupied boundaries reject without partial writes | 移植済み | short, wrapping, interrupted and already occupied boundaries reject without partial writes<br>doors on walls shorter than ten cells are rejected with a reason |  |
| 38 | six-cell door cannot cross different adjacent regions | 移植済み | ten-cell door cannot cross different adjacent regions |  |
| 39 | independent automatic doors are six cells, never clipped to a short wall | 移植済み | independent automatic doors are ten cells, never clipped to a short wall |  |
| 40 | rectangular gate overlays reuse walls and flapper door without carving the floor | 移植済み | rectangular gate overlays reuse walls and flapper door without carving the floor |  |
| 41 | invalid gate overlays reject blank cells, multiple rooms, furniture, walls and non-rectangles atomically | 移植済み | invalid gate overlays reject blank cells, multiple rooms, furniture, walls and non-rectangles atomically |  |
| 42 | save and validation preserve old equipment sizes and new opening groups | 移植済み | save and validation preserve old equipment sizes and new opening groups |  |

### fleet.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 43 | fleet bundle freezes one-based indices, full maps, initial poses and world-unit robot sequences | 対象外: 外部API |  | scene-fleet-bundle/v1 の書き出し |
| 44 | fleet bundle rejects invalid schema but preserves every blocked action with explicit errors | 対象外: 外部API |  | scene-fleet-bundle/v1 の書き出し |
| 45 | fleet session accepts commands only while connected, acknowledges serially and protects retries | 対象外: 外部API |  | /api/fleet のセッション・HTTP |
| 46 | fleet HTTP API publishes snapshots, restricts origins, validates commands and clears ended sessions | 対象外: 外部API |  | /api/fleet のセッション・HTTP |

### floor-plan.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 47 | 50-inch physical dimensions describe display area, not ratio coordinate units | 移植済み | ratioToMm maps the ratio corner to the field size<br>cell grid exactly covers the drawable area |  |
| 48 | multi-cell furniture roundtrips and blocks every occupied navigation cell | 移植済み | multi-cell furniture roundtrips and rejects overlap and malformed footprints<br>multi-cell furniture blocks every occupied navigation cell |  |
| 49 | furniture cannot cross a room boundary or a hole | 移植済み | furniture cannot cross a room boundary or a hole |  |
| 50 | rotation swaps the footprint and rejects blocked or out-of-map results | 移植済み | rotation swaps the footprint and rejects blocked or out-of-map results<br>furniture rotated 90 degrees out of its room is rejected |  |
| 51 | adjacent doors merge into a continuous opening without a central wall | 移植済み | adjacent doors merge into a continuous opening without a central wall<br>adjacent doors merge into one opening without a central wall |  |
| 52 | navigation exports bottom-left walls, door gaps and conservative obstacle cells | 移植済み | navigation exports wall stubs at door ends, reasons and obstacle rectangles<br>navigation uses the mm bottom-left contract with 1705 cells |  |
| 53 | door snapping finds walls from either side, outer border and shared walls | 移植済み | door snapping finds walls from either side, outer border and shared walls |  |
| 54 | named partition walls and corridor doors persist and export navigation geometry | 移植済み | named partition walls and corridor doors persist as mm Y-up segments<br>named partition walls and corridor doors export navigation geometry |  |
| 55 | independent corridor barriers stop unsafe paths and wide door openings permit passage | 移植済み | independent corridor barriers stop unsafe paths and wide door openings permit passage |  |
| 56 | rendering can hide labels while preserving names, elevator appearance and reception monitor | 対象外: DOM |  | 描画 |
| 57 | door mode and door-specific unlock references validate and remap with copied layouts | 移植済み | door mode and door-specific unlock references validate<br>rejects duplicate ids and unresolved references | G3 で解消。レイアウトの複製（remap）は S2 以降 |
| 58 | grid bounds use top-row indices and bottom-left world coordinates | 移植済み | grid bounds use bottom-row indices and bottom-left mm<br>cellIndex counts rows from the bottom and rejects out-of-range |  |
| 59 | actual L-shaped occupancy excludes the missing bbox corner | 移植済み | actual L-shaped occupancy excludes the missing bbox corner<br>L-shaped room rejects the empty cell center inside its bounding box |  |
| 60 | anchor selects a cell interior even for a ring with a hole | 移植済み | anchor selects a cell interior even for a ring with a hole |  |
| 61 | legacy rectangles remain unmodified, optional floor plan is supported | 移植済み | maps without a floor plan still export cell-based navigation | 矩形の部屋（旧形式）は旧互換 |
| 62 | ownership validates polygons instead of overlapping bounding boxes | 移植済み | ownership validates cell polygons instead of overlapping bounding boxes |  |
| 63 | doors belong to occupied cell boundaries and shared-wall doors are unique | 移植済み | doors belong to occupied cell boundaries and shared-wall doors are unique |  |
| 64 | furniture validates occupancy, kind, cardinal rotation and unique cell | 移植済み | furniture validates occupancy, kind, cardinal rotation and unique cell | G4 で解消（validateFloorPlan を修正） |
| 65 | strict values, ID safety and count limits reject malformed plans | 移植済み | strict values, ID safety and count limits reject malformed plans<br>rejects cell indices outside 0..1704<br>rejects duplicate ids and unresolved references | G5 で解消（validateFloorPlan を修正） |
| 66 | JSON roundtrip preserves IDs, references, polygons and fixtures | 移植済み | JSON roundtrip preserves IDs, references, polygons and fixtures |  |
| 67 | unreferenced region deletion removes fixtures without mutating the input | 移植済み | unreferenced region deletion removes fixtures without mutating the input |  |
| 68 | region deletion protects direct track, initial and action room references | 移植済み | region deletion protects direct track, initial and action room references |  |
| 69 | renderer stretches furniture to its footprint and switches multi-cell variants | 対象外: DOM |  | 描画・エディターモジュール |
| 70 | renderer is DOM-lazy, has clickable geometry, shared walls, door gap and textured furniture | 対象外: DOM |  | 描画・エディターモジュール |
| 71 | editor module is also importable without a top-level document | 対象外: DOM |  | 描画・エディターモジュール |
| 72 | extended equipment selectively saves v5 and survives timeline conversion and roundtrip | 対象外: 旧互換 |  | v5 保存・旧時間軸への変換 |

### history-http.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 73 | history HTTP API persists snapshots and rejects cross-origin writes and invalid payloads | 対象外: 履歴サーバー |  |  |

### history.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 74 | disk history survives restart and can roll forward after applying an older snapshot | 対象外: 履歴サーバー |  |  |
| 75 | disk history rejects competing writers and stale revisions without overwriting | 対象外: 履歴サーバー |  |  |
| 76 | corrupt committed history is reported instead of silently skipping a revision | 対象外: 履歴サーバー |  |  |
| 77 | client preserves every rapid edit and resumes unsent history after a restart | 対象外: 履歴サーバー |  |  |
| 78 | client rejects edits when local pending backup is full or another editor advances history | 対象外: 履歴サーバー |  |  |

### model.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 79 | ordered v3 roundtrips and new actions need no explicit trigger | 対象外: 旧互換 |  | ordered モード |
| 80 | ordered left-to-right placement changes actual order and preview without mutating input | 対象外: 旧互換 |  | ordered モード |
| 81 | ordered tracks run independently and implicit completion cannot be bypassed by OR | 対象外: 旧互換 |  | ordered モード |
| 82 | ordered additional waits can delay a row and preserve delays and legacy start conditions | 対象外: 旧互換 |  | ordered モード |
| 83 | ordered implicit edges reject cycles after reordering or cross-track connections | 対象外: 旧互換 |  | ordered モード |
| 84 | ordered equal positions are stable, and immediate actions finish before the next | 対象外: 旧互換 |  | ordered モード |
| 85 | legacy v2 has no implicit execution edges and remains unchanged until opted in | 対象外: 旧互換 |  | v2 |
| 86 | new movement uses a fixed near-10mm arrival margin and stable wait | 対象外: 旧互換 |  | 到着許容・dwell は fleet-scene/v1 で廃止 |
| 87 | action preview resolves trigger-ordered start position instead of array order | 移植済み | action preview resolves the time-ordered start pose without mutating the map | トリガー順は時刻順に置換 |
| 88 | rotation seconds sets actual duration and completion trigger without changing legacy speed | 対象外: 旧互換 |  | angularSpeed・rotationSeconds による所要時間は runSeconds に置換。旋回の進行は 179→-179 のテストで確認 |
| 89 | display templates and event hatch options persist and reach runtime state | 移植済み | display templates and event hatch options persist and reject unknown values<br>display targets update in place, hide removes only its target, and templates reach the state<br>room events update stable targets and unrelated ends do not clear other states | G6 で解消 |
| 90 | rotation stays in place, uses shortest yaw and angular speed, then triggers a straight move | 移植済み | 179 to -179 explicit rotation takes the shortest 2 degree arc over the bar length and keeps the room |  |
| 91 | rotation uses the preceding arrival, preserves room, and rejects overlapping movement | 移植済み | 179 to -179 explicit rotation takes the shortest 2 degree arc over the bar length and keeps the room<br>same-row overlap is an error and does not slip the bar or block other rows | angularSpeed の検証は旧互換 |
| 92 | two consecutive moves form straight segments and initial pose persists without an action | 移植済み | consecutive moves form straight segments, keep yaw and the initial pose persists without actions |  |
| 93 | exports, helpers, v2 sample, JSON roundtrip, and distinct project IDs | 移植済み | createProject yields one empty valid fleet-scene/v1 map<br>projectForSave output survives a JSON roundtrip through validateProject | v2 サンプルは旧互換 |
| 94 | grid rooms aggregate only occupied cells, retain IDs and select an interior arrival point | 移植済み | actual L-shaped occupancy excludes the missing bbox corner<br>events aggregate stationary actors inside the room; moving or outside actors wait for arrival; end releases<br>rejects duplicate ids and unresolved references |  |
| 95 | planned duration roundtrips but never changes execution and supports legacy omissions | 対象外: 旧互換 |  | plannedDuration は廃止 |
| 96 | save snapshot refreshes derived navigation without changing editable data | 移植済み | save snapshot refreshes derived navigation without changing editable data |  |
| 97 | all new kinds and actions validate; defaults are unique, chain locally, and never mutate input | 移植済み | all new kinds and actions validate; defaults are unique, chain locally, and never mutate input<br>sample project with tracks, rooms and doors is valid | G7 で解消。trigger の連鎖は position の連鎖に置換 |
| 98 | multiple maps are independent and trigger references never cross map boundaries | 対象外: 旧互換 |  | マップ間のトリガー参照 |
| 99 | actual start/complete timestamps drive all/any, delays, gaps, and forward references | 対象外: 旧互換 |  | トリガー |
| 100 | any trigger picks earliest actual source, not first source or first array entry | 対象外: 旧互換 |  | トリガー |
| 101 | move duration is distance/speed plus dwell; yaw follows shortest arc; tolerances are reference-only | 対象外: 旧互換 |  | 速度・dwell・許容値による所要時間 |
| 102 | zero-distance movement applies yaw and dwell without invented rotation duration | 対象外: 旧互換 |  | 距離 0 の移動の dwell |
| 103 | planned editor position is not simulation time, and seeking is pure and deterministic | 移植済み | compilePlan is deterministic and sampling does not depend on call order or mutate the map |  |
| 104 | muted sources block all dependents, any may use live source, and locks do not mute | 対象外: 旧互換 |  | トリガーの依存元ミュート |
| 105 | overlapping moves block deterministically instead of secretly serializing or introducing a gate | 移植済み | same-row overlap is an error and does not slip the bar or block other rows |  |
| 106 | display targets update in place, hide removes only its target, and effects apply at exact completion | 移植済み | display targets update in place, hide removes only its target, and templates reach the state |  |
| 107 | actor-attached show/hide coexist with motion and identify their owner by track ID | 移植済み | actor-attached displays identify their owner by track ID |  |
| 108 | event-end defaults match last known local target and selected room, including other room tracks | 移植済み | event-end defaults match last known local target and selected room, including other room tracks | G8 で解消 |
| 109 | same-timestamp effects have deterministic map/track/action order with dependency precedence | 移植済み | same-timestamp effects have deterministic track/action order (later track wins) | G9 で解消。依存関係（トリガー）の優先は旧互換 |
| 110 | room events update stable targets, unrelated end does not clear other room states | 移植済み | room events update stable targets and unrelated ends do not clear other states |  |
| 111 | arrival during event aggregates, latch survives end, same-room move retains and exit releases at start | 対象外: 旧互換 |  | イベント終了後も集約を保つのは非固定時間軸の挙動。固定時間軸では終了で解除（上流 timed の event completion と同じ） |
| 112 | starting event aggregates stationary actors inside room, not moving or geometrically outside actors | 移植済み | events aggregate stationary actors inside the room; moving or outside actors wait for arrival; end releases |  |
| 113 | event during arrival dwell sees stationary actor and aggregation is retained after event end | 対象外: 旧互換 |  | 到着後の dwell |
| 114 | event starting during unaggregated same-room travel does not aggregate until arrival | 移植済み | events aggregate stationary actors inside the room; moving or outside actors wait for arrival; end releases |  |
| 115 | valid backgrounds include high-quality 15MB encoded images without regex recursion | 対象外: 旧互換 |  | 背景画像は fleet-scene/v1 で廃止 |
| 116 | aggregate encoded background size reserves metadata headroom for 80MiB JSON imports | 対象外: 旧互換 |  | 背景画像は fleet-scene/v1 で廃止 |
| 117 | validator rejects v1 | 移植済み | rejects wrong schema |  |
| 118 | validator rejects absolute project duration | 対象外: 旧互換 |  | v1 の duration |
| 119 | validator rejects empty maps | 移植済み | validator rejects empty maps | G2 で解消 |
| 120 | validator rejects map limit | 移植済み | rejects more than 8 maps |  |
| 121 | validator rejects null map | 移植済み | validator rejects null map | G2 で解消 |
| 122 | validator rejects duplicate global ID | 移植済み | rejects duplicate ids and unresolved references |  |
| 123 | validator rejects unsafe ID | 移植済み | validator rejects unsafe ID | G2 で解消 |
| 124 | validator rejects reserved ID | 移植済み | validator rejects reserved ID | G2 で解消 |
| 125 | validator rejects unknown kind | 移植済み | validator rejects unknown kind | G2 で解消 |
| 126 | validator rejects unsafe color | 移植済み | validator rejects unsafe color | G2 で解消 |
| 127 | validator rejects nonboolean mute | 移植済み | validator rejects nonboolean mute | G2 で解消 |
| 128 | validator rejects duplicate robot | 移植済み | validator rejects duplicate robot | G2 で解消 |
| 129 | validator rejects fractional robot | 対象外: 旧互換 |  | 整数の robotId は fleet.json の文字列 ID に置換 |
| 130 | validator rejects human zero count | 移植済み | validator rejects human zero count<br>validator accepts text of exactly 4000 chars and a human count of 1 | G2 で解消 |
| 131 | validator rejects human fractional count | 移植済み | validator rejects human fractional count | G2 で解消 |
| 132 | validator rejects unknown initial room | 移植済み | rejects an actor initial.roomId that is non-empty and does not exist |  |
| 133 | validator rejects missing initial room | 移植済み | validator rejects missing initial room | G2 で解消 |
| 134 | validator rejects bad initial coordinates | 移植済み | rejects yaw -180 and coordinates outside the drawable area |  |
| 135 | validator rejects room outside bounds | 移植済み | rejects cell indices outside 0..1704 | 矩形の部屋は廃止。マス番号で検証 |
| 136 | validator rejects unknown room track reference | 移植済み | rejects a room track whose roomId does not exist |  |
| 137 | validator rejects unknown action room | 移植済み | validator rejects unknown action room | G2 で解消 |
| 138 | validator rejects wrong action kind | 移植済み | validator rejects wrong action kind | G2 で解消 |
| 139 | validator rejects absolute start | 対象外: 旧互換 |  | v1 の start・duration |
| 140 | validator rejects duration | 対象外: 旧互換 |  | v1 の start・duration |
| 141 | validator rejects nonfinite speed | 対象外: 旧互換 |  | speed は廃止 |
| 142 | validator rejects zero speed | 対象外: 旧互換 |  | speed は廃止 |
| 143 | validator rejects numeric string | 移植済み | validator rejects numeric string | G2 で解消 |
| 144 | validator rejects bad coordinates | 移植済み | rejects yaw -180 and coordinates outside the drawable area |  |
| 145 | validator rejects bad yaw | 移植済み | rejects yaw -180 and coordinates outside the drawable area |  |
| 146 | validator rejects nonfinite editor position | 移植済み | rejects times outside 0..86400 |  |
| 147 | validator rejects negative tolerance | 対象外: 旧互換 |  | tolerance・dwell・angleTolerance は廃止 |
| 148 | validator rejects nonfinite dwell | 対象外: 旧互換 |  | tolerance・dwell・angleTolerance は廃止 |
| 149 | validator rejects bad angle tolerance | 対象外: 旧互換 |  | tolerance・dwell・angleTolerance は廃止 |
| 150 | validator rejects bad target | 移植済み | rejects duplicate ids and unresolved references |  |
| 151 | validator rejects bad state | 移植済み | validator rejects bad state | G2 で解消 |
| 152 | validator rejects bad text | 移植済み | validator rejects bad text | G2 で解消 |
| 153 | validator rejects long text | 移植済み | validator rejects long text<br>validator accepts text of exactly 4000 chars and a human count of 1 | G2 で解消 |
| 154 | validator rejects null trigger | 対象外: 旧互換 |  | トリガー（fleet-scene/v1 では trigger を拒否: rejects join actions and trigger properties） |
| 155 | validator rejects unknown mode | 対象外: 旧互換 |  | トリガー（fleet-scene/v1 では trigger を拒否: rejects join actions and trigger properties） |
| 156 | validator rejects empty sources | 対象外: 旧互換 |  | トリガー（fleet-scene/v1 では trigger を拒否: rejects join actions and trigger properties） |
| 157 | validator rejects null source | 対象外: 旧互換 |  | トリガー（fleet-scene/v1 では trigger を拒否: rejects join actions and trigger properties） |
| 158 | validator rejects start complete | 対象外: 旧互換 |  | トリガー（fleet-scene/v1 では trigger を拒否: rejects join actions and trigger properties） |
| 159 | validator rejects negative delay | 対象外: 旧互換 |  | トリガー（fleet-scene/v1 では trigger を拒否: rejects join actions and trigger properties） |
| 160 | validator rejects nonfinite delay | 対象外: 旧互換 |  | トリガー（fleet-scene/v1 では trigger を拒否: rejects join actions and trigger properties） |
| 161 | validator rejects missing action reference | 対象外: 旧互換 |  | トリガー（fleet-scene/v1 では trigger を拒否: rejects join actions and trigger properties） |
| 162 | validator rejects self cycle | 対象外: 旧互換 |  | トリガー（fleet-scene/v1 では trigger を拒否: rejects join actions and trigger properties） |
| 163 | validator rejects indirect cycle even in any mode | 対象外: 旧互換 |  | トリガー（fleet-scene/v1 では trigger を拒否: rejects join actions and trigger properties） |
| 164 | validator rejects external background | 対象外: 旧互換 |  | 背景画像は fleet-scene/v1 で廃止 |
| 165 | validator rejects SVG background | 対象外: 旧互換 |  | 背景画像は fleet-scene/v1 で廃止 |
| 166 | validator rejects bad base64 | 対象外: 旧互換 |  | 背景画像は fleet-scene/v1 で廃止 |
| 167 | validator rejects empty background | 対象外: 旧互換 |  | 背景画像は fleet-scene/v1 で廃止 |
| 168 | validator rejects background size | 対象外: 旧互換 |  | 背景画像は fleet-scene/v1 で廃止 |
| 169 | 2000 action limit is global across maps, exact limit validates without recursive graph traversal | 移植済み | 2000 action limit is global across maps, exact limit validates<br>accepts 2000 actions and rejects 2001 | G10 で解消。グラフ走査はトリガー廃止で不要 |
| 170 | time formatting carries rounded seconds and minutes | 移植済み | formatTime uses m:ss.s with carry on rounding<br>formatTime treats negative and non-finite values as 0 | S2c（timelineView.ts） |

### scenario-library.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 171 | the library contains sixteen distinct, independently generated scenarios | 対象外: S2以降 |  | 16 本のシナリオ（S3） |
| 172 | daily-security: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 173 | daily-cleaning: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 174 | daily-delivery: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 175 | tutorial-passage: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 176 | tutorial-door: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 177 | tutorial-fire: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 178 | tutorial-crowd: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 179 | tutorial-dirt: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 180 | tutorial-vip: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 181 | bcp: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 182 | garbage: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 183 | occupancy: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 184 | learning: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 185 | hospitality: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 186 | environment: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 187 | remote: schema roundtrip, complete playback, facing and collision safety | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 188 | daily scenarios share building geometry and show three roles without moving standby robots | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 189 | door priority demonstrates actual intermediate closure before the other robot crosses | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 190 | dirty regions are partial, visible before cleaning and removed when cleaning completes | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 191 | building-side crowd information precedes clockwise detour and stays outside local sensor view | 対象外: S2以降 |  | シナリオライブラリ（S3） |
| 192 | presentation input rejects malformed times, geometry, styling and excessive cue counts | 移植済み | validatePresentation rejects malformed times, geometry, styling and excessive cue counts |  |

### scene-features.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 193 | bulk timeline validation preserves long timed durations accepted by the project schema | 移植済み | checkSequence accepts long timed durations and rejects out-of-range seconds |  |
| 194 | batch timeline edits preserve relative starts and reject invalid edits atomically | 移植済み | adjustTimeline shifts and resizes as a group and rejects invalid edits atomically |  |
| 195 | sequence reordering changes chronological order without changing duration or gaps | 移植済み | reorderSequence swaps order while keeping durations and the gap |  |
| 196 | scenario handoff is explicitly a draft with percent coordinates and exact action times | 対象外: 外部API |  | scene-scenario-draft（百分率座標）の出力は非目標 |
| 197 | 100mm rendering dimension and editor safety share the same conservative footprint | 移植済み | wall clearance of exactly 60mm is allowed and 59mm is rejected<br>collision thresholds are 120mm robot-robot and 74mm robot-human | 100mm の描画寸法は D6（安全半径 60mm 固定）で置換 |
| 198 | charging overlays preserve all navigation cells, walls and obstacles across JSON roundtrip | 移植済み | charging overlays preserve all navigation cells, walls and obstacles across JSON roundtrip<br>charging zones do not change navigation | G11 で解消（validateFloorPlan を修正） |
| 199 | robot role accepts all three types, preserves old missing values and rejects unknown roles | 移植済み | robot role accepts all three types, preserves old missing values and rejects unknown roles | G12 で解消 |
| 200 | disconnected join nodes are editable but cannot fire without two sources | 対象外: 旧互換 |  | 合流 |

### startup.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 201 | startup PowerShell files parse and an explicit Node.js can prepare without downloads | 対象外: 起動スクリプト |  |  |
| 202 | an invalid explicit Node.js fails instead of downloading or falling back | 対象外: 起動スクリプト |  |  |
| 203 | cached user-local Node.js is reused offline without modifying its files | 対象外: 起動スクリプト |  |  |
| 204 | runtime checksum mismatch aborts execution and removes only its staging directory | 対象外: 起動スクリプト |  |  |

### timed.test.js

| # | 上流テスト | 区分 | 移植先のテスト | 備考 |
|---:|---|---|---|---|
| 205 | facing turns insert shared time, keep translation duration and are idempotent after edits | 移植済み | facing turns insert shared time, keep translation duration and are idempotent after edits |  |
| 206 | human turn migration removes manual and generated rotations without shifting other bars | 対象外: 旧互換 |  | 人物の旋回の移行 |
| 207 | timeline alignment uses an eight-screen-pixel radius for either edge at every zoom | 移植済み | timelineAlignment snaps either edge within eight screen pixels at every zoom<br>timelineAlignment ignores candidates outside min..max |  |
| 208 | timeline-only migration preserves bars and layout while removing joins and cyclic conditions | 対象外: 旧互換 |  | timeline-only への移行 |
| 209 | timeline-only new actions omit conditions, reject joins and retain timed waits | 移植済み | rejects join actions and trigger properties |  |
| 210 | timeline-only still stops overlapping rows without blocking independent former dependencies | 移植済み | same-row overlap is an error and does not slip the bar or block other rows |  |
| 211 | timeline-only migration rejects unsupported schemas and retains validation of bad coordinates | 対象外: 旧互換 |  | timeline-only への移行 |
| 212 | fixed timeline uses exact bar start/end and ignores physical delay simulation settings | 移植済み | fixed timeline uses exact bar start/end and keeps mm segments as the planned trajectory |  |
| 213 | fixed timeline rejects overlapping bars and late triggers without silently slipping | 移植済み | same-row overlap is an error and does not slip the bar or block other rows | 遅れたトリガーは旧互換 |
| 214 | fixed timeline display and room events end exactly at the right edge of their bars | 移植済み | display and room events end exactly at the right edge of their bars |  |
| 215 | fixed timeline event completion restores actors hidden by room aggregation | 移植済み | events aggregate stationary actors inside the room; moving or outside actors wait for arrival; end releases |  |
| 216 | editing geometry is checked independently of muted rows, failed predecessors and invalid initial poses | 移植済み | action preview checks geometry regardless of muted rows, blocked predecessors and invalid initial poses |  |
| 217 | v4 timing uses placement, actual width and downstream slip, and seeking is deterministic | 対象外: 旧互換 |  | 非固定時間軸の後続の遅れ |
| 218 | wait holds display until hide; join waits for both successful completions | 移植済み | display targets update in place, hide removes only its target, and templates reach the state | 合流は旧互換 |
| 219 | failed and timed out actions never release implicit successors or joins | 移植済み | geometry failures stop at the start pose and block what follows on the row | タイムアウト・合流は旧互換 |
| 220 | joining timeout includes time waiting for dependencies | 対象外: 旧互換 |  | timeoutSeconds は廃止 |
| 221 | timed-out rotation stops at its partial angle and never drifts after the deadline | 対象外: 旧互換 |  | timeoutSeconds は廃止 |
| 222 | rotation is motion for room aggregation until the turn has finished | 移植済み | rotation is motion for room aggregation until the turn has finished |  |
| 223 | failure or timeout during arrival dwell preserves the reached position and angle | 対象外: 旧互換 |  | simulationOutcome・timeoutSeconds・dwell は廃止 |
| 224 | new timed actions add dwell only after movement, not display or wait | 対象外: 旧互換 |  | dwell は廃止 |
| 225 | grid snap uses cell centers at all edges | 移植済み | grid coordinates snap to edit-grid centers at all edges<br>snapToEditGrid returns the center of the in-range block |  |
| 226 | free coordinates preserve decimals, constrain axes from the origin, and validate explicitly | 移植済み | free coordinates preserve decimals, constrain axes from the origin, and validate explicitly |  |
| 227 | walls, furniture, unassigned cells and swept body clearance block paths | 移植済み | walls, furniture, unassigned cells and swept body clearance block paths |  |
| 228 | imported invalid initial poses are explicitly blocked even without any movement action | 移植済み | invalid initial poses block the row explicitly; muted rows report no errors |  |
| 229 | continuous closest approach detects human/robot crossings and stationary actors | 移植済み | continuous closest approach detects human/robot crossings and stationary actors |  |
| 230 | fixed timeline reports corridor conflicts instead of adding invisible waiting time | 移植済み | fixed timeline reports narrow corridor conflicts instead of adding invisible waiting time |  |
| 231 | narrow corridors serialize opposing robots, hold outside entry and delay downstream | 対象外: 旧互換 |  | 廊下待ちの収束計算（非固定時間軸） |
| 232 | four-cell corridors are not exclusive and parked robots in narrow corridors block entry | 移植済み | twelve-cell corridors are not exclusive and parked robots in narrow corridors block entry<br>corridors up to 11 cells wide form one-at-a-time zones; 12 cells do not | G1 で解消（timedPlan.ts に停車中ロボットの検出を追加） |
| 233 | a deadline expires even when the corridor occupant never has an exit plan | 対象外: 旧互換 |  | timeoutSeconds・トリガー |
| 234 | a deadline covers an unresolved dependency, not just dependencies with known completion times | 対象外: 旧互換 |  | timeoutSeconds・トリガー |
| 235 | a robot initially in a narrow corridor has priority to exit before an incoming robot | 対象外: 旧互換 |  | 廊下待ちの収束計算（非固定時間軸） |
| 236 | nonconvergent traffic plans stop all effects instead of releasing stale downstream completions | 対象外: 旧互換 |  | 廊下待ちの収束計算 |
| 237 | v4 validates fields and roundtrips without altering legacy maps | 対象外: 旧互換 |  | v4 |
| 238 | autosave serializes writers and stops stale tabs without overwriting | 対象外: S2以降 |  | エディターの自動保存（localStorage） |
| 239 | storage quota errors do not advance the save baseline and explicit recovery stops preserve raw data | 対象外: S2以降 |  | エディターの自動保存（localStorage） |
| 240 | compiled 2000-action sampling matches fresh evaluation and stays within a frame budget | 移植済み | a 2000-action plan compiles within 2s, samples within a frame and matches fresh evaluation |  |

## 未移植のギャップ

Task 1〜10 で移植すべき DOM 非依存の挙動のうち、移植先に対応するテストがないもの。本表作成時点では修正していない。

- **G1** `four-cell corridors are not exclusive and parked robots in narrow corridors block entry`（#232）: 1 台ずつ通す区間（幅 11 マス以下）に初期位置で停車しているロボットがいるとき、その区間を通る他のロボットの移動を止める挙動（上流 `timed-plan.js` の `resourceReady`。固定時間軸でも有効）。移植先は区間の幅の判定だけで、停車中のロボットを検出しない（Task 9 で既知）。
- **G2** model の検証（`scene/model.ts` の `validateProject` に実装はあるが、テストがない）:
  - `validator rejects empty maps`（#119）: `maps: []` の拒否
  - `validator rejects null map`（#121）: `maps[0] = null` の拒否
  - `validator rejects unsafe ID`（#123）: `__proto__` などの ID の拒否
  - `validator rejects reserved ID`（#124）: `$start` の ID の拒否
  - `validator rejects unknown kind`（#125）: 未知の行種別の拒否
  - `validator rejects unsafe color`（#126）: `#RRGGBB` 以外の色の拒否
  - `validator rejects nonboolean mute`（#127）: 真偽値でない `muted` の拒否
  - `validator rejects duplicate robot`（#128）: 同じ `robotId` を 2 行に割り当てた場合の拒否
  - `validator rejects human zero count`（#130）・`validator rejects human fractional count`（#131）: 人数 0・小数の拒否
  - `validator rejects missing initial room`（#133）: `initial.roomId` の欠落の拒否
  - `validator rejects unknown action room`（#137）: アクションの存在しない `roomId` の拒否（空文字の unlock だけ検証済み）
  - `validator rejects wrong action kind`（#138）: 行種別に合わないアクション種別の拒否
  - `validator rejects numeric string`（#143）: 数値の文字列（`x: "10"`）の拒否
  - `validator rejects bad state`（#151）: 未知の部屋状態の拒否
  - `validator rejects bad text`（#152）・`validator rejects long text`（#153）: 文字列でない text・4000 字を超える text の拒否
- **G3** `door mode and door-specific unlock references validate and remap with copied layouts`（#57）: `doorMode` の不正値、他の部屋の扉を指す `doorId`、unlock 以外のアクションに付いた `doorId` の拒否が未検証（実装は `model.ts`）。レイアウトの複製部分は S2 以降。
- **G4** `furniture validates occupancy, kind, cardinal rotation and unique cell`（#64）: 家具の `type`（`"script"`）、回転角（45・360・`"90"`）、`roomId: "__proto__"`、他の要素と重複する ID の拒否が未検証。`floorPlan.ts` の `validateFloorPlan` 単体はこれらを検証せず、`validateProject`（`model.ts`）にだけ実装がある。
- **G5** `strict values, ID safety and count limits reject malformed plans`（#65）: 部屋の名前（型・121 字以上）・色・種類・床材・ID 安全性の拒否、`floorPlan` が null や配列でない場合の拒否、扉・家具・部屋の件数上限の拒否が未検証。
- **G6** `display templates and event hatch options persist and reach runtime state`（#89）: `displayTemplate`・`hatchStyle` の未知の値、`hatchColor` の不正な色の拒否が未検証（実行時の状態への反映は移植済み）。
- **G7** `all new kinds and actions validate; defaults are unique, chain locally, and never mutate input`（#97）: `newTrack` の未知の kind と、行種別に合わない `newAction` の type で例外を投げること、両関数が入力の map・track を変更しないこと、同種の行の名前が重複しないことが未検証。
- **G8** `event-end defaults match last known local target and selected room, including other room tracks`（#108）: event-end の既定の target が、同じ部屋を担当する別の部屋行の最後の event-start を引き継ぐこと（`model.ts` の `newAction` に実装）が未検証。
- **G9** `same-timestamp effects have deterministic map/track/action order with dependency precedence`（#109）: 同じ時刻に同じ `targetId` へ作用する表示の適用順（後の行が勝つ）が未検証。依存関係の優先はトリガー前提のため旧互換。
- **G10** `2000 action limit is global across maps, exact limit validates without recursive graph traversal`（#169）: アクション 2000 件の上限をマップをまたいだ合計で数えることが未検証（単一マップの 2000／2001 件だけ検証済み）。
- **G11** `charging overlays preserve all navigation cells, walls and obstacles across JSON roundtrip`（#198）: 充電スペースの範囲外の座標・幅の超過・NaN・ID の重複の拒否が未検証（`model.ts` に実装）。
- **G12** `robot role accepts all three types, preserves old missing values and rejects unknown roles`（#199）: `robotRole` の 3 種（cleaning／security／delivery）の受理と保存往復、未知の値の拒否が未検証（`model.ts` に実装）。
- **G13** `room activity follows physical robot occupancy and excludes charging and muted robots`（#19）: ミュートしたロボットを部屋の作業表示（`roomActivities`）から除外することが未検証。
- **G14** `transit and turning robots never become room activities while crossing the entrance`（#20）: 旋回中のロボットを部屋の作業表示に含めないことが未検証。

## 回帰確認（2026-11-10）

`web-controller` で `npx tsx --test --test-reporter=tap <file>` を実行した結果。

| ファイル | pass | fail |
|---|---:|---:|
| scripts/scene/doors.test.ts | 19 | 0 |
| scripts/scene/equipment.test.ts | 16 | 0 |
| scripts/scene/floorPlan.test.ts | 16 | 0 |
| scripts/scene/grid.test.ts | 7 | 0 |
| scripts/scene/model.test.ts | 15 | 0 |
| scripts/scene/navigation.test.ts | 12 | 0 |
| scripts/scene/presentation.test.ts | 5 | 0 |
| scripts/scene/safety.test.ts | 13 | 0 |
| scripts/scene/timedPlan.test.ts | 22 | 0 |
| scripts/scene/timelineEdit.test.ts | 9 | 0 |
| scripts/scene/units.test.ts | 5 | 0 |
| scripts/fleet-migration.test.ts | 6 | 0 |
| scripts/localizer-hub.test.ts | 10 | 0 |
| scripts/localization.test.ts | 218 | 0 |
| scripts/appearance-contrast.test.mjs | 10 | 0 |

`npx tsc --noEmit --incremental false -p tsconfig.json`: 終了コード 0。
