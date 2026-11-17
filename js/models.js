/* 账号（登录 / 注册）与高斯模型的上传、摆放、管理界面 */
(function () {
  'use strict';
  const C = Cesium;
  const UI = GE.ui;
  const S = GE.splats;
  const esc = GE.fmt.escape;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const A = (GE.account = { user: null, config: null, available: false });
  const M = (GE.models = {});
  let viewer;

  async function api(path, opts) {
    opts = opts || {};
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.raw) {
      init.body = opts.raw;
      init.headers['Content-Type'] = 'application/octet-stream';
    } else if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      init.headers['Content-Type'] = 'application/json';
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw new Error('连不上服务器，请确认服务窗口没有关闭');
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) { /* 不是 JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || '请求失败（' + res.status + '）');
      err.status = res.status;
      throw err;
    }
    return data;
  }
  A.api = api;

  /* ---------- 账号 ---------- */
  let popup = null;
  function closePopup() {
    if (!popup) return;
    popup.remove();
    popup = null;
    document.removeEventListener('mousedown', onDocDown, true);
  }
  function onDocDown(e) {
    if (popup && !popup.contains(e.target) && e.target.id !== 'account-btn') closePopup();
  }

  function renderAccount() {
    let btn = $('#account-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'account-btn';
      btn.className = 'account-btn';
      $('#menubar').appendChild(btn);
      btn.addEventListener('click', () => {
        if (popup) return closePopup();
        if (!A.user) return A.login();
        popup = document.createElement('div');
        popup.className = 'menu-pop';
        const items = [
          ['上传高斯模型…', () => M.upload()],
          ['模型列表…', () => M.showList()],
          null,
          ['退出登录', () => A.logout()],
        ];
        items.forEach((it) => {
          if (!it) {
            const sep = document.createElement('div');
            sep.className = 'menu-sep';
            popup.appendChild(sep);
            return;
          }
          const row = document.createElement('div');
          row.className = 'menu-item';
          row.innerHTML = '<span class="mi-mark"></span><span class="mi-label"></span><span class="mi-hint"></span>';
          $('.mi-label', row).textContent = it[0];
          row.addEventListener('click', () => { closePopup(); it[1](); });
          popup.appendChild(row);
        });
        document.body.appendChild(popup);
        const r = btn.getBoundingClientRect();
        popup.style.top = r.bottom + 'px';
        popup.style.left = Math.max(8, r.right - popup.offsetWidth) + 'px';
        document.addEventListener('mousedown', onDocDown, true);
      });
    }
    btn.textContent = A.user ? A.user.name + ' ▾' : '登录 / 注册';
    btn.title = A.user ? '账号与高斯模型' : '登录后可以上传高斯模型';
    btn.classList.toggle('signed', !!A.user);
  }

  async function loadMe() {
    try {
      const data = await api('api/auth/me');
      A.available = true;
      A.user = data.user;
      A.config = data.config;
    } catch (e) {
      A.available = false;
      A.user = null;
    }
    renderAccount();
  }

  function authDialog(mode) {
    const reg = mode === 'register';
    const body = document.createElement('div');
    body.innerHTML =
      '<label class="field"><span>用户名</span><input name="username" type="text" autocomplete="username" maxlength="20" spellcheck="false"></label>' +
      '<label class="field"><span>密码' + (reg ? '（至少 8 位）' : '') + '</span><input name="password" type="password" autocomplete="' + (reg ? 'new-password' : 'current-password') + '" maxlength="72"></label>' +
      (reg ? '<label class="field"><span>再输一次密码</span><input name="password2" type="password" autocomplete="new-password" maxlength="72"></label>' : '') +
      '<p class="form-error" hidden></p>' +
      '<p class="modal-hint">' + (reg ? '已有账号？<a href="#" data-switch="login">去登录</a>' : '还没有账号？<a href="#" data-switch="register">注册一个</a>') + '</p>';
    let close = null;
    let busy = false;
    const showError = (box, text) => {
      const p = $('.form-error', box);
      p.textContent = text;
      p.hidden = !text;
    };
    async function submit(box) {
      if (busy) return;
      const username = $('[name=username]', box).value.trim();
      const password = $('[name=password]', box).value;
      if (!username || !password) return showError(box, '请输入用户名和密码');
      if (reg && password !== $('[name=password2]', box).value) return showError(box, '两次输入的密码不一致');
      busy = true;
      showError(box, '');
      try {
        const data = await api(reg ? 'api/auth/register' : 'api/auth/login', { method: 'POST', body: { username, password } });
        A.user = data.user;
        $$('input[type=password]', box).forEach((i) => { i.value = ''; });
        renderAccount();
        S.refresh();
        UI.toast((reg ? '注册成功，已登录：' : '已登录：') + A.user.name + (reg && A.user.admin ? '（第一个账号，自动成为管理员）' : ''), 'ok');
        close(true);
      } catch (e) {
        showError(box, e.message);
      } finally {
        busy = false;
      }
    }
    return UI.dialog({
      title: reg ? '注册' : '登录',
      body,
      buttons: [
        { label: '取消', value: null },
        { label: reg ? '注册' : '登录', primary: true, value: (box) => { submit(box); return undefined; } },
      ],
      onOpen(box, closeFn) {
        close = closeFn;
        $('[data-switch]', box).addEventListener('click', (e) => {
          e.preventDefault();
          closeFn('switch:' + e.target.dataset.switch);
        });
      },
    }).then((v) => (typeof v === 'string' && v.startsWith('switch:') ? authDialog(v.slice(7)) : v));
  }

  A.login = function () {
    if (!A.available) {
      UI.toast('当前页面没有连接到账号服务（请用“启动.bat”打开）', 'warn', 6000);
      return Promise.resolve(null);
    }
    return authDialog('login');
  };
  A.logout = async function () {
    try {
      await api('api/auth/logout', { method: 'POST' });
    } catch (e) { /* 会话可能已失效 */ }
    A.user = null;
    renderAccount();
    S.refresh();
    UI.toast('已退出登录');
  };

  /* ---------- 摆放表单（上传和编辑共用） ---------- */
  const PLACE_HTML =
    '<label class="field"><span>名称</span><input name="name" type="text" maxlength="60"></label>' +
    '<div class="field-row">' +
    '<label class="field"><span>经度</span><input name="lon" type="number" step="any"></label>' +
    '<label class="field"><span>纬度</span><input name="lat" type="number" step="any"></label>' +
    '</div>' +
    '<div class="gs-row"><button type="button" data-act="pick">在地球上点选位置</button><button type="button" data-act="center">用视野中心</button><button type="button" data-act="fly">看模型</button></div>' +
    '<div class="field-row">' +
    '<label class="field"><span>底部海拔（米）</span><input name="base" type="number" step="any"></label>' +
    '<label class="field"><span>缩放（倍）</span><input name="scale" type="number" step="any" min="0.00001"></label>' +
    '</div>' +
    '<label class="field"><span>模型里哪个轴朝上</span><select name="up">' +
    '<option value="-y">−Y 朝上（3DGS 训练结果常见）</option><option value="z">Z 朝上</option><option value="y">Y 朝上</option><option value="-z">−Z 朝上</option></select></label>' +
    '<label class="field gs-slider"><span>朝向（顺时针）<b data-out="heading"></b></span><input name="heading" type="range" min="-180" max="180" step="0.5"></label>' +
    '<label class="field gs-slider"><span>前后倾斜<b data-out="pitch"></b></span><input name="pitch" type="range" min="-180" max="180" step="0.5"></label>' +
    '<label class="field gs-slider"><span>左右倾斜<b data-out="roll"></b></span><input name="roll" type="range" min="-180" max="180" step="0.5"></label>' +
    '<label class="field gs-slider gs-crop"><span>只保留中心附近（裁掉外围杂点）<b data-out="crop"></b></span><input name="crop" type="range" min="20" max="400" step="5"></label>' +
    '<label class="field"><span>说明（可选）</span><input name="note" type="text" maxlength="300"></label>';

  // 模型坐标里“上”方向的最低点（去掉 2% 飞点后的范围），用来把模型底部对到指定海拔
  function upMin(bmin, bmax, up) {
    if (!bmin || !bmax) return 0;
    if (up === 'z') return bmin[2];
    if (up === 'y') return bmin[1];
    if (up === '-y') return -bmax[1];
    return -bmax[2];
  }

  /*
   * 在 container 里建立摆放表单。info = { bmin, bmax, radius }；init 是初始摆放（height 为模型中心海拔）。
   * 每次改动调用 onChange(placement, cropRadius)。返回 { read(), setPosition(lon, lat, ground), destroy() }。
   */
  function placementForm(container, info, init, onChange, opts) {
    container.innerHTML = PLACE_HTML;
    const el = (name) => $('[name=' + name + ']', container);
    const out = (name) => $('[data-out=' + name + ']', container);
    if (!opts.crop) $('.gs-crop', container).hidden = true;
    if (!opts.fly) $('[data-act=fly]', container).hidden = true;

    el('name').value = init.name || '';
    el('note').value = init.note || '';
    el('lon').value = (+init.lon).toFixed(6);
    el('lat').value = (+init.lat).toFixed(6);
    el('scale').value = init.scale;
    el('up').value = init.up;
    el('heading').value = init.heading;
    el('pitch').value = init.pitch;
    el('roll').value = init.roll;
    el('crop').value = 400;
    el('base').value = (init.height + upMin(info.bmin, info.bmax, init.up) * init.scale).toFixed(1);

    function read() {
      const scale = Math.max(parseFloat(el('scale').value) || 1, 1e-5);
      const up = el('up').value;
      const base = parseFloat(el('base').value) || 0;
      const cropPct = parseFloat(el('crop').value);
      return {
        name: el('name').value.trim(),
        note: el('note').value.trim(),
        lon: Math.max(-180, Math.min(180, parseFloat(el('lon').value) || 0)),
        lat: Math.max(-90, Math.min(90, parseFloat(el('lat').value) || 0)),
        height: base - upMin(info.bmin, info.bmax, up) * scale,
        heading: parseFloat(el('heading').value) || 0,
        pitch: parseFloat(el('pitch').value) || 0,
        roll: parseFloat(el('roll').value) || 0,
        scale, up,
        cropRadius: opts.crop && cropPct < 400 ? (info.radius * cropPct) / 100 : 0,
      };
    }
    function changed() {
      const p = read();
      out('heading').textContent = p.heading + '°';
      out('pitch').textContent = p.pitch + '°';
      out('roll').textContent = p.roll + '°';
      out('crop').textContent = p.cropRadius ? Math.round(parseFloat(el('crop').value)) + '%' : '不裁剪';
      onChange(p);
    }
    container.addEventListener('input', changed);

    let picker = null;
    function stopPick() {
      if (picker) picker.destroy();
      picker = null;
      document.body.classList.remove('picking');
    }
    async function setPosition(lon, lat) {
      el('lon').value = lon.toFixed(6);
      el('lat').value = lat.toFixed(6);
      // 开了地形时把底部海拔设成该点的地面高程，没开地形时地面就是 0
      const ground = GE.terrain && GE.terrain.enabled ? await GE.terrain.heightAt(lon, lat, 1500) : 0;
      el('base').value = ground.toFixed(1);
      changed();
    }
    container.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'pick') {
        stopPick();
        document.body.classList.add('picking');
        UI.toast('请在地球上点击模型所在的位置');
        picker = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
        picker.setInputAction((click) => {
          const p = GE.controls.pickGround(click.position);
          if (!p) return;
          const c = C.Cartographic.fromCartesian(p);
          stopPick();
          setPosition(C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude));
        }, C.ScreenSpaceEventType.LEFT_CLICK);
      } else if (act === 'center') {
        const t = GE.controls.centerTarget();
        if (!t) return UI.toast('视野中心不在地面上', 'warn');
        const c = C.Cartographic.fromCartesian(t);
        setPosition(C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude));
      } else if (act === 'fly' && opts.fly) {
        opts.fly();
      }
    });
    changed();
    return { read, setPosition, destroy: stopPick };
  }

  const strip = (p) => ({ lon: p.lon, lat: p.lat, height: p.height, heading: p.heading, pitch: p.pitch, roll: p.roll, scale: p.scale, up: p.up });

  function viewCenter() {
    const t = GE.controls.centerTarget();
    const c = t ? C.Cartographic.fromCartesian(t) : viewer.camera.positionCartographic;
    return { lon: C.Math.toDegrees(c.longitude), lat: C.Math.toDegrees(c.latitude) };
  }

  /* ---------- 上传 ---------- */
  // 按裁剪半径筛掉外围的点（保持原有的重要度顺序）
  function cropBuffer(buffer, count, radius) {
    const src = new Float32Array(buffer), srcU = new Uint32Array(buffer);
    const r2 = radius * radius;
    let kept = 0;
    for (let i = 0; i < count; i++) {
      const o = i * 8;
      if (src[o] * src[o] + src[o + 1] * src[o + 1] + src[o + 2] * src[o + 2] <= r2) kept++;
    }
    const out = new Uint32Array(kept * 8);
    for (let i = 0, k = 0; i < count; i++) {
      const o = i * 8;
      if (src[o] * src[o] + src[o + 1] * src[o + 1] + src[o + 2] * src[o + 2] <= r2) {
        out.set(srcU.subarray(o, o + 8), k);
        k += 8;
      }
    }
    return { buffer: out.buffer, count: kept };
  }

  let uploading = false;
  M.upload = async function () {
    if (uploading) return;
    if (!A.user) {
      const ok = await A.login();
      if (!ok || !A.user) return;
    }
    if (!S.supported) return UI.toast('这个浏览器不支持 WebGL2，无法显示和上传高斯模型', 'warn', 6000);
    uploading = true;

    const conf = A.config || { maxSplats: 8000000, chunkSplats: 131072 };
    const body = document.createElement('div');
    body.className = 'gs-wizard';
    body.innerHTML =
      '<div class="gs-file"><button type="button" class="gs-pick">选择模型文件…</button><span class="gs-filename">支持 3DGS 的 .ply 和 .splat</span>' +
      '<input type="file" accept=".ply,.splat" hidden></div>' +
      '<div class="gs-progress" hidden><i></i></div><p class="modal-hint gs-info">选好文件后在浏览器里转换格式，然后可以在地球上摆放并预览，确认后再上传。</p>' +
      '<fieldset class="gs-place" disabled></fieldset>';

    const state = { data: null, form: null, worker: null, cancelled: false, busy: false, modelId: null };
    let closeFn = null;
    const bar = (box, frac, text) => {
      const p = $('.gs-progress', box);
      p.hidden = frac === null;
      if (frac !== null) $('i', p).style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
      if (text !== undefined) $('.gs-info', box).textContent = text;
    };

    function convert(box, file) {
      if (state.worker) state.worker.terminate();
      if (state.form) state.form.destroy();
      S.clearPreview();
      state.data = null;
      $('.gs-place', box).disabled = true;
      $('.gs-filename', box).textContent = file.name + '（' + (file.size / 1048576).toFixed(1) + ' MB）';
      bar(box, 0, '正在读取并转换…');
      const w = (state.worker = new Worker('js/splat-worker.js'));
      w.onmessage = (e) => {
        const m = e.data;
        if (m.t === 'progress') {
          bar(box, m.phase === 'read' ? (m.done / m.total) * 0.9 : 0.95, m.phase === 'read' ? '正在读取并转换…' : '正在按重要度排序…');
        } else if (m.t === 'error') {
          bar(box, null, '转换失败：' + m.message);
          w.terminate();
          state.worker = null;
        } else if (m.t === 'converted') {
          w.terminate();
          state.worker = null;
          state.data = m;
          let text = '共 ' + m.count.toLocaleString() + ' 个点';
          if (m.dropped) text += '，已去掉 ' + m.dropped.toLocaleString() + ' 个几乎透明或无效的点';
          if (m.truncated) text += '；超过上限，按重要度只保留了前 ' + m.count.toLocaleString() + ' 个（舍去 ' + m.truncated.toLocaleString() + ' 个）';
          bar(box, null, text + '。请调整位置和方向，满意后点“上传”。');
          startPlacement(box, file);
        }
      };
      w.postMessage({ t: 'convert', job: 1, file, maxSplats: conf.maxSplats });
    }

    function startPlacement(box, file) {
      const d = state.data;
      const c = viewCenter();
      const init = { name: file.name.replace(/\.[^.]+$/, '').slice(0, 60), note: '', lon: c.lon, lat: c.lat, height: 0, heading: 0, pitch: 0, roll: 0, scale: 1, up: '-y' };
      init.height = -upMin(d.bmin, d.bmax, init.up) * init.scale;
      const fs = $('.gs-place', box);
      fs.disabled = false;
      const preview = S.setPreview({ buffer: d.buffer, count: d.count, radius: d.radius, chunkSplats: conf.chunkSplats, placement: strip(init) });
      state.form = placementForm(fs, d, init, (p) => {
        if (!S.preview) return;
        S.setPlacement(S.preview, strip(p));
        S.preview.crop = p.cropRadius;
      }, { crop: true, fly: () => S.flyTo(S.preview, 1.2) });
      if (preview) S.flyTo(preview, 1.5);
    }

    async function putChunk(id, n, bytes) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await api('api/models/' + id + '/chunks/' + n, { method: 'PUT', raw: bytes });
        } catch (e) {
          if (attempt >= 3 || state.cancelled || (e.status && e.status < 500 && e.status !== 429)) throw e;
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
    }

    async function doUpload(box) {
      if (state.busy || !state.data || !state.form) return;
      const p = state.form.read();
      if (!p.name) return UI.toast('请填写模型名称', 'warn');
      state.busy = true;
      $('.gs-place', box).disabled = true;
      try {
        let buffer = state.data.buffer, count = state.data.count, radius = state.data.radius;
        if (p.cropRadius) {
          const cut = cropBuffer(buffer, count, p.cropRadius);
          if (!cut.count) throw new Error('裁剪后没有剩下任何点，请把裁剪范围调大');
          buffer = cut.buffer;
          count = cut.count;
          radius = Math.min(radius, p.cropRadius);
        }
        bar(box, 0, '正在上传…');
        const meta = Object.assign(strip(p), { name: p.name, note: p.note, count, radius, bmin: state.data.bmin, bmax: state.data.bmax });
        const created = await api('api/models', { method: 'POST', body: meta });
        const model = created.model;
        state.modelId = model.id;
        const per = model.chunkSplats;
        let next = 0, done = 0;
        const runner = async () => {
          while (next < model.chunks && !state.cancelled) {
            const n = next++;
            const len = Math.min(per, count - n * per);
            await putChunk(model.id, n, new Uint8Array(buffer, n * per * 32, len * 32));
            done++;
            bar(box, done / model.chunks, '正在上传… ' + done + ' / ' + model.chunks + ' 块');
          }
        };
        await Promise.all([runner(), runner(), runner()]);
        if (state.cancelled) throw new Error('已取消');
        await api('api/models/' + model.id + '/complete', { method: 'POST' });
        state.modelId = null;
        S.clearPreview();
        await S.refresh();
        UI.toast('上传完成：' + p.name + '（' + count.toLocaleString() + ' 个点）', 'ok', 6000);
        closeFn('done');
        S.flyTo(model.id, 1.0);
      } catch (e) {
        if (state.modelId) {
          api('api/models/' + state.modelId, { method: 'DELETE' }).catch(() => {});
          state.modelId = null;
        }
        if (!state.cancelled) {
          bar(box, null, '上传失败：' + e.message);
          $('.gs-place', box).disabled = false;
        }
      } finally {
        state.busy = false;
      }
    }

    await UI.dialog({
      title: '上传高斯模型',
      side: true,
      body,
      buttons: [
        { label: '关闭', value: null },
        { label: '上传', primary: true, value: (box) => { doUpload(box); return undefined; } },
      ],
      onOpen(box, close) {
        closeFn = close;
        const input = $('input[type=file]', box);
        $('.gs-pick', box).addEventListener('click', () => input.click());
        input.addEventListener('change', () => {
          const file = input.files && input.files[0];
          if (file) convert(box, file);
        });
      },
    });
    // 对话框关闭：停掉转换、取消上传、清掉预览
    state.cancelled = true;
    if (state.worker) state.worker.terminate();
    if (state.form) state.form.destroy();
    S.clearPreview();
    uploading = false;
  };

  /* ---------- 编辑摆放 ---------- */
  M.edit = async function (id) {
    const m = S.byId.get(id);
    if (!m) return;
    const original = Object.assign({}, m.meta);
    m.editing = true;
    const body = document.createElement('div');
    body.className = 'gs-wizard';
    body.innerHTML = '<fieldset class="gs-place"></fieldset>';
    let form = null;
    S.flyTo(m, 1.2);
    const result = await UI.dialog({
      title: '调整模型位置',
      side: true,
      body,
      buttons: [
        { label: '取消', value: null },
        { label: '保存', primary: true, value: () => form.read() },
      ],
      onOpen(box) {
        form = placementForm($('.gs-place', box), m.meta, original, (p) => S.setPlacement(m, strip(p)), { crop: false, fly: () => S.flyTo(m, 1.2) });
      },
    });
    if (form) form.destroy();
    m.editing = false;
    if (!result) {
      S.setPlacement(m, strip(original));
      return;
    }
    if (!result.name) {
      S.setPlacement(m, strip(original));
      return UI.toast('名称不能为空，未保存', 'warn');
    }
    try {
      await api('api/models/' + id, { method: 'PATCH', body: Object.assign(strip(result), { name: result.name, note: result.note }) });
      UI.toast('已保存', 'ok');
    } catch (e) {
      S.setPlacement(m, strip(original));
      UI.toast('保存失败：' + e.message, 'warn', 6000);
    }
    S.refresh();
  };

  /* ---------- 模型列表 ---------- */
  M.showList = function () {
    const body = document.createElement('div');
    body.className = 'gs-list';
    function render() {
      const list = S.models;
      if (!list.length) {
        body.innerHTML = '<p class="modal-text">还没有任何高斯模型。' + (A.user ? '点右上角的用户名 → “上传高斯模型…”可以添加。' : '登录后可以上传。') + '</p>';
        return;
      }
      body.innerHTML = list.map((m) => {
        const p = m.meta;
        return '<div class="gs-item" data-id="' + esc(m.id) + '">' +
          '<div class="gs-item-text"><div class="gs-item-name">' + esc(p.name) + (p.status !== 'ready' ? '<span class="tag">未传完</span>' : '') + '</div>' +
          '<div class="gs-item-sub">' + esc(p.owner || '') + ' · ' + p.count.toLocaleString() + ' 点 · ' + esc(GE.fmt.latlon(p.lat, p.lon)) + (p.note ? ' · ' + esc(p.note) : '') + '</div></div>' +
          '<div class="gs-item-actions"><button type="button" data-act="fly">飞到</button>' +
          (p.editable ? '<button type="button" data-act="edit">调整</button><button type="button" data-act="delete">删除</button>' : '') + '</div></div>';
      }).join('');
    }
    render();
    let closeFn = null;
    body.addEventListener('click', async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      const item = e.target.closest('.gs-item');
      if (!act || !item) return;
      const id = item.dataset.id;
      const m = S.byId.get(id);
      if (!m) return;
      if (act === 'fly') {
        closeFn(null);
        S.flyTo(m);
      } else if (act === 'edit') {
        closeFn(null);
        M.edit(id);
      } else if (act === 'delete') {
        if (!(await UI.confirm('删除模型', '确定删除“' + m.meta.name + '”？删除后不能恢复。', '删除'))) return;
        try {
          await api('api/models/' + id, { method: 'DELETE' });
          UI.toast('已删除', 'ok');
        } catch (err) {
          UI.toast('删除失败：' + err.message, 'warn', 6000);
        }
        await S.refresh();
        render();
      }
    });
    S.refresh().then(render);
    return UI.dialog({
      title: '高斯模型列表',
      body,
      buttons: [{ label: '关闭', value: null, primary: true }],
      onOpen(box, close) { closeFn = close; },
    });
  };

  M.init = function (v) {
    viewer = v;
    renderAccount();
    loadMe();
  };
})();
