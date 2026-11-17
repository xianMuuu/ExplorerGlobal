/* 高斯模型后台线程：① 把 .ply / .splat 转成内部格式（居中、按重要度排序）；② 按视线方向给点排序。
   内部格式每个点 32 字节：位置 f32×3 | RGBA u8×4 | 缩放 f32×3 | 四元数 u8×4（w,x,y,z）。 */
'use strict';

const SH_C0 = 0.28209479177387814;
const BLOCK = 8 * 1024 * 1024;
const TYPE_SIZE = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

const models = new Map(); // 排序用：模型编号 -> { pos, depth, bucket, count, capacity }
const COUNTS = new Uint32Array(65536);

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.t === 'sort') sortModel(m);
    else if (m.t === 'data') addData(m);
    else if (m.t === 'drop') models.delete(m.id);
    else if (m.t === 'convert') {
      convert(m).catch((err) => self.postMessage({ t: 'error', job: m.job, message: String((err && err.message) || err) }));
    }
  } catch (err) {
    self.postMessage({ t: 'error', id: m.id, job: m.job, message: String((err && err.message) || err) });
  }
};

/* ---------- 排序 ---------- */
function addData(msg) {
  let m = models.get(msg.id);
  if (!m || m.capacity !== msg.capacity) {
    m = { capacity: msg.capacity, count: 0, pos: new Float32Array(msg.capacity * 3), depth: new Float32Array(msg.capacity), bucket: new Uint16Array(msg.capacity) };
    models.set(msg.id, m);
  }
  const src = new Float32Array(msg.buffer, 0, msg.count * 8);
  const pos = m.pos;
  for (let i = 0, s = 0, d = msg.offset * 3; i < msg.count; i++, s += 8, d += 3) {
    pos[d] = src[s];
    pos[d + 1] = src[s + 1];
    pos[d + 2] = src[s + 2];
  }
  m.count = Math.max(m.count, msg.offset + msg.count);
}

// 按眼睛坐标的 z（= a·x + b·y + c·z，常数项不影响顺序）从远到近排：16 位计数排序，线性时间
function sortModel(msg) {
  const m = models.get(msg.id);
  if (!m) return;
  const n = Math.min(msg.count, m.count);
  const order = new Uint32Array(n);
  if (n > 0) {
    const pos = m.pos, depth = m.depth, bucket = m.bucket;
    const a = msg.a, b = msg.b, c = msg.c;
    let min = Infinity, max = -Infinity;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const d = a * pos[j] + b * pos[j + 1] + c * pos[j + 2];
      depth[i] = d;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    const k = 65535 / Math.max(max - min, 1e-12);
    COUNTS.fill(0);
    for (let i = 0; i < n; i++) {
      const q = ((depth[i] - min) * k) | 0;
      bucket[i] = q;
      COUNTS[q]++;
    }
    // 眼睛坐标里越远 z 越小，所以升序就是由远到近
    let sum = 0;
    for (let q = 0; q < 65536; q++) {
      const t = COUNTS[q];
      COUNTS[q] = sum;
      sum += t;
    }
    for (let i = 0; i < n; i++) order[COUNTS[bucket[i]]++] = i;
  }
  self.postMessage({ t: 'order', id: msg.id, seq: msg.seq, count: n, order }, [order.buffer]);
}

/* ---------- 格式转换 ---------- */
function progress(job, phase, done, total) {
  self.postMessage({ t: 'progress', job, phase, done, total });
}

function byte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// 读入阶段的输出：已是内部格式，但还没有排序和居中
function makeRaw(total) {
  const buf = new ArrayBuffer(total * 32);
  return { total, n: 0, buf, F: new Float32Array(buf), U: new Uint8Array(buf), imp: new Float32Array(total) };
}

// 写入一个点；位置或尺寸不是有限数、或几乎全透明的点丢弃
function put(raw, x, y, z, r, g, b, a, s0, s1, s2, q0, q1, q2, q3) {
  if (!(a >= 3) || !Number.isFinite(x + y + z + s0 + s1 + s2)) return;
  const i = raw.n++;
  const o = i * 8, u = i * 32;
  const F = raw.F, U = raw.U;
  F[o] = x; F[o + 1] = y; F[o + 2] = z;
  U[u + 12] = r; U[u + 13] = g; U[u + 14] = b; U[u + 15] = a;
  F[o + 4] = s0; F[o + 5] = s1; F[o + 6] = s2;
  U[u + 28] = q0; U[u + 29] = q1; U[u + 30] = q2; U[u + 31] = q3;
  // 重要度 = 不透明度 × 最大两个轴的乘积（近似投影面积）：大而实的点排在前面，只加载前一部分时轮廓仍然完整
  const lo = Math.min(s0, s1, s2);
  raw.imp[i] = (a / 255) * ((s0 * s1 * s2) / Math.max(lo, 1e-20));
}

