// Login gate: turns a bearer token into a Foundry session for ONE user (the Claude GM), so an automated
// browser can log in without ever seeing that user's password.
//
// Runs on the Foundry server, next to Foundry, listening on localhost only. The reverse proxy (Caddy) sends
// /claude-login here and everything else to Foundry. See README.md in this folder for setup.
//
// GET /claude-login with "Authorization: Bearer <token>":
//   1. GET  {FOUNDRY}/join            -> Foundry hands out a fresh session cookie
//   2. POST {FOUNDRY}/join (JSON)     -> that session is logged in as the configured user
//   3. 302 to /game with that session cookie, so the caller is now logged in.
// Anything else gets 403 (no detail). Too many bad tokens lock the gate for a while.
//
// No dependencies; Node 20+. Config is read from a JSON file (default ./secrets.json, chmod 600):
//   { "tokenSha256": "<hex sha256 of the token>", "userId": "<Foundry user id>", "password": "<that user's password>" }
// The token itself is not stored here, only its hash.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.GATE_PORT || 30001);
const FOUNDRY = (process.env.FOUNDRY_INTERNAL_URL || 'http://127.0.0.1:30000').replace(/\/$/, '');
const SECRETS_FILE = process.env.GATE_SECRETS || new URL('./secrets.json', import.meta.url).pathname;

const MAX_FAILURES = 5;                // bad tokens allowed per window...
const WINDOW_MS = 15 * 60 * 1000;      // ...in this window, then the gate refuses everyone until it passes

const sha256 = (s) => createHash('sha256').update(s).digest();
let failures = [];
let lockedUntil = 0;

function loadSecrets() {
  // Re-read each time so a rotated token or password takes effect without a restart.
  const s = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
  if (!/^[0-9a-f]{64}$/i.test(s.tokenSha256 || '') || !s.userId || !s.password) {
    throw new Error(`${SECRETS_FILE} needs tokenSha256 (64 hex chars), userId and password`);
  }
  return s;
}

function tokenMatches(header, tokenSha256) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  if (!m) return false;
  return timingSafeEqual(sha256(m[1]), Buffer.from(tokenSha256, 'hex'));
}

function log(req, msg) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`${new Date().toISOString()} ${ip} ${msg}`);
}

function deny(res, code = 403, text = 'Forbidden') {
  res.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end(text);
}

function sessionCookieFrom(res) {
  const all = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  return all.find((c) => /^session=/.test(c));
}

async function login(secrets) {
  const first = await fetch(`${FOUNDRY}/join`, { redirect: 'manual' });
  const setCookie = sessionCookieFrom(first);
  if (!setCookie) {
    // No world running (Foundry is on the setup screen) or Foundry is down.
    throw Object.assign(new Error(`no session cookie from /join (HTTP ${first.status}); is a world launched?`), { code: 503 });
  }
  const cookie = setCookie.split(';')[0];
  const post = await fetch(`${FOUNDRY}/join`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
    body: JSON.stringify({ action: 'join', userid: secrets.userId, password: secrets.password }),
  });
  let body = {};
  try { body = await post.json(); } catch { /* non-JSON error page */ }
  if (!post.ok || body.status === 'failed' || body.error) {
    throw Object.assign(new Error(`Foundry refused the login (HTTP ${post.status}): ${body.error || body.message || ''}`), { code: 502 });
  }
  return { setCookie, redirect: body.redirect || '/game' };
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path !== '/claude-login' || req.method !== 'GET') return deny(res, 404, 'Not found');

  const now = Date.now();
  if (now < lockedUntil) { log(req, 'refused: locked'); return deny(res, 429, 'Locked'); }

  let secrets;
  try { secrets = loadSecrets(); }
  catch (e) { log(req, `config error: ${e.message}`); return deny(res, 500, 'Gate misconfigured'); }

  if (!tokenMatches(req.headers.authorization, secrets.tokenSha256)) {
    failures = failures.filter((t) => now - t < WINDOW_MS).concat(now);
    if (failures.length >= MAX_FAILURES) { lockedUntil = now + WINDOW_MS; failures = []; log(req, 'bad token; LOCKING'); }
    else log(req, 'bad token');
    return deny(res);
  }

  try {
    const { setCookie, redirect } = await login(secrets);
    log(req, 'login ok');
    // Same Path/SameSite/expiry Foundry chose; Secure added because the public side is HTTPS.
    res.writeHead(302, {
      'Set-Cookie': /;\s*secure/i.test(setCookie) ? setCookie : `${setCookie}; Secure`,
      Location: redirect,
      'Cache-Control': 'no-store',
    });
    res.end();
  } catch (e) {
    log(req, `login failed: ${e.message}`);
    deny(res, e.code || 502, 'Login failed; see gate log');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`claude-login gate on 127.0.0.1:${PORT} -> ${FOUNDRY}`));
