// engine.test.js — behavioral regression checks for the Great Chess engine.
// Run with: node --test engine.test.js
// Expectations follow Hans Bodlaender's historic Tamerlane page
// (chessvariants.com, 1996/2003) as recorded in RULE_NOTES, plus the two
// explicitly labelled completions of edges the source leaves unspecified.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState, emptyState, legalMoves, applyMove, chooseBotMove, inCheck,
  squareName, restoreState,
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
const kinds = (moves, kind) => moves.filter((m) => (m.kind || 'move') === kind);

const kings = [['5,0', 'king', 'white'], ['10,9', 'king', 'black']];

test('square labels distinguish board coordinates and both citadels', () => {
  assert.equal(squareName('0,0'), 'a1');
  assert.equal(squareName('5,2'), 'f3');
  assert.equal(squareName('10,9'), 'k10');
  assert.equal(squareName('11,1'), 'white citadel');
  assert.equal(squareName('-1,8'), 'black citadel');
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
  assert.equal(s.pendingRoyalReturn, null);
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
    ...kings,
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
  const open = S([...kings, ['5,5', 'giraffe', 'white']]);
  assert.deepEqual(dests(legalMoves(open), '5,5'),
    ['0,4', '0,6', '1,4', '1,6', '10,4', '10,6', '4,0', '4,1', '4,9', '6,0', '6,1', '6,9', '9,4', '9,6']);
  const diagBlocked = S([...kings, ['5,5', 'giraffe', 'white'], ['4,4', 'pawn', 'white']]);
  assert.deepEqual(dests(legalMoves(diagBlocked), '5,5'),
    ['0,6', '1,6', '10,4', '10,6', '4,9', '6,0', '6,1', '6,9', '9,4', '9,6']);
  const orthBlocked = S([...kings, ['5,5', 'giraffe', 'white'], ['3,4', 'pawn', 'black']]);
  assert.deepEqual(dests(legalMoves(orthBlocked), '5,5'),
    ['0,6', '1,6', '10,4', '10,6', '4,0', '4,1', '4,9', '6,0', '6,1', '6,9', '9,4', '9,6']);
  const capturable = S([...kings, ['5,5', 'giraffe', 'white'], ['1,4', 'rook', 'black']]);
  const dm = dests(legalMoves(capturable), '5,5');
  assert.ok(dm.includes('1,4'));
  assert.ok(!dm.includes('0,4'));
});

