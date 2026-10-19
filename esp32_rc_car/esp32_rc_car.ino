/*
 * ============================================================================
 * プロジェクト名: ESP32 フリート対応ラジコンカー (2WD) - 堁E��化版 (Robust V4)
 * 対策頁E��:
 *   1. 【ヒープ断牁E��対策】String完�E排除・ゼロ動的メモリ確保！Eero Allocation�E�E
 *   2. 【ゾンビ接続キル】通信途絶時�E自動�E断・アドバタイズ強制復旧(BLE晁E/自動�E接綁EWS晁E
 *   3. 【テレメトリ可視化】オンボ�EドTFT(ST7789 170x320)に稼働時閁EUptime)・残ヒーチEHeap)を常時表示
 *   4. 【互換性】ESP32 Arduino Core v2.x / v3.x 両対忁E
 *   5. 【フリート管琁E��Wi-Fi + WebSocketをメイン通信経路とし、褁E��台めE
 *      フリートハブから識別・一括/個別制御できるようにする、ELE/Classic BTは
 *      チE��チE��・フォールバック用としてTRANSPORT_MODEで刁E��可能、E
 *
 * V4 ハ�Eドウェア変更 (V3からの再設訁E:
 *   - 表示: 外付けOLED(SSD1306, I2C) -> ideaspark ESP32基板オンボ�Eド一体型TFT(ST7789V3, SPI, 170x320)
 *   - 本個体はTFT表示とL298Nモーター駁E��のみを担当する(カメラ/LEDは搭載しなぁE��別個佁E。
 *     モーター方向ピンはL298Nの6ピン(ENA/IN1/IN2/ENB/IN3/IN4)を直接制御する標準方式、E
 * ============================================================================
 */

// 送信経路の選抁E MODE_WEBSOCKET(既宁E本番) / MODE_BLE / MODE_CLASSIC_BT(チE��チE��用)
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

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <esp_mac.h> // esp_read_mac() : WiFi/BT初期化前でめEACアドレスを取得可能

// ----------------------------------------------------------------------------
// 表惁E��ンジンの型定義 (enum/struct) はファイル先頭で宣言しておく、E
// Arduinoビルダーは関数プロトタイプをファイル先頭付近に自動挿入するため、E
// これら�E型を使ぁE��数(setExpression/deriveAutoExpression/drawEyes筁Eより後ろに
// 定義すると「undeclared」エラーになる。定義本佁E実裁Eは後方のセクションに記述する、E
// ----------------------------------------------------------------------------
enum ExpressionId {
  EXPR_NEUTRAL = 0,  // 1. 通常
  EXPR_HAPPY,        // 2. 嘴しい
  EXPR_FUN,          // 3. 楽しい
  EXPR_LAUGH,        // 4. 笑う
  EXPR_SURPRISED,    // 5. 驚き
  EXPR_CURIOUS,      // 6. 好奇心
  EXPR_THINKING,     // 7. 考え中
  EXPR_WINK,         // 8. ウインク
  EXPR_WORRIED,      // 9. 悲しい(通信断絶時の自動表情にも使用)
  EXPR_ANGRY,        // 10. 怒り
  EXPR_SLEEPY,       // 11. 眠い
  EXPR_LOVE,         // 12. 大好き
  EXPR_SHOCKED,      // 13. ショック(フェイルセーフ発動時)
  EXPR_GIVEUP,       // 14. ギブアップ
  EXPR_SHY,          // 15. 照れる
  EXPR_COMPOSED,     // 16. 余裕
  EXPR_COUNT
};

enum FaceLayoutMode { LAYOUT_SPLIT = 0, LAYOUT_FULL_FACE = 1 };            // 上下分割 / 顔のみ全画面
enum SplitBottomContent { SPLIT_BOTTOM_SENSOR = 0, SPLIT_BOTTOM_ALERT = 1 }; // 分割時、下半分に何を表示するか

enum EyeSpecial {
  EYE_SPECIAL_NONE = 0,     // 通常: パラメトリックな角丸四角形の目(tired/angry/happyパラメータで変形)
  EYE_SPECIAL_ARC_CLOSED,   // 笑って閉じた目(弧): happy/fun/laugh/shy
  EYE_SPECIAL_SWIRL,        // 片目通常+片目渦巻き: curious
  EYE_SPECIAL_DOTS,         // 片目通常+片目「…」: thinking
  EYE_SPECIAL_WINK,         // 片目通常+片目ウインク: wink
  EYE_SPECIAL_SHOCK_SWEAT,  // 丸目+眩+汗: shocked
  EYE_SPECIAL_X,            // ×目: giveup
  EYE_SPECIAL_HEART         // ハート型: love
};

// 目の形状に重ねて描く追加装飾(単体では使わず EyeSpecial と組み合わせて使用)
enum EyeDecoration {
  EYE_DECO_NONE = 0,
  EYE_DECO_LASH,     // まつ毛: fun
  EYE_DECO_BLUSH,    // 頼の赤面線: shy
  EYE_DECO_SPARKLE   // キラッと光る線: composed
};

enum MouthShape {
  MOUTH_LINE,
  MOUTH_SMILE_ARC,
  MOUTH_O,
  MOUTH_ZIGZAG,
  MOUTH_SLEEP_TILDE,
  MOUTH_WAVY_SAD,
  MOUTH_JAGGED,
  MOUTH_SMALL_O,
  MOUTH_TRIANGLE,
  MOUTH_LINE_SIDE, // 片側に寄った短い直線: thinking
  MOUTH_SMIRK      // 片側だけ上がる非対称スマイル: wink/composed
};

struct ExpressionParams {
  float eyeWidthScale;    // 基準幅に対する倍率
  float eyeHeightScale;   // 基準高さに対する倍率
  float eyeRadiusScale;   // 角丸半径の倍率(0=四角、1=標準の丸み)
  float eyeTired;         // 0-1: 外側(目尻側)上まぶたが垂れ下がる量(眠気・警戒)
  float eyeAngry;         // 0-1: 内側(鼻側)上まぶたが垂れ下がる量(怒り)
  float eyeHappy;         // 0-1: 下まぶたが中央から山形に持ち上がる量(笑顔)
  EyeSpecial eyeSpecial;  // 通常のパラメトリック描画を上書きする特殊表示
  EyeDecoration eyeDecoration; // 目の形状に重ねて描く追加装飾(まつ毛/赤面/キラッ)
  MouthShape mouthShape;
  uint16_t eyeColor;
  uint16_t mouthColor;
  bool blinkEnabled;
  uint16_t blinkMinMs;
  uint16_t blinkMaxMs;
  float maxOpenness;      // 通常晁E非まばたき晁Eの目の開き具吁E(1.0=全閁E
  bool saccadeEnabled;
  float saccadeRangeScale; // 眼琁E��征E��対する視線移動篁E��の割吁E
  bool saccadeDownOnly;    // true: 下向き篁E��のみ(UNSUREの伏し目を維持E
};

// ----------------------------------------------------------------------------
// TFTチE��スプレイ設宁E(ideaspark ESP32基板オンボ�Eド一体型 ST7789V3, 170x320)
// メーカー公表のポ�Eト�EチE��ング: DC=2, RST=4, CS=15, SCLK=18, MOSI=23, BLK=32
// SCLK/MOSIはVSPI既定ピンと一致するが、既定�EMISO(GPIO19)はカメラD7と競合するためE
// SPI.begin()でMISOを�E示皁E��無効(-1)にしてから初期化すめEdisplayは書き込み専用のため支障なぁE、E
// ----------------------------------------------------------------------------
#define TFT_DC      2
#define TFT_RST     4
#define TFT_CS      15
#define TFT_SCLK    18
#define TFT_MOSI    23
#define TFT_BL      32
#define TFT_PANEL_W 170
#define TFT_PANEL_H 320
const int SPLIT_BOTTOM_Y = TFT_PANEL_H / 2;         // 下半分(センサー情報/アラート)の開始Y座標
const int SPLIT_BOTTOM_H = TFT_PANEL_H - SPLIT_BOTTOM_Y;

