# ARマーカー測位のFleet統合 実装計画

状態: 計画（未実装）。作成日 2026-10-26。第三者レビュー指摘を反映済み。
通常の運用手順は [fleet.md](fleet.md) を参照してください。本書は実装後に運用文書へ統合します。

## 1. 目的と範囲

俯瞰USBカメラとARマーカー（ArUco）でロボットの位置・向きをリアルタイムに取得し、Fleetの監視・安全補足・位置フィードバック走行に使います。

- 範囲: 表示・監視、安全／検証の補足、位置フィードバック走行（waypoint）。
- 対象外: 経路の動的再計画による衝突回避、差動操舵による連続追従、検出のWorker化、ESP32ファームウェア変更、マップ上でのルート編集（ルートはJSON手書き）。
- 台数: 最大4台（ロボットID0〜3）。基準マーカーはID40〜43。
- ESP32の走行FWは変更しません。1.5秒の受信途絶フェイルセーフは最後の砦として維持します。

## 2. 決定事項

| 項目 | 決定 |
| --- | --- |
| 構成 | node-localizerをFleet（Next.js）へ統合。ブラウザー内でOpenCV.js検出 |
| カメラ接続 | Hub実行PCへ接続（localhostでgetUserMediaが使える） |
| 検出の常駐 | シェル常駐Provider。同一タブで画面遷移しても検出を継続 |
| 補足の範囲 | 表示・監視、安全／検証、位置フィードバック走行 |
| マーカー対応 | UIで設定し`fleet.json`へ保存。最大4台 |
| 校正 | 自動測定ウィザード |
| 走行制御 | stop-and-goで開始。連続追従は将来拡張 |
| 測位喪失 | 短時間停止して待機し、復帰したら自動再開。上限超過で手動へ戻す |
| ルート作成 | JSON手書き（waypoint種別） |
| 衝突対策 | 簡易な近接停止 |
| `/ws/localizer`保護 | Origin許可リスト＋loopback限定 |
| リリース | 3段階PR（URL再編／測位・表示・安全／校正・閉ループ） |
| コード取込 | node-localizerの取込・改変は許可済み |

## 3. 流用元（node-localizer）の分析

場所: `Downloads\robot-localizer-node-1.0.0-20261023\node-localizer`（リポジトリ外）。

- `server.js`は127.0.0.1限定の静的配信のみ。出力APIはありません。検出・測位・描画・CSVは全てブラウザー内です。
- `public/geometry.js`はDOM非依存の純粋ESMで、TS化しやすい構成です。`detector.js`は`cv`インスタンスを受け取るだけです。
- 出力契約`robot_pose/v3`:
  - 座標は1600×900の比率座標（左下原点、Y上）。
  - yawは右0°・反時計回り正・(-180,180]。マーカー画像の右方向が前方。
- 基準4枚で測位、3枚は暫定推定（警告）、2枚以下は全座標を無効化。未検出ロボットの過去値は保持しません。
- 制約:
  - `validateConfig`がロボット4台固定。
  - 100ms待機のため10fps未満。
  - `timestamp_ms`は撮影時刻ではなく処理時刻。
  - フレーム間の状態を持たず、フィルタ・外れ値棄却なし。
  - レンズ歪み未校正、nadir近似。
  - 背景タブで検知が遅れる。
  - README記載の「217件」のテスト数と実機精度は未検証値。移植前に原本で`npm test`を実行して基準値を確定する。

## 4. 現行Fleetとの接点

- `VehicleState.position`は予約のみで未使用（[protocol.ts](../web-controller/fleet/protocol.ts)）。廃止し、`poseState`へ置き換えます。
- [routeEngine.ts](../web-controller/fleet/routeEngine.ts)に「位置補正レイヤーを上位に置く」想定のコメントがあります。
- [registry.ts](../web-controller/fleet/registry.ts)の`registerHello`は再接続時にstateを再生成するため、姿勢は別ストアで持ちます。
- `fleetState`はtelemetryごとに全配信されるため、姿勢は載せず別メッセージにします。
- `/ws/device`はESP32 FW2本（`esp32_rc_car.ino`、`camera_xiao_s3.ino`）に固定されているため永続的に維持します。
- `a`コマンドは`speedL`/`speedR`を個別指定できます（将来の差動操舵の余地）。`c`は右、`d`は左の超信地旋回です。
- `fleet.json`はversion 1のまま任意項目を追加します（旧Hubは未知項目を無視でき、既存テストも維持）。

## 5. 設計方針

### 5.1 座標系

