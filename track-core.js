'use strict';
// ---------- GPS track generation (Phase 4) ----------
// 打卡环坐标必须由调用方提供（来自 /routes/nearby 或 state 里的 routes），仓库内不内置任何学校的坐标。

// 自由跑没有路线，但仍要交一条合规轨迹。用与任何学校无关的合成圆环：
// 半径按经度缩放，保证高纬度也不会退化。仅用于占位形状，真实校园跑必须用平台返回的 checkpoints。
function syntheticRing(segments) {
  const n = Math.max(4, segments || 15);
  const lat = 0, lon = 0, rLat = 0.0006, rLon = 0.0008;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * 2 * Math.PI;
    ring.push([+(lat + rLat * Math.sin(a)).toFixed(7), +(lon + rLon * Math.cos(a)).toFixed(7)]);
  }
  return ring;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- 拟真层（默认开启）----------
// 目标：在严格满足客户端硬规则的前提下，让轨迹在「服务端基础统计」下与真实跑步不可分。
// 三层物理分离：
//   运动学层：跑者速度波动（AR(1)），决定实际走了多远
//   观测层  ：手机 GPS 定位误差（AR(1) 二维），只是测量偏差，不改变实际位移
//   过滤层  ：客户端 RunTrack 同款平滑与下限规则
// 默认值取自文献量级：配速 CV 3~8%、开阔地 GPS 1σ 3~5m。
const REALISM_DEFAULTS = {
  gpsSigmaM: 3,        // 观测噪声 1σ（米）。>4 时点距易跌破 6m 下限，触发丢点
  gpsPhi: 0.75,        // 观测噪声 AR(1) 系数；真实 GPS 误差强时间相关
  speedCv: 0.05,       // 速度变异系数（大众跑者 5%）
  speedPhi: 0.7,       // 速度 AR(1) 系数
  dtJitterSec: 0.5,    // 采样间隔抖动半宽（秒）
  accuracyMedianM: 8,
  accuracyPhi: 0.8,
  seed: null,          // null=每次随机；设值则完全可复现（测试用）
};

