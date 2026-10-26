// render.js — SVG renderer for ProtoPlanner.
// Draws board / parts / bench modules / wires / bridges into the layer groups of
// <svg id="canvas">, and offers hit-testing + overlay helpers for interact.js.
// All SVG visual styling lives in SVG_CSS (injected into #svg-style) so exports carry it.

import {
  partDef, resolvePins, bodyRect, rotateOffset, validatePlacement, parseNodeId,
} from './parts.js';

export const PITCH_PX = 24;

const NS = 'http://www.w3.org/2000/svg';
const LAYER_IDS = ['bench', 'board', 'bridges', 'parts', 'modules', 'wires', 'highlight', 'overlay'];
const CONTENT_LAYERS = ['bench', 'board', 'bridges', 'parts', 'modules', 'wires'];

/** Jumper-wire color names → hex. */
export const WIRE_HEX = {
  red: '#e03131', black: '#212529', blue: '#1c7ed6', green: '#2f9e44', yellow: '#f2c511',
  orange: '#f76707', white: '#f1f3f5', purple: '#7048e8', brown: '#8d5524', grey: '#868e96', gray: '#868e96',
  pink: '#f06595',
};
const PLUG_STRIPES = ['#e03131', '#f76707', '#f2c511', '#f06595', '#1c7ed6']; // red orange yellow pink blue
const RESISTOR_BANDS = ['#111', '#7b3f00', '#e03131', '#f76707', '#f2c511', '#2f9e44', '#1c7ed6', '#7048e8', '#868e96', '#f8f9fa'];

export const SVG_CSS = `
  #layer-highlight, #layer-overlay { pointer-events: none; }
  .mid-handle { pointer-events: all; cursor: move; }
  text { font-family: ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; user-select: none; pointer-events: none; }
  .hit { fill: transparent; stroke: none; pointer-events: all; }
  .hit-path { fill: none; stroke: transparent; stroke-width: 10px; stroke-linecap: round; pointer-events: stroke; }
  .np { pointer-events: none; }

  /* board */
  .board-shadow { fill: rgba(0,0,0,.28); }
  .board-body { fill: #1f5f7a; stroke: #3b8bae; stroke-width: 2px; }
  .board-inner { fill: none; stroke: rgba(255,255,255,.08); stroke-width: 1px; }
  .mount-hole { fill: #0b2a38; stroke: #c9c9c9; stroke-width: 1.2px; }
  .channel { fill: rgba(0,0,0,.22); }
  .strip-trace { fill: none; stroke: rgba(255,255,255,.16); stroke-width: 7px; stroke-linecap: round; }
  .rail-trace { fill: none; stroke: rgba(255,255,255,.16); stroke-width: 7px; stroke-linecap: round; }
  .rail-stripe { fill: none; stroke-width: 2.5px; stroke-linecap: round; }
  .rail-stripe.plus { stroke: #ff6b6b; } .rail-stripe.minus { stroke: #4dabf7; }
  .rail-sign { font-size: 11px; font-weight: 700; text-anchor: middle; dominant-baseline: middle; }
  .rail-sign.plus { fill: #ff8787; } .rail-sign.minus { fill: #74c0fc; }
  .col-num { font-size: 6px; fill: rgba(255,255,255,.72); text-anchor: middle; dominant-baseline: middle; }
  .row-letter { font-size: 7.5px; font-weight: 600; fill: rgba(255,255,255,.85); text-anchor: middle; dominant-baseline: middle; }
  .hole { fill: #d4a834; stroke: #7a5c14; stroke-width: .7px; }
  .hole-c { fill: #0f2f3d; pointer-events: none; }
  .hole.hl { fill: #ffe066; stroke: #ffd43b; stroke-width: 2.4px; }

  /* nets by sim level (holes + pins) */
  .lv-gnd { fill: #4dabf7 !important; stroke: #1971c2 !important; }
  .lv-vcc { fill: #ff6b6b !important; stroke: #c92a2a !important; }
  .lv-high { fill: #ffa94d !important; stroke: #e8590c !important; }
  .lv-low { fill: #ced4da !important; stroke: #868e96 !important; }
  .lv-conflict { fill: #f06595 !important; stroke: #a61e4d !important; }
  .halo { fill: rgba(255,212,59,.35); stroke: rgba(255,212,59,.9); stroke-width: 1px; }

  /* through-hole parts */
  .pin { fill: #f3d27a; stroke: #3a2a06; stroke-width: .9px; }
  .pin.hl { fill: #ffe066; stroke: #ffd43b; stroke-width: 2.4px; }
  .pad { fill: #c99f2b; stroke: #6b4f0e; stroke-width: .6px; }
  .pin-label { font-size: 4.6px; fill: #e9ecef; text-anchor: middle; dominant-baseline: middle; font-weight: 600; }
  .pin-label.dark { fill: #212529; }
  .part-name { font-size: 7px; font-weight: 700; fill: #f8f9fa; text-anchor: middle; dominant-baseline: middle; letter-spacing: .3px; }
  .part-sub { font-size: 5px; fill: #ced4da; text-anchor: middle; dominant-baseline: middle; }
  .value-text { font-size: 5.6px; fill: #212529; text-anchor: middle; dominant-baseline: middle; font-weight: 600;
                paint-order: stroke; stroke: rgba(255,255,255,.85); stroke-width: 2px; stroke-linejoin: round; }
  .ref-text { font-size: 5.6px; fill: #343a40; text-anchor: middle; dominant-baseline: middle; font-weight: 700;
              paint-order: stroke; stroke: rgba(255,255,255,.85); stroke-width: 2px; stroke-linejoin: round; }
  .lead { fill: none; stroke: #b8bcc2; stroke-width: 2.2px; stroke-linecap: round; }
  .xiao-body { fill: #1b1d22; stroke: #3b3f47; stroke-width: 1px; }
  .xiao-inner { fill: #23262d; stroke: none; }
  .xiao-chip { fill: #0d0e11; stroke: #44474f; stroke-width: .6px; }
  .usb { fill: #c8ccd2; stroke: #6b7079; stroke-width: 1px; }
  .usb-slot { fill: #2b2f36; }
  .res-body { fill: #d9c49a; stroke: #8f7c4e; stroke-width: .9px; }
  .band { stroke-width: 2.6px; }
  .diode-body { fill: #1a1a1a; stroke: #4d4d4d; stroke-width: .9px; }
  .diode-band { fill: #d0d4d9; }
  .cap-body { fill: #1c7ed6; stroke: #0b4f8f; stroke-width: .9px; }
  .cap-stripe { fill: #a5d8ff; }
  .mosfet-body { fill: #141414; stroke: #4a4a4a; stroke-width: 1px; }
  .mosfet-tab { fill: #b4b8bd; stroke: #777; stroke-width: .8px; }
  .mosfet-tab-hole { fill: #f1f3f5; }
  .part.conducting .mosfet-body { stroke: #ffa94d; stroke-width: 2px; }
  .conduct-mark { fill: #ffa94d; display: none; }
  .part.conducting .conduct-mark { display: block; }
  .part.invalid .invalid-outline { fill: rgba(224,49,49,.12); stroke: #e03131; stroke-width: 2px; stroke-dasharray: 5 3; }
  .invalid-outline { fill: none; stroke: none; pointer-events: none; }

  /* bench modules */
  .module-shadow { fill: rgba(0,0,0,.18); }
  .pcb-green { fill: #2f7d4f; stroke: #1e5a37; stroke-width: 1.4px; }
  .pcb-trace { fill: none; stroke: rgba(255,255,255,.14); stroke-width: 2px; stroke-linecap: round; }
  .chip { fill: #111; stroke: #444; stroke-width: .8px; }
  .chip-text { font-size: 4.6px; fill: #ddd; text-anchor: middle; dominant-baseline: middle; }
  .header { fill: #0f0f0f; stroke: #333; stroke-width: .6px; }
  .socket { fill: #f1f3f5; stroke: #868e96; stroke-width: .8px; }
  .jumper { fill: #f2c511; stroke: #7a5c14; stroke-width: .6px; }
  .ind { fill: #4a1010; stroke: #2b2b2b; stroke-width: .8px; }
  .ind.on { fill: #ff3b3b; stroke: #ffc9c9; filter: drop-shadow(0 0 3px #ff5252); }
  .pwr-led { fill: #1a3a1a; stroke: #2b2b2b; stroke-width: .6px; }
  .part.powered .pwr-led { fill: #51cf66; filter: drop-shadow(0 0 2.5px #51cf66); }
  .term-label { font-size: 4.6px; fill: #f1f3f5; text-anchor: middle; dominant-baseline: middle; font-weight: 600; }
  .term-label.dark { fill: #212529; }
  .terminal { fill: #f3d27a; stroke: #3a2a06; stroke-width: .9px; }
  .terminal.hl { fill: #ffe066; stroke: #ffd43b; stroke-width: 2.4px; }
  .stepper-plate { fill: #9aa0a6; stroke: #5f6368; stroke-width: 1px; }
  .stepper-can { fill: #c9ccd1; stroke: #6b7079; stroke-width: 1.2px; }
  .stepper-can2 { fill: #e9ecef; }
  .rotor-shaft { fill: #495057; stroke: #212529; stroke-width: .8px; }
  .rotor-arrow { fill: none; stroke: #e03131; stroke-width: 2.4px; stroke-linecap: round; stroke-linejoin: round; }
  .pigtail { fill: none; stroke-width: 1.8px; stroke-linecap: round; }
  .servo-body { fill: #2b6cb0; stroke: #1a4a7d; stroke-width: 1.2px; }
  .servo-top { fill: #3b82c4; }
  .servo-ear { fill: #2b6cb0; stroke: #1a4a7d; stroke-width: .8px; }
  .horn { fill: #f8f9fa; stroke: #868e96; stroke-width: .8px; }
  .servo-led { fill: #333; }
  .part.alive .servo-led { fill: #51cf66; filter: drop-shadow(0 0 2.5px #51cf66); }
  .coil-core { fill: #3a3a3a; stroke: #111; stroke-width: 1px; }
  .coil-wind { fill: none; stroke: #b87333; stroke-width: 1.6px; }
  .part.energized .coil-core { fill: #ff922b; }
  .field { fill: none; stroke: rgba(255,146,43,.75); stroke-width: 1.2px; display: none; }
  .part.energized .field { display: block; }
  .psu-body { fill: #343a40; stroke: #212529; stroke-width: 1.2px; }
  .psu-face { fill: #495057; }
  .psu-text { font-size: 9px; font-weight: 800; fill: #74c0fc; text-anchor: middle; dominant-baseline: middle; }
  .post-gnd { fill: #212529; stroke: #000; stroke-width: 1px; }
  .post-v { fill: #e03131; stroke: #7a1010; stroke-width: 1px; }
  .generic-body { fill: #495057; stroke: #212529; stroke-width: 1px; }

  /* wires & bridges */
  .wire-shadow { fill: none; stroke: rgba(0,0,0,.35); stroke-width: 5.5px; stroke-linecap: round; }
  .wire { fill: none; stroke-width: 4px; stroke-linecap: round; }
  .wire.hl { stroke-width: 6px; filter: drop-shadow(0 0 2px #ffd43b); }
  .wire-dot { stroke: rgba(0,0,0,.55); stroke-width: 1px; }
  .plug-band { fill: none; stroke: #868e96; stroke-width: 11px; stroke-linecap: round; }
  .plug-stripe { fill: none; stroke-width: 1.6px; stroke-linecap: round; }
  .bridge { fill: none; stroke: #b87333; stroke-width: 9px; stroke-linecap: round; }
  .bridge-hi { fill: none; stroke: #e0a060; stroke-width: 2px; stroke-linecap: round; pointer-events: none; }

  /* overlay */
  .ghost { opacity: .72; }
  .ghost-outline { fill: none; stroke-width: 2px; stroke-dasharray: 5 3; }
  .ghost.valid .ghost-outline { stroke: #40c057; fill: rgba(64,192,87,.12); }
  .ghost.invalid .ghost-outline { stroke: #e03131; fill: rgba(224,49,49,.14); }
  .rubber { fill: none; stroke-width: 3px; stroke-dasharray: 6 4; stroke-linecap: round; opacity: .9; }
  .rubber-dot { fill: #fff; stroke: #212529; stroke-width: 1px; }
  .sel-outline { fill: none; stroke: #339af0; stroke-width: 2px; stroke-dasharray: 6 3; }
  .sel-wire { fill: none; stroke: rgba(51,154,240,.55); stroke-width: 9px; stroke-linecap: round; }
  .mid-handle { fill: #fff; stroke: #1971c2; stroke-width: 2px; }
`;

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

