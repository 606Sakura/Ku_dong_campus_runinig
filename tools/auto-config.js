// 自动配置：从微信小程序包里取出 baseUrl 与 signSecret，写进 config.local.json。
// 只用 Node 内置模块。绝不把密钥打印到终端或日志里。
//
// 用法：
//   node tools/auto-config.js           已有完整配置则跳过
//   node tools/auto-config.js --force   重新检测并覆盖 baseUrl / signSecret
//   node tools/auto-config.js --dry     只报告找到了什么，不写文件
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const LOCAL = path.join(ROOT, 'config.local.json');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

// ---------- V1MMWX 解包（微信 4 / xwechat）----------
// 格式来源：docs/api-map.md「小程序包解包」。整包解到内存，不落盘 —— 包里含密钥。
function unpackV1mmwx(raw, appid) {
  if (raw.slice(0, 6).toString('ascii') !== 'V1MMWX') return null;
  const key = crypto.pbkdf2Sync(appid, 'saltiest', 1000, 32, 'sha1');
  const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from('the iv: 16 bytes'));
  const dec = Buffer.concat([d.update(raw.slice(6, 6 + 1024)), d.final()]);
  const xk = appid.charCodeAt(appid.length - 2);
  const rest = Buffer.alloc(Math.max(0, raw.length - (6 + 1024)));
  for (let i = 0; i < rest.length; i++) rest[i] = raw[6 + 1024 + i] ^ xk;
  const inner = Buffer.concat([dec, rest]);

  // 文件表：@0x15 起，记录 = u8 路径长 + 路径 + NUL + u24 off + u8 pad + u24 size + u8 pad + u16 0
  const files = {};
  let p = 0x15;
  for (;;) {
    const len = inner[p];
    if (len < 3 || len > 200) break;
    let valid = true;
    for (let c = 1; c <= len; c++) {
      const ch = inner[p + c];
      if (ch < 0x20 || ch > 0x7e) { valid = false; break; }
    }
    if (!valid || inner[p + 1 + len] !== 0) break;
    const name = inner.slice(p + 1, p + 1 + len).toString('utf8').replace(/^\//, '');
    const f = p + 2 + len;
    const off = (inner[f] << 16) | (inner[f + 1] << 8) | inner[f + 2];
    const size = (inner[f + 4] << 16) | (inner[f + 5] << 8) | inner[f + 6];
    if (off + size > inner.length) break;
    files[name] = inner.slice(off, off + size);
    p = f + 10;
  }
  return files;
}

