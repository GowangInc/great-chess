// engine.js — Great Chess (Tamerlane chess) rules engine.
// Pure browser-native ESM. No dependencies. Also runs on Node 24+.
// Board: x 0..10 (files a-k), y 0..9 (ranks 1-10). Key = `${x},${y}`.
// White advances +y. Citadels: white own '11,1', black own '-1,8'.
// All state is JSON-serializable. See RULE_NOTES for reconstruction choices.

export const COLORS = ['white', 'black'];

export const TYPES = {
  king: {
    name: 'King', short: 'K',
    description: 'Royal, highest rank. Moves one square in any direction. While it is your only royal it may never be left attacked. Once per game, when checked or stalemated, it may swap places with any friendly non-royal piece.',
  },
  prince: {
    name: 'Prince', short: 'Pr',
    description: 'Royal, second rank. Moves one square in any direction. Created when the king-pawn (f-file) promotes; becomes the reigning royal if no king remains.',
  },
  adventitious: {
    name: 'Adventitious king', short: 'Ad',
    description: 'Royal, third rank. Moves one square in any direction. Created only by the third promotion of the pawn-of-pawns. It alone may enter its own citadel, where it is immune; if it is your last royal it instead returns to the pawn-of-pawns home square.',
  },
  rook: {
    name: 'Rook', short: 'R',
    description: 'Slides any number of empty squares horizontally or vertically; captures on the destination square.',
  },
  knight: {
    name: 'Knight', short: 'N',
    description: 'Leaps to a square two steps one way and one the other (2,1), jumping over any pieces in between.',
  },
  picket: {
    name: 'Picket', short: 'Pi',
    description: 'Moves diagonally like a bishop but must travel at least two squares; the first diagonal square must be empty and blocks the move.',
  },
  giraffe: {
    name: 'Giraffe', short: 'G',
    description: 'Moves one square diagonally, then three or more squares onward orthogonally away from its start. Every square of the bent path must be empty; only the destination may capture.',
  },
  ferz: {
    name: 'Ferz', short: 'F',
    description: 'Moves exactly one square diagonally in any direction.',
  },
  vizier: {
    name: 'Vizier', short: 'V',
    description: 'Moves exactly one square horizontally or vertically.',
  },
  elephant: {
    name: 'Elephant', short: 'E',
    description: 'Leaps exactly two squares diagonally (2,2), jumping over any piece on the skipped square.',
  },
  camel: {
    name: 'Camel', short: 'C',
    description: 'Leaps to a square three steps one way and one the other (3,1), like an elongated knight, jumping over pieces.',
  },
  engine: {
    name: 'Engine', short: 'En',
    description: 'Leaps exactly two squares horizontally or vertically (2,0), jumping over the skipped square.',
  },
  pawn: {
    name: 'Pawn', short: 'P',
    description: 'Moves one square straight forward onto an empty square and captures one square diagonally forward. Promotion follows the pawn’s original file, even after captures change its file; the king-pawn becomes a prince. Only the pawn starting on White’s a3 (Black’s k8) is the pawn-of-pawns: its three arrivals produce a dormant pawn, a returning pawn, then an adventitious king. The opposite rook-pawn, starting on White’s k3 (Black’s a8), promotes to a rook.',
  },
};