const P = (v) => v * PITCH_PX;                       // grid → px
const fmt = (n) => (Math.round(n * 100) / 100).toString();

function el(tag, attrs = {}, children = []) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') e.textContent = String(v);
    else e.setAttribute(k, typeof v === 'number' ? fmt(v) : String(v));
  }
  for (const c of children) if (c) e.appendChild(c);
  return e;
}
const g = (attrs = {}, children = []) => el('g', attrs, children);
const circle = (cx, cy, r, attrs = {}) => el('circle', { cx: P(cx), cy: P(cy), r: P(r), ...attrs });
const rect = (x, y, w, h, attrs = {}) => el('rect', { x: P(x), y: P(y), width: P(w), height: P(h), ...attrs });
const line = (x1, y1, x2, y2, attrs = {}) => el('line', { x1: P(x1), y1: P(y1), x2: P(x2), y2: P(y2), ...attrs });
const text = (x, y, str, attrs = {}) => el('text', { x: P(x), y: P(y), text: str, ...attrs });
/** Text that stays upright regardless of the enclosing part rotation. */
const upright = (x, y, str, rot, attrs = {}) =>
  text(x, y, str, { ...attrs, transform: rot ? `rotate(${-rot} ${fmt(P(x))} ${fmt(P(y))})` : null });

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function wireHex(name) { return WIRE_HEX[String(name || '').toLowerCase()] || (String(name || '').startsWith('#') ? name : '#868e96'); }

/** Parse '220Ω' / '10kΩ' / '4.7k' / '1M' → ohms (number) or null. */
function parseOhms(str) {
  const m = String(str || '').replace(/\s/g, '').match(/^([\d.]+)([kKmM]?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const mult = m[2] === 'k' || m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : m[2] === 'm' ? 1e-3 : 1;
  return n * mult;
}
/** 4-band resistor colors for an ohm value (digit, digit, multiplier). */
function resistorBands(ohms) {
  if (!ohms || ohms <= 0) return ['#7b3f00', '#111', '#111'];
  let exp = 0, v = ohms;
  while (v >= 100) { v /= 10; exp++; }
  while (v < 10 && exp > -2) { v *= 10; exp--; }
  const d1 = Math.floor(v / 10) % 10, d2 = Math.round(v) % 10;
  const multColor = exp >= 0 ? RESISTOR_BANDS[Math.min(exp, 9)] : exp === -1 ? '#d4a834' : '#c0c0c0';
  return [RESISTOR_BANDS[d1], RESISTOR_BANDS[d2], multColor];
}

/** Quadratic-curve control point for a wire: explicit mid, or midpoint pushed 8 % perpendicular. */
function wireControl(a, b, mid) {
  if (mid && isFinite(mid.x) && isFinite(mid.y)) return { x: mid.x, y: mid.y };
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const push = 0.08 * len;                       // 8 % of the chord, perpendicular
  return { x: (a.x + b.x) / 2 - dy / len * push, y: (a.y + b.y) / 2 + dx / len * push };
}
function quadPath(a, c, b) { return `M ${fmt(P(a.x))} ${fmt(P(a.y))} Q ${fmt(P(c.x))} ${fmt(P(c.y))} ${fmt(P(b.x))} ${fmt(P(b.y))}`; }
/** Point on the quadratic at t=.5 (where the mid handle sits when no explicit mid). */
function quadMid(a, c, b) { return { x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y }; }

/** SVG path data (px) for a wire between grid points a, b with optional explicit control point `mid`. */
export function wirePathD(a, b, mid) { return quadPath(a, wireControl(a, b, mid), b); }
/** Grid point where the draggable mid handle sits (on the curve at t = .5). */
export function wireHandlePoint(a, b, mid) { return quadMid(a, wireControl(a, b, mid), b); }
/** Control point that makes the curve pass through handle point h at t = .5. */
export function controlForHandle(a, b, h) { return { x: 2 * h.x - (a.x + b.x) / 2, y: 2 * h.y - (a.y + b.y) / 2 }; }

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function holeXY(board, idOrHole) {
  const h = typeof idOrHole === 'string' ? (board.holeById ? board.holeById(idOrHole) : null) : idOrHole;
  return h && isFinite(h.x) && isFinite(h.y) ? { x: h.x, y: h.y } : null;
}

/** Bounding box (grid units) of all holes on the board. */
function boardBox(board) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const h of board.holes || []) {
    if (h.x < minX) minX = h.x; if (h.x > maxX) maxX = h.x;
    if (h.y < minY) minY = h.y; if (h.y > maxY) maxY = h.y;
  }
  if (!isFinite(minX)) { minX = 1; maxX = board.cols || 30; minY = 0; maxY = 11; }
  const m = 1.1;                                   // PCB margin beyond the outermost holes
  return { minX, minY, maxX, maxY, x: minX - m, y: minY - m, w: maxX - minX + 2 * m, h: maxY - minY + 2 * m };
}

