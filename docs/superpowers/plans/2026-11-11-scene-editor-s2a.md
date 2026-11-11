# シーンエディター基盤（S2a）実装計画

> **エージェント向け:** 必須の下位スキル: superpowers:subagent-driven-development（推奨）または superpowers:executing-plans。各ステップはチェックボックス（`- [ ]`）で進捗を管理する。

**Goal:** `/scenes` ページに、Hub 側へ永続保存されるシーンプロジェクトの読込・保存・編集履歴・元に戻す／やり直す・タブ管理・マップ表示の土台を作る。

**Architecture:** 保存の正本は Hub。`fleet/sceneHistoryStore.ts` が連番の全状態スナップショットを `data/scene-history/` に追記し、`server.ts` が Next へ渡す前に `/api/scenes/*` を処理する。ブラウザー側は DOM 非依存の `scene/editorHistory.ts`（元に戻す／やり直す）と `scene/historyClient.ts`（送信キュー・競合検知）を React のフック `hooks/useSceneProject.tsx` で包み、ページは S1 の `scene/*` を使って SVG に描く。

**Tech Stack:** Next.js 14（App Router）、React 18、TypeScript、CSS Modules（`.fleet` スコープ）、lucide-react、`tsx --test`、`@playwright/test`（新規・開発用、インストール済み Edge を使用）。

**Spec:** [docs/superpowers/specs/2026-11-09-scene-editor-port-design.md](../specs/2026-11-09-scene-editor-port-design.md)（D17、6章、10章）。前段の計画: [2026-11-09-scene-core.md](2026-11-09-scene-core.md)。

**上流:** `C:\Users\1600028\Desktop\Developments\minirobo-editor-ref`（`e937be4`）。主な参照: `history-store.js`、`server.js`、`public/history-client.js`、`public/app.js`（`commit`・タブ・描画）、`browser-tests/history.spec.js`・`studio.spec.js`。

## 所有者の決定（2026-11-11）

- 見た目は**フリート画面に合わせる**（ガラス調、ライト／ダーク、5 配色、既存の文字・余白規則）。ただしマップ描画（床材・部屋・家具・扉・壁）は**テーマに依存しない固定色**とし、S4 の走行面表示と共通にする。
- 対象画面は**幅 768px 以上（タブレットまで）**。767px 以下では編集 UI を出さず「幅768px以上の画面で開いてください」と表示する。マウスとタッチの両方を Pointer Events で扱う。

## Global Constraints

- 保存の正本は Hub。ブラウザーの localStorage への自動保存は作らない（上流の `autosave.js` は移植しない）。
- 保存形式は `fleet-scene/v1` のみ受け付ける。サーバーは保存前に必ず `validateProject` を通す。
- 履歴は件数無制限・全状態保存・`10桁連番.json`・SHA-256 付き・一時ファイルへ書いて rename。破損・番号抜けを検出したら起動時に例外で止め、黙って読み飛ばさない。
- 元に戻す／やり直すはメモリー上で 40 操作まで。新しい編集でやり直し履歴を破棄する。
- 状態を変える HTTP（POST）は、`Content-Type: application/json` 必須、本文 10MiB 以下、`Origin` ヘッダーのホストが `Host` ヘッダーと一致する場合のみ受け付ける（別サイトからの書き込みを防ぐ）。不一致は 403、型違いは 415、超過は 413。
- 同時編集の競合: `expectedRevision` が最新と一致しない POST は 409。同じ `id` と同じ内容の再送は重複保存せず 200 で同じ記録を返す。同じ `id` で内容が違えば 409。
- ページは `app/(console)/scenes/` に置き、ナビに「シーン」（アイコン `Clapperboard`）を追加する。文言は日本語を直接書く。
- 文字サイズ 24/20/16/14/12px、カード角丸 8px、余白 20px、間隔 16/24px、操作部品の最小高さ 44px、`focus-visible` の輪郭は既存の `--focus`。
- `.fleet svg { width:18px; height:18px }` が全 SVG に効くため、マップ用 SVG は専用クラスで上書きする。
- web-controller は CJS（tsx）。テストにトップレベル await・`import.meta` を使わない。
- 既存テスト（`test:scene`・`test:fleet`・`test:localization`・`test:appearance`）と `tsc --noEmit` を壊さない。

