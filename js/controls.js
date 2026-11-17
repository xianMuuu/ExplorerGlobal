/* 相机操作：键盘、鼠标、导航环共用的平移 / 缩放 / 旋转 / 倾斜 */
(function () {
  'use strict';
  const C = Cesium;
  let viewer, scene, camera, canvas;

  const MIN_RANGE = 25; // 最近离地面的距离（米）
  // 最远缩放：停在“完整地球视图”。再远（比如 5e7）地球会缩成一个小球，不像谷歌地球——谷歌地球往下滚到底只缩到整球默认状态就停。
  const MAX_RANGE = 2.2e7;
  // 俯仰角范围：接近垂直俯视（留一点余量，否则朝向会丢失）到接近平视
  const MIN_PITCH = -C.Math.PI_OVER_TWO + 0.0015;
  const MAX_PITCH = C.Math.toRadians(-2);
  const EARTH_R = 6371008.8;

  const ROT_RATE = C.Math.toRadians(70); // 按住时每秒旋转角度
  const TILT_RATE = C.Math.toRadians(45);
  const ZOOM_RATE = 1.7; // 按住时距离按 e^(-rate*t) 变化
  const SMOOTH = 9; // 速度跟随系数，越大越“跟手”

  const held = Object.create(null); // 动作名 -> 是否按住
  const heldSince = Object.create(null);
  const keyToAction = Object.create(null); // e.code -> 动作名
  const vel = { panX: 0, panY: 0, zoom: 0, rot: 0, tilt: 0 };
  let zoomInertia = 0; // 滚轮缩放惯性（对数速度，正值拉远）
  let lastTime = 0;
  let anim = null;

  const scratch2 = new C.Cartesian2();

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function pickGround(pos) {
    const ray = camera.getPickRay(pos);
    const p = ray ? scene.globe.pick(ray, scene) : undefined;
    return p || camera.pickEllipsoid(pos, scene.globe.ellipsoid);
  }

  /* 屏幕中心对着的地面点；看向太空时返回 undefined */
  function centerTarget() {
    scratch2.x = canvas.clientWidth / 2;
    scratch2.y = canvas.clientHeight / 2;
    return pickGround(scratch2);
  }

  /* 相机相对某地面点的朝向、俯仰、距离（在该点的东-北-天坐标系里） */
  function hprAbout(target) {
    const m = C.Transforms.eastNorthUpToFixedFrame(target);
    const inv = C.Matrix4.inverseTransformation(m, new C.Matrix4());
    const d = C.Matrix4.multiplyByPointAsVector(inv, camera.directionWC, new C.Cartesian3());
    C.Cartesian3.normalize(d, d);
    let heading;
    if (Math.hypot(d.x, d.y) < 1e-4) {
      // 垂直俯视：视线没有水平分量，用屏幕“上”方向定朝向
      const u = C.Matrix4.multiplyByPointAsVector(inv, camera.upWC, new C.Cartesian3());
      heading = Math.atan2(u.x, u.y);
    } else {
      heading = Math.atan2(d.x, d.y);
    }
    return {
      heading,
      pitch: Math.asin(clamp(d.z, -1, 1)),
      range: C.Cartesian3.distance(camera.positionWC, target),
    };
  }

  /* 绕屏幕中心地面点旋转（dHeading）和倾斜（dPitch，正值朝地平线方向抬起） */
  function orbit(dHeading, dPitch) {
    const target = centerTarget();
    if (!target) return false;
    const c = hprAbout(target);
    const heading = c.heading + (dHeading || 0);
    const pitch = clamp(c.pitch + (dPitch || 0), MIN_PITCH, MAX_PITCH);
    camera.lookAt(target, new C.HeadingPitchRange(heading, pitch, clamp(c.range, MIN_RANGE, MAX_RANGE)));
    camera.lookAtTransform(C.Matrix4.IDENTITY);
    return true;
  }

  function currentRange() {
    const t = centerTarget();
    if (t) return C.Cartesian3.distance(camera.positionWC, t);
    return Math.max(camera.positionCartographic.height, MIN_RANGE);
  }

  /* 按屏幕方向平移：x 向右为正，y 向屏幕上方为正，单位米（沿地面） */
  function panBy(x, y) {
    const dist = Math.hypot(x, y);
    if (dist < 1e-6) return;
    const carto = camera.positionCartographic;
    const heading = camera.heading;
    const pitch = camera.pitch;
    const bearing = heading + Math.atan2(x, y);
    const ang = dist / EARTH_R;
    const lat1 = carto.latitude;
    const sinLat2 = Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(bearing);
    const limit = C.Math.toRadians(89.5);
    const lat2 = clamp(Math.asin(clamp(sinLat2, -1, 1)), -limit, limit);
    const lon2 = carto.longitude + Math.atan2(
      Math.sin(bearing) * Math.sin(ang) * Math.cos(lat1),
      Math.cos(ang) - Math.sin(lat1) * sinLat2
    );
    camera.setView({
      destination: C.Cartesian3.fromRadians(lon2, lat2, carto.height),
      orientation: { heading, pitch, roll: 0 },
    });
  }

  function setRange(range) {
    range = clamp(range, MIN_RANGE, MAX_RANGE);
    camera.moveForward(currentRange() - range);
  }

  /* factor < 1 拉近，> 1 拉远。
     围绕屏幕中心的地面点缩放（lookAt 保持该点在屏幕中央），
     这样倾斜视角下地球也不会随缩放跑到屏幕下方。
     缩小（factor>1）时俯仰角逐步回正到垂直俯视（谷歌地球手感）；放大保持当前倾斜。 */
  function zoomBy(factor) {
    const target = centerTarget();
    if (!target) {
      // 看向太空时没有地面锚点，退化为沿视线移动
      camera.moveForward(currentRange() * (1 - factor));
      return;
    }
    const c = hprAbout(target);
    const next = clamp(c.range * factor, MIN_RANGE, MAX_RANGE);
    let pitch = c.pitch;
    if (factor > 1) {
      // 拉得越远回正越多；逐帧小步累积，丝滑过渡到俯视
      const k = clamp(1 - 1 / factor, 0, 1) * 0.5;
      pitch = c.pitch + (MIN_PITCH - c.pitch) * k;
    }
    if (Math.abs(next - c.range) > 1e-3 || Math.abs(pitch - c.pitch) > 1e-6) {
      camera.lookAt(target, new C.HeadingPitchRange(c.heading, pitch, next));
      camera.lookAtTransform(C.Matrix4.IDENTITY);
    }
  }

  /* 以鼠标所指的地面点为锚点缩放（双击用），带缓动 */
  function zoomToward(pos, factor) {
    const p = pickGround(pos);
    if (!p) return;
    const cam = camera.positionWC;
    const dist = C.Cartesian3.distance(cam, p);
    const next = clamp(dist * factor, MIN_RANGE * 2, MAX_RANGE);
    if (Math.abs(next - dist) < 1) return;
    const dir = C.Cartesian3.normalize(C.Cartesian3.subtract(cam, p, new C.Cartesian3()), new C.Cartesian3());
    const dest = C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(dir, next, new C.Cartesian3()), new C.Cartesian3());
    cancelMotion();
    camera.flyTo({
      destination: dest,
      orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 },
      duration: 0.45,
      easingFunction: C.EasingFunction.QUADRATIC_OUT,
    });
  }

  function shortestAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  /* 把朝向/俯仰平滑地转到目标值（绕屏幕中心）。传 undefined 表示该项不变。 */
  function animateOrientation(targetHeading, targetPitch, seconds) {
    camera.cancelFlight();
    const duration = (seconds || 0.6) * 1000;
    const t0 = performance.now();
    let prev = 0;
    const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
    anim = function (now) {
      const u = clamp((now - t0) / duration, 0, 1);
      const target = centerTarget();
      if (!target) { anim = null; return; }
      const c = hprAbout(target);
      const e0 = ease(prev);
      const e1 = ease(u);
      const frac = e0 >= 1 ? 1 : (e1 - e0) / (1 - e0); // 本帧走完“剩余量”的多少
      const dH = targetHeading === undefined ? 0 : shortestAngle(targetHeading - c.heading) * frac;
      const dP = targetPitch === undefined ? 0 : (targetPitch - c.pitch) * frac;
      orbit(dH, dP);
      prev = u;
      if (u >= 1) anim = null;
    };
  }

  function cancelMotion() {
    anim = null;
    camera.cancelFlight();
  }

  function hold(action, on) {
    if (on) {
      if (!held[action]) heldSince[action] = performance.now();
      held[action] = true;
      cancelMotion();
    } else if (held[action]) {
      // 短按也保证有一个可见的步进
      const since = heldSince[action];
      const rest = 200 - (performance.now() - since);
      if (rest > 0) setTimeout(() => { if (heldSince[action] === since) held[action] = false; }, rest);
      else held[action] = false;
    }
  }

  function releaseAll() {
    Object.keys(held).forEach((k) => { held[k] = false; });
    Object.keys(keyToAction).forEach((k) => { delete keyToAction[k]; });
  }

  function axis(pos, neg) {
    return (held[pos] ? 1 : 0) - (held[neg] ? 1 : 0);
  }

  /* 每帧：把按住的动作变成带缓入缓出的连续运动 */
  function update() {
    const now = performance.now();
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt <= 0) return;
    if (dt > 0.1) dt = 0.1;

    if (anim) anim(now);

    const k = 1 - Math.exp(-dt * SMOOTH);
    vel.panX += (axis('panRight', 'panLeft') - vel.panX) * k;
    vel.panY += (axis('panUp', 'panDown') - vel.panY) * k;
    vel.zoom += (axis('zoomIn', 'zoomOut') - vel.zoom) * k;
    vel.rot += (axis('rotRight', 'rotLeft') - vel.rot) * k;
    vel.tilt += (axis('tiltUp', 'tiltDown') - vel.tilt) * k;

    const eps = 0.003;
    if (Math.abs(vel.panX) > eps || Math.abs(vel.panY) > eps) {
      const speed = Math.min(currentRange() * 0.9, EARTH_R * 0.7);
      panBy(vel.panX * speed * dt, vel.panY * speed * dt);
    }
    if (Math.abs(vel.zoom) > eps) zoomBy(Math.exp(-vel.zoom * ZOOM_RATE * dt));
    if (Math.abs(zoomInertia) > 0.0005) {
      zoomBy(Math.exp(zoomInertia));
      zoomInertia *= 0.93; // 惯性衰减
    } else if (zoomInertia !== 0) {
      zoomInertia = 0;
    }
    if (Math.abs(vel.rot) > eps || Math.abs(vel.tilt) > eps) {
      orbit(vel.rot * ROT_RATE * dt, vel.tilt * TILT_RATE * dt);
    }
  }

  function isTyping(e) {
    const t = e.target;
    if (!t || !t.tagName) return false;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
  }

  function actionFor(e) {
    const arrows = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' };
    const d = arrows[e.key];
    if (e.ctrlKey || e.altKey || e.metaKey) return null;
    if (d) {
      if (e.shiftKey) {
        // Shift+左右：旋转；Shift+下：朝地平线抬起；Shift+上：回到俯视
        return d === 'Left' ? 'rotLeft' : d === 'Right' ? 'rotRight' : d === 'Up' ? 'tiltDown' : 'tiltUp';
      }
      return 'pan' + d;
    }
    if (e.key === '+' || e.key === '=' || e.key === 'PageUp') return 'zoomIn';
    if (e.key === '-' || e.key === '_' || e.key === 'PageDown') return 'zoomOut';
    return null;
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (isTyping(e) || (GE.ui && GE.ui.isModalOpen && GE.ui.isModalOpen())) return;
      const action = actionFor(e);
      if (action) {
        e.preventDefault();
        const old = keyToAction[e.code];
        if (old && old !== action) hold(old, false);
        keyToAction[e.code] = action;
        hold(action, true);
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      const key = e.key.toLowerCase();
      if (key === 'n') northUp();
      else if (key === 'u') topDown();
      else if (key === 'r') resetView();
    });
    document.addEventListener('keyup', (e) => {
      const action = keyToAction[e.code];
      if (action) {
        delete keyToAction[e.code];
        hold(action, false);
      }
    });
    window.addEventListener('blur', releaseAll);
  }

  function bindMouse() {
    const ssc = scene.screenSpaceCameraController;
    ssc.minimumZoomDistance = MIN_RANGE;
    ssc.maximumZoomDistance = MAX_RANGE;
    ssc.inertiaSpin = 0.92;
    ssc.inertiaTranslate = 0.92;
    ssc.inertiaZoom = 0.82;
    // 左键拖动：抓着地球平移；滚轮 / 右键拖动：以鼠标位置为锚点缩放；
    // 中键拖动、Shift/Ctrl+左键拖动：旋转和倾斜
    ssc.rotateEventTypes = [C.CameraEventType.LEFT_DRAG];
    // 滚轮改由下方自定义 handler 接管（围绕屏幕中心地面点缩放，倾斜时不跑偏）；
    // 触屏捏合、右键拖动仍走 Cesium 默认缩放
    ssc.zoomEventTypes = [C.CameraEventType.PINCH, C.CameraEventType.RIGHT_DRAG];
    ssc.tiltEventTypes = [
      C.CameraEventType.MIDDLE_DRAG,
      C.CameraEventType.PINCH,
      { eventType: C.CameraEventType.LEFT_DRAG, modifier: C.KeyboardEventModifier.SHIFT },
      { eventType: C.CameraEventType.LEFT_DRAG, modifier: C.KeyboardEventModifier.CTRL },
      { eventType: C.CameraEventType.RIGHT_DRAG, modifier: C.KeyboardEventModifier.CTRL },
    ];
    ssc.lookEventTypes = [];

    const defaults = viewer.cesiumWidget.screenSpaceEventHandler;
    defaults.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    defaults.removeInputAction(C.ScreenSpaceEventType.LEFT_CLICK);

    const handler = new C.ScreenSpaceEventHandler(canvas);
    handler.setInputAction((e) => {
      if (GE.tools && GE.tools.isActive()) return;
      zoomToward(e.position, 0.5);
    }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    // 右键双击：缩小
    let lastRight = { t: 0, x: 0, y: 0 };
    canvas.addEventListener('pointerdown', (e) => {
      cancelMotion();
      if (e.button !== 2) return;
      const now = performance.now();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (now - lastRight.t < 350 && Math.hypot(x - lastRight.x, y - lastRight.y) < 8) {
        lastRight.t = 0;
        if (!(GE.tools && GE.tools.isActive())) zoomToward(new C.Cartesian2(x, y), 2.0);
      } else {
        lastRight = { t: now, x, y };
      }
    }, true);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      cancelMotion();
      // 归一化 deltaY（像素/行/页），累积成惯性速度：向下滚拉远，向上滚拉近
      const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1);
      zoomInertia += (d / 120) * 0.14;
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function northUp() { animateOrientation(0, undefined, 0.6); }
  function topDown() { animateOrientation(undefined, MIN_PITCH, 0.6); }
  function resetView() { animateOrientation(0, MIN_PITCH, 0.7); }

  function flyHome(seconds) {
    const h = GE.config.home;
    cancelMotion();
    camera.flyTo({
      destination: C.Cartesian3.fromDegrees(h.lon, h.lat, h.height),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
      duration: seconds === undefined ? 2.0 : seconds,
      easingFunction: C.EasingFunction.CUBIC_IN_OUT,
    });
  }

  /* 缩放滑块用：0 = 最远，1 = 最近（对数刻度） */
  const LOG_MIN = Math.log(MIN_RANGE);
  const LOG_MAX = Math.log(MAX_RANGE);
  function getZoomT() {
    return clamp(1 - (Math.log(currentRange()) - LOG_MIN) / (LOG_MAX - LOG_MIN), 0, 1);
  }
  function setZoomT(t) {
    cancelMotion();
    setRange(Math.exp(LOG_MAX - clamp(t, 0, 1) * (LOG_MAX - LOG_MIN)));
  }

  function init(v) {
    viewer = v;
    scene = v.scene;
    camera = v.camera;
    canvas = v.canvas;
    bindMouse();
    bindKeyboard();
    lastTime = performance.now();
    scene.preUpdate.addEventListener(update);
  }

  GE.controls = {
    init, hold, releaseAll, orbit, panBy, zoomBy, zoomToward, setRange, currentRange,
    getZoomT, setZoomT, northUp, topDown, resetView, flyHome, cancelMotion,
    centerTarget, pickGround, hprAbout,
    limits: { MIN_RANGE, MAX_RANGE, MIN_PITCH, MAX_PITCH },
  };
})();
