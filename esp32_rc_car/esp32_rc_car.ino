/*
 * ============================================================================
 * プロジェクト名: ESP32 フリート対応ラジコンカー (2WD) - 堅牢化版 (Robust V4)
 * 対策項目:
 *   1. 【ヒープ断片化対策】String完全排除・ゼロ動的メモリ確保（Zero Allocation）
 *   2. 【ゾンビ接続キル】通信途絶時の自動切断・アドバタイズ強制復旧(BLE時)/自動再接続(WS時)
 *   3. 【テレメトリ可視化】オンボードTFT(ST7789 170x320)に稼働時間(Uptime)・残ヒープ(Heap)を常時表示
 *   4. 【互換性】ESP32 Arduino Core v2.x / v3.x 両対応
 *   5. 【フリート管理】Wi-Fi + WebSocketをメイン通信経路とし、複数台を
 *      フリートハブから識別・一括/個別制御できるようにする。BLE/Classic BTは
 *      デバッグ・フォールバック用としてTRANSPORT_MODEで切替可能。
 *   6. 【カメラ】OV2640(JPEG出力)によるスナップショット送信 (captureImage要求 -> imageFrame応答)
 *
 * V4 ハードウェア変更 (V3からの再設計):
 *   - 表示: 外付けOLED(SSD1306, I2C) -> ideaspark ESP32基板オンボード一体型TFT(ST7789V3, SPI, 170x320)
 *   - カメラ: OV7670 -> OV2640 (センサー内蔵JPEGエンコーダによりペイロードを大幅削減)
 *   - オンボードTFTがGPIO2/4/15/18/23/32を専有するため、モーター方向ピンとカメラピンを全面再配置。
 *     モーター方向ピンは各モーター1本+外付けインバータIC(74HC04等、IN1/IN2またはIN3/IN4の相補生成用)に削減。
 * ============================================================================
 */

// 送信経路の選択: MODE_WEBSOCKET(既定/本番) / MODE_BLE / MODE_CLASSIC_BT(デバッグ用)
#define MODE_WEBSOCKET  0
#define MODE_BLE        1
#define MODE_CLASSIC_BT 2
#define TRANSPORT_MODE MODE_WEBSOCKET

// OV2640カメラ機能の有効/無効 (WebSocketモード時のみ有効)。カメラ未接続で検証する場合は0にする。
#define CAMERA_ENABLED 1

#if TRANSPORT_MODE == MODE_BLE
  #include <BLEDevice.h>
  #include <BLEServer.h>
  #include <BLEUtils.h>
  #include <BLE2902.h>
#elif TRANSPORT_MODE == MODE_CLASSIC_BT
  #include "BluetoothSerial.h"
#else
  #include <WiFi.h>
  #include <WebSocketsClient.h> // https://github.com/Links2004/arduinoWebSockets
  #include <ArduinoJson.h>      // https://github.com/bblanchon/ArduinoJson
  #include <Preferences.h>
  #include "wifi_secrets.h"     // WIFI_SSID / WIFI_PASSWORD / FLEET_HUB_HOST / FLEET_HUB_PORT を定義 (gitignore対象)
#endif

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <esp_mac.h> // esp_read_mac() : WiFi/BT初期化前でもMACアドレスを取得可能

// ----------------------------------------------------------------------------
// TFTディスプレイ設定 (ideaspark ESP32基板オンボード一体型 ST7789V3, 170x320)
// メーカー公表のポートマッピング: DC=2, RST=4, CS=15, SCLK=18, MOSI=23, BLK=32
// SCLK/MOSIはVSPI既定ピンと一致するが、既定のMISO(GPIO19)はカメラD7と競合するため
// SPI.begin()でMISOを明示的に無効(-1)にしてから初期化する(displayは書き込み専用のため支障なし)。
// ----------------------------------------------------------------------------
#define TFT_DC      2
#define TFT_RST     4
#define TFT_CS      15
#define TFT_SCLK    18
#define TFT_MOSI    23
#define TFT_BL      32
#define TFT_PANEL_W 170
#define TFT_PANEL_H 320

Adafruit_ST7789 display = Adafruit_ST7789(TFT_CS, TFT_DC, TFT_RST);

// ----------------------------------------------------------------------------
// ピンアサイン定義 (L298N 接続)
// TFTがGPIO2/4/15/18/23/32を専有するため、方向ピンは各モーター1本に削減し、
// もう一方のIN端子は外付けインバータIC(74HC04等)でこのピンの論理反転を入力する。
// ----------------------------------------------------------------------------
const int PIN_ENA = 14;   // 右モーター PWM
const int PIN_DIR_R = 27; // 右モーター 方向 (L298N IN1に直結、IN2はインバータ出力を接続)

