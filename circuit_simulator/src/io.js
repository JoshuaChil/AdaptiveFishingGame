// io.js — JSON export/import (+validation), file downloads, SVG/PNG snapshots,
// Markdown wiring list + BOM, and a node describer shared with panels.js.
import { PART_LIBRARY, partDef, resolvePins } from './parts.js';

export const BOARD_KINDS = ['mini', 'half', 'dual', 'full'];
const ROTATIONS = [0, 90, 180, 270];
const RAIL_WORDS = { tp: 'top + rail', tm: 'top − rail', bp: 'bottom + rail', bm: 'bottom − rail' };
const RAIL_SHORT = { tp: 'T+', tm: 'T−', bp: 'B+', bm: 'B−' };
const ROW_ORDER = 'abcdefghijklmnopqrst';
const ROLE_RANK = {
  gpio: 0, power: 1, supply: 1, gnd: 2,
  gate: 3, drain: 3, source: 3,
  anode: 4, cathode: 4, signal: 4, input: 4, power_in: 4,
  lead: 5, connector: 6, passive: 7, battery: 8,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function fail(msg) { throw new Error(msg); }

export function knownPartType(type) {
  if (typeof type !== 'string') return false;
  try {
    if (PART_LIBRARY instanceof Map) return PART_LIBRARY.has(type);
    if (Array.isArray(PART_LIBRARY)) return PART_LIBRARY.some((d) => d && d.type === type);
    if (isObj(PART_LIBRARY) && Object.prototype.hasOwnProperty.call(PART_LIBRARY, type)) return true;
  } catch { /* fall through */ }
  try { return !!partDef(type); } catch { return false; }
}

export function safePartDef(type) {
  try { return partDef(type) || null; } catch { return null; }
}

/** Parse an opaque node id into {kind:'hole'|'rail'|'pin', …} or null. */
export function parseNode(id) {
  if (typeof id !== 'string') return null;
  const seg = id.split(':');
  if (seg[0] === 'h' && seg.length === 2) {
    const m = /^([a-t])(\d{1,3})$/.exec(seg[1]);
    return m ? { kind: 'hole', row: m[1], col: Number(m[2]) } : null;
  }
  if (seg[0] === 'r' && seg.length === 3) {
    const col = Number(seg[2]);
    if (!RAIL_WORDS[seg[1]] || !Number.isInteger(col)) return null;
    return { kind: 'rail', rail: seg[1], col };
  }
  if (seg[0] === 'p' && seg.length >= 3 && seg[1]) {
    return { kind: 'pin', partId: seg[1], pin: seg.slice(2).join(':') };
  }
  return null;
}

function idOf(h) { return typeof h === 'string' ? h : (h && typeof h === 'object' ? h.id ?? null : null); }

/** Fallback display label when board.label is unavailable. */
export function fallbackLabel(nodeId) {
  const p = parseNode(nodeId);
  if (!p) return String(nodeId);
  if (p.kind === 'hole') return `${p.row}${p.col}`;
  if (p.kind === 'rail') return `${RAIL_SHORT[p.rail]} ${p.col}`;
  return `${p.partId}.${p.pin}`;
}

// ---------------------------------------------------------------------------
// JSON export / import
// ---------------------------------------------------------------------------

export function exportJson(project) {
  const copy = JSON.parse(JSON.stringify(project));
  copy.version = 1;
  copy.meta = { ...(copy.meta || {}), modified: Date.now() };
  if (!copy.meta.name) copy.meta.name = 'Untitled';
  return JSON.stringify(copy, null, 2);
}

/** Parse + validate project JSON text. Throws Error with a helpful message. */
export function importJson(text) {
  let raw;
  try {
    raw = JSON.parse(typeof text === 'string' ? text : String(text));
  } catch (e) {
    fail(`Not valid JSON: ${e.message}`);
  }
  if (!isObj(raw)) fail('Project file must be a JSON object at the top level.');
  if (raw.version !== 1) fail(`Unsupported project version ${JSON.stringify(raw.version)} (expected 1).`);

  // meta
  const metaIn = isObj(raw.meta) ? raw.meta : {};
  const meta = {
    name: typeof metaIn.name === 'string' && metaIn.name.trim() ? metaIn.name : 'Untitled',
    modified: isNum(metaIn.modified) ? metaIn.modified : Date.now(),
  };

  // board
  if (!isObj(raw.board)) fail('Missing "board" object.');
  if (!BOARD_KINDS.includes(raw.board.kind)) {
    fail(`board.kind must be one of ${BOARD_KINDS.join(', ')} (got ${JSON.stringify(raw.board.kind)}).`);
  }
  const board = { kind: raw.board.kind, railSplit: raw.board.railSplit === true };

  // parts
  if (!Array.isArray(raw.parts)) fail('"parts" must be an array.');
  const partIds = new Set();
  const parts = raw.parts.map((p, i) => {
    const where = `parts[${i}]${isObj(p) && typeof p.id === 'string' ? ` (${p.id})` : ''}`;
    if (!isObj(p)) fail(`${where} must be an object.`);
    if (typeof p.id !== 'string' || !p.id) fail(`${where} is missing a string "id".`);
    if (partIds.has(p.id)) fail(`Duplicate part id "${p.id}".`);
    partIds.add(p.id);
    if (!knownPartType(p.type)) fail(`${where} has unknown part type ${JSON.stringify(p.type)}.`);
    if (!isObj(p.at) || !isNum(p.at.x) || !isNum(p.at.y)) fail(`${where} needs "at": {x, y} with numeric coordinates.`);
    const rot = p.rot == null ? 0 : p.rot;
    if (!ROTATIONS.includes(rot)) fail(`${where} has invalid rotation ${JSON.stringify(p.rot)} (use 0, 90, 180 or 270).`);
    if (p.props != null && !isObj(p.props)) fail(`${where} "props" must be an object.`);
    return { id: p.id, type: p.type, at: { x: p.at.x, y: p.at.y }, rot, props: { ...(p.props || {}) } };
  });

  // wires
  const wiresIn = raw.wires == null ? [] : raw.wires;
  if (!Array.isArray(wiresIn)) fail('"wires" must be an array.');
  const wireIds = new Set();
  const wires = wiresIn.map((w, i) => {
    const where = `wires[${i}]${isObj(w) && typeof w.id === 'string' ? ` (${w.id})` : ''}`;
    if (!isObj(w)) fail(`${where} must be an object.`);
    if (typeof w.id !== 'string' || !w.id) fail(`${where} is missing a string "id".`);
    if (wireIds.has(w.id)) fail(`Duplicate wire id "${w.id}".`);
    wireIds.add(w.id);
    const kind = w.kind == null ? 'wire' : w.kind;
    if (kind !== 'wire' && kind !== 'plug') fail(`${where} has invalid kind ${JSON.stringify(w.kind)} (use "wire" or "plug").`);
    for (const end of ['a', 'b']) {
      if (!parseNode(w[end])) {
        fail(`${where} endpoint "${end}" = ${JSON.stringify(w[end])} is not a node id (expected h:c5, r:tp:3 or p:PART:PIN).`);
      }
    }
    if (kind === 'plug') {
      if (parseNode(w.a).kind !== 'pin' || parseNode(w.b).kind !== 'pin') fail(`${where} is a plug but its endpoints are not part pins.`);
    }
    let mid = null;
    if (w.mid != null) {
      if (!isObj(w.mid) || !isNum(w.mid.x) || !isNum(w.mid.y)) fail(`${where} "mid" must be {x, y} or null.`);
      mid = { x: w.mid.x, y: w.mid.y };
    }
    const color = typeof w.color === 'string' && w.color ? w.color : (kind === 'plug' ? 'grey' : 'red');
    return { id: w.id, kind, a: w.a, b: w.b, color, mid };
  });

  // bridges
  const bridgesIn = raw.bridges == null ? [] : raw.bridges;
  if (!Array.isArray(bridgesIn)) fail('"bridges" must be an array.');
  const bridgeIds = new Set();
  const bridges = bridgesIn.map((b, i) => {
    const where = `bridges[${i}]${isObj(b) && typeof b.id === 'string' ? ` (${b.id})` : ''}`;
    if (!isObj(b)) fail(`${where} must be an object.`);
    if (typeof b.id !== 'string' || !b.id) fail(`${where} is missing a string "id".`);
    if (bridgeIds.has(b.id)) fail(`Duplicate bridge id "${b.id}".`);
    bridgeIds.add(b.id);
    for (const end of ['a', 'b']) {
      const n = parseNode(b[end]);
      if (!n || n.kind !== 'hole') fail(`${where} endpoint "${end}" = ${JSON.stringify(b[end])} must be a strip hole (h:c5).`);
    }
    return { id: b.id, a: b.a, b: b.b };
  });

  return { version: 1, meta, board, parts, wires, bridges };
}

// ---------------------------------------------------------------------------
// Downloads / snapshots
// ---------------------------------------------------------------------------

export function downloadFile(filename, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function exportSvg(renderer, filename = 'protoplanner.svg') {
  const svg = renderer.exportSvgString();
  downloadFile(filename, svg, 'image/svg+xml;charset=utf-8');
  return svg;
}

function svgSize(svgText) {
  const open = /<svg\b[^>]*>/i.exec(svgText);
  if (!open) return { width: 0, height: 0 };
  const tag = open[0];
  const num = (attr) => {
    const m = new RegExp(`\\s${attr}="([\\d.]+)(?:px)?"`, 'i').exec(tag);
    return m ? parseFloat(m[1]) : 0;
  };
  let width = num('width');
  let height = num('height');
  if (!width || !height) {
    const vb = /\sviewBox="([^"]+)"/i.exec(tag);
    if (vb) {
      const v = vb[1].trim().split(/[\s,]+/).map(Number);
      if (v.length === 4) { width = width || v[2]; height = height || v[3]; }
    }
  }
  return { width, height };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not rasterize the SVG (image failed to load).'));
    img.src = url;
  });
}

