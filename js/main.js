/* 启动入口：创建三维地球，设置画质，初始化各模块 */
(async function () {
  'use strict';
  const loading = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');

  function fail(message, error) {
    if (error) console.error(error);
    loading.classList.remove('hidden');
    loading.classList.add('error');
    loadingText.textContent = message;
  }

  if (!window.Cesium) {
    fail('三维引擎文件缺失：找不到 lib/Cesium/Cesium.js。请确认项目文件夹完整，并通过“启动.bat”打开。');
    return;
  }
  const C = Cesium;
  const cfg = GE.config;

  let viewer;
  try {
    viewer = new C.Viewer('cesiumContainer', {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      vrButton: false,
      projectionPicker: false,
      scene3DOnly: true,
      // 版权信息由界面右下角自己显示，这里给一个不显示的容器
      creditContainer: document.createElement('div'),
      contextOptions: { webgl: { alpha: false, antialias: true, powerPreference: 'high-performance' } },
    });
  } catch (e) {
    fail('无法创建三维画面：浏览器没有可用的 WebGL。请用新版 Chrome 或 Edge 打开，并在浏览器设置里开启硬件加速。', e);
    return;
  }

  const scene = viewer.scene;
  const globe = scene.globe;

  /* ---------- 画质 ---------- */
  // 按屏幕真实像素渲染（高分屏不发糊），最高 2 倍
  const dpr = window.devicePixelRatio || 1;
  viewer.useBrowserRecommendedResolution = false;
  viewer.resolutionScale = Math.min(dpr, 2) / dpr;
  // LOD 误差 ≤ 1.5，开启 FXAA 抗锯齿
  globe.maximumScreenSpaceError = cfg.maxScreenSpaceError;
  scene.postProcessStages.fxaa.enabled = true;
  globe.tileCacheSize = 600;
  globe.baseColor = C.Color.fromCssColorString('#0b1a33');
  globe.enableLighting = false;
  globe.showGroundAtmosphere = true;
  scene.highDynamicRange = false;
  viewer.clock.shouldAnimate = false;

  // 高速运动时画面本来就看不清，按 1.5 去加载沿途的瓦片只会拖慢帧率（实测长途飞行会掉帧）。
  // 这里在高速运动期间把误差临时放宽一档，速度降下来就恢复，静止画面始终是 1.5。
  if (cfg.motion && cfg.motion.sse > cfg.maxScreenSpaceError) {
    const lastPos = new C.Cartesian3();
    let lastTime = 0;
    let relaxedUntil = 0;
    scene.preUpdate.addEventListener(() => {
      const now = performance.now();
      const pos = viewer.camera.positionWC;
      if (lastTime) {
        const dt = (now - lastTime) / 1000;
        const height = Math.max(viewer.camera.positionCartographic.height, 100);
        if (dt > 0 && C.Cartesian3.distance(pos, lastPos) / dt / height > cfg.motion.speed) relaxedUntil = now + cfg.motion.holdMs;
      }
      C.Cartesian3.clone(pos, lastPos);
      lastTime = now;
      const want = now < relaxedUntil ? cfg.motion.sse : cfg.maxScreenSpaceError;
      if (globe.maximumScreenSpaceError !== want) globe.maximumScreenSpaceError = want;
    });
  }

  viewer.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.home.lon, cfg.home.lat, cfg.home.height),
    orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
  });

  GE.viewer = viewer;
  window.viewer = viewer;

  /* ---------- 模块 ---------- */
  try {
    GE.controls.init(viewer);
    GE.search.init(viewer);
    const imageryReady = GE.imagery.init(viewer);
    GE.ui.init(viewer);

    // 本地底图很快就能显示，不必等在线影像源探测完成；但要等地标预热结束（预热时地标会画出来，需要遮罩挡住）
    const minDelay = new Promise((resolve) => setTimeout(resolve, 600));
    await Promise.all([minDelay, GE.search.ready]);
    loading.classList.add('hidden');
    await imageryReady;
  } catch (e) {
    fail('初始化失败：' + (e && e.message ? e.message : e), e);
    return;
  }

  /* ---------- 可选：Google 实景三维（需要在 js/config.js 里填写自己的密钥） ---------- */
  if (cfg.googleMapsApiKey) {
    try {
      const tileset = await C.createGooglePhotorealistic3DTileset({ key: cfg.googleMapsApiKey });
      scene.primitives.add(tileset);
      GE.photo3d = tileset;
      GE.ui.toast('已启用 Google 实景三维', 'ok');
    } catch (e) {
      console.error(e);
      GE.ui.toast('Google 实景三维加载失败：请检查密钥是否有效、是否已开通 Map Tiles API', 'warn', 8000);
    }
  }
})();
