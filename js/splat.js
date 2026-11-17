/* 高斯模型（3DGS）：模型清单、按距离渐进加载、渲染。
   渲染在叠在地球画布上面的一块独立 WebGL2 画布里完成，每帧跟随地球的相机。
   性能手段：① 模型数据按重要度排列，远看只加载和绘制前一部分；② 同屏点数有预算，按帧率自动增减；
   ③ 排序在后台线程做；④ 相机运动时降低叠加画布分辨率；⑤ 离开后释放显存。 */
(function () {
  'use strict';
  const C = Cesium;
  const cfg = Object.assign({
    budget: 1500000, // 同屏最多画多少个点（起始值，之后按帧率自动增减）
    minBudget: 150000,
    maxBudget: 4000000, // 也是单个模型最多载入显存的点数
    maxLoaded: 3, // 同时显示的模型个数
    showPx: 14, // 模型在屏幕上的半径超过这么多像素就开始加载显示
    motionScale: 0.6, // 相机运动时叠加画布的分辨率比例
    maxDpr: 1.5,
    releaseMs: 15000, // 离开视野多久后释放显存
  }, (GE.config && GE.config.splat) || {});

  const S = (GE.splats = {
    supported: false, enabled: GE.store.get('splats', true), markers: true,
    models: [], byId: new Map(), preview: null, budget: cfg.budget,
    stats: { drawn: 0, loaded: 0, total: 0, frameMs: 0, active: 0 }, config: cfg,
  });

  let viewer, scene, camera, canvas, gl, prog, quadBuf, worker;
  let U = {};
  let rowSplats = 2048;
  let inflight = 0;
  let lastFrame = 0, ema = 16, lastAdjust = 0, lastMove = 0, lastStatus = 0, dirty = false;
  const lastView = new C.Matrix4();
  const scratchMV = new C.Matrix4();
  const scratchRot = new C.Matrix3();
  const proj = new Float32Array(16);

  const VS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uTex;
uniform int uRowSplats;
uniform int uLimit;
uniform mat4 uMV;
uniform mat4 uProj;
uniform vec2 uFocal;
uniform vec2 uViewport;
uniform float uScale;
uniform float uCrop;
in vec2 aPos;
in int aIndex;
out vec4 vColor;
out vec2 vPos;
void main() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  if (aIndex >= uLimit) return;
  ivec2 tc = ivec2((aIndex % uRowSplats) * 2, aIndex / uRowSplats);
  uvec4 t0 = texelFetch(uTex, tc, 0);
  vec3 p = uintBitsToFloat(t0.xyz);
  if (uCrop > 0.0 && dot(p, p) > uCrop * uCrop) return;
  vec4 cam = uMV * vec4(p, 1.0);
  if (cam.z > -0.3) return;
  vec4 clip = uProj * cam;
  float lim = 1.3 * clip.w;
  if (clip.x < -lim || clip.x > lim || clip.y < -lim || clip.y > lim) return;
  uint c = t0.w;
  uvec4 t1 = texelFetch(uTex, tc + ivec2(1, 0), 0);
  vec3 s = uintBitsToFloat(t1.xyz) * uScale;
  uint qb = t1.w;
  vec4 q = normalize((vec4(float(qb & 255u), float((qb >> 8) & 255u), float((qb >> 16) & 255u), float(qb >> 24)) - 128.0) / 128.0);
  float w = q.x, x = q.y, y = q.z, z = q.w;
  mat3 R = mat3(
    1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
    2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
    2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y));
  mat3 M = mat3(uMV) * R;
  M[0] *= s.x; M[1] *= s.y; M[2] *= s.z;
  float iz = -1.0 / cam.z;
  vec3 j0 = vec3(uFocal.x * iz, 0.0, uFocal.x * cam.x * iz * iz);
  vec3 j1 = vec3(0.0, uFocal.y * iz, uFocal.y * cam.y * iz * iz);
  vec3 r0 = j0 * M;
  vec3 r1 = j1 * M;
  float a = dot(r0, r0) + 0.3;
  float b = dot(r0, r1);
  float d = dot(r1, r1) + 0.3;
  float mid = 0.5 * (a + d);
  float rad = length(vec2(0.5 * (a - d), b));
  float l1 = mid + rad;
  float l2 = max(mid - rad, 0.05);
  vec2 v1 = abs(b) < 1e-6 ? (a >= d ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) : normalize(vec2(b, l1 - a));
  vec2 major = min(sqrt(2.0 * l1), 1024.0) * v1;
  vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(v1.y, -v1.x);
  vColor = vec4(float(c & 255u), float((c >> 8) & 255u), float((c >> 16) & 255u), float(c >> 24)) / 255.0;
  vPos = aPos;
  gl_Position = vec4(clip.xy / clip.w + (aPos.x * major + aPos.y * minor) * 2.0 / uViewport, 0.0, 1.0);
}`;

  const FS = `#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vPos;