async function readSplat(file, job) {
  const total = Math.floor(file.size / 32);
  if (!total) throw new Error('文件是空的');
  const raw = makeRaw(total);
  const rowsPerBlock = BLOCK / 32;
  for (let start = 0; start < total; start += rowsPerBlock) {
    const rows = Math.min(rowsPerBlock, total - start);
    const buf = await file.slice(start * 32, (start + rows) * 32).arrayBuffer();
    const f = new Float32Array(buf), u = new Uint8Array(buf);
    for (let i = 0; i < rows; i++) {
      const o = i * 8, b = i * 32;
      put(raw, f[o], f[o + 1], f[o + 2], u[b + 24], u[b + 25], u[b + 26], u[b + 27], f[o + 3], f[o + 4], f[o + 5], u[b + 28], u[b + 29], u[b + 30], u[b + 31]);
    }
    progress(job, 'read', start + rows, total);
  }
  return raw;
}

async function readPly(file, job) {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 65536)).arrayBuffer());
  let text = '';
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
  const tag = 'end_header\n';
  const end = text.indexOf(tag);
  if (!text.startsWith('ply') || end < 0) throw new Error('不是有效的 PLY 文件');
  const lines = text.slice(0, end).split('\n').map((s) => s.trim());
  if (!lines.includes('format binary_little_endian 1.0')) throw new Error('只支持二进制小端格式的 PLY（binary_little_endian）');

  let total = 0, rowSize = 0, elementIndex = -1, inVertex = false;
  const props = {};
  for (const line of lines) {
    const p = line.split(/\s+/);
    if (p[0] === 'element') {
      elementIndex++;
      inVertex = p[1] === 'vertex';
      if (inVertex) {
        if (elementIndex !== 0) throw new Error('不支持这种 PLY（顶点数据不在最前面，可能是压缩版）。请导出标准的 3DGS PLY');
        total = parseInt(p[2], 10);
      }
    } else if (p[0] === 'property' && inVertex) {
      const size = TYPE_SIZE[p[1]];
      if (!size) throw new Error('不支持的 PLY 属性类型：' + p[1]);
      props[p[2]] = { off: rowSize, type: p[1] };
      rowSize += size;
    }
  }
  if (!(total > 0) || !rowSize) throw new Error('PLY 里没有顶点数据');
  const need = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
  const missing = need.filter((k) => !props[k]);
  if (missing.length) throw new Error('这不是高斯模型 PLY（缺少属性 ' + missing.slice(0, 4).join('、') + '）。普通点云或压缩版 PLY 不能直接使用');
  const dataStart = end + tag.length;
  if (file.size < dataStart + total * rowSize) throw new Error('PLY 文件不完整（数据比文件头声明的少）');

  const raw = makeRaw(total);
  const allFloat = rowSize % 4 === 0 && need.every((k) => (props[k].type === 'float' || props[k].type === 'float32') && props[k].off % 4 === 0);
  const O = need.map((k) => props[k].off);
  const rowsPerBlock = Math.max(1, Math.floor(BLOCK / rowSize));

  for (let start = 0; start < total; start += rowsPerBlock) {
    const rows = Math.min(rowsPerBlock, total - start);
    const buf = await file.slice(dataStart + start * rowSize, dataStart + (start + rows) * rowSize).arrayBuffer();
    let get;
    if (allFloat) {
      const f = new Float32Array(buf);
      get = (base, k) => f[(base + O[k]) >> 2];
    } else {
      const dv = new DataView(buf);
      const types = need.map((k) => props[k].type);
      get = (base, k) => {
        const o = base + O[k];
        switch (types[k]) {
          case 'float': case 'float32': return dv.getFloat32(o, true);
          case 'double': case 'float64': return dv.getFloat64(o, true);
          case 'uchar': case 'uint8': return dv.getUint8(o);
          case 'char': case 'int8': return dv.getInt8(o);
          case 'short': case 'int16': return dv.getInt16(o, true);
          case 'ushort': case 'uint16': return dv.getUint16(o, true);
          case 'int': case 'int32': return dv.getInt32(o, true);
          default: return dv.getUint32(o, true);
        }
      };
    }
    for (let i = 0; i < rows; i++) {
      const base = i * rowSize;
      let q0 = get(base, 6), q1 = get(base, 7), q2 = get(base, 8), q3 = get(base, 9);
      const ql = Math.hypot(q0, q1, q2, q3) || 1;
      q0 /= ql; q1 /= ql; q2 /= ql; q3 /= ql;
      put(raw,
        get(base, 0), get(base, 1), get(base, 2),
        byte((0.5 + SH_C0 * get(base, 11)) * 255), byte((0.5 + SH_C0 * get(base, 12)) * 255), byte((0.5 + SH_C0 * get(base, 13)) * 255),
        byte(255 / (1 + Math.exp(-get(base, 10)))),
        Math.exp(get(base, 3)), Math.exp(get(base, 4)), Math.exp(get(base, 5)),
        byte(q0 * 128 + 128), byte(q1 * 128 + 128), byte(q2 * 128 + 128), byte(q3 * 128 + 128));
    }
    progress(job, 'read', start + rows, total);
  }
  return raw;
}

