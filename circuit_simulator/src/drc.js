// drc.js — design-rule checks over a project + board + netlist. Pure JS, no DOM.

import {
  partDef,
  partProps,
  pinNodeId,
  parseNodeId,
  resolvePins,
  validatePlacement,
  occupancyMap,
  findPlugPartner,
  isHoleNode,
} from './parts.js';

export const DRC_CODES = {
  PIN_OFFBOARD: { severity: 'error', title: 'Pin off the board' },
  PIN_CHANNEL: { severity: 'error', title: 'Pin in the channel' },
  PIN_OVERLAP: { severity: 'error', title: 'Two pins in one hole' },
  POWER_SHORT: { severity: 'error', title: 'Power short' },
  FLYBACK_REVERSED: { severity: 'error', title: 'Flyback diode reversed' },
  FLOATING_REQUIRED_PIN: { severity: 'error', title: 'Required pin not connected' }, // per pin: error|warn
  MAGNET_NO_FLYBACK: { severity: 'warn', title: 'No flyback diode' },
  GATE_NO_SERIES_R: { severity: 'warn', title: 'Gate without series resistor' },
  GATE_NO_PULLDOWN: { severity: 'warn', title: 'Gate without pulldown' },
  GATE_UNDRIVEN: { severity: 'warn', title: 'Gate not driven by a GPIO' },
  ULN_PLUS_ON_3V3: { severity: 'warn', title: 'ULN2003 powered from 3V3' },
  SERVO_ON_3V3: { severity: 'warn', title: 'Servo powered from 3V3' },
  USB_CURRENT: { severity: 'warn', title: 'Too much load on USB 5V' },
  STEPPER_UNPLUGGED: { severity: 'warn', title: 'Stepper not plugged in' },
  ULN_JUMPER_OPEN: { severity: 'warn', title: 'ULN2003 COM jumper open' },
  DANGLING_WIRE: { severity: 'warn', title: 'Wire ends nowhere' },
  VBUS_TIED_TO_SUPPLY: { severity: 'info', title: 'XIAO 5V tied to external supply' },
  STRAPPING_PIN_LOAD: { severity: 'info', title: 'Load on a strapping pin' },
  HOLE_DOUBLE_BOOKED: { severity: 'info', title: 'Hole used twice' },
  UNCONNECTED_PART: { severity: 'info', title: 'Part not connected' },
};

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };
const CODE_ORDER = Object.keys(DRC_CODES);

const VCC_TAGS = ['5V', 'V+', '3V3'];
const isVccNet = (net) => !!net && VCC_TAGS.some((t) => net.powerTags.has(t)) ;
const isGndNet = (net) => !!net && net.powerTags.has('GND');

