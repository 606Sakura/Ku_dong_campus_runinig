// 轨迹不变量自检：直接复用 server.js 的 generateTrack / trackStepSec
// 依据：小程序 track 类约束（minDistance 6m / maxSpeed 8m/s / 间隔≤15s / maxPoints 500）
//       + 服务端 finish 会按 routeData 重算距离，故轨迹总长必须收敛到申报距离
//       + 轨迹时间戳必须落在申报窗口 [startAt, now] 内
// 运行：node tools/verify_track.js   —— 退出码 0 = 全部通过
const { generateTrack, trackStepSec, haversineM } = require('../track-core');

const MAX_SPEED = 8;      // m/s，平台硬上限
const MIN_POINT_DIST = 6; // m，平台相邻点下限
const MAX_POINT_GAP = 15; // s，超过则服务端分段
const MAX_POINTS = 500;
const MIN_PACE = 180, MAX_PACE = 600, MIN_DIST = 1.0, MAX_DIST_RULE = 3.333; // s/km, km

// 平台合规域。上一版只取 8×4=18 个网格点，恰好漏掉了残差最坏的 1.098km/248s。
// 现在按 10m 距离步长 × 7s 时长步长密集扫（49346 组全枚举太慢，会跑满 2 分钟）。
// ponytail: 7s 步长可能漏掉个别极窄的坏点；发现回归就把步长调小重扫。
const CASES = [];
for (let d = 1000; d <= 3340; d += 10) {
  const distanceKm = d / 1000;
  const lo = Math.ceil(distanceKm * MIN_PACE), hi = Math.min(600, Math.floor(distanceKm * MAX_PACE));
  for (let durationSec = lo; durationSec <= hi; durationSec += 7) {
    CASES.push({ distanceKm, durationSec });
  }
  // 边界值单独补上（配速恰好卡 min/maxPace 时最险）
  CASES.push({ distanceKm, durationSec: lo });
  if (hi !== lo) CASES.push({ distanceKm, durationSec: hi });
}

let bad = 0;
let worst = { peak: 0, minD: Infinity, gap: 0, pts: 0, residual: 0, residualAt: '', amp: 0, ampAt: '' };
const fail = (label, m) => { if (bad < 25) console.log(`FAIL  ${label}  ${m}`); bad++; };
// 基准环：合成圆形打卡环，不依赖任何真实学校坐标（算法只依赖 segLen/ringLen）。
const BASELINE_RING = [];
for (let i = 0; i < 15; i++) {
  const a = i / 15 * 2 * Math.PI;
  BASELINE_RING.push([0 + 0.0006 * Math.sin(a), 0 + 0.0008 * Math.cos(a)]);
}
const track_ = (distanceKm, durationSec, startMs) => generateTrack(distanceKm * 1000, durationSec, startMs, BASELINE_RING);

