// engine.test.js — behavioral regression checks for the Great Chess engine.
// Run with: node --test engine.test.js
// All expectations are hand-derived from local://great-chess-engine-spec.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLORS, TYPES, RULE_NOTES,
  initialState, emptyState, legalMoves, applyMove, chooseBotMove, inCheck, squareName,
} from './engine.js';

let counter = 0;
// Build a sparse custom position: [key, type, color, extra?] tuples.
function S(placements, turn = 'white') {
  const s = emptyState();
  s.turn = turn;
  for (const [k, type, color, extra] of placements) {
    counter += 1;
    s.board[k] = { id: `t${counter}`, type, color, ...(extra || {}) };
  }
  return s;
}
const has = (moves, from, to, kind = 'move') =>
  moves.some((m) => m.from === from && m.to === to && (m.kind || 'move') === kind);
const dests = (moves, from) => moves.filter((m) => m.from === from).map((m) => m.to).sort();

test('exports and metadata', () => {
  assert.deepEqual(COLORS, ['white', 'black']);
  const types = ['king', 'prince', 'adventitious', 'rook', 'knight', 'picket', 'giraffe', 'ferz', 'vizier', 'elephant', 'camel', 'engine', 'pawn'];
  const shorts = new Set();
  for (const t of types) {
    assert.ok(TYPES[t], `missing type ${t}`);
    assert.equal(typeof TYPES[t].name, 'string');
    assert.equal(typeof TYPES[t].short, 'string');
    assert.equal(typeof TYPES[t].description, 'string');
    assert.ok(TYPES[t].description.length > 20, `description too thin for ${t}`);
    assert.ok(!shorts.has(TYPES[t].short), `duplicate short ${TYPES[t].short}`);
    shorts.add(TYPES[t].short);
  }
  assert.ok(Array.isArray(RULE_NOTES));
  assert.ok(RULE_NOTES.length >= 9);
  assert.ok(RULE_NOTES.every((n) => typeof n === 'string' && n.length > 40));
  assert.equal(squareName('0,0'), 'a1');
  assert.equal(squareName('5,2'), 'f3');
  assert.equal(squareName('10,9'), 'k10');
  assert.equal(squareName('11,1'), 'white citadel');
  assert.equal(squareName('-1,8'), 'black citadel');
});

test('emptyState shape', () => {
  assert.deepEqual(emptyState(), {
    board: {}, turn: 'white', ply: 0, history: [], result: null,
    exchangeUsed: { white: false, black: false },
    citadelUsed: { white: false, black: false },
    pendingCitadel: null,
  });
});

test('initial position: 28 pieces per side, key squares, white to move', () => {
  const s = initialState();
  const pieces = Object.values(s.board);
  assert.equal(pieces.filter((p) => p.color === 'white').length, 28);
  assert.equal(pieces.filter((p) => p.color === 'black').length, 28);
  assert.equal(Object.keys(s.board).length, 56);
  assert.equal(s.board['5,1'].type, 'king');
  assert.equal(s.board['5,1'].color, 'white');
  assert.equal(s.board['5,8'].type, 'king');
  assert.equal(s.board['5,8'].color, 'black');
  assert.equal(s.board['4,1'].type, 'ferz');
  assert.equal(s.board['6,1'].type, 'vizier');
  assert.equal(s.board['4,8'].type, 'vizier'); // 180-degree rotation
  assert.equal(s.board['6,8'].type, 'ferz');
  assert.equal(s.board['0,0'].type, 'elephant');
  assert.equal(s.board['10,9'].type, 'elephant');
  assert.equal(s.board['2,0'].type, 'camel');
  assert.equal(s.board['4,0'].type, 'engine');
  assert.equal(s.board['0,1'].type, 'rook');
  assert.equal(s.board['3,1'].type, 'giraffe');
  assert.equal(s.board['2,1'].type, 'picket');
  assert.equal(s.board['0,2'].promotion, 'pawn'); // white pawn-of-pawns
  assert.equal(s.board['10,7'].promotion, 'pawn'); // black pawn-of-pawns
  assert.equal(s.board['5,2'].promotion, 'prince'); // king-pawns
  assert.equal(s.board['5,7'].promotion, 'prince');
  assert.equal(s.board['1,2'].promotion, 'engine');
  assert.equal(s.turn, 'white');
  assert.equal(s.ply, 0);
  assert.equal(s.result, null);
  assert.equal(inCheck(s, 'white'), false);
  assert.equal(inCheck(s, 'black'), false);
});