function renderBoard(layerBench, layerBoard, board, nodeIndex) {
  const bb = boardBox(board);
  const isRail = (h) => String(h.id).startsWith('r:');
  const stripHoles = (board.holes || []).filter((h) => !isRail(h));
  const railHoles = (board.holes || []).filter(isRail);

  // Shadow (bench layer) + body
  layerBench.appendChild(rect(bb.x + 0.12, bb.y + 0.16, bb.w, bb.h, { rx: P(0.5), class: 'board-shadow' }));
  layerBoard.appendChild(rect(bb.x, bb.y, bb.w, bb.h, { rx: P(0.5), class: 'board-body' }));
  layerBoard.appendChild(rect(bb.x + 0.2, bb.y + 0.2, bb.w - 0.4, bb.h - 0.4, { rx: P(0.35), class: 'board-inner np' }));
  for (const [cx, cy] of [[bb.x + 0.55, bb.y + 0.55], [bb.x + bb.w - 0.55, bb.y + 0.55], [bb.x + 0.55, bb.y + bb.h - 0.55], [bb.x + bb.w - 0.55, bb.y + bb.h - 0.55]]) {
    layerBoard.appendChild(circle(cx, cy, 0.28, { class: 'mount-hole np' }));
  }

  // Channel bands: gaps > 1 between consecutive strip-hole rows
  const ys = [...new Set(stripHoles.map((h) => h.y))].sort((a, b) => a - b);
  const blocks = [];                                // [{yTop,yBot}] per a..j block, for numbers/letters
  let blockStart = ys[0];
  for (let i = 1; i <= ys.length; i++) {
    if (i === ys.length || ys[i] - ys[i - 1] > 1) {
      blocks.push({ yTop: blockStart, yBot: ys[i - 1] });
      if (i < ys.length) {
        if (ys[i] - ys[i - 1] > 2) layerBoard.appendChild(rect(bb.minX - 0.6, ys[i - 1] + 0.5, bb.maxX - bb.minX + 1.2, ys[i] - ys[i - 1] - 1, { class: 'channel np' }));
        blockStart = ys[i];
      }
    }
  }

  // Strip traces (connect the 5 holes of each strip) and rail traces (grouped in 5s)
  const byStrip = new Map();
  for (const h of stripHoles) {
    const k = h.strip || `${h.col}:${h.y >= 7 ? 'b' : 'a'}`;
    if (!byStrip.has(k)) byStrip.set(k, []);
    byStrip.get(k).push(h);
  }
  const traces = g({ class: 'np' });
  for (const hs of byStrip.values()) {
    if (hs.length < 2) continue;
    const y0 = Math.min(...hs.map((h) => h.y)), y1 = Math.max(...hs.map((h) => h.y));
    traces.appendChild(line(hs[0].x, y0, hs[0].x, y1, { class: 'strip-trace' }));
  }
  const railGroups = new Map();                     // rail id → sorted holes
  for (const h of railHoles) {
    const k = String(h.id).split(':')[1];
    if (!railGroups.has(k)) railGroups.set(k, []);
    railGroups.get(k).push(h);
  }
  const railYs = [...railGroups.values()].map((hs) => hs[0].y);
  const midY = (bb.minY + bb.maxY) / 2;
  const topYs = railYs.filter((y) => y < midY), botYs = railYs.filter((y) => y >= midY);
  for (const [railId, hs] of railGroups) {
    hs.sort((a, b) => a.x - b.x);
    const y = hs[0].y;
    for (let i = 0; i < hs.length; i += 5) {        // copper trace per group of 5
      const seg = hs.slice(i, i + 5);
      traces.appendChild(line(seg[0].x, y, seg[seg.length - 1].x, y, { class: 'rail-trace' }));
    }
    // Colored stripe on the outer side, split where the strip id changes (railSplit)
    const plus = /p$/.test(railId);
    // stripe goes on the side away from the other rail of the pair (outermost rail → board edge)
    const outer = y < midY ? (y === Math.min(...topYs) ? -0.55 : 0.55) : (y === Math.max(...botYs) ? 0.55 : -0.55);
    const segs = [];
    let cur = [hs[0]];
    for (let i = 1; i < hs.length; i++) {
      const same = !board.stripOf || board.stripOf(hs[i].id) === board.stripOf(cur[0].id);
      if (same) cur.push(hs[i]); else { segs.push(cur); cur = [hs[i]]; }
    }
    segs.push(cur);
    for (const s of segs) {
      traces.appendChild(line(s[0].x - 0.3, y + outer, s[s.length - 1].x + 0.3, y + outer, { class: `rail-stripe ${plus ? 'plus' : 'minus'}` }));
    }
    const sign = plus ? '+' : '−';
    traces.appendChild(text(hs[0].x - 1.1, y + outer * 0.2, sign, { class: `rail-sign ${plus ? 'plus' : 'minus'}` }));
    traces.appendChild(text(hs[hs.length - 1].x + 1.1, y + outer * 0.2, sign, { class: `rail-sign ${plus ? 'plus' : 'minus'}` }));
  }
  layerBoard.appendChild(traces);

  // Column numbers above the first block and below the last; row letters at both ends
  const labels = g({ class: 'np' });
  const cols = [...new Set(stripHoles.map((h) => h.x))].sort((a, b) => a - b);
  if (blocks.length) {
    for (const x of cols) {
      labels.appendChild(text(x, blocks[0].yTop - 0.95, String(x), { class: 'col-num' }));
      labels.appendChild(text(x, blocks[blocks.length - 1].yBot + 0.95, String(x), { class: 'col-num' }));
    }
  }
  const rowsByY = new Map();
  for (const h of stripHoles) if (h.row && !rowsByY.has(h.y)) rowsByY.set(h.y, h.row);
  for (const [y, row] of rowsByY) {
    labels.appendChild(text(bb.minX - 0.6, y, row, { class: 'row-letter' }));
    labels.appendChild(text(bb.maxX + 0.6, y, row, { class: 'row-letter' }));
  }
  layerBoard.appendChild(labels);

  // Holes: gold pad (data-node) + dark center + invisible hit circle (data-node)
  const holes = g({ class: 'holes' });
  for (const h of board.holes || []) {
    nodeIndex.set(h.id, { x: h.x, y: h.y });
    holes.appendChild(circle(h.x, h.y, 0.22, { class: 'hole', 'data-node': h.id }));
    holes.appendChild(circle(h.x, h.y, 0.1, { class: 'hole-c' }));
    holes.appendChild(circle(h.x, h.y, 0.45, { class: 'hit', 'data-node': h.id }));
  }
  layerBoard.appendChild(holes);
  return bb;
}

// ---------------------------------------------------------------------------
// Part bodies — drawn in the part's rot-0 local frame (grid units relative to
// the anchor pin for through-hole parts / body top-left for bench modules).
// ---------------------------------------------------------------------------

function mergedProps(def, part) { return { ...(def && def.props ? def.props : {}), ...(part.props || {}) }; }
function localBody(def, props) {
  if (def && def.mount === 'bench') return { x: 0, y: 0, w: (def.size && def.size.w) || 4, h: (def.size && def.size.h) || 4 };
  try { const b = def && def.body ? def.body(props) : null; if (b) return b; } catch { /* fall through */ }
  return { x: -0.5, y: -0.5, w: 1, h: 1 };
}
function localPins(def, props) {
  try { return def && def.pins ? def.pins(props) : []; } catch { return []; }
}
function pinSpan(pins, props, dflt) {
  if (pins.length > 1) {
    const s = Math.max(Math.abs(pins[1].dx - pins[0].dx), Math.abs(pins[1].dy - pins[0].dy));
    if (s > 0) return s;
  }
  return Number(props.span) || dflt;
}

