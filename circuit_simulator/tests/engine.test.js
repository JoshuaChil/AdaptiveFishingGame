// engine.test.js — board + parts + netlist (plan §9)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_PRESETS, ROW_Y, makeBoard } from '../src/board.js';
import {
  PART_LIBRARY,
  PART_ORDER,
  WIRE_COLORS,
  partDef,
  pinNodeId,
  parseNodeId,
  resolvePins,
  validatePlacement,
  internalConnections,
  connectorPins,
  expandPlug,
  nextRefId,
  rotateOffset,
  bodyRect,
  suggestAnchor,
  parseOhms,
  findPlugPartner,
} from '../src/parts.js';
import { UnionFind, buildNetlist } from '../src/netlist.js';

const half = () => makeBoard({ kind: 'half', railSplit: false });
const xiao = (x = 1, y = 2, rot = 0) => ({ id: 'U1', type: 'xiao_esp32c3', at: { x, y }, rot, props: {} });
const part = (id, type, x, y, props = {}, rot = 0) => ({ id, type, at: { x, y }, rot, props });
const pinAt = (p, name) => p.find((q) => q.name === name);

// ---------------------------------------------------------------------------
describe('board', () => {
  test('presets and ROW_Y match the plan', () => {
    assert.deepEqual(BOARD_PRESETS.half, { cols: 30, blocks: 1, rails: true });
    assert.deepEqual(BOARD_PRESETS.mini, { cols: 17, blocks: 1, rails: false });
    assert.deepEqual(BOARD_PRESETS.dual, { cols: 30, blocks: 2, rails: true });
    assert.deepEqual(BOARD_PRESETS.full, { cols: 63, blocks: 1, rails: true });
    assert.equal(ROW_Y.e, 4);
    assert.equal(ROW_Y.f, 7);
    assert.equal(ROW_Y.j, 11);
    assert.equal(ROW_Y.k, 15);
    assert.equal(ROW_Y.t, 26);
  });

  test('half board has 300 strip holes + 100 rail holes', () => {
    const b = half();
    assert.equal(b.cols, 30);
    assert.equal(b.holes.filter((h) => h.kind === 'strip').length, 300);
    assert.equal(b.holes.filter((h) => h.kind === 'rail').length, 100);
    assert.equal(b.stripHoles.length, 300);
    assert.equal(b.railHoles.length, 100);
    assert.equal(b.rails.length, 4);
    assert.deepEqual(b.rails.map((r) => r.id), ['tp', 'tm', 'bm', 'bp']);
    assert.deepEqual(b.rails.map((r) => r.y), [-3, -2, 14, 15]);
    assert.deepEqual(b.rails.map((r) => r.polarity), ['+', '−', '−', '+']);
    for (const r of b.rails) {
      assert.equal(r.cols[0], 3);
      assert.equal(r.cols[r.cols.length - 1], 27);
      assert.equal(r.cols.length, 25);
    }
  });

  test('holeAt / holeById / classify', () => {
    const b = half();
    assert.equal(b.holeAt(5, 2), 'h:c5');
    assert.equal(b.holeAt(5, 5), null); // channel
    assert.equal(b.holeAt(5, 6), null);
    assert.equal(b.holeAt(31, 0), null); // off board
    assert.equal(b.holeAt(0, 0), null);
    assert.equal(b.holeAt(1, 7), 'h:f1');
    assert.equal(b.holeAt(30, 11), 'h:j30');
    assert.equal(b.holeAt(3, -3), 'r:tp:3');
    assert.equal(b.holeAt(27, 15), 'r:bp:27');
    assert.equal(b.holeAt(2, -3), null); // rails start at col 3
    assert.equal(b.holeAt(28, -2), null);
    assert.equal(b.holeAt(5.4, 1.6), 'h:c5'); // snaps within 0.5
    assert.equal(b.classify(5, 2), 'hole');
    assert.equal(b.classify(5, 5), 'channel');
    assert.equal(b.classify(31, 0), 'offboard');
    assert.equal(b.classify(5, -10), 'offboard');
    assert.deepEqual(b.holeById('h:c5'), { id: 'h:c5', kind: 'strip', x: 5, y: 2, row: 'c', col: 5, block: 0, strip: 's:a5' });
    assert.equal(b.holeById('h:z5'), null);
  });

  test('strips: a5/e5 share a strip, e5/f5 do not; rail continuity vs railSplit', () => {
    const b = half();
    assert.equal(b.stripOf('h:a5'), b.stripOf('h:e5'));
    assert.equal(b.stripOf('h:a5'), 's:a5');
    assert.notEqual(b.stripOf('h:e5'), b.stripOf('h:f5'));
    assert.equal(b.stripOf('h:f5'), 's:f5');
    assert.notEqual(b.stripOf('h:a5'), b.stripOf('h:a6'));
    assert.deepEqual(b.stripMembers('s:a5'), ['h:a5', 'h:b5', 'h:c5', 'h:d5', 'h:e5']);
    assert.equal(b.stripOf('r:tp:3'), 'rail:tp');
    assert.equal(b.stripOf('r:tp:3'), b.stripOf('r:tp:27'));
    assert.notEqual(b.stripOf('r:tp:3'), b.stripOf('r:tm:3'));
    assert.notEqual(b.stripOf('r:tp:3'), b.stripOf('r:bp:3')); // top and bottom rails are separate
    assert.equal(b.stripMembers('rail:tp').length, 25);
    assert.equal(b.strips().length, 60 + 4);

    const s = makeBoard({ kind: 'half', railSplit: true });
    assert.equal(s.stripOf('r:tp:3'), 'rail:tp:L');
    assert.equal(s.stripOf('r:tp:27'), 'rail:tp:R');
    assert.notEqual(s.stripOf('r:tp:3'), s.stripOf('r:tp:27'));
    assert.equal(s.stripOf('r:tp:3'), s.stripOf('r:tp:15'));
    assert.equal(s.stripOf('r:tp:16'), s.stripOf('r:tp:27'));
    assert.equal(s.holes.length, 400);
    assert.equal(s.strips().length, 60 + 8);
  });

  test('labels use the real minus sign', () => {
    const b = half();
    assert.equal(b.label('h:c5'), 'c5');
    assert.equal(b.label('r:tp:12'), 'T+ 12');
    assert.equal(b.label('r:bm:7'), 'B− 7');
    assert.equal(b.label('r:tm:3'), 'T− 3');
    assert.equal(b.label('r:bp:3'), 'B+ 3');
    assert.equal(b.label('p:DRV1:+'), 'DRV1 +');
  });

  test('mini has no rails; full is 63 cols; dual stacks a second block', () => {
    const m = makeBoard({ kind: 'mini' });
    assert.equal(m.rails.length, 0);
    assert.equal(m.holes.length, 170);
    assert.equal(m.holeAt(3, -3), null);
    assert.equal(m.classify(3, -3), 'offboard');
    assert.equal(m.holeAt(17, 11), 'h:j17');
    assert.equal(m.holeAt(18, 0), null);

    const f = makeBoard({ kind: 'full' });
    assert.equal(f.cols, 63);
    assert.equal(f.stripHoles.length, 630);
    assert.equal(f.railHoles.length, 4 * 58);
    assert.equal(f.holeAt(60, -3), 'r:tp:60');
    assert.equal(f.holeAt(61, -3), null);

    const d = makeBoard({ kind: 'dual' });
    assert.equal(d.stripHoles.length, 600);
    assert.equal(d.railHoles.length, 100);
    assert.deepEqual(d.rails.map((r) => r.y), [-3, -2, 29, 30]);
    assert.equal(d.holeAt(5, 15), 'h:k5');
    assert.equal(d.holeAt(5, 26), 'h:t5');
    assert.equal(d.holeAt(5, 20), null);
    assert.equal(d.classify(5, 13), 'channel');
    assert.equal(d.stripOf('h:k5'), 's:k5');
    assert.equal(d.stripOf('h:k5'), d.stripOf('h:o5'));
    assert.notEqual(d.stripOf('h:o5'), d.stripOf('h:p5'));
    assert.notEqual(d.stripOf('h:j5'), d.stripOf('h:k5'));
  });

  test('accepts a plain kind string and falls back to half', () => {
    assert.equal(makeBoard('mini').cols, 17);
    assert.equal(makeBoard(undefined).cols, 30);
    assert.equal(makeBoard({ kind: 'bogus' }).cols, 30);
  });
});

