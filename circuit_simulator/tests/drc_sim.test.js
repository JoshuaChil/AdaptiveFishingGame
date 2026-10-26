// drc_sim.test.js — DRC + sim + the "Fishing game receiver" preset (plan §7, §9)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeBoard } from '../src/board.js';
import { buildNetlist } from '../src/netlist.js';
import { runDrc, DRC_CODES, summarizeIssues } from '../src/drc.js';
import {
  STEPPER_SEQUENCE,
  defaultInputs,
  evaluate,
  makeScript,
  scriptInputsAt,
  advanceStepper,
} from '../src/sim.js';

// ---------------------------------------------------------------------------
// Fixture: the preset, literally from plan §7 (10 parts, 22 wires, railSplit false)
// ---------------------------------------------------------------------------
const W = (id, color, a, b, mid = null) => ({ id, kind: 'wire', a, b, color, mid });

export function fixturePreset() {
  return {
    version: 1,
    meta: { name: 'Fishing game receiver', modified: 0 },
    board: { kind: 'half', railSplit: false },
    parts: [
      { id: 'U1', type: 'xiao_esp32c3', at: { x: 1, y: 2 }, rot: 0, props: { label: 'XIAO ESP32C3' } },
      { id: 'R1', type: 'resistor', at: { x: 8, y: 10 }, rot: 0, props: { value: '220Ω', span: 4 } },
      { id: 'R2', type: 'resistor', at: { x: 12, y: 7 }, rot: 0, props: { value: '10kΩ', span: 4 } },
      { id: 'Q1', type: 'mosfet_n', at: { x: 12, y: 9 }, rot: 0, props: { package: 'TO-220', partNumber: 'IRLZ44N' } },
      { id: 'D1', type: 'diode', at: { x: 13, y: 8 }, rot: 0, props: { value: '1N4007', span: 4 } },
      { id: 'DRV1', type: 'uln2003', at: { x: 3, y: -12 }, rot: 0, props: { jumper: true } },
      { id: 'M1', type: 'stepper_28byj48', at: { x: 13, y: -12 }, rot: 0, props: {} },
      { id: 'SV1', type: 'servo', at: { x: 1, y: 17 }, rot: 0, props: {} },
      { id: 'L1', type: 'electromagnet', at: { x: 12, y: 17 }, rot: 0, props: {} },
      { id: 'PS1', type: 'power_supply', at: { x: 32, y: 12 }, rot: 0, props: { voltage: 5, label: '5V 2A supply' } },
    ],
    wires: [
      W('W1', 'red', 'h:a1', 'r:tp:3'),
      W('W2', 'black', 'h:a2', 'r:tm:3'),
      W('W3', 'red', 'r:tp:26', 'r:bp:26'),
      W('W4', 'black', 'r:tm:25', 'r:bm:25'),
      W('W5', 'red', 'p:PS1:V+', 'r:bp:27'),
      W('W6', 'black', 'p:PS1:GND', 'r:bm:27'),
      W('W7', 'yellow', 'h:j1', 'h:j8'),
      W('W8', 'black', 'h:j14', 'r:bm:14'),
      W('W9', 'black', 'h:j16', 'r:bm:16'),
      W('W10', 'red', 'h:j17', 'r:bp:17'),
      W('W11', 'blue', 'h:j13', 'p:L1:1'),
      W('W12', 'red', 'r:bp:15', 'p:L1:2'),
      W('W13', 'orange', 'h:a4', 'p:DRV1:IN1'),
      W('W14', 'orange', 'h:a5', 'p:DRV1:IN2'),
      W('W15', 'orange', 'h:a6', 'p:DRV1:IN3'),
      W('W16', 'orange', 'h:a7', 'p:DRV1:IN4'),
      W('W17', 'black', 'r:tm:8', 'p:DRV1:-'),
      W('W18', 'red', 'r:tp:10', 'p:DRV1:+'),
      W('W19', 'white', 'h:i2', 'p:SV1:SIG', { x: 0.6, y: 14 }),
      W('W20', 'red', 'r:bp:3', 'p:SV1:VCC'),
      W('W21', 'black', 'r:bm:4', 'p:SV1:GND'),
      { id: 'W22', kind: 'plug', a: 'p:M1:PLUG', b: 'p:DRV1:SOCKET', color: 'grey', mid: null },
    ],
    bridges: [],
  };
}

const build = (project) => {
  const board = makeBoard(project.board);
  const netlist = buildNetlist(project, board);
  return { board, netlist, issues: runDrc(project, board, netlist) };
};
const codes = (issues, code) => issues.filter((i) => i.code === code);
const without = (project, { parts = [], wires = [] } = {}) => ({
  ...project,
  parts: project.parts.filter((p) => !parts.includes(p.id)),
  wires: project.wires.filter((w) => !wires.includes(w.id)),
});
const withPart = (project, part) => ({ ...project, parts: [...project.parts, part] });
const withWire = (project, wire) => ({ ...project, wires: [...project.wires, wire] });
const setProps = (project, id, props) => ({ ...project, parts: project.parts.map((p) => (p.id === id ? { ...p, props: { ...p.props, ...props } } : p)) });
const movePart = (project, id, at, rot) => ({ ...project, parts: project.parts.map((p) => (p.id === id ? { ...p, at, rot: rot ?? p.rot } : p)) });