test('initial move samples: knight, blocked rook, pawn', () => {
  const s = initialState();
  assert.deepEqual(dests(legalMoves(s), '1,1'), ['0,3', '2,3', '3,0']);
  assert.equal(legalMoves(s, '0,1').length, 0); // rook boxed in by its pawn
  assert.deepEqual(dests(legalMoves(s), '0,2'), ['0,3']);
});

test('leapers jump over blockers', () => {
  const base = [
    ['5,0', 'king', 'white'], ['10,9', 'king', 'black'],
    ['4,5', 'pawn', 'white'], ['6,5', 'pawn', 'white'], ['5,4', 'pawn', 'white'], ['5,6', 'pawn', 'white'],
  ];
  const camel = S([...base, ['5,5', 'camel', 'white']]);
  assert.deepEqual(dests(legalMoves(camel), '5,5'), ['2,4', '2,6', '4,2', '4,8', '6,2', '6,8', '8,4', '8,6']);
  const knight = S([...base, ['5,5', 'knight', 'white']]);
  assert.deepEqual(dests(legalMoves(knight), '5,5'), ['3,4', '3,6', '4,3', '4,7', '6,3', '6,7', '7,4', '7,6']);
  const elephant = S([...base, ['5,5', 'elephant', 'white']]);
  assert.deepEqual(dests(legalMoves(elephant), '5,5'), ['3,3', '3,7', '7,3', '7,7']);
  const engine = S([...base, ['5,5', 'engine', 'white']]);
  assert.deepEqual(dests(legalMoves(engine), '5,5'), ['3,5', '5,3', '5,7', '7,5']);
});

test('picket: minimum two squares, first square blocks, slider truncation', () => {
  const kings = [['5,0', 'king', 'white'], ['10,9', 'king', 'black']];
  const open = S([...kings, ['5,5', 'picket', 'white']]);
  assert.deepEqual(dests(legalMoves(open), '5,5'),
    ['0,0', '1,1', '1,9', '10,0', '2,2', '2,8', '3,3', '3,7', '7,3', '7,7', '8,2', '8,8', '9,1', '9,9']);
  const blockedFirst = S([...kings, ['5,5', 'picket', 'white'], ['6,6', 'pawn', 'white']]);
  assert.deepEqual(dests(legalMoves(blockedFirst), '5,5'),
    ['0,0', '1,1', '1,9', '10,0', '2,2', '2,8', '3,3', '3,7', '7,3', '8,2', '9,1']);
  const capturable = S([...kings, ['5,5', 'picket', 'white'], ['7,7', 'pawn', 'black']]);
  assert.deepEqual(dests(legalMoves(capturable), '5,5'),
    ['0,0', '1,1', '1,9', '10,0', '2,2', '2,8', '3,3', '3,7', '7,3', '7,7', '8,2', '9,1']);
});

