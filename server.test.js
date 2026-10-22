// Behavioral integration tests for the Great Chess authoritative server.
//
// Run with: node --test server.test.js
// Every test boots an isolated app on an ephemeral port with its own temporary
// SQLite directory. No fixed ports or shared state, so the suite is parallel-safe.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from './server.js';
import { initialState, legalMoves } from './engine.js';

const ALLOWED_ORIGIN = 'https://gowanginc.github.io';

async function launch(options = {}) {
  const dataDir = options.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), 'great-chess-test-')));
  const app = createApp({ dataDir, ...options });
  const { port } = await app.listen(0, '127.0.0.1');
  return { app, dataDir, port, base: `http://127.0.0.1:${port}` };
}

async function withServer(t, options = {}) {
  const ctx = await launch(options);
  t.after(async () => {
    await ctx.app.close();
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  return ctx;
}

async function api(base, method, route, { token, body, origin, raw } = {}) {
  const headers = {};
  if (raw !== undefined || body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  const response = await fetch(base + route, {
    method,
    headers,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

function openingMove() {
  const moves = legalMoves(initialState()) || [];
  const move = moves.find((candidate) => (candidate.kind ?? 'move') === 'move');
  assert.ok(move, 'engine must expose at least one legal opening move');
  return { from: move.from, to: move.to, ...(move.kind ? { kind: move.kind } : {}) };
}

async function createAndFill(base, { name = 'Test Room', password, whiteName = 'Ann', blackName = 'Bob' } = {}) {
  const created = await api(base, 'POST', '/api/rooms', {
    body: { name, playerName: whiteName, ...(password ? { password } : {}) },
  });
  assert.equal(created.status, 201, created.text);
  const joined = await api(base, 'POST', `/api/rooms/${created.json.roomId}/join`, {
    body: { playerName: blackName, ...(password ? { password } : {}) },
  });
  assert.equal(joined.status, 200, joined.text);
  return {
    roomId: created.json.roomId,
    whiteToken: created.json.token,
    blackToken: joined.json.token,
  };
}

function openSocket(port, origin = ALLOWED_ORIGIN) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin } });
  socket.on('error', () => {});
  return socket;
}

async function socketOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return socket;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 3000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

function frameQueue(socket) {
  const queue = [];
  const waiters = [];
  socket.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });
  return {
    next(timeout = 3000) {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(deliver);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timed out waiting for websocket frame'));
        }, timeout);
        function deliver(frame) {
          clearTimeout(timer);
          resolve(frame);
        }
        waiters.push(deliver);
      });
    },
  };
}

async function subscribe(socket, roomId, token) {
  const frames = frameQueue(socket);
  socket.send(JSON.stringify({ type: 'subscribe', roomId, token }));
  return frames;
}

function closeSocket(socket) {
  try {
    socket.terminate();
  } catch {
    // Already closed.
  }
}

// ---------------------------------------------------------------------------
// Health and public lobby
// ---------------------------------------------------------------------------

test('health returns the fixed payload with no machine details', async (t) => {
  const { base } = await withServer(t);
  const response = await api(base, 'GET', '/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, version: '1.0.0' });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!/host|machine|server-name|instance/i.test(response.text));
});

test('created room appears in the public list without secrets or board state', async (t) => {
  const { base } = await withServer(t);
  const created = await api(base, 'POST', '/api/rooms', {
    body: { name: 'Lobby Room', playerName: 'Ann' },
  });
  assert.equal(created.status, 201);
  const { roomId, token, color } = created.json;
  assert.match(roomId, /^[A-Za-z0-9_-]{8,32}$/);
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(color, 'white');

  const list = await api(base, 'GET', '/api/rooms');
  assert.equal(list.status, 200);
  assert.equal(list.json.rooms.length, 1);
  assert.deepEqual(list.json.rooms[0], {
    id: roomId,
    name: 'Lobby Room',
    locked: false,
    players: 1,
    status: 'waiting',
  });
  assert.ok(!list.text.includes(token), 'public list must not leak seat tokens');
  assert.ok(!/[0-9a-f]{64}/.test(list.text), 'public list must not leak token hashes');
  assert.ok(!list.text.includes('board'), 'public list must not leak game state');
});

test('two seats join, a third join is rejected', async (t) => {
  const { base } = await withServer(t);
  const created = await api(base, 'POST', '/api/rooms', {
    body: { name: 'Pairs', playerName: 'Ann' },
  });
  const joined = await api(base, 'POST', `/api/rooms/${created.json.roomId}/join`, {
    body: { playerName: 'Bob' },
  });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.color, 'black');
  assert.notEqual(joined.json.token, created.json.token);

  const third = await api(base, 'POST', `/api/rooms/${created.json.roomId}/join`, {
    body: { playerName: 'Cara' },
  });
  assert.equal(third.status, 409);

  const list = await api(base, 'GET', '/api/rooms');
  assert.equal(list.json.rooms[0].players, 2);
  assert.equal(list.json.rooms[0].status, 'playing');
});

