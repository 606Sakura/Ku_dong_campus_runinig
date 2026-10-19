'use strict';
// 端到端验收（零依赖）：三组进程
//   A 组·窗口外（KD_MOCK_WINDOW=closed）—— 窗口只该拦「立即提交的校园跑」
//   B 组·窗口内（默认 open）—— 校园跑全链路 + 字段映射 + 记录归一化
//   C 组·自由跑（closed）—— FREE 单发入库、绕过窗口、不计成绩
//   D 段（B 组内第二阶段）—— 平台统计取不到时的降级
//
// 为什么不用 output/playwright/run-qa.ps1：那里依赖 Playwright CLI 的硬编码绝对路径，
// 断言的是浏览器交互，验不到「前端又去读平台根本不存在的字段名」这类映射回退 ——
// 上一版 QA 全绿，正是因为 mock-platform 照着前端的错误字段名造了假数据。
// 本脚本直接对后端契约与前端源码做断言，任一条失败即 process.exitCode = 1。
//
// 运行：node tools/verify_e2e.js
// 注意：真实账号的 state.json 不会被碰（KD_STATE_FILE 指向临时文件）。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const MOCK_PORT = Number(process.env.KD_E2E_MOCK_PORT) || 8788;
const APP_PORT = Number(process.env.KD_E2E_APP_PORT) || 8791;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const BIND_CODE = Buffer.from(JSON.stringify({ t: 'e2e-token-0000', d: 'dev_e2e', f: '' })).toString('base64');

let pass = 0, fail = 0;
const failed = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failed.push(name); console.log(`  ✗ ${name}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, opt) {
  try {
    const r = await fetch(url, opt);
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, body, text };
  } catch (e) { return { status: 0, body: null, text: String(e && e.message || e) }; }
}
const postJson = (url, obj) => req(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj || {}),
});

// 端口上有没有人在听。绝不拿它当「我们的进程起来了」的判据 ——
// 上一轮残留的进程同样会让它返回真，上一版脚本正是被这个骗过：
// 新起的 app 撞 EADDRINUSE 秒退，探活却探到旧 app，/bind 打到旧进程（指向已死的 mock）报 fetch failed。
async function portBusy(port) {
  const r = await req(`http://127.0.0.1:${port}/`);
  return r.status > 0;
}

// 等子进程自己的服务就绪：既要端口通，也要进程还活着
async function waitReady(url, proc, out, label, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 12000)) {
    if (proc.exitCode !== null) {
      throw new Error(`${label} 启动即退出（exit ${proc.exitCode}）：` + out.join('').slice(-500));
    }
    if ((await req(url)).status > 0) return true;
    await sleep(150);
  }
  throw new Error(`${label} 超时未就绪：` + out.join('').slice(-500));
}

// 校园跑提交后会立刻返回 started:true，finish 由调度器在 durationSec*TIME_SCALE 后执行。
// 这里轮询 /state 直到 session 清空，返回最终记录。
async function waitSessionDone(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 20000)) {
    const st = await req(APP + '/state');
    if (st.body && st.body.ok && !st.body.session) return st.body;
    await sleep(200);
  }
  return (await req(APP + '/state')).body;
}

