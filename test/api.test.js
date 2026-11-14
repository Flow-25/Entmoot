'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entmoot-'));
process.env.DATA_FILE = path.join(dir, 'data.json');
const { server, data, purgeExpired } = require('../server');

let base;
test.before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, { body, token, admin } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['X-Admin-Token'] = admin;
  const res = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function newMoot(extra = {}) {
  const res = await call('POST', '/api/moots', {
    body: { question: 'Where to?', options: ['Isengard', 'Fangorn', 'Rohan'], method: 'approval', ...extra },
  });
  assert.equal(res.status, 201);
  return res.body;
}

const join = async (id, name, password) =>
  (await call('POST', `/api/moots/${id}/join`, { body: { name, password } })).body.token;

test('create validates input', async () => {
  assert.equal((await call('POST', '/api/moots', { body: { question: '', options: ['a', 'b'], method: 'approval' } })).status, 400);
  assert.equal((await call('POST', '/api/moots', { body: { question: 'q', options: ['a', 'A '], method: 'approval' } })).status, 400);
  assert.equal((await call('POST', '/api/moots', { body: { question: 'q', options: ['a', 'b'], method: 'dice' } })).status, 400);
  assert.equal((await call('GET', '/api/moots/nope')).status, 404);
  assert.equal((await call('GET', '/api/moots/__proto__')).status, 404);
});

test('results stay hidden until you have voted', async () => {
  const { id } = await newMoot();
  const treebeard = await join(id, 'Treebeard');
  const quickbeam = await join(id, 'Quickbeam');

  let info = (await call('GET', `/api/moots/${id}`, { token: treebeard })).body;
  assert.equal(info.results, null);
  assert.equal(info.you.name, 'Treebeard');
  const [isengard, fangorn] = info.options.map(o => o.id);

  info = (await call('PUT', `/api/moots/${id}/ballot`, { token: treebeard, body: { ballot: { approved: [isengard, fangorn] } } })).body;
  assert.equal(info.results.count, 1);
  assert.equal(info.results.ballots[0].name, 'Treebeard');

  info = (await call('GET', `/api/moots/${id}`, { token: quickbeam })).body;
  assert.equal(info.results, null);
  assert.deepEqual(info.voters, [{ name: 'Treebeard', voted: true }, { name: 'Quickbeam', voted: false }]);
  assert.equal((await call('GET', `/api/moots/${id}`)).body.results, null);

  await call('PUT', `/api/moots/${id}/ballot`, { token: quickbeam, body: { ballot: { approved: [isengard] } } });
  info = (await call('GET', `/api/moots/${id}`, { token: quickbeam })).body;
  assert.deepEqual(info.results.ranking[0], { option: isengard, score: 2, rank: 1 });
});

test('ballots are validated', async () => {
  const { id } = await newMoot({ method: 'score' });
  const token = await join(id, 'Pippin');
  const [a] = (await call('GET', `/api/moots/${id}`)).body.options.map(o => o.id);
  const put = ballot => call('PUT', `/api/moots/${id}/ballot`, { token, body: { ballot } });
  assert.equal((await put({ scores: { [a]: 6 } })).status, 400);
  assert.equal((await put({ scores: { ghost: 1 } })).status, 400);
  assert.equal((await put({ approved: [a] })).status, 400);
  assert.equal((await put({ scores: { [a]: 5 } })).status, 200);
  assert.equal((await call('PUT', `/api/moots/${id}/ballot`, { body: { ballot: { scores: {} } } })).status, 401);
});

test('rejoining restores the ballot; passwords protect names', async () => {
  const { id } = await newMoot();
  const merry = await join(id, 'Merry', 'pipeweed');
  assert.equal((await call('POST', `/api/moots/${id}/join`, { body: { name: 'merry' } })).status, 403);
  assert.equal((await call('POST', `/api/moots/${id}/join`, { body: { name: 'merry', password: 'wrong' } })).status, 403);
  assert.equal(await join(id, ' MERRY ', 'pipeweed'), merry);
  const open = await join(id, 'Pippin');
  assert.equal(await join(id, 'pippin'), open);
  assert.equal((await call('GET', `/api/moots/${id}`)).body.voters.length, 2);
});