Adafruit_ST7789 display = Adafruit_ST7789(TFT_CS, TFT_DC, TFT_RST);

// 画面下半分(センサー情報/NO LINKアラート)のオフスクリーンバッファ。直接displayへclear→redrawすると
// 瞬間的な黒塗りが見えてちらつくため、他のキャンバスと同様に一括転送する。
// ※setup()内で遅延確保する(グローバルオブジェクトのままだと非常に早い段階の静的初期化で
// 大きなmallocが走り、esp_timerタスク生成用のヒープが足りず起動直後にpanic・リブートする)
GFXcanvas16 *bottomCanvas = nullptr;

// ----------------------------------------------------------------------------
// ピンアサイン定義 (L298N 接続、6ピン直接制御)
// TFTがGPIO2/4/15/18/23/32を専有するため、空いているGPIOに方向ピンを割り当てる、E
// ----------------------------------------------------------------------------
const int PIN_ENA = 14;   // 右モーター PWM
const int PIN_IN1  = 27;  // 右モーター 方向1 (L298N IN1)
const int PIN_IN2  = 26;  // 右モーター 方向2 (L298N IN2)

const int PIN_IN3  = 33;  // 左モーター 方向1 (L298N IN3)
const int PIN_IN4  = 19;  // 左モーター 方向2 (L298N IN4)
const int PIN_ENB = 25;   // 左モーター PWM

#if TRANSPORT_MODE == MODE_WEBSOCKET
  // WebSocketsClientはスレチE��セーフではなぁE��め、E��受信の実アクセス(sendHello/sendTelemetry/
  // webSocket.loop())はwsMutexで直列化する。
  // webSocket.loop()のコールバック(onWebSocketEvent->sendHello)が同一タスク冁E��再�EしてロチE��めE
  // 取り直すため、忁E��再帰可能ミューチE��クスを使用する、E
  SemaphoreHandle_t wsMutex = NULL;
#endif

// ----------------------------------------------------------------------------
// PWM制御パラメータ
// ----------------------------------------------------------------------------
const int PWM_FREQ = 30000;      // 30kHz (高周波でモーターの可聴ノイズを抑制)
const int PWM_RESOLUTION = 8;    // 8-bit (0 、E255)
const int PWM_CH_RIGHT = 0;      // Core v2用
const int PWM_CH_LEFT = 1;       // Core v2用

// ----------------------------------------------------------------------------
// 通信 & シスチE��状態管琁E(静的固定バチE��ァ)
// ----------------------------------------------------------------------------
const char* DEVICE_NAME_PREFIX = "ESP32_RC_Car";
char deviceId[16] = "unknown";        // MACアドレス丁E桁由来 (侁E "rc-a1b2c3")
char deviceDisplayName[32] = "";      // 任意設定�E表示吁E(未設定時はdeviceIdを使用)

char currentCommand = 'e';
int currentSpeedL = 0;
int currentSpeedR = 0;
volatile bool isDeviceConnected = false;
char lastRawBuffer[24] = "NONE";

unsigned long lastPacketTime = 0;
const unsigned long FAILSAFE_TIMEOUT_MS = 1500;       // 1.5秒途絶で緊急停止
const unsigned long ZOMBIE_TIMEOUT_MS   = 10000;      // 10秒途絶で接続リセチE��

unsigned long lastDisplayTime = 0;
const unsigned long DISPLAY_INTERVAL_MS = 200;        // チE��メトリ画面の全画面再描画周朁E

// ----------------------------------------------------------------------------
// 表惁E��ンジン用の補助状慁E(停止継続時閁E& フェイルセーフ発動検知)
// applyMotorControl()/loop()から更新され、後述のderiveAutoExpression()が参照する、E
// ----------------------------------------------------------------------------
unsigned long idleStartTime = 0;      // cmd='e'が継続してぁE��開始時刻 (0=非アイドル中)
unsigned long shockedUntil = 0;       // フェイルセーフ発動によるEXPR_SHOCKED表示の終亁E��刻 (0=非発動中)
bool shockedFlashPending = false;     // SHOCKED突�E直後�E白フラチE��ュ演�Eがまだの場吁Erue
ExpressionId idleExpressionChoice = EXPR_NEUTRAL; // アイドル中にランダム抽選された現在の表情
unsigned long nextIdleExpressionAt = 0;           // 次にアイドル表情を再抽選する時刻(0=即時抽選)

