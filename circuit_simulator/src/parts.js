// parts.js — part library, pin resolution, placement validation, id helpers.
// Pure JS, no DOM. All geometry is in grid units (1 = 0.1" hole pitch).

export const WIRE_COLORS = ['red', 'black', 'blue', 'green', 'yellow', 'orange', 'white', 'purple', 'brown', 'grey'];

export const PART_ORDER = [
  'xiao_esp32c3',
  'resistor',
  'diode',
  'capacitor',
  'mosfet_n',
  'uln2003',
  'stepper_28byj48',
  'servo',
  'electromagnet',
  'power_supply',
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function normRot(rot) {
  const r = Number(rot) || 0;
  return ((Math.round(r / 90) * 90) % 360 + 360) % 360;
}

/**
 * Rotate an offset about the origin. Returns an array `[x, y]` that also carries
 * `.x`/`.y` (and `.dx`/`.dy`) so both `const [x,y] = …` and `const {x,y} = …` work.
 *   0→(dx,dy), 90→(−dy,dx), 180→(−dx,−dy), 270→(dy,−dx)
 */
export function rotateOffset(dx, dy, rot) {
  const r = normRot(rot);
  let x = dx;
  let y = dy;
  if (r === 90) { x = -dy; y = dx; }
  else if (r === 180) { x = -dx; y = -dy; }
  else if (r === 270) { x = dy; y = -dx; }
  // avoid -0
  x = x === 0 ? 0 : x;
  y = y === 0 ? 0 : y;
  const out = [x, y];
  out.x = x; out.y = y; out.dx = x; out.dy = y;
  return out;
}

export function pinNodeId(partId, pin) {
  return `p:${partId}:${pin}`;
}

/**
 * Parse an opaque node id. Pin names may contain ':'-free punctuation such as
 * '+', '-', 'V+'; the id is split on the first two colons only.
 *   'h:c5'      → { kind:'hole', id, row:'c', col:5, hole:'c5' }
 *   'r:tp:3'    → { kind:'rail', id, rail:'tp', col:3 }
 *   'p:DRV1:+'  → { kind:'pin',  id, partId:'DRV1', pin:'+' }
 */
export function parseNodeId(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('h:')) {
    const hole = id.slice(2);
    const m = /^([a-t])(\d+)$/.exec(hole);
    if (!m) return null;
    return { kind: 'hole', id, row: m[1], col: Number(m[2]), hole };
  }
  if (id.startsWith('r:')) {
    const i = id.indexOf(':', 2);
    if (i < 0) return null;
    const rail = id.slice(2, i);
    const col = Number(id.slice(i + 1));
    if (!rail || !Number.isFinite(col)) return null;
    return { kind: 'rail', id, rail, col };
  }
  if (id.startsWith('p:')) {
    const i = id.indexOf(':', 2);
    if (i < 0) return null;
    const partId = id.slice(2, i);
    const pin = id.slice(i + 1);
    if (!partId || !pin) return null;
    return { kind: 'pin', id, partId, pin };
  }
  return null;
}

export function isHoleNode(id) {
  return typeof id === 'string' && (id.startsWith('h:') || id.startsWith('r:'));
}

/** Parse a resistor value string to ohms: '220Ω', '220R', '10k', '10kΩ', '4k7', '1M'. */
export function parseOhms(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.replace(/[Ωω]|ohms?/gi, '').replace(/\s+/g, '').replace(/R$/i, '');
  let m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(s);
  if (m) {
    const n = parseFloat(m[1]);
    const mult = m[2] === 'k' || m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : m[2] === 'm' ? 1e6 : 1;
    return n * mult;
  }
  m = /^(\d+)([kKmM])(\d+)$/.exec(s); // 4k7 style
  if (m) {
    const mult = m[2].toLowerCase() === 'k' ? 1e3 : 1e6;
    return parseFloat(`${m[1]}.${m[3]}`) * mult;
  }
  return null;
}

function clampSpan(v, def = 4) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(10, Math.max(2, n));
}

// ---------------------------------------------------------------------------
// Part library (§3 of the plan — exact pin names/orders/offsets)
// ---------------------------------------------------------------------------