// 起 mock + server，跑 fn，最后一定杀掉两个进程
async function withStack(opts, fn) {
  const mockEnv = {
    ...process.env, PORT: String(MOCK_PORT),
    // 严格计时开着（默认），容差放宽到覆盖压缩后的等待误差；压缩系数让 e2e 不必真等 180s
    KD_MOCK_TIME_TOLERANCE_SEC: '10',
    // mock 必须用同一个压缩系数，否则它按真实 600s 对账、被测按 6s 提交，永远判无效
    KD_TIME_SCALE: '0.01',
    KD_MOCK_WINDOW: opts.window || 'open',
    KD_MOCK_STATS: opts.stats || '',
    KD_MOCK_STUDENT: 'E2E0000001',
  };
  for (const [p, what] of [[MOCK_PORT, '假平台'], [APP_PORT, '被测服务']]) {
    if (await portBusy(p)) {
      throw new Error(`端口 ${p} 已被占用（${what}）：先关掉上一个进程再跑，否则本轮会探到旧进程而误判。`);
    }
  }
  const stateFile = path.join(os.tmpdir(), `kd-e2e-state-${process.pid}-${Date.now()}.json`);
  const mock = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-platform.js')],
    { env: mockEnv, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
  const mockOut = [];
  mock.stdout.on('data', (c) => mockOut.push(String(c)));
  mock.stderr.on('data', (c) => mockOut.push(String(c)));

  const app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(APP_PORT), KD_BASE: MOCK, KD_STATE_FILE: stateFile, KD_SIGN_SECRET: 'mock-secret-for-local-test-only',
      // 真实计时在验收里压缩到 1%：等 1.2s 而不是 120s；上报的 duration 不变
      KD_TIME_SCALE: '0.01', KD_TICK_MS: '300' },
    stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
  });
  const appOut = [];
  app.stdout.on('data', (c) => appOut.push(String(c)));
  app.stderr.on('data', (c) => appOut.push(String(c)));

  const kill = () => {
    for (const p of [app, mock]) { try { p.kill(); } catch { /* 已退出 */ } }
  };
  try {
    await waitReady(MOCK + '/mock/log', mock, mockOut, '假平台');
    await waitReady(APP + '/state', app, appOut, '被测服务');
    await postJson(MOCK + '/mock/reset', {});
    const bind = await postJson(APP + '/bind', { code: BIND_CODE });
    if (!(bind.body && bind.body.ok)) throw new Error('绑定失败: ' + bind.text.slice(0, 200));
    // CAMPUS 前置：拉附近路线并选定 62（大环）。单条时服务端自动选，两条必须显式选。
    const routes = await req(APP + '/routes?lat=0&lng=0');
    if (!(routes.body && routes.body.ok && routes.body.routes.length >= 2)) {
      throw new Error('拉取路线失败: ' + JSON.stringify(routes.body).slice(0, 200));
    }
    const sel = await postJson(APP + '/routes/select', { routeId: 62 });
    if (!(sel.body && sel.body.ok)) throw new Error('选路线失败: ' + JSON.stringify(sel.body).slice(0, 200));
    return await fn({ mock, app, stateFile, mockOut, appOut });
  } finally {
    kill();
    // 等端口真的释放：TIME_WAIT 不挡 bind，但进程未退会挡。最多等 3 秒。
    for (let i = 0; i < 20; i++) {
      if (!await portBusy(MOCK_PORT) && !await portBusy(APP_PORT)) break;
      await sleep(150);
    }
    try { fs.unlinkSync(stateFile); } catch { /* 无所谓 */ }
    for (const p of [app, mock]) { if (!p.killed) { try { p.kill('SIGKILL'); } catch { /* 已退出 */ } } }
  }
}

const mockLog = async () => (await req(MOCK + '/mock/log')).body;
const pathsOf = (log) => (log && log.data && log.data.requests || []).map((r) => `${r.method} ${r.path}`);
const bodyOf = (log, method, p) => {
  const hit = (log && log.data && log.data.requests || []).find((r) => r.method === method && r.path === p);
  if (!hit) return null;
  try { return JSON.parse(hit.body); } catch { return null; }
};

// 与 server.js 的 parseWindow 同口径：从平台原文抠窗口起止（分钟）
function parseWindowFromMock() {
  const m = /([0-9]{1,2}):([0-9]{2})[^0-9]{0,6}([0-9]{1,2}):([0-9]{2})/.exec('仅允许在09:00~09:30开始跑步');
  if (!m) return null;
  return { startMin: +m[1] * 60 + +m[2], endMin: +m[3] * 60 + +m[4] };
}