function drawXiao(part, def, props, rot) {
  const b = localBody(def, props);
  const out = g();
  out.appendChild(rect(b.x, b.y, b.w, b.h, { rx: P(0.3), class: 'xiao-body' }));
  out.appendChild(rect(b.x + 0.35, b.y + 0.9, b.w - 0.7, b.h - 1.8, { rx: P(0.15), class: 'xiao-inner' }));
  // USB-C stub on the left (rot 0), vertically centred between the pin rows
  const midY = b.y + b.h / 2;
  out.appendChild(rect(b.x - 0.45, midY - 0.6, 0.85, 1.2, { rx: P(0.25), class: 'usb' }));
  out.appendChild(rect(b.x - 0.3, midY - 0.3, 0.45, 0.6, { rx: P(0.12), class: 'usb-slot' }));
  // Shielded module + antenna strip
  out.appendChild(rect(b.x + 2.4, midY - 1.1, 2.4, 2.2, { rx: P(0.08), class: 'xiao-chip' }));
  out.appendChild(rect(b.x + b.w - 1.3, b.y + 1.1, 0.7, b.h - 2.2, { class: 'xiao-chip' }));
  out.appendChild(upright(b.x + 3.6, midY, 'ESP32-C3', rot, { class: 'part-sub' }));
  out.appendChild(upright(b.x + b.w / 2, b.y + 0.45, props.label || 'XIAO ESP32C3', rot, { class: 'part-name', style: 'font-size:6px' }));
  out.appendChild(upright(b.x + 1.2, midY, part.id, rot, { class: 'part-sub', style: 'fill:#adb5bd;font-weight:700' }));
  // Castellated pads + per-pin labels
  for (const p of localPins(def, props)) {
    if (p.offGrid || !isFinite(p.dx)) continue;
    out.appendChild(rect(p.dx - 0.34, p.dy - 0.34, 0.68, 0.68, { rx: P(0.08), class: 'pad' }));
    const labelY = p.dy <= b.y + b.h / 2 ? p.dy + 0.62 : p.dy - 0.62;
    out.appendChild(upright(p.dx, labelY, p.label || p.name, rot, { class: 'pin-label' }));
  }
  return out;
}

function drawResistor(part, def, props, rot) {
  const span = pinSpan(localPins(def, props), props, 4);
  const out = g();
  const x0 = Math.min(0.75, span * 0.22), x1 = span - x0;
  out.appendChild(line(0, 0, span, 0, { class: 'lead' }));
  out.appendChild(rect(x0, -0.42, x1 - x0, 0.84, { rx: P(0.3), class: 'res-body' }));
  const bands = resistorBands(parseOhms(props.value));
  const bw = x1 - x0, bx = [x0 + bw * 0.22, x0 + bw * 0.4, x0 + bw * 0.58, x0 + bw * 0.8];
  [...bands, '#d4a834'].forEach((c, i) => out.appendChild(line(bx[i], -0.38, bx[i], 0.38, { class: 'band', stroke: c })));
  out.appendChild(upright(span / 2, -0.85, `${part.id}  ${props.value || ''}`.trim(), rot, { class: 'value-text' }));
  return out;
}

function drawDiode(part, def, props, rot) {
  const span = pinSpan(localPins(def, props), props, 4);
  const out = g();
  const x0 = Math.min(0.85, span * 0.25), x1 = span - x0;
  out.appendChild(line(0, 0, span, 0, { class: 'lead' }));
  out.appendChild(rect(x0, -0.38, x1 - x0, 0.76, { rx: P(0.12), class: 'diode-body' }));
  out.appendChild(rect(x1 - 0.42, -0.38, 0.22, 0.76, { class: 'diode-band' }));   // cathode band at K
  out.appendChild(upright(span / 2, -0.85, `${part.id}  ${props.value || ''}`.trim(), rot, { class: 'value-text' }));
  out.appendChild(upright(0, 0.75, 'A', rot, { class: 'value-text', style: 'font-size:4.6px' }));
  out.appendChild(upright(span, 0.75, 'K', rot, { class: 'value-text', style: 'font-size:4.6px' }));
  return out;
}

function drawCapacitor(part, def, props, rot) {
  const span = pinSpan(localPins(def, props), props, 2);
  const out = g();
  const cx = span / 2, r = Math.max(0.55, Math.min(1.1, span / 2 + 0.1));
  out.appendChild(line(0, 0, cx, -r * 0.5, { class: 'lead' }));
  out.appendChild(line(span, 0, cx, -r * 0.5, { class: 'lead' }));
  out.appendChild(circle(cx, -r * 0.55, r, { class: 'cap-body' }));
  if (props.polarized) {
    out.appendChild(rect(cx - r * 0.95, -r * 0.55 - r * 0.85, r * 0.3, r * 1.7, { class: 'cap-stripe' })); // negative stripe
    out.appendChild(upright(0, 0.7, '+', rot, { class: 'value-text' }));
  }
  out.appendChild(upright(cx, -r * 1.55 - 0.3, `${part.id}  ${props.value || ''}`.trim(), rot, { class: 'value-text' }));
  return out;
}

function drawMosfet(part, def, props, rot) {
  // Compact "lying" package so the body never reaches the neighbouring rows (±1 grid).
  const pins = localPins(def, props);
  const out = g();
  const to92 = /92/.test(String(props.package || ''));
  const x0 = Math.min(...pins.map((p) => p.dx)) - 0.55, x1 = Math.max(...pins.map((p) => p.dx)) + 0.55;
  if (to92) {
    // half-round TO-92 outline (flat face toward the labels)
    out.appendChild(el('path', { class: 'mosfet-body', d: `M ${fmt(P(x0))} ${fmt(P(0.42))} H ${fmt(P(x1))} V ${fmt(P(-0.25))} A ${fmt(P((x1 - x0) / 2))} ${fmt(P(0.5))} 0 0 0 ${fmt(P(x0))} ${fmt(P(-0.25))} Z` }));
  } else {
    out.appendChild(rect(x0, -0.78, x1 - x0, 0.34, { rx: P(0.05), class: 'mosfet-tab' }));
    out.appendChild(circle((x0 + x1) / 2, -0.61, 0.1, { class: 'mosfet-tab-hole' }));
    out.appendChild(rect(x0, -0.46, x1 - x0, 0.9, { rx: P(0.08), class: 'mosfet-body' }));
  }
  for (const p of pins) {
    if (!isFinite(p.dx)) continue;
    out.appendChild(upright(p.dx + 0.36, -0.2, p.label || p.name, rot, { class: 'pin-label', style: 'font-size:4px;text-anchor:start' }));
  }
  out.appendChild(circle(x1 - 0.18, 0.26, 0.09, { class: 'conduct-mark' }));
  out.appendChild(upright((x0 + x1) / 2, -1.05, `${part.id}  ${props.partNumber || (to92 ? '2N7000' : 'IRLZ44N')}`, rot, { class: 'value-text' }));
  return out;
}

function drawGenericThrough(part, def, props, rot) {
  const b = localBody(def, props);
  const out = g();
  out.appendChild(rect(b.x, b.y, b.w, b.h, { rx: P(0.15), class: 'generic-body' }));
  out.appendChild(upright(b.x + b.w / 2, b.y + b.h / 2, `${part.id} ${(def && def.name) || part.type}`, rot, { class: 'part-sub' }));
  return out;
}

// ---- bench modules ----------------------------------------------------------

function terminalsOf(def) { return (def && Array.isArray(def.terminals)) ? def.terminals : []; }
function termLabel(t) { return t.label && t.label.length <= 4 ? t.label : t.name; }

/** Header-pin stubs + labels for a row of terminals along an edge (inside the body). */
function drawTerminalLabels(out, def, rot, opts = {}) {
  const b = localBody(def, {});
  for (const t of terminalsOf(def)) {
    if (opts.skip && opts.skip.includes(t.name)) continue;
    // Place the label just inside the body from the terminal
    const inX = t.tx <= 0 ? 0.75 : t.tx >= b.w ? -0.75 : 0;
    const inY = t.ty <= 0 ? 0.65 : t.ty >= b.h ? -0.65 : 0;
    out.appendChild(rect(t.tx - 0.28, t.ty - 0.28, 0.56, 0.56, { rx: P(0.05), class: 'header' }));
    out.appendChild(upright(t.tx + inX, t.ty + inY, termLabel(t), rot, { class: `term-label ${opts.dark ? 'dark' : ''}` }));
  }
}

