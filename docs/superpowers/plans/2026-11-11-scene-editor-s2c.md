# シーンエディター S2c（時間軸と動作の編集）実装計画

> **エージェント向け:** 必須の下位スキル: superpowers:subagent-driven-development（推奨）または superpowers:executing-plans。各ステップはチェックボックス（`- [ ]`）で進捗を管理する。

**Goal:** 時間軸（行・バー・ルーラー・プレイヘッド）、動作の編集（ロボット行の一括設定画面と、人・部屋・画面表示の動作ダイアログ）、マップ上の座標ピッカー、インスペクター、再生（全画面プレビュー含む）を、固定時間軸のみで `/scenes` に移植する。S2a のプレースホルダー（「設定」「時間軸」カードと暫定の時刻スライダー）を置き換える。

**Architecture:** 編集操作は S2b と同じく、DOM に依存しない純粋関数（`SceneMap` を受け取り新しい `SceneMap` を返す。失敗は日本語の `Error`）として `scene/` に作る。画面は S2a の `scene.commit(edit, label)` に 1 操作 = 1 回の `commit` で書き込み、元に戻すはページ全体の `scene.undo`（S2a）を使う。バーのドラッグ中は画面の一時状態だけを動かし、離したときに 1 回だけ `commit` する。ロボット行の一括設定と座標ピッカーは作業コピー（draft）に対して操作し、「適用」で 1 回の `commit` にまとめる。

**Tech Stack:** Next.js 14、React 18、TypeScript、CSS Modules（`.fleet` スコープ）、lucide-react、`tsx --test`、`@playwright/test`（導入済み）。

**Spec:** [設計書](../specs/2026-11-09-scene-editor-port-design.md)（D17）。前段: [S2a](2026-11-11-scene-editor-s2a.md)、[S2b](2026-11-11-scene-editor-s2b.md)。

**上流:** `C:\Users\1600028\Desktop\Developments\minirobo-editor-ref`（`e937be4`）。主な参照: `public/app.js`（時間軸 344〜560 行、一括設定 602〜714 行、動作フォーム 787〜910 行、座標ピッカー 1206〜1330 行、インスペクター 1330〜1470 行、再生 2004〜2032 行）、`browser-tests/studio.spec.js`、`browser-tests/sequence-editor.spec.js`。

## 所有者の決定（2026-11-11）

- **実行方式は固定時間軸のみ。** 順序実行（ordered）と旧トリガー方式は作らない。実機の完了待ちは設計書の進行時計（D1、S5）で実現する。
- **ロボット行の編集は上流どおり「シーケンスを一括設定」画面**（作業コピー → 「適用」で一括保存、↑↓で順序入れ替え、動作の追加・削除）。人・部屋・画面表示の行は、1 件ずつの動作ダイアログ。
- **マップ上の座標ピッカーを S2c に含める**（移動先・初期位置を、マップのクリックと向きの指定で決める）。
- **トラックとバーの上流の操作をすべて移植する**（追加・並べ替え・複製・削除・除外・固定・バーの移動とリサイズ・複数選択・Shift スナップ・キーボード操作・ダブルクリック追加・パレットからのドラッグ&ドロップ追加）。
- **再生は、再生・一時停止・先頭へ・ループ・速度・シークに加えて、全画面プレビューも作る。**
- 完了後は、S2a・S2b・S2c を 1 本の PR にして main へマージする（所有者の指示）。

## 私の判断（計画書の確認時に覆せる）

- **元に戻すはページ全体の `scene.undo`（上限 40）を使う。** S2b のマップ編集ダイアログの 100 段階は作業コピー専用で、時間軸の編集は即時反映のため別系統にしない。ロボット行の一括設定と座標ピッカーは作業コピーなので、適用までは履歴に入らない。
- **到着判定（`angleTolerance`・`angularSpeed` 等の上流の到着フィールド）は持たない。** 設計書 D13 の到着判定（位置 20mm・向き 5°）は S5 の進行時計で扱う。S2c の動作フォームは、現行の `Action` 型にあるフィールドだけを編集する。
- **パレットのドラッグ&ドロップは、マウスとペンのみ**（HTML5 ドラッグ&ドロップはタッチで動かないため）。タッチでは、同じ操作を「＋ 移動」などのボタンとダブルクリック（ダブルタップ）で行える。
- **バーのドラッグ・リサイズは Pointer Events**（マウス・タッチ・ペン共通）で作る。スナップは 0.1 秒刻み（既定）／0.5 秒刻み（切替）、Shift で他のバーの端に吸着（`timelineAlignment`）。
- **座標ピッカーは 20mm マス（グリッド）と自由座標の 2 種類。** グリッドは編集グリッド（20〜100mm）の区画中心。自由座標はカーソル追従→クリックで仮固定→再クリックで再指定（上流どおり）。
- **時間軸の時間幅（horizon）は上流どおり**: `max(30, 最後のバーの終了 + 4, 再生時間 + 8)` 秒、上限 7200 秒。ズームは 1 秒あたり 10〜120px、既定 26px。
- **全画面プレビューは編集の確認用。** 展示（50 インチ表面への表示、設計書 D20）は S4 で作り、ここでは作らない。
- **旧互換の項目（`plannedDuration`・`timeoutSeconds`・`simulationOutcome` の編集 UI）は作らない。** 現行の `Action` 型に存在しないため。

