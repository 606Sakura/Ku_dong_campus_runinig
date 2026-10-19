// 提交前本地校验的验收（纯函数，零依赖，不触网）
//
// 验的是"拦截意图"而不是实现细节：
//   · 轨迹漏掉一个打卡点 → 必须拦下来并说出是哪个点（否则提交后才知道被判无效）
//   · 点距跌破平台下限 → 必须拦下来（客户端过滤会把点丢掉，上传点集与本地不一致）
//   · 申报值浮动 → 必须仍然合规，且确实变化（否则等于没浮动）
// 用法：node tools/verify_guard.js
'use strict';

const { verifyCheckpoints, guardTrack, applyJitter, PLATFORM } = require('../run-guard');
const { generateTrack } = require('../track-core');

let pass = 0, fail = 0;
const bad = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; bad.push(name); console.log('  ✗ ' + name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))); }
}

// 一个边长约 40m 的方形环，四角即打卡点
const lat = 0, lng = 0;
const D = 0.00036;   // ≈40m
const ring = [
  { latitude: lat, longitude: lng, pointName: '东南角', seqNo: 1 },
  { latitude: lat, longitude: lng + D, pointName: '西南角', seqNo: 2 },
  { latitude: lat + D, longitude: lng + D, pointName: '西北角', seqNo: 3 },
  { latitude: lat + D, longitude: lng, pointName: '东北角', seqNo: 4 },
];
const checkpoints = ring.map((c) => [c.latitude, c.longitude]);
const t0 = Date.UTC(2026, 9, 18, 0, 0, 0);
const track = generateTrack(1200, 600, t0, checkpoints, { seed: 42 });

console.log('[A] 打卡点复算');
const hit = verifyCheckpoints(track.points, ring, { radius: 30, ordered: true });
ok(hit.ok === true, '轨迹穿过全部 4 个打卡点', { missing: hit.missing });
ok(hit.hits.length === 4 && hit.hits.every((h) => h.hit), '每个点都标记为命中');
ok(hit.hits.every((h) => h.nearestM <= 30), '最近距离都在半径内',
  hit.hits.map((h) => +h.nearestM.toFixed(1)));

// 把一个点挪到 100m 外：环变了，轨迹不再经过它
const moved = ring.map((c, i) => (i === 2 ? { ...c, latitude: c.latitude + 0.0009 } : c));
const miss = verifyCheckpoints(track.points, moved, { radius: 30, ordered: true });
ok(miss.ok === false, '漏掉一个点必须判不通过');
// ORDERED 游标卡在「西北角」后，后面的「东北角」也推进不了 —— 两个都报出来才对。
ok(miss.missing.includes('西北角') && !miss.missing.includes('东南角'), '漏点里含「西北角」、不含已命中的「东南角」', miss.missing);
ok(miss.reason && /西北角/.test(miss.reason), 'reason 里带点名（前端直接显示给用户）', miss.reason);

// 顺序语义：用一条只走前三点、第四点才到的人工点集来验游标推进。
// 拿整圈轨迹测没意义 —— 环只有 160m、轨迹 1200m，会绕 7 圈把乱序也走全。
const straight = [
  { latitude: lat, longitude: lng },
  { latitude: lat, longitude: lng + D },
  { latitude: lat + D, longitude: lng + D },
  { latitude: lat + D, longitude: lng },
].map((p, i) => ({ ...p, timestamp: t0 + i * 60000, accuracy: 8 }));
ok(verifyCheckpoints(straight, ring, { radius: 30, ordered: false }).ok === true,
  'ANY 模式不看顺序，四个点都到过即通过');
ok(verifyCheckpoints(straight, [ring[0], ring[2], ring[1], ring[3]], { radius: 30, ordered: true }).ok === false,
  'ORDERED 模式下打卡点表顺序写错必须判不通过（不能假装通过）');

console.log('\n[B] 轨迹硬校验');
const g = guardTrack(track.points);
ok(g.ok === true, '生成器产出的轨迹通过平台硬阈值', g.problems);
ok(g.dropped === 0, '客户端过滤不丢点', { dropped: g.dropped });
ok(g.minStepM >= PLATFORM.minDistance, '最小点距 ≥ 6m', { minStepM: g.minStepM });
ok(g.peakSpeed <= PLATFORM.maxSpeed, '峰值速度 ≤ 8m/s', { peakSpeed: g.peakSpeed });
ok(g.kept <= PLATFORM.maxPoints, '点数 ≤ 500', { kept: g.kept });

// 人工造一条点距 2m 的轨迹：必须被拦
const dense = track.points.slice(0, 40).flatMap((p) => {
  const q = { ...p, latitude: p.latitude + 0.000018 };   // ≈2m
  return [p, q];
});
const gd = guardTrack(dense);
ok(gd.ok === false, '点距跌破下限必须拦');
ok(gd.problems.some((m) => /最小点距/.test(m)), '原因写明是最小点距', gd.problems);

// 造一条瞬时速度 20m/s 的轨迹
const fast = track.points.slice(0, 20).map((p, i) => (i === 10
  ? { ...p, latitude: p.latitude + 0.002, timestamp: p.timestamp - 100 } : p));
ok(guardTrack(fast).ok === false, '峰值速度超限必须拦');

console.log('\n[C] 申报值浮动');
const rules = { runAvailableNow: true, minDistance: 1.0, minDuration: 180, maxDuration: 600, minPace: 180, maxPace: 600 };
const { checkRunRules } = require('../server.js');
const seen = new Set();
let allLegal = true;
for (let i = 0; i < 30; i++) {
  const j = applyJitter(1.2, 480, rules, {
    check: (d, s) => checkRunRules(rules, d, s, { runs: [] }),
    rng: () => ((i * 0.618 + 0.13) % 1),
  });
  seen.add(j.distanceKm + '/' + j.durationSec);
  if (checkRunRules(rules, j.distanceKm, j.durationSec, { runs: [] }).length) allLegal = false;
}
ok(allLegal, '浮动后的每一组都仍然合规');
ok(seen.size > 10, '浮动确实产生不同值（否则等于没浮动）', { distinct: seen.size });

// 规则极窄时不得越界：minPace=每公里正好 400s、maxPace=400s，浮动只能落在同一档
const tight = { ...rules, minPace: 400, maxPace: 400 };
const jt = applyJitter(1.2, 480, tight, { check: (d, s) => checkRunRules(tight, d, s, { runs: [] }) });
ok(checkRunRules(tight, jt.distanceKm, jt.durationSec, { runs: [] }).length === 0,
  '规则极窄时浮动结果仍合规（配速必须正好 400s/km）', jt);

console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('失败项：\n  - ' + bad.join('\n  - ')); process.exitCode = 1; }
