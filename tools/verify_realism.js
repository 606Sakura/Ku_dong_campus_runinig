// 轨迹「拟真度」自检：把生成器的机器指纹量化出来。
// 依据：客户端 RunTrack 只做几何/精度滤波（模块 759），不做统计判断 ——
//       所以这里检查的不是平台会不会拒，而是「服务端若做基础统计能否识破」。
// 硬失败项 = 平台规则或确定性缺陷；软指标 = 人类分布的连续谱，超界只警告。
// 运行：
//   node tools/verify_realism.js                 用默认参数生成一份样本
//   node tools/verify_realism.js --gen 1.2/600   指定 距离km/时长s
//   node tools/verify_realism.js --check <file>  检查已有轨迹（JSON 点数组 / state.json 的 runs[].track.points）
// 退出码 0 = 无硬失败。
'use strict';
const fs = require('fs');
const path = require('path');
const { generateTrack, haversineM, clientFilter } = require('../track-core');

// 客户端 CAMPUS 预设（app-service.js 模块 759，偏移 381171）
const PLATFORM = {
  minDistance: 6, maxSpeed: 8, maxSegmentDistance: 180,
  segmentBreakGapSec: 15, accuracyTrusted: 20, accuracyDegraded: 65, maxPoints: 500,
};
const RESIDUAL_LIMIT = 0.005; // 0.5%，与 verify_track.js 的 0.2% 不同：这里只防「明显对不上」

// 人类参考区间（来源：配速 CV 文献 3~12%，手机 GPS 1σ 3~5m；见 docs 与数据集调研）
const HUMAN = {
  dtUniquePct: [0.30, 1],      // 采样间隔唯一值比例下限
  pathDevSdM: [0.5, 12],       // 点到打卡环折线的最近距离标准差，米
  speedCvPct: [2, 15],         // 速度变异系数
  speedLag33: [-1, 0.5],       // 环周期自相关，超过 0.5 说明有机械周期
  accuracyLag1: [0.4, 1],      // 精度序列自相关，真实场景强相关
  startOffsetM: [0, 20],       // 起点与轨迹首点偏差
};

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

// ---------- 统计工具 ----------
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function acf(a, lag) {
  const m = mean(a);
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) {
    den += (a[i] - m) ** 2;
    if (i + lag < a.length) num += (a[i] - m) * (a[i + lag] - m);
  }
  return den === 0 ? 0 : num / den;
}

// 局部平面近似：把经纬度投到米制平面（跨度几十米，误差可忽略）。
// 返回 [x, y]，x 向东、y 向北，以 refLat 为基准。
function toPlane(lat, lon, refLat) {
  const M = 111320, k = Math.cos(refLat * Math.PI / 180);
  return [lon * k * M, lat * M];
}

