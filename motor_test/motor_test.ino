/*
 * ============================================================================
 * モーター & L298N ハードウェア単体自動診断スケッチ
 * 目的: BLE通信やWeb UIを経由せず、配線・電源・モーターの正常性を直接検証する
 * ============================================================================
 */

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C
#define OLED_SDA_PIN 21
#define OLED_SCL_PIN 22

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ピンアサイン
const int PIN_ENA = 14;  // 右モーター PWM
const int PIN_IN1 = 27;  // 右モーター 方向1
const int PIN_IN2 = 26;  // 右モーター 方向2

const int PIN_IN3 = 32;  // 左モーター 方向1
const int PIN_IN4 = 33;  // 左モーター 方向2
const int PIN_ENB = 25;  // 左モーター PWM

const int PWM_FREQ = 30000;
const int PWM_RESOLUTION = 8;

void setupPWM() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  ledcAttach(PIN_ENA, PWM_FREQ, PWM_RESOLUTION);
  ledcAttach(PIN_ENB, PWM_FREQ, PWM_RESOLUTION);
#else
  ledcSetup(0, PWM_FREQ, PWM_RESOLUTION);
  ledcAttachPin(PIN_ENA, 0);
  ledcSetup(1, PWM_FREQ, PWM_RESOLUTION);
  ledcAttachPin(PIN_ENB, 1);
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

void setMotors(int in1, int in2, int in3, int in4, int speedR, int speedL) {
  digitalWrite(PIN_IN1, in1);
  digitalWrite(PIN_IN2, in2);
  digitalWrite(PIN_IN3, in3);
  digitalWrite(PIN_IN4, in4);
  writePWM(PIN_ENA, 0, speedR);
  writePWM(PIN_ENB, 1, speedL);
}

void updateOLED(const char* status, int speedR, int speedL) {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("--- HW MOTOR TEST ---");
  display.setCursor(0, 16);
  display.printf("STATUS: %s\n", status);
  display.setCursor(0, 32);
  display.printf("RIGHT PWM: %3d\n", speedR);
  display.setCursor(0, 44);
  display.printf("LEFT  PWM: %3d\n", speedL);
  display.display();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n\n========================================");
  Serial.println("  ESP32 Hardware Diagnostic Test Start  ");
  Serial.println("========================================");

  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
  if (display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(10, 20);
    display.println("STARTING TEST...");
    display.display();
  }

  pinMode(PIN_IN1, OUTPUT);
  pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_IN3, OUTPUT);
  pinMode(PIN_IN4, OUTPUT);

  setupPWM();
  setMotors(LOW, LOW, LOW, LOW, 0, 0);
  delay(1000);
}

void loop() {
  // 1. 前進テスト (PWM 200)
  Serial.println("[TEST 1/4] FORWARD (PWM: 200)");
  updateOLED("FORWARD", 200, 200);
  setMotors(LOW, HIGH, LOW, HIGH, 200, 200);
  delay(2500);

  // 2. 停止 (1秒)
  Serial.println("[PAUSE] STOP");
  updateOLED("STOP", 0, 0);
  setMotors(LOW, LOW, LOW, LOW, 0, 0);
  delay(1000);

  // 3. 後退テスト (PWM 200)
  Serial.println("[TEST 2/4] REVERSE (PWM: 200)");
  updateOLED("REVERSE", 200, 200);
  setMotors(HIGH, LOW, HIGH, LOW, 200, 200);
  delay(2500);

  // 4. 停止 (1秒)
  Serial.println("[PAUSE] STOP");
  updateOLED("STOP", 0, 0);
  setMotors(LOW, LOW, LOW, LOW, 0, 0);
  delay(1000);

  // 5. 右旋回テスト
  Serial.println("[TEST 3/4] TURN RIGHT (PWM: 200)");
  updateOLED("TURN RIGHT", 200, 200);
  setMotors(HIGH, LOW, LOW, HIGH, 200, 200);
  delay(2000);

  // 6. 停止 (1秒)
  Serial.println("[PAUSE] STOP");
  updateOLED("STOP", 0, 0);
  setMotors(LOW, LOW, LOW, LOW, 0, 0);
  delay(1000);

  // 7. 左旋回テスト
  Serial.println("[TEST 4/4] TURN LEFT (PWM: 200)");
  updateOLED("TURN LEFT", 200, 200);
  setMotors(LOW, HIGH, HIGH, LOW, 200, 200);
  delay(2000);

  // 8. 停止 (2秒)
  Serial.println("[CYCLE COMPLETE] STOPPING FOR 2s");
  updateOLED("CYCLE DONE", 0, 0);
  setMotors(LOW, LOW, LOW, LOW, 0, 0);
  delay(2000);
}