// 按重要度从大到小的序号（对数后分 65536 桶做计数排序）
function importanceOrder(imp, n) {
  const key = new Uint16Array(n);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = Math.log(imp[i] + 1e-30);
    imp[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const k = 65535 / Math.max(max - min, 1e-12);
  COUNTS.fill(0);
  for (let i = 0; i < n; i++) {
    const q = 65535 - (((imp[i] - min) * k) | 0);
    key[i] = q;
    COUNTS[q]++;
  }
  let sum = 0;
  for (let q = 0; q < 65536; q++) {
    const t = COUNTS[q];
    COUNTS[q] = sum;
    sum += t;
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[COUNTS[key[i]]++] = i;
  return order;
}

// 某个坐标轴上去掉两端各 2% 之后的范围：模型外围常有零星飞点，直接取最大最小值会把尺寸估得过大
function robustRange(F, order, m, axis) {
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < m; k++) {
    const v = F[order[k] * 8 + axis];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max > min)) return [min, max];
  const BINS = 4096;
  const hist = new Uint32Array(BINS);
  const s = (BINS - 1) / (max - min);
  for (let k = 0; k < m; k++) hist[((F[order[k] * 8 + axis] - min) * s) | 0]++;
  const cut = m * 0.02;
  let lo = 0, hi = BINS - 1, acc = 0;
  while (lo < BINS && acc + hist[lo] <= cut) acc += hist[lo++];
  acc = 0;
  while (hi > lo && acc + hist[hi] <= cut) acc += hist[hi--];
  return [min + lo / s, min + (hi + 1) / s];
}

async function convert(msg) {
  const file = msg.file;
  const name = String(file.name || '').toLowerCase();
  const raw = name.endsWith('.splat') ? await readSplat(file, msg.job) : await readPly(file, msg.job);
  if (!raw.n) throw new Error('文件里没有可用的点');
  progress(msg.job, 'sort', 0, 1);

  const order = importanceOrder(raw.imp, raw.n);
  const m = Math.min(raw.n, msg.maxSplats || raw.n);
  const F = raw.F;
  const rx = robustRange(F, order, m, 0), ry = robustRange(F, order, m, 1), rz = robustRange(F, order, m, 2);
  const cx = (rx[0] + rx[1]) / 2, cy = (ry[0] + ry[1]) / 2, cz = (rz[0] + rz[1]) / 2;

  const out = new ArrayBuffer(m * 32);
  const OF = new Float32Array(out), OU = new Uint32Array(out), IU = new Uint32Array(raw.buf);
  for (let k = 0; k < m; k++) {
    const s = order[k] * 8, d = k * 8;
    OF[d] = F[s] - cx;
    OF[d + 1] = F[s + 1] - cy;
    OF[d + 2] = F[s + 2] - cz;
    OU[d + 3] = IU[s + 3];
    OU[d + 4] = IU[s + 4];
    OU[d + 5] = IU[s + 5];
    OU[d + 6] = IU[s + 6];
    OU[d + 7] = IU[s + 7];
  }
  const bmin = [rx[0] - cx, ry[0] - cy, rz[0] - cz];
  const bmax = [rx[1] - cx, ry[1] - cy, rz[1] - cz];
  self.postMessage({
    t: 'converted', job: msg.job, buffer: out, count: m,
    source: raw.total, dropped: raw.total - raw.n, truncated: raw.n - m,
    bmin, bmax, radius: Math.hypot(bmax[0], bmax[1], bmax[2]) || 1,
  }, [out]);
}