## Review Focus

1. 2 つのブラウザーで同時に編集したとき、後から送った側が古い版を上書きすること（409 で止まり、再読込を案内すること）。
2. 送信中にページを閉じる・Hub が落ちる → 未送信の編集が「保存済み」と表示されたまま失われること（未送信件数を表示し続けること）。
3. 元に戻した後に新しい編集をすると、やり直しが残って古い状態へ戻れてしまうこと。
4. 別サイトのページから `fetch('http://<hub>:3000/api/scenes/history', {method:'POST'})` で書き込めること。
5. 幅 768px ちょうど・767px、タッチだけの端末でマップの拡大・全体表示が使えないこと。

---

## ファイル構成

```text
web-controller/
  fleet/sceneHistoryStore.ts      履歴の検証・追記・読込（Hub 専有）
  fleet/sceneHttp.ts              /api/scenes/* の HTTP 処理（Origin・型・サイズ・409）
  server.ts                       sceneHttp を Next の前に差し込む（変更）
  scene/editorHistory.ts          元に戻す／やり直す（純粋関数）
  scene/historyClient.ts          送信キュー・再試行・競合検知（fetch を注入）
  scene/mapColors.ts              マップ描画の固定色（床材・部屋種別・家具・扉）
  hooks/useSceneProject.tsx       上の 2 つを React に接続
  app/(console)/scenes/page.tsx           ページ（幅判定・レイアウト）
  app/(console)/scenes/scenes.module.css  ページ専用スタイル
  app/(console)/scenes/MapTabs.tsx        タブ（追加・名前変更・削除・配置コピー）
  app/(console)/scenes/MapStage.tsx       マップ SVG（床・部屋・家具・扉・壁・充電・グリッド・行為者）
  app/(console)/scenes/HistoryDialog.tsx  編集履歴（一覧・適用・再試行）
  app/(console)/scenes/ProjectBar.tsx     プロジェクト名・元に戻す／やり直す・JSON 保存／開く・保存状態
  app/(console)/ConsoleShell.tsx          ナビに「シーン」を追加（変更）
  scripts/scene/sceneHistoryStore.test.ts
  scripts/scene/sceneHttp.test.ts
  scripts/scene/editorHistory.test.ts
  scripts/scene/historyClient.test.ts
  browser-tests/scenes-*.spec.ts          Playwright（Task 9）
  playwright.config.ts
```

---

### Task 1: 履歴ストア（Hub）

**Files:**
- Create: `web-controller/fleet/sceneHistoryStore.ts`、`web-controller/scripts/scene/sceneHistoryStore.test.ts`

**Interfaces:**
- Consumes: `scene/model.ts` の `validateProject`、`projectForSave`
- Produces:
  - `interface SceneHistoryRecord { revision: number; id: string; timestamp: string; label: string; restoredFrom: number | null; hash: string; project: SceneProject }`
  - `type SceneHistoryMeta = Omit<SceneHistoryRecord, "project">`
  - `class SceneHistoryStore { static open(dir: string, now?: () => Date): SceneHistoryStore; list(): SceneHistoryMeta[]; get(revision: number): SceneHistoryRecord | null; latest(): SceneHistoryRecord | null; append(input: { expectedRevision: number; id: string; label: string; project: unknown; restoredFrom?: number | null }): { status: "created" | "duplicate"; record: SceneHistoryRecord } | { status: "conflict"; latestRevision: number }; close(): void }`
- 値: ファイル名 `0000000001.json`、`id` は 1〜80 文字の英数字・`_`・`-`、`label` は 1〜120 文字、`hash` は `project` を `JSON.stringify` した文字列の SHA-256（16 進）。`writer.lock`（作成時排他 `wx`）で同じフォルダーの多重オープンを拒否し、`close()` で消す。

