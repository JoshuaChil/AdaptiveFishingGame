// interact.js — pointer/keyboard state machine for the ProtoPlanner canvas.
// States: idle | placing | wiringFromA | draggingPart | draggingMid | panning.
// Every project mutation goes through store.commit(label, draft => …).

import { PITCH_PX, wirePathD, wireHandlePoint, controlForHandle } from './render.js';
import { partDef, resolvePins, rotateOffset, suggestAnchor, nextRefId, parseNodeId } from './parts.js';

const TOOL_KEYS = { v: 'select', w: 'wire', b: 'bridge' };
const TOOL_HINT = {
  select: 'Select: click to select · drag to move · R rotate · Del delete',
  wire: 'Wire: click the first hole or pin',
  bridge: 'Bridge: click a hole, then an adjacent hole',
  pan: 'Pan: drag to pan · wheel to zoom',
};
const DRAG_THRESHOLD = 0.15;         // grid units before a press becomes a drag
const ZOOM_MIN = 0.3, ZOOM_MAX = 4;

const isEditable = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
const snapHalf = (v) => Math.round(v * 2) / 2;

/** Lowest free `${prefix}${n}` among items with an `id`. */
function nextFreeId(prefix, items) {
  const used = new Set((items || []).map((it) => String(it.id)));
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}
function partRefId(def, parts) {
  try { const id = nextRefId(def.refPrefix, parts); if (id) return id; } catch { /* fall through */ }
  return nextFreeId(def.refPrefix || 'X', parts);
}
function mergedProps(def, part) { return { ...(def && def.props ? def.props : {}), ...(part && part.props ? part.props : {}) }; }

/** Local (rot-0) body rect for a part type: through → def.body(props); bench → size. */
function localBody(def, props) {
  if (def && def.mount === 'bench') return { x: 0, y: 0, w: (def.size && def.size.w) || 4, h: (def.size && def.size.h) || 4 };
  try { const b = def && def.body ? def.body(props) : null; if (b) return b; } catch { /* ignore */ }
  return { x: -0.5, y: -0.5, w: 1, h: 1 };
}
/** Rotated offset from the anchor to the body centre (so a fresh ghost hangs centred on the cursor). */
function centerOffset(def, props, rot) {
  const b = localBody(def, props);
  return rotateOffset(b.x + b.w / 2, b.y + b.h / 2, rot || 0);
}