// ---------------------------------------------------------------------------
describe('parts', () => {
  test('library, order and colours', () => {
    assert.deepEqual(PART_ORDER, [
      'xiao_esp32c3', 'resistor', 'diode', 'capacitor', 'mosfet_n',
      'uln2003', 'stepper_28byj48', 'servo', 'electromagnet', 'power_supply',
    ]);
    for (const t of PART_ORDER) assert.ok(PART_LIBRARY[t], `missing ${t}`);
    assert.equal(Object.keys(PART_LIBRARY).length, 10);
    assert.deepEqual(WIRE_COLORS, ['red', 'black', 'blue', 'green', 'yellow', 'orange', 'white', 'purple', 'brown', 'grey']);
    assert.equal(partDef('resistor').refPrefix, 'R');
    assert.equal(partDef('uln2003').refPrefix, 'DRV');
    assert.equal(partDef('nope'), null);
    assert.deepEqual(partDef('uln2003').size, { w: 8, h: 7 });
    assert.deepEqual(partDef('stepper_28byj48').size, { w: 6, h: 6 });
    assert.deepEqual(partDef('servo').size, { w: 6, h: 4 });
    assert.deepEqual(partDef('electromagnet').size, { w: 4, h: 4 });
    assert.deepEqual(partDef('power_supply').size, { w: 5, h: 4 });
  });

  test('rotateOffset works with array and object destructuring', () => {
    assert.deepEqual([...rotateOffset(2, 1, 0)], [2, 1]);
    assert.deepEqual([...rotateOffset(2, 1, 90)], [-1, 2]);
    assert.deepEqual([...rotateOffset(2, 1, 180)], [-2, -1]);
    assert.deepEqual([...rotateOffset(2, 1, 270)], [1, -2]);
    const { x, y } = rotateOffset(2, 1, 90);
    assert.equal(x, -1);
    assert.equal(y, 2);
    assert.deepEqual([...rotateOffset(3, 0, -90)], [0, -3]);
  });

  test('parseNodeId handles +, -, V+ and plug/socket pins', () => {
    assert.deepEqual(parseNodeId('h:c5'), { kind: 'hole', id: 'h:c5', row: 'c', col: 5, hole: 'c5' });
    assert.deepEqual(parseNodeId('r:tp:3'), { kind: 'rail', id: 'r:tp:3', rail: 'tp', col: 3 });
    assert.deepEqual(parseNodeId('p:DRV1:+'), { kind: 'pin', id: 'p:DRV1:+', partId: 'DRV1', pin: '+' });
    assert.deepEqual(parseNodeId('p:DRV1:-'), { kind: 'pin', id: 'p:DRV1:-', partId: 'DRV1', pin: '-' });
    assert.deepEqual(parseNodeId('p:PS1:V+'), { kind: 'pin', id: 'p:PS1:V+', partId: 'PS1', pin: 'V+' });
    assert.equal(parseNodeId('p:M1:PLUG').pin, 'PLUG');
    assert.equal(parseNodeId('p:DRV1:SOCKET').pin, 'SOCKET');
    assert.equal(parseNodeId('p:U1:BAT-').pin, 'BAT-');
    assert.equal(parseNodeId('x:1'), null);
    assert.equal(parseNodeId(null), null);
    assert.equal(pinNodeId('DRV1', '+'), 'p:DRV1:+');
  });

  test('XIAO at (1,2) rot 0: 5V on c1, D0 on g1, D7 on c7; 14 through + 2 off-grid', () => {
    const b = half();
    const pins = resolvePins(xiao(1, 2, 0));
    assert.equal(pins.length, 16);
    assert.equal(pins.filter((p) => p.through).length, 14);
    assert.equal(pins.filter((p) => p.offGrid).length, 2);
    const at = (n) => b.holeAt(pinAt(pins, n).x, pinAt(pins, n).y);
    assert.equal(at('5V'), 'h:c1');
    assert.equal(at('GND'), 'h:c2');
    assert.equal(at('3V3'), 'h:c3');
    assert.equal(at('D10'), 'h:c4');
    assert.equal(at('D9'), 'h:c5');
    assert.equal(at('D8'), 'h:c6');
    assert.equal(at('D7'), 'h:c7');
    assert.equal(at('D0'), 'h:g1');
    assert.equal(at('D1'), 'h:g2');
    assert.equal(at('D6'), 'h:g7');
    assert.equal(pinAt(pins, 'D0').strapping, true);
    assert.equal(pinAt(pins, 'D8').strapping, true);
    assert.equal(pinAt(pins, 'D9').strapping, true);
    assert.equal(pinAt(pins, 'D1').strapping, undefined);
    assert.equal(pinAt(pins, '5V').volts, 5);
    assert.equal(pinAt(pins, '3V3').volts, 3.3);
    assert.equal(pinAt(pins, 'GND').required, 'error');
    assert.equal(pinAt(pins, '5V').nodeId, 'p:U1:5V');
    assert.equal(pinAt(pins, 'BAT-').through, false);
    assert.deepEqual(internalConnections(xiao()), [['p:U1:BAT-', 'p:U1:GND']]);
    assert.ok(validatePlacement(xiao(1, 2, 0), b, []).ok);
  });

  test('XIAO rot 90 → channel; rot 180 puts USB right and is valid from row f', () => {
    const b = half();
    const v = validatePlacement(xiao(5, 2, 90), b, []);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => p.code === 'channel'));
    // anchor on row a puts the second row (dy 6) in the channel
    const a = validatePlacement(xiao(1, 0, 0), b, []);
    assert.equal(a.ok, false);
    assert.ok(a.problems.every((p) => p.code === 'channel'));
    assert.equal(a.problems.length, 7);
    // rot 180 at (7,8): pins run x 7..1, rows g and a
    const r = resolvePins(xiao(7, 8, 180));
    assert.equal(b.holeAt(pinAt(r, '5V').x, pinAt(r, '5V').y), 'h:g7');
    assert.equal(b.holeAt(pinAt(r, 'D0').x, pinAt(r, 'D0').y), 'h:c7');
    assert.equal(b.holeAt(pinAt(r, 'D6').x, pinAt(r, 'D6').y), 'h:c1');
    assert.equal(b.holeAt(pinAt(r, 'D7').x, pinAt(r, 'D7').y), 'h:g1');
    assert.ok(validatePlacement(xiao(7, 8, 180), b, []).ok);
    // off board
    const off = validatePlacement(xiao(28, 2, 0), b, []);
    assert.equal(off.ok, false);
    assert.ok(off.problems.some((p) => p.code === 'offboard'));
  });

  test('MOSFET package order TO-220 [G,D,S] vs TO-92 [S,G,D]', () => {
    const q220 = resolvePins(part('Q1', 'mosfet_n', 12, 9, { package: 'TO-220' }));
    assert.deepEqual(q220.map((p) => p.name), ['G', 'D', 'S']);
    assert.deepEqual(q220.map((p) => p.x), [12, 13, 14]);
    assert.deepEqual(q220.map((p) => p.role), ['gate', 'drain', 'source']);
    const q92 = resolvePins(part('Q1', 'mosfet_n', 12, 9, { package: 'TO-92' }));
    assert.deepEqual(q92.map((p) => p.name), ['S', 'G', 'D']);
    assert.deepEqual(q92.map((p) => p.x), [12, 13, 14]);
    assert.ok(q220.every((p) => p.required === 'error'));
    assert.equal(partDef('mosfet_n').props.partNumber, 'IRLZ44N');
  });

  test('resistor span moves pin 2; span is clamped 2..10; diode A/K; polarized cap labels', () => {
    const r4 = resolvePins(part('R1', 'resistor', 8, 10, { span: 4 }));
    assert.deepEqual(r4.map((p) => [p.name, p.x, p.y]), [['1', 8, 10], ['2', 12, 10]]);
    const r6 = resolvePins(part('R1', 'resistor', 8, 10, { span: 6 }));
    assert.equal(pinAt(r6, '2').x, 14);
    assert.equal(pinAt(resolvePins(part('R1', 'resistor', 8, 10, { span: 99 })), '2').x, 18);
    assert.equal(pinAt(resolvePins(part('R1', 'resistor', 8, 10, { span: 1 })), '2').x, 10);
    assert.equal(pinAt(resolvePins(part('R1', 'resistor', 8, 10, {})), '2').x, 12); // default 4
    // vertical straddle: rot 90 + span 3 (e→f)
    const v = resolvePins(part('R1', 'resistor', 5, 4, { span: 3 }, 90));
    assert.deepEqual(v.map((p) => [p.x, p.y]), [[5, 4], [5, 7]]);
    assert.ok(validatePlacement(part('R1', 'resistor', 5, 4, { span: 3 }, 90), half(), []).ok);
    const d = resolvePins(part('D1', 'diode', 13, 8, { span: 4 }));
    assert.deepEqual(d.map((p) => [p.name, p.role, p.x]), [['A', 'anode', 13], ['K', 'cathode', 17]]);
    const c = resolvePins(part('C1', 'capacitor', 1, 0, { polarized: true }));
    assert.deepEqual(c.map((p) => [p.name, p.label, p.x]), [['1', '+', 1], ['2', '−', 3]]);
    assert.equal(parseOhms('220Ω'), 220);
    assert.equal(parseOhms('10kΩ'), 10000);
    assert.equal(parseOhms('4k7'), 4700);
    assert.equal(parseOhms('1M'), 1e6);
    assert.equal(parseOhms('abc'), null);
  });

  test('overlap is detected against other parts and ignores the part itself', () => {
    const b = half();
    const q = part('Q1', 'mosfet_n', 12, 9);
    const r = part('R1', 'resistor', 8, 9, { span: 4 }); // pin 2 at h12 = Q1 gate
    const v = validatePlacement(r, b, [q]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.problems.map((p) => [p.pin, p.code, p.holeId]), [['2', 'overlap', 'h:h12']]);
    assert.ok(validatePlacement(r, b, [r]).ok);
    assert.ok(validatePlacement(r, b, []).ok);
    assert.ok(validatePlacement(part('DRV1', 'uln2003', 3, -12), b, [q]).ok); // bench always ok
  });

  test('bench parts: terminals have absolute x,y and through:false; hidden pins carry hidden:true', () => {
    const drv = resolvePins(part('DRV1', 'uln2003', 3, -12));
    const t = (n) => pinAt(drv, n);
    assert.deepEqual([t('IN1').x, t('IN1').y], [4, -5]);
    assert.deepEqual([t('IN4').x, t('IN4').y], [7, -5]);
    assert.deepEqual([t('-').x, t('-').y], [8.5, -5]);
    assert.deepEqual([t('+').x, t('+').y], [9.5, -5]);
    assert.deepEqual([t('SOCKET').x, t('SOCKET').y], [11, -8.5]);
    assert.deepEqual(t('SOCKET').connector, ['COM', 'OUT4', 'OUT3', 'OUT2', 'OUT1']);
    assert.equal(t('IN1').required, 'cond');
    assert.equal(t('-').required, 'error');
    assert.equal(t('+').required, 'error');
    assert.equal(t('-').role, 'gnd');
    assert.equal(t('+').role, 'power_in');
    assert.ok(drv.every((p) => p.through === false));
    const hidden = drv.filter((p) => p.hidden).map((p) => p.name);
    assert.deepEqual(hidden, ['COM', 'OUT1', 'OUT2', 'OUT3', 'OUT4']);
    assert.equal(t('COM').x, undefined);

    const m = resolvePins(part('M1', 'stepper_28byj48', 13, -12));
    assert.deepEqual([pinAt(m, 'PLUG').x, pinAt(m, 'PLUG').y], [13, -8.5]);
    assert.deepEqual(pinAt(m, 'PLUG').connector, ['RED', 'ORANGE', 'YELLOW', 'PINK', 'BLUE']);
    assert.deepEqual(m.filter((p) => p.hidden).map((p) => p.name), ['RED', 'ORANGE', 'YELLOW', 'PINK', 'BLUE']);

    const sv = resolvePins(part('SV1', 'servo', 1, 17));
    assert.deepEqual(sv.map((p) => [p.name, p.x, p.y, p.role]), [['SIG', 2, 17, 'signal'], ['VCC', 3, 17, 'power_in'], ['GND', 4, 17, 'gnd']]);
    assert.ok(sv.every((p) => p.required === 'error'));

    const l = resolvePins(part('L1', 'electromagnet', 12, 17));
    assert.deepEqual(l.map((p) => [p.name, p.x, p.y, p.required]), [['1', 13, 17, 'warn'], ['2', 15, 17, 'warn']]);

    const ps = resolvePins(part('PS1', 'power_supply', 32, 12, { voltage: 5 }));
    assert.deepEqual(ps.map((p) => [p.name, p.x, p.y, p.role]), [['GND', 32, 13, 'gnd'], ['V+', 32, 15, 'supply']]);
    assert.equal(pinAt(ps, 'V+').volts, 5);
    assert.equal(pinAt(resolvePins(part('PS1', 'power_supply', 32, 12, { voltage: 12 })), 'V+').volts, 12);
    assert.equal(partDef('power_supply').props.voltage, 5);

    // bench rotation is about the body top-left
    const rot = resolvePins(part('SV1', 'servo', 1, 17, {}, 90));
    assert.deepEqual([pinAt(rot, 'SIG').x, pinAt(rot, 'SIG').y], [1, 18]);
  });

  test('connectorPins / expandPlug / findPlugPartner', () => {
    const drv = part('DRV1', 'uln2003', 3, -12);
    const m = part('M1', 'stepper_28byj48', 13, -12);
    assert.deepEqual(connectorPins(drv, 'SOCKET'), ['p:DRV1:COM', 'p:DRV1:OUT4', 'p:DRV1:OUT3', 'p:DRV1:OUT2', 'p:DRV1:OUT1']);
    assert.equal(connectorPins(drv, 'IN1'), null);
    assert.equal(connectorPins(part('R1', 'resistor', 1, 1), '1'), null);
    const pairs = expandPlug(m, 'PLUG', drv, 'SOCKET');
    assert.deepEqual(pairs, [
      ['p:M1:RED', 'p:DRV1:COM'],
      ['p:M1:ORANGE', 'p:DRV1:OUT4'],
      ['p:M1:YELLOW', 'p:DRV1:OUT3'],
      ['p:M1:PINK', 'p:DRV1:OUT2'],
      ['p:M1:BLUE', 'p:DRV1:OUT1'],
    ]);
    assert.equal(expandPlug(m, 'PLUG', drv, 'IN1'), null);
    assert.equal(expandPlug(m, 'PLUG', m, 'PLUG'), null);
    const project = { parts: [drv, m], wires: [{ id: 'W22', kind: 'plug', a: 'p:M1:PLUG', b: 'p:DRV1:SOCKET' }] };
    assert.deepEqual(findPlugPartner(project, 'M1', 'PLUG'), { partId: 'DRV1', pin: 'SOCKET', wireId: 'W22' });
    assert.deepEqual(findPlugPartner(project, 'DRV1', 'SOCKET'), { partId: 'M1', pin: 'PLUG', wireId: 'W22' });
    assert.equal(findPlugPartner({ parts: [drv, m], wires: [] }, 'M1', 'PLUG'), null);
  });

  test('ULN jumper switch: closed by default, open when props.jumper === false', () => {
    assert.deepEqual(internalConnections(part('DRV1', 'uln2003', 0, 0, {})), [['p:DRV1:+', 'p:DRV1:COM']]);
    assert.deepEqual(internalConnections(part('DRV1', 'uln2003', 0, 0, { jumper: true })), [['p:DRV1:+', 'p:DRV1:COM']]);
    assert.deepEqual(internalConnections(part('DRV1', 'uln2003', 0, 0, { jumper: false })), []);
    assert.deepEqual(partDef('uln2003').indicators.map((i) => [i.id, i.pin]), [['LED_A', 'OUT1'], ['LED_B', 'OUT2'], ['LED_C', 'OUT3'], ['LED_D', 'OUT4']]);
  });

  test('nextRefId returns the lowest free id', () => {
    assert.equal(nextRefId('R', []), 'R1');
    assert.equal(nextRefId('R', [{ id: 'R1' }, { id: 'R3' }]), 'R2');
    assert.equal(nextRefId('R', [{ id: 'R1' }, { id: 'R2' }]), 'R3');
    assert.equal(nextRefId('DRV', [{ id: 'DRV1' }, { id: 'D1' }]), 'DRV2');
  });

  test('bodyRect rotates about the anchor', () => {
    const r0 = bodyRect(xiao(1, 2, 0));
    assert.deepEqual(r0, { x: 1 - 0.63, y: 1.5, w: 8.26, h: 7 });
    const r180 = bodyRect(xiao(7, 8, 180));
    assert.ok(Math.abs(r180.x - (7 - 7.63)) < 1e-9);
    assert.ok(Math.abs(r180.y - 1.5) < 1e-9);
    assert.equal(r180.w, 8.26);
    assert.equal(r180.h, 7);
    const r90 = bodyRect(part('R1', 'resistor', 5, 4, { span: 3 }, 90));
    assert.ok(r90.h > r90.w);
    const bench = bodyRect(part('DRV1', 'uln2003', 3, -12));
    assert.deepEqual(bench, { x: 3, y: -12, w: 8, h: 7 });
    const bench90 = bodyRect(part('DRV1', 'uln2003', 3, -12, {}, 90));
    assert.deepEqual(bench90, { x: 3 - 7, y: -12, w: 7, h: 8 });
  });

  test('suggestAnchor snaps the 0.6" XIAO across the channel within ±2 rows', () => {
    const b = half();
    const def = partDef('xiao_esp32c3');
    assert.deepEqual(suggestAnchor(def, {}, 0, 1, 2, b, []), { x: 1, y: 2 });
    assert.deepEqual(suggestAnchor(def, {}, 0, 1, 0, b, []), { x: 1, y: 1 }); // row a → b
    assert.deepEqual(suggestAnchor(def, {}, 0, 1, 6, b, []), { x: 1, y: 4 }); // channel → e
    assert.deepEqual(suggestAnchor(def, {}, 0, 1, 5, b, []), { x: 1, y: 4 });
    assert.deepEqual(suggestAnchor(def, {}, 180, 7, 11, b, []), { x: 7, y: 10 }); // j → i (USB right)
    assert.equal(suggestAnchor(def, {}, 90, 5, 2, b, []), null); // vertical never fits
    assert.equal(suggestAnchor(def, {}, 0, 28, 2, b, []), null); // off board
    assert.equal(suggestAnchor('xiao_esp32c3', {}, 0, 1, 3.4, b, []).y, 3);
    // occupied: a resistor on c1 pushes the anchor down a row
    const blocker = part('R9', 'resistor', 1, 2, { span: 2 });
    assert.deepEqual(suggestAnchor(def, {}, 0, 1, 2, b, [blocker]), { x: 1, y: 1 });
    // excludeId lets a part be dropped on its own holes
    const me = xiao(1, 2, 0);
    assert.deepEqual(suggestAnchor(def, {}, 0, 1, 2, b, [me], 'U1'), { x: 1, y: 2 });
    assert.deepEqual(suggestAnchor(partDef('servo'), {}, 0, 40, 3, b, []), { x: 40, y: 3 }); // bench: anything
  });
});