/** Blob URL → Image → <canvas> (scale×) → toBlob → download. Returns a Promise. */
export async function exportPng(renderer, filename = 'protoplanner.png', scale = 2) {
  const svg = renderer.exportSvgString();
  const size = svgSize(svg);
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    if (typeof img.decode === 'function') { try { await img.decode(); } catch { /* Safari may reject; onload already fired */ } }
    const baseW = size.width || img.naturalWidth || img.width || 800;
    const baseH = size.height || img.naturalHeight || img.height || 600;
    const w = Math.max(1, Math.round(baseW * scale));
    const h = Math.max(1, Math.round(baseH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const png = await new Promise((resolve, reject) => {
      try {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed.'))), 'image/png');
      } catch (e) { reject(e); }
    });
    downloadFile(filename, png, 'image/png');
    return png;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

// ---------------------------------------------------------------------------
// Node describer (shared by the Markdown export and the properties panel)
// ---------------------------------------------------------------------------

/**
 * createNodeDescriber(project, {board, netlist}) → {
 *   describe(nodeId)  "XIAO D0 strip (j1)" | "top + rail (T+ 3)" | "DRV1 IN1" | "Q1 gate pin (h12)"
 *   label(nodeId)     "j1" | "T+ 3"
 *   netOf(nodeId), netName(nodeId), pinPhrase(part, pin), holeIdAt(x, y), pinsOf(partId), stripPins(holeId)
 * }
 */
export function createNodeDescriber(project, derived = {}) {
  const board = derived.board || null;
  const netlist = derived.netlist || null;
  const parts = Array.isArray(project?.parts) ? project.parts : [];
  const partById = new Map(parts.map((p) => [p.id, p]));
  const xiaoCount = parts.filter((p) => p.type === 'xiao_esp32c3').length;
  const pinsByPart = new Map();
  const holePins = new Map(); // holeId → [{part, pin}]

  function holeIdAt(x, y) {
    if (!board || typeof board.holeAt !== 'function') return null;
    try { return idOf(board.holeAt(x, y)); } catch { return null; }
  }

  for (const part of parts) {
    let pins = [];
    try { pins = resolvePins(part) || []; } catch { pins = []; }
    pinsByPart.set(part.id, pins);
    for (const pin of pins) {
      if (pin.hidden || pin.offGrid || !pin.through) continue;
      const hid = holeIdAt(pin.x, pin.y);
      if (!hid) continue;
      if (!holePins.has(hid)) holePins.set(hid, []);
      holePins.get(hid).push({ part, pin });
    }
  }

  function label(nodeId) {
    if (board && typeof board.label === 'function') {
      try {
        const l = board.label(nodeId);
        if (typeof l === 'string' && l) return l;
      } catch { /* fall through */ }
    }
    return fallbackLabel(nodeId);
  }

  function stripMembers(holeId) {
    if (board && typeof board.stripOf === 'function' && typeof board.stripMembers === 'function') {
      try {
        const sid = board.stripOf(holeId);
        const m = sid ? board.stripMembers(sid) : null;
        if (Array.isArray(m) && m.length) return m.map(idOf).filter(Boolean);
      } catch { /* fall through */ }
    }
    return [holeId];
  }

  function rank(pin) {
    const r = ROLE_RANK[pin?.role];
    return r == null ? 5 : r;
  }

  /** Pins physically soldered on the same strip as holeId, most informative first. */
  function stripPins(holeId) {
    const out = [];
    for (const hid of stripMembers(holeId)) for (const e of holePins.get(hid) || []) out.push(e);
    out.sort((a, b) => rank(a.pin) - rank(b.pin));
    return out;
  }

  function pinPhrase(part, pin) {
    const name = pin?.name ?? '?';
    if (part.type === 'xiao_esp32c3') return xiaoCount > 1 ? `XIAO ${part.id} ${name}` : `XIAO ${name}`;
    const role = pin?.role;
    if (role === 'gate' || role === 'drain' || role === 'source' || role === 'anode' || role === 'cathode') return `${part.id} ${role}`;
    if (role === 'passive') return `${part.id} pin${name}`;
    if (role === 'lead') return `${part.id} lead ${name}`;
    return `${part.id} ${name}`;
  }

  function netOf(nodeId) {
    try { return netlist?.netOf?.get?.(nodeId) ?? null; } catch { return null; }
  }
  function netName(nodeId) { return netOf(nodeId)?.name ?? null; }
  function pinsOf(partId) { return pinsByPart.get(partId) || []; }

  function describe(nodeId) {
    const p = parseNode(nodeId);
    if (!p) return `unknown node ${String(nodeId)}`;
    if (p.kind === 'hole') {
      const best = stripPins(nodeId)[0];
      return best ? `${pinPhrase(best.part, best.pin)} strip (${label(nodeId)})` : `empty strip (${label(nodeId)})`;
    }
    if (p.kind === 'rail') return `${RAIL_WORDS[p.rail]} (${label(nodeId)})`;
    const part = partById.get(p.partId);
    if (!part) return `${p.partId} ${p.pin} (missing part)`;
    const def = safePartDef(part.type);
    const pin = pinsOf(part.id).find((q) => q.name === p.pin) || null;
    if (p.pin === 'PLUG') return `${part.type === 'stepper_28byj48' ? 'Stepper' : (def?.name || part.type)} ${part.id} plug`;
    if (p.pin === 'SOCKET') return `${part.id} socket`;
    if (pin && pin.through) {
      const hid = holeIdAt(pin.x, pin.y);
      return `${pinPhrase(part, pin)} pin${hid ? ` (${label(hid)})` : ''}`;
    }
    return pinPhrase(part, pin || { name: p.pin, role: '' });
  }

  return { describe, label, netOf, netName, pinPhrase, holeIdAt, pinsOf, stripPins, stripMembers, partById };
}

// ---------------------------------------------------------------------------
// Markdown wiring list
// ---------------------------------------------------------------------------

function mdCell(s) { return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }

function boardWords(b) {
  const names = { mini: 'Mini (17 columns, no rails)', half: 'Half-size (30 columns, 4 rails)', dual: 'Dual half (2 × 30-column blocks)', full: 'Full-size (63 columns, 4 rails)' };
  return `${names[b?.kind] || b?.kind || 'unknown'}${b?.railSplit ? ', rails split at the middle' : ''}`;
}

/** "c1–c7 / g1–g7" style compression of a list of hole ids. */
function compressHoles(holeIds) {
  const byRow = new Map();
  for (const id of holeIds) {
    const p = parseNode(id);
    if (!p || p.kind !== 'hole') continue;
    if (!byRow.has(p.row)) byRow.set(p.row, new Set());
    byRow.get(p.row).add(p.col);
  }
  const rows = [...byRow.keys()].sort((a, b) => ROW_ORDER.indexOf(a) - ROW_ORDER.indexOf(b));
  return rows.map((row) => {
    const cols = [...byRow.get(row)].sort((a, b) => a - b);
    const runs = [];
    let start = cols[0]; let prev = cols[0];
    for (let i = 1; i <= cols.length; i++) {
      const c = cols[i];
      if (c === prev + 1) { prev = c; continue; }
      runs.push(start === prev ? `${row}${start}` : `${row}${start}–${row}${prev}`);
      start = c; prev = c;
    }
    return runs.join(', ');
  }).join(' / ');
}

function usbDirection(rot) {
  return { 0: 'USB left', 180: 'USB right', 90: 'USB up', 270: 'USB down' }[rot] || `rot ${rot}`;
}

function partValueText(part, def) {
  const props = part.props || {};
  if (def && typeof def.bom === 'function') {
    try { const s = def.bom(props); if (s) return String(s); } catch { /* fall through */ }
  }
  const bits = [];
  if (props.value) bits.push(String(props.value));
  if (props.package) bits.push(String(props.package));
  if (props.partNumber) bits.push(String(props.partNumber));
  if (props.polarized) bits.push('polarized');
  if (props.voltage != null) bits.push(`${props.voltage} V`);
  if (props.label && part.type !== 'xiao_esp32c3') bits.push(String(props.label));
  if (part.type === 'xiao_esp32c3' && props.label) bits.push(String(props.label));
  if (part.type === 'uln2003') bits.push(props.jumper === false ? 'COM jumper open' : 'COM jumper closed');
  return bits.join(' ') || '—';
}

function partPositionText(part, def, D) {
  const pins = D.pinsOf(part.id);
  const through = pins.filter((p) => p.through && !p.hidden && !p.offGrid);
  if (def?.mount === 'bench' || (!through.length && pins.length)) {
    return `bench @ (${fmtNum(part.at?.x)}, ${fmtNum(part.at?.y)})`;
  }
  const holes = through.map((p) => D.holeIdAt(p.x, p.y)).filter(Boolean);
  let txt = holes.length ? compressHoles(holes) : `off-board @ (${fmtNum(part.at?.x)}, ${fmtNum(part.at?.y)})`;
  if (holes.length && holes.length < through.length) txt += ` (${through.length - holes.length} pin(s) off-board)`;
  if (part.type === 'xiao_esp32c3') txt += `, ${usbDirection(part.rot || 0)}`;
  return txt;
}

function fmtNum(n) { return isNum(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : '?'; }

function netHoleSummary(net, D) {
  const holes = Array.isArray(net.holes) ? net.holes.map(idOf).filter(Boolean)
    : (Array.isArray(net.members) ? net.members.filter((m) => { const p = parseNode(m); return p && p.kind !== 'pin'; }) : []);
  const groups = new Map(); // stripKey → ids
  for (const h of holes) {
    const p = parseNode(h);
    if (!p) continue;
    const key = p.kind === 'rail' ? `rail:${p.rail}` : `strip:${D.stripMembers(h).slice().sort().join(',')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  const out = [];
  for (const [key, ids] of groups) {
    if (key.startsWith('rail:')) { out.push(`${RAIL_SHORT[key.slice(5)]} rail`); continue; }
    const members = D.stripMembers(ids[0]);
    const sorted = members.slice().sort((a, b) => {
      const pa = parseNode(a); const pb = parseNode(b);
      return (ROW_ORDER.indexOf(pa.row) - ROW_ORDER.indexOf(pb.row)) || (pa.col - pb.col);
    });
    if (sorted.length > 1) out.push(`${D.label(sorted[0])}–${D.label(sorted[sorted.length - 1])}`);
    else out.push(D.label(sorted[0]));
  }
  return out;
}

function netIsInteresting(net, D) {
  const nPins = net.pins?.length || 0;
  const nHoles = Array.isArray(net.holes) ? net.holes.length : 0;
  if (nPins >= 2) return true;
  if (nPins === 1) return nHoles > 0; // a lone bench terminal / off-grid pad is not a net worth listing
  const keys = new Set();
  const holes = Array.isArray(net.holes) ? net.holes.map(idOf) : (net.members || []);
  for (const h of holes) {
    const p = parseNode(h);
    if (!p || p.kind === 'pin') continue;
    keys.add(p.kind === 'rail' ? `rail:${p.rail}` : `strip:${D.stripMembers(h).slice().sort()[0]}`);
    if (keys.size > 1) return true;
  }
  return false;
}

function netSortKey(net) {
  const n = net.name || '';
  if (n === 'GND') return '0';
  if (n === '5V' || n === 'V+' || n === '3V3') return `1${n}`;
  if (/^D\d+$/.test(n)) return `2${n.padStart(4, '0')}`;
  return `3${n}`;
}

/** Markdown wiring list: title, board, BOM, wires, bridges, nets, checks. derived = {board, netlist, issues}. */
export function wiringListMarkdown(project, derived = {}) {
  const D = createNodeDescriber(project, derived);
  const issues = Array.isArray(derived.issues) ? derived.issues : [];
  const name = project?.meta?.name || 'Untitled';
  const when = new Date(isNum(project?.meta?.modified) ? project.meta.modified : Date.now());
  const date = when.toISOString().slice(0, 10);
  const L = [];

  L.push(`# ${name} — wiring list`, '', `_Generated ${date} by ProtoPlanner_`, '');
  L.push(`**Board:** ${boardWords(project?.board)}  `);
  L.push(`**Parts:** ${project.parts.length} · **Wires:** ${project.wires.length} · **Solder bridges:** ${(project.bridges || []).length}`, '');

  // BOM
  L.push('## Bill of materials', '', '| Ref | Part | Value / Package | Position |', '|---|---|---|---|');
  for (const part of project.parts) {
    const def = safePartDef(part.type);
    L.push(`| ${mdCell(part.id)} | ${mdCell(def?.name || part.type)} | ${mdCell(partValueText(part, def))} | ${mdCell(partPositionText(part, def, D))} |`);
  }
  if (!project.parts.length) L.push('| — | (no parts) | | |');
  L.push('');

  // Wires
  L.push('## Wires', '');
  if (!project.wires.length) L.push('_No wires._');
  project.wires.forEach((w, i) => {
    const m = /^W(\d+)$/.exec(w.id || '');
    const n = m ? Number(m[1]) : i + 1;
    const net = D.netName(w.a) || D.netName(w.b);
    const netTxt = net ? ` — net ${net}` : '';
    if (w.kind === 'plug') {
      L.push(`${i + 1}. **Plug ${n}**: ${D.describe(w.a)} → ${D.describe(w.b)} (keyed 5-wire plug)`);
    } else {
      L.push(`${i + 1}. **Wire ${n}** (${w.color || 'uncolored'}): ${D.describe(w.a)} → ${D.describe(w.b)}${netTxt}`);
    }
  });
  L.push('');

  // Bridges
  L.push('## Solder bridges', '');
  const bridges = project.bridges || [];
  if (!bridges.length) L.push('_None._');
  bridges.forEach((b, i) => L.push(`${i + 1}. **${b.id}**: ${D.label(b.a)} ↔ ${D.label(b.b)}${D.netName(b.a) ? ` — net ${D.netName(b.a)}` : ''}`));
  L.push('');

  // Nets
  L.push('## Nets', '');
  const nets = (derived.netlist?.nets || []).filter((n) => netIsInteresting(n, D));
  nets.sort((a, b) => netSortKey(a).localeCompare(netSortKey(b)));
  if (!nets.length) L.push('_No connected nets._');
  for (const net of nets) {
    const pins = (net.pins || []).map((p) => `${p.partId}.${p.pin}`);
    const holes = netHoleSummary(net, D);
    const kind = net.kind && net.kind !== 'other' ? ` _(${net.kind})_` : '';
    const bits = [];
    if (pins.length) bits.push(`pins: ${pins.join(', ')}`);
    if (holes.length) bits.push(`holes: ${holes.join(', ')}`);
    L.push(`- **${net.name || net.id}**${kind} — ${bits.join('; ') || 'no members'}`);
  }
  L.push('');

  // Checks
  const count = (sev) => issues.filter((x) => x.severity === sev).length;
  L.push('## Design checks', '');
  L.push(`**${count('error')} errors · ${count('warn')} warnings · ${count('info')} infos**`, '');
  for (const sev of ['error', 'warn', 'info']) {
    for (const it of issues.filter((x) => x.severity === sev)) {
      L.push(`- ${sev.toUpperCase()} \`${it.code || ''}\` ${it.message || ''}`);
    }
  }
  if (!issues.length) L.push('_No issues._');
  L.push('');

  return L.join('\n');
}
