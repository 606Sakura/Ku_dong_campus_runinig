// 取绑定码：Node 入口。流式读 extract-token.ps1 的输出，命中即停，绝不落盘。
// 用法：
//   node 取绑定码.js                 打印绑定码
//   node 取绑定码.js --mask          只打印字段是否存在与长度（安全自查用）
//   node 取绑定码.js --json          打印 {t,d,f,code}（明文，仅排错）
//   node 取绑定码.js --bind          取码后自动 POST 本机服务完成绑定
//   node 取绑定码.js --raw <file>    跳过扫内存，对已有内存文本提取（联调用）
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { grab, makeCard } = require('../card-core.js');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const PS1 = path.join(__dirname, 'extract-token.ps1');
const TAIL = 8192;   // 匹配可能跨 chunk 边界，多留一截尾巴再拼

// 流式扫描：凑齐 t/d 就杀掉子进程立刻返回，不把几百 MB 内存读进本进程。
function scanStream(proc) {
  return new Promise((resolve, reject) => {
    let buf = '', errText = '', stopped = false;
    const finish = (err, found) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      err ? reject(err) : resolve(found);
    };
    const timer = setTimeout(() => {
      const e = new Error('扫描超时（120 秒）。请确认微信已打开校园跑小程序并停在首页后重试。');
      e.code = 'TIMEOUT';   // 超时不重试：三次 = 6 分钟，用户只会以为程序卡死
      finish(e);
    }, 120000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      const r = grab(buf);
      if (r.t && r.d) return finish(null, r);
      if (buf.length > TAIL) buf = buf.slice(-TAIL);
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { errText += d; });
    proc.on('error', (e) => finish(new Error('无法启动 PowerShell: ' + e.message)));
    proc.on('close', (code) => {
      if (stopped) return;
      const r = grab(buf);
      if (r.t && r.d) return finish(null, r);
      if (code === 2 || /NO_WECHAT_PROCESS/.test(errText)) {
        const e = new Error('没找到微信进程。请先打开电脑微信并进入校园跑小程序首页，再重试。');
        e.code = 'NO_WECHAT';
        return finish(e);
      }
      finish(null, r);
    });
  });
}

async function readCreds() {
  const rawFile = argOf('--raw');
  if (rawFile) return grab(fs.readFileSync(rawFile, 'utf8'));
  // 三次尝试：微信会在切到前台时重写内存，单次扫不到多半是时机问题。
  // 每次重新 spawn，extract-token.ps1 每次执行都会重新枚举微信进程，重试不是空转。
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1], { windowsHide: true });
    try {
      const r = await scanStream(proc);
      if (r && r.t && r.d) return r;
      lastErr = null;
    } catch (e) {
      if (e && e.code === 'TIMEOUT') throw e;
      lastErr = e;
    }
    if (attempt < 3) {
      process.stderr.write("第 " + attempt + " 次没取到，1 秒后重试（请保持小程序停在首页）…\n");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// 三次自动取码都失败后的手动兜底：把可复制的命令原样打出来，不要让用户去猜。
function writeFallbackHint() {
  const port = process.env.PORT || '8787';
  process.stderr.write(
    '\n-- 手动兜底 --\n' +
    '1) 在已登录微信的这台 Windows 上运行： node tools\\取绑定码.js\n' +
    '2) 它会打印一串 Base64，复制整串\n' +
    '3) 回到 http://127.0.0.1:' + port + '/ ，粘贴到「绑定码」框，点「连接身份」\n');
}

async function main() {
  let creds;
  try { creds = await readCreds(); }
  catch (e) { process.stderr.write(e.message + '\n'); writeFallbackHint(); return 1; }
  if (!creds || !creds.t) {
    process.stderr.write('没提取到 token。请在小程序里退到首页再进一次（触发新的请求），然后重试。\n');
    writeFallbackHint();
    return 1;
  }
  const code = makeCard(creds.t, creds.d, creds.f);

  if (has('--mask')) {
    const m = (v) => (v ? v.slice(0, 6) + '…(' + v.length + ' chars)' : '(缺失)');
    process.stdout.write('token=' + m(creds.t) + '\ndevice-id=' + m(creds.d) + '\nfp=' + m(creds.f) + '\n绑定码长度=' + code.length + '\n');
  } else if (has('--json')) {
    process.stdout.write(JSON.stringify({ t: creds.t, d: creds.d, f: creds.f, code }, null, 2) + '\n');
  } else {
    process.stdout.write(code + '\n');
  }

  if (has('--bind')) {
    const url = 'http://127.0.0.1:' + (process.env.PORT || '8787') + '/bind';
    const r = spawnSync(process.execPath, ['-e',
      'fetch(' + JSON.stringify(url) + ', { method:"POST", headers:{"Content-Type":"application/json"},' +
      ' body: JSON.stringify({ code: ' + JSON.stringify(code) + ' }) })' +
      '.then(r => r.json()).then(j => { console.log(JSON.stringify(j)); process.exit(j && j.ok === false ? 1 : 0); })' +
      '.catch(e => { console.error("绑定请求失败: " + e.message); process.exit(1); });'
    ], { encoding: 'utf8', stdio: 'inherit' });
    if (r.status) writeFallbackHint();
    return r.status || 0;
  }
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c));
module.exports = { readCreds, main };
