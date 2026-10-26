// board.js — ElectroCookie protoboard geometry (pure JS, no DOM).
//
// Grid unit = one 0.1" hole pitch. x = column (1-based), y = row position:
//   block 0: a..e = 0..4, channel 5,6, f..j = 7..11
//   block 1 (dual board only): k..o = 15..19, channel 20,21, p..t = 22..26
// Rails: tp (top outer "+", y=-3), tm (top inner "−", y=-2),
//        bm (bottom inner "−", y=maxRowY+3), bp (bottom outer "+", y=maxRowY+4).
// Rail holes live at cols 3..cols-3. `railSplit` cuts each rail at its middle column.

export const BOARD_PRESETS = {
  mini: { cols: 17, blocks: 1, rails: false },
  half: { cols: 30, blocks: 1, rails: true },
  dual: { cols: 30, blocks: 2, rails: true },
  full: { cols: 63, blocks: 1, rails: true },
};

export const ROW_Y = {
  a: 0, b: 1, c: 2, d: 3, e: 4,
  f: 7, g: 8, h: 9, i: 10, j: 11,
  k: 15, l: 16, m: 17, n: 18, o: 19,
  p: 22, q: 23, r: 24, s: 25, t: 26,
};

/** Row letters per block, split into the two 5-hole strips (upper / lower). */
export const BLOCK_ROWS = [
  [['a', 'b', 'c', 'd', 'e'], ['f', 'g', 'h', 'i', 'j']],
  [['k', 'l', 'm', 'n', 'o'], ['p', 'q', 'r', 's', 't']],
];

export const RAIL_IDS = ['tp', 'tm', 'bm', 'bp'];
export const RAIL_LABEL = { tp: 'T+', tm: 'T−', bm: 'B−', bp: 'B+' };
export const RAIL_POLARITY = { tp: '+', tm: '−', bm: '−', bp: '+' };

export const RAIL_FIRST_COL = 3;

function normalizeCfg(cfg) {
  if (typeof cfg === 'string') cfg = { kind: cfg };
  const kind = cfg && BOARD_PRESETS[cfg.kind] ? cfg.kind : 'half';
  return { kind, railSplit: !!(cfg && cfg.railSplit) };
}

/**
 * Build a board model.
 * @param {{kind:'half'|'mini'|'dual'|'full', railSplit?:boolean}|string} cfg
 */
