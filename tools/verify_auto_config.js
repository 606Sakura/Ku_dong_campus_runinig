// 自动配置自检：不依赖微信、不联网、不读真实包。
// 覆盖两件事：V1MMWX 解包（自造最小包往返）与 app-service.js 的提取规则。
'use strict';
const path = require('path');
const crypto = require('crypto');
const { unpackV1mmwx, extractConfig } = require('./auto-config.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

// ---------- A. 解包往返 ----------
// 按 docs/api-map.md 的格式反向构造一个只含 app-service.js 的包。
console.log('[A] V1MMWX 解包往返');
function buildPackage(appid, files) {
  // inner：21 字节头 + 记录表 + 数据区
  const names = Object.keys(files);
  const header = Buffer.alloc(0x15);
  header[0] = 0xBE;
  let tableLen = 0;
  for (const n of names) tableLen += 1 + n.length + 1 + 10;
  let dataOff = 0x15 + tableLen;
  const records = [], datas = [];
  for (const n of names) {
    const data = Buffer.from(files[n], 'utf8');
    const rec = Buffer.alloc(1 + n.length + 1 + 10);
    rec[0] = n.length;
    rec.write(n, 1, 'utf8');
    const f = 1 + n.length + 1;
    rec[f] = dataOff >> 16; rec[f + 1] = (dataOff >> 8) & 0xff; rec[f + 2] = dataOff & 0xff;
    rec[f + 4] = data.length >> 16; rec[f + 5] = (data.length >> 8) & 0xff; rec[f + 6] = data.length & 0xff;
    records.push(rec); datas.push(data);
    dataOff += data.length;
  }
  const inner = Buffer.concat([header, ...records, ...datas]);
  // 反解：先拆出 0x15 之后的全部（dec+rest），再按加密逆过程拼回
  const decLen = 1024;
  const dec = inner.slice(0, decLen);
  const rest = inner.slice(decLen);
  const key = crypto.pbkdf2Sync(appid, 'saltiest', 1000, 32, 'sha1');
  const c = crypto.createCipheriv('aes-256-cbc', key, Buffer.from('the iv: 16 bytes'));
  const encHead = Buffer.concat([c.update(dec), c.final()]);
  const xk = appid.charCodeAt(appid.length - 2);
  const xored = Buffer.alloc(rest.length);
  for (let i = 0; i < rest.length; i++) xored[i] = rest[i] ^ xk;
  return Buffer.concat([Buffer.from('V1MMWX', 'ascii'), encHead, xored]);
}
{
  const appid = 'wx0123456789abcdee';   // 假 AppID：hex 全段但非真实值
  const src = 'console.log(1)';
  const pkg = buildPackage(appid, { 'app-service.js': src, 'page-frame.html': '<html></html>' });
  const out = unpackV1mmwx(pkg, appid);
  ok(out && out['app-service.js'] && out['app-service.js'].toString('utf8') === src, '解包取回 app-service.js 原文');
  ok(out && out['page-frame.html'] !== undefined, '解包取回其他文件');
  ok(unpackV1mmwx(Buffer.from('NOTV1M'), appid) === null, '非 V1MMWX 返回 null');
}

// ---------- B. 提取规则 ----------
console.log('[B] extractConfig');
{
  const src = [
    'var a="https://api.example.edu";',
    'c="".concat(a,"/sunshine"),s="".concat(a,"/schoolServer");',
    'f["sunshine-run"]=t; fetch(u+"/users/profile");',
    'var secret="' + 'a'.repeat(64) + '";',
    'https://github.com/babel/babel',
  ].join('\n');
  const r = extractConfig(src);
  ok(r.baseUrl === 'https://api.example.edu/sunshine', '拼出 baseUrl（主机 + 前缀）', r.baseUrl);
  ok(r.signSecret === 'a'.repeat(64), '取到唯一的 64 位十六进制密钥');
}
{
  const src = 'var a="https://x.example"; c="".concat(a,"/p"); fetch(u+"/users/profile");' +
    ' var s1="' + 'b'.repeat(64) + '", s2="' + 'c'.repeat(64) + '";';
  const r = extractConfig(src);
  ok(r.signSecret === null, '两个候选密钥 → 不猜，返回 null');
  ok(r.baseUrl === 'https://x.example/p', '密钥有歧义时 baseUrl 仍可提取');
}
{
  ok(extractConfig('var a="https://nothing.example"; just text').baseUrl === null, '没有接口路径 → baseUrl 为 null');
  const r = extractConfig('fetch("/users/profile")');
  ok(r.baseUrl === null && r.signSecret === null, '空源码 → 两项都为 null');
}
{
  // 前缀可能缺失：主机后直接就是接口路径
  const src = 'var a="https://bare.example"; fetch(a+"/users/profile"); var s="' + 'd'.repeat(64) + '";';
  ok(extractConfig(src).baseUrl === 'https://bare.example', '无前缀时只取主机');
}

console.log(`\n自动配置：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