- [ ] **Step 1: 失敗するテストを書く**（一時フォルダーを `fs.mkdtempSync(os.tmpdir())` で作る）
  - 空フォルダーで `latest() === null`、`append({expectedRevision:0,...})` が `created` で revision 1
  - `expectedRevision: 0` の 2 回目は `conflict` で `latestRevision: 1`
  - 同じ `id`・同じ `project` の再送は `duplicate` で同じ revision、同じ `id`・別 `project` は `conflict`
  - `validateProject` を通らない `project`（`schema: "robot-scene/v5"`）は例外
  - 開き直しても `list()` が同じ。`0000000002.json` だけ置いて番号抜けにすると `open` が例外。`hash` を書き換えると `open` が例外
  - 同じフォルダーを 2 回 `open` すると 2 回目が例外、`close()` 後は開ける
  - 書込み途中の一時ファイル（`*.tmp`）が残っていても `open` は無視して成功
- [ ] **Step 2:** `cd web-controller; npx tsx --test --test-reporter=tap scripts/scene/sceneHistoryStore.test.ts` で FAIL を確認。
- [ ] **Step 3:** 上流 `history-store.js` を参照して実装（`fs.writeFileSync(tmp)` → `fs.fsyncSync` → `fs.renameSync`）。
- [ ] **Step 4:** PASS と `npx tsc --noEmit --incremental false -p tsconfig.json` を確認。
- [ ] **Step 5:** コミット `feat(fleet): add durable scene history store`

### Task 2: HTTP API と server.ts への組み込み

**Files:**
- Create: `web-controller/fleet/sceneHttp.ts`、`web-controller/scripts/scene/sceneHttp.test.ts`
- Modify: `web-controller/server.ts`（`createServer` のハンドラーで `handleSceneRequest` が `true` を返したら Next に渡さない）

**Interfaces:**
- Consumes: Task 1 の `SceneHistoryStore`
- Produces: `handleSceneRequest(req: IncomingMessage, res: ServerResponse, store: SceneHistoryStore): Promise<boolean>`（`/api/scenes/` 以外は `false`）

| メソッド・パス | 応答 |
|---|---|
| `GET /api/scenes/history` | 200 `{ records: SceneHistoryMeta[] }` |
| `GET /api/scenes/history/:revision` | 200 `SceneHistoryRecord`、無ければ 404 |
| `GET /api/scenes/latest` | 200 `SceneHistoryRecord`、空なら 204 |
| `POST /api/scenes/history` | 本文 `{expectedRevision,id,label,project,restoredFrom?}`。201 作成、200 重複、409 `{latestRevision}`、400 検証エラー `{error}`、403 Origin 不一致、413、415 |

- 保存先は環境変数 `SCENE_HISTORY_DIR`、未指定なら `data/scene-history`。

- [ ] **Step 1: 失敗するテストを書く**（`http.createServer` をポート 0 で立て、Node 標準 `fetch` で叩く）
  - 上表の各ステータス、`Origin: http://evil.example` は 403、`Origin` なしの POST も 403、`Content-Type: text/plain` は 415、10MiB+1 バイトは 413
  - GET は Origin を問わず 200
  - `/api/routes` には `false` を返す（Next に渡る）
- [ ] **Step 2〜4:** FAIL 確認 → 実装 → PASS・型チェック。
- [ ] **Step 5:** `server.ts` に組み込み、`npm --prefix web-controller run dev` を起動して `Invoke-RestMethod http://localhost:3000/api/scenes/history` が `records` を返すことを確認後に停止。
- [ ] **Step 6:** コミット `feat(fleet): serve scene history over same-origin HTTP`

### Task 3: 元に戻す／やり直す

**Files:**
- Create: `web-controller/scene/editorHistory.ts`、`web-controller/scripts/scene/editorHistory.test.ts`

**Interfaces:**
- Produces:
  - `UNDO_LIMIT = 40`
  - `interface EditorHistory<T> { present: T; past: T[]; future: T[] }`
  - `initHistory<T>(present: T): EditorHistory<T>`、`pushEdit<T>(h, next: T): EditorHistory<T>`、`undo<T>(h)`、`redo<T>(h)`、`canUndo(h)`、`canRedo(h)`
  - いずれも入力を変更せず新しいオブジェクトを返す。

