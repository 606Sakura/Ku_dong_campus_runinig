// 提交前本地校验（纯函数，零依赖，供 server.js 与验收脚本共用）
//
// 为什么要有这一层：平台对轨迹的硬校验（点距、峰速、点数、打卡点）在服务端执行，
// 提交后才知道不合格就晚了 —— 会话已经建立，记录已经落库，而且无效记录没有删除接口。
// 这里把同一套规则在提交前跑一遍，不通过就不发 finish。阈值全部抄自 docs/api-map.md，
// 与 track-core.js 的生成约束同源，避免"生成端放宽、校验端收紧"的漂移。
'use strict';

const { haversineM, clientFilter } = require('./track-core');

// CAMPUS 预设（api-map.md「GPS 轨迹校验参数」）。FREE 预设更宽，但这里只拦 CAMPUS。
const PLATFORM = {
  minDistance: 6,
  maxSpeed: 8,
  maxSegmentDistance: 180,
  maxPoints: 500,
  checkpointRadiusM: 30,
};

// 打卡点判定。
// ORDERED（默认）：单游标顺序推进 —— 平台 passMode=ORDERED 时必须是这个语义。
// ANY：每个点独立判定。
// 返回的 nearestM 是"全程离该点最近的距离"，漏点时据此告诉用户差了多少米。
function verifyCheckpoints(points, checkpoints, opts) {
  const o = opts || {};
  const radius = Number(o.radius) > 0 ? Number(o.radius) : PLATFORM.checkpointRadiusM;
  const ordered = o.ordered !== false;
  const norm = (c) => (Array.isArray(c)
    ? { latitude: Number(c[0]), longitude: Number(c[1]) }
    : { latitude: Number(c.latitude), longitude: Number(c.longitude) });
  const cps = (checkpoints || []).map(norm)
    .filter((c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude));
  const hits = cps.map((c, i) => ({
    seqNo: (checkpoints[i] && checkpoints[i].seqNo != null) ? checkpoints[i].seqNo : i + 1,
    name: (checkpoints[i] && (checkpoints[i].pointName || checkpoints[i].name)) || `打卡点 ${i + 1}`,
    // 坐标一并回传：前端要在地图上画这些点，再让前端去猜就会两处漂移
    latitude: c.latitude, longitude: c.longitude,
    hit: false,
    nearestM: Infinity,
  }));
  if (!hits.length) return { ok: false, radius, hits, missing: [], reason: '路线没有可用打卡点' };
  if (!Array.isArray(points) || points.length === 0) {
    return { ok: false, radius, hits, missing: hits.map((h) => h.name), reason: '轨迹为空' };
  }

  if (ordered) {
    let cursor = 0;
    for (const p of points) {
      if (cursor >= hits.length) break;
      const c = cps[cursor];
      const d = haversineM(p.latitude, p.longitude, c.latitude, c.longitude);
      if (d < hits[cursor].nearestM) hits[cursor].nearestM = d;
      if (d <= radius) { hits[cursor].hit = true; cursor++; }
    }
  } else {
    for (const p of points) {
      for (let i = 0; i < cps.length; i++) {
        const d = haversineM(p.latitude, p.longitude, cps[i].latitude, cps[i].longitude);
        if (d < hits[i].nearestM) hits[i].nearestM = d;
        if (d <= radius) hits[i].hit = true;
      }
    }
  }

  const missing = hits.filter((h) => !h.hit).map((h) => h.name);
  return {
    ok: missing.length === 0,
    radius,
    ordered,
    hits,
    missing,
    reason: missing.length ? `未经过打卡点：${missing.join('、')}` : null,
  };
}

// 轨迹硬校验。用与平台同一套客户端过滤（5 点中值平滑 + 6m 下限 + 传送剔除 + 500 点抽稀）
// 重放一遍：过滤会丢点，就说明上传后平台看到的点集与本地生成的不一致。
function guardTrack(points, opts) {
  const o = opts || {};
  const maxPoints = Number(o.maxPoints) || PLATFORM.maxPoints;
  const filtered = clientFilter(Array.isArray(points) ? points : [], maxPoints);
  let minStepM = Infinity, peakSpeed = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const d = haversineM(a.latitude, a.longitude, b.latitude, b.longitude);
    if (d < minStepM) minStepM = d;
    const dt = (b.timestamp - a.timestamp) / 1000;
    if (dt > 0 && d / dt > peakSpeed) peakSpeed = d / dt;
  }
  const problems = [];
  const dropped = points.length - filtered.length;
  if (dropped !== 0) problems.push(`客户端过滤会丢 ${dropped} 个点（上传点数 ${points.length} → ${filtered.length}）`);
  if (points.length > maxPoints) problems.push(`点数 ${points.length} 超过平台上限 ${maxPoints}`);
  if (Number.isFinite(minStepM) && minStepM < PLATFORM.minDistance) {
    problems.push(`最小点距 ${minStepM.toFixed(2)}m 低于平台下限 ${PLATFORM.minDistance}m`);
  }
  if (peakSpeed > PLATFORM.maxSpeed) {
    problems.push(`峰值速度 ${peakSpeed.toFixed(2)}m/s 超过平台上限 ${PLATFORM.maxSpeed}m/s`);
  }
  return {
    ok: problems.length === 0,
    problems,
    dropped,
    kept: filtered.length,
    minStepM: Number.isFinite(minStepM) ? +minStepM.toFixed(2) : null,
    peakSpeed: +peakSpeed.toFixed(3),
  };
}

// 申报值小幅浮动。
// 目的不是"更真实"，而是消除"同一参数每次提交数字一模一样"这个最明显的机器特征。
// 距离 ±0.05km、时长 ±3%，每次候选都重新过一遍规则；50 次全不合法就用原值 —— 绝不越界。
function applyJitter(distanceKm, durationSec, rules, opts) {
  const o = opts || {};
  const rng = typeof o.rng === 'function' ? o.rng : Math.random;
  const distAmpKm = o.distAmpKm != null ? Number(o.distAmpKm) : 0.05;
  const durPct = o.durPct != null ? Number(o.durPct) : 0.03;
  const check = typeof o.check === 'function' ? o.check : null;
  // 窗口已由调用方确认，这里只判阈值；把 runAvailableNow 抹掉免得每轮都撞窗口。
  const rulesForCheck = rules ? Object.assign({}, rules, { runAvailableNow: true }) : null;
  for (let i = 0; i < 50; i++) {
    const d = +(Number(distanceKm) + (rng() * 2 - 1) * distAmpKm).toFixed(2);
    const s = Math.round(Number(durationSec) * (1 + (rng() * 2 - 1) * durPct));
    if (!(d > 0) || !(s > 0)) continue;
    const bad = check ? check(d, s) : (rulesForCheck ? require('./server.js').checkRunRules(rulesForCheck, d, s, { runs: [] }) : []);
    if (bad && bad.length) continue;
    return { distanceKm: d, durationSec: s, jittered: true };
  }
  return { distanceKm: Number(distanceKm), durationSec: Number(durationSec), jittered: false };
}

module.exports = { PLATFORM, verifyCheckpoints, guardTrack, applyJitter };
