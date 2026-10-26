// panels.js — palette, toolbar behaviours, tabs, properties / checks / run panels,
// and the run-mode requestAnimationFrame simulation loop.
//
// DOM id contract (plan §8): #toolbar buttons (#tool-select #tool-wire #tool-bridge #tool-pan
// #btn-undo #btn-redo #btn-rotate #btn-delete #sel-wire-color #sel-board #sel-preset #btn-run
// #btn-export-json #btn-export-svg #btn-export-png #btn-export-md #file-import), #palette, #status,
// tabs #tab-props #tab-checks #tab-run and panes #panel-props #panel-checks #panel-run.
import { PART_ORDER, WIRE_COLORS, partDef, resolvePins } from './parts.js';
import { defaultInputs, evaluate, makeScript, scriptInputsAt } from './sim.js';
import * as ioModule from './io.js';
import { PRESETS as DEFAULT_PRESETS } from './presets.js';

const { createNodeDescriber, BOARD_KINDS } = ioModule;
const SVG_NS = 'http://www.w3.org/2000/svg';
const TOOL_BUTTONS = { 'tool-select': 'select', 'tool-wire': 'wire', 'tool-bridge': 'bridge', 'tool-pan': 'pan' };
const TABS = { props: ['tab-props', 'panel-props'], checks: ['tab-checks', 'panel-checks'], run: ['tab-run', 'panel-run'] };
const SCRIPTS = [
  ['Stepper CW', 'stepperCW', { steps: 8, stepMs: 150 }],
  ['Stepper CCW', 'stepperCCW', { steps: 8, stepMs: 150 }],
  ['Magnet pulse', 'magnetPulse', { ms: 500 }],
  ['Servo sweep', 'servoSweep', { ms: 2000 }],
];
const POWER_NET_NAMES = new Set(['GND', '5V', '3V3', 'V+']);

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'draggable', 'htmlFor', 'title', 'readOnly']);

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROP_KEYS.has(k)) n[k] = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  appendAll(n, children);
  return n;
}

function appendAll(n, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendAll(n, c);
    else n.append(c instanceof Node ? c : String(c));
  }
}

function clear(n) { if (n) while (n.firstChild) n.removeChild(n.firstChild); }

function svg(tag, attrs = {}, ...children) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  for (const c of children) if (c) n.append(c);
  return n;
}

function row(labelText, control, cls = '') {
  return el('label', { class: `prop-row ${cls}`.trim() }, el('span', { class: 'prop-label', text: labelText }), control);
}

function kv(labelText, valueText, cls = '') {
  return el('div', { class: `prop-row prop-static ${cls}`.trim() },
    el('span', { class: 'prop-label', text: labelText }),
    el('span', { class: 'prop-value', text: String(valueText ?? '—') }));
}

function select(options, value, onChange, attrs = {}) {
  const s = el('select', attrs);
  for (const o of options) {
    const opt = typeof o === 'object' ? o : { value: String(o), label: String(o) };
    s.append(el('option', { value: opt.value, text: opt.label }));
  }
  s.value = value == null ? '' : String(value);
  if (onChange) s.addEventListener('change', () => onChange(s.value));
  return s;
}

function numberInput(value, onChange, attrs = {}) {
  const i = el('input', { type: 'number', ...attrs });
  i.value = value == null ? '' : String(value);
  i.addEventListener('change', () => {
    const v = Number(i.value);
    if (Number.isFinite(v)) onChange(v);
    else i.value = value == null ? '' : String(value);
  });
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); });
  return i;
}

function textInput(value, onChange, attrs = {}) {
  const i = el('input', { type: 'text', ...attrs });
  i.value = value == null ? '' : String(value);
  i.addEventListener('change', () => onChange(i.value));
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); });
  return i;
}

function checkbox(checked, onChange, attrs = {}) {
  const i = el('input', { type: 'checkbox', ...attrs });
  i.checked = !!checked;
  i.addEventListener('change', () => onChange(i.checked));
  return i;
}