const XIAO_TOP = [
  { name: '5V', role: 'power', volts: 5, source: true, aka: ['VBUS'] },
  { name: 'GND', role: 'gnd', required: 'error', source: true },
  { name: '3V3', role: 'power', volts: 3.3, source: true, aka: ['500 mA'] },
  { name: 'D10', role: 'gpio', gpio: 10, aka: ['MOSI'] },
  { name: 'D9', role: 'gpio', gpio: 9, strapping: true, aka: ['MISO', 'BOOT'] },
  { name: 'D8', role: 'gpio', gpio: 8, strapping: true, aka: ['SCK'] },
  { name: 'D7', role: 'gpio', gpio: 20, aka: ['RX'] },
];
const XIAO_BOTTOM = [
  { name: 'D0', role: 'gpio', gpio: 2, strapping: true, aka: ['A0'] },
  { name: 'D1', role: 'gpio', gpio: 3, aka: ['A1'] },
  { name: 'D2', role: 'gpio', gpio: 4, aka: ['A2'] },
  { name: 'D3', role: 'gpio', gpio: 5, aka: ['A3'] },
  { name: 'D4', role: 'gpio', gpio: 6, aka: ['SDA'] },
  { name: 'D5', role: 'gpio', gpio: 7, aka: ['SCL'] },
  { name: 'D6', role: 'gpio', gpio: 21, aka: ['TX'] },
];

export const XIAO_GPIO_PINS = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10'];

export const MOSFET_PACKAGES = {
  'TO-220': { order: ['G', 'D', 'S'], partNumber: 'IRLZ44N', body: { x: -0.5, y: -1.7, w: 3, h: 1.5 } },
  'TO-92': { order: ['S', 'G', 'D'], partNumber: '2N7000', body: { x: -0.5, y: -1.3, w: 3, h: 1.1 } },
};
const MOSFET_ROLE = { G: 'gate', D: 'drain', S: 'source' };
const MOSFET_LABEL = { G: 'G', D: 'D', S: 'S' };

