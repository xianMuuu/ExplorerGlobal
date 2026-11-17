/* 影像源管理：探测、自动降级/回升、注记层、网格、地形 */
(function () {
  'use strict';
  const C = Cesium;
  const cfg = GE.config;

  /* ---------- GCJ-02（国测局偏移坐标）与 WGS-84 互转 ---------- */
  const PI = Math.PI;
  const A = 6378245.0;
  const EE = 0.00669342162296594323;

  function outOfChina(lng, lat) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }
  function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
    ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
    return ret;
  }
  function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
    ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
    return ret;
  }
  function gcjDelta(lng, lat) {
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = (lat / 180.0) * PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
    dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
    return [dLng, dLat];
  }
  function wgs2gcj(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    const d = gcjDelta(lng, lat);
    return [lng + d[0], lat + d[1]];
  }
  function gcj2wgs(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    let wl = lng;
    let wa = lat;
    for (let i = 0; i < 3; i++) {
      const d = gcjDelta(wl, wa);
      wl = lng - d[0];
      wa = lat - d[1];
    }
    return [wl, wa];
  }
  GE.geo = { wgs2gcj, gcj2wgs };

  /* ---------- Google 注记的大陆纠偏 ----------
     Google 的注记在中国大陆带国测局偏移，港澳和国外不带，同一张瓦片里两种都可能出现，
     整张挪动会在边界处把瓦片拉变形。这里保持标准瓦片网格，把每张瓦片分成 8×8 小块：
     落在大陆的小块改从“偏移后的位置”取图，其余小块原样照搬。偏移量取整像素，文字不会发糊。 */
  const FIX_GRID = 8;
  const FIX_UNIT = 512; // 把一张瓦片的边长分成 512 份（scale=2 瓦片的一个像素）
  const FIX_CELL = FIX_UNIT / FIX_GRID;

  function latOfMercator(t) {
    return (Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) * 180) / Math.PI;
  }
  function mercatorOfLat(lat) {
    const r = (lat * Math.PI) / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
  }
  function isFlipped(img) {
    // Cesium 取回的 ImageBitmap 是上下颠倒的（解码时已翻转，供 WebGL 直接上传）
    return typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap;
  }

  // 偏移不足 2.5 个屏幕像素的低层级瓦片（9 级及以下）看不出差别，原样使用；长途飞行中途加载的基本都是这类
  const FIX_MIN_SHIFT = 5;

  /* 这张瓦片要不要纠偏、怎么拼。返回 null 表示原样使用 */
  function planMainlandFix(x, y, level) {
    const n = Math.pow(2, level);
    const west = (x / n) * 360 - 180;
    const east = ((x + 1) / n) * 360 - 180;
    if (east < 73 || west > 135.6) return null;

    // 瓦片中心处的偏移：向东、向南为正，单位是 1/512 瓦片；取整保证文字不被重采样弄糊
    const cLat = latOfMercator((y + 0.5) / n);
    const d = gcjDelta((west + east) / 2, cLat);
    const ox = Math.round((d[0] / 360) * n * FIX_UNIT);
    const oy = Math.round((mercatorOfLat(cLat + d[1]) * n - (y + 0.5)) * FIX_UNIT);
    if (Math.max(Math.abs(ox), Math.abs(oy)) < FIX_MIN_SHIFT) return null;

    const G = FIX_GRID;
    const mask = new Uint8Array(G * G);
    let count = 0;
    for (let j = 0; j < G; j++) {
      const lat = latOfMercator((y + (j + 0.5) / G) / n);
      for (let i = 0; i < G; i++) {
        if (GE.region.inMainland(west + ((i + 0.5) / G / n) * 360, lat)) {
          mask[j * G + i] = 1;
          count++;
        }
      }
    }
    if (!count) return null;

    const blocks = []; // [u0, v0, u1, v1, 取图偏移 x, 取图偏移 y]
    if (count === G * G) {
      blocks.push([0, 0, FIX_UNIT, FIX_UNIT, ox, oy]);
    } else {
      for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
          const on = mask[j * G + i];
          blocks.push([i * FIX_CELL, j * FIX_CELL, (i + 1) * FIX_CELL, (j + 1) * FIX_CELL, on ? ox : 0, on ? oy : 0]);
        }
      }
    }

    // 要用到哪些原图：相对本瓦片的 [列偏移, 行偏移]。未纠偏的小块用本瓦片，纠偏的小块用偏移后落到的 1~4 张
    const need = [];
    const seen = new Set();
    for (const [u0, v0, u1, v1, sx, sy] of blocks) {
      for (let b = Math.floor((v0 + sy) / FIX_UNIT); b <= Math.floor((v1 - 1 + sy) / FIX_UNIT); b++) {
        for (let a = Math.floor((u0 + sx) / FIX_UNIT); a <= Math.floor((u1 - 1 + sx) / FIX_UNIT); a++) {
          const key = a + ',' + b;
          if (!seen.has(key)) {
            seen.add(key);
            need.push([a, b]);
          }
        }
      }
    }
    return { blocks, need };
  }

  /* 拼图优先交给后台线程（js/label-worker.js），主线程不停顿；浏览器不支持时退回到在主线程用画布拼 */
  let bitmapOptionsOk = false;
  C.Resource.supportsImageBitmapOptions().then((ok) => {
    bitmapOptionsOk = !!ok;
  });
  let fixWorker = null;
  let fixWorkerBroken = false;
  let fixSeq = 0;
  const fixJobs = new Map();

  function canUseWorker() {
    return bitmapOptionsOk && !fixWorkerBroken && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
  }

  function composeInWorker(urls, blocks, redo) {
    if (!fixWorker) {
      fixWorker = new Worker('js/label-worker.js');
      fixWorker.onmessage = (e) => {
        const job = fixJobs.get(e.data.id);
        if (!job) return;
        fixJobs.delete(e.data.id);
        if (e.data.bitmap) job.resolve(e.data.bitmap);
        else job.reject(new Error(e.data.error));
      };
      fixWorker.onerror = () => {
        // 后台线程起不来：改回主线程拼图，已经排队的也重做
        fixWorkerBroken = true;
        fixWorker = null;
        const jobs = Array.from(fixJobs.values());
        fixJobs.clear();
        for (const job of jobs) job.redo().then(job.resolve, job.reject);
      };
    }
    return new Promise((resolve, reject) => {
      const id = ++fixSeq;
      fixJobs.set(id, { resolve, reject, redo });
      fixWorker.postMessage({ id, urls, blocks });
    });
  }

  function tileUrl(def, x, y, level) {
    if (def._proxy) return def._proxy + level + '/' + x + '/' + y;
    const subs = def.subdomains || [''];
    return def.url
      .replace('{s}', subs[(x + y + level) % subs.length])
      .replace('{x}', x)
      .replace('{y}', y)
      .replace('{z}', level);
  }

  function withMainlandFix(load, def) {
    const pending = new Map(); // 相邻瓦片会用到同一张原图，这里去重并短暂保留
    function source(x, y, level) {
      const key = level + '/' + x + '/' + y;
      let p = pending.get(key);
      if (!p) {
        p = Promise.resolve(load(x, y, level)).then(
          (img) => img || null,
          () => {
            pending.delete(key);
            return null;
          }
        );
        pending.set(key, p);
        if (pending.size > 64) pending.delete(pending.keys().next().value);
      }
      return p;
    }

    function composeHere(plan, tiles) {
      const keys = Object.keys(tiles);
      return Promise.all(keys.map((k) => source(tiles[k][0], tiles[k][1], tiles[k][2]))).then((imgs) => {
        const got = new Map();
        keys.forEach((k, i) => imgs[i] && got.set(k, imgs[i]));
        if (!got.size) throw new Error('注记瓦片加载失败');

        const size = got.values().next().value.width;
        const k = size / FIX_UNIT;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;

        for (const [u0, v0, u1, v1, sx, sy] of plan.blocks) {
          for (let b = Math.floor((v0 + sy) / FIX_UNIT); b <= Math.floor((v1 - 1 + sy) / FIX_UNIT); b++) {
            for (let a = Math.floor((u0 + sx) / FIX_UNIT); a <= Math.floor((u1 - 1 + sx) / FIX_UNIT); a++) {
              const img = got.get(a + ',' + b);
              if (!img) continue;
              const du0 = Math.max(u0, a * FIX_UNIT - sx);
              const du1 = Math.min(u1, (a + 1) * FIX_UNIT - sx);
              const dv0 = Math.max(v0, b * FIX_UNIT - sy);
              const dv1 = Math.min(v1, (b + 1) * FIX_UNIT - sy);
              const w = (du1 - du0) * k;
              const h = (dv1 - dv0) * k;
              const srcX = (du0 + sx - a * FIX_UNIT) * k;
              const srcY = (dv0 + sy - b * FIX_UNIT) * k;
              if (isFlipped(img)) {
                ctx.setTransform(1, 0, 0, -1, 0, 0);
                ctx.drawImage(img, srcX, img.height - srcY - h, w, h, du0 * k, -(dv0 * k + h), w, h);
              } else {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.drawImage(img, srcX, srcY, w, h, du0 * k, dv0 * k, w, h);
              }
            }
          }
        }
        return canvas;
      });
    }

    return function (x, y, level, request) {
      const plan = planMainlandFix(x, y, level);
      if (!plan) return load(x, y, level, request);

      const n = Math.pow(2, level);
      const tiles = {}; // "列偏移,行偏移" -> [x, y, level]
      for (const [a, b] of plan.need) {
        if (y + b >= 0 && y + b < n) tiles[a + ',' + b] = [(((x + a) % n) + n) % n, y + b, level];
      }
      if (!canUseWorker()) return composeHere(plan, tiles);

      const urls = {};
      for (const key in tiles) urls[key] = tileUrl(def, tiles[key][0], tiles[key][1], level);
      return composeInWorker(urls, plan.blocks, () => composeHere(plan, tiles));
    };
  }

  /* 把 GCJ-02 瓦片摆回 WGS-84 位置的瓦片方案（高德用：它的影像和注记全部带偏移） */
  class GCJ02TilingScheme extends C.WebMercatorTilingScheme {
    constructor(options) {
      super(options);
      const merc = new C.WebMercatorProjection();
      this._projection.project = function (cartographic, result) {
        const g = wgs2gcj(C.Math.toDegrees(cartographic.longitude), C.Math.toDegrees(cartographic.latitude));
        const p = merc.project(new C.Cartographic(C.Math.toRadians(g[0]), C.Math.toRadians(g[1])));
        if (!result) return new C.Cartesian3(p.x, p.y, 0);
        result.x = p.x;
        result.y = p.y;
        return result;
      };
      this._projection.unproject = function (cartesian, result) {
        const c = merc.unproject(cartesian);
        const w = gcj2wgs(C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude));
        if (!result) return new C.Cartographic(C.Math.toRadians(w[0]), C.Math.toRadians(w[1]), 0);
        result.longitude = C.Math.toRadians(w[0]);
        result.latitude = C.Math.toRadians(w[1]);
        result.height = 0;
        return result;
      };
    }
  }

  /* ---------- 影像源管理 ---------- */
  const M = (GE.imagery = {
    viewer: null,
    mode: 'auto', // 'auto' 或某个影像源 id
    activeId: null,
    baseLayer: null,
    satLayer: null,
    labelLayer: null,
    gridLayer: null,
    labelsVisible: true,
    status: {}, // id -> 'unknown' | 'ok' | 'down'
    stats: {}, // id -> { ok, err, recent: [[时间, 是否成功]] }
    totalTiles: 0,
  });

  function byId(id) {
    return GE.sources.find((s) => s.id === id);
  }
  M.byId = byId;

  function statOf(id) {
    return M.stats[id] || (M.stats[id] = { ok: 0, err: 0, recent: [] });
  }

  function setStatus(id, status) {
    if (M.status[id] === status) return;
    M.status[id] = status;
    GE.bus.emit('imagery:status', { id, status });
  }

  function pushRecent(st, ok) {
    st.recent.push([performance.now(), ok]);
    if (st.recent.length > 400) st.recent.splice(0, 200);
  }

  function createProvider(def, kind, src) {
    // 瓦片统一走本地 server 的缓存代理：/tiles/<源>/<类型>/<z>/<x>/<y>。
    // server 命中本地缓存直接返回（断网/无梯子也可用），未命中则抓上游并落盘。
    const proxyBase = '/tiles/' + src.id + '/' + kind + '/';
    const def2 = Object.assign({}, def, { url: proxyBase + '{z}/{x}/{y}', subdomains: [], _proxy: proxyBase });
    const provider = new C.UrlTemplateImageryProvider({
      url: def2.url,
      subdomains: def2.subdomains,
      minimumLevel: 0,
      maximumLevel: def2.maximumLevel,
      tilingScheme: def2.gcj02 === true ? new GCJ02TilingScheme() : new C.WebMercatorTilingScheme(),
      // 声明为 256：scale=2 的瓦片实际是 512 像素，相当于每个屏幕像素有 2 倍采样，画面更锐利
      tileWidth: 256,
      tileHeight: 256,
      hasAlphaChannel: kind !== 'sat',
      enablePickFeatures: false,
      credit: kind === 'sat' ? src.credit : undefined,
    });

    const st = statOf(src.id);
    const direct = provider.requestImage.bind(provider);
    const original = def2.gcj02 === 'mainland' && GE.region ? withMainlandFix(direct, def2) : direct;
    provider.requestImage = function (x, y, level, request) {
      const p = original(x, y, level, request);
      if (p && typeof p.then === 'function') {
        p.then(
          () => {
            st.ok++;
            M.totalTiles++;
            pushRecent(st, 1);
          },
          () => {}
        );
      }
      return p;
    };
    provider.errorEvent.addEventListener(() => {
      st.err++;
      pushRecent(st, 0);
      if (kind === 'sat') onTileError(src.id);
    });
    return provider;
  }

  async function probe(id) {
    const src = byId(id);
    if (!src) return false;
    if (src.local) return M.status[id] === 'ok';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.probeTimeout);
    let ok = false;
    try {
      const res = await fetch('/tiles/' + id + '/sat/3/6/3', { cache: 'no-store', signal: ctrl.signal });
      if (res.ok) {
        const blob = await res.blob();
        ok = blob.size > 100 && /^image\//.test(blob.type || '');
      }
    } catch (e) {
      ok = false;
    }
    clearTimeout(timer);
    setStatus(id, ok ? 'ok' : 'down');
    return ok;
  }
  M.probe = probe;

  function apply(id, reason) {
    const src = byId(id);
    const layers = M.viewer.imageryLayers;
    const previous = M.activeId;
    if (previous === id && (src.local || M.satLayer)) return;

    if (M.satLayer) { layers.remove(M.satLayer, true); M.satLayer = null; }
    if (M.labelLayer) { layers.remove(M.labelLayer, true); M.labelLayer = null; }
    M.activeId = id;

    if (!src.local) {
      const at = M.baseLayer ? layers.indexOf(M.baseLayer) + 1 : 0;
      M.satLayer = layers.addImageryProvider(createProvider(src.sat, 'sat', src), at);
      if (src.labels) {
        M.labelLayer = layers.addImageryProvider(createProvider(src.labels, 'labels', src), at + 1);
        M.labelLayer.show = M.labelsVisible;
      }
    }
    GE.bus.emit('imagery:change', { id, previous, reason: reason || 'auto', source: src });
  }

  /* 按当前模式选择影像源：自动模式按优先级探测，手动模式直接使用所选的 */
  let refreshing = null;
  M.refresh = function (reason) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (M.mode !== 'auto') {
        const ok = await probe(M.mode);
        apply(M.mode, ok ? 'manual' : 'manual-unreachable');
        return;
      }
      const online = GE.sources.filter((s) => !s.local);
      const probes = online.map((s) => probe(s.id));
      for (let i = 0; i < online.length; i++) {
        if (await probes[i]) {
          apply(online[i].id, reason);
          return;
        }
      }
      apply('bluemarble', reason || 'all-down');
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  /* 运行中瓦片大面积失败时复测，确认不可用才降级（个别高层级缺图不算故障） */
  let verifying = false;
  let lastVerify = 0;
  async function onTileError(id) {
    if (id !== M.activeId || verifying) return;
    const st = statOf(id);
    const t = performance.now();
    st.recent = st.recent.filter((r) => t - r[0] < cfg.degrade.windowMs);
    const errs = st.recent.filter((r) => !r[1]).length;
    // 两种情况都去复测：窗口期内大部分请求失败；或者最近一次成功之后已经连续失败多次
    // （刚才还正常、突然断掉时，窗口里还留着大量成功记录，只看占比会迟迟不触发）
    let streak = 0;
    for (let i = st.recent.length - 1; i >= 0 && !st.recent[i][1]; i--) streak++;
    const mostlyFailing = errs >= cfg.degrade.minErrors && errs / st.recent.length >= cfg.degrade.errorRatio;
    if (!mostlyFailing && streak < cfg.degrade.minErrors) return;
    if (t - lastVerify < 3000) return;
    lastVerify = t;

    verifying = true;
    const ok = await probe(id);
    verifying = false;
    st.recent = [];
    if (ok || id !== M.activeId) return;

    if (M.mode === 'auto') {
      await M.refresh('degrade');
    } else {
      GE.bus.emit('imagery:unreachable', { id, source: byId(id) });
    }
  }

  /* 自动模式下定期尝试回升到优先级更高的影像源 */
  async function recheck() {
    if (M.mode !== 'auto' || document.hidden || refreshing) return;
    const order = GE.sources.filter((s) => !s.local).map((s) => s.id);
    const idx = order.indexOf(M.activeId);
    const higher = idx < 0 ? order : order.slice(0, idx);
    for (const id of higher) {
      if (await probe(id)) {
        if (M.mode === 'auto') apply(id, 'recover');
        return;
      }
    }
  }

  M.setMode = function (mode) {
    if (mode !== 'auto' && !byId(mode)) return Promise.resolve();
    M.mode = mode;
    GE.store.set('imageryMode', mode);
    GE.bus.emit('imagery:mode', { mode });
    return M.refresh(mode === 'auto' ? 'auto' : 'manual');
  };

  M.setLabelsVisible = function (on) {
    M.labelsVisible = !!on;
    GE.store.set('labels', M.labelsVisible);
    if (M.labelLayer) M.labelLayer.show = M.labelsVisible;
  };

  M.setGrid = function (on) {
    const layers = M.viewer.imageryLayers;
    if (on && !M.gridLayer) {
      M.gridLayer = layers.addImageryProvider(
        new C.GridImageryProvider({
          cells: 4,
          color: C.Color.fromCssColorString('#ffe9a8').withAlpha(0.55),
          glowColor: C.Color.TRANSPARENT,
          glowWidth: 0,
          backgroundColor: C.Color.TRANSPARENT,
          tilingScheme: new C.GeographicTilingScheme(),
        })
      );
    } else if (!on && M.gridLayer) {
      layers.remove(M.gridLayer, true);
      M.gridLayer = null;
    }
  };

  M.init = async function (viewer) {
    M.viewer = viewer;
    GE.sources.forEach((s) => { M.status[s.id] = 'unknown'; });

    const savedMode = GE.store.get('imageryMode', 'auto');
    M.mode = savedMode === 'auto' || byId(savedMode) ? savedMode : 'auto';
    M.labelsVisible = GE.store.get('labels', true) !== false;

    const local = byId('bluemarble');
    try {
      const provider = await C.SingleTileImageryProvider.fromUrl(local.url, { credit: local.credit });
      M.baseLayer = viewer.imageryLayers.addImageryProvider(provider, 0);
      setStatus('bluemarble', 'ok');
    } catch (e) {
      setStatus('bluemarble', 'down');
      console.warn('[GE] 本地蓝色大理石底图加载失败', e);
    }

    await M.refresh('startup');
    setInterval(recheck, cfg.recheckInterval);
    window.addEventListener('online', () => { M.refresh('online'); });
  };

  /* ---------- 地形（可选） ---------- */
  const T = (GE.terrain = { enabled: false, provider: null, loading: null });

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
  }
  GE.withTimeout = withTimeout;

  T.setEnabled = async function (on) {
    const viewer = M.viewer;
    if (!on) {
      T.enabled = false;
      viewer.terrainProvider = new C.EllipsoidTerrainProvider();
      GE.store.set('terrain', false);
      GE.bus.emit('terrain:change', { enabled: false });
      return true;
    }
    try {
      if (!T.provider) {
        T.loading = T.loading || withTimeout(C.ArcGISTiledElevationTerrainProvider.fromUrl(cfg.terrainUrl), 8000);
        T.provider = await T.loading;
      }
      viewer.terrainProvider = T.provider;
      T.enabled = true;
      GE.store.set('terrain', true);
      GE.bus.emit('terrain:change', { enabled: true });
      return true;
    } catch (e) {
      T.loading = null;
      T.enabled = false;
      GE.bus.emit('terrain:change', { enabled: false, failed: true });
      return false;
    }
  };

  /* 查询某点的地面高程（米）。地形关闭或查询超时返回 0。 */
  T.heightAt = async function (lonDeg, latDeg, timeoutMs) {
    if (!T.enabled || !T.provider) return 0;
    try {
      const carto = C.Cartographic.fromDegrees(lonDeg, latDeg);
      const out = await withTimeout(C.sampleTerrain(T.provider, 11, [carto]), timeoutMs || 800);
      const h = out && out[0] && out[0].height;
      return Number.isFinite(h) ? h : 0;
    } catch (e) {
      return 0;
    }
  };
})();