- [ ] **Step 1: 失敗するテストを書く** — 41 回 `pushEdit` すると `past.length === 40` で最古が消える。undo→pushEdit で `future` が空。undo を空の past で呼ぶと同じ参照を返す。入力の凍結（`Object.freeze`）で例外が出ない。
- [ ] **Step 2〜4:** FAIL → 実装 → PASS・型チェック。
- [ ] **Step 5:** コミット `feat(scene): add bounded undo/redo history`

### Task 4: 送信キューと競合検知（ブラウザー側）

**Files:**
- Create: `web-controller/scene/historyClient.ts`、`web-controller/scripts/scene/historyClient.test.ts`

**Interfaces:**
- Consumes: Task 2 の API 仕様
- Produces:
  - `type SaveState = { kind: "saved"; revision: number } | { kind: "pending"; count: number } | { kind: "conflict"; latestRevision: number } | { kind: "error"; message: string; count: number }`
  - `createHistoryClient(opts: { fetch: typeof fetch; baseUrl?: string; makeId: () => string; onState: (s: SaveState) => void }): { load(): Promise<SceneHistoryRecord | null>; record(project: SceneProject, label: string, restoredFrom?: number | null): void; retry(): void; list(): Promise<SceneHistoryMeta[]>; get(revision: number): Promise<SceneHistoryRecord> }`
  - 送信は 1 件ずつ順番に行う。`conflict` になったら以降の送信を止め、`record` を受け付けても送らずに件数だけ増やす。`error`（通信失敗・5xx）は送信を止め、`retry()` で同じ `id` のまま再送する。

- [ ] **Step 1: 失敗するテストを書く**（偽の `fetch` を渡す）
  - 3 件を続けて `record` → POST が順番に 3 回、`expectedRevision` が 0,1,2、最終状態 `saved` revision 3
  - 2 件目で 409 → 状態 `conflict`、3 件目は送られない
  - 2 件目で通信例外 → `error` count 2、`retry()` で 2 件目が**同じ id** で再送され、続けて 3 件目
  - 送信中の状態は `pending` で未送信件数を含む
- [ ] **Step 2〜4:** FAIL → 上流 `history-client.js` を参照して実装 → PASS・型チェック。
- [ ] **Step 5:** コミット `feat(scene): add ordered history upload with conflict detection`

### Task 5: ページ骨組み・ナビ・幅判定・フック

**Files:**
- Create: `hooks/useSceneProject.tsx`、`app/(console)/scenes/page.tsx`、`app/(console)/scenes/scenes.module.css`、`app/(console)/scenes/ProjectBar.tsx`
- Modify: `app/(console)/ConsoleShell.tsx`（NAV の「ロボット」の後に `{ href: "/scenes", label: "シーン", title: "シーンエディター", Icon: Clapperboard }`）

**Interfaces:**
- Consumes: Task 3・4
- Produces: `useSceneProject(): { project: SceneProject | null; activeMapId: string | null; setActiveMap(id): void; commit(edit: (draft: SceneProject) => void, label: string): string | null; undo(): void; redo(): void; canUndo: boolean; canRedo: boolean; saveState: SaveState; history: { list; get; apply(revision: number): Promise<void>; retry(): void } }`
  - `commit` は `structuredClone` した下書きに `edit` を適用し `validateProject` を通す。失敗時は何も変えずエラー文を返す（成功時 `null`）。成功時は `pushEdit` と `record` を行う。`conflict` 中は `commit` を拒否して理由を返す。
  - 履歴が空のときは `createProject("新しいシーン")` を作り、ラベル「新規作成」で最初の記録にする。

