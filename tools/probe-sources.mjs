// 探测一组地址在“走系统代理”和“直连”两种情况下是否可达。
// 用法：node tools/probe-sources.mjs [分组名 …]   不带参数则探测全部分组
// 可选：--save <目录>  把响应体存成文件（文件名为 名称-方式.bin）
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROXY = process.env.PROBE_PROXY || 'http://127.0.0.1:7897';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const GROUPS = {
  imagery: {
    'esri-server': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/3/6',
    'esri-services': 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/3/6',
    'esri-clarity': 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/3/3/6',
    'esri-wayback': 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/3/3/6',
    'bing-ecn': 'https://ecn.t0.tiles.virtualearth.net/tiles/a120.jpeg?g=14000',
    'bing-ak': 'https://t0.ssl.ak.tiles.virtualearth.net/tiles/a120.jpeg?g=14000',
    'eox-s2-2016': 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2016_3857/default/g/3/3/6.jpg',
    'gaode-sat': 'https://webst01.is.autonavi.com/appmaptile?style=6&x=6&y=3&z=3',
  },
  services: {
    'overpass-de': 'https://overpass-api.de/api/status',
    'overpass-kumi': 'https://overpass.kumi.systems/api/status',
    'nominatim': 'https://nominatim.openstreetmap.org/status',
    'esri-geocode': 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer?f=json',
    'esri-elevation': 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer?f=json',
  },
};

const args = process.argv.slice(2);
let saveDir = null;
const si = args.indexOf('--save');
if (si >= 0) {
  saveDir = args[si + 1];
  args.splice(si, 2);
  fs.mkdirSync(saveDir, { recursive: true });
}
// 额外的自定义地址：名称=地址
const custom = {};
for (let i = args.length - 1; i >= 0; i--) {
  const m = /^([\w.-]+)=(https?:.+)$/.exec(args[i]);
  if (m) { custom[m[1]] = m[2]; args.splice(i, 1); }
}
if (Object.keys(custom).length) GROUPS.custom = custom;
const wanted = args.length ? args : Object.keys(GROUPS);

function curl(name, url, mode) {
  return new Promise((resolve) => {
    const out = saveDir ? path.join(saveDir, `${name}-${mode}.bin`) : (process.platform === 'win32' ? 'NUL' : '/dev/null');
    const a = ['-s', '-m', '10', '-A', UA, '-H', 'Origin: http://localhost:8093', '-H', 'Referer: http://localhost:8093/', '-o', out, '-w', '%{http_code} %{size_download} %{time_total} %{content_type} cors=%header{access-control-allow-origin}'];
    if (mode === 'proxy') a.push('-x', PROXY); else a.push('--noproxy', '*');
    a.push(url);
    execFile('curl.exe', a, { timeout: 15000 }, (err, stdout) => {
      const [code, size, time, ...ct] = (stdout || '').trim().split(' ');
      resolve({ name, mode, code: code || 'ERR', size: Number(size || 0), time: Number(time || 0), type: ct.join(' '), err: err ? (err.code || err.message) : null });
    });
  });
}

const jobs = [];
for (const g of wanted) {
  const group = GROUPS[g];
  if (!group) { console.log('未知分组：' + g); continue; }
  for (const [name, url] of Object.entries(group)) for (const mode of ['proxy', 'direct']) jobs.push(curl(name, url, mode));
}
const rows = await Promise.all(jobs);
for (const r of rows) {
  console.log(`${r.name.padEnd(16)} ${r.mode.padEnd(6)} ${String(r.code).padEnd(4)} ${String(r.size).padStart(8)} B ${r.time.toFixed(2).padStart(6)} s  ${r.type}${r.err ? '  [curl ' + r.err + ']' : ''}`);
}
