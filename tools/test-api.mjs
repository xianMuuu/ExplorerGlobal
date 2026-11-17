// 接口自测：不启动服务，直接调用 api/core.mjs，数据写在系统临时目录，跑完即删。
// 用法：node tools/test-api.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApi } from '../api/core.mjs';
import { fsStore } from '../api/store-fs.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-api-test-'));
const api = createApi({ store: fsStore(dir), config: { chunkSplats: 1000, maxModelsPerUser: 2, pbkdf2Iterations: 1000 } });
const ORIGIN = 'http://localhost:9999';
let pass = 0, failCount = 0;

function check(name, ok, detail) {
  if (ok) pass++;
  else { failCount++; console.log('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

async function call(method, url, { body, cookie, origin = ORIGIN, raw } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  let payload;
  if (raw) { payload = raw; headers['content-type'] = 'application/octet-stream'; headers['content-length'] = String(raw.byteLength); }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await api.handle(new Request(ORIGIN + url, { method, headers, body: payload }), { ip: '127.0.0.1' });
  if (!res) return { status: 404, data: null, cookie: '', headers: new Headers() }; // 不是接口路径：服务会交给静态文件处理，白名单外返回 404
  const setCookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
  return { status: res.status, data, cookie: setCookie, headers: res.headers };
}

const pw1 = crypto.randomBytes(9).toString('base64url');
const pw2 = crypto.randomBytes(9).toString('base64url');
const placement = { lon: 114.1371, lat: 22.283, height: 10, heading: 0, pitch: 0, roll: 0, scale: 1, up: 'z' };

try {
  let r = await call('GET', '/api/auth/me');
  check('me anonymous', r.status === 200 && r.data.user === null && r.data.config.chunkSplats === 1000);

  r = await call('POST', '/api/auth/register', { body: { username: 'a', password: pw1 } });
  check('reject short name', r.status === 400);
  r = await call('POST', '/api/auth/register', { body: { username: '测试用户', password: 'short' } });
  check('reject short password', r.status === 400);

  r = await call('POST', '/api/auth/register', { body: { username: '测试用户', password: pw1 } });
  check('register first', r.status === 200 && r.data.user.admin === true && /eg_session=/.test(r.cookie), JSON.stringify(r.data));
  const adminCookie = r.cookie;
  check('cookie flags', /HttpOnly/.test(r.headers.getSetCookie()[0]) && /SameSite=Lax/.test(r.headers.getSetCookie()[0]));

  r = await call('POST', '/api/auth/register', { body: { username: '测试用户', password: pw1 } });
  check('duplicate name', r.status === 409);
  r = await call('POST', '/api/auth/register', { body: { username: 'Bob_2', password: pw2 } });
  check('register second', r.status === 200 && r.data.user.admin === false);
  const bobCookie = r.cookie;

  r = await call('POST', '/api/auth/login', { body: { username: 'bob_2', password: 'wrong-password' } });
  check('wrong password', r.status === 401);
  r = await call('POST', '/api/auth/login', { body: { username: 'nobody', password: pw2 } });
  check('unknown user', r.status === 401);
  r = await call('POST', '/api/auth/login', { body: { username: 'BOB_2', password: pw2 } });
  check('login case-insensitive', r.status === 200 && r.data.user.name === 'Bob_2');
  r = await call('GET', '/api/auth/me', { cookie: bobCookie });
  check('me with session', r.data.user && r.data.user.name === 'Bob_2');

  const stored = fs.readFileSync(path.join(dir, 'kv', 'user', 'bob_2.json'), 'utf8');
  check('password not stored in clear', !stored.includes(pw2) && /"hash"/.test(stored));

  r = await call('POST', '/api/models', { body: { ...placement, name: 'x', count: 2500, radius: 5 } });
  check('create needs login', r.status === 401);
  r = await call('POST', '/api/models', { cookie: bobCookie, origin: 'http://evil.example', body: { ...placement, name: 'x', count: 2500, radius: 5 } });
  check('cross-site write refused', r.status === 403);
  r = await call('POST', '/api/models', { cookie: bobCookie, body: { ...placement, lat: 123, name: 'x', count: 2500, radius: 5 } });
  check('bad latitude', r.status === 400);

  r = await call('POST', '/api/models', { cookie: bobCookie, body: { ...placement, name: '测试楼', note: '说明', count: 2500, radius: 5, bmin: [-1, -1, -1], bmax: [1, 1, 1] } });
  check('create model', r.status === 201 && r.data.model.chunks === 3 && r.data.model.status === 'uploading', JSON.stringify(r.data));
  const id = r.data.model.id;

  r = await call('GET', '/api/models');
  check('uploading model hidden from public', r.data.models.length === 0);
  r = await call('GET', '/api/models', { cookie: bobCookie });
  check('owner sees own uploading model', r.data.models.length === 1 && r.data.models[0].mine === true);

  const chunk = (n, len) => { const a = new Uint8Array(len); a.fill(n + 1); return a; };
  r = await call('PUT', `/api/models/${id}/chunks/0`, { raw: chunk(0, 32000) });
  check('chunk needs login', r.status === 401);
  r = await call('PUT', `/api/models/${id}/chunks/0`, { cookie: bobCookie, raw: chunk(0, 31999) });
  check('wrong chunk size', r.status === 400);
  r = await call('PUT', `/api/models/${id}/chunks/7`, { cookie: bobCookie, raw: chunk(0, 32000) });
  check('chunk index out of range', r.status === 400);
  r = await call('PUT', `/api/models/${id}/chunks/0`, { cookie: bobCookie, raw: chunk(0, 32000) });
  check('put chunk 0', r.status === 200);
  r = await call('POST', `/api/models/${id}/complete`, { cookie: bobCookie });
  check('complete with missing chunks', r.status === 409 && r.data.missing.join() === '1,2');
  r = await call('GET', `/api/models/${id}/chunks/0`);
  check('unfinished chunk hidden from public', r.status === 404);
  await call('PUT', `/api/models/${id}/chunks/1`, { cookie: bobCookie, raw: chunk(1, 32000) });
  await call('PUT', `/api/models/${id}/chunks/2`, { cookie: bobCookie, raw: chunk(2, 16000) });
  r = await call('POST', `/api/models/${id}/complete`, { cookie: bobCookie });
  check('complete', r.status === 200 && r.data.model.status === 'ready');

  r = await call('GET', '/api/models');
  check('public list', r.data.models.length === 1 && r.data.models[0].name === '测试楼' && r.data.models[0].editable === false);
  r = await call('GET', `/api/models/${id}/chunks/2`);
  check('public chunk download', r.status === 200 && r.data.length === 16000 && r.data[0] === 3 && /immutable/.test(r.headers.get('cache-control')));
  r = await call('PUT', `/api/models/${id}/chunks/0`, { cookie: bobCookie, raw: chunk(0, 32000) });
  check('no data change after ready', r.status === 409);

  r = await call('PATCH', `/api/models/${id}`, { body: { heading: 90 } });
  check('patch needs login', r.status === 401);
  r = await call('PATCH', `/api/models/${id}`, { cookie: bobCookie, body: { heading: 90, name: '改名' } });
  check('patch by owner', r.status === 200 && r.data.model.heading === 90 && r.data.model.name === '改名' && r.data.model.lon === placement.lon);
  r = await call('PATCH', `/api/models/${id}`, { cookie: adminCookie, body: { scale: 2 } });
  check('patch by admin', r.status === 200 && r.data.model.scale === 2);

  r = await call('POST', '/api/models', { cookie: bobCookie, body: { ...placement, name: 'second', count: 10, radius: 1 } });
  const id2 = r.data.model.id;
  r = await call('POST', '/api/models', { cookie: bobCookie, body: { ...placement, name: 'third', count: 10, radius: 1 } });
  check('per-user limit', r.status === 403);

  r = await call('POST', '/api/auth/register', { body: { username: 'carol', password: pw2 } });
  const carolCookie = r.cookie;
  r = await call('DELETE', `/api/models/${id}`, { cookie: carolCookie });
  check('delete by stranger refused', r.status === 403);
  r = await call('DELETE', `/api/models/${id}`, { cookie: bobCookie });
  check('delete by owner', r.status === 200);
  check('blobs removed', !fs.existsSync(path.join(dir, 'blobs', 'chunk', id)));
  r = await call('DELETE', `/api/models/${id2}`, { cookie: adminCookie });
  check('delete by admin', r.status === 200);
  r = await call('GET', '/api/models', { cookie: bobCookie });
  check('list empty after delete', r.data.models.length === 0);

  r = await call('POST', '/api/auth/logout', { cookie: bobCookie });
  check('logout', r.status === 200);
  r = await call('GET', '/api/auth/me', { cookie: bobCookie });
  check('session ended', r.data.user === null);

  r = await call('GET', '/api/models/../../kv/user/bob_2');
  check('path tricks', r.status === 404 || r.status === 405, String(r.status));

  let limited = false;
  for (let i = 0; i < 12; i++) {
    r = await call('POST', '/api/auth/login', { body: { username: 'carol', password: 'guess-' + i } });
    if (r.status === 429) limited = true;
  }
  check('login rate limit', limited);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`pass ${pass}, fail ${failCount}`);
process.exit(failCount ? 1 : 0);
