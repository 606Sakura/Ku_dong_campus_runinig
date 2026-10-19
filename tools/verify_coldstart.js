// 零配置冷启动：把仓库复制到临时目录，不预置 config.local.json / config.seed.json，
// 断言服务能起、进入演示模式、并走通 /bind → /routes → /confirm → /run。
// 用法：node tools\verify_coldstart.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { waitReady } = require('./lib/wait-ready.js');

const ROOT = path.join(__dirname, '..');
const APP_PORT = 8797;
const DEMO_PORT = 8798;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 800);
  });
}

// 只复制运行所需文件，不复制任何本地配置与真实状态
const COPY = ['server.js', 'index.html', 'track-core.js', 'run-guard.js', 'bind-wizard.js', 'card-core.js', 'package.json', 'config.example.json', 'schools.example.json', 'state.example.json'];
function stage(tmp) {
  fs.mkdirSync(path.join(tmp, 'tools'), { recursive: true });
  for (const f of COPY) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  for (const f of ['mock-platform.js', 'lib/wait-ready.js']) {
    const dst = path.join(tmp, 'tools', f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'tools', f), dst);
  }
}

(async () => {
  if (await portBusy(APP_PORT) || await portBusy(DEMO_PORT)) {
    console.error(`端口 ${APP_PORT}/${DEMO_PORT} 已被占用（可能有上一轮残留进程），先关掉再跑。`);
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-cold-'));
  let child = null;
  const out = [];
  try {
    stage(tmp);
    ok(!fs.existsSync(path.join(tmp, 'config.local.json')), '临时目录没有 config.local.json');
    ok(!fs.existsSync(path.join(tmp, 'config.seed.json')), '临时目录没有 config.seed.json（确实零配置）');

    // 绝不设 KD_BASE / KD_SIGN_SECRET：它们会让服务以为自己是真实模式
    const env = { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', KD_DEMO_PORT: String(DEMO_PORT), KD_STATE_FILE: path.join(tmp, 'tmp-state.json') };
    delete env.KD_BASE; delete env.KD_SIGN_SECRET; delete env.AC_SCHOOLS_FILE;
    child = spawn(process.execPath, [path.join(tmp, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    await waitReady('http://127.0.0.1:' + APP_PORT + '/', child, out, '被测服务');

    const base = 'http://127.0.0.1:' + APP_PORT;
    const j = async (u, o) => { const r = await fetch(base + u, o); return { status: r.status, body: await r.json().catch(() => null) }; };
    const post = (u, b) => j(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

    const home = await fetch(base + '/');
    const html = await home.text();
    ok(home.status === 200 && html.includes('id="bind-screen"'), 'GET / 返回绑定页');
    ok(html.includes('id="demo-banner"'), '页面含演示模式横幅容器');

    const st = await j('/state');
    ok(st.body && st.body.ok === true, 'GET /state ok');
    ok(st.body && st.body.demo === true, 'GET /state demo=true（未配置时自动演示模式）');
    ok(st.body && (st.body.accounts || []).length === 0, '尚无账号');

    const md = await j('/mode');
    ok(md.body && md.body.demo === true && md.body.base === undefined, 'GET /mode 只回演示标志，不下发平台地址');

    const cfg = await j('/config');
    ok(cfg.body && cfg.body.ok === true && cfg.body.schoolLat === null, 'GET /config 无坐标时返回 null');

    // 演示码：README「演示模式」那段命令的产物
    const card = Buffer.from(JSON.stringify({ t: '11111111-2222-3333-4444-555555555555', d: 'dev_aaaaaaaaaaaaaaaa', f: '' }), 'utf8').toString('base64');
    const bind = await post('/bind', { code: card });
    ok(bind.body && bind.body.ok === true, '绑定演示账号成功', bind.body && bind.body.error);

    const rules = await j('/rules');
    ok(rules.body && rules.body.ok === true, 'GET /rules ok');
    const d = (rules.body && rules.body.defaults) || {};
    const rr = (rules.body && rules.body.rules) || {};
    ok(Number.isFinite(d.distanceKm) && d.distanceKm >= rr.minDistance, '开箱默认距离在平台下限之上');
    ok(Number.isFinite(d.durationSec) && d.durationSec >= rr.minDuration && d.durationSec <= rr.maxDuration, '开箱默认时长落在平台区间内');

    const routes = await j('/routes?lat=0&lng=0');
    const list = (routes.body && routes.body.routes) || [];
    ok(list.length === 2, '取到 2 条附近路线', 'got ' + list.length);
    ok(routes.body && routes.body.selectedRouteId === null, '多条路线不自动选（交给用户挑）');

    const sel = await post('/routes/select', { routeId: list[0].routeId });
    ok(sel.body && sel.body.ok === true, '选定路线');

    const confirm = await post('/confirm', { runType: 'CAMPUS', distanceKm: d.distanceKm, durationSec: d.durationSec });
    ok(confirm.body && confirm.body.ok === true && confirm.body.confirmToken, '拿到确认令牌');

    const run = await post('/run', { runType: 'CAMPUS', distanceKm: d.distanceKm, durationSec: d.durationSec, confirmToken: confirm.body.confirmToken });
    ok(run.body && run.body.ok === true && run.body.scheduled !== true, '零配置下完成一次真实提交（打到演示平台）', run.body && (run.body.error || (run.body.problems || []).join('；')));

    ok(!fs.existsSync(path.join(tmp, 'config.local.json')), '没有 seed 时不会凭空生成 config.local.json');

    // ---------- seed 自动生成：只在 config.local.json 不存在时复制一次 ----------
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-seed-'));
    try {
      stage(tmp2);
      const seed = { baseUrl: '', signSecret: '', port: 0, host: '127.0.0.1', schoolLat: 0.5, schoolLng: 0.5 };
      fs.writeFileSync(path.join(tmp2, 'config.seed.json'), JSON.stringify(seed, null, 2));
      const serverPath = path.join(tmp2, 'server.js');
      require(serverPath);   // require.main !== module，只跑配置加载，不 listen
      const localPath = path.join(tmp2, 'config.local.json');
      ok(fs.existsSync(localPath), '有 seed 时自动生成 config.local.json');
      const written = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      ok(written.schoolLat === 0.5 && written.schoolLng === 0.5, '生成的配置内容与 seed 一致');

      // 用户改过之后不能被 seed 覆盖
      fs.writeFileSync(localPath, JSON.stringify({ ...seed, schoolLat: 0.25 }));
      delete require.cache[require.resolve(serverPath)];
      require(serverPath);
      ok(JSON.parse(fs.readFileSync(localPath, 'utf8')).schoolLat === 0.25, '已有的 config.local.json 不被 seed 覆盖');
    } finally {
      try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    fail++;
    console.log('  ✗ 异常：' + e.message);
    if (out.length) console.log('    --- 服务输出 ---\n' + out.join('').slice(-1200));
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => { child.on('exit', r); setTimeout(r, 2000); });
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n冷启动：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