export function makeBoard(cfg) {
  const norm = normalizeCfg(cfg);
  const preset = BOARD_PRESETS[norm.kind];
  const cols = preset.cols;
  const blocks = [];
  const rows = [];
  const rowY = {};
  const holes = [];
  const byId = new Map();
  const byXY = new Map();
  const stripMap = new Map(); // stripId -> hole ids
  const stripKind = new Map(); // stripId -> 'strip' | 'rail'
  const xyKey = (x, y) => `${x},${y}`;

  // ---- strip holes -------------------------------------------------------
  for (let b = 0; b < preset.blocks; b++) {
    const [upper, lower] = BLOCK_ROWS[b];
    const channelY = [ROW_Y[upper[4]] + 1, ROW_Y[upper[4]] + 2];
    blocks.push({
      index: b,
      upperRows: upper.slice(),
      lowerRows: lower.slice(),
      rows: [...upper, ...lower],
      channelY,
      y0: ROW_Y[upper[0]],
      y1: ROW_Y[lower[4]],
    });
    for (const half of [upper, lower]) {
      for (const letter of half) {
        rows.push(letter);
        rowY[letter] = ROW_Y[letter];
      }
      for (let col = 1; col <= cols; col++) {
        const stripId = `s:${half[0]}${col}`;
        stripKind.set(stripId, 'strip');
        const members = [];
        for (const letter of half) {
          const id = `h:${letter}${col}`;
          const hole = { id, kind: 'strip', x: col, y: ROW_Y[letter], row: letter, col, block: b, strip: stripId };
          holes.push(hole);
          byId.set(id, hole);
          byXY.set(xyKey(col, hole.y), hole);
          members.push(id);
        }
        stripMap.set(stripId, members);
      }
    }
  }
  const maxRowY = blocks[blocks.length - 1].y1;

  // ---- rails -------------------------------------------------------------
  const rails = [];
  if (preset.rails) {
    const first = RAIL_FIRST_COL;
    const last = cols - RAIL_FIRST_COL;
    const mid = Math.floor((first + last) / 2);
    const railY = { tp: -3, tm: -2, bm: maxRowY + 3, bp: maxRowY + 4 };
    for (const rid of RAIL_IDS) {
      const railCols = [];
      for (let c = first; c <= last; c++) railCols.push(c);
      const segments = norm.railSplit
        ? [
            { id: `rail:${rid}:L`, cols: railCols.filter((c) => c <= mid) },
            { id: `rail:${rid}:R`, cols: railCols.filter((c) => c > mid) },
          ]
        : [{ id: `rail:${rid}`, cols: railCols }];
      const rail = {
        id: rid,
        polarity: RAIL_POLARITY[rid],
        label: RAIL_LABEL[rid],
        y: railY[rid],
        cols: railCols,
        from: first,
        to: last,
        split: norm.railSplit,
        segments,
      };
      rails.push(rail);
      for (const seg of segments) {
        stripKind.set(seg.id, 'rail');
        const members = [];
        for (const col of seg.cols) {
          const id = `r:${rid}:${col}`;
          const hole = { id, kind: 'rail', x: col, y: rail.y, row: rid, col, rail: rid, strip: seg.id };
          holes.push(hole);
          byId.set(id, hole);
          byXY.set(xyKey(col, hole.y), hole);
          members.push(id);
        }
        stripMap.set(seg.id, members);
      }
    }
  }

  // ---- bounds ------------------------------------------------------------
  const minY = preset.rails ? -3.5 : -0.5;
  const maxY = preset.rails ? maxRowY + 4.5 : maxRowY + 0.5;
  const bounds = {
    minX: 0.5,
    maxX: cols + 0.5,
    minY,
    maxY,
    x: 0.5,
    y: minY,
    w: cols,
    h: maxY - minY,
  };

  // ---- lookups -----------------------------------------------------------
  function holeAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const h = byXY.get(xyKey(Math.round(x), Math.round(y)));
    return h ? h.id : null;
  }
  function holeById(id) {
    return byId.get(id) || null;
  }
  function classify(x, y) {
    if (holeAt(x, y)) return 'hole';
    if (x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY) return 'channel';
    return 'offboard';
  }
  function label(id) {
    if (typeof id !== 'string') return String(id);
    const h = byId.get(id);
    if (h) return h.kind === 'rail' ? `${RAIL_LABEL[h.rail]} ${h.col}` : `${h.row}${h.col}`;
    if (id.startsWith('h:')) return id.slice(2);
    if (id.startsWith('r:')) {
      const [, rail, col] = id.split(':');
      return `${RAIL_LABEL[rail] || rail} ${col}`;
    }
    if (id.startsWith('p:')) {
      const i = id.indexOf(':', 2);
      return i < 0 ? id.slice(2) : `${id.slice(2, i)} ${id.slice(i + 1)}`;
    }
    return id;
  }
  function stripOf(id) {
    const h = byId.get(id);
    return h ? h.strip : null;
  }
  function stripMembers(stripId) {
    const m = stripMap.get(stripId);
    return m ? m.slice() : [];
  }
  function strips() {
    const out = [];
    for (const [id, members] of stripMap) out.push({ id, kind: stripKind.get(id), members: members.slice() });
    return out;
  }
  function railOf(id) {
    const h = byId.get(id);
    return h && h.kind === 'rail' ? h.rail : null;
  }

  return {
    cfg: norm,
    kind: norm.kind,
    railSplit: norm.railSplit,
    cols,
    rows,
    rowY,
    blocks,
    maxRowY,
    rails,
    bounds,
    holes,
    stripHoles: holes.filter((h) => h.kind === 'strip'),
    railHoles: holes.filter((h) => h.kind === 'rail'),
    holeAt,
    holeById,
    classify,
    label,
    stripOf,
    stripMembers,
    strips,
    railOf,
  };
}
