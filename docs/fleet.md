# Fleet運用と通信

## 画面のURL

| URL | 内容 |
| --- | --- |
| `/control` | 走行・手動／自動・ルート実行・表情・カメラ撮影／ライブ（旧 `/fleet`） |
| `/field` | フロアマップ（ロボットの位置・向き・軌跡・追跡状態） |
| `/robots` | ロボット構成（カメラの紐付け、測位マーカーID・高さ） |
| `/localizer` | 俯瞰カメラの開始・停止、検出結果、領域設定、CSV記録 |
| `/robots` | ロボット構成（カメラの紐付け） |
| `/settings` | 表示設定（旧 `/fleet/settings`） |
| `/direct/bluetooth` | Bluetooth直接操作（旧 `/bluetooth`） |

`/`、`/fleet`、`/fleet/settings`、`/bluetooth`、`/api/fleet/routes` は新URLへ一時リダイレクトします。
ESP32は従来どおり `/ws/device`、ブラウザーは `/ws/client` に接続します（ファームウェア固定のため変更しません）。

## ロボット構成

`deviceId` は物理ESP32の識別子、`robotId` は論理ロボットの識別子です。
初回接続した走行デバイスから `robot-<deviceId>` を自動作成します。
1ロボットにつき走行＋LCD機1台、任意のカメラ1台を割り当てます。
同じカメラを複数ロボットへ同時には割り当てられません。
複数制御のチェック選択は一時的な操作対象で、ロボット構成とは別です。

1. 走行機とカメラ機を同じHubへ接続します。
2. `/robots` を開き、対象ロボットの「カメラの紐付け」でカメラを選択します。
3. 「保存しました」を確認します。撮影・ライブは `/control` でロボットを個別選択し、「カメラ」から操作します。
4. 別のロボットに移す場合は、元のロボットで「未割当」に戻してから割り当てます。

未接続の登録済みデバイスも再起動後に表示されます。カメラ未接続時は撮影・配信操作だけが
無効になり、走行可能条件は変えません。走行機の切断は自動ルートを停止します。
デバイスの再接続は手動モード・停止からやり直します。

## 保存と復旧

標準の保存先は `web-controller/data/fleet.json`。`FLEET_DATA_DIR` にディレクトリを指定して
変更できます。パスはHub起動プロセスの作業ディレクトリ基準なので、絶対パスを推奨します。
ルートのnpmコマンドは `web-controller` を作業ディレクトリとして起動します。

- バージョン1のJSONにデバイス情報とロボット構成（カメラ割当・測位マーカーID・マーカー高さ）のみ保存します。
  マーカー項目がない旧ファイルは、読み込み時に「未割当・高さ 90mm」で補います。
- 俯瞰カメラの設定（カメラ高さ・領域寸法・基準黒部）は同じディレクトリの `field.json` に保存します。
- 接続状態、走行モード、映像、実行中ルートは復元しません。
- 一時ファイルへの書き込み後に置換します。保存できなければメモリ上の割当も更新しません。
- 不正な保存ファイルは自動で上書きせず、Hub起動を失敗させます。
- 1つの保存先にはHubを1プロセスだけ起動してください。共有ストレージの多重書き込みには非対応です。
- バックアップ・復元はHubを停止してから実施します。移設先PCにもファイルを移してください。
- 保存先はPCローカルです。Git pushだけでは別PCの割当は移りません。
- 削除・物理走行機交換の画面操作は未実装です。必要時はHub停止中にバックアップを取り、
  保存JSONの整合性を保ってメンテナンスしてください。cameraDeviceIdを解除してからdeviceを除去します。

`FLEET_DATA_DIR` を標準以外のリポジトリ内パスへ変更した場合、そのパスもGit除外してください。

## 通信契約

ESP32は `/ws/device`、ブラウザーは `/ws/client` に接続します。
型定義は [protocol.ts](../web-controller/fleet/protocol.ts) です。

```json
{"type":"hello","deviceId":"rc-example","name":"Robot","fw":"4.1.0","capabilities":["drive","display"]}
```

```json
{"type":"hello","deviceId":"cam-example","name":"Camera","fw":"camera-1.0.0","capabilities":["camera"]}
```

`capabilities` 未指定の旧helloは `drive`＋`display` として受け入れます。
旧来の走行コマンド・テレメトリ・表情・レイアウト形式は維持します。
旧一体型カメラFWはカメラ能力を宣言しないため、映像送信元としては扱いません。

| 機能 | メッセージ |
| --- | --- |
| 走行 | Hub→`drive`、デバイス→`telemetry` |
| 表示 | Hub→`setExpression`／`setDisplayLayout` |
| 撮影 | Hub→`captureImage`、カメラ→`imageFrame`（JPEG Base64） |
| ライブ | Hub→`streamStart`／`streamStop`。配信中のカメラだけに`ping` |
| カメラ生存確認 | カメラ→`heartbeat`。モーター用telemetryは不要 |
| 構成編集 | UI→`assignCamera`（requestId／robotId／cameraDeviceId）、`assignMarker`（markerId／markerHeightMm）、`setFieldConfig`。Hub→`operationResult` |
| 測位 | 俯瞰カメラ（`/ws/localizer`）→`localizerHello`／`poseFrame`／`localizerStatus`、Hub→UIは約10Hzの`poseState` |
| 状態配信 | `fleetState`: 従来の走行機一覧`vehicles`＋物理一覧`devices`＋構成`robots` |

