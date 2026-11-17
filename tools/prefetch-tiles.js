'use strict';
/*
 * 重点城市瓦片预抓取脚本（零第三方依赖）。
 * 复用了 server-tiles.js 的抓取与缓存逻辑：已有缓存自动跳过（断点续传），
 * 未命中则抓上游（google 走系统代理）落盘到 data/tiles/，并统计新下载体积、
 * 在预算（默认 500GB）内安全停止。
 *
 * 用法：
 *   node tools/prefetch-tiles.js                      # 抓全部城市，预算 500GB
 *   node tools/prefetch-tiles.js --budget 50          # 预算 50GB
 *   node tools/prefetch-tiles.js --city 纽约           # 只抓某个城市（名字含关键字即匹配）
 *   node tools/prefetch-tiles.js --source gaode       # 换影像源（google|gaode|esri）
 *   node tools/prefetch-tiles.js --dry-run            # 只估算瓦片数与体积，不真抓
 *   node tools/prefetch-tiles.js --maxlevel 18        # 全局调高最大层级
 */
const path = require('path');
const tiles = require('../server-tiles.js');

/* ---------- 参数解析 ---------- */
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) { args[k] = next; i++; }
    else args[k] = true;
  }
}
const SOURCE = args.source || 'google';
const BUDGET_GB = parseFloat(args.budget || '500');
const BUDGET_BYTES = BUDGET_GB * 1024 * 1024 * 1024;
const CONCURRENCY = parseInt(args.concurrency || '16', 10);
const DRY_RUN = !!args['dry-run'];
const CITY_FILTER = args.city;
const GLOBAL_MAXLEVEL = parseInt(args.maxlevel || '0', 10) || 0; // 0 = 用各城市自己的层级

const dataDir = path.join(__dirname, '..', 'data');

/* ---------- 重点城市 / 世界著名地标 ----------
   名字, 纬度, 经度, 半径(km), 最大层级, 说的都是 google 瓦片（XYZ，y 顶=0） */
const CITIES = [
  ['纽约', 40.7128, -74.0060, 12, 17],
  ['自由女神像', 40.6892, -74.0445, 3, 18],
  ['巴黎·埃菲尔铁塔', 48.8584, 2.2945, 12, 17],
  ['伦敦', 51.5074, -0.1278, 12, 17],
  ['罗马·斗兽场', 41.8902, 12.4922, 8, 17],
  ['威尼斯', 45.4408, 12.3155, 6, 17],
  ['巴塞罗那·圣家堂', 41.4036, 2.1744, 8, 17],
  ['伊斯坦布尔·圣索菲亚', 41.0086, 28.9802, 10, 17],
  ['莫斯科·红场', 55.7539, 37.6208, 10, 16],
  ['吉萨金字塔', 29.9792, 31.1342, 4, 18],
  ['开罗', 30.0444, 31.2357, 12, 16],
  ['迪拜·哈利法塔', 25.1972, 55.2744, 10, 17],
  ['泰姬陵', 27.1751, 78.0421, 4, 18],
  ['吴哥窟', 13.4125, 103.8670, 5, 17],
  ['东京', 35.6762, 139.6503, 14, 17],
  ['悉尼·歌剧院', 33.8568, 151.2153, 10, 17],
  ['旧金山·金门大桥', 37.8199, -122.4783, 12, 17],
  ['大峡谷', 36.1069, -112.1129, 8, 16],
  ['里约·基督像', -22.9519, -43.2105, 10, 17],
  ['马丘比丘', -13.1631, -72.5450, 5, 17],
  ['珠穆朗玛峰', 27.9881, 86.9250, 6, 16],
  ['新加坡', 1.3521, 103.8198, 10, 17],
  ['香港', 22.3193, 114.1694, 12, 17],
  ['上海', 31.2304, 121.4737, 18, 16],
  ['北京·天安门', 39.9042, 116.4074, 14, 16],
  ['西安·兵马俑', 34.3841, 109.2785, 6, 17],
  ['拉萨·布达拉宫', 29.6578, 91.1169, 8, 16],
  ['桂林·漓江', 24.7764, 110.4815, 10, 16],
  ['张家界', 29.1171, 110.4790, 8, 16],
  ['杭州·西湖', 30.2455, 120.1450, 8, 16],
].map(([name, lat, lon, radiusKm, maxLevel]) => ({
  name, lat, lon, radiusKm,
  maxLevel: GLOBAL_MAXLEVEL || maxLevel,
}));

/* ---------- Web Mercator 瓦片范围（XYZ，y 顶=0，与 google/gaode/esri 一致） ---------- */
const DEG_PER_KM = 1 / 111.32;