- Hub内部はmm（原点左下、X右・Y上、headingは反時計回り正・0°は+X）。
- 比率座標からmmへの換算は`data/field.json`の領域寸法で行います。
- CSV出力は原本どおり`robot_pose/v3`（比率座標）を維持します。

### 5.2 メッセージ

- localizer→Hub: hello、`poseFrame`（frameId、capturedAt、referenceCount、extrinsicsOk、各markerIdの姿勢）、停止理由。
- Hub→UI: 約10Hzへ間引いた`poseState`（mm姿勢、追跡状態、ageMs、localizer状態）。
- UI→Hub: `assignMarker`（`assignCamera`と同じrequestId／`operationResult`方式）、場の設定更新。

### 5.3 姿勢の信頼性

- 外れ値ゲート: 前回有効姿勢から、最大速度×経過時間＋余裕を超える移動を棄却します。同じ新位置が3フレーム連続で一貫した場合のみ受理し直します。最大速度は校正前は暫定500mm/s、校正後は最大校正速度の1.5倍。
- 平滑化: 初期はゲートのみ。静止時の標準偏差が受入基準を満たさない場合のみ軽い平滑を導入します。
- 鮮度: Hubの受信時刻を基準にstale判定します（暫定0.5秒）。周期を実測してから再設定します。
- 追跡状態: tracking／stale／lost／unassigned。
- localizerの切断は「全閉ループロボットがstale」として扱います。開ループルートには影響させません。

### 5.4 セキュリティ

- `/ws/localizer`はloopbackからの接続のみ、かつOriginが`http://localhost:<PORT>`または`http://127.0.0.1:<PORT>`の場合のみ受け付けます。Originなしは拒否します。
- メッセージは有限数・件数上限を検証します。`FLEET_LOCALIZER_ALLOW_REMOTE`で緩和可能（既定は無効）。
- 理由: 閉ループでは姿勢が走行を左右するため、外部サイトのスクリプトから偽姿勢を送られる経路を塞ぎます（Hub PC上のブラウザーからは`ws://localhost`へ到達できる）。

### 5.5 検出ランタイムの常駐

- 検出ループは画面ではなくシェル側の`LocalizerRuntimeProvider`に置きます。`/localizer`は操作UIです。
- 開始できるのはlocalhost／127.0.0.1で開いたページのみ（スマホでは無効）。起動中はヘッダーにインジケーターを常時表示します。
- ページが非表示・最小化されたら警告し、Wake Lockを使います。検出が止まれば理由付きでHubへ通知します。
- OpenCV.js（約11MB）は`/localizer`で明示開始したときだけ動的に読み込みます。

### 5.6 閉ループの安全原則

- 基準4枚が揃っているときだけ閉ループ走行と校正を許可します。3枚は表示のみ。
- 領域外では閉ループ走行中のロボットだけ自動停止します（手動操作は上書きしない）。
- 停止系の統合: 全台停止、`setMode`でmanual切替、走行機切断、手動`e`で`stopAllAutomation`を呼び、旧エンジンとWaypointEngineの両方を止めます。同時に走るルートは1種類です。
- 無進捗watchdog: waypointごとにタイムアウト（暫定「距離÷校正速度×3＋10秒」）。前進指示中に2秒で進捗10mm未満ならそのロボットを停止し中断通知します。
- 喪失時: staleなら即`e`を送って待機します。復帰したら旧状態を継続せず整列から再評価します。待機上限（暫定5秒）を超えたらそのロボットを手動へ戻して通知します。
- 近接停止: ロボット外形は幅60×奥行60×高さ80mm。対角約85mm＋余裕35mmで、中心間距離の暫定しきい値を120mmとします。解除はヒステリシスとして140mm。優先度はmarker ID昇順で決定的に決めます。膠着が10秒続けば経路全体を中断して通知します。
- マーカー取付誤差: 校正の前進走行で、進行方向とmarker yawの差（ヨーオフセット）を推定して保存します。
- 校正値: 校正日時を保存し、24時間超過でUIが再校正を促します。走行中の実進捗が校正値の±50%を外れたら警告します。

## 6. リリース分割と手順

### PR1: URL・シェル再編（測位と無関係、回帰を分離）