// ---------------------------------------------------------------------------
// Authentication and isolation
// ---------------------------------------------------------------------------

test('password rooms gate joining and private reads require the seat token', async (t) => {
  const { base } = await withServer(t);
  const created = await api(base, 'POST', '/api/rooms', {
    body: { name: 'Secret', playerName: 'Ann', password: 'correct horse' },
  });
  assert.equal(created.status, 201);
  const { roomId, token: whiteToken } = created.json;

  const missing = await api(base, 'POST', `/api/rooms/${roomId}/join`, {
    body: { playerName: 'Bob' },
  });
  assert.equal(missing.status, 403);

  const wrong = await api(base, 'POST', `/api/rooms/${roomId}/join`, {
    body: { playerName: 'Bob', password: 'wrong horse' },
  });
  assert.equal(wrong.status, 403);
  assert.ok(!wrong.text.includes('correct horse'));

  const right = await api(base, 'POST', `/api/rooms/${roomId}/join`, {
    body: { playerName: 'Bob', password: 'correct horse' },
  });
  assert.equal(right.status, 200);
  assert.equal(right.json.color, 'black');

  const anonymous = await api(base, 'GET', `/api/rooms/${roomId}`);
  assert.equal(anonymous.status, 401);

  const other = await api(base, 'POST', '/api/rooms', {
    body: { name: 'Other', playerName: 'Cara' },
  });
  const crossRead = await api(base, 'GET', `/api/rooms/${roomId}`, {
    token: other.json.token,
  });
  assert.equal(crossRead.status, 401);
  const crossAction = await api(base, 'POST', `/api/rooms/${roomId}/action`, {
    token: other.json.token,
    body: { type: 'resign' },
  });
  assert.equal(crossAction.status, 401);

  const invalidResume = await api(base, 'POST', `/api/rooms/${roomId}/join`, {
    body: { playerName: 'Mallory', resumeToken: other.json.token },
  });
  assert.equal(invalidResume.status, 403);

  const list = await api(base, 'GET', '/api/rooms');
  const entry = list.json.rooms.find((room) => room.id === roomId);
  assert.equal(entry.locked, true);
  assert.equal(entry.players, 2);
});

test('private room read returns the exact wire shape', async (t) => {
  const { base } = await withServer(t);
  const { roomId, whiteToken, blackToken } = await createAndFill(base);
  const response = await api(base, 'GET', `/api/rooms/${roomId}`, { token: whiteToken });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json).sort(), ['drawOffer', 'room', 'state', 'you']);
  assert.equal(response.json.you, 'white');
  assert.equal(response.json.drawOffer, null);
  assert.equal(response.json.state.ply, 0);
  assert.equal(response.json.state.turn, 'white');
  assert.equal(response.json.room.status, 'playing');
  assert.deepEqual(
    response.json.room.players.map((player) => [player.color, player.name]),
    [
      ['white', 'Ann'],
      ['black', 'Bob'],
    ],
  );
  const blackView = await api(base, 'GET', `/api/rooms/${roomId}`, { token: blackToken });
  assert.equal(blackView.json.you, 'black');
});

