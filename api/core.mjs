// 账号与高斯模型接口。
// 只用 Web 标准接口（Request / Response / crypto.subtle），本机 Node 服务和 Cloudflare 共用这一份代码。
// 数据通过 store 适配器读写：getJSON / putJSON / del / list(prefix) / getBlob / putBlob / delBlob / listBlobs(prefix)。

const enc = new TextEncoder();

const DEFAULTS = {
  registration: 'open', // open：任何人可注册；closed：关闭注册
  maxModelsPerUser: 20,
  maxSplats: 8000000,
  chunkSplats: 131072,
  bytesPerSplat: 32,
  sessionDays: 30,
  pbkdf2Iterations: 100000,
  cookieName: 'eg_session',
};

const UP_AXES = ['z', 'y', '-y', '-z'];
const NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/;
const ID_RE = /^[0-9a-f]{24}$/;
const DUMMY_SALT = new Uint8Array(16);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
const fail = (status, error) => json({ error }, status);

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(text) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
}
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return b64url(new Uint8Array(bits));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function cookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
async function readJSON(request, limit = 65536) {
  try {
    const text = await request.text();
    if (text.length > limit) return null;
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}
function num(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
function vec3(v) {
  return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n)) ? v.map(Number) : null;
}

// 内存限流：同一个键在窗口期内最多 max 次。进程重启即清零；多实例部署时只在单个实例内生效。
function limiter() {
  const map = new Map();
  return (key, max, windowMs, t) => {
    const e = map.get(key);
    if (!e || e.reset <= t) {
      if (map.size > 5000) for (const [k, v] of map) if (v.reset <= t) map.delete(k);
      map.set(key, { n: 1, reset: t + windowMs });
      return true;
    }
    e.n++;
    return e.n <= max;
  };
}