1. `/`→`/control`。現`/fleet`→`/control`、`/fleet/settings`→`/settings`、`/bluetooth`→`/direct/bluetooth`。`/field`、`/robots`、`/routes`、`/localizer`は空の枠から作成。
2. [next.config.mjs](../web-controller/next.config.mjs)の`redirects()`で旧URLを互換維持。APIは`/api/routes`へ移し、旧`/api/fleet/routes`はredirect。
3. ルートグループの共通layoutにヘッダー・ナビ・全台停止・外観適用を集約。[useFleetSocket.ts](../web-controller/hooks/useFleetSocket.ts)はContext Provider化し、遷移してもWebSocketを1本に保ちます。全台停止は全画面から押せること。
4. カメラ紐付けなどの構成編集は`/robots`へ移動。`/control`には走行・スナップショット・ライブ・ルート実行を残します。
5. [server.ts](../web-controller/server.ts)のupgrade許可に`/ws/localizer`を追加（PR2で使用）。`/ws/device`は維持。
6. READMEの「Bluetoothは`/`」の記述を現状に合わせて修正。
7. 完了条件: 既存機能の回帰なし、旧URLのredirect動作、外観・レイアウトの再検証（7節）。

### PR2: 測位・表示・安全（Phase 1〜5）

1. 測位コア: `web-controller/localization/`に`geometry.ts`・型・`detector.ts`。ロボット1〜4台の可変、ID0〜3。スキーマは`robot_pose/v3`。
2. `@techstark/opencv-js`を4.12.0-release.1で固定し、Route Handlerの`/vendor/opencv.js`で配信。Next側にCSPがないため`unsafe-eval`設定は不要。
3. 原本テストを`tsx --test`形式へ移植（投影往復、3枚フォールバック、辞書全50ID×4回転、小マーカー検出）。
4. Hub: protocol追加、`fleet/poseStore.ts`、`/ws/localizer`ハンドラー（5.3・5.4）、`VehicleState.position`廃止。
5. 保存: `RobotDefinition`に任意項目（`markerId`、`markerHeightMm`既定90・ID3は120想定）。重複・範囲の検証。場の設定は`data/field.json`（カメラ高さ、領域寸法mm、基準黒部寸法）に原子的に保存。
6. `/localizer`: 検出ループ（`requestVideoFrameCallback`で映像更新ごとに処理、100ms固定待機を廃止）、プレビュー、オーバーレイ、CSV記録、Hubへのpose送信。フレーム周期と撮影→受信遅延の計測表示を含める。
7. `/robots`: カメラ紐付け、マーカーID・高さの設定。`/field`: 16:9のSVGに位置・向き・名前・追跡状態・軌跡。
8. 安全補足: 追跡状態表示、localizer未接続・基準3枚の警告、領域外警告。
9. 完了条件: 実機計測で受入基準（8節）の値を取得し、記録する。

### PR3: 校正・閉ループ（PR2の実測値が基準を満たした場合のみ着手）

1. `fleet/calibration.ts`: 依存注入（`sendDrive`、`getPose`、時刻）。複数PWM段階で前進・旋回を短時間実走し、動き出しPWM・mm/s・deg/s（左右旋回別）・ヨーオフセットを算出。実走前に操作者の確認と領域端からの余裕を確認。追跡喪失・全台停止・切断で即中断。結果を`motion`へ保存。
2. `fleet/waypointEngine.ts`: ロボットごとに「旋回整列→直進→停止安定化→次waypoint／集合待機」。判断は姿勢更新（約10Hz）ごと、再送は800ms。旋回は測位遅延を考慮し、校正deg/sから予測停止位置で止める。
3. ルートJSON（waypoint種別）: waypoint列（mm座標）、許容誤差、同期グループ。読み込み時に検証（有限数、領域内、数量上限）。[rendezvous-demo.json](../web-controller/fleet/routes/rendezvous-demo.json)は旧種別として維持。`listAvailableRoutes`に種別を追加。スロットはmarker ID昇順で割り当て。
4. 5.6の喪失・watchdog・近接停止・`stopAllAutomation`を実装。
5. 閉ループ開始前チェック: 基準4枚、対象全台がtracking、校正済み、領域内、localizer正常。
6. sim world: [fakeDevice.ts](../web-controller/scripts/fakeDevice.ts)に、driveコマンドで運動学的に移動する疑似ロボットと、同一プロセスの疑似localizerを追加。ノイズ、遅延、欠損、基準3枚化、外れ値を注入可能にする。

## 7. テスト・検証

- `npm run typecheck`、`npm --prefix web-controller run test:appearance`が成功すること。
- localizationテスト（移植分）、poseStoreの鮮度・外れ値ゲート、Hub統合（偽ソケット）を追加。
  - markerIdからrobotIdへの対応。
  - 非loopback・不正Origin・Originなしの拒否。
  - localizer切断でstaleになる。
