// sim.js — logic-level simulation (no SPICE). Pure JS, no DOM.
//
// Levels: GND > VCC > HIGH > LOW > FLOAT, CONFLICT when GND and VCC are both driven
// strongly on one net. Pins drive "strong" levels; resistors pass levels "weakly":
// among weak drivers the one with the lowest path resistance wins (so a 220 Ω series
// resistor from a HIGH GPIO beats a 10 kΩ pulldown to GND, like the real divider).

import { makeBoard } from './board.js';
import { partDef, partProps, pinNodeId, parseOhms, findPlugPartner, XIAO_GPIO_PINS } from './parts.js';
import { buildNetlist } from './netlist.js';

export const STEPPER_SEQUENCE = [
  [1, 1, 0, 0],
  [0, 1, 1, 0],
  [0, 0, 1, 1],
  [1, 0, 0, 1],
]; // from receiver_controller.ino (two-coil-on full step)

export const STEPPER_DEG_PER_STEP = 11.25;

export const LEVELS = ['GND', 'VCC', 'HIGH', 'LOW', 'FLOAT', 'CONFLICT'];
const PRIORITY = { GND: 0, VCC: 1, HIGH: 2, LOW: 3, FLOAT: 4 };
const RANK = { GND: 0, LOW: 1, HIGH: 2, VCC: 3 }; // for diode bias
export const isHighLevel = (lvl) => lvl === 'HIGH' || lvl === 'VCC';

const MAX_PASSES = 10;
const DEFAULT_OHMS = 1000;

function xiaoIds(project) {
  return ((project && project.parts) || []).filter((p) => p.type === 'xiao_esp32c3').map((p) => p.id);
}

export function defaultInputs(project) {
  const gpio = {};
  const servoAngle = {};
  for (const id of xiaoIds(project)) {
    gpio[id] = {};
    for (const pin of XIAO_GPIO_PINS) gpio[id][pin] = false;
    servoAngle[id] = 90;
  }
  return { gpio, servoAngle, supplyOn: true };
}

/** Deep-copy inputs and make sure every XIAO in the project has an entry. */
export function cloneInputs(base, project) {
  const out = { gpio: {}, servoAngle: {}, supplyOn: base ? base.supplyOn !== false : true };
  for (const id of xiaoIds(project)) {
    out.gpio[id] = {};
    for (const pin of XIAO_GPIO_PINS) out.gpio[id][pin] = !!(base && base.gpio && base.gpio[id] && base.gpio[id][pin]);
    const a = base && base.servoAngle ? base.servoAngle[id] : undefined;
    out.servoAngle[id] = Number.isFinite(a) ? a : 90;
  }
  // keep any extra keys the caller stored (e.g. for XIAOs no longer present)
  if (base && base.gpio) for (const k of Object.keys(base.gpio)) if (!out.gpio[k]) out.gpio[k] = { ...base.gpio[k] };
  return out;
}

function resolveLevel(strongSet, weakMap) {
  if (strongSet && strongSet.size) {
    if (strongSet.has('GND') && strongSet.has('VCC')) return 'CONFLICT';
    let best = null;
    for (const l of strongSet) if (best === null || PRIORITY[l] < PRIORITY[best]) best = l;
    return best;
  }
  if (weakMap && weakMap.size) {
    let best = null;
    for (const w of weakMap.values()) {
      if (!best || w.r < best.r || (w.r === best.r && PRIORITY[w.level] < PRIORITY[best.level])) best = w;
    }
    return best.level;
  }
  return 'FLOAT';
}

/**
 * Evaluate the circuit at logic level.
 * @returns {{ netLevel: Map<string,string>, parts: Object, notes: string[] }}
 */