export const PART_LIBRARY = {
  xiao_esp32c3: {
    type: 'xiao_esp32c3',
    name: 'XIAO ESP32C3',
    refPrefix: 'U',
    mount: 'through',
    visual: { kind: 'xiao', usb: 'left', usbStub: { x: -1.5, y: 2.3, w: 0.9, h: 1.4 } },
    props: { label: 'XIAO ESP32C3' },
    pins() {
      const out = [];
      XIAO_TOP.forEach((p, i) => out.push({ ...p, label: p.name, dx: i, dy: 0 }));
      XIAO_BOTTOM.forEach((p, i) => out.push({ ...p, label: p.name, dx: i, dy: 6 }));
      // Underside battery pads: off-grid terminals (never union with holes).
      out.push({ name: 'BAT+', label: 'BAT+', role: 'battery', dx: 2.5, dy: 3, offGrid: true });
      out.push({ name: 'BAT-', label: 'BAT−', role: 'battery', dx: 4.5, dy: 3, offGrid: true });
      return out;
    },
    body() {
      return { x: -0.63, y: -0.5, w: 8.26, h: 7 };
    },
    internal: [['BAT-', 'GND']],
    bom() {
      return 'Seeed Studio XIAO ESP32C3';
    },
  },

  resistor: {
    type: 'resistor',
    name: 'Resistor',
    refPrefix: 'R',
    mount: 'through',
    visual: { kind: 'resistor' },
    props: { value: '220Ω', span: 4 },
    pins(props) {
      const span = clampSpan(props.span, 4);
      return [
        { name: '1', label: '1', role: 'passive', dx: 0, dy: 0 },
        { name: '2', label: '2', role: 'passive', dx: span, dy: 0 },
      ];
    },
    body(props) {
      const span = clampSpan(props.span, 4);
      return { x: 0.6, y: -0.35, w: Math.max(0.8, span - 1.2), h: 0.7 };
    },
    bom(props) {
      return `Resistor ${props.value}`;
    },
  },

  diode: {
    type: 'diode',
    name: 'Diode',
    refPrefix: 'D',
    mount: 'through',
    visual: { kind: 'diode', bandAt: 'K' },
    props: { value: '1N4007', span: 4 },
    pins(props) {
      const span = clampSpan(props.span, 4);
      return [
        { name: 'A', label: 'A', role: 'anode', dx: 0, dy: 0 },
        { name: 'K', label: 'K', role: 'cathode', dx: span, dy: 0 },
      ];
    },
    body(props) {
      const span = clampSpan(props.span, 4);
      return { x: 0.6, y: -0.35, w: Math.max(0.8, span - 1.2), h: 0.7 };
    },
    bom(props) {
      return `Diode ${props.value}`;
    },
  },

  capacitor: {
    type: 'capacitor',
    name: 'Capacitor',
    refPrefix: 'C',
    mount: 'through',
    visual: { kind: 'capacitor' },
    props: { value: '100µF', span: 2, polarized: false },
    pins(props) {
      const span = clampSpan(props.span, 2);
      const pol = !!props.polarized;
      return [
        { name: '1', label: pol ? '+' : '1', role: 'passive', dx: 0, dy: 0 },
        { name: '2', label: pol ? '−' : '2', role: 'passive', dx: span, dy: 0 },
      ];
    },
    body(props) {
      const span = clampSpan(props.span, 2);
      return { x: span / 2 - 0.6, y: -1.5, w: 1.2, h: 1.2 };
    },
    bom(props) {
      return `Capacitor ${props.value}${props.polarized ? ' (polarized)' : ''}`;
    },
  },

  mosfet_n: {
    type: 'mosfet_n',
    name: 'N-MOSFET',
    refPrefix: 'Q',
    mount: 'through',
    visual: { kind: 'mosfet' },
    props: { package: 'TO-220', partNumber: 'IRLZ44N' },
    packages: MOSFET_PACKAGES,
    pins(props) {
      const pkg = MOSFET_PACKAGES[props.package] || MOSFET_PACKAGES['TO-220'];
      return pkg.order.map((n, i) => ({
        name: n,
        label: MOSFET_LABEL[n],
        role: MOSFET_ROLE[n],
        dx: i,
        dy: 0,
        required: 'error',
      }));
    },
    body(props) {
      const pkg = MOSFET_PACKAGES[props.package] || MOSFET_PACKAGES['TO-220'];
      return { ...pkg.body };
    },
    bom(props) {
      return `N-MOSFET ${props.partNumber || ''} (${props.package})`.replace('  ', ' ');
    },
  },

  uln2003: {
    type: 'uln2003',
    name: 'ULN2003 driver',
    refPrefix: 'DRV',
    mount: 'bench',
    visual: { kind: 'uln2003' },
    size: { w: 8, h: 7 },
    props: { jumper: true },
    terminals: [
      { name: 'IN1', label: 'IN1', role: 'input', tx: 1, ty: 7, required: 'cond', edge: 'bottom' },
      { name: 'IN2', label: 'IN2', role: 'input', tx: 2, ty: 7, required: 'cond', edge: 'bottom' },
      { name: 'IN3', label: 'IN3', role: 'input', tx: 3, ty: 7, required: 'cond', edge: 'bottom' },
      { name: 'IN4', label: 'IN4', role: 'input', tx: 4, ty: 7, required: 'cond', edge: 'bottom' },
      { name: '-', label: '−', role: 'gnd', tx: 5.5, ty: 7, required: 'error', edge: 'bottom' },
      { name: '+', label: '+ (5–12V)', role: 'power_in', tx: 6.5, ty: 7, required: 'error', edge: 'bottom' },
      {
        name: 'SOCKET',
        label: 'Motor socket',
        role: 'connector',
        tx: 8,
        ty: 3.5,
        edge: 'right',
        connector: ['COM', 'OUT4', 'OUT3', 'OUT2', 'OUT1'],
      },
    ],
    hiddenPins: [
      { name: 'COM', label: 'COM', role: 'common' },
      { name: 'OUT1', label: 'OUT1', role: 'output', netName: 'OUT1' },
      { name: 'OUT2', label: 'OUT2', role: 'output', netName: 'OUT2' },
      { name: 'OUT3', label: 'OUT3', role: 'output', netName: 'OUT3' },
      { name: 'OUT4', label: 'OUT4', role: 'output', netName: 'OUT4' },
    ],
    switches: [{ prop: 'jumper', label: 'COM ↔ + jumper', default: true, connects: ['+', 'COM'] }],
    indicators: [
      { id: 'LED_A', pin: 'OUT1' },
      { id: 'LED_B', pin: 'OUT2' },
      { id: 'LED_C', pin: 'OUT3' },
      { id: 'LED_D', pin: 'OUT4' },
    ],
    bom() {
      return 'ULN2003 stepper driver module';
    },
  },

  stepper_28byj48: {
    type: 'stepper_28byj48',
    name: '28BYJ-48 stepper',
    refPrefix: 'M',
    mount: 'bench',
    visual: { kind: 'stepper', rotor: { cx: 3, cy: 3, r: 2 } },
    size: { w: 6, h: 6 },
    props: {},
    terminals: [
      {
        name: 'PLUG',
        label: '5-pin plug',
        role: 'connector',
        tx: 0,
        ty: 3.5,
        edge: 'left',
        connector: ['RED', 'ORANGE', 'YELLOW', 'PINK', 'BLUE'],
      },
    ],
    hiddenPins: [
      { name: 'RED', label: 'red (COM)', role: 'common' },
      { name: 'ORANGE', label: 'orange', role: 'coil' },
      { name: 'YELLOW', label: 'yellow', role: 'coil' },
      { name: 'PINK', label: 'pink', role: 'coil' },
      { name: 'BLUE', label: 'blue', role: 'coil' },
    ],
    coils: [
      { color: 'BLUE', in: 'IN1' },
      { color: 'PINK', in: 'IN2' },
      { color: 'YELLOW', in: 'IN3' },
      { color: 'ORANGE', in: 'IN4' },
    ],
    common: 'RED',
    degPerStep: 11.25,
    bom() {
      return '28BYJ-48 5V stepper motor';
    },
  },

  servo: {
    type: 'servo',
    name: 'Servo',
    refPrefix: 'SV',
    mount: 'bench',
    visual: { kind: 'servo', horn: { cx: 3, cy: 2.6, r: 1.1 } },
    size: { w: 6, h: 4 },
    props: {},
    terminals: [
      { name: 'SIG', label: 'SIG', role: 'signal', tx: 1, ty: 0, required: 'error', edge: 'top' },
      { name: 'VCC', label: 'VCC', role: 'power_in', tx: 2, ty: 0, required: 'error', edge: 'top' },
      { name: 'GND', label: 'GND', role: 'gnd', tx: 3, ty: 0, required: 'error', edge: 'top' },
    ],
    bom() {
      return 'Hobby servo (SG90 / MG90S)';
    },
  },

  electromagnet: {
    type: 'electromagnet',
    name: 'Electromagnet',
    refPrefix: 'L',
    mount: 'bench',
    visual: { kind: 'electromagnet' },
    size: { w: 4, h: 4 },
    props: {},
    terminals: [
      { name: '1', label: '1', role: 'lead', tx: 1, ty: 0, required: 'warn', edge: 'top' },
      { name: '2', label: '2', role: 'lead', tx: 3, ty: 0, required: 'warn', edge: 'top' },
    ],
    bom() {
      return '5V electromagnet';
    },
  },

  power_supply: {
    type: 'power_supply',
    name: 'Power supply',
    refPrefix: 'PS',
    mount: 'bench',
    visual: { kind: 'power_supply' },
    size: { w: 5, h: 4 },
    props: { voltage: 5, label: '5V 2A supply' },
    terminals: [
      { name: 'GND', label: 'GND', role: 'gnd', tx: 0, ty: 1, source: true, edge: 'left' },
      {
        name: 'V+',
        label: 'V+',
        role: 'supply',
        tx: 0,
        ty: 3,
        source: true,
        edge: 'left',
        volts: (props) => Number(props.voltage) || 5,
      },
    ],
    bom(props) {
      return `${props.voltage}V power supply`;
    },
  },
};