test('rooms are isolated from each other', async (t) => {
  const { base } = await withServer(t);
  const first = await createAndFill(base, { name: 'First' });
  const second = await createAndFill(base, { name: 'Second' });

  const moved = await api(base, 'POST', `/api/rooms/${first.roomId}/action`, {
    token: first.whiteToken,
    body: { type: 'move', move: openingMove(), expectedPly: 0 },
  });
  assert.equal(moved.status, 200);

  const firstState = await api(base, 'GET', `/api/rooms/${first.roomId}`, {
    token: first.whiteToken,
  });
  const secondState = await api(base, 'GET', `/api/rooms/${second.roomId}`, {
    token: second.whiteToken,
  });
  assert.equal(firstState.json.state.ply, 1);
  assert.equal(secondState.json.state.ply, 0);

  const crossMove = await api(base, 'POST', `/api/rooms/${second.roomId}/action`, {
    token: first.blackToken,
    body: { type: 'move', move: openingMove(), expectedPly: 0 },
  });
  assert.equal(crossMove.status, 401);
});

// ---------------------------------------------------------------------------
// Action validation
// ---------------------------------------------------------------------------

test('illegal, stale, out-of-turn and premature moves are rejected without mutating state', async (t) => {
  const { base } = await withServer(t);
  const { roomId, whiteToken, blackToken } = await createAndFill(base);

  const sameSquare = await api(base, 'POST', `/api/rooms/${roomId}/action`, {
    token: whiteToken,
    body: { type: 'move', move: { from: '0,0', to: '0,0' }, expectedPly: 0 },
  });
  assert.equal(sameSquare.status, 400);
  assert.ok(sameSquare.json.error);

  const emptySquare = await api(base, 'POST', `/api/rooms/${roomId}/action`, {
    token: whiteToken,
    body: { type: 'move', move: { from: '5,5', to: '5,6' }, expectedPly: 0 },
  });
  assert.equal(emptySquare.status, 400);

  const stalePly = await api(base, 'POST', `/api/rooms/${roomId}/action`, {
    token: whiteToken,
    body: { type: 'move', move: openingMove(), expectedPly: 5 },
  });
  assert.equal(stalePly.status, 409);

  const outOfTurn = await api(base, 'POST', `/api/rooms/${roomId}/action`, {
    token: blackToken,
    body: { type: 'move', move: openingMove(), expectedPly: 0 },
  });
  assert.equal(outOfTurn.status, 409);

  const unchanged = await api(base, 'GET', `/api/rooms/${roomId}`, { token: whiteToken });
  assert.equal(unchanged.json.state.ply, 0);

  const lonely = await api(base, 'POST', '/api/rooms', {
    body: { name: 'Alone', playerName: 'Solo' },
  });
  const premature = await api(base, 'POST', `/api/rooms/${lonely.json.roomId}/action`, {
    token: lonely.json.token,
    body: { type: 'move', move: openingMove(), expectedPly: 0 },
  });
  assert.equal(premature.status, 409);

  const badAction = await api(base, 'POST', `/api/rooms/${roomId}/action`, {
    token: whiteToken,
    body: { type: 'teleport' },
  });
  assert.equal(badAction.status, 400);
});