for (const { distanceKm, durationSec } of CASES) {
  const t = track_(distanceKm, durationSec);
  const p = t.points;
  const label = `${distanceKm}km/${durationSec}s`;

  // 1. 点数上限 + 非空
  if (p.length === 0) { fail(label, '轨迹为空'); continue; }
  if (p.length > MAX_POINTS) fail(label, `点数 ${p.length} > ${MAX_POINTS}`);
  worst.pts = Math.max(worst.pts, p.length);

  let walked = 0, peak = 0, minD = Infinity, maxGap = 0;
  for (let i = 1; i < p.length; i++) {
    const d = haversineM(p[i - 1].latitude, p[i - 1].longitude, p[i].latitude, p[i].longitude);
    const gapSec = (p[i].timestamp - p[i - 1].timestamp) / 1000;
    // 相邻两点间真实耗时是 gapSec（收敛迭代会重算步长，不能拿名义 stepSec 除）
    walked += d;
    peak = Math.max(peak, gapSec > 0 ? d / gapSec : Infinity);
    minD = Math.min(minD, d);
    maxGap = Math.max(maxGap, gapSec);
  }
  const declaredM = distanceKm * 1000;

  // 2. 轨迹实测长度必须收敛到申报距离（服务端会按 routeData 重算）
  const residual = Math.abs(walked / declaredM - 1);
  if (residual > 0.002) fail(label, `轨迹实测 ${walked.toFixed(1)}m vs 申报 ${declaredM.toFixed(0)}m 残差 ${(residual * 100).toFixed(3)}% > 0.2%`);
  if (residual > worst.residual) { worst.residual = residual; worst.residualAt = label; }

  // 3. 速度 ≤ 8 m/s（S1 修复的核心断言）
  if (peak > MAX_SPEED + 1e-6) fail(label, `峰值速度 ${peak.toFixed(3)} m/s > ${MAX_SPEED}`);
  worst.peak = Math.max(worst.peak, peak);

  // 4. 相邻点距离 ≥ 6m
  if (minD < MIN_POINT_DIST - 1e-6) fail(label, `最小点距 ${minD.toFixed(3)}m < ${MIN_POINT_DIST}m`);
  worst.minD = Math.min(worst.minD, minD);

  // 5. 时间间隔 < 15s（否则触发平台分段）
  if (maxGap >= MAX_POINT_GAP) fail(label, `相邻点时间间隔 ${maxGap}s >= ${MAX_POINT_GAP}s`);
  worst.gap = Math.max(worst.gap, maxGap);

  // 6. 切角补偿幅度（N4：原阈值 5% 只剩 0.2% 余量，实测最大 4.80%）
  const amp = Math.abs(t.speed / (declaredM / durationSec) - 1);
  if (amp > 0.08) fail(label, `切角补偿幅度 ${(amp * 100).toFixed(2)}% 超出预期 8%`);
  if (amp > worst.amp) { worst.amp = amp; worst.ampAt = label; }

  // 7. 时间戳必须落在申报窗口 [startAt, now] 内（S6）
  const now = Date.now(), startAt = now - durationSec * 1000;
  const pt = track_(distanceKm, durationSec, startAt).points;
  if (Math.abs(pt[0].timestamp - startAt) > 1000) fail(label, `首点时间 ${pt[0].timestamp} 偏离 startAt ${startAt}`);
  if (pt[pt.length - 1].timestamp > now + 1000) {
    fail(label, `末点时间 ${pt[pt.length - 1].timestamp} 晚于 now ${now}`);
  }
}

// 8. 回归：N1 的最坏点（单次迭代时残差 1.864%，比迭代前更差）
{
  const p = track_(1.098, 248).points;
  let w = 0;
  for (let i = 1; i < p.length; i++) w += haversineM(p[i - 1].latitude, p[i - 1].longitude, p[i].latitude, p[i].longitude);
  const r = Math.abs(w / 1098 - 1);
  if (r > 0.002) { fail('N1 回归', `1.098km/248s 残差 ${(r * 100).toFixed(3)}%（单次迭代版为 1.864%）`); }
  else console.log(`PASS  N1 回归：1.098km/248s 残差 ${(r * 100).toFixed(3)}%（单次迭代版为 1.864%）`);
}

// 9. 回归：S1（idx 用圈数当初值）—— 峰值不能破线
{
  const p = track_(1.928, 600).points;
  let peak = 0;
  for (let i = 1; i < p.length; i++) {
    const gap = (p[i].timestamp - p[i - 1].timestamp) / 1000;
    peak = Math.max(peak, haversineM(p[i - 1].latitude, p[i - 1].longitude, p[i].latitude, p[i].longitude) / gap);
  }
  if (peak > MAX_SPEED) fail('S1 回归', `1.928km/600s 峰值 ${peak.toFixed(3)} m/s 破线`);
  else console.log(`PASS  S1 回归：1.928km/600s 峰值 ${peak.toFixed(3)} m/s（bug 版为 8.266）`);
}

