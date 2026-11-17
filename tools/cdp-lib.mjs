// 测试辅助：通过 Chrome DevTools Protocol 驱动本机 Chrome（零依赖，需要 Node 22+）。
// 先用 --remote-debugging-port 启动 Chrome，再运行 tools/cdp.mjs。
import fs from 'node:fs';

const PORT = process.env.CDP_PORT || 9333;
const BASE = `http://127.0.0.1:${PORT}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOOK = `(() => {
  if (window.__logs) return;
  window.__logs = [];
  const fmt = (a) => {
    try {
      if (a instanceof Error) return a.stack || a.message;
      if (a && typeof a === 'object') return JSON.stringify(a);
      return String(a);
    } catch (e) { return '[unprintable]'; }
  };
  const push = (level, args) => {
    window.__logs.push({ t: Math.round(performance.now()), level, msg: args.map(fmt).join(' ').slice(0, 700) });
  };
  for (const k of ['error', 'warn']) {
    const o = console[k];
    console[k] = (...a) => { push(k, a); o.apply(console, a); };
  }
  window.addEventListener('error', (e) => push('uncaught', [e.message, (e.filename || '') + ':' + e.lineno, e.error]));
  window.addEventListener('unhandledrejection', (e) => push('rejection', [e.reason]));
  try { performance.setResourceTimingBufferSize(30000); } catch (e) {}
})();`;

export async function connect(opts = {}) {
  let targets = await (await fetch(BASE + '/json/list')).json();
  let t = targets.find((x) => x.type === 'page' && (!opts.match || x.url.includes(opts.match)));
  if (!t) t = await (await fetch(BASE + '/json/new?about:blank', { method: 'PUT' })).json();

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('无法连接到浏览器调试端口')); });

  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
      else p.res(m.result);
    } else {
      for (const fn of listeners) fn(m);
    }
  };

  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej, method });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const page = {
    send,
    sleep,
    target: t,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error('页面脚本出错: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
      }
      return r.result.value;
    },

    async open(url, { viewport = { width: 1600, height: 900, dpr: 1 }, timeout = 30000 } = {}) {
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Log.enable');
      await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.dpr, mobile: false });
      await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
      const loaded = new Promise((res) => {
        const off = page.on((m) => { if (m.method === 'Page.loadEventFired') { off(); res(true); } });
        setTimeout(() => { off(); res(false); }, timeout);
      });
      await send('Page.navigate', { url });
      return loaded;
    },

    async shot(file, { quality, clip } = {}) {
      const params = quality ? { format: 'jpeg', quality } : { format: 'png' };
      if (clip) params.clip = { x: clip[0], y: clip[1], width: clip[2], height: clip[3], scale: clip[4] || 1 };
      const r = await send('Page.captureScreenshot', params);
      const buf = Buffer.from(r.data, 'base64');
      fs.writeFileSync(file, buf);
      return buf.length;
    },

    mouse(type, x, y, extra = {}) {
      return send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, ...extra });
    },
    async move(x, y) { await page.mouse('mouseMoved', x, y); },
    async click(x, y, { button = 'left', count = 1 } = {}) {
      const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
      await page.mouse('mouseMoved', x, y);
      for (let i = 1; i <= count; i++) {
        await page.mouse('mousePressed', x, y, { button, buttons, clickCount: i });
        await page.mouse('mouseReleased', x, y, { button, buttons: 0, clickCount: i });
        if (i < count) await sleep(60);
      }
    },
    async drag(x1, y1, x2, y2, { button = 'left', steps = 20, stepMs = 16, modifiers = 0, hold = 0 } = {}) {
      const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
      await page.mouse('mouseMoved', x1, y1, { modifiers });
      await page.mouse('mousePressed', x1, y1, { button, buttons, clickCount: 1, modifiers });
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        await page.mouse('mouseMoved', x1 + (x2 - x1) * k, y1 + (y2 - y1) * k, { button, buttons, modifiers });
        await sleep(stepMs);
      }
      if (hold) await sleep(hold);
      await page.mouse('mouseReleased', x2, y2, { button, buttons: 0, clickCount: 1, modifiers });
    },
    async wheel(x, y, deltaY, times = 1, gap = 40) {
      for (let i = 0; i < times; i++) {
        await page.mouse('mouseWheel', x, y, { deltaX: 0, deltaY });
        await sleep(gap);
      }
    },

    async keyDown(code, { key = code, vk = 0, modifiers = 0, text } = {}) {
      await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, text });
    },
    async keyUp(code, { key = code, vk = 0, modifiers = 0 } = {}) {
      await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    },
    async press(code, o = {}, holdMs = 0) {
      await page.keyDown(code, o);
      if (holdMs) await sleep(holdMs);
      await page.keyUp(code, o);
    },
    async type(text) { await send('Input.insertText', { text }); },

    logs() { return page.evaluate('window.__logs || []'); },
    close() { ws.close(); },
  };

  // 视口覆盖只在当前调试会话内有效，所以每次连接都重新设置，保证各步骤尺寸一致。
  const vp = opts.viewport || { width: Number(process.env.CDP_W || 1600), height: Number(process.env.CDP_H || 900), dpr: Number(process.env.CDP_DPR || 1) };
  await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: false });
  page.viewport = vp;
  return page;
}