export const RULE_NOTES = [
  '1. Royal exchange: the historical "king swap" is generalized to the highest remaining royal (king, then prince, then adventitious). Once per game per side, only when that royal is attacked or the side otherwise has no legal move; it swaps with any friendly non-royal piece and is legal only if the royal is not attacked after the swap. The swap consumes the turn.',
  '2. Sheltered-royal return is a modern completion of an unresolved historical edge, not an established manuscript rule. When a sheltered adventitious king becomes its side’s only royal, it returns to the pawn-of-pawns home square (white a3, black k8). A non-royal occupant is removed; a royal is never overwritten. If a royal occupies that square, use the nearest empty, unattacked home-pawn square, scanning outward by file distance, then across outward ranks. Voluntary entry must still leave the last royal safe after the return.',
  '3. Pawn-of-pawns second arrival: the pawn returns to the king-pawn home square (white f3 "5,2", black f8 "5,7"), removing a non-royal occupant as captured. If any royal occupies that square the pawn instead waits on the last rank, dormant and immune (awaitingReturn), and the return auto-resolves after any later move once the square is free of royals (history kind "return", no turn or ply change).',
  '4. Deployment of the pawn-of-pawns: qualifying squares are computed with the full legal-move generator — enemy escape includes capturing the deployed pawn, moving the unit, and respects pins and friendly covering; a merely forward-blocked pawn is not falsely trapped if it can capture. If no square qualifies, ordinary moves are allowed and the pawn stays dormant. Deployment may replace an own or enemy non-royal occupant but never a royal and never an immune (dormant) piece. Deployment onto the last rank does not count as an arrival. The escape simulation is bounded to depth 3; deeper nesting conservatively treats the unit as escaping (unreachable in normal play).',
  '5. Opponent-citadel entry: only the highest royal may enter. The entering move ends the move part of the turn but the mover must immediately choose: citadel-draw (result draw, reason "citadel draw") or, once per game, citadel-swap with another own royal; the choice consumes the same turn (ply is not incremented again). If no swap is available the draw is forced.',
  '6. Checkmate OR stalemate loses: a side to move with at least one royal and no legal moves loses — reason "checkmate" if its highest royal is attacked, else "stalemate". There are no fifty-move or repetition draws; draws arise only from the citadel declaration or by agreement/resignation handled by the server.',
  '7. Check means the highest remaining royal is attacked. With two or more royals, royals may be exposed and captured like ordinary pieces; the last royal may never be left attacked. A side with no royal at all is treated as non-terminal so tutorial and sparse custom positions remain playable.',
  '8. Picket: a diagonal slider with a two-square minimum; the first diagonal square must be empty and blocks everything beyond. Giraffe: one diagonal step then three or more outward orthogonal steps; the entire bent path (including unlandable intermediate squares) must be empty and no U-turns are allowed.',
  '9. Attribution: the game\'s invention by Timur (Tamerlane) is tradition, not established history. These rules follow the full reconstruction at tamerlaneschess.wordpress.com (2017-03-24), corroborated by en.wikipedia.org/wiki/Tamerlane_chess and en.chessbase.com/post/tamerlane-chess-revived. The chessvariants.com historical page was inaccessible (HTTP 403); the moddable source contained contradictions and was rejected as non-authoritative.',
];

const FILES = 'abcdefghijk';
const key = (x, y) => x + ',' + y;
const parseKey = (k) => {
  const i = k.indexOf(',');
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
};
const onBoard = (x, y) => x >= 0 && x <= 10 && y >= 0 && y <= 9;
const WHITE_CITADEL = '11,1';
const BLACK_CITADEL = '-1,8';
const CITADEL_KEYS = new Set([WHITE_CITADEL, BLACK_CITADEL]);
const OWN_CITADEL = { white: WHITE_CITADEL, black: BLACK_CITADEL };
const OPP_CITADEL = { white: BLACK_CITADEL, black: WHITE_CITADEL };
const ROYAL_RANK = { king: 0, prince: 1, adventitious: 2 };
const isRoyal = (t) => t === 'king' || t === 'prince' || t === 'adventitious';
const opponent = (c) => (c === 'white' ? 'black' : 'white');
const PAWN_FILE_PROMOTION = ['pawn', 'engine', 'camel', 'elephant', 'ferz', 'prince', 'vizier', 'giraffe', 'picket', 'knight', 'rook'];
const PAWN_OF_PAWNS_ORIGIN = { white: '0,2', black: '10,7' };
const KING_PAWN_HOME = { white: '5,2', black: '5,7' };
const FAR_RANK = { white: 9, black: 0 };
const PAWN_DIR = { white: 1, black: -1 };

const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const STEPS8 = [...ORTH, ...DIAG];
const LEAPS = {
  knight: [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]],
  camel: [[1, 3], [3, 1], [-1, 3], [-3, 1], [1, -3], [3, -1], [-1, -3], [-3, -1]],
  elephant: [[2, 2], [2, -2], [-2, 2], [-2, -2]],
  engine: [[2, 0], [-2, 0], [0, 2], [0, -2]],
};

export function emptyState() {
  return {
    board: {},
    turn: 'white',
    ply: 0,
    history: [],
    result: null,
    exchangeUsed: { white: false, black: false },
    citadelUsed: { white: false, black: false },
    pendingCitadel: null,
  };
}