/** Assert the §7 expectations on a netlist + issues list. */
function assertPresetExpectations(netlist, issues) {
  const byName = (n) => netlist.byName.get(n);
  const pinsOf = (n) => byName(n)[0].pins.map((p) => `${p.partId}.${p.pin}`).sort();
  for (const n of ['GND', '5V', 'D0', 'D1', 'D7', 'D8', 'D9', 'D10', 'Q1.G', 'Q1.D', '3V3', 'OUT1', 'OUT2', 'OUT3', 'OUT4']) {
    assert.ok(byName(n), `net ${n} missing`);
    assert.equal(byName(n).length, 1, `net ${n} should be unique`);
  }
  assert.deepEqual(pinsOf('5V'), ['D1.K', 'DRV1.+', 'DRV1.COM', 'L1.2', 'M1.RED', 'PS1.V+', 'SV1.VCC', 'U1.5V']);
  assert.deepEqual(pinsOf('GND'), ['DRV1.-', 'PS1.GND', 'Q1.S', 'R2.2', 'SV1.GND', 'U1.BAT-', 'U1.GND']);
  assert.deepEqual(pinsOf('D0'), ['R1.1', 'U1.D0']);
  assert.deepEqual(pinsOf('D1'), ['SV1.SIG', 'U1.D1']);
  assert.deepEqual(pinsOf('D10'), ['DRV1.IN1', 'U1.D10']);
  assert.deepEqual(pinsOf('D9'), ['DRV1.IN2', 'U1.D9']);
  assert.deepEqual(pinsOf('D8'), ['DRV1.IN3', 'U1.D8']);
  assert.deepEqual(pinsOf('D7'), ['DRV1.IN4', 'U1.D7']);
  assert.deepEqual(pinsOf('Q1.G'), ['Q1.G', 'R1.2', 'R2.1']);
  assert.deepEqual(pinsOf('Q1.D'), ['D1.A', 'L1.1', 'Q1.D']);
  assert.deepEqual(pinsOf('OUT1'), ['DRV1.OUT1', 'M1.BLUE']);
  assert.deepEqual(pinsOf('OUT2'), ['DRV1.OUT2', 'M1.PINK']);
  assert.deepEqual(pinsOf('OUT3'), ['DRV1.OUT3', 'M1.YELLOW']);
  assert.deepEqual(pinsOf('OUT4'), ['DRV1.OUT4', 'M1.ORANGE']);
  assert.deepEqual(netlist.dangling, []);

  const s = summarizeIssues(issues);
  assert.equal(s.error, 0, `errors: ${issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' | ')}`);
  assert.equal(s.warn, 0, `warnings: ${issues.filter((i) => i.severity === 'warn').map((i) => i.message).join(' | ')}`);
  assert.equal(s.info, 4, `infos: ${issues.map((i) => i.code).join(',')}`);
  assert.equal(codes(issues, 'VBUS_TIED_TO_SUPPLY').length, 1);
  const strapping = codes(issues, 'STRAPPING_PIN_LOAD');
  assert.equal(strapping.length, 3);
  assert.deepEqual(strapping.map((i) => i.message.slice(0, 2)).sort(), ['D0', 'D8', 'D9']);
}

// ---------------------------------------------------------------------------
describe('preset fixture', () => {
  test('nets and DRC match plan §7 (0 errors / 0 warnings / 4 infos)', () => {
    const project = fixturePreset();
    assert.equal(project.parts.length, 10);
    assert.equal(project.wires.length, 22);
    const { netlist, issues } = build(project);
    assertPresetExpectations(netlist, issues);
    for (const i of issues) {
      assert.ok(/^i\d+$/.test(i.id));
      assert.ok(['error', 'warn', 'info'].includes(i.severity));
      assert.ok(DRC_CODES[i.code]);
      assert.ok(i.message.length > 10);
      assert.ok(typeof i.refs === 'object');
    }
    assert.match(codes(issues, 'VBUS_TIED_TO_SUPPLY')[0].message, /U1 5V .*PS1 V\+/);
  });

  test('src/presets.js (Agent C) yields the same result when present', async (t) => {
    let mod;
    try {
      mod = await import('../src/presets.js');
    } catch (e) {
      t.skip(`presets.js not available: ${e.message.split('\n')[0]}`);
      return;
    }
    if (typeof mod.fishingReceiverPreset !== 'function') {
      t.skip('presets.js has no fishingReceiverPreset()');
      return;
    }
    const project = mod.fishingReceiverPreset();
    assert.equal(project.parts.length, 10);
    assert.equal(project.wires.length, 22);
    assert.equal(project.board.railSplit, false);
    const { netlist, issues } = build(project);
    assertPresetExpectations(netlist, issues);
  });
});