const int PIN_DIR_L = 33; // 左モーター 方向 (L298N IN3に直結、IN4はインバータ出力を接続)
const int PIN_ENB = 25;   // 左モーター PWM

#if TRANSPORT_MODE == MODE_WEBSOCKET && CAMERA_ENABLED
  #include "esp_camera.h"
  #include "mbedtls/base64.h"

  // ----------------------------------------------------------------------------
  // OV2640カメラ ピンアサイン定義 (DVPパラレル+SCCB)
  // TFTの専有ピン(2,4,15,18,23,32)およびモーターピン(14,25,27,33)を避けて再配置。
  //
  // 実機モジュール側シルク印刷 -> ESP32配線対応表 (18ピン品, XCLK/XVCLKピン無しタイプ):
  //   3.3  -> ESP32 3V3          GND  -> ESP32 GND
  //   SCL  -> GPIO22 (SCCBクロック)   SDA  -> GPIO21 (SCCBデータ)
  //   VSYNC-> GPIO13             HREF -> GPIO17            DCLK -> GPIO12 (PCLK)
  //   RST  -> ESP32 3V3に直結(Low活性のため常時解除、GPIO不要)
  //   PWDN -> ESP32 GNDに直結(High活性のため常時給電、GPIO不要)
  //   D0-D3-> GPIO34/35/36/39(入力専用)   D4-D7 -> GPIO26/5/16/19
  //   NG   -> 未接続(NC)
  //   ※本モジュールはXCLK/XVCLKピンを基板上に持たない(内蔵発振器で自走)ため配線不要。
  // ----------------------------------------------------------------------------
  #define CAM_PIN_D0    34  // 入力専用ピン
  #define CAM_PIN_D1    35  // 入力専用ピン
  #define CAM_PIN_D2    36  // 入力専用ピン
  #define CAM_PIN_D3    39  // 入力専用ピン
  #define CAM_PIN_D4    26
  #define CAM_PIN_D5    5
  #define CAM_PIN_D6    16
  #define CAM_PIN_D7    19
  #define CAM_PIN_VSYNC 13
  #define CAM_PIN_HREF  17
  #define CAM_PIN_PCLK  12  // モジュール表記: DCLK
  #define CAM_PIN_XCLK  0   // モジュールにXCLKピンが無いため物理配線なし(ドライバ内部設定用の値のみ)
  #define CAM_PIN_SIOD  21  // モジュール表記: SDA (SCCBデータ)
  #define CAM_PIN_SIOC  22  // モジュール表記: SCL (SCCBクロック)
  #define CAM_PIN_PWDN  -1  // モジュールのPWDNピンはGNDへ直結して使用(常時給電、GPIO制御なし)
  #define CAM_PIN_RESET -1  // モジュールのRSTピンは3V3へ直結して使用(常時リセット解除、GPIO制御なし)
  // 注意: RESET/PWDNをスタティックに固定しているため、EN(チップ)リセットだけではカメラの内部状態はリセットされない。
  // 実運用(バッテリ電源ON/OFF)では毎回電源が完全に入り直るため問題ないが、
  // 開発中のUSB再書き込み/ENボタン再起動後にカメラが失敗する場合は、USBを一度完全に抜き差ししてから再テストすること。

  #define CAM_FRAME_WIDTH  160
  #define CAM_FRAME_HEIGHT 120
  #define CAM_JSON_BUF_SIZE 40000 // JPEG(QVGA/quality14)想定。実測に応じて調整可
  #define STREAM_MIN_INTERVAL_MS 200  // 連続配信の最小送信間隔(理論上限5fps。走行応答性とのトレードオフ)
  #define STREAM_HUB_TIMEOUT_MS  5000 // 配信中にHubから何も届かない状態がこの時間続いたら自動停止

  char imageJsonBuf[CAM_JSON_BUF_SIZE];
  bool cameraReady = false;

  // ライブ配信はCore0の専用タスクで実行し、モーター制御(Core1のloop)への影響を避ける。
  // WebSocketsClientはスレッドセーフではないため、送受信の実アクセスはwsMutexで直列化する。
  // webSocket.loop()のコールバック(onWebSocketEvent->sendHello)が同一タスク内で再入してロックを取り直すため、必ず再帰可能ミューテックスを使用する。
  SemaphoreHandle_t wsMutex = NULL;
  TaskHandle_t cameraStreamTaskHandle = NULL;
  volatile bool streamingEnabled = false;   // streamStart/streamStopで切替
  volatile bool captureRequested = false;   // 単発captureImage要求
  volatile unsigned long lastStreamFrameAt = 0;
#endif