// mulberry32：给定 seed 可复现；seed=null 时退回 Math.random。
function makeRng(seed) {
  if (seed === null || seed === undefined) return Math.random;
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// AR(1)：x[i] = phi*x[i-1] + sqrt(1-phi²)*eps，稳态方差 1。phi=0 退化为白噪声。
function ar1(n, phi, rng) {
  const out = new Array(n);
  let x = gauss(rng);
  out[0] = x;
  const k = Math.sqrt(Math.max(0, 1 - phi * phi));
  for (let i = 1; i < n; i++) { x = phi * x + k * gauss(rng); out[i] = x; }
  return out;
}

// 采样步长（秒）。保证点距过平台下限、且 <15s 不触发分段。
// 弧长下限取 7.6m 而非平台下限 6m：采样点连成折线后跨顶点会切角，实测折损约 8%，
// 最慢合规配速（1km/600s）下用 6m 只有 1.8% 余量（折线 6.11m），薄得像纸。
// generateTrack 与上游的点数闸门共用此函数，避免两处公式漂移。
function trackStepSec(distanceM, durationSec) {
  const speed = distanceM / durationSec; // m/s
  return Math.max(4, Math.min(12, 7.6 / speed));
}

// 环几何：各段长度与总长
function ringGeometry(pts) {
  const segLen = [];
  let ringLen = 0;
  for (let i = 0; i < pts.length; i++) {
    const [la1, lo1] = pts[i], [la2, lo2] = pts[(i + 1) % pts.length];
    const d = haversineM(la1, lo1, la2, lo2);
    segLen.push(d); ringLen += d;
  }
  return { segLen, ringLen };
}

// 弧长 → 经纬度。rem 必须从 0 起算（用圈数当初值会让圆周接缝处跳变一整圈）。
function pointAtArc(pts, segLen, ringLen, arc) {
  let rem = arc % ringLen, idx = 0;
  while (rem > segLen[idx]) { rem -= segLen[idx]; idx = (idx + 1) % pts.length; }
  const [la1, lo1] = pts[idx], [la2, lo2] = pts[(idx + 1) % pts.length];
  const f = segLen[idx] === 0 ? 0 : rem / segLen[idx];
  return [la1 + (la2 - la1) * f, lo1 + (lo2 - lo1) * f];
}

// 生成轨迹点：{latitude, longitude, timestamp, accuracy}
// distanceM = 申报距离（米）。总长收敛到它 —— 服务端按 routeData 重算，对不上就是硬伤。
// startMs   = 轨迹起始时刻（应等于申报 startTime），缺省取当前时刻。
// checkpoints = [[lat,lng],...] 闭合环（末点连首点），至少 4 点；无隐式默认。
// options = {realism:{...}, seed}；realism:false 退回等速实现（仅测试对照用）。
function generateTrack(distanceM, durationSec, startMs, checkpoints, options) {
  const opt = options || {};
  if (opt.realism === false) return generateNaiveTrack(distanceM, durationSec, startMs, checkpoints);
  return generateRealisticTrack(distanceM, durationSec, startMs, checkpoints, opt);
}

function generateRealisticTrack(distanceM, durationSec, startMs, checkpoints, opt) {
  if (!Array.isArray(checkpoints) || checkpoints.length < 4) {
    throw new Error(`未提供打卡环（至少 4 个点，收到 ${Array.isArray(checkpoints) ? checkpoints.length : "非数组"}）`);
  }
  const pts = checkpoints;
  const { segLen, ringLen } = ringGeometry(pts);
  const t0 = startMs === undefined ? Date.now() : startMs;
  const R = Object.assign({}, REALISM_DEFAULTS, opt.realism || {});
  const rng = makeRng(opt.seed === undefined ? R.seed : opt.seed);
  const nominal = distanceM / durationSec;
  const baseStep = trackStepSec(distanceM, durationSec);
  const MAX_SPEED = 8, MIN_STEP = 6, TARGET_STEP = 13;

  // ---- 采样时刻 ----
  // 每段 dt 被三条硬约束夹住：
  //   位移 >= 13m （留余量给观测噪声，否则点距跌破 6m → 丢点 → 收敛跳变）
  //   间隔 < 14s  （平台 segmentBreakGapSec = 15）
  //   间隔 >= 1s  （毫秒取整后时间戳不能撞车）
  // 段数装不下就加密/抽稀，不放宽约束。
  const vFloor = Math.max(0.5, 1 - 4 * R.speedCv);
  const loDt = Math.max(1.0, baseStep * 0.6, TARGET_STEP / (nominal * vFloor));
  const hiDt = Math.min(14, Math.max(baseStep * 1.4, loDt * 1.3));
  let nSeg = Math.max(2, Math.round(durationSec / Math.max(baseStep, loDt)));
  while (nSeg > 2 && nSeg * loDt > durationSec) nSeg -= 1;
  while (nSeg * hiDt < durationSec) nSeg += 1;
  if (nSeg * loDt > durationSec || nSeg * hiDt < durationSec) {
    throw new Error(`时长 ${durationSec}s 无法在点距>=${MIN_STEP}m、间隔<15s 下分配（${nSeg} 段，区间 ${(nSeg * loDt).toFixed(0)}~${(nSeg * hiDt).toFixed(0)}s）`);
  }

  const dt0 = durationSec / nSeg;
  const jitter = Math.min(R.dtJitterSec, Math.max(0, Math.min(dt0 - loDt, hiDt - dt0)));
  const dtSec = [0];
  for (let i = 1; i <= nSeg; i++) dtSec.push(Math.min(hiDt, Math.max(loDt, dt0 + (rng() * 2 - 1) * jitter)));
  // 残差均分到未触边界的段，clamp 后单调收敛（按剩余容量加权会过冲）。
  for (let it = 0; it < 200; it++) {
    const diff = durationSec - dtSec.reduce((x, y) => x + y, 0);
    if (Math.abs(diff) < 1e-7) break;
    const free = [];
    for (let i = 1; i <= nSeg; i++) if (diff > 0 ? dtSec[i] < hiDt - 1e-9 : dtSec[i] > loDt + 1e-9) free.push(i);
    if (!free.length) break;
    const share = diff / free.length;
    for (const i of free) dtSec[i] = Math.min(hiDt, Math.max(loDt, dtSec[i] + share));
  }
  const tSec = [0];
  for (let i = 1; i <= nSeg; i++) tSec.push(tSec[i - 1] + dtSec[i]);

  // ---- 噪声序列 ----
  // 一次生成、收敛期间复用 —— 否则二分的目标函数不是确定函数，收敛无从谈起。
  const n = nSeg + 1;
  const speedNoise = ar1(n, R.speedPhi, rng).map((x) => 1 + R.speedCv * x);
  const gpsX = ar1(n, R.gpsPhi, rng).map((x) => x * R.gpsSigmaM);
  const gpsY = ar1(n, R.gpsPhi, rng).map((x) => x * R.gpsSigmaM);
  const accSeries = ar1(n, R.accuracyPhi, rng);
  const accMed = R.accuracyMedianM;

  const refLat = pts[0][0];
  const mPerLon = 111320 * Math.cos(refLat * Math.PI / 180);
  const mPerLat = 111320;

  // 观测噪声按切向/垂直分解，切向只保留 30%。
  // 依据：上传的 routeData 已过客户端 5 点中位平滑，切向高频抖动本就被吸收；
  // 而切向噪声直接压缩点距，会触发 6m 下限丢点，让收敛跳变。
  const TANGENTIAL_KEEP = 0.3;
  const makePoint = (arc, i) => {
    const [la, lo] = pointAtArc(pts, segLen, ringLen, arc);
    const [la2, lo2] = pointAtArc(pts, segLen, ringLen, arc + 1);
    let tx = (lo2 - lo) * mPerLon, ty = (la2 - la) * mPerLat;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const along = gpsX[i] * tx + gpsY[i] * ty;
    const across = -gpsX[i] * ty + gpsY[i] * tx;
    return {
      latitude: +(la + (ty * along * TANGENTIAL_KEEP + tx * across) / mPerLat).toFixed(7),
      longitude: +(lo + (tx * along * TANGENTIAL_KEEP - ty * across) / mPerLon).toFixed(7),
      timestamp: t0 + Math.round(tSec[i] * 1000),
      accuracy: +Math.max(3, Math.min(60, accMed * Math.exp(0.35 * accSeries[i]))).toFixed(1),
    };
  };
  const walkedM = (arr) => arr.reduce((acc, q, i) =>
    i === 0 ? 0 : acc + haversineM(arr[i - 1].latitude, arr[i - 1].longitude, q.latitude, q.longitude), 0);

  // 目标函数：只依赖 scale，必须确定。
  const build = (scale) => {
    const out = [];
    let arc = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) arc += nominal * scale * speedNoise[i] * dtSec[i];
      out.push(makePoint(arc, i));
    }
    return out;
  };

  // 二分：walked(scale) 严格单调递增（每段位移乘同一正数）。
  // 越界点（点距<6m / 速度>8m/s）偶尔出现，剔除后重来，最多 3 轮。
  let keepMask = new Array(n).fill(true), best = null, bestErr = Infinity;
  for (let round = 0; round < 3; round++) {
    const pick = (arr) => arr.filter((_, i) => keepMask[i]);
    let lo = 0.4, hi = 2.5;
    let localBest = null, localErr = Infinity;
    if (walkedM(pick(build(hi))) < distanceM) {
      localBest = pick(build(hi)); localErr = Math.abs(walkedM(localBest) - distanceM);
    } else {
      for (let it = 0; it < 60; it++) {
        const mid = (lo + hi) / 2;
        const cand = pick(build(mid));
        const err = walkedM(cand) - distanceM;
        if (Math.abs(err) < localErr) { localBest = cand; localErr = Math.abs(err); }
        if (err < 0) lo = mid; else hi = mid;
      }
    }
    if (localErr < bestErr) { best = localBest; bestErr = localErr; }
    if (best && bestErr / distanceM < 5e-5) break;

    const dropTs = new Set();
    for (let k = 1; k < best.length; k++) {
      const prev = best[k - 1], cur = best[k];
      const d = haversineM(prev.latitude, prev.longitude, cur.latitude, cur.longitude);
      const dt = (cur.timestamp - prev.timestamp) / 1000;
      if (d < MIN_STEP * 0.999 || (dt > 0 && d / dt > MAX_SPEED * 0.999)) dropTs.add(cur.timestamp);
    }
    if (!dropTs.size) break;
    for (let i = 0; i < n; i++) if (dropTs.has(t0 + Math.round(tSec[i] * 1000))) keepMask[i] = false;
    if (keepMask.filter(Boolean).length < 2) throw new Error('噪声导致有效点不足 2 个，请降低 gpsSigmaM');
    bestErr = Infinity;
  }

  return {
    points: best.slice(0, 500), declaredM: distanceM, walkedM: walkedM(best),
    speed: nominal, ringLen, stepSec: baseStep, t0,
  };
}

