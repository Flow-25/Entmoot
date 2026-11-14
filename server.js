'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tally = require('./lib/tally');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const MAX_BODY = 256 * 1024;
// Optional sub-path the app is published under, e.g. BASE_PATH=/entmoot for example.org/entmoot.
// Requests must then start with it; everything else gets a 404.
const BASE_PATH = normalizeBase(process.env.BASE_PATH);

function normalizeBase(value) {
  const base = `/${value || ''}`.replace(/\/+/g, '/').replace(/\/$/, '');
  if (!/^(\/[\w.~-]+)*$/.test(base)) throw new Error(`Invalid BASE_PATH: ${value}`);
  return base;
}

const METHODS = ['approval', 'ranked', 'score'];
const SCORE_MAX = 5;
const MAX_OPTIONS = 50;
const MAX_VOTERS = 500;
const DAY = 24 * 60 * 60 * 1000;
const KEEP_CLOSED = 30 * DAY; // closed moots are deleted this long after closing
const KEEP_IDLE = 180 * DAY; // open moots are deleted after this long without activity

// data.moots[id] = {
//   id, adminToken, question, method: 'approval'|'ranked'|'score',
//   openOptions: bool, secret: bool, closed: bool, createdAt, updatedAt, closedAt,
//   options: [{ id, label, addedBy }],
//   voters: [{ name, token, passwordHash, ballot }]
// }
let data = { moots: {} };
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  /* first run, start empty */
}

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const newId = (n = 10) => crypto.randomBytes(n).toString('base64url').slice(0, n);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const INDEX = path.join(PUBLIC, 'index.html');
// index.html is a template: {{BASE}} becomes the sub-path the app is served under.
const renderIndex = () => fs.readFileSync(INDEX, 'utf8').replaceAll('{{BASE}}', BASE_PATH);

function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = '/';
  }
  // SPA: anything that isn't a file falls back to index.html
  const file = path.join(PUBLIC, path.normalize(rel));
  if (file === INDEX || !file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    return res.end(renderIndex());
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---- helpers ---------------------------------------------------------------

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const sameText = (a, b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}

function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(pw, salt, 32).toString('hex');
  return safeEqual(hash, candidate);
}

function getMoot(id) {
  if (!Object.hasOwn(data.moots, id)) fail(404, 'This moot does not exist (or has long since ended).');
  return data.moots[id];
}

const isAdmin = (req, moot) => safeEqual(req.headers['x-admin-token'], moot.adminToken);

function getVoter(req, moot) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  return (token && moot.voters.find(v => safeEqual(v.token, token))) || null;
}

function requireOpen(moot) {
  if (moot.closed) fail(409, 'This moot is closed.');
}

function touch(moot) {
  moot.updatedAt = Date.now();
  save();
}

// Validates a ballot against the moot and returns a clean copy.
function cleanBallot(moot, ballot) {
  const ids = new Set(moot.options.map(o => o.id));
  const idList = v => {
    if (!Array.isArray(v) || v.some(x => !ids.has(x)) || new Set(v).size !== v.length) {
      fail(400, 'That ballot does not match the options of this moot.');
    }
    return [...v];
  };
  if (!ballot || typeof ballot !== 'object') fail(400, 'A ballot is required.');
  if (moot.method === 'approval') return { approved: idList(ballot.approved) };
  if (moot.method === 'ranked') return { ranking: idList(ballot.ranking) };
  const scores = {};
  const given = ballot.scores && typeof ballot.scores === 'object' ? ballot.scores : fail(400, 'A ballot is required.');
  for (const [id, v] of Object.entries(given)) {
    if (!ids.has(id) || !Number.isInteger(v) || v < 0 || v > SCORE_MAX) {
      fail(400, 'That ballot does not match the options of this moot.');
    }
    scores[id] = v;
  }
  return { scores };
}

