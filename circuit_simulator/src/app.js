// app.js — ProtoPlanner bootstrap.
//
// Boot order (plan §8): saved project or preset → store → restore saved UI →
// renderer → interactions → panels → first render → fit view (first run only).
// Toolbar/palette/panel behaviors live in panels.js; this file only wires the
// two controls outside that contract (#btn-help, #btn-import) and page-level
// glue (run-mode body attribute, autosave flush, error reporting).

import { createStore, loadSavedProject, loadSavedUi } from './store.js';
import { createRenderer } from './render.js';
import { attachInteractions } from './interact.js';
import { initPanels } from './panels.js';
import * as io from './io.js';
import * as presets from './presets.js';

const $ = id => document.getElementById(id);

function setStatus(text, isError = false) {
  const el = $('status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', isError);
}

/** Remove duplicate <option>s (same value) that can appear if both the HTML
 *  and panels.js populate a select. Keeps the first occurrence. */
function dedupeOptions(select) {
  if (!select) return;
  const seen = new Set();
  for (const opt of [...select.options]) {
    if (seen.has(opt.value)) opt.remove();
    else seen.add(opt.value);
  }
}

function wireHelpDialog() {
  const dlg = $('help');
  const btn = $('btn-help');
  if (!dlg || !btn) return;
  const canDialog = typeof dlg.showModal === 'function';
  const toggle = () => {
    if (dlg.open) dlg.close();
    else if (canDialog) dlg.showModal();
    else dlg.setAttribute('open', '');
  };
  btn.addEventListener('click', toggle);
  for (const closer of dlg.querySelectorAll('[data-close-help]')) {
    closer.addEventListener('click', () => dlg.close());
  }
  // Click on the backdrop closes.
  dlg.addEventListener('click', ev => {
    if (ev.target === dlg) dlg.close();
  });
  // "?" anywhere (outside inputs) opens help.
  window.addEventListener('keydown', ev => {
    if (ev.key !== '?' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    ev.preventDefault();
    toggle();
  });
}

function wireImportButton() {
  const btn = $('btn-import');
  const input = $('file-import');
  if (!btn || !input) return;
  btn.addEventListener('click', () => {
    input.value = ''; // allow re-importing the same file
    input.click();
  });
}

function boot() {
  const svg = $('canvas');
  if (!svg) throw new Error('#canvas not found in index.html');

  // 1. Project: autosave or the fishing-receiver preset on first run.
  const saved = loadSavedProject();
  const project = saved ?? presets.fishingReceiverPreset();
  const store = createStore(project);

  // 2. Restore persisted UI (tool, wireColor, view) before anything renders.
  const savedUi = loadSavedUi();
  if (savedUi) store.setUi(savedUi);

  // 3. Renderer, interactions, panels.
  const renderer = createRenderer(svg, store);
  const interact = attachInteractions(svg, store, renderer, {
    onStatus: text => setStatus(text ?? ''),
  });
  initPanels({ store, renderer, interact, io, presets });

  for (const id of ['sel-wire-color', 'sel-board', 'sel-preset']) dedupeOptions($(id));

  // 4. First paint.
  renderer.render();
  if (!savedUi?.view && typeof renderer.fitView === 'function') renderer.fitView();

  // 5. Page-level glue.
  wireHelpDialog();
  wireImportButton();

  const syncMode = ui => {
    document.body.dataset.mode = ui.mode === 'run' ? 'run' : 'edit';
  };
  syncMode(store.ui);
  store.subscribeUi((ui, patch) => {
    if ('mode' in patch) syncMode(ui);
  });

  const flush = () => {
    try {
      store.flush();
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  const name = store.get().meta?.name;
  setStatus(
    saved
      ? `Restored autosaved project${name ? ` "${name}"` : ''}. Hover a hole to see its net.`
      : `Loaded preset${name ? ` "${name}"` : ''}. Hover a hole to see its net.`,
  );

  window.__pp = { store, renderer, interact, io, presets };
  return window.__pp;
}

try {
  boot();
} catch (err) {
  console.error('[ProtoPlanner] boot failed', err);
  const msg = err && err.message ? err.message : String(err);
  setStatus(`Failed to start: ${msg} (see console)`, true);
}