// チE��イスIDをMACアドレス丁Eバイトから生戁E("rc-xxxxxx")
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
// モーター駁E��関数
// ----------------------------------------------------------------------------
void applyMotorControl(char cmd, int speedL, int speedR) {
  // EXPR_SLEEPY判定用: 'e'(停止)に入った瞬間�E時刻のみ記録し、以後�E連続停止時間として参�Eする、E
  static char prevCmdForIdle = '\0';
  if (cmd == 'e') {
    if (prevCmdForIdle != 'e') {
      idleStartTime = millis();
      nextIdleExpressionAt = 0;
      idleExpressionChoice = EXPR_NEUTRAL;
    }
  } else {
    idleStartTime = 0;
  }
  prevCmdForIdle = cmd;

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
// メモリ動的確保ゼロ�E�Eero Allocation�E�パケチE��パ�Eサー
// ----------------------------------------------------------------------------
void parseCommandPacketFast(const char* buf, size_t len) {
  if (len == 0 || buf == nullptr) return;

  lastPacketTime = millis();

  // 生データの記録 (最大20斁E��E
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
// 画面下半分(分割レイアウト時)の描画処理。センサー情報の簡易版、または通信断絶時のアラートを表示する。
// ----------------------------------------------------------------------------
void updateSplitBottom(SplitBottomContent content) {
  if (bottomCanvas == nullptr) return;
  bottomCanvas->fillScreen(ST77XX_BLACK);
  bottomCanvas->drawLine(0, 0, TFT_PANEL_W - 1, 0, ST77XX_WHITE);

  if (content == SPLIT_BOTTOM_ALERT) {
    bottomCanvas->setTextSize(2);
    bottomCanvas->setTextColor(ST77XX_RED);
    bottomCanvas->setCursor(4, 14);
    bottomCanvas->print("NO LINK");
    bottomCanvas->setTextSize(1);
    bottomCanvas->setTextColor(ST77XX_WHITE);
    bottomCanvas->setCursor(4, 40);
    bottomCanvas->print("Fleet Hub disconnected");
    bottomCanvas->setCursor(4, 56);
    bottomCanvas->printf("HEAP:%luKB", ESP.getFreeHeap() / 1024);
    display.drawRGBBitmap(0, SPLIT_BOTTOM_Y, bottomCanvas->getBuffer(), TFT_PANEL_W, SPLIT_BOTTOM_H);
    return;
  }

  // 通常時: 通信状態 / モード / 速度バー(L,R)だけに絞った簡易表示
  bottomCanvas->setTextSize(1);
  bottomCanvas->setTextColor(isDeviceConnected ? ST77XX_GREEN : ST77XX_RED);
  bottomCanvas->setCursor(4, 6);
#if TRANSPORT_MODE == MODE_WEBSOCKET
  bottomCanvas->print(isDeviceConnected ? "WS: OK" : "WS: WAIT");
#elif TRANSPORT_MODE == MODE_BLE
  bottomCanvas->print(isDeviceConnected ? "BLE: OK" : "BLE: WAIT");
#else
  bottomCanvas->print(isDeviceConnected ? "BT: OK" : "BT: WAIT");
#endif

  bottomCanvas->setTextColor(ST77XX_YELLOW);
  bottomCanvas->setCursor(90, 6);
  switch (currentCommand) {
    case 'a': bottomCanvas->print("FORWARD"); break;
    case 'b': bottomCanvas->print("REVERSE"); break;
    case 'c': bottomCanvas->print("TURN-R"); break;
    case 'd': bottomCanvas->print("TURN-L"); break;
    default:  bottomCanvas->print("STOP"); break;
  }

  bottomCanvas->setTextColor(ST77XX_WHITE);
  bottomCanvas->setCursor(4, 22);
  bottomCanvas->printf("L:%3d", currentSpeedL);
  bottomCanvas->drawRect(4, 34, 160, 10, ST77XX_WHITE);
  int barL = map(constrain(currentSpeedL, 0, 255), 0, 255, 0, 156);
  if (barL > 0) bottomCanvas->fillRect(6, 36, barL, 6, ST77XX_CYAN);

  bottomCanvas->setCursor(4, 50);
  bottomCanvas->printf("R:%3d", currentSpeedR);
  bottomCanvas->drawRect(4, 62, 160, 10, ST77XX_WHITE);
  int barR = map(constrain(currentSpeedR, 0, 255), 0, 255, 0, 156);
  if (barR > 0) bottomCanvas->fillRect(6, 64, barR, 6, ST77XX_CYAN);

  display.drawRGBBitmap(0, SPLIT_BOTTOM_Y, bottomCanvas->getBuffer(), TFT_PANEL_W, SPLIT_BOTTOM_H);
}


// ============================================================================
// 表惁Eフェイス)エンジン: 目・口をTFTに描画しロボット�E表惁E��表現する、E
// 設計方釁E
//   - 全画面fillScreenは行わず、目/口それぞれの固定バウンチE��ングボックスのみ
//     黒塗り→�E描画することでちらつきを抑えめEupdateDisplay()とは別の独立関数)、E
//   - まばたき(blink)と視線�E自律移勁Esaccade/きょろきめE��)は独立したタイマ�Eで
//     並行動作させ、表惁E��とに有効/無効・頻度・振れ幁E��ExpressionParamsチE�Eブルで刁E��える、E
//   - 判定優先度: ①手動オーバ�EライチEsetExpression) > ②フェイルセーチE刁E�� >
//     ③走行状慁E> ④アイドル(眠そう) > ⑤NEUTRAL既宁E(resolveExpression()参�E)、E
//   - enum/struct型定義はファイル先頭(includes直征Eで宣言済み(Arduinoビルダーの
//     自動�Eロトタイプ挿入対筁E。ここでは状態テーブル/変数/関数本体�Eみを記述する、E
// ============================================================================

// 表惁E��タログ (plan.md の表参�E)。色はAdafruit_ST7789のRGB565マクロ/定数値、E
const ExpressionParams EXPRESSION_TABLE[EXPR_COUNT] = {
  // widthScale, heightScale, radiusScale, tired, angry, happy, special,                 decoration,       mouthShape,        eyeColor,      mouthColor,    blink, blinkMin,blinkMax, maxOpen, saccade, saccadeRange, saccadeDownOnly
  /* EXPR_NEUTRAL   */ { 1.00f, 1.00f, 1.00f, 0.00f, 0.00f, 0.00f, EYE_SPECIAL_NONE,       EYE_DECO_NONE,    MOUTH_LINE,        ST77XX_WHITE,  ST77XX_WHITE,  true,  3000, 6000, 1.00f, true,  0.40f, false },
  /* EXPR_HAPPY     */ { 1.05f, 0.75f, 1.00f, 0.00f, 0.00f, 0.85f, EYE_SPECIAL_NONE,       EYE_DECO_NONE,    MOUTH_SMILE_ARC,   ST77XX_CYAN,   ST77XX_YELLOW, true,  2200, 4200, 1.00f, true,  0.40f, false },
  /* EXPR_FUN       */ { 1.00f, 1.00f, 1.00f, 0.00f, 0.00f, 0.00f, EYE_SPECIAL_ARC_CLOSED, EYE_DECO_LASH,    MOUTH_SMILE_ARC,   ST77XX_CYAN,   ST77XX_YELLOW, false, 0,    0,    1.00f, false, 0.00f, false },
  /* EXPR_LAUGH     */ { 1.30f, 1.00f, 1.00f, 0.00f, 0.00f, 0.00f, EYE_SPECIAL_ARC_CLOSED, EYE_DECO_NONE,    MOUTH_SMILE_ARC,   ST77XX_CYAN,   ST77XX_YELLOW, false, 0,    0,    1.00f, false, 0.00f, false },
  /* EXPR_SURPRISED */ { 1.30f, 1.30f, 1.00f, 0.00f, 0.00f, 0.00f, EYE_SPECIAL_NONE,       EYE_DECO_NONE,    MOUTH_O,           ST77XX_WHITE,  0xF81F,        false, 0,    0,    1.00f, false, 0.00f, false },
  /* EXPR_CURIOUS   */ { 1.00f, 0.90f, 1.00f, 0.00f, 0.00f, 0.00f, EYE_SPECIAL_SWIRL,      EYE_DECO_NONE,    MOUTH_ZIGZAG,      0xFD20,        0xAEDC,        true,  3000, 6000, 1.00f, true,  0.40f, false },
  /* EXPR_THINKING  */ { 0.90f, 0.80f, 0.80f, 0.60f, 0.00f, 0.00f, EYE_SPECIAL_NONE,       EYE_DECO_NONE,    MOUTH_LINE_SIDE,   ST77XX_WHITE,  0xFD20,        true,  3000, 6000, 1.00f, true,  0.40f, true  },
  /* EXPR_WINK      */ { 1.10f, 0.90f, 1.00f, 0.00f, 0.00f, 0.30f, EYE_SPECIAL_WINK,       EYE_DECO_NONE,    MOUTH_SMIRK,       ST77XX_CYAN,   ST77XX_YELLOW, true,  2200, 4200, 1.00f, true,  0.55f, false },
  /* EXPR_WORRIED   */ { 0.85f, 0.90f, 0.80f, 0.70f, 0.00f, 0.00f, EYE_SPECIAL_NONE,       EYE_DECO_NONE,    MOUTH_WAVY_SAD,    0xAEDC,        ST77XX_BLUE,   true,  3000, 6000, 1.00f, true,  0.20f, false },
  /* EXPR_ANGRY     */ { 1.00f, 0.65f, 0.30f, 0.00f, 1.00f, 0.00f, EYE_SPECIAL_NONE,       EYE_DECO_NONE,    MOUTH_LINE,        ST77XX_RED,    ST77XX_RED,    false, 0,    0,    1.00f, false, 0.00f, false },
  /* EXPR_SLEEPY    */ { 1.00f, 0.30f, 1.00f, 0.80f, 0.00f, 0.00f, EYE_SPECIAL_NONE,       EYE_DECO_NONE,    MOUTH_SLEEP_TILDE, 0x8438,        0x8410,        true,  6000, 9000, 0.45f, true,  0.20f, false },
  /* EXPR_LOVE      */ { 1.00f, 1.00f, 1.00f, 0.00f, 0.00f, 0.00f, EYE_SPECIAL_HEART,      EYE_DECO_NONE,    MOUTH_SMALL_O,     ST77XX_RED,    ST77XX_RED,    false, 0,    0,    1.00f, false, 0.00f, false },
  /* EXPR_SHOCKED   */ { 1.00f, 1.00f, 1.00f, 0.00f, 0.00f, 0.00f, EYE_SPECIAL_SHOCK_SWEAT,EYE_DECO_NONE,    MOUTH_JAGGED,      ST77XX_RED,    ST77XX_RED,    false, 0,    0,    1.00f, false, 0.00f, false },
  /* EXPR_GIVEUP    */ { 1.00f, 1.00f, 1.00f, 0.00f, 0.00f, 0.00f, EYE_SPECIAL_X,          EYE_DECO_NONE,    MOUTH_WAVY_SAD,    0x8410,        0x8410,        false, 0,    0,    1.00f, false, 0.00f, false },
  /* EXPR_SHY       */ { 1.00f, 1.00f, 1.00f, 0.00f, 0.00f, 0.00f, EYE_SPECIAL_ARC_CLOSED, EYE_DECO_BLUSH,   MOUTH_LINE,        0xF81F,        0xF81F,        false, 0,    0,    1.00f, false, 0.00f, false },
  /* EXPR_COMPOSED  */ { 1.00f, 0.55f, 1.00f, 0.00f, 0.00f, 0.00f, EYE_SPECIAL_NONE,       EYE_DECO_SPARKLE, MOUTH_SMIRK,       ST77XX_CYAN,   ST77XX_YELLOW, true,  4000, 7000, 0.65f, true,  0.35f, false },
};

// ----------------------------------------------------------------------------
// 顔レイアウト定数 (setRotation(2)適用後の170x320ポートレート座標系)
// ----------------------------------------------------------------------------
const int FACE_EYE_L_X = 44;
const int FACE_EYE_R_X = 106;
const int FACE_EYE_Y = 60;
const int FACE_EYE_RADIUS = 26;
const int FACE_EYE_BASE_HW = 20; // パラメトリック目の標準状態での半幅(px)
const int FACE_EYE_BASE_HH = 24; // パラメトリック目の標準状態での半高さ(px)
const int FACE_MOUTH_X = 50;
const int FACE_MOUTH_Y = 30;
const int FACE_MOUTH_W = 30; // 半幁E

// 部刁E�E描画用バウンチE��ングボックス(目領域と口領域は重ならなぁE��ぁE��訁E
const int FACE_EYES_BOX_X = 10, FACE_EYES_BOX_Y = 60, FACE_EYES_BOX_W = 150, FACE_EYES_BOX_H = 120;
const int FACE_MOUTH_BOX_X = 35, FACE_MOUTH_BOX_Y = 190, FACE_MOUTH_BOX_W = 100, FACE_MOUTH_BOX_H = 60;

// 目/口のオフスクリーンバッファ(2本値キャンバス)。毎フレームdrawRGBBitmapで一括転送してチラつきを防ぐ。
GFXcanvas16 eyesCanvas(FACE_EYES_BOX_W, FACE_EYES_BOX_H);
GFXcanvas16 mouthCanvas(FACE_MOUTH_BOX_W, FACE_MOUTH_BOX_H);

// ----------------------------------------------------------------------------
// 上下分割レイアウト用の縮小顔(上半分に顔、下半分にセンサー情報/アラートを表示する)
// ----------------------------------------------------------------------------
const float SPLIT_FACE_SCALE = 0.60f;
const int SPLIT_EYES_W = (int)(FACE_EYES_BOX_W * SPLIT_FACE_SCALE);
const int SPLIT_EYES_H = (int)(FACE_EYES_BOX_H * SPLIT_FACE_SCALE);
const int SPLIT_MOUTH_W = (int)(FACE_MOUTH_BOX_W * SPLIT_FACE_SCALE);
const int SPLIT_MOUTH_H = (int)(FACE_MOUTH_BOX_H * SPLIT_FACE_SCALE);
const int SPLIT_EYES_X = (TFT_PANEL_W - SPLIT_EYES_W) / 2;
const int SPLIT_EYES_Y = 14;
const int SPLIT_MOUTH_X = (TFT_PANEL_W - SPLIT_MOUTH_W) / 2;
const int SPLIT_MOUTH_Y = SPLIT_EYES_Y + SPLIT_EYES_H + 6;
GFXcanvas16 eyesCanvasSmall(SPLIT_EYES_W, SPLIT_EYES_H);
GFXcanvas16 mouthCanvasSmall(SPLIT_MOUTH_W, SPLIT_MOUTH_H);

const unsigned long FACE_INTERVAL_MS = 60;             // 表惁E��面の更新周朁E紁E6fps)
const unsigned long BLINK_ANIM_MS = 110;               // まばたき1フェーズ(閁E閁Eあたり�E所要時閁E
const unsigned long SHOCKED_HOLD_MS = 2500;            // SHOCKED表惁E�E固定表示時間
const unsigned long BOOT_SPLIT_DURATION_MS = 5000;     // 起動直後に分割レイアウトを表示し続ける時間
const unsigned long DEFAULT_MANUAL_DURATION_MS = 8000; // 手動表惁E��定�EチE��ォルト持続時閁E

// --- 表惁E��慁E---
ExpressionId currentExpression = EXPR_NEUTRAL;
ExpressionId manualExpression = EXPR_NEUTRAL;
bool manualOverrideActive = false;
unsigned long manualOverrideUntil = 0;

// --- まばたき状慁E---
enum BlinkPhase { BLINK_IDLE, BLINK_CLOSING, BLINK_OPENING };
BlinkPhase blinkPhase = BLINK_IDLE;
float eyeOpenness = 1.0f;
unsigned long nextBlinkAt = 0;
unsigned long blinkPhaseStartAt = 0;

// --- サチE��ーチE視線�E律移勁E状慁E---
int saccadeOffsetX = 0, saccadeOffsetY = 0;
int saccadeTargetX = 0, saccadeTargetY = 0;
unsigned long nextSaccadeAt = 0;
unsigned long saccadeHoldUntil = 0;

// --- 目の形状モーフィング状態(表情切替時に目標値へ滑らかに近づける) ---
float curEyeWidthScale = 1.0f, curEyeHeightScale = 1.0f, curEyeRadiusScale = 1.0f;
float curEyeTired = 0.0f, curEyeAngry = 0.0f, curEyeHappy = 0.0f;

// --- 表示レイアウト & 再描画制御 ---
FaceLayoutMode lastFaceLayoutMode = LAYOUT_SPLIT;  // 直前フレームのレイアウト(切替検知用)
bool fleetLayoutOverrideActive = false;            // フリートからのsetDisplayLayout指示が有効中か
FaceLayoutMode fleetLayoutOverride = LAYOUT_SPLIT; // 有効時に強制するレイアウト
unsigned long bootSplitUntil = 0;                  // 起動直後の分割表示を終了させる時刻(setup()で設定)
unsigned long lastFaceTime = 0;
bool forceFullRedraw = true;  // モード�E替直後に1度だけ�E画面クリアするためのフラグ
bool needFullClear = false;   // SHOCKEDフラチE��ュ後、次フレームで全画面を黒に戻すため�Eフラグ

// 手動表惁E��ーバ�Eライドを設定すめE(Phase C: WebSocketの"setExpression"受信から呼び出し予宁E
void setExpression(ExpressionId id, unsigned long durationMs) {
  manualExpression = id;
  manualOverrideActive = true;
  manualOverrideUntil = millis() + (durationMs > 0 ? durationMs : DEFAULT_MANUAL_DURATION_MS);
}

// 走行状慁E接続状態から�E動表惁E��決定すめE(優先度②③④⑤)
ExpressionId deriveAutoExpression() {
  unsigned long now = millis();

  // ② フェイルセーフ発動直後�ESHOCKEDを優允E
  if (shockedUntil != 0) {
    if (now < shockedUntil) return EXPR_SHOCKED;
    shockedUntil = 0;
  }

#if TRANSPORT_MODE == MODE_WEBSOCKET || TRANSPORT_MODE == MODE_BLE
  if (!isDeviceConnected) return EXPR_WORRIED;
#endif

  // ③ 走行状慁E
  switch (currentCommand) {
    case 'a': return EXPR_HAPPY;
    case 'b': return EXPR_THINKING;
    case 'c':
    case 'd': return EXPR_SURPRISED;
    case 'e':
    default:
      // ④ アイドル: 一定間隔(3〜6秒)でランダムに表情を再抽選する。
      //    アイドル継続が長いほどSLEEPYの出現確率が上がり、低確率でSURPRISEDも混ぜる。
      if (idleStartTime != 0 && now >= nextIdleExpressionAt) {
        unsigned long idleElapsedSec = (now - idleStartTime) / 1000;
        int sleepyWeight = (idleElapsedSec > 40) ? 40 : (int)idleElapsedSec;
        if ((int)random(0, 100 + sleepyWeight) < sleepyWeight) {
          idleExpressionChoice = EXPR_SLEEPY;
        } else {
          int r = random(0, 100);
          if (r < 4)       idleExpressionChoice = EXPR_SURPRISED;
          else if (r < 40) idleExpressionChoice = EXPR_HAPPY;
          else if (r < 55) idleExpressionChoice = EXPR_THINKING;
          else             idleExpressionChoice = EXPR_NEUTRAL;
        }
        nextIdleExpressionAt = now + random(3000, 6001);
      }
      return idleExpressionChoice; // ⑤既定(NEUTRAL)を含むランダム表情
  }
}

// 優先度①(手動)を加味した最終的な表惁EDを解決する
ExpressionId resolveExpression() {
  if (manualOverrideActive) {
    if (millis() >= manualOverrideUntil) {
      manualOverrideActive = false;
    } else {
      return manualExpression;
    }
  }
  return deriveAutoExpression();
}

// 上に凸の弧(にっこり目・HAPPY口の基本形)を短ぁE���Eの連なりで近似描画する
void drawArcUp(Adafruit_GFX &gfx, int cx, int cy, int r, uint16_t color) {
  int prevX = cx - r, prevY = cy;
  for (int i = 1; i <= 16; i++) {
    float t = PI * i / 16.0f;
    int x = cx - (int)(r * cos(t));
    int y = cy - (int)(r * sin(t));
    gfx.drawLine(prevX, prevY, x, y, color);
    prevX = x; prevY = y;
  }
}

// 下に凸の弧(困り口・悲しい口の基本形)
void drawArcDown(Adafruit_GFX &gfx, int cx, int cy, int r, uint16_t color) {
  int prevX = cx - r, prevY = cy;
  for (int i = 1; i <= 16; i++) {
    float t = PI * i / 16.0f;
    int x = cx - (int)(r * cos(t));
    int y = cy + (int)(r * sin(t));
    gfx.drawLine(prevX, prevY, x, y, color);
    prevX = x; prevY = y;
  }
}

void drawHeart(Adafruit_GFX &gfx, int cx, int cy, int r, uint16_t color) {
  gfx.fillCircle(cx - r / 2, cy - r / 3, r / 2, color);
  gfx.fillCircle(cx + r / 2, cy - r / 3, r / 2, color);
  gfx.fillTriangle(cx - r, cy - r / 4, cx + r, cy - r / 4, cx, cy + r, color);
}

// まつ毛(短い3本の斜線)。isLeftで左右対称に傾きを反転する
void drawEyelash(Adafruit_GFX &gfx, int cx, int topY, uint16_t color, bool isLeft) {
  int dir = isLeft ? -1 : 1;
  for (int i = -1; i <= 1; i++) {
    int x0 = cx + i * 6;
    gfx.drawLine(x0, topY, x0 + dir * 3, topY - 6, color);
  }
}

// 頬の赤面線(斜めの短い平行線3本)
void drawBlush(Adafruit_GFX &gfx, int cx, int cy, uint16_t color) {
  for (int i = -1; i <= 1; i++) {
    gfx.drawLine(cx - 4, cy + i * 5 - 4, cx + 4, cy + i * 5 + 4, color);
  }
}

// 渦巻き目(好奇心)。角度を増やしながら半径を広げる螺旋を短い線分の連なりで近似描画する
void drawSwirl(Adafruit_GFX &gfx, int cx, int cy, int maxR, uint16_t color) {
  int prevX = cx, prevY = cy;
  for (int i = 1; i <= 24; i++) {
    float angle = i * 0.9f;
    float rr = maxR * (i / 24.0f);
    int x = cx + (int)(rr * cos(angle));
    int y = cy + (int)(rr * sin(angle));
    gfx.drawLine(prevX, prevY, x, y, color);
    prevX = x; prevY = y;
  }
}

// 汗だれ(ショック時に目の外側へ描く短い縦線)
void drawSweatLines(Adafruit_GFX &gfx, int x, int y, uint16_t color) {
  gfx.drawLine(x, y, x - 3, y + 10, color);
  gfx.drawLine(x + 4, y + 3, x + 2, y + 13, color);
}

// キラッと光る線(余裕の表情で目の脇に描く十字型の光)
void drawSparkle(Adafruit_GFX &gfx, int cx, int cy, uint16_t color) {
  gfx.drawLine(cx - 6, cy, cx + 6, cy, color);
  gfx.drawLine(cx, cy - 6, cx, cy + 6, color);
  gfx.drawLine(cx - 4, cy - 4, cx + 4, cy + 4, color);
  gfx.drawLine(cx - 4, cy + 4, cx + 4, cy - 4, color);
}

// 1つの目を角丸四角形で描画し、怒り/眠気/笑顔のまぶた重なりを表現する。
// isLeftEyeで鼻側(内側)がどちらの辺かを判定し、怒り/眠気の切り欠きを左右対称にする。
void drawOneParametricEye(Adafruit_GFX &gfx, int cx, int cy, uint16_t color, float openness, bool isLeftEye) {
  int w = max(4, (int)(FACE_EYE_BASE_HW * 2 * curEyeWidthScale));
  int h = max(4, (int)(FACE_EYE_BASE_HH * 2 * curEyeHeightScale * max(openness, 0.06f)));
  int radius = constrain((int)(min(w, h) / 2 * curEyeRadiusScale), 0, min(w, h) / 2);
  int x = cx - w / 2;
  int y = cy - h / 2;
  gfx.fillRoundRect(x, y, w, h, radius, color);

  int cutBase = min(w, h);
  if (curEyeAngry > 0.01f) {
    // 怒り: 鼻側(内側)の上角を切り落とし、ハの字の眉のように見せる
    int cut = (int)(cutBase * 0.9f * curEyeAngry);
    if (isLeftEye) gfx.fillTriangle(x + w, y, x + w - cut, y, x + w, y + cut, ST77XX_BLACK);
    else           gfx.fillTriangle(x, y, x + cut, y, x, y + cut, ST77XX_BLACK);
  }
  if (curEyeTired > 0.01f) {
    // 眠気/警戒: 目尻側(外側)の上角を切り落とす
    int cut = (int)(cutBase * 0.9f * curEyeTired);
    if (isLeftEye) gfx.fillTriangle(x, y, x + cut, y, x, y + cut, ST77XX_BLACK);
    else           gfx.fillTriangle(x + w, y, x + w - cut, y, x + w, y + cut, ST77XX_BLACK);
  }
  if (curEyeHappy > 0.01f) {
    // 笑顔: 下まぶたが中央から山形に持ち上がる(^_^風)
    int rise = (int)(h * 0.9f * curEyeHappy);
    gfx.fillTriangle(x - 2, y + h, x + w + 2, y + h, cx, y + h - rise, ST77XX_BLACK);
  }
}

// 両目を描画する。eyeSpecialが専用形状(X/HEART/SWIRL/DOTS/WINK/SHOCK_SWEAT/ARC_CLOSED)を持つ場合はそれを描画し、
// NONEの場合はパラメトリック描画(drawOneParametricEye)を行う。最後にeyeDecorationで追加装飾を重ね描きする。
void drawEyes(Adafruit_GFX &gfx, const ExpressionParams &p, float openness, int sx, int sy) {
  int r = FACE_EYE_RADIUS;
  switch (p.eyeSpecial) {
    case EYE_SPECIAL_X:
      gfx.drawLine(FACE_EYE_L_X - r, FACE_EYE_Y - r, FACE_EYE_L_X + r, FACE_EYE_Y + r, p.eyeColor);
      gfx.drawLine(FACE_EYE_L_X - r, FACE_EYE_Y + r, FACE_EYE_L_X + r, FACE_EYE_Y - r, p.eyeColor);
      gfx.drawLine(FACE_EYE_R_X - r, FACE_EYE_Y - r, FACE_EYE_R_X + r, FACE_EYE_Y + r, p.eyeColor);
      gfx.drawLine(FACE_EYE_R_X - r, FACE_EYE_Y + r, FACE_EYE_R_X + r, FACE_EYE_Y - r, p.eyeColor);
      break;
    case EYE_SPECIAL_HEART:
      drawHeart(gfx, FACE_EYE_L_X, FACE_EYE_Y, r, p.eyeColor);
      drawHeart(gfx, FACE_EYE_R_X, FACE_EYE_Y, r, p.eyeColor);
      break;
    case EYE_SPECIAL_ARC_CLOSED: {
      int rr = max(6, (int)(r * 0.85f * curEyeWidthScale));
      drawArcUp(gfx, FACE_EYE_L_X, FACE_EYE_Y, rr, p.eyeColor);
      drawArcUp(gfx, FACE_EYE_L_X, FACE_EYE_Y - 1, rr, p.eyeColor);
      drawArcUp(gfx, FACE_EYE_R_X, FACE_EYE_Y, rr, p.eyeColor);
      drawArcUp(gfx, FACE_EYE_R_X, FACE_EYE_Y - 1, rr, p.eyeColor);
      break;
    }
    case EYE_SPECIAL_SWIRL:
      drawOneParametricEye(gfx, FACE_EYE_L_X + sx, FACE_EYE_Y + sy, p.eyeColor, openness, true);
      drawSwirl(gfx, FACE_EYE_R_X, FACE_EYE_Y, (int)(r * 0.8f), p.eyeColor);
      break;
    case EYE_SPECIAL_DOTS:
      drawOneParametricEye(gfx, FACE_EYE_L_X + sx, FACE_EYE_Y + sy, p.eyeColor, openness, true);
      gfx.fillCircle(FACE_EYE_R_X - 10, FACE_EYE_Y, 3, p.eyeColor);
      gfx.fillCircle(FACE_EYE_R_X,      FACE_EYE_Y, 3, p.eyeColor);
      gfx.fillCircle(FACE_EYE_R_X + 10, FACE_EYE_Y, 3, p.eyeColor);
      break;
    case EYE_SPECIAL_WINK:
      drawOneParametricEye(gfx, FACE_EYE_L_X + sx, FACE_EYE_Y + sy, p.eyeColor, openness, true);
      gfx.drawLine(FACE_EYE_R_X - r, FACE_EYE_Y, FACE_EYE_R_X + r, FACE_EYE_Y, p.eyeColor);
      gfx.drawLine(FACE_EYE_R_X - r, FACE_EYE_Y + 1, FACE_EYE_R_X + r, FACE_EYE_Y + 1, p.eyeColor);
      break;
    case EYE_SPECIAL_SHOCK_SWEAT: {
      int rr = (int)(r * 0.7f);
      gfx.drawCircle(FACE_EYE_L_X, FACE_EYE_Y, rr, p.eyeColor);
      gfx.drawCircle(FACE_EYE_L_X, FACE_EYE_Y, rr - 1, p.eyeColor);
      gfx.fillCircle(FACE_EYE_L_X, FACE_EYE_Y, 3, p.eyeColor);
      gfx.drawCircle(FACE_EYE_R_X, FACE_EYE_Y, rr, p.eyeColor);
      gfx.drawCircle(FACE_EYE_R_X, FACE_EYE_Y, rr - 1, p.eyeColor);
      gfx.fillCircle(FACE_EYE_R_X, FACE_EYE_Y, 3, p.eyeColor);
      drawSweatLines(gfx, FACE_EYE_L_X - r - 8, FACE_EYE_Y - r, p.eyeColor);
      drawSweatLines(gfx, FACE_EYE_R_X + r + 2, FACE_EYE_Y - r, p.eyeColor);
      break;
    }
    default:
      drawOneParametricEye(gfx, FACE_EYE_L_X + sx, FACE_EYE_Y + sy, p.eyeColor, openness, true);
      drawOneParametricEye(gfx, FACE_EYE_R_X + sx, FACE_EYE_Y + sy, p.eyeColor, openness, false);
      break;
  }

  // 目の形状に重ねて描く追加装飾(まつ毛/赤面/キラッ)
  switch (p.eyeDecoration) {
    case EYE_DECO_LASH:
      drawEyelash(gfx, FACE_EYE_L_X, FACE_EYE_Y - (int)(r * 0.85f), p.eyeColor, true);
      drawEyelash(gfx, FACE_EYE_R_X, FACE_EYE_Y - (int)(r * 0.85f), p.eyeColor, false);
      break;
    case EYE_DECO_BLUSH:
      drawBlush(gfx, FACE_EYE_L_X - r - 8, FACE_EYE_Y + 12, p.eyeColor);
      drawBlush(gfx, FACE_EYE_R_X + r - 4, FACE_EYE_Y + 12, p.eyeColor);
      break;
    case EYE_DECO_SPARKLE:
      drawSparkle(gfx, FACE_EYE_R_X + r + 10, FACE_EYE_Y - r - 4, p.eyeColor);
      break;
    default:
      break;
  }
}

void drawMouth(Adafruit_GFX &gfx, MouthShape shape, uint16_t color, float intensity) {
  int cx = FACE_MOUTH_X, cy = FACE_MOUTH_Y;
  int w = (int)(FACE_MOUTH_W * (0.55f + 0.45f * constrain(intensity, 0.0f, 1.0f)));

  switch (shape) {
    case MOUTH_SMILE_ARC:
      drawArcUp(gfx, cx, cy, w, color);
      drawArcUp(gfx, cx, cy - 1, w, color);
      break;
    case MOUTH_O:
      gfx.drawCircle(cx, cy, 9, color);
      gfx.drawCircle(cx, cy, 8, color);
      break;
    case MOUTH_ZIGZAG: {
      int steps = 4, sw = (FACE_MOUTH_W * 2) / steps;
      int px = cx - FACE_MOUTH_W, py = cy;
      for (int i = 0; i < steps; i++) {
        int nx = px + sw;
        int ny = cy + ((i % 2 == 0) ? 6 : -6);
        gfx.drawLine(px, py, nx, ny, color);
        px = nx; py = ny;
      }
      break;
    }
    case MOUTH_SLEEP_TILDE:
      gfx.drawLine(cx - 10, cy, cx - 3, cy - 4, color);
      gfx.drawLine(cx - 3, cy - 4, cx + 4, cy, color);
      gfx.drawLine(cx + 4, cy, cx + 11, cy - 4, color);
      gfx.setTextSize(1);
      gfx.setTextColor(color);
      gfx.setCursor(cx + 20, cy - 14 - (int)(4 * sin(millis() / 300.0)));
      gfx.print("z");
      gfx.setCursor(cx + 28, cy - 20 - (int)(4 * sin(millis() / 300.0 + 1.0)));
      gfx.print("Z");
      break;
    case MOUTH_WAVY_SAD:
      drawArcDown(gfx, cx, cy - 8, FACE_MOUTH_W, color);
      break;
    case MOUTH_JAGGED: {
      int steps = 6, sw = (FACE_MOUTH_W * 2) / steps;
      int px = cx - FACE_MOUTH_W, py = cy;
      for (int i = 0; i < steps; i++) {
        int nx = px + sw;
        int ny = cy + ((i % 2 == 0) ? -8 : 8);
        gfx.drawLine(px, py, nx, ny, color);
        px = nx; py = ny;
      }
      break;
    }
    case MOUTH_SMALL_O:
      gfx.fillCircle(cx, cy, 5, color);
      break;
    case MOUTH_TRIANGLE:
      gfx.fillTriangle(cx - w, cy - 4, cx + w, cy - 4, cx, cy + 16, color);
      break;
    case MOUTH_LINE_SIDE:
      gfx.drawLine(cx + 6, cy, cx + 6 + w / 2, cy, color);
      gfx.drawLine(cx + 6, cy + 1, cx + 6 + w / 2, cy + 1, color);
      break;
    case MOUTH_SMIRK:
      gfx.drawLine(cx - w, cy, cx, cy, color);
      drawArcUp(gfx, cx + w / 2, cy, w / 2, color);
      break;
    case MOUTH_LINE:
    default:
      gfx.drawLine(cx - w, cy, cx + w, cy, color);
      gfx.drawLine(cx - w, cy + 1, cx + w, cy + 1, color);
      break;
  }
}

// まばたき(eyeOpenness)とサチE��ーチEsaccadeOffsetX/Y)のタイマ�EめEフレーム刁E��める
void updateFaceAnimationState(const ExpressionParams& p) {
  unsigned long now = millis();

  // --- まばたき ---
  if (p.blinkEnabled) {
    if (blinkPhase == BLINK_IDLE) {
      if (nextBlinkAt == 0) nextBlinkAt = now + random(p.blinkMinMs, p.blinkMaxMs);
      eyeOpenness = p.maxOpenness;
      if (now >= nextBlinkAt) {
        blinkPhase = BLINK_CLOSING;
        blinkPhaseStartAt = now;
      }
    } else if (blinkPhase == BLINK_CLOSING) {
      float t = (float)(now - blinkPhaseStartAt) / BLINK_ANIM_MS;
      if (t >= 1.0f) {
        eyeOpenness = 0.0f;
        blinkPhase = BLINK_OPENING;
        blinkPhaseStartAt = now;
      } else {
        eyeOpenness = p.maxOpenness * (1.0f - t);
      }
    } else { // BLINK_OPENING
      float t = (float)(now - blinkPhaseStartAt) / BLINK_ANIM_MS;
      if (t >= 1.0f) {
        eyeOpenness = p.maxOpenness;
        blinkPhase = BLINK_IDLE;
        nextBlinkAt = now + random(p.blinkMinMs, p.blinkMaxMs);
      } else {
        eyeOpenness = p.maxOpenness * t;
      }
    }
  } else {
    eyeOpenness = p.maxOpenness;
    blinkPhase = BLINK_IDLE;
    nextBlinkAt = 0;
  }

  // --- サチE��ーチEきょろきめE��) ---
  int maxOffset = (int)(FACE_EYE_RADIUS * p.saccadeRangeScale);
  if (p.saccadeEnabled && maxOffset > 0) {
    if (now >= nextSaccadeAt && saccadeHoldUntil == 0) {
      saccadeTargetX = random(-maxOffset, maxOffset + 1);
      saccadeTargetY = p.saccadeDownOnly ? random(0, maxOffset + 1) : random(-maxOffset / 2, maxOffset + 1);
      saccadeHoldUntil = now + random(300, 601);
    }
    int dx = saccadeTargetX - saccadeOffsetX;
    int dy = saccadeTargetY - saccadeOffsetY;
    saccadeOffsetX += (abs(dx) <= 2) ? dx : dx / 3;
    saccadeOffsetY += (abs(dy) <= 2) ? dy : dy / 3;

    if (saccadeHoldUntil != 0 && now >= saccadeHoldUntil) {
      saccadeHoldUntil = 0;
      saccadeTargetX = 0;
      saccadeTargetY = 0;
      nextSaccadeAt = now + random(2000, 5001);
    }
  } else {
    saccadeOffsetX = 0; saccadeOffsetY = 0;
    saccadeTargetX = 0; saccadeTargetY = 0;
    saccadeHoldUntil = 0;
  }

  // --- 目の形状モーフィング(現在値を目標値へ指数的に近づけ、滑らかな表情遷移にする) ---
  const float EYE_MORPH_RATE = 0.15f;
  curEyeWidthScale  += (p.eyeWidthScale  - curEyeWidthScale)  * EYE_MORPH_RATE;
  curEyeHeightScale += (p.eyeHeightScale - curEyeHeightScale) * EYE_MORPH_RATE;
  curEyeRadiusScale += (p.eyeRadiusScale - curEyeRadiusScale) * EYE_MORPH_RATE;
  curEyeTired += (p.eyeTired - curEyeTired) * EYE_MORPH_RATE;
  curEyeAngry += (p.eyeAngry - curEyeAngry) * EYE_MORPH_RATE;
  curEyeHappy += (p.eyeHappy - curEyeHappy) * EYE_MORPH_RATE;
}

// 元キャンバスの内容を指定サイズの小キャンバスへ最近傍補間で縮小コピーする(分割レイアウトの縮小顔用)
void downscaleCanvas(GFXcanvas16 &src, GFXcanvas16 &dst) {
  uint16_t* s = src.getBuffer();
  uint16_t* d = dst.getBuffer();
  int sw = src.width(), sh = src.height();
  int dw = dst.width(), dh = dst.height();
  for (int y = 0; y < dh; y++) {
    int sy = y * sh / dh;
    for (int x = 0; x < dw; x++) {
      int sx = x * sw / dw;
      d[y * dw + x] = s[sy * sw + sx];
    }
  }
}

// 口の開き具合(intensity)を算出する。常時ゆっくりとした呼吸のような開閉を重畳し、
// HAPPY表情で走行中の場合はさらに速度に応じて大きく開くようにする。
float computeMouthIntensity(ExpressionId expr) {
  float breathing = 0.5f + 0.5f * sinf(millis() / 1200.0f);
  float base = 0.15f + 0.20f * breathing;
  if (expr == EXPR_HAPPY) {
    float driveBoost = constrain((currentSpeedL + currentSpeedR) / 510.0f, 0.0f, 1.0f);
    return constrain(base + driveBoost, 0.0f, 1.0f);
  }
  return base;
}

// 現在表示すべき画面レイアウトを判定する(優先度: ①通信断絶 > ②フリート指示 > ③起動直後 > ④全画面顔)
void resolveFaceLayout(FaceLayoutMode &layout, SplitBottomContent &content) {
  if (!isDeviceConnected) {
    layout = LAYOUT_SPLIT;
    content = SPLIT_BOTTOM_ALERT;
    return;
  }
  if (fleetLayoutOverrideActive) {
    layout = fleetLayoutOverride;
    content = SPLIT_BOTTOM_SENSOR;
    return;
  }
  if (millis() < bootSplitUntil) {
    layout = LAYOUT_SPLIT;
    content = SPLIT_BOTTOM_SENSOR;
    return;
  }
  layout = LAYOUT_FULL_FACE;
  content = SPLIT_BOTTOM_SENSOR;
}

// 表情(顔)画面の1フレーム更新。レイアウトに応じて全画面表示または縮小表示を切り替える。
void updateFace(FaceLayoutMode layout) {
  currentExpression = resolveExpression();

  // SHOCKED突入直後: 白フラッシュ(1フレーム)→次フレームで全画面を黒に戻してから通常描画
  // (手動オーバーライド中でSHOCKEDが表示されない場合はフラッシュ自体を省略する)
  if (shockedFlashPending) {
    shockedFlashPending = false;
    if (currentExpression == EXPR_SHOCKED) {
      display.fillScreen(ST77XX_WHITE);
      needFullClear = true;
      return;
    }
  }
  if (needFullClear) {
    display.fillScreen(ST77XX_BLACK);
    needFullClear = false;
  }

  const ExpressionParams& p = EXPRESSION_TABLE[currentExpression];
  updateFaceAnimationState(p);

  eyesCanvas.fillScreen(ST77XX_BLACK);
  drawEyes(eyesCanvas, p, eyeOpenness, saccadeOffsetX, saccadeOffsetY);

  float mouthIntensity = computeMouthIntensity(currentExpression);
  mouthCanvas.fillScreen(ST77XX_BLACK);
  drawMouth(mouthCanvas, p.mouthShape, p.mouthColor, mouthIntensity);

  if (layout == LAYOUT_FULL_FACE) {
    display.drawRGBBitmap(FACE_MOUTH_BOX_X, FACE_MOUTH_BOX_Y, mouthCanvas.getBuffer(), FACE_MOUTH_BOX_W, FACE_MOUTH_BOX_H);
    display.drawRGBBitmap(FACE_EYES_BOX_X, FACE_EYES_BOX_Y, eyesCanvas.getBuffer(), FACE_EYES_BOX_W, FACE_EYES_BOX_H);
  } else {
    downscaleCanvas(eyesCanvas, eyesCanvasSmall);
    downscaleCanvas(mouthCanvas, mouthCanvasSmall);
    display.drawRGBBitmap(SPLIT_EYES_X, SPLIT_EYES_Y, eyesCanvasSmall.getBuffer(), SPLIT_EYES_W, SPLIT_EYES_H);
    display.drawRGBBitmap(SPLIT_MOUTH_X, SPLIT_MOUTH_Y, mouthCanvasSmall.getBuffer(), SPLIT_MOUTH_W, SPLIT_MOUTH_H);
  }
}

// ----------------------------------------------------------------------------
// 通信トランスポ�Eト実裁E(WebSocket / BLE(NUS) / Classic BT(SPP))
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
  // streamStart(受信): {"type":"streamStart"} -> Core0タスクぁE00ms間隔で連続imageFrame送信を開姁E
  // streamStop (受信): {"type":"streamStop"}  -> 連続�E信を停止
  // setExpression(受信): {"type":"setExpression","expression":"happy","durationMs":8000}
  // ping    (受信): {"type":"ping"}
  // --------------------------------------------------------------------------
  WebSocketsClient webSocket;
  Preferences preferences;
  unsigned long lastTelemetryTime = 0;
  const unsigned long TELEMETRY_INTERVAL_MS = 1000; // フェイルセーフ�E生存確認も兼ねめE

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

  // Fleet Hubから渡される表情名(文字列)をExpressionIdへ変換する。未知の値はNEUTRAL扱いとする。
  ExpressionId expressionIdFromString(const char* name) {
    if (strcmp(name, "happy") == 0) return EXPR_HAPPY;
    if (strcmp(name, "fun") == 0) return EXPR_FUN;
    if (strcmp(name, "laugh") == 0) return EXPR_LAUGH;
    if (strcmp(name, "surprised") == 0) return EXPR_SURPRISED;
    if (strcmp(name, "curious") == 0) return EXPR_CURIOUS;
    if (strcmp(name, "thinking") == 0) return EXPR_THINKING;
    if (strcmp(name, "wink") == 0) return EXPR_WINK;
    if (strcmp(name, "worried") == 0) return EXPR_WORRIED;
    if (strcmp(name, "angry") == 0) return EXPR_ANGRY;
    if (strcmp(name, "sleepy") == 0) return EXPR_SLEEPY;
    if (strcmp(name, "love") == 0) return EXPR_LOVE;
    if (strcmp(name, "shocked") == 0) return EXPR_SHOCKED;
    if (strcmp(name, "giveup") == 0) return EXPR_GIVEUP;
    if (strcmp(name, "shy") == 0) return EXPR_SHY;
    if (strcmp(name, "composed") == 0) return EXPR_COMPOSED;
    return EXPR_NEUTRAL;
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
    } else if (strcmp(type, "setExpression") == 0) {
      const char* expr = doc["expression"] | "neutral";
      unsigned long durationMs = doc["durationMs"] | DEFAULT_MANUAL_DURATION_MS;
      setExpression(expressionIdFromString(expr), durationMs);
    } else if (strcmp(type, "setDisplayLayout") == 0) {
      const char* layoutStr = doc["layout"] | "auto";
      if (strcmp(layoutStr, "split") == 0) {
        fleetLayoutOverride = LAYOUT_SPLIT;
        fleetLayoutOverrideActive = true;
      } else if (strcmp(layoutStr, "full") == 0) {
        fleetLayoutOverride = LAYOUT_FULL_FACE;
        fleetLayoutOverrideActive = true;
      } else {
        fleetLayoutOverrideActive = false; // "auto": 自動判定(起動直後分割/通常全画面/断絶時アラート)に戻す
      }
    }
    // "ping" はlastPacketTime更新のみで応答不要E(次回telemetryで生存確誁E
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
      // 刁E��後�E確実にアドバタイズ再開
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

        // ACK通知�E�コマンド変化時、また�E1秒周期で間引いて送信しバチE��ァ溢れを防止�E�E
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
// 初期匁E(setup)
// ----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(100);

  generateDeviceId();

  // 1. TFT初期化(MISOは未使用のため明示的に無効化してからSPIバスを開始)
  pinMode(TFT_BL, OUTPUT);
  digitalWrite(TFT_BL, HIGH); // バックライチEN
  SPI.begin(TFT_SCLK, -1, TFT_MOSI, TFT_CS);
  display.init(TFT_PANEL_W, TFT_PANEL_H);
  display.setRotation(2); // 170x320のポートレート表示(USBポートを下にして使用、実機確認により180度反転)
  display.fillScreen(ST77XX_BLACK);
  display.setTextColor(ST77XX_WHITE);
  display.setTextSize(2);
  display.setCursor(4, 20);
  display.println("ESP32 RC ROBUST V4");
  display.setTextSize(1);
  display.setCursor(4, 44);
  display.println(deviceId);

  // 起動最初期のヒープ圧迸を避けるため、分割レイアウト下半分キャンバスはここで遅延確保する
  bottomCanvas = new GFXcanvas16(TFT_PANEL_W, SPLIT_BOTTOM_H);

  // 2. モーターピン初期化(L298Nを6ピンで直接制御: ENA/IN1/IN2/ENB/IN3/IN4)
  pinMode(PIN_IN1, OUTPUT);
  pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_IN3, OUTPUT);
  pinMode(PIN_IN4, OUTPUT);

  setupPWM();
  applyMotorControl('e', 0, 0);

#if TRANSPORT_MODE == MODE_WEBSOCKET
  // 3. WebSocket送受信直列化用ミューテックス
  wsMutex = xSemaphoreCreateRecursiveMutex();
#endif

#if TRANSPORT_MODE == MODE_WEBSOCKET
  // 4. 保存済み表示名の復允E& Wi-Fi/WebSocket初期匁E
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
  // 4. BLE初期匁E
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
  bootSplitUntil = millis() + BOOT_SPLIT_DURATION_MS; // 起動直後は分割レイアウトで様子を確認できるようにする
}