test('giraffe: bent path destinations and blocking', () => {
  const kings = [['5,0', 'king', 'white'], ['10,9', 'king', 'black']];
  const open = S([...kings, ['5,5', 'giraffe', 'white']]);
  assert.deepEqual(dests(legalMoves(open), '5,5'),
    ['0,4', '0,6', '1,4', '1,6', '10,4', '10,6', '4,0', '4,1', '4,9', '6,0', '6,1', '6,9', '9,4', '9,6']);
  // Own piece on the diagonal step kills the whole branch.
  const diagBlocked = S([...kings, ['5,5', 'giraffe', 'white'], ['4,4', 'pawn', 'white']]);
  assert.deepEqual(dests(legalMoves(diagBlocked), '5,5'),
    ['0,6', '1,6', '10,4', '10,6', '4,9', '6,0', '6,1', '6,9', '9,4', '9,6']);
  // Enemy on the first orthogonal step truncates that ray without being landable.
  const orthBlocked = S([...kings, ['5,5', 'giraffe', 'white'], ['3,4', 'pawn', 'black']]);
  assert.deepEqual(dests(legalMoves(orthBlocked), '5,5'),
    ['0,6', '1,6', '10,4', '10,6', '4,0', '4,1', '4,9', '6,0', '6,1', '6,9', '9,4', '9,6']);
  // Enemy on a legal destination (third orthogonal step) is capturable.
  const capturable = S([...kings, ['5,5', 'giraffe', 'white'], ['1,4', 'rook', 'black']]);
  const dm = dests(legalMoves(capturable), '5,5');
  assert.ok(dm.includes('1,4'));
  assert.ok(!dm.includes('0,4'));
});

test('pawn steps and captures forward only', () => {
  const s = S([
    ['5,0', 'king', 'white'], ['10,9', 'king', 'black'],
    ['5,5', 'pawn', 'white', { promotion: 'rook' }], ['4,6', 'rook', 'black'],
  ]);
  assert.deepEqual(dests(legalMoves(s), '5,5'), ['4,6', '5,6']);
  const sb = S([
    ['5,0', 'king', 'white'], ['10,9', 'king', 'black'],
    ['5,5', 'pawn', 'black', { promotion: 'rook' }], ['6,4', 'rook', 'white'],
  ], 'black');
  assert.deepEqual(dests(legalMoves(sb), '5,5'), ['5,4', '6,4']);
});

test('file-based promotion: king-pawn becomes prince, camel-pawn becomes camel', () => {
  const s = S([
    ['0,0', 'king', 'white'], ['10,9', 'king', 'black'],
    ['5,8', 'pawn', 'white', { promotion: 'prince' }],
  ]);
  const s2 = applyMove(s, { from: '5,8', to: '5,9' });
  assert.equal(s2.board['5,9'].type, 'prince');
  assert.equal(s2.board['5,9'].id, s.board['5,8'].id);
  const c = S([
    ['0,0', 'king', 'white'], ['10,9', 'king', 'black'],
    ['2,8', 'pawn', 'white', { promotion: 'camel' }],
  ]);
  assert.equal(applyMove(c, { from: '2,8', to: '2,9' }).board['2,9'].type, 'camel');
});