// 点到线段的距离（米），全部在米制平面上算。
function pointToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const d2 = dx * dx + dy * dy;
  if (d2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// 每个点到「打卡环折线」的最近距离（米）。
// 这是判「轨迹是否精确落在几何折线上」的正确指标：机器生成 ≈ 毫米级，真实 GPS 3~5m。
// 没有环（--check 外部轨迹）时返回 null —— 如实标注，不猜。
function distanceToRing(points, ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const refLat = points[0].latitude;
  const ringXY = ring.map(([la, lo]) => toPlane(la, lo, refLat));
  return points.map((p) => {
    const xy = toPlane(p.latitude, p.longitude, refLat);
    let best = Infinity;
    for (let i = 0; i < ringXY.length; i++) {
      const d = pointToSegment(xy, ringXY[i], ringXY[(i + 1) % ringXY.length]);
      if (d < best) best = d;
    }
    return best;
  });
}

// ---------- 核心分析 ----------
function analyze(points, ctx) {
  const hard = [], soft = [], metricsAfter = {};
  const p = points;
  if (!Array.isArray(p) || p.length < 3) {
    hard.push('点数不足 3，无法分析');
    return { hard, soft, metrics: {} };
  }

  const dt = [], dist = [], speed = [];
  for (let i = 1; i < p.length; i++) {
    const d = haversineM(p[i - 1].latitude, p[i - 1].longitude, p[i].latitude, p[i].longitude);
    const gap = (p[i].timestamp - p[i - 1].timestamp) / 1000;
    dt.push(gap); dist.push(d);
    speed.push(gap > 0 ? d / gap : Infinity);
  }
  const walkedM = dist.reduce((a, b) => a + b, 0);
  const peak = Math.max(...speed);
  const minD = Math.min(...dist);
  const accuracy = p.map((x) => Number(x.accuracy)).filter(Number.isFinite);

  // ---- 硬失败：平台硬约束 ----
  if (p.length > PLATFORM.maxPoints) hard.push(`点数 ${p.length} > ${PLATFORM.maxPoints}`);
  if (peak > PLATFORM.maxSpeed + 1e-6) hard.push(`峰值速度 ${peak.toFixed(3)} m/s > ${PLATFORM.maxSpeed}`);
  if (minD < PLATFORM.minDistance - 1e-6) hard.push(`最小点距 ${minD.toFixed(3)} m < ${PLATFORM.minDistance}`);
  const maxDt = Math.max(...dt);
  if (maxDt > PLATFORM.segmentBreakGapSec) soft.push(`最大间隔 ${maxDt.toFixed(1)}s > ${PLATFORM.segmentBreakGapSec}s（会被分段）`);
  if (ctx.declaredM) {
    const r = Math.abs(walkedM / ctx.declaredM - 1);
    if (r > RESIDUAL_LIMIT) hard.push(`长度残差 ${(r * 100).toFixed(3)}% > ${(RESIDUAL_LIMIT * 100)}%`);
  }
  // 时间戳必须单调
  for (let i = 1; i < p.length; i++) {
    if (p[i].timestamp < p[i - 1].timestamp) { hard.push(`时间戳在点 ${i} 处回退`); break; }
  }

  // ---- 确定性缺陷：重复指纹 ----
  if (ctx.idempotent === true) hard.push('同参数两次生成坐标逐点完全相同（跨运行幂等）');
  const dupKey = new Set(p.map((x) => `${x.latitude},${x.longitude}`));
  if (dupKey.size < p.length) soft.push(`重复坐标 ${p.length - dupKey.size}/${p.length} 个`);

  // ---- 过滤幂等：服务端若用同一套 RunTrack 规则重跑一遍，点与长度都不应变 ----
  // 两件事分开看：
  //   丢点 —— 说明我们上传的是「本来就该被过滤掉」的形态；
  //   变长 —— 说明二次平滑改了形状。客户端的 totalDistanceMeters 累加的是每次 smooth(t) 的段长，
  //           上传的 routeData 也是 smooth 后的点，所以一段轨迹被平滑第二次 = 形状被改第二次。
  // 只比点数会漏掉后者：实测 2km/480s 丢点 0 个，长度却掉 1.83%。
  if (ctx.checkFilterIdempotent !== false) {
    const refiltered = clientFilter(p, PLATFORM.maxPoints);
    const lost = p.length - refiltered.length;
    if (lost > 0) {
      const pct = lost / p.length;
      (pct > 0.02 ? hard : soft).push(`二次过滤会再丢 ${lost}/${p.length} 点（${(pct * 100).toFixed(1)}%）`);
    }
    if (refiltered.length > 1) {
      const w2 = refiltered.reduce((a, q, i) => i
        ? a + haversineM(refiltered[i - 1].latitude, refiltered[i - 1].longitude, q.latitude, q.longitude) : 0, 0);
      // 只报告，不判定：真实用户的 routeData 同样是 smooth 之后的点，
      // 服务端若再平滑一次，真实数据也会被改短同样的量级。这是「重复处理」的结果，
      // 不是「我们才有的」指纹，拿它当失败会制造假警报。
      metricsAfter.refilterDriftPct = Math.abs(w2 / walkedM - 1) * 100;
    }
  }

  // ---- 软指标：机器特征 ----
  const dtUniquePct = new Set(dt.map((x) => x.toFixed(3))).size / dt.length;
  const ringDev = distanceToRing(p, ctx.ring);
  const devSd = ringDev ? sd(ringDev) : null;
  const devMax = ringDev ? Math.max(...ringDev) : null;
  const spMean = mean(speed), spSd = sd(speed);
  const speedCvPct = spMean > 0 ? spSd / spMean * 100 : 0;
  const lag33 = p.length > 40 ? acf(speed, 33) : null;
  const accLag1 = accuracy.length > 10 ? acf(accuracy, 1) : null;

  const metrics = {
    points: p.length, walkedM, peak, minD, meanDt: mean(dt), maxDt,
    dtUniquePct, devSd, devMax, speedCvPct, lag33, accLag1,
    accMedian: accuracy.length ? pct(accuracy, 0.5) : null,
    accMin: accuracy.length ? Math.min(...accuracy) : null,
    accMax: accuracy.length ? Math.max(...accuracy) : null,
    startOffsetM: ctx.startOffsetM,
    ...metricsAfter,
  };

  const range = (v, [lo, hi], label, fmt) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    if (v < lo || v > hi) soft.push(`${label} ${fmt(v)} 超出参考区间 [${fmt(lo)}, ${fmt(hi)}]`);
  };
  range(dtUniquePct, HUMAN.dtUniquePct, '采样间隔唯一值比例', (x) => x.toFixed(3));
  range(devSd, HUMAN.pathDevSdM, '点-环偏离 sd(m)', (x) => x.toFixed(3));
  range(speedCvPct, HUMAN.speedCvPct, '速度 CV(%)', (x) => x.toFixed(2));
  range(lag33, HUMAN.speedLag33, '速度 lag33 自相关', (x) => x.toFixed(3));
  range(accLag1, HUMAN.accuracyLag1, 'accuracy lag1', (x) => x.toFixed(3));
  range(ctx.startOffsetM, HUMAN.startOffsetM, '起点-首点偏差(m)', (x) => x.toFixed(2));

  if (metrics.accMax !== null && metrics.accMax > PLATFORM.accuracyDegraded) {
    soft.push(`accuracy 最大 ${metrics.accMax}m > degraded 阈值 ${PLATFORM.accuracyDegraded}m（会被降级）`);
  }
  return { hard, soft, metrics };
}