- [ ] **Step 1:** レイアウト: 上段 ProjectBar、2 段目タブ、中央マップ、下段に時間軸の置き場所（S2c で中身を入れる空のカード）。幅 1280px 以上は横並び（マップ左・右に設定パネル）、768〜1279px は縦積み。767px 以下は案内文だけを出す（`matchMedia("(min-width: 768px)")`）。
- [ ] **Step 2:** ProjectBar: 名前（Enter・フォーカス移動で確定、Escape で取消、空は不可）、元に戻す／やり直す（Ctrl+Z・Ctrl+Shift+Z・Ctrl+Y、入力欄にフォーカスがあるときは無視）、保存状態（`saved`=「保存済み #n」、`pending`=「保存中 n件」、`conflict`=警告色で「他の画面で更新されました。再読込してください」と再読込ボタン、`error`=「保存に失敗 n件」と再試行ボタン）。
- [ ] **Step 3:** `npx tsc --noEmit` とブラウザーで表示確認（Task 9 で自動化）。
- [ ] **Step 4:** コミット `feat(scenes): add scene editor page shell with durable saving`

### Task 6: タブ

**Files:**
- Create: `app/(console)/scenes/MapTabs.tsx`

**Interfaces:**
- Consumes: Task 5 の `commit`、S1 の `copyMapLayout`（無い場合は `scene/model.ts` に `copyMapLayout(source: SceneMap, name: string, makeId?: IdFactory): SceneMap` を追加し、部屋・設備の ID を振り直し、行と演出を引き継がないことを単体テストで確認する）
- 動作: 追加（「新しくマップを描く」または既存マップの配置コピーを選ぶダイアログ）、名前変更（ダブルクリック・Enter 確定・Escape 取消・空不可）、削除（確認ダイアログ、最後の 1 枚は削除不可）、最大 8 枚（超過時はボタン無効と理由表示）。タブの切替は編集履歴に残さない。

- [ ] **Step 1:** `copyMapLayout` が未実装ならテスト先行で追加（Task 3 と同じ手順）。
- [ ] **Step 2:** コンポーネントを実装。キーボードで左右キー移動できる `role="tablist"`。
- [ ] **Step 3:** 型チェック。
- [ ] **Step 4:** コミット `feat(scenes): add map tabs with layout copy`

### Task 7: マップ表示

**Files:**
- Create: `scene/mapColors.ts`、`app/(console)/scenes/MapStage.tsx`

**Interfaces:**
- Consumes: S1 の `buildNavigation`・`mergedDoors`・`compilePlan`・`samplePlan`・`regionBounds`
- Produces: `<MapStage map={SceneMap} time={number} showGrid={boolean} gridMm={EditGridMm} onPick?={(p: {x:number;y:number}) => void} />`
  - SVG の `viewBox="0 0 1100 620"`、点は `svgY = 620 - y`、角度は `-yaw`。
  - 計画は `WeakMap<SceneMap, ScenePlan>` でマップ参照ごとにキャッシュする。
  - 描画順: 床（部屋のマス・床材）→ 充電スペース → 家具 → 壁 → 扉（`sampleDoorPlan` の開度）→ 経路 → 行為者（ロボットは 80mm 角の四角と向き矢印、安全円 60mm を点線、人物は半径 14mm）→ 表示・イベント。
  - 拡大: 「全体」「150%」「200%」「400%」。全体は親要素に合わせる。拡大時はスクロールで移動（タッチの 1 本指スクロールも可）。
  - `mapColors.ts` はテーマと無関係な固定色（床材 4 種、部屋種別、家具 4 種、扉、壁、充電）。

- [ ] **Step 1:** `mapColors.ts`（色の値は上流 `public/style.css`・`floor-plan.js` の描画色をそのまま使う）。
- [ ] **Step 2:** MapStage を実装し、ページに組み込む。時刻は暫定のスライダー（0〜`duration`）で動かす（再生ボタン等は S2c）。
- [ ] **Step 3:** 型チェック。上流の標準テストマップに相当するデータが無いため、Task 9 の Playwright で S1 のテスト用フィクスチャを読み込んで確認する。
- [ ] **Step 4:** コミット `feat(scenes): render scene maps in mm with theme-independent colors`

### Task 8: JSON 保存・読込と編集履歴ダイアログ

**Files:**
- Create: `app/(console)/scenes/HistoryDialog.tsx`
- Modify: `app/(console)/scenes/ProjectBar.tsx`