- WaypointEngine（モックタイマー）: 収束、喪失→復帰再開、待機上限超過、近接停止と解除、watchdog、全台停止の割り込み。
- 校正推定器: 合成軌跡からmm/s・deg/s・ヨーオフセットを復元。
- 保存: 旧`fleet.json`（新項目なし）の読み込み、マーカーID重複の拒否、不正ファイルを上書きしない。
- UI検証（PR1・PR2）: Playwrightで両テーマ、幅320／768pxのスクリーンショット確認。新規の状態色（追跡中／遮蔽／領域外／stale）を`test:appearance`のコントラスト試験へ追加。
- sim worldで、遅延・ノイズ・欠損を与えた集合ルートの完了を確認。
- ルートの`npm test`は現状`test:fleet`のみのため、新規テストを含むよう更新。

## 8. 受入基準（PR2の実機計測、PR3着手のgo/no-go）

条件: カメラ高800mm、領域約1107×623mm。値はPR2の実測でp値を出して見直します。

| 項目 | 基準 |
| --- | --- |
| 静止時の位置の標準偏差 | 3mm以下 |
| 静止時のyawの標準偏差 | 1.5°以下 |
| 測位更新周期 | p95が200ms以下 |
| 撮影→Hub受信の遅延 | p95が300ms以下 |
| 4台同時の検出率（遮蔽なし） | 95%以上 |
| 既知位置（四隅・中心）の絶対誤差 | 15mm以下 |
| 閉ループの許容誤差（初期値） | 位置30mm、向き5° |

追加で確認する項目: ID3（120mm機）の高さ補正、遮蔽時の停止と復帰、背景化・最小化時の挙動、複数台同時走行時の処理速度。

## 9. 暫定定数（実測後に調整）

| 定数 | 暫定値 |
| --- | --- |
| stale判定 | 0.5秒 |
| 喪失時の待機上限 | 5秒 |
| 外れ値ゲートの暫定最大速度 | 500mm/s |
| 外れ値の再受理 | 3フレーム連続 |
| 近接停止／解除 | 120mm／140mm |
| 近接の膠着中断 | 10秒 |
| 無進捗watchdog | 2秒で進捗10mm未満 |
| waypointタイムアウト | 距離÷校正速度×3＋10秒 |
| 校正の再実施目安 | 24時間 |
| 閉ループの許容誤差 | 位置30mm、向き5° |
| poseState配信 | 約10Hz |

## 10. リスクと留意点

- 40mmマーカーのyaw雑音が閉ループの許容誤差に対して大きい可能性があります。8節の基準未達ならPR3は着手しません。
- Windows版ブラウザーは、遮蔽されたウィンドウの描画・`requestVideoFrameCallback`を抑制する場合があります。検出ウィンドウを隠さない運用と警告表示を前提にします。
- 校正値は電池電圧や床面で変わります。再校正の促しと進捗乖離の警告で補います。
- URL再編は直近のFleet UI再監査（CSS調整）と衝突しやすいため、PR1は`feat/fleet-ui-appearance`の取り込み状況を確認してから基点を決めます。作業は新規ブランチで行い、未コミットのino差分には触れません。
- 原本のライセンス表記は同梱されていません。取込・改変は許可済みですが、第三者への再配布は別途確認が必要です。
- ロボット外形の実測値（60×60×80mm）は目安です。近接しきい値は実測で調整します。

## 11. 主な変更対象

- 流用元: `node-localizer/public/{geometry.js, detector.js, app.js, dictionary.js}`、`test/localizer.test.js`。
- 変更: [protocol.ts](../web-controller/fleet/protocol.ts)、[hub.ts](../web-controller/fleet/hub.ts)、[robotStore.ts](../web-controller/fleet/robotStore.ts)、[routeEngine.ts](../web-controller/fleet/routeEngine.ts)、[server.ts](../web-controller/server.ts)、[useFleetSocket.ts](../web-controller/hooks/useFleetSocket.ts)、[app/fleet/page.tsx](../web-controller/app/fleet/page.tsx)、[next.config.mjs](../web-controller/next.config.mjs)、[fleet-migration.test.ts](../web-controller/scripts/fleet-migration.test.ts)、[fakeDevice.ts](../web-controller/scripts/fakeDevice.ts)、[package.json](../package.json)、[fleet.md](fleet.md)、[README.md](../README.md)。
- 新設: `web-controller/localization/`、`fleet/{poseStore, calibration, waypointEngine, fieldConfigStore}.ts`、`/field`・`/robots`・`/routes`・`/localizer`の各ページ、`LocalizerRuntimeProvider`。