export function initialState() {
  const s = emptyState();
  const board = s.board;
  const counts = {};
  const put = (x, y, color, type, extra) => {
    const ck = color + ':' + type;
    const n = counts[ck] || 0;
    counts[ck] = n + 1;
    board[key(x, y)] = { id: color[0] + '-' + type + '-' + n, type, color, ...(extra || {}) };
  };
  put(0, 0, 'white', 'elephant'); put(10, 0, 'white', 'elephant');
  put(2, 0, 'white', 'camel'); put(8, 0, 'white', 'camel');
  put(4, 0, 'white', 'engine'); put(6, 0, 'white', 'engine');
  ['rook', 'knight', 'picket', 'giraffe', 'ferz', 'king', 'vizier', 'giraffe', 'picket', 'knight', 'rook']
    .forEach((t, x) => put(x, 1, 'white', t));
  PAWN_FILE_PROMOTION.forEach((promo, x) => put(x, 2, 'white', 'pawn', { promotion: promo }));
  // Black: exact 180-degree rotation of white.
  put(0, 9, 'black', 'elephant'); put(10, 9, 'black', 'elephant');
  put(2, 9, 'black', 'camel'); put(8, 9, 'black', 'camel');
  put(4, 9, 'black', 'engine'); put(6, 9, 'black', 'engine');
  ['rook', 'knight', 'picket', 'giraffe', 'vizier', 'king', 'ferz', 'giraffe', 'picket', 'knight', 'rook']
    .forEach((t, x) => put(x, 8, 'black', t));
  [...PAWN_FILE_PROMOTION].reverse().forEach((promo, x) => put(x, 7, 'black', 'pawn', { promotion: promo }));
  return s;
}

export function squareName(k) {
  if (k === WHITE_CITADEL) return 'white citadel';
  if (k === BLACK_CITADEL) return 'black citadel';
  const [x, y] = parseKey(k);
  if (!onBoard(x, y)) return k;
  return FILES[x] + (y + 1);
}

// Royals of a color, keys sorted by rank (highest first).
function royalList(board, color) {
  const out = [];
  for (const k of Object.keys(board)) {
    const p = board[k];
    if (p.color === color && isRoyal(p.type)) out.push(k);
  }
  out.sort((a, b) => ROYAL_RANK[board[a].type] - ROYAL_RANK[board[b].type]);
  return out;
}

function highestRoyalId(board, color) {
  const r = royalList(board, color);
  return r.length ? board[r[0]].id : null;
}

// Reverse attack detection: is `targetKey` attacked by `byColor`?
// Citadel squares are valid attack targets (a royal there can be menaced).
function isAttacked(board, targetKey, byColor) {
  const [x, y] = parseKey(targetKey);
  // Pawns
  const dir = PAWN_DIR[byColor];
  for (const dx of [-1, 1]) {
    const px = x + dx, py = y - dir;
    if (onBoard(px, py)) {
      const q = board[key(px, py)];
      if (q && q.color === byColor && q.type === 'pawn') return true;
    }
  }
  // Leapers
  for (const type of ['knight', 'camel', 'elephant', 'engine']) {
    for (const [dx, dy] of LEAPS[type]) {
      const cx = x + dx, cy = y + dy;
      if (!onBoard(cx, cy)) continue;
      const q = board[key(cx, cy)];
      if (q && q.color === byColor && q.type === type) return true;
    }
  }
  // Royal steps / ferz / vizier (a royal may also attack from a citadel square)
  for (const [dx, dy] of STEPS8) {
    const cx = x + dx, cy = y + dy;
    if (!onBoard(cx, cy) && !CITADEL_KEYS.has(key(cx, cy))) continue;
    const q = board[key(cx, cy)];
    if (!q || q.color !== byColor) continue;
    if (isRoyal(q.type)) return true;
    if (q.type === 'ferz' && dx !== 0 && dy !== 0) return true;
    if (q.type === 'vizier' && (dx === 0) !== (dy === 0)) return true;
  }
  // Rook rays
  for (const [dx, dy] of ORTH) {
    for (let d = 1; ; d++) {
      const cx = x + dx * d, cy = y + dy * d;
      if (!onBoard(cx, cy)) break;
      const q = board[key(cx, cy)];
      if (q) {
        if (q.color === byColor && q.type === 'rook') return true;
        break;
      }
    }
  }
  // Picket rays: first square blocks; attacker at distance >= 2
  for (const [dx, dy] of DIAG) {
    for (let d = 1; ; d++) {
      const cx = x + dx * d, cy = y + dy * d;
      if (!onBoard(cx, cy)) break;
      const q = board[key(cx, cy)];
      if (q) {
        if (d >= 2 && q.color === byColor && q.type === 'picket') return true;
        break;
      }
    }
  }
  // Giraffe: walk back along each outward orthogonal ray; the diagonal
  // square must be empty and the giraffe sits one further diagonal step.
  for (const [dx, dy] of DIAG) {
    for (const [ox, oy] of [[dx, 0], [0, dy]]) {
      for (let n = 1; ; n++) {
        const cx = x - ox * n, cy = y - oy * n;
        if (!onBoard(cx, cy)) break;
        if (board[key(cx, cy)]) break;
        if (n >= 3) {
          const sx = cx - dx, sy = cy - dy;
          if (onBoard(sx, sy)) {
            const g = board[key(sx, sy)];
            if (g && g.color === byColor && g.type === 'giraffe') return true;
          }
        }
      }
    }
  }
  return false;
}