Hubは接続socketのdeviceIdを固定し、他のdeviceIdを名乗る後続メッセージを拒否します。
能力とオンライン状態に基づき送信先を制限します。名前やIDは認証情報ではありません。
信頼できるLANのみで使用し、ポート転送・不特定端末の接続は許可しないでください。

カメラは1秒ごとにheartbeat、Hubは5秒更新がなければ未接続判定します。
XIAOはHubから5秒受信がなければ配信を止めます。再接続時に配信を自動再開しません。
最後の閲覧クライアントが閉じたとき・割当変更時にも配信を止めます。
配信の開始／停止は全閲覧者共通です。複数閲覧者が同じカメラを操作すると相互に停止できます。
フレームは保存せず、遅いブラウザーにはフレームを間引きます。
Hubの受信上限600,000bytes、JPEG Base64上限512,000文字、XIAOのJPEG上限120KiBです。

走行FWは従来どおり1.5秒の受信途絶で停止します。Hubは走行機へ生存確認pingを送りません。
手動操作の200ms再送と自動ルートの800ms再送は、停止・通信断の安全機構とは独立です。
停止指示は自動モードでも届き、関連する自動ルートの再送・予約を取り消します。

## 測位（俯瞰カメラとARUCOマーカー）

計画と設計は [ar-localizer-plan.md](ar-localizer-plan.md) を参照してください。現在は表示・監視・追跡状態の提供までで、走行制御には使いません。

- マーカー: `DICT_4X4_50`、基準ID40（左上）・41（右上）・42（右下）・43（左下）、ロボットID0〜3（最大4台）。
  ロボット上ではマーカー画像の右方向をロボット前方に合わせます。黒部寸法は基準が設定値（初期33mm）、ロボットが40mmです。
- 手順: 俯瞰USBカメラをHub実行PCへ接続 → `/robots` でマーカーIDとマーカー高さを設定 →
  `/localizer` で領域設定を確認して保存 → カメラを選んで「開始」 → `/field` で確認。
- 測位は**Hub実行PCのlocalhostで開いたページ**からのみ開始できます。検出ループはシェルで常駐し、同じタブで画面を移動しても続きます。
  ウィンドウが背面・最小化されると検出が遅れる・止まることがあるため、警告を表示します。
- Hubは`/ws/localizer`を、loopbackからの接続で、かつOriginがこのHubのlocalhost系のときだけ受け付けます。
  `FLEET_LOCALIZER_ALLOW_REMOTE=1` で緩和できますが、偵の姿勢を送られるリスクがあるため非推奨です。
- 追跡状態: 追跡中（最新フレームで検出）／未検出（フレームは届くがマーカーなし・飛び値を棄却）／
  測位なし（フレームが0.5秒以上途絶・未接続・停止）／マーカー未割当。過去の座標は保持しません。
  500mm/sを超える飛びは棄却し、同じ場所が3フレーム連続したときだけ受理します（暫定値）。
- 座標: Hub内部はmm（原点左下、X右・Y上、向きは右0°・反時計回り正）。CSVは原本どおり`robot_pose/v3`の比率座標（1600×900）です。
- 実機の絶対精度・検出率・遅延は未検証です。受入基準は計画書の「受入基準」を参照してください。

## 実機なしの確認

別PCの運用Hubではなく、専用のローカルHubと保存先を使います。
以下はPowerShellで、それぞれ別ターミナルから実行します。

```powershell
$env:PORT = '3117'
$env:FLEET_DATA_DIR = Join-Path $env:TEMP 'esp32-fleet-demo'
npm run dev
```

```powershell
$env:FLEET_HUB_HOST = 'localhost'
$env:FLEET_HUB_PORT = '3117'
npm run sim:device -- --fleet
```

<http://localhost:3117/control> を開きます。`--fleet` は走行用2台とカメラ用1台です。
単体起動は `npm run sim:device -- <deviceId> <name> <drive|camera|legacy>` です。
俯瞰カメラなしで測位UIを確認するには、続けて `npm run sim:localizer -- --assign --drop` を実行します（現在の場合は
`FLEET_HUB_PORT` を合わせる）。`--assign` は先頭2台へマーカーID0/1を割り当て、`--drop` はマーカー1を周期的に隠します。
シミュレータを終了しHubを再起動して、割当が残り接続状態は未接続へ戻ることも確認できます。
自動テストは一時保存領域と偽socketを使用し、実機へ接続しません。

## 接続診断

ESP32とHub実行PCを同じ2.4GHz対応LANへ接続します。スマホテザリングのIPは変わるため、
Hub実行PC側でIPv4とポートを確認し、各スケッチのローカル設定を更新してください。
この開発PCのIPを無条件に転記しないでください。ゲストWi-Fiの端末間隔離と
Windowsファイアウォールも確認してください。Bluetooth直接操作はWeb Bluetooth対応の
Chrome／EdgeでlocalhostまたはHTTPSを使います。Classic BTは対応SPPクライアントで操作します。