// ---------------------------------------------------------------------------
describe('drc', () => {
  const base = fixturePreset();

  test('DRC_CODES lists every code with a severity', () => {
    const expected = [
      'PIN_OFFBOARD', 'PIN_CHANNEL', 'PIN_OVERLAP', 'POWER_SHORT', 'FLYBACK_REVERSED', 'FLOATING_REQUIRED_PIN',
      'MAGNET_NO_FLYBACK', 'GATE_NO_SERIES_R', 'GATE_NO_PULLDOWN', 'ULN_PLUS_ON_3V3', 'SERVO_ON_3V3', 'USB_CURRENT',
      'STEPPER_UNPLUGGED', 'ULN_JUMPER_OPEN', 'DANGLING_WIRE', 'VBUS_TIED_TO_SUPPLY', 'STRAPPING_PIN_LOAD',
      'HOLE_DOUBLE_BOOKED', 'UNCONNECTED_PART',
    ];
    for (const c of expected) assert.ok(DRC_CODES[c], c);
    assert.equal(DRC_CODES.PIN_OFFBOARD.severity, 'error');
    assert.equal(DRC_CODES.MAGNET_NO_FLYBACK.severity, 'warn');
    assert.equal(DRC_CODES.UNCONNECTED_PART.severity, 'info');
  });

  test('PIN_OFFBOARD', () => {
    const p = movePart(base, 'R1', { x: 28, y: 10 }); // pin 2 at x=32
    const { issues } = build(p);
    const hits = codes(issues, 'PIN_OFFBOARD');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'error');
    assert.match(hits[0].message, /R1 pin 2/);
    assert.deepEqual(hits[0].refs.parts, ['R1']);
    assert.equal(codes(build(base).issues, 'PIN_OFFBOARD').length, 0);
  });

  test('PIN_CHANNEL', () => {
    const p = movePart(base, 'U1', { x: 1, y: 2 }, 90);
    const hits = codes(build(p).issues, 'PIN_CHANNEL');
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((h) => h.severity === 'error'));
    assert.match(hits[0].message, /U1 pin .* channel/);
    assert.equal(codes(build(base).issues, 'PIN_CHANNEL').length, 0);
  });

  test('PIN_OVERLAP is reported once per hole', () => {
    const p = withPart(base, { id: 'R3', type: 'resistor', at: { x: 12, y: 9 }, rot: 0, props: { span: 4 } }); // pin 1 on h12 = Q1 gate
    const hits = codes(build(p).issues, 'PIN_OVERLAP');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'error');
    assert.match(hits[0].message, /Hole h12/);
    assert.deepEqual(hits[0].refs.parts.sort(), ['Q1', 'R3']);
    assert.equal(codes(build(base).issues, 'PIN_OVERLAP').length, 0);
  });

  test('POWER_SHORT', () => {
    const p = withWire(base, W('W99', 'red', 'h:b1', 'h:b2')); // 5V strip to GND strip
    const hits = codes(build(p).issues, 'POWER_SHORT');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'error');
    assert.match(hits[0].message, /5V and GND/);
    assert.equal(hits[0].refs.nets.length, 1);
    const p2 = withWire(base, W('W99', 'red', 'h:b1', 'h:b3')); // 5V to 3V3
    assert.equal(codes(build(p2).issues, 'POWER_SHORT').length, 1);
    assert.equal(codes(build(base).issues, 'POWER_SHORT').length, 0);
    // 12 V supply on the 5V rail is a short too
    const p3 = setProps(base, 'PS1', { voltage: 12 });
    assert.match(codes(build(p3).issues, 'POWER_SHORT')[0].message, /5V and V\+/);
  });

  test('FLYBACK_REVERSED', () => {
    // flip D1: anchor at g17 rot 180 → A on g17 (5V), K on g13 (drain)
    const p = movePart(base, 'D1', { x: 17, y: 8 }, 180);
    const { issues } = build(p);
    const hits = codes(issues, 'FLYBACK_REVERSED');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'error');
    assert.match(hits[0].message, /D1 is reversed/);
    assert.ok(hits[0].refs.parts.includes('D1') && hits[0].refs.parts.includes('L1'));
    assert.equal(codes(issues, 'MAGNET_NO_FLYBACK').length, 0);
    assert.equal(codes(build(base).issues, 'FLYBACK_REVERSED').length, 0);
  });

  test('FLOATING_REQUIRED_PIN honours error / warn / cond', () => {
    // error: servo GND
    let hits = codes(build(without(base, { wires: ['W21'] })).issues, 'FLOATING_REQUIRED_PIN');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'error');
    assert.match(hits[0].message, /SV1 GND is not connected/);
    assert.deepEqual(hits[0].refs.nodes, ['p:SV1:GND']);
    // error with hole label: MOSFET source
    hits = codes(build(without(base, { wires: ['W8'] })).issues, 'FLOATING_REQUIRED_PIN');
    assert.equal(hits.length, 1);
    assert.match(hits[0].message, /Q1 source \(h14\) is not connected/);
    // warn: magnet lead
    hits = codes(build(without(base, { wires: ['W11'] })).issues, 'FLOATING_REQUIRED_PIN');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warn');
    assert.match(hits[0].message, /L1 pin 1|L1 1/);
    // cond: ULN IN1 only matters while a stepper is plugged in
    hits = codes(build(without(base, { wires: ['W13'] })).issues, 'FLOATING_REQUIRED_PIN');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'error');
    assert.match(hits[0].message, /DRV1 IN1 is not connected/);
    const unplugged = build(without(base, { wires: ['W13', 'W22'] })).issues;
    assert.equal(codes(unplugged, 'FLOATING_REQUIRED_PIN').length, 0);
    assert.equal(codes(unplugged, 'STEPPER_UNPLUGGED').length, 1);
    // XIAO GND is required
    hits = codes(build(without(base, { wires: ['W2'] })).issues, 'FLOATING_REQUIRED_PIN');
    assert.ok(hits.some((h) => /U1 GND \(c2\)/.test(h.message)));
    assert.equal(codes(build(base).issues, 'FLOATING_REQUIRED_PIN').length, 0);
  });

  test('MAGNET_NO_FLYBACK', () => {
    const hits = codes(build(without(base, { parts: ['D1'] })).issues, 'MAGNET_NO_FLYBACK');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warn');
    assert.match(hits[0].message, /L1 has no flyback diode/);
    assert.deepEqual(hits[0].refs.parts, ['L1']);
    assert.equal(codes(build(base).issues, 'MAGNET_NO_FLYBACK').length, 0);
    // not raised while a lead is floating (FLOATING_REQUIRED_PIN covers it)
    assert.equal(codes(build(without(base, { parts: ['D1'], wires: ['W11'] })).issues, 'MAGNET_NO_FLYBACK').length, 0);
  });

  test('GATE_NO_SERIES_R / GATE_UNDRIVEN / GATE_NO_PULLDOWN', () => {
    // D0 straight onto the gate strip
    const direct = withWire(without(base, { parts: ['R1'], wires: ['W7'] }), W('W99', 'yellow', 'h:j1', 'h:j12'));
    let issues = build(direct).issues;
    let hits = codes(issues, 'GATE_NO_SERIES_R');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warn');
    assert.match(hits[0].message, /Q1 gate \(h12\) is driven directly by U1 D0/);
    assert.equal(codes(issues, 'GATE_UNDRIVEN').length, 0);
    // remove R1 only → gate reachable by no GPIO
    issues = build(without(base, { parts: ['R1'] })).issues;
    assert.equal(codes(issues, 'GATE_NO_SERIES_R').length, 0);
    assert.equal(codes(issues, 'GATE_UNDRIVEN').length, 1);
    assert.match(codes(issues, 'GATE_UNDRIVEN')[0].message, /Q1 gate \(h12\) is not driven/);
    // remove R2 → no pulldown
    hits = codes(build(without(base, { parts: ['R2'] })).issues, 'GATE_NO_PULLDOWN');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warn');
    assert.equal(hits[0].message, 'Q1 gate (h12) has no pulldown to GND (a 10 kΩ resistor keeps the load off while the XIAO boots).');
    const ok = build(base).issues;
    assert.equal(codes(ok, 'GATE_NO_PULLDOWN').length, 0);
    assert.equal(codes(ok, 'GATE_NO_SERIES_R').length, 0);
    assert.equal(codes(ok, 'GATE_UNDRIVEN').length, 0);
  });

  test('ULN_PLUS_ON_3V3 / SERVO_ON_3V3', () => {
    const uln = { ...base, wires: base.wires.map((w) => (w.id === 'W18' ? W('W18', 'red', 'h:a3', 'p:DRV1:+') : w)) };
    let hits = codes(build(uln).issues, 'ULN_PLUS_ON_3V3');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warn');
    assert.match(hits[0].message, /DRV1 \+ is on 3V3/);
    const sv = { ...base, wires: base.wires.map((w) => (w.id === 'W20' ? W('W20', 'red', 'h:a3', 'p:SV1:VCC') : w)) };
    hits = codes(build(sv).issues, 'SERVO_ON_3V3');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warn');
    assert.match(hits[0].message, /SV1 VCC is on 3V3/);
    const ok = build(base).issues;
    assert.equal(codes(ok, 'ULN_PLUS_ON_3V3').length, 0);
    assert.equal(codes(ok, 'SERVO_ON_3V3').length, 0);
  });

  test('USB_CURRENT only without an external supply and with ≥2 heavy loads on XIAO 5V', () => {
    const noPs = without(base, { parts: ['PS1'], wires: ['W5', 'W6'] });
    const issues = build(noPs).issues;
    const hits = codes(issues, 'USB_CURRENT');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warn');
    assert.match(hits[0].message, /U1 5V \(USB\) is the only supply and feeds/);
    assert.ok(hits[0].refs.parts.includes('SV1') && hits[0].refs.parts.includes('DRV1') && hits[0].refs.parts.includes('L1'));
    assert.equal(codes(issues, 'VBUS_TIED_TO_SUPPLY').length, 0);
    assert.equal(summarizeIssues(issues).error, 0);
    // one load only → fine
    const oneLoad = without(noPs, { parts: ['SV1', 'L1', 'D1'], wires: ['W19', 'W20', 'W21', 'W11', 'W12'] });
    assert.equal(codes(build(oneLoad).issues, 'USB_CURRENT').length, 0);
    assert.equal(codes(build(base).issues, 'USB_CURRENT').length, 0);
  });

  test('STEPPER_UNPLUGGED / ULN_JUMPER_OPEN', () => {
    let hits = codes(build(without(base, { wires: ['W22'] })).issues, 'STEPPER_UNPLUGGED');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warn');
    assert.match(hits[0].message, /M1 is not plugged into a ULN2003 socket/);
    hits = codes(build(setProps(base, 'DRV1', { jumper: false })).issues, 'ULN_JUMPER_OPEN');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warn');
    assert.match(hits[0].message, /DRV1 COM jumper is open/);
    const ok = build(base).issues;
    assert.equal(codes(ok, 'STEPPER_UNPLUGGED').length, 0);
    assert.equal(codes(ok, 'ULN_JUMPER_OPEN').length, 0);
  });

  test('DANGLING_WIRE', () => {
    const p = withWire(withWire(base, W('W98', 'red', 'h:b1', 'p:PS2:V+')), { id: 'W97', kind: 'plug', a: 'p:M1:PLUG', b: 'h:c9' });
    const hits = codes(build(p).issues, 'DANGLING_WIRE');
    assert.equal(hits.length, 2);
    assert.ok(hits.every((h) => h.severity === 'warn'));
    const w98 = hits.find((h) => h.refs.wires.includes('W98'));
    assert.match(w98.message, /Wire W98 ends on p:PS2:V\+/);
    assert.deepEqual(w98.refs.nodes, ['p:PS2:V+']);
    const w97 = hits.find((h) => h.refs.wires.includes('W97'));
    assert.match(w97.message, /Plug W97 .* matching connectors/);
    assert.equal(codes(build(base).issues, 'DANGLING_WIRE').length, 0);
  });

  test('VBUS_TIED_TO_SUPPLY / STRAPPING_PIN_LOAD (info)', () => {
    const ok = build(base).issues;
    assert.equal(codes(ok, 'VBUS_TIED_TO_SUPPLY').length, 1);
    assert.equal(codes(ok, 'VBUS_TIED_TO_SUPPLY')[0].severity, 'info');
    assert.equal(codes(ok, 'STRAPPING_PIN_LOAD').length, 3);
    assert.ok(codes(ok, 'STRAPPING_PIN_LOAD').every((h) => h.severity === 'info'));
    assert.match(codes(ok, 'STRAPPING_PIN_LOAD').find((h) => h.message.startsWith('D0')).message, /R1 pin 1/);
    // XIAO 5V isolated from the rail → no VBUS info
    assert.equal(codes(build(without(base, { wires: ['W1'] })).issues, 'VBUS_TIED_TO_SUPPLY').length, 0);
    // lone XIAO → no strapping loads
    const lone = { ...base, parts: base.parts.filter((p) => p.id === 'U1'), wires: [] };
    assert.equal(codes(build(lone).issues, 'STRAPPING_PIN_LOAD').length, 0);
  });

  test('HOLE_DOUBLE_BOOKED (info)', () => {
    // wire into a hole that already holds R1 pin 1
    let hits = codes(build(withWire(base, W('W96', 'green', 'h:i8', 'r:bm:5'))).issues, 'HOLE_DOUBLE_BOOKED');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'info');
    assert.match(hits[0].message, /Hole i8 is used by R1 pin 1 and wire W96/);
    // wire ending on the pin node itself counts for the same hole
    hits = codes(build(withWire(base, W('W96', 'green', 'p:R1:1', 'r:bm:5'))).issues, 'HOLE_DOUBLE_BOOKED');
    assert.equal(hits.length, 1);
    // two wire ends in one empty hole
    hits = codes(build(withWire(base, W('W95', 'green', 'h:j1', 'r:bm:5'))).issues, 'HOLE_DOUBLE_BOOKED');
    assert.equal(hits.length, 1);
    assert.match(hits[0].message, /Hole j1 is used by wire W7 and wire W95/);
    assert.equal(codes(build(base).issues, 'HOLE_DOUBLE_BOOKED').length, 0);
  });

  test('UNCONNECTED_PART (info) for a lone passive, not for a part with floating-required errors', () => {
    const p = withPart(base, { id: 'R3', type: 'resistor', at: { x: 20, y: 0 }, rot: 0, props: { span: 4 } });
    const issues = build(p).issues;
    const hits = codes(issues, 'UNCONNECTED_PART');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'info');
    assert.match(hits[0].message, /R3 .*is not connected to anything/);
    assert.equal(summarizeIssues(issues).error, 0);
    const lonely = withPart(base, { id: 'SV2', type: 'servo', at: { x: 40, y: 0 }, rot: 0, props: {} });
    const li = build(lonely).issues;
    assert.equal(codes(li, 'UNCONNECTED_PART').length, 0);
    assert.equal(codes(li, 'FLOATING_REQUIRED_PIN').length, 3);
    assert.equal(codes(build(base).issues, 'UNCONNECTED_PART').length, 0);
  });

  test('issues are sorted error → warn → info', () => {
    const p = withWire(without(base, { parts: ['D1'] }), W('W99', 'red', 'h:b1', 'h:b2'));
    const issues = build(p).issues;
    const rank = { error: 0, warn: 1, info: 2 };
    for (let i = 1; i < issues.length; i++) assert.ok(rank[issues[i - 1].severity] <= rank[issues[i].severity]);
    assert.equal(issues[0].code, 'POWER_SHORT');
  });
});