// ---------- 输入 ----------
function syntheticRing(n) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * 2 * Math.PI;
    ring.push([0 + 0.0006 * Math.sin(a), 0 + 0.0008 * Math.cos(a)]);
  }
  return ring;
}

// --check：接受 {points:[...]}、点数组、state.json（取第一条 runs[].track.points）
function loadPoints(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.points)) return raw.points;
  const dry = raw.plan && raw.plan.body_finish && raw.plan.body_finish.routeData;
  if (Array.isArray(dry)) return dry;
  for (const acc of Object.values(raw.accounts || {})) {
    for (const run of acc.runs || []) {
      if (run && run.track && Array.isArray(run.track.points) && run.track.points.length) return run.track.points;
    }
  }
  return null;
}

// ---------- 输出 ----------
function report(title, res) {
  console.log(`\n── ${title} ──`);
  const m = res.metrics;
  if (m.points) {
    console.log(`  点数 ${m.points} | 实测 ${m.walkedM.toFixed(1)}m | 峰值 ${m.peak.toFixed(3)} m/s | 最小点距 ${m.minD.toFixed(3)}m`);
    console.log(`  采样间隔 均值 ${m.meanDt.toFixed(3)}s 最大 ${m.maxDt.toFixed(1)}s 唯一值比例 ${(m.dtUniquePct * 100).toFixed(1)}%`);
    console.log(`  速度 CV ${m.speedCvPct.toFixed(2)}% | 点-环偏离 sd ${m.devSd === null ? 'n/a' : m.devSd.toFixed(4) + 'm'} | lag33 ${m.lag33 === null ? 'n/a' : m.lag33.toFixed(3)}`);
    console.log(`  accuracy 中位 ${m.accMedian}m 范围 ${m.accMin}~${m.accMax}m lag1 ${m.accLag1 === null ? 'n/a' : m.accLag1.toFixed(3)}`);
    if (m.startOffsetM !== undefined) console.log(`  起点-首点偏差 ${m.startOffsetM.toFixed(2)}m`);
    if (m.refilterDriftPct !== undefined) console.log(`  二次平滑长度变化 ${m.refilterDriftPct.toFixed(2)}%（参考，不判定）`);
  }
  for (const x of res.hard) console.log(`  FAIL  ${x}`);
  for (const x of res.soft) console.log(`  WARN  ${x}`);
  if (!res.hard.length && !res.soft.length) console.log('  全部指标在参考区间内');
}

function main() {
  const checkFile = arg('--check', null);
  if (checkFile) {
    const pts = loadPoints(path.resolve(checkFile));
    if (!pts) { console.error(`[realism] ${checkFile} 里没找到轨迹点`); return 1; }
    const res = analyze(pts, {});
    report(`检查 ${checkFile}`, res);
    return res.hard.length ? 1 : 0;
  }

  const [km, sec] = String(arg('--gen', '1.2/600')).split('/').map(Number);
  if (!(km > 0) || !(sec > 0)) { console.error('[realism] --gen 需要 距离km/时长s，例如 1.2/600'); return 1; }

  const ring = syntheticRing(15);
  const seedArg = arg('--seed', null);
  if (seedArg !== null && !Number.isFinite(Number(seedArg))) {
    console.error(`[realism] --seed 需要数字，收到 ${JSON.stringify(seedArg)}`); return 1;
  }
  const trackOpts = seedArg === null ? undefined : { seed: Number(seedArg) };
  const t1 = generateTrack(km * 1000, sec, 1700000000000, ring, trackOpts);
  const t2 = generateTrack(km * 1000, sec, 1700000000000, ring, trackOpts);
  const idempotent = t1.points.length === t2.points.length &&
    t1.points.every((p, i) => p.latitude === t2.points[i].latitude && p.longitude === t2.points[i].longitude);

  // 幂等有两种来源：没给 seed 却逐点相同 = 缺陷；给了 seed 却不同 = 可复现性坏了。
  // 显式 seed 下幂等是预期行为，不能当硬失败报。
  const seeded = seedArg !== null;
  const res = analyze(t1.points, {
    declaredM: km * 1000, idempotent: idempotent && !seeded,
    startOffsetM: 0, ring,
  });
  if (seeded && !idempotent) res.hard.push('给了 --seed 但两次生成不一致（可复现性失效）');
  const mode = seeded ? `seed=${seedArg}` + (idempotent ? '，可复现' : '，不可复现') : (idempotent ? '幂等' : '每次不同');
  report(`生成样本 ${km}km/${sec}s（${mode}）`, res);

  console.log(`\n覆盖：客户端 CAMPUS 预设 minDistance ${PLATFORM.minDistance}m / maxSpeed ${PLATFORM.maxSpeed}m/s / maxPoints ${PLATFORM.maxPoints}`);
  console.log(res.hard.length ? `\n${res.hard.length} 项硬失败` : '\n无硬失败');
  return res.hard.length ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { analyze, distanceToRing, acf, PLATFORM, HUMAN };