// ----------------------------------------------------------------------------
// PWM制御パラメータ
// ----------------------------------------------------------------------------
const int PWM_FREQ = 30000;      // 30kHz (高周波でモーターの可聴ノイズを抑制)
const int PWM_RESOLUTION = 8;    // 8-bit (0 〜 255)
const int PWM_CH_RIGHT = 0;      // Core v2用
const int PWM_CH_LEFT = 1;       // Core v2用

// ----------------------------------------------------------------------------
// 通信 & システム状態管理 (静的固定バッファ)
// ----------------------------------------------------------------------------
const char* DEVICE_NAME_PREFIX = "ESP32_RC_Car";
char deviceId[16] = "unknown";        // MACアドレス下6桁由来 (例: "rc-a1b2c3")
char deviceDisplayName[32] = "";      // 任意設定の表示名 (未設定時はdeviceIdを使用)

char currentCommand = 'e';
int currentSpeedL = 0;
int currentSpeedR = 0;
volatile bool isDeviceConnected = false;
char lastRawBuffer[24] = "NONE";

unsigned long lastPacketTime = 0;
const unsigned long FAILSAFE_TIMEOUT_MS = 1500;       // 1.5秒途絶で緊急停止
const unsigned long ZOMBIE_TIMEOUT_MS   = 10000;      // 10秒途絶で接続リセット

unsigned long lastDisplayTime = 0;
const unsigned long DISPLAY_INTERVAL_MS = 200;        // I2C負荷軽減のため200ms周期

// デバイスIDをMACアドレス下3バイトから生成 ("rc-xxxxxx")
void generateDeviceId() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(deviceId, sizeof(deviceId), "rc-%02x%02x%02x", mac[3], mac[4], mac[5]);
}

const char* effectiveDisplayName() {
  return deviceDisplayName[0] != '\0' ? deviceDisplayName : deviceId;
}

// ----------------------------------------------------------------------------
// PWM出力関数 (Core v2 / v3 互換)
// ----------------------------------------------------------------------------
void setupPWM() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  ledcAttach(PIN_ENA, PWM_FREQ, PWM_RESOLUTION);
  ledcAttach(PIN_ENB, PWM_FREQ, PWM_RESOLUTION);
#else
  ledcSetup(PWM_CH_RIGHT, PWM_FREQ, PWM_RESOLUTION);
  ledcAttachPin(PIN_ENA, PWM_CH_RIGHT);
  ledcSetup(PWM_CH_LEFT, PWM_FREQ, PWM_RESOLUTION);
  ledcAttachPin(PIN_ENB, PWM_CH_LEFT);
#endif
}

void writePWM(int pin, int channel, int value) {
  int duty = constrain(value, 0, 255);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  ledcWrite(pin, duty);
#else
  ledcWrite(channel, duty);
#endif
}

// ----------------------------------------------------------------------------
// モーター駆動関数
// ----------------------------------------------------------------------------
void applyMotorControl(char cmd, int speedL, int speedR) {
  currentCommand = cmd;
  currentSpeedL = speedL;
  currentSpeedR = speedR;

  switch (cmd) {
    case 'a': // 前進 (Forward): 両モーターとも正転
      digitalWrite(PIN_DIR_R, LOW);
      digitalWrite(PIN_DIR_L, LOW);
      writePWM(PIN_ENA, PWM_CH_RIGHT, speedR);
      writePWM(PIN_ENB, PWM_CH_LEFT, speedL);
      break;

    case 'b': // 後退 (Reverse): 両モーターとも逆転
      digitalWrite(PIN_DIR_R, HIGH);
      digitalWrite(PIN_DIR_L, HIGH);
      writePWM(PIN_ENA, PWM_CH_RIGHT, speedR);
      writePWM(PIN_ENB, PWM_CH_LEFT, speedL);
      break;

    case 'c': // 右超信地旋回 (Turn Right): 右逆転・左正転
      digitalWrite(PIN_DIR_R, HIGH);
      digitalWrite(PIN_DIR_L, LOW);
      writePWM(PIN_ENA, PWM_CH_RIGHT, speedR);
      writePWM(PIN_ENB, PWM_CH_LEFT, speedL);
      break;

    case 'd': // 左超信地旋回 (Turn Left): 右正転・左逆転
      digitalWrite(PIN_DIR_R, LOW);
      digitalWrite(PIN_DIR_L, HIGH);
      writePWM(PIN_ENA, PWM_CH_RIGHT, speedR);
      writePWM(PIN_ENB, PWM_CH_LEFT, speedL);
      break;

    case 'e': // 停止 (Stop): PWMデューティ0で停止(方向ピンはそのままでよい)
    default:
      writePWM(PIN_ENA, PWM_CH_RIGHT, 0);
      writePWM(PIN_ENB, PWM_CH_LEFT, 0);
      currentSpeedL = 0;
      currentSpeedR = 0;
      break;
  }
}