test('pawn steps and captures forward only', () => {
  const s = S([
    ...kings,
    ['5,5', 'pawn', 'white', { promotion: 'rook' }], ['4,6', 'rook', 'black'],
  ]);
  assert.deepEqual(dests(legalMoves(s), '5,5'), ['4,6', '5,6']);
  const sb = S([
    ...kings,
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

test('royal safety uses the completed promotion rather than the previous royal count', () => {
  for (const extra of [{ promotion: 'prince' }, { promotion: 'pawn', stage: 2 }]) {
    const state = S([
      ['5,0', 'king', 'white'], ['5,5', 'rook', 'black'],
      ['3,8', 'pawn', 'white', extra], ['10,9', 'king', 'black'],
    ]);
    assert.equal(inCheck(state, 'white'), true);
    const promoted = applyMove(state, { from: '3,8', to: '3,9' });
    assert.equal(promoted.board['3,9'].type, extra.promotion === 'prince' ? 'prince' : 'adventitious');
    const captured = applyMove(promoted, { from: '5,5', to: '5,0' });
    assert.equal(captured.board['5,0'].color, 'black');
    assert.equal(captured.result, null);
    assert.ok(has(legalMoves(captured), '3,9', '4,9'));
  }
  const ordinary = S([
    ['5,0', 'king', 'white'], ['5,5', 'rook', 'black'],
    ['3,8', 'pawn', 'white', { promotion: 'rook' }], ['10,9', 'king', 'black'],
  ]);
  assert.ok(!has(legalMoves(ordinary), '3,8', '3,9'));
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

test('royal exchange: checked only, any friendly piece, once per side', () => {
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
  // Black re-checks the king: the exchange has already been spent.
  const s3 = applyMove(s2, { from: '5,5', to: '5,0' });
  assert.equal(inCheck(s3, 'white'), true);
  assert.ok(!legalMoves(s3).some((m) => m.kind === 'exchange'));
  // Not in check with moves available: exchange never offered.
  const quiet = S([...kings, ['0,0', 'rook', 'white']]);
  assert.ok(!legalMoves(quiet).some((m) => m.kind === 'exchange'));
});

test('royal exchange: another royal is a legal partner, safety still applies', () => {
  const s = S([
    ['0,0', 'king', 'white'], ['4,2', 'prince', 'white'],
    ['0,5', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  const ms = legalMoves(s);
  assert.ok(has(ms, '0,0', '4,2', 'exchange'));
  const s2 = applyMove(s, { from: '0,0', to: '4,2', kind: 'exchange' });
  assert.equal(s2.board['4,2'].type, 'king');
  assert.equal(s2.board['0,0'].type, 'prince'); // exposed lower royal is allowed
  assert.equal(s2.exchangeUsed.white, true);
  assert.equal(inCheck(s2, 'white'), false);
  // A swap into the own citadel is never offered, even to a sheltered royal.
  const own = S([
    ['10,1', 'king', 'white'], ['11,1', 'adventitious', 'white'],
    ['0,1', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  assert.equal(inCheck(own, 'white'), true);
  const ownMs = legalMoves(own);
  assert.ok(!has(ownMs, '10,1', '11,1', 'exchange'));
});

test('royal exchange: never offered for a mere stalemate', () => {
  // White king boxed in and a white pawn with no moves; the side has no legal
  // moves at all, yet the exchange must stay unavailable.
  const s = S([
    ['0,0', 'king', 'white'], ['4,9', 'pawn', 'white', { promotion: 'pawn', stage: 1, dormant: true }],
    ['1,5', 'rook', 'black'], ['3,2', 'camel', 'black'], ['10,9', 'king', 'black'],
  ]);
  assert.equal(inCheck(s, 'white'), false);
  assert.deepEqual(legalMoves(s), []);
  // The stalemate is only declared once a move has been made, and the winner
  // is the opponent of the side that has no moves.
  const s2 = applyMove({ ...s, turn: 'black' }, { from: '10,9', to: '10,8' });
  assert.deepEqual(s2.result, { winner: 'black', reason: 'stalemate' });
});

test('exchange off the far rank ends pawn-of-pawns immunity, keeps its stage', () => {
  const s = S([
    ['0,0', 'king', 'white'],
    ['4,2', 'pawn', 'white', { promotion: 'pawn', stage: 1, dormant: true }],
    ['0,5', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  const pid = s.board['4,2'].id;
  const s2 = applyMove(s, { from: '0,0', to: '4,2', kind: 'exchange' });
  assert.equal(s2.board['4,2'].type, 'king');
  assert.equal(s2.board['0,0'].id, pid);
  assert.equal(s2.board['0,0'].type, 'pawn');
  assert.equal(s2.board['0,0'].stage, 1);
  assert.equal(s2.board['0,0'].dormant, undefined);
  assert.equal(s2.board['0,0'].awaitingReturn, undefined);
});

test('citadel entry is an immediate draw with no choice state', () => {
  const s = S([
    ['0,8', 'king', 'white'], ['3,3', 'prince', 'white'], ['10,9', 'king', 'black'],
  ]);
  const snap = JSON.stringify(s);
  assert.ok(has(legalMoves(s), '0,8', '-1,8'));
  const entered = applyMove(s, { from: '0,8', to: '-1,8' });
  assert.equal(JSON.stringify(s), snap); // input untouched
  assert.deepEqual(entered.result, { winner: null, reason: 'citadel draw' });
  assert.equal(entered.turn, 'black');
  assert.equal(entered.ply, 1);
  assert.equal(entered.pendingRoyalReturn, null);
  assert.equal('pendingCitadel' in entered, false);
  assert.equal('citadelUsed' in entered, false);
  assert.equal(entered.history.length, 1);
  assert.equal(entered.history[0].kind, 'move');
  assert.equal(entered.board['-1,8'].type, 'king');
  assert.deepEqual(legalMoves(entered), []);
  // Sole royal: still just a draw, never an extra decision.
  const sole = applyMove(S([['0,8', 'king', 'white'], ['10,9', 'king', 'black']]),
    { from: '0,8', to: '-1,8' });
  assert.deepEqual(sole.result, { winner: null, reason: 'citadel draw' });
  assert.equal(sole.ply, 1);
  // A non-highest royal may not enter the opponent citadel.
  const notHighest = S([
    ['0,8', 'prince', 'white'], ['5,5', 'king', 'white'], ['10,9', 'king', 'black'],
  ]);
  assert.ok(!has(legalMoves(notHighest), '0,8', '-1,8'));
  // Obsolete choice kinds cannot be played.
  assert.throws(() => applyMove(s, { from: '0,8', to: '-1,8', kind: 'citadel-draw' }));
});

test('royal return after a capture: pending owner choice, no extra ply', () => {
  const s = S([
    ['11,1', 'adventitious', 'white'],
    ['2,0', 'king', 'white'], ['2,2', 'rook', 'black'], ['10,9', 'king', 'black'],
  ], 'black');
  const adId = s.board['11,1'].id;
  const snap = JSON.stringify(s);
  const cap = applyMove(s, { from: '2,2', to: '2,0' }); // rook c3xc1
  assert.equal(JSON.stringify(s), snap); // input untouched
  assert.equal(cap.result, null);
  assert.deepEqual(cap.pendingRoyalReturn, {
    color: 'white', royal: adId, from: '11,1', resumeTurn: 'white',
  });
  assert.equal(cap.turn, 'white'); // the owner resolves before playing on
  assert.equal(cap.ply, 1);
  assert.equal(cap.board['2,0'].type, 'rook');
  assert.equal(cap.history.at(-1).kind, 'move');

  const choices = legalMoves(cap);
  assert.ok(choices.length > 0);
  assert.ok(choices.every((m) => m.kind === 'royal-return' && m.from === '11,1'));
  assert.ok(choices.every((m) => !cap.board[m.to])); // only empty main-board squares
  assert.ok(choices.every((m) => m.to !== '11,1'));
  // The c1 rook controls c2 and the whole first rank, so those are excluded.
  assert.ok(!choices.some((m) => m.to === '2,1'));
  assert.ok(!choices.some((m) => m.to === '0,0'));
  assert.ok(choices.some((m) => m.to === '3,2'));

  const placed = applyMove(cap, { from: '11,1', to: '3,2', kind: 'royal-return' });
  assert.equal(placed.ply, 1); // the placement spends no turn
  assert.equal(placed.turn, 'white'); // resumeTurn
  assert.equal(placed.pendingRoyalReturn, null);
  assert.equal(placed.result, null);
  assert.equal(placed.board['3,2'].id, adId);
  assert.equal(placed.board['3,2'].type, 'adventitious');
  assert.equal(placed.board['11,1'], undefined);
  assert.equal(placed.history.at(-1).kind, 'royal-return');
  assert.deepEqual(s.pendingRoyalReturn, null);

  // White then plays an ordinary move and only that move advances the ply.
  const next = applyMove(placed, { from: '3,2', to: '4,3' });
  assert.equal(next.turn, 'black');
  assert.equal(next.ply, 2);

  // Pending states survive a JSON round trip unchanged.
  const clone = JSON.parse(JSON.stringify(cap));
  assert.deepEqual(clone, cap);
  assert.deepEqual(legalMoves(clone), choices);
});

test('voluntary own-citadel entry by the sole royal also returns by choice', () => {
  const s = S([
    ['10,1', 'adventitious', 'white'],
    ['3,0', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  const cap = applyMove(s, { from: '10,1', to: '11,1' });
  assert.deepEqual(cap.pendingRoyalReturn, {
    color: 'white', royal: s.board['10,1'].id, from: '11,1', resumeTurn: 'black',
  });
  assert.equal(cap.turn, 'white');
  assert.equal(cap.ply, 1);
  const choices = legalMoves(cap);
  assert.ok(choices.every((m) => m.kind === 'royal-return'));
  // The d1 rook controls the d-file.
  assert.ok(!choices.some((m) => m.to === '3,5'));
  assert.ok(choices.some((m) => m.to === '0,5'));
  const placed = applyMove(cap, { from: '11,1', to: '0,5', kind: 'royal-return' });
  assert.equal(placed.ply, 1);
  assert.equal(placed.turn, 'black'); // opponent after a voluntary entry
  // Black's ordinary move is what advances the ply.
  const next = applyMove(placed, { from: '10,9', to: '10,8' });
  assert.equal(next.ply, 2);
  assert.equal(next.turn, 'white');
});

test('voluntary return mirrors for black', () => {
  const s = S([
    ['0,8', 'adventitious', 'black'], ['5,0', 'king', 'white'],
  ], 'black');
  const cap = applyMove(s, { from: '0,8', to: '-1,8' });
  assert.deepEqual(cap.pendingRoyalReturn, {
    color: 'black', royal: s.board['0,8'].id, from: '-1,8', resumeTurn: 'white',
  });
  assert.equal(cap.turn, 'black');
  const placed = applyMove(cap, { from: '-1,8', to: '5,5', kind: 'royal-return' });
  assert.equal(placed.ply, 1);
  assert.equal(placed.turn, 'white');
});

test('no safe return target resolves as an immediate loss, not a pending state', () => {
  // Every main-board square is occupied; when the black king captures the
  // white king the only vacated square is attacked by the black king itself.
  const placements = [
    ['11,1', 'adventitious', 'white'], ['0,0', 'king', 'white'], ['0,1', 'king', 'black'],
  ];
  for (let y = 0; y <= 9; y++) {
    for (let x = 0; x <= 10; x++) {
      const k = x + ',' + y;
      if (k === '0,0' || k === '0,1') continue;
      placements.push([k, 'pawn', 'white', { promotion: 'rook' }]);
    }
  }
  const s = S(placements, 'black');
  const out = applyMove(s, { from: '0,1', to: '0,0' });
  assert.equal(out.pendingRoyalReturn, null);
  assert.deepEqual(out.result, { winner: 'black', reason: 'stalemate' });
  assert.equal(out.board['0,0'].color, 'black');
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

test('pawn-of-pawns: deployment is an extra option, not a compulsion', () => {
  const s = S([
    ['2,9', 'pawn', 'white', { promotion: 'pawn', stage: 1, dormant: true }],
    ['5,0', 'king', 'white'],
    ['4,5', 'rook', 'black'], ['6,5', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  const ms = legalMoves(s);
  const deploys = kinds(ms, 'deploy');
  assert.equal(deploys.length, 1);
  assert.equal(deploys[0].from, '2,9');
  assert.equal(deploys[0].to, '5,4');
  // Ordinary moves remain available while the pawn stays dormant.
  assert.ok(has(ms, '5,0', '5,1'));
  const quiet = applyMove(s, { from: '5,0', to: '5,1' });
  assert.equal(quiet.board['2,9'].dormant, true);
  assert.equal(quiet.board['2,9'].stage, 1);

  const s2 = applyMove(s, deploys[0]);
  assert.equal(s2.board['5,4'].type, 'pawn');
  assert.equal(s2.board['5,4'].dormant, undefined);
  assert.equal(s2.board['5,4'].stage, 1); // deployment is not a new arrival
  assert.ok(!s2.board['2,9']);
  assert.equal(s2.turn, 'black');
  assert.ok(!s2.history.some((h) => h.kind === 'return'));
});

test('pawn-of-pawns: deploy may replace own or enemy lower royals', () => {
  const s = S([
    ['2,9', 'pawn', 'white', { promotion: 'pawn', stage: 1, dormant: true }],
    ['5,0', 'king', 'white'], ['5,4', 'ferz', 'white'],
    ['4,5', 'rook', 'black'], ['6,5', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  const deploys = kinds(legalMoves(s), 'deploy');
  assert.equal(deploys.length, 1);
  assert.equal(deploys[0].replaces, s.board['5,4'].id);
  const s2 = applyMove(s, deploys[0]);
  assert.equal(s2.board['5,4'].type, 'pawn');
  assert.equal(s2.history.at(-1).capture, 'ferz');
  assert.ok(!Object.values(s2.board).some((p) => p.type === 'ferz'));

  // An enemy prince is an ordinary capturable piece for deployment ...
  const lowerEnemy = S([
    ['2,9', 'pawn', 'white', { promotion: 'pawn', stage: 1, dormant: true }],
    ['5,0', 'king', 'white'], ['5,4', 'prince', 'black'],
    ['4,5', 'rook', 'black'], ['6,5', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  const enemyDeploys = kinds(legalMoves(lowerEnemy), 'deploy');
  assert.equal(enemyDeploys.length, 1);
  assert.equal(enemyDeploys[0].replaces, lowerEnemy.board['5,4'].id);

  // ... but a reigning royal is never displaceable.
  const reigning = S([
    ['2,9', 'pawn', 'white', { promotion: 'pawn', stage: 1, dormant: true }],
    ['5,0', 'king', 'white'], ['5,4', 'king', 'black'],
    ['4,5', 'rook', 'black'], ['6,5', 'rook', 'black'],
  ]);
  assert.deepEqual(kinds(legalMoves(reigning), 'deploy'), []);
});

test('pawn-of-pawns: single-attack deploy requires genuine no-escape (pins)', () => {
  // Black ferz on e6 (4,5) is pinned to its king on a6 (0,5) by the white rook
  // on h6 (7,5): leaving the rank exposes the king, so it cannot escape.
  const s = S([
    ['2,9', 'pawn', 'white', { promotion: 'pawn', stage: 1, dormant: true }],
    ['5,0', 'king', 'white'], ['7,5', 'rook', 'white'],
    ['4,5', 'ferz', 'black'], ['0,5', 'king', 'black'],
  ]);
  const deploys = kinds(legalMoves(s), 'deploy');
  assert.deepEqual(deploys.map((m) => m.to).sort(), ['3,4', '5,4']);
});

test('pawn-of-pawns: deployment may never expose the sole royal', () => {
  // The dormant pawn shields the king on the f-file; both fork squares move it
  // off the file, so no deployment is legal.
  const s = S([
    ['5,5', 'king', 'white'], ['5,0', 'rook', 'black'],
    ['3,8', 'ferz', 'black'], ['5,8', 'ferz', 'black'],
    ['5,2', 'pawn', 'white', { promotion: 'pawn', stage: 1, dormant: true }],
    ['10,9', 'king', 'black'],
  ]);
  const ms = legalMoves(s);
  assert.deepEqual(kinds(ms, 'deploy'), []);
  assert.ok(has(ms, '5,5', '4,5')); // ordinary moves remain
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
  assert.equal(s2.pendingRoyalReturn, null); // a second royal is alive
});

test('adventitious king shelters in its own citadel while another royal lives', () => {
  const s = S([
    ['10,1', 'adventitious', 'white'], ['5,0', 'king', 'white'], ['10,9', 'king', 'black'],
  ]);
  const s2 = applyMove(s, { from: '10,1', to: '11,1' });
  assert.equal(s2.board['11,1'].type, 'adventitious');
  assert.equal(s2.pendingRoyalReturn, null);
  assert.equal(s2.turn, 'black');
  assert.equal(s2.ply, 1);
});

test('restoreState: legacy pending citadel becomes the immediate draw', () => {
  const legacy = {
    ...S([['-1,8', 'king', 'white'], ['3,3', 'prince', 'white'], ['10,9', 'king', 'black']]),
    ply: 7,
    history: [{ from: '0,8', to: '-1,8', kind: 'move', piece: 'king', color: 'white', notation: 'K-a9x' }],
    citadelUsed: { white: false, black: false },
    pendingCitadel: { color: 'white', royal: 't-legacy', citadel: '-1,8' },
  };
  legacy.pendingCitadel.royal = legacy.board['-1,8'].id;
  const snap = JSON.stringify(legacy);
  const restored = restoreState(legacy);
  assert.equal(JSON.stringify(legacy), snap); // pure
  assert.deepEqual(restored.result, { winner: null, reason: 'citadel draw' });
  assert.equal(restored.ply, 7);
  assert.equal(restored.history.length, 1);
  assert.equal(restored.history[0].kind, 'move');
  assert.equal('pendingCitadel' in restored, false);
  assert.equal('citadelUsed' in restored, false);
  assert.equal(restored.pendingRoyalReturn, null);
  assert.equal(restored.board['-1,8'].type, 'king');
  assert.deepEqual(legalMoves(restored), []);
});

test('restoreState: preserves finished results and modern pending state', () => {
  const mated = applyMove(
    S([['0,0', 'king', 'white'], ['7,5', 'rook', 'black'], ['1,9', 'rook', 'black'], ['10,9', 'king', 'black']], 'black'),
    { from: '7,5', to: '0,5' },
  );
  const restored = restoreState(mated);
  assert.deepEqual(restored.result, { winner: 'black', reason: 'checkmate' });

  const pending = applyMove(
    S([['11,1', 'adventitious', 'white'], ['2,0', 'king', 'white'], ['2,2', 'rook', 'black'], ['10,9', 'king', 'black']], 'black'),
    { from: '2,2', to: '2,0' },
  );
  const kept = restoreState(pending);
  assert.deepEqual(kept.pendingRoyalReturn, pending.pendingRoyalReturn);
  assert.deepEqual(legalMoves(kept), legalMoves(pending));
  assert.equal(kept.result, null);

  // Idempotent on an already-current state.
  assert.deepEqual(restoreState(initialState()), initialState());
  assert.deepEqual(restoreState(restoreState(initialState())), restoreState(initialState()));
  assert.throws(() => restoreState(null));
});

test('applyMove: immutability and validation errors', () => {
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
  assert.throws(() => applyMove(initialState(), { from: '0,1', to: '0,3', kind: 'citadel-swap' }));
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

test('bot: legal deterministic move, mate in one, free choices, null when over', () => {
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

  // Free royal-return placement is a legal bot choice.
  const pending = applyMove(
    S([['11,1', 'adventitious', 'white'], ['2,0', 'king', 'white'], ['2,2', 'rook', 'black'], ['10,9', 'king', 'black']], 'black'),
    { from: '2,2', to: '2,0' },
  );
  const free = chooseBotMove(pending, { depth: 1, timeMs: 200 });
  assert.ok(free);
  assert.equal(free.kind, 'royal-return');
  assert.ok(has(legalMoves(pending), free.from, free.to, 'royal-return'));
  assert.ok(applyMove(pending, free).pendingRoyalReturn === null);

  // Optional deployment does not starve the bot of ordinary moves.
  const fork = S([
    ['2,9', 'pawn', 'white', { promotion: 'pawn', stage: 1, dormant: true }],
    ['5,0', 'king', 'white'],
    ['4,5', 'rook', 'black'], ['6,5', 'rook', 'black'], ['10,9', 'king', 'black'],
  ]);
  const pick = chooseBotMove(fork, { depth: 1, timeMs: 300 });
  assert.ok(has(legalMoves(fork), pick.from, pick.to, pick.kind || 'move'));
  assert.ok(applyMove(fork, pick));
});
