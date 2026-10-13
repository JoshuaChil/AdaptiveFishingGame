#include <WiFi.h>
#include <esp_now.h>


struct PositionCommand {
  uint8_t magic;
  uint8_t position;
};

const int STEPS_PER_POSITION = 256;

volatile int targetPosition = 0;
int currentStep = 0;
int row = 0;

void onReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len != sizeof(PositionCommand)) {
    return;
  }

  PositionCommand cmd;
  memcpy(&cmd, data, sizeof(cmd));

  if (cmd.magic != 0xA5 || cmd.position > 4) {
    return;
  }

  targetPosition = cmd.position;
}


const int motorPins[4] = {D1, D2, D3, D4};

const int sequence[4][4] = {
  {1, 1, 0, 0},
  {0, 1, 1, 0},
  {0, 0, 1, 1},
  {1, 0 ,0, 1},
};

void stepOnce(bool forward) {
  if (forward) {
    row = (row + 1) % 4;
    currentStep++;
  }
  else {
    row = (row + 3) % 4;
    currentStep --;
  }

  for (int coil = 0; coil < 4; coil ++) {
    digitalWrite(motorPins[coil], sequence[row][coil]);
  }

  delayMicroseconds(2000);
}

void coilsOff() {
  for (int i = 0; i < 4; i++) {
    digitalWrite(motorPins[i], LOW);
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  WiFi.mode(WIFI_STA);

  for (int i = 0; i < 4; i++) {
    pinMode(motorPins[i], OUTPUT);
    digitalWrite(motorPins[i], LOW);
  }

  if (esp_now_init() != ESP_OK) {
    Serial.println("Failed to start ESP-NOW");
    return;
  }


  esp_now_register_recv_cb(onReceive);

}

void loop() {
  int targetStep = targetPosition * 256;
  if (currentStep < targetStep) {
    stepOnce(true);
  }
  if (currentStep > targetStep) {
    stepOnce(false);
  }
  else {
    coilsOff();
  }
}
