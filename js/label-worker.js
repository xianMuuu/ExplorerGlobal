/* 后台线程：取 Google 注记瓦片并按小块重新拼图（大陆纠偏，见 imagery.js）。
   取图、解码、拼图都在这里完成，主线程只负责把成品上传显卡，飞行时不掉帧。
   收：{ id, urls: { "列偏移,行偏移": 地址 }, blocks: [[u0, v0, u1, v1, 取图偏移x, 取图偏移y], …] }，坐标单位是 1/512 瓦片
   发：{ id, bitmap } 或 { id, error } */
'use strict';

const UNIT = 512;
const pending = new Map(); // 相邻瓦片会用到同一张原图，这里去重并短暂保留

function source(url) {
  let p = pending.get(url);
  if (!p) {
    p = fetch(url, { mode: 'cors', credentials: 'omit' })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      })
      .then((blob) => createImageBitmap(blob))
      .catch(() => {
        pending.delete(url);
        return null;
      });
    pending.set(url, p);
    if (pending.size > 64) pending.delete(pending.keys().next().value);
  }
  return p;
}

self.onmessage = async (e) => {
  const { id, urls, blocks } = e.data;
  try {
    const keys = Object.keys(urls);
    const imgs = await Promise.all(keys.map((k) => source(urls[k])));
    const got = new Map();
    keys.forEach((k, i) => imgs[i] && got.set(k, imgs[i]));
    if (!got.size) throw new Error('注记瓦片加载失败');

    const size = got.values().next().value.width;
    const k = size / UNIT;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    for (const [u0, v0, u1, v1, sx, sy] of blocks) {
      for (let b = Math.floor((v0 + sy) / UNIT); b <= Math.floor((v1 - 1 + sy) / UNIT); b++) {
        for (let a = Math.floor((u0 + sx) / UNIT); a <= Math.floor((u1 - 1 + sx) / UNIT); a++) {
          const img = got.get(a + ',' + b);
          if (!img) continue;
          const du0 = Math.max(u0, a * UNIT - sx);
          const du1 = Math.min(u1, (a + 1) * UNIT - sx);
          const dv0 = Math.max(v0, b * UNIT - sy);
          const dv1 = Math.min(v1, (b + 1) * UNIT - sy);
          const w = (du1 - du0) * k;
          const h = (dv1 - dv0) * k;
          ctx.drawImage(img, (du0 + sx - a * UNIT) * k, (dv0 + sy - b * UNIT) * k, w, h, du0 * k, dv0 * k, w, h);
        }
      }
    }

    // 与 Cesium 自己取回的瓦片保持同一种格式：上下翻转、不预乘透明度
    const bitmap = await createImageBitmap(canvas, { imageOrientation: 'flipY', premultiplyAlpha: 'none' });
    self.postMessage({ id, bitmap }, [bitmap]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
