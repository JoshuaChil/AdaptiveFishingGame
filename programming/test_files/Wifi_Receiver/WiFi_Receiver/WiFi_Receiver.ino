#include <WiFi.h>
#include <esp_now.h>

void onReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  Serial.printf("From %02X:%02X:%02X:%02X:%02X:%02X ", info->src_addr[0],info->src_addr[1],info->src_addr[2],
  info->src_addr[3],info->src_addr[4],info->src_addr[5]);
  Serial.print("Received ");
  Serial.print(len);
  Serial.print(" byte(s): ");
  Serial.println((char) data[0]);
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  WiFi.mode(WIFI_STA);

  if (esp_now_init() != ESP_OK) {
    Serial.println("Failed to start ESP-NOW");
    return;
  }

  esp_now_register_recv_cb(onReceive);

  Serial.println("Receiver ready, listening");

}

void loop() {
  
}