// ---------------------------------------------------------------------------
describe('sim', () => {
  const base = fixturePreset();
  const setup = (project = base) => {
    const board = makeBoard(project.board);
    const netlist = buildNetlist(project, board);
    return { project, board, netlist, level: (res, name) => res.netLevel.get(netlist.byName.get(name)[0].id) };
  };

  test('STEPPER_SEQUENCE matches the firmware', () => {
    assert.deepEqual(STEPPER_SEQUENCE, [[1, 1, 0, 0], [0, 1, 1, 0], [0, 0, 1, 1], [1, 0, 0, 1]]);
  });

  test('defaultInputs', () => {
    const d = defaultInputs(base);
    assert.deepEqual(Object.keys(d.gpio), ['U1']);
    assert.equal(Object.keys(d.gpio.U1).length, 11);
    assert.equal(d.gpio.U1.D0, false);
    assert.equal(d.gpio.U1.D10, false);
    assert.deepEqual(d.servoAngle, { U1: 90 });
    assert.equal(d.supplyOn, true);
  });

  test('idle: power nets settle, nothing switched, servo alive, ULN powered', () => {
    const { project, board, netlist, level } = setup();
    const res = evaluate(project, board, netlist, defaultInputs(project));
    assert.equal(level(res, 'GND'), 'GND');
    assert.equal(level(res, '5V'), 'VCC');
    assert.equal(level(res, '3V3'), 'VCC');
    assert.equal(level(res, 'D0'), 'LOW');
    assert.equal(level(res, 'Q1.G'), 'LOW'); // 220 Ω from LOW beats 10 kΩ to GND
    assert.equal(level(res, 'Q1.D'), 'FLOAT');
    assert.deepEqual(res.parts.Q1, { conducting: false });
    assert.deepEqual(res.parts.L1, { energized: false });
    assert.deepEqual(res.parts.D1, { forward: false });
    assert.deepEqual(res.parts.DRV1, { powered: true, out: [false, false, false, false], leds: [false, false, false, false] });
    assert.deepEqual(res.parts.SV1, { alive: true, angle: 90 });
    assert.equal(res.parts.M1.plugged, true);
    assert.deepEqual(res.parts.M1.coils, [false, false, false, false]);
    assert.equal(res.parts.M1.stepIndex, 0);
    assert.equal(res.parts.M1.rotorAngle, 0);
    assert.deepEqual(res.parts.PS1, { on: true });
    assert.deepEqual(res.notes, []);
    assert.ok(res.netLevel instanceof Map);
  });

  test('D0 HIGH → gate HIGH → Q1 conducting → drain GND → L1 energized', () => {
    const { project, board, netlist, level } = setup();
    const inputs = defaultInputs(project);
    inputs.gpio.U1.D0 = true;
    const res = evaluate(project, board, netlist, inputs);
    assert.equal(level(res, 'D0'), 'HIGH');
    assert.equal(level(res, 'Q1.G'), 'HIGH');
    assert.equal(level(res, 'Q1.D'), 'GND');
    assert.equal(res.parts.Q1.conducting, true);
    assert.equal(res.parts.L1.energized, true);
    assert.equal(res.parts.D1.forward, false); // flyback is reverse-biased while the magnet is on
  });

  test('source not on GND → never conducts; reversed flyback is forward-biased', () => {
    const noSrc = without(base, { wires: ['W8'] });
    const { project, board, netlist, level } = setup(noSrc);
    const inputs = defaultInputs(project);
    inputs.gpio.U1.D0 = true;
    const res = evaluate(project, board, netlist, inputs);
    assert.equal(level(res, 'Q1.G'), 'HIGH');
    assert.equal(res.parts.Q1.conducting, false);
    assert.equal(res.parts.L1.energized, false);

    const flipped = movePart(base, 'D1', { x: 17, y: 8 }, 180);
    const f = setup(flipped);
    const r2 = evaluate(f.project, f.board, f.netlist, (() => { const i = defaultInputs(f.project); i.gpio.U1.D0 = true; return i; })());
    assert.equal(r2.parts.D1.forward, true);
  });

  test('ULN unpowered → no outputs, note emitted; powered + IN HIGH → OUT GND + LED', () => {
    const unpowered = without(base, { wires: ['W18'] });
    const u = setup(unpowered);
    const inputs = defaultInputs(u.project);
    inputs.gpio.U1.D10 = true;
    let res = evaluate(u.project, u.board, u.netlist, inputs);
    assert.equal(res.parts.DRV1.powered, false);
    assert.deepEqual(res.parts.DRV1.out, [false, false, false, false]);
    assert.equal(u.level(res, 'OUT1'), 'FLOAT');
    assert.ok(res.notes.some((n) => /DRV1 is unpowered/.test(n)));

    const { project, board, netlist, level } = setup();
    res = evaluate(project, board, netlist, inputs);
    assert.equal(res.parts.DRV1.powered, true);
    assert.deepEqual(res.parts.DRV1.out, [true, false, false, false]);
    assert.deepEqual(res.parts.DRV1.leds, [true, false, false, false]);
    assert.equal(level(res, 'OUT1'), 'GND');
    assert.deepEqual(res.parts.M1.coils, [true, false, false, false]);
    // supply off → ULN loses power (XIAO 5V still VCC via USB though — rail is still VCC)
    const off = { ...defaultInputs(project), supplyOn: false };
    res = evaluate(project, board, netlist, off);
    assert.equal(level(res, '5V'), 'VCC'); // USB VBUS keeps the rail up
    assert.deepEqual(res.parts.PS1, { on: false });
  });

  test('servo alive only when powered and driven by a GPIO', () => {
    const noVcc = setup(without(base, { wires: ['W20'] }));
    let res = evaluate(noVcc.project, noVcc.board, noVcc.netlist, defaultInputs(noVcc.project));
    assert.equal(res.parts.SV1.alive, false);
    const noSig = setup(without(base, { wires: ['W19'] }));
    res = evaluate(noSig.project, noSig.board, noSig.netlist, defaultInputs(noSig.project));
    assert.equal(res.parts.SV1.alive, false);
    const { project, board, netlist } = setup();
    const inputs = defaultInputs(project);
    inputs.servoAngle.U1 = 37;
    res = evaluate(project, board, netlist, inputs);
    assert.deepEqual(res.parts.SV1, { alive: true, angle: 37 });
  });

  test('GND and VCC on one net → CONFLICT + note', () => {
    const shorted = setup(withWire(base, W('W99', 'red', 'h:b1', 'h:b2')));
    const res = evaluate(shorted.project, shorted.board, shorted.netlist, defaultInputs(shorted.project));
    assert.equal(shorted.level(res, 'GND'), 'CONFLICT');
    assert.ok(res.notes.some((n) => /CONFLICT/.test(n)));
  });

  test('advanceStepper moves ±1 step / ±11.25° per sequence frame', () => {
    let s = advanceStepper(null, STEPPER_SEQUENCE[0]);
    assert.equal(s.stepIndex, 0);
    assert.equal(s.rotorAngle, 0);
    s = advanceStepper(s, STEPPER_SEQUENCE[1]);
    assert.equal(s.stepIndex, 1);
    assert.equal(s.rotorAngle, 11.25);
    s = advanceStepper(s, STEPPER_SEQUENCE[2]);
    s = advanceStepper(s, STEPPER_SEQUENCE[3]);
    s = advanceStepper(s, STEPPER_SEQUENCE[0]); // wrap
    assert.equal(s.stepIndex, 4);
    assert.equal(s.rotorAngle, 45);
    s = advanceStepper(s, STEPPER_SEQUENCE[0]); // same frame → no move
    assert.equal(s.stepIndex, 4);
    s = advanceStepper(s, STEPPER_SEQUENCE[3]); // backwards
    assert.equal(s.stepIndex, 3);
    assert.equal(s.rotorAngle, 33.75);
    s = advanceStepper(s, [false, false, false, false]); // de-energized → hold
    assert.equal(s.stepIndex, 3);
    assert.equal(s.rotorAngle, 33.75);
    s = advanceStepper(s, STEPPER_SEQUENCE[2]); // resumes from the last known frame
    assert.equal(s.stepIndex, 2);
    // minimal prev without seqIndex still works (stepIndex implies the frame)
    assert.equal(advanceStepper({ stepIndex: 0, rotorAngle: 0 }, STEPPER_SEQUENCE[1]).stepIndex, 1);
    assert.equal(advanceStepper({ stepIndex: 0, rotorAngle: 0 }, STEPPER_SEQUENCE[3]).stepIndex, -1);
    assert.equal(advanceStepper({ stepIndex: 0, rotorAngle: 0 }, STEPPER_SEQUENCE[3]).rotorAngle, 348.75);
  });

  test('stepper CW script lights LEDs A..D in firmware order and advances the rotor; CCW reverses', () => {
    const { project, board, netlist } = setup();
    const script = makeScript('stepperCW', { steps: 8, stepMs: 150 });
    assert.equal(script.durationMs, 1200);
    const basis = defaultInputs(project);
    let prev = null;
    const ledFrames = [];
    for (let frame = 0; frame < 8; frame++) {
      const { inputs, done } = scriptInputsAt(script, basis, project, frame * 150);
      assert.equal(done, false);
      assert.deepEqual(['D10', 'D9', 'D8', 'D7'].map((p) => inputs.gpio.U1[p]), STEPPER_SEQUENCE[frame % 4].map(Boolean));
      const res = evaluate(project, board, netlist, inputs, prev);
      ledFrames.push(res.parts.DRV1.leds.map(Number).join(''));
      assert.deepEqual(res.parts.M1.coils, STEPPER_SEQUENCE[frame % 4].map(Boolean));
      assert.equal(res.parts.M1.stepIndex, frame);
      assert.ok(Math.abs(res.parts.M1.rotorAngle - frame * 11.25) < 1e-9);
      prev = res;
    }
    assert.deepEqual(ledFrames.slice(0, 4), ['1100', '0110', '0011', '1001']);
    const end = scriptInputsAt(script, basis, project, 1200);
    assert.equal(end.done, true);
    assert.deepEqual(['D10', 'D9', 'D8', 'D7'].map((p) => end.inputs.gpio.U1[p]), [false, false, false, false]);
    assert.equal(basis.gpio.U1.D10, false, 'base inputs must not be mutated');

    const ccw = makeScript('stepperCCW', { steps: 4, stepMs: 100 });
    prev = null;
    for (let frame = 0; frame < 4; frame++) {
      const { inputs } = scriptInputsAt(ccw, basis, project, frame * 100);
      const res = evaluate(project, board, netlist, inputs, prev);
      assert.equal(res.parts.M1.stepIndex, 0 - frame); // 0 - 0 avoids -0
      prev = res;
    }
    assert.equal(makeScript('stepperCW').steps, 8);
    assert.equal(makeScript('stepperCW').stepMs, 150);
    assert.throws(() => makeScript('nope'));
  });

  test('magnetPulse drives the GPIO behind the gate resistor; servoSweep goes 0→180→0', () => {
    const { project, board, netlist } = setup();
    const basis = defaultInputs(project);
    const pulse = makeScript('magnetPulse', { ms: 500 });
    let r = scriptInputsAt(pulse, basis, project, 100);
    assert.equal(r.inputs.gpio.U1.D0, true);
    assert.equal(r.done, false);
    assert.equal(evaluate(project, board, netlist, r.inputs).parts.L1.energized, true);
    r = scriptInputsAt(pulse, basis, project, 500);
    assert.equal(r.inputs.gpio.U1.D0, false);
    assert.equal(r.done, true);
    assert.equal(makeScript('magnetPulse').ms, 500);

    const sweep = makeScript('servoSweep', { ms: 2000 });
    assert.equal(scriptInputsAt(sweep, basis, project, 0).inputs.servoAngle.U1, 0);
    assert.equal(scriptInputsAt(sweep, basis, project, 1000).inputs.servoAngle.U1, 180);
    assert.equal(scriptInputsAt(sweep, basis, project, 1500).inputs.servoAngle.U1, 90);
    const end = scriptInputsAt(sweep, basis, project, 2000);
    assert.equal(end.done, true);
    assert.equal(end.inputs.servoAngle.U1, 90);
    assert.equal(basis.servoAngle.U1, 90);

    // magnet pulse falls back to D0 when no gate chain exists
    const lone = { ...base, parts: base.parts.filter((p) => p.id === 'U1'), wires: [] };
    assert.equal(scriptInputsAt(pulse, defaultInputs(lone), lone, 0).inputs.gpio.U1.D0, true);
  });
});
