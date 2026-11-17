// 把 js/region.js 的判断结果打印成字符图，排查边界用。
// 用法：node tools/map-region.mjs <西> <南> <东> <北> [列数=100] [行数=40]   # 表示纠偏，. 表示不纠偏
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = { window: {}, Math, Array, Infinity, NaN, console };
ctx.window = ctx;
ctx.GE = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('js/region-cn.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('js/region.js', 'utf8'), ctx);
const inMainland = ctx.GE.region.inMainland;

const [w, s, e, n] = process.argv.slice(2, 6).map(Number);
const cols = +process.argv[6] || 100;
const rows = +process.argv[7] || 40;
for (let r = 0; r < rows; r++) {
  const lat = n - ((r + 0.5) / rows) * (n - s);
  let line = '';
  for (let c = 0; c < cols; c++) line += inMainland(w + ((c + 0.5) / cols) * (e - w), lat) ? '#' : '.';
  console.log(lat.toFixed(4) + ' ' + line);
}
