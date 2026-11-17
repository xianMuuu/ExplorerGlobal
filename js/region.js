/* 判断一个 WGS-84 坐标是否落在“Google 注记带偏移”的范围：中国大陆（实测金门也带偏移）及其近海，
   不含香港、澳门、台湾本岛和澎湖。边界数据简化到约 150 米，所以界外 200 米内也算在内。 */
(function () {
  'use strict';
  const data = GE.regionCN;
  const BAND = 0.25; // 纬度分带宽度（度），用来加速大多边形的判断
  const NEAR_KM = 0.2;
  const PAD = 0.01; // 约 1 公里，找边界线段时的外扩量

  // 大陆近海（手工勾画，从鸭绿江口以西到北仑河口以东，含渤海和海南周边）：跨海大桥、小岛的注记和陆地一样带偏移。
  // 前半段是离岸一侧，后半段从内陆绕回起点；港澳水域在判断时先行排除。
  const CN_SEA = [
    123.9, 39.95, 123.9, 39.2, 123.4, 38.7, 122.9, 38.0, 123.0, 37.0, 122.8, 36.0, 121.5, 34.8, 122.3, 32.5,
    123.3, 31.2, 123.3, 30.3, 123.0, 29.4, 122.5, 28.6, 122.0, 27.9, 121.4, 27.0, 120.7, 26.2, 120.2, 25.3,
    119.6, 24.7, 118.9, 24.1, 118.0, 23.4, 117.3, 22.9, 116.3, 22.4, 115.3, 22.0, 114.6, 21.75, 113.2, 21.4,
    112.2, 21.2, 111.3, 20.9, 111.3, 19.9, 111.0, 19.0, 110.4, 18.0, 109.5, 17.9, 108.3, 18.3, 108.3, 19.8,
    108.9, 20.7, 108.2, 21.2, 108.12, 21.3, 108.12, 21.7, 110.0, 22.0, 113.0, 23.0, 116.5, 24.0, 119.0, 26.5,
    120.5, 29.0, 120.5, 32.0, 119.0, 35.0, 117.3, 37.8, 117.3, 39.4, 119.4, 40.2, 121.5, 41.2, 122.6, 40.9,
    123.9, 40.2,
  ];

  function makeRing(a, indexed) {
    const ring = { a, w: Infinity, e: -Infinity, s: Infinity, n: -Infinity, bands: null, band0: 0 };
    for (let i = 0; i < a.length; i += 2) {
      if (a[i] < ring.w) ring.w = a[i];
      if (a[i] > ring.e) ring.e = a[i];
      if (a[i + 1] < ring.s) ring.s = a[i + 1];
      if (a[i + 1] > ring.n) ring.n = a[i + 1];
    }
    if (indexed) {
      ring.band0 = Math.floor(ring.s / BAND);
      const count = Math.floor(ring.n / BAND) - ring.band0 + 1;
      ring.bands = Array.from({ length: count }, () => []);
      for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
        const lo = Math.floor(Math.min(a[i + 1], a[j + 1]) / BAND) - ring.band0;
        const hi = Math.floor(Math.max(a[i + 1], a[j + 1]) / BAND) - ring.band0;
        for (let b = lo; b <= hi; b++) ring.bands[b].push(j, i);
      }
    }
    return ring;
  }

  function crosses(a, i, j, x, y) {
    const yi = a[i + 1];
    const yj = a[j + 1];
    return yi > y !== yj > y && x < ((a[j] - a[i]) * (y - yi)) / (yj - yi) + a[i];
  }

  function contains(ring, x, y) {
    if (x < ring.w || x > ring.e || y < ring.s || y > ring.n) return false;
    const a = ring.a;
    let inside = false;
    if (ring.bands) {
      const list = ring.bands[Math.floor(y / BAND) - ring.band0];
      if (!list) return false;
      for (let k = 0; k < list.length; k += 2) if (crosses(a, list[k + 1], list[k], x, y)) inside = !inside;
    } else {
      for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) if (crosses(a, i, j, x, y)) inside = !inside;
    }
    return inside;
  }

  /* 点到线段的距离平方（平方公里） */
  function segDist2(a, i, j, x, y, kx, ky) {
    const ax = (a[i] - x) * kx;
    const ay = (a[i + 1] - y) * ky;
    const bx = (a[j] - x) * kx;
    const by = (a[j + 1] - y) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx;
    const py = ay + t * dy;
    return px * px + py * py;
  }

  function ringDist2(ring, x, y, kx, ky) {
    const a = ring.a;
    let best = Infinity;
    if (ring.bands) {
      const lo = Math.max(0, Math.floor((y - PAD) / BAND) - ring.band0);
      const hi = Math.min(ring.bands.length - 1, Math.floor((y + PAD) / BAND) - ring.band0);
      for (let b = lo; b <= hi; b++) {
        const list = ring.bands[b];
        for (let k = 0; k < list.length; k += 2) {
          const d = segDist2(a, list[k + 1], list[k], x, y, kx, ky);
          if (d < best) best = d;
        }
      }
    } else {
      for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
        const d = segDist2(a, i, j, x, y, kx, ky);
        if (d < best) best = d;
      }
    }
    return best;
  }

  let rings = null;
  let hk = null;
  let macau = null;
  let sea = null;
  function prepare() {
    rings = data.mainland.map((a) => makeRing(a, a.length > 400));
    hk = data.hk.map((a) => makeRing(a, a.length > 400));
    macau = data.macau.map((a) => makeRing(a, false));
    sea = makeRing(CN_SEA, false);
  }

  let lastX = NaN;
  let lastY = NaN;
  let last = false;

  function inMainland(x, y) {
    if (!data) return false;
    if (x < 73 || x > 135.6 || y < 17.5 || y > 54) return false;
    if (x === lastX && y === lastY) return last;
    if (!rings) prepare();
    lastX = x;
    lastY = y;
    last = compute(x, y);
    return last;
  }

  function compute(x, y) {
    if (x > 113.5 && x < 114.6 && y > 22.05 && y < 22.6) {
      for (let i = 0; i < hk.length; i++) if (contains(hk[i], x, y)) return false;
      for (let i = 0; i < macau.length; i++) if (contains(macau[i], x, y)) return false;
    }
    for (let i = 0; i < rings.length; i++) if (contains(rings[i], x, y)) return true;
    if (contains(sea, x, y)) return true;

    const kx = Math.cos((y * Math.PI) / 180) * 111.32;
    const ky = 110.57;
    const near2 = NEAR_KM * NEAR_KM;
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      if (x < r.w - PAD || x > r.e + PAD || y < r.s - PAD || y > r.n + PAD) continue;
      if (ringDist2(r, x, y, kx, ky) <= near2) return true;
    }
    return false;
  }

  GE.region = { inMainland };
})();