export function partDef(type) {
  return PART_LIBRARY[type] || null;
}

export function partProps(part) {
  const def = partDef(part.type);
  return { ...(def ? def.props : {}), ...(part.props || {}) };
}

// ---------------------------------------------------------------------------
// Pin resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a placed part's pins/terminals to absolute grid coordinates + node ids.
 * Through-hole parts: every pin has x,y (ints) and through:true unless offGrid.
 * Bench parts: terminals have through:false and absolute x,y (at + rotated (tx,ty));
 * hidden pins have hidden:true and no x/y.
 */
export function resolvePins(part) {
  const def = partDef(part.type);
  if (!def) return [];
  const props = partProps(part);
  const rot = normRot(part.rot);
  const at = part.at || { x: 0, y: 0 };
  const out = [];
  if (def.mount === 'through') {
    for (const p of def.pins(props)) {
      const o = rotateOffset(p.dx, p.dy, rot);
      out.push({
        ...p,
        label: p.label ?? p.name,
        nodeId: pinNodeId(part.id, p.name),
        through: !p.offGrid,
        offGrid: !!p.offGrid,
        x: at.x + o.x,
        y: at.y + o.y,
      });
    }
    return out;
  }
  for (const t of def.terminals || []) {
    const o = rotateOffset(t.tx, t.ty, rot);
    const volts = typeof t.volts === 'function' ? t.volts(props) : t.volts;
    const rec = {
      ...t,
      label: t.label ?? t.name,
      nodeId: pinNodeId(part.id, t.name),
      through: false,
      x: at.x + o.x,
      y: at.y + o.y,
    };
    if (volts !== undefined) rec.volts = volts;
    else delete rec.volts;
    if (t.connector) rec.connector = t.connector.slice();
    out.push(rec);
  }
  for (const h of def.hiddenPins || []) {
    out.push({ ...h, label: h.label ?? h.name, nodeId: pinNodeId(part.id, h.name), through: false, hidden: true });
  }
  return out;
}