test('a legal move from the shared engine is accepted and broadcast in the state', async (t) => {
  const { base } = await withServer(t);
  const { roomId, whiteToken, blackToken } = await createAndFill(base);

  const response = await api(base, 'POST', `/api/rooms/${roomId}/action`, {
    token: whiteToken,
    body: { type: 'move', move: openingMove(), expectedPly: 0 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true });

  const whiteView = await api(base, 'GET', `/api/rooms/${roomId}`, { token: whiteToken });
  assert.equal(whiteView.json.state.ply, 1);
  assert.equal(whiteView.json.state.turn, 'black');
  assert.equal(whiteView.json.state.history.length, 1);
  assert.equal(whiteView.json.state.result, null);

  const blackView = await api(base, 'GET', `/api/rooms/${roomId}`, { token: blackToken });
  assert.equal(blackView.json.state.ply, 1);
});

// ---------------------------------------------------------------------------
// Resign, draw, rematch
// ---------------------------------------------------------------------------

test('draw offers, resignations and rematches follow the wire contract', async (t) => {
  const { base } = await withServer(t);

  // Draw by agreement.
  const draw = await createAndFill(base, { name: 'Draw' });
  const duplicate = await api(base, 'POST', `/api/rooms/${draw.roomId}/action`, {
    token: draw.whiteToken,
    body: { type: 'accept-draw' },
  });
  assert.equal(duplicate.status, 409, 'cannot accept a draw that was never offered');

  const offer = await api(base, 'POST', `/api/rooms/${draw.roomId}/action`, {
    token: draw.whiteToken,
    body: { type: 'offer-draw' },
  });
  assert.equal(offer.status, 200);
  const selfAccept = await api(base, 'POST', `/api/rooms/${draw.roomId}/action`, {
    token: draw.whiteToken,
    body: { type: 'accept-draw' },
  });
  assert.equal(selfAccept.status, 409);

  const offeredView = await api(base, 'GET', `/api/rooms/${draw.roomId}`, {
    token: draw.blackToken,
  });
  assert.equal(offeredView.json.drawOffer, 'white');

  const accept = await api(base, 'POST', `/api/rooms/${draw.roomId}/action`, {
    token: draw.blackToken,
    body: { type: 'accept-draw' },
  });
  assert.equal(accept.status, 200);
  const drawn = await api(base, 'GET', `/api/rooms/${draw.roomId}`, { token: draw.whiteToken });
  assert.equal(drawn.json.state.result.winner, null);
  assert.equal(drawn.json.room.status, 'finished');
  assert.equal(drawn.json.drawOffer, null);

  const moveAfterResult = await api(base, 'POST', `/api/rooms/${draw.roomId}/action`, {
    token: draw.whiteToken,
    body: { type: 'move', move: openingMove(), expectedPly: 0 },
  });
  assert.equal(moveAfterResult.status, 409);

  // Rematch requires both seats.
  const single = await api(base, 'POST', `/api/rooms/${draw.roomId}/action`, {
    token: draw.whiteToken,
    body: { type: 'rematch' },
  });
  assert.equal(single.status, 200);
  const stillFinished = await api(base, 'GET', `/api/rooms/${draw.roomId}`, {
    token: draw.whiteToken,
  });
  assert.notEqual(stillFinished.json.state.result, null);

  const both = await api(base, 'POST', `/api/rooms/${draw.roomId}/action`, {
    token: draw.blackToken,
    body: { type: 'rematch' },
  });
  assert.equal(both.status, 200);
  const reset = await api(base, 'GET', `/api/rooms/${draw.roomId}`, { token: draw.whiteToken });
  assert.equal(reset.json.state.ply, 0);
  assert.equal(reset.json.state.result, null);
  assert.equal(reset.json.room.status, 'playing');

  // Resignation awards the game to the opponent.
  const resignRoom = await createAndFill(base, { name: 'Resign' });
  const resign = await api(base, 'POST', `/api/rooms/${resignRoom.roomId}/action`, {
    token: resignRoom.blackToken,
    body: { type: 'resign' },
  });
  assert.equal(resign.status, 200);
  const resigned = await api(base, 'GET', `/api/rooms/${resignRoom.roomId}`, {
    token: resignRoom.whiteToken,
  });
  assert.equal(resigned.json.state.result.winner, 'white');
  assert.equal(resigned.json.state.result.reason, 'resignation');

  const resignAgain = await api(base, 'POST', `/api/rooms/${resignRoom.roomId}/action`, {
    token: resignRoom.whiteToken,
    body: { type: 'resign' },
  });
  assert.equal(resignAgain.status, 409);
});

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

test('websocket subscribe authenticates, broadcasts and rejects bad frames', async (t) => {
  const { base, port } = await withServer(t);
  const created = await api(base, 'POST', '/api/rooms', {
    body: { name: 'Live', playerName: 'Ann' },
  });
  const { roomId, token: whiteToken } = created.json;

  const white = openSocket(port);
  t.after(() => closeSocket(white));
  await socketOpen(white);
  const whiteFrames = await subscribe(white, roomId, whiteToken);

  const initial = await whiteFrames.next();
  assert.equal(initial.type, 'state');
  assert.equal(initial.you, 'white');
  assert.equal(initial.room.id, roomId);
  assert.equal(initial.room.players.length, 1);
  assert.equal(initial.room.players[0].connected, true);

  const joined = await api(base, 'POST', `/api/rooms/${roomId}/join`, {
    body: { playerName: 'Bob' },
  });
  assert.equal(joined.status, 200);
  const blackToken = joined.json.token;

  const afterJoin = await whiteFrames.next();
  assert.equal(afterJoin.type, 'state');
  assert.equal(afterJoin.room.players.length, 2);
  assert.equal(afterJoin.room.players.find((p) => p.color === 'white').connected, true);

  const black = openSocket(port);
  t.after(() => closeSocket(black));
  await socketOpen(black);
  const blackFrames = await subscribe(black, roomId, blackToken);
  const blackInitial = await blackFrames.next();
  assert.equal(blackInitial.you, 'black');
  assert.equal(blackInitial.room.players.length, 2);

  // Black's connection is itself broadcast to white.
  const whiteSeesBlack = await whiteFrames.next();
  assert.equal(whiteSeesBlack.state.ply, 0);
  assert.equal(whiteSeesBlack.room.players.find((p) => p.color === 'black').connected, true);

  const moved = await api(base, 'POST', `/api/rooms/${roomId}/action`, {
    token: whiteToken,
    body: { type: 'move', move: openingMove(), expectedPly: 0 },
  });
  assert.equal(moved.status, 200);
  const whiteUpdate = await whiteFrames.next();
  const blackUpdate = await blackFrames.next();
  assert.equal(whiteUpdate.state.ply, 1);
  assert.equal(blackUpdate.state.ply, 1);

  // Bad credentials and malformed frames produce error frames, not crashes.
  const probe = openSocket(port);
  t.after(() => closeSocket(probe));
  await socketOpen(probe);
  const probeFrames = frameQueue(probe);
  probe.send(JSON.stringify({ type: 'subscribe', roomId, token: 'x'.repeat(43) }));
  const unauthorized = await probeFrames.next();
  assert.equal(unauthorized.type, 'error');

  probe.send('this is not json');
  assert.equal((await probeFrames.next()).type, 'error');

  probe.send(JSON.stringify({ type: 'move', from: 'a', to: 'b' }));
  assert.equal((await probeFrames.next()).type, 'error');

  const health = await api(base, 'GET', '/api/health');
  assert.equal(health.status, 200);
});

test('websocket upgrades from disallowed origins are refused', async (t) => {
  const { port } = await withServer(t);
  const socket = openSocket(port, 'https://evil.example');
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 3000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve('open');
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve('error');
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve('close');
    });
  });
  assert.notEqual(outcome, 'open');
  closeSocket(socket);
});

