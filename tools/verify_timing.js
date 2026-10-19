// 真实计时与断点续跑的验收（碰 mock，不碰真实账号）
//
// 验的是三件在真平台上会直接判「记录无效」的事：
//   1. 零等待提交（start 后立刻 finish）必须被严格计时的 mock 判 status=2
//   2. 等满时长再提交必须判 status=1
//   3. 进程重启后，state 里没提交完的会话要能续上（tick 直接驱动，不等调度器）
//
// 为了让这个脚本能在几秒内跑完，server 与 mock 共用 KD_TIME_SCALE 把 600s 压成 6s，
// 并把 mock 的容差压到 2s —— 「零等待」差 6s 依然会越界，语义没有被削弱。
// 用法：node tools/verify_timing.js
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { waitReady } = require('./lib/wait-ready.js');

const ROOT = path.join(__dirname, '..');
const MOCK_PORT = Number(process.env.KD_TIMING_MOCK_PORT) || 8788;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const SCALE = 0.01;
const stateFile = path.join(os.tmpdir(), `kd-timing-state-${process.pid}.json`);

// require 前固化：server.js 在加载时读 KD_BASE / KD_STATE_FILE
process.env.KD_BASE = MOCK;
process.env.KD_STATE_FILE = stateFile;
process.env.KD_SIGN_SECRET = 'mock-secret-for-local-test-only';
process.env.KD_TIME_SCALE = String(SCALE);
const server = require(path.join(ROOT, 'server.js'));

let pass = 0, fail = 0;
const bad = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; bad.push(name); console.log('  ✗ ' + name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (url, opt) => {
  const r = await fetch(url, opt);
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, body, text };
};

const ROUTE = {
  routeId: 62, passMode: 'ORDERED', checkpointHitRadiusM: 30,
  checkpoints: Array.from({ length: 12 }, (_, i) => {
    const a = i / 12 * 2 * Math.PI;
    return [0 + 0.0011 * Math.sin(a), 0 + 0.0014 * Math.cos(a)];
  }),
};
const CREDS = { t: 'timing-token', d: 'dev_timing', f: '' };

function writeState(obj) { fs.writeFileSync(stateFile, JSON.stringify(obj, null, 2)); }
function seedState(session) {
  writeState({
    schemaVersion: 2, active: 'T0001', tokens: {},
    accounts: {
      T0001: {
        user: { name: '计时测试', studentId: 'T0001', schoolName: '示例大学' },
        creds: CREDS, runs: [], schedules: [], boundAt: new Date().toISOString(),
        routes: [ROUTE], selectedRouteId: 62, session,
      },
    },
  });
}