## Global Constraints

- 座標は mm・左下原点・Y 上。時間は秒（小数 1 桁表示）。バー位置は `Action.position`、長さは `Action.runSeconds`。
- トラック上限 128、同じ行のバーは重ならない（`checkSequence`）。固定（`locked`）の行は編集・移動・削除・並べ替えができない。除外（`muted`）の行はプレビューに出ない。
- トラック種別ごとに追加できる動作: ロボット・人 = 移動／表示／表示を消去／待機、部屋 = イベント発生／イベント終了／ドア解錠／待機、画面表示 = 表示／表示を消去／待機。
- 動作の編集関数は入力を変更せず、失敗時は理由を日本語の `Error` で投げる。成功時だけ新しい `SceneMap` を返す。
- 画面は `<dialog>` + `showModal()`。`window.alert/confirm/prompt` を使わない。取消（Esc・キャンセル）は draft を捨てる。未適用の変更があるときの取消は確認ダイアログを出す。
- 見た目はフリート画面（ガラス調・ライト／ダーク）。全画面ダイアログの背景は `--surface-strong`（約 93% 不透明）では透けるため、S2b の `--me-solid`（テーマ別の不透明色）と同じ方式にする。
- 対象画面は幅 768px 以上。マウスとタッチの両方で操作できること。操作部品 44px 以上、`focus-visible` を維持。文字 12px 以上。
- ダイアログ内の Ctrl+Z / Ctrl+Y は、ページ側（`ProjectBar` の window リスナー）へ伝えない（S2b と同じ）。
- web-controller は CJS（tsx）。テストにトップレベル await・`import.meta` を使わない。
- 日本語を含むファイルを PowerShell 5.1 の `Get-Content -Raw`→`Set-Content` で書き換えない。`.ps1` は ASCII のみ。日本語を含む既存ファイルへの `create_file` は失敗するので、編集ツールを使う。
- 既存テスト（`test:scene`・`test:fleet`・`test:localization`・`test:appearance`・`test:browser`）と `tsc --noEmit` を壊さない。

## Review Focus

1. バーのドラッグ・リサイズ中に `commit` が連続して走り、履歴が大量に積まれること（離したとき 1 回だけ）。`pointercancel`・ポインター喪失・Esc でドラッグが途中で残ること。
2. 固定（`locked`）の行が、移動・リサイズ・削除・並べ替え・複数選択の一括調整・キーボード操作のどれかで変更できてしまうこと。
3. 複数選択の一括移動で、一部のバーだけ重なり検査に失敗したとき、一部だけが動いて整合しなくなること（全部成功か全部失敗）。
4. トラックの削除・動作の削除で、他の動作が参照する `targetId`（表示を消去・イベント終了）、`doorId`（解錠）、部屋トラックの `roomId` が宙に浮くこと。
5. 初期位置のないロボット・人の行に、最初の動作（移動）を置く前に初期位置を決めさせる流れが抜けること。初期位置が通れない場所・他の行と重なる場所にならないこと。
6. 座標ピッカーで、通れない点（壁・家具・狭いドア）を「適用」できてしまうこと。自由座標の仮固定中にスクロール・ズーム・Esc で状態が壊れること。
7. ロボット行の一括設定で、「適用」前の作業コピーが元のマップに漏れること。適用時に `geometryProblem`（通行不可）を見落とすこと。
8. 再生が、ループ・速度変更・シーク・動作編集の直後に、時刻が範囲外になる、または止まらないこと。
9. 全画面プレビューを閉じたあとに、時刻・再生状態が食い違うこと。

---

## ファイル構成

```text
web-controller/
  scene/timelineView.ts         時間軸の表示計算（horizon・ルーラー・量子化・バー位置・時刻表記）（新規・純粋）
  scene/playback.ts             再生の状態遷移（再生・一時停止・ループ・速度・シーク）（新規・純粋）
  scene/trackEdit.ts            トラックと動作の編集操作（追加・並べ替え・複製・削除・除外・固定・属性）（新規・純粋）
  scene/actionEdit.ts           動作フォームの下ごしらえ（種別の制約・新規 draft・解錠対象・検証）（新規・純粋）
  scene/coordinatePick.ts       座標ピッカーの点の決定と検査（新規・純粋）
  scene/timelineEdit.ts         （既存）バーの移動・リサイズ・順序入れ替え・スナップ
  scripts/scene/{timelineView,playback,trackEdit,actionEdit,coordinatePick}.test.ts（新規）
  hooks/usePlayback.ts          再生の requestAnimationFrame ループ（新規）
  app/(console)/scenes/
    page.tsx                    プレースホルダーを置き換える（変更）
    TimelineCard.tsx            時間軸（ルーラー・行見出し・レーン・プレイヘッド・操作バー）（新規）
    TimelineBar.tsx             バー 1 本（移動・リサイズ・キーボード）（新規）
    TrackPalette.tsx            行と動作のパレット（ボタン・ドラッグ元）（新規）
    PlaybackBar.tsx             再生・先頭・ループ・速度・シーク・全画面（新規）
    PreviewDialog.tsx           全画面プレビュー（新規）
    Inspector.tsx               「設定」カード（行・動作・初期位置・一括調整）（新規）
    ActionDialog.tsx            動作 1 件の編集ダイアログ（人・部屋・画面表示）（新規）
    SequenceDialog.tsx          ロボット行のシーケンス一括設定（新規）
    CoordinatePicker.tsx        マップ上の座標・向きの指定ダイアログ（新規）
    timeline.module.css / editors.module.css（新規）
  browser-tests/scenes-timeline.spec.ts, scenes-actions.spec.ts（新規）
```

