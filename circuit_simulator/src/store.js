// store.js — ProtoPlanner project state.
//
// Owns: the current project document, undo/redo history, autosave,
// the memoized derived model (board / netlist / DRC issues) and the
// non-undoable UI state (tool, mode, selection, wire color, view, sim).
//
// Consumers (render.js, interact.js, panels.js, app.js) must treat the
// object returned by `get()` as read-only and change it only through
// `commit(label, mutator)`.

import { makeBoard } from './board.js';
import { buildNetlist } from './netlist.js';
import { runDrc } from './drc.js';

export const PROJECT_KEY = 'protoplanner.project';
export const UI_KEY = 'protoplanner.ui';
export const UNDO_CAP = 100;
export const AUTOSAVE_MS = 300;

export const TOOLS = ['select', 'wire', 'bridge', 'pan'];
export const MODES = ['edit', 'run'];

export const DEFAULT_VIEW = { tx: 40, ty: 120, scale: 1 };

export function defaultUi() {
  return {
    tool: 'select',
    mode: 'edit',
    selection: null,                 // { kind:'part'|'wire'|'bridge', id } | null
    wireColor: 'red',
    view: { ...DEFAULT_VIEW },       // viewport transform: translate(tx,ty) scale(scale)
    sim: { inputs: null, script: null, startedAt: 0 },
  };
}

// ---------------------------------------------------------------------------
// localStorage helpers (safe in Node and in browsers with storage disabled)
// ---------------------------------------------------------------------------

function hasStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