// 10. 回归：S5（pace 秒数进位成 60 产出 "3'60""）
{
  const spk = 240 / 1.001; // 1.001km/240s → 239.76 s/km
  const pm = Math.floor(spk / 60), ps = Math.round(spk % 60);
  const pace = ps === 60 ? `${pm + 1}'00"` : `${pm}'${String(ps).padStart(2, '0')}"`;
  if (/60"/.test(pace)) fail('S5 回归', `pace 产出 ${pace}`);
  else console.log(`PASS  S5 回归：1.001km/240s → pace ${pace}（未修复版为 "3'60\\""）`);
}

// 11. 回归：N6（提交距离取 2 位小数，轨迹按未取整生成 → 两者失配）
//     修的要点不是"取整偏差为 0"（那不可能），而是"轨迹与提交距离引用同一个取整值"。
//     这里断言取整值确实与申报值不同（说明取整真的发生了），且残差相对取整后的值算。
{
  const d2 = +(1.005).toFixed(2);
  const rounded = Math.abs(d2 - 1.005) * 1000;
  if (rounded < 1) fail('N6 回归', '1.005 未发生取整，断言失去意义');
  else {
    // 轨迹必须按 d2 生成；若仍按 1.005 生成，相对 d2 就会差 0.5%
    const p = track_(d2, 600).points;
    let w = 0;
    for (let i = 1; i < p.length; i++) w += haversineM(p[i - 1].latitude, p[i - 1].longitude, p[i].latitude, p[i].longitude);
    const r = Math.abs(w / (d2 * 1000) - 1);
    if (r > 0.002) fail('N6 回归', `轨迹相对提交距离 ${d2}km 残差 ${(r * 100).toFixed(3)}%`);
    else console.log(`PASS  N6 回归：1.005km 取整为 ${d2}km（偏差 ${rounded.toFixed(1)}m），轨迹相对提交值残差 ${(r * 100).toFixed(3)}%`);
  }
}

// 12. 跨校：换一条环（不同半径/点数）重跑同一合规网格，算法必须与具体路线无关。
//     缩样 1/13 步长（不然两份网格 ×2 会跑满 2 分钟），阈值同主网格。
{
  const cpsA = [], cpsB = [];
  for (let i = 0; i < 8; i++) { const a = i / 8 * 2 * Math.PI; cpsA.push([0 + 0.0006 * Math.sin(a), 0 + 0.0008 * Math.cos(a)]); }
  for (let i = 0; i < 12; i++) { const a = i / 12 * 2 * Math.PI; cpsB.push([0 + 0.0011 * Math.sin(a), 0 + 0.0014 * Math.cos(a)]); }
  const sparse = CASES.filter((_, i) => i % 13 === 0);
  for (const [name, cps] of [['小环8点', cpsA], ['大环12点', cpsB]]) {
    let bad2 = 0, worstR = 0, worstPeak = 0, worstMinD = Infinity;
    for (const { distanceKm, durationSec } of sparse) {
      let t;
      try { t = generateTrack(distanceKm * 1000, durationSec, undefined, cps); }
      catch (e) { fail(`跨校${name} ${distanceKm}km/${durationSec}s`, e.message); bad2++; continue; }
      const p = t.points;
      let walked = 0, peak = 0, minD = Infinity;
      for (let i = 1; i < p.length; i++) {
        const d = haversineM(p[i - 1].latitude, p[i - 1].longitude, p[i].latitude, p[i].longitude);
        const gapSec = (p[i].timestamp - p[i - 1].timestamp) / 1000;
        walked += d;
        peak = Math.max(peak, gapSec > 0 ? d / gapSec : Infinity);
        minD = Math.min(minD, d);
      }
      const r = Math.abs(walked / (distanceKm * 1000) - 1);
      worstR = Math.max(worstR, r); worstPeak = Math.max(worstPeak, peak); worstMinD = Math.min(worstMinD, minD);
      if (p.length > MAX_POINTS) { fail(`跨校${name} ${distanceKm}km/${durationSec}s`, `点数 ${p.length} 超限`); bad2++; }
      if (r > 0.002) { fail(`跨校${name} ${distanceKm}km/${durationSec}s`, `残差 ${(r * 100).toFixed(3)}%`); bad2++; }
      if (peak > MAX_SPEED + 1e-6) { fail(`跨校${name} ${distanceKm}km/${durationSec}s`, `峰值 ${peak.toFixed(3)} m/s`); bad2++; }
      if (minD < MIN_POINT_DIST - 1e-6) { fail(`跨校${name} ${distanceKm}km/${durationSec}s`, `点距 ${minD.toFixed(3)}m`); bad2++; }
    }
    if (!bad2) console.log(`PASS  跨校${name}：${sparse.length} 组，最坏残差 ${(worstR * 100).toFixed(4)}%，峰值 ${worstPeak.toFixed(3)} m/s，最小点距 ${worstMinD.toFixed(3)}m`);
  }
  // 少于 4 点的环如实拒绝
  try { generateTrack(1200, 600, undefined, [[1, 2], [3, 4]]); fail('跨校小环', '2 点环未被拒绝'); }
  catch (e) { console.log(`PASS  跨校小环拒绝：<4 点报「${e.message}」`); }
}

console.log(`\n覆盖 ${CASES.length} 组合规参数`);
console.log(`最坏值：峰值速度 ${worst.peak.toFixed(3)} m/s | 最小点距 ${worst.minD.toFixed(3)} m | 最大间隔 ${worst.gap}s | 最多点数 ${worst.pts}`);
console.log(`        长度残差 ${(worst.residual * 100).toFixed(4)}% (${worst.residualAt}) | 切角补偿 ${(worst.amp * 100).toFixed(2)}% (${worst.ampAt})`);
console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