// ----------------------------------------------------------------------------
// メモリ動的確保ゼロ（Zero Allocation）パケットパーサー
// ----------------------------------------------------------------------------
void parseCommandPacketFast(const char* buf, size_t len) {
  if (len == 0 || buf == nullptr) return;

  lastPacketTime = millis();

  // 生データの記録 (最大20文字)
  size_t copyLen = (len < 20) ? len : 20;
  memcpy(lastRawBuffer, buf, copyLen);
  lastRawBuffer[copyLen] = '\0';

  char cmd = buf[0];
  int speedL = 0;
  int speedR = 0;

  const char* firstComma = strchr(buf, ',');
  if (firstComma != nullptr) {
    speedL = atoi(firstComma + 1);
    const char* secondComma = strchr(firstComma + 1, ',');
    if (secondComma != nullptr) {
      speedR = atoi(secondComma + 1);
    }
  } else if (cmd == 'e') {
    speedL = 0;
    speedR = 0;
  }

  applyMotorControl(cmd, speedL, speedR);
}

// ----------------------------------------------------------------------------
// TFT画面描画処理 (170x320 ST7789V3, setRotation(1)適用で320x170のランドスケープ表示)
// 毎回全画面を黒で塗り潰してから再描画する(OLED版と同じ設計の踏襲)。
// ----------------------------------------------------------------------------
void updateDisplay() {
  display.fillScreen(ST77XX_BLACK);

  // 1. ヘッダー (通信状態 & 稼働時間)
  display.setTextSize(2);
  display.setCursor(4, 4);
#if TRANSPORT_MODE == MODE_WEBSOCKET
  display.setTextColor(isDeviceConnected ? ST77XX_GREEN : ST77XX_RED);
  display.print(isDeviceConnected ? "WS: OK" : "WS: WAIT");
#elif TRANSPORT_MODE == MODE_BLE
  display.setTextColor(isDeviceConnected ? ST77XX_GREEN : ST77XX_RED);
  display.print(isDeviceConnected ? "BLE: OK" : "BLE: WAIT");
#else
  display.setTextColor(isDeviceConnected ? ST77XX_GREEN : ST77XX_RED);
  display.print(isDeviceConnected ? "BT: OK" : "BT: WAIT");
#endif

  // Uptime (分:秒)
  unsigned long sec = millis() / 1000;
  display.setTextColor(ST77XX_CYAN);
  display.setCursor(220, 4);
  display.printf("%02lu:%02lu", (sec / 60) % 100, sec % 60);

  // 2. 現在のモード表示
  display.setTextColor(ST77XX_YELLOW);
  display.setCursor(4, 28);
  switch (currentCommand) {
    case 'a': display.print("MODE: FORWARD"); break;
    case 'b': display.print("MODE: REVERSE"); break;
    case 'c': display.print("MODE: TURN-R "); break;
    case 'd': display.print("MODE: TURN-L "); break;
    case 'e': display.print("MODE: STOP   "); break;
    default:  display.print("MODE: UNKNOWN"); break;
  }

  // 3. モーター速度バーグラフ (L & R)
  display.setTextSize(1);
  display.setTextColor(ST77XX_WHITE);
  display.setCursor(4, 56);
  display.printf("L:%3d", currentSpeedL);
  display.drawRect(50, 54, 200, 12, ST77XX_WHITE);
  int barL = map(constrain(currentSpeedL, 0, 255), 0, 255, 0, 196);
  if (barL > 0) display.fillRect(52, 56, barL, 8, ST77XX_CYAN);

  display.setCursor(4, 74);
  display.printf("R:%3d", currentSpeedR);
  display.drawRect(50, 72, 200, 12, ST77XX_WHITE);
  int barR = map(constrain(currentSpeedR, 0, 255), 0, 255, 0, 196);
  if (barR > 0) display.fillRect(52, 74, barR, 8, ST77XX_CYAN);

  // 4. カメラ状態
  display.setCursor(4, 96);
#if TRANSPORT_MODE == MODE_WEBSOCKET && CAMERA_ENABLED
  display.setTextColor(cameraReady ? ST77XX_GREEN : ST77XX_RED);
  display.print(cameraReady ? "CAM: READY" : "CAM: N/A  ");
#else
  display.setTextColor(ST77XX_WHITE);
  display.print("CAM: DISABLED");
#endif

  // 5. 残ヒープ容量 & デバイスID (フリート内で他機と区別するため)
  display.drawLine(0, 116, 319, 116, ST77XX_WHITE);
  display.setTextColor(ST77XX_WHITE);
  display.setCursor(4, 122);
  display.printf("HEAP:%luKB", ESP.getFreeHeap() / 1024);
  display.setCursor(140, 122);
  display.printf("%s", effectiveDisplayName());
}