// ---------- A 组：窗口外 ----------
async function groupA() {
  console.log('\n[A 组] 窗口外（KD_MOCK_WINDOW=closed）');
  await withStack({ window: 'closed' }, async () => {
    // 1. 校园跑立即提交必须被窗口拦住（证明 mock 的窗口开关真的生效，
    //    否则后面「预约不受窗口影响」的对照就没有意义）
    // ★ 新版行为：窗口外不再 400，而是自动排到下一个开跑窗口并落一条 pending。
    // 这条断言同时钉住三件事：200、scheduled:true、plannedAt 真落在窗口起点之后 1~3 分钟内。
    const cfCampus = await postJson(APP + '/confirm', { distanceKm: 1.2, durationSec: 600 });
    const runCampus = await postJson(APP + '/run', {
      distanceKm: 1.2, durationSec: 600, confirmToken: cfCampus.body && cfCampus.body.confirmToken,
    });
    const w = parseWindowFromMock();
    const jitterOk = runCampus.body && Number.isFinite(runCampus.body.plannedAt) && w
      ? (() => {
        const bj = new Date(runCampus.body.plannedAt + 8 * 3600e3);
        const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
        return mins >= w.startMin && mins <= w.startMin + 3;
      })() : false;
    check('A1 窗口外 · 校园跑自动排期(200 + scheduled)',
      runCampus.status === 200 && runCampus.body && runCampus.body.ok === true
        && runCampus.body.scheduled === true && runCampus.body.auto === true,
      { status: runCampus.status, body: runCampus.body });
    check('A1b 自动排期落在窗口起点后 1~3 分钟内',
      jitterOk, { plannedAt: runCampus.body && runCampus.body.plannedAt, window: w });
    check('A1c 窗口外不再返回 400（旧行为已移除）',
      runCampus.status !== 400 && !(runCampus.body && runCampus.body.problems), runCampus.status);

    // 2. 同一个窗口下，预约照常创建 —— 这就是「预约不该被窗口连坐」的后端侧证据
    // plannedAt 只取一次：摘要含它的精确值，两次 Date.now() 差几毫秒就会 403
    const plannedAt = Date.now() + 3600e3;
    const cfSched = await postJson(APP + '/confirm', { distanceKm: 1.2, durationSec: 600, plannedAt });
    const sched = await postJson(APP + '/schedule', {
      distanceKm: 1.2, durationSec: 600, plannedAt,
      confirmToken: cfSched.body && cfSched.body.confirmToken,
    });
    check('A2 窗口外 · 预约仍可创建(200)', sched.status === 200 && sched.body && sched.body.ok,
      { status: sched.status, body: sched.body });

    // 3. 预约点存在 /state.schedules 里（前端队列读的就是它）
    const st = await req(APP + '/state');
    // A1 的自动排期 + 这条手建预约 = 2 条 pending
    const pend = (st.body && st.body.schedules || []).filter((j) => j.status === 'pending');
    check('A3 预约已入队 /state.schedules（含 A1 的自动排期）', st.status === 200 && pend.length === 2,
      { n: pend.length, auto: pend.filter((j) => j.auto === true).length });
    check('A3b 自动排期那条带 auto:true 标记（可与手建预约区分）',
      pend.some((j) => j.auto === true && j.id === (runCampus.body && runCampus.body.jobId)));

    // 4. 前端源码：窗口条件必须带 !scheduled，且按钮状态不再只有一个出口
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    check('A4 index.html · 窗口校验带 !scheduled（预约不连坐）',
      /if \(!scheduled && rules\.runAvailableNow !== true\)/.test(html));
    // ★ 新版行为：手动「改用预约」按钮已删除，窗口外由后端自动排。
    // 断言换成「自动排期链路完整」+「旧按钮确实不在了」。
    check('A5 index.html · 自动落窗链路存在（windowStartFrom + scheduled 分支）',
      /function windowStartFrom/.test(html) && /r.body.scheduled/.test(html)
        && /已自动排到/.test(html));
    check('A5b index.html · 手动「改用预约」按钮已移除',
      !/id="switch-schedule-window"/.test(html) && !/switch-schedule-window/.test(html));
    check('A5c index.html · 提交按钮不再因窗口外用 disabled 拦（窗口外可点）',
      !/switch-schedule-window/.test(html) && /c.ok === false && !c.unknown/.test(html));
    check('A5d index.html · 手机卡已移除，局域网地址改由 /lan 提供',
      !/id="copy-phone-link"/.test(html) && html.includes("apiGet('/lan')"));
    check('A5e index.html · 距离/时长微调按钮存在（始终可见可改）',
      /data-step="distance-km"/.test(html) && /data-step="duration-sec"/.test(html)
        && /data-delta="1"/.test(html) && /data-delta="-1"/.test(html));
    check('A5f index.html · 默认值来自 /rules 的 defaults，不是 HTML 硬编码',
      /serverDefaults = rr.body.defaults/.test(html) && /function applyDefaults()/.test(html));
    check('A5g index.html · 默认值按「规则签名」重填（换账号/换学校才重置，同规则下不覆盖用户改动）',
      /let defaultsSig = null/.test(html)
        && html.includes('if (sig === defaultsSig) return')
        && /function ruleSignature()/.test(html) && !/defaultsApplied/.test(html));
    // 决策 19：预填窗口起点靠解析平台原文，且失败要能留空
    const m = /(\d{1,2}):(\d{2})\s*[~\-—至到]\s*(\d{1,2}):(\d{2})/.exec('仅允许在09:00~09:30开始跑步');
    check('A6 平台原文可解析出窗口起点 09:00', !!m && m[1] === '09' && m[2] === '00',
      m && m.slice(0, 3));
    // 7. 跑步回放进度条（静态）：这些名字只活在 index.html 里，
    //    渲染分支被删、或宽度回到写死值，这里必红。
    check('A7 index.html · 实时进度函数 paintLive 定义存在', html.includes('function paintLive()'));
    check('A8 index.html · 1 秒 tick 真的调用了 paintLive()（不是只定义不用）',
      html.includes('paintLive(); }, 1000)'));
    check('A8b index.html · 进度由服务端 session.startedAt/submitAt 驱动，不再本地回放',
      html.includes('session.startedAt') && html.includes('session.submitAt') && !html.includes('function paintReplay'));
    check('A9 index.html · .task-progress>span 不再写死 width:35%（宽度只能由 JS 给）',
      html.includes('height:100%;width:0;') && !html.includes('width:35%'));
    check('A10 index.html · 里程行 data-role="pace" 与回放小字 data-role="replay-note" 都存在',
      /data-role="pace"/.test(html) && /data-role="replay-note"/.test(html));
    check('A11 index.html · 状态徽章渲染分支补上 success（否则任务一成功就从卡里消失）',
      /tone = 'success'/.test(html), { hit: (html.match(/tone = 'success'/g) || []).length });
  });
}

