// 实验：同一张瓦片用不同参数请求高德注记图层，存成图片以便比较能拆出哪些子图层。
// 用法：node tools/label-exp.mjs <输出目录> [z x y]
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'tools/data/labels';
const z = Number(process.argv[3] || 16);
const x = Number(process.argv[4] || 53957);
const y = Number(process.argv[5] || 24832);
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (/\.(png|jpg|txt)$/.test(f)) fs.unlinkSync(path.join(outDir, f));

const W = `https://wprd01.is.autonavi.com/appmaptile?lang=zh_cn&x=${x}&y=${y}&z=${z}`;
const S = `https://webst01.is.autonavi.com/appmaptile?x=${x}&y=${y}&z=${z}`;
const variants = {
  '01-wprd-s8-scl1': W + '&size=1&scl=1&style=8',
  '02-wprd-s8-scl2': W + '&size=1&scl=2&style=8',
  '03-wprd-s8-lt1': W + '&size=1&scl=1&style=8&ltype=1',
  '04-wprd-s8-lt2': W + '&size=1&scl=1&style=8&ltype=2',
  '05-wprd-s8-lt3': W + '&size=1&scl=1&style=8&ltype=3',
  '06-wprd-s8-lt4': W + '&size=1&scl=1&style=8&ltype=4',
  '07-wprd-s8-lt5': W + '&size=1&scl=1&style=8&ltype=5',
  '08-wprd-s8-lt6': W + '&size=1&scl=1&style=8&ltype=6',
  '09-wprd-s8-lt7': W + '&size=1&scl=1&style=8&ltype=7',
  '10-wprd-s8-lt8': W + '&size=1&scl=1&style=8&ltype=8',
  '11-wprd-s8-lt11': W + '&size=1&scl=1&style=8&ltype=11',
  '12-wprd-s8-size2': W + '&size=2&scl=1&style=8',
  '13-wprd-s8-scl2-lt2': W + '&size=1&scl=2&style=8&ltype=2',
  '14-wprd-s8-scl2-lt4': W + '&size=1&scl=2&style=8&ltype=4',
  '15-wprd-s7-scl1': W + '&size=1&scl=1&style=7',
  '16-wprd-s7-lt4': W + '&size=1&scl=1&style=7&ltype=4',
  '17-webst-s8': S + '&style=8',
  '18-webst-s8-lt2': S + '&style=8&ltype=2',
  '19-webst-s8-lt4': S + '&style=8&ltype=4',
  '20-webst-s8-scale2': S + '&style=8&scale=2',
};

function get(name, url) {
  return new Promise((resolve) => {
    const file = path.join(outDir, name + '.png');
    execFile('curl.exe', ['-s', '-m', '10', '--noproxy', '*', '-o', file, '-w', '%{http_code} %{size_download} %{content_type}', url], { timeout: 15000 }, (err, stdout) => {
      resolve(`${name.padEnd(22)} ${(stdout || '').trim()}${err ? ' [curl ' + (err.code || err.message) + ']' : ''}`);
    });
  });
}
const rows = await Promise.all(Object.entries(variants).map(([n, u]) => get(n, u)));
console.log(rows.join('\n'));