// ---------------------------------------------------------------------------
describe('netlist', () => {
  const emptyProject = (parts = [], wires = [], bridges = []) => ({ version: 1, board: { kind: 'half', railSplit: false }, parts, wires, bridges });
  const netOf = (nl, node) => nl.netOf.get(node);

  test('UnionFind basics', () => {
    const uf = new UnionFind();
    uf.add('a');
    uf.add('b');
    uf.add('c');
    uf.union('a', 'b');
    assert.equal(uf.find('a'), uf.find('b'));
    assert.notEqual(uf.find('a'), uf.find('c'));
    uf.union('c', 'd'); // auto-adds d
    assert.ok(uf.connected('c', 'd'));
    const g = uf.groups();
    assert.equal(g.size, 2);
    assert.deepEqual([...g.values()].map((x) => x.sort()), [['a', 'b'], ['c', 'd']]);
    assert.equal(uf.find('zzz'), undefined);
  });

  test('strips join, channel isolates, wires and bridges join, singletons kept', () => {
    const b = half();
    const nl = buildNetlist(emptyProject(), b);
    assert.equal(netOf(nl, 'h:a5'), netOf(nl, 'h:e5'));
    assert.notEqual(netOf(nl, 'h:e5'), netOf(nl, 'h:f5'));
    assert.notEqual(netOf(nl, 'h:a5'), netOf(nl, 'h:a6'));
    assert.equal(netOf(nl, 'r:tp:3'), netOf(nl, 'r:tp:27'));
    assert.notEqual(netOf(nl, 'r:tp:3'), netOf(nl, 'r:bp:3'));
    assert.equal(nl.nets.length, 64);
    assert.ok(nl.nets.every((n) => n.id.startsWith('n')));
    assert.ok(nl.netOf.has('h:j30'));

    const wired = buildNetlist(emptyProject([], [{ id: 'W1', kind: 'wire', a: 'h:a5', b: 'h:f9' }], [{ id: 'B1', a: 'h:c6', b: 'h:c7' }]), b);
    assert.equal(netOf(wired, 'h:e5'), netOf(wired, 'h:j9'));
    assert.equal(netOf(wired, 'h:a6'), netOf(wired, 'h:e7'));
    assert.notEqual(netOf(wired, 'h:a5'), netOf(wired, 'h:a6'));
    assert.equal(wired.nets.length, 62);
    assert.deepEqual(wired.dangling, []);
    const n = netOf(wired, 'h:a5');
    assert.equal(n.holes.length, 10);
    assert.equal(n.kind, 'other');
    assert.ok(/^N\d+$/.test(n.name));
    assert.ok(n.roles instanceof Set);
    assert.ok(n.powerTags instanceof Set);
  });

  test('a through pin inherits the hole net and names it D0; power/gnd pins tag the net', () => {
    const b = half();
    const nl = buildNetlist(emptyProject([xiao(1, 2, 0)]), b);
    const d0 = netOf(nl, 'p:U1:D0');
    assert.equal(d0, netOf(nl, 'h:j1'));
    assert.equal(d0.name, 'D0');
    assert.equal(d0.kind, 'gpio');
    assert.deepEqual(d0.pins.map((p) => [p.partId, p.partType, p.pin, p.role, p.strapping]), [['U1', 'xiao_esp32c3', 'D0', 'gpio', true]]);
    assert.ok(d0.members.includes('h:f1') && d0.members.includes('p:U1:D0'));
    const g = netOf(nl, 'p:U1:GND');
    assert.equal(g.name, 'GND');
    assert.equal(g.kind, 'gnd');
    assert.ok(g.powerTags.has('GND'));
    assert.equal(netOf(nl, 'p:U1:BAT-'), g); // internal connection
    assert.ok(g.members.includes('h:a2'));
    const v = netOf(nl, 'p:U1:5V');
    assert.equal(v.name, '5V');
    assert.equal(v.kind, 'power');
    assert.ok(v.powerTags.has('5V'));
    assert.equal(v.pins[0].volts, 5);
    assert.equal(netOf(nl, 'p:U1:3V3').name, '3V3');
    assert.equal(netOf(nl, 'p:U1:D7').name, 'D7');
    assert.equal(netOf(nl, 'h:c7'), netOf(nl, 'p:U1:D7'));
    assert.deepEqual(nl.byName.get('D0').length, 1);
    assert.ok(nl.pinInfo.get('p:U1:D0').holeId === 'h:g1');
    // off-grid BAT+ is a node but not on any hole
    assert.equal(netOf(nl, 'p:U1:BAT+').holes.length, 0);
  });

  test('plug unions RED↔COM, BLUE↔OUT1; jumper open separates + from COM', () => {
    const b = half();
    const drv = part('DRV1', 'uln2003', 3, -12, { jumper: true });
    const m = part('M1', 'stepper_28byj48', 13, -12);
    const plug = { id: 'W22', kind: 'plug', a: 'p:M1:PLUG', b: 'p:DRV1:SOCKET', color: 'grey', mid: null };
    const nl = buildNetlist(emptyProject([drv, m], [plug]), b);
    assert.equal(netOf(nl, 'p:M1:RED'), netOf(nl, 'p:DRV1:COM'));
    assert.equal(netOf(nl, 'p:M1:RED'), netOf(nl, 'p:DRV1:+'));
    assert.equal(netOf(nl, 'p:M1:BLUE'), netOf(nl, 'p:DRV1:OUT1'));
    assert.equal(netOf(nl, 'p:M1:PINK'), netOf(nl, 'p:DRV1:OUT2'));
    assert.equal(netOf(nl, 'p:M1:YELLOW'), netOf(nl, 'p:DRV1:OUT3'));
    assert.equal(netOf(nl, 'p:M1:ORANGE'), netOf(nl, 'p:DRV1:OUT4'));
    assert.equal(netOf(nl, 'p:M1:BLUE').name, 'OUT1');
    assert.equal(netOf(nl, 'p:M1:ORANGE').name, 'OUT4');
    assert.notEqual(netOf(nl, 'p:M1:BLUE'), netOf(nl, 'p:M1:PINK'));
    assert.deepEqual(nl.dangling, []);

    const open = buildNetlist(emptyProject([{ ...drv, props: { jumper: false } }, m], [plug]), b);
    assert.equal(open.netOf.get('p:M1:RED'), open.netOf.get('p:DRV1:COM'));
    assert.notEqual(open.netOf.get('p:DRV1:COM'), open.netOf.get('p:DRV1:+'));

    // an incompatible plug is dangling and joins nothing
    const bad = buildNetlist(emptyProject([drv, m], [{ id: 'W9', kind: 'plug', a: 'p:M1:PLUG', b: 'p:DRV1:IN1' }]), b);
    assert.deepEqual(bad.dangling, ['W9']);
    assert.notEqual(bad.netOf.get('p:M1:RED'), bad.netOf.get('p:DRV1:COM'));
  });

  test('naming priority: GND > 5V/V+ > 3V3 > Dn > OUTx > Q1.D > R1.2 > N#; conflict kind', () => {
    const b = half();
    const ps = part('PS1', 'power_supply', 32, 12, { voltage: 5 });
    const q = part('Q1', 'mosfet_n', 12, 9);
    const d = part('D1', 'diode', 13, 8, { span: 4 });
    const r = part('R1', 'resistor', 20, 0, { span: 4 });
    const l = part('L1', 'electromagnet', 12, 17);
    const W = (id, a, bb) => ({ id, kind: 'wire', a, b: bb });
    const nl = buildNetlist(emptyProject([xiao(1, 2, 0), ps, q, d, r, l], [
      W('W1', 'p:PS1:GND', 'h:a2'), // gnd + XIAO GND
      W('W2', 'p:PS1:V+', 'h:a1'), // supply + XIAO 5V → 5V (same tag, no conflict)
      W('W3', 'h:j13', 'p:L1:1'), // drain net gains a lead
    ]), b);
    assert.equal(netOf(nl, 'p:PS1:GND').name, 'GND');
    assert.equal(netOf(nl, 'p:PS1:GND'), netOf(nl, 'p:U1:GND'));
    const five = netOf(nl, 'p:PS1:V+');
    assert.equal(five.name, '5V');
    assert.equal(five.kind, 'power');
    assert.deepEqual([...five.powerTags], ['5V']);
    assert.equal(netOf(nl, 'p:U1:3V3').name, '3V3');
    const drain = netOf(nl, 'p:Q1:D');
    assert.equal(drain.name, 'Q1.D'); // mosfet beats diode (D1.A) and lead (L1.1)
    assert.equal(drain.kind, 'signal');
    assert.equal(drain, netOf(nl, 'p:D1:A'));
    assert.equal(drain, netOf(nl, 'p:L1:1'));
    assert.equal(netOf(nl, 'p:Q1:G').name, 'Q1.G');
    assert.equal(netOf(nl, 'p:D1:K').name, 'D1.K');
    assert.equal(netOf(nl, 'p:R1:2').name, 'R1.2');
    assert.equal(netOf(nl, 'p:R1:2').kind, 'other');
    assert.ok(/^N\d+$/.test(netOf(nl, 'h:a29').name));

    // 12 V supply tied to XIAO 5V → mixed tags → conflict
    const nl12 = buildNetlist(emptyProject([xiao(1, 2, 0), { ...ps, props: { voltage: 12 } }], [W('W2', 'p:PS1:V+', 'h:a1')]), b);
    const c = nl12.netOf.get('p:PS1:V+');
    assert.equal(c.kind, 'conflict');
    assert.deepEqual([...c.powerTags].sort(), ['5V', 'V+']);
    const lone12 = buildNetlist(emptyProject([{ ...ps, props: { voltage: 12 } }]), b);
    assert.equal(lone12.netOf.get('p:PS1:V+').name, 'V+');
    assert.ok(lone12.netOf.get('p:PS1:V+').powerTags.has('V+'));

    // GND shorted to 5V → conflict named GND
    const sh = buildNetlist(emptyProject([xiao(1, 2, 0)], [W('W1', 'h:a1', 'h:a2')]), b);
    const s = sh.netOf.get('p:U1:5V');
    assert.equal(s.kind, 'conflict');
    assert.equal(s.name, 'GND');
    // 3V3 tied to 5V → conflict too
    const s2 = buildNetlist(emptyProject([xiao(1, 2, 0)], [W('W1', 'h:a1', 'h:a3')]), b);
    assert.equal(s2.netOf.get('p:U1:3V3').kind, 'conflict');
  });

  test('dangling wires and bridges are recorded, not unioned', () => {
    const b = half();
    const nl = buildNetlist(emptyProject([xiao(1, 2, 0)], [
      { id: 'W1', kind: 'wire', a: 'h:a1', b: 'p:PS9:V+' },
      { id: 'W2', kind: 'wire', a: 'h:a5', b: 'h:z9' },
      { id: 'W3', kind: 'wire', a: 'h:a6', b: 'h:a7' },
    ], [{ id: 'B1', a: 'h:c8', b: 'r:tp:1' }]), b);
    assert.deepEqual(nl.dangling, ['W1', 'W2', 'B1']);
    assert.equal(netOf(nl, 'h:a6'), netOf(nl, 'h:a7'));
    assert.equal(netOf(nl, 'p:U1:5V').pins.length, 1);
    // pins wired directly to a pin node
    const nl2 = buildNetlist(emptyProject([xiao(1, 2, 0), part('SV1', 'servo', 1, 17)], [
      { id: 'W1', kind: 'wire', a: 'p:U1:D1', b: 'p:SV1:SIG' },
    ]), b);
    assert.equal(nl2.netOf.get('p:SV1:SIG').name, 'D1');
    assert.deepEqual(nl2.dangling, []);
  });

  test('two XIAOs qualify gpio/power net names with the part id', () => {
    const b = half();
    const nl = buildNetlist(emptyProject([xiao(1, 2, 0), { ...xiao(12, 2, 0), id: 'U2' }]), b);
    assert.equal(netOf(nl, 'p:U1:D0').name, 'U1.D0');
    assert.equal(netOf(nl, 'p:U2:D0').name, 'U2.D0');
    assert.equal(netOf(nl, 'p:U1:5V').name, 'U1.5V');
    assert.equal(netOf(nl, 'p:U1:GND').name, 'GND');
  });
});