out vec4 fragColor;
void main() {
  float A = -dot(vPos, vPos);
  if (A < -4.0) discard;
  float B = exp(A) * vColor.a;
  fragColor = vec4(vColor.rgb * B, B);
}`;

  /* ---------- WebGL ---------- */
  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  function initGL() {
    gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) return false;
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aIndex');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    U = {};
    ['uTex', 'uRowSplats', 'uLimit', 'uMV', 'uProj', 'uFocal', 'uViewport', 'uScale', 'uCrop'].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2, -2, 2, -2, -2, 2, 2, 2]), gl.STATIC_DRAW);
    rowSplats = gl.getParameter(gl.MAX_TEXTURE_SIZE) >= 4096 ? 2048 : 1024;
    return true;
  }

  function ensureGpu(m) {
    if (m.tex) return true;
    const maxRows = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const cap = Math.min(m.total, cfg.maxBudget, maxRows * rowSplats);
    const rows = Math.ceil(cap / rowSplats);
    m.cap = cap;
    m.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, m.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, rowSplats * 2, rows);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    m.orderBuf = gl.createBuffer();
    m.vao = gl.createVertexArray();
    gl.bindVertexArray(m.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.orderBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.INT, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    return true;
  }

  function release(m) {
    if (gl && m.tex) {
      gl.deleteTexture(m.tex);
      gl.deleteBuffer(m.orderBuf);
      gl.deleteVertexArray(m.vao);
    }
    m.tex = m.orderBuf = m.vao = null;
    m.loaded = 0;
    m.nextChunk = 0;
    m.sorted = 0;
    m.sortCount = -1;
    m.sortBusy = false;
    m.epoch++;
    if (worker) worker.postMessage({ t: 'drop', id: m.id });
  }

  /* ---------- 模型与摆放 ---------- */
  // 把模型自己的坐标轴转成“东-北-上”：选项表示模型里哪个轴朝上
  const UP_FIX = {
    z: C.Matrix3.IDENTITY,
    y: new C.Matrix3(1, 0, 0, 0, 0, -1, 0, 1, 0),
    '-y': new C.Matrix3(1, 0, 0, 0, 0, 1, 0, -1, 0),
    '-z': new C.Matrix3(1, 0, 0, 0, -1, 0, 0, 0, -1),
  };

  function updateMatrix(m) {
    const p = m.meta;
    m.center = C.Cartesian3.fromDegrees(p.lon, p.lat, p.height);
    const enu = C.Transforms.eastNorthUpToFixedFrame(m.center);
    // 朝向从正北顺时针为正（和罗盘一致），所以绕“上”轴转负角度
    const rz = C.Matrix3.fromRotationZ(-C.Math.toRadians(p.heading || 0));
    const rx = C.Matrix3.fromRotationX(C.Math.toRadians(p.pitch || 0));
    const ry = C.Matrix3.fromRotationY(C.Math.toRadians(p.roll || 0));
    C.Matrix3.multiply(rz, rx, scratchRot);
    C.Matrix3.multiply(scratchRot, ry, scratchRot);
    C.Matrix3.multiply(scratchRot, UP_FIX[p.up] || UP_FIX.z, scratchRot);
    C.Matrix3.multiplyByScalar(scratchRot, p.scale || 1, scratchRot);
    m.matrix = C.Matrix4.multiply(enu, C.Matrix4.fromRotationTranslation(scratchRot, C.Cartesian3.ZERO), new C.Matrix4());
    m.radiusWorld = Math.max(p.radius * (p.scale || 1), 0.5);
    if (m.marker) {
      m.marker.position = m.center;
      m.marker.label.text = p.name || '';
    }
  }

  let iconCache = null;
  function markerIcon() {
    if (iconCache) return iconCache;
    const c = document.createElement('canvas');
    c.width = c.height = 56;
    const g = c.getContext('2d');
    g.beginPath();
    g.arc(28, 28, 24, 0, Math.PI * 2);
    g.fillStyle = 'rgba(124, 92, 255, 0.95)';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = '#ffffff';
    g.stroke();
    g.fillStyle = '#ffffff';
    g.font = 'bold 22px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('3D', 28, 29);
    iconCache = c;
    return c;
  }

  function makeModel(meta, local) {
    const m = {
      id: meta.id, meta, local: local || null, total: meta.count,
      center: null, matrix: null, radiusWorld: 1, mv: new Float32Array(16),
      tex: null, orderBuf: null, vao: null, cap: 0,
      loaded: 0, nextChunk: 0, loading: false, errors: 0, retryAt: 0, epoch: 0,
      sorted: 0, sortCount: -1, sortBusy: false, sortSeq: 0, dir: [0, 0, 0], pending: null,
      want: 0, px: 0, dist: 0, active: false, lastActive: 0, crop: 0, marker: null,
    };
    if (!local && viewer) {
      m.marker = viewer.entities.add({
        billboard: {
          image: markerIcon(), width: 28, height: 28,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new C.NearFarScalar(2.0e4, 1.0, 8.0e6, 0.45),
        },
        label: {
          text: meta.name || '',
          font: '600 13px "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
          fillColor: C.Color.WHITE, outlineColor: C.Color.fromCssColorString('#1b1b1b'), outlineWidth: 4,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: C.HorizontalOrigin.LEFT, verticalOrigin: C.VerticalOrigin.CENTER,
          pixelOffset: new C.Cartesian2(18, 0),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, 3.0e5),
        },
      });
      m.marker.splatModel = m;
    }
    updateMatrix(m);
    return m;
  }

  function dispose(m) {
    release(m);
    if (m.marker) viewer.entities.remove(m.marker);
    m.marker = null;
  }

  /* ---------- 加载 ---------- */
  function chunkSize(m, n) {
    const per = m.meta.chunkSplats;
    return Math.min(per, m.total - n * per);
  }

  function uploadChunk(m, n, buffer) {
    const per = m.meta.chunkSplats;
    const offset = n * per;
    const count = Math.min(buffer.byteLength / 32, m.cap - offset);
    if (count <= 0) return;
    const rows = Math.ceil(count / rowSplats);
    let data = new Uint32Array(buffer, 0, count * 8);
    if (count % rowSplats) {
      const padded = new Uint32Array(rows * rowSplats * 8);
      padded.set(data);
      data = padded;
    }
    gl.bindTexture(gl.TEXTURE_2D, m.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, offset / rowSplats, rowSplats * 2, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data);
    worker.postMessage({ t: 'data', id: m.id, offset, count, capacity: m.cap, buffer }, [buffer]);
    m.loaded = offset + count;
    m.nextChunk = n + 1;
  }

  function pump(m, now) {
    if (m.loading || !m.tex || now < m.retryAt) return;
    const per = m.meta.chunkSplats;
    if (per % rowSplats) return; // 分块大小和纹理行宽对不上（服务端改过设置），无法按块写入
    const need = Math.min(Math.ceil(Math.min(m.want, m.cap) / per), Math.ceil(m.cap / per));
    if (m.nextChunk >= need) return;
    const n = m.nextChunk;
    if (m.local) {
      // 本地预览：数据已在内存里，每帧写入一块，避免一次性写入造成卡顿
      const start = n * per * 32;
      uploadChunk(m, n, m.local.slice(start, start + chunkSize(m, n) * 32));
      return;
    }
    if (inflight >= 2) return;
    m.loading = true;
    inflight++;
    const epoch = m.epoch;
    fetch('api/models/' + m.id + '/chunks/' + n)
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (buf.byteLength !== chunkSize(m, n) * 32) throw new Error('分块大小不符');
        if (m.tex && m.epoch === epoch && m.nextChunk === n) uploadChunk(m, n, buf);
        m.errors = 0;
      })
      .catch((e) => {
        m.errors++;
        m.retryAt = performance.now() + Math.min(30000, 1500 * m.errors * m.errors);
        if (m.errors === 3) console.warn('[高斯模型] 分块加载失败', m.id, n, e);
      })
      .finally(() => {
        m.loading = false;
        inflight--;
      });
  }

  function onWorkerMessage(e) {
    const msg = e.data;
    if (msg.t !== 'order') return;
    const m = msg.id === 'preview' ? S.preview : S.byId.get(msg.id);
    if (!m || !m.tex || msg.seq !== m.sortSeq) {
      if (m && msg.seq === m.sortSeq) m.sortBusy = false;
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, m.orderBuf);
    gl.bufferData(gl.ARRAY_BUFFER, msg.order, gl.DYNAMIC_DRAW);
    m.sorted = msg.count;
    m.sortBusy = false;
    if (m.pending) {
      m.dir = m.pending.dir;
      m.sortCount = m.pending.count;
    }
  }

  /* ---------- 每帧 ---------- */
  function frame() {
    if (!gl || gl.isContextLost()) return;
    const now = performance.now();
    if (lastFrame) ema = ema * 0.9 + Math.min(now - lastFrame, 250) * 0.1;
    lastFrame = now;

    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const fovy = camera.frustum.fovy;
    if (!cw || !ch || !fovy) return;
    const tanHalf = Math.tan(fovy / 2);
    const focalCss = ch / 2 / tanHalf;
    const camPos = camera.positionWC;
    const view = camera.viewMatrix;
    if (!C.Matrix4.equalsEpsilon(view, lastView, 1e-10)) {
      lastMove = now;
      C.Matrix4.clone(view, lastView);
    }

    const list = S.preview ? S.models.concat(S.preview) : S.models;
    const cand = [];
    for (const m of list) {
      m.dist = C.Cartesian3.distance(camPos, m.center);
      m.px = (m.radiusWorld / Math.max(m.dist, m.radiusWorld * 0.25)) * focalCss;
      const ready = m.local || m.meta.status === 'ready';
      if (S.enabled && ready && m.px >= (m.active ? cfg.showPx * 0.7 : cfg.showPx)) cand.push(m);
    }
    cand.sort((a, b) => b.px - a.px);
    const keep = cand.slice(0, cfg.maxLoaded);
    for (const m of list) {
      m.active = keep.indexOf(m) >= 0;
      if (m.active) m.lastActive = now;
      else if (m.tex && (now - m.lastActive > cfg.releaseMs || !S.enabled)) release(m);
      if (m.marker) m.marker.show = S.markers && !(m.active && m.sorted > 0);
    }

    // 每个模型想画多少点：随屏幕占比增长，总数不超过预算
    let sum = 0;
    for (const m of keep) {
      const cover = Math.min(1, m.px / (0.45 * ch));
      const frac = Math.max(0.03, Math.min(1, cover * cover * 1.2));
      m.want = Math.min(m.total, Math.max(Math.min(m.total, 40000), Math.round(m.total * frac)));
      sum += m.want;
    }
    if (sum > S.budget) for (const m of keep) m.want = Math.max(1000, Math.floor((m.want * S.budget) / sum));

    const draws = [];
    let loaded = 0, total = 0;
    for (const m of keep) {
      ensureGpu(m);
      m.want = Math.min(m.want, m.cap);
      pump(m, now);
      loaded += m.loaded;
      total += m.total;
      C.Matrix4.multiply(view, m.matrix, scratchMV);
      C.Matrix4.toArray(scratchMV, m.mv);
      const count = Math.min(m.loaded, m.want);
      if (!count || m.mv[14] > m.radiusWorld * 2) continue; // 还没有数据，或整个模型在相机背后
      m.count = count;
      const len = Math.hypot(m.mv[2], m.mv[6], m.mv[10]) || 1;
      const dir = [m.mv[2] / len, m.mv[6] / len, m.mv[10] / len];
      const turned = dir[0] * m.dir[0] + dir[1] * m.dir[1] + dir[2] * m.dir[2] < 0.9995;
      // 视线方向变了约 2 度、或要画的点数变了超过 5%，就请后台线程重新排序；同一时间只排一次
      if (!m.sortBusy && (turned || m.sortCount < 0 || Math.abs(count - m.sortCount) > m.sortCount * 0.05 || (count > m.sortCount && now - lastMove > 300))) {
        m.sortBusy = true;
        m.sortSeq++;
        m.pending = { dir, count };
        worker.postMessage({ t: 'sort', id: m.id, seq: m.sortSeq, count, a: m.mv[2], b: m.mv[6], c: m.mv[10] });
      }
      if (m.sorted > 0) draws.push(m);
    }

    // 叠加画布尺寸：相机运动时降分辨率
    const moving = now - lastMove < 140;
    const scale = Math.min(window.devicePixelRatio || 1, cfg.maxDpr) * (moving && draws.length ? cfg.motionScale : 1);
    const W = Math.max(1, Math.round(cw * scale)), H = Math.max(1, Math.round(ch * scale));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
      dirty = true;
    }

    let drawn = 0;
    if (draws.length || dirty) {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      dirty = draws.length > 0;
    }
    if (draws.length) {
      draws.sort((a, b) => b.dist - a.dist);
      const f = H / 2 / tanHalf;
      const near = 0.1, far = 1.0e7;
      proj.fill(0);
      proj[0] = f / (W / 2);
      proj[5] = f / (H / 2);
      proj[10] = (far + near) / (near - far);
      proj[11] = -1;
      proj[14] = (2 * far * near) / (near - far);
      gl.useProgram(prog);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(U.uProj, false, proj);
      gl.uniform2f(U.uFocal, f, f);
      gl.uniform2f(U.uViewport, W, H);
      gl.uniform1i(U.uRowSplats, rowSplats);
      gl.uniform1i(U.uTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      for (const m of draws) {
        const n = Math.min(m.sorted, m.count);
        // 只画了一部分点时把每个点略微放大，补上被省略的小点留下的缝隙
        const boost = n < m.total ? Math.min(1.7, Math.pow(m.total / n, 0.2)) : 1;
        gl.uniformMatrix4fv(U.uMV, false, m.mv);
        gl.uniform1i(U.uLimit, m.count);
        gl.uniform1f(U.uScale, boost);
        gl.uniform1f(U.uCrop, m.crop || 0);
        gl.bindTexture(gl.TEXTURE_2D, m.tex);
        gl.bindVertexArray(m.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, m.sorted);
        drawn += n;
      }
      gl.bindVertexArray(null);
    }

    // 按帧率调整点数预算：低于约 24 帧就减，高于约 45 帧就加
    if (drawn > 50000 && now - lastAdjust > 600) {
      lastAdjust = now;
      if (ema > 42) S.budget = Math.max(cfg.minBudget, Math.round(S.budget * 0.85));
      else if (ema < 22) S.budget = Math.min(cfg.maxBudget, Math.round(S.budget * 1.08));
    }

    S.stats.drawn = drawn;
    S.stats.loaded = loaded;
    S.stats.total = total;
    S.stats.active = keep.length;
    S.stats.frameMs = ema;
    if (now - lastStatus > 400) {
      lastStatus = now;
      updateStatus();
    }
  }

  let statusEl = null;
  const wan = (n) => (n >= 10000 ? (n / 10000).toFixed(n >= 1e6 ? 0 : 1) + ' 万' : String(n));
  function updateStatus() {
    if (!statusEl) return;
    const st = S.stats;
    if (!st.active) {
      if (!statusEl.hidden) statusEl.hidden = true;
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = '高斯模型：绘制 ' + wan(st.drawn) + ' 点 · 已载入 ' + wan(st.loaded) + ' / ' + wan(st.total);
    statusEl.title = '点数预算 ' + wan(S.budget) + '（按帧率自动调整）';
  }

  /* ---------- 对外接口 ---------- */
  S.refresh = async function () {
    let data;
    try {
      const res = await fetch('api/models', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (e) {
      S.available = false;
      return false;
    }
    S.available = true;
    const seen = new Set();
    for (const meta of data.models || []) {
      seen.add(meta.id);
      const m = S.byId.get(meta.id);
      if (m) {
        if (m.editing) continue; // 正在调整摆放的模型不要被服务器上的旧值覆盖
        m.meta = meta;
        updateMatrix(m);
      } else {
        const nm = makeModel(meta);
        S.byId.set(meta.id, nm);
        S.models.push(nm);
      }
    }
    S.models = S.models.filter((m) => {
      if (seen.has(m.id)) return true;
      dispose(m);
      S.byId.delete(m.id);
      return false;
    });
    GE.bus.emit('splats:list', S.models);
    return true;
  };

  S.flyTo = function (m, duration) {
    if (typeof m === 'string') m = S.byId.get(m);
    if (!m) return;
    const r = Math.max(m.radiusWorld, 3);
    camera.flyToBoundingSphere(new C.BoundingSphere(m.center, r), {
      duration: duration === undefined ? 2.0 : duration,
      offset: new C.HeadingPitchRange(camera.heading, C.Math.toRadians(-28), Math.max(r * 2.6, 30)),
    });
  };

  S.setEnabled = function (on) {
    S.enabled = !!on;
    GE.store.set('splats', S.enabled);
    GE.bus.emit('splats:enabled', S.enabled);
  };

  // 改摆放参数（只改本地显示，不写服务器）；用于上传前预览和编辑位置时的实时反馈
  S.setPlacement = function (m, placement) {
    if (typeof m === 'string') m = S.byId.get(m);
    if (!m) return;
    Object.assign(m.meta, placement);
    updateMatrix(m);
  };

  // 上传前的本地预览：data = { buffer, count, radius, chunkSplats, placement }
  S.setPreview = function (data) {
    S.clearPreview();
    if (!gl || !data) return null;
    const meta = Object.assign({ id: 'preview', name: '', count: data.count, radius: data.radius, chunkSplats: data.chunkSplats, status: 'ready' }, data.placement);
    S.preview = makeModel(meta, data.buffer);
    return S.preview;
  };
  S.clearPreview = function () {
    if (S.preview) release(S.preview);
    S.preview = null;
  };

  S.init = function (v) {
    viewer = v;
    scene = v.scene;
    camera = v.camera;
    canvas = document.createElement('canvas');
    canvas.id = 'splat-canvas';
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;';
    // 放在地球容器内部，大小和位置才能与地球画布完全一致
    const host = document.getElementById('cesiumContainer');
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(canvas);

    try {
      S.supported = initGL();
    } catch (e) {
      console.error('[高斯模型] 初始化失败', e);
      S.supported = false;
      gl = null;
    }
    if (S.supported) {
      worker = new Worker('js/splat-worker.js');
      worker.onmessage = onWorkerMessage;
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
      });
      canvas.addEventListener('webglcontextrestored', () => {
        // 显存里的东西全部作废：重建着色器，模型从头加载
        (S.preview ? S.models.concat(S.preview) : S.models).forEach((m) => { m.tex = m.orderBuf = m.vao = null; release(m); });
        try { initGL(); } catch (e) { gl = null; }
      });
      scene.postRender.addEventListener(frame);
    }

    const sb = document.getElementById('sb-source');
    if (sb) {
      statusEl = document.createElement('span');
      statusEl.className = 'sb-item';
      statusEl.id = 'sb-splat';
      statusEl.hidden = true;
      sb.parentNode.insertBefore(statusEl, sb.nextSibling);
    }

    // 点击远处的“3D”标记飞到模型
    const handler = new C.ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction((click) => {
      const picked = scene.pick(click.position);
      if (picked && picked.id && picked.id.splatModel) S.flyTo(picked.id.splatModel);
    }, C.ScreenSpaceEventType.LEFT_CLICK);

    S.refresh();
    setInterval(() => { if (!document.hidden) S.refresh(); }, 60000);
  };
})();
