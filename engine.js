// engine.js — Great Chess (Tamerlane chess) rules engine.
// Pure browser-native ESM. No dependencies. Also runs on Node 24+.
// Board: x 0..10 (files a-k), y 0..9 (ranks 1-10). Key = `${x},${y}`.
// White advances +y. Citadels: white own '11,1', black own '-1,8'.
// All state is JSON-serializable. See RULE_NOTES for reconstruction choices.

export const COLORS = ['white', 'black'];

export const TYPES = {
  king: {
    name: 'King', short: 'K',
    description: 'Royal, highest rank. Moves one square in any direction. While it is your only royal it may never be left attacked. Once per game, while it is attacked, it may swap places with any friendly piece, including another royal, but never into its own citadel.',
  },
  prince: {
    name: 'Prince', short: 'Pr',
    description: 'Royal, second rank. Moves one square in any direction. Created when the king-pawn (f-file) promotes; becomes the reigning royal if no king remains.',
  },
  adventitious: {
    name: 'Adventitious king', short: 'Ad',
    description: 'Royal, third rank. Moves one square in any direction. Created only by the third promotion of the pawn-of-pawns. It alone may shelter in its own citadel; as your only royal it must then be placed by you on an empty, unattacked square of the main board, which spends no turn.',
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
    description: 'Moves exactly one square diagonally in any direction. Called the General in the historical Tamerlane source.',
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
    description: 'Leaps exactly two squares horizontally or vertically (2,0), jumping over the skipped square. Called the war engine in the historical Tamerlane source.',
  },
  pawn: {
    name: 'Pawn', short: 'P',
    description: 'Moves one square straight forward onto an empty square and captures one square diagonally forward. Promotion follows the pawn’s original file, even after captures change its file; the king-pawn becomes a prince. Only the pawn starting on White’s a3 (Black’s k8) is the pawn-of-pawns: its three arrivals produce a dormant, immune pawn, a returning pawn, then an adventitious king. A dormant pawn may optionally deploy to a square where it forks or traps an enemy unit, while the side may instead play any ordinary move. The opposite rook-pawn, starting on White’s k3 (Black’s a8), promotes to a rook.',
  },
};