function drawUln(part, def, props, rot) {
  const b = localBody(def, props);
  const out = g();
  out.appendChild(rect(b.x, b.y, b.w, b.h, { rx: P(0.25), class: 'pcb-green' }));
  for (const [cx, cy] of [[0.4, 0.4], [b.w - 0.4, 0.4], [0.4, b.h - 0.4]]) out.appendChild(circle(cx, cy, 0.18, { class: 'mount-hole' }));
  // traces for flavour
  out.appendChild(el('path', { class: 'pcb-trace', d: `M ${fmt(P(1))} ${fmt(P(6.3))} V ${fmt(P(4.6))} H ${fmt(P(2.2))} M ${fmt(P(4))} ${fmt(P(6.3))} V ${fmt(P(4.6))} M ${fmt(P(6.5))} ${fmt(P(6.3))} V ${fmt(P(5.2))} H ${fmt(P(7.2))}` }));
  // ULN2003A DIP
  out.appendChild(rect(1.6, 2.6, 4.2, 1.6, { rx: P(0.06), class: 'chip' }));
  out.appendChild(circle(1.9, 2.9, 0.1, { fill: '#999' }));
  out.appendChild(upright(3.7, 3.4, 'ULN2003A', rot, { class: 'chip-text' }));
  out.appendChild(upright(b.w / 2, 0.6, 'ULN2003 driver', rot, { class: 'part-name', style: 'font-size:6px' }));
  out.appendChild(upright(1.3, 1.5, part.id, rot, { class: 'part-sub', style: 'font-weight:700;fill:#e9ecef' }));
  // LEDs A..D
  const inds = (def && def.indicators) || [];
  inds.forEach((ind, i) => {
    const x = 2.2 + i * 1.1, y = 1.6;
    out.appendChild(circle(x, y, 0.22, { class: 'ind', 'data-ind': `${part.id}:${ind.id}` }));
    out.appendChild(upright(x, y + 0.5, String.fromCharCode(65 + i), rot, { class: 'term-label', style: 'font-size:4px' }));
  });
  out.appendChild(circle(6.8, 1.6, 0.18, { class: 'pwr-led' }));
  out.appendChild(upright(6.8, 2.1, 'PWR', rot, { class: 'term-label', style: 'font-size:3.8px' }));
  // JST socket on the SOCKET terminal + COM jumper
  const sock = terminalsOf(def).find((t) => t.name === 'SOCKET');
  if (sock) {
    out.appendChild(rect(sock.tx - 0.95, sock.ty - 1.15, 1.0, 2.3, { rx: P(0.08), class: 'socket' }));
    for (let i = 0; i < 5; i++) out.appendChild(rect(sock.tx - 0.75, sock.ty - 0.95 + i * 0.44, 0.35, 0.22, { class: 'header' }));
    out.appendChild(upright(sock.tx - 1.6, sock.ty, 'MOTOR', rot, { class: 'term-label', style: 'font-size:3.8px' }));
  }
  const jx = 6.2, jy = 5.0;
  out.appendChild(rect(jx - 0.15, jy - 0.5, 0.3, 1.0, { class: 'header' }));
  if (props.jumper !== false) out.appendChild(rect(jx - 0.3, jy - 0.4, 0.6, 0.8, { rx: P(0.06), class: 'jumper' }));
  out.appendChild(upright(jx + 0.85, jy, 'COM', rot, { class: 'term-label', style: 'font-size:3.8px' }));
  drawTerminalLabels(out, def, rot, { skip: ['SOCKET'] });
  return out;
}

function drawStepper(part, def, props, rot) {
  const b = localBody(def, props);
  const out = g();
  const cx = b.w / 2, cy = b.h / 2, r = Math.min(b.w, b.h) / 2 - 0.45;
  out.appendChild(rect(0.1, cy - 0.45, b.w - 0.2, 0.9, { rx: P(0.2), class: 'stepper-plate' }));
  out.appendChild(circle(0.45, cy, 0.14, { class: 'mount-hole' }));
  out.appendChild(circle(b.w - 0.45, cy, 0.14, { class: 'mount-hole' }));
  out.appendChild(circle(cx, cy, r, { class: 'stepper-can' }));
  out.appendChild(circle(cx, cy, r * 0.55, { class: 'stepper-can2' }));
  out.appendChild(upright(cx, cy + r * 0.78, '28BYJ-48', rot, { class: 'part-sub', style: 'fill:#343a40;font-weight:700' }));
  out.appendChild(upright(cx, cy - r * 0.78, part.id, rot, { class: 'part-sub', style: 'fill:#343a40;font-weight:700' }));
  // rotor: shaft + arrow, rotated by applySim about (cx,cy)
  const rotor = g({ 'data-rotor': '', 'data-cx': P(cx), 'data-cy': P(cy) });
  rotor.appendChild(circle(cx, cy, 0.32, { class: 'rotor-shaft' }));
  rotor.appendChild(el('path', { class: 'rotor-arrow', d: `M ${fmt(P(cx))} ${fmt(P(cy))} L ${fmt(P(cx))} ${fmt(P(cy - r * 0.5))} M ${fmt(P(cx - 0.3))} ${fmt(P(cy - r * 0.5 + 0.3))} L ${fmt(P(cx))} ${fmt(P(cy - r * 0.5))} L ${fmt(P(cx + 0.3))} ${fmt(P(cy - r * 0.5 + 0.3))}` }));
  out.appendChild(rotor);
  // 5-wire pigtail to the PLUG terminal
  const plug = terminalsOf(def).find((t) => t.name === 'PLUG');
  if (plug) {
    const x0 = cx - r + 0.1;
    PLUG_STRIPES.forEach((c, i) => {
      const dy = (i - 2) * 0.17;
      out.appendChild(el('path', { class: 'pigtail', stroke: c, d: `M ${fmt(P(x0))} ${fmt(P(cy + dy))} C ${fmt(P(x0 - 0.8))} ${fmt(P(cy + dy))} ${fmt(P(plug.tx + 0.7))} ${fmt(P(plug.ty + dy))} ${fmt(P(plug.tx + 0.35))} ${fmt(P(plug.ty + dy))}` }));
    });
    out.appendChild(rect(plug.tx - 0.3, plug.ty - 0.6, 0.65, 1.2, { rx: P(0.08), class: 'socket' }));
  }
  return out;
}

function drawServo(part, def, props, rot) {
  const b = localBody(def, props);
  const out = g();
  const hx = b.w * 0.68, hy = b.h * 0.6;                 // output shaft
  out.appendChild(rect(-0.3, b.h * 0.45, b.w + 0.6, 0.5, { rx: P(0.08), class: 'servo-ear' }));
  out.appendChild(rect(0, 0.7, b.w, b.h - 0.7, { rx: P(0.15), class: 'servo-body' }));
  out.appendChild(rect(0.25, 0.9, b.w - 0.5, 0.9, { rx: P(0.08), class: 'servo-top' }));
  out.appendChild(circle(hx, hy, 0.95, { class: 'servo-top' }));
  out.appendChild(upright(1.5, hy + 0.1, 'SG90', rot, { class: 'part-sub', style: 'fill:#e7f5ff;font-weight:700' }));
  out.appendChild(upright(1.5, hy + 0.7, part.id, rot, { class: 'part-sub', style: 'fill:#a5d8ff;font-weight:700' }));
  out.appendChild(circle(0.5, b.h - 0.5, 0.14, { class: 'servo-led' }));
  // horn (rotated by applySim about the shaft)
  const horn = g({ 'data-horn': '', 'data-cx': P(hx), 'data-cy': P(hy) });
  horn.appendChild(rect(hx - 0.22, hy - 1.5, 0.44, 1.75, { rx: P(0.2), class: 'horn' }));
  horn.appendChild(circle(hx, hy, 0.3, { class: 'horn' }));
  for (let i = 1; i <= 3; i++) horn.appendChild(circle(hx, hy - 0.42 * i, 0.07, { fill: '#868e96' }));
  out.appendChild(horn);
  // leads: SIG orange, VCC red, GND brown
  const leadColor = { SIG: '#f76707', VCC: '#e03131', GND: '#8d5524' };
  for (const t of terminalsOf(def)) {
    out.appendChild(line(t.tx, t.ty + 0.72, t.tx, t.ty, { class: 'pigtail', stroke: leadColor[t.name] || '#868e96' }));
    out.appendChild(upright(t.tx, t.ty + 1.15, termLabel(t), rot, { class: 'term-label' }));
  }
  return out;
}

function drawMagnet(part, def, props, rot) {
  const b = localBody(def, props);
  const out = g();
  const cx = b.w / 2, top = 0.9, bot = b.h - 0.4;
  const w = Math.min(b.w - 1.2, 2.4);
  out.appendChild(rect(cx - w / 2, top, w, bot - top, { rx: P(0.15), class: 'coil-core' }));
  for (let y = top + 0.35; y < bot - 0.25; y += 0.3) out.appendChild(line(cx - w / 2 - 0.08, y, cx + w / 2 + 0.08, y, { class: 'coil-wind' }));
  out.appendChild(upright(cx, (top + bot) / 2, part.id, rot, { class: 'part-sub', style: 'fill:#ffd8a8;font-weight:700;paint-order:stroke;stroke:rgba(0,0,0,.6);stroke-width:2px' }));
  // magnetic field arcs, shown when energized
  for (const k of [1, 1.35, 1.7]) {
    out.appendChild(el('path', { class: 'field', d: `M ${fmt(P(cx - w / 2 - 0.25 * k))} ${fmt(P(bot))} Q ${fmt(P(cx))} ${fmt(P(bot + 1.1 * k))} ${fmt(P(cx + w / 2 + 0.25 * k))} ${fmt(P(bot))}` }));
  }
  for (const t of terminalsOf(def)) {
    out.appendChild(el('path', { class: 'pigtail', stroke: '#e03131', d: `M ${fmt(P(t.tx))} ${fmt(P(t.ty))} C ${fmt(P(t.tx))} ${fmt(P(t.ty + 0.5))} ${fmt(P(cx + (t.tx < cx ? -w / 3 : w / 3)))} ${fmt(P(top - 0.4))} ${fmt(P(cx + (t.tx < cx ? -w / 3 : w / 3)))} ${fmt(P(top))}` }));
    out.appendChild(upright(t.tx, t.ty + 1.25, termLabel(t), rot, { class: 'term-label dark' }));
  }
  return out;
}