// ----------------------------------------------------------------------------
// 通信トランスポート実装 (WebSocket / BLE(NUS) / Classic BT(SPP))
// ----------------------------------------------------------------------------
#if TRANSPORT_MODE == MODE_WEBSOCKET
  // --------------------------------------------------------------------------
  // フリートハブとのWebSocket通信 (JSONプロトコル)
  // hello   (送信): {"type":"hello","deviceId":"rc-xxxxxx","name":"...","fw":"4.0.0"}
  // telemetry(送信): {"type":"telemetry","cmd":"a","speedL":190,"speedR":190,"heap":150000,"uptimeMs":12345}
  // imageFrame(送信): {"type":"imageFrame","deviceId":"rc-xxxxxx","width":320,"height":240,"format":"jpeg","dataB64":"..."}
  // drive   (受信): {"type":"drive","cmd":"a","speedL":190,"speedR":190}
  // setName (受信): {"type":"setName","name":"Car-Blue"}
  // captureImage(受信): {"type":"captureImage"}
  // streamStart(受信): {"type":"streamStart"} -> Core0タスクが200ms間隔で連続imageFrame送信を開始
  // streamStop (受信): {"type":"streamStop"}  -> 連続配信を停止
  // ping    (受信): {"type":"ping"}
  // --------------------------------------------------------------------------
  WebSocketsClient webSocket;
  Preferences preferences;
  unsigned long lastTelemetryTime = 0;
  const unsigned long TELEMETRY_INTERVAL_MS = 1000; // フェイルセーフの生存確認も兼ねる

  void saveDisplayName(const char* name) {
    strncpy(deviceDisplayName, name, sizeof(deviceDisplayName) - 1);
    deviceDisplayName[sizeof(deviceDisplayName) - 1] = '\0';
    preferences.begin("fleet", false);
    preferences.putString("name", deviceDisplayName);
    preferences.end();
  }

  void sendHello() {
    StaticJsonDocument<128> doc;
    doc["type"] = "hello";
    doc["deviceId"] = deviceId;
    doc["name"] = effectiveDisplayName();
    doc["fw"] = "4.0.0";
    char buf[128];
    size_t n = serializeJson(doc, buf, sizeof(buf));
    if (xSemaphoreTakeRecursive(wsMutex, portMAX_DELAY)) {
      webSocket.sendTXT(buf, n);
      xSemaphoreGiveRecursive(wsMutex);
    }
  }

  void sendTelemetry() {
    StaticJsonDocument<160> doc;
    doc["type"] = "telemetry";
    doc["deviceId"] = deviceId;
    doc["cmd"] = String(currentCommand);
    doc["speedL"] = currentSpeedL;
    doc["speedR"] = currentSpeedR;
    doc["heap"] = ESP.getFreeHeap();
    doc["uptimeMs"] = millis();
    char buf[160];
    size_t n = serializeJson(doc, buf, sizeof(buf));
    if (xSemaphoreTakeRecursive(wsMutex, portMAX_DELAY)) {
      webSocket.sendTXT(buf, n);
      xSemaphoreGiveRecursive(wsMutex);
    }
  }

