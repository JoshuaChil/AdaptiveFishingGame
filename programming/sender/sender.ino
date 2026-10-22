#include <WiFi.h>
#include <esp_now.h>

const int BUTTON_A = D1;
const int BUTTON_B = D2;
const uint8_t receiverMac[] = {0x58, 0x8C, 0x81, 0xA9, 0x4A, 0x9C};
int pivot_state = 0;
bool reel_down = false;
int direction = 1;

int lastA = HIGH;
int lastB = HIGH;

struct PositionCommand {
  uint8_t type; // the key check value
  uint8_t position;  // the actual position command
};

struct ReelCommand {
  uint8_t type;
  uint8_t reelState;
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
    PositionCommand cmd = {1, (uint8_t)pivot_state};
    esp_err_t result = esp_now_send(receiverMac, (uint8_t*)&cmd, sizeof(cmd));

    if (result == ESP_OK) {
    Serial.print("Sent position: ");
    Serial.println(pivot_state);
    }
    else {
    Serial.println("Send failed");
    }
}

void sendReelState() {
    ReelCommand cmd = {2, (uint8_t)reel_down};
    esp_err_t result = esp_now_send(receiverMac, (uint8_t*)&cmd, sizeof(cmd));

    if (result == ESP_OK) {
    Serial.print("Sent state, reel down is: ");
    Serial.println(reel_down);
    }
    else {
    Serial.println("Send failed");
    }
}

void loop() {
  int a = digitalRead(BUTTON_A);
  int b = digitalRead(BUTTON_B);

  if (a == LOW && lastA == HIGH) {
    reel_down = !reel_down;
    sendReelState();
  }

 if (b == LOW && lastB == HIGH) {
  pivot_state += direction;

  if (pivot_state >= 4) {
    pivot_state = 4;
    direction = -1;
  }
  else if (pivot_state <= 0) {
    pivot_state = 0;
    direction = 1;
  }

  sendPosition();
}

  lastA = a;
  lastB = b;
  delay(20);
}