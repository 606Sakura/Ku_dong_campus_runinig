// 窗口回归：不碰真实账号。纯逻辑断言 nextWindowStart/parseWindow，
// 再起假平台 + 被测服务器（独立端口 + KD_STATE_FILE 副本）验证排期落窗。
// 用法：node tools\verify_window.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { waitReady } = require('./lib/wait-ready.js');

const ROOT = path.join(__dirname, '..');
// require 前就设：server.js 在 require 时固化 STATE_FILE，绝不能指向真实 state。
// 测试进程与被测子进程共用同一份副本，resetStaleRunning 才能读到 B 段手造的任务。
const stateFile = path.join(os.tmpdir(), `kd-win-state-${process.pid}.json`);
process.env.KD_STATE_FILE = stateFile;
const server = require(path.join(ROOT, 'server.js'));
const { parseWindow, nextWindowStart } = server;

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
// 北京时间 'YYYY-MM-DD HH:MM' → UTC 毫秒
function bj(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]);
}

// ---------- A. 纯逻辑 ----------
const W = '每日 09:00-09:30 开跑';
console.log('[A] parseWindow / nextWindowStart');
ok(parseWindow(W) && parseWindow(W).startMin === 540 && parseWindow(W).endMin === 570, '解析 09:00-09:30 → 540/570');
ok(parseWindow('看不懂') === null, '不可解析 → null（调用方须明确报错）');
ok(parseWindow('25:99-09:30') === null, '非法时分 → null');

const day = '2026-10-17';
ok(nextWindowStart(W, bj(day + ' 08:50'), 0) === bj(day + ' 09:00'), '窗口前 → 今天 09:00');
ok(nextWindowStart(W, bj(day + ' 09:10'), 0) === bj(day + ' 09:10'), '窗口内 → 立即(now)');
ok(nextWindowStart(W, bj(day + ' 09:30'), 0) === bj(day + ' 09:30'), '窗口终点(含) → 立即');
ok(nextWindowStart(W, bj(day + ' 09:31'), 0) === bj('2026-10-18 09:00'), '窗口后 → 明天 09:00');
ok(nextWindowStart(W, bj(day + ' 00:00'), 0) === bj(day + ' 09:00'), '零点 → 今天 09:00');
const j0 = nextWindowStart(W, bj(day + ' 08:50'));
ok(j0 > bj(day + ' 09:00') && j0 <= bj(day + ' 09:03'), '默认抖动 1~3 分钟');
ok(nextWindowStart(W, bj(day + ' 08:50'), 5000) === bj(day + ' 09:00') + 5000, '显式 jitter 生效（09:00+5s）');
ok(nextWindowStart(W, bj(day + ' 09:00') - 1, 0) === bj(day + ' 09:00'), '边界前 1ms → 09:00');

// ---------- B. 排期落窗 e2e（假平台 + state 副本） ----------
console.log('[B] 排期落窗 e2e（假平台 8793 / 被测 8794，state 副本）');
(async () => {
  const mock = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-platform.js')], {
    env: { ...process.env, PORT: '8793', KD_MOCK_WINDOW: 'closed' }, stdio: 'ignore',
  });
  await waitReady('http://127.0.0.1:8793/mock/log', mock, [], '假平台');
  const env = {
    ...process.env, PORT: '8794', HOST: '127.0.0.1', KD_STATE_FILE: stateFile,
    KD_BASE: 'http://127.0.0.1:8793', KD_MOCK_STUDENT: 'E2E0000001', KD_SIGN_SECRET: 'mock-secret-for-local-test-only',
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' });
  await waitReady('http://127.0.0.1:8794/', child, [], '被测服务');
  const base = 'http://127.0.0.1:8794';
  const j = (u, o) => fetch(base + u, o).then((r) => r.json());

  // 绑定假账号（与 verify_e2e.js 同款 code）
  const card = Buffer.from(JSON.stringify({ t: 'e2e-token-0000', d: 'dev_e2e', f: '' }), 'utf8').toString('base64');
  const bind = await j('/bind', { method: 'POST', body: JSON.stringify({ code: card }) });
  ok(bind.ok === true, '绑定假账号成功');

  // 窗口外 live 提交（需先 /confirm 取令牌）→ 自动排期到窗口起点 + 1~3 分钟
  const confirm = await j('/confirm', { method: 'POST', body: JSON.stringify({ runType: 'CAMPUS', distanceKm: 2, durationSec: 540 }) });
  ok(confirm.ok === true && confirm.confirmToken, '/confirm 签发令牌');
  const run = await j('/run', { method: 'POST', body: JSON.stringify({ confirmToken: confirm.confirmToken, runType: 'CAMPUS', distanceKm: 2, durationSec: 540 }) });
  if (!(run.ok === true && run.scheduled === true)) console.log('  [debug] /run →', JSON.stringify(run).slice(0, 300));
  ok(run.ok === true && run.scheduled === true, '窗口外提交 → scheduled');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const jobs = Object.values(st.accounts).flatMap((a) => a.schedules || []);
  ok(jobs.length === 1 && jobs[0].auto === true, '排期任务入队且带 auto 标记');
  const job = jobs[0];
  const jobBj = new Date(job.plannedAt + 8 * 3600e3);
  ok(jobBj.getUTCHours() === 9 && jobBj.getUTCMinutes() >= 1 && jobBj.getUTCMinutes() <= 3, `落点在窗口起点+1~3分（实际 ${jobBj.toISOString().slice(11, 16)} 北京）`);

  // running 卡死恢复：手造一个 running 任务，resetStaleRunning 后应回 pending
  // （测试进程 require 的 server.js 也读同一份副本，见文件顶部 process.env 设置）
  job.status = 'running';
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
  await server.resetStaleRunning();
  const st2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const j2 = Object.values(st2.accounts).flatMap((a) => a.schedules || [])[0];
  ok(j2.status === 'pending', 'running 卡死任务被重置为 pending');

  // 先等子进程真正退出再退出本进程：Windows 上子进程句柄还在关闭时退出会触发 libuv assert。
  const waitExit = (p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode) return r(); p.once('exit', r); p.once('error', r); });
  child.kill(); mock.kill();
  await Promise.all([waitExit(child), waitExit(mock)]);
  try { fs.unlinkSync(stateFile); } catch { /* 无所谓 */ }
  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); child && child.kill(); mock && mock.kill(); process.exit(1); });