---

### Task 1: 時間軸の表示計算と再生の状態遷移（並列 A）

**Files:**
- Create: `web-controller/scene/timelineView.ts`、`web-controller/scene/playback.ts`、各テスト

**Interfaces:**
- Consumes: `types.ts`、`timedPlan.ts`（`ScenePlan.duration`）。
- Produces（純粋）:
  - `timelineView.ts`: `MIN_HORIZON_S = 30`、`MAX_HORIZON_S = 7200`、`PX_MIN = 10`、`PX_MAX = 120`、`PX_DEFAULT = 26`、`LANE_PAD_PX = 16`、`timelineHorizon(map, planDuration): number`、`rulerTicks(horizon, px): { time: number; left: number; label: string }[]`（`px < 30` で 5 秒刻み、それ以外 2 秒刻み）、`quantize(seconds, fine: boolean): number`（fine は 0.1、粗いと 0.5。負は 0）、`barBox(action, px): { left: number; width: number }`（`left = position * px + 16`、幅は `runSeconds * px`、最小幅あり）、`timeToPx(t, px)`、`pxToTime(x, px)`、`fitPx(viewportPx, horizon): number`（`PX_MIN..PX_MAX` に収める）、`formatTime(seconds): string`（`m:ss.s` 形式。丸めで 60 秒になったら繰り上げる＝上流の「時刻表示の書式」）。
  - `playback.ts`: `PlaybackState = { time: number; running: boolean; looping: boolean; speed: number }`、`SPEEDS = [0.5, 1, 2, 4]`、`initialPlayback()`、`step(state, deltaMs, duration): PlaybackState`（`running` のとき `time += deltaMs/1000 * speed`。終端で、ループなら 0 へ戻り、ループでなければ `time = duration` で `running = false`。`duration = 0` のときは動かず停止）、`seek(state, t, duration)`（0〜duration にクランプ）、`toggle(state, duration)`（終端で押すと先頭から再生）、`home(state)`、`setSpeed(state, s)`（`SPEEDS` 以外は拒否）、`toggleLoop(state)`、`clampTo(state, duration)`（再生時間が縮んだとき時刻を収める）。
- **ステップ 1: 失敗するテストを書く**
  - `timelineHorizon`: バーなしで 30、最後のバー終了 + 4 が 30 を超えると反映、再生時間 + 8（ただし 3600 で頭打ち）、上限 7200。
  - `rulerTicks`: 幅 26px で 2 秒刻み、20px で 5 秒刻み、境界 `px = 30`。先頭は 0 秒。
  - `quantize`: 0.1 秒刻みの丸め（0.04→0、0.05→0.1、浮動小数点の誤差で 0.30000000000000004 にならない）、0.5 秒刻み、負は 0。
  - `barBox` と `pxToTime` の往復、`fitPx` のクランプ（`PX_MIN`・`PX_MAX`）。
  - `formatTime`: 59.96 → `1:00.0`（繰り上げ）、0 → `0:00.0`、125.04 → `2:05.0`、負・NaN の扱い。
  - `step`: 速度 0.5/1/2/4 での進み方、終端のループ・停止、`duration = 0`、巨大な `deltaMs`（タブが裏に回った後）でも `time` が範囲内、入力を変更しない。
  - `toggle`: 終端で再生すると先頭から、途中で押すと一時停止。`seek` のクランプ。`clampTo` で時刻が収まる。
- **ステップ 2〜4:** FAIL → 実装 → PASS・型チェック・実装を壊す変異テスト（量子化の丸め・終端の判定・ループ）で失敗を確認。
- **ステップ 5:** コミット `feat(scene): add timeline layout and playback state helpers`

### Task 2: トラックと動作の編集操作（並列 B）

**Files:**
- Create: `web-controller/scene/trackEdit.ts`、`web-controller/scripts/scene/trackEdit.test.ts`

