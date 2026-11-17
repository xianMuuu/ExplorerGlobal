'use strict';
/*
 * ExplorerGlobal 本机服务（零依赖）：发送网页静态文件，并提供账号与高斯模型接口。
 * 默认只监听本机回环地址，不对局域网开放。
 * 用法：node server.js [--port 8091] [--open] [--host 0.0.0.0] [--data <数据目录>]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { pathToFileURL } = require('url');
const tiles = require('./server-tiles.js');

const APP_NAME = 'ExplorerGlobal';
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}
const PORT = parseInt(argValue('port', process.env.PORT || '8091'), 10);
const OPEN = args.includes('--open');
const HOST = argValue('host', '');
const ROOT = __dirname;
const DATA = path.resolve(argValue('data', path.join(ROOT, 'data')));
// 单次请求体上限：模型按 4 MB 一块上传，留出余量
const MAX_BODY = 9 * 1024 * 1024;

// 只有这些路径会作为静态文件发出去；data/（账号和模型数据）、backup/、tools/、api/ 等一律不发
const PUBLIC_FILES = new Set(['/index.html']);
const PUBLIC_DIRS = ['/css/', '/js/', '/lib/', '/assets/'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }, headers));
  res.end(body);
}

let pageOpened = false;
let api = null;

/* 把 Node 的请求转成标准 Request 交给接口模块，再把标准 Response 写回去 */
async function handleApi(req, res) {
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
    req.resume();
    return send(res, 413, JSON.stringify({ error: '请求体过大' }), { 'Content-Type': 'application/json; charset=utf-8' });
  }
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.destroy();
      return;
    }
    parts.push(chunk);
  }
  const headers = new Headers();
  for (const name of ['cookie', 'origin', 'referer', 'content-type', 'content-length', 'user-agent', 'accept']) {
    if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
  }
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = Buffer.concat(parts);
  const request = new Request('http://' + (req.headers.host || 'localhost:' + PORT) + req.url, init);
  const response = await api.handle(request, { ip: req.socket.remoteAddress || 'local' });

  const out = { 'X-Content-Type-Options': 'nosniff' };
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') out[name] = value;
  });
  const setCookie = response.headers.getSetCookie();
  if (setCookie.length) out['set-cookie'] = setCookie;
  const body = Buffer.from(await response.arrayBuffer());
  out['content-length'] = body.length;
  res.writeHead(response.status, out);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function handleStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
  if (urlPath === '/') urlPath = '/index.html';
  if (!PUBLIC_FILES.has(urlPath) && !PUBLIC_DIRS.some((d) => urlPath.startsWith(d))) return send(res, 404, 'Not Found');
  if (urlPath === '/index.html' && !pageOpened) {
    pageOpened = true;
    console.log('  浏览器已打开页面。');
  }
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not Found');

    const ext = path.extname(file).toLowerCase();
    const immutable = urlPath.startsWith('/lib/') || urlPath.startsWith('/assets/');
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': immutable ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };

    const since = req.headers['if-modified-since'];
    if (since && Math.floor(st.mtimeMs / 1000) <= Math.floor(new Date(since).getTime() / 1000)) {
      res.writeHead(304, headers);
      return res.end();
    }

    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

function handle(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    return send(res, 400, 'Bad Request');
  }
  if (urlPath === '/api' || urlPath.startsWith('/api/')) {
    handleApi(req, res).catch((e) => {
      console.error('[接口出错]', e);
      if (!res.headersSent) send(res, 500, JSON.stringify({ error: '服务器内部错误' }), { 'Content-Type': 'application/json; charset=utf-8' });
      else res.destroy();
    });
    return;
  }
  if (urlPath === '/tiles' || urlPath.startsWith('/tiles/')) {
    tiles.handle(req, res, urlPath);
    return;
  }
  handleStatic(req, res, urlPath);
}

function listen(host, required) {
  const server = http.createServer(handle);
  return new Promise((resolve) => {
    server.once('error', (e) => {
      if (required) {
        if (e.code === 'EADDRINUSE') {
          console.error('\n[错误] 端口 ' + PORT + ' 已被占用。请先关闭占用该端口的程序，或重新双击“启动.bat”（会自动清理）。');
        } else {
          console.error('\n[错误] 服务启动失败：' + e.message);
        }
        process.exit(1);
      }
      resolve(false);
    });
    server.listen(PORT, host, () => resolve(true));
  });
}

(async () => {
  // 接口模块是 ES 模块（与线上部署共用），这里动态载入
  const { createApi } = await import(pathToFileURL(path.join(ROOT, 'api', 'core.mjs')).href);
  const { fsStore } = await import(pathToFileURL(path.join(ROOT, 'api', 'store-fs.mjs')).href);
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[提示] data/config.json 读取失败，已按默认设置运行：' + e.message);
  }
  api = createApi({ store: fsStore(DATA), config });
  tiles.init({ dataDir: DATA });

  if (HOST) {
    await listen(HOST, true);
  } else {
    await listen('127.0.0.1', true);
    await listen('::1', false);
  }
  const url = 'http://localhost:' + PORT + '/';
  console.log('');
  console.log('  ' + APP_NAME + ' 已启动');
  console.log('  地址：' + url);
  console.log('  数据目录：' + DATA);
  if (HOST) console.log('  注意：正在监听 ' + HOST + '，局域网内的其他设备也能访问。');
  console.log('  关闭本窗口即停止服务。');
  console.log('');
  if (OPEN) {
    if (process.platform === 'win32') exec('start "" "' + url + '"');
    else if (process.platform === 'darwin') exec('open "' + url + '"');
    else exec('xdg-open "' + url + '"');
  }
})();