// ----------------------------------------------------------------------------
// メインルーチE(loop)
// ----------------------------------------------------------------------------
void loop() {
#if TRANSPORT_MODE == MODE_WEBSOCKET
  if (xSemaphoreTakeRecursive(wsMutex, portMAX_DELAY)) {
    webSocket.loop();
    xSemaphoreGiveRecursive(wsMutex);
  }
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

  // ① フェイルセーフ�E琁E 走行中に通信パケチE��ぁE.5秒途絶えたら�E動停止
  if (currentCommand != 'e' && (now - lastPacketTime > FAILSAFE_TIMEOUT_MS)) {
    applyMotorControl('e', 0, 0);
    strncpy(lastRawBuffer, "TIMEOUT_STOP", sizeof(lastRawBuffer));
    // 表惁E��ンジン: フェイルセーフ発動をEXPR_SHOCKEDとして一定時間表示する
    shockedUntil = now + SHOCKED_HOLD_MS;
    shockedFlashPending = true;
  }

#if TRANSPORT_MODE == MODE_WEBSOCKET
  // ①b 定期チE��メトリ送信 (フリートハブ�Eの生存確認にも利用)
  if (isDeviceConnected && (now - lastTelemetryTime > TELEMETRY_INTERVAL_MS)) {
    lastTelemetryTime = now;
    sendTelemetry();
  }
#endif

#if TRANSPORT_MODE == MODE_BLE
  // ② ゾンビ接続キル & 自己修復:
  // 接続中とマ�EクされてぁE��ぁE0秒間パケチE��が届かなぁE��合、接続が半死にしてぁE��可能性があるためアドバタイズを強制再送E
  if (isDeviceConnected && (now - lastPacketTime > ZOMBIE_TIMEOUT_MS)) {
    if (currentCommand != 'e') {
      applyMotorControl('e', 0, 0);
    }
  }
#endif

  // ③ 画面レイアウトの判定 (通信断絶 > フリート指示 > 起動直後 > 通常の全画面顔)
  FaceLayoutMode layout;
  SplitBottomContent bottomContent;
  resolveFaceLayout(layout, bottomContent);
  if (layout != lastFaceLayoutMode) {
    lastFaceLayoutMode = layout;
    forceFullRedraw = true;
  }

  // ④ TFT定期更新: 表情画面(部分再描画/約16fps)は毎フレーム、分割時の下半分(約200ms周期)はそれより低頻度で更新する
  if (now - lastFaceTime > FACE_INTERVAL_MS) {
    lastFaceTime = now;
    if (forceFullRedraw) {
      display.fillScreen(ST77XX_BLACK);
      forceFullRedraw = false;
    }
    updateFace(layout);
  }
  if (layout == LAYOUT_SPLIT && (now - lastDisplayTime > DISPLAY_INTERVAL_MS)) {
    lastDisplayTime = now;
    updateSplitBottom(bottomContent);
  }

  // CPUタスク刁E��替え�E隙間を確俁E
  yield();
}