**Interfaces:**
- Consumes: `model.ts`（`newTrack`・`newAction`・`COLORS`）、`safety.ts`（`createSafety`・`pathProblem`）、`ids.ts`、`timelineEdit.ts`（`checkSequence`・`adjustTimeline`・`reorderSequence`）、`mapEditRegions.ts`（`MAX_ROOMS` は参照のみ）。
- Produces（純粋。入力を変更しない。失敗は `Error`）:
  - `MAX_TRACKS = 128`
  - `addTrack(map, kind: TrackKind, opts: { roomId?: string; index?: number }, makeId?): { map: SceneMap; trackId: string }`（上限 128。部屋の行は領域が 0 のとき「先にマップ編集で部屋・廊下を作成してください。」。ロボット・人は初期位置を、通行でき、既存の行の初期位置と車体・人の半径＋余裕 5mm 以上離れた最初の空きマスの中心へ置く。空きがなければ「初期位置を配置できる空きがありません。先にマップ編集で部屋・廊下を広げてください。」）
  - `moveTrack(map, trackId, toIndex)`、`moveTrackBy(map, trackId, ±1)`（固定の行・移動先が固定の行は不可。端は「これ以上移動できません。」）
  - `setTrackFlag(map, trackId, "muted" | "locked", value)`（これは固定中でも切り替えられる）
  - `updateTrack(map, trackId, patch: Partial<Pick<Track, "name" | "color" | "count" | "robotRole" | "robotId" | "roomId">>)`（固定の行は不可。`count` は 1〜1000 の整数、`robotId` は 0〜9999 の整数かつ他の行と重複不可、色は `#RRGGBB`、名前は 1〜120 文字）
  - `setInitialPose(map, trackId, pose: Pose)`（固定の行は不可。通行できない点は `pathProblem` の理由で拒否）
  - `deleteTrack(map, trackId)`（固定は不可。この行の動作が `targetId` で結ばれた他の行の動作がある場合は、参照が宙に浮かないよう「表示を消去」「イベント終了」側を一緒に消すか拒否するかを**テストで決めた方で固定**する。上流は単に行を消す＝参照切れを許していたため、`validateProject` が通るかを確認し、通らない場合は拒否理由を返す）
  - `deleteActions(map, actionIds: string[])`（固定の行の動作を含むと全体を拒否。見つからない ID は拒否）
  - `duplicateAction(map, actionId, makeId?): { map; actionId }`（開始を +6 秒、名前に ` copy`（最大 120 文字）、`show`・`event-start` は新しい `targetId`、固定は不可）
  - `addActionToTrack(map, trackId, type, overrides?, makeId?): { map; actionId }`（種別が行に許されていなければ拒否。位置は直前の動作の終了。重なりは `checkSequence`）
  - `replaceAction(map, trackId, action): SceneMap`（編集後の動作で置き換え。`checkSequence`・`validateProject` 相当の検査。固定は不可）
  - `replaceTrack(map, track): SceneMap`（一括設定の「適用」用。固定は不可、`checkSequence`）
  - `trackKindLabel`・`actionTypeLabel`（画面用の日本語表記: 移動／表示／表示を消去／イベント発生／イベント終了／ドア解錠／待機、ロボット／人／部屋／画面表示）
- **ステップ 1: 失敗するテストを書く**（上流 `studio.spec.js` のトラック・アクション編集と、`sequence-editor.spec.js` の関連、`test/model.test.js` を換算）
  - 追加: 種別ごとの既定名・色、128 本目と 129 本目、部屋の行（領域なしは拒否）、初期位置が壁・家具・他の行と重ならない、空きなし、`index` の挿入位置。
  - 並べ替え: 先頭・末尾の端、固定の行（動かす側・動かされる側）、1 つずつの入れ替えと `moveTrack` の結果が一致。
  - 固定・除外: 固定中でも `setTrackFlag` は切り替え可。固定の行への `updateTrack`・`deleteTrack`・`deleteActions`・`duplicateAction`・`replaceAction` は全て拒否され、マップは不変。
  - 属性の検証: `count`（0・1001・小数）、`robotId` の重複、色の形式、名前の長さ。
  - 動作の削除・複製: 複数選択の削除、固定を含む場合は全体を拒否（部分削除にならない）、複製の `targetId`、`position + 6`。
  - 行の削除と参照: 表示を消去が参照する `targetId`・解錠の `doorId`・部屋の行の `roomId` の扱い（上記）。
  - 入力 map の不変性（`structuredClone` と比較）。
- **ステップ 2〜4:** FAIL → 上流 `app.js`（1403〜1470 行）と `model.js` を参照して実装 → PASS・型チェック・変異テスト（固定の検査・128 本の上限・全体拒否）。
- **ステップ 5:** コミット `feat(scene): add track and action editing operations`

### Task 3: 動作フォームの下ごしらえ（並列 C）

**Files:**
- Create: `web-controller/scene/actionEdit.ts`、`web-controller/scripts/scene/actionEdit.test.ts`

**Interfaces:**
- Consumes: `model.ts`（`newAction`・`DISPLAY_TEMPLATES`・`HATCH_STYLES`）、`timedPlan.ts`（`actionPreview`）、`types.ts`。
- Produces（純粋）:
  - `availableTypes(track): ActionType[]`（ロボット・人 = move/show/hide/wait、部屋 = event-start/event-end/unlock/wait、画面表示 = show/hide/wait）
  - `openActionDraft(map, trackId, actionId | null, type?, overrides?, makeId?): { action: Action; needsInitialPose: boolean }`（新規は `newAction`、位置は直前の動作の終了（`overrides.position` を優先）。ロボット・人で、最初の動作より前に置くとき `needsInitialPose = true`＝上流の「初期位置をどこにしますか？」。回転（`motion: "rotate"`）の既定 `rotationSeconds`・`runSeconds` は `shortestTurn` と角速度 90°/秒から求める）
  - `setMotion(action, "linear" | "rotate"): Action`（回転は `runSeconds` = 回転秒数、`yaw` は −180〜180。直線に戻すと `rotationSeconds` を消す）
  - `actionFields(action, trackKind): FieldSpec[]`（画面が描く入力欄の定義。`label`・`kind`（text/number/select/color/textarea）・`min`・`max`・`step`・`options`。種別ごと: 共通=名前（120 文字）、移動=実行秒数（0.1〜86400）、待機=秒数（0.1〜86400）、表示=テンプレート・表示する言葉（500 文字）、イベント発生=イベント（会議中／停電／火災）・色・模様・言葉、表示を消去／イベント終了=終了する項目、ドア解錠=解錠対象・秒数、回転=角度・秒数）
  - `endTargets(map, type): { value: string; label: string; roomId?: string }[]`（表示を消去の対象＝`show` の `targetId` 一覧、イベント終了の対象＝`event-start`）
  - `unlockTargets(map): { value: string; label: string }[]`（部屋と、名前のある設備（`door:<id>`））、`applyUnlockTarget(action, value, map): Action`（設備なら `doorId`・`roomId`・名前を設定、部屋なら `doorId` を消す。存在しない設備は拒否）
  - `validateAction(map, trackId, action): { ok: true } | { ok: false; error: string }`（`checkSequence` 相当の重なり、各項目の範囲、移動は `actionPreview` の `geometryProblem`、終了系は対象が必須、解錠は対象が必須）