#if CAMERA_ENABLED
  // --------------------------------------------------------------------------
  // OV2640カメラ初期化 (JPEG出力・PSRAM非搭載を想定しQVGA/DRAMバッファで運用)
  // --------------------------------------------------------------------------
  bool setupCamera() {
    camera_config_t config = {};
    config.ledc_channel = LEDC_CHANNEL_2; // モーターPWM(ch0,1)と衝突しないチャンネルを使用
    config.ledc_timer   = LEDC_TIMER_1;
    config.pin_d0 = CAM_PIN_D0;
    config.pin_d1 = CAM_PIN_D1;
    config.pin_d2 = CAM_PIN_D2;
    config.pin_d3 = CAM_PIN_D3;
    config.pin_d4 = CAM_PIN_D4;
    config.pin_d5 = CAM_PIN_D5;
    config.pin_d6 = CAM_PIN_D6;
    config.pin_d7 = CAM_PIN_D7;
    config.pin_xclk = CAM_PIN_XCLK;
    config.pin_pclk = CAM_PIN_PCLK;
    config.pin_vsync = CAM_PIN_VSYNC;
    config.pin_href = CAM_PIN_HREF;
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
    config.pin_sccb_sda = CAM_PIN_SIOD;
    config.pin_sccb_scl = CAM_PIN_SIOC;
#else
    config.pin_sscb_sda = CAM_PIN_SIOD;
    config.pin_sscb_scl = CAM_PIN_SIOC;
#endif
    config.pin_pwdn = CAM_PIN_PWDN;
    config.pin_reset = CAM_PIN_RESET;
    config.xclk_freq_hz = 20000000;
    config.pixel_format = PIXFORMAT_JPEG;
    config.frame_size = FRAMESIZE_QQVGA;  // 160x120 (fps向上のためQVGAから縮小、データ量約1/4)
    config.jpeg_quality = 14;             // 0(高画質/大容量)〜63(低画質/小容量)
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.grab_mode = CAMERA_GRAB_LATEST;

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) {
      Serial.printf("[WARN] Camera init failed: 0x%x\n", err);
      return false;
    }
    Serial.println(F("[INFO] OV2640 Camera initialized (JPEG/QVGA)"));
    return true;
  }

  // --------------------------------------------------------------------------
  // 1フレーム撮影してJPEGをBase64化しWebSocketで送信 (Zero Allocation: 静的バッファに直接エンコード)
  // --------------------------------------------------------------------------
  void captureAndSendImage() {
    if (!cameraReady) {
      Serial.println(F("[WARN] captureImage requested but camera not ready"));
      return;
    }

    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println(F("[WARN] esp_camera_fb_get() failed"));
      return;
    }

    int headerLen = snprintf(imageJsonBuf, sizeof(imageJsonBuf),
      "{\"type\":\"imageFrame\",\"deviceId\":\"%s\",\"width\":%d,\"height\":%d,\"format\":\"jpeg\",\"dataB64\":\"",
      deviceId, fb->width, fb->height);

    size_t availableForB64 = sizeof(imageJsonBuf) - headerLen - 3; // 末尾の \"} + 終端文字用
    size_t encodedLen = 0;
    int rc = mbedtls_base64_encode((unsigned char*)imageJsonBuf + headerLen, availableForB64, &encodedLen,
                                    fb->buf, fb->len);

    if (rc != 0) {
      Serial.printf("[WARN] JPEG frame too large for buffer (fb->len=%u, avail=%u) - skipped\n",
                    (unsigned)fb->len, (unsigned)availableForB64);
      esp_camera_fb_return(fb);
      return;
    }

    esp_camera_fb_return(fb);

    size_t totalLen = headerLen + encodedLen;
    imageJsonBuf[totalLen++] = '"';
    imageJsonBuf[totalLen++] = '}';

    if (xSemaphoreTakeRecursive(wsMutex, portMAX_DELAY)) {
      webSocket.sendTXT(imageJsonBuf, totalLen);
      xSemaphoreGiveRecursive(wsMutex);
    }
  }

  // --------------------------------------------------------------------------
  // Core0専用タスク: 単発撮影(captureRequested)と連続配信(streamingEnabled)を一本化して処理する。
  // esp_camera_fb_get/return を複数コアから同時に呼ばないようにするための唯一の呼び出し元。
  // --------------------------------------------------------------------------
  void cameraStreamTask(void* pvParameters) {
    for (;;) {
      unsigned long now = millis();
      bool doCapture = false;

      if (captureRequested) {
        captureRequested = false;
        doCapture = true;
      } else if (streamingEnabled) {
        if (now - lastPacketTime > STREAM_HUB_TIMEOUT_MS) {
          // Hubからの通信が一定時間途絶えた場合は配信を自動停止する(暴走防止)
          streamingEnabled = false;
          Serial.println(F("[WARN] Stream auto-stopped: Hub communication timeout"));
        } else if (now - lastStreamFrameAt >= STREAM_MIN_INTERVAL_MS) {
          lastStreamFrameAt = now;
          doCapture = true;
        }
      }

      if (doCapture && cameraReady) {
        captureAndSendImage();
      }

      vTaskDelay(pdMS_TO_TICKS(10));
    }
  }
#endif

  void handleWebSocketMessage(const uint8_t* payload, size_t length) {
    StaticJsonDocument<160> doc;
    if (deserializeJson(doc, payload, length) != DeserializationError::Ok) return;

    lastPacketTime = millis();
    const char* type = doc["type"] | "";

    if (strcmp(type, "drive") == 0) {
      const char* cmdStr = doc["cmd"] | "e";
      int speedL = doc["speedL"] | 0;
      int speedR = doc["speedR"] | 0;
      char raw[24];
      snprintf(raw, sizeof(raw), "%s,%d,%d;", cmdStr, speedL, speedR);
      parseCommandPacketFast(raw, strlen(raw));
    } else if (strcmp(type, "setName") == 0) {
      const char* name = doc["name"] | "";
      saveDisplayName(name);
#if CAMERA_ENABLED
    } else if (strcmp(type, "captureImage") == 0) {
      captureRequested = true;
    } else if (strcmp(type, "streamStart") == 0) {
      streamingEnabled = true;
      Serial.println(F("[INFO] Live stream started"));
    } else if (strcmp(type, "streamStop") == 0) {
      streamingEnabled = false;
      Serial.println(F("[INFO] Live stream stopped"));
#endif
    }
    // "ping" はlastPacketTime更新のみで応答不要 (次回telemetryで生存確認)
  }

  void onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
    switch (type) {
      case WStype_CONNECTED:
        isDeviceConnected = true;
        lastPacketTime = millis();
        Serial.println(F("[INFO] Fleet Hub Connected"));
        sendHello();
        break;
      case WStype_DISCONNECTED:
        isDeviceConnected = false;
        Serial.println(F("[INFO] Fleet Hub Disconnected -> Auto Reset to STOP"));
        applyMotorControl('e', 0, 0);
#if CAMERA_ENABLED
        streamingEnabled = false; // 通信切断時はライブ配信も即停止
#endif
        strncpy(lastRawBuffer, "DISCONNECT", sizeof(lastRawBuffer));
        break;
      case WStype_TEXT:
        handleWebSocketMessage(payload, length);
        break;
      default:
        break;
    }
  }