// ---------------------------------------------------------------------------
// Persistence and reconnection
// ---------------------------------------------------------------------------

test('rooms, seats, tokens and board state survive a restart', async (t) => {
  const first = await launch();
  t.after(async () => {
    await first.app.close();
    await rm(first.dataDir, { recursive: true, force: true });
  });
  const { roomId, whiteToken, blackToken } = await createAndFill(first.base);
  const move = await api(first.base, 'POST', `/api/rooms/${roomId}/action`, {
    token: whiteToken,
    body: { type: 'move', move: openingMove(), expectedPly: 0 },
  });
  assert.equal(move.status, 200);
  await first.app.close();

  const second = await launch({ dataDir: first.dataDir });
  t.after(() => second.app.close());

  const whiteView = await api(second.base, 'GET', `/api/rooms/${roomId}`, { token: whiteToken });
  assert.equal(whiteView.status, 200);
  assert.equal(whiteView.json.you, 'white');
  assert.equal(whiteView.json.state.ply, 1);
  assert.equal(whiteView.json.state.turn, 'black');
  assert.equal(whiteView.json.room.players.every((player) => player.connected === false), true);

  const blackView = await api(second.base, 'GET', `/api/rooms/${roomId}`, { token: blackToken });
  assert.equal(blackView.status, 200);
  assert.equal(blackView.json.you, 'black');

  const list = await api(second.base, 'GET', '/api/rooms');
  assert.equal(list.json.rooms.length, 1);
  assert.equal(list.json.rooms[0].id, roomId);
  assert.equal(list.json.rooms[0].status, 'playing');

  // A persisted seat token also reconnects over the websocket.
  const socket = openSocket(second.port);
  t.after(() => closeSocket(socket));
  await socketOpen(socket);
  const frames = await subscribe(socket, roomId, blackToken);
  const frame = await frames.next();
  assert.equal(frame.type, 'state');
  assert.equal(frame.you, 'black');
  assert.equal(frame.state.ply, 1);

  // And the same token resumes the seat through join without a new seat.
  const resumed = await api(second.base, 'POST', `/api/rooms/${roomId}/join`, {
    body: { playerName: 'Bob', resumeToken: blackToken },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.json.color, 'black');
  assert.equal(blackView.json.room.players.length, 2);
});

// ---------------------------------------------------------------------------
// Input limits, static allowlist and CORS
// ---------------------------------------------------------------------------

test('oversized request bodies are rejected', async (t) => {
  const { base } = await withServer(t);
  const response = await api(base, 'POST', '/api/rooms', {
    raw: JSON.stringify({ name: 'big', playerName: 'Ann', padding: 'x'.repeat(30000) }),
  });
  assert.equal(response.status, 413);
});

test('room creation is rate limited per client', async (t) => {
  const { base } = await withServer(t);
  let last = null;
  for (let index = 0; index < 13; index += 1) {
    last = await api(base, 'POST', '/api/rooms', {
      body: { name: `Room ${index}`, playerName: 'Ann' },
    });
  }
  assert.equal(last.status, 429);
});

test('static serving is limited to the frontend allowlist', async (t) => {
  const { base } = await withServer(t);

  const index = await api(base, 'GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /text\/html/);
  assert.match(index.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(index.headers.get('x-frame-options'), 'DENY');

  const head = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);

  const script = await api(base, 'GET', '/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);

  for (const blocked of [
    '/server.js',
    '/server.test.js',
    '/package.json',
    '/compose.yaml',
    '/Dockerfile',
    '/data/great-chess.db',
    '/great-chess.db',
    '/%2e%2e/server.js',
    '/nope.js',
  ]) {
    const response = await api(base, 'GET', blocked);
    assert.equal(response.status, 404, `${blocked} must not be served`);
  }
});

test('creator may take the black seat and the opponent fills white', async (t) => {
  const { base } = await withServer(t);
  const invalid = await api(base, 'POST', '/api/rooms', {
    body: { name: 'Bad', playerName: 'Ann', color: 'purple' },
  });
  assert.equal(invalid.status, 400);

  const created = await api(base, 'POST', '/api/rooms', {
    body: { name: 'Black First', playerName: 'Zed', color: 'black' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.color, 'black');

  const view = await api(base, 'GET', `/api/rooms/${created.json.roomId}`, {
    token: created.json.token,
  });
  assert.equal(view.json.you, 'black');
  assert.deepEqual(
    view.json.room.players.map((player) => player.color),
    ['black'],
  );

  const joined = await api(base, 'POST', `/api/rooms/${created.json.roomId}/join`, {
    body: { playerName: 'Ann' },
  });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.color, 'white');
});

test('the configured room cap is enforced', async (t) => {
  const { base } = await withServer(t, { maxRooms: 1 });
  const first = await api(base, 'POST', '/api/rooms', {
    body: { name: 'Only', playerName: 'Ann' },
  });
  assert.equal(first.status, 201);
  const second = await api(base, 'POST', '/api/rooms', {
    body: { name: 'Overflow', playerName: 'Bob' },
  });
  assert.equal(second.status, 503);
});

test('finished rooms release capacity without losing history or bypassing rematch limits', async (t) => {
  const { base } = await withServer(t, { maxRooms: 1 });
  const first = await createAndFill(base);
  assert.equal((await api(base, 'POST', `/api/rooms/${first.roomId}/action`, {
    token: first.whiteToken, body: { type: 'resign' },
  })).status, 200);
  const second = await createAndFill(base, { name: 'Next game' });
  const retained = await api(base, 'GET', `/api/rooms/${first.roomId}`, { token: first.whiteToken });
  assert.equal(retained.json.state.result.reason, 'resignation');
  assert.equal((await api(base, 'POST', `/api/rooms/${first.roomId}/action`, {
    token: first.whiteToken, body: { type: 'rematch' },
  })).status, 200);
  assert.equal((await api(base, 'POST', `/api/rooms/${first.roomId}/action`, {
    token: first.blackToken, body: { type: 'rematch' },
  })).status, 503);
  assert.equal((await api(base, 'POST', `/api/rooms/${second.roomId}/action`, {
    token: second.whiteToken, body: { type: 'resign' },
  })).status, 200);
  assert.equal((await api(base, 'POST', `/api/rooms/${first.roomId}/action`, {
    token: first.blackToken, body: { type: 'rematch' },
  })).status, 200);
  const replay = await api(base, 'GET', `/api/rooms/${first.roomId}`, { token: first.whiteToken });
  assert.equal(replay.json.state.result, null);
  assert.equal(replay.json.state.ply, 0);
});

test('one-seat rooms age out after 24 hours but can be rejoined without losing the seat', async (t) => {
  let now = 1_000_000_000;
  const { base } = await withServer(t, { maxRooms: 1, now: () => now });
  const first = await api(base, 'POST', '/api/rooms', { body: { name: 'Waiting', playerName: 'Ann' } });
  const create = () => api(base, 'POST', '/api/rooms', { body: { name: 'Fresh', playerName: 'Bob' } });
  now += 24 * 60 * 60 * 1000 - 1;
  assert.equal((await create()).status, 503);
  now++;
  assert.deepEqual((await api(base, 'GET', '/api/rooms')).json.rooms, []);
  const second = await create();
  assert.equal(second.status, 201);
  const joinFirst = () => api(base, 'POST', `/api/rooms/${first.json.roomId}/join`, {
    body: { playerName: 'Guest' },
  });
  assert.equal((await joinFirst()).status, 503);
  assert.equal((await api(base, 'GET', `/api/rooms/${first.json.roomId}`, {
    token: first.json.token,
  })).json.you, 'white');
  await api(base, 'POST', `/api/rooms/${second.json.roomId}/join`, { body: { playerName: 'Guest' } });
  await api(base, 'POST', `/api/rooms/${second.json.roomId}/action`, {
    token: second.json.token, body: { type: 'resign' },
  });
  assert.equal((await joinFirst()).status, 200);
  assert.equal((await api(base, 'GET', '/api/rooms')).json.rooms[0].id, first.json.roomId);
});

test('CORS reflects only configured origins', async (t) => {
  const { base } = await withServer(t);

  const allowed = await api(base, 'GET', '/api/health', { origin: ALLOWED_ORIGIN });
  assert.equal(allowed.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.match(allowed.headers.get('vary') ?? '', /Origin/);

  const preflight = await fetch(`${base}/api/rooms`, {
    method: 'OPTIONS',
    headers: {
      origin: ALLOWED_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, authorization',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);

  const disallowed = await api(base, 'GET', '/api/health', { origin: 'https://evil.example' });
  assert.equal(disallowed.headers.get('access-control-allow-origin'), null);

  const forbiddenWrite = await api(base, 'POST', '/api/rooms', {
    origin: 'https://evil.example',
    body: { name: 'Sneaky', playerName: 'Mallory' },
  });
  assert.equal(forbiddenWrite.status, 403);
});
