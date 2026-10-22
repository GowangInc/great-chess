// Great Chess authoritative multiplayer server.
//
// Node 24+ ESM. One runtime dependency (`ws`), built-in `node:sqlite` for
// persistence. The board rules live entirely in the shared `engine.js` module;
// this file owns seats, authentication, room isolation and the wire protocol.
//
// Exports (fixed by the shared contract):
//   createApp(options) -> { server, db, listen, close, address }
//   VERSION
//
// The HTTP server only starts when this file is executed as the entrypoint.

import http from 'node:http';
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { initialState, applyMove } from './engine.js';

export const VERSION = '1.0.0';

const COLORS = ['white', 'black'];
const ACTIONS = new Set(['move', 'resign', 'offer-draw', 'accept-draw', 'rematch']);
const KINDS = new Set(['move', 'exchange', 'deploy', 'citadel-swap', 'citadel-draw']);

const MAX_BODY_BYTES = 16 * 1024;
const MAX_WS_PAYLOAD = 8 * 1024;
const MAX_NAME_CHARS = 40;
const MAX_PASSWORD_CHARS = 128;
const MAX_ROOMS_DEFAULT = 200;
const ROOM_LIST_LIMIT = 100;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^Bearer ([A-Za-z0-9_-]{20,128})$/;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const SCRYPT_PREFIX = 'scrypt';

const STATIC_FILES = new Set([
  'index.html',
  'app.js',
  'style.css',
  'pieces.js',
  'tutorial.js',
  'engine.js',
  'bot-worker.js',
  'config.js',
]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
};

