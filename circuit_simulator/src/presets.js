// presets.js — pure project data. Imports nothing (safe for node tests and the browser).
// Project JSON v1 shape: see plan §2.

export function blankProject(kind = 'half') {
  return {
    version: 1,
    meta: { name: 'Untitled', modified: Date.now() },
    board: { kind, railSplit: false },
    parts: [],
    wires: [],
    bridges: [],
  };
}

function part(id, type, x, y, props = {}, rot = 0) {
  return { id, type, at: { x, y }, rot, props };
}

function wire(id, color, a, b, mid = null, kind = 'wire') {
  return { id, kind, a, b, color, mid };
}

/**
 * "Fishing game receiver" on a half-size ElectroCookie board (plan §7).
 * XIAO ESP32C3 anchor (1,2) rot 0 (USB off the left edge):
 *   c1=5V c2=GND c3=3V3 c4=D10 c5=D9 c6=D8 c7=D7 / g1=D0 g2=D1 g3=D2 g4=D3 g5=D4 g6=D5 g7=D6
 * Firmware pin map: D0 → magnet MOSFET gate (220 Ω series, 10 kΩ pulldown, flyback diode),
 * D1 → servo signal, D10/D9/D8/D7 → ULN2003 IN1..IN4.
 */
export function fishingReceiverPreset() {
  return {
    version: 1,
    meta: { name: 'Fishing game receiver', modified: Date.now() },
    board: { kind: 'half', railSplit: false },
    parts: [
      part('U1', 'xiao_esp32c3', 1, 2, { label: 'XIAO ESP32C3' }),
      part('R1', 'resistor', 8, 10, { value: '220Ω', span: 4 }),          // i8, i12  (gate series)
      part('R2', 'resistor', 12, 7, { value: '10kΩ', span: 4 }),          // f12, f16 (gate pulldown)
      part('Q1', 'mosfet_n', 12, 9, { package: 'TO-220', partNumber: 'IRLZ44N' }), // G h12, D h13, S h14
      part('D1', 'diode', 13, 8, { value: '1N4007', span: 4 }),           // A g13 (drain), K g17 (5V)
      part('DRV1', 'uln2003', 3, -12, { jumper: true }),                  // bench, above the board
      part('M1', 'stepper_28byj48', 13, -12, {}),                         // bench, PLUG at (13,-8.5)
      part('SV1', 'servo', 1, 17, {}),                                    // bench, below the board
      part('L1', 'electromagnet', 12, 17, {}),                            // bench, leads (13,17) (15,17)
      part('PS1', 'power_supply', 32, 12, { voltage: 5, label: '5V 2A supply' }), // bench, right of board
    ],
    wires: [
      wire('W1', 'red', 'h:a1', 'r:tp:3'),            // XIAO 5V → top + rail
      wire('W2', 'black', 'h:a2', 'r:tm:3'),          // XIAO GND → top − rail
      wire('W3', 'red', 'r:tp:26', 'r:bp:26'),        // rail bridge +
      wire('W4', 'black', 'r:tm:25', 'r:bm:25'),      // rail bridge −
      wire('W5', 'red', 'p:PS1:V+', 'r:bp:27'),       // supply → bottom + rail
      wire('W6', 'black', 'p:PS1:GND', 'r:bm:27'),    // supply → bottom − rail
      wire('W7', 'yellow', 'h:j1', 'h:j8'),           // D0 → R1 pin 1
      wire('W8', 'black', 'h:j14', 'r:bm:14'),        // Q1 source → GND
      wire('W9', 'black', 'h:j16', 'r:bm:16'),        // R2 → GND
      wire('W10', 'red', 'h:j17', 'r:bp:17'),         // D1 cathode strip → 5V
      wire('W11', 'blue', 'h:j13', 'p:L1:1'),         // drain → magnet
      wire('W12', 'red', 'r:bp:15', 'p:L1:2'),        // 5V → magnet
      wire('W13', 'orange', 'h:a4', 'p:DRV1:IN1'),    // D10
      wire('W14', 'orange', 'h:a5', 'p:DRV1:IN2'),    // D9
      wire('W15', 'orange', 'h:a6', 'p:DRV1:IN3'),    // D8
      wire('W16', 'orange', 'h:a7', 'p:DRV1:IN4'),    // D7
      wire('W17', 'black', 'r:tm:8', 'p:DRV1:-'),     // GND → ULN −
      wire('W18', 'red', 'r:tp:10', 'p:DRV1:+'),      // 5V → ULN +
      wire('W19', 'white', 'h:i2', 'p:SV1:SIG', { x: 0.6, y: 14 }), // D1 → servo signal (dodges W7)
      wire('W20', 'red', 'r:bp:3', 'p:SV1:VCC'),      // 5V → servo
      wire('W21', 'black', 'r:bm:4', 'p:SV1:GND'),    // GND → servo
      wire('W22', 'grey', 'p:M1:PLUG', 'p:DRV1:SOCKET', null, 'plug'), // stepper plug → ULN socket
    ],
    bridges: [],
  };
}

export const PRESETS = [
  { id: 'blank', name: 'Blank (half board)', build: () => blankProject('half') },
  { id: 'fishing', name: 'Fishing game receiver', build: fishingReceiverPreset },
];