// Pseudo-legal destination keys for piece p at k (no royal-safety filter).
// `highestId` = id of the highest royal of p.color (for citadel entry).
function pseudoMoves(board, k, p, highestId) {
  const [x, y] = parseKey(k);
  const out = [];
  const land = (cx, cy) => {
    if (!onBoard(cx, cy)) return;
    const occ = board[key(cx, cy)];
    if (!occ) out.push(key(cx, cy));
    else if (occ.color !== p.color && !occ.dormant) out.push(key(cx, cy));
  };
  const ray = (dirs, minDist) => {
    for (const [dx, dy] of dirs) {
      let d = 0, cx = x + dx, cy = y + dy;
      while (onBoard(cx, cy)) {
        d++;
        const kk = key(cx, cy);
        const occ = board[kk];
        if (minDist > 1 && d === 1) {
          if (occ) break; // first square blocks
        } else {
          if (occ) {
            if (occ.color !== p.color && !occ.dormant) out.push(kk);
            break;
          }
          out.push(kk);
        }
        cx += dx; cy += dy;
      }
    }
  };
  switch (p.type) {
    case 'king':
    case 'prince':
    case 'adventitious': {
      for (const [dx, dy] of STEPS8) land(x + dx, y + dy);
      if (p.id === highestId) {
        const oc = OPP_CITADEL[p.color];
        const [ox, oy] = parseKey(oc);
        if (Math.abs(ox - x) <= 1 && Math.abs(oy - y) <= 1 && !board[oc]) out.push(oc);
      }
      if (p.type === 'adventitious') {
        const oc = OWN_CITADEL[p.color];
        const [ox, oy] = parseKey(oc);
        if (Math.abs(ox - x) <= 1 && Math.abs(oy - y) <= 1 && !board[oc]) out.push(oc);
      }
      break;
    }
    case 'ferz': for (const [dx, dy] of DIAG) land(x + dx, y + dy); break;
    case 'vizier': for (const [dx, dy] of ORTH) land(x + dx, y + dy); break;
    case 'knight':
    case 'camel':
    case 'elephant':
    case 'engine':
      for (const [dx, dy] of LEAPS[p.type]) land(x + dx, y + dy);
      break;
    case 'rook': ray(ORTH, 1); break;
    case 'picket': ray(DIAG, 2); break;
    case 'giraffe': {
      for (const [dx, dy] of DIAG) {
        const mx = x + dx, my = y + dy;
        if (!onBoard(mx, my) || board[key(mx, my)]) continue;
        for (const [ox, oy] of [[dx, 0], [0, dy]]) {
          for (let n = 1; ; n++) {
            const cx = mx + ox * n, cy = my + oy * n;
            if (!onBoard(cx, cy)) break;
            const occ = board[key(cx, cy)];
            if (occ) {
              if (n >= 3 && occ.color !== p.color && !occ.dormant) out.push(key(cx, cy));
              break;
            }
            if (n >= 3) out.push(key(cx, cy));
          }
        }
      }
      break;
    }
    case 'pawn': {
      const dir = PAWN_DIR[p.color];
      const fy = y + dir;
      if (onBoard(x, fy) && !board[key(x, fy)]) out.push(key(x, fy));
      for (const dx of [-1, 1]) {
        const cx = x + dx;
        if (!onBoard(cx, fy)) continue;
        const occ = board[key(cx, fy)];
        if (occ && occ.color !== p.color && !occ.dormant) out.push(key(cx, fy));
      }
      break;
    }
    default:
      break;
  }
  return out;
}

// Count of pseudo moves (mobility heuristic; no allocations of move objects).
function pseudoCount(board, color) {
  const hid = highestRoyalId(board, color);
  let n = 0;
  for (const k of Object.keys(board)) {
    const p = board[k];
    if (p.color === color && !p.dormant) n += pseudoMoves(board, k, p, hid).length;
  }
  return n;
}