**Interfaces:**
- Consumes: Task 5 の `history`・`commit`、S1 の `projectForSave`・`validateProject`
- 動作:
  - JSON 保存: `projectForSave` の結果を `<name>.fleet-scene.json` としてダウンロード。
  - JSON 読込: 10MiB 以下、`validateProject` を通るもののみ。通らなければ理由を表示して現在の作業を変えない。成功時はラベル「JSON読込」で 1 件の編集にする。上流の旧形式は「S3 の変換機能で取り込んでください」と表示して拒否。
  - 履歴ダイアログ: 新しい順の一覧（番号・日時・ラベル・元の番号）。「この状態を適用」は新しい履歴（`restoredFrom` 付き、ラベル「履歴 #n を適用」）として追加し、後の履歴を消さない。`error` 中は「未送信を再試行」を出す。

- [ ] **Step 1:** 実装。
- [ ] **Step 2:** 型チェック。
- [ ] **Step 3:** コミット `feat(scenes): add JSON import/export and history dialog`

### Task 9: 画面の自動テスト（Playwright）

**Files:**
- Modify: `web-controller/package.json`（devDependencies に `@playwright/test`、scripts に `"test:browser": "playwright test"`）
- Create: `web-controller/playwright.config.ts`、`web-controller/browser-tests/scenes-*.spec.ts`

**Interfaces:**
- 設定: `channel: "msedge"`、`workers: 1`、`webServer` で `cross-env PORT=3117 SCENE_HISTORY_DIR=<一時フォルダー> tsx server.ts` を起動（利用者の `data/` を汚さない）。ポート 3117 が使用中なら他プロセスを止めずに失敗させる。ブラウザー本体のダウンロードは行わない（`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` で導入）。

- [ ] **Step 1:** 導入: `npm --prefix web-controller install -D @playwright/test`（環境変数 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`）。
- [ ] **Step 2: テストを書く**
  - 新規表示で「保存済み #1」、名前を変えると「保存済み #2」、再読込しても名前が残る
  - Ctrl+Z で名前が戻り、新しい編集の後は Ctrl+Y が無効
  - タブを 8 枚まで追加でき 9 枚目のボタンが無効、最後の 1 枚は削除できない、名前の空確定は拒否
  - 2 つのページ（同じブラウザーの別コンテキスト）で順に編集 → 後の方が「他の画面で更新されました」を表示し、以降の編集を受け付けない
  - Hub への POST を `page.route` で 1 回失敗させる → 「保存に失敗 1件」→ 再試行で「保存済み」
  - 別 Origin からの POST（`request.post` に `Origin: http://evil.example`）が 403
  - 不正な JSON の読込で作業が変わらず理由が出る、正しい JSON は読み込める
  - 履歴ダイアログで #1 を適用 → 新しい番号で追加され、後の番号も残る
  - 幅 767px で案内文のみ、768px でマップとタブが表示される。両テーマ（ライト・ダーク）で文字色と背景のコントラストが 4.5:1 以上（`getComputedStyle` で確認）
  - タッチ端末相当（`hasTouch: true`）で拡大 200% → 1 本指スクロールでマップが動く
- [ ] **Step 3:** 実行: `npm --prefix web-controller run test:browser` → 全件 PASS。
- [ ] **Step 4:** 全回帰: `test:scene`・`test:fleet`・`test:localization`・`test:appearance`・`tsc --noEmit` が失敗 0。
- [ ] **Step 5:** コミット `test(scenes): add browser tests for the scene editor foundation`

---

## 実装者に任せること（私の判断として記録）

- `data/scenes/` は使わず、最新の履歴を「現在のシーン」とする（上流と同じ方式。S5 の実行系は `latest()` を読む）。
- 本文上限は 10MiB（上流は背景画像のため 100MiB。本移植では背景画像を扱わない）。
- コンポーネントの内部分割と CSS のクラス名。

## 後続

- S2b（マップ作成）、S2c（時間軸と動作の編集）は本計画の完了後に作成する。
