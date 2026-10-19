// 敏感信息自检：扫 git 跟踪文件，防止真实学号/平台地址/密钥误入公开仓库。
// 用法：node tools/check-secrets.js        —— 命中即非零退出
// 前提：在 git 仓库内运行（用 git ls-files 取文件清单）；不在仓库内时退化为扫当前目录。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// 每条规则：{ name, re, allow }。allow 是允许出现的示例值/占位符。
const RULES = [
  { name: '13 位学号', re: /\b(19|20)\d{11}\b/g },
  { name: '中国大陆手机号', re: /\b1[3-9]\d{9}\b/g },
  { name: '疑似收款账号标识', re: new RegExp('LG' + '-GZ[0-9]{3,}', 'g') },
  { name: '硬编码长十六进制密钥', re: /\b[0-9a-f]{64}\b/gi },
  // 小程序 AppID：wx + 16 位 hex，能唯一定位到具体小程序
  { name: '小程序 AppID', re: new RegExp('(?<![0-9a-z])wx[0-9a-f]{16}(?![0-9a-z])', 'gi') },
  // 同一行出现一对高精度经纬度 = 泄露具体校园位置
  { name: 'GPS 经纬度对', re: /[1-5][0-9][.][0-9]{5,}[^0-9]{0,12}1[0-3][0-9][.][0-9]{5,}/g },
  // 注意：正则字面量里反斜杠写两个。早先写成四个，导致该规则永不命中。
  { name: '本地绝对路径（盘符开头）', re: new RegExp('[A-Za-z]:' + '\\\\', 'g') },
  // 非白名单域名：防止把真实平台地址写进被跟踪文件
  {
    name: '非白名单域名',
    re: /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi,
    allowHit: (h) => /^(?:127\.0\.0\.1|localhost|mock\.local|nodejs\.org|github\.com|raw\.githubusercontent\.com|www\.w3\.org|schema\.org)$/i.test(h)
      || /\.example(?:\.|$)/i.test(h),
  },
];

// 这些值在测试与文档里是刻意保留的假样本。
const ALLOW = [
  '2000000000000',            // mock 平台的占位学号
  '11111111-2222-3333-4444-555555555555',
  'mock-secret-for-local-test-only',
  'wx0123456789abcdee',       // 解包测试用的假 AppID
];

const TEXT_EXT = new Set(['.js', '.json', '.md', '.html', '.cmd', '.ps1', '.yml', '.yaml', '.txt', '']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'output']);

// 已跟踪 + 未跟踪但未被 ignore 的文件。只看已跟踪会漏掉"正准备 git add 的那个文件"，
// 而那恰恰是这条防线要拦的东西。
function listFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0').filter(Boolean);
  } catch {
    const out = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); continue; }
        out.push(path.relative(ROOT, path.join(dir, e.name)));
      }
    })(ROOT);
    return out;
  }
}

const mask = (s) => s.replace(/[0-9a-f]/gi, (c, i) => (i < 3 || i > s.length - 4 ? c : '*'));

const findings = [];
for (const rel of listFiles()) {
  if (!TEXT_EXT.has(path.extname(rel))) continue;
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  for (const rule of RULES) {
    lines.forEach((line, idx) => {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const hit = m[0];
        if (rule.allowHit && rule.allowHit(m[1])) continue;
        if (ALLOW.some((a) => hit.includes(a) || a.includes(hit))) continue;
        findings.push({ rel, line: idx + 1, rule: rule.name, hit: mask(hit) });
      }
    });
  }
}

if (!findings.length) {
  console.log(`[check-secrets] 通过：${listFiles().length} 个文件未命中敏感模式`);
  process.exit(0);
}

console.error(`[check-secrets] 命中 ${findings.length} 处，禁止提交：\n`);
for (const f of findings) console.error(`  ${f.rel}:${f.line}  ${f.rule}  ${f.hit}`);
console.error('\n真实值请移到 config.local.json（已被 .gitignore 排除），或替换为占位符。');
process.exit(1);