export function createApi({ store, config = {}, now = () => Date.now() }) {
  const cfg = { ...DEFAULTS, ...config };
  const allow = limiter();

  function sessionCookie(request, token, maxAge) {
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return `${cfg.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  }

  // 浏览器发出的跨站写请求一定带 Origin；不带 Origin 的是命令行之类的客户端，它们拿不到别人的 Cookie
  function sameOrigin(request) {
    const origin = request.headers.get('origin');
    if (!origin) return true;
    try {
      return new URL(origin).host === new URL(request.url).host;
    } catch (e) {
      return false;
    }
  }

  async function currentUser(request) {
    const token = cookies(request)[cfg.cookieName];
    if (!token || token.length > 100) return null;
    const key = 'session/' + (await sha256(token));
    const s = await store.getJSON(key);
    if (!s) return null;
    if (s.exp < now()) {
      await store.del(key);
      return null;
    }
    const u = await store.getJSON('user/' + s.user);
    return u ? { key: s.user, name: u.name, admin: !!u.admin } : null;
  }

  async function startSession(request, key, user) {
    const token = b64url(randomBytes(32));
    const maxAge = cfg.sessionDays * 86400;
    await store.putJSON('session/' + (await sha256(token)), { user: key, exp: now() + maxAge * 1000 });
    return json({ user: { name: user.name, admin: !!user.admin } }, 200, { 'set-cookie': sessionCookie(request, token, maxAge) });
  }

  const publicConfig = () => ({
    registration: cfg.registration,
    maxSplats: cfg.maxSplats,
    chunkSplats: cfg.chunkSplats,
    bytesPerSplat: cfg.bytesPerSplat,
    maxModelsPerUser: cfg.maxModelsPerUser,
  });

  /* ---------- 账号 ---------- */
  async function register(request, ip) {
    if (cfg.registration !== 'open') return fail(403, '当前未开放注册');
    if (!allow('reg:' + ip, 8, 3600e3, now())) return fail(429, '注册过于频繁，请稍后再试');
    const body = await readJSON(request);
    if (!body) return fail(400, '请求格式不正确');
    const name = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!NAME_RE.test(name)) return fail(400, '用户名需为 2–20 个字符，只能包含中文、字母、数字和下划线');
    if (password.length < 8 || password.length > 72) return fail(400, '密码长度需为 8–72 个字符');
    const key = name.toLowerCase();
    if (await store.getJSON('user/' + key)) return fail(409, '这个用户名已被注册');
    const first = (await store.list('user/')).length === 0;
    const salt = randomBytes(16);
    const user = {
      name,
      salt: b64url(salt),
      hash: await pbkdf2(password, salt, cfg.pbkdf2Iterations),
      iter: cfg.pbkdf2Iterations,
      admin: first, // 第一个注册的用户是管理员
      createdAt: now(),
    };
    await store.putJSON('user/' + key, user);
    return startSession(request, key, user);
  }

  async function login(request, ip) {
    const body = await readJSON(request);
    if (!body) return fail(400, '请求格式不正确');
    const name = String(body.username || '').trim();
    const password = String(body.password || '').slice(0, 200);
    const key = name.toLowerCase().slice(0, 40);
    const t = now();
    if (!allow('login:' + ip + ':' + key, 10, 600e3, t) || !allow('login-ip:' + ip, 60, 600e3, t)) {
      return fail(429, '尝试次数过多，请 10 分钟后再试');
    }
    const user = NAME_RE.test(name) ? await store.getJSON('user/' + key) : null;
    // 用户不存在时也做一次同样耗时的计算，避免通过响应时间探测用户名是否存在
    const hash = await pbkdf2(password, user ? fromB64url(user.salt) : DUMMY_SALT, user ? user.iter : cfg.pbkdf2Iterations);
    if (!user || !safeEqual(hash, user.hash)) return fail(401, '用户名或密码不正确');
    return startSession(request, key, user);
  }

  async function logout(request) {
    const token = cookies(request)[cfg.cookieName];
    if (token && token.length <= 100) await store.del('session/' + (await sha256(token)));
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '', 0) });
  }

  /* ---------- 模型 ---------- */
  const chunkKey = (id, n) => `chunk/${id}/${n}`;

  function view(m, user) {
    const mine = !!user && m.owner === user.key;
    return {
      id: m.id, name: m.name, note: m.note, owner: m.ownerName,
      lon: m.lon, lat: m.lat, height: m.height, heading: m.heading, pitch: m.pitch, roll: m.roll, scale: m.scale, up: m.up,
      count: m.count, chunks: m.chunks, chunkSplats: m.chunkSplats, radius: m.radius, bmin: m.bmin, bmax: m.bmax,
      status: m.status, createdAt: m.createdAt, mine, editable: mine || (!!user && user.admin),
    };
  }

  async function removeModel(m) {
    for (const key of await store.listBlobs(`chunk/${m.id}/`)) await store.delBlob(key);
    await store.del('model/' + m.id);
  }

  async function allModels() {
    const out = [];
    for (const key of await store.list('model/')) {
      const m = await store.getJSON(key);
      if (!m) continue;
      // 上传到一半就放弃的模型，一天后清理
      if (m.status !== 'ready' && now() - m.createdAt > 86400e3) {
        await removeModel(m);
        continue;
      }
      out.push(m);
    }
    return out;
  }

  function placement(body, base) {
    const p = {
      lon: num(body.lon, -180, 180),
      lat: num(body.lat, -90, 90),
      height: num(body.height, -1000, 20000),
      heading: num(body.heading, -360, 360),
      pitch: num(body.pitch, -360, 360),
      roll: num(body.roll, -360, 360),
      scale: num(body.scale, 1e-5, 1e5),
    };
    for (const k of Object.keys(p)) {
      if (p[k] === null) {
        if (base && body[k] === undefined) p[k] = base[k];
        else return null;
      }
    }
    p.up = body.up === undefined && base ? base.up : body.up;
    if (!UP_AXES.includes(p.up)) return null;
    return p;
  }

  function texts(body, base) {
    const name = body.name === undefined && base ? base.name : String(body.name || '').trim();
    const note = body.note === undefined && base ? base.note : String(body.note || '').trim();
    if (!name || name.length > 60 || note.length > 300) return null;
    return { name, note };
  }

  async function listModels(user) {
    const all = await allModels();
    return json({ models: all.filter((m) => m.status === 'ready' || (user && m.owner === user.key)).map((m) => view(m, user)) });
  }

  async function createModel(request, user) {
    const body = await readJSON(request);
    if (!body) return fail(400, '请求格式不正确');
    const p = placement(body);
    const t = texts(body);
    const count = num(body.count, 1, cfg.maxSplats);
    const radius = num(body.radius, 1e-9, 1e9);
    if (!p) return fail(400, '位置参数不完整或超出范围');
    if (!t) return fail(400, '名称需为 1–60 个字符，说明不超过 300 个字符');
    if (count === null || !Number.isInteger(count)) return fail(400, '点数需在 1 到 ' + cfg.maxSplats + ' 之间');
    if (radius === null) return fail(400, '模型尺寸参数不正确');
    const mine = (await allModels()).filter((m) => m.owner === user.key);
    if (!user.admin && mine.length >= cfg.maxModelsPerUser) return fail(403, '每个账号最多上传 ' + cfg.maxModelsPerUser + ' 个模型，请先删除不用的模型');
    const m = {
      id: hex(randomBytes(12)),
      ...t, ...p,
      owner: user.key, ownerName: user.name,
      count, chunkSplats: cfg.chunkSplats, chunks: Math.ceil(count / cfg.chunkSplats),
      radius, bmin: vec3(body.bmin), bmax: vec3(body.bmax),
      status: 'uploading', createdAt: now(), updatedAt: now(),
    };
    await store.putJSON('model/' + m.id, m);
    return json({ model: view(m, user) }, 201);
  }

  async function putChunk(request, user, m, n) {
    if (m.status !== 'uploading') return fail(409, '模型已经上传完成，不能再改数据');
    if (!(n >= 0 && n < m.chunks)) return fail(400, '分块序号超出范围');
    const expected = (n === m.chunks - 1 ? m.count - n * m.chunkSplats : m.chunkSplats) * cfg.bytesPerSplat;
    if (Number(request.headers.get('content-length') || 0) > expected) return fail(413, '分块过大');
    const data = new Uint8Array(await request.arrayBuffer());
    if (data.byteLength !== expected) return fail(400, '分块大小不符（应为 ' + expected + ' 字节）');
    await store.putBlob(chunkKey(m.id, n), data);
    return json({ ok: true, chunk: n });
  }

  async function completeModel(user, m) {
    if (m.status === 'ready') return json({ model: view(m, user) });
    const have = new Set(await store.listBlobs(`chunk/${m.id}/`));
    const missing = [];
    for (let n = 0; n < m.chunks; n++) if (!have.has(chunkKey(m.id, n))) missing.push(n);
    if (missing.length) return json({ error: '还有分块没有上传完', missing }, 409);
    m.status = 'ready';
    m.updatedAt = now();
    await store.putJSON('model/' + m.id, m);
    return json({ model: view(m, user) });
  }

  async function patchModel(request, user, m) {
    const body = await readJSON(request);
    if (!body) return fail(400, '请求格式不正确');
    const p = placement(body, m);
    const t = texts(body, m);
    if (!p) return fail(400, '位置参数不完整或超出范围');
    if (!t) return fail(400, '名称需为 1–60 个字符，说明不超过 300 个字符');
    Object.assign(m, p, t, { updatedAt: now() });
    await store.putJSON('model/' + m.id, m);
    return json({ model: view(m, user) });
  }

  async function getChunk(user, m, n) {
    if (m.status !== 'ready' && !(user && (m.owner === user.key || user.admin))) return fail(404, '没有这个模型');
    const data = await store.getBlob(chunkKey(m.id, n));
    if (!data) return fail(404, '没有这个分块');
    return new Response(data, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        // 模型数据上传完成后不再变化，可以长期缓存
        'cache-control': m.status === 'ready' ? 'public, max-age=31536000, immutable' : 'no-store',
      },
    });
  }

  /* ---------- 路由 ---------- */
  async function route(request, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method.toUpperCase();
    if (!path.startsWith('/api')) return null;
    const ip = (ctx && ctx.ip) || 'unknown';

    if (path === '/api/ping') return json({ ok: true, time: now() });
    const write = method !== 'GET' && method !== 'HEAD';
    if (write && !sameOrigin(request)) return fail(403, '拒绝跨站请求');

    if (path === '/api/auth/me' && method === 'GET') {
      const u = await currentUser(request);
      return json({ user: u ? { name: u.name, admin: u.admin } : null, config: publicConfig() });
    }
    if (path === '/api/auth/register' && method === 'POST') return register(request, ip);
    if (path === '/api/auth/login' && method === 'POST') return login(request, ip);
    if (path === '/api/auth/logout' && method === 'POST') return logout(request);

    if (path === '/api/models') {
      const user = await currentUser(request);
      if (method === 'GET') return listModels(user);
      if (method === 'POST') return user ? createModel(request, user) : fail(401, '请先登录');
      return fail(405, '不支持的请求方法');
    }

    const mm = path.match(/^\/api\/models\/([0-9a-f]+)(?:\/(complete|chunks\/(\d{1,5})))?$/);
    if (mm && ID_RE.test(mm[1])) {
      const m = await store.getJSON('model/' + mm[1]);
      if (!m) return fail(404, '没有这个模型');
      const user = await currentUser(request);
      const sub = mm[2] || '';
      if (sub.startsWith('chunks/') && method === 'GET') return getChunk(user, m, Number(mm[3]));
      if (!write) return fail(405, '不支持的请求方法');
      if (!user) return fail(401, '请先登录');
      if (m.owner !== user.key && !user.admin) return fail(403, '只有上传者或管理员可以修改这个模型');
      if (sub.startsWith('chunks/') && method === 'PUT') return putChunk(request, user, m, Number(mm[3]));
      if (sub === 'complete' && method === 'POST') return completeModel(user, m);
      if (!sub && method === 'PATCH') return patchModel(request, user, m);
      if (!sub && method === 'DELETE') {
        await removeModel(m);
        return json({ ok: true });
      }
      return fail(405, '不支持的请求方法');
    }
    return fail(404, '没有这个接口');
  }

  async function handle(request, ctx) {
    try {
      return await route(request, ctx);
    } catch (e) {
      console.error('[api]', e);
      return fail(500, '服务器内部错误');
    }
  }

  return { handle, config: cfg };
}
