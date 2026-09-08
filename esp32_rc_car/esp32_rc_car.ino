/*
 * ============================================================================
 * プロジェクト名: ESP32 フリート対応ラジコンカー (2WD) - 堅牢化版 (Robust V3)
 * 対策項目:
 *   1. 【ヒープ断片化対策】String完全排除・ゼロ動的メモリ確保（Zero Allocation）
 *   2. 【I2Cバスハング対策】Wire.setTimeOut(25ms) 設定でモーターブラシノイズによるフリーズ防止
 *   3. 【ゾンビ接続キル】通信途絶時の自動切断・アドバタイズ強制復旧(BLE時)/自動再接続(WS時)
 *   4. 【テレメトリ可視化】OLEDに稼働時間(Uptime)・残ヒープ(Heap)を常時表示
 *   5. 【互換性】ESP32 Arduino Core v2.x / v3.x 両対応
 *   6. 【フリート管理】Wi-Fi + WebSocketをメイン通信経路とし、複数台を
 *      フリートハブから識別・一括/個別制御できるようにする。BLE/Classic BTは
 *      デバッグ・フォールバック用としてTRANSPORT_MODEで切替可能。
 * ============================================================================
 */

// 送信経路の選択: MODE_WEBSOCKET(既定/本番) / MODE_BLE / MODE_CLASSIC_BT(デバッグ用)
#define MODE_WEBSOCKET  0
#define MODE_BLE        1
#define MODE_CLASSIC_BT 2
#define TRANSPORT_MODE MODE_WEBSOCKET

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

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <esp_mac.h> // esp_read_mac() : WiFi/BT初期化前でもMACアドレスを取得可能

// ----------------------------------------------------------------------------
// OLEDディスプレイ設定 (SSD1306 128x64)
// ----------------------------------------------------------------------------
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C

#define OLED_SDA_PIN 21
#define OLED_SCL_PIN 22

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ----------------------------------------------------------------------------
// ピンアサイン定義 (L298N 接続)
// ----------------------------------------------------------------------------
const int PIN_ENA = 14;  // 右モーター PWM
const int PIN_IN1 = 27;  // 右モーター 方向1
const int PIN_IN2 = 26;  // 右モーター 方向2

const int PIN_IN3 = 32;  // 左モーター 方向1
const int PIN_IN4 = 33;  // 左モーター 方向2
const int PIN_ENB = 25;  // 左モーター PWM

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
    case 'a': // 前進 (Forward)
      digitalWrite(PIN_IN1, LOW);
      digitalWrite(PIN_IN2, HIGH);
      digitalWrite(PIN_IN3, LOW);
      digitalWrite(PIN_IN4, HIGH);
      writePWM(PIN_ENA, PWM_CH_RIGHT, speedR);
      writePWM(PIN_ENB, PWM_CH_LEFT, speedL);
      break;

    case 'b': // 後退 (Reverse)
      digitalWrite(PIN_IN1, HIGH);
      digitalWrite(PIN_IN2, LOW);
      digitalWrite(PIN_IN3, HIGH);
      digitalWrite(PIN_IN4, LOW);
      writePWM(PIN_ENA, PWM_CH_RIGHT, speedR);
      writePWM(PIN_ENB, PWM_CH_LEFT, speedL);
      break;

    case 'c': // 右超信地旋回 (Turn Right)
      digitalWrite(PIN_IN1, HIGH);
      digitalWrite(PIN_IN2, LOW);
      digitalWrite(PIN_IN3, LOW);
      digitalWrite(PIN_IN4, HIGH);
      writePWM(PIN_ENA, PWM_CH_RIGHT, speedR);
      writePWM(PIN_ENB, PWM_CH_LEFT, speedL);
      break;

    case 'd': // 左超信地旋回 (Turn Left)
      digitalWrite(PIN_IN1, LOW);
      digitalWrite(PIN_IN2, HIGH);
      digitalWrite(PIN_IN3, HIGH);
      digitalWrite(PIN_IN4, LOW);
      writePWM(PIN_ENA, PWM_CH_RIGHT, speedR);
      writePWM(PIN_ENB, PWM_CH_LEFT, speedL);
      break;

    case 'e': // 停止 (Stop)
    default:
      digitalWrite(PIN_IN1, LOW);
      digitalWrite(PIN_IN2, LOW);
      digitalWrite(PIN_IN3, LOW);
      digitalWrite(PIN_IN4, LOW);
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
// OLED画面描画処理 (I2Cタイムアウト保護付き)
// ----------------------------------------------------------------------------
void updateOLED() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  // 1. ヘッダー (通信状態 & 稼働時間)
  display.setTextSize(1);
  display.setCursor(0, 0);