export function attachInteractions(svgEl, store, renderer, { onStatus } = {}) {
  const svg = svgEl;
  const status = (msg) => { if (typeof onStatus === 'function') onStatus(msg || ''); };

  // ---- state ---------------------------------------------------------------
  let mode = 'idle';
  let placing = null;    // { type, def, props, rot, part, valid }
  let wireA = null;      // { nodeId, pos, bridge:boolean }
  let drag = null;       // { partId, def, bench, startPtr, startAt, rot, ghost, valid, moved }
  let midDrag = null;    // { wireId, a, b, mid, moved }
  let pan = null;        // { startX, startY, startView }
  let spaceHeld = false;
  let hoverNode = null;
  let lastPtr = { x: 0, y: 0 };
  let destroyed = false;

  // ---- accessors -----------------------------------------------------------
  const project = () => store.get();
  const derived = () => { try { return store.derived() || {}; } catch { return {}; } };
  const tool = () => (store.ui && store.ui.tool) || 'select';
  const ptr = (e) => renderer.toSvgPoint(e.clientX, e.clientY);
  const closestAttr = (e, sel, attr) => { const n = e.target && e.target.closest ? e.target.closest(sel) : null; return n ? n.getAttribute(attr) : null; };
  /** Node under the pointer. Wire hit-paths sit above holes and pins, so when the pointer is on a wire
   *  but within 0.6 grid units of one of its endpoints, resolve to that endpoint node (lets you hover or
   *  start a new wire from a hole that already has a wire soldered to it). */
  const nodeAt = (e) => {
    const direct = closestAttr(e, '[data-node]', 'data-node');
    if (direct) return direct;
    const wireId = closestAttr(e, '[data-wire]', 'data-wire');
    if (!wireId) return null;
    const w = findWire(wireId);
    if (!w) return null;
    const p = ptr(e);
    let best = null, bestD = 0.6;
    for (const end of [w.a, w.b]) {
      const pos = renderer.nodePosition(end);
      if (!pos) continue;
      const d = Math.hypot(pos.x - p.x, pos.y - p.y);
      if (d < bestD) { bestD = d; best = end; }
    }
    return best;
  };
  /** Wire under the pointer (id) when no node resolves. */
  const wireAt = (e) => closestAttr(e, '[data-wire]', 'data-wire');
  /** Geometric fallback for the wire/bridge tools: the pin or hole within 0.45 grid units of p,
   *  for when a wire's hit-path (which sits above the board) covers the hole the user is clicking. */
  function geomNodeAt(p) {
    let best = null, bestD = 0.45;
    for (const part of project().parts || []) {
      let pins = []; try { pins = resolvePins(part) || []; } catch { pins = []; }
      for (const pin of pins) {
        if (pin.hidden || pin.x == null || pin.y == null) continue;
        const d = Math.hypot(pin.x - p.x, pin.y - p.y);
        if (d < bestD) { bestD = d; best = pin.nodeId; }
      }
    }
    if (best) return best;
    const hole = renderer.snapToHole(p.x, p.y);
    return hole ? (typeof hole === 'string' ? hole : hole.id) : null;
  }
  const findPart = (id) => (project().parts || []).find((p) => p.id === id);
  const findWire = (id) => (project().wires || []).find((w) => w.id === id);

  /** What the pointer is over, in hit priority: mid handle > wire > bridge > part. */
  function targetAt(e) {
    const t = e.target;
    if (!t || !t.closest) return null;
    let n;
    if ((n = t.closest('[data-mid-handle]'))) return { kind: 'mid', id: n.getAttribute('data-mid-handle') };
    if ((n = t.closest('[data-wire]'))) return { kind: 'wire', id: n.getAttribute('data-wire') };
    if ((n = t.closest('[data-bridge]'))) return { kind: 'bridge', id: n.getAttribute('data-bridge') };
    if ((n = t.closest('[data-part]'))) return { kind: 'part', id: n.getAttribute('data-part') };
    return null;
  }

  function parseNode(nodeId) {
    try { const p = parseNodeId(nodeId); if (p) return p; } catch { /* fall through */ }
    if (nodeId.startsWith('h:')) return { kind: 'hole' };
    if (nodeId.startsWith('r:')) return { kind: 'rail' };
    const m = /^p:([^:]+):(.+)$/.exec(nodeId);
    return m ? { kind: 'pin', partId: m[1], pin: m[2] } : { kind: 'unknown' };
  }
  function pinOf(nodeId) {
    const p = parseNode(nodeId);
    if (p.kind !== 'pin') return null;
    const partId = p.partId || p.part, pinName = p.pin || p.pinName || p.name;
    const part = findPart(partId);
    if (!part) return null;
    let pins = []; try { pins = resolvePins(part) || []; } catch { pins = []; }
    return { part, pin: pins.find((x) => x.name === pinName) || null, pinName };
  }
  const isConnector = (nodeId) => { const r = pinOf(nodeId); return !!(r && r.pin && r.pin.connector); };
  const isStripHole = (nodeId) => parseNode(nodeId).kind === 'hole';

  function nodeLabel(nodeId) {
    const p = parseNode(nodeId);
    if (p.kind === 'pin') return `${p.partId || p.part}.${p.pin || p.pinName || p.name}`;
    const board = derived().board;
    try { if (board && board.label) return board.label(nodeId) || nodeId; } catch { /* ignore */ }
    return nodeId;
  }
  function netOf(nodeId) {
    const nl = derived().netlist;
    return nl && nl.netOf ? nl.netOf.get(nodeId) || null : null;
  }

  // ---- hover ---------------------------------------------------------------
  function setHover(nodeId) {
    if (nodeId === hoverNode) return;
    hoverNode = nodeId;
    if (!nodeId) { renderer.highlightNet(null); status(TOOL_HINT[tool()]); return; }
    if (nodeId.startsWith('w:')) {
      // Hovering the body of a wire: light up the net it belongs to.
      const w = findWire(nodeId.slice(2));
      const net = w ? (netOf(w.a) || netOf(w.b)) : null;
      renderer.highlightNet(net ? net.id : null);
      status(w ? `${w.id} (${w.color || w.kind})${net ? ` · net ${net.name || net.id}` : ''}` : TOOL_HINT[tool()]);
      return;
    }
    const net = netOf(nodeId);
    renderer.highlightNet(net ? net.id : null);
    status(`${nodeLabel(nodeId)}${net ? ` · net ${net.name || net.id}` : ''}`);
  }

  // ---- cursor --------------------------------------------------------------
  function updateCursor() {
    let c = 'default';
    if (mode === 'panning') c = 'grabbing';
    else if (spaceHeld || tool() === 'pan') c = 'grab';
    else if (mode === 'placing') c = 'copy';
    else if (mode === 'draggingPart' || mode === 'draggingMid') c = 'move';
    else if (tool() === 'wire' || tool() === 'bridge') c = 'crosshair';
    svg.style.cursor = c;
  }

  // ---- commits -------------------------------------------------------------
  function select(sel) {
    store.setUi({ selection: sel || null });
    renderer.showSelection(sel || null);
  }
  function commitPlace(part) {
    store.commit('place', (d) => { (d.parts || (d.parts = [])).push(part); });
    select({ kind: 'part', id: part.id });
    status(`Placed ${part.id}`);
  }
  function commitMove(partId, at) {
    store.commit('move', (d) => { const p = (d.parts || []).find((x) => x.id === partId); if (p) p.at = { x: at.x, y: at.y }; });
  }
  /** Centroid of a part's visible pins (grid units), or null. */
  function pinCentroid(part) {
    let pins = []; try { pins = resolvePins(part) || []; } catch { return null; }
    const vis = pins.filter((q) => !q.hidden && q.x != null && q.y != null);
    if (!vis.length) return null;
    return { x: vis.reduce((s, q) => s + q.x, 0) / vis.length, y: vis.reduce((s, q) => s + q.y, 0) / vis.length };
  }
  /** Rotate 90° about the part's pin centroid (not its anchor pin) so it stays where it is, then re-snap
   *  through-hole parts to the nearest valid anchor. Invalid results are still committed; DRC flags them. */
  function commitRotate(partId) {
    store.commit('rotate', (d) => {
      const p = (d.parts || []).find((x) => x.id === partId);
      if (!p) return;
      const before = pinCentroid(p);
      p.rot = ((p.rot || 0) + 90) % 360;
      const after = pinCentroid(p);
      if (!before || !after) return;
      p.at = { x: p.at.x + Math.round(before.x - after.x), y: p.at.y + Math.round(before.y - after.y) };
      const def = partDef(p.type);
      if (!def || def.mount === 'bench') return;
      const board = derived().board;
      if (!board) return;
      const others = (d.parts || []).filter((x) => x.id !== p.id);
      let snapped = null;
      try { snapped = suggestAnchor(def, mergedProps(def, p), p.rot, p.at.x, p.at.y, board, others, p.id); } catch { snapped = null; }
      if (snapped) p.at = { x: snapped.x, y: snapped.y };
    });
  }
  function commitDelete(sel) {
    store.commit('delete', (d) => {
      if (sel.kind === 'part') {
        d.parts = (d.parts || []).filter((p) => p.id !== sel.id);
        const pre = `p:${sel.id}:`;
        d.wires = (d.wires || []).filter((w) => !String(w.a).startsWith(pre) && !String(w.b).startsWith(pre));
      } else if (sel.kind === 'wire') d.wires = (d.wires || []).filter((w) => w.id !== sel.id);
      else if (sel.kind === 'bridge') d.bridges = (d.bridges || []).filter((b) => b.id !== sel.id);
    });
    select(null);
    status(`Deleted ${sel.id}`);
  }
  function commitWire(a, b) {
    const kind = isConnector(a) && isConnector(b) ? 'plug' : 'wire';
    const id = nextFreeId('W', project().wires);
    const color = kind === 'plug' ? 'grey' : ((store.ui && store.ui.wireColor) || 'red');
    store.commit('addWire', (d) => { (d.wires || (d.wires = [])).push({ id, kind, a, b, color, mid: null }); });
    select({ kind: 'wire', id });
    status(`${kind === 'plug' ? 'Plugged' : 'Wired'} ${nodeLabel(a)} → ${nodeLabel(b)} (${id})`);
  }
  function commitBridge(a, b) {
    const id = nextFreeId('B', project().bridges);
    store.commit('addBridge', (d) => { (d.bridges || (d.bridges = [])).push({ id, a, b }); });
    select({ kind: 'bridge', id });
    status(`Bridged ${nodeLabel(a)} ↔ ${nodeLabel(b)} (${id})`);
  }
  function commitWireMid(wireId, mid) {
    store.commit('moveWireMid', (d) => { const w = (d.wires || []).find((x) => x.id === wireId); if (w) w.mid = mid ? { x: mid.x, y: mid.y } : null; });
  }

  // ---- placement / move geometry -------------------------------------------
  /**
   * Resolve where a part of `def` would land for a desired anchor (grid floats).
   * Through-hole: suggestAnchor within ±2 rows → valid; else rounded + invalid.
   * Bench: snapped to the 0.5 grid, always valid.
   */
  function resolveAnchor(def, props, rot, desired, excludeId) {
    if (def && def.mount === 'bench') return { at: { x: snapHalf(desired.x), y: snapHalf(desired.y) }, valid: true };
    const board = derived().board;
    const others = (project().parts || []).filter((p) => p.id !== excludeId);
    const rx = Math.round(desired.x), ry = Math.round(desired.y);
    let at = null;
    try { at = board ? suggestAnchor(def, props, rot, rx, ry, board, others) : null; } catch { at = null; }
    if (at && isFinite(at.x) && isFinite(at.y)) return { at: { x: at.x, y: at.y }, valid: true };
    return { at: { x: rx, y: ry }, valid: false };
  }

  function updatePlacingGhost(p) {
    if (!placing) return;
    const off = centerOffset(placing.def, placing.props, placing.rot);
    const r = resolveAnchor(placing.def, placing.props, placing.rot, { x: p.x - off.x, y: p.y - off.y }, null);
    placing.part = { id: placing.id, type: placing.type, at: r.at, rot: placing.rot, props: placing.props };
    placing.valid = r.valid;
    renderer.showGhost(placing.part, r.valid);
  }

  function beginPlacing(type) {
    const def = partDef(type);
    if (!def) { status(`Unknown part type: ${type}`); return false; }
    cancel(true);
    const props = { ...(def.props || {}) };
    placing = { type, def, props, rot: 0, id: partRefId(def, project().parts), part: null, valid: false };
    mode = 'placing';
    select(null);
    updatePlacingGhost(lastPtr);
    status(`Placing ${def.name || type}: click to drop · R rotate · Esc cancel`);
    updateCursor();
    return true;
  }

  function finishPlacing(p) {
    if (!placing) return;
    updatePlacingGhost(p);
    const part = placing.part;
    const wasValid = placing.valid;
    placing = null; mode = 'idle';
    renderer.showGhost(null);
    commitPlace(part);
    if (!wasValid) status(`Placed ${part.id} (no valid anchor nearby — check Checks panel)`);
    updateCursor();
  }

  // ---- part drag -----------------------------------------------------------
  function updateDragGhost(p) {
    if (!drag) return;
    const desired = { x: drag.startAt.x + (p.x - drag.startPtr.x), y: drag.startAt.y + (p.y - drag.startPtr.y) };
    const r = resolveAnchor(drag.def, drag.props, drag.rot, desired, drag.partId);
    drag.ghost = { id: drag.partId, type: drag.type, at: r.at, rot: drag.rot, props: drag.props };
    drag.valid = r.valid;
    renderer.showGhost(drag.ghost, r.valid);
    const orig = svg.querySelector(`[data-part="${drag.partId}"]`);
    if (orig) orig.style.opacity = '0.35';
    renderer.showSelection(null);
  }
  function endDrag(commit) {
    if (!drag) return;
    const orig = svg.querySelector(`[data-part="${drag.partId}"]`);
    if (orig) orig.style.opacity = '';
    renderer.showGhost(null);
    const d = drag; drag = null; mode = 'idle';
    if (commit && d.moved && d.ghost && (d.ghost.at.x !== d.startAt.x || d.ghost.at.y !== d.startAt.y)) {
      commitMove(d.partId, d.ghost.at);
      status(d.valid ? `Moved ${d.partId}` : `Moved ${d.partId} — placement flagged (see Checks)`);
    }
    renderer.showSelection(store.ui && store.ui.selection);
    updateCursor();
  }

  // ---- wire mid drag -------------------------------------------------------
  function previewMid(h) {
    if (!midDrag) return;
    midDrag.mid = controlForHandle(midDrag.a, midDrag.b, h);
    const d = wirePathD(midDrag.a, midDrag.b, midDrag.mid);
    for (const path of svg.querySelectorAll(`[data-wire-g="${midDrag.wireId}"] path`)) path.setAttribute('d', d);
    const handle = svg.querySelector(`[data-mid-handle="${midDrag.wireId}"]`);
    if (handle) { handle.setAttribute('cx', h.x * PITCH_PX); handle.setAttribute('cy', h.y * PITCH_PX); }
    const halo = svg.querySelector('#layer-overlay .sel-wire');
    if (halo) halo.setAttribute('d', d);
  }

  // ---- pointer handlers ----------------------------------------------------
  function onPointerDown(e) {
    const p = ptr(e); lastPtr = p;
    if (e.button === 2) { if (mode !== 'idle') { cancel(); e.preventDefault(); } return; }
    // panning: middle button, pan tool, or Space held
    if (e.button === 1 || spaceHeld || tool() === 'pan') {
      if (mode !== 'idle' && mode !== 'placing' && mode !== 'wiringFromA') return;
      pan = { startX: e.clientX, startY: e.clientY, startView: renderer.getView(), prevMode: mode };
      mode = 'panning';
      try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      updateCursor(); e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    if (mode === 'placing') { finishPlacing(p); e.preventDefault(); return; }

    const node = nodeAt(e);
    if (mode === 'wiringFromA') {
      const nodeB = node || geomNodeAt(p);
      if (!nodeB) { cancel(); status('Wire cancelled'); return; }
      finishWiring(nodeB);
      return;
    }

    const t = tool();
    if (t === 'wire' || t === 'bridge') {
      const nodeA = node || geomNodeAt(p);
      if (!nodeA) { select(null); return; }
      if (t === 'bridge' && !isStripHole(nodeA)) { status('Bridges join two adjacent strip holes — click a hole first'); return; }
      wireA = { nodeId: nodeA, pos: renderer.nodePosition(nodeA) || p, bridge: t === 'bridge' };
      mode = 'wiringFromA';
      renderer.showRubberBand(wireA.pos, p, t === 'bridge' ? 'orange' : (store.ui && store.ui.wireColor) || 'red');
      status(`${t === 'bridge' ? 'Bridge' : 'Wire'} from ${nodeLabel(nodeA)} — click the second ${t === 'bridge' ? 'adjacent hole' : 'hole or pin'} · Esc cancels`);
      return;
    }

    // select tool
    const target = targetAt(e);
    if (!target) { select(null); return; }
    if (target.kind === 'mid') {
      const w = findWire(target.id);
      const a = w && renderer.nodePosition(w.a), b = w && renderer.nodePosition(w.b);
      if (!w || !a || !b) return;
      midDrag = { wireId: w.id, a, b, mid: w.mid, moved: false };
      mode = 'draggingMid';
      try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      updateCursor(); e.preventDefault();
      return;
    }
    if (target.kind === 'part') {
      const part = findPart(target.id);
      if (!part) return;
      select({ kind: 'part', id: part.id });
      const def = partDef(part.type);
      drag = {
        partId: part.id, type: part.type, def, props: mergedProps(def, part), rot: part.rot || 0,
        bench: !!(def && def.mount === 'bench'), startPtr: p, startAt: { ...part.at }, ghost: null, valid: true, moved: false,
      };
      mode = 'draggingPart';
      try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
      return;
    }
    select({ kind: target.kind, id: target.id });
  }

  function finishWiring(nodeB) {
    const a = wireA; wireA = null; mode = 'idle';
    renderer.showRubberBand(null);
    if (nodeB === a.nodeId) { status('Both ends are the same node — wire discarded'); updateCursor(); return; }
    if (a.bridge) {
      const pa = renderer.nodePosition(a.nodeId), pb = renderer.nodePosition(nodeB);
      const adjacent = pa && pb && Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y) === 1;
      if (!isStripHole(nodeB) || !adjacent) { status('Bridges must join two adjacent strip holes — cancelled'); updateCursor(); return; }
      const dup = (project().bridges || []).some((b) => (b.a === a.nodeId && b.b === nodeB) || (b.a === nodeB && b.b === a.nodeId));
      if (dup) { status('That bridge already exists'); updateCursor(); return; }
      commitBridge(a.nodeId, nodeB);
    } else {
      commitWire(a.nodeId, nodeB);
    }
    updateCursor();
  }

  function onPointerMove(e) {
    const p = ptr(e); lastPtr = p;
    switch (mode) {
      case 'panning': {
        if (!pan) return;
        renderer.setView({ ...pan.startView, tx: pan.startView.tx + (e.clientX - pan.startX), ty: pan.startView.ty + (e.clientY - pan.startY) }, false);
        return;
      }
      case 'placing': updatePlacingGhost(p); return;
      case 'wiringFromA': {
        const node = nodeAt(e) || geomNodeAt(p);
        setHover(node);
        const end = node ? renderer.nodePosition(node) || p : p;
        renderer.showRubberBand(wireA.pos, end, wireA.bridge ? 'orange' : (store.ui && store.ui.wireColor) || 'red');
        return;
      }
      case 'draggingPart': {
        if (!drag) return;
        if (!drag.moved && Math.hypot(p.x - drag.startPtr.x, p.y - drag.startPtr.y) < DRAG_THRESHOLD) return;
        drag.moved = true;
        updateDragGhost(p);
        updateCursor();
        return;
      }
      case 'draggingMid': {
        if (!midDrag) return;
        midDrag.moved = true;
        previewMid(p);
        return;
      }
      default:
        setHover(nodeAt(e) || (wireAt(e) ? `w:${wireAt(e)}` : null));
    }
  }

  function onPointerUp(e) {
    // (pointer capture is released implicitly after pointerup; releasing here could fire lostpointercapture mid-handler)
    if (mode === 'panning') {
      renderer.setView(renderer.getView(), true);
      mode = pan && pan.prevMode && pan.prevMode !== 'idle' ? pan.prevMode : 'idle';
      pan = null; updateCursor();
      return;
    }
    if (mode === 'draggingPart') { endDrag(true); return; }
    if (mode === 'draggingMid') {
      const m = midDrag; midDrag = null; mode = 'idle';
      if (m && m.moved) commitWireMid(m.wireId, m.mid);
      else renderer.showSelection(store.ui && store.ui.selection);
      updateCursor();
    }
  }

  function onPointerCancel() {
    if (mode === 'draggingPart') endDrag(false);
    else if (mode === 'draggingMid') { midDrag = null; mode = 'idle'; renderer.render(); renderer.showSelection(store.ui && store.ui.selection); }
    else if (mode === 'panning') { pan = null; mode = 'idle'; }
    updateCursor();
  }
  function onPointerLeave() { if (mode === 'idle') setHover(null); }

  // ---- wheel zoom (about the cursor) ---------------------------------------
  function onWheel(e) {
    e.preventDefault();
    const v = renderer.getView();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.scale * factor));
    if (scale === v.scale) return;
    const r = svg.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;      // cursor in svg px
    const k = scale / v.scale;
    renderer.setView({ scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k }, true);
    if (mode === 'placing') updatePlacingGhost(lastPtr);
  }

  // ---- HTML5 drag & drop from the palette ----------------------------------
  function onDragOver(e) {
    const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
    if (!types.includes('text/part-type') && mode !== 'placing') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const p = ptr(e); lastPtr = p;
    if (mode === 'placing') updatePlacingGhost(p);   // ghost shown when the palette called startPlacing() on dragstart
  }
  function onDrop(e) {
    const type = (e.dataTransfer && e.dataTransfer.getData('text/part-type')) || (placing && placing.type);
    if (!type) return;
    e.preventDefault();
    const p = ptr(e); lastPtr = p;
    if (!placing || placing.type !== type) { if (!beginPlacing(type)) return; }
    finishPlacing(p);
  }

  // ---- keyboard ------------------------------------------------------------
  function onKeyDown(e) {
    if (isEditable(e.target)) return;
    const meta = e.metaKey || e.ctrlKey;
    const key = e.key;
    if (meta && (key === 'z' || key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) { if (store.redo) store.redo(); status('Redo'); } else { if (store.undo) store.undo(); status('Undo'); }
      return;
    }
    if (meta && (key === 'y' || key === 'Y')) { e.preventDefault(); if (store.redo) store.redo(); status('Redo'); return; }
    if (meta) return;
    switch (key) {
      case ' ':
        if (!spaceHeld) { spaceHeld = true; updateCursor(); }
        e.preventDefault();
        return;
      case 'Escape':
        cancel(); status(TOOL_HINT[tool()]);
        return;
      case 'Delete': case 'Backspace': {
        const sel = store.ui && store.ui.selection;
        if (sel && mode === 'idle') { e.preventDefault(); commitDelete(sel); }
        return;
      }
      case 'r': case 'R': {
        if (mode === 'placing' && placing) { placing.rot = (placing.rot + 90) % 360; updatePlacingGhost(lastPtr); return; }
        if (mode === 'draggingPart' && drag) { drag.rot = (drag.rot + 90) % 360; updateDragGhost(lastPtr); return; }
        const sel = store.ui && store.ui.selection;
        if (sel && sel.kind === 'part' && mode === 'idle') { commitRotate(sel.id); status(`Rotated ${sel.id}`); }
        return;
      }
      default: {
        const t = TOOL_KEYS[key.toLowerCase()];
        if (t && key.length === 1) setTool(t);
      }
    }
  }
  function onKeyUp(e) {
    if (e.key === ' ') { spaceHeld = false; updateCursor(); }
  }
  function onBlur() { spaceHeld = false; updateCursor(); }

  // ---- public ops ----------------------------------------------------------
  /** Abort any in-progress operation (ghost / rubber band / drag) without committing. */
  function cancel(silent = false) {
    if (mode === 'placing') { placing = null; renderer.showGhost(null); }
    else if (mode === 'wiringFromA') { wireA = null; renderer.showRubberBand(null); }
    else if (mode === 'draggingPart') { endDrag(false); }
    else if (mode === 'draggingMid') { midDrag = null; renderer.render(); }
    else if (mode === 'panning') { pan = null; }
    mode = 'idle';
    renderer.showSelection(store.ui && store.ui.selection);
    updateCursor();
    if (!silent) status(TOOL_HINT[tool()]);
  }

  function setTool(t) {
    if (!TOOL_HINT[t]) return;
    cancel(true);
    store.setUi({ tool: t });
    updateCursor();
    status(TOOL_HINT[t]);
  }

  function startPlacing(type) { beginPlacing(type); }

  // ---- subscriptions -------------------------------------------------------
  function syncSelection() {
    const sel = store.ui && store.ui.selection;
    if (!sel) { renderer.showSelection(null); return; }
    const proj = project();
    const exists = sel.kind === 'part' ? (proj.parts || []).some((p) => p.id === sel.id)
      : sel.kind === 'wire' ? (proj.wires || []).some((w) => w.id === sel.id)
        : sel.kind === 'bridge' ? (proj.bridges || []).some((b) => b.id === sel.id) : false;
    if (!exists) { store.setUi({ selection: null }); renderer.showSelection(null); return; }
    renderer.showSelection(sel);
  }
  const unsubs = [];
  if (typeof store.subscribe === 'function') {
    unsubs.push(store.subscribe(() => {
      if (destroyed) return;
      if (mode === 'draggingPart' || mode === 'draggingMid') return;   // previews live in the overlay; redraw after commit
      renderer.render();
      syncSelection();
    }));
  }
  if (typeof store.subscribeUi === 'function') {
    unsubs.push(store.subscribeUi(() => { if (!destroyed && mode !== 'draggingPart' && mode !== 'draggingMid') { syncSelection(); updateCursor(); } }));
  }

  // ---- listeners -----------------------------------------------------------
  const listeners = [
    [svg, 'pointerdown', onPointerDown], [svg, 'pointermove', onPointerMove], [svg, 'pointerup', onPointerUp],
    [svg, 'pointercancel', onPointerCancel], [svg, 'lostpointercapture', (e) => { if (mode === 'panning' || mode === 'draggingPart' || mode === 'draggingMid') onPointerCancel(e); }],
    [svg, 'pointerleave', onPointerLeave], [svg, 'wheel', onWheel, { passive: false }],
    [svg, 'contextmenu', (e) => e.preventDefault()], [svg, 'dragover', onDragOver], [svg, 'drop', onDrop],
    [window, 'keydown', onKeyDown], [window, 'keyup', onKeyUp], [window, 'blur', onBlur],
  ];
  for (const [t, ev, fn, opts] of listeners) t.addEventListener(ev, fn, opts);
  svg.style.touchAction = 'none';
  updateCursor();
  status(TOOL_HINT[tool()]);

  function destroy() {
    destroyed = true;
    cancel(true);
    for (const [t, ev, fn, opts] of listeners) t.removeEventListener(ev, fn, opts);
    for (const u of unsubs) if (typeof u === 'function') u();
  }

  return { setTool, startPlacing, cancel, destroy, /** current interaction state, for debugging */ get mode() { return mode; } };
}