export const RULE_NOTES = [
  '1. Royal exchange: once per game per side, and only while that side\'s reigning royal (king, then prince, then adventitious) is attacked — never merely because the side is stalemated — the royal may swap places with any friendly piece, including another royal. The swap consumes the turn, may not place the royal in its own citadel, and is legal only if the royal is not attacked on the square it reaches.',
  '2. Opponent-citadel entry: only the reigning royal may enter the opponent\'s citadel, and the entry is an immediate draw (result reason "citadel draw"). There is no declaration, no continuation swap and no choice of any kind.',
  '3. Sheltered-royal return is Hans Bodlaender\'s INVENTION, not historical evidence. Only an adventitious king may shelter in its own citadel. When it is its side\'s only royal — by voluntary entry or when its other royal is captured — its owner must place it on an empty main-board square of their choice that does not leave it attacked. The placement spends no turn and does not increment ply; the side whose turn would normally follow then plays normally (after a capture, that is the owner; after a voluntary entry, the opponent). If no such square exists the side loses.',
  '4. Pawn-of-pawns arrivals: the first arrival leaves the pawn dormant and uncapturable on the far rank. The second arrival returns it to the king-pawn home square (white f3 "5,2", black f8 "5,7"), removing a non-royal occupant as captured. The source does not specify a royal occupant there; as a clearly labelled completion of that gap, the pawn waits dormant on the far rank and returns automatically once the square is free of royals (history kind "return", no turn or ply change). The third arrival becomes an adventitious king.',
  '5. Deployment of a dormant pawn-of-pawns is OPTIONAL: the side may always play an ordinary move instead. A square qualifies when the pawn would there attack two or more enemy units, or one enemy unit with no legal escape after full simulation (pins, covering pieces and the capture of the deployed pawn all count). Deployment may replace any friendly or enemy piece except a reigning royal of either side — surplus lower royals are ordinary capturable pieces — and never an immune dormant piece. Deployment onto the far rank is not a new arrival. The escape simulation is bounded to depth 3; deeper nesting conservatively treats the unit as escaping (unreachable in normal play).',
  '6. Checkmate OR stalemate loses: a side to move with at least one royal and no legal moves loses, and the winner is always the opponent of that side — reason "checkmate" if its reigning royal is attacked, else "stalemate". There are no fifty-move or repetition draws; draws arise only from citadel entry or agreement handled by the server.',
  '7. Check means the reigning (highest remaining) royal is attacked. With two or more royals, even the reigning king may be exposed and captured; another royal then takes its role. The last royal may never be left attacked. A side with no royal at all is treated as non-terminal so tutorial and sparse custom positions remain playable.',
  '8. Picket: a diagonal slider with a two-square minimum; the first diagonal square must be empty and blocks everything beyond. Giraffe: one diagonal step then three or more outward orthogonal steps; the entire bent path (including unlandable intermediate squares) must be empty and no U-turns are allowed.',
  '9. Source and attribution: these rules follow Hans Bodlaender\'s historic Tamerlane page at chessvariants.com (1996, revised 2003). Internal type IDs are unchanged; the source\'s General is the ferz and its war engine is the engine. The tradition that Timur (Tamerlane) invented the game is not established history. Bodlaender\'s owner-chosen return of a sheltered last royal is his invention, and the wait for a royal to vacate f3/f8 is labelled as a completion of an unspecified edge rather than a documented rule.',
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
    pendingRoyalReturn: null,
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
  const hypo = { ...state, board: nb, turn: opponent(color), pendingRoyalReturn: null };
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
  // Deployment may displace any piece except each side's reigning royal
  // (highest royal, whatever its type) and an immune dormant piece.
  const reigning = new Set([highestRoyalId(board, color), highestRoyalId(board, opponent(color))]);
  const out = [];
  for (let sy = 0; sy <= 9; sy++) {
    for (let sx = 0; sx <= 10; sx++) {
      const s = key(sx, sy);
      if (s === pawnKey) continue;
      const occ = board[s];
      if (occ && (occ.dormant || reigning.has(occ.id))) continue;
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

// Every empty main-board square that keeps a returning sole royal safe.
// While pendingRoyalReturn is set these are the only legal moves.
function royalReturnMoves(state) {
  const prr = state.pendingRoyalReturn;
  if (!prr) return [];
  const royal = state.board[prr.from];
  if (!royal) return [];
  const board = { ...state.board };
  delete board[prr.from];
  const sole = royalList(board, prr.color).length === 0;
  const out = [];
  for (let y = 0; y <= 9; y++) {
    for (let x = 0; x <= 10; x++) {
      const k = key(x, y);
      if (board[k]) continue;
      if (sole) {
        board[k] = royal;
        const safe = !isAttacked(board, k, opponent(prr.color));
        delete board[k];
        if (!safe) continue;
      }
      out.push({ from: prr.from, to: k, kind: 'royal-return' });
    }
  }
  return out;
}

// Full legal move list for state.turn. `sim` bounds deploy-escape recursion.
function allLegal(state, sim) {
  sim = sim || 0;
  if (state.result) return [];
  const board = state.board, color = state.turn;
  if (state.pendingRoyalReturn) return royalReturnMoves(state);
  const royals = royalList(board, color);
  const hid = royals.length ? board[royals[0]].id : null;
  const pendingReturns = Object.keys(board).some((k) => board[k].awaitingReturn);
  // One dormant pawn-of-pawns may redeploy, but only as an extra option.
  let dormKey = null;
  for (const k of Object.keys(board)) {
    const p = board[k];
    if (p.color === color && p.type === 'pawn' && p.promotion === 'pawn' && p.dormant && !p.awaitingReturn) {
      dormKey = k;
      break;
    }
  }
  const moves = [];
  const keys = Object.keys(board);
  for (const k of keys) {
    const p = board[k];
    if (p.color !== color || p.dormant) continue;
    const dests = pseudoMoves(board, k, p, hid);
    for (const to of dests) {
      // Entering the opponent citadel is an immediate draw, hence always legal.
      if (to === OPP_CITADEL[color]) {
        moves.push({ from: k, to, kind: 'move' });
        continue;
      }
      const transforms = pendingReturns ||
        (p.type === 'pawn' && parseKey(to)[1] === FAR_RANK[color]) ||
        (p.type === 'adventitious' && to === OWN_CITADEL[color]);
      if (transforms) {
        const ns = applyInternal(state, { from: k, to, kind: 'move' }, false);
        // A sole sheltered royal with no safe square loses at once: refuse it.
        if (ns.result && ns.result.winner === opponent(color)) continue;
        if (ns.pendingRoyalReturn && ns.pendingRoyalReturn.color === color) {
          moves.push({ from: k, to, kind: 'move' });
          continue;
        }
        const remaining = royalList(ns.board, color);
        if (remaining.length === 1 && isAttacked(ns.board, remaining[0], opponent(color))) continue;
      } else if (royals.length === 1) {
        const nb = { ...board };
        delete nb[k];
        nb[to] = p;
        if (isAttacked(nb, k === royals[0] ? to : royals[0], opponent(color))) continue;
      }
      moves.push({ from: k, to, kind: 'move' });
    }
  }
  if (dormKey) moves.push(...genDeploys(state, dormKey, royals, sim));
  // Royal exchange: once per game, only while the reigning royal is attacked.
  if (!state.exchangeUsed[color] && royals.length) {
    const hk = royals[0];
    if (isAttacked(board, hk, opponent(color))) {
      const ownCitadel = OWN_CITADEL[color];
      for (const k of keys) {
        const p = board[k];
        if (k === hk || p.color !== color || k === ownCitadel) continue;
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
  let pendingRoyalReturn = null;

  if (kind === 'royal-return') {
    const prr = state.pendingRoyalReturn;
    const royal = board[move.from];
    delete board[move.from];
    board[move.to] = royal;
    turn = prr.resumeTurn;
    ply = state.ply; // the placement spends no turn and adds no ply
    history.push({
      from: move.from, to: move.to, kind, piece: royal.type, color: prr.color,
      notation: TYPES[royal.type].short + ' returns ' + squareName(move.to),
    });
  } else if (kind === 'exchange') {
    const a = board[move.from];
    const b = board[move.to];
    const moved = { ...b };
    // Leaving the far rank ends dormancy/immunity of a pawn-of-pawns but
    // keeps its promotion stage.
    if (moved.dormant || moved.awaitingReturn) {
      const [, ny] = parseKey(move.from);
      if (ny !== FAR_RANK[moved.color]) {
        delete moved.dormant;
        delete moved.awaitingReturn;
      }
    }
    board[move.from] = moved;
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
      // The entry alone ends the game as a draw; no choice follows.
      result = { winner: null, reason: 'citadel draw' };
    } else if (p.type === 'adventitious' && move.to === OWN_CITADEL[color]) {
      if (royalList(board, color).length === 1) {
        pendingRoyalReturn = { color, royal: p.id, from: move.to, resumeTurn: opponent(color) };
        turn = color; // the owner places it before the next turn
      }
    } else if (p.type === 'pawn') {
      const [, ty] = parseKey(move.to);
      if (ty === FAR_RANK[color]) handlePawnArrival(board, move.to, p, color, history);
    }
  }

  if (kind !== 'royal-return' && !result) {
    resolveAwaitingReturns(board, history);
    if (!result && !pendingRoyalReturn) {
      // A captured royal may leave a sheltered adventitious king as the
      // side's only royal: its owner must bring it back to the main board.
      for (const side of COLORS) {
        const sheltered = board[OWN_CITADEL[side]];
        if (sheltered && sheltered.type === 'adventitious' && sheltered.color === side &&
            royalList(board, side).length === 1) {
          pendingRoyalReturn = {
            color: side, royal: sheltered.id, from: OWN_CITADEL[side], resumeTurn: turn,
          };
          turn = side;
          break;
        }
      }
    }
    if (pendingRoyalReturn && royalReturnMoves({ board, pendingRoyalReturn }).length === 0) {
      const owner = pendingRoyalReturn.color;
      const mated = isAttacked(board, pendingRoyalReturn.from, opponent(owner));
      result = { winner: opponent(owner), reason: mated ? 'checkmate' : 'stalemate' };
      pendingRoyalReturn = null;
    }
  }

  const next = { board, turn, ply, history, result, exchangeUsed, pendingRoyalReturn };
  if (checkEnd && !result && !pendingRoyalReturn) {
    const sideRoyals = royalList(board, turn);
    if (sideRoyals.length && allLegal(next, 0).length === 0) {
      const mated = isAttacked(board, sideRoyals[0], opponent(turn));
      next.result = { winner: opponent(turn), reason: mated ? 'checkmate' : 'stalemate' };
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

// Upgrades a persisted state to the current shape. Pure: the input is never
// modified and board/ledger contents are preserved. Call at storage
// boundaries only; generated states already match this shape.
export function restoreState(state) {
  if (!state || typeof state !== 'object' || !state.board) throw new Error('invalid state');
  const legacyCitadel = state.pendingCitadel;
  const next = { ...state };
  delete next.pendingCitadel;
  delete next.citadelUsed;
  next.exchangeUsed = { white: false, black: false, ...(state.exchangeUsed || {}) };
  next.pendingRoyalReturn = state.pendingRoyalReturn || null;
  if (!Array.isArray(next.history)) next.history = [];
  if (typeof next.ply !== 'number') next.ply = 0;
  if (next.result === undefined) next.result = null;
  if (legacyCitadel && !next.result) {
    // The old pending citadel choice is the immediate draw the source
    // mandates: no extra ply, no extra ledger entry, board untouched.
    next.result = { winner: null, reason: 'citadel draw' };
    next.pendingRoyalReturn = null;
  }
  return next;
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