/** Map of holeId -> { partId, pin } for all through pins of the given parts. */
export function occupancyMap(parts, board) {
  const occ = new Map();
  for (const part of parts || []) {
    const def = partDef(part.type);
    if (!def || def.mount !== 'through') continue;
    for (const pin of resolvePins(part)) {
      if (!pin.through) continue;
      const hid = board.holeAt(pin.x, pin.y);
      if (!hid) continue;
      if (!occ.has(hid)) occ.set(hid, []);
      occ.get(hid).push({ partId: part.id, pin: pin.name });
    }
  }
  return occ;
}

/**
 * Validate a through-hole placement against the board and the other parts.
 * Bench parts are always ok.
 */
export function validatePlacement(part, board, otherParts = []) {
  const def = partDef(part.type);
  if (!def) return { ok: false, problems: [{ pin: null, code: 'offboard' }] };
  if (def.mount !== 'through') return { ok: true, problems: [] };
  const others = (otherParts || []).filter((p) => p && p.id !== part.id);
  const occ = occupancyMap(others, board);
  const problems = [];
  for (const pin of resolvePins(part)) {
    if (!pin.through) continue;
    const cls = board.classify(pin.x, pin.y);
    if (cls === 'offboard') {
      problems.push({ pin: pin.name, code: 'offboard', x: pin.x, y: pin.y });
      continue;
    }
    if (cls === 'channel') {
      problems.push({ pin: pin.name, code: 'channel', x: pin.x, y: pin.y });
      continue;
    }
    const holeId = board.holeAt(pin.x, pin.y);
    const occupants = occ.get(holeId);
    if (occupants && occupants.length) {
      problems.push({ pin: pin.name, code: 'overlap', holeId, x: pin.x, y: pin.y, with: occupants[0] });
    }
  }
  return { ok: problems.length === 0, problems };
}