test('multi-royal exposure: extra royal may be left attacked, sole royal may not', () => {
  const withPrince = S([
    ['5,0', 'king', 'white'], ['0,0', 'prince', 'white'],
    ['5,5', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  assert.equal(inCheck(withPrince, 'white'), true); // highest royal is the king
  assert.ok(has(legalMoves(withPrince), '5,0', '5,1')); // stays on the open file: allowed
  const sole = S([
    ['5,0', 'king', 'white'], ['5,5', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  assert.ok(!has(legalMoves(sole), '5,0', '5,1'));
  assert.ok(has(legalMoves(sole), '5,0', '4,0')); // real evasions exist
});

test('checkmate loses: result winner and reason', () => {
  const s = S([
    ['0,0', 'king', 'white'],
    ['7,5', 'rook', 'black'], ['1,9', 'rook', 'black'], ['10,9', 'king', 'black'],
  ], 'black');
  const s2 = applyMove(s, { from: '7,5', to: '0,5' });
  assert.deepEqual(s2.result, { winner: 'black', reason: 'checkmate' });
  assert.equal(s2.history.length, 1);
  assert.equal(s2.history[0].capture, undefined);
});

test('stalemate loses: no legal moves without check', () => {
  const s = S([
    ['0,0', 'king', 'white'],
    ['1,9', 'rook', 'black'], ['3,2', 'camel', 'black'], ['10,9', 'king', 'black'],
  ], 'black');
  // Rook covers the b-file escape squares; the camel already covers a2 (0,1).
  const s2 = applyMove(s, { from: '1,9', to: '1,5' });
  assert.deepEqual(s2.result, { winner: 'black', reason: 'stalemate' });
});

test('royal exchange: only in check, swaps, single use', () => {
  const s = S([
    ['5,0', 'king', 'white'], ['0,0', 'rook', 'white'],
    ['5,5', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  const ms = legalMoves(s);
  assert.ok(has(ms, '5,0', '0,0', 'exchange'));
  const s2 = applyMove(s, { from: '5,0', to: '0,0', kind: 'exchange' });
  assert.equal(s2.board['0,0'].type, 'king');
  assert.equal(s2.board['5,0'].type, 'rook');
  assert.equal(s2.exchangeUsed.white, true);
  assert.equal(s2.turn, 'black');
  assert.equal(s2.ply, 1);
  // Black captures the rook on f1 (5,0), re-checking the king: no second exchange.
  const s3 = applyMove(s2, { from: '5,5', to: '5,0' });
  assert.equal(inCheck(s3, 'white'), true);
  assert.ok(!legalMoves(s3).some((m) => m.kind === 'exchange'));
  // Not in check with moves available: exchange never offered.
  const quiet = S([['5,0', 'king', 'white'], ['0,0', 'rook', 'white'], ['10,9', 'king', 'black']]);
  assert.ok(!legalMoves(quiet).some((m) => m.kind === 'exchange'));
});

test('citadel: entry, pending choices, draw and swap semantics', () => {
  const s = S([
    ['0,8', 'king', 'white'], ['3,3', 'prince', 'white'], ['10,9', 'king', 'black'],
  ]);
  const kid = s.board['0,8'].id;
  const pid = s.board['3,3'].id;
  assert.ok(has(legalMoves(s), '0,8', '-1,8'));
  const entered = applyMove(s, { from: '0,8', to: '-1,8' });
  assert.deepEqual(entered.pendingCitadel, { color: 'white', royal: kid, citadel: '-1,8' });
  assert.equal(entered.turn, 'white'); // turn stays with the mover
  assert.equal(entered.ply, 1);
  const choices = legalMoves(entered);
  assert.equal(choices.length, 2);
  assert.ok(choices.every((m) => typeof m.from === 'string' && typeof m.to === 'string'));
  assert.ok(has(choices, '-1,8', '-1,8', 'citadel-draw'));
  assert.ok(has(choices, '-1,8', '3,3', 'citadel-swap'));
  const drawn = applyMove(entered, { from: '-1,8', to: '-1,8', kind: 'citadel-draw' });
  assert.deepEqual(drawn.result, { winner: null, reason: 'citadel draw' });
  assert.equal(drawn.ply, 1); // choice consumed the same turn
  assert.equal(drawn.pendingCitadel, null);
  const swapped = applyMove(entered, { from: '-1,8', to: '3,3', kind: 'citadel-swap', with: pid });
  assert.equal(swapped.board['3,3'].id, kid);
  assert.equal(swapped.board['-1,8'].id, pid);
  assert.equal(swapped.citadelUsed.white, true);
  assert.equal(swapped.ply, 1);
  assert.equal(swapped.turn, 'black');
  // Sole royal entering: only the (forced) draw choice remains.
  const soleEntry = applyMove(
    S([['0,8', 'king', 'white'], ['10,9', 'king', 'black']]),
    { from: '0,8', to: '-1,8' },
  );
  const soleChoices = legalMoves(soleEntry);
  assert.equal(soleChoices.length, 1);
  assert.equal(soleChoices[0].kind, 'citadel-draw');
  // A non-highest royal may not enter the opponent citadel.
  const notHighest = S([
    ['0,8', 'prince', 'white'], ['5,5', 'king', 'white'], ['10,9', 'king', 'black'],
  ]);
  assert.ok(!has(legalMoves(notHighest), '0,8', '-1,8'));
});

test('pawn-of-pawns: first arrival dormancy and immunity', () => {
  const s = S([
    ['0,8', 'pawn', 'white', { promotion: 'pawn' }],
    ['4,0', 'king', 'white'], ['5,9', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  const s2 = applyMove(s, { from: '0,8', to: '0,9' });
  assert.equal(s2.board['0,9'].type, 'pawn');
  assert.equal(s2.board['0,9'].stage, 1);
  assert.equal(s2.board['0,9'].dormant, true);
  const blackMoves = legalMoves(s2); // black to move
  assert.ok(!blackMoves.some((m) => m.to === '0,9')); // immune: cannot be captured
});

test('pawn-of-pawns: compulsory deploy on a forking square (tutorial scenario)', () => {
  const s = S([
    ['2,9', 'pawn', 'white', { promotion: 'pawn', stage: 1, dormant: true }],
    ['5,0', 'king', 'white'],
    ['4,5', 'rook', 'black'], ['6,5', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  const ms = legalMoves(s);
  assert.equal(ms.length, 1); // ordinary moves are suppressed
  assert.equal(ms[0].from, '2,9');
  assert.equal(ms[0].to, '5,4');
  assert.equal(ms[0].kind, 'deploy');
  const s2 = applyMove(s, ms[0]);
  assert.equal(s2.board['5,4'].type, 'pawn');
  assert.equal(s2.board['5,4'].dormant, undefined);
  assert.ok(!s2.board['2,9']);
  assert.equal(s2.turn, 'black');
  // After deployment the pawn is an ordinary capturable pawn.
  const after = S([
    ['5,4', 'pawn', 'white', { promotion: 'pawn', stage: 1 }],
    ['5,0', 'king', 'white'], ['5,8', 'rook', 'black'], ['10,9', 'king', 'black'],
  ], 'black');
  assert.ok(has(legalMoves(after), '5,8', '5,4'));
});

test('pawn-of-pawns: deploy may replace an own non-royal occupant', () => {
  const s = S([
    ['2,9', 'pawn', 'white', { promotion: 'pawn', stage: 1, dormant: true }],
    ['5,0', 'king', 'white'], ['5,4', 'ferz', 'white'],
    ['4,5', 'rook', 'black'], ['6,5', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  const ms = legalMoves(s);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].kind, 'deploy');
  assert.equal(ms[0].replaces, s.board['5,4'].id);
  const s2 = applyMove(s, ms[0]);
  assert.equal(s2.board['5,4'].type, 'pawn');
  assert.equal(s2.history.at(-1).capture, 'ferz');
  assert.ok(!Object.values(s2.board).some((p) => p.type === 'ferz'));
});

test('pawn-of-pawns: single-attack deploy requires genuine no-escape (pins and covering)', () => {
  // Black ferz on e6 (4,5) is pinned to its king on a6 (0,5) by the white rook
  // on h6 (7,5): leaving the rank exposes the king, so it cannot escape.
  const s = S([
    ['2,9', 'pawn', 'white', { promotion: 'pawn', stage: 1, dormant: true }],
    ['5,0', 'king', 'white'], ['7,5', 'rook', 'white'],
    ['4,5', 'ferz', 'black'], ['0,5', 'king', 'black'],
  ]);
  const ms = legalMoves(s);
  assert.deepEqual(ms.map((m) => m.to).sort(), ['3,4', '5,4']);
  assert.ok(ms.every((m) => m.kind === 'deploy' && m.from === '2,9'));
});

test('pawn-of-pawns: second arrival returns to king-pawn home', () => {
  const s = S([
    ['3,8', 'pawn', 'white', { promotion: 'pawn', stage: 1 }],
    ['5,0', 'king', 'white'], ['10,9', 'king', 'black'],
  ]);
  const s2 = applyMove(s, { from: '3,8', to: '3,9' });
  assert.equal(s2.board['5,2'].type, 'pawn');
  assert.equal(s2.board['5,2'].stage, 2);
  assert.ok(!s2.board['3,9']);
  assert.equal(s2.history.at(-1).kind, 'return');
  // Non-royal occupant of the home square is removed as captured.
  const occ = S([
    ['3,8', 'pawn', 'white', { promotion: 'pawn', stage: 1 }],
    ['5,0', 'king', 'white'], ['5,2', 'rook', 'white'], ['10,9', 'king', 'black'],
  ]);
  const occ2 = applyMove(occ, { from: '3,8', to: '3,9' });
  assert.equal(occ2.board['5,2'].type, 'pawn');
  assert.equal(occ2.history.at(-1).capture, 'rook');
  assert.ok(!Object.values(occ2.board).some((p) => p.type === 'rook'));
});

test('pawn-of-pawns: royal on home square delays the return, then auto-resolves', () => {
  const s = S([
    ['3,8', 'pawn', 'white', { promotion: 'pawn', stage: 1 }],
    ['5,2', 'king', 'white'], ['10,9', 'king', 'black'],
  ]);
  const s2 = applyMove(s, { from: '3,8', to: '3,9' });
  assert.equal(s2.board['3,9'].awaitingReturn, true);
  assert.equal(s2.board['3,9'].dormant, true);
  assert.equal(s2.board['5,2'].type, 'king'); // no illegal overwrite
  const s3 = applyMove(s2, { from: '10,9', to: '10,8' });
  assert.equal(s3.board['3,9'].awaitingReturn, true); // still blocked
  const s4 = applyMove(s3, { from: '5,2', to: '5,1' });
  assert.equal(s4.board['5,2'].type, 'pawn');
  assert.equal(s4.board['5,2'].stage, 2);
  assert.ok(!s4.board['3,9']);
  assert.equal(s4.history.at(-1).kind, 'return');
});

test('pawn-of-pawns: third arrival becomes an adventitious king', () => {
  const s = S([
    ['3,8', 'pawn', 'white', { promotion: 'pawn', stage: 2 }],
    ['5,0', 'king', 'white'], ['10,9', 'king', 'black'],
  ]);
  const s2 = applyMove(s, { from: '3,8', to: '3,9' });
  assert.equal(s2.board['3,9'].type, 'adventitious');
  assert.equal(s2.board['3,9'].stage, 3);
});

test('adventitious king: own citadel immunity vs sole-royal return', () => {
  // With another royal alive it shelters and stays.
  const s = S([
    ['10,1', 'adventitious', 'white'], ['5,0', 'king', 'white'], ['10,9', 'king', 'black'],
  ]);
  const s2 = applyMove(s, { from: '10,1', to: '11,1' });
  assert.equal(s2.board['11,1'].type, 'adventitious');
  // As the sole royal it immediately returns to the pawn-of-pawns origin.
  const sole = S([['10,1', 'adventitious', 'white'], ['10,9', 'king', 'black']]);
  const sole2 = applyMove(sole, { from: '10,1', to: '11,1' });
  assert.equal(sole2.board['0,2'].type, 'adventitious');
  assert.ok(!sole2.board['11,1']);
  assert.ok(sole2.history.some((h) => h.kind === 'return'));
  // Opposing sole king on the origin: nearest free home-pawn square, never erased.
  const clash = S([['10,1', 'adventitious', 'white'], ['0,2', 'king', 'black']]);
  const clash2 = applyMove(clash, { from: '10,1', to: '11,1' });
  assert.equal(clash2.board['0,2'].type, 'king');
  assert.equal(clash2.board['0,2'].color, 'black');
  assert.equal(clash2.board['2,2'].type, 'adventitious');
});

test('royal safety uses the completed promotion and sheltered-return position', () => {
  const sheltered = S([
    ['5,0', 'king', 'white'], ['11,1', 'adventitious', 'white'],
    ['5,5', 'rook', 'black'], ['10,9', 'king', 'black'],
  ], 'black');
  const captured = applyMove(sheltered, { from: '5,5', to: '5,0' });
  assert.equal(captured.board['0,2'].type, 'adventitious');
  assert.equal(captured.board['11,1'], undefined);
  assert.equal(captured.turn, 'white');

  const promotion = S([
    ['5,0', 'king', 'white'], ['5,5', 'rook', 'black'],
    ['3,8', 'pawn', 'white', { promotion: 'prince' }], ['10,9', 'king', 'black'],
  ]);
  const promoted = applyMove(promotion, { from: '3,8', to: '3,9' });
  assert.equal(promoted.board['3,9'].type, 'prince');
  assert.equal(promoted.board['5,0'].type, 'king');

  const unsafeReturn = S([
    ['10,1', 'adventitious', 'white'], ['0,5', 'rook', 'black'],
    ['10,9', 'king', 'black'],
  ]);
  assert.ok(!has(legalMoves(unsafeReturn), '10,1', '11,1'));
});

test('applyMove: immutability, validation errors', () => {
  const s = initialState();
  const snap = JSON.stringify(s);
  const s2 = applyMove(s, legalMoves(s)[0]);
  assert.equal(JSON.stringify(s), snap); // input deep-unchanged
  assert.notEqual(s2, s);
  assert.equal(s2.ply, 1);
  assert.equal(s2.turn, 'black');
  assert.throws(() => applyMove(initialState(), { from: '0,1', to: '0,4' })); // blocked rook
  assert.throws(() => applyMove(initialState(), { from: '0,7', to: '0,6' })); // wrong turn
  assert.throws(() => applyMove(initialState(), { from: 'nowhere', to: '0,3' }));
  const mated = applyMove(
    S([['0,0', 'king', 'white'], ['7,5', 'rook', 'black'], ['1,9', 'rook', 'black'], ['10,9', 'king', 'black']], 'black'),
    { from: '7,5', to: '0,5' },
  );
  assert.throws(() => applyMove(mated, { from: '0,0', to: '0,1' })); // game over
});

test('state survives JSON round-trip', () => {
  const s = initialState();
  const c = JSON.parse(JSON.stringify(s));
  assert.deepEqual(c, s);
  assert.equal(legalMoves(c).length, legalMoves(s).length);
  assert.deepEqual(dests(legalMoves(c), '1,1'), ['0,3', '2,3', '3,0']);
});

test('bot: legal deterministic move, finds mate in one, null when over', () => {
  const s = initialState();
  const m1 = chooseBotMove(s, { depth: 1, timeMs: 300 });
  assert.ok(m1 && typeof m1.from === 'string' && typeof m1.to === 'string');
  assert.ok(has(legalMoves(s), m1.from, m1.to, m1.kind || 'move'));
  const m2 = chooseBotMove(s, { depth: 1, timeMs: 300 });
  assert.deepEqual(m2, m1); // deterministic
  const mate = S([
    ['0,0', 'king', 'black'],
    ['7,5', 'rook', 'white'], ['1,9', 'rook', 'white'], ['5,0', 'king', 'white'],
  ]);
  const mm = chooseBotMove(mate, { depth: 2, timeMs: 600 });
  assert.equal(mm.from, '7,5');
  assert.equal(mm.to, '0,5');
  const over = applyMove(mate, mm);
  assert.deepEqual(over.result, { winner: 'white', reason: 'checkmate' });
  assert.equal(chooseBotMove(over, { depth: 1, timeMs: 100 }), null);
});