// 客户端 RunTrack 过滤的等价实现（模块 759）：
//   5 点中位平滑 → 距上一点 <6m 丢弃 → 传送剔除 → 点数上限抽稀
// 只复刻影响「上传点数与总长」的部分。转弯/运动确认依赖 speed 字段，
// 而真实上传数据不带 speed（normalizeRouteDataForPersistence 会丢弃），故不复刻。
function clientFilter(points, maxPoints) {
  if (!Array.isArray(points) || points.length === 0) return [];
  let buf = [];
  const smoothed = points.map((p) => {
    buf.push(p);
    if (buf.length > 5 || p.timestamp - buf[0].timestamp > 4000) buf.shift();
    if (buf.length < 2) return p;
    const la = buf.map((x) => x.latitude).sort((a, b) => a - b);
    const lo = buf.map((x) => x.longitude).sort((a, b) => a - b);
    const mid = Math.floor(la.length / 2);
    return Object.assign({}, p, {
      latitude: la.length % 2 ? la[mid] : (la[mid - 1] + la[mid]) / 2,
      longitude: lo.length % 2 ? lo[mid] : (lo[mid - 1] + lo[mid]) / 2,
    });
  });
  const out = [smoothed[0]];
  for (let i = 1; i < smoothed.length; i++) {
    const prev = out[out.length - 1];
    const d = haversineM(prev.latitude, prev.longitude, smoothed[i].latitude, smoothed[i].longitude);
    const dt = (smoothed[i].timestamp - prev.timestamp) / 1000;
    if (d > 180) continue;
    if (dt > 0 && d / dt > 8) continue;
    if (d >= 6) out.push(smoothed[i]);
  }
  if (out.length <= maxPoints) return out;
  // Math.round 在 ratio<1 时会取到重复索引 → 重复点时间戳差为 0 → 下游 d/dt=Infinity。
  const keep = [out[0]];
  const picked = new Set([0]);
  const ratio = (out.length - 1) / (maxPoints - 1);
  for (let i = 1; i < maxPoints - 1; i++) {
    const k = Math.round(i * ratio);
    if (!picked.has(k)) { picked.add(k); keep.push(out[k]); }
  }
  if (!picked.has(out.length - 1)) keep.push(out[out.length - 1]);
  return keep;
}

