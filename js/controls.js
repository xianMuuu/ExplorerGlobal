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
  let relaxUntil = 0; // 缩小（滚轮向下）后，在此时间戳前持续把俯仰角回正到垂直俯视
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

  /* 绕屏幕中心地面点旋转（dHeading）和倾斜（dPitch，正值朝地平线方向抬起）。
     供键盘旋转/倾斜和「缩小回正」用。鼠标拖动不走这里（见 orbitGlobeCenter / pivotDrag）。 */
  function orbit(dHeading, dPitch) {
    const target = centerTarget();
    if (!target) return false;
    const c = hprAbout(target);
    const heading = c.heading + (dHeading || 0);
    const pitch = clamp(c.pitch + (dPitch || 0), MIN_PITCH, MAX_PITCH);
    // 极点附近 heading/pitch 可能退化产生 NaN，保护相机不被锁死
    if (!Number.isFinite(heading) || !Number.isFinite(pitch) || !Number.isFinite(c.range)) return false;
    camera.lookAt(target, new C.HeadingPitchRange(heading, pitch, clamp(c.range, MIN_RANGE, MAX_RANGE)));
    camera.lookAtTransform(C.Matrix4.IDENTITY);
    return true;
  }

  /* 绕球心的轨道旋转：左键拖动。
     旋转中心是地心，不是屏幕中心的地面点，所以：
     - 拖动经过南北极不会卡死、不会翻转（heading 连续变化，pitch 有限位）；
     - 和谷歌地球一样，拖动就是拨动整个地球。 */
  function orbitGlobeCenter(dxPx, dyPx) {
    const k = Math.PI / Math.max(320, canvas.clientHeight);
    const r = Math.max(C.Cartesian3.magnitude(camera.positionWC), MIN_RANGE);
    const carto = C.Cartographic.fromCartesian(camera.positionWC);
    // 在相机当前位置的 ENU 里重算朝向
    const m = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0));
    const east = new C.Cartesian3(m[0], m[4], m[8]);
    const north = new C.Cartesian3(m[1], m[5], m[9]);
    const up = new C.Cartesian3(m[2], m[6], m[10]);
    const heading = camera.heading + dxPx * k;
    const pitch = clamp(camera.pitch - dyPx * k, MIN_PITCH, MAX_PITCH);
    if (!Number.isFinite(heading) || !Number.isFinite(pitch)) return;
    const dir = new C.Cartesian3(
      east.x * Math.sin(heading) * Math.cos(pitch) + north.x * Math.cos(heading) * Math.cos(pitch) + up.x * Math.sin(pitch),
      east.y * Math.sin(heading) * Math.cos(pitch) + north.y * Math.cos(heading) * Math.cos(pitch) + up.y * Math.sin(pitch),
      east.z * Math.sin(heading) * Math.cos(pitch) + north.z * Math.cos(heading) * Math.cos(pitch) + up.z * Math.sin(pitch)
    );
    const dest = C.Cartesian3.multiplyByScalar(dir, r, new C.Cartesian3());
    camera.setView({ destination: dest, orientation: { heading, pitch, roll: 0 } });
  }

  /* Alt+左拖：抬头/低头（相机原地点头，位置不动） */
  function lookBy(dyPx) {
    const k = C.Math.toRadians(0.12); // 每像素 0.12°
    camera.lookUp(-dyPx * k);
  }

  /* 双击按住拖：绕双击处地面点环视（旋转点锁定在该点） */
  let pivotPoint = null;
  let pivotHpr = null;
  function startPivot(pos) {
    const p = pickGround(pos);
    if (!p) return false;
    pivotPoint = p;
    pivotHpr = hprAbout(p);
    return true;
  }
  function pivotDrag(dxPx, dyPx) {
    if (!pivotPoint || !pivotHpr) return;
    const k = Math.PI / Math.max(320, canvas.clientHeight);
    const heading = pivotHpr.heading + dxPx * k;
    const pitch = clamp(pivotHpr.pitch - dyPx * k, MIN_PITCH, MAX_PITCH);
    if (!Number.isFinite(heading) || !Number.isFinite(pitch)) return;
    camera.lookAt(pivotPoint, new C.HeadingPitchRange(heading, pitch, pivotHpr.range));
    camera.lookAtTransform(C.Matrix4.IDENTITY);
  }
  function endPivot() { pivotPoint = null; pivotHpr = null; }

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
     缩小（factor>1）时俯仰角逐步回正到垂直俯视（谷歌地球手感）；放大保持当前倾斜。
     注意：本函数仅用于键盘 +/- 和导航环滑杆的连续缩放；滚轮走 Cesium 原生缩放（见 bindMouse）。 */
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
    if (!Number.isFinite(next) || !Number.isFinite(pitch) || !Number.isFinite(c.heading)) return;
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
    // 滚轮缩小后：在 relaxUntil 之前把俯仰角平滑回正到垂直俯视（只改俯仰，不动距离）
    if (performance.now() < relaxUntil) {
      const t = centerTarget();
      if (t) {
        const c = hprAbout(t);
        const dP = (MIN_PITCH - c.pitch) * (1 - Math.exp(-dt * 5));
        if (Math.abs(dP) > 1e-5) orbit(0, dP);
      }
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
    // 滚轮缩放速率：Cesium 默认 5.0（一格约 1.8 倍，太灵敏），取 3.2（一格约 1.45 倍），
    // 缓慢但不过分迟钝，接近谷歌地球手感
    ssc.zoomFactor = 3.2;
    // 关闭 Cesium 默认的拖动类交互：左拖/中拖/右拖/Shift/Ctrl 都由下方自定义 handler 接管，
    // 只有滚轮（WHEEL）和触屏捏合（PINCH）留在 Cesium 原生（方向稳定、极地安全、带惯性）
    ssc.rotateEventTypes = [];
    ssc.zoomEventTypes = [C.CameraEventType.WHEEL, C.CameraEventType.PINCH];
    ssc.tiltEventTypes = [C.CameraEventType.PINCH];
    ssc.translateEventTypes = [];
    ssc.lookEventTypes = [];

    const defaults = viewer.cesiumWidget.screenSpaceEventHandler;
    defaults.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    defaults.removeInputAction(C.ScreenSpaceEventType.LEFT_CLICK);

    const handler = new C.ScreenSpaceEventHandler(canvas);

    /* 自定义拖动状态机：
       - 左键拖（无 Alt）：绕球心旋转（orbitGlobeCenter）
       - Alt+左键拖：抬头/低头（lookBy）
       - 双击后按住左键拖：绕双击点环视（pivotDrag）
       - 右键拖：缩放（zoomBy）
       - 中键拖：平移（panBy） */
    let dragMode = null;
    let dragLast = { x: 0, y: 0 };
    let suppressDrag = false; // 双击后松手，用于延迟检测：若短时间再按下则进入环视
    let pendingPivotPos = null;
    let pivotArmed = false;
    let pivotTimer = null;

    function posOf(e) { return new C.Cartesian2(e.position.x, e.position.y); }

    handler.setInputAction((e) => {
      if (GE.tools && GE.tools.isActive()) return;
      if (dragMode) { endDrag(); return; }
      // 双击 = 放大（快速双击）；双击后按住拖 = 环视（在 LEFT_DOWN 里检测）
      const p = posOf(e);
      if (pivotArmed && pendingPivotPos && Math.abs(pendingPivotPos.x - p.x) < 3 && Math.abs(pendingPivotPos.y - p.y) < 3) {
        // 快速双击：放大
        zoomToward(p, 0.5);
        pivotArmed = false;
        pendingPivotPos = null;
        return;
      }
      pivotArmed = true;
      pendingPivotPos = p;
      if (pivotTimer) clearTimeout(pivotTimer);
      pivotTimer = setTimeout(() => { pivotArmed = false; pendingPivotPos = null; }, 300);
    }, C.ScreenSpaceEventType.LEFT_CLICK);

    function beginDrag(e, mode) {
      if (GE.tools && GE.tools.isActive()) return;
      cancelMotion();
      dragMode = mode;
      dragLast = { x: e.position.x, y: e.position.y };
      if (mode === 'pivot') {
        // 双击后按住：进入环视（旋转点锁定在双击处）
        if (!startPivot(posOf(e))) { dragMode = null; return; }
      }
    }
    function moveDrag(e) {
      if (!dragMode) return;
      const pos = e.endPosition || e.position;
      const dx = pos.x - dragLast.x;
      const dy = pos.y - dragLast.y;
      dragLast = { x: pos.x, y: pos.y };
      if (dragMode === 'orbit') orbitGlobeCenter(dx, dy);
      else if (dragMode === 'look') lookBy(dy);
      else if (dragMode === 'pivot') pivotDrag(dx, dy);
      else if (dragMode === 'zoom') zoomBy(Math.exp(dy * 0.0022));
      else if (dragMode === 'pan') panBy(-dx * 0.15, dy * 0.15);
    }
    function endDrag() {
      dragMode = null;
      endPivot();
    }

    handler.setInputAction((e) => {
      // 双击后 300ms 内再按下左键 = 锁定旋转点环视（谷歌地球手感）；否则普通绕球心旋转
      if (pivotArmed) {
        clearTimeout(pivotTimer);
        pivotTimer = null;
        pivotArmed = false;
        pendingPivotPos = null;
        beginDrag(e, 'pivot');
        return;
      }
      beginDrag(e, 'orbit');
    }, C.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction((e) => {
      endDrag();
    }, C.ScreenSpaceEventType.LEFT_UP);
    // Alt+左键拖：抬头/低头
    handler.setInputAction((e) => {
      beginDrag(e, 'look');
    }, { eventType: C.ScreenSpaceEventType.LEFT_DOWN, modifier: C.KeyboardEventModifier.ALT });
    // 通用移动：按当前 dragMode 分发
    handler.setInputAction((e) => {
      moveDrag(e);
    }, C.ScreenSpaceEventType.MOUSE_MOVE);
    // 右键拖：缩放
    handler.setInputAction((e) => {
      beginDrag(e, 'zoom');
    }, C.ScreenSpaceEventType.RIGHT_DOWN);
    // 中键拖：平移
    handler.setInputAction((e) => {
      beginDrag(e, 'pan');
    }, C.ScreenSpaceEventType.MIDDLE_DOWN);

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
    // 滚轮缩小（deltaY>0）时附加「俯仰回正」；不 preventDefault，缩放仍由 Cesium 原生处理
    canvas.addEventListener('wheel', (e) => {
      if (e.deltaY > 0) relaxUntil = performance.now() + 260;
    }, { passive: true });
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
