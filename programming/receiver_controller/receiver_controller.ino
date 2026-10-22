#include <WiFi.h>
#include <esp_now.h>
#include <ESP32Servo.h>

struct PositionCommand {
  uint8_t magic;
  uint8_t position;
};

const int SERVO_PIN = D0;
const int ELECTROMAGNET_PIN = 
const int NUM_POSITIONS = 5;                                  
const int DEGREES_PER_POSITION = 180 / (NUM_POSITIONS - 1);   
const unsigned long STEP_INTERVAL_MS = 10;                   

Servo servo;

volatile int targetPosition = 0;
int currentAngle = 0;
unsigned long lastStepTime = 0;

void onReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len != sizeof(PositionCommand)) {
    return;
  }

  PositionCommand cmd;
  memcpy(&cmd, data, sizeof(cmd));

  if (cmd.magic != 0xA5 || cmd.position >= NUM_POSITIONS) {
    return;
  }

  targetPosition = cmd.position;
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  servo.setPeriodHertz(50);
  servo.attach(SERVO_PIN, 500, 2500);
  servo.write(currentAngle);   // start at 0 degrees (servo may jump here on boot)

  WiFi.mode(WIFI_STA);
  Serial.print("Receiver MAC: ");
  Serial.println(WiFi.macAddress());

  if (esp_now_init() != ESP_OK) {
    Serial.println("Failed to start ESP-NOW");
    return;
  }

  esp_now_register_recv_cb(onReceive);
  Serial.println("Waiting for position commands");
}

void loop() {
  int targetAngle = targetPosition * DEGREES_PER_POSITION;

  // Move one degree toward the target every STEP_INTERVAL_MS, without blocking
  if (currentAngle != targetAngle && millis() - lastStepTime >= STEP_INTERVAL_MS) {
    lastStepTime = millis();

    if (currentAngle < targetAngle) {
      currentAngle++;
    } else {
      currentAngle--;
    }

    servo.write(currentAngle);

    if (currentAngle == targetAngle) {
      Serial.print("Reached position ");
      Serial.print(targetPosition);
      Serial.print(" (");
      Serial.print(currentAngle);
      Serial.println(" deg)");
    }
  }
}
