// WiFi接続単体切り分け用の最小テストスケッチ (カメラ/TFT/モーター等は一切含まない)
#include <WiFi.h>
#include "wifi_secrets.h"

void printEncType(wifi_auth_mode_t authmode) {
  switch (authmode) {
    case WIFI_AUTH_OPEN: Serial.print("OPEN"); break;
    case WIFI_AUTH_WEP: Serial.print("WEP"); break;
    case WIFI_AUTH_WPA_PSK: Serial.print("WPA_PSK"); break;
    case WIFI_AUTH_WPA2_PSK: Serial.print("WPA2_PSK"); break;
    case WIFI_AUTH_WPA_WPA2_PSK: Serial.print("WPA_WPA2_PSK"); break;
    case WIFI_AUTH_WPA2_ENTERPRISE: Serial.print("WPA2_ENTERPRISE"); break;
    case WIFI_AUTH_WPA3_PSK: Serial.print("WPA3_PSK"); break;
    case WIFI_AUTH_WPA2_WPA3_PSK: Serial.print("WPA2_WPA3_PSK"); break;
    default: Serial.print("UNKNOWN"); break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("[DIAG] WiFi-only test start");
  Serial.printf("[DIAG] Target SSID: \"%s\"\n", WIFI_SSID);
  Serial.printf("[DIAG] ESP32 MAC: %s\n", WiFi.macAddress().c_str());

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(200);

  Serial.println("[DIAG] Scanning nearby Wi-Fi networks...");
  int n = WiFi.scanNetworks();
  Serial.printf("[DIAG] Scan done. %d network(s) found.\n", n);
  bool targetFound = false;
  for (int i = 0; i < n; i++) {
    Serial.printf("[DIAG] %2d: SSID=\"%s\" RSSI=%d ch=%d enc=", i, WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.channel(i));
    printEncType(WiFi.encryptionType(i));
    Serial.println();
    if (WiFi.SSID(i) == WIFI_SSID) targetFound = true;
  }
  Serial.printf("[DIAG] Target SSID \"%s\" visible from ESP32: %s\n", WIFI_SSID, targetFound ? "YES" : "NO");

  Serial.println("[DIAG] Connecting...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(300);
    Serial.printf("[DIAG] status=%d\n", WiFi.status());
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[DIAG] Connected! IP=%s RSSI=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    Serial.printf("[DIAG] Connect failed. Final status=%d\n", WiFi.status());
  }
}

void loop() {
  delay(1000);
}