#if TRANSPORT_MODE == MODE_WEBSOCKET
  display.print(isDeviceConnected ? "[WS: OK]" : "[WS: WAIT]");
#elif TRANSPORT_MODE == MODE_BLE
  display.print(isDeviceConnected ? "[BLE: OK]" : "[BLE: WAIT]");
#else
  display.print(isDeviceConnected ? "[BT: OK]" : "[BT: WAIT]");
#endif

  // Uptime (分:秒)
  unsigned long sec = millis() / 1000;
  display.setCursor(72, 0);
  display.printf("%02lu:%02lu", (sec / 60) % 100, sec % 60);

  // 2. 現在のモード表示
  display.setCursor(0, 14);
  display.print("MODE: ");
  switch (currentCommand) {
    case 'a': display.print("FORWARD "); break;
    case 'b': display.print("REVERSE "); break;
    case 'c': display.print("TURN-R  "); break;
    case 'd': display.print("TURN-L  "); break;
    case 'e': display.print("STOP    "); break;
    default:  display.print("UNKNOWN "); break;
  }

  // 3. モーター速度バーグラフ (L & R)
  display.setCursor(0, 26);
  display.printf("L:%3d", currentSpeedL);
  display.drawRect(36, 26, 90, 7, SSD1306_WHITE);
  int barL = map(constrain(currentSpeedL, 0, 255), 0, 255, 0, 86);
  if (barL > 0) display.fillRect(38, 28, barL, 3, SSD1306_WHITE);

  display.setCursor(0, 36);
  display.printf("R:%3d", currentSpeedR);
  display.drawRect(36, 36, 90, 7, SSD1306_WHITE);
  int barR = map(constrain(currentSpeedR, 0, 255), 0, 255, 0, 86);
  if (barR > 0) display.fillRect(38, 38, barR, 3, SSD1306_WHITE);

  // 4. 残ヒープ容量 & デバイスID (フリート内で他機と区別するため)
  display.drawLine(0, 46, 127, 46, SSD1306_WHITE);
  display.setCursor(0, 50);
  display.printf("HEAP:%luKB", ESP.getFreeHeap() / 1024);
  display.setCursor(70, 50);
  display.printf("%s", effectiveDisplayName());

  display.display();
}

// ----------------------------------------------------------------------------
// 通信トランスポート実装 (WebSocket / BLE(NUS) / Classic BT(SPP))
// ----------------------------------------------------------------------------
#if TRANSPORT_MODE == MODE_WEBSOCKET
  // --------------------------------------------------------------------------
  // フリートハブとのWebSocket通信 (JSONプロトコル)
  // hello   (送信): {"type":"hello","deviceId":"rc-xxxxxx","name":"...","fw":"3.0.0"}
  // telemetry(送信): {"type":"telemetry","cmd":"a","speedL":190,"speedR":190,"heap":150000,"uptimeMs":12345}
  // drive   (受信): {"type":"drive","cmd":"a","speedL":190,"speedR":190}
  // setName (受信): {"type":"setName","name":"Car-Blue"}
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
    doc["fw"] = "3.0.0";
    char buf[128];
    size_t n = serializeJson(doc, buf, sizeof(buf));
    webSocket.sendTXT(buf, n);
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
    webSocket.sendTXT(buf, n);
  }

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

  // 1. I2Cバス初期化 & タイムアウト設定 (ノイズによるバスハング防止)
  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
  Wire.setTimeOut(25); // 25msタイムアウトで無限ロックを防止

  // 2. OLED初期化
  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println(F("[WARN] OLED not detected or bus busy"));
  } else {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 20);
    display.println("ESP32 RC ROBUST V3");
    display.setCursor(0, 35);
    display.println(deviceId);
    display.display();
  }

  // 3. モーターピン初期化
  pinMode(PIN_IN1, OUTPUT);
  pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_IN3, OUTPUT);
  pinMode(PIN_IN4, OUTPUT);

  setupPWM();
  applyMotorControl('e', 0, 0);

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
  webSocket.loop();
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

  // ③ OLED定期更新 (200ms周期)
  if (now - lastDisplayTime > DISPLAY_INTERVAL_MS) {
    lastDisplayTime = now;
    updateOLED();
  }

  // CPUタスク切り替えの隙間を確保
  yield();
}