(async () => {
  const mock = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-platform.js')], {
    env: { ...process.env, PORT: String(MOCK_PORT), KD_TIME_SCALE: String(SCALE), KD_MOCK_TIME_TOLERANCE_SEC: '2' },
    stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
  });
  const mockOut = [];
  mock.stdout.on('data', (c) => mockOut.push(String(c)));
  mock.stderr.on('data', (c) => mockOut.push(String(c)));

  try {
    await waitReady(MOCK + '/mock/log', mock, mockOut, '假平台');
    await req(MOCK + '/mock/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

    // ---------- A. 零等待 vs 真实等待 ----------
    console.log('[A] 严格计时（mock 容差 2s，600s 压缩为 6s）');
    const started = await server.startSession(CREDS, ROUTE, 1.2, 600, 'CAMPUS', undefined);
    ok(started.ok === true, 'A1 会话建立成功', started);
    const zero = await server.finishSession(CREDS, { sessionId: started.sessionId, startedAt: Date.now(), durationSec: 600, distanceKm: 1.2, selectedCheckpoints: started.selectedCheckpoints }, ROUTE, {});
    ok(zero.ok === true, 'A2 零等待提交在 HTTP 层是成功的（假平台不拒收）', { stage: zero.stage });
    let runs = (await req(MOCK + '/runs?page=1&size=10')).body;
    let rec = runs && runs.data && runs.data.records && runs.data.records[0];
    ok(rec && rec.status === 2, 'A3 但被严格计时判为无效（status=2）—— 这正是线上会发生的', rec && { status: rec.status });

    // 真实等待：按 submitAt 等满再提交
    await req(MOCK + '/mock/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const s2 = await server.startSession(CREDS, ROUTE, 1.2, 600, 'CAMPUS', undefined);
    ok(s2.ok === true, 'A4 第二个会话建立成功');
    const startedAt = Date.now();
    await sleep(600 * 1000 * SCALE + 300);   // 6s + 余量
    const timed = await server.finishSession(CREDS, { sessionId: s2.sessionId, startedAt, durationSec: 600, distanceKm: 1.2, selectedCheckpoints: s2.selectedCheckpoints }, ROUTE, {});
    ok(timed.ok === true, 'A5 等满时长后提交成功', { stage: timed.stage, detail: timed.ok ? null : timed.detail });
    runs = (await req(MOCK + '/runs?page=1&size=10')).body;
    rec = runs && runs.data && runs.data.records && runs.data.records[0];
    ok(rec && rec.status === 1, 'A6 严格计时判为有效（status=1）', rec && { status: rec.status, declared: rec.duration });
    ok(timed.guard && timed.guard.ok === true, 'A7 提交前本地校验通过（点距/峰速/丢点）', timed.guard);
    ok(timed.checkpoints && timed.checkpoints.ok === true, 'A8 提交前打卡点复算全命中',
      timed.checkpoints && timed.checkpoints.missing);

    // ---------- B. 断点续跑 ----------
    console.log('\n[B] 断点续跑（state 里的会话到点后由 tick 提交）');
    await req(MOCK + '/mock/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const startMs3 = Date.now();
    const s3 = await server.startSession(CREDS, ROUTE, 1.2, 600, 'CAMPUS', undefined);
    ok(s3.ok === true, 'B1 会话建立成功');
    // 模拟"进程重启后从磁盘恢复"：只把会话写进 state，不给进程任何内存态
    // 必须等满真实时长才提交，否则严格计时照样判无效 —— 这正是断点续跑要保住的语义
    await sleep(600 * 1000 * SCALE + 400);
    seedState({
      sessionId: s3.sessionId, startedAt: startMs3, submitAt: Date.now() - 1000,
      distanceKm: 1.2, durationSec: 600, routeId: 62, passMode: 'ORDERED',
      checkpointHitRadiusM: 30, selectedCheckpoints: s3.selectedCheckpoints, attempts: 0,
    });
    const before = JSON.parse(fs.readFileSync(stateFile, 'utf8')).accounts.T0001.session;
    ok(before && before.sessionId === s3.sessionId, 'B2 会话已落盘（重启后不丢）');
    await server.tick();
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8')).accounts.T0001;
    ok(after.session === null, 'B3 tick 到点后提交并清空会话', after.session);
    ok((after.runs || []).length === 1 && after.runs[0].sessionId === s3.sessionId,
      'B4 记账写入 runs（sessionId 对得上）', after.runs && after.runs.length);
    runs = (await req(MOCK + '/runs?page=1&size=10')).body;
    rec = runs && runs.data && runs.data.records && runs.data.records[0];
    ok(rec && rec.status === 1, 'B5 续跑提交的记录被判有效', rec && { status: rec.status });

    // ---------- C. 过期会话与可重试分类 ----------
    console.log('\n[C] 过期会话与失败分类');
    ok(server.isRetriable({ status: 0 }) === true, 'C1 网络错误（status 0）可重试');
    ok(server.isRetriable({ status: 503 }) === true, 'C2 5xx 可重试');
    ok(server.isRetriable({ status: 400 }) === false, 'C3 平台业务拒绝不可重试');
    ok(server.isRetriable(null) === false, 'C4 空响应不可重试');

    seedState({
      sessionId: 999999, startedAt: Date.now() - 3600e3, submitAt: Date.now() - 3000e3,
      distanceKm: 1.2, durationSec: 600, routeId: 62, attempts: 0,
    });
    await server.tick();
    const stale = JSON.parse(fs.readFileSync(stateFile, 'utf8')).accounts.T0001;
    ok(stale.session === null, 'C5 超过宽限期的会话被清掉（不再无限重试）');
    ok(stale.lastFailure && /超时/.test(stale.lastFailure.reason || ''), 'C6 清掉时留下可读原因',
      stale.lastFailure);

    // 本地校验失败不得提交：把路线换成"轨迹走不到"的环
    await req(MOCK + '/mock/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const badRoute = {
      routeId: 62, passMode: 'ORDERED', checkpointHitRadiusM: 30,
      checkpoints: [[0 + 0.05, 0], [0, 0 + 0.05], [0 + 0.05, 0 + 0.05], [0 - 0.05, 0]],
    };
    const s4 = await server.startSession(CREDS, badRoute, 1.2, 600, 'CAMPUS', undefined);
    if (s4.ok) {
      const g = await server.finishSession(CREDS, {
        sessionId: s4.sessionId, startedAt: Date.now() - 7000, durationSec: 600, distanceKm: 1.2,
        selectedCheckpoints: badRoute.checkpoints.map((c, i) => ({ latitude: c[0], longitude: c[1], pointName: '点' + (i + 1), seqNo: i + 1 })),
      }, badRoute, {});
      ok(g.ok === false && g.stage === 'guard', 'C7 打卡点/轨迹不合格时本地拦下，不发 finish', { stage: g.stage, detail: g.detail });
      const log = (await req(MOCK + '/mock/log')).body;
      const finished = (log.data.requests || []).some((r) => /\/finish$/.test(r.path));
      ok(finished === false, 'C8 被拦下时确实没有向平台发 finish', { finished });
    } else {
      ok(false, 'C7/C8 会话建立失败，无法验证拦截', s4);
    }
  } finally {
    try { mock.kill(); } catch { /* 已退出 */ }
    try { fs.unlinkSync(stateFile); } catch { /* 无所谓 */ }
  }

  console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('失败项：\n  - ' + bad.join('\n  - ')); process.exitCode = 1; }
})();
