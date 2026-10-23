# ファームウェアと配線

## 走行＋LCD

[esp32_rc_car.ino](../firmware/esp32_rc_car/esp32_rc_car.ino) はideaspark ESP32＋ST7789V3
（170×320）とL298Nの6ピン直接制御用です。カメラ・LED・外付けインバータは含みません。

| 用途 | GPIO |
| --- | --- |
| 右PWM ENA | 14 |
| 右方向 IN1／IN2 | 27／26 |
| 左方向 IN3／IN4 | 33／19 |
| 左PWM ENB | 25 |
| TFT DC／RST／CS | 2／4／15 |
| TFT SCLK／MOSI／BL | 18／23／32 |

TFTは書き込み専用でSPI MISOを無効にしています。GPIO19をMISOへ戻さないでください。
L298NのENA／ENBジャンパーはPWM入力に合わせて外し、基板間GNDを共通にしてください。
モーター電源をESP32の3.3Vから取らず、モーター・ドライバーの定格に合わせます。

`TRANSPORT_MODE` は0=WebSocket、1=BLE（NUS）、2=Classic BT（SPP）です。
同時使用ではなくビルド時の切替です。既定は0で、CLIの`-DTRANSPORT_MODE`でも切り替えられます。
BLE／SPPの従来パケット（例 `a,190,190;`）と停止`e`、表情・レイアウトは維持します。

Arduinoライブラリ: **WebSockets**（Links2004）、**ArduinoJson**（6系API対応）、
**Adafruit GFX Library**、**Adafruit ST7735 and ST7789 Library**。
WiFi／Preferences／BLE／BluetoothSerialはESP32コア付属です。
検証環境はArduino CLI 1.5.1、ESP32 Core 3.3.11。Core 2系はPWM互換分岐を保持していますが、
今回の移行ではコンパイルしていません。

スケッチ内の `wifi_secrets.example.h` を同じフォルダーの `wifi_secrets.h` として用意し、
Wi-Fiと**Hub実行PC**のホスト・ポートを設定します。既存ローカル設定は移動後も保持しています。

```sh
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/esp32_rc_car
arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app --build-property compiler.cpp.extra_flags=-DTRANSPORT_MODE=1 firmware/esp32_rc_car
arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app --build-property compiler.cpp.extra_flags=-DTRANSPORT_MODE=2 firmware/esp32_rc_car
```

BLE構成は容量が大きいため、4MBフラッシュ機でHuge APP等の適切なパーティションを選びます。
ボードの実容量に合わない設定を使わないでください。

## カメラ専用XIAO

[camera_xiao_s3.ino](../firmware/camera_xiao_s3/camera_xiao_s3.ino) は
**Seeed Studio XIAO ESP32S3 Sense**＋Senseカメラ拡張ボード用です。
秋月[118079](https://akizukidenshi.com/catalog/g/g118079/)はOV3660搭載として案内されています。
実際のロット・搭載センサーは基板と起動ログのPIDで確認してください。
旧走行機のOV2640ピン配置は流用していません。

| 用途 | GPIO |
| --- | --- |
| XCLK／SDA／SCL | 10／40／39 |
| D0〜D7 | 15／17／18／16／14／12／11／48 |
| VSYNC／HREF／PCLK | 38／47／13 |
| PWDN／RESET | 未接続（-1） |

端子配置の参照: [Seeedメーカー資料](https://wiki.seeedstudio.com/xiao_esp32s3_camera_usage/)。
**OPI PSRAMを有効**にします。無効時やカメラ初期化失敗時はHubへ登録せず、シリアルへ理由を表示します。
QVGA（320×240）JPEG・最大5フレーム/秒です。PSRAMの2フレームと固定の送信領域を使用します。
OV3660の場合にだけ垂直反転を設定します。装着方向は撮影して確認してください。
OV5640のオートフォーカスは実装していません。交換センサー対応を実機確認済みとは扱わないでください。

依存はWebSockets、ArduinoJsonとコア同梱のesp32-camera／mbedTLSです。
Wi-Fi設定は走行機とは別のスケッチフォルダーに用意します。
未作成の場合はexampleのプレースホルダーを使ってビルド可能ですが、そのままでは運用LANに接続できません。

```sh
arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32S3:PSRAM=opi firmware/camera_xiao_s3
```

XIAO ESP32S3はClassic Bluetooth非対応です。走行機のClassic BTフォールバックとは別です。
長時間配信時は温度・電源安定性も確認してください。SD保存・HTTPカメラサーバーは今回の対象外です。

## 実機受け入れ

ビルド成功は配線・電源・センサー・通信品質の実機保証ではありません。
書き込み前にボード／ポート／フラッシュ容量を確認し、車輪を浮かせてください。
自動アップロードは行いません。

1. 走行機のみで前後・左右・停止、1.5秒途絶停止、LCD表示を確認します。
2. 必要なBLE／SPP構成でも接続・停止を確認します。
3. XIAOのPSRAM・センサーPID・Wi-Fi接続を確認し、単発撮影から試します。
4. Fleetで割当し、ライブ表示・配信停止・カメラ電源断の警告を確認します。
5. カメラ断では走行可能、走行機の通信断では停止することを別々に確認します。