// ---------- 定位微信的小程序包 ----------
// 新版（WeChat 4 / xwechat）与旧版路径都看；按修改时间倒序，最新的优先。
function candidatePackages() {
  const bases = [
    path.join(process.env.APPDATA || '', 'Tencent', 'xwechat', 'radium', 'users'),
    path.join(process.env.APPDATA || '', 'Tencent', 'WeChat', 'radium', 'users'),
    path.join(os.homedir(), 'Documents', 'WeChat Files', 'Applet'),
  ].filter((p) => p && fs.existsSync(p));

  const out = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (e.name !== '__APP__.wxapkg' && !/^\d+\.wxapkg$/.test(e.name)) continue;
      // appid：新版 .../packages/<appid>/<ver>/__APP__.wxapkg，旧版 .../Applet/<appid>/<ver>.wxapkg
      const appid = /^wx[0-9a-f]{16}$/.test(path.basename(path.dirname(full)))
        ? path.basename(path.dirname(full))
        : path.basename(path.dirname(path.dirname(full)));
      if (!/^wx[0-9a-f]{16}$/.test(appid) && !/^wx[0-9a-f]{6,}$/.test(appid)) continue;
      try { out.push({ file: full, appid, mtime: fs.statSync(full).mtimeMs }); } catch {}
    }
  };
  for (const b of bases) walk(b, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------- 从 app-service.js 里取配置 ----------
// 返回 { baseUrl, signSecret } —— 调用方负责决定是否落盘。
function extractConfig(source) {
  const hosts = [...new Set(source.match(/https?:\/\/[a-z0-9.-]+/gi) || [])]
    .filter((h) => !/github|gnu\.org|mozilla|w3\.org|npmjs|w3schools/i.test(h));
  // API 主机：附近出现接口路径的那一个。取不到就放弃，不猜。
  let apiHost = null, tail = '';
  for (const h of hosts) {
    let i = -1;
    while ((i = source.indexOf(h, i + 1)) !== -1) {
      const around = source.slice(i, i + 220);
      if (/\/users\/profile|sunshine-run|run-rules|\/runs/.test(around)) { apiHost = h; tail = source.slice(i + h.length, i + h.length + 60); break; }
    }
    if (apiHost) break;
  }
  if (!apiHost) return { baseUrl: null, signSecret: null };

  // 路径前缀：主机紧跟着的第一个 concat(a,"/<前缀>")。
  // 源码里形如 `a="https://…",c="".concat(a,"/sunshine"),s="".concat(a,"/schoolServer"),`
  // —— 取第一个匹配；没有就是裸主机。
  const m = /concat\(\w+\s*,\s*["'](\/[a-zA-Z0-9_-]+)["']\s*\)/.exec(tail);
  const prefix = m ? m[1] : '';
  const baseUrl = apiHost + prefix;

  // 密钥：全包唯一的 64 位十六进制常量。多于一个就不猜。
  const hexes = [...new Set(source.match(/\b[0-9a-f]{64}\b/gi) || [])];
  const signSecret = hexes.length === 1 ? hexes[0] : null;

  return { baseUrl, signSecret };
}

function loadLocal() {
  try { return JSON.parse(fs.readFileSync(LOCAL, 'utf8').replace(/^﻿/, '')); }
  catch { return {}; }
}

function writeLocal(next) {
  const merged = { ...loadLocal(), ...next };
  fs.writeFileSync(LOCAL, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

function main() {
  const cur = loadLocal();
  const complete = Boolean(cur.baseUrl && cur.signSecret);
  if (complete && !has('--force')) {
    console.log('[auto-config] config.local.json 已有 baseUrl 与 signSecret，跳过（要重新检测加 --force）。');
    return 0;
  }

  const packs = candidatePackages();
  if (!packs.length) {
    console.error('[auto-config] 没找到微信小程序包。请先登录电脑微信并打开校园跑小程序，再重试。');
    return 2;
  }

  let scanned = 0;
  for (const p of packs) {
    let files;
    try { files = unpackV1mmwx(fs.readFileSync(p.file), p.appid); }
    catch { continue; }   // 解包失败（版本格式变了）就换下一个，不中断
    const source = files && files['app-service.js'];
    if (!source) continue;
    scanned++;
    const { baseUrl, signSecret } = extractConfig(source.toString('utf8'));
    if (!baseUrl || !signSecret) continue;

    console.log(`[auto-config] 命中小程序包：appid ${p.appid}`);
    console.log(`[auto-config] baseUrl    = ${baseUrl}`);
    console.log(`[auto-config] signSecret = ${signSecret.slice(0, 4)}…（共 ${signSecret.length} 字符，不完整打印）`);
    if (has('--dry')) { console.log('[auto-config] --dry：未写入。'); return 0; }
    writeLocal({ baseUrl, signSecret });
    console.log('[auto-config] 已写入 config.local.json。重启 启动.cmd 生效。');
    return 0;
  }

  console.error(`[auto-config] 扫了 ${packs.length} 个包（成功解包 ${scanned} 个），没提取到完整配置。`);
  console.error('[auto-config] 手动方式：把 baseUrl 与 signSecret 填进 config.local.json，见 docs/接入新学校.md。');
  return 1;
}

if (require.main === module) process.exit(main());
module.exports = { unpackV1mmwx, candidatePackages, extractConfig };