export function evaluate(project, board, netlist, inputs, prev = null) {
  const parts = (project && project.parts) || [];
  inputs = inputs || defaultInputs(project);
  const supplyOn = inputs.supplyOn !== false;
  const notes = [];
  const netOfPin = (partId, pin) => netlist.netOf.get(pinNodeId(partId, pin)) || null;
  const nets = netlist.nets;

  // ---- static strong drivers --------------------------------------------
  const seed = new Map(); // netId -> Set<level>
  const addLevel = (map, net, lvl) => {
    if (!net) return;
    if (!map.has(net.id)) map.set(net.id, new Set());
    map.get(net.id).add(lvl);
  };
  for (const net of nets) {
    for (const p of net.pins) {
      if (p.role === 'gpio' && p.partType === 'xiao_esp32c3') {
        const on = !!(inputs.gpio && inputs.gpio[p.partId] && inputs.gpio[p.partId][p.pin]);
        addLevel(seed, net, on ? 'HIGH' : 'LOW');
      } else if (p.source) {
        if (p.partType === 'power_supply' && !supplyOn) continue;
        if (p.role === 'gnd') addLevel(seed, net, 'GND');
        else if (p.role === 'power' || p.role === 'supply') addLevel(seed, net, 'VCC');
      }
    }
  }

  // ---- devices ------------------------------------------------------------
  const resistors = parts
    .filter((p) => p.type === 'resistor')
    .map((r) => ({ id: r.id, ohms: parseOhms(partProps(r).value) ?? DEFAULT_OHMS, a: netOfPin(r.id, '1'), b: netOfPin(r.id, '2') }))
    .filter((r) => r.a && r.b && r.a !== r.b);
  const mosfets = parts
    .filter((p) => p.type === 'mosfet_n')
    .map((q) => ({ id: q.id, g: netOfPin(q.id, 'G'), d: netOfPin(q.id, 'D'), s: netOfPin(q.id, 'S') }));
  const ulns = parts
    .filter((p) => p.type === 'uln2003')
    .map((u) => ({
      id: u.id,
      plus: netOfPin(u.id, '+'),
      minus: netOfPin(u.id, '-'),
      in: [1, 2, 3, 4].map((i) => netOfPin(u.id, `IN${i}`)),
      out: [1, 2, 3, 4].map((i) => netOfPin(u.id, `OUT${i}`)),
    }));

  // ---- fixed point ----------------------------------------------------------
  let levels = new Map();
  let weak = new Map(); // netId -> Map<key, {level, r, origin}>
  let dyn = new Map(); // netId -> Set<level>
  let signature = '';
  let converged = false;
  const lvl = (net) => (net ? levels.get(net.id) || 'FLOAT' : 'FLOAT');
  const mosState = new Map();
  const ulnState = new Map();

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const strongAll = (netId) => {
      const s = new Set(seed.get(netId) || []);
      for (const l of dyn.get(netId) || []) s.add(l);
      return s;
    };
    // weak propagation through resistors (uses previous pass's weak map)
    const nextWeak = new Map();
    const contribute = (toNet, level, r, origin) => {
      if (origin === toNet.id || level === 'FLOAT') return;
      if (!nextWeak.has(toNet.id)) nextWeak.set(toNet.id, new Map());
      const m = nextWeak.get(toNet.id);
      const key = `${level}|${origin}`;
      const cur = m.get(key);
      if (!cur || r < cur.r) m.set(key, { level, r, origin });
    };
    const driversOf = (net) => {
      const out = [];
      for (const l of strongAll(net.id)) out.push({ level: l, r: 0, origin: net.id });
      for (const w of (weak.get(net.id) || new Map()).values()) out.push(w);
      return out;
    };
    for (const r of resistors) {
      for (const d of driversOf(r.a)) contribute(r.b, d.level, d.r + r.ohms, d.origin);
      for (const d of driversOf(r.b)) contribute(r.a, d.level, d.r + r.ohms, d.origin);
    }
    weak = nextWeak;

    // resolve
    const next = new Map();
    for (const net of nets) next.set(net.id, resolveLevel(strongAll(net.id), weak.get(net.id)));
    levels = next;

    // dynamic drivers from resolved levels
    const nextDyn = new Map();
    for (const q of mosfets) {
      const conducting = isHighLevel(lvl(q.g)) && lvl(q.s) === 'GND';
      mosState.set(q.id, { conducting });
      if (conducting && q.d) addLevel(nextDyn, q.d, 'GND');
    }
    for (const u of ulns) {
      const powered = lvl(u.plus) === 'VCC' && lvl(u.minus) === 'GND';
      const out = u.in.map((n) => powered && isHighLevel(lvl(n)));
      ulnState.set(u.id, { powered, out, leds: out.slice() });
      out.forEach((active, i) => { if (active && u.out[i]) addLevel(nextDyn, u.out[i], 'GND'); });
    }
    dyn = nextDyn;

    const sig = JSON.stringify([
      [...levels.entries()],
      [...dyn.entries()].map(([k, v]) => [k, [...v].sort()]),
      [...weak.entries()].map(([k, v]) => [k, [...v.values()].map((w) => [w.level, w.r, w.origin]).sort()]),
    ]);
    if (sig === signature) {
      converged = true;
      break;
    }
    signature = sig;
  }
  if (!converged) notes.push(`Simulation did not settle within ${MAX_PASSES} passes.`);
  for (const net of nets) if (levels.get(net.id) === 'CONFLICT') notes.push(`Net ${net.name} is in CONFLICT (GND and VCC are both driven).`);

  // ---- part results ------------------------------------------------------
  const results = {};
  for (const part of parts) {
    const def = partDef(part.type);
    if (!def) continue;
    switch (part.type) {
      case 'mosfet_n':
        results[part.id] = mosState.get(part.id) || { conducting: false };
        break;
      case 'uln2003': {
        const st = ulnState.get(part.id) || { powered: false, out: [false, false, false, false], leds: [false, false, false, false] };
        results[part.id] = { powered: st.powered, out: st.out.slice(), leds: st.leds.slice() };
        if (!st.powered) notes.push(`${part.id} is unpowered (+ must be 5V and − must be GND).`);
        break;
      }
      case 'stepper_28byj48': {
        const plugged = !!findPlugPartner(project, part.id, 'PLUG');
        const red = lvl(netOfPin(part.id, def.common));
        const coils = def.coils.map((c) => lvl(netOfPin(part.id, c.color)) === 'GND' && red === 'VCC');
        const prevPart = prev && prev.parts ? prev.parts[part.id] : null;
        const adv = advanceStepper(prevPart, coils);
        results[part.id] = { plugged, coils, stepIndex: adv.stepIndex, rotorAngle: adv.rotorAngle, seqIndex: adv.seqIndex };
        break;
      }
      case 'servo': {
        const vcc = lvl(netOfPin(part.id, 'VCC')) === 'VCC';
        const gnd = lvl(netOfPin(part.id, 'GND')) === 'GND';
        const sigNet = netOfPin(part.id, 'SIG');
        const gpio = sigNet ? sigNet.pins.find((p) => p.role === 'gpio') : null;
        const alive = vcc && gnd && !!gpio;
        const a = gpio && inputs.servoAngle ? inputs.servoAngle[gpio.partId] : undefined;
        results[part.id] = { alive, angle: Number.isFinite(a) ? a : 90 };
        break;
      }
      case 'electromagnet': {
        const l1 = lvl(netOfPin(part.id, '1'));
        const l2 = lvl(netOfPin(part.id, '2'));
        results[part.id] = { energized: (l1 === 'VCC' && l2 === 'GND') || (l1 === 'GND' && l2 === 'VCC') };
        break;
      }
      case 'diode': {
        const ra = RANK[lvl(netOfPin(part.id, 'A'))];
        const rk = RANK[lvl(netOfPin(part.id, 'K'))];
        results[part.id] = { forward: ra !== undefined && rk !== undefined && ra > rk };
        break;
      }
      case 'power_supply':
        results[part.id] = { on: supplyOn };
        break;
      case 'xiao_esp32c3':
        results[part.id] = { on: true, gpio: { ...((inputs.gpio && inputs.gpio[part.id]) || {}) } };
        break;
      default:
        break;
    }
  }

  return { netLevel: levels, parts: results, notes };
}

