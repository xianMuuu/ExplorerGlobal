'use strict';
/*
 * 瓦片缓存代理（零第三方依赖）。
 * 把浏览器请求的 /tiles/<source>/<kind>/<z>/<x>/<y> 当作本地瓦片库的入口：
 *   - 本地有缓存：直接读（HIT），断网/无梯子也能用；
 *   - 没有缓存：抓上游（google 走系统代理、其余直连），落盘到 data/tiles/ 再返回（MISS）。
 * 上游模板与 js/config.js 的 GE.sources 保持一致。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { execSync } = require('child_process');

/* ---------- 上游瓦片定义（与 config.js 同步） ---------- */
const UPSTREAM = {
  google: {
    proxy: true,
    sat:    { url: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}&scale=2', subdomains: ['0', '1', '2', '3'], maxLevel: 20, ext: 'jpg' },
    labels: { url: 'https://mt{s}.google.com/vt/lyrs=h&x={x}&y={y}&z={z}&scale=2&hl=zh-CN', subdomains: ['0', '1', '2', '3'], maxLevel: 20, ext: 'png' },
  },
  gaode: {
    proxy: false,
    sat:    { url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', subdomains: ['1', '2', '3', '4'], maxLevel: 18, ext: 'jpg' },
    labels: { url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}', subdomains: ['1', '2', '3', '4'], maxLevel: 18, ext: 'png' },
  },
  esri: {
    proxy: false,
    sat:    { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', subdomains: [], maxLevel: 19, ext: 'jpg' },
    labels: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', subdomains: [], maxLevel: 12, ext: 'png' },
  },
};

const CONTENT_TYPE_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const EXT_BY_CONTENT_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

let cacheRoot = null; // data/tiles
let proxy = null;     // { host, port } 系统 HTTP 代理（翻墙软件）

function init(opts) {
  cacheRoot = opts.dataDir ? path.join(opts.dataDir, 'tiles') : path.join(__dirname, 'data', 'tiles');
  proxy = opts.proxy || readSystemProxy();
  if (proxy) console.log('[瓦片缓存] 上游代理：' + proxy.host + ':' + proxy.port + '（google 等被墙源走它）');
  else console.log('[瓦片缓存] 未检测到系统代理，google 源在大陆可能抓取失败（会正常降级到高德）');
  return { cacheRoot, proxy };
}

function readSystemProxy() {
  try {
    const regQuery = (...parts) => {
      try { return execSync('reg query ' + parts.join(' '), { encoding: 'utf8', timeout: 5000, windowsHide: true }); }
      catch (e) { return e.stdout || ''; }
    };
    const enableOut = regQuery('"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"', '/v', 'ProxyEnable');
    const enable = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(enableOut);
    if (!enable || parseInt(enable[1], 16) !== 1) return null;
    const serverOut = regQuery('"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"', '/v', 'ProxyServer');
    const server = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(serverOut);
    if (!server) return null;
    let p = server[1].trim();
    const httpsMatch = /https=([^;\s]+)/i.exec(p);
    if (httpsMatch) p = httpsMatch[1];
    else { const httpMatch = /http=([^;\s]+)/i.exec(p); if (httpMatch) p = httpMatch[1]; }
    p = p.replace(/^https?:\/\//i, '').trim();
    const i = p.lastIndexOf(':');
    if (i <= 0) return null;
    const host = p.slice(0, i);
    const port = parseInt(p.slice(i + 1), 10);
    if (!host || !port) return null;
    return { host, port };
  } catch (e) { return null; }
}

function shouldUseProxy(hostname) {
  if (!proxy) return false;
  return /(^|\.)google(apis)?\.com$/i.test(hostname);
}

/* ---------- 上游 URL 拼装 ---------- */
function upstreamUrl(source, kind, z, x, y) {
  const def = UPSTREAM[source] && UPSTREAM[source][kind];
  if (!def) return null;
  const subs = def.subdomains || [''];
  const s = subs[(x + y + z) % subs.length] || '';
  return def.url
    .replace('{s}', s)
    .replace('{x}', x)
    .replace('{y}', y)
    .replace('{z}', z);
}

/* ---------- 缓存路径 ---------- */
function cachePathFor(source, kind, z, x, y, ext) {
  const dir = path.join(cacheRoot, source, kind, String(z), String(x));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, String(y) + (ext || ''));
}

function readCache(source, kind, z, x, y) {
  if (!cacheRoot) return null;
  const dir = path.join(cacheRoot, source, kind, String(z), String(x));
  for (const ext of ['.png', '.jpg', '.webp', '.jpeg']) {
    const f = path.join(dir, String(y) + ext);
    if (fs.existsSync(f)) {
      try { return { file: f, buffer: fs.readFileSync(f), contentType: CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream', ext }; } catch (e) { return null; }
    }
  }
  return null;
}

/* ---------- 抓取上游（直连或经 HTTP CONNECT 隧道） ---------- */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname;
    const port = u.port || (u.protocol === 'https:' ? 443 : 80);
    const useProxy = u.protocol === 'https:' && shouldUseProxy(host);
    const reqHeaders = {
      'User-Agent': UA,
      'Referer': 'https://earth.google.com/',
      'Accept': 'image/*,*/*;q=0.8',
    };

    function parseResponse(sock, onDone) {
      let buf = Buffer.alloc(0);
      let contentLength = -1;
      let state = 'head';
      let status = 0;
      const headers = {};

      function fail(e) { try { sock.destroy(); } catch (_) {} reject(e); }

      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (state === 'head') {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) { if (buf.length > 16384) fail(new Error('响应头过大')); return; }
          const headStr = buf.slice(0, idx).toString('latin1');
          buf = buf.slice(idx + 4);
          const lines = headStr.split('\r\n');
          const sm = /^HTTP\/\d\.\d\s+(\d+)/.exec(lines[0]);
          status = sm ? parseInt(sm[1], 10) : 0;
          for (let i = 1; i < lines.length; i++) {
            const ci = lines[i].indexOf(':');
            if (ci > 0) headers[lines[i].slice(0, ci).trim().toLowerCase()] = lines[i].slice(ci + 1).trim();
          }
          const chunked = /chunked/i.test(headers['transfer-encoding'] || '');
          if (!chunked && headers['content-length']) contentLength = parseInt(headers['content-length'], 10);
          state = 'body';
          if (chunked) { readChunked(); return; }
        }
        if (state === 'body' && contentLength >= 0) {
          if (buf.length >= contentLength) {
            sock.removeAllListeners('data');
            onDone(status, headers, buf.slice(0, contentLength));
          }
          return;
        }
      });

      // chunked 解码（瓦片一般带 content-length，这里兜底）
      function readChunked() {
        let body = Buffer.alloc(0);
        sock.removeAllListeners('data');
        sock.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          for (;;) {
            const lineEnd = buf.indexOf('\r\n');
            if (lineEnd === -1) return;
            const sizeStr = buf.slice(0, lineEnd).toString('latin1').split(';')[0].trim();
            const size = parseInt(sizeStr, 16);
            if (isNaN(size)) { fail(new Error('chunked 解析失败')); return; }
            if (size === 0) { sock.removeAllListeners('data'); onDone(status, headers, body); return; }
            if (buf.length < lineEnd + 2 + size + 2) return;
            body = Buffer.concat([body, buf.slice(lineEnd + 2, lineEnd + 2 + size)]);
            buf = buf.slice(lineEnd + 2 + size + 2);
          }
        });
      }

      sock.on('end', () => { if (state !== 'done') onDone(status, headers, buf); });
      sock.on('error', fail);
      sock.setTimeout(20000, () => fail(new Error('上游超时')));
    }

    function finish(status, headers, body) {
      if (status >= 200 && status < 300 && body.length > 0) {
        resolve({ statusCode: status, headers, body });
      } else {
        reject(new Error('上游返回 ' + status + '（' + body.length + ' 字节）'));
      }
    }

    function direct() {
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(url, { headers: reqHeaders, method: 'GET' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish(res.statusCode, res.headers, Buffer.concat(chunks)));
      });
      req.setTimeout(20000, () => req.destroy(new Error('上游超时')));
      req.on('error', reject);
      req.end();
    }

    function viaProxy() {
      const conn = net.connect(proxy.port, proxy.host);
      conn.on('error', reject);
      conn.on('connect', () => {
        conn.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\n\r\n');
        let headBuf = Buffer.alloc(0);
        const onHeadData = (chunk) => {
          headBuf = Buffer.concat([headBuf, chunk]);
          const idx = headBuf.indexOf('\r\n\r\n');
          if (idx === -1) { if (headBuf.length > 8192) { conn.destroy(); reject(new Error('代理 CONNECT 响应异常')); } return; }
          const statusLine = headBuf.slice(0, idx).toString('latin1').split('\r\n')[0];
          const sm = /^HTTP\/\d\.\d\s+(\d+)/.exec(statusLine);
          conn.removeListener('data', onHeadData);
          if (!sm || sm[1] !== '200') { conn.destroy(); reject(new Error('代理 CONNECT 失败：' + statusLine)); return; }
          const tlsSock = tls.connect({ socket: conn, servername: host, rejectUnauthorized: false }, () => {
            const reqStr = 'GET ' + u.pathname + u.search + ' HTTP/1.1\r\n' +
              'Host: ' + host + '\r\n' +
              'User-Agent: ' + UA + '\r\n' +
              'Referer: https://earth.google.com/\r\n' +
              'Accept: image/*,*/*;q=0.8\r\n' +
              'Connection: close\r\n\r\n';
            parseResponse(tlsSock, finish);
            tlsSock.write(reqStr);
          });
          tlsSock.on('error', reject);
        };
        conn.on('data', onHeadData);
      });
    }

    if (useProxy) viaProxy();
    else direct();
  });
}