// Can the attacked enemy unit escape a pawn deployed to `s`? Simulates the
// post-deploy position with the enemy to move: the unit escapes iff the
// enemy has ANY fully legal move after which the unit is no longer attacked
// by the deployed pawn. Bounded to depth 3 (then conservatively escapes).
function canUnitEscape(state, pawnKey, s, unit, sim) {
  if (sim >= 3) return true;
  const board = state.board, color = state.turn;
  const pawn = board[pawnKey];
  const nb = { ...board };
  delete nb[pawnKey];
  const moved = { ...pawn };
  delete moved.dormant;
  delete nb[s];
  nb[s] = moved;
  const hypo = { ...state, board: nb, turn: opponent(color), pendingCitadel: null };
  const dir = PAWN_DIR[color];
  const [sx, sy] = parseKey(s);
  const enemyMoves = allLegal(hypo, sim + 1);
  for (const m of enemyMoves) {
    const ns = applyInternal(hypo, m, false);
    const p2 = ns.board[s];
    if (!p2 || p2.id !== pawn.id) return true; // deployed pawn captured
    let uk = null;
    for (const k of Object.keys(ns.board)) {
      if (ns.board[k].id === unit.piece.id) { uk = k; break; }
    }
    if (!uk) return true; // unit gone (should not happen)
    const [ux, uy] = parseKey(uk);
    if (!(uy === sy + dir && Math.abs(ux - sx) === 1)) return true;
  }
  return false;
}

// Deployment squares for a dormant stage-1 pawn-of-pawns at `pawnKey`.
function genDeploys(state, pawnKey, royals, sim) {
  const board = state.board, color = state.turn, dir = PAWN_DIR[color];
  const pawn = board[pawnKey];
  const out = [];
  for (let sy = 0; sy <= 9; sy++) {
    for (let sx = 0; sx <= 10; sx++) {
      const s = key(sx, sy);
      if (s === pawnKey) continue;
      const occ = board[s];
      if (occ && (isRoyal(occ.type) || occ.dormant)) continue;
      const attacked = [];
      for (const dx of [-1, 1]) {
        const tx = sx + dx, ty = sy + dir;
        if (!onBoard(tx, ty)) continue;
        const q = board[key(tx, ty)];
        if (q && q.color !== color && !q.dormant) attacked.push({ key: key(tx, ty), piece: q });
      }
      let qualifies = false;
      if (attacked.length >= 2) qualifies = true;
      else if (attacked.length === 1) qualifies = !canUnitEscape(state, pawnKey, s, attacked[0], sim);
      if (!qualifies) continue;
      if (royals.length === 1) {
        const nb = { ...board };
        delete nb[pawnKey];
        if (occ) delete nb[s];
        nb[s] = pawn;
        if (isAttacked(nb, royals[0], opponent(color))) continue;
      }
      out.push({ from: pawnKey, to: s, kind: 'deploy', ...(occ ? { replaces: occ.id } : {}) });
    }
  }
  return out;
}

function citadelChoiceMoves(state) {
  const pc = state.pendingCitadel;
  const out = [{ from: pc.citadel, to: pc.citadel, kind: 'citadel-draw' }];
  if (!state.citadelUsed[pc.color]) {
    for (const rk of royalList(state.board, pc.color)) {
      const p = state.board[rk];
      if (p.id !== pc.royal) out.push({ from: pc.citadel, to: rk, kind: 'citadel-swap', with: p.id });
    }
  }
  return out;
}

// Full legal move list for state.turn. `sim` bounds deploy-escape recursion.
function allLegal(state, sim) {
  sim = sim || 0;
  if (state.result) return [];
  const board = state.board, color = state.turn;
  if (state.pendingCitadel) return citadelChoiceMoves(state);
  const royals = royalList(board, color);
  const hid = royals.length ? board[royals[0]].id : null;
  const pendingReturns = Object.keys(board).some((k) => board[k].awaitingReturn ||
    (board[k].type === 'adventitious' && k === OWN_CITADEL[board[k].color]));
  // Forced deployment of a dormant pawn-of-pawns.
  let dormKey = null;
  for (const k of Object.keys(board)) {
    const p = board[k];
    if (p.color === color && p.type === 'pawn' && p.promotion === 'pawn' && p.dormant && !p.awaitingReturn) {
      dormKey = k;
      break;
    }
  }
  if (dormKey) {
    const deploys = genDeploys(state, dormKey, royals, sim);
    if (deploys.length) return deploys;
  }
  const moves = [];
  const keys = Object.keys(board);
  for (const k of keys) {
    const p = board[k];
    if (p.color !== color || p.dormant) continue;
    const dests = pseudoMoves(board, k, p, hid);
    for (const to of dests) {
      const transforms = pendingReturns ||
        (p.type === 'pawn' && parseKey(to)[1] === FAR_RANK[color]) ||
        (p.type === 'adventitious' && to === OWN_CITADEL[color]);
      if (transforms) {
        const nb = applyInternal(state, { from: k, to, kind: 'move' }, false).board;
        const remaining = royalList(nb, color);
        if (remaining.length === 1 && isAttacked(nb, remaining[0], opponent(color))) continue;
      } else if (royals.length === 1) {
        const nb = { ...board };
        delete nb[k];
        nb[to] = p;
        if (isAttacked(nb, k === royals[0] ? to : royals[0], opponent(color))) continue;
      }
      moves.push({ from: k, to, kind: 'move' });
    }
  }
  // Royal exchange: once per game, in check or otherwise stalemated.
  if (!state.exchangeUsed[color] && royals.length) {
    const hk = royals[0];
    if (isAttacked(board, hk, opponent(color)) || moves.length === 0) {
      for (const k of keys) {
        const p = board[k];
        if (p.color !== color || isRoyal(p.type)) continue;
        const nb = { ...board };
        nb[hk] = p;
        nb[k] = board[hk];
        if (!isAttacked(nb, k, opponent(color))) moves.push({ from: hk, to: k, kind: 'exchange' });
      }
    }
  }
  return moves;
}