// ---------- B 组：窗口内 ----------
async function groupB() {
  console.log('\n[B 组] 窗口内（runAvailableNow=true）');
  await withStack({ window: 'open' }, async () => {
    const cf = await postJson(APP + '/confirm', { distanceKm: 1.2, durationSec: 600 });
    const run = await postJson(APP + '/run', {
      distanceKm: 1.2, durationSec: 600, confirmToken: cf.body && cf.body.confirmToken,
    });
    check('B1 校园跑建会话成功(200，返回 started 与 submitAt)',
      run.status === 200 && run.body && run.body.ok && run.body.started === true && run.body.sessionId != null,
      { status: run.status, body: run.body });
    check('B2 返回 sessionId 且类型为 CAMPUS',
      run.body && run.body.sessionId != null && run.body.runType === 'CAMPUS', run.body);
    check('B2b 到点时刻 = 开始 + duration（真实计时，非零等待）',
      run.body && run.body.submitAt - run.body.startedAt >= 1000,
      run.body && { wait: run.body.submitAt - run.body.startedAt });
    // 等调度器把会话提交完，后续断言才有记录可查
    const done = await waitSessionDone(20000);
    check('B2c 会话在到点后自动提交并清空',
      done && !done.session && (done.runs || []).length >= 1,
      done && { session: done.session, runs: (done.runs || []).length });

    // 3. /records 字段映射 —— 本次改动的核心。
    //    这里断言平台真字段名而不是前端当初编的名字；一旦前端/后端又回退，必红。
    const rec = await req(APP + '/records');
    const d = rec.body || {};
    check('B3 /records.stats 归一化成功', d.stats && d.stats.ok === true, { stats: d.stats });
    check('B4 stats.validCount 是数字（取 standards[].currentValue）',
      d.stats && Number.isFinite(d.stats.validCount) && d.stats.validCount === 1, { v: d.stats && d.stats.validCount });
    check('B5 stats.standardCount === 18（取 standardValue，非 targetValue/requiredRuns）',
      d.stats && d.stats.standardCount === 18, { v: d.stats && d.stats.standardCount });
    check('B6 stats.totalDistanceKm 是数字（取 semesterStats.qualifiedDistance||totalDistance）',
      d.stats && Number.isFinite(d.stats.totalDistanceKm), { v: d.stats && d.stats.totalDistanceKm });
    check('B7 stats 不含平台不存在的键 validRuns/requiredRuns',
      d.stats && d.stats.validRuns === undefined && d.stats.requiredRuns === undefined, { keys: d.stats && Object.keys(d.stats) });

    // 8. 平台记录归一化：status 数字 → 语义串；列表键必须是 records
    const p0 = (d.platform || [])[0];
    check('B8 platform 记录条数 = 1（列表键 records 被认到）', (d.platform || []).length === 1,
      { n: (d.platform || []).length });
    check('B9 platform[0].status 归一化为语义串（数字 1 → success）',
      p0 && p0.status === 'success', { status: p0 && p0.status });
    check('B10 platform[0] 字段名统一：distanceKm/durationSec，且没有原始 distance',
      p0 && Number.isFinite(p0.distanceKm) && Number.isFinite(p0.durationSec) && p0.distance === undefined,
      { keys: p0 && Object.keys(p0) });
    check('B11 platform[0].src === "platform"（来源标签）', p0 && p0.src === 'platform', { src: p0 && p0.src });

    // 12. 本机日志补默认值：runType/platformId 必须存在，去重键才配得上
    const l0 = (d.local || [])[0];
    check('B12 local[0] 有 runType 与 platformId（旧记录读取时补默认值）',
      l0 && l0.runType === 'CAMPUS' && l0.platformId != null, { runType: l0 && l0.runType, platformId: l0 && l0.platformId });
    check('B13 本机 platformId 与平台 id 可对上（去重键同源）',
      l0 && p0 && String(l0.platformId) === String(p0.id), { local: l0 && l0.platformId, plat: p0 && p0.id });

    // 14. 静态回归：前端不得再出现平台不存在的字段名
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const bad = [/stats\?\.validRuns/, /stats\.validRuns/, /stats\.requiredRuns/].filter((re) => re.test(html));
    check('B14 index.html 不再引用 stats.validRuns/requiredRuns', bad.length === 0, { hits: bad.length });
    check('B15 index.html 记录去重键 keyOf 存在', /const keyOf = \(r\) =>/.test(html));

    // 16. 签名未被破坏
    const log = await mockLog();
    check('B16 mock 验签全过（signFail=0 且 signOk>0）',
      log.data.signFail === 0 && log.data.signOk > 0, { ok: log.data.signOk, fail: log.data.signFail });
    check('B17 校园跑走的是会话链路（有 sessions/start 与 finish）',
      pathsOf(log).some((p) => p === 'POST /runs/sessions/start')
      && pathsOf(log).some((p) => /POST \/runs\/sessions\/\d+\/finish/.test(p)), { paths: pathsOf(log) });

    // 19. 跨校：提交用的是所选路线 62，轨迹落在 62 的环上，而不是路线 6 的旧坐标
    const startBody = bodyOf(log, 'POST', '/runs/sessions/start');
    check('B25 startBody.routeId 是所选路线 62（不是硬编码 6）',
      startBody && startBody.routeId === 62, { startBody });
    const b0 = bodyOf(log, 'POST', '/runs/sessions/start');
    check('B26 startLatitude/Longitude 在路线 62 首点附近（±0.0002）',
      b0 && Math.abs(b0.startLatitude) <= 3e-4 && Math.abs(b0.startLongitude - 0.0014) <= 3e-4,
      b0);
    const runLog = (await mockLog()).data.requests.find((r) => r.method === 'POST' && /\/finish$/.test(r.path));
    let firstPt = null;
    try { firstPt = JSON.parse(runLog.body).routeData[0]; } catch { /* 已在断言里报 */ }
    check('B27 轨迹首点落在路线 62 的环上（与旧路线首点 30.0000/120.0000 不同）',
      firstPt && Math.abs(firstPt.latitude - 30.0) > 0.005 && Math.abs(firstPt.longitude - 120.0) > 0.005,
      firstPt);
    // 18. 回放的三条不变量：起点取落定时刻、失败不回放、宽度按已过时间重算
    check('B21 index.html · 落定记录仍按 finishedAt / runs[].at 归一',
      /settledFromSchedule/.test(html) && /settledFromRun/.test(html));
    check('B22 index.html · 失败任务不显示进度（pace 行保持 hidden）',
      /current.status !== 'failed'/.test(html));
    check('B23 index.html · 进度宽度按「已过时间 / 会话总时长」重算（刷新后接同一时间轴）',
      html.includes('(Date.now() - live.startedAt) / total'));
    check('B24 index.html · 宽度格式化为两位小数百分比（0.00% ~ 100.00%）',
      html.includes("(frac * 100).toFixed(2) + '%'"));
    check('B28 index.html · 进行中的会话优先展示（session 分支先于 pending）',
      /const current = sessionAcc/.test(html));
  });

  // 降级段：平台统计取不到 → 不得回落本地条数
  console.log('\n[B 组 · 降级段] KD_MOCK_STATS=empty（平台 /stats 返回 data:null）');
  await withStack({ window: 'open', stats: 'empty' }, async () => {
    const cf = await postJson(APP + '/confirm', { distanceKm: 1.2, durationSec: 600 });
    await postJson(APP + '/run', { distanceKm: 1.2, durationSec: 600, confirmToken: cf.body && cf.body.confirmToken });
    await waitSessionDone(20000);
    const rec = await req(APP + '/records');
    const d = rec.body || {};
    check('B18 统计取不到时 stats 为 null（不塌成假数据）', d.stats === null, { stats: d.stats });
    check('B19 同时给出 statsError 原因', typeof d.statsError === 'string' && d.statsError.length > 0, { e: d.statsError });
    check('B20 本机日志仍在（记录列表不因统计失败而空）', (d.local || []).length === 1, { n: (d.local || []).length });
  });
}