- **ステップ 1: 失敗するテストを書く**
  - `availableTypes` の 4 種別。許されない種別は `openActionDraft` が拒否。
  - `openActionDraft`: 位置の既定、`overrides.position` の優先、`needsInitialPose` の条件（初期位置のない種別では常に false、最初の動作より前でだけ true）、固定の行の拒否、存在しない行・動作の拒否、入力の不変性。
  - 回転: 角度と秒数の既定（180° は 2 秒）、`setMotion` の往復、`yaw` の範囲。
  - `actionFields`: 種別ごとの項目の有無と制約の値（秒数の下限は待機・移動・解錠が 0.1、表示などは 0）。
  - `endTargets`・`unlockTargets`・`applyUnlockTarget`: 部屋と設備の組み立て、設備選択で名前が `<設備名>解錠` になる、存在しない設備の拒否、部屋に戻すと `doorId` が消える。
  - `validateAction`: 重なり、範囲外の秒数、通れない移動先（壁の中）が `geometryProblem` の理由で返る、終了系で対象が空。
- **ステップ 2〜4:** FAIL → 上流 `app.js`（787〜910 行、584〜600 行）を参照して実装 → PASS・型チェック・変異テスト（`needsInitialPose` の条件・範囲検査・設備の扱い）。
- **ステップ 5:** コミット `feat(scene): add action form helpers`

### Task 4: 座標ピッカーの点の決定と検査（並列 D）

**Files:**
- Create: `web-controller/scene/coordinatePick.ts`、`web-controller/scripts/scene/coordinatePick.test.ts`

**Interfaces:**
- Consumes: `grid.ts`（`snapToEditGrid`・`cellAt`）、`floorPlan.ts`（`roomContainsPoint`・`roomAnchor`）、`safety.ts`（`createSafety`・`pathProblem`）、`units.ts`、`mapView.ts`（`clampToArea`）。
- Produces（純粋）:
  - `type PickMode = "grid" | "free"`
  - `pickPoint(map, mm: {x,y}, mode): { x: number; y: number; roomId: string }`（グリッドは `editGridMm` の区画の中心へ吸着、自由は mm のまま `clampToArea`。`roomId` は点を含む領域、無ければ `""`）
  - `constrainAxis(origin, point): {x,y}`（Shift: 水平／垂直のうち移動量の大きい軸だけ動かす）
  - `pickProblem(map, kind: TrackKind, point, yaw?): string`（`createSafety`／`pathProblem` の理由。初期位置では向きが −180〜180 でなければ「初期の向きは -180〜180° で指定してください。」。通れれば空文字）
  - `pickRoom(map, mm): { roomId: string; anchor: {x,y} } | null`（部屋イベントの対象指定用。領域の内側でなければ null）
  - `normalizeYaw180(deg)`（−180〜180 へ。NaN は拒否）
- **ステップ 1: 失敗するテストを書く**（上流 `app.js` 972〜1006・1206〜1330 行と、`safety.test.ts` の通行判定を参照）
  - `pickPoint`: 20mm グリッドの中心、40・80mm グリッド（原点基準の区画、右上の半端は範囲内に収める）、自由座標、地図の外（クランプ）、領域の外は `roomId = ""`。
  - `constrainAxis`: 水平／垂直、同じ移動量のときの規則（固定してテストする）、原点と同じ点。
  - `pickProblem`: 壁の中・家具の中・狭いドア（有効 112mm は不可、132mm は可）・領域の外・他の行と重なる点、向きの範囲、人とロボットで半径が違うこと。
  - `pickRoom`: 領域の内側と外側、共有する辺、空の領域。
  - 入力 map の不変性、`NaN`・`Infinity` の拒否。
- **ステップ 2〜4:** FAIL → 実装 → PASS・型チェック・変異テスト（吸着の丸め・クランプ・通行判定の呼び出し）。
- **ステップ 5:** コミット `feat(scene): add coordinate picking helpers`

### Task 5: 再生フックと画面の骨組み

**Files:**
- Create: `web-controller/hooks/usePlayback.ts`、`app/(console)/scenes/PlaybackBar.tsx`
- Modify: `app/(console)/scenes/page.tsx`（暫定の時刻スライダーを `PlaybackBar` に置き換え、`time` と再生状態を持つ）

