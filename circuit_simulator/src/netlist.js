// netlist.js — union-find connectivity + net naming. Pure JS, no DOM.

import {
  resolvePins,
  internalConnections,
  expandPlug,
  parseNodeId,
  isHoleNode,
} from './parts.js';

export class UnionFind {
  constructor() {
    this.parent = new Map();
    this.order = [];
  }
  add(id) {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      this.order.push(id);
    }
    return id;
  }
  has(id) {
    return this.parent.has(id);
  }
  find(a) {
    if (!this.parent.has(a)) return undefined;
    let root = a;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // path compression
    let cur = a;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
    return ra;
  }
  connected(a, b) {
    return this.has(a) && this.has(b) && this.find(a) === this.find(b);
  }
  /** Map<root, id[]> in first-seen order. */
  groups() {
    const m = new Map();
    for (const id of this.order) {
      const r = this.find(id);
      if (!m.has(r)) m.set(r, []);
      m.get(r).push(id);
    }
    return m;
  }
}

// Naming priority among "non-passive" roles when no power/gpio name applies.
const ROLE_PRIORITY = [
  'gate', 'drain', 'source',
  'signal', 'input', 'output',
  'anode', 'cathode',
  'lead', 'power_in', 'common', 'coil', 'battery', 'connector',
  'passive',
];
const rolePriority = (role) => {
  const i = ROLE_PRIORITY.indexOf(role);
  return i < 0 ? ROLE_PRIORITY.length : i;
};

function powerTagOf(pin) {
  if (pin.role === 'gnd') return 'GND';
  if (pin.role === 'power' || pin.role === 'supply') {
    const v = Number(pin.volts);
    if (Math.abs(v - 5) < 1e-6) return '5V';
    if (Math.abs(v - 3.3) < 1e-6) return '3V3';
    return pin.role === 'supply' ? 'V+' : `${v}V`;
  }
  return null;
}

/**
 * Build the netlist for a project on a board.
 * Returns { nets, netOf, byName, dangling, pinInfo }.
 */
export function buildNetlist(project, board) {
  const parts = (project && project.parts) || [];
  const wires = (project && project.wires) || [];
  const bridges = (project && project.bridges) || [];
  const uf = new UnionFind();

  // 1. holes, 2. strips & rails
  for (const h of board.holes) uf.add(h.id);
  for (const s of board.strips()) {
    for (let i = 1; i < s.members.length; i++) uf.union(s.members[0], s.members[i]);
  }

  // 3. pins (+ pin↔hole for through pins on real holes), 4. internal connections
  const pinInfo = new Map();
  const partById = new Map();
  for (const part of parts) {
    partById.set(part.id, part);
    for (const pin of resolvePins(part)) {
      uf.add(pin.nodeId);
      const rec = {
        nodeId: pin.nodeId,
        partId: part.id,
        partType: part.type,
        pin: pin.name,
        label: pin.label,
        role: pin.role,
        hidden: !!pin.hidden,
        through: !!pin.through,
        holeId: null,
      };
      if (pin.volts !== undefined) rec.volts = pin.volts;
      if (pin.strapping) rec.strapping = true;
      if (pin.required) rec.required = pin.required;
      if (pin.source) rec.source = true;
      if (pin.netName) rec.netName = pin.netName;
      if (pin.x !== undefined) { rec.x = pin.x; rec.y = pin.y; }
      pinInfo.set(pin.nodeId, rec);
      if (pin.through && !pin.hidden) {
        const hid = board.holeAt(pin.x, pin.y);
        if (hid) {
          uf.union(pin.nodeId, hid);
          rec.holeId = hid;
        }
      }
    }
    for (const [a, b] of internalConnections(part)) uf.union(a, b);
  }

  // 5. wires
  const dangling = [];
  for (const w of wires) {
    if (w.kind === 'plug') {
      const pa = parseNodeId(w.a);
      const pb = parseNodeId(w.b);
      const partA = pa && pa.kind === 'pin' ? partById.get(pa.partId) : null;
      const partB = pb && pb.kind === 'pin' ? partById.get(pb.partId) : null;
      const pairs = partA && partB ? expandPlug(partA, pa.pin, partB, pb.pin) : null;
      if (!pairs) {
        dangling.push(w.id);
        continue;
      }
      for (const [a, b] of pairs) uf.union(a, b);
    } else if (uf.has(w.a) && uf.has(w.b)) {
      uf.union(w.a, w.b);
    } else {
      dangling.push(w.id);
    }
  }

  // 6. bridges
  for (const b of bridges) {
    if (uf.has(b.a) && uf.has(b.b)) uf.union(b.a, b.b);
    else dangling.push(b.id);
  }

  // 7. group → nets
  const xiaoCount = parts.filter((p) => p.type === 'xiao_esp32c3').length;
  const nets = [];
  const netOf = new Map();
  const byName = new Map();
  let idx = 0;
  for (const [, members] of uf.groups()) {
    const holes = [];
    const pins = [];
    for (const m of members) {
      if (isHoleNode(m)) holes.push(m);
      else if (pinInfo.has(m)) pins.push(pinInfo.get(m));
    }
    const roles = new Set(pins.map((p) => p.role));
    const powerTags = new Set();
    for (const p of pins) {
      const t = powerTagOf(p);
      if (t) powerTags.add(t);
    }

    let kind = 'other';
    if (powerTags.size > 1) kind = 'conflict';
    else if (powerTags.has('GND')) kind = 'gnd';
    else if (powerTags.size === 1) kind = 'power';
    else if (roles.has('gpio')) kind = 'gpio';
    else if (pins.some((p) => p.role !== 'passive' && p.role !== 'connector')) kind = 'signal';

    const net = {
      id: `n${idx}`,
      name: '',
      members: members.slice(),
      holes,
      pins,
      roles,
      kind,
      powerTags,
    };
    net.name = nameNet(net, idx, xiaoCount);
    nets.push(net);
    for (const m of members) netOf.set(m, net);
    if (!byName.has(net.name)) byName.set(net.name, []);
    byName.get(net.name).push(net);
    idx++;
  }

  return { nets, netOf, byName, dangling, pinInfo };
}

function nameNet(net, idx, xiaoCount) {
  const { pins } = net;
  if (pins.some((p) => p.role === 'gnd')) return 'GND';
  const supply = pins.find((p) => p.role === 'supply');
  if (supply) return powerTagOf(supply) === '5V' ? '5V' : 'V+';
  const power = pins.find((p) => p.role === 'power');
  if (power) {
    const tag = powerTagOf(power);
    return xiaoCount > 1 ? `${power.partId}.${tag}` : tag;
  }
  const gpio = pins.find((p) => p.role === 'gpio');
  if (gpio) return xiaoCount > 1 ? `${gpio.partId}.${gpio.pin}` : gpio.pin;
  const hinted = pins.find((p) => p.netName);
  if (hinted) return hinted.netName;
  const sorted = pins
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rolePriority(a.p.role) - rolePriority(b.p.role) || a.i - b.i);
  if (sorted.length) return `${sorted[0].p.partId}.${sorted[0].p.pin}`;
  return `N${idx}`;
}