function computeResults(moot) {
  const ids = moot.options.map(o => o.id);
  const cast = moot.voters.filter(v => v.ballot);
  const ballots = cast.map(v => v.ballot);
  const results = { count: ballots.length };
  if (moot.method === 'ranked') {
    const { results: ranking, pairwise } = tally.schulze(ids, ballots);
    Object.assign(results, { ranking, pairwise });
  } else {
    results.ranking = tally[moot.method](ids, ballots);
  }
  if (!moot.secret) results.ballots = cast.map(v => ({ name: v.name, ballot: v.ballot }));
  return results;
}

// What a given visitor is allowed to see of a moot.
function view(moot, voter, admin) {
  const showResults = moot.closed || Boolean(voter && voter.ballot);
  return {
    id: moot.id,
    question: moot.question,
    method: moot.method,
    scoreMax: SCORE_MAX,
    openOptions: moot.openOptions,
    secret: moot.secret,
    closed: moot.closed,
    createdAt: moot.createdAt,
    closedAt: moot.closedAt || null,
    options: moot.options.map(({ id, label, addedBy }) => ({ id, label, addedBy })),
    voters: moot.voters.map(v => ({ name: v.name, voted: Boolean(v.ballot) })),
    you: voter ? { name: voter.name, ballot: voter.ballot } : null,
    isAdmin: admin,
    results: showResults ? computeResults(moot) : null,
  };
}

// ---- API -------------------------------------------------------------------

async function createMoot(req, res) {
  const body = await readBody(req);
  const question = text(body.question, 200);
  if (!question) fail(400, 'A moot needs a question.');
  if (!METHODS.includes(body.method)) fail(400, 'Unknown voting method.');
  const labels = [];
  for (const raw of Array.isArray(body.options) ? body.options : []) {
    const label = text(raw, 100);
    if (label && !labels.some(l => sameText(l, label))) labels.push(label);
  }
  if (labels.length < 2) fail(400, 'A moot needs at least two different options.');
  if (labels.length > MAX_OPTIONS) fail(400, `A moot can have at most ${MAX_OPTIONS} options.`);

  let id;
  do id = newId(10);
  while (Object.hasOwn(data.moots, id));
  const now = Date.now();
  const moot = {
    id,
    adminToken: newId(24),
    question,
    method: body.method,
    openOptions: Boolean(body.openOptions),
    secret: Boolean(body.secret),
    closed: false,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    options: labels.map(label => ({ id: newId(6), label, addedBy: null })),
    voters: [],
  };
  data.moots[id] = moot;
  save();
  sendJson(res, 201, { id, adminToken: moot.adminToken });
}

function getMootInfo(req, res, id) {
  const moot = getMoot(id);
  sendJson(res, 200, view(moot, getVoter(req, moot), isAdmin(req, moot)));
}

async function joinMoot(req, res, id) {
  const moot = getMoot(id);
  const body = await readBody(req);
  const name = text(body.name, 40);
  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
  if (!name) fail(400, 'Please give a name.');

  let voter = moot.voters.find(v => sameText(v.name, name));
  if (voter) {
    if (voter.passwordHash && !checkPassword(password, voter.passwordHash)) {
      fail(403, password ? 'Wrong password for that name.' : 'That name is protected by a password.');
    }
  } else {
    requireOpen(moot);
    if (moot.voters.length >= MAX_VOTERS) fail(409, 'This moot is full.');
    voter = { name, token: newId(24), passwordHash: password ? hashPassword(password) : null, ballot: null };
    moot.voters.push(voter);
    touch(moot);
  }
  sendJson(res, 200, { token: voter.token, name: voter.name });
}

async function castBallot(req, res, id) {
  const moot = getMoot(id);
  const voter = getVoter(req, moot);
  if (!voter) fail(401, 'Join the moot before voting.');
  requireOpen(moot);
  const body = await readBody(req);
  voter.ballot = cleanBallot(moot, body.ballot);
  touch(moot);
  sendJson(res, 200, view(moot, voter, isAdmin(req, moot)));
}