**Interfaces:**
- Consumes: Task 1 の `playback.ts`。
- Produces: `usePlayback(duration): { state: PlaybackState; actions: { toggle; home; seek; setSpeed; toggleLoop } }`（`requestAnimationFrame` で `step` を呼ぶ。タブが非表示のあいだは進めない。アンマウントで停止。`duration` が縮んだら `clampTo`）、`<PlaybackBar playback duration onFullscreen />`（再生／一時停止・先頭へ・ループ・速度・シーク・時刻表示 `m:ss.s / m:ss.s`・全画面ボタン）。
- **ステップ 1:** `usePlayback` と `PlaybackBar`（ボタンは `aria-pressed`、44px 以上）。時刻の範囲外・速度変更・ループの境界で止まらないこと。
- **ステップ 2:** 型チェック、`test:scene`、実ブラウザーで再生・停止・シーク・ループを確認（幅 768 / 1280、ライト／ダーク）。確認できなかった点は報告に明記する。
- **ステップ 3:** コミット `feat(scenes): add playback controls`

### Task 6: 時間軸（行・バー・パレット）

**Files:**
- Create: `TimelineCard.tsx`、`TimelineBar.tsx`、`TrackPalette.tsx`、`timeline.module.css`
- Modify: `page.tsx`（「時間軸」カードを置き換える）

**Interfaces:**
- Consumes: Task 1〜3、`timelineEdit.ts`（`adjustTimeline`・`reorderSequence`・`timelineAlignment`）、`scene.commit`、`compilePlan`（`actionStates`・警告）。
- Produces: `<TimelineCard map selection onSelect playback commit />`、選択状態の型 `{ trackId?: string; actionId?: string; blocks: ReadonlySet<string> }`。
- 振る舞い（上流 344〜560 行）:
  - ルーラー（秒）・行見出し（種別アイコン・名前・人数／種別・除外／固定のトグル）・レーン・バー（名前・種別と開始〜終了・長さ）・プレイヘッド（クリック／ドラッグでシーク）。実際の開始が予定より遅いバーには「実 N.Ns」の帯を出す。通行不可のバーは状態で見分けられる（色だけに頼らず文字も出す）。
  - バー: Pointer Events で移動（開始時刻）とリサイズ（右端の取っ手）。ドラッグ中は一時状態だけを動かし、離したとき 1 回だけ `commit`。Esc・`pointercancel`・ポインター喪失で破棄。Ctrl/⌘ で追加選択、Shift で行内範囲選択、選択後のドラッグで一括移動（全部成功か全部失敗）。Shift を押しながらのドラッグで他のバーの端に吸着（ガイドと吸着先の名前を表示）。スナップは 0.1／0.5 秒の切替。
  - キーボード: バーにフォーカスして Enter で編集、取っ手に ←→ で 0.5 秒単位の長さ調整（固定の行は不可）、Delete で削除確認。
  - 行: 見出しのドラッグと「↑ 上へ／↓ 下へ」で並べ替え（固定の行は不可）。行を追加するパレット（ロボット・人・部屋・画面表示のボタン）。レーンのダブルクリック（ダブルタップ）でその時刻に動作を追加。パレットの動作（＋ 移動 など）からレーンへのドラッグ&ドロップ追加（ドロップ位置のプレビューを出す。置けない場所は理由を出す。マウス・ペンのみ）。
  - ズーム（10〜120px/秒）・全体表示・スナップ切替・「N TRACKS」表示。
  - 固定中の行のバーを操作しようとしたら理由を `role="alert"` で出す。
- **ステップ 1:** 行・ルーラー・バー・プレイヘッドの表示（編集なし）。
- **ステップ 2:** バーの移動・リサイズ・選択・スナップ・キーボード。
- **ステップ 3:** 行の追加・並べ替え・除外・固定・パレットとダブルクリック追加。
- **ステップ 4:** 型チェック、`test:scene`、実ブラウザーで手動確認（幅 768 / 1024 / 1280、ライト／ダーク、マウスとタッチ）。確認できなかった点は報告に明記する。
- **ステップ 5:** コミット `feat(scenes): add the timeline`（ステップごとに分けてよい）

### Task 7: 動作ダイアログとロボット行の一括設定

**Files:**
- Create: `ActionDialog.tsx`、`SequenceDialog.tsx`、`editors.module.css`

**Interfaces:**
- Consumes: Task 2・3・4、`MapStage`（`overlay`）、S2b の入力部品（`MapEditorFields.tsx` の `TextCommit`・`SelectField`・`ColorField`・`ToggleButton`）。
- Produces: `<ActionDialog map trackId actionId type? overrides? open onApply onClose />`（人・部屋・画面表示の行用）、`<SequenceDialog map trackId actionId? type? overrides? open onApply onClose />`（ロボット行用。作業コピーを編集し、「適用」で `replaceTrack` を 1 回の `commit` にまとめる）。
- 振る舞い（上流 602〜714・787〜910 行）:
  - 動作ダイアログ: 種別に応じた入力欄（`actionFields`）。移動はマップ上に出発点・目標点・経路と、通れない場合の `geometryProblem` を表示（`actionPreview`）。「適用」は `validateAction` が `ok` のときだけ。取消は破棄。
  - 一括設定: 名称・ロボット種別（清掃／警備／配送）・ロボット ID・（人なら人数）・初期位置（「初期位置をマップで配置」）・動作の一覧（↑↓・削除・追加・選択）・選択中の動作のフォーム（移動／回転の切替含む）。適用時に全移動で `geometryProblem` を確認し、回転は `rotationSeconds = runSeconds`、直線は `yaw` を出発姿勢に合わせる（上流どおり）。
  - 最初の動作を、最初の既存動作より前に置くとき、先に「初期位置をどこにしますか？」で座標ピッカーを開く。
  - 未適用の変更があるときの Esc・キャンセルは確認ダイアログ。ダイアログ内の Ctrl+Z をページへ伝えない。