test('secret moots never reveal individual ballots', async () => {
  const { id, adminToken } = await newMoot({ secret: true });
  const token = await join(id, 'Treebeard');
  const [a] = (await call('GET', `/api/moots/${id}`)).body.options.map(o => o.id);
  const info = (await call('PUT', `/api/moots/${id}/ballot`, { token, body: { ballot: { approved: [a] } } })).body;
  assert.equal(info.results.count, 1);
  assert.equal(info.results.ballots, undefined);
  const closed = (await call('POST', `/api/moots/${id}/close`, { admin: adminToken })).body;
  assert.equal(closed.results.ballots, undefined);
});

test('options: open moots let voters add, only the creator removes', async () => {
  const shut = await newMoot();
  const outsider = await join(shut.id, 'Saruman');
  assert.equal((await call('POST', `/api/moots/${shut.id}/options`, { token: outsider, body: { label: 'Orthanc' } })).status, 403);
  assert.equal((await call('POST', `/api/moots/${shut.id}/options`, { admin: shut.adminToken, body: { label: 'Orthanc' } })).status, 201);

  const { id, adminToken } = await newMoot({ openOptions: true, method: 'ranked' });
  const token = await join(id, 'Quickbeam');
  assert.equal((await call('POST', `/api/moots/${id}/options`, { body: { label: 'Lórien' } })).status, 401);
  assert.equal((await call('POST', `/api/moots/${id}/options`, { token, body: { label: 'fangorn' } })).status, 409);
  let info = (await call('POST', `/api/moots/${id}/options`, { token, body: { label: 'Lórien' } })).body;
  const added = info.options.at(-1);
  assert.deepEqual({ label: added.label, addedBy: added.addedBy }, { label: 'Lórien', addedBy: 'Quickbeam' });

  const ids = info.options.map(o => o.id);
  await call('PUT', `/api/moots/${id}/ballot`, { token, body: { ballot: { ranking: [added.id, ids[0]] } } });
  assert.equal((await call('DELETE', `/api/moots/${id}/options/${added.id}`, { token })).status, 403);
  info = (await call('DELETE', `/api/moots/${id}/options/${added.id}`, { token, admin: adminToken })).body;
  assert.equal(info.options.length, 3);
  assert.deepEqual(info.you.ballot, { ranking: [ids[0]] });
  assert.equal(info.results.ranking[0].option, ids[0]);
  assert.ok(info.results.pairwise[ids[0]]);
});

test('closing freezes ballots and reveals results to everyone', async () => {
  const { id, adminToken } = await newMoot();
  const token = await join(id, 'Treebeard');
  const [a, b] = (await call('GET', `/api/moots/${id}`)).body.options.map(o => o.id);
  await call('PUT', `/api/moots/${id}/ballot`, { token, body: { ballot: { approved: [a] } } });

  assert.equal((await call('POST', `/api/moots/${id}/close`, { admin: 'wrong' })).status, 403);
  assert.equal((await call('POST', `/api/moots/${id}/close`)).status, 403);
  assert.equal((await call('POST', `/api/moots/${id}/close`, { admin: adminToken })).body.closed, true);

  assert.equal((await call('PUT', `/api/moots/${id}/ballot`, { token, body: { ballot: { approved: [b] } } })).status, 409);
  assert.equal((await call('POST', `/api/moots/${id}/join`, { body: { name: 'Latecomer' } })).status, 409);
  assert.equal(await join(id, 'Treebeard'), token);
  const info = (await call('GET', `/api/moots/${id}`)).body;
  assert.equal(info.isAdmin, false);
  assert.deepEqual(info.results.ranking[0], { option: a, score: 1, rank: 1 });
  assert.equal(JSON.stringify(info).includes(adminToken), false);
  assert.equal(JSON.stringify(info).includes(token), false);
});

test('expired moots are purged', async () => {
  const closed = await newMoot();
  const idle = await newMoot();
  const fresh = await newMoot();
  await call('POST', `/api/moots/${closed.id}/close`, { admin: closed.adminToken });
  const day = 24 * 60 * 60 * 1000;
  assert.equal(purgeExpired(), 0);
  assert.ok(purgeExpired(Date.now() + 31 * day) >= 1); // also sweeps moots closed by other tests
  assert.equal(closed.id in data.moots, false);
  assert.equal(idle.id in data.moots, true);
  data.moots[idle.id].updatedAt -= 200 * day;
  assert.equal(purgeExpired(), 1);
  assert.equal(idle.id in data.moots, false);
  assert.equal(fresh.id in data.moots, true);
});