export function legalMoves(state, from = null) {
  const ms = allLegal(state, 0);
  return from == null ? ms : ms.filter((m) => m.from === from);
}

export function inCheck(state, color) {
  const royals = royalList(state.board, color);
  if (!royals.length) return false;
  return isAttacked(state.board, royals[0], opponent(color));
}

// Pawn-of-pawns home-rank scan for the sole-royal citadel return.
function freeHomeSquareScan(board, color, origin) {
  const [ox] = parseKey(origin);
  const homeY = color === 'white' ? 2 : 7;
  const yStep = color === 'white' ? 1 : -1;
  for (let r = 0; ; r++) {
    const y = homeY + r * yStep;
    if (y < 0 || y > 9) return null;
    for (let d = 0; d <= 10; d++) {
      const xs = d === 0 ? [ox] : [ox - d, ox + d];
      for (const x of xs) {
        if (x < 0 || x > 10) continue;
        if (!board[key(x, y)] && !isAttacked(board, key(x, y), opponent(color))) return key(x, y);
      }
    }
  }
}

function relocateAdventitious(board, color, fromKey, history) {
  const p = board[fromKey];
  const origin = PAWN_OF_PAWNS_ORIGIN[color];
  const occ = board[origin];
  let target = null;
  let captured = null;
  if (!occ || !isRoyal(occ.type)) {
    target = origin;
    captured = occ ? occ.type : null;
  } else {
    target = freeHomeSquareScan(board, color, origin) || fromKey; // full board never occurs
  }
  if (target !== fromKey) {
    delete board[fromKey];
    board[target] = p;
    history.push({
      from: fromKey, to: target, kind: 'return', piece: p.type, color,
      ...(captured ? { capture: captured } : {}),
      notation: TYPES[p.type].short + ' returns ' + squareName(target),
    });
  }
}

function handlePawnArrival(board, toKey, p, color, history) {
  if (p.promotion && p.promotion !== 'pawn') {
    board[toKey] = { ...p, type: p.promotion };
    return;
  }
  const stage = p.stage || 0;
  if (stage === 0) {
    board[toKey] = { ...p, stage: 1, dormant: true };
    return;
  }
  if (stage === 1) {
    const home = KING_PAWN_HOME[color];
    const occ = board[home];
    if (occ && isRoyal(occ.type)) {
      board[toKey] = { ...p, dormant: true, awaitingReturn: true };
      return;
    }
    delete board[toKey];
    const np = { ...p, stage: 2 };
    delete np.dormant;
    delete np.awaitingReturn;
    board[home] = np;
    history.push({
      from: toKey, to: home, kind: 'return', piece: 'pawn', color,
      ...(occ ? { capture: occ.type } : {}),
      notation: 'P returns ' + squareName(home),
    });
    return;
  }
  // stage 2: third arrival -> adventitious king
  const np = { ...p, type: 'adventitious', stage: 3 };
  delete np.dormant;
  delete np.awaitingReturn;
  board[toKey] = np;
}

