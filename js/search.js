/* 搜索：地名解析（坐标 / 离线地名表 / 在线服务）、飞行定位、红色地标与信息卡 */
(function () {
  'use strict';
  const C = Cesium;
  const cfg = GE.config;
  let viewer, scene, cardEl;

  /* ---------- 格式化 ---------- */
  function dms(v, pos, neg) {
    const hemi = v >= 0 ? pos : neg;
    v = Math.abs(v);
    let d = Math.floor(v);
    const mf = (v - d) * 60;
    let m = Math.floor(mf);
    let s = Math.round((mf - m) * 6000) / 100;
    if (s >= 60) { s = 0; m++; }
    if (m >= 60) { m = 0; d++; }
    return d + '°' + String(m).padStart(2, '0') + "'" + s.toFixed(2).padStart(5, '0') + '"' + hemi;
  }
  GE.fmt = {
    latlon(lat, lon) { return dms(lat, '北', '南') + ' ' + dms(lon, '东', '西'); },
    alt(m) {
      if (!Number.isFinite(m)) return '—';
      return Math.abs(m) < 1000 ? Math.round(m) + ' 米' : (m / 1000).toFixed(2) + ' 公里';
    },
    dist(m) {
      if (!Number.isFinite(m)) return '—';
      if (m < 1000) return m.toFixed(m < 100 ? 1 : 0) + ' 米';
      return (m / 1000).toFixed(m < 100000 ? 2 : 0) + ' 公里';
    },
    area(m2) {
      if (!Number.isFinite(m2)) return '—';
      if (m2 < 1e6) return m2.toFixed(0) + ' 平方米';
      return (m2 / 1e6).toFixed(2) + ' 平方公里';
    },
    escape(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
  };

  function svgUrl(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  GE.icons = {
    // 搜索结果：红色水滴形地标
    redPin: svgUrl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="84" viewBox="0 0 30 42">' +
      '<ellipse cx="15" cy="39.5" rx="6" ry="2" fill="#000" opacity=".35"/>' +
      '<path d="M15 1.5C7.8 1.5 2 7.2 2 14.3 2 23.6 13 37 15 39.4 17 37 28 23.6 28 14.3 28 7.2 22.2 1.5 15 1.5z" fill="#ea4335" stroke="#fff" stroke-width="1.6"/>' +
      '<circle cx="15" cy="14.2" r="4.8" fill="#7c1410"/></svg>'
    ),
    // “我的地点”：黄色图钉
    yellowPin: svgUrl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 32 32">' +
      '<ellipse cx="9" cy="29.5" rx="5" ry="1.6" fill="#000" opacity=".35"/>' +
      '<path d="M9 29.5L15.5 17" stroke="#d9d9d9" stroke-width="1.8" stroke-linecap="round"/>' +
      '<path d="M12.5 6.5l11 7.5-2.2 3.6c-.5.8-1.6 1-2.4.5l-7.6-5.1c-.8-.5-1-1.6-.5-2.4z" fill="#fbd23c" stroke="#8a6a00" stroke-width="1"/>' +
      '<path d="M17.5 2.5l10 6.8-2.8 3.6-9.6-6.5z" fill="#ffe36e" stroke="#8a6a00" stroke-width="1"/></svg>'
    ),
  };

  /* ---------- 地名解析 ---------- */
  const S = (GE.search = { results: [], current: null, entity: null, token: 0, lastFlight: null, cardVisible: false });

  function parseCoords(q) {
    const s = q.trim().replace(/，/g, ',');
    const re = /(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*["″]?\s*([NSEW北南东西])/gi;
    const parts = Array.from(s.matchAll(re));
    if (parts.length === 2) {
      let lat, lon;
      parts.forEach((p) => {
        const v = parseInt(p[1], 10) + parseInt(p[2], 10) / 60 + parseFloat(p[3]) / 3600;
        const h = p[4].toUpperCase();
        if (h === 'N' || h === '北') lat = v;
        else if (h === 'S' || h === '南') lat = -v;
        else if (h === 'E' || h === '东') lon = v;
        else lon = -v;
      });
      if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    }
    const m = s.match(/^([+-]?\d{1,3}(?:\.\d+)?)\s*°?\s*([NS北南])?\s*[,\s]\s*([+-]?\d{1,3}(?:\.\d+)?)\s*°?\s*([EW东西])?$/i);
    if (m) {
      let a = parseFloat(m[1]);
      let b = parseFloat(m[3]);
      if (m[2] && /[S南]/i.test(m[2])) a = -a;
      if (m[4] && /[W西]/i.test(m[4])) b = -b;
      let lat = a;
      let lon = b;
      if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) { lat = b; lon = a; }
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    }
    return null;
  }

  async function fetchJSON(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function nominatim(q) {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=zh-CN&q=' + encodeURIComponent(q);
    const data = await fetchJSON(url, 5000);
    return (data || []).map((r) => ({
      name: r.name || String(r.display_name || q).split(',')[0],
      display: r.display_name || '',
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      source: 'OpenStreetMap',
    })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  }

  async function arcgis(q) {
    const url = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&maxLocations=6&langCode=zh&outFields=LongLabel&SingleLine=' + encodeURIComponent(q);
    const data = await fetchJSON(url, 5000);
    return ((data && data.candidates) || []).map((c) => ({
      name: c.address || q,
      display: (c.attributes && c.attributes.LongLabel) || c.address || '',
      lat: c.location && c.location.y,
      lon: c.location && c.location.x,
      source: 'Esri',
    })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  }

  /* 高德地理编码（国内直连、无需梯子）。返回 GCJ-02 坐标，转回 WGS-84。 */
  async function amap(q) {
    const key = cfg.amapKey;
    if (!key) throw new Error('未配置高德 Key');
    const url = 'https://restapi.amap.com/v3/geocode/geo?key=' + encodeURIComponent(key) + '&address=' + encodeURIComponent(q) + '&output=json';
    const data = await fetchJSON(url, 5000);
    const geos = (data && data.geocodes) || [];
    const out = [];
    for (const g of geos) {
      if (!g.location) continue;
      const parts = g.location.split(',');
      if (parts.length !== 2) continue;
      const lon = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const wgs = GE.geo.gcj2wgs(lon, lat);
      out.push({
        name: g.formatted_address || g.province || q,
        display: g.formatted_address || '',
        lat: wgs[1],
        lon: wgs[0],
        source: '高德地图',
      });
    }
    return out;
  }

  /* 离线地名表。exactOnly 为真时只返回名称或别名完全一致的条目。 */
  function local(q, exactOnly) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const scored = [];
    GE.gazetteer.forEach((g) => {
      const name = g[0].toLowerCase();
      const aliases = g[1].toLowerCase();
      let score = 0;
      if (name === s || aliases.split(' ').includes(s) || aliases === s) score = 3;
      else if (!exactOnly && (name.includes(s) || aliases.includes(s))) score = 2;
      else if (!exactOnly && s.includes(name)) score = 1;
      if (score) scored.push({ score, name: g[0], display: g[4], lat: g[2], lon: g[3], source: '离线地名表' });
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 6);
  }

  S.geocode = async function (q) {
    const coords = parseCoords(q);
    if (coords) {
      return {
        results: [{ name: GE.fmt.latlon(coords.lat, coords.lon), display: '坐标位置', lat: coords.lat, lon: coords.lon, source: '坐标' }],
        via: '坐标',
      };
    }
    const exact = local(q, true);
    if (exact.length) return { results: exact, via: '离线地名表' };

    let failures = 0;
    // 高德优先（国内直连、无需梯子，且中文地名更准）；失败再回退 OpenStreetMap / Esri
    const services = [['高德地图', amap], ['OpenStreetMap', nominatim], ['Esri', arcgis]];
    for (const [name, fn] of services) {
      try {
        const r = await fn(q);
        if (r.length) return { results: r, via: name };
      } catch (e) {
        failures++;
      }
    }
    return { results: local(q, false), via: '离线地名表', onlineFailed: failures === services.length };
  };

  /* ---------- 地标与信息卡 ---------- */
  // 地标实体只创建一次、之后反复复用：首次绘制要编译着色器，放在飞行开始时会卡顿一下
  function ensurePin() {
    if (S.entity) return S.entity;
    S.entity = viewer.entities.add({
      id: 'search-pin',
      show: false,
      position: C.Cartesian3.fromDegrees(cfg.home.lon, cfg.home.lat),
      billboard: {
        image: GE.icons.redPin,
        width: 30,
        height: 42,
        verticalOrigin: C.VerticalOrigin.BOTTOM,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
      },
      label: {
        text: ' ',
        font: '600 15px "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
        fillColor: C.Color.WHITE,
        outlineColor: C.Color.fromCssColorString('#1b1b1b'),
        outlineWidth: 4,
        style: C.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: C.HorizontalOrigin.LEFT,
        verticalOrigin: C.VerticalOrigin.CENTER,
        pixelOffset: new C.Cartesian2(20, -24),
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
      },
    });
    return S.entity;
  }

  function showPin(r) {
    const e = ensurePin();
    e.position = C.Cartesian3.fromDegrees(r.lon, r.lat);
    e.label.text = r.name;
    e.show = true;
  }

  /* 启动时在加载遮罩后面把地标画几帧，让着色器提前编译好 */
  function warmUp() {
    return new Promise((resolve) => {
      const e = ensurePin();
      e.label.text = '地标预热';
      e.show = true;
      const started = performance.now();
      let frames = 0;
      let off = null;
      const finish = () => {
        if (!off) return;
        off();
        off = null;
        if (!S.current) e.show = false;
        resolve();
      };
      off = scene.postRender.addEventListener(() => {
        frames++;
        if (frames >= 20 && performance.now() - started >= 350) finish();
      });
      setTimeout(finish, 2500);
    });
  }

  function hideCard() {
    S.cardVisible = false;
    if (cardEl) cardEl.hidden = true;
  }

  function showCard(r) {
    const f = GE.fmt;
    cardEl.innerHTML =
      '<button type="button" class="ic-close" data-act="close" title="关闭">×</button>' +
      '<div class="ic-title">' + f.escape(r.name) + '</div>' +
      (r.display ? '<div class="ic-sub">' + f.escape(r.display) + '</div>' : '') +
      '<div class="ic-coords">' + f.escape(f.latlon(r.lat, r.lon)) + '</div>' +
      '<div class="ic-meta">数据来源：' + f.escape(r.source || '—') + '</div>' +
      '<div class="ic-actions">' +
      '<button type="button" data-act="save">保存到“我的地点”</button>' +
      '<button type="button" data-act="maps">在 Google 地图中查看</button>' +
      '</div><i class="ic-tail"></i>';
    cardEl.hidden = false;
    S.cardVisible = true;
    updateCard();
  }

  const scratchWin = new C.Cartesian2();
  const anchor = { r: null, pos: new C.Cartesian3(), at: 0, shown: null, css: '' };
  let occluder = null;
  function updateCard() {
    if (!S.cardVisible || !S.current) return;
    const r = S.current;
    const now = performance.now();
    // 锚点坐标缓存起来；开了地形时每半秒按地面高度刷新一次
    if (anchor.r !== r || (GE.terrain.enabled && now - anchor.at > 500)) {
      const h = GE.terrain.enabled ? scene.globe.getHeight(C.Cartographic.fromDegrees(r.lon, r.lat)) || 0 : 0;
      C.Cartesian3.fromDegrees(r.lon, r.lat, h, scene.globe.ellipsoid, anchor.pos);
      anchor.r = r;
      anchor.at = now;
    }
    if (!occluder) occluder = new C.EllipsoidalOccluder(scene.globe.ellipsoid, scene.camera.positionWC);
    else occluder.cameraPosition = scene.camera.positionWC;
    const win = occluder.isPointVisible(anchor.pos) ? scene.cartesianToCanvasCoordinates(anchor.pos, scratchWin) : undefined;
    const shown = !!win;
    if (shown !== anchor.shown) {
      anchor.shown = shown;
      cardEl.style.visibility = shown ? 'visible' : 'hidden';
    }
    if (!shown) return;
    const css = 'translate(' + Math.round(win.x) + 'px,' + Math.round(win.y - 48) + 'px) translate(-50%,-100%)';
    if (css !== anchor.css) {
      anchor.css = css;
      cardEl.style.transform = css;
    }
  }

  /* ---------- 飞行定位 ---------- */
  S.goTo = async function (r) {
    S.current = r;
    showPin(r);
    hideCard();
    GE.bus.emit('search:select', r);

    const ground = await GE.terrain.heightAt(r.lon, r.lat, 800);
    if (S.current !== r) return;

    GE.controls.cancelMotion();
    const started = performance.now();
    const outcome = await new Promise((resolve) => {
      viewer.camera.flyTo({
        destination: C.Cartesian3.fromDegrees(r.lon, r.lat, ground + cfg.fly.height),
        orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
        duration: cfg.fly.duration,
        easingFunction: C.EasingFunction.CUBIC_IN_OUT,
        complete: () => resolve('complete'),
        cancel: () => resolve('cancel'),
      });
    });
    S.lastFlight = {
      name: r.name,
      outcome,
      ms: Math.round(performance.now() - started),
      ground,
      cameraHeight: viewer.camera.positionCartographic.height,
    };
    if (S.current === r) showCard(r);
  };

  S.search = async function (q) {
    q = (q || '').trim();
    if (!q) return;
    const token = ++S.token;
    GE.bus.emit('search:start', { q });
    let out;
    try {
      out = await S.geocode(q);
    } catch (e) {
      out = { results: [], via: '—', onlineFailed: true };
    }
    if (token !== S.token) return;
    S.results = out.results;
    GE.bus.emit('search:results', Object.assign({ q }, out));
    if (out.results.length) {
      const history = GE.store.get('history', []).filter((h) => h !== q);
      history.unshift(q);
      GE.store.set('history', history.slice(0, 12));
      await S.goTo(out.results[0]);
    }
  };

  S.clear = function () {
    S.token++;
    S.results = [];
    S.current = null;
    if (S.entity) S.entity.show = false;
    hideCard();
    GE.bus.emit('search:clear');
  };

  S.init = function (v) {
    viewer = v;
    scene = v.scene;
    cardEl = document.getElementById('infocard');
    cardEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || !S.current) return;
      const r = S.current;
      const act = btn.dataset.act;
      if (act === 'close') hideCard();
      else if (act === 'save') {
        GE.places.add({ type: 'placemark', name: r.name, desc: r.display || '', lat: r.lat, lon: r.lon });
        GE.ui.toast('已保存到“我的地点”：' + r.name);
      } else if (act === 'maps') {
        window.open('https://www.google.com/maps/@' + r.lat.toFixed(6) + ',' + r.lon.toFixed(6) + ',17z', '_blank', 'noopener');
      }
    });
    scene.postRender.addEventListener(updateCard);
    S.ready = warmUp();
  };
})();