function drawPsu(part, def, props, rot) {
  const b = localBody(def, props);
  const out = g();
  out.appendChild(rect(0, 0, b.w, b.h, { rx: P(0.2), class: 'psu-body' }));
  out.appendChild(rect(0.9, 0.35, b.w - 1.2, b.h - 0.7, { rx: P(0.12), class: 'psu-face' }));
  out.appendChild(upright(0.9 + (b.w - 1.2) / 2, b.h / 2 - 0.35, `${props.voltage ?? 5} V`, rot, { class: 'psu-text' }));
  out.appendChild(upright(0.9 + (b.w - 1.2) / 2, b.h / 2 + 0.55, props.label || 'DC SUPPLY', rot, { class: 'part-sub' }));
  out.appendChild(upright(0.9 + (b.w - 1.2) / 2, b.h - 0.6, part.id, rot, { class: 'part-sub', style: 'font-weight:700' }));
  for (const t of terminalsOf(def)) {
    const isGnd = /gnd/i.test(t.name) || t.role === 'gnd';
    out.appendChild(circle(t.tx, t.ty, 0.42, { class: isGnd ? 'post-gnd' : 'post-v' }));
    out.appendChild(upright(t.tx + 0.95, t.ty, termLabel(t), rot, { class: 'term-label' }));
  }
  return out;
}

function drawGenericBench(part, def, props, rot) {
  const b = localBody(def, props);
  const out = g();
  out.appendChild(rect(0, 0, b.w, b.h, { rx: P(0.2), class: 'generic-body' }));
  out.appendChild(upright(b.w / 2, b.h / 2, `${part.id} ${(def && def.name) || part.type}`, rot, { class: 'part-sub' }));
  drawTerminalLabels(out, def, rot);
  return out;
}

const BODY_DRAWERS = {
  xiao_esp32c3: drawXiao, resistor: drawResistor, diode: drawDiode, capacitor: drawCapacitor, mosfet_n: drawMosfet,
  uln2003: drawUln, stepper_28byj48: drawStepper, servo: drawServo, electromagnet: drawMagnet, power_supply: drawPsu,
};

// ---------------------------------------------------------------------------
// Parts: body (rotated local frame) + absolute pins/terminals
// ---------------------------------------------------------------------------

/** Pins/terminals with absolute grid positions; tolerant of missing x/y. */
function partPins(part, def) {
  let pins = [];
  try { pins = resolvePins(part) || []; } catch { pins = []; }
  const rot = part.rot || 0;
  const out = [];
  for (const p of pins) {
    if (p.hidden) continue;
    let x = p.x, y = p.y;
    if (!isFinite(x) || !isFinite(y)) {
      const dx = isFinite(p.dx) ? p.dx : p.tx, dy = isFinite(p.dy) ? p.dy : p.ty;
      if (!isFinite(dx) || !isFinite(dy)) continue;
      const o = rotateOffset(dx, dy, rot);
      x = part.at.x + o.x; y = part.at.y + o.y;
    }
    out.push({ ...p, x, y, nodeId: p.nodeId || `p:${part.id}:${p.name}` });
  }
  return out;
}

