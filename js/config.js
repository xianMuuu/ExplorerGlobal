/* 全局命名空间、配置、影像源定义、离线地名表 */
window.GE = window.GE || {};

GE.config = {
  // 启动时的全球视角
  home: { lon: 108.0, lat: 30.0, height: 1.8e7 },
  // 搜索定位：沿缓动曲线飞行 2 秒，停在目标上空 2000 米
  fly: { duration: 2.0, height: 2000 },
  // 地形/影像 LOD 屏幕空间误差（越小越清晰，Cesium 默认 2）
  maxScreenSpaceError: 1.5,
  // 相机高速运动（飞行途中、猛甩地球）时临时把误差放宽到 sse，慢下来立刻恢复到上面的 1.5。
  // speed 是判定“高速”的门槛：每秒移动的距离超过当前视角高度的多少倍。把 sse 改成 1.5 即关闭这项优化。
  motion: { sse: 3, speed: 2.5, holdMs: 80 },
  // 影像源探测超时（毫秒）
  probeTimeout: 5000,
  // 自动模式下，每隔多久尝试回升到更高优先级的影像源（毫秒）
  recheckInterval: 45000,
  // 运行中降级判据：窗口期内错误数和错误占比都超过阈值，或者连续失败达到 minErrors 次；复测也失败才切换
  degrade: { windowMs: 12000, minErrors: 6, errorRatio: 0.6 },
  // 可选地形（ArcGIS 全球高程，无需密钥）
  terrainUrl: 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer',
  // 可选：填入自己的 Google Maps API 密钥（需开通 Map Tiles API）后，启用 Google 实景三维模型。
  // 留空则不启用。注意：这一项没有密钥无法实测，属于未验证功能。
  googleMapsApiKey: '',
};

/*
 * 影像源，按优先级从高到低排列。自动模式下依次探测，用第一个可用的；
 * 全部不可用时只显示本地蓝色大理石底图。
 *   sat    卫星影像层
 *   labels 注记层（地名、道路、边界），叠加在卫星影像上
 *   gcj02  该图层使用国测局偏移坐标，加载时做纠偏：
 *          true       整层纠偏（高德）
 *          'mainland' 只在中国大陆范围内纠偏（Google 注记在大陆带偏移，港澳台和国外不带）
 */
GE.sources = [
  {
    id: 'google',
    name: 'Google 高清卫星',
    credit: '影像 © Google',
    probe: 'https://mt0.google.com/vt/lyrs=s&x=6&y=3&z=3&scale=2',
    sat: {
      url: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}&scale=2',
      subdomains: ['0', '1', '2', '3'],
      maximumLevel: 20,
    },
    labels: {
      url: 'https://mt{s}.google.com/vt/lyrs=h&x={x}&y={y}&z={z}&scale=2&hl=zh-CN',
      subdomains: ['0', '1', '2', '3'],
      maximumLevel: 20,
      // 删掉这一行就恢复 Google 原样（大陆范围内路网和地名会比影像偏出几百米，与正版 Google 地球一致）
      gcj02: 'mainland',
    },
  },
  {
    id: 'gaode',
    name: '高德卫星',
    credit: '影像 © 高德地图',
    probe: 'https://webst01.is.autonavi.com/appmaptile?style=6&x=6&y=3&z=3',
    sat: {
      url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
      subdomains: ['1', '2', '3', '4'],
      maximumLevel: 18,
      gcj02: true,
    },
    labels: {
      url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}',
      subdomains: ['1', '2', '3', '4'],
      maximumLevel: 18,
      gcj02: true,
    },
  },
  {
    id: 'esri',
    name: 'Esri 世界影像',
    credit: '影像 © Esri, Maxar, Earthstar Geographics',
    probe: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/3/6',
    sat: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19,
    },
    labels: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 12,
    },
  },
  {
    id: 'bluemarble',
    name: '本地蓝色大理石',
    credit: '底图：NASA Blue Marble（本地）',
    local: true,
    url: 'assets/bluemarble.jpg',
  },
];

/* 简单的事件总线 */
GE.bus = (function () {
  const map = Object.create(null);
  return {
    on(evt, fn) { (map[evt] = map[evt] || []).push(fn); },
    emit(evt, data) {
      (map[evt] || []).forEach((fn) => {
        try { fn(data); } catch (e) { console.error('[GE] 事件处理出错 ' + evt, e); }
      });
    },
  };
})();

/* 本地存储（读写失败时静默退回默认值，例如浏览器禁用了存储） */
GE.store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('ge.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('ge.' + key, JSON.stringify(value)); } catch (e) { /* 存储不可用时忽略 */ }
  },
};

/*
 * 离线地名表：在线地名服务都不可用时的兜底。
 * [名称, 别名(空格分隔), 纬度, 经度, 说明]
 */
