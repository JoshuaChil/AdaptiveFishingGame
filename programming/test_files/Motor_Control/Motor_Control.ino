const int motorPins[4] = {D1, D2, D3, D4}; // IN1, IN2, IN3, IN4

const int sequence[4][4] = {
  {1, 1, 0, 0},
  {0, 1, 1, 0},
  {0, 0, 1, 1},
  {1, 0, 0, 1}
};

void setup() {
  for (int i = 0; i < 4; i++) {
    pinMode(motorPins[i], OUTPUT);
  }
}

void loop() {
  for (int step = 0; step < 4; step++) {
    for (int coil = 0; coil < 4; coil++) {
      digitalWrite(motorPins[coil], sequence[step][coil]);
    }
    delayMicroseconds(1500);
  }
}