function readJson(key) {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === '') return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  if (!hasStorage()) return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeKey(key) {
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Saved project from localStorage, or null if absent / unparsable / wrong shape. */
export function loadSavedProject() {
  const p = readJson(PROJECT_KEY);
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (!Array.isArray(p.parts) || !p.board || typeof p.board !== 'object') return null;
  return normalizeProject(p);
}

/** Saved UI subset `{ tool?, wireColor?, view? }` from localStorage, or null. */
export function loadSavedUi() {
  const raw = readJson(UI_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (TOOLS.includes(raw.tool)) out.tool = raw.tool;
  if (typeof raw.wireColor === 'string' && raw.wireColor) out.wireColor = raw.wireColor;
  const v = raw.view;
  if (
    v && typeof v === 'object' &&
    Number.isFinite(v.tx) && Number.isFinite(v.ty) &&
    Number.isFinite(v.scale) && v.scale > 0
  ) {
    out.view = { tx: v.tx, ty: v.ty, scale: v.scale };
  }
  return Object.keys(out).length ? out : null;
}

/** Remove both autosave keys. */
export function clearSaved() {
  removeKey(PROJECT_KEY);
  removeKey(UI_KEY);
}

// ---------------------------------------------------------------------------
// Project helpers
// ---------------------------------------------------------------------------

/** Deep copy of plain JSON data. */
export function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/** Fill in missing top-level fields so consumers can rely on the shape. Mutates and returns `p`. */
export function normalizeProject(p) {
  if (!p || typeof p !== 'object') throw new TypeError('project must be an object');
  if (p.version == null) p.version = 1;
  if (!p.meta || typeof p.meta !== 'object') p.meta = {};
  if (!p.board || typeof p.board !== 'object') p.board = { kind: 'half', railSplit: false };
  if (!p.board.kind) p.board.kind = 'half';
  if (typeof p.board.railSplit !== 'boolean') p.board.railSplit = false;
  if (!Array.isArray(p.parts)) p.parts = [];
  if (!Array.isArray(p.wires)) p.wires = [];
  if (!Array.isArray(p.bridges)) p.bridges = [];
  return p;
}

/**
 * Remove the selected item from a draft project, cascading as required.
 *   - part  → removes the part and every wire whose `a` or `b` is `p:{id}:...`
 *   - wire  → removes that wire (plain jumper or plug)
 *   - bridge→ removes that bridge
 * Intended to be called inside a `commit('delete', draft => ...)` mutator.
 * Returns true if anything was removed.
 */
export function cascadeDelete(draft, selection) {
  if (!draft || !selection) return false;
  const kind = selection.kind;
  const id = selection.id;
  if (!kind || id == null) return false;
  normalizeProject(draft);

  if (kind === 'part') {
    const before = draft.parts.length + draft.wires.length;
    draft.parts = draft.parts.filter(p => p.id !== id);
    const prefix = `p:${id}:`;
    draft.wires = draft.wires.filter(
      w => !(String(w.a ?? '').startsWith(prefix) || String(w.b ?? '').startsWith(prefix)),
    );
    return draft.parts.length + draft.wires.length !== before;
  }
  if (kind === 'wire') {
    const before = draft.wires.length;
    draft.wires = draft.wires.filter(w => w.id !== id);
    return draft.wires.length !== before;
  }
  if (kind === 'bridge') {
    const before = draft.bridges.length;
    draft.bridges = draft.bridges.filter(b => b.id !== id);
    return draft.bridges.length !== before;
  }
  return false;
}

/** True if `selection` still refers to an existing item in `project`. */
export function selectionExists(project, selection) {
  if (!selection || !project) return false;
  const { kind, id } = selection;
  if (kind === 'part') return project.parts.some(p => p.id === id);
  if (kind === 'wire') return project.wires.some(w => w.id === id);
  if (kind === 'bridge') return project.bridges.some(b => b.id === id);
  return false;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function emptyNetlist() {
  return { nets: [], netOf: new Map(), byName: new Map(), dangling: [] };
}

/**
 * createStore(initialProject) → Store
 *
 * Store API (plan §4/§5):
 *   get()                              current project (read-only by convention)
 *   commit(label, mutator)             clone → mutator(draft) → history → notify → autosave
 *                                      (mutator returning `false` aborts the commit)
 *   replace(project, {resetHistory})   swap in an imported / preset project
 *   undo() / redo()                    → boolean (did anything)
 *   canUndo() / canRedo()
 *   subscribe(fn(project, label))      → unsubscribe
 *   derived()                          memoized { board, netlist, issues }
 *   ui                                 non-undoable UI state object (live reference)
 *   setUi(patch)                       shallow merge → notify ui listeners → persist subset
 *   subscribeUi(fn(ui, patch))         → unsubscribe
 *   flush()                            write pending autosaves immediately
 *   historyLength()                    → { undo, redo }
 */
export function createStore(initialProject) {
  let project = normalizeProject(clone(initialProject));
  const undoStack = [];
  const redoStack = [];
  const listeners = new Set();
  const uiListeners = new Set();
  let memo = null;
  let saveTimer = null;
  let uiSaveTimer = null;

  const ui = defaultUi();

  // -- persistence ---------------------------------------------------------

  function saveProjectNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writeJson(PROJECT_KEY, project);
  }

  function scheduleSave() {
    if (!hasStorage()) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProjectNow, AUTOSAVE_MS);
  }

  function saveUiNow() {
    if (uiSaveTimer) {
      clearTimeout(uiSaveTimer);
      uiSaveTimer = null;
    }
    writeJson(UI_KEY, { tool: ui.tool, wireColor: ui.wireColor, view: ui.view });
  }

  function scheduleUiSave() {
    if (!hasStorage()) return;
    if (uiSaveTimer) clearTimeout(uiSaveTimer);
    uiSaveTimer = setTimeout(saveUiNow, AUTOSAVE_MS);
  }

  function flush() {
    if (saveTimer) saveProjectNow();
    if (uiSaveTimer) saveUiNow();
  }

  // -- notification --------------------------------------------------------

  function notify(label) {
    for (const fn of [...listeners]) {
      try {
        fn(project, label);
      } catch (err) {
        console.error('[store] subscriber failed on', label, err);
      }
    }
  }

  function notifyUi(patch) {
    for (const fn of [...uiListeners]) {
      try {
        fn(ui, patch);
      } catch (err) {
        console.error('[store] ui subscriber failed', err);
      }
    }
  }

  /** Install `next` as current project; drop stale selection; notify; autosave. */
  function install(next, label) {
    project = next;
    memo = null;
    if (ui.selection && !selectionExists(project, ui.selection)) {
      setUi({ selection: null });
    }
    notify(label);
    scheduleSave();
  }

  // -- public API ----------------------------------------------------------

  function get() {
    return project;
  }

  function commit(label, mutator) {
    if (typeof mutator !== 'function') throw new TypeError('commit(label, mutator): mutator must be a function');
    const draft = clone(project);
    const result = mutator(draft);
    if (result === false) return project; // mutator opted out — nothing changes
    normalizeProject(draft);
    draft.meta.modified = Date.now();

    undoStack.push(project);
    if (undoStack.length > UNDO_CAP) undoStack.splice(0, undoStack.length - UNDO_CAP);
    redoStack.length = 0;

    install(draft, label);
    return project;
  }

  function replace(next, { resetHistory = true } = {}) {
    const incoming = normalizeProject(clone(next));
    if (resetHistory) {
      undoStack.length = 0;
      redoStack.length = 0;
    } else {
      undoStack.push(project);
      if (undoStack.length > UNDO_CAP) undoStack.splice(0, undoStack.length - UNDO_CAP);
      redoStack.length = 0;
    }
    install(incoming, 'replace');
    return project;
  }

  function undo() {
    if (!undoStack.length) return false;
    redoStack.push(project);
    install(undoStack.pop(), 'undo');
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    undoStack.push(project);
    install(redoStack.pop(), 'redo');
    return true;
  }

  function canUndo() {
    return undoStack.length > 0;
  }

  function canRedo() {
    return redoStack.length > 0;
  }

  function historyLength() {
    return { undo: undoStack.length, redo: redoStack.length };
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe(fn): fn must be a function');
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /**
   * Memoized derived model. Recomputed lazily after every commit / replace /
   * undo / redo. A failure in the netlist or DRC stage is reported as an
   * `ENGINE_ERROR` issue (and logged) instead of crashing the UI; a board
   * failure is fatal and rethrown.
   */
  function derived() {
    if (memo) return memo;
    const board = makeBoard(project.board);
    let netlist;
    let issues;
    const internal = [];
    try {
      netlist = buildNetlist(project, board);
    } catch (err) {
      console.error('[store] buildNetlist failed', err);
      netlist = emptyNetlist();
      internal.push({
        id: 'engine:netlist',
        severity: 'error',
        code: 'ENGINE_ERROR',
        message: `Netlist failed: ${err && err.message ? err.message : err}`,
        refs: {},
      });
    }
    try {
      issues = runDrc(project, board, netlist);
      if (!Array.isArray(issues)) issues = [];
    } catch (err) {
      console.error('[store] runDrc failed', err);
      issues = [];
      internal.push({
        id: 'engine:drc',
        severity: 'error',
        code: 'ENGINE_ERROR',
        message: `Design-rule check failed: ${err && err.message ? err.message : err}`,
        refs: {},
      });
    }
    if (internal.length) issues = [...internal, ...issues];
    memo = { board, netlist, issues };
    return memo;
  }

  function setUi(patch) {
    if (!patch || typeof patch !== 'object') return ui;
    Object.assign(ui, patch);
    notifyUi(patch);
    if ('tool' in patch || 'wireColor' in patch || 'view' in patch) scheduleUiSave();
    return ui;
  }

  function subscribeUi(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribeUi(fn): fn must be a function');
    uiListeners.add(fn);
    return () => uiListeners.delete(fn);
  }

  return {
    get,
    commit,
    replace,
    undo,
    redo,
    canUndo,
    canRedo,
    historyLength,
    subscribe,
    derived,
    ui,
    setUi,
    subscribeUi,
    flush,
  };
}