- **ステップ 1:** 動作ダイアログ（人・部屋・画面表示）と、マップ上の経路プレビュー。
- **ステップ 2:** ロボット行の一括設定。
- **ステップ 3:** 型チェック、`test:scene`、実ブラウザーで手動確認（幅 768 / 1280、ライト／ダーク）。
- **ステップ 4:** コミット `feat(scenes): add action editors`

### Task 8: 座標ピッカー

**Files:**
- Create: `CoordinatePicker.tsx`

**Interfaces:**
- Consumes: Task 4、`MapStage`（`overlay`）。
- Produces: `<CoordinatePicker map value kind track? mode="move" | "initial" | "room" open title help onSelect onClose />`。
- 振る舞い（上流 972〜1006・1206〜1330 行）:
  - マップをクリックして位置を決める。グリッド（区画の中心）と自由座標（カーソル追従 → クリックで仮固定 → マーカーを再クリックで再指定、Shift で水平／垂直）。初期位置では向きの数値入力（−180〜180°）と、車体の向きのプレビュー。部屋イベントでは領域の内側をクリックして対象を選ぶ。
  - 通れない点は `pickProblem` の理由を表示し、「適用」を無効にして、マーカーを赤く見せる（色だけに頼らず文字も出す）。
  - Pointer Events（マウス・タッチ）。「適用」で `onSelect`、取消で破棄。元の画面で「適用」するまで保存されない旨を出す。
- **ステップ 1:** ダイアログとクリックでの指定（グリッド）。
- **ステップ 2:** 自由座標・Shift・初期位置の向き・部屋イベント。
- **ステップ 3:** 型チェック、実ブラウザーで手動確認（幅 768 / 1280、マウスとタッチ）。
- **ステップ 4:** コミット `feat(scenes): add the coordinate picker`

### Task 9: インスペクター（設定カード）

**Files:**
- Create: `Inspector.tsx`
- Modify: `page.tsx`（「設定」カードを置き換える）

**Interfaces:**
- Consumes: Task 2・3、Task 6 の選択状態、Task 7・8 のダイアログ。
- 振る舞い（上流 1330〜1470 行）:
  - 何も選んでいないとき: 使い方の案内（固定時間軸の説明）。
  - 領域を選んだとき（地図のクリック）: 領域名・色・種類・床材、「部屋の形・床材・家具を編集」（S2b のダイアログを開く）、部屋の行の追加。領域の削除は S2b のダイアログにあるため、ここには置かない。
  - 行を選んだとき: 名前・色、人数（人）、ロボット種別・ID（ロボット）、対象の部屋（部屋の行）、初期位置の設定、動作の追加（種別ボタン）、↑↓、行の削除（確認付き）。
  - 動作を選んだとき: 名前・種別・状態（待機／実行／不可の理由）、「アクションを編集」または「シーケンスを一括設定」、初期位置の設定、複製、削除（確認付き）、行の設定。
  - 複数選択があるとき: 件数・秒数の入力・「開始をずらす」「長さを調整」「選択を解除」（`adjustTimeline`）。
  - 固定中の行は、すべての変更ボタンを無効にして理由を出す。
- **ステップ 1:** 行・動作・複数選択のパネル。
- **ステップ 2:** 領域のパネルと、地図のクリックでの選択（`MapStage.onPick` の再利用）。
- **ステップ 3:** 型チェック、実ブラウザーで手動確認。
- **ステップ 4:** コミット `feat(scenes): add the inspector`

### Task 10: 全画面プレビュー

**Files:**
- Create: `PreviewDialog.tsx`

**Interfaces:**
- Consumes: Task 5 の再生、`MapStage`。
- 振る舞い: 全画面の `<dialog>` に、マップ（等倍で最大）と再生操作（再生／一時停止・先頭・ループ・速度・シーク）を出す。時刻と再生状態は、閉じたあとも元の画面と同じものを使う（食い違わない）。Esc・「閉じる」で閉じる。背景は `--me-solid` 方式の不透明色。
- **ステップ 1〜2:** ダイアログと再生の接続、実ブラウザーで確認（幅 768 / 1280、ライト／ダーク）。
- **ステップ 3:** コミット `feat(scenes): add the fullscreen preview`

### Task 11: Playwright（画面の自動テスト）

**Files:**
- Create: `web-controller/browser-tests/scenes-timeline.spec.ts`、`scenes-actions.spec.ts`
- Modify: `browser-tests/helpers.ts`（必要な共通関数のみ）

**Interfaces:** `playwright.config.ts` は変更しない。`openSeeded`（S2b）で既知のマップとトラックを投入する。