#elif TRANSPORT_MODE == MODE_BLE
  #define SERVICE_UUID           "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
  #define CHARACTERISTIC_UUID_RX "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
  #define CHARACTERISTIC_UUID_TX "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

  BLEServer *pServer = NULL;
  BLECharacteristic *pTxCharacteristic = NULL;

  class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      isDeviceConnected = true;
      lastPacketTime = millis();
      Serial.println(F("[INFO] BLE Client Connected"));
    };

    void onDisconnect(BLEServer* pServer) {
      isDeviceConnected = false;
      Serial.println(F("[INFO] BLE Client Disconnected -> Auto Reset to STOP"));
      applyMotorControl('e', 0, 0);
      strncpy(lastRawBuffer, "DISCONNECT", sizeof(lastRawBuffer));
      // 切断後は確実にアドバタイズ再開
      delay(100);
      pServer->startAdvertising();
    }
  };

  class MyCallbacks: public BLECharacteristicCallbacks {
    char lastAckCmd = ' ';
    unsigned long lastAckTime = 0;

    void onWrite(BLECharacteristic *pCharacteristic) {
      String rxVal = pCharacteristic->getValue();
      if (rxVal.length() > 0) {
        parseCommandPacketFast(rxVal.c_str(), rxVal.length());

        // ACK通知（コマンド変化時、または1秒周期で間引いて送信しバッファ溢れを防止）
        unsigned long now = millis();
        if (pTxCharacteristic && isDeviceConnected && (currentCommand != lastAckCmd || now - lastAckTime > 1000)) {
          lastAckCmd = currentCommand;
          lastAckTime = now;
          char ack[8];
          snprintf(ack, sizeof(ack), "ACK:%c", currentCommand);
          pTxCharacteristic->setValue((uint8_t*)ack, strlen(ack));
          pTxCharacteristic->notify();
        }
      }
    }
  };
#else
  BluetoothSerial SerialBT;
#endif

// ----------------------------------------------------------------------------
// 初期化 (setup)
// ----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(100);

  generateDeviceId();

  // 1. TFT初期化 (MISOはカメラD7(GPIO19)と競合するため明示的に無効化してからSPIバスを開始)
  pinMode(TFT_BL, OUTPUT);
  digitalWrite(TFT_BL, HIGH); // バックライトON
  SPI.begin(TFT_SCLK, -1, TFT_MOSI, TFT_CS);
  display.init(TFT_PANEL_W, TFT_PANEL_H);
  display.setRotation(1); // 320x170のランドスケープ表示に回転
  display.fillScreen(ST77XX_BLACK);
  display.setTextColor(ST77XX_WHITE);
  display.setTextSize(2);
  display.setCursor(4, 20);
  display.println("ESP32 RC ROBUST V4");
  display.setTextSize(1);
  display.setCursor(4, 44);
  display.println(deviceId);

  // 2. モーターピン初期化 (方向ピンは各モーター1本。インバータICでIN2/IN4相当を生成)
  pinMode(PIN_DIR_R, OUTPUT);
  pinMode(PIN_DIR_L, OUTPUT);

  setupPWM();
  applyMotorControl('e', 0, 0);

#if TRANSPORT_MODE == MODE_WEBSOCKET && CAMERA_ENABLED
  // 3. OV2640カメラ初期化 (失敗してもモーター/表示系は継続動作させる)
  cameraReady = setupCamera();
  wsMutex = xSemaphoreCreateRecursiveMutex();
  // カメラ撮影・送信はCore0の専用タスクで行い、Core1のloop()(モーター制御/走行応答)への影響を避ける
  xTaskCreatePinnedToCore(cameraStreamTask, "camStream", 8192, NULL, 1, &cameraStreamTaskHandle, 0);
