/* 界面：菜单栏、工具栏、侧栏（搜索 / 地点 / 图层）、导航环、状态栏、对话框、绘制工具 */
(function () {
  'use strict';
  const C = Cesium;
  const f = GE.fmt;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function el(tag, attrs, html) {
    const n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach((k) => n.setAttribute(k, attrs[k]));
    if (html !== undefined) n.innerHTML = html;
    return n;
  }

  let viewer, scene, camera, canvas;
  const UI = (GE.ui = {});

  const settings = Object.assign(
    { sidebar: true, toolbar: true, statusbar: true, scalebar: true, nav: true, grid: false, atmosphere: true, sun: false, terrain: false },
    GE.store.get('settings', {})
  );
  UI.settings = settings;

  /* ---------- 提示条 ---------- */
  UI.toast = function (msg, kind, ms) {
    const box = $('#toasts');
    const t = el('div', { class: 'toast ' + (kind || '') });
    t.textContent = msg;
    box.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, ms || 3800);
  };

  /* ---------- 对话框 ---------- */
  let modalCount = 0;
  UI.isModalOpen = () => modalCount > 0;

  UI.dialog = function (opts) {
    return new Promise((resolve) => {
      const wrap = el('div', { class: 'modal-backdrop' + (opts.side ? ' passthrough' : '') });
      const box = el('div', { class: 'modal' + (opts.side ? ' side' : ''), role: 'dialog', 'aria-modal': opts.side ? 'false' : 'true' });
      box.innerHTML =
        '<div class="modal-title"><span></span><button type="button" class="modal-x" title="关闭">×</button></div>' +
        '<div class="modal-body"></div><div class="modal-foot"></div>';
      $('.modal-title span', box).textContent = opts.title || '';
      const body = $('.modal-body', box);
      if (typeof opts.body === 'string') body.innerHTML = opts.body;
      else if (opts.body) body.appendChild(opts.body);
      const foot = $('.modal-foot', box);

      let closed = false;
      function close(value) {
        if (closed) return;
        closed = true;
        modalCount--;
        document.removeEventListener('keydown', onKey, true);
        wrap.remove();
        resolve(value);
      }
      (opts.buttons || [{ label: '确定', value: true, primary: true }]).forEach((b) => {
        const btn = el('button', { type: 'button', class: b.primary ? 'primary' : '' });
        btn.textContent = b.label;
        btn.addEventListener('click', () => {
          const v = typeof b.value === 'function' ? b.value(box) : b.value;
          if (v !== undefined) close(v);
        });
        foot.appendChild(btn);
      });
      $('.modal-x', box).addEventListener('click', () => close(null));
      function onKey(e) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close(null);
        } else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
          const p = $('button.primary', foot);
          if (p) { e.preventDefault(); p.click(); }
        }
      }
      document.addEventListener('keydown', onKey, true);
      if (!opts.side) wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(null); });

      wrap.appendChild(box);
      $('#modal-root').appendChild(wrap);
      modalCount++;
      if (opts.onOpen) opts.onOpen(box, close);
      const first = $('input,textarea', box) || $('button.primary', box);
      if (first) { first.focus(); if (first.select) first.select(); }
    });
  };

  UI.confirm = function (title, text, okLabel) {
    return UI.dialog({
      title,
      body: '<p class="modal-text">' + f.escape(text) + '</p>',
      buttons: [{ label: '取消', value: false }, { label: okLabel || '确定', value: true, primary: true }],
    });
  };

  /* ---------- 开关类设置 ---------- */
  function applySetting(name) {
    const on = !!settings[name];
    switch (name) {
      case 'sidebar':
      case 'toolbar':
      case 'statusbar':
      case 'scalebar':
      case 'nav':
        document.body.classList.toggle('no-' + name, !on);
        break;
      case 'grid':
        GE.imagery.setGrid(on);
        break;
      case 'atmosphere':
        scene.skyAtmosphere.show = on;
        scene.globe.showGroundAtmosphere = on;
        break;
      case 'sun':
        scene.globe.enableLighting = on;
        if (on) viewer.clock.currentTime = C.JulianDate.now();
        break;
      case 'terrain':
        GE.terrain.setEnabled(on).then((ok) => {
          if (on && !ok) {
            settings.terrain = false;
            GE.store.set('settings', settings);
            UI.toast('地形服务暂时连不上，已保持关闭', 'warn');
            refreshChrome();
          }
        });
        break;
    }
  }
  function toggle(name, value) {
    settings[name] = value === undefined ? !settings[name] : !!value;
    GE.store.set('settings', settings);
    applySetting(name);
    refreshChrome();
  }
  UI.toggle = toggle;

  function refreshChrome() {
    renderToolbarState();
    renderLayers();
  }

  /* ---------- 常用动作 ---------- */
  function download(href, name) {
    const a = el('a', { href, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function saveImage() {
    viewer.render();
    download(canvas.toDataURL('image/jpeg', 0.95), 'earth-' + stamp() + '.jpg');
    UI.toast('已保存当前视图为图片');
  }
  function viewCenter() {
    const t = GE.controls.centerTarget();
    const c = t ? C.Cartographic.fromCartesian(t) : camera.positionCartographic;
    return { lat: C.Math.toDegrees(c.latitude), lon: C.Math.toDegrees(c.longitude) };
  }
  function openInMaps() {
    const c = viewCenter();
    const range = Math.round(Math.max(100, Math.min(GE.controls.currentRange(), 2.0e7)));
    window.open('https://www.google.com/maps/@' + c.lat.toFixed(6) + ',' + c.lon.toFixed(6) + ',' + range + 'm/data=!3m1!1e3', '_blank', 'noopener');
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => UI.toast('浏览器拒绝了全屏请求', 'warn'));
  }
  function focusSearch() {
    if (!settings.sidebar) toggle('sidebar', true);
    $('#panel-search').classList.remove('collapsed');
    const input = $('#search-input');
    input.focus();
    input.select();
  }

  function showShortcuts() {
    const rows = [
      ['左键拖动', '抓住地球平移（松手后带惯性）'],
      ['滚轮', '以鼠标位置为锚点缩放'],
      ['左键双击 / 右键双击', '放大一级 / 缩小一级'],
      ['右键拖动', '连续缩放'],
      ['中键拖动，或 Shift / Ctrl + 左键拖动', '旋转和倾斜视角'],
      ['← ↑ → ↓', '平移'],
      ['+ / -，或 PageUp / PageDown', '放大 / 缩小'],
      ['Shift + ← / →', '旋转'],
      ['Shift + ↓ / ↑', '朝地平线抬起 / 回到俯视'],
      ['N', '正北朝上'],
      ['U', '垂直俯视'],
      ['R', '正北朝上并垂直俯视'],
      ['Ctrl + F，或 /', '跳到搜索框'],
      ['Ctrl + Alt + B', '显示 / 隐藏侧栏'],
      ['Esc', '取消当前工具，关闭信息卡'],
    ];
    UI.dialog({
      title: '键盘与鼠标操作',
      body: '<table class="keys">' + rows.map((r) => '<tr><th>' + f.escape(r[0]) + '</th><td>' + f.escape(r[1]) + '</td></tr>').join('') + '</table>',
      buttons: [{ label: '关闭', value: true, primary: true }],
    });
  }

  function showAbout() {
    UI.dialog({
      title: '关于',
      body:
        '<p class="modal-text"><b>Google Earth Pro 本地复刻版</b></p>' +
        '<p class="modal-text">界面与操作仿照 Google Earth Pro，代码为独立编写，与 Google 无关联。</p>' +
        '<p class="modal-text">三维地球引擎：CesiumJS ' + f.escape(C.VERSION) + '（Apache-2.0）。</p>' +
        '<p class="modal-text">影像按需从在线服务加载，版权归各数据提供方所有；离线底图为 NASA Blue Marble。</p>',
      buttons: [{ label: '关闭', value: true, primary: true }],
    });
  }

  /* ---------- 菜单栏 ---------- */
  let openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    openMenu.btn.classList.remove('open');
    openMenu.pop.remove();
    openMenu = null;
  }
  function showMenu(btn, def) {
    closeMenu();
    const pop = el('div', { class: 'menu-pop', role: 'menu' });
    def.items().forEach((it) => {
      if (it === '-') {
        pop.appendChild(el('div', { class: 'menu-sep' }));
        return;
      }
      const row = el('div', { class: 'menu-item' + (it.disabled ? ' disabled' : ''), role: 'menuitem' });
      const mark = it.check ? (it.check() ? '✓' : '') : it.radio ? (it.radio() ? '●' : '') : '';
      row.innerHTML = '<span class="mi-mark">' + mark + '</span><span class="mi-label"></span><span class="mi-hint"></span>';
      $('.mi-label', row).textContent = it.label;
      $('.mi-hint', row).textContent = it.hint || '';
      if (!it.disabled) row.addEventListener('click', () => { closeMenu(); it.act(); });
      pop.appendChild(row);
    });
    const r = btn.getBoundingClientRect();
    pop.style.left = r.left + 'px';
    pop.style.top = r.bottom + 'px';
    document.body.appendChild(pop);
    btn.classList.add('open');
    openMenu = { btn, pop };
  }

  function buildMenus() {
    const ctl = GE.controls;
    const defs = [
      { label: '文件', items: () => [
        { label: '打开 KML/KMZ…', act: () => $('#file-kml').click() },
        { label: '将“我的地点”另存为 KML…', act: exportKml, disabled: !P.my.length },
        '-',
        { label: '保存图像…', act: saveImage },
        { label: '打印…', hint: 'Ctrl+P', act: () => window.print() },
        '-',
        { label: '在 Google 地图中查看', act: openInMaps },
      ] },
      { label: '编辑', items: () => [
        { label: '查找', hint: 'Ctrl+F', act: focusSearch },
        { label: '清除搜索结果', act: () => { GE.search.clear(); $('#search-input').value = ''; } },
        '-',
        { label: '清空“我的地点”…', act: clearMyPlaces, disabled: !P.my.length },
      ] },
      { label: '视图', items: () => [
        { label: '工具栏', check: () => settings.toolbar, act: () => toggle('toolbar') },
        { label: '侧栏', hint: 'Ctrl+Alt+B', check: () => settings.sidebar, act: () => toggle('sidebar') },
        { label: '状态栏', check: () => settings.statusbar, act: () => toggle('statusbar') },
        { label: '比例尺', check: () => settings.scalebar, act: () => toggle('scalebar') },
        { label: '导航控件', check: () => settings.nav, act: () => toggle('nav') },
        '-',
        { label: '经纬网格', check: () => settings.grid, act: () => toggle('grid') },
        { label: '大气层', check: () => settings.atmosphere, act: () => toggle('atmosphere') },
        { label: '日照', check: () => settings.sun, act: () => toggle('sun') },
        { label: '地形', check: () => settings.terrain, act: () => toggle('terrain') },
        '-',
        { label: '全屏', hint: 'F11', act: toggleFullscreen },
        '-',
        { label: '重置倾斜（垂直俯视）', hint: 'U', act: ctl.topDown },
        { label: '重置罗盘（正北朝上）', hint: 'N', act: ctl.northUp },
        { label: '重置倾斜和罗盘', hint: 'R', act: ctl.resetView },
        { label: '回到初始视图', act: () => ctl.flyHome() },
      ] },
      { label: '工具', items: () => [
        { label: '标尺', act: () => T.startDraw('ruler') },
        '-',
        { label: '影像源：自动（按优先级降级）', radio: () => GE.imagery.mode === 'auto', act: () => GE.imagery.setMode('auto') },
      ].concat(GE.sources.map((s) => ({
        label: '影像源：' + s.name,
        radio: () => GE.imagery.mode === s.id,
        act: () => GE.imagery.setMode(s.id),
      }))).concat([
        '-',
        { label: '重新检测影像源', act: recheckSources },
      ]) },
      { label: '添加', items: () => [
        { label: '地标', act: () => T.addPlacemark() },
        { label: '路径', act: () => T.startDraw('path') },
        { label: '多边形', act: () => T.startDraw('polygon') },
      ] },
      { label: '帮助', items: () => [
        { label: '键盘与鼠标操作', act: showShortcuts },
        { label: '关于', act: showAbout },
      ] },
    ];

    const bar = $('#menubar');
    defs.forEach((def) => {
      const btn = el('button', { type: 'button', class: 'menu-btn' });
      btn.textContent = def.label;
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (openMenu && openMenu.btn === btn) closeMenu();
        else showMenu(btn, def);
      });
      btn.addEventListener('mouseenter', () => {
        if (openMenu && openMenu.btn !== btn) showMenu(btn, def);
      });
      bar.appendChild(btn);
    });
    document.addEventListener('mousedown', (e) => {
      if (openMenu && !e.target.closest('.menu-pop') && !e.target.closest('.menu-btn')) closeMenu();
    });
    window.addEventListener('blur', closeMenu);
  }

  async function recheckSources() {
    UI.toast('正在检测各影像源…');
    await Promise.all(GE.sources.filter((s) => !s.local).map((s) => GE.imagery.probe(s.id)));
    await GE.imagery.refresh('manual-recheck');
    const st = GE.imagery.status;
    UI.toast(GE.sources.filter((s) => !s.local).map((s) => s.name + (st[s.id] === 'ok' ? ' 可用' : ' 不可用')).join('；'), '', 6000);
  }

  /* ---------- 工具栏 ---------- */
  const ICON = {
    sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><path d="M9.5 4.5v15"/><path d="M5.3 8h2M5.3 11h2M5.3 14h2"/>',
    placemark: '<path d="M7 21l4.6-8.6" /><path d="M9.2 5.2l8.6 5.8-1.7 2.8c-.4.7-1.3.9-2 .4l-6-4c-.7-.5-.9-1.4-.4-2z" fill="#fbd23c" stroke="#fbd23c"/><path d="M13 2.5l7.8 5.3-2.2 2.8-7.5-5z" fill="#ffe36e" stroke="#ffe36e"/>',
    polygon: '<path d="M5 9l8-4.5 6 6-3 8.5H7.5z" fill="rgba(138,180,248,.25)"/><circle cx="5" cy="9" r="1.4" fill="currentColor"/><circle cx="13" cy="4.5" r="1.4" fill="currentColor"/><circle cx="19" cy="10.5" r="1.4" fill="currentColor"/><circle cx="16" cy="19" r="1.4" fill="currentColor"/><circle cx="7.5" cy="19" r="1.4" fill="currentColor"/>',
    path: '<path d="M4.5 18.5C8 8 11.5 20 19.5 5.5"/><circle cx="4.5" cy="18.5" r="1.6" fill="currentColor"/><circle cx="19.5" cy="5.5" r="1.6" fill="currentColor"/>',
    overlay: '<rect x="3" y="5" width="18" height="14" rx="1.2"/><path d="M3 16l5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.3"/>',
    tour: '<rect x="3" y="7" width="12" height="10" rx="1.5"/><path d="M15 10.5l6-3v9l-6-3z"/>',
    history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    planet: '<circle cx="12" cy="12" r="5.5"/><ellipse cx="12" cy="12" rx="10" ry="3.2" transform="rotate(-20 12 12)"/>',
    ruler: '<path d="M3.5 16.5l13-13 4 4-13 13z"/><path d="M7 13l1.8 1.8M9.8 10.2l1.8 1.8M12.6 7.4l1.8 1.8"/>',
    email: '<rect x="3" y="5.5" width="18" height="13" rx="1.5"/><path d="M3.5 6.5l8.5 7 8.5-7"/>',
    print: '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><rect x="7.5" y="14" width="9" height="6" fill="#2b2c2f"/>',
    saveimg: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M12 7.5v8M8.5 12.2l3.5 3.5 3.5-3.5"/>',
    maps: '<path d="M9 4.5L3.5 6.5v13L9 17.5l6 2 5.5-2v-13L15 6.5z"/><path d="M9 4.5v13M15 6.5v13"/>',
    home: '<path d="M4 11.5L12 4.5l8 7"/><path d="M6.5 10v9.5h11V10"/>',
  };
  const NA = '（本地复刻版未提供）';
  let toolbarDefs = [];

  function buildToolbar() {
    toolbarDefs = [
      { id: 'sidebar', title: '隐藏 / 显示侧栏', act: () => toggle('sidebar'), active: () => settings.sidebar },
      '|',
      { id: 'placemark', title: '添加地标', act: () => T.addPlacemark() },
      { id: 'polygon', title: '添加多边形', act: () => T.startDraw('polygon') },
      { id: 'path', title: '添加路径', act: () => T.startDraw('path') },
      { id: 'overlay', title: '添加图像叠加层' + NA, disabled: true },
      { id: 'tour', title: '录制游览' + NA, disabled: true },
      '|',
      { id: 'history', title: '显示历史图像' + NA, disabled: true },
      { id: 'sun', title: '显示日照', act: () => toggle('sun'), active: () => settings.sun },
      { id: 'planet', title: '切换到星空、火星、月球' + NA, disabled: true },
      '|',
      { id: 'ruler', title: '显示标尺', act: () => T.startDraw('ruler') },
      '|',
      { id: 'email', title: '电子邮件' + NA, disabled: true },
      { id: 'print', title: '打印', act: () => window.print() },
      { id: 'saveimg', title: '保存图像', act: saveImage },
      { id: 'maps', title: '在 Google 地图中查看', act: openInMaps },
      '|',
      { id: 'home', title: '回到初始视图', act: () => GE.controls.flyHome() },
    ];
    const bar = $('#toolbar');
    toolbarDefs.forEach((d) => {
      if (d === '|') {
        bar.appendChild(el('span', { class: 'tb-sep' }));
        return;
      }
      const btn = el('button', { type: 'button', class: 'tb-btn', title: d.title, 'data-id': d.id },
        '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[d.id] + '</svg>');
      if (d.disabled) btn.disabled = true;
      else btn.addEventListener('click', d.act);
      bar.appendChild(btn);
    });
  }
  function renderToolbarState() {
    toolbarDefs.forEach((d) => {
      if (d === '|' || !d.active) return;
      const btn = $('#toolbar [data-id="' + d.id + '"]');
      if (btn) btn.classList.toggle('active', !!d.active());
    });
  }

  /* ---------- 侧栏：搜索 ---------- */
  function bindSearch() {
    const input = $('#search-input');
    const status = $('#search-status');
    const list = $('#search-results');

    function setStatus(text, kind) {
      status.hidden = !text;
      status.textContent = text || '';
      status.className = 'search-status ' + (kind || '');
    }
    function renderResults(results) {
      list.innerHTML = '';
      results.forEach((r, i) => {
        const li = el('li', { class: 'result', 'data-i': i });
        li.innerHTML = '<span class="r-pin"><b>' + String.fromCharCode(65 + i) + '</b></span><div class="r-text"><div class="r-name"></div><div class="r-sub"></div></div>';
        $('.r-name', li).textContent = r.name;
        $('.r-sub', li).textContent = r.display || f.latlon(r.lat, r.lon);
        li.addEventListener('click', () => GE.search.goTo(r));
        list.appendChild(li);
      });
    }

    $('#search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      input.blur();
      GE.search.search(input.value);
    });
    $('#search-clear-link').addEventListener('click', (e) => {
      e.preventDefault();
      input.value = '';
      GE.search.clear();
    });
    $('#search-history-link').addEventListener('click', (e) => {
      e.preventDefault();
      const history = GE.store.get('history', []);
      if (!history.length) {
        setStatus('还没有搜索记录');
        return;
      }
      setStatus('历史记录（点击重新搜索）');
      list.innerHTML = '';
      history.forEach((q) => {
        const li = el('li', { class: 'result history' });
        li.innerHTML = '<span class="r-pin h">↺</span><div class="r-text"><div class="r-name"></div></div>';
        $('.r-name', li).textContent = q;
        li.addEventListener('click', () => { input.value = q; GE.search.search(q); });
        list.appendChild(li);
      });
    });

    GE.bus.on('search:start', (d) => {
      list.innerHTML = '';
      setStatus('正在搜索“' + d.q + '”…', 'busy');
    });
    GE.bus.on('search:results', (d) => {
      renderResults(d.results);
      if (!d.results.length) {
        setStatus(d.onlineFailed ? '在线地名服务连不上，离线地名表里也没有“' + d.q + '”' : '没有找到“' + d.q + '”', 'warn');
      } else if (d.onlineFailed) {
        setStatus('在线地名服务连不上，以下结果来自离线地名表', 'warn');
      } else {
        setStatus('找到 ' + d.results.length + ' 个结果（' + d.via + '）');
      }
    });
    GE.bus.on('search:select', (r) => {
      $$('.result', list).forEach((li) => {
        const i = li.dataset.i;
        li.classList.toggle('active', i !== undefined && GE.search.results[i] === r);
      });
      renderPlaces();
    });
    GE.bus.on('search:clear', () => {
      list.innerHTML = '';
      setStatus('');
      renderPlaces();
    });
  }

  /* ---------- 地点（我的地点 / 临时地点） ---------- */
  const P = (GE.places = { my: [], kml: [], entities: new Map(), selected: null });

  const TREE_ICON = {
    folder: '<svg viewBox="0 0 16 16"><path d="M1.5 4a1 1 0 0 1 1-1h3.3l1.4 1.6h6.3a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="#e8b84a"/></svg>',
    placemark: '<svg viewBox="0 0 16 16"><path d="M4 14.5l3.2-6" stroke="#cfcfcf" stroke-width="1.2"/><path d="M6 3.4l6.2 4.2-1.3 2c-.3.5-.9.6-1.4.3L5.3 7.1c-.5-.3-.6-1-.3-1.4z" fill="#fbd23c"/><path d="M8.8 1.5l5.4 3.7-1.5 1.9-5.2-3.5z" fill="#ffe36e"/></svg>',
    search: '<svg viewBox="0 0 16 16"><path d="M8 1.2c-2.9 0-5.2 2.3-5.2 5.1 0 3.7 4.4 8 5.2 8.6.8-.6 5.2-4.9 5.2-8.6 0-2.8-2.3-5.1-5.2-5.1z" fill="#ea4335"/><circle cx="8" cy="6.3" r="1.9" fill="#7c1410"/></svg>',
    path: '<svg viewBox="0 0 16 16"><path d="M2.5 12.5C5 5 7.5 14 13.5 3.5" fill="none" stroke="#fff" stroke-width="1.5"/></svg>',
    polygon: '<svg viewBox="0 0 16 16"><path d="M3 6l5.5-3 4.5 4.2-2 5.8H4.5z" fill="rgba(255,255,255,.3)" stroke="#fff" stroke-width="1.2"/></svg>',
    kml: '<svg viewBox="0 0 16 16"><path d="M3.5 1.5h6l3 3v10h-9z" fill="#8ab4f8"/><path d="M9.5 1.5v3h3" fill="#5e8fd8"/></svg>',
    rename: '<svg viewBox="0 0 16 16"><path d="M2.5 13.5l.6-3 7.3-7.3 2.4 2.4-7.3 7.3z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    remove: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  };

  function labelGraphics(text) {
    return {
      text,
      font: '600 14px "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
      fillColor: C.Color.WHITE,
      outlineColor: C.Color.fromCssColorString('#1b1b1b'),
      outlineWidth: 4,
      style: C.LabelStyle.FILL_AND_OUTLINE,
      horizontalOrigin: C.HorizontalOrigin.LEFT,
      verticalOrigin: C.VerticalOrigin.CENTER,
      pixelOffset: new C.Cartesian2(20, -18),
      heightReference: C.HeightReference.CLAMP_TO_GROUND,
    };
  }
  function pinGraphics() {
    return {
      image: GE.icons.yellowPin,
      width: 32,
      height: 32,
      // 图钉的针尖在图片左下角附近，偏移后让针尖落在坐标点上
      pixelOffset: new C.Cartesian2(7, 2.5),
      verticalOrigin: C.VerticalOrigin.BOTTOM,
      heightReference: C.HeightReference.CLAMP_TO_GROUND,
    };
  }

  function createEntity(item) {
    let entity;
    if (item.type === 'placemark') {
      entity = viewer.entities.add({
        position: C.Cartesian3.fromDegrees(item.lon, item.lat),
        billboard: pinGraphics(),
        label: labelGraphics(item.name),
      });
    } else {
      const flat = [];
      item.coords.forEach((c) => flat.push(c[0], c[1]));
      const positions = C.Cartesian3.fromDegreesArray(flat);
      if (item.type === 'path') {
        entity = viewer.entities.add({
          polyline: { positions, width: 3, material: C.Color.fromCssColorString('#ffe36e'), clampToGround: true },
        });
      } else {
        entity = viewer.entities.add({
          polygon: { hierarchy: new C.PolygonHierarchy(positions), material: C.Color.WHITE.withAlpha(0.28) },
          polyline: { positions: positions.concat([positions[0]]), width: 2.5, material: C.Color.WHITE, clampToGround: true },
        });
      }
    }
    entity.show = item.visible !== false;
    P.entities.set(item.id, entity);
  }

  P.save = function () {
    GE.store.set('places', P.my);
  };
  P.add = function (item) {
    item.id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    item.visible = true;
    P.my.push(item);
    createEntity(item);
    P.save();
    renderPlaces();
    return item;
  };
  P.remove = function (id) {
    const i = P.my.findIndex((it) => it.id === id);
    if (i < 0) return;
    const entity = P.entities.get(id);
    if (entity) viewer.entities.remove(entity);
    P.entities.delete(id);
    P.my.splice(i, 1);
    P.save();
    renderPlaces();
  };
  P.rename = function (id, name) {
    const item = P.my.find((it) => it.id === id);
    if (!item) return;
    item.name = name;
    const entity = P.entities.get(id);
    if (entity && entity.label) entity.label.text = name;
    P.save();
    renderPlaces();
  };
  P.setVisible = function (id, on) {
    const item = P.my.find((it) => it.id === id);
    if (!item) return;
    item.visible = !!on;
    const entity = P.entities.get(id);
    if (entity) entity.show = item.visible;
    P.save();
  };
  P.flyTo = async function (id) {
    const item = P.my.find((it) => it.id === id);
    if (!item) return;
    if (item.type === 'placemark') {
      await flyToPoint(item.lon, item.lat);
    } else {
      const entity = P.entities.get(id);
      if (entity) viewer.flyTo(entity, { duration: GE.config.fly.duration, offset: new C.HeadingPitchRange(0, -C.Math.PI_OVER_TWO, 0) });
    }
  };

  async function flyToPoint(lon, lat) {
    const ground = await GE.terrain.heightAt(lon, lat, 800);
    GE.controls.cancelMotion();
    camera.flyTo({
      destination: C.Cartesian3.fromDegrees(lon, lat, ground + GE.config.fly.height),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
      duration: GE.config.fly.duration,
      easingFunction: C.EasingFunction.CUBIC_IN_OUT,
    });
  }

  async function clearMyPlaces() {
    const ok = await UI.confirm('清空“我的地点”', '将删除“我的地点”里的全部 ' + P.my.length + ' 个条目，此操作无法撤销。', '全部删除');
    if (!ok) return;
    P.my.slice().forEach((it) => P.remove(it.id));
  }

  function xmlEscape(s) {
    return String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  }
  function exportKml() {
    const marks = P.my.map((it) => {
      const head = '<Placemark><name>' + xmlEscape(it.name) + '</name>' + (it.desc ? '<description>' + xmlEscape(it.desc) + '</description>' : '');
      if (it.type === 'placemark') return head + '<Point><coordinates>' + it.lon + ',' + it.lat + ',0</coordinates></Point></Placemark>';
      const coords = it.coords.map((c) => c[0] + ',' + c[1] + ',0');
      if (it.type === 'path') return head + '<LineString><tessellate>1</tessellate><coordinates>' + coords.join(' ') + '</coordinates></LineString></Placemark>';
      return head + '<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>' + coords.concat(coords[0]).join(' ') + '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>';
    });
    const kml = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n<name>我的地点</name>\n' + marks.join('\n') + '\n</Document>\n</kml>\n';
    const url = URL.createObjectURL(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }));
    download(url, '我的地点.kml');
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function importKml(file) {
    try {
      const ds = await C.KmlDataSource.load(file, { camera, canvas, clampToGround: true });
      await viewer.dataSources.add(ds);
      P.kml.push({ id: 'k' + Date.now().toString(36), name: file.name, ds });
      renderPlaces();
      viewer.flyTo(ds, { duration: GE.config.fly.duration });
      UI.toast('已打开 ' + file.name);
    } catch (e) {
      console.error(e);
      UI.toast('无法打开 ' + file.name + '：文件不是有效的 KML/KMZ', 'warn', 6000);
    }
  }

  function treeRow(opts) {
    const row = el('div', { class: 'tree-row' + (opts.folder ? ' is-folder' : '') + (opts.selected ? ' selected' : '') });
    row.innerHTML =
      '<span class="tw' + (opts.folder ? '' : ' leaf') + '"></span>' +
      (opts.checkbox === false ? '' : '<input type="checkbox"' + (opts.checked ? ' checked' : '') + '>') +
      '<span class="ico">' + TREE_ICON[opts.icon] + '</span><span class="lbl"></span>' +
      (opts.actions ? '<span class="row-actions"></span>' : '');
    $('.lbl', row).textContent = opts.label;
    if (opts.title) row.title = opts.title;
    return row;
  }

  function renderPlaces() {
    const root = $('#places-tree');
    if (!root || !viewer) return;
    root.innerHTML = '';

    // 我的地点
    const my = el('div', { class: 'tree-node open' });
    const myRow = treeRow({ folder: true, icon: 'folder', label: '我的地点', checked: P.my.some((it) => it.visible !== false) || !P.my.length });
    my.appendChild(myRow);
    const myKids = el('div', { class: 'tree-children' });
    if (!P.my.length) myKids.appendChild(el('div', { class: 'tree-empty' }, '还没有保存的地点。可用工具栏的图钉添加地标，或在搜索结果的信息卡里保存。'));
    P.my.forEach((it) => {
      const row = treeRow({ icon: it.type, label: it.name, checked: it.visible !== false, actions: true, selected: P.selected === it.id, title: '双击飞到此处' });
      $('input', row).addEventListener('change', (e) => P.setVisible(it.id, e.target.checked));
      row.addEventListener('click', (e) => {
        if (e.target.closest('input,.row-actions')) return;
        P.selected = it.id;
        $$('.tree-row.selected', root).forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
      });
      row.addEventListener('dblclick', (e) => {
        if (e.target.closest('input,.row-actions')) return;
        P.flyTo(it.id);
      });
      const acts = $('.row-actions', row);
      const rn = el('button', { type: 'button', title: '重命名' }, TREE_ICON.rename);
      rn.addEventListener('click', async () => {
        const name = await promptText('重命名', '名称', it.name);
        if (name) P.rename(it.id, name);
      });
      const rm = el('button', { type: 'button', title: '删除' }, TREE_ICON.remove);
      rm.addEventListener('click', async () => {
        if (await UI.confirm('删除', '确定删除“' + it.name + '”吗？', '删除')) P.remove(it.id);
      });
      acts.appendChild(rn);
      acts.appendChild(rm);
      myKids.appendChild(row);
    });
    my.appendChild(myKids);
    $('input', myRow).addEventListener('change', (e) => {
      P.my.forEach((it) => P.setVisible(it.id, e.target.checked));
      renderPlaces();
    });
    bindFolder(my, myRow);
    root.appendChild(my);

    // 临时地点：当前搜索结果 + 打开的 KML
    const temp = el('div', { class: 'tree-node open' });
    const tempRow = treeRow({ folder: true, icon: 'folder', label: '临时地点', checkbox: false });
    temp.appendChild(tempRow);
    const tempKids = el('div', { class: 'tree-children' });
    const cur = GE.search.current;
    if (cur) {
      const row = treeRow({ icon: 'search', label: cur.name, checked: !GE.search.entity || GE.search.entity.show, title: '双击飞到此处' });
      $('input', row).addEventListener('change', (e) => { if (GE.search.entity) GE.search.entity.show = e.target.checked; });
      row.addEventListener('dblclick', (e) => { if (!e.target.closest('input')) GE.search.goTo(cur); });
      tempKids.appendChild(row);
    }
    P.kml.forEach((k) => {
      const row = treeRow({ icon: 'kml', label: k.name, checked: k.ds.show, actions: true, title: '双击飞到此处' });
      $('input', row).addEventListener('change', (e) => { k.ds.show = e.target.checked; });
      row.addEventListener('dblclick', (e) => { if (!e.target.closest('input,.row-actions')) viewer.flyTo(k.ds, { duration: GE.config.fly.duration }); });
      const rm = el('button', { type: 'button', title: '关闭' }, TREE_ICON.remove);
      rm.addEventListener('click', () => {
        viewer.dataSources.remove(k.ds, true);
        P.kml.splice(P.kml.indexOf(k), 1);
        renderPlaces();
      });
      $('.row-actions', row).appendChild(rm);
      tempKids.appendChild(row);
    });
    if (!cur && !P.kml.length) tempKids.appendChild(el('div', { class: 'tree-empty' }, '搜索结果和打开的 KML 文件会显示在这里。'));
    temp.appendChild(tempKids);
    bindFolder(temp, tempRow);
    root.appendChild(temp);
  }

  function bindFolder(node, row) {
    $('.tw', row).addEventListener('click', (e) => {
      e.stopPropagation();
      node.classList.toggle('open');
    });
  }

  function promptText(title, label, value) {
    return UI.dialog({
      title,
      body: '<label class="field"><span>' + f.escape(label) + '</span><input type="text" class="f-text" value="' + f.escape(value || '') + '"></label>',
      buttons: [
        { label: '取消', value: null },
        { label: '确定', primary: true, value: (box) => $('.f-text', box).value.trim() || undefined },
      ],
    });
  }

  /* ---------- 图层面板 ---------- */
  function renderLayers() {
    const root = $('#layers-tree');
    if (!root || !viewer) return;
    const img = GE.imagery;
    root.innerHTML = '';

    const db = el('div', { class: 'tree-node open' });
    const dbRow = treeRow({ folder: true, icon: 'folder', label: '主数据库', checkbox: false });
    db.appendChild(dbRow);
    const kids = el('div', { class: 'tree-children' });
    const layerDefs = [
      { label: '边界和地名', checked: img.labelsVisible, set: (v) => img.setLabelsVisible(v), title: '注记层：地名、道路、边界' },
      { label: '地形', checked: settings.terrain, set: (v) => toggle('terrain', v), title: '开启后地表有起伏，状态栏显示海拔（需要连接 ArcGIS 高程服务）' },
      { label: '大气层', checked: settings.atmosphere, set: (v) => toggle('atmosphere', v) },
      { label: '经纬网格', checked: settings.grid, set: (v) => toggle('grid', v) },
      { label: '日照', checked: settings.sun, set: (v) => toggle('sun', v), title: '按当前时刻显示昼夜' },
    ];
    layerDefs.forEach((d) => {
      const row = el('label', { class: 'tree-row layer' });
      row.innerHTML = '<span class="tw leaf"></span><input type="checkbox"' + (d.checked ? ' checked' : '') + '><span class="lbl"></span>';
      $('.lbl', row).textContent = d.label;
      if (d.title) row.title = d.title;
      $('input', row).addEventListener('change', (e) => d.set(e.target.checked));
      kids.appendChild(row);
    });
    db.appendChild(kids);
    bindFolder(db, dbRow);
    root.appendChild(db);

    const src = el('div', { class: 'tree-node open' });
    const srcRow = treeRow({ folder: true, icon: 'folder', label: '影像源', checkbox: false });
    src.appendChild(srcRow);
    const srcKids = el('div', { class: 'tree-children' });
    const statusText = { ok: '可用', down: '不可用', unknown: '未检测' };
    const options = [{ id: 'auto', name: '自动（按优先级降级）' }].concat(GE.sources);
    options.forEach((s) => {
      const row = el('label', { class: 'tree-row layer source' });
      const st = s.id === 'auto' ? '' : img.status[s.id] || 'unknown';
      row.innerHTML =
        '<span class="tw leaf"></span><input type="radio" name="imagery-source"' + (img.mode === s.id ? ' checked' : '') + '>' +
        (s.id === 'auto' ? '' : '<i class="dot ' + st + '" title="' + statusText[st] + '"></i>') +
        '<span class="lbl"></span>' + (img.activeId === s.id ? '<span class="tag">使用中</span>' : '');
      $('.lbl', row).textContent = s.name;
      $('input', row).addEventListener('change', () => img.setMode(s.id));
      srcKids.appendChild(row);
    });
    src.appendChild(srcKids);
    bindFolder(src, srcRow);
    root.appendChild(src);
  }

  /* ---------- 状态栏、比例尺、导航环 ---------- */
  let mousePos = null;
  let lastStatus = 0;
  let lastScale = 0;
  let lastHeadingDeg = null;
  let queueMax = 0;

  function updateStatus(now) {
    if (now - lastStatus < 80) return;
    lastStatus = now;
    const pos = mousePos || new C.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const p = GE.controls.pickGround(pos);
    if (p) {
      const c = C.Cartographic.fromCartesian(p);
      $('#sb-latlon').textContent = f.latlon(C.Math.toDegrees(c.latitude), C.Math.toDegrees(c.longitude));
      if (GE.terrain.enabled) {
        const h = scene.globe.getHeight(c);
        $('#sb-elev').textContent = '海拔 ' + (Number.isFinite(h) ? Math.round(h) + ' 米' : '—');
      } else {
        $('#sb-elev').textContent = '海拔 —';
      }
    } else {
      $('#sb-latlon').textContent = '—';
      $('#sb-elev').textContent = '海拔 —';
    }
    $('#sb-eye').textContent = '视角海拔高度 ' + f.alt(camera.positionCartographic.height);
  }

  const NICE = [1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 1e4, 2e4, 3e4, 5e4, 1e5, 2e5, 3e5, 5e5, 1e6, 2e6, 3e6, 5e6];
  function updateScale(now) {
    if (now - lastScale < 250) return;
    lastScale = now;
    const bar = $('#scalebar');
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    let y = h - 60;
    let a = GE.controls.pickGround(new C.Cartesian2(w / 2 - 50, y));
    let b = GE.controls.pickGround(new C.Cartesian2(w / 2 + 50, y));
    if (!a || !b) {
      y = h / 2;
      a = GE.controls.pickGround(new C.Cartesian2(w / 2 - 50, y));
      b = GE.controls.pickGround(new C.Cartesian2(w / 2 + 50, y));
    }
    if (!a || !b) {
      bar.style.visibility = 'hidden';
      return;
    }
    const geod = new C.EllipsoidGeodesic(C.Cartographic.fromCartesian(a), C.Cartographic.fromCartesian(b));
    const mpp = geod.surfaceDistance / 100;
    if (!(mpp > 0)) {
      bar.style.visibility = 'hidden';
      return;
    }
    let nice = NICE[0];
    for (let i = 0; i < NICE.length; i++) {
      if (NICE[i] / mpp <= 130) nice = NICE[i];
    }
    bar.style.visibility = 'visible';
    $('#scalebar-label').textContent = nice >= 1000 ? nice / 1000 + ' 公里' : nice + ' 米';
    $('#scalebar-line').style.width = Math.max(8, Math.round(nice / mpp)) + 'px';
  }

  function updateNav() {
    const deg = Math.round(C.Math.toDegrees(camera.heading) * 10) / 10;
    if (deg !== lastHeadingDeg) {
      lastHeadingDeg = deg;
      $('#nav-ring-rot').setAttribute('transform', 'rotate(' + -deg + ' 50 50)');
    }
    if (!zoomDrag) {
      const top = ((1 - GE.controls.getZoomT()) * 100).toFixed(1) + '%';
      if (top !== lastThumbTop) {
        lastThumbTop = top;
        $('#nav-zoom-thumb').style.top = top;
      }
    } else {
      lastThumbTop = null;
    }
  }

  let lastThumbTop = null;
  let zoomDrag = false;
  function bindNav() {
    $$('#nav [data-act]').forEach((node) => {
      const act = node.dataset.act;
      const up = () => {
        GE.controls.hold(act, false);
        node.classList.remove('pressed');
      };
      node.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { node.setPointerCapture(e.pointerId); } catch (err) { /* 个别浏览器不支持对 SVG 元素捕获指针 */ }
        GE.controls.hold(act, true);
        node.classList.add('pressed');
      });
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
      node.addEventListener('lostpointercapture', up);
    });

    // 拖动外圈旋转视图；点击 N 恢复正北
    const ring = $('#nav-look');
    let drag = null;
    const angleOf = (e) => {
      const r = ring.getBoundingClientRect();
      return Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2)));
    };
    $$('#nav-look .ring, #nav-north').forEach((node) => {
      node.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        drag = { a: angleOf(e), moved: false, onNorth: !!e.target.closest('#nav-north') };
        try { ring.setPointerCapture(e.pointerId); } catch (err) { /* 同上 */ }
        GE.controls.cancelMotion();
      });
    });
    ring.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const a = angleOf(e);
      let d = a - drag.a;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) < 0.004) return;
      drag.moved = true;
      drag.a = a;
      GE.controls.orbit(-d, 0);
    });
    const endDrag = () => {
      if (drag && !drag.moved && drag.onNorth) GE.controls.northUp();
      drag = null;
    };
    ring.addEventListener('pointerup', endDrag);
    ring.addEventListener('pointercancel', () => { drag = null; });

    // 缩放滑块
    const track = $('#nav-zoom-track');
    const setFromEvent = (e) => {
      const r = track.getBoundingClientRect();
      const t = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      $('#nav-zoom-thumb').style.top = (1 - t) * 100 + '%';
      GE.controls.setZoomT(t);
    };
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      zoomDrag = true;
      track.setPointerCapture(e.pointerId);
      setFromEvent(e);
    });
    track.addEventListener('pointermove', (e) => { if (zoomDrag) setFromEvent(e); });
    const endZoom = () => { zoomDrag = false; };
    track.addEventListener('pointerup', endZoom);
    track.addEventListener('pointercancel', endZoom);
  }

  function bindStatus() {
    const handler = new C.ScreenSpaceEventHandler(canvas);
    handler.setInputAction((e) => {
      mousePos = C.Cartesian2.clone(e.endPosition, mousePos || new C.Cartesian2());
    }, C.ScreenSpaceEventType.MOUSE_MOVE);
    canvas.addEventListener('pointerleave', () => { mousePos = null; });

    const fg = $('#stream-fg');
    const circ = 2 * Math.PI * 7;
    fg.style.strokeDasharray = circ;
    const text = $('#sb-stream-text');
    function setProgress(n) {
      if (n === 0) {
        queueMax = 0;
        fg.style.strokeDashoffset = 0;
        text.textContent = '瓦片已就绪 · 累计 ' + GE.imagery.totalTiles + ' 块';
        document.body.classList.remove('streaming');
      } else {
        queueMax = Math.max(queueMax, n);
        fg.style.strokeDashoffset = circ * (n / queueMax);
        text.textContent = '正在加载瓦片，剩余 ' + n + ' 块';
        document.body.classList.add('streaming');
      }
    }
    // 队列长度几乎每帧都在变，界面最多每 120 毫秒刷新一次，避免拖慢渲染
    let pendingCount = 0;
    let shownCount = -1;
    let lastProgress = 0;
    scene.globe.tileLoadProgressEvent.addEventListener((n) => { pendingCount = n; });

    scene.postRender.addEventListener(() => {
      const now = performance.now();
      if (pendingCount !== shownCount && now - lastProgress >= 120) {
        lastProgress = now;
        shownCount = pendingCount;
        setProgress(pendingCount);
      }
      updateStatus(now);
      updateScale(now);
      updateNav();
    });
  }

  function bindImageryEvents() {
    const label = $('#sb-source');
    GE.bus.on('imagery:change', (d) => {
      label.textContent = '影像：' + d.source.name;
      label.title = d.source.credit || '';
      $('#credits').textContent = (d.source.credit || '') + ' · CesiumJS';
      const prev = d.previous ? GE.imagery.byId(d.previous) : null;
      if (d.reason === 'degrade') UI.toast((prev ? prev.name : '当前影像源') + '连不上，已自动切换到：' + d.source.name, 'warn', 6000);
      else if (d.reason === 'recover') UI.toast('已恢复到更高优先级的影像源：' + d.source.name, 'ok', 5000);
      else if (d.reason === 'manual-unreachable') UI.toast(d.source.name + ' 当前连不上，画面会停留在本地底图；可在“图层 → 影像源”改回自动', 'warn', 7000);
      else if (d.source.local && GE.imagery.mode === 'auto') UI.toast('在线影像源都连不上，正在使用本地蓝色大理石底图', 'warn', 7000);
      else if (d.reason === 'startup' && d.id !== GE.sources[0].id) UI.toast(GE.sources[0].name + '连不上，当前使用：' + d.source.name, 'warn', 6000);
      renderLayers();
    });
    GE.bus.on('imagery:unreachable', (d) => {
      UI.toast(d.source.name + ' 当前连不上；可在“图层 → 影像源”改回自动', 'warn', 7000);
    });
    GE.bus.on('imagery:status', renderLayers);
    GE.bus.on('imagery:mode', renderLayers);
    GE.bus.on('terrain:change', renderLayers);
  }

  /* ---------- 工具：添加地标、标尺 / 路径 / 多边形 ---------- */
  const T = (GE.tools = { active: null, cleanup: null });
  T.isActive = () => !!T.active;
  T.cancel = function () {
    if (T.cleanup) {
      const fn = T.cleanup;
      T.cleanup = null;
      fn();
    }
    T.active = null;
    document.body.classList.remove('tool-active');
  };

  T.addPlacemark = async function () {
    T.cancel();
    const target = GE.controls.centerTarget();
    if (!target) {
      UI.toast('请先把视图对准地面再添加地标', 'warn');
      return;
    }
    const c0 = C.Cartographic.fromCartesian(target);
    const state = { lat: C.Math.toDegrees(c0.latitude), lon: C.Math.toDegrees(c0.longitude) };
    const entity = viewer.entities.add({
      position: new C.CallbackProperty(() => C.Cartesian3.fromDegrees(state.lon, state.lat), false),
      billboard: pinGraphics(),
    });
    const handler = new C.ScreenSpaceEventHandler(canvas);
    let box = null;
    const sync = () => {
      if (!box) return;
      $('.f-lat', box).value = state.lat.toFixed(6);
      $('.f-lon', box).value = state.lon.toFixed(6);
    };
    handler.setInputAction((e) => {
      const p = GE.controls.pickGround(e.position);
      if (!p) return;
      const c = C.Cartographic.fromCartesian(p);
      state.lat = C.Math.toDegrees(c.latitude);
      state.lon = C.Math.toDegrees(c.longitude);
      sync();
    }, C.ScreenSpaceEventType.LEFT_CLICK);

    T.active = 'placemark';
    document.body.classList.add('tool-active');
    T.cleanup = () => {
      handler.destroy();
      viewer.entities.remove(entity);
    };

    const result = await UI.dialog({
      title: '新建地标',
      side: true,
      body:
        '<label class="field"><span>名称</span><input type="text" class="f-name" value="未命名地标"></label>' +
        '<div class="field-row"><label class="field"><span>纬度</span><input type="text" class="f-lat" inputmode="decimal"></label>' +
        '<label class="field"><span>经度</span><input type="text" class="f-lon" inputmode="decimal"></label></div>' +
        '<label class="field"><span>说明</span><textarea class="f-desc" rows="3"></textarea></label>' +
        '<p class="modal-hint">在地图上单击可以移动图钉的位置。</p>',
      buttons: [
        { label: '取消', value: null },
        {
          label: '确定',
          primary: true,
          value: (b) => {
            const lat = parseFloat($('.f-lat', b).value);
            const lon = parseFloat($('.f-lon', b).value);
            if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) {
              UI.toast('经纬度无效：纬度范围 -90 到 90，经度范围 -180 到 180', 'warn');
              return undefined;
            }
            return { name: $('.f-name', b).value.trim() || '未命名地标', desc: $('.f-desc', b).value.trim(), lat, lon };
          },
        },
      ],
      onOpen: (b) => {
        box = b;
        sync();
        const onEdit = () => {
          const lat = parseFloat($('.f-lat', b).value);
          const lon = parseFloat($('.f-lon', b).value);
          if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
            state.lat = lat;
            state.lon = lon;
          }
        };
        $('.f-lat', b).addEventListener('input', onEdit);
        $('.f-lon', b).addEventListener('input', onEdit);
      },
    });
    box = null;
    if (T.active === 'placemark') T.cancel();
    if (result) {
      P.add({ type: 'placemark', name: result.name, desc: result.desc, lat: result.lat, lon: result.lon });
      UI.toast('已添加地标：' + result.name);
    }
  };

  function pathLength(coords) {
    let d = 0;
    for (let i = 1; i < coords.length; i++) {
      const g = new C.EllipsoidGeodesic(
        C.Cartographic.fromDegrees(coords[i - 1][0], coords[i - 1][1]),
        C.Cartographic.fromDegrees(coords[i][0], coords[i][1])
      );
      d += g.surfaceDistance;
    }
    return d;
  }
  function polygonArea(coords) {
    const R = 6371008.8;
    let sum = 0;
    for (let i = 0; i < coords.length; i++) {
      const a = coords[i];
      const b = coords[(i + 1) % coords.length];
      sum += C.Math.toRadians(b[0] - a[0]) * (2 + Math.sin(C.Math.toRadians(a[1])) + Math.sin(C.Math.toRadians(b[1])));
    }
    return Math.abs((sum * R * R) / 2);
  }

  T.startDraw = function (mode) {
    T.cancel();
    const titles = { ruler: '标尺', path: '新建路径', polygon: '新建多边形' };
    const color = mode === 'ruler' ? C.Color.fromCssColorString('#ffe36e') : C.Color.WHITE;
    const pts = []; // [lon, lat]
    let cursor = null;
    let finished = false;

    const toCartesian = (list) => {
      const flat = [];
      list.forEach((c) => flat.push(c[0], c[1]));
      return C.Cartesian3.fromDegreesArray(flat);
    };
    const livePoints = () => {
      const list = cursor && !finished ? pts.concat([cursor]) : pts.slice();
      if (mode === 'polygon' && list.length > 2) list.push(list[0]);
      return list;
    };

    const line = viewer.entities.add({
      polyline: {
        positions: new C.CallbackProperty(() => toCartesian(livePoints()), false),
        width: 3,
        material: color,
        depthFailMaterial: color,
        arcType: C.ArcType.GEODESIC,
      },
    });
    const dots = [];
    const addDot = (c) => {
      dots.push(viewer.entities.add({
        position: C.Cartesian3.fromDegrees(c[0], c[1]),
        point: { pixelSize: 8, color: C.Color.fromCssColorString('#ea4335'), outlineColor: C.Color.WHITE, outlineWidth: 1.5 },
      }));
    };

    const panel = $('#toolpanel');
    panel.innerHTML =
      '<div class="tp-title"><span>' + titles[mode] + '</span><button type="button" class="tp-x" title="关闭">×</button></div>' +
      '<div class="tp-read"></div>' +
      '<div class="tp-hint">单击添加点，双击或按 Enter 完成，Backspace 撤销上一点，Esc 取消。</div>' +
      '<div class="tp-actions"><button type="button" data-act="clear">清除</button><button type="button" class="primary" data-act="done">' + (mode === 'ruler' ? '完成' : '保存…') + '</button></div>';
    panel.hidden = false;

    function readout() {
      const list = cursor && !finished ? pts.concat([cursor]) : pts;
      let html = '';
      if (mode === 'polygon') {
        const ring = list.length > 2 ? list.concat([list[0]]) : list;
        html = '<div><span>周长</span><b>' + f.dist(pathLength(ring)) + '</b></div><div><span>面积</span><b>' + (list.length > 2 ? f.area(polygonArea(list)) : '—') + '</b></div>';
      } else {
        html = '<div><span>长度</span><b>' + f.dist(pathLength(list)) + '</b></div>';
      }
      html += '<div><span>点数</span><b>' + pts.length + '</b></div>';
      $('.tp-read', panel).innerHTML = html;
    }
    readout();

    const toLonLat = (pos) => {
      const p = GE.controls.pickGround(pos);
      if (!p) return null;
      const c = C.Cartographic.fromCartesian(p);
      return [C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude)];
    };

    const handler = new C.ScreenSpaceEventHandler(canvas);
    handler.setInputAction((e) => {
      if (finished) return;
      const c = toLonLat(e.position);
      if (!c) return;
      const last = pts[pts.length - 1];
      if (last && Math.abs(last[0] - c[0]) < 1e-9 && Math.abs(last[1] - c[1]) < 1e-9) return; // 双击的第二下
      pts.push(c);
      addDot(c);
      readout();
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((e) => {
      if (finished) return;
      cursor = toLonLat(e.endPosition);
      readout();
    }, C.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(() => finish(), C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    function clearPoints() {
      pts.length = 0;
      dots.splice(0).forEach((d) => viewer.entities.remove(d));
      finished = false;
      cursor = null;
      readout();
    }
    function undo() {
      if (finished || !pts.length) return;
      pts.pop();
      const d = dots.pop();
      if (d) viewer.entities.remove(d);
      readout();
    }
    async function finish() {
      if (finished) return;
      const need = mode === 'polygon' ? 3 : 2;
      if (pts.length < need) {
        UI.toast('至少需要 ' + need + ' 个点', 'warn');
        return;
      }
      finished = true;
      cursor = null;
      readout();
      if (mode === 'ruler') return;
      const name = await promptText(titles[mode], '名称', mode === 'path' ? '未命名路径' : '未命名多边形');
      if (!name) {
        finished = false;
        return;
      }
      P.add({ type: mode, name, coords: pts.slice() });
      UI.toast('已保存到“我的地点”：' + name);
      T.cancel();
    }

    function onKey(e) {
      if (UI.isModalOpen()) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(); }
      else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
    }
    document.addEventListener('keydown', onKey);
    panel.onclick = (e) => {
      if (e.target.closest('.tp-x')) T.cancel();
      else if (e.target.closest('[data-act="clear"]')) clearPoints();
      else if (e.target.closest('[data-act="done"]')) finish();
    };

    T.active = mode;
    document.body.classList.add('tool-active');
    T.cleanup = () => {
      handler.destroy();
      document.removeEventListener('keydown', onKey);
      viewer.entities.remove(line);
      dots.forEach((d) => viewer.entities.remove(d));
      panel.hidden = true;
      panel.onclick = null;
    };
  };

  /* ---------- 全局快捷键 ---------- */
  function bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggle('sidebar');
        return;
      }
      if (UI.isModalOpen()) return;
      if (e.key === 'Escape') {
        if (openMenu) closeMenu();
        else if (T.isActive()) T.cancel();
        else if (typing) e.target.blur();
        else if (GE.search.cardVisible) $('#infocard [data-act="close"]').click();
        return;
      }
      if (!typing && e.key === '/' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        focusSearch();
      }
    });
  }

  /* ---------- 初始化 ---------- */
  UI.init = function (v) {
    viewer = v;
    scene = v.scene;
    camera = v.camera;
    canvas = v.canvas;

    buildMenus();
    buildToolbar();
    bindSearch();
    bindNav();
    bindStatus();
    bindImageryEvents();
    bindGlobalKeys();

    $$('.panel-head').forEach((head) => {
      head.addEventListener('click', () => head.parentElement.classList.toggle('collapsed'));
    });
    $('#file-kml').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) importKml(file);
    });

    // 打印时用当前画面的截图顶替画布（WebGL 画布直接打印可能是空白）
    window.addEventListener('beforeprint', () => {
      viewer.render();
      const old = $('#print-shot');
      if (old) old.remove();
      $('#view').appendChild(el('img', { id: 'print-shot', alt: '', src: canvas.toDataURL('image/jpeg', 0.92) }));
    });
    window.addEventListener('afterprint', () => {
      const shot = $('#print-shot');
      if (shot) shot.remove();
    });

    P.my = GE.store.get('places', []).filter((it) => it && it.id && it.type);
    P.my.forEach(createEntity);

    ['sidebar', 'toolbar', 'statusbar', 'scalebar', 'nav', 'atmosphere', 'sun'].forEach(applySetting);
    if (settings.grid) applySetting('grid');
    if (settings.terrain) applySetting('terrain');

    renderPlaces();
    renderLayers();
    renderToolbarState();
  };
})();