function resolveAwaitingReturns(board, history) {
  for (const color of COLORS) {
    const keys = Object.keys(board)
      .filter((k) => board[k].awaitingReturn && board[k].color === color)
      .sort();
    for (const k of keys) {
      const home = KING_PAWN_HOME[color];
      const occ = board[home];
      if (occ && isRoyal(occ.type)) continue;
      const p = board[k];
      delete board[k];
      const np = { ...p, stage: 2 };
      delete np.dormant;
      delete np.awaitingReturn;
      board[home] = np;
      history.push({
        from: k, to: home, kind: 'return', piece: 'pawn', color,
        ...(occ ? { capture: occ.type } : {}),
        notation: 'P returns ' + squareName(home),
      });
    }
  }
}

// Applies a move known to be legal. checkEnd: detect mate/stalemate for the
// side to move (true for the public path; skipped inside search/simulation,
// where the caller handles terminals). Never mutates `state`.
function applyInternal(state, move, checkEnd) {
  const kind = move.kind || 'move';
  const color = state.turn;
  const board = { ...state.board };
  const history = state.history.slice();
  let turn = opponent(color);
  let ply = state.ply + 1;
  let result = state.result;
  let exchangeUsed = state.exchangeUsed;
  let citadelUsed = state.citadelUsed;
  let pendingCitadel = null;

  if (kind === 'citadel-draw') {
    const piece = board[move.from];
    history.push({
      from: move.from, to: move.to, kind, piece: piece ? piece.type : 'king', color,
      notation: 'citadel draw',
    });
    result = { winner: null, reason: 'citadel draw' };
    ply = state.ply; // choice consumes the same turn
  } else if (kind === 'citadel-swap') {
    const a = board[move.from];
    const b = board[move.to];
    board[move.from] = b;
    board[move.to] = a;
    citadelUsed = { ...citadelUsed, [color]: true };
    history.push({
      from: move.from, to: move.to, kind, piece: a.type, color,
      notation: TYPES[a.type].short + ' citadel<->' + squareName(move.to),
    });
    ply = state.ply; // choice consumes the same turn
  } else if (kind === 'exchange') {
    const a = board[move.from];
    const b = board[move.to];
    board[move.from] = b;
    board[move.to] = a;
    exchangeUsed = { ...exchangeUsed, [color]: true };
    history.push({
      from: move.from, to: move.to, kind, piece: a.type, color,
      notation: TYPES[a.type].short + squareName(move.from) + '<->' + squareName(move.to),
    });
  } else if (kind === 'deploy') {
    const pawn = board[move.from];
    const occ = board[move.to];
    delete board[move.from];
    const np = { ...pawn };
    delete np.dormant;
    board[move.to] = np;
    history.push({
      from: move.from, to: move.to, kind, piece: 'pawn', color,
      ...(occ ? { capture: occ.type } : {}),
      notation: 'P deploy ' + squareName(move.to),
    });
  } else {
    const p = board[move.from];
    const occ = board[move.to];
    delete board[move.from];
    board[move.to] = p;
    history.push({
      from: move.from, to: move.to, kind: 'move', piece: p.type, color,
      ...(occ ? { capture: occ.type } : {}),
      notation: TYPES[p.type].short + squareName(move.from) + (occ ? 'x' : '-') + squareName(move.to),
    });
    if (isRoyal(p.type) && move.to === OPP_CITADEL[color]) {
      pendingCitadel = { color, royal: p.id, citadel: move.to };
      turn = color; // mover must immediately choose
    } else if (p.type === 'adventitious' && move.to === OWN_CITADEL[color]) {
      if (royalList(board, color).length === 1) relocateAdventitious(board, color, move.to, history);
    } else if (p.type === 'pawn') {
      const [, ty] = parseKey(move.to);
      if (ty === FAR_RANK[color]) handlePawnArrival(board, move.to, p, color, history);
    }
  }

  resolveAwaitingReturns(board, history);
  for (const side of COLORS) {
    const sheltered = board[OWN_CITADEL[side]];
    if (sheltered?.type === 'adventitious' && sheltered.color === side &&
        royalList(board, side).length === 1) {
      relocateAdventitious(board, side, OWN_CITADEL[side], history);
    }
  }

  const next = { board, turn, ply, history, result, exchangeUsed, citadelUsed, pendingCitadel };
  if (checkEnd && !result && !pendingCitadel) {
    const sideRoyals = royalList(board, turn);
    if (sideRoyals.length && allLegal(next, 0).length === 0) {
      const mated = isAttacked(board, sideRoyals[0], opponent(turn));
      next.result = { winner: color, reason: mated ? 'checkmate' : 'stalemate' };
    }
  }
  return next;
}