function mercX(lon, n) { return ((lon + 180) / 360) * n; }
function mercY(lat, n) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function tileRange(city, z) {
  const n = Math.pow(2, z);
  const dLat = city.radiusKm * DEG_PER_KM;
  const dLon = city.radiusKm * DEG_PER_KM / Math.max(0.3, Math.cos((city.lat * Math.PI) / 180));
  let x0 = Math.floor(mercX(city.lon - dLon, n));
  let x1 = Math.floor(mercX(city.lon + dLon, n));
  let y0 = Math.floor(mercY(city.lat + dLat, n)); // 北 = 较小的 y
  let y1 = Math.floor(mercY(city.lat - dLat, n));
  // 跨日期线（本例城市都不在两侧，兜底）
  if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
  if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
  // radius 小于一块瓦片时至少保证中心那块
  const cx = Math.floor(mercX(city.lon, n));
  const cy = Math.floor(mercY(city.lat, n));
  x0 = clamp(Math.min(x0, cx), 0, n - 1);
  x1 = clamp(Math.max(x1, cx), 0, n - 1);
  y0 = clamp(Math.min(y0, cy), 0, n - 1);
  y1 = clamp(Math.max(y1, cy), 0, n - 1);
  return { n, x0, x1, y0, y1 };
}

/* ---------- 估算每块瓦片体积（用于 dry-run / 预统计） ---------- */
const EST_BYTES_PER_TILE = { sat: 20000, labels: 12000 };

function estimate() {
  let total = 0;
  for (const city of CITIES) {
    let cityTiles = 0;
    for (let z = 3; z <= city.maxLevel; z++) {
      const r = tileRange(city, z);
      const cnt = (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
      cityTiles += cnt;
      total += cnt * (EST_BYTES_PER_TILE.sat + EST_BYTES_PER_TILE.labels);
    }
    console.log(`  ${city.name.padEnd(14, '　')} z3–z${city.maxLevel} 约 ${cityTiles.toLocaleString()} 块瓦片（sat+labels 合计约 ${(cityTiles * 32000 / 1048576).toFixed(0)} MB）`);
  }
  console.log(`\n估算总量：${(total / 1073741824).toFixed(2)} GB（sat+labels，按均值估算，实际有出入）`);
  return total;
}

/* ---------- 生成任务 ---------- */
function buildTasks() {
  const tasks = [];
  for (const city of CITIES) {
    if (CITY_FILTER && !city.name.includes(CITY_FILTER)) continue;
    for (let z = 3; z <= city.maxLevel; z++) {
      const r = tileRange(city, z);
      for (let x = r.x0; x <= r.x1; x++) {
        for (let y = r.y0; y <= r.y1; y++) {
          tasks.push({ city: city.name, source: SOURCE, kind: 'sat', z, x, y });
          tasks.push({ city: city.name, source: SOURCE, kind: 'labels', z, x, y });
        }
      }
    }
  }
  return tasks;
}

/* ---------- 抓取（并发池） ---------- */
async function run() {
  const tasks = buildTasks();
  console.log(`\n共 ${tasks.length.toLocaleString()} 个瓦片任务，并发 ${CONCURRENCY}，预算 ${BUDGET_GB}GB，源=${SOURCE}`);
  if (!tasks.length) { console.log('没有匹配的任务。'); return; }

  let next = 0;
  let done = 0;
  let missBytes = 0;
  let hitCount = 0;
  let errorCount = 0;
  let stopped = false;
  const t0 = Date.now();

  function tick() {
    const el = (Date.now() - t0) / 1000;
    const rate = Math.round(done / Math.max(1, el));
    process.stdout.write(
      `\r  进度 ${done.toLocaleString()}/${tasks.length.toLocaleString()}  ` +
      `新增 ${(missBytes / 1073741824).toFixed(2)}GB  ` +
      `命中 ${hitCount.toLocaleString()}  失败 ${errorCount}  ${rate} 块/s   ` + '       '
    );
  }

  async function worker() {
    while (true) {
      if (stopped) return;
      const i = next++;
      if (i >= tasks.length) return;
      const t = tasks[i];
      try {
        const r = await tiles.fetchTile(t.source, t.kind, t.z, t.x, t.y);
        if (r.cache === 'HIT') hitCount++;
        else { missBytes += r.bytes; }
      } catch (e) {
        errorCount++;
      }
      done++;
      if (missBytes >= BUDGET_BYTES) {
        stopped = true;
        console.log(`\n\n已达到预算 ${BUDGET_GB}GB，停止。`);
      }
      if (done % 200 === 0) tick();
    }
  }

  const pool = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker);
  await Promise.all(pool);
  tick();
  const el = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n\n完成。用时 ${el}s，共新增缓存 ${(missBytes / 1073741824).toFixed(3)}GB，命中 ${hitCount}，失败 ${errorCount}（失败多为高层级缺图，正常）。`);
  console.log(`缓存目录：${tiles.cacheRoot()}`);
}

/* ---------- 入口 ---------- */
async function main() {
  console.log('重点城市瓦片预抓取 —— 源=' + SOURCE + '，预算=' + BUDGET_GB + 'GB');
  tiles.init({ dataDir });
  if (DRY_RUN) { estimate(); return; }
  estimate();
  await run();
}
main().catch((e) => { console.error('\n出错：', e); process.exit(1); });