/** Run all design-rule checks. Returns issues sorted error → warn → info. */
export function runDrc(project, board, netlist) {
  const parts = (project && project.parts) || [];
  const wires = (project && project.wires) || [];
  const bridges = (project && project.bridges) || [];
  const issues = [];
  let seq = 0;
  const add = (code, message, refs = {}, severity = null) => {
    const def = DRC_CODES[code];
    issues.push({ id: `i${++seq}`, severity: severity || def.severity, code, message, refs });
  };

  const byId = new Map(parts.map((p) => [p.id, p]));
  const ofType = (t) => parts.filter((p) => p.type === t);
  const netOfNode = (nodeId) => netlist.netOf.get(nodeId) || null;
  const pinNet = (partId, pin) => netOfNode(pinNodeId(partId, pin));
  const otherPins = (net, partId) => (net ? net.pins.filter((p) => p.partId !== partId) : []);
  const pinsOfPart = new Map(parts.map((p) => [p.id, resolvePins(p)]));
  const pinRec = (partId, pin) => (pinsOfPart.get(partId) || []).find((p) => p.name === pin) || null;

  const roleWord = { gate: 'gate', drain: 'drain', source: 'source' };
  /** "Q1 gate (h12)" / "DRV1 IN1" / "U1 GND (c2)" */
  const pinLabel = (partId, pin) => {
    const rec = pinRec(partId, pin);
    const word = rec && roleWord[rec.role] ? roleWord[rec.role] : pin;
    let hole = null;
    if (rec && rec.through) hole = board.holeAt(rec.x, rec.y);
    return hole ? `${partId} ${word} (${board.label(hole)})` : `${partId} ${word}`;
  };
  const netLabel = (net) => (net ? `net ${net.name}` : 'nothing');
  const listPins = (pins) => pins.map((p) => (/^\d+$/.test(p.pin) ? `${p.partId} pin ${p.pin}` : `${p.partId} ${p.pin}`)).join(', ');

  // ------------------------------------------------------------------------
  // Placement: PIN_OFFBOARD / PIN_CHANNEL (per pin), PIN_OVERLAP (per hole)
  // ------------------------------------------------------------------------
  for (const part of parts) {
    const def = partDef(part.type);
    if (!def || def.mount !== 'through') continue;
    const { problems } = validatePlacement(part, board, []);
    for (const pr of problems) {
      if (pr.code === 'offboard') {
        add('PIN_OFFBOARD', `${part.id} pin ${pr.pin} lands off the board at column ${pr.x}, row ${pr.y}; move it onto the holes.`, {
          parts: [part.id],
          nodes: [pinNodeId(part.id, pr.pin)],
        });
      } else if (pr.code === 'channel') {
        add('PIN_CHANNEL', `${part.id} pin ${pr.pin} lands in the channel at column ${pr.x}, row ${pr.y} where there is no hole; move or rotate it.`, {
          parts: [part.id],
          nodes: [pinNodeId(part.id, pr.pin)],
        });
      }
    }
  }
  const occ = occupancyMap(parts, board);
  for (const [holeId, occupants] of occ) {
    if (occupants.length < 2) continue;
    const who = occupants.map((o) => pinLabel(o.partId, o.pin).replace(/ \(.*\)$/, '')).join(' and ');
    add('PIN_OVERLAP', `Hole ${board.label(holeId)} is used by both ${who}; only one lead fits per hole.`, {
      parts: [...new Set(occupants.map((o) => o.partId))],
      nodes: [holeId, ...occupants.map((o) => pinNodeId(o.partId, o.pin))],
    });
  }

  // ------------------------------------------------------------------------
  // POWER_SHORT — mixed power tags on one net
  // ------------------------------------------------------------------------
  for (const net of netlist.nets) {
    if (net.kind !== 'conflict') continue;
    const tags = [...net.powerTags].sort().join(' and ');
    const where = net.holes.slice(0, 3).map((h) => board.label(h));
    const drivers = net.pins.filter((p) => ['gnd', 'power', 'supply'].includes(p.role));
    add('POWER_SHORT', `Short circuit: ${tags} are joined on one net (${listPins(drivers)}${where.length ? `; holes ${where.join(', ')}` : ''}).`, {
      nets: [net.id],
      parts: [...new Set(drivers.map((p) => p.partId))],
    });
  }

  // ------------------------------------------------------------------------
  // FLOATING_REQUIRED_PIN
  // ------------------------------------------------------------------------
  const floatingParts = new Set();
  for (const part of parts) {
    const def = partDef(part.type);
    if (!def) continue;
    const plugged = part.type === 'uln2003' ? !!findPlugPartner(project, part.id, 'SOCKET') : false;
    for (const pin of pinsOfPart.get(part.id)) {
      if (!pin.required || pin.hidden) continue;
      let severity = pin.required;
      if (severity === 'cond') {
        if (!plugged) continue;
        severity = 'error';
      }
      const net = netOfNode(pin.nodeId);
      if (net && otherPins(net, part.id).length) continue;
      floatingParts.add(part.id);
      const extra = pin.required === 'cond'
        ? ' — a stepper is plugged into the socket, so all four inputs need a GPIO.'
        : pin.role === 'gnd' ? ' — it needs a wire to GND.'
        : pin.role === 'power_in' ? ' — it needs a wire to 5V.'
        : '.';
      add('FLOATING_REQUIRED_PIN', `${pinLabel(part.id, pin.name)} is not connected to anything${extra}`, {
        parts: [part.id],
        nodes: [pin.nodeId],
        nets: net ? [net.id] : [],
      }, severity === 'warn' ? 'warn' : 'error');
    }
  }

  // ------------------------------------------------------------------------
  // Electromagnet: FLYBACK_REVERSED / MAGNET_NO_FLYBACK
  // ------------------------------------------------------------------------
  const diodes = ofType('diode').map((d) => ({ part: d, na: pinNet(d.id, 'A'), nk: pinNet(d.id, 'K') }));
  for (const mag of ofType('electromagnet')) {
    const n1 = pinNet(mag.id, '1');
    const n2 = pinNet(mag.id, '2');
    if (!n1 || !n2 || n1 === n2) continue;
    if (!otherPins(n1, mag.id).length || !otherPins(n2, mag.id).length) continue; // floating → handled above
    const across = diodes.filter((d) => (d.na === n1 && d.nk === n2) || (d.na === n2 && d.nk === n1));
    if (!across.length) {
      add('MAGNET_NO_FLYBACK', `${mag.id} has no flyback diode across its leads (${netLabel(n1)} ↔ ${netLabel(n2)}); add a 1N4007 with the band (K) toward 5V.`, {
        parts: [mag.id],
        nets: [n1.id, n2.id],
      });
      continue;
    }
    for (const d of across) {
      if (isVccNet(d.na) && !isVccNet(d.nk)) {
        add('FLYBACK_REVERSED', `${d.part.id} is reversed: its anode (${pinLabel(d.part.id, 'A').replace(/^.*\(|\)$/g, '')}) sits on ${netLabel(d.na)} and its cathode on ${netLabel(d.nk)}, so it conducts whenever the supply is on. Flip it so the band (K) faces 5V.`, {
          parts: [d.part.id, mag.id],
          nets: [d.na.id, d.nk.id],
        });
      }
    }
  }

  // ------------------------------------------------------------------------
  // MOSFET gate checks
  // ------------------------------------------------------------------------
  const resistors = ofType('resistor').map((r) => ({ part: r, n1: pinNet(r.id, '1'), n2: pinNet(r.id, '2') }));
  for (const q of ofType('mosfet_n')) {
    const gate = pinNet(q.id, 'G');
    if (!gate || !otherPins(gate, q.id).length) continue; // floating → handled above
    const gpioOnGate = gate.pins.filter((p) => p.role === 'gpio');
    const rOnGate = resistors
      .filter((r) => r.n1 === gate || r.n2 === gate)
      .map((r) => ({ ...r, other: r.n1 === gate ? r.n2 : r.n1 }));
    const seriesR = rOnGate.filter((r) => r.other && r.other.pins.some((p) => p.role === 'gpio'));
    const pulldown = rOnGate.filter((r) => isGndNet(r.other));
    const otherDriver = gate.pins.some((p) => p.partId !== q.id && ['output', 'signal', 'drain'].includes(p.role));
    if (gpioOnGate.length) {
      add('GATE_NO_SERIES_R', `${pinLabel(q.id, 'G')} is driven directly by ${listPins(gpioOnGate)} without a series resistor (220 Ω recommended).`, {
        parts: [q.id, ...gpioOnGate.map((p) => p.partId)],
        nets: [gate.id],
      });
    } else if (!seriesR.length && !otherDriver) {
      add('GATE_UNDRIVEN', `${pinLabel(q.id, 'G')} is not driven by any GPIO, directly or through a series resistor.`, {
        parts: [q.id],
        nets: [gate.id],
      });
    }
    if (!pulldown.length) {
      add('GATE_NO_PULLDOWN', `${pinLabel(q.id, 'G')} has no pulldown to GND (a 10 kΩ resistor keeps the load off while the XIAO boots).`, {
        parts: [q.id],
        nets: [gate.id],
      });
    }
  }

  // ------------------------------------------------------------------------
  // ULN2003 checks
  // ------------------------------------------------------------------------
  for (const drv of ofType('uln2003')) {
    const props = partProps(drv);
    const plus = pinNet(drv.id, '+');
    if (plus && plus.powerTags.has('3V3')) {
      add('ULN_PLUS_ON_3V3', `${drv.id} + is on 3V3; the ULN2003 and the 28BYJ-48 need 5–12 V — move it to the 5V rail.`, {
        parts: [drv.id],
        nets: [plus.id],
      });
    }
    if (props.jumper === false) {
      const com = pinNet(drv.id, 'COM');
      if (!isVccNet(com)) {
        add('ULN_JUMPER_OPEN', `${drv.id} COM jumper is open, so the stepper common (red wire) gets no power; close the jumper or wire COM to 5V.`, {
          parts: [drv.id],
          nets: com ? [com.id] : [],
        });
      }
    }
  }

  // ------------------------------------------------------------------------
  // Servo on 3V3
  // ------------------------------------------------------------------------
  for (const sv of ofType('servo')) {
    const vcc = pinNet(sv.id, 'VCC');
    if (vcc && vcc.powerTags.has('3V3')) {
      add('SERVO_ON_3V3', `${sv.id} VCC is on 3V3; servos need 5 V and draw more than the 3V3 regulator can supply.`, {
        parts: [sv.id],
        nets: [vcc.id],
      });
    }
  }

  // ------------------------------------------------------------------------
  // USB_CURRENT — everything hangs off XIAO 5V with no external supply
  // ------------------------------------------------------------------------
  const supplyConnected = ofType('power_supply').some((ps) => {
    const vp = pinNet(ps.id, 'V+');
    return vp && otherPins(vp, ps.id).length > 0;
  });
  for (const u of ofType('xiao_esp32c3')) {
    if (supplyConnected) break;
    const vbus = pinNet(u.id, '5V');
    if (!vbus) continue;
    const loads = [];
    for (const p of vbus.pins) {
      if (p.partId === u.id) continue;
      if ((p.partType === 'servo' && p.pin === 'VCC') || (p.partType === 'uln2003' && p.pin === '+') || p.partType === 'electromagnet') {
        if (!loads.includes(p.partId)) loads.push(p.partId);
      }
    }
    if (loads.length >= 2) {
      add('USB_CURRENT', `${u.id} 5V (USB) is the only supply and feeds ${loads.join(', ')}; a USB port cannot deliver that much current — add an external 5 V supply.`, {
        parts: [u.id, ...loads],
        nets: [vbus.id],
      });
    }
  }

  // ------------------------------------------------------------------------
  // STEPPER_UNPLUGGED
  // ------------------------------------------------------------------------
  for (const m of ofType('stepper_28byj48')) {
    if (!findPlugPartner(project, m.id, 'PLUG')) {
      add('STEPPER_UNPLUGGED', `${m.id} is not plugged into a ULN2003 socket (use the wire tool from ${m.id} PLUG to the driver's SOCKET).`, {
        parts: [m.id],
        nodes: [pinNodeId(m.id, 'PLUG')],
      });
    }
  }

  // ------------------------------------------------------------------------
  // DANGLING_WIRE
  // ------------------------------------------------------------------------
  const wireById = new Map(wires.map((w) => [w.id, w]));
  const bridgeById = new Map(bridges.map((b) => [b.id, b]));
  for (const id of netlist.dangling || []) {
    const w = wireById.get(id) || bridgeById.get(id);
    if (!w) {
      add('DANGLING_WIRE', `${id} is dangling.`, { wires: [id] });
      continue;
    }
    const what = bridgeById.has(id) ? 'Bridge' : w.kind === 'plug' ? 'Plug' : 'Wire';
    if (w.kind === 'plug') {
      add('DANGLING_WIRE', `${what} ${id} from ${w.a} to ${w.b} does not join two matching connectors (a 5-pin PLUG must go to a 5-pin SOCKET).`, {
        wires: [id],
        nodes: [w.a, w.b],
      });
      continue;
    }
    const bad = [w.a, w.b].filter((n) => !netlist.netOf.has(n));
    add('DANGLING_WIRE', `${what} ${id} ends on ${bad.length ? bad.join(' and ') : `${w.a} / ${w.b}`}, which does not exist on this board or on any part.`, {
      wires: [id],
      nodes: bad,
    });
  }

  // ------------------------------------------------------------------------
  // VBUS_TIED_TO_SUPPLY / STRAPPING_PIN_LOAD
  // ------------------------------------------------------------------------
  for (const u of ofType('xiao_esp32c3')) {
    const vbus = pinNet(u.id, '5V');
    const supplies = vbus ? vbus.pins.filter((p) => p.role === 'supply') : [];
    if (supplies.length) {
      add('VBUS_TIED_TO_SUPPLY', `${u.id} 5V (VBUS) is tied to ${listPins(supplies)}; fine on the bench, but unplug USB while the external supply is on (or add a Schottky diode) so the two 5 V sources do not fight.`, {
        parts: [u.id, ...supplies.map((p) => p.partId)],
        nets: [vbus.id],
      });
    }
    for (const pin of pinsOfPart.get(u.id)) {
      if (!pin.strapping) continue;
      const net = netOfNode(pin.nodeId);
      const others = otherPins(net, u.id);
      if (!others.length) continue;
      const gpio = pin.gpio !== undefined ? ` (GPIO${pin.gpio})` : '';
      add('STRAPPING_PIN_LOAD', `${pin.name}${gpio} is a strapping pin; ${listPins(others)} on it may affect boot mode if the line is pulled at reset.`, {
        parts: [u.id, ...new Set(others.map((p) => p.partId))],
        nets: [net.id],
        nodes: [pin.nodeId],
      });
    }
  }

  // ------------------------------------------------------------------------
  // HOLE_DOUBLE_BOOKED — a hole with a pin plus a wire end, or two wire ends
  // ------------------------------------------------------------------------
  const bookings = new Map(); // holeId -> [{kind:'pin'|'wire', id, text}]
  const book = (holeId, entry) => {
    if (!bookings.has(holeId)) bookings.set(holeId, []);
    bookings.get(holeId).push(entry);
  };
  for (const [holeId, occupants] of occ) {
    if (occupants.length === 1) book(holeId, { kind: 'pin', id: occupants[0].partId, text: `${occupants[0].partId} pin ${occupants[0].pin}` });
  }
  const endpointHole = (nodeId) => {
    if (isHoleNode(nodeId)) return board.holeById(nodeId) ? nodeId : null;
    const p = parseNodeId(nodeId);
    if (!p || p.kind !== 'pin') return null;
    const rec = pinRec(p.partId, p.pin);
    return rec && rec.through ? board.holeAt(rec.x, rec.y) : null;
  };
  for (const w of wires) {
    if (w.kind === 'plug') continue;
    for (const end of [w.a, w.b]) {
      const h = endpointHole(end);
      if (h) book(h, { kind: 'wire', id: w.id, text: `wire ${w.id}` });
    }
  }
  for (const b of bridges) {
    for (const end of [b.a, b.b]) {
      const h = endpointHole(end);
      if (h) book(h, { kind: 'bridge', id: b.id, text: `bridge ${b.id}` });
    }
  }
  for (const [holeId, list] of bookings) {
    if (list.length < 2) continue;
    if (!list.some((e) => e.kind !== 'bridge')) continue; // two bridges meeting is fine
    add('HOLE_DOUBLE_BOOKED', `Hole ${board.label(holeId)} is used by ${list.map((e) => e.text).join(' and ')}; a hole takes one lead, so move the wire to a free hole on the same strip.`, {
      nodes: [holeId],
      wires: list.filter((e) => e.kind !== 'pin').map((e) => e.id),
      parts: list.filter((e) => e.kind === 'pin').map((e) => e.id),
    });
  }

  // ------------------------------------------------------------------------
  // UNCONNECTED_PART
  // ------------------------------------------------------------------------
  for (const part of parts) {
    if (floatingParts.has(part.id)) continue;
    const connected = (pinsOfPart.get(part.id) || []).some((pin) => otherPins(netOfNode(pin.nodeId), part.id).length > 0);
    if (!connected) {
      add('UNCONNECTED_PART', `${part.id} (${partDef(part.type)?.name || part.type}) is not connected to anything.`, { parts: [part.id] });
    }
  }

  issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || CODE_ORDER.indexOf(a.code) - CODE_ORDER.indexOf(b.code) || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return issues;
}

/** Convenience: { error, warn, info } counts. */
export function summarizeIssues(issues) {
  const s = { error: 0, warn: 0, info: 0 };
  for (const i of issues) s[i.severity] = (s[i.severity] || 0) + 1;
  return s;
}
