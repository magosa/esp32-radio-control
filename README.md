# ESP32 Radio Control

走行・LCD用ESP32とカメラ用ESP32を分離し、Fleet Hubで1台のロボットとして管理します。
カメラの割当は画面で変更でき、Hub再起動後も保存されます。

## 起動

Node.js 20以降とnpmを使用します。

```sh
npm --prefix web-controller ci
npm run dev
```

Fleet: <http://localhost:3000/control>。Bluetooth直接操作: <http://localhost:3000/direct/bluetooth>。
HubはESP32から到達できるPCで起動します。この開発PCと同じとは限りません。
本番相当の起動は `npm run build` の後に `npm start` です。

## 配置

| パス | 用途 |
| --- | --- |
| [web-controller](web-controller) | Next.js画面、WebSocket Hub、ルート、シミュレータ |
| [firmware/esp32_rc_car](firmware/esp32_rc_car) | ideaspark ESP32: L298N走行＋ST7789 LCD。WebSocket／BLE／Classic BT |
| [firmware/camera_xiao_s3](firmware/camera_xiao_s3) | XIAO ESP32S3 Sense: Wi-Fiカメラ専用 |
| [firmware/diagnostics](firmware/diagnostics) | 実機診断スケッチ。本番FWではありません |
| [scripts](scripts) | シリアル診断などの保守スクリプト |
| [docs/firmware.md](docs/firmware.md) | 配線、依存ライブラリ、ビルド、書き込み前の確認 |
| [docs/fleet.md](docs/fleet.md) | ロボット構成、通信、保存、シミュレーション、運用 |
| [docs/migration.md](docs/migration.md) | 移行内容、互換性、段階的な適用・切り戻し |
| [archive/workshop/ARCHIVE.md](archive/workshop/ARCHIVE.md) | 旧OLED／Bluetooth教材・Slidev・図・Archify |

## 検証

```sh
npm test
npm run test:appearance
npm run typecheck
npm run build
npm run sim:device -- --fleet
```

最後のコマンドは走行機2台（うち1台は旧hello形式）とカメラ1台を接続します。
本番Hubに疑似デバイスを接続しないでください。詳細は [Fleet運用](docs/fleet.md) を参照してください。

## 安全・機密情報

- カメラ断は警告のみです。走行機自身の通信断フェイルセーフは独立して維持します。
- 動作試験前は車輪を浮かせてください。ビルドやnpmテストは実機へアップロードしません。
- 各スケッチの `wifi_secrets.h`、Hubの `web-controller/data/` はGit対象外です。
- Hubには認証がありません。信頼できる閉域LAN専用で、インターネットへ公開しないでください。
- 過去のGit履歴に含まれた認証情報は削除コミットだけでは消えません。該当するWi-Fi認証情報は更新してください。