async function addOption(req, res, id) {
  const moot = getMoot(id);
  const voter = getVoter(req, moot);
  const admin = isAdmin(req, moot);
  requireOpen(moot);
  if (!admin && !moot.openOptions) fail(403, 'Only the creator can add options to this moot.');
  if (!admin && !voter) fail(401, 'Join the moot before adding options.');
  const body = await readBody(req);
  const label = text(body.label, 100);
  if (!label) fail(400, 'The option is empty.');
  if (moot.options.some(o => sameText(o.label, label))) fail(409, 'That option already exists.');
  if (moot.options.length >= MAX_OPTIONS) fail(409, `A moot can have at most ${MAX_OPTIONS} options.`);
  let optionId;
  do optionId = newId(6);
  while (moot.options.some(o => o.id === optionId));
  moot.options.push({ id: optionId, label, addedBy: voter ? voter.name : null });
  touch(moot);
  sendJson(res, 201, view(moot, voter, admin));
}

function removeOption(req, res, id, optionId) {
  const moot = getMoot(id);
  if (!isAdmin(req, moot)) fail(403, 'Only the creator can remove options.');
  requireOpen(moot);
  if (!moot.options.some(o => o.id === optionId)) fail(404, 'That option does not exist.');
  if (moot.options.length <= 2) fail(409, 'A moot needs at least two options.');
  moot.options = moot.options.filter(o => o.id !== optionId);
  // Ballots simply lose the removed option; the rest of each ballot stands.
  for (const { ballot } of moot.voters) {
    if (!ballot) continue;
    if (ballot.approved) ballot.approved = ballot.approved.filter(o => o !== optionId);
    if (ballot.ranking) ballot.ranking = ballot.ranking.filter(o => o !== optionId);
    if (ballot.scores) delete ballot.scores[optionId];
  }
  touch(moot);
  sendJson(res, 200, view(moot, getVoter(req, moot), true));
}

function closeMoot(req, res, id) {
  const moot = getMoot(id);
  if (!isAdmin(req, moot)) fail(403, 'Only the creator can close this moot.');
  if (!moot.closed) {
    moot.closed = true;
    moot.closedAt = Date.now();
    touch(moot);
  }
  sendJson(res, 200, view(moot, getVoter(req, moot), true));
}

const routes = [
  ['POST', /^\/api\/moots$/, createMoot],
  ['GET', /^\/api\/moots\/([\w-]+)$/, getMootInfo],
  ['POST', /^\/api\/moots\/([\w-]+)\/join$/, joinMoot],
  ['PUT', /^\/api\/moots\/([\w-]+)\/ballot$/, castBallot],
  ['POST', /^\/api\/moots\/([\w-]+)\/options$/, addOption],
  ['DELETE', /^\/api\/moots\/([\w-]+)\/options\/([\w-]+)$/, removeOption],
  ['POST', /^\/api\/moots\/([\w-]+)\/close$/, closeMoot],
];

async function handleApi(req, res, pathname) {
  for (const [method, re, handler] of routes) {
    const m = pathname.match(re);
    if (m && req.method === method) return handler(req, res, ...m.slice(1));
  }
  sendJson(res, 404, { error: 'not found' });
}

// ---- expiry ----------------------------------------------------------------

function purgeExpired(now = Date.now()) {
  let removed = 0;
  for (const [id, moot] of Object.entries(data.moots)) {
    const expired = moot.closed
      ? now - (moot.closedAt || moot.updatedAt || moot.createdAt) > KEEP_CLOSED
      : now - (moot.updatedAt || moot.createdAt) > KEEP_IDLE;
    if (expired) {
      delete data.moots[id];
      removed++;
    }
  }
  if (removed) save();
  return removed;
}

const server = http.createServer(async (req, res) => {
  let { pathname } = new URL(req.url, 'http://x');
  try {
    if (BASE_PATH) {
      if (pathname !== BASE_PATH && !pathname.startsWith(BASE_PATH + '/')) return sendJson(res, 404, { error: 'not found' });
      pathname = pathname.slice(BASE_PATH.length) || '/';
    }
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else serveStatic(res, pathname);
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
    if (!err.status) console.error(err);
  }
});

if (require.main === module) {
  purgeExpired();
  setInterval(purgeExpired, 60 * 60 * 1000).unref();
  server.listen(PORT, () => console.log(`Entmoot listening on http://localhost:${server.address().port}${BASE_PATH}`));
}

module.exports = { server, readBody, save, newId, data, purgeExpired };