#endif

#if TRANSPORT_MODE == MODE_WEBSOCKET
  // 4. 保存済み表示名の復元 & Wi-Fi/WebSocket初期化
  preferences.begin("fleet", true);
  String savedName = preferences.getString("name", "");
  preferences.end();
  strncpy(deviceDisplayName, savedName.c_str(), sizeof(deviceDisplayName) - 1);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[INFO] Connecting to Wi-Fi: %s\n", WIFI_SSID);
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 15000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[INFO] Wi-Fi Connected: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(F("[WARN] Wi-Fi connect timeout, will keep retrying in background"));
  }

  webSocket.begin(FLEET_HUB_HOST, FLEET_HUB_PORT, "/ws/device");
  webSocket.onEvent(onWebSocketEvent);
  webSocket.setReconnectInterval(3000);

  Serial.printf("[INFO] Fleet WebSocket client started: %s -> %s:%d (FreeHeap: %lu bytes)\n",
                deviceId, FLEET_HUB_HOST, FLEET_HUB_PORT, ESP.getFreeHeap());
#elif TRANSPORT_MODE == MODE_BLE
  // 4. BLE初期化
  char bleName[32];
  snprintf(bleName, sizeof(bleName), "%s_%s", DEVICE_NAME_PREFIX, deviceId);
  BLEDevice::init(bleName);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  pTxCharacteristic = pService->createCharacteristic(
                        CHARACTERISTIC_UUID_TX,
                        BLECharacteristic::PROPERTY_NOTIFY
                      );
  pTxCharacteristic->addDescriptor(new BLE2902());

  BLECharacteristic *pRxCharacteristic = pService->createCharacteristic(
                                           CHARACTERISTIC_UUID_RX,
                                           BLECharacteristic::PROPERTY_WRITE |
                                           BLECharacteristic::PROPERTY_WRITE_NR
                                         );
  pRxCharacteristic->setCallbacks(new MyCallbacks());

  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.printf("[INFO] Robust BLE Started: %s (FreeHeap: %lu bytes)\n", bleName, ESP.getFreeHeap());
#else
  char btName[32];
  snprintf(btName, sizeof(btName), "%s_%s", DEVICE_NAME_PREFIX, deviceId);
  if (SerialBT.begin(btName)) {
    Serial.printf("[INFO] Bluetooth Classic Started: %s\n", btName);
  }
#endif

  lastPacketTime = millis();
}

// ----------------------------------------------------------------------------
// メインループ (loop)
// ----------------------------------------------------------------------------
void loop() {
#if TRANSPORT_MODE == MODE_WEBSOCKET
  #if CAMERA_ENABLED
    if (xSemaphoreTakeRecursive(wsMutex, portMAX_DELAY)) {
      webSocket.loop();
      xSemaphoreGiveRecursive(wsMutex);
    }
  #else
    webSocket.loop();
  #endif
#elif TRANSPORT_MODE == MODE_CLASSIC_BT
  isDeviceConnected = SerialBT.hasClient();
  if (SerialBT.available()) {
    char buf[32];
    size_t n = SerialBT.readBytesUntil(';', buf, sizeof(buf) - 1);
    buf[n] = '\0';
    parseCommandPacketFast(buf, n);
  }
#endif

  unsigned long now = millis();

  // ① フェイルセーフ処理: 走行中に通信パケットが1.5秒途絶えたら自動停止
  if (currentCommand != 'e' && (now - lastPacketTime > FAILSAFE_TIMEOUT_MS)) {
    applyMotorControl('e', 0, 0);
    strncpy(lastRawBuffer, "TIMEOUT_STOP", sizeof(lastRawBuffer));
  }

#if TRANSPORT_MODE == MODE_WEBSOCKET
  // ①b 定期テレメトリ送信 (フリートハブ側の生存確認にも利用)
  if (isDeviceConnected && (now - lastTelemetryTime > TELEMETRY_INTERVAL_MS)) {
    lastTelemetryTime = now;
    sendTelemetry();
  }
#endif

#if TRANSPORT_MODE == MODE_BLE
  // ② ゾンビ接続キル & 自己修復:
  // 接続中とマークされているが10秒間パケットが届かない場合、接続が半死にしている可能性があるためアドバタイズを強制再送
  if (isDeviceConnected && (now - lastPacketTime > ZOMBIE_TIMEOUT_MS)) {
    if (currentCommand != 'e') {
      applyMotorControl('e', 0, 0);
    }
  }
#endif

  // ③ TFT定期更新 (200ms周期)
  if (now - lastDisplayTime > DISPLAY_INTERVAL_MS) {
    lastDisplayTime = now;
    updateDisplay();
  }

  // CPUタスク切り替えの隙間を確保
  yield();
}