/** Absolute body rect; falls back to rotating the local body about the anchor. */
function absBody(part, def, props) {
  try { const b = bodyRect(part); if (b && isFinite(b.x)) return b; } catch { /* fall through */ }
  const lb = localBody(def, props), rot = part.rot || 0;
  const corners = [[lb.x, lb.y], [lb.x + lb.w, lb.y], [lb.x, lb.y + lb.h], [lb.x + lb.w, lb.y + lb.h]].map(([dx, dy]) => rotateOffset(dx, dy, rot));
  const xs = corners.map((c) => part.at.x + c.x), ys = corners.map((c) => part.at.y + c.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/**
 * Build <g data-part> for a part. `opts.ghost` strips data attributes that
 * would otherwise be picked up by hit-testing / net maps.
 */
function drawPart(part, { board, otherParts, nodeIndex, ghost = false, invalid = null } = {}) {
  const def = partDef(part.type);
  const props = mergedProps(def, part);
  const rot = part.rot || 0;
  const bench = def && def.mount === 'bench';
  const root = g({ class: `part ${bench ? 'bench' : 'through'}`, 'data-part': ghost ? null : part.id, 'data-type': part.type });

  const drawer = BODY_DRAWERS[part.type] || (bench ? drawGenericBench : drawGenericThrough);
  const body = drawer(part, def, props, rot);
  body.setAttribute('transform', `translate(${fmt(P(part.at.x))} ${fmt(P(part.at.y))}) rotate(${rot})`);
  if (bench) root.appendChild(g({}, [el('rect', { class: 'module-shadow np', x: P(part.at.x) + 3, y: P(part.at.y) + 4, width: P(localBody(def, props).w), height: P(localBody(def, props).h), rx: P(0.25), transform: `rotate(${rot} ${fmt(P(part.at.x))} ${fmt(P(part.at.y))})` })]));
  root.appendChild(body);

  // Pins / terminals (absolute coordinates; on top of the body)
  const pinsG = g({ class: 'pins' });
  for (const p of partPins(part, def)) {
    if (nodeIndex) nodeIndex.set(p.nodeId, { x: p.x, y: p.y });
    const cls = p.through === false || bench ? 'terminal' : 'pin';
    pinsG.appendChild(circle(p.x, p.y, 0.3, { class: cls, 'data-node': ghost ? null : p.nodeId, 'data-pin': p.name }));
    if (!ghost) pinsG.appendChild(circle(p.x, p.y, 0.45, { class: 'hit', 'data-node': p.nodeId }));
    if (p.offGrid) pinsG.appendChild(upright(p.x, p.y + 0.6, p.label || p.name, 0, { class: 'value-text', style: 'font-size:4.2px' }));
  }
  root.appendChild(pinsG);

  // Placement validity (through-hole only)
  let problems = invalid;
  if (problems === null && !ghost && !bench && board) {
    try { const v = validatePlacement(part, board, otherParts || []); problems = v && !v.ok ? (v.problems || []) : []; } catch { problems = []; }
  }
  const ab = absBody(part, def, props);
  const outline = rect(ab.x - 0.15, ab.y - 0.15, ab.w + 0.3, ab.h + 0.3, { rx: P(0.2), class: 'invalid-outline' });
  root.appendChild(outline);
  if (problems && problems.length) {
    root.classList.add('invalid');
    root.appendChild(el('title', { text: problems.map((p) => `${p.pin || ''} ${p.code || ''}`.trim()).join(', ') }));
  }
  return root;
}

// ---------------------------------------------------------------------------
// Wires & bridges
// ---------------------------------------------------------------------------

function drawWire(w, a, b) {
  const c = wireControl(a, b, w.mid);
  const d = quadPath(a, c, b);
  const root = g({ class: `wire-g ${w.kind === 'plug' ? 'plug' : ''}`, 'data-wire-g': w.id });
  if (w.kind === 'plug') {
    root.appendChild(el('path', { class: 'plug-band', d, 'data-wire': w.id }));
    // 5 stripes, offset perpendicular to the chord (approximate parallel curves)
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    PLUG_STRIPES.forEach((col, i) => {
      const o = (i - 2) * (1.9 / PITCH_PX);
      const sh = (p) => ({ x: p.x + nx * o, y: p.y + ny * o });
      root.appendChild(el('path', { class: 'plug-stripe np', stroke: col, d: quadPath(sh(a), sh(c), sh(b)) }));
    });
  } else {
    const hex = wireHex(w.color);
    root.appendChild(el('path', { class: 'wire-shadow np', d }));
    root.appendChild(el('path', { class: 'wire', d, stroke: hex, 'data-wire': w.id }));
    root.appendChild(circle(a.x, a.y, 0.25, { class: 'wire-dot np', fill: hex }));
    root.appendChild(circle(b.x, b.y, 0.25, { class: 'wire-dot np', fill: hex }));
  }
  root.appendChild(el('path', { class: 'hit-path', d, 'data-wire': w.id }));
  return root;
}

function drawBridge(br, a, b) {
  const root = g({ class: 'bridge-g', 'data-bridge-g': br.id });
  root.appendChild(line(a.x, a.y, b.x, b.y, { class: 'bridge', 'data-bridge': br.id }));
  root.appendChild(line(a.x, a.y, b.x, b.y, { class: 'bridge-hi' }));
  return root;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const LEVEL_CLASS = { GND: 'lv-gnd', VCC: 'lv-vcc', HIGH: 'lv-high', CONFLICT: 'lv-conflict' };
const LEVEL_CLASSES = ['lv-gnd', 'lv-vcc', 'lv-high', 'lv-low', 'lv-conflict'];
const SIM_PART_CLASSES = ['conducting', 'energized', 'powered', 'alive', 'plugged', 'forward'];

export function createRenderer(svgEl, store) {
  const svg = svgEl;
  const viewport = svg.querySelector('#viewport') || svg;
  const layers = {};
  for (const id of LAYER_IDS) {
    let node = svg.querySelector(`#layer-${id}`);
    if (!node) { node = g({ id: `layer-${id}` }); viewport.appendChild(node); }
    layers[id] = node;
  }
  // Overlay sub-groups so ghost / rubber band / selection can be cleared independently
  const ov = { ghost: g({ class: 'ov-ghost' }), rubber: g({ class: 'ov-rubber' }), sel: g({ class: 'ov-sel' }) };
  for (const k of ['ghost', 'rubber', 'sel']) layers.overlay.appendChild(ov[k]);

  // Inject stylesheet so exports carry it
  let styleEl = svg.querySelector('#svg-style');
  if (!styleEl) { styleEl = el('style', { id: 'svg-style' }); svg.insertBefore(styleEl, svg.firstChild); }
  styleEl.textContent = SVG_CSS;
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', NS);

  // State
  let view = { tx: 40, ty: 120, scale: 1 };
  let nodeIndex = new Map();           // nodeId → {x,y} grid
  let netElems = new Map();            // netId → [Element] (holes/pins/terminals)
  let netWires = new Map();            // netId → [Element] (wire paths)
  let currentNet = null;
  let simResult = null;
  let lastProject = null;
  let lastBoard = null;
  let lastNetlist = null;

  const uiView = store && store.ui && store.ui.view;
  if (uiView && isFinite(uiView.tx) && isFinite(uiView.ty) && isFinite(uiView.scale)) view = { ...uiView };
  applyViewTransform();

  function applyViewTransform() {
    viewport.setAttribute('transform', `translate(${fmt(view.tx)} ${fmt(view.ty)}) scale(${fmt(view.scale)})`);
  }

  function derived() {
    try { return store.derived() || {}; } catch { return {}; }
  }

  // ---- full render ---------------------------------------------------------
  function render(project = store.get()) {
    const d = derived();
    const board = d.board, netlist = d.netlist;
    lastProject = project; lastBoard = board; lastNetlist = netlist;
    nodeIndex = new Map();
    for (const id of CONTENT_LAYERS) clear(layers[id]);
    clear(layers.highlight);

    if (board) renderBoard(layers.bench, layers.board, board, nodeIndex);

    const parts = project.parts || [];
    for (const part of parts) {
      const def = partDef(part.type);
      const node = drawPart(part, { board, otherParts: parts.filter((p) => p.id !== part.id), nodeIndex });
      (def && def.mount === 'bench' ? layers.modules : layers.parts).appendChild(node);
    }
    for (const br of project.bridges || []) {
      const a = nodePosition(br.a), b = nodePosition(br.b);
      if (a && b) layers.bridges.appendChild(drawBridge(br, a, b));
    }
    for (const w of project.wires || []) {
      const a = nodePosition(w.a), b = nodePosition(w.b);
      if (a && b) layers.wires.appendChild(drawWire(w, a, b));
    }
    buildNetMaps(netlist);
    if (currentNet) highlightNet(currentNet);
    if (simResult) applySim(simResult);
  }

  function buildNetMaps(netlist) {
    netElems = new Map(); netWires = new Map();
    if (!netlist || !netlist.netOf) return;
    const add = (map, key, elm) => { if (!map.has(key)) map.set(key, []); map.get(key).push(elm); };
    for (const id of ['board', 'parts', 'modules']) {
      for (const elm of layers[id].querySelectorAll('[data-node]')) {
        if (elm.classList.contains('hit')) continue;
        const net = netlist.netOf.get(elm.getAttribute('data-node'));
        if (net) add(netElems, net.id, elm);
      }
    }
    for (const elm of layers.wires.querySelectorAll('.wire[data-wire], .plug-band[data-wire]')) {
      const w = (lastProject.wires || []).find((x) => x.id === elm.getAttribute('data-wire'));
      const net = w && netlist.netOf.get(w.a);
      if (net) add(netWires, net.id, elm);
    }
  }

  // ---- net highlight -------------------------------------------------------
  function highlightNet(netId) {
    for (const elm of svg.querySelectorAll('.hl')) elm.classList.remove('hl');
    clear(layers.highlight);
    currentNet = netId || null;
    if (!currentNet) return;
    for (const elm of netElems.get(currentNet) || []) {
      elm.classList.add('hl');
      const cx = parseFloat(elm.getAttribute('cx')), cy = parseFloat(elm.getAttribute('cy'));
      if (isFinite(cx) && isFinite(cy)) layers.highlight.appendChild(el('circle', { cx, cy, r: P(0.55), class: 'halo' }));
    }
    for (const elm of netWires.get(currentNet) || []) elm.classList.add('hl');
  }

  // ---- simulation visuals --------------------------------------------------
  function applySim(result) {
    simResult = result || null;
    // clear
    for (const elm of svg.querySelectorAll('.' + LEVEL_CLASSES.join(', .'))) elm.classList.remove(...LEVEL_CLASSES);
    for (const elm of svg.querySelectorAll('.ind.on')) elm.classList.remove('on');
    for (const elm of layers.parts.children) elm.classList.remove(...SIM_PART_CLASSES);
    for (const elm of layers.modules.children) elm.classList.remove(...SIM_PART_CLASSES);
    for (const elm of svg.querySelectorAll('[data-rotor], [data-horn]')) elm.removeAttribute('transform');
    if (!simResult) return;

    // net levels → node colors
    const levels = simResult.netLevel;
    if (levels && typeof levels.forEach === 'function') {
      levels.forEach((level, netId) => {
        const cls = LEVEL_CLASS[level];
        if (!cls) return;
        for (const elm of netElems.get(netId) || []) elm.classList.add(cls);
      });
    }
    // per-part state
    const partsState = simResult.parts || {};
    for (const [id, st] of Object.entries(partsState)) {
      const node = svg.querySelector(`[data-part="${cssEscape(id)}"]`);
      if (!node || !st) continue;
      for (const k of SIM_PART_CLASSES) if (st[k]) node.classList.add(k);
      // indicators (ULN LEDs): leds may be {LED_A:bool} | {OUT1:bool} | bool[]; fallback to `out`
      const part = (lastProject && lastProject.parts || []).find((p) => p.id === id);
      const def = part && partDef(part.type);
      const inds = (def && def.indicators) || [];
      inds.forEach((ind, i) => {
        let on = false;
        const leds = st.leds, out = st.out;
        if (Array.isArray(leds)) on = !!leds[i];
        else if (leds && typeof leds === 'object') on = !!(leds[ind.id] ?? leds[ind.pin] ?? leds[String.fromCharCode(65 + i)]);
        else if (Array.isArray(out)) on = !!out[i];
        else if (out && typeof out === 'object') on = !!out[ind.pin];
        const led = node.querySelector(`[data-ind="${cssEscape(`${id}:${ind.id}`)}"]`);
        if (led) led.classList.toggle('on', on);
      });
      // rotor / horn
      const rotor = node.querySelector('[data-rotor]');
      if (rotor && isFinite(st.rotorAngle)) rotor.setAttribute('transform', `rotate(${fmt(st.rotorAngle)} ${rotor.getAttribute('data-cx')} ${rotor.getAttribute('data-cy')})`);
      const horn = node.querySelector('[data-horn]');
      if (horn && isFinite(st.angle)) horn.setAttribute('transform', `rotate(${fmt(st.angle - 90)} ${horn.getAttribute('data-cx')} ${horn.getAttribute('data-cy')})`);
    }
  }

  function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'); }

  // ---- geometry / hit-testing ----------------------------------------------
  /** Grid position of a node id (hole, rail hole, pin/terminal), or null. */
  function nodePosition(nodeId) {
    if (!nodeId) return null;
    const hit = nodeIndex.get(nodeId);
    if (hit) return { x: hit.x, y: hit.y };
    let parsed = null;
    try { parsed = parseNodeId(nodeId); } catch { parsed = null; }
    const board = lastBoard || derived().board;
    if (parsed && (parsed.kind === 'hole' || parsed.kind === 'rail')) return board ? holeXY(board, nodeId) : null;
    const project = lastProject || store.get();
    const m = /^p:([^:]+):(.+)$/.exec(nodeId);
    const partId = parsed && parsed.partId ? parsed.partId : m && m[1];
    const pinName = parsed && (parsed.pin || parsed.pinName) ? (parsed.pin || parsed.pinName) : m && m[2];
    const part = (project.parts || []).find((p) => p.id === partId);
    if (!part) return null;
    const pin = partPins(part, partDef(part.type)).find((p) => p.name === pinName);
    return pin ? { x: pin.x, y: pin.y } : null;
  }

  /** Client (screen) coordinates → grid units inside #viewport. */
  function toSvgPoint(clientX, clientY) {
    const ctm = viewport.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const inv = ctm.inverse();
    const pt = typeof DOMPoint !== 'undefined' ? new DOMPoint(clientX, clientY).matrixTransform(inv)
      : (() => { const p = svg.createSVGPoint(); p.x = clientX; p.y = clientY; return p.matrixTransform(inv); })();
    return { x: pt.x / PITCH_PX, y: pt.y / PITCH_PX };
  }

  /** Nearest hole within 0.5 grid units, as {id,x,y,…}, or null. */
  function snapToHole(x, y) {
    const board = lastBoard || derived().board;
    if (!board || !board.holeAt) return null;
    const rx = Math.round(x), ry = Math.round(y);
    if (Math.hypot(x - rx, y - ry) > 0.5) return null;
    const h = board.holeAt(rx, ry);
    if (!h) return null;
    if (typeof h === 'string') return (board.holeById && board.holeById(h)) || { id: h, x: rx, y: ry };
    return h;
  }

  // ---- view ----------------------------------------------------------------
  function getView() { return { ...view }; }
  function setView(v, persist = true) {
    view = {
      tx: isFinite(v.tx) ? v.tx : view.tx,
      ty: isFinite(v.ty) ? v.ty : view.ty,
      scale: Math.min(4, Math.max(0.3, isFinite(v.scale) ? v.scale : view.scale)),
    };
    applyViewTransform();
    if (persist && store && typeof store.setUi === 'function') { try { store.setUi({ view: { ...view } }); } catch { /* ignore */ } }
  }

  /** Union bbox (px, viewport space) of the content layers. */
  function contentBBox() {
    let box = null;
    for (const id of CONTENT_LAYERS) {
      if (!layers[id].firstChild) continue;
      let b; try { b = layers[id].getBBox(); } catch { continue; }
      if (!b || !(b.width || b.height)) continue;
      box = box ? {
        x: Math.min(box.x, b.x), y: Math.min(box.y, b.y),
        x2: Math.max(box.x2, b.x + b.width), y2: Math.max(box.y2, b.y + b.height),
      } : { x: b.x, y: b.y, x2: b.x + b.width, y2: b.y + b.height };
    }
    return box ? { x: box.x, y: box.y, w: box.x2 - box.x, h: box.y2 - box.y } : { x: 0, y: 0, w: P(32), h: P(16) };
  }

  function fitView(margin = 40) {
    const r = svg.getBoundingClientRect();
    const W = r.width || svg.clientWidth || 800, H = r.height || svg.clientHeight || 600;
    const bb = contentBBox();
    const scale = Math.min(4, Math.max(0.3, Math.min((W - 2 * margin) / bb.w, (H - 2 * margin) / bb.h)));
    setView({ scale, tx: (W - bb.w * scale) / 2 - bb.x * scale, ty: (H - bb.h * scale) / 2 - bb.y * scale });
  }

  // ---- overlay helpers (interact.js) ---------------------------------------
  function showGhost(part, valid = true) {
    clear(ov.ghost);
    if (!part) return;
    const def = partDef(part.type);
    const node = drawPart(part, { ghost: true, invalid: [] });
    node.classList.add('ghost', valid ? 'valid' : 'invalid');
    const ab = absBody(part, def, mergedProps(def, part));
    node.appendChild(rect(ab.x - 0.2, ab.y - 0.2, ab.w + 0.4, ab.h + 0.4, { rx: P(0.2), class: 'ghost-outline' }));
    ov.ghost.appendChild(node);
  }

  function showRubberBand(from, to, color = 'red') {
    clear(ov.rubber);
    if (!from) return;
    const hex = wireHex(color);
    const end = to || from;
    ov.rubber.appendChild(line(from.x, from.y, end.x, end.y, { class: 'rubber', stroke: hex }));
    ov.rubber.appendChild(circle(from.x, from.y, 0.28, { class: 'rubber-dot' }));
    if (to) ov.rubber.appendChild(circle(to.x, to.y, 0.22, { class: 'rubber-dot', fill: hex }));
  }

  function showSelection(selection) {
    clear(ov.sel);
    if (!selection || !selection.id) return;
    const project = lastProject || store.get();
    if (selection.kind === 'part') {
      const part = (project.parts || []).find((p) => p.id === selection.id);
      if (!part) return;
      const def = partDef(part.type);
      const ab = absBody(part, def, mergedProps(def, part));
      ov.sel.appendChild(rect(ab.x - 0.25, ab.y - 0.25, ab.w + 0.5, ab.h + 0.5, { rx: P(0.25), class: 'sel-outline' }));
    } else if (selection.kind === 'wire') {
      const w = (project.wires || []).find((x) => x.id === selection.id);
      if (!w) return;
      const a = nodePosition(w.a), b = nodePosition(w.b);
      if (!a || !b) return;
      const c = wireControl(a, b, w.mid);
      ov.sel.appendChild(el('path', { class: 'sel-wire', d: quadPath(a, c, b) }));
      const hp = quadMid(a, c, b);                 // always on the curve (t = .5)
      ov.sel.appendChild(circle(hp.x, hp.y, 0.3, { class: 'mid-handle', 'data-mid-handle': w.id }));
    } else if (selection.kind === 'bridge') {
      const br = (project.bridges || []).find((x) => x.id === selection.id);
      if (!br) return;
      const a = nodePosition(br.a), b = nodePosition(br.b);
      if (!a || !b) return;
      const x = Math.min(a.x, b.x) - 0.45, y = Math.min(a.y, b.y) - 0.45;
      ov.sel.appendChild(rect(x, y, Math.abs(a.x - b.x) + 0.9, Math.abs(a.y - b.y) + 0.9, { rx: P(0.3), class: 'sel-outline' }));
    }
  }

  function clearOverlay() { clear(ov.ghost); clear(ov.rubber); clear(ov.sel); }

  // ---- export --------------------------------------------------------------
  function exportSvgString(margin = 24) {
    const bb = contentBBox();
    const clone = svg.cloneNode(true);
    clone.removeAttribute('style'); clone.removeAttribute('class');
    for (const id of ['layer-overlay', 'layer-highlight']) { const n = clone.querySelector(`#${id}`); if (n) n.remove(); }
    for (const n of clone.querySelectorAll('.hl')) n.classList.remove('hl');
    for (const n of clone.querySelectorAll('.hit, .hit-path')) n.remove();
    const vp = clone.querySelector('#viewport');
    if (vp) vp.setAttribute('transform', `translate(${fmt(-bb.x + margin)} ${fmt(-bb.y + margin)})`);
    const w = Math.ceil(bb.w + 2 * margin), h = Math.ceil(bb.h + 2 * margin);
    clone.setAttribute('xmlns', NS);
    clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    const bg = el('rect', { x: 0, y: 0, width: w, height: h, fill: '#ffffff' });
    const style = clone.querySelector('#svg-style');
    if (style) { style.textContent = SVG_CSS; style.after(bg); } else { clone.insertBefore(el('style', { id: 'svg-style', text: SVG_CSS }), clone.firstChild); clone.insertBefore(bg, clone.children[1] || null); }
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  }

  return {
    render, highlightNet, applySim, nodePosition, toSvgPoint, snapToHole,
    getView, setView, fitView,
    showGhost, showRubberBand, showSelection, clearOverlay,
    exportSvgString,
    /** Layer groups, exposed for debugging / panels. */
    layers,
  };
}
