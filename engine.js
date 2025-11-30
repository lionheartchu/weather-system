// Core weather-driven particle engine
// 固定系统：weatherState + applyMapping + shared flow rule
// v = v_shape + v_large + v_small + v_direction + v_vertical

// -------------------------
// 1. weatherState schema
// -------------------------
export function createDefaultWeatherState() {
  return {
    // A. 动力学 / 形体相关
    deformFactor: 0.0,        // 粒子偏离 base shape 的程度 (0 = 紧贴, 1 = 完全撕裂)
    shapeStrength: 1.0,       // base shape 吸引力有多强
    flowDirection: [0, 0, 0], // 全局漂移方向 (例如风向)
    flowSpeed: 0.0,           // 全局漂移速度大小
    turbulence: 0.0,          // 扰动强度 (0~1)
    noiseScaleLarge: 1.0,     // 大尺度噪声（整体卷曲尺寸）
    noiseScaleSmall: 1.0,     // 小尺度噪声（边缘颗粒感）
    verticalBias: 0.0,        // 垂直偏置 (>0 往下), 雨/雪用

    clusterStrength: 0.0,     // 聚合/排斥强度 (>0 聚团, <0 互斥) — 当前未直接使用，可扩展

    // B. 粒子生命周期 & 数量（spawnRate 在外部管理，这里只用 lifeSpan）
    spawnRate: 0.0,           // 每秒生成多少粒子（由外部系统决定如何使用）
    lifeSpan: 1.0,            // 平均寿命（秒）

    // C. 粒子局部属性
    sizeMin: 1.0,
    sizeMax: 1.0,

    // D. 视觉 / 材质相关（渲染层使用）
    brightness: 1.0,          // 整体亮度
    contrast: 1.0,            // 对比度
    colorTemperature: 0.5,    // 冷暖（0=冷, 1=暖）
    softness: 0.5,            // 粒子边缘软硬
    trailLength: 0.3          // 残影长度
  };
}

// -------------------------
// 2. applyMapping
//    normalizedInputs: { cloudCover: 0~1, humidity: 0~1, ... }
//    mappingConfig: { deformFactor: { from, min, max }, ... }
// -------------------------
export function applyMapping(normalizedInputs, mappingConfig, baseState) {
  const ws = { ...(baseState || createDefaultWeatherState()) };

  for (const key in mappingConfig) {
    const cfg = mappingConfig[key]; // { from: "cloudCover", min: x, max: y }
    const t = normalizedInputs[cfg.from];
    if (t === undefined) continue;  // 对应 input 未提供时跳过

    const clampedT = clamp01(t);
    const v = cfg.min + (cfg.max - cfg.min) * clampedT;
    ws[key] = v;
  }

  return ws;
}

// -------------------------
// 3. updateParticle — shared flow field rule
//    v = v_shape + v_large + v_small + v_direction + v_vertical
//
// p: 粒子对象 { position: [x,y,z], velocity?: [x,y,z], life: 0~1 }
// dt: delta time (秒)
// weatherState: 上面 schema 的实例
// projectToShape: function(vec3 position) -> vec3 (base shape 投影点)
// noiseFn: function(vec3 position, number time) -> vec3 (噪声向量)
// time: 全局时间 (秒)
// -------------------------
export function updateParticle(p, dt, weatherState, projectToShape, noiseFn, time) {
  // fallback 防止没初始化
  if (!p.position) p.position = [0, 0, 0];
  if (!p.velocity) p.velocity = [0, 0, 0];
  if (p.life === undefined) p.life = 1.0;
  const t = time || 0;

  // ---- v_shape：形体吸引 ----
  // 外部传入 projectToShape，决定 base shape 的拓扑
  const shapePos = projectToShape ? projectToShape(p.position) : p.position;
  const dirShape = sub(shapePos, p.position);
  const dirShapeNorm = normalizeSafe(dirShape);

  const wShape = weatherState.shapeStrength * (1.0 - clamp01(weatherState.deformFactor));
  const v_shape = mulScalar(dirShapeNorm, wShape);

  // ---- v_large：大尺度流场 ----
  const posLarge = mulScalar(p.position, weatherState.noiseScaleLarge);
  const nLarge = noiseFn ? noiseFn(posLarge, t) : [0, 0, 0];
  const v_large = mulScalar(normalizeSafe(nLarge), weatherState.turbulence);

  // ---- v_small：小尺度扰动 ----
  const posSmall = mulScalar(p.position, weatherState.noiseScaleSmall);
  const nSmall = noiseFn ? noiseFn(posSmall, t + 100.0) : [0, 0, 0];
  const v_small = mulScalar(normalizeSafe(nSmall), weatherState.turbulence * 0.5);

  // ---- v_direction：整体方向漂移 ----
  const dir = normalizeSafe(weatherState.flowDirection || [0, 0, 0]);
  const v_direction = mulScalar(dir, weatherState.flowSpeed);

  // ---- v_vertical：垂直偏置（雨/雪）----
  const v_vertical = [0, -weatherState.verticalBias, 0];

  // ---- 合力：v = v_shape + v_large + v_small + v_direction + v_vertical ----
  let v = add(
    v_shape,
    add(
      v_large,
      add(
        v_small,
        add(v_direction, v_vertical)
      )
    )
  );

  // ---- 简单速度平滑（保持“同一家人”的运动风格）----
  v = mixVec(p.velocity, v, 0.2); // smoothingFactor = 0.2

  // ---- 限速（防止爆炸）----
  const maxSpeed = 5.0;
  v = clampLength(v, 0.0, maxSpeed);

  // ---- 更新粒子位置和速度 ----
  p.position = add(p.position, mulScalar(v, dt));
  p.velocity = v;

  // ---- 更新生命周期 ----
  p.life -= dt / Math.max(weatherState.lifeSpan, 0.0001);
}

// -------------------------
// 4. 简单向量工具函数（3D）
// -------------------------
function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function mulScalar(v, s) {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function length(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function clampLength(v, minLen, maxLen) {
  const len = length(v);
  if (len === 0) return v;
  const clamped = Math.min(Math.max(len, minLen), maxLen);
  const scale = clamped / len;
  return mulScalar(v, scale);
}

function normalizeSafe(v) {
  const len = length(v);
  if (len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function mixVec(a, b, t) {
  const s = 1 - t;
  return [
    a[0] * s + b[0] * t,
    a[1] * s + b[1] * t,
    a[2] * s + b[2] * t
  ];
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
