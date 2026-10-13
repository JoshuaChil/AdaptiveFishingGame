const int BUTTON_A = D1;
const int BUTTON_B = D2;

int lastA = HIGH;
int lastB = HIGH;

void setup()
{
  Serial.begin(115200);
  pinMode(BUTTON_A, INPUT_PULLUP);
  pinMode(BUTTON_B, INPUT_PULLUP);
  Serial.print("Button Tester: ");
}

void loop()
{
  int a = digitalRead(BUTTON_A);
  int b = digitalRead(BUTTON_B);
  if (a == LOW && lastA == HIGH)
  {
    Serial.println("Button A Pressed");
  }
  if (b == LOW && lastB == HIGH)
  {
    Serial.println("Button B Pressed");
  }
  lastA = a;
  lastB = b;
  delay(20);
}