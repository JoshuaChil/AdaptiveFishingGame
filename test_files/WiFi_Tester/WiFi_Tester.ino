#include <WiFi.h>
#include <esp_now.h>

const uint8_t receiverMac[] = {0x58, 0x8C, 0x81, 0xA9, 0x4A, 0x9C};

void setup()
{
  Serial.begin(115200);
  delay(1000);

  WiFi.mode(WIFI_STA);
  
  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW System Failed to Start");
    return;
  }

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, receiverMac, 6);
  peer.channel = 0;
  peer.encrypt = false;

  if (esp_now_add_peer(&peer) != ESP_OK) {
    Serial.println("Faiiled to add peer");
    return;
  }

  Serial.println("Peer chip added");


}

void loop() {
  char message = 'A';

  esp_err_t result = esp_now_send(receiverMac, (uint8_t*)&message, sizeof(message));

  if (result == ESP_OK) {
    Serial.println("Packet sent");
  }
  else {
    Serial.println("Send failed");
  }

  delay(2000);
}
