#include <WiFi.h>
#include <esp_now.h>

const int BUTTON_A = D1;
const int BUTTON_B = D2;
const uint8_t receiverMac[] = {0x58, 0x8C, 0x81, 0xA9, 0x4A, 0x9C};
int state = 0;

int lastA = HIGH;
int lastB = HIGH;

struct PositionCommand {
  uint8_t magic; // the key check value
  uint8_t position;  // the actual position command
};

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_A, INPUT_PULLUP);
  pinMode(BUTTON_B, INPUT_PULLUP);

  WiFi.mode(WIFI_STA);

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP_NOW Failed to start");
    return;
  }

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, receiverMac, 6);
  peer.channel = 0;
  peer.encrypt = false;

  if (esp_now_add_peer(&peer) != ESP_OK) {
    Serial.println("Failed to add peer");
    return;
  }

  Serial.println("Peer chip added");

}

void sendPosition() {
    PositionCommand cmd = {0xA5, (uint8_t)state};
    esp_err_t result = esp_now_send(receiverMac, (uint8_t*)&cmd, sizeof(cmd));

    if (result == ESP_OK) {
    Serial.print("Sent position: ");
    Serial.println(state);
    }
    else {
    Serial.println("Send failed");
    }
}

void loop() {
  int a = digitalRead(BUTTON_A);
  int b = digitalRead(BUTTON_B);

  if (a == LOW && lastA == HIGH) {
    state = (state + 1) % 5;
    sendPosition();
  }

  if (b == LOW && lastB == HIGH) {
    state = (state + 4) % 5;
    sendPosition();
  }

  lastA = a;
  lastB = b;
  delay(20);
}