- **ステップ 1: テストを書く**（日本語は `\u` 表記か UTF-8 で書き、`create_file` の上書きは使わない）
  - 時間軸: 行・バーの表示、ルーラー、ズーム・全体表示、バーのドラッグ移動で `commit` が 1 回（履歴が +1）、リサイズ、Esc・`pointercancel` で変更なし、重なる移動の拒否、固定行のバーは動かず理由が出る、除外のトグル、複数選択（Ctrl）の一括移動、Shift 吸着の名前表示、キーボード（←→ で 0.5 秒）。
  - 行の操作: 追加（4 種別）、128 本で拒否、並べ替え（↑↓・見出しのドラッグ）、固定中は不可、削除は確認付きでページの Ctrl+Z で戻る。
  - 動作: ダブルクリックで追加、パレットのドラッグ&ドロップ追加（置けない場所の理由）、人・部屋・画面表示のダイアログで編集して適用、複製、削除。
  - ロボット行: 一括設定を開く、動作の追加・↑↓・削除、適用前は元のマップが変わらない、キャンセルで破棄、通れない移動先は適用できず理由が出る、適用 1 回で履歴が +1。
  - 座標ピッカー: グリッドで指定、自由座標の仮固定と再指定、通れない点で「適用」が無効、初期位置の向き。タッチ（`hasTouch: true`）で指定できる。
  - 再生: 再生・一時停止・先頭・ループ・速度・シーク、プレイヘッドのドラッグ、全画面プレビューを開閉して時刻が一致。
  - 幅 768 / 1280 で、時間軸・インスペクター・ダイアログがはみ出さない。両テーマで、バーの文字・行名・エラー文・時刻表示のコントラストが 4.5:1 以上（実ピクセル。`textAndBackground` を使う）。
- **ステップ 2:** `npm --prefix web-controller run test:browser` で全件 PASS（既存 37 件を含む）。
- **ステップ 3:** 変異テスト（画面側）: 固定行の検査を外す／ドラッグの `commit` を移動のたびに呼ぶ／`pointercancel` の破棄を外す／ダイアログ内のキー伝播を止める処理を外す、のそれぞれで該当テストが失敗することを確認して戻す。`--grep` に `+` を使わない（正規表現として扱われ、テストが実行されない）。
- **ステップ 4:** 全回帰（`test:scene`・`test:fleet`・`test:localization`・`test:appearance`・`tsc`）と、文字化けの走査（`U+FFFD` が 0 件）。
- **ステップ 5:** コミット `test(scenes): add browser tests for the timeline and action editors`

### Task 12: 対応表の更新、PR の作成とマージ

**Files:**
- Modify: `web-controller/scripts/scene/upstream-parity.md`

- **ステップ 1:** 対応表を更新する。「対象外: S2以降」のうち S2c で移植した項目（時刻表示の書式 #170 など）を「移植済み」にし、テスト名を書く。S3・S4・S5 に残す項目は理由を保つ。
- **ステップ 2:** 全回帰（`test:scene`・`test:fleet`・`test:localization`・`test:appearance`・`tsc`・`test:browser`）と、文字化けの走査。すべて成功を確認する。
- **ステップ 3:** main の最新を取り込み、競合がないことを確認する。
- **ステップ 4:** PR を作成する（S2a・S2b・S2c の内容、検証結果、実機への影響がないこと、未実装で残るもの＝S3 以降、確認できなかった点）。PR のテンプレートがあれば従う。
- **ステップ 5:** 所有者の指示どおり main へマージする。マージ方式は履歴を残す**マージコミット**とする（S2a・S2b・S2c の経緯がコミットで追えるように）。
- **ステップ 6:** マージ後に main で全回帰を再実行して確認する。取り込み済みのリモートブランチ・ローカルブランチの削除は、**所有者の確認を取ってから**行う。

---

## 並列実行（git worktree）

| 段階 | 担当 | 範囲 | 触るファイル |
|---|---|---|---|
| 1 | A | Task 1 | `scene/timelineView.ts`、`scene/playback.ts`、各テスト |
| 1 | B | Task 2 | `scene/trackEdit.ts`、そのテスト |
| 1 | C | Task 3 | `scene/actionEdit.ts`、そのテスト |
| 1 | D | Task 4 | `scene/coordinatePick.ts`、そのテスト |
| 2 | 私 | Task 5〜10（画面。実ブラウザーの確認が要るため順番に） | `app/(console)/scenes/*`、`hooks/usePlayback.ts` |
| 3 | 私 | Task 11 | `browser-tests/*` |
| 4 | 私 | Task 12 | `upstream-parity.md`、PR |

画面の Task は、Playwright のサーバーがポート 3117 固定のため、並列に検証できない。純粋関数の 4 件だけを並列にする。担当への依頼は、前回の教訓どおり「読むファイルを列挙」「触るファイルを 2 つに限定」「完了前に必ずコミット」「報告は検証してから採用（テスト・型・変異テストを私が再実行）」とする。worktree は `C:\Users\1600028\Desktop\Developments\wt\` に作り、`node_modules` の junction（リポジトリ直下と `web-controller` の 2 つ）を張る。終了後はリンクを先に外してから削除する。

## 実装者に任せること（私の判断として記録）

- 各ファイルの内部分割と CSS のクラス名。ただし公開する関数名・型は上記を変えない。
- ルーラーのラベルの細かな見た目、ガイドの色（マップ側は固定色、画面側はテーマ変数）。

## 後続

- S3（旧形式の取り込みと 16 本のシナリオ、演出の編集）は、本計画の完了後に作成する。
- S4（展示モード）、S5（進行時計と異常時の方針）、S6（8 台対応）は設計書の順に進める。