// ---------- C 组：自由跑 ----------
async function groupC() {
  console.log('\n[C 组] 自由跑（KD_MOCK_WINDOW=closed，验证绕过窗口）');
  await withStack({ window: 'closed' }, async () => {
    // 1. FREE 不受窗口限制（mock 明确处于窗口外）
    const cf = await postJson(APP + '/confirm', { distanceKm: 1.2, durationSec: 600, runType: 'FREE' });
    check('C1 FREE 可取得确认令牌', cf.status === 200 && cf.body && cf.body.ok && cf.body.runType === 'FREE', cf.body);
    const run = await postJson(APP + '/run', {
      distanceKm: 1.2, durationSec: 600, runType: 'FREE', confirmToken: cf.body && cf.body.confirmToken,
    });
    check('C2 窗口外 FREE 仍提交成功(200)（FREE 不查窗口）',
      run.status === 200 && run.body && run.body.ok, { status: run.status, body: run.body });
    check('C3 返回 platformId 且 sessionId 为 null（FREE 无会话）',
      run.body && run.body.platformId != null && run.body.sessionId === null && run.body.runType === 'FREE', run.body);

    // 4. 走的是单发 POST /runs，不是会话链路
    const log = await mockLog();
    const paths = pathsOf(log);
    check('C4 FREE 不发 sessions/start', !paths.some((p) => p === 'POST /runs/sessions/start'), { paths });
    check('C5 FREE 发单发 POST /runs', paths.includes('POST /runs'), { paths });

    // 6. body 形状（对照小程序 saveRunRecord）
    const b = bodyOf(log, 'POST', '/runs');
    check('C6 FREE body 带 runType:"FREE"', b && b.runType === 'FREE', { runType: b && b.runType });
    check('C7 FREE body 带轨迹（routeData 非空）', b && Array.isArray(b.routeData) && b.routeData.length > 0,
      { points: b && b.routeData && b.routeData.length });
    check('C8 FREE body 不含 routeId（自由跑无固定路线）', b && b.routeId === undefined, { routeId: b && b.routeId });
    check('C9 FREE body 的距离/时长/配速齐全',
      b && Number.isFinite(b.distance) && Number.isFinite(b.duration) && typeof b.pace === 'string', b && { d: b.distance, t: b.duration, p: b.pace });

    // 10. mock 独立复核轨迹收敛
    const ml = (log.data.runs || []).find((r) => r.runType === 'FREE');
    check('C10 mock 复核 FREE 轨迹：实走与申报偏差 < 0.05%',
      ml && ml.trackAudit && ml.trackAudit.ok === true && Math.abs(ml.trackAudit.deltaPct) < 0.05,
      ml && ml.trackAudit);

    // 11. 本机日志记账：runType + platformId
    const st = await req(APP + '/state');
    const r0 = (st.body.runs || [])[0];
    check('C11 本机日志记 runType:"FREE" 与 platformId',
      r0 && r0.runType === 'FREE' && r0.platformId != null && r0.sessionId === null,
      r0 && { runType: r0.runType, platformId: r0.platformId, sessionId: r0.sessionId });

    // 12. 决定性：FREE 不进有效成绩
    const rec = await req(APP + '/records');
    const d = rec.body || {};
    check('C12 FREE 不计入 stats.validCount（有效次数仍为 0）',
      d.stats && d.stats.ok === true && d.stats.validCount === 0, { v: d.stats && d.stats.validCount });
    check('C13 但平台记录里能看到这次 FREE',
      (d.platform || []).length === 1 && d.platform[0].runType === 'FREE', { n: (d.platform || []).length });

    // 14. 令牌绑定类型：校园跑的令牌不能拿来提交自由跑
    const cf2 = await postJson(APP + '/confirm', { distanceKm: 1.2, durationSec: 600 });   // CAMPUS
    const cross = await postJson(APP + '/run', {
      distanceKm: 1.2, durationSec: 600, runType: 'FREE', confirmToken: cf2.body && cf2.body.confirmToken,
    });
    check('C14 跨类型复用令牌被拒(403)（paramDigest 含 runType）',
      cross.status === 403 && /参数与确认时不一致/.test(String(cross.body && cross.body.error)),
      { status: cross.status, error: cross.body && cross.body.error });

    // 15. 自由跑不支持预约：两块入口都要堵上
    const cf3 = await postJson(APP + '/confirm', {
      distanceKm: 1.2, durationSec: 600, runType: 'FREE', plannedAt: Date.now() + 3600e3,
    });
    check('C15 FREE + plannedAt 的 /confirm 被拒(400)', cf3.status === 400, { status: cf3.status, body: cf3.body });
    const cf4 = await postJson(APP + '/confirm', { distanceKm: 1.2, durationSec: 600, plannedAt: Date.now() + 3600e3 });
    const schedFree = await postJson(APP + '/schedule', {
      distanceKm: 1.2, durationSec: 600, runType: 'FREE', plannedAt: Date.now() + 3600e3,
      confirmToken: cf4.body && cf4.body.confirmToken,
    });
    check('C16 /schedule 带 runType:FREE 被拒(400)', schedFree.status === 400, { status: schedFree.status, body: schedFree.body });

    // 17. /preview 的 FREE plan 形状（前端画轨迹要能取到）
    //    先清请求日志：干跑必须零提交，而前面已经真实提交过一次 FREE
    await postJson(MOCK + '/mock/reset', {});
    const pv = await postJson(APP + '/preview', { distanceKm: 1.2, durationSec: 600, runType: 'FREE' });
    check('C17 FREE 干跑 plan 为单发形状且带轨迹',
      pv.status === 200 && pv.body && pv.body.plan && pv.body.plan.path === '/runs'
      && Array.isArray(pv.body.plan.body.routeData) && pv.body.plan.body.routeData.length > 0,
      { plan: pv.body && pv.body.plan && Object.keys(pv.body.plan) });
    check('C18 干跑不产生任何提交请求（只有 GET）',
      !pathsOf(await mockLog()).some((p) => p.startsWith('POST /runs')), {});
  });
}

(async () => {
  console.log('校园跑自托管 · 端到端验收（零真实提交，全部指向本地假平台）');
  try {
    await groupA();
    await groupB();
    await groupC();
  } catch (e) {
    fail++;
    failed.push('运行中断');
    console.error('\n[致命] ' + (e && e.stack || e));
  }
  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  if (failed.length) { console.log('失败项：\n  - ' + failed.join('\n  - ')); process.exitCode = 1; }
  else console.log('全部通过。');
})();