// 等速实现（拟真层之前的行为）。保留作负样本与回归对照，不对外暴露。
function generateNaiveTrack(distanceM, durationSec, startMs, checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length < 4) throw new Error(`未提供打卡环（至少 4 个点，收到 ${Array.isArray(checkpoints) ? checkpoints.length : "非数组"}）`);
  const pts = checkpoints;
  const { segLen, ringLen } = ringGeometry(pts);
  const t0 = startMs === undefined ? Date.now() : startMs;
  const nominal = distanceM / durationSec;
  const stepSec = trackStepSec(distanceM, durationSec);
  const steps = Math.floor(durationSec / stepSec);
  const sample = (speed) => {
    const pts2 = [];
    for (let i = 0; i <= steps; i++) {
      const s = i * stepSec;
      const [la, lo] = pointAtArc(pts, segLen, ringLen, speed * s);
      pts2.push({
        latitude: +la.toFixed(7),
        longitude: +lo.toFixed(7),
        timestamp: t0 + Math.round(s * 1000),
        accuracy: +(5 + Math.random() * 8).toFixed(1),
      });
    }
    return pts2;
  };
  const walkedM = (arr) => arr.reduce((acc, p, i) =>
    i === 0 ? 0 : acc + haversineM(arr[i - 1].latitude, arr[i - 1].longitude, p.latitude, p.longitude), 0);

  let lo = nominal * 0.7, hi = nominal * 1.6;
  let best = sample(nominal), bestErr = Math.abs(walkedM(best) - distanceM);
  if (walkedM(sample(hi)) < distanceM) { best = sample(hi); bestErr = Math.abs(walkedM(best) - distanceM); }
  else {
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      const cand = sample(mid);
      const err = walkedM(cand) - distanceM;
      if (Math.abs(err) < bestErr) { best = cand; bestErr = Math.abs(err); }
      if (err < 0) lo = mid; else hi = mid;
    }
  }
  return { points: best.slice(0, 500), declaredM: distanceM, walkedM: walkedM(best), speed: nominal, ringLen, stepSec, t0 };
}

module.exports = { haversineM, trackStepSec, generateTrack, syntheticRing, clientFilter, REALISM_DEFAULTS, generateNaiveTrack };