function button(text, onClick, cls = '', attrs = {}) {
  const b = el('button', { type: 'button', class: cls, text, ...attrs });
  b.addEventListener('click', onClick);
  return b;
}

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function fmtDeg(v) { return isNum(v) ? `${Math.round(v * 10) / 10}°` : '?'; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function safeDef(type) { try { return partDef(type) || null; } catch { return null; } }
function selKey(sel) { return sel ? `${sel.kind}:${sel.id}` : ''; }
function isEditableTarget(t) {
  return t instanceof Element && (t.matches('input, select, textarea, [contenteditable="true"]'));
}

// ---------------------------------------------------------------------------
// Palette glyphs (tiny inline SVG, currentColor so they follow the theme)
// ---------------------------------------------------------------------------

function glyph(type) {
  const g = svg('svg', { viewBox: '0 0 32 32', width: 30, height: 30, class: 'palette-glyph', 'aria-hidden': 'true' });
  const S = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const path = (d, extra = {}) => svg('path', { ...S, d, ...extra });
  const rect = (x, y, w, h, extra = {}) => svg('rect', { ...S, x, y, width: w, height: h, rx: 1.5, ...extra });
  const dot = (cx, cy, r = 1.1) => svg('circle', { cx, cy, r, fill: 'currentColor' });
  switch (type) {
    case 'xiao_esp32c3':
      g.append(rect(7, 5, 22, 22, { rx: 2.5 }), svg('rect', { x: 2, y: 13, width: 5, height: 6, rx: 1, fill: 'currentColor' }));
      for (let i = 0; i < 7; i++) g.append(dot(10 + i * 2.7, 9, 0.9), dot(10 + i * 2.7, 23, 0.9));
      break;
    case 'resistor':
      g.append(path('M2 16h5l2.5-6 5 12 5-12 5 12 2.5-6h5'));
      break;
    case 'diode':
      g.append(path('M2 16h7M23 16h7M23 8v16'), svg('path', { d: 'M9 8v16l14-8z', fill: 'currentColor' }));
      break;
    case 'capacitor':
      g.append(path('M2 16h11M13 7v18M19 7v18M19 16h11'));
      break;
    case 'mosfet_n':
      g.append(rect(7, 3, 18, 13), svg('circle', { ...S, cx: 16, cy: 8, r: 2 }), path('M11 16v13M16 16v13M21 16v13'));
      break;
    case 'uln2003':
      g.append(rect(2, 4, 28, 24, { rx: 2 }), svg('rect', { x: 9, y: 9, width: 14, height: 7, rx: 1, fill: 'currentColor' }));
      for (let i = 0; i < 6; i++) g.append(dot(6 + i * 4, 24));
      break;
    case 'stepper_28byj48':
      g.append(svg('circle', { ...S, cx: 15, cy: 15, r: 11 }), dot(15, 15, 3), path('M26 15h4M4 15H1'));
      break;
    case 'servo':
      g.append(rect(4, 12, 24, 16, { rx: 2 }), path('M16 12 26 5M7 12V7M10 12V7M13 12V7'), dot(16, 12, 2.5));
      break;
    case 'electromagnet':
      g.append(path('M2 14q3.5-6 7 0t7 0t7 0t7 0'), rect(4, 18, 24, 8, { rx: 1 }));
      break;
    case 'power_supply':
      g.append(rect(3, 7, 26, 18, { rx: 3 }), path('M10 13v6M7 16h6M19 16h6M12 25v4M20 25v4'));
      break;
    default:
      g.append(rect(6, 6, 20, 20, { rx: 3 }));
  }
  return g;
}

function pinCountOf(def) {
  try {
    if (def.mount === 'bench') return (def.terminals || []).length;
    const pins = typeof def.pins === 'function' ? def.pins(def.props || {}) : (def.pins || []);
    return pins.filter((p) => !p.offGrid).length;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// initPanels
// ---------------------------------------------------------------------------

export function initPanels({ store, renderer, interact, io, presets } = {}) {
  if (!store) throw new Error('initPanels: store is required');
  const IO = io || ioModule;
  const PRESET_LIST = (presets && presets.PRESETS) || DEFAULT_PRESETS;

  const state = { tab: 'props', lastSelKey: null, lastMode: null, lastTool: null, lastColor: null };
  const run = {
    raf: null, inputs: null, xiaoKey: null, prev: null,
    script: null, scriptStart: 0, scriptLabel: '',
    lastReadout: '', nodes: { gpio: [], servo: new Map(), readout: null, toggle: null, hint: null, scriptStatus: null },
  };

  // ---- generic glue -------------------------------------------------------

  function setStatus(text, level = 'info') {
    const s = $('status');
    if (!s) return;
    s.textContent = text || '';
    s.classList.toggle('error', level === 'error');
  }
  function safeDerived() { try { return store.derived() || {}; } catch (e) { console.warn('derived() failed', e); return {}; } }
  function highlight(netId) { try { renderer?.highlightNet?.(netId); } catch { /* renderer not ready */ } }
  function fitView() { try { renderer?.fitView?.(); } catch { /* ignore */ } }
  function on(id, evt, fn) { const n = $(id); if (n) n.addEventListener(evt, fn); return n; }

  function setTool(tool) {
    try { interact?.setTool?.(tool); } catch (e) { console.warn(e); }
    if (store.ui.tool !== tool) store.setUi({ tool });
    syncToolButtons();
  }

  function startPlacing(type) {
    if (store.ui.mode === 'run') setMode('edit');
    try { interact?.startPlacing?.(type); } catch (e) { setStatus(`Cannot place ${type}: ${e.message}`, 'error'); }
  }

  function commitProp(partId, key, value) {
    store.commit('props', (d) => {
      const p = d.parts.find((x) => x.id === partId);
      if (!p) return;
      p.props = p.props || {};
      p.props[key] = value;
    });
  }
  function commitRotate(partId, rot) {
    store.commit('rotate', (d) => {
      const p = d.parts.find((x) => x.id === partId);
      if (p) p.rot = rot == null ? ((p.rot || 0) + 90) % 360 : ((rot % 360) + 360) % 360;
    });
  }
  function commitMove(partId, patch) {
    store.commit('move', (d) => {
      const p = d.parts.find((x) => x.id === partId);
      if (!p) return;
      const def = safeDef(p.type);
      const fix = (v) => (def?.mount === 'bench' ? v : Math.round(v));
      if (isNum(patch.x)) p.at.x = fix(patch.x);
      if (isNum(patch.y)) p.at.y = fix(patch.y);
    });
  }
  function commitBoard(patch) {
    store.commit('board', (d) => {
      d.board = d.board || { kind: 'half', railSplit: false };
      if (patch.kind) d.board.kind = patch.kind;
      if (typeof patch.railSplit === 'boolean') d.board.railSplit = patch.railSplit;
    });
  }
  function deleteFromDraft(d, sel) {
    if (sel.kind === 'part') {
      d.parts = d.parts.filter((p) => p.id !== sel.id);
      const prefix = `p:${sel.id}:`;
      d.wires = d.wires.filter((w) => !(String(w.a).startsWith(prefix) || String(w.b).startsWith(prefix)));
    } else if (sel.kind === 'wire') {
      d.wires = d.wires.filter((w) => w.id !== sel.id);
    } else if (sel.kind === 'bridge') {
      d.bridges = (d.bridges || []).filter((b) => b.id !== sel.id);
    }
  }
  function rotateSelection() {
    const sel = store.ui.selection;
    if (!sel || sel.kind !== 'part') { setStatus('Select a part to rotate.'); return; }
    commitRotate(sel.id, null);
  }
  function deleteSelection() {
    const sel = store.ui.selection;
    if (!sel) { setStatus('Nothing selected.'); return; }
    store.setUi({ selection: null });
    store.commit('delete', (d) => { deleteFromDraft(d, sel); });
    setStatus(`Deleted ${sel.id}.`);
  }
  function selectThing(selection) {
    store.setUi({ selection });
    try { renderer?.showSelection?.(selection); } catch { /* optional */ }
  }

  // ---- palette ------------------------------------------------------------

  function buildPalette() {
    const host = $('palette');
    if (!host) return;
    clear(host);
    for (const type of PART_ORDER) {
      const def = safeDef(type);
      if (!def) continue;
      const n = pinCountOf(def);
      const meta = n == null ? (def.mount === 'bench' ? 'module' : 'part')
        : `${n} pin${n === 1 ? '' : 's'}${def.mount === 'bench' ? ' · bench' : ''}`;
      const card = el('div', {
        class: `palette-item ${def.mount === 'bench' ? 'bench' : 'through'}`,
        draggable: true, tabindex: '0', role: 'button',
        title: `${def.name} — click to place, or drag onto the canvas`,
        dataset: { type },
      },
      glyph(type),
      el('div', { class: 'palette-text' },
        el('div', { class: 'palette-name', text: def.name || type }),
        el('div', { class: 'palette-meta', text: meta })));
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/part-type', type);
        e.dataTransfer.setData('text/plain', type);
        e.dataTransfer.effectAllowed = 'copy';
      });
      card.addEventListener('click', () => startPlacing(type));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startPlacing(type); }
      });
      host.append(card);
    }
  }

  // ---- toolbar ------------------------------------------------------------

  function bindToolbar() {
    for (const [id, tool] of Object.entries(TOOL_BUTTONS)) on(id, 'click', () => setTool(tool));
    on('btn-undo', 'click', () => { store.undo(); syncToolbarProject(); });
    on('btn-redo', 'click', () => { store.redo(); syncToolbarProject(); });
    on('btn-rotate', 'click', rotateSelection);
    on('btn-delete', 'click', deleteSelection);

    const colorSel = $('sel-wire-color');
    if (colorSel) {
      clear(colorSel);
      for (const c of WIRE_COLORS) colorSel.append(el('option', { value: c, text: c }));
      colorSel.value = store.ui.wireColor || WIRE_COLORS[0];
      colorSel.addEventListener('change', () => store.setUi({ wireColor: colorSel.value }));
    }

    const boardSel = $('sel-board');
    if (boardSel) {
      clear(boardSel);
      for (const k of BOARD_KINDS) boardSel.append(el('option', { value: k, text: boardKindLabel(k) }));
      boardSel.value = store.get().board?.kind || 'half';
      boardSel.addEventListener('change', () => commitBoard({ kind: boardSel.value }));
    }

    const presetSel = $('sel-preset');
    if (presetSel) {
      clear(presetSel);
      presetSel.append(el('option', { value: '', text: 'Load preset…' }));
      for (const p of PRESET_LIST) presetSel.append(el('option', { value: p.id, text: p.name }));
      presetSel.value = '';
      presetSel.addEventListener('change', () => { loadPreset(presetSel.value); presetSel.value = ''; });
    }

    on('btn-run', 'click', toggleRun);
    on('btn-export-json', 'click', () => {
      try { IO.downloadFile('protoplanner.json', IO.exportJson(store.get()), 'application/json'); setStatus('Exported protoplanner.json'); }
      catch (e) { setStatus(`JSON export failed: ${e.message}`, 'error'); }
    });
    on('btn-export-svg', 'click', () => {
      try { IO.exportSvg(renderer, 'protoplanner.svg'); setStatus('Exported protoplanner.svg'); }
      catch (e) { setStatus(`SVG export failed: ${e.message}`, 'error'); }
    });
    on('btn-export-png', 'click', () => {
      Promise.resolve()
        .then(() => IO.exportPng(renderer, 'protoplanner.png', 2))
        .then(() => setStatus('Exported protoplanner.png'))
        .catch((e) => setStatus(`PNG export failed: ${e.message}`, 'error'));
    });
    on('btn-export-md', 'click', () => {
      try { IO.downloadFile('wiring.md', IO.wiringListMarkdown(store.get(), safeDerived()), 'text/markdown;charset=utf-8'); setStatus('Exported wiring.md'); }
      catch (e) { setStatus(`Markdown export failed: ${e.message}`, 'error'); }
    });
    on('file-import', 'change', importFile);

    // Keep keystrokes inside form controls from reaching canvas shortcuts (R, Delete, V, W…).
    for (const id of ['toolbar', 'panel-props', 'panel-checks', 'panel-run']) {
      const n = $(id);
      if (n) n.addEventListener('keydown', (e) => { if (isEditableTarget(e.target)) e.stopPropagation(); });
    }
  }

  function boardKindLabel(k) {
    return { mini: 'Mini (17 col)', half: 'Half (30 col)', dual: 'Dual half', full: 'Full (63 col)' }[k] || k;
  }

  function loadPreset(id) {
    const preset = PRESET_LIST.find((p) => p.id === id);
    if (!preset) return;
    const cur = store.get();
    const dirty = (cur.parts?.length || 0) + (cur.wires?.length || 0) > 0;
    if (dirty && !window.confirm(`Replace the current project with "${preset.name}"?\nThe current layout will be discarded (undo history is cleared).`)) return;
    let project;
    try { project = preset.build(); } catch (e) { setStatus(`Preset failed: ${e.message}`, 'error'); return; }
    if (store.ui.mode === 'run') setMode('edit');
    store.setUi({ selection: null });
    store.replace(project, { resetHistory: true });
    fitView();
    setStatus(`Loaded preset "${preset.name}".`);
  }

  async function importFile(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const project = IO.importJson(text);
      if (store.ui.mode === 'run') setMode('edit');
      store.setUi({ selection: null });
      store.replace(project, { resetHistory: true });
      fitView();
      setStatus(`Imported "${file.name}": ${project.parts.length} parts, ${project.wires.length} wires, ${project.bridges.length} bridges.`);
    } catch (err) {
      setStatus(`Import failed: ${err.message}`, 'error');
    } finally {
      input.value = '';
    }
  }

  function syncToolButtons() {
    const tool = store.ui.tool;
    for (const [id, t] of Object.entries(TOOL_BUTTONS)) {
      const b = $(id);
      if (!b) continue;
      b.classList.toggle('active', tool === t);
      b.setAttribute('aria-pressed', String(tool === t));
    }
  }

  function syncSelectionButtons() {
    const sel = store.ui.selection;
    const rot = $('btn-rotate');
    const del = $('btn-delete');
    if (rot) rot.disabled = !(sel && sel.kind === 'part');
    if (del) del.disabled = !sel;
  }

  function syncToolbarProject() {
    const undo = $('btn-undo');
    const redo = $('btn-redo');
    try {
      if (undo) undo.disabled = !store.canUndo();
      if (redo) redo.disabled = !store.canRedo();
    } catch { /* ignore */ }
    const boardSel = $('sel-board');
    const kind = store.get().board?.kind;
    if (boardSel && kind && boardSel.value !== kind) boardSel.value = kind;
  }

  // ---- tabs ---------------------------------------------------------------

  function setTab(name) {
    if (!TABS[name]) return;
    state.tab = name;
    for (const [key, [tabId, paneId]] of Object.entries(TABS)) {
      const active = key === name;
      const t = $(tabId);
      const p = $(paneId);
      if (t) { t.classList.toggle('active', active); t.setAttribute('aria-selected', String(active)); }
      if (p) { p.classList.toggle('active', active); p.style.display = active ? '' : 'none'; }
    }
  }

  function bindTabs() {
    for (const [key, [tabId]] of Object.entries(TABS)) on(tabId, 'click', () => setTab(key));
    const initial = Object.entries(TABS).find(([, [tabId]]) => $(tabId)?.classList.contains('active'))?.[0] || 'props';
    setTab(initial);
  }

  // ---- properties panel ---------------------------------------------------

  function renderProps() {
    const host = $('panel-props');
    if (!host) return;
    const project = store.get();
    const derived = safeDerived();
    const sel = store.ui.selection;
    clear(host);
    if (sel?.kind === 'part') {
      const part = project.parts.find((p) => p.id === sel.id);
      if (part) { host.append(partProps(part, project, derived)); return; }
    }
    if (sel?.kind === 'wire') {
      const w = project.wires.find((x) => x.id === sel.id);
      if (w) { host.append(wireProps(w, project, derived)); return; }
    }
    if (sel?.kind === 'bridge') {
      const b = (project.bridges || []).find((x) => x.id === sel.id);
      if (b) { host.append(bridgeProps(b, project, derived)); return; }
    }
    host.append(projectProps(project, derived));
  }

  function propControl(part, key, value, dflt) {
    const onChange = (v) => commitProp(part.id, key, v);
    if (key === 'package') return select(['TO-220', 'TO-92'], value ?? dflt ?? 'TO-220', onChange);
    if (key === 'span') return numberInput(value ?? dflt ?? 4, (v) => onChange(clamp(Math.round(v), 2, 10)), { min: 2, max: 10, step: 1 });
    if (key === 'voltage') return numberInput(value ?? dflt ?? 5, onChange, { min: 0, max: 48, step: 0.1 });
    const sample = value ?? dflt;
    if (typeof sample === 'boolean') return checkbox(!!value, onChange);
    if (typeof sample === 'number') return numberInput(value ?? dflt, onChange, { step: 'any' });
    return textInput(value ?? '', onChange);
  }

  function propLabel(key) {
    return { label: 'Label', value: 'Value', span: 'Span (holes)', package: 'Package', partNumber: 'Part number',
      jumper: 'COM jumper closed', voltage: 'Voltage (V)', polarized: 'Polarized' }[key] || key;
  }

  function partProps(part, project, derived) {
    const def = safeDef(part.type);
    const D = createNodeDescriber(project, derived);
    const bench = def?.mount === 'bench';
    const box = el('div', { class: 'props part-props', dataset: { part: part.id } });
    box.append(el('h3', { class: 'props-title', text: `${part.id} · ${def?.name || part.type}` }));
    box.append(kv('Type', part.type));
    box.append(row('X', numberInput(part.at?.x, (v) => commitMove(part.id, { x: v }), { step: bench ? 0.5 : 1 })));
    box.append(row('Y', numberInput(part.at?.y, (v) => commitMove(part.id, { y: v }), { step: bench ? 0.5 : 1 })));
    if (!bench) {
      const hid = D.holeIdAt(part.at?.x, part.at?.y);
      box.append(kv('Anchor hole', hid ? D.label(hid) : 'off-board', hid ? '' : 'warn'));
    }
    box.append(row('Rotation', select([0, 90, 180, 270].map((r) => ({ value: String(r), label: `${r}°` })), String(part.rot || 0),
      (v) => commitRotate(part.id, Number(v)))));

    const keys = [...new Set([...Object.keys(def?.props || {}), ...Object.keys(part.props || {})])];
    if (keys.length) {
      const sec = el('section', { class: 'props-section' }, el('h4', { text: 'Properties' }));
      for (const key of keys) {
        const dflt = def?.props?.[key];
        const value = part.props?.[key];
        sec.append(row(propLabel(key), propControl(part, key, value, dflt), `prop-${key}`));
      }
      box.append(sec);
    }

    const pins = D.pinsOf(part.id).filter((p) => !p.hidden);
    if (pins.length) {
      const tbody = el('tbody');
      for (const pin of pins) {
        const hid = pin.through && !pin.offGrid ? D.holeIdAt(pin.x, pin.y) : null;
        const net = D.netOf(pin.nodeId);
        const where = pin.offGrid ? 'off-grid' : pin.through ? (hid ? D.label(hid) : 'off-board') : 'terminal';
        const tr = el('tr', { class: pin.through && !pin.offGrid && !hid ? 'pin-offboard' : '', dataset: { node: pin.nodeId } },
          el('td', { text: pin.label && pin.label !== pin.name ? `${pin.name} (${pin.label})` : pin.name }),
          el('td', { text: where }),
          el('td', { text: net?.name || '—' }));
        if (net) {
          tr.addEventListener('mouseenter', () => highlight(net.id));
          tr.addEventListener('mouseleave', () => highlight(null));
        }
        tbody.append(tr);
      }
      box.append(el('section', { class: 'props-section' }, el('h4', { text: 'Pins' }),
        el('table', { class: 'pin-table' },
          el('thead', {}, el('tr', {}, el('th', { text: 'Pin' }), el('th', { text: 'Hole' }), el('th', { text: 'Net' }))),
          tbody)));
    }

    box.append(el('div', { class: 'props-actions' },
      button('Rotate 90°', () => commitRotate(part.id, null), 'btn'),
      button('Delete', () => { store.setUi({ selection: null }); store.commit('delete', (d) => { deleteFromDraft(d, { kind: 'part', id: part.id }); }); }, 'btn danger')));
    return box;
  }

  function wireProps(w, project, derived) {
    const D = createNodeDescriber(project, derived);
    const box = el('div', { class: 'props wire-props', dataset: { wire: w.id } });
    box.append(el('h3', { class: 'props-title', text: `${w.id} · ${w.kind === 'plug' ? 'Plug connection' : 'Jumper wire'}` }));
    box.append(kv('From', D.describe(w.a)));
    box.append(kv('To', D.describe(w.b)));
    box.append(kv('Net', D.netName(w.a) || D.netName(w.b) || '— (dangling)'));
    box.append(kv('Kind', w.kind || 'wire'));
    if (w.kind === 'plug') {
      box.append(kv('Color', w.color || 'grey'));
    } else {
      box.append(row('Color', select(WIRE_COLORS.includes(w.color) ? WIRE_COLORS : [...WIRE_COLORS, w.color], w.color,
        (v) => store.commit('props', (d) => { const x = d.wires.find((y) => y.id === w.id); if (x) x.color = v; }))));
    }
    const actions = el('div', { class: 'props-actions' });
    if (w.mid) {
      actions.append(button('Straighten', () => store.commit('moveWireMid', (d) => { const x = d.wires.find((y) => y.id === w.id); if (x) x.mid = null; }), 'btn'));
    }
    actions.append(button('Delete', () => { store.setUi({ selection: null }); store.commit('delete', (d) => { deleteFromDraft(d, { kind: 'wire', id: w.id }); }); }, 'btn danger'));
    box.append(actions);
    return box;
  }

  function bridgeProps(b, project, derived) {
    const D = createNodeDescriber(project, derived);
    const box = el('div', { class: 'props bridge-props', dataset: { bridge: b.id } });
    box.append(el('h3', { class: 'props-title', text: `${b.id} · Solder bridge` }));
    box.append(kv('Between', `${D.label(b.a)} ↔ ${D.label(b.b)}`));
    box.append(kv('Net', D.netName(b.a) || '—'));
    box.append(el('div', { class: 'props-actions' },
      button('Delete', () => { store.setUi({ selection: null }); store.commit('delete', (d) => { deleteFromDraft(d, { kind: 'bridge', id: b.id }); }); }, 'btn danger')));
    return box;
  }

  function projectProps(project, derived) {
    const box = el('div', { class: 'props project-props' });
    box.append(el('h3', { class: 'props-title', text: 'Project' }));
    box.append(row('Name', textInput(project.meta?.name || '', (v) => store.commit('props', (d) => { d.meta = d.meta || {}; d.meta.name = v || 'Untitled'; }))));
    box.append(row('Board', select(BOARD_KINDS.map((k) => ({ value: k, label: boardKindLabel(k) })), project.board?.kind || 'half', (v) => commitBoard({ kind: v }))));
    box.append(row('Split rails at middle', checkbox(!!project.board?.railSplit, (v) => commitBoard({ railSplit: v }))));
    const nets = (derived.netlist?.nets || []).filter((n) => (n.pins?.length || 0) > 0);
    box.append(el('section', { class: 'props-section' }, el('h4', { text: 'Summary' }),
      kv('Parts', project.parts.length), kv('Wires', project.wires.length), kv('Bridges', (project.bridges || []).length), kv('Nets with pins', nets.length)));
    box.append(el('p', { class: 'props-hint', text: 'Select a part, wire or bridge on the canvas to edit it. Click a palette item (or drag it onto the canvas) to add a part.' }));
    return box;
  }

  // ---- checks panel -------------------------------------------------------

  function renderChecks() {
    const host = $('panel-checks');
    const derived = safeDerived();
    const issues = Array.isArray(derived.issues) ? derived.issues : [];
    const counts = { error: 0, warn: 0, info: 0 };
    for (const it of issues) counts[it.severity] = (counts[it.severity] || 0) + 1;
    const tab = $('tab-checks');
    if (tab) {
      tab.textContent = `Checks (${counts.error}/${counts.warn}/${counts.info})`;
      tab.classList.toggle('has-errors', counts.error > 0);
      tab.classList.toggle('has-warnings', counts.error === 0 && counts.warn > 0);
    }
    if (!host) return;
    clear(host);
    host.append(el('div', { class: 'checks-summary' },
      el('span', { class: 'count error', text: `${counts.error} error${counts.error === 1 ? '' : 's'}` }),
      el('span', { class: 'count warn', text: `${counts.warn} warning${counts.warn === 1 ? '' : 's'}` }),
      el('span', { class: 'count info', text: `${counts.info} info` })));
    if (!issues.length) {
      host.append(el('div', { class: 'checks-empty', text: 'No issues found.' }));
      return;
    }
    for (const [sev, title] of [['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info']]) {
      const list = issues.filter((x) => x.severity === sev);
      if (!list.length) continue;
      const section = el('section', { class: `issue-group ${sev}` }, el('h4', { class: 'issue-group-title', text: `${title} (${list.length})` }));
      for (const it of list) {
        const rowEl = el('div', { class: `issue ${sev}`, role: 'button', tabindex: '0', title: it.code || '', dataset: { issue: it.id || '' } },
          el('span', { class: 'issue-badge', text: sev }),
          el('span', { class: 'issue-msg', text: it.message || it.code || '' }),
          el('span', { class: 'issue-code', text: it.code || '' }));
        rowEl.addEventListener('click', () => focusIssue(it));
        rowEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusIssue(it); } });
        section.append(rowEl);
      }
      host.append(section);
    }
  }

  function focusIssue(it) {
    const refs = it.refs || {};
    const derived = safeDerived();
    let selection = null;
    if (refs.parts?.length) selection = { kind: 'part', id: refs.parts[0] };
    else if (refs.wires?.length) selection = { kind: 'wire', id: refs.wires[0] };
    else if (refs.bridges?.length) selection = { kind: 'bridge', id: refs.bridges[0] };
    if (selection) selectThing(selection);
    let netId = null;
    if (refs.nets?.length) { const n = refs.nets[0]; netId = n && typeof n === 'object' ? n.id : n; }
    if (netId == null && refs.nodes?.length) {
      try { netId = derived.netlist?.netOf?.get(refs.nodes[0])?.id ?? null; } catch { netId = null; }
    }
    if (netId != null) highlight(netId);
    setStatus(`${(it.severity || '').toUpperCase()} ${it.code || ''}: ${it.message || ''}`.trim(), it.severity === 'error' ? 'error' : 'info');
  }

  // ---- run panel ----------------------------------------------------------

  function ensureInputs(project) {
    const key = project.parts.filter((p) => p.type === 'xiao_esp32c3').map((p) => p.id).join(',');
    if (run.inputs && key === run.xiaoKey) return;
    let d;
    try { d = defaultInputs(project); } catch { d = null; }
    if (!d || typeof d !== 'object') d = { gpio: {}, servoAngle: {}, supplyOn: true };
    d.gpio = d.gpio || {};
    d.servoAngle = d.servoAngle || {};
    if (d.supplyOn == null) d.supplyOn = true;
    if (run.inputs) {
      for (const id of Object.keys(d.gpio)) if (run.inputs.gpio?.[id]) d.gpio[id] = { ...d.gpio[id], ...run.inputs.gpio[id] };
      for (const id of Object.keys(d.servoAngle)) if (run.inputs.servoAngle?.[id] != null) d.servoAngle[id] = run.inputs.servoAngle[id];
      if (run.inputs.supplyOn != null) d.supplyOn = run.inputs.supplyOn;
    }
    run.inputs = d;
    run.xiaoKey = key;
  }

  function renderRunPanel() {
    const host = $('panel-run');
    if (!host) return;
    const project = store.get();
    ensureInputs(project);
    const running = store.ui.mode === 'run';
    clear(host);
    run.nodes.gpio = [];
    run.nodes.servo = new Map();

    const toggle = button(running ? 'Stop' : 'Run', toggleRun, `run-toggle${running ? ' on active' : ''}`, { 'aria-pressed': String(running) });
    const hint = el('span', { class: 'run-hint', text: running ? 'Simulating — toggle pins below.' : 'Press Run to simulate logic levels.' });
    host.append(el('div', { class: 'run-header' }, toggle, hint));
    run.nodes.toggle = toggle;
    run.nodes.hint = hint;

    host.append(el('section', { class: 'run-section' }, el('h4', { text: 'Power' }),
      row('External supply on', checkbox(run.inputs.supplyOn !== false, (v) => { run.inputs.supplyOn = v; }))));

    const xiaos = project.parts.filter((p) => p.type === 'xiao_esp32c3');
    if (!xiaos.length) host.append(el('p', { class: 'run-empty', text: 'Add a XIAO ESP32C3 to drive GPIO pins.' }));
    for (const x of xiaos) {
      const sec = el('section', { class: 'run-section xiao-controls', dataset: { part: x.id } }, el('h4', { text: `${x.id} GPIO outputs` }));
      const grid = el('div', { class: 'gpio-grid' });
      run.inputs.gpio[x.id] = run.inputs.gpio[x.id] || {};
      for (let i = 0; i <= 10; i++) {
        const pin = `D${i}`;
        const onNow = !!run.inputs.gpio[x.id][pin];
        const b = el('button', { type: 'button', class: `gpio-toggle${onNow ? ' on' : ''}`, dataset: { part: x.id, pin }, text: pin, 'aria-pressed': String(onNow) });
        b.addEventListener('click', () => {
          const g = run.inputs.gpio[x.id];
          g[pin] = !g[pin];
          b.classList.toggle('on', g[pin]);
          b.setAttribute('aria-pressed', String(g[pin]));
          if (store.ui.mode !== 'run') setMode('run');
        });
        run.nodes.gpio.push(b);
        grid.append(b);
      }
      sec.append(grid);
      const angle = run.inputs.servoAngle[x.id] ?? 90;
      run.inputs.servoAngle[x.id] = angle;
      const out = el('span', { class: 'servo-angle', text: `${angle}°` });
      const slider = el('input', { type: 'range', min: 0, max: 180, step: 1, class: 'servo-slider' });
      slider.value = String(angle);
      slider.addEventListener('input', () => {
        run.inputs.servoAngle[x.id] = Number(slider.value);
        out.textContent = `${slider.value}°`;
      });
      run.nodes.servo.set(x.id, { slider, out });
      sec.append(row('Servo angle', el('span', { class: 'servo-row' }, slider, out)));
      host.append(sec);
    }

    const scripts = el('div', { class: 'script-buttons' });
    for (const [label, kind, opts] of SCRIPTS) {
      scripts.append(button(label, () => startScript(kind, opts, label), 'script-btn', { dataset: { script: kind } }));
    }
    const scriptStatus = el('div', { class: 'script-status', text: run.script ? `Running: ${run.scriptLabel}…` : '' });
    run.nodes.scriptStatus = scriptStatus;
    host.append(el('section', { class: 'run-section' }, el('h4', { text: 'Scripts' }), scripts, scriptStatus));

    const readout = el('pre', { class: 'run-readout', text: running ? '' : 'Not running.' });
    run.nodes.readout = readout;
    run.lastReadout = '';
    host.append(el('section', { class: 'run-section' }, el('h4', { text: 'Readout' }), readout));
    syncRunHeader();
  }

  function syncRunHeader() {
    const running = store.ui.mode === 'run';
    const btn = $('btn-run');
    if (btn) {
      btn.textContent = running ? 'Stop' : 'Run';
      btn.classList.toggle('active', running);
      btn.classList.toggle('on', running);
      btn.setAttribute('aria-pressed', String(running));
    }
    if (run.nodes.toggle) {
      run.nodes.toggle.textContent = running ? 'Stop' : 'Run';
      run.nodes.toggle.classList.toggle('on', running);
      run.nodes.toggle.classList.toggle('active', running);
      run.nodes.toggle.setAttribute('aria-pressed', String(running));
    }
    if (run.nodes.hint) run.nodes.hint.textContent = running ? 'Simulating — toggle pins below.' : 'Press Run to simulate logic levels.';
    document.body?.classList.toggle('mode-run', running);
  }

  function syncScriptStatus() {
    if (run.nodes.scriptStatus) run.nodes.scriptStatus.textContent = run.script ? `Running: ${run.scriptLabel}…` : '';
  }

  function toggleRun() { setMode(store.ui.mode === 'run' ? 'edit' : 'run'); }

  function setMode(mode) {
    if (store.ui.mode !== mode) store.setUi({ mode });
    syncRunLoop();
  }

  function syncRunLoop() {
    const running = store.ui.mode === 'run';
    if (running && run.raf == null) startLoop();
    else if (!running && run.raf != null) stopLoop();
    state.lastMode = store.ui.mode;
    syncRunHeader();
  }

  function startLoop() {
    run.prev = null;
    run.lastReadout = '';
    run.raf = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (run.raf != null) cancelAnimationFrame(run.raf);
    run.raf = null;
    run.script = null;
    run.prev = null;
    syncScriptStatus();
    try { renderer?.applySim?.(null); } catch { /* ignore */ }
    if (run.nodes.readout) run.nodes.readout.textContent = 'Not running.';
    run.lastReadout = '';
  }

  function startScript(kind, opts, label) {
    ensureInputs(store.get());
    let script;
    try { script = makeScript(kind, opts); } catch (e) { setStatus(`Script failed: ${e.message}`, 'error'); return; }
    if (!script) { setStatus(`Unknown script ${kind}`, 'error'); return; }
    run.script = script;
    run.scriptLabel = label;
    run.scriptStart = performance.now();
    if (store.ui.mode !== 'run') setMode('run');
    syncScriptStatus();
    setStatus(`${label} started.`);
  }

  function frame(now) {
    run.raf = null;
    if (store.ui.mode !== 'run') return;
    const project = store.get();
    const derived = safeDerived();
    ensureInputs(project);
    let inputs = run.inputs;
    if (run.script) {
      try {
        const r = scriptInputsAt(run.script, clone(run.inputs), project, now - run.scriptStart);
        if (r && r.inputs) inputs = r.inputs;
        if (!r || r.done) { run.script = null; syncScriptStatus(); }
      } catch (e) {
        run.script = null;
        syncScriptStatus();
        setStatus(`Script error: ${e.message}`, 'error');
      }
    }
    let result = null;
    if (derived.board && derived.netlist) {
      try {
        result = evaluate(project, derived.board, derived.netlist, inputs, run.prev);
      } catch (e) {
        console.error(e);
        setStatus(`Simulation error: ${e.message}`, 'error');
        setMode('edit');
        return;
      }
    }
    run.prev = result;
    try { renderer?.applySim?.(result); } catch (e) { console.warn('applySim failed', e); }
    syncGpioButtons(inputs);
    updateReadout(result, inputs, project, derived);
    run.raf = requestAnimationFrame(frame);
  }

  function syncGpioButtons(inputs) {
    for (const b of run.nodes.gpio) {
      const on = !!inputs?.gpio?.[b.dataset.part]?.[b.dataset.pin];
      if (b.classList.contains('on') !== on) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    }
    if (run.script) {
      for (const [id, { slider, out }] of run.nodes.servo) {
        const a = inputs?.servoAngle?.[id];
        if (isNum(a) && Number(slider.value) !== Math.round(a)) { slider.value = String(Math.round(a)); out.textContent = `${Math.round(a)}°`; }
      }
    }
  }

  function netLevelOf(result, net) {
    const nl = result?.netLevel;
    if (!nl) return null;
    if (nl instanceof Map) return nl.get(net.id) ?? null;
    return nl[net.id] ?? null;
  }

  function netSortKey(net) {
    const n = net.name || '';
    if (n === 'GND') return '0';
    if (POWER_NET_NAMES.has(n)) return `1${n}`;
    if (/^D\d+$/.test(n)) return `2${n.slice(1).padStart(3, '0')}`;
    return `3${n}`;
  }

  function updateReadout(result, inputs, project, derived) {
    const out = run.nodes.readout;
    if (!out) return;
    const lines = [];
    const nets = (derived.netlist?.nets || []).filter((n) => n.name && (POWER_NET_NAMES.has(n.name) || n.kind === 'gnd' || n.kind === 'power' || n.kind === 'gpio' || n.kind === 'conflict'));
    nets.sort((a, b) => netSortKey(a).localeCompare(netSortKey(b)));
    if (nets.length) {
      lines.push('Nets:');
      for (const n of nets) lines.push(`  ${n.name}: ${netLevelOf(result, n) ?? '?'}`);
    }
    const partLines = [];
    for (const part of project.parts) {
      const s = result?.parts?.[part.id];
      if (!s && part.type !== 'power_supply' && part.type !== 'xiao_esp32c3') continue;
      partLines.push(`  ${partStateText(part, s || {}, inputs)}`);
    }
    if (partLines.length) lines.push('Parts:', ...partLines);
    if (Array.isArray(result?.notes) && result.notes.length) {
      lines.push('Notes:');
      for (const n of result.notes) lines.push(`  ${typeof n === 'string' ? n : (n?.message || JSON.stringify(n))}`);
    }
    if (!result) lines.push('(no simulation result — engine not ready)');
    const text = lines.join('\n');
    if (text !== run.lastReadout) { run.lastReadout = text; out.textContent = text; }
  }

  function ledLetters(leds, outs) {
    const src = leds ?? outs;
    const norm = (k, i) => {
      const s = String(k);
      let m = /^LED_?([A-D])$/i.exec(s); if (m) return m[1].toUpperCase();
      m = /^OUT(\d)$/i.exec(s); if (m) return 'ABCD'[Number(m[1]) - 1] || s;
      if (/^[A-D]$/i.test(s)) return s.toUpperCase();
      return i != null ? ('ABCD'[i] || s) : s;
    };
    if (Array.isArray(src)) {
      if (src.every((v) => typeof v === 'boolean' || v === 0 || v === 1)) return src.map((v, i) => (v ? 'ABCD'[i] : null)).filter(Boolean);
      return src.map((v, i) => norm(v, i));
    }
    if (src && typeof src === 'object') return Object.keys(src).filter((k) => src[k]).map((k) => norm(k));
    return [];
  }

  function partStateText(part, s, inputs) {
    switch (part.type) {
      case 'mosfet_n':
        return `${part.id}: ${s.conducting ? 'conducting (drain pulled to GND)' : 'off'}`;
      case 'electromagnet':
        return `${part.id}: ${s.energized ? 'ENERGIZED' : 'idle'}`;
      case 'uln2003': {
        const leds = ledLetters(s.leds, s.out);
        return `${part.id}: ${s.powered ? 'powered' : 'unpowered'}${leds.length ? `, LEDs ${leds.join(' ')}` : (s.powered ? ', LEDs off' : '')}`;
      }
      case 'stepper_28byj48': {
        const coils = Array.isArray(s.coils) ? ` coils ${s.coils.map((c) => (c ? '●' : '○')).join('')}` : '';
        const step = s.stepIndex != null ? `, step ${s.stepIndex}` : '';
        const rotor = isNum(s.rotorAngle) ? `, rotor ${fmtDeg(s.rotorAngle)}` : '';
        return `${part.id}: ${s.plugged === false ? 'unplugged' : 'plugged'}${coils}${step}${rotor}`;
      }
      case 'servo':
        return `${part.id}: ${s.alive ? `alive, ${fmtDeg(s.angle)}` : 'no power / no signal'}`;
      case 'diode':
        return `${part.id}: ${s.forward ? 'forward biased (conducting)' : 'blocking'}`;
      case 'power_supply':
        return `${part.id}: ${inputs?.supplyOn === false ? 'OFF' : `on (${part.props?.voltage ?? 5} V)`}`;
      case 'xiao_esp32c3': {
        const g = inputs?.gpio?.[part.id] || {};
        const high = Object.keys(g).filter((k) => g[k]);
        return `${part.id}: HIGH on ${high.length ? high.join(' ') : 'none'}`;
      }
      default: {
        const bits = Object.entries(s).filter(([, v]) => v == null || typeof v !== 'object').map(([k, v]) => `${k}=${v}`);
        return `${part.id}: ${bits.join(', ') || '—'}`;
      }
    }
  }

  // ---- subscriptions ------------------------------------------------------

  function onProjectChange() {
    renderProps();
    renderChecks();
    renderRunPanel();
    syncToolbarProject();
    syncSelectionButtons();
  }

  function onUiChange() {
    const ui = store.ui;
    if (ui.tool !== state.lastTool) { state.lastTool = ui.tool; syncToolButtons(); }
    if (ui.wireColor !== state.lastColor) {
      state.lastColor = ui.wireColor;
      const sel = $('sel-wire-color');
      if (sel && ui.wireColor && sel.value !== ui.wireColor) sel.value = ui.wireColor;
    }
    const sk = selKey(ui.selection);
    if (sk !== state.lastSelKey) { state.lastSelKey = sk; renderProps(); syncSelectionButtons(); }
    if (ui.mode !== state.lastMode) syncRunLoop();
  }

  // ---- boot ---------------------------------------------------------------

  buildPalette();
  bindToolbar();
  bindTabs();
  state.lastTool = store.ui.tool;
  state.lastColor = store.ui.wireColor;
  state.lastSelKey = selKey(store.ui.selection);
  state.lastMode = store.ui.mode;
  renderProps();
  renderChecks();
  renderRunPanel();
  syncToolButtons();
  syncToolbarProject();
  syncSelectionButtons();
  syncRunLoop();

  const unsubProject = store.subscribe(onProjectChange);
  const unsubUi = store.subscribeUi(onUiChange);

  return {
    setTab,
    setMode,
    setStatus,
    renderProps,
    renderChecks,
    renderRunPanel,
    destroy() {
      try { unsubProject?.(); } catch { /* ignore */ }
      try { unsubUi?.(); } catch { /* ignore */ }
      stopLoop();
    },
  };
}