export function applyMove(state, move) {
  if (!state || typeof state !== 'object' || !state.board) throw new Error('invalid state');
  if (state.result) throw new Error('game is over');
  if (!move || typeof move.from !== 'string' || typeof move.to !== 'string') throw new Error('invalid move');
  const kind = move.kind || 'move';
  const cand = allLegal(state, 0).find((m) =>
    m.from === move.from && m.to === move.to && (m.kind || 'move') === kind &&
    (m.with === undefined || m.with === move.with) &&
    (m.replaces === undefined || m.replaces === move.replaces));
  if (!cand) throw new Error('illegal move');
  return applyInternal(state, cand, true);
}

// ---------------- Bot (bounded, deterministic) ----------------

const VALUE = {
  king: 20000, prince: 900, adventitious: 900, rook: 500, picket: 450,
  giraffe: 350, knight: 300, camel: 300, elephant: 250, engine: 200,
  ferz: 150, vizier: 150, pawn: 100,
};
const MATE = 100000;

function moveIdentity(m) {
  return m.from + '>' + m.to + ':' + (m.kind || 'move') + ':' + (m.with || '') + ':' + (m.replaces || '');
}

function orderMoves(state, moves) {
  const b = state.board;
  return moves
    .map((m) => {
      const tgt = b[m.to];
      const mover = b[m.from];
      const cap = tgt ? VALUE[tgt.type] || 0 : 0;
      return { m, s: cap * 64 - (VALUE[(mover || {}).type] || 0), id: moveIdentity(m) };
    })
    .sort((a, b2) => b2.s - a.s || (a.id < b2.id ? -1 : a.id > b2.id ? 1 : 0))
    .map((x) => x.m);
}

function evalState(state) {
  const board = state.board;
  let score = 0;
  for (const k of Object.keys(board)) {
    const p = board[k];
    let v = VALUE[p.type] || 100;
    if (p.type === 'pawn' && p.promotion === 'pawn') {
      v += (p.stage || 0) * 40;
      if (p.dormant) v += 60;
    }
    const [x, y] = parseKey(k);
    if (onBoard(x, y)) v += Math.max(0, 6 - Math.round(Math.abs(x - 5) + Math.abs(y - 4.5)));
    score += p.color === state.turn ? v : -v;
  }
  const mob = pseudoCount(board, state.turn) - pseudoCount(board, opponent(state.turn));
  score += Math.max(-40, Math.min(40, mob * 2));
  return score;
}

function terminalScore(state) {
  // Side to move has no legal moves or the game already ended.
  if (state.result) {
    if (state.result.winner === null) return 0;
    return state.result.winner === state.turn ? MATE - state.ply : -(MATE - state.ply);
  }
  const royals = royalList(state.board, state.turn);
  if (!royals.length) return evalState(state); // non-terminal sparse position
  return -(MATE - state.ply); // mate and stalemate both lose
}

let botAbort = false;
let botDeadline = 0;

function search(state, depth, alpha, beta) {
  if (botAbort) return 0;
  if (Date.now() > botDeadline) {
    botAbort = true;
    return 0;
  }
  if (state.result) return terminalScore(state);
  if (depth === 0) return evalState(state);
  const moves = allLegal(state, 0);
  if (!moves.length) return terminalScore(state);
  let best = -Infinity;
  for (const m of orderMoves(state, moves)) {
    const ns = applyInternal(state, m, false);
    const sc = ns.turn === state.turn
      ? search(ns, depth - 1, alpha, beta)
      : -search(ns, depth - 1, -beta, -alpha);
    if (botAbort) return 0;
    if (sc > best) best = sc;
    if (sc > alpha) alpha = sc;
    if (alpha >= beta) break;
  }
  return best;
}

export function chooseBotMove(state, { depth = 2, timeMs = 700 } = {}) {
  if (!state || state.result) return null;
  const moves = allLegal(state, 0);
  if (!moves.length) return null;
  const ordered = orderMoves(state, moves);
  botDeadline = Date.now() + Math.max(30, timeMs | 0);
  botAbort = false;
  let best = ordered[0];
  const maxDepth = Math.max(1, depth | 0);
  for (let d = 1; d <= maxDepth; d++) {
    let cur = null;
    let curScore = -Infinity;
    let alpha = -Infinity;
    for (const m of ordered) {
      const ns = applyInternal(state, m, false);
      const sc = ns.turn === state.turn
        ? search(ns, d - 1, alpha, Infinity)
        : -search(ns, d - 1, -Infinity, -alpha);
      if (botAbort) break;
      if (cur === null || sc > curScore) {
        cur = m;
        curScore = sc;
      }
      if (sc > alpha) alpha = sc;
    }
    if (!botAbort && cur) best = cur;
    if (botAbort) break;
  }
  return best;
}
