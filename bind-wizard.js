// 取码向导与诊断端点：把现有命令行工具与本地状态暴露给网页，不再让用户开终端。
// 不引入代理/证书：取码仍然走 tools/取绑定码.js（读微信进程内存），这里只负责拉起与转发。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname);
const SCAN_SCRIPT = path.join(ROOT, 'tools', 'get-bind-code.js');
const SCAN_TIMEOUT_MS = 90000;

// 把取码器的进度转成 NDJSON 推给前端。
// stdout 是一次性的 pretty JSON（--json 的输出形状），所以只能等结束后整体解析；
// 进度来自脚本自己在 stderr 写的「第 N 次没取到…」——把它转成用户能看懂的话推上去。
// 为什么必须给进度：扫进程内存要几秒到几十秒，没有反馈用户会以为按钮没反应、反复点。
function streamScan(req, res) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  });
  const send = (obj) => { try { res.write(res.write ? JSON.stringify(obj) + '\n' : ''); } catch { /* 客户端已断 */ } };
  const done = (obj) => { send(obj); try { res.end(); } catch { /* 已结束 */ } };

  if (process.platform !== 'win32') {
    return done({ type: 'error', code: 'unsupported', message: '一键读取只在 Windows 上可用：取码需要读取微信进程内存。' });
  }
  if (!fs.existsSync(SCAN_SCRIPT)) {
    return done({ type: 'error', code: 'missing', message: '找不到取码脚本 tools/get-bind-code.js，安装包可能不完整。' });
  }

  send({ type: 'start', message: '正在读取微信进程信息…' });
  const child = spawn(process.execPath, [SCAN_SCRIPT, '--json'], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', errText = '', finished = false;
  const finish = (payload) => {
    if (finished) return;
    finished = true;
    done(payload);
  };
  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* 已退出 */ }
    finish({ type: 'error', code: 'timeout', message: '读取超时（90s）。确认微信已登录并保持运行后重试。' });
  }, SCAN_TIMEOUT_MS);

  child.stdout.on('data', (c) => { out += String(c); });
  child.stderr.on('data', (c) => {
    const piece = String(c);
    errText += piece;
    if (/第 \d+ 次没取到/.test(piece)) send({ type: 'progress', message: '没扫到，正在重试（让小程序停在首页更容易取到）…' });
  });
  child.on('error', (e) => {
    clearTimeout(timer);
    finish({ type: 'error', code: 'spawn', message: '取码器启动失败：' + e.message });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (finished) return;
    const m = /\{[\s\S]*\}/.exec(out);
    let parsed = null;
    try { parsed = m ? JSON.parse(m[0]) : null; } catch { /* 解析失败按未取到处理 */ }
    if (parsed && parsed.code) {
      return finish({ type: 'done', bindCode: parsed.code, user: parsed.t ? { tokenLen: String(parsed.t).length } : null });
    }
    // 退出码/报错 → 用户能看懂的原因。这三类覆盖了绝大多数求助场景。
    const hint = /管理员|Access is denied|拒绝访问|OpenProcess/i.test(errText) || code === 5
      ? '需要管理员权限：右键「启动.cmd」→ 以管理员身份运行，再点一次。'
      : '没读到绑定码。请确认：① 微信已登录；②「校园跑」小程序打开过首页；③ 小程序版本受支持。也可以用下面的「从剪贴板粘贴」。';
    // 不把子进程 stderr 原文回给浏览器：取码脚本的 stdout 是进程内存片段，
    // stderr 也可能带出来。只回白名单里的已知原因。
    const detail = /NO_WECHAT_PROCESS/.test(errText) ? '未找到微信进程'
      : /Access is denied|拒绝访问/.test(errText) ? '权限不足'
      : code === 2 ? '取码脚本未找到微信进程' : '取码脚本失败';
    finish({ type: 'error', code: 'scan_failed', exitCode: code, message: hint, detail });
  });
  req.on('close', () => { try { child.kill(); } catch { /* 已退出 */ } });
}

// 本地诊断：只读配置与 state，不触网。
// 探活（probe）另走三个 GET，同样是只读 —— 用来区分「token 过期」与「网络不通」。
// 保留首字 + 星号；空值原样返回 null。
function mask(v) { return v ? String(v).slice(0, 1) + '***' : null; }

function buildDiagnose(ctx) {
  const { loadState, activeAccount, DEMO_MODE, BASE, STATE_FILE, SIGN_SECRET } = ctx;
  const st = loadState();
  const a = activeAccount(st);
  const out = {
    ok: true,
    node: process.version,
    platform: process.platform,
    demo: DEMO_MODE,
    // 真实平台地址不写进诊断响应：终端启动日志里已经有，接口没必要再给一份。
    base: DEMO_MODE ? '(演示模式，本地假平台)' : (BASE ? '(已配置真实平台)' : '(未配置)'),
    stateFile: path.basename(STATE_FILE),
    stateFileExists: fs.existsSync(STATE_FILE),
    signSecretSet: !!SIGN_SECRET,
    account: a ? {
      // 只留首字：诊断信息够用，但不把完整姓名/学校名交给任何能访问本机端口的进程。
      studentId: String(a.id).slice(0, 4) + '***',
      name: mask(a.acc.user && a.acc.user.name),
      schoolName: mask(a.acc.user && a.acc.user.schoolName),
      hasCreds: !!(a.acc.creds && a.acc.creds.t),
      deviceId: a.acc.creds ? (a.acc.creds.d ? '已设置' : '缺失') : '缺失',
      routes: (a.acc.routes || []).length,
      selectedRouteId: a.acc.selectedRouteId || null,
      runs: (a.acc.runs || []).length,
      pendingSchedules: (a.acc.schedules || []).filter((x) => x.status === 'pending').length,
      session: a.acc.session ? {
        sessionId: a.acc.session.sessionId,
        remainSec: Math.max(0, Math.round((a.acc.session.submitAt - Date.now()) / 1000)),
      } : null,
      lastFailure: a.acc.lastFailure || null,
    } : null,
  };
  if (!SIGN_SECRET) out.signHint = '演示模式使用固定测试密钥；真实模式缺 signSecret 会在启动时直接退出。';
  return out;
}

module.exports = { streamScan, buildDiagnose, SCAN_SCRIPT };
