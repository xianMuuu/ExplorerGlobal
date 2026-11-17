// 生成 js/region-cn.js：中国范围（大陆、港澳、台湾、海南等较大岛屿）的简化外轮廓。
// 用途：决定一块影像瓦片取国内影像源还是国际影像源，以及矢量地名是否显示。轮廓只简化到约 1 公里，不代表任何边界主张。
// 数据来源：阿里云 DataV 公开的行政边界 tools/data/100000.json（GCJ-02 坐标，先转成 WGS-84 再简化）。
// 用法：node tools/build-region.mjs
import fs from 'node:fs';

const PI = Math.PI, A = 6378245.0, EE = 0.00669342162296594323;
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return r;
}
function tLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return r;
}
function delta(lng, lat) {
  let dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
  const rad = (lat / 180) * PI;
  let m = Math.sin(rad); m = 1 - EE * m * m;
  const s = Math.sqrt(m);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (m * s)) * PI);
  dLng = (dLng * 180) / ((A / s) * Math.cos(rad) * PI);
  return [dLng, dLat];
}
function gcj2wgs([lng, lat]) {
  let wl = lng, wa = lat;
  for (let i = 0; i < 4; i++) { const d = delta(wl, wa); wl = lng - d[0]; wa = lat - d[1]; }
  return [wl, wa];
}

function rings(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const f of j.features) {
    const g = f.geometry;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    for (const p of polys) out.push(p[0].map(gcj2wgs)); // 只取外环
  }
  return out;
}

function stats(r) {
  let area = 0, per = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    area += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    per += Math.hypot(r[i][0] - r[j][0], r[i][1] - r[j][1]);
    cx += r[i][0]; cy += r[i][1];
  }
  return { area: Math.abs(area) / 2, per, cx: cx / r.length, cy: cy / r.length };
}

// Douglas–Peucker 简化（容差单位：度）
function simplify(r, tol) {
  if (r.length < 8) return r;
  const keep = new Uint8Array(r.length);
  keep[0] = keep[r.length - 1] = 1;
  const stack = [[0, r.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, wd = 0;
    const ax = r[a][0], ay = r[a][1], bx = r[b][0], by = r[b][1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let t = len2 ? ((r[i][0] - ax) * dx + (r[i][1] - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(r[i][0] - (ax + t * dx), r[i][1] - (ay + t * dy));
      if (d > wd) { wd = d; worst = i; }
    }
    if (wd > tol) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out = r.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : r;
}

const TOL = 0.008; // 约 0.9 公里
const MIN_AREA = 0.004; // 平方度，约 40 平方公里：更小的岛屿不单列，由国际影像源覆盖
const flat = (r) => r.flatMap((p) => [+p[0].toFixed(4), +p[1].toFixed(4)]);

const all = rings('tools/data/100000.json').map((r) => ({ r, s: stats(r) }));
all.sort((a, b) => b.s.area - a.s.area);
const kept = [];
let dropped = 0;
for (const { r, s } of all) {
  const thin = s.area / (s.per * s.per) < 0.012; // 细长条（海上的断续线段）不是陆地
  if (thin || s.area < MIN_AREA) { dropped++; continue; }
  const last = r[r.length - 1];
  const open = last[0] === r[0][0] && last[1] === r[0][1] ? r.slice(0, -1) : r;
  kept.push({ ring: simplify(open, TOL), s });
}

const body =
  '/* 由 tools/build-region.mjs 生成，请勿手工修改。坐标为 WGS-84，按 [经度, 纬度, 经度, 纬度, …] 排列。\n' +
  '   中国范围（大陆、港澳、台湾及较大岛屿）的简化外轮廓，取自阿里云 DataV 行政边界（转换并简化到约 1 公里）。\n' +
  '   仅用于决定一块影像取国内还是国际影像源，不代表任何边界主张。 */\n' +
  'window.GE = window.GE || {};\n' +
  'GE.regionCN = ' + JSON.stringify({ rings: kept.map((k) => flat(k.ring)) }) + ';\n';
fs.writeFileSync('js/region-cn.js', body);

console.log(JSON.stringify({
  sourceRings: all.length, kept: kept.length, dropped,
  rings: kept.map((k) => ({ points: k.ring.length, areaDeg2: +k.s.area.toFixed(3), center: [+k.s.cx.toFixed(2), +k.s.cy.toFixed(2)] })),
  bytes: body.length,
}));