const STATIC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https: wss: ws:",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const scrypt = promisify(scryptCallback);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function normalizeOrigins(value) {
  const raw = typeof value === 'string' && value.trim()
    ? value.split(',')
    : ['https://gowanginc.github.io'];
  const origins = new Set();
  for (const entry of raw) {
    const candidate = entry.trim();
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // Ignore malformed configuration entries rather than failing startup.
    }
  }
  return origins;
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function isAllowedOrigin(origin, origins) {
  if (!origin) return true; // Non-browser clients do not send Origin.
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin === 'null') return false;
  if (origins.has(parsed.origin)) return true;
  // Development convenience: loopback pages on any port may talk to a local
  // backend. Remote pages cannot forge Origin, so this does not widen exposure.
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHost(parsed.hostname);
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const stripped = value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  if ([...stripped].length > MAX_NAME_CHARS) return null;
  return stripped;
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function newToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function newRoomId() {
  return randomBytes(9).toString('base64url');
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return [
    SCRYPT_PREFIX,
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || typeof password !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let derived;
  try {
    derived = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function statusOf(room) {
  if (room.state && room.state.result) return 'finished';
  return room.seats.white && room.seats.black ? 'playing' : 'waiting';
}

function seatCount(room) {
  return COLORS.reduce((total, color) => total + (room.seats[color] ? 1 : 0), 0);
}

function publicRoomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    locked: Boolean(room.passwordHash),
    players: seatCount(room),
    status: statusOf(room),
  };
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(options = {}) {
  const dataDir = path.resolve(
    options.dataDir ?? process.env.DATA_DIR ?? path.join(process.cwd(), 'data'),
  );
  const staticDir = path.resolve(
    options.staticDir ?? path.dirname(fileURLToPath(import.meta.url)),
  );
  const allowedOrigins = normalizeOrigins(
    options.allowedOrigins ?? process.env.ALLOWED_ORIGINS,
  );
  const maxRooms = Number(options.maxRooms ?? process.env.MAX_ROOMS ?? MAX_ROOMS_DEFAULT);
  const roomCap = Number.isFinite(maxRooms) && maxRooms > 0 ? Math.floor(maxRooms) : MAX_ROOMS_DEFAULT;
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
  const clock = typeof options.now === 'function' ? options.now : Date.now;

  mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(path.join(dataDir, 'great-chess.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT,
      status TEXT NOT NULL,
      state TEXT NOT NULL,
      draw_offer TEXT,
      rematch_white INTEGER NOT NULL DEFAULT 0,
      rematch_black INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seats (
      room_id TEXT NOT NULL,
      color TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      PRIMARY KEY (room_id, color),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );
  `);

  const stmtUpsertRoom = db.prepare(`
    INSERT INTO rooms (id, name, password_hash, status, state, draw_offer,
                       rematch_white, rematch_black, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      password_hash = excluded.password_hash,
      status = excluded.status,
      state = excluded.state,
      draw_offer = excluded.draw_offer,
      rematch_white = excluded.rematch_white,
      rematch_black = excluded.rematch_black,
      updated_at = excluded.updated_at
  `);
  const stmtUpsertSeat = db.prepare(`
    INSERT INTO seats (room_id, color, name, token_hash)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id, color) DO UPDATE SET
      name = excluded.name,
      token_hash = excluded.token_hash
  `);
  const stmtDeleteSeat = db.prepare('DELETE FROM seats WHERE room_id = ? AND color = ?');
  const stmtAllRooms = db.prepare('SELECT * FROM rooms');
  const stmtAllSeats = db.prepare('SELECT room_id, color, name, token_hash FROM seats');

  /** @type {Map<string, {id:string,name:string,passwordHash:string|null,state:object,drawOffer:string|null,rematch:{white:boolean,black:boolean},seats:Record<string,{name:string,tokenHash:string}|undefined>,createdAt:number,updatedAt:number}>} */
  const rooms = new Map();

  for (const row of stmtAllRooms.all()) {
    let state;
    try {
      state = JSON.parse(row.state);
    } catch {
      state = null;
    }
    if (!state || typeof state !== 'object') state = initialState();
    rooms.set(row.id, {
      id: row.id,
      name: row.name,
      passwordHash: row.password_hash ?? null,
      state,
      drawOffer: row.draw_offer === 'white' || row.draw_offer === 'black' ? row.draw_offer : null,
      rematch: { white: Boolean(row.rematch_white), black: Boolean(row.rematch_black) },
      seats: { white: undefined, black: undefined },
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
    });
  }

  for (const row of stmtAllSeats.all()) {
    const room = rooms.get(row.room_id);
    if (!room || !COLORS.includes(row.color)) continue;
    room.seats[row.color] = { name: row.name, tokenHash: row.token_hash };
  }

  function countsTowardCapacity(room, now = clock()) {
    if (room.state.result) return false;
    return Boolean(room.seats.white && room.seats.black) ||
      now - room.updatedAt < 24 * 60 * 60 * 1000;
  }

  function atCapacity() {
    const now = clock();
    let count = 0;
    for (const room of rooms.values()) {
      if (countsTowardCapacity(room, now) && ++count >= roomCap) return true;
    }
    return false;
  }

  // Live socket registry: roomId -> {white:Set, black:Set}. Deliberately not
  // persisted; every seat starts disconnected after a restart.
  const roomSockets = new Map();

  function persistRoom(room) {
    db.exec('BEGIN IMMEDIATE');
    try {
      stmtUpsertRoom.run(
        room.id,
        room.name,
        room.passwordHash,
        statusOf(room),
        JSON.stringify(room.state),
        room.drawOffer,
        room.rematch.white ? 1 : 0,
        room.rematch.black ? 1 : 0,
        room.createdAt,
        room.updatedAt,
      );
      for (const color of COLORS) {
        const seat = room.seats[color];
        if (seat) stmtUpsertSeat.run(room.id, color, seat.name, seat.tokenHash);
        else stmtDeleteSeat.run(room.id, color);
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A failed rollback must not mask the original write error.
      }
      throw error;
    }
  }

  function socketSet(roomId, color) {
    let entry = roomSockets.get(roomId);
    if (!entry) {
      entry = { white: new Set(), black: new Set() };
      roomSockets.set(roomId, entry);
    }
    return entry[color];
  }

  function isSeatConnected(roomId, color) {
    const entry = roomSockets.get(roomId);
    return Boolean(entry && entry[color] && entry[color].size > 0);
  }

  function detailRoom(room) {
    const players = [];
    for (const color of COLORS) {
      const seat = room.seats[color];
      if (!seat) continue;
      players.push({ name: seat.name, color, connected: isSeatConnected(room.id, color) });
    }
    return {
      id: room.id,
      name: room.name,
      locked: Boolean(room.passwordHash),
      players,
      status: statusOf(room),
    };
  }

  function stateFrame(room, color) {
    return {
      type: 'state',
      room: detailRoom(room),
      state: room.state,
      you: color,
      drawOffer: room.drawOffer,
    };
  }

  function broadcast(roomId) {
    const room = rooms.get(roomId);
    const entry = roomSockets.get(roomId);
    if (!room || !entry) return;
    for (const color of COLORS) {
      const frame = JSON.stringify(stateFrame(room, color));
      for (const socket of entry[color]) {
        if (socket.readyState !== 1) continue;
        try {
          socket.send(frame);
        } catch {
          // A socket that fails mid-send is cleaned up by its own error handler.
        }
      }
    }
  }

  // --- rate limiting -------------------------------------------------------

  const buckets = new Map();

  function rateLimit(key, limit, windowMs = 60_000) {
    const now = clock();
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  }

  const bucketSweeper = setInterval(() => {
    const now = clock();
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  }, 300_000);
  bucketSweeper.unref?.();

  function clientIp(req) {
    if (trustProxy) {
      // Cloudflare overwrites CF-Connecting-IP at the edge, so it is the least
      // spoofable source; X-Forwarded-For is the fallback for other proxies.
      const cloudflare = req.headers['cf-connecting-ip'];
      if (typeof cloudflare === 'string' && cloudflare.trim()) {
        return cloudflare.trim().slice(0, 64);
      }
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.length > 0) {
        const first = forwarded.split(',')[0].trim();
        if (first) return first.slice(0, 64);
      }
    }
    return req.socket?.remoteAddress || 'unknown';
  }

  // --- HTTP plumbing -------------------------------------------------------

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin || !isAllowedOrigin(origin, allowedOrigins)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    };
  }

  function sendJson(req, res, status, payload, extra = {}) {
    if (res.writableEnded || res.headersSent) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...corsHeaders(req),
      ...extra,
    });
    res.end(body);
  }

  function fail(req, res, status, message, extra) {
    sendJson(req, res, status, { error: message }, extra);
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        resolve({ tooLarge: true });
        return;
      }
      const chunks = [];
      let size = 0;
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      req.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          settle({ tooLarge: true });
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => settle({ buffer: Buffer.concat(chunks) }));
      req.on('error', () => settle({ aborted: true }));
      req.on('close', () => settle({ aborted: true }));
    });
  }

  function parseJsonObject(buffer) {
    if (!buffer || buffer.length === 0) return {};
    let value;
    try {
      value = JSON.parse(buffer.toString('utf8'));
    } catch {
      return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  }

  function bearerToken(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = TOKEN_PATTERN.exec(header.trim());
    return match ? match[1] : null;
  }

  function seatColorForToken(room, token) {
    if (!token) return null;
    const candidate = hashToken(token);
    for (const color of COLORS) {
      const seat = room.seats[color];
      if (seat && hexEqual(candidate, seat.tokenHash)) return color;
    }
    return null;
  }

  async function requireSeat(req, res, room) {
    const token = bearerToken(req);
    if (!token) {
      fail(req, res, 401, 'missing seat token');
      return null;
    }
    const color = seatColorForToken(room, token);
    if (!color) {
      fail(req, res, 401, 'invalid seat token');
      return null;
    }
    return { token, color };
  }

  // --- static files --------------------------------------------------------

  function serveStatic(req, res, pathname) {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
      res.end();
      return;
    }
    const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!STATIC_FILES.has(requested)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end(method === 'HEAD' ? undefined : 'Not found');
      return;
    }
    let body;
    try {
      body = readFileSync(path.join(staticDir, requested));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end(method === 'HEAD' ? undefined : 'Not found');
      return;
    }
    const type = CONTENT_TYPES[path.extname(requested)] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': STATIC_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    res.end(method === 'HEAD' ? undefined : body);
  }

  // --- HTTP routing --------------------------------------------------------

  async function handleRequest(req, res) {
    const method = req.method || 'GET';
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://internal').pathname);
    } catch {
      fail(req, res, 400, 'invalid request path');
      return;
    }

    if (method === 'OPTIONS') {
      const cors = corsHeaders(req);
      res.writeHead(cors['Access-Control-Allow-Origin'] ? 204 : 403, {
        ...SECURITY_HEADERS,
        ...cors,
        'Content-Length': '0',
      });
      res.end();
      return;
    }

    const ip = clientIp(req);

    // Browser mutation requests must come from a configured origin. Reads stay
    // open (they carry no secret in ambient authority); CORS hides them instead.
    if (method !== 'GET' && req.headers.origin && !isAllowedOrigin(req.headers.origin, allowedOrigins)) {
      fail(req, res, 403, 'origin not allowed');
      return;
    }

    if (pathname === '/api/health') {
      if (method !== 'GET') {
        fail(req, res, 405, 'method not allowed', { Allow: 'GET' });
        return;
      }
      sendJson(req, res, 200, { ok: true, version: VERSION });
      return;
    }

    if (!pathname.startsWith('/api/')) {
      serveStatic(req, res, pathname);
      return;
    }

    if (!rateLimit(`api:${ip}`, 240)) {
      fail(req, res, 429, 'too many requests');
      return;
    }

    if (pathname === '/api/rooms') {
      if (method === 'GET') {
        const list = [...rooms.values()]
          .filter((room) => countsTowardCapacity(room))
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, ROOM_LIST_LIMIT)
          .map(publicRoomSummary);
        sendJson(req, res, 200, { rooms: list });
        return;
      }
      if (method === 'POST') {
        await handleCreateRoom(req, res, ip);
        return;
      }
      fail(req, res, 405, 'method not allowed', { Allow: 'GET, POST' });
      return;
    }

    const detailMatch = /^\/api\/rooms\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
    if (detailMatch) {
      if (method !== 'GET') {
        fail(req, res, 405, 'method not allowed', { Allow: 'GET' });
        return;
      }
      await handleGetRoom(req, res, detailMatch[1]);
      return;
    }

    const actionMatch = /^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/(join|action)$/.exec(pathname);
    if (actionMatch) {
      const [, roomId, verb] = actionMatch;
      if (method !== 'POST') {
        fail(req, res, 405, 'method not allowed', { Allow: 'POST' });
        return;
      }
      if (verb === 'join') {
        await handleJoin(req, res, ip, roomId);
      } else {
        await handleAction(req, res, roomId);
      }
      return;
    }

    fail(req, res, 404, 'not found');
  }

  async function handleCreateRoom(req, res, ip) {
    if (!rateLimit(`create:${ip}`, 12)) {
      fail(req, res, 429, 'too many rooms created');
      return;
    }
    const parsed = await readBody(req);
    if (parsed.tooLarge) {
      fail(req, res, 413, 'request body too large', { Connection: 'close' });
      req.destroy();
      return;
    }
    if (!parsed.buffer) {
      fail(req, res, 400, 'invalid request body');
      return;
    }
    const body = parseJsonObject(parsed.buffer);
    if (!body) {
      fail(req, res, 400, 'invalid JSON body');
      return;
    }
    const name = cleanName(body.name);
    const playerName = cleanName(body.playerName);
    if (!name) {
      fail(req, res, 400, 'room name must be 1-40 characters');
      return;
    }
    if (!playerName) {
      fail(req, res, 400, 'player name must be 1-40 characters');
      return;
    }
    let color = 'white';
    if (body.color !== undefined) {
      if (body.color !== 'white' && body.color !== 'black') {
        fail(req, res, 400, 'color must be white or black');
        return;
      }
      color = body.color;
    }
    let password = null;
    if (body.password !== undefined && body.password !== null) {
      if (typeof body.password !== 'string') {
        fail(req, res, 400, 'password must be a string');
        return;
      }
      if (body.password.length > MAX_PASSWORD_CHARS) {
        fail(req, res, 400, `password must be at most ${MAX_PASSWORD_CHARS} characters`);
        return;
      }
      if (body.password.length > 0) password = body.password;
    }
    if (atCapacity()) {
      fail(req, res, 503, 'server is at capacity');
      return;
    }

    const passwordHash = password ? await hashPassword(password) : null;
    // Re-check after the async hash: concurrent creates could otherwise
    // overshoot the cap while awaiting scrypt.
    if (atCapacity()) {
      fail(req, res, 503, 'server is at capacity');
      return;
    }

    let roomId = newRoomId();
    while (rooms.has(roomId)) roomId = newRoomId();

    const token = newToken();
    const timestamp = clock();
    const room = {
      id: roomId,
      name,
      passwordHash,
      state: initialState(),
      drawOffer: null,
      rematch: { white: false, black: false },
      seats: { white: undefined, black: undefined },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    room.seats[color] = { name: playerName, tokenHash: hashToken(token) };
    rooms.set(room.id, room);
    persistRoom(room);

    sendJson(req, res, 201, { roomId: room.id, token, color });
    broadcast(room.id);
  }

  async function handleJoin(req, res, ip, roomId) {
    if (!rateLimit(`join:${ip}`, 60)) {
      fail(req, res, 429, 'too many join attempts');
      return;
    }
    const room = rooms.get(roomId);
    if (!room) {
      fail(req, res, 404, 'room not found');
      return;
    }
    const parsed = await readBody(req);
    if (parsed.tooLarge) {
      fail(req, res, 413, 'request body too large', { Connection: 'close' });
      req.destroy();
      return;
    }
    if (!parsed.buffer) {
      fail(req, res, 400, 'invalid request body');
      return;
    }
    const body = parseJsonObject(parsed.buffer);
    if (!body) {
      fail(req, res, 400, 'invalid JSON body');
      return;
    }
    const playerName = cleanName(body.playerName);
    if (!playerName) {
      fail(req, res, 400, 'player name must be 1-40 characters');
      return;
    }

    // A resume token is proof of an existing seat; it re-authenticates the same
    // seat without renting a new one and without re-supplying the password.
    if (body.resumeToken !== undefined) {
      if (typeof body.resumeToken !== 'string' || body.resumeToken.length > 128) {
        fail(req, res, 400, 'invalid resume token');
        return;
      }
      const color = seatColorForToken(room, body.resumeToken);
      if (!color) {
        fail(req, res, 403, 'invalid resume token');
        return;
      }
      sendJson(req, res, 200, { roomId: room.id, token: body.resumeToken, color });
      broadcast(room.id);
      return;
    }

    if (room.passwordHash) {
      if (!rateLimit(`pw:${ip}:${roomId}`, 10)) {
        fail(req, res, 429, 'too many password attempts');
        return;
      }
      if (typeof body.password !== 'string') {
        fail(req, res, 403, 'password required');
        return;
      }
      if (body.password.length > MAX_PASSWORD_CHARS) {
        fail(req, res, 400, 'password too long');
        return;
      }
      const ok = await verifyPassword(body.password, room.passwordHash);
      if (!ok) {
        fail(req, res, 403, 'wrong password');
        return;
      }
    }

    const color = COLORS.find((candidate) => !room.seats[candidate]);
    if (!color) {
      fail(req, res, 409, 'room is full');
      return;
    }
    if (!countsTowardCapacity(room) && atCapacity()) {
      fail(req, res, 503, 'server is at capacity');
      return;
    }

    const token = newToken();
    room.seats[color] = { name: playerName, tokenHash: hashToken(token) };
    room.updatedAt = clock();
    persistRoom(room);

    sendJson(req, res, 200, { roomId: room.id, token, color });
    broadcast(room.id);
  }

  async function handleGetRoom(req, res, roomId) {
    const room = rooms.get(roomId);
    if (!room) {
      fail(req, res, 404, 'room not found');
      return;
    }
    const seat = await requireSeat(req, res, room);
    if (!seat) return;
    sendJson(req, res, 200, {
      room: detailRoom(room),
      state: room.state,
      you: seat.color,
      drawOffer: room.drawOffer,
    });
  }

  async function handleAction(req, res, roomId) {
    const room = rooms.get(roomId);
    if (!room) {
      fail(req, res, 404, 'room not found');
      return;
    }
    const seat = await requireSeat(req, res, room);
    if (!seat) return;
    const { color } = seat;

    const parsed = await readBody(req);
    if (parsed.tooLarge) {
      fail(req, res, 413, 'request body too large', { Connection: 'close' });
      req.destroy();
      return;
    }
    if (!parsed.buffer) {
      fail(req, res, 400, 'invalid request body');
      return;
    }
    const body = parseJsonObject(parsed.buffer);
    if (!body) {
      fail(req, res, 400, 'invalid JSON body');
      return;
    }
    if (typeof body.type !== 'string' || !ACTIONS.has(body.type)) {
      fail(req, res, 400, 'unknown action type');
      return;
    }

    if (body.type !== 'rematch' && (!room.seats.white || !room.seats.black)) {
      fail(req, res, 409, 'waiting for an opponent');
      return;
    }
    if (body.type !== 'rematch' && room.state.result) {
      fail(req, res, 409, 'game is already finished');
      return;
    }

    switch (body.type) {
      case 'move': {
        if (room.state.turn !== color) {
          fail(req, res, 409, 'not your turn');
          return;
        }
        if (!Number.isInteger(body.expectedPly) || body.expectedPly !== room.state.ply) {
          fail(req, res, 409, 'stale board state');
          return;
        }
        const move = body.move;
        if (
          !move ||
          typeof move !== 'object' ||
          Array.isArray(move) ||
          typeof move.from !== 'string' ||
          typeof move.to !== 'string' ||
          move.from.length > 8 ||
          move.to.length > 8 ||
          (move.kind !== undefined && (typeof move.kind !== 'string' || !KINDS.has(move.kind)))
        ) {
          fail(req, res, 400, 'invalid move payload');
          return;
        }
        let next;
        try {
          // The shared engine is the sole authority on legality. Extra fields
          // beyond the from/to/kind identity (engine-specific choice payloads)
          // are forwarded untouched; the engine rejects anything it cannot use.
          next = applyMove(room.state, move);
        } catch {
          fail(req, res, 400, 'illegal move');
          return;
        }
        if (!next || typeof next !== 'object') {
          fail(req, res, 400, 'illegal move');
          return;
        }
        room.state = next;
        // A move lapses any standing draw offer; only acceptance settles it.
        room.drawOffer = null;
        room.updatedAt = clock();
        persistRoom(room);
        break;
      }
      case 'resign': {
        room.state = {
          ...room.state,
          result: { winner: color === 'white' ? 'black' : 'white', reason: 'resignation' },
        };
        room.drawOffer = null;
        room.updatedAt = clock();
        persistRoom(room);
        break;
      }
      case 'offer-draw': {
        if (room.drawOffer === color) {
          fail(req, res, 409, 'draw already offered');
          return;
        }
        room.drawOffer = color;
        room.updatedAt = clock();
        persistRoom(room);
        break;
      }
      case 'accept-draw': {
        if (!room.drawOffer || room.drawOffer === color) {
          fail(req, res, 409, 'no draw offer to accept');
          return;
        }
        room.state = {
          ...room.state,
          result: { winner: null, reason: 'draw-agreement' },
        };
        room.drawOffer = null;
        room.updatedAt = clock();
        persistRoom(room);
        break;
      }
      case 'rematch': {
        if (!room.state.result) {
          fail(req, res, 409, 'game is not finished');
          return;
        }
        if (!room.seats.white || !room.seats.black) {
          fail(req, res, 409, 'waiting for an opponent');
          return;
        }
        if (room.rematch[color === 'white' ? 'black' : 'white'] && atCapacity()) {
          fail(req, res, 503, 'server is at capacity');
          return;
        }
        room.rematch[color] = true;
        if (room.rematch.white && room.rematch.black) {
          room.state = initialState();
          room.drawOffer = null;
          room.rematch = { white: false, black: false };
        }
        room.updatedAt = clock();
        persistRoom(room);
        break;
      }
      default:
        fail(req, res, 400, 'unknown action type');
        return;
    }

    sendJson(req, res, 200, { ok: true });
    broadcast(room.id);
  }

  // --- HTTP + WebSocket server --------------------------------------------

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      fail(req, res, 500, 'internal server error');
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

  function rejectUpgrade(socket, status, message) {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const body = message || '';
    socket.write(
      `HTTP/1.1 ${status}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        '\r\n' +
        body,
    );
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://internal').pathname;
    } catch {
      rejectUpgrade(socket, '400 Bad Request', 'Bad request');
      return;
    }
    if (pathname !== '/ws') {
      rejectUpgrade(socket, '404 Not Found', 'Not found');
      return;
    }
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin, allowedOrigins)) {
      rejectUpgrade(socket, '403 Forbidden', 'Origin not allowed');
      return;
    }
    if (!rateLimit(`ws:${clientIp(req)}`, 60)) {
      rejectUpgrade(socket, '429 Too Many Requests', 'Too many connections');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  function unbindSocket(ws) {
    const binding = ws.greatChessBinding;
    if (!binding || !binding.roomId) return;
    const entry = roomSockets.get(binding.roomId);
    const roomId = binding.roomId;
    ws.greatChessBinding = { roomId: null, color: null };
    if (entry && binding.color) {
      entry[binding.color].delete(ws);
      if (rooms.get(roomId)) broadcast(roomId);
    }
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.greatChessBinding = { roomId: null, color: null };
    const ip = clientIp(req);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.send(JSON.stringify({ type: 'error', message: 'binary frames are not supported' }));
        return;
      }
      const text = data.toString('utf8');
      if (Buffer.byteLength(text) > MAX_WS_PAYLOAD) {
        ws.send(JSON.stringify({ type: 'error', message: 'frame too large' }));
        return;
      }
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON frame' }));
        return;
      }
      if (!message || typeof message !== 'object' || message.type !== 'subscribe') {
        ws.send(JSON.stringify({ type: 'error', message: 'expected subscribe frame' }));
        return;
      }
      if (!rateLimit(`wssub:${ip}`, 60)) {
        ws.send(JSON.stringify({ type: 'error', message: 'too many subscribe attempts' }));
        return;
      }
      if (
        typeof message.roomId !== 'string' ||
        message.roomId.length > 64 ||
        typeof message.token !== 'string' ||
        message.token.length > 128
      ) {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid subscribe frame' }));
        return;
      }
      const room = rooms.get(message.roomId);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'room not found' }));
        return;
      }
      const color = seatColorForToken(room, message.token);
      if (!color) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }

      if (
        ws.greatChessBinding.roomId &&
        (ws.greatChessBinding.roomId !== room.id || ws.greatChessBinding.color !== color)
      ) {
        unbindSocket(ws);
      }
      ws.greatChessBinding = { roomId: room.id, color };
      socketSet(room.id, color).add(ws);
      // broadcast() includes this socket, so the subscriber gets exactly one
      // authoritative state frame and everybody else sees the new connection.
      broadcast(room.id);
    });

    ws.on('close', () => {
      unbindSocket(ws);
    });

    ws.on('error', () => {
      unbindSocket(ws);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  function listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        const actualPort = address && typeof address === 'object' ? address.port : port;
        const actualHost = address && typeof address === 'object' ? address.address : host;
        resolve({
          port: actualPort,
          host: actualHost,
          url: `http://127.0.0.1:${actualPort}`,
        });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  let closing = null;
  function close() {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(heartbeat);
      clearInterval(bucketSweeper);
      for (const ws of wss.clients) {
        try {
          ws.terminate();
        } catch {
          // Socket already gone.
        }
      }
      await new Promise((resolve) => {
        try {
          wss.close(() => resolve());
        } catch {
          resolve();
        }
      });
      await new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      try {
        db.close();
      } catch {
        // Closing an already-closed handle is harmless during shutdown.
      }
    })();
    return closing;
  }

  function address() {
    return server.address();
  }

  return { server, db, listen, close, address };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entrypoint && import.meta.url === entrypoint) {
  const port = Number(process.env.PORT || 9277);
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp();
  app
    .listen(port, host)
    .then(({ port: actualPort, host: actualHost }) => {
      console.log(`great-chess server listening on ${actualHost}:${actualPort}`);
    })
    .catch((error) => {
      console.error('great-chess server failed to start:', error.message);
      process.exit(1);
    });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