/* ---------- 抓一块瓦片并落盘（供 server 与 prefetch 复用） ---------- */
const inflight = new Map();

function fetchTile(source, kind, z, x, y) {
  const def = UPSTREAM[source] && UPSTREAM[source][kind];
  if (!def) return Promise.reject(new Error('未知源：' + source + '/' + kind));
  if (z < 0 || z > def.maxLevel) return Promise.reject(new Error('超出层级范围 ' + z));

  const key = source + '/' + kind + '/' + z + '/' + x + '/' + y;
  const hit = readCache(source, kind, z, x, y);
  if (hit) return Promise.resolve({ ...hit, cache: 'HIT', bytes: hit.buffer.length });

  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const url = upstreamUrl(source, kind, z, x, y);
    const { statusCode, headers, body } = await fetchBuffer(url);
    const ct = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_BY_CONTENT_TYPE[ct] || ('.' + def.ext);
    const file = cachePathFor(source, kind, z, x, y, ext);
    // 先写临时文件再改名，避免并发/中断留下半截文件
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return { file, buffer: body, contentType: CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream', ext, cache: 'MISS', bytes: body.length, upstream: statusCode };
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ---------- HTTP 路由处理 ---------- */
const ROUTE = /^\/tiles\/([a-z]+)\/(sat|labels)\/(\d+)\/(\d+)\/(\d+)$/;

function handle(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Method Not Allowed');
  }
  const m = ROUTE.exec(urlPath);
  if (!m) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }
  const [, source, kind, z, x, y] = m;
  fetchTile(source, kind, parseInt(z, 10), parseInt(x, 10), parseInt(y, 10)).then(
    (r) => {
      res.writeHead(r.bytes > 0 ? 200 : 206, {
        'Content-Type': r.contentType,
        'Content-Length': r.bytes,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Cache': r.cache,
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      res.end(r.buffer);
    },
    (e) => {
      const code = /超出层级|未知源/.test(e.message) ? 404 : 502;
      const msg = code === 404 ? e.message.replace(/（.*/, '') : '上游不可达';
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Cache': 'ERROR' });
      res.end(msg);
    }
  );
}

module.exports = { init, handle, fetchTile, readCache, cachePathFor, cacheRoot: () => cacheRoot, UPSTREAM, upstreamUrl, readSystemProxy };