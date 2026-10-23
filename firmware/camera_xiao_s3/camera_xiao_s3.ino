#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <esp_camera.h>
#include <esp_mac.h>
#include <mbedtls/base64.h>

#if __has_include("wifi_secrets.h")
#include "wifi_secrets.h"
#else
#include "wifi_secrets.example.h"
#endif

#if !CONFIG_IDF_TARGET_ESP32S3
#error "Select Seeed Studio XIAO ESP32S3 with OPI PSRAM enabled"
#endif

constexpr size_t MAX_JPEG_BYTES = 120 * 1024;
constexpr size_t MAX_FRAME_BYTES = 4 * ((MAX_JPEG_BYTES + 2) / 3) + 256;
constexpr uint32_t FRAME_INTERVAL_MS = 200;
constexpr uint32_t HEARTBEAT_INTERVAL_MS = 1000;
constexpr uint32_t STREAM_TIMEOUT_MS = 5000;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 5000;

WebSocketsClient webSocket;
char deviceId[24];
char* frameMessage = nullptr;
bool cameraReady = false;
bool hubConnected = false;
bool streaming = false;
bool captureRequested = false;
uint32_t lastHubMessage = 0;
uint32_t lastHeartbeat = 0;
uint32_t lastFrame = 0;
uint32_t lastWifiReconnectAttempt = 0;
wl_status_t lastWifiStatus = WL_NO_SHIELD;
uint32_t lastConnectionReport = 0;

bool initializeCamera() {
  if (!psramFound()) {
    Serial.println("Camera requires OPI PSRAM; enable it in board settings");
    return false;
  }
  Serial.printf("PSRAM detected: %u bytes\n", static_cast<unsigned>(ESP.getPsramSize()));
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_pwdn = -1;
  config.pin_reset = -1;
  config.pin_xclk = 10;
  config.pin_sccb_sda = 40;
  config.pin_sccb_scl = 39;
  config.pin_d0 = 15;
  config.pin_d1 = 17;
  config.pin_d2 = 18;
  config.pin_d3 = 16;
  config.pin_d4 = 14;
  config.pin_d5 = 12;
  config.pin_d6 = 11;
  config.pin_d7 = 48;
  config.pin_vsync = 38;
  config.pin_href = 47;
  config.pin_pclk = 13;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_QVGA;
  config.jpeg_quality = 16;
  config.fb_count = 2;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.grab_mode = CAMERA_GRAB_LATEST;
  const esp_err_t result = esp_camera_init(&config);
  if (result != ESP_OK) {
    Serial.printf("Camera initialization failed: 0x%x\n", result);
    return false;
  }
  sensor_t* sensor = esp_camera_sensor_get();
  Serial.printf("Camera sensor PID: 0x%04x\n", sensor ? sensor->id.PID : 0);
  if (sensor && sensor->id.PID == OV3660_PID) {
    sensor->set_vflip(sensor, 1);
  }
  frameMessage = static_cast<char*>(ps_malloc(MAX_FRAME_BYTES));
  if (!frameMessage) {
    Serial.println("Unable to allocate camera message buffer");
    esp_camera_deinit();
    return false;
  }
  camera_fb_t* frame = esp_camera_fb_get();
  const bool validFrame = frame && frame->format == PIXFORMAT_JPEG && frame->len >= 4
    && frame->len <= MAX_JPEG_BYTES && frame->buf[0] == 0xff && frame->buf[1] == 0xd8;
  if (validFrame) {
    Serial.printf("Camera self-test: JPEG %ux%u, %u bytes\n", static_cast<unsigned>(frame->width),
      static_cast<unsigned>(frame->height), static_cast<unsigned>(frame->len));
  } else {
    Serial.println("Camera self-test failed: no valid JPEG frame");
  }
  if (frame) esp_camera_fb_return(frame);
  if (!validFrame) {
    free(frameMessage);
    frameMessage = nullptr;
    esp_camera_deinit();
    return false;
  }
  return true;
}

void sendHello() {
  StaticJsonDocument<256> message;
  message["type"] = "hello";
  message["deviceId"] = deviceId;
  message["name"] = deviceId;
  message["fw"] = "camera-1.0.0";
  message.createNestedArray("capabilities").add("camera");
  char payload[256];
  const size_t length = serializeJson(message, payload, sizeof(payload));
  webSocket.sendTXT(payload, length);
}

