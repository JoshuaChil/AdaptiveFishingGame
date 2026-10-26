
#include <WiFi.h>
#include <esp_now.h>
#include <ESP32Servo.h>

// --------------------------------------------------
// ESP-NOW command structure
// Must match the sender's structure exactly.
// type 1 = servo position
// type 2 = reel state (0 = UP, 1 = DOWN)
// --------------------------------------------------

struct Command
{
  uint8_t type;
  uint8_t state;
};

// --------------------------------------------------
// PIN ASSIGNMENTS
// Verify these GPIO numbers for your ESP32 board.
// Do not use the same pin for servo and stepper.
// --------------------------------------------------

const int ELECTROMAGNET_PIN = 23;
const int SERVO_PIN = 13;

// ULN2003 inputs: IN1, IN2, IN3, IN4
const int MOTOR_PINS[4] = {18, 19, 21, 22};

// --------------------------------------------------
// SERVO SETTINGS
// --------------------------------------------------

const int NUM_POSITIONS = 5;
const int DEGREES_PER_POSITION = 180 / (NUM_POSITIONS - 1);

Servo servo;

volatile int targetPosition = 0;
int currentAngle = 0;
unsigned long lastServoStepTime = 0;
const unsigned long SERVO_STEP_INTERVAL_MS = 10;

// --------------------------------------------------
// STEPPER SETTINGS
// --------------------------------------------------

// Approximate full steps per output-shaft revolution
const long STEPS_PER_REVOLUTION = 2048;
const long ROTATIONS_PER_MOVE = 3;
const long TARGET_STEPS = STEPS_PER_REVOLUTION * ROTATIONS_PER_MOVE;

const unsigned long STEPPER_STEP_INTERVAL_US = 2000;

// Two-coil-on full-step sequence
const int sequence[4][4] = {
    {1, 1, 0, 0},
    {0, 1, 1, 0},
    {0, 0, 1, 1},
    {1, 0, 0, 1}};

int sequenceIndex = 0;
long stepsCompleted = 0;

bool reelDown = false;
bool stepperMoving = false;
bool requestedReelDown = false;
bool lastCompletedReelDown = false;
bool hasCompletedReelMove = false;

int stepperDirection = 1;

unsigned long lastStepperStepTime = 0;

// --------------------------------------------------
// START A REEL MOVEMENT
// --------------------------------------------------

void startReelMovement(bool down)
{
  if (stepperMoving)
  {
    return;
  }

  if (hasCompletedReelMove &&
      down == lastCompletedReelDown)
  {
    return;
  }

  requestedReelDown = down;
  reelDown = down;

  stepperDirection = down ? 1 : -1;
  stepsCompleted = 0;
  stepperMoving = true;
  lastStepperStepTime = micros();

  Serial.println(down
                     ? "Reel moving DOWN: 3 rotations forward"
                     : "Reel moving UP: 3 rotations backward");
}

// --------------------------------------------------
// ESP-NOW RECEIVE CALLBACK
// --------------------------------------------------

void onReceive(const esp_now_recv_info_t *info,
               const uint8_t *data,
               int len)
{

  if (len != sizeof(Command))
  {
    return;
  }

  Command cmd;
  memcpy(&cmd, data, sizeof(cmd));

  if (cmd.type != 1 && cmd.type != 2)
  {
    return;
  }

  if (cmd.type == 1)
  {
    if (cmd.state >= NUM_POSITIONS)
    {
      return;
    }

    targetPosition = cmd.state;
  }

  if (cmd.type == 2)
  {
    if (cmd.state > 1)
    {
      return;
    }

    // Ignore repeated requests for the same state.
    if (stepperMoving)
    {
      return;
    }

    if (hasCompletedReelMove &&
        (bool)cmd.state == lastCompletedReelDown)
    {
      return;
    }

    startReelMovement(cmd.state == 1);
  }
}

// --------------------------------------------------
// PERFORM ONE STEPPER STEP
// --------------------------------------------------

void performStepperStep()
{
  for (int coil = 0; coil < 4; coil++)
  {
    digitalWrite(
        MOTOR_PINS[coil],
        sequence[sequenceIndex][coil]);
  }

  sequenceIndex += stepperDirection;

  if (sequenceIndex >= 4)
  {
    sequenceIndex = 0;
  }

  if (sequenceIndex < 0)
  {
    sequenceIndex = 3;
  }

  stepsCompleted++;

  if (stepsCompleted >= TARGET_STEPS)
  {
    stepperMoving = false;

    // De-energize motor coils to reduce heating.
    for (int i = 0; i < 4; i++)
    {
      digitalWrite(MOTOR_PINS[i], LOW);
    }

    lastCompletedReelDown = requestedReelDown;
    hasCompletedReelMove = true;

    Serial.println(requestedReelDown
                       ? "Reel reached DOWN state"
                       : "Reel reached UP state");
  }
}

// --------------------------------------------------
// SETUP
// --------------------------------------------------

void setup()
{
  Serial.begin(115200);
  delay(500);

  pinMode(ELECTROMAGNET_PIN, OUTPUT);
  digitalWrite(ELECTROMAGNET_PIN, LOW);

  for (int i = 0; i < 4; i++)
  {
    pinMode(MOTOR_PINS[i], OUTPUT);
    digitalWrite(MOTOR_PINS[i], LOW);
  }

  servo.setPeriodHertz(50);
  servo.attach(SERVO_PIN, 500, 2500);
  servo.write(currentAngle);

  WiFi.mode(WIFI_STA);

  Serial.print("Receiver MAC: ");
  Serial.println(WiFi.macAddress());

  if (esp_now_init() != ESP_OK)
  {
    Serial.println("Failed to start ESP-NOW");
    return;
  }

  esp_now_register_recv_cb(onReceive);

  Serial.println("Waiting for ESP-NOW commands");
}

// --------------------------------------------------
// MAIN LOOP
// --------------------------------------------------

void loop()
{
  // SERVO CONTROL
  int targetAngle = targetPosition * DEGREES_PER_POSITION;

  if (currentAngle != targetAngle &&
      millis() - lastServoStepTime >=
          SERVO_STEP_INTERVAL_MS)
  {

    lastServoStepTime = millis();

    if (currentAngle < targetAngle)
    {
      currentAngle++;
    }
    else
    {
      currentAngle--;
    }

    servo.write(currentAngle);
  }

  // STEPPER CONTROL - NON-BLOCKING
  if (stepperMoving &&
      (unsigned long)(micros() - lastStepperStepTime) >= STEPPER_STEP_INTERVAL_US)
  {

    lastStepperStepTime = micros();
    performStepperStep();
  }
}