// ---------------------------------------------------------------------------
// Stepper rotor
// ---------------------------------------------------------------------------

function seqIndexOf(coils) {
  if (!Array.isArray(coils)) return -1;
  return STEPPER_SEQUENCE.findIndex((seq) => seq.every((v, i) => !!v === !!coils[i]));
}
const normAngle = (a) => ((a % 360) + 360) % 360;

/**
 * Advance the rotor: stepIndex moves ±1 when the coil pattern moves to the next /
 * previous STEPPER_SEQUENCE entry; rotorAngle moves ±11.25°. `prev` is the previous
 * stepper result ({stepIndex, rotorAngle, seqIndex?|coils?}) or null.
 */
export function advanceStepper(prev, coils) {
  const stepIndex = prev && Number.isFinite(prev.stepIndex) ? prev.stepIndex : 0;
  const rotorAngle = prev && Number.isFinite(prev.rotorAngle) ? prev.rotorAngle : 0;
  const idx = seqIndexOf(coils);
  let prevSeq = null;
  if (prev) {
    if (Number.isInteger(prev.seqIndex)) prevSeq = prev.seqIndex;
    else if (Array.isArray(prev.coils) && seqIndexOf(prev.coils) >= 0) prevSeq = seqIndexOf(prev.coils);
    else if (Number.isFinite(prev.stepIndex)) prevSeq = ((prev.stepIndex % 4) + 4) % 4;
  }
  if (idx < 0) return { stepIndex, rotorAngle, seqIndex: prevSeq };
  if (prevSeq === null) return { stepIndex, rotorAngle, seqIndex: idx };
  if (idx === (prevSeq + 1) % 4) return { stepIndex: stepIndex + 1, rotorAngle: normAngle(rotorAngle + STEPPER_DEG_PER_STEP), seqIndex: idx };
  if (idx === (prevSeq + 3) % 4) return { stepIndex: stepIndex - 1, rotorAngle: normAngle(rotorAngle - STEPPER_DEG_PER_STEP), seqIndex: idx };
  return { stepIndex, rotorAngle, seqIndex: idx };
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

export function makeScript(kind, opts = {}) {
  switch (kind) {
    case 'stepperCW':
    case 'stepperCCW': {
      const steps = Math.max(1, Math.round(opts.steps ?? 8));
      const stepMs = Math.max(1, Number(opts.stepMs ?? 150));
      return { kind, steps, stepMs, durationMs: steps * stepMs, label: kind === 'stepperCW' ? 'Stepper CW' : 'Stepper CCW' };
    }
    case 'magnetPulse': {
      const ms = Math.max(1, Number(opts.ms ?? 500));
      return { kind, ms, durationMs: ms, label: 'Magnet pulse' };
    }
    case 'servoSweep': {
      const ms = Math.max(1, Number(opts.ms ?? 2000));
      return { kind, ms, durationMs: ms, label: 'Servo sweep' };
    }
    default:
      throw new Error(`Unknown script kind: ${kind}`);
  }
}

const pinMapCache = new WeakMap();

/**
 * Which XIAO GPIOs the scripts should drive, derived from the project's netlist:
 *  - steppers: per ULN2003, the GPIO sharing a net with IN1..IN4
 *  - magnet: the GPIO whose net reaches a MOSFET gate through one resistor (or directly); fallback D0
 */
export function scriptPinMap(project) {
  if (project && typeof project === 'object' && pinMapCache.has(project)) return pinMapCache.get(project);
  const parts = (project && project.parts) || [];
  const board = makeBoard(project && project.board);
  const netlist = buildNetlist(project, board);
  const netOfPin = (partId, pin) => netlist.netOf.get(pinNodeId(partId, pin)) || null;
  const gpioOn = (net) => (net ? net.pins.find((p) => p.role === 'gpio' && p.partType === 'xiao_esp32c3') : null);

  const steppers = parts
    .filter((p) => p.type === 'uln2003')
    .map((u) => ({
      drvId: u.id,
      pins: [1, 2, 3, 4].map((i) => {
        const g = gpioOn(netOfPin(u.id, `IN${i}`));
        return g ? { xiaoId: g.partId, pin: g.pin } : null;
      }),
    }));

  let magnet = null;
  const gates = new Set(parts.filter((p) => p.type === 'mosfet_n').map((q) => netOfPin(q.id, 'G')).filter(Boolean));
  const resistors = parts.filter((p) => p.type === 'resistor').map((r) => [netOfPin(r.id, '1'), netOfPin(r.id, '2')]);
  outer: for (const u of parts.filter((p) => p.type === 'xiao_esp32c3')) {
    for (const pin of XIAO_GPIO_PINS) {
      const net = netOfPin(u.id, pin);
      if (!net) continue;
      if (gates.has(net)) { magnet = { xiaoId: u.id, pin }; break outer; }
      for (const [a, b] of resistors) {
        const other = a === net ? b : b === net ? a : null;
        if (other && gates.has(other)) { magnet = { xiaoId: u.id, pin }; break outer; }
      }
    }
  }
  if (!magnet) {
    const ids = xiaoIds(project);
    if (ids.length) magnet = { xiaoId: ids[0], pin: 'D0' };
  }
  const map = { steppers, magnet };
  if (project && typeof project === 'object') pinMapCache.set(project, map);
  return map;
}

/**
 * Inputs at time tMs into a script, derived from `base` inputs.
 * @returns {{ inputs: object, done: boolean }}
 */
export function scriptInputsAt(script, base, project, tMs) {
  const inputs = cloneInputs(base || defaultInputs(project), project);
  const t = Math.max(0, Number(tMs) || 0);
  if (!script) return { inputs, done: true };
  const map = scriptPinMap(project);
  const setGpio = (ref, value) => {
    if (!ref) return;
    if (!inputs.gpio[ref.xiaoId]) inputs.gpio[ref.xiaoId] = {};
    inputs.gpio[ref.xiaoId][ref.pin] = !!value;
  };
  switch (script.kind) {
    case 'stepperCW':
    case 'stepperCCW': {
      const frame = Math.floor(t / script.stepMs);
      const done = frame >= script.steps;
      const dir = script.kind === 'stepperCW' ? 1 : -1;
      const seqIdx = (((frame * dir) % 4) + 4) % 4;
      const pattern = done ? [0, 0, 0, 0] : STEPPER_SEQUENCE[seqIdx]; // firmware de-energizes when the move completes
      for (const drv of map.steppers) drv.pins.forEach((ref, i) => setGpio(ref, pattern[i]));
      return { inputs, done };
    }
    case 'magnetPulse': {
      const on = t < script.ms;
      setGpio(map.magnet, on);
      return { inputs, done: !on };
    }
    case 'servoSweep': {
      const done = t >= script.ms;
      if (!done) {
        const half = script.ms / 2;
        const angle = t < half ? (180 * t) / half : 180 * (1 - (t - half) / half);
        const a = Math.max(0, Math.min(180, angle));
        for (const id of Object.keys(inputs.servoAngle)) inputs.servoAngle[id] = a;
      }
      return { inputs, done };
    }
    default:
      return { inputs, done: true };
  }
}