GE.gazetteer = [
  ['香港大学', 'hku 港大 university of hong kong', 22.2830, 114.1371, '香港岛薄扶林道'],
  ['香港中文大学', 'cuhk 中大', 22.4196, 114.2068, '香港新界沙田'],
  ['香港科技大学', 'hkust 科大', 22.3364, 114.2655, '香港新界清水湾'],
  ['维多利亚港', 'victoria harbour', 22.2930, 114.1694, '香港'],
  ['香港国际机场', 'hkg 赤鱲角机场', 22.3080, 113.9185, '香港大屿山'],
  ['香港', 'hong kong', 22.3193, 114.1694, '中国香港特别行政区'],
  ['澳门', 'macau macao', 22.1987, 113.5439, '中国澳门特别行政区'],
  ['天安门', 'tiananmen', 39.9087, 116.3975, '北京市东城区'],
  ['故宫', '紫禁城 forbidden city', 39.9163, 116.3972, '北京市东城区'],
  ['八达岭长城', '长城 great wall', 40.3598, 116.0200, '北京市延庆区'],
  ['清华大学', 'tsinghua', 40.0000, 116.3264, '北京市海淀区'],
  ['北京大学', '北大 pku peking university', 39.9926, 116.3055, '北京市海淀区'],
  ['北京', 'beijing', 39.9042, 116.4074, '中国首都'],
  ['东方明珠', 'oriental pearl', 31.2397, 121.4998, '上海市浦东新区'],
  ['外滩', 'the bund', 31.2400, 121.4900, '上海市黄浦区'],
  ['上海', 'shanghai', 31.2304, 121.4737, '中国'],
  ['广州塔', 'canton tower 小蛮腰', 23.1065, 113.3245, '广州市海珠区'],
  ['广州', 'guangzhou', 23.1291, 113.2644, '广东省'],
  ['深圳', 'shenzhen', 22.5431, 114.0579, '广东省'],
  ['杭州西湖', '西湖 west lake', 30.2420, 120.1490, '浙江省杭州市'],
  ['杭州', 'hangzhou', 30.2741, 120.1551, '浙江省'],
  ['南京', 'nanjing', 32.0603, 118.7969, '江苏省'],
  ['武汉', 'wuhan', 30.5928, 114.3055, '湖北省'],
  ['成都', 'chengdu', 30.5728, 104.0668, '四川省'],
  ['重庆', 'chongqing', 29.5630, 106.5516, '中国'],
  ['西安', 'xian', 34.3416, 108.9398, '陕西省'],
  ['布达拉宫', 'potala', 29.6578, 91.1169, '西藏拉萨'],
  ['珠穆朗玛峰', '珠峰 everest', 27.9881, 86.9250, '喜马拉雅山脉'],
  ['台北', 'taipei', 25.0330, 121.5654, '中国台湾'],
  ['东京塔', 'tokyo tower', 35.6586, 139.7454, '日本东京'],
  ['富士山', 'mount fuji', 35.3606, 138.7274, '日本'],
  ['东京', 'tokyo', 35.6762, 139.6503, '日本'],
  ['首尔', 'seoul', 37.5665, 126.9780, '韩国'],
  ['新加坡', 'singapore', 1.3521, 103.8198, '新加坡'],
  ['滨海湾金沙', 'marina bay sands', 1.2834, 103.8607, '新加坡'],
  ['泰姬陵', 'taj mahal', 27.1751, 78.0421, '印度阿格拉'],
  ['哈利法塔', 'burj khalifa 迪拜塔', 25.1972, 55.2744, '阿联酋迪拜'],
  ['迪拜', 'dubai', 25.2048, 55.2708, '阿联酋'],
  ['吉萨金字塔', '金字塔 pyramids giza', 29.9792, 31.1342, '埃及开罗'],
  ['开罗', 'cairo', 30.0444, 31.2357, '埃及'],
  ['红场', 'red square', 55.7539, 37.6208, '俄罗斯莫斯科'],
  ['莫斯科', 'moscow', 55.7558, 37.6173, '俄罗斯'],
  ['埃菲尔铁塔', 'eiffel tower', 48.8584, 2.2945, '法国巴黎'],
  ['巴黎', 'paris', 48.8566, 2.3522, '法国'],
  ['大本钟', 'big ben', 51.5007, -0.1246, '英国伦敦'],
  ['伦敦', 'london', 51.5074, -0.1278, '英国'],
  ['柏林', 'berlin', 52.5200, 13.4050, '德国'],
  ['罗马斗兽场', '斗兽场 colosseum', 41.8902, 12.4922, '意大利罗马'],
  ['罗马', 'rome roma', 41.9028, 12.4964, '意大利'],
  ['自由女神像', 'statue of liberty', 40.6892, -74.0445, '美国纽约'],
  ['时代广场', 'times square', 40.7580, -73.9855, '美国纽约'],
  ['纽约', 'new york nyc', 40.7128, -74.0060, '美国'],
  ['白宫', 'white house', 38.8977, -77.0365, '美国华盛顿'],
  ['金门大桥', 'golden gate bridge', 37.8199, -122.4783, '美国旧金山'],
  ['旧金山', 'san francisco', 37.7749, -122.4194, '美国'],
  ['洛杉矶', 'los angeles', 34.0522, -118.2437, '美国'],
  ['大峡谷', 'grand canyon', 36.1069, -112.1129, '美国亚利桑那州'],
  ['里约基督像', 'christ the redeemer', -22.9519, -43.2105, '巴西里约热内卢'],
  ['马丘比丘', 'machu picchu', -13.1631, -72.5450, '秘鲁'],
  ['悉尼歌剧院', 'sydney opera house', -33.8568, 151.2153, '澳大利亚悉尼'],
  ['悉尼', 'sydney', -33.8688, 151.2093, '澳大利亚'],
];