void sendFrame() {
  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame) {
    Serial.println("Camera capture failed");
    return;
  }
  if (frame->format != PIXFORMAT_JPEG || frame->len > MAX_JPEG_BYTES) {
    Serial.println("Camera frame rejected: format or size limit");
    esp_camera_fb_return(frame);
    return;
  }
  const int headerLength = snprintf(frameMessage, MAX_FRAME_BYTES,
    "{\"type\":\"imageFrame\",\"deviceId\":\"%s\",\"width\":%u,\"height\":%u,\"format\":\"jpeg\",\"dataB64\":\"",
    deviceId, static_cast<unsigned>(frame->width), static_cast<unsigned>(frame->height));
  size_t encodedLength = 0;
  const int result = mbedtls_base64_encode(
    reinterpret_cast<unsigned char*>(frameMessage + headerLength), MAX_FRAME_BYTES - headerLength - 3,
    &encodedLength, frame->buf, frame->len);
  esp_camera_fb_return(frame);
  if (result != 0) {
    Serial.println("Camera base64 encoding failed");
    return;
  }
  memcpy(frameMessage + headerLength + encodedLength, "\"}", 3);
  if (!webSocket.sendTXT(frameMessage, headerLength + encodedLength + 2)) {
    Serial.println("Camera frame send failed; stream stopped");
    streaming = false;
  } else if (!streaming) {
    Serial.println("Snapshot sent");
  }
}

void onWebSocketEvent(WStype_t event, uint8_t* payload, size_t length) {
  if (event == WStype_CONNECTED) {
    Serial.println("Fleet Hub connected");
    hubConnected = true;
    streaming = false;
    captureRequested = false;
    lastHubMessage = millis();
    sendHello();
  } else if (event == WStype_DISCONNECTED) {
    if (hubConnected) Serial.println("Fleet Hub disconnected; stream stopped");
    hubConnected = false;
    streaming = false;
    captureRequested = false;
  } else if (event == WStype_TEXT && length <= 512) {
    StaticJsonDocument<256> message;
    if (deserializeJson(message, payload, length)) return;
    const char* type = message["type"] | "";
    if (!strcmp(type, "ping")) {
      lastHubMessage = millis();
    } else if (!strcmp(type, "captureImage")) {
      captureRequested = true;
      lastHubMessage = millis();
    } else if (!strcmp(type, "streamStart")) {
      streaming = true;
      Serial.println("Live stream started");
      lastHubMessage = millis();
    } else if (!strcmp(type, "streamStop")) {
      streaming = false;
      Serial.println("Live stream stopped");
      captureRequested = false;
      lastHubMessage = millis();
    }
  }
}

void setup() {
  Serial.begin(115200);
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(deviceId, sizeof(deviceId), "cam-%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  cameraReady = initializeCamera();
  if (!cameraReady) return;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println("Connecting to Wi-Fi");
  webSocket.begin(FLEET_HUB_HOST, FLEET_HUB_PORT, "/ws/device");
  webSocket.onEvent(onWebSocketEvent);
  webSocket.setReconnectInterval(3000);
  Serial.printf("Camera %s -> %s:%d\n", deviceId, FLEET_HUB_HOST, FLEET_HUB_PORT);
}

void loop() {
  if (!cameraReady) {
    delay(100);
    return;
  }
  const wl_status_t wifiStatus = WiFi.status();
  if (wifiStatus != lastWifiStatus) {
    const bool wasConnected = lastWifiStatus == WL_CONNECTED;
    lastWifiStatus = wifiStatus;
    if (wifiStatus == WL_CONNECTED) {
      Serial.print("Wi-Fi connected: ");
      Serial.println(WiFi.localIP());
    } else if (wasConnected) {
      Serial.println("Wi-Fi disconnected; reconnecting");
    }
  }
  webSocket.loop();
  const uint32_t now = millis();
  if (wifiStatus != WL_CONNECTED && now - lastWifiReconnectAttempt >= WIFI_RECONNECT_INTERVAL_MS) {
    lastWifiReconnectAttempt = now;
    Serial.println("Wi-Fi reconnect attempt");
    WiFi.reconnect();
  }
  if (!hubConnected && now - lastConnectionReport >= 10000) {
    lastConnectionReport = now;
    if (wifiStatus == WL_CONNECTED) {
      Serial.printf("Waiting for Fleet Hub: %s:%d\n", FLEET_HUB_HOST, FLEET_HUB_PORT);
    } else {
      Serial.printf("Waiting for 2.4GHz Wi-Fi (status=%d, 1=SSID unavailable, 6=disconnected)\n",
        static_cast<int>(wifiStatus));
    }
  }
  if (streaming && now - lastHubMessage > STREAM_TIMEOUT_MS) {
    streaming = false;
    Serial.println("Live stream stopped: Hub timeout");
  }
  if (hubConnected && now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = now;
    char message[96];
    const int length = snprintf(message, sizeof(message), "{\"type\":\"heartbeat\",\"deviceId\":\"%s\"}", deviceId);
    webSocket.sendTXT(message, length);
  }
  if (hubConnected && (captureRequested || streaming) && now - lastFrame >= FRAME_INTERVAL_MS) {
    captureRequested = false;
    lastFrame = now;
    sendFrame();
  }
  delay(2);
}