/** def.internal pairs + closed switches, as [nodeId, nodeId] pairs. */
export function internalConnections(part) {
  const def = partDef(part.type);
  if (!def) return [];
  const props = partProps(part);
  const out = [];
  for (const [a, b] of def.internal || []) out.push([pinNodeId(part.id, a), pinNodeId(part.id, b)]);
  for (const sw of def.switches || []) {
    const v = props[sw.prop];
    const closed = v === undefined ? !!sw.default : !!v;
    if (closed) out.push([pinNodeId(part.id, sw.connects[0]), pinNodeId(part.id, sw.connects[1])]);
  }
  return out;
}

/** Ordered node ids behind a connector terminal (SOCKET / PLUG), or null. */
export function connectorPins(part, pinName) {
  const def = partDef(part.type);
  if (!def || !def.terminals) return null;
  const t = def.terminals.find((x) => x.name === pinName && Array.isArray(x.connector));
  if (!t) return null;
  return t.connector.map((n) => pinNodeId(part.id, n));
}

/** Index-wise pairs joining two connectors, or null when incompatible. */
export function expandPlug(partA, pinA, partB, pinB) {
  if (!partA || !partB) return null;
  const a = connectorPins(partA, pinA);
  const b = connectorPins(partB, pinB);
  if (!a || !b || a.length !== b.length || a.length === 0) return null;
  if (partA.id === partB.id) return null;
  return a.map((id, i) => [id, b[i]]);
}

/**
 * Find the connector a part's connector terminal is plugged into via a `plug` wire.
 * Returns { partId, pin, wireId } or null.
 */
export function findPlugPartner(project, partId, pinName) {
  const me = pinNodeId(partId, pinName);
  const parts = (project && project.parts) || [];
  const byId = new Map(parts.map((p) => [p.id, p]));
  const self = byId.get(partId);
  if (!self) return null;
  for (const w of (project && project.wires) || []) {
    if (w.kind !== 'plug') continue;
    let other = null;
    if (w.a === me) other = w.b;
    else if (w.b === me) other = w.a;
    else continue;
    const po = parseNodeId(other);
    if (!po || po.kind !== 'pin') continue;
    const op = byId.get(po.partId);
    if (!op) continue;
    if (expandPlug(self, pinName, op, po.pin)) return { partId: po.partId, pin: po.pin, wireId: w.id };
  }
  return null;
}

/** Lowest free `{prefix}{n}` id (n ≥ 1), e.g. nextRefId('R', parts) → 'R3'. */
export function nextRefId(prefix, parts) {
  const used = new Set((parts || []).map((p) => p.id));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Absolute body rectangle (grid units) after rotation about the anchor. */
export function bodyRect(part) {
  const def = partDef(part.type);
  if (!def) return { x: 0, y: 0, w: 0, h: 0 };
  const props = partProps(part);
  const at = part.at || { x: 0, y: 0 };
  const rel = def.mount === 'through' ? def.body(props) : { x: 0, y: 0, w: def.size.w, h: def.size.h };
  const corners = [
    [rel.x, rel.y],
    [rel.x + rel.w, rel.y],
    [rel.x, rel.y + rel.h],
    [rel.x + rel.w, rel.y + rel.h],
  ].map(([dx, dy]) => rotateOffset(dx, dy, part.rot));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: at.x + minX, y: at.y + minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/**
 * Nearest valid anchor for a through part dropped at (x,y): tries y, y−1, y+1, y−2, y+2
 * at the same x and returns the first fully valid anchor, or null.
 * `def` may be a definition object or a type string. `excludeId` (optional) is the id of
 * the part being moved so it does not collide with itself.
 */
export function suggestAnchor(def, props, rot, x, y, board, parts, excludeId = null) {
  const d = typeof def === 'string' ? partDef(def) : def;
  if (!d) return null;
  const rx = Math.round(x);
  const ry = Math.round(y);
  if (d.mount !== 'through') return { x: rx, y: ry };
  const others = (parts || []).filter((p) => p && p.id !== excludeId);
  for (const dy of [0, -1, 1, -2, 2]) {
    const cand = { x: rx, y: ry + dy };
    const ghost = { id: excludeId || '__ghost__', type: d.type, at: cand, rot: normRot(rot), props: props || {} };
    if (validatePlacement(ghost, board, others).ok) return cand;
  }
  return null;
}
