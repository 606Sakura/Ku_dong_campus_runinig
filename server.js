// 校园跑自托管 · 单文件服务器（Node，零依赖）
// Phase 3: /bind 解析绑定码并验证凭据；Phase 4: /run 提交代跑
// Phase 5: 多账号 state + confirmToken 守卫 + 预约调度器 + 平台记录拉取
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { haversineM, trackStepSec, generateTrack, syntheticRing } = require('./track-core');
const { verifyCheckpoints, guardTrack, applyJitter } = require('./run-guard');
const bindWizard = require('./bind-wizard');
const PKG = readJsonQuiet(path.join(__dirname, 'package.json')) || {};

// ---------- 运行环境闸门 ----------
// 全局 fetch 与 AbortSignal.timeout 需要 Node >= 18；更低版本会在第一次请求时才炸，
// 那时用户只看到「平台返回异常」，排查成本远高于启动即退出。
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  console.error(`[启动失败] 需要 Node.js >= 18，当前为 ${process.version}。`);
  console.error('下载地址：https://nodejs.org/ （选 LTS 版本）');
  process.exit(1);
}

// ---------- 配置 ----------
// 优先级：环境变量 > config.local.json > config.example.json > 内置默认。
// config.local.json 存放真实平台地址与密钥，已在 .gitignore 中，绝不入库。
function readJsonQuiet(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
  catch { return null; }
}
const CONFIG_DIR = __dirname;
// 首次运行：分发目录带一份 config.seed.json（不入库），没有 config.local.json 时复制成它。
// 只在目标不存在时创建 —— 用户改过的配置绝不能被 seed 覆盖。
function seedConfigIfMissing() {
  const local = path.join(CONFIG_DIR, 'config.local.json');
  const seed = path.join(CONFIG_DIR, 'config.seed.json');
  try {
    if (fs.existsSync(local) || !fs.existsSync(seed)) return;
    fs.copyFileSync(seed, local);
    console.log('[config] 已从 config.seed.json 生成 config.local.json');
  } catch (e) {
    console.error('[config] config.seed.json 复制失败，按演示模式继续：' + e.message);
  }
}
seedConfigIfMissing();
const FILE_CFG = readJsonQuiet(path.join(CONFIG_DIR, 'config.local.json'))
  || readJsonQuiet(path.join(CONFIG_DIR, 'config.example.json'))
  || {};
const pick = (envVal, fileVal, dflt) => (envVal !== undefined && envVal !== '' ? envVal : (fileVal !== undefined && fileVal !== null && fileVal !== '' ? fileVal : dflt));

const PORT = Number(pick(process.env.PORT, FILE_CFG.port, 8787));
const HOST = pick(process.env.HOST, FILE_CFG.host, '127.0.0.1');   // 只绑本机：这个服务持有真实 token，不该对局域网开放
const BASE_CFG = String(pick(process.env.KD_BASE, FILE_CFG.baseUrl, '')).trim();
const SIGN_SECRET_CFG = String(pick(process.env.KD_SIGN_SECRET, FILE_CFG.signSecret, '')).trim();
// 校内坐标兜底：浏览器定位被拒或不可用时，用它取附近路线（不下发密钥，见 GET /config）
const SCHOOL_LAT = Number(pick(process.env.KD_SCHOOL_LAT, FILE_CFG.schoolLat, 0)) || null;
const SCHOOL_LNG = Number(pick(process.env.KD_SCHOOL_LNG, FILE_CFG.schoolLng, 0)) || null;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF';
// KD_STATE_FILE 可覆盖：验收脚本必须跑在临时副本上，否则会覆盖真实账号的 state.json
const STATE_FILE = path.resolve(pick(process.env.KD_STATE_FILE, FILE_CFG.stateFile, path.join(__dirname, 'state.json')));
const STATE_BAK = STATE_FILE.replace(/.json$/, '') + '.bak.json';
const SCHEMA_VERSION = 2;
// 远端版本号：只用来在页头提示"有新版"，绝不做自动更新 —— 那等于在用户机器上执行下载的二进制。
// 失败静默：离线用户不该因为查不到版本就启动不了。
let LATEST_VERSION = null;
function startVersionCheck() {
  // 只在 package.json 显式配了 upstream 时才查。fork/自建仓库没有这个字段 → 本机不联网。
  const owner = PKG.upstream && PKG.upstream.owner;
  const repo = PKG.upstream && PKG.upstream.repo;
  if (!owner || !repo || /^TODO/.test(String(owner))) return;
  const url = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/main/package.json';
  fetch(url, { signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && j.version) LATEST_VERSION = String(j.version); })
    .catch(() => { /* 离线 / 仓库改名：静默 */ });
}
const TOKEN_TTL_MS = 5 * 60 * 1000;   // confirmToken 有效期 5 分钟

// 演示模式：没有配置平台地址时不报错，而是内嵌拉起本地 mock 平台，
// 让新同学 clone 后零配置就能看到完整流程。数据只落在内存与本地 state.json。
const DEMO_MODE = !BASE_CFG;
const DEMO_PORT = Number(pick(process.env.KD_DEMO_PORT, FILE_CFG.demoPort, 8788));
const DEMO_SIGN_SECRET = 'mock-secret-for-local-test-only';
if (!DEMO_MODE && !SIGN_SECRET_CFG) {
  console.error('[启动失败] 已配置 baseUrl 但缺少 signSecret。');
  console.error('签名密钥在校园跑小程序的客户端代码里，填写方式见 docs/接入新学校.md。');
  process.exit(1);
}
const BASE = DEMO_MODE ? `http://127.0.0.1:${DEMO_PORT}` : BASE_CFG;
const SIGN_SECRET = DEMO_MODE ? DEMO_SIGN_SECRET : SIGN_SECRET_CFG;
// 轨迹拟真参数（可选）。缺省用 track-core 的默认档。
// 只放「硬件与物理世界需要标定」的量：不同手机 GPS 精度不同，不同操场半径也不同。
const TRACK_OPTIONS = FILE_CFG.track && typeof FILE_CFG.track === 'object' ? { realism: FILE_CFG.track } : undefined;
// 真实计时：start 之后等满 durationSec 再发 finish。
// 平台用会话真实墙钟对账上报名义 duration，偏差大会判无效（参考实现 v29+ 实测 >10s 即 status:2）。
// 余量取 4s：实测服务端计时起点比客户端晚约 2s，再留 2s 网络往返。
const SUBMIT_MARGIN_MS = Number(pick(process.env.KD_SUBMIT_MARGIN_MS, FILE_CFG.submitMarginMs, 4000));
const SESSION_MAX_GRACE_MS = 60 * 1000;      // 到点后最多补提交多久，超过就撤销会话
const SCHEDULER_TICK_MS = Number(pick(process.env.KD_TICK_MS, FILE_CFG.tickMs, 5000));
// 提交时对申报值做小幅浮动，消除「每次数字一模一样」的机器特征；config.track.jitter=false 可关
const JITTER_ENABLED = !(FILE_CFG.track && FILE_CFG.track.jitter === false);
// 仅验收/演示：把"等多久"压缩，不改上报值。生产恒为 1。
const TIME_SCALE = (() => {
  const v = Number(process.env.KD_TIME_SCALE);
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

// 绑定失败时把平台原始响应翻译成一句用户能懂的话；原文仍放在 detail 里供排查。
function bindFailureMessage(r) {
  if (r.status === 0) return '无法连接校园平台，请检查网络';
  if (r.json && r.json.code !== undefined && r.json.code !== 200 && r.json.code !== 0) {
    const c = String(r.json.code);
    const msg = String(r.json.message || r.json.msg || '');
    if (/401|403|token|login|登录|失效/i.test(c + ' ' + msg)) return '绑定码已失效，请回到小程序首页重新取码';
    if (/404|school|未开通|不存在/i.test(c + ' ' + msg)) return '该账号未开通校园跑，或学校暂不支持';
    if (/50d/.test(c) || r.status >= 500) return '校园平台暂时不可用，请稍后再试';
  }
  if (r.status >= 500) return '校园平台暂时不可用，请稍后再试';
  return '平台返回异常';
}

// 多校登记表：文件不存在就跳过（单校场景不需要它）；存在但写坏了要当场说清楚，
// 否则用户会以为"加了一所新学校"，而程序从来没读过。
function loadSchoolRegistry() {
  const p = path.join(__dirname, process.env.AC_SCHOOLS_FILE || 'schools.json');
  if (!fs.existsSync(p)) return null;
  try {
    const list = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
    const schools = Array.isArray(list.schools) ? list.schools : [];
    return { path: p, schools };
  } catch (e) {
    console.error(`[schools] ${p} 解析失败：${e.message}（忽略该文件，按单校继续）`);
    return null;
  }
}

// ---------- state（多账号 + 自动迁移）----------
// 新结构：{ schemaVersion:2, active, accounts:{ [studentId]: {user,creds,runs,schedules,boundAt} }, tokens:{} }
// runs 与 schedules 都下沉到账号内：顶层放会串号（maxDailyRuns 判据要按账号数当天条数）。
function emptyState() { return { schemaVersion: SCHEMA_VERSION, active: null, accounts: {}, tokens: {} }; }

function backupOnce(rawText) {
  if (!rawText) return;
  try { if (fs.existsSync(STATE_BAK)) return; fs.writeFileSync(STATE_BAK, rawText); }
  catch (e) { console.error('[backup]', e.message); }
}

// 纯函数：旧扁平 {user,creds,runs} → 新结构。不碰磁盘，可单测。
function migrateState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState();
  if (raw.schemaVersion === SCHEMA_VERSION && raw.accounts && typeof raw.accounts === 'object') {
    raw.tokens = raw.tokens || {};
    // session 是后加的：老文件没有这个键，统一补 null，读取方不必处处判 undefined
    for (const id of Object.keys(raw.accounts)) {
      if (raw.accounts[id] && raw.accounts[id].session === undefined) raw.accounts[id].session = null;
    }
    return raw;
  }
  if (raw.creds && raw.creds.t && raw.user) {
    const id = String(raw.user.studentId || raw.user.id);
    return {
      schemaVersion: SCHEMA_VERSION,
      active: id,
      accounts: { [id]: { user: raw.user, creds: raw.creds, runs: raw.runs || [], schedules: [], boundAt: new Date().toISOString() } },
      tokens: {},
    };
  }
  return emptyState();
}

function loadState() {
  let rawText = null, raw = null;
  try {
    rawText = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (e) {
    // 文件不存在是正常首启；其他读取错误必须暴露出来，不能当成"未绑定"。
    if (e.code === 'ENOENT') return emptyState();
    console.error(`[state] 读取 ${STATE_FILE} 失败（${e.code || e.message}），本次按空库处理，原文件未改动。`);
    return emptyState();
  }
  try {
    raw = JSON.parse(rawText.replace(/^﻿/, ''));
  } catch (e) {
    // 半截写入 / 手改坏一个逗号：先备份再返回空库，否则下次 /bind 会直接覆盖掉历史记录。
    const bak = `${STATE_FILE}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(STATE_FILE, bak); } catch { /* 备份失败也让服务继续起 */ }
    console.error(`[state] ${STATE_FILE} 不是合法 JSON（${e.message}）。`);
    console.error(`[state] 原文件已备份为 ${bak}，本次按空库运行；重新绑定会写入新文件。`);
    return emptyState();
  }
  const migrated = migrateState(raw);
  // 结构变了就落盘，并把原文件留一份备份
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    backupOnce(rawText);
    try { saveState(migrated); } catch (e) { console.error('[migrate]', e.message); }
    console.log('[state] 已从旧扁平结构迁移到 schemaVersion 2，备份见 state.bak.json');
  }
  return migrated;
}

// 原子写：临时文件 + rename。直接覆盖时进程被杀会留下半截 JSON，
// 下次 loadState 静默当成空库 → 凭据全丢且无提示。
// Windows 上 rename 覆盖已存在文件偶发 EPERM，此时回退为直接覆盖写（次优但不丢数据）。
function saveState(s) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  try {
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    fs.copyFileSync(tmp, STATE_FILE);
    fs.unlinkSync(tmp);
  }
}

// 取当前账号；缺省时回退到唯一账号，方便单账号场景
function activeAccount(st) {
  if (!st.accounts) return null;
  const id = st.active;
  if (id && st.accounts[id]) return { id, acc: st.accounts[id] };
  const ids = Object.keys(st.accounts);
  return ids.length === 1 ? { id: ids[0], acc: st.accounts[ids[0]] } : null;
}

// 对外展示用：剔除 creds（真实 token 绝不下发到浏览器）
function publicState(st) {
  const a = activeAccount(st);
  return {
    ok: true,
    schemaVersion: st.schemaVersion,
    active: a ? a.id : null,
    user: a ? a.acc.user : null,
    accounts: Object.keys(st.accounts || {}).map((id) => ({
      studentId: id,
      name: (st.accounts[id].user || {}).name || null,
      schoolName: (st.accounts[id].user || {}).schoolName || null,
    })),
    runs: a ? (a.acc.runs || []) : [],
    schedules: a ? (a.acc.schedules || []) : [],
    session: a ? (a.acc.session || null) : null,
    demo: DEMO_MODE,
  };
}


// ---------- confirmToken（真实提交的两步确认）----------
// 没有这个守卫时，curl 直接打 POST /run 就会真实提交到学校平台。
// 流程：/confirm 按参数摘要签发一次性令牌 → /run 必须带该令牌且参数吻合才真提交。
// 令牌绑定参数摘要，所以「确认 1.2km/600s」不能拿去提交 3km/300s。
// 归一化必须放在这里，而不是调用点：/confirm 可能传 'FREE' 而 /run 传 undefined，
// 两处各自归一化一旦漏一个，令牌就永远对不上，且错误文案是「参数与确认时不一致」——
// 会把人误导去查距离/时长。
function normRunType(v) { return v === 'FREE' ? 'FREE' : 'CAMPUS'; }

function paramDigest(distanceKm, durationSec, plannedAt, runType) {
  return sha256hex(`${normRunType(runType)}|${distanceKm}|${durationSec}|${plannedAt || ''}`);
}

function issueConfirmToken(st, studentId, distanceKm, durationSec, plannedAt, runType) {
  st.tokens = st.tokens || {};
  const token = crypto.randomBytes(16).toString('hex');
  st.tokens[token] = { studentId, digest: paramDigest(distanceKm, durationSec, plannedAt, runType), exp: Date.now() + TOKEN_TTL_MS };
  pruneTokens(st);
  return token;
}

// 一次性：校验通过即删除，防重放
function consumeConfirmToken(st, token, studentId, distanceKm, durationSec, plannedAt, runType) {
  const t = st.tokens && st.tokens[token];
  if (!t) return '确认令牌不存在或已被使用';
  if (Date.now() > t.exp) { delete st.tokens[token]; return '确认令牌已过期（有效期 5 分钟）'; }
  if (t.studentId !== studentId) return '确认令牌与当前账号不符';
  if (t.digest !== paramDigest(distanceKm, durationSec, plannedAt, runType)) return '参数与确认时不一致，请重新确认';
  delete st.tokens[token];
  return null;   // null = 通过
}

function pruneTokens(st) {
  const now = Date.now();
  for (const k of Object.keys(st.tokens || {})) if (st.tokens[k].exp < now) delete st.tokens[k];
}

// ---------- 进程内串行队列 ----------
// /run、调度器、/schedule 都会「读-改-写」state.json。两处并发时后写覆盖先写。
// ponytail: 单进程内串行够用；多进程部署需要文件锁。
let chain = Promise.resolve();
function withState(fn) {
  const p = chain.then(fn, fn);
  chain = p.then(() => {}, () => {});
  return p;
}

// ---------- 开跑窗口推算（纯函数，可单测）----------
// 平台只在 runUnavailableReason 里给窗口原文（形如「仅允许在09:00~09:30开始跑步」），
// 没有结构化字段。所以从原文抠 —— 抠不到就返回 null，绝不硬编码 09:00：窗口可能随星期/时段变化。
function parseWindow(text) {
  const m = /([0-9]{1,2}):([0-9]{2})[^0-9]{0,6}([0-9]{1,2}):([0-9]{2})/.exec(String(text || ''));
  if (!m) return null;
  const sh = +m[1], sm = +m[2], eh = +m[3], em = +m[4];
  if (sh > 23 || sm > 59 || eh > 23 || em > 59) return null;
  return { startMin: sh * 60 + sm, endMin: eh * 60 + em };
}

// 下一个开跑时刻（毫秒）。jitterMs 让每次落点错开，避免整点秒提交。
// 返回 null = 窗口原文解析不出来，调用方必须走「明确报错」而不是猜一个时间。
function nextWindowStart(reason, nowMs, jitterMs) {
  const w = parseWindow(reason);
  if (!w) return null;
  const now = nowMs === undefined ? Date.now() : nowMs;
  const jit = jitterMs === undefined ? (1 + Math.floor(Math.random() * 3)) * 60 * 1000 : jitterMs;
  const bj = new Date(now + 8 * 3600e3);          // 北京时间视角
  const cur = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const midnight = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  // 窗口内（含窗口起点后）→ 今天就开；否则下一个窗口起点
  let target = midnight + w.startMin * 60000;
  if (cur > w.startMin && cur <= w.endMin) target = midnight + cur * 60000;
  else if (cur > w.endMin) target = midnight + 24 * 3600e3 + w.startMin * 60000;
  const local = target - 8 * 3600e3;
  return local > now ? local + jit : local;
}

// 默认跑量：距离按性别（平台在 /run-rules/current 里给 sex，档案里没有性别字段），
// 时长从「配速区间中值」推，再夹进平台上下限 —— 硬编码 840s 在 maxDuration=600 的学校会直接不合规。
function defaultRunParams(rules, prev) {
  const r = rules || {};
  const sex = String(r.sex == null ? '' : r.sex);
  let distanceKm = sex === '1' ? 2.0 : (sex === '2' ? 1.5 : 2.0);
  if (typeof r.minDistance === 'number') distanceKm = Math.max(distanceKm, r.minDistance);
  const targetPace = (typeof r.minPace === 'number' && typeof r.maxPace === 'number')
    ? (r.minPace + r.maxPace) / 2 : 390;
  let durationSec = Math.round(distanceKm * targetPace);
  const lo = Math.max(
    typeof r.minDuration === 'number' ? r.minDuration : 0,
    typeof r.minPace === 'number' ? Math.ceil(distanceKm * r.minPace) : 0);
  const hi = Math.min(
    typeof r.maxDuration === 'number' ? r.maxDuration : Infinity,
    typeof r.maxPace === 'number' ? Math.floor(distanceKm * r.maxPace) : Infinity);
  if (Number.isFinite(hi) && hi >= lo) durationSec = Math.min(Math.max(durationSec, lo), hi);
  else if (Number.isFinite(hi)) durationSec = hi;
  else if (Number.isFinite(lo)) durationSec = Math.max(durationSec, lo);
  // prev：同一条路线同一天复用上一次的值，避免每次刷新都跳数（按路线+日期复用）
  if (prev && Number.isFinite(prev.distanceKm) && Number.isFinite(prev.durationSec)) {
    return { distanceKm: prev.distanceKm, durationSec: prev.durationSec, sex: sex || null, derived: true };
  }
  return { distanceKm: +distanceKm.toFixed(2), durationSec, sex: sex || null, derived: true };
}

// 局域网地址：替代原来那张「手机打开本页」卡片
function lanAddresses(port) {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, url: 'http://' + a.address + ':' + port + '/' });
    }
  }
  return out;
}

// ---------- 平台交互 ----------
function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function hmacSha256hex(key, s) { return crypto.createHmac('sha256', key).update(s, 'utf8').digest('hex'); }

// 三个 POST（/runs、/runs/sessions/start、/runs/sessions/{id}/finish）需要签名
function needsSign(method, p) {
  return method === 'POST' && (p === '/runs' || p === '/runs/sessions/start' || /^\/runs\/sessions\/[0-9]+\/finish$/.test(p));
}

async function platformReq(creds, method, p, bodyObj) {
  const headers = {
    'sunshine-run': creds.t,
    'sunshine-run-device-id': creds.d || '',
    'sunshine-run-device-fp': creds.f || '',
    'user-agent': UA,
    'content-type': 'application/json',
  };
  let bodyStr = '';
  if (bodyObj !== undefined) {
    bodyStr = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
    headers['content-length'] = Buffer.byteLength(bodyStr);
  }
  if (needsSign(method, p)) {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(16).toString('hex');
    const base = ['v1', method.toUpperCase(), p, ts, nonce, sha256hex(creds.t), sha256hex(creds.d || ''), sha256hex(bodyStr)].join('\n') + '\n';
    headers['sunshine-run-timestamp'] = ts;
    headers['sunshine-run-nonce'] = nonce;
    headers['sunshine-run-sign'] = hmacSha256hex(SIGN_SECRET, base);
  }
  // fetch 超时/网络错误会 throw。不接住的话，dry 模式的"规则查不到就用常量兜底"这段
  // 永远走不到，而且异常会冒泡成 unhandledRejection 打死进程。
  let res;
  try {
    res = await fetch(BASE + p, { method, headers, body: bodyStr || undefined, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { status: 0, json: null, text: `无法连接校园平台：${e.name === 'TimeoutError' ? '请求超时（15s）' : e.message}`, raw: e.message, err: e.message };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// 平台开跑规则校验（/run-rules/current 的 data）。
// 阈值全部原样取自服务端，不本地推算 —— minDuration 与 minPace×distance 可能互不自洽，以平台为准。
// 返回问题列表（空数组 = 可提交）。
function checkRunRules(rules, distanceKm, durationSec, st) {
  const bad = [];
  if (rules.runAvailableNow !== true) {
    bad.push('不在开跑窗口：' + (rules.runUnavailableReason || '平台未说明原因'));
  }
  if (typeof rules.minDistance === 'number' && distanceKm < rules.minDistance) {
    bad.push(`距离 ${distanceKm}km 小于平台下限 ${rules.minDistance}km`);
  }
  if (typeof rules.minDuration === 'number' && durationSec < rules.minDuration) {
    bad.push(`时长 ${durationSec}s 低于平台下限 ${rules.minDuration}s`);
  }
  if (typeof rules.maxDuration === 'number' && durationSec > rules.maxDuration) {
    bad.push(`时长 ${durationSec}s 超过平台上限 ${rules.maxDuration}s`);
  }
  const pace = durationSec / distanceKm; // s/km
  if (typeof rules.minPace === 'number' && pace < rules.minPace) {
    bad.push(`配速 ${Math.round(pace)}s/km 快于平台最快 ${rules.minPace}s/km`);
  }
  if (typeof rules.maxPace === 'number' && pace > rules.maxPace) {
    bad.push(`配速 ${Math.round(pace)}s/km 慢于平台最慢 ${rules.maxPace}s/km`);
  }
  // ponytail: maxDailyRuns=0 当作「未配置=不限」处理；若平台实为「0 次」，把条件改成 >= 0 即可
  if (rules.maxDailyRuns > 0) {
    const day = (iso) => new Date(new Date(iso).getTime() + 288e5).toISOString().slice(0, 10); // UTC+8 日期
    const today = day(new Date().toISOString());
    const n = (st.runs || []).filter((r) => r.at && day(r.at) === today).length;
    if (n >= rules.maxDailyRuns) bad.push(`今日已提交 ${n} 次，达到平台上限 ${rules.maxDailyRuns} 次`);
  }
  return bad;
}

// ---------- 跑步执行（/run 与调度器共用）----------
// 组装 start/finish body。route = 账号选中的路线 {routeId, checkpoints}，CAMPUS 必传。
// 纯计算，不触网，可直接用于 dry 预览。
function buildRunBodies(distanceKm, durationSec, nowMs, runType, route, trackOptions, startedAtMs) {
  const free = normRunType(runType) === 'FREE';
  // 自由跑没有会话，也就没有 start body
  let startBody = null, checkpoints = free ? syntheticRing() : null;
  if (!free) {
    if (!route || !Array.isArray(route.checkpoints) || route.checkpoints.length < 4) {
      throw new Error('未选择路线或路线缺打卡点：请先获取附近路线并选择');
    }
    checkpoints = route.checkpoints;
  }
  // 取整后再生成轨迹：轨迹按未取整的 distanceKm 造、提交时取 2 位小数，两者会差最多 5m
  const dist2 = +Number(distanceKm).toFixed(2);
  const now = new Date(nowMs === undefined ? Date.now() : nowMs);
  // startedAtMs：真实计时模式下是会话 start 的墙钟；缺省退回"从 now 往前回溯"（干跑预览与 FREE 用）
  const startAt = startedAtMs !== undefined && startedAtMs !== null
    ? new Date(startedAtMs)
    : new Date(now.getTime() - durationSec * 1000);
  // 轨迹时间戳必须落在申报窗口 [startAt, now] 内 —— 否则末点比申报 endTime 晚一整个 durationSec，一比对就露馅
  const track = generateTrack(dist2 * 1000, durationSec, startAt.getTime(), checkpoints, trackOptions);
  const points = track.points;
  // 起点必须与轨迹首点同源：「我在哪按下开始」是一次物理事件、一个位置。
  // 早先两边各自随机，实测相差 13m —— 服务端若校验「首点应接近申报起点」就是现成的矛盾。
  if (!free) {
    startBody = {
      runType: 'CAMPUS', routeId: route.routeId,
      startLatitude: points[0].latitude,
      startLongitude: points[0].longitude,
    };
  }
  const fmt = (d) => new Date(d.getTime() + 288e5).toISOString().slice(0, 19); // UTC+8 "YYYY-MM-DDTHH:MM:SS"
  // 配速：秒数取整后可能进位成 60，须归一化，否则产出 "3'60""
  const spk = durationSec / dist2;
  const paceMin = Math.floor(spk / 60), paceSec = Math.round(spk % 60);
  const paceStr = paceSec === 60 ? `${paceMin + 1}'00"` : `${paceMin}'${String(paceSec).padStart(2, '0')}"`;
  const finishBody = {
    distance: dist2,
    duration: durationSec,
    pace: paceStr,
    calories: Math.floor(60 * dist2),
    startTime: fmt(startAt),
    endTime: fmt(now),
    routeData: points,
  };
  // 只在 FREE 时加字段：CAMPUS 的 body 字节保持不变，签名基串才不会被动到
  if (free) finishBody.runType = 'FREE';
  return { startBody, finishBody, track, dist2, startAt: startAt.getTime(), runType: normRunType(runType) };
}

// 网络错误（status 0：超时/连不上）与 5xx 可重试；平台明确拒绝（业务错误）重试只会多刷无效记录。
function isRetriable(r) {
  if (!r) return false;
  return r.status === 0 || r.status >= 500;
}

// ---------- 真实计时：会话两段式 ----------
// startSession 只建会话并把起点交给平台；finishSession 到点后才生成完整轨迹并提交。
// 为什么必须拆：平台按会话真实墙钟对账 duration，零等待提交会被判无效。
// 拆开后 state 里要留 session 记录，进程重启才能续跑（见 resumeSessions）。
async function startSession(creds, route, distanceKm, durationSec, runType, trackOptions) {
  const { startBody } = buildRunBodies(distanceKm, durationSec, Date.now(), runType, route, trackOptions);
  const r = await platformReq(creds, 'POST', '/runs/sessions/start', startBody);
  const okCode = r.json && (r.json.code === 200 || r.json.code === 0);
  if (!okCode) return { ok: false, stage: 'start', detail: r.text.slice(0, 400), retriable: isRetriable(r) };
  const sessionId = r.json.data && (r.json.data.sessionId || r.json.data.id);
  if (!sessionId) return { ok: false, stage: 'start', detail: '未返回 sessionId: ' + r.text.slice(0, 400), retriable: false };
  // 平台在 start 响应里回传本次实际校验的打卡点；有就以它为准（比缓存路线更可信）
  const selected = Array.isArray(r.json.data.selectedCheckpoints) && r.json.data.selectedCheckpoints.length
    ? r.json.data.selectedCheckpoints : null;
  return {
    ok: true, stage: 'start', sessionId, selectedCheckpoints: selected,
    route: r.json.data.route || null,
    startLat: startBody.startLatitude, startLng: startBody.startLongitude,
  };
}

// 打卡半径：平台在 start 响应里给 route.checkpointHitRadiusM；缺省 30m（api-map.md）
function checkpointRadius(route) {
  const v = route && Number(route.checkpointHitRadiusM);
  return Number.isFinite(v) && v > 0 ? v : 30;
}

// 到点后提交。startedAt 是会话真实开始时刻，轨迹时间轴与 duration 都从它推。
async function finishSession(creds, session, route, opts) {
  const o = opts || {};
  const nowMs = o.nowMs === undefined ? Date.now() : o.nowMs;
  const checkpoints = (session.selectedCheckpoints && session.selectedCheckpoints.length >= 4)
    ? session.selectedCheckpoints.map((c) => [Number(c.latitude), Number(c.longitude)])
    : route.checkpoints;
  const built = buildRunBodies(
    session.distanceKm, session.durationSec, nowMs, 'CAMPUS',
    Object.assign({}, route, { checkpoints }), o.trackOptions, session.startedAt);
  const { finishBody, track } = built;
  // 提交前本地校验：平台硬阈值 + 打卡点全命中。不合格就不发 finish ——
  // 会话已经建立，发出去被判无效就没有删除接口了。
  const guard = guardTrack(finishBody.routeData);
  const cp = verifyCheckpoints(finishBody.routeData, session.selectedCheckpoints || route.checkpoints,
    { radius: checkpointRadius(route), ordered: (route.passMode || 'ORDERED') !== 'ANY' });
  if (o.strict !== false && (!guard.ok || !cp.ok)) {
    return {
      ok: false, stage: 'guard', retriable: false, track, guard, checkpoints: cp, dist2: built.dist2,
      detail: !guard.ok ? '轨迹本地校验未通过：' + guard.problems.join('；') : cp.reason,
    };
  }
  const r = await platformReq(creds, 'POST', '/runs/sessions/' + session.sessionId + '/finish', finishBody);
  const okCode = r.json && (r.json.code === 200 || r.json.code === 0);
  return {
    ok: okCode, stage: 'finish', runType: 'CAMPUS', sessionId: session.sessionId,
    platformId: (r.json && r.json.data && r.json.data.id != null) ? String(r.json.data.id) : null,
    detail: r.text.slice(0, 500),
    finishJson: (r.json && r.json.data) || null,
    track, guard, checkpoints: cp, dist2: built.dist2,
    retriable: okCode ? false : isRetriable(r),
  };
}

// 撤销会话：超时/本地校验失败时调用，避免平台侧留下半截会话
async function cancelSession(creds, sessionId) {
  try {
    const r = await platformReq(creds, 'POST', '/runs/sessions/' + sessionId + '/cancel');
    return !!(r.json && (r.json.code === 200 || r.json.code === 0));
  } catch { return false; }
}

// 查询平台开跑规则。返回 {rules, degraded, raw}
async function fetchRules(creds) {
  const rr = await platformReq(creds, 'GET', '/run-rules/current');
  const rules = rr.json && rr.json.code === 200 ? rr.json.data : null;
  return { rules, raw: rr };
}

// ---------- 平台响应归一化 ----------
// 为什么放后端：平台契约（fetchRules/checkRunRules/platformReq）本就全在这一侧，
// 前端做兼容读取等于把契约抄成两份，而且验收脚本得开浏览器才验得到字段。
// 纯函数，不触网，可单测。
const numOrNull = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) ? Number(v) : null;

// 有效次数标准可能挂在不同 standardType 上，别硬编码下标 0（app-service.js:1873 就是这么挑的）
const VALID_TYPES = ['RUN_COUNT_VALID', 'RUN_COUNT_2KM', 'RUN_COUNT'];

// 平台 /stats → 展示语义。三态必须分开：
//   取不到（data 缺失）/ 取到了但结构不认识 / 正常。
//   塌成一种就会让页面写不出原因，或者把「字段缺失」显示成「有效 — 次」。
function normalizeStats(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: '平台未返回统计数据（data 为空）' };
  const sem = data.semesterStats || {};
  const list = Array.isArray(data.standards) ? data.standards : [];
  const std = list.find((x) => x && VALID_TYPES.includes(x.standardType)) || list[0] || null;
  const totalDistanceKm = numOrNull(sem.qualifiedDistance) !== null
    ? numOrNull(sem.qualifiedDistance) : numOrNull(sem.totalDistance);
  if (!std && totalDistanceKm === null) {
    return { ok: false, reason: '平台统计缺少 standards 与 semesterStats，结构不认识' };
  }
  return {
    ok: true,
    validCount: numOrNull(std && std.currentValue),
    standardCount: numOrNull(std && std.standardValue),
    totalDistanceKm,
    totalRuns: numOrNull(sem.totalRuns),
    totalAttempts: numOrNull(sem.totalAttempts),
    label: (std && std.label) || null,
    details: (std && std.details) || null,
    isMet: std ? std.isMet === true : null,
    semesterName: data.currentSemesterName || sem.semester || null,
    raw: data,   // 原始响应留着，页面「查看」与排错用
  };
}

// 单条记录 → 统一形状。status 是数字 0/1/2，不是字符串（app-service.js:1882 getStatusLabel）。
// 三态：0=待同步 1=有效 2=无效。原来前端拿 'failed' 做字符串比较，平台记录永远显示「成功」。
const STATUS_TEXT = { 0: 'pending', 1: 'success', 2: 'invalid' };
function normalizeStatus(v) {
  if (typeof v === 'number') return STATUS_TEXT[v] || 'unknown';
  if (v === 'failed') return 'failed';
  if (v === 'success' || v === 'pending' || v === 'invalid') return v;
  return 'unknown';
}

function normalizeRun(r, src) {
  if (!r || typeof r !== 'object') return null;
  return {
    id: r.id != null ? String(r.id) : null,
    sessionId: r.sessionId != null ? String(r.sessionId) : null,
    distanceKm: numOrNull(r.distance),
    durationSec: numOrNull(r.duration),
    pace: r.pace || null,
    calories: numOrNull(r.calories),
    runType: r.runType || (r.sessionId != null || r.routeId != null ? 'CAMPUS' : 'FREE'),
    routeName: r.routeName || null,
    snapshotUrl: r.snapshotUrl || null,
    status: normalizeStatus(r.status),
    invalidReason: r.invalidReason || null,
    at: r.endTime || r.startTime || r.createdAt || r.runDate || r.at || null,
    src,
  };
}

// 真正提交一次。返回 {ok, sessionId, detail, finishJson}
// route：CAMPUS 必传（{routeId, checkpoints}），FREE 可空 —— buildRunBodies 会如实拒绝。
async function executeRun(creds, distanceKm, durationSec, nowMs, runType, route, startedAtMs) {
  const { startBody, finishBody, track } = buildRunBodies(distanceKm, durationSec, nowMs, runType, route, TRACK_OPTIONS, startedAtMs);
  const codeOkEarly = (j) => j && (j.code === 200 || j.code === 0);
  // 自由跑：单发 POST /runs，无会话，平台返回 data.id（api-map.md「FREE 三连」实测）
  if (startBody === null) {
    const r = await platformReq(creds, 'POST', '/runs', finishBody);
    if (!codeOkEarly(r.json)) return { ok: false, stage: 'free', detail: r.text.slice(0, 500), retriable: isRetriable(r) };
    const d = (r.json && r.json.data) || {};
    return {
      ok: true, stage: 'free', runType: 'FREE', sessionId: null,
      platformId: d.id != null ? String(d.id) : null,
      detail: r.text.slice(0, 500), finishJson: d, track,
    };
  }
  const start = await platformReq(creds, 'POST', '/runs/sessions/start', startBody);
  // 成功码：小程序认 200 或 0。server.js 原来只认 200，比客户端窄，会误判成功为失败。
  const codeOk = (j) => j && (j.code === 200 || j.code === 0);
  if (!codeOk(start.json)) {
    // 会话没建起来：没有需要撤销的会话，网络类失败可以安全重试整个动作
    return { ok: false, stage: 'start', detail: start.text.slice(0, 400), retriable: isRetriable(start) };
  }
  const sessionId = start.json.data && (start.json.data.sessionId || start.json.data.id);
  if (!sessionId) return { ok: false, stage: 'start', detail: '未返回 sessionId: ' + start.text.slice(0, 400), retriable: false };
  const finish = await platformReq(creds, 'POST', `/runs/sessions/${sessionId}/finish`, finishBody);
  return {
    ok: codeOk(finish.json), stage: 'finish', runType: 'CAMPUS', sessionId,
    platformId: (finish.json && finish.json.data && finish.json.data.id != null) ? String(finish.json.data.id) : null,
    detail: finish.text.slice(0, 500),
    finishJson: finish.json && finish.json.data || null,
    track,
    retriable: codeOk(finish.json) ? false : isRetriable(finish),
  };
}

// ---------- 跑量参数校验（/run、/preview、/confirm、/schedule 共用）----------
function validateRunParams(opt) {
  const posNum = (v, name, dflt) => {
    if (v === undefined || v === null) return { v: dflt };
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) return { err: `${name} 必须是有限正数，收到 ${JSON.stringify(v)}` };
    return { v: n };
  };
  const dk = posNum(opt.distanceKm, 'distanceKm', 1.2);
  if (dk.err) return { err: dk.err };
  const ds = posNum(opt.durationSec, 'durationSec', Math.round(dk.v * 500));
  if (ds.err) return { err: ds.err };
  const distanceKm = dk.v, durationSec = ds.v;
  if (durationSec > 24 * 3600) return { err: 'durationSec 超过 24 小时' };
  if (distanceKm > 100) return { err: 'distanceKm 超过 100km' };
  // 点数闸门：服务端只收 ≤500 点。用与 generateTrack 同一个公式，避免两处漂移。
  const estPoints = Math.floor(durationSec / trackStepSec(distanceKm * 1000, durationSec)) + 1;
  if (estPoints > 490) {
    return { err: `轨迹将生成约 ${estPoints} 点，接近平台 500 点上限；请缩短时长或加大距离（提高配速）` };
  }
  return { distanceKm, durationSec };
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    if (res.writableEnded) return;
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  // 只绑 loopback 挡不住本机浏览器里的恶意页面盲发 POST。Origin 非本机一律拒绝；
  // 无 Origin 的请求（curl / 命令行）照旧放行 —— 那不是浏览器，不存在跨站。
  const isLocalOrigin = (o) => {
    try {
      const u = new URL(o);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]';
    } catch { return false; }
  };
  const reqOrigin = req.headers.origin;
  if (reqOrigin && !isLocalOrigin(reqOrigin)) {
    return send(403, { ok: false, error: 'forbidden origin' });
  }
  // async 监听器里抛的错不会进外层 try/catch（Node>=15 默认让进程直接退出），
  // 所以每个 async 监听器必须自带兜底。顺带限制请求体大小。
  const onEnd = (fn, tag) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) { req.destroy(); }
    });
    req.on('end', () => {
      Promise.resolve()
        .then(() => fn(body))
        .catch((e) => {
          console.error(`[${tag}]`, e && e.stack || e);
          send(500, { ok: false, error: String(e && e.message || e) });
        });
    });
  };
  // 入参闸门：NaN / Infinity / 字符串 / 数组都能让 NaN 穿透下游比较（NaN<1 恒为 false），
  // 必须在进规则校验前拦掉。
  const posNum = (v, name, dflt) => {
    if (v === undefined || v === null) return { v: dflt };
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) return { err: `${name} 必须是有限正数，收到 ${JSON.stringify(v)}` };
    return { v: n };
  };
  // dry 与真实提交共用的执行体。/run、/preview 与调度器都走这里。
  const doRun = async (studentId, distanceKm, durationSec, dry, plannedAt, runTypeRaw) => {
    const runType = normRunType(runTypeRaw);
    const st = loadState();
    const acc = st.accounts[studentId];
    if (!acc) return send(404, { ok: false, error: `账号 ${studentId} 不存在` });

    // 1. 先查开跑规则（GET 不需签名），窗口/阈值全部以平台实时返回为准
    const { rules, raw: rr } = await fetchRules(acc.creds);
    let effRules = rules, rulesDegraded = false;
    if (!rules) {
      if (!dry) return send(502, { ok: false, error: '开跑规则查询失败', detail: rr.text.slice(0, 300) });
      // ponytail: 兜底常量来自 api-map.md 2026-10-15 实测，仅 dry 预览用，不进正式提交
      effRules = { runAvailableNow: null, minDistance: 1.0, minDuration: 180, maxDuration: 600, minPace: 180, maxPace: 600 };
      rulesDegraded = true;
    }
    // 自由跑与校园跑的校验口径不同：FREE 不查窗口、不限时长配速（api-map.md FREE 三连实测）。
    // 通用入参闸门（validateRunParams）仍然生效，那挡的是畸形输入，不是平台规则。
    const problems = runType === 'FREE' ? [] : checkRunRules(effRules, distanceKm, durationSec, acc);
    // 窗口外不报错：自动排到下一个开跑窗口（+1~3 分钟抖动），落一条 pending 交给调度器。
    // 这是新版的核心简化 —— 用户不必再手动「改用预约」并手填 datetime。
    // 其余不合规（距离/时长/配速/每日上限）仍然拒绝：那些是参数错，排到明天也一样错。
    const windowOnly = problems.length > 0 && problems.every((m) => m.startsWith('不在开跑窗口'));
    if (windowOnly && !dry && runType !== 'FREE') {
      const plannedAt = nextWindowStart(effRules.runUnavailableReason);
      if (plannedAt === null) {
        return send(400, {
          ok: false, error: '不在开跑窗口，且平台未给出可解析的窗口时间',
          problems, rules: effRules,
        });
      }
      const id = 'kd-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
      await withState(() => {
        const s2 = loadState();
        const a2 = s2.accounts[studentId];
        if (a2) {
          a2.schedules.push({
            id, studentId, distanceKm, durationSec, plannedAt,
            status: 'pending', createdAt: Date.now(), attempts: 0, auto: true,
          });
          saveState(s2);
        }
      });
      return send(200, {
        ok: true, scheduled: true, auto: true, jobId: id,
        plannedAt, distanceKm, durationSec, runType: 'CAMPUS',
        reason: effRules.runUnavailableReason || null,
        note: '现在不在开跑窗口，已自动排到 ' + new Date(plannedAt + 8 * 3600e3).toISOString().slice(11, 16) + '（北京时间，含 1~3 分钟随机抖动）。到点由本机服务器自动提交。',
      });
    }
    if (problems.length && !dry) {
      return send(400, { ok: false, error: '不符合平台规则', problems, rules: effRules });
    }

    // CAMPUS 需要选中的路线：无选中且只有 1 条时自动选它；否则如实拒绝
    let route = null;
    if (runType !== 'FREE') {
      const routes = acc.routes || [];
      let sel = routes.find((r) => r.routeId === acc.selectedRouteId);
      if (!sel && routes.length === 1) sel = routes[0];
      if (!sel) return send(400, { ok: false, error: '尚未选择路线：先获取附近路线并选择' });
      route = sel;
    }
    const built = buildRunBodies(distanceKm, durationSec, Date.now(), runType, route, TRACK_OPTIONS);
    const { startBody, finishBody, track, dist2 } = built;
    const points = finishBody.routeData;

    if (dry) {
      return send(200, {
        ok: true, dry: true, studentId, runType,
        rules: effRules, rulesDegraded, problems,
        // 自由跑没有会话，plan 形状不同；页面画轨迹要从 body_finish || body 里取
        plan: startBody === null
          ? { path: '/runs', body: finishBody }
          : { path_start: '/runs/sessions/start', body_start: startBody, path_finish: '/runs/sessions/{sessionId}/finish', body_finish: finishBody },
        trackPoints: points.length,
        // 自报 vs 实测分别列出：只看 declaredM 会掩盖折线收敛的残差
        declaredM: +track.declaredM.toFixed(1),
        walkedM: +track.walkedM.toFixed(1),
        residualPct: +((track.walkedM / track.declaredM - 1) * 100).toFixed(4),
        avgSpeed: +(track.walkedM / durationSec).toFixed(3),
        ringMeters: +track.ringLen.toFixed(1),
        stepSec: +track.stepSec.toFixed(3),
        // 时间口径统一用 UTC+8 无 Z，与 body_finish.startTime/endTime 一致
        trackWindow: {
          first: points.length ? new Date(points[0].timestamp + 288e5).toISOString().slice(0, 19) : null,
          last: points.length ? new Date(points[points.length - 1].timestamp + 288e5).toISOString().slice(0, 19) : null,
        },
        // 提交前本地校验结果：干跑就把它摊给用户看，别等提交后才知道漏了打卡点
        guard: guardTrack(points),
        checkpointHits: verifyCheckpoints(points, runType === 'FREE' ? syntheticRing() : route.checkpoints, {
          radius: runType === 'FREE' ? 30 : checkpointRadius(route),
          ordered: runType === 'FREE' ? false : ((route.passMode || 'ORDERED') !== 'ANY'),
        }),
      });
    }

    // 真实提交
    // 自由跑：单发 POST /runs，没有会话，也没有真实计时（平台对它不查窗口、不计成绩）。
    if (runType === 'FREE') {
      const r = await executeRun(acc.creds, distanceKm, durationSec, Date.now(), 'FREE', route);
      if (r.ok) {
        await withState(() => {
          const s2 = loadState();
          if (s2.accounts[studentId]) {
            s2.accounts[studentId].runs.unshift({
              at: new Date().toISOString(), sessionId: null,
              runType: 'FREE', platformId: r.platformId || null,
              distanceKm: dist2, durationSec, trackPoints: points.length,
              residualPct: +((track.walkedM / track.declaredM - 1) * 100).toFixed(4),
              response: r.finishJson,
            });
            saveState(s2);
          }
        });
        return send(200, {
          ok: true, sessionId: null, platformId: r.platformId || null,
          runType: 'FREE', distanceKm: dist2, durationSec, detail: r.detail,
        });
      }
      return send(502, { ok: false, stage: r.stage, detail: r.detail, retriable: !!r.retriable });
    }

    // 校园跑：建会话 → 落库 → 到点由调度器提交。
    // 申报值小幅浮动（距离 ±0.05km、时长 ±3%），浮动后重新过规则；全不合法就用原值。
    let jit = { distanceKm, durationSec, jittered: false };
    if (JITTER_ENABLED) {
      const j = applyJitter(distanceKm, durationSec, effRules, {
        check: (d, sc) => checkRunRules(Object.assign({}, effRules, { runAvailableNow: true }), d, sc, acc),
      });
      if (!checkRunRules(Object.assign({}, effRules, { runAvailableNow: true }), j.distanceKm, j.durationSec, acc).length) jit = j;
    }
    const startedAt = Date.now();
    const started = await startSession(acc.creds, route, jit.distanceKm, jit.durationSec, 'CAMPUS', TRACK_OPTIONS);
    if (!started.ok) return send(502, { ok: false, stage: started.stage, detail: started.detail, retriable: !!started.retriable });
    // 到点时刻 = 开始 + 时长 - 余量。余量补偿服务端计时起点偏晚与网络往返。
    const submitAt = startedAt + jit.durationSec * 1000 * TIME_SCALE - Math.min(SUBMIT_MARGIN_MS, jit.durationSec * 200 * TIME_SCALE);
    const session = {
      sessionId: started.sessionId, startedAt, submitAt,
      distanceKm: jit.distanceKm, durationSec: jit.durationSec,
      routeId: route.routeId, passMode: route.passMode || null,
      checkpointHitRadiusM: route.checkpointHitRadiusM != null ? route.checkpointHitRadiusM : checkpointRadius(route),
      selectedCheckpoints: started.selectedCheckpoints,
      jittered: jit.jittered, attempts: 0, createdAt: startedAt,
    };
    const saved = await withState(() => {
      const s2 = loadState();
      const a2 = s2.accounts[studentId];
      if (!a2) return { err: '账号已不存在' };
      if (a2.session) return { err: '已有一个正在进行的会话（' + a2.session.sessionId + '），等它结束再提交' };
      a2.session = session;
      saveState(s2);
      return { ok: true };
    });
    if (saved.err) return send(409, { ok: false, error: saved.err, sessionId: started.sessionId });
    return send(200, {
      ok: true, started: true, sessionId: started.sessionId, runType: 'CAMPUS',
      distanceKm: jit.distanceKm, durationSec: jit.durationSec, jittered: jit.jittered,
      startedAt, submitAt, waitSec: Math.round((submitAt - startedAt) / 1000),
      checkpointCount: (started.selectedCheckpoints || route.checkpoints || []).length,
      note: '会话已建立，' + Math.round((submitAt - startedAt) / 1000) + ' 秒后自动提交。可以关掉页面，进程保持运行即可。',
    });
  };

  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
      return;
    }
    if (req.method === 'POST' && req.url === '/bind') {
      return onEnd(async (body) => {
        let code;
        try { ({ code } = JSON.parse(body || '{}')); }
        catch (e) { return send(400, { ok: false, error: '请求体不是合法 JSON' }); }
        // 绑定码 = Base64({"t","d","f"})
        let creds;
        try { creds = JSON.parse(Buffer.from(code, 'base64').toString('utf8')); }
        catch (e) { return send(400, { ok: false, error: '绑定码格式不对：' + e.message }); }
        if (!creds.t) return send(400, { ok: false, error: '码里没有 token 字段 t' });
        // 客户端（小程序）强制要求 t 与 deviceId 非空，这里对齐它的口径
        if (!creds.d) return send(400, { ok: false, error: '码里没有 device-id 字段 d' });
        // 用凭据调平台验证
        const r = await platformReq(creds, 'GET', '/users/profile');
        if (r.json && (r.json.code === 200 || r.json.code === 0)) {
          const user = r.json.data || {};
          const id = String(user.studentId || user.id);
          return withState(() => {
            const st = loadState();
            const prev = st.accounts[id];
            st.accounts[id] = {
              user,
              creds,
              runs: (prev && prev.runs) || [],          // 重新绑定同一账号时保留本地日志
              schedules: (prev && prev.schedules) || [],
              boundAt: new Date().toISOString(),
            };
            st.active = id;
            saveState(st);
            return send(200, { ok: true, user, studentId: id, rebound: Boolean(prev) });
          });
        }
        return send(502, { ok: false, error: bindFailureMessage(r), detail: r.text.slice(0, 300) });
      }, 'bind');
    }
    // 展示用状态：剔除 creds，绝不下发真实 token
    if (req.method === 'GET' && req.url === '/state') {
      return send(200, Object.assign(publicState(loadState()), { latestVersion: LATEST_VERSION, version: PKG.version || null }));
    }
    // 一键取码：把命令行取码器包成流式接口，页面不必开终端
    if (req.method === 'POST' && req.url === '/bind/scan') {
      return bindWizard.streamScan(req, res);
    }
    // 本地诊断。?probe=1 时额外发三个只读 GET，用来区分「token 过期」与「网络不通」。
    // 写死的三个探活都是 GET：这个端点绝不能成为绕过 confirmToken 的提交入口。
    if (req.method === 'GET' && (req.url === '/diagnose' || req.url.startsWith('/diagnose?'))) {
      const q = new URL(req.url, 'http://x').searchParams;
      const out = bindWizard.buildDiagnose({
        loadState, activeAccount, DEMO_MODE, BASE, STATE_FILE, SIGN_SECRET,
      });
      out.version = PKG.version || null;
      out.latestVersion = LATEST_VERSION;
      if (q.get('probe') === '1') {
        return withState(async () => {
          const a = activeAccount(loadState());
          if (!a) { out.probes = { skipped: '未绑定账号' }; return send(200, out); }
          const one = async (path) => {
            const r = await platformReq(a.acc.creds, 'GET', path);
            return {
              path,
              httpStatus: r.status,
              platformCode: r.json ? r.json.code : null,
              ok: r.status === 200 && r.json && (r.json.code === 200 || r.json.code === 0),
              error: r.status === 0 ? r.text.slice(0, 120) : null,
            };
          };
          out.probes = {
            profile: await one('/users/profile'),
            rules: await one('/run-rules/current'),
            routes: await one('/routes/nearby?lat=' + (SCHOOL_LAT || 0) + '&lng=' + (SCHOOL_LNG || 0) + '&limit=1'),
          };
          return send(200, out);
        });
      }
      return send(200, out);
    }
    // 账号列表 / 切换
    if (req.method === 'GET' && req.url === '/accounts') {
      const st = loadState();
      return send(200, {
        ok: true, active: st.active,
        accounts: Object.keys(st.accounts).map((id) => ({
          studentId: id,
          name: (st.accounts[id].user || {}).name || null,
          schoolName: (st.accounts[id].user || {}).schoolName || null,
          boundAt: st.accounts[id].boundAt || null,
          runCount: (st.accounts[id].runs || []).length,
          scheduleCount: (st.accounts[id].schedules || []).length,
        })),
      });
    }
    if (req.method === 'POST' && req.url === '/accounts') {
      return onEnd(async (body) => {
        let studentId;
        try { ({ studentId } = JSON.parse(body || '{}')); }
        catch (e) { return send(400, { ok: false, error: '请求体不是合法 JSON' }); }
        return withState(() => {
          const st = loadState();
          if (!st.accounts[studentId]) return send(404, { ok: false, error: `账号 ${studentId} 不存在` });
          st.active = String(studentId);
          saveState(st);
          return send(200, { ok: true, active: st.active });
        });
      }, 'switch-account');
    }
    if (req.method === 'POST' && req.url === '/run') {
      return onEnd(async (body) => {
        let opt;
        try { opt = JSON.parse(body || '{}'); }
        catch (e) { return send(400, { ok: false, error: '请求体不是合法 JSON' }); }
        if (!opt || typeof opt !== 'object' || Array.isArray(opt)) return send(400, { ok: false, error: '请求体必须是 JSON 对象' });
        const chk = validateRunParams(opt);
        if (chk.err) return send(400, { ok: false, error: chk.err });
        const { distanceKm, durationSec } = chk;
        // 账号在 body 解析后、令牌校验前取，避免与 /accounts 切换竞态：
        // 令牌按签发时的账号 id 校验，随后也对该账号执行。
        const a0 = activeAccount(loadState());
        if (!a0) return send(400, { ok: false, error: '先 /bind 绑定' });
        // ★ 守卫：没有有效 confirmToken 一律当干跑处理。
        // 否则 curl 直接打我就能真实提交到学校平台。dry:true 保留为显式干跑。
        const wantLive = opt.dry !== true;
        let dry = true, guardErr = null;
        if (wantLive) {
          const guard = await withState(() => {
            const st = loadState();
            const err = consumeConfirmToken(st, opt.confirmToken, a0.id, distanceKm, durationSec, opt.plannedAt, opt.runType);
            if (err) return { err };
            saveState(st);
            return { ok: true };
          });
          if (guard.err) return send(403, { ok: false, error: guard.err, hint: '真实提交需先 POST /confirm 取得令牌' });
          dry = false;
        }
        return doRun(a0.id, distanceKm, durationSec, dry, opt.plannedAt, opt.runType);
      });
    }
    // ---------- Phase 5 新端点 ----------
    // 开跑规则：页面据此算合规区间与窗口
    if (req.method === 'GET' && req.url === '/rules') {
      const st = loadState(); const a = activeAccount(st);
      if (!a) return send(400, { ok: false, error: '先 /bind 绑定' });
      const { rules, raw } = await fetchRules(a.acc.creds);
      if (!rules) return send(502, { ok: false, error: '开跑规则查询失败', detail: raw.text.slice(0, 300) });
      // defaults：页面开箱即用的距离/时长。从平台规则推导，不硬编码（840s 在 maxDuration=600 的学校会不合规）。
      const prev = (a.acc.runs || [])[0] || null;
      const defaults = defaultRunParams(rules, prev);
      // window：窗口原文抠出来的结构，前端据此把「现在不在窗口」讲成「已自动排到 07:32」
      const win = parseWindow(rules.runUnavailableReason);
      return send(200, {
        ok: true, studentId: a.id, rules, demo: DEMO_MODE,
        defaults, window: win, serverNow: new Date().toISOString(),
      });
    }
    // 干跑预览：返回完整 routeData 供页面画 SVG 轨迹图，绝不发任何 POST
    if (req.method === 'POST' && req.url === '/preview') {
      const st = loadState(); const a = activeAccount(st);
      if (!a) return send(400, { ok: false, error: '先 /bind 绑定' });
      return onEnd(async (body) => {
        let opt;
        try { opt = JSON.parse(body || '{}'); }
        catch (e) { return send(400, { ok: false, error: '请求体不是合法 JSON' }); }
        const chk = validateRunParams(opt || {});
        if (chk.err) return send(400, { ok: false, error: chk.err });
        return doRun(a.id, chk.distanceKm, chk.durationSec, true, opt.plannedAt, opt.runType);
      }, 'preview');
    }
    // 两步确认第一步：签发一次性令牌
    if (req.method === 'POST' && req.url === '/confirm') {
      const st = loadState(); const a = activeAccount(st);
      if (!a) return send(400, { ok: false, error: '先 /bind 绑定' });
      return onEnd(async (body) => {
        let opt;
        try { opt = JSON.parse(body || '{}'); }
        catch (e) { return send(400, { ok: false, error: '请求体不是合法 JSON' }); }
        const chk = validateRunParams(opt || {});
        if (chk.err) return send(400, { ok: false, error: chk.err });
        const plannedAt = opt.plannedAt || null;
        const runType = normRunType(opt.runType);
        // 自由跑不支持预约：FREE 不计成绩，排队执行它没有意义，调度器也就不必认识 runType
        if (runType === 'FREE' && plannedAt) {
          return send(400, { ok: false, error: '自由跑不支持预约，请改用「立即提交」' });
        }
        return withState(() => {
          const s2 = loadState();
          const token = issueConfirmToken(s2, a.id, chk.distanceKm, chk.durationSec, plannedAt, runType);
          saveState(s2);
          return send(200, {
            ok: true, confirmToken: token, expiresInSec: TOKEN_TTL_MS / 1000, runType,
            studentId: a.id, distanceKm: chk.distanceKm, durationSec: chk.durationSec, plannedAt,
            note: '该令牌一次性、5 分钟有效、绑定上述参数。真实提交须在 POST /run 里带上它。',
          });
        });
      }, 'confirm');
    }
    // 预约列表
    if (req.method === 'GET' && req.url === '/schedule') {
      const st = loadState(); const a = activeAccount(st);
      return send(200, { ok: true, active: a ? a.id : null, schedules: a ? (a.acc.schedules || []) : [] });
    }
    // 创建预约：必须带有效 confirmToken（创建时一次授权，到点自动执行不再问）
    if (req.method === 'POST' && req.url === '/schedule') {
      const st = loadState(); const a = activeAccount(st);
      if (!a) return send(400, { ok: false, error: '先 /bind 绑定' });
      return onEnd(async (body) => {
        let opt;
        try { opt = JSON.parse(body || '{}'); }
        catch (e) { return send(400, { ok: false, error: '请求体不是合法 JSON' }); }
        if (normRunType(opt && opt.runType) === 'FREE') {
          return send(400, { ok: false, error: '自由跑不支持预约，请改用「立即提交」' });
        }
        const chk = validateRunParams(opt || {});
        if (chk.err) return send(400, { ok: false, error: chk.err });
        const plannedAt = Number(opt.plannedAt);
        if (!Number.isFinite(plannedAt) || plannedAt <= 0) return send(400, { ok: false, error: 'plannedAt 必须是时间戳（毫秒）' });
        if (plannedAt <= Date.now()) return send(400, { ok: false, error: 'plannedAt 必须晚于当前时间' });
        return withState(() => {
          const s2 = loadState();
          const acc = s2.accounts[a.id];
          if (!acc) return send(404, { ok: false, error: `账号 ${a.id} 不存在` });
          // 令牌绑定 plannedAt，所以必须先 consume 再落库
          const err = consumeConfirmToken(s2, opt.confirmToken, a.id, chk.distanceKm, chk.durationSec, opt.plannedAt, 'CAMPUS');
          if (err) return send(403, { ok: false, error: err, hint: '预约需先 POST /confirm 取得令牌' });
          const id = 'kd-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
          const job = {
            id, studentId: a.id, distanceKm: chk.distanceKm, durationSec: chk.durationSec,
            plannedAt, status: 'pending', createdAt: Date.now(), attempts: 0,
          };
          acc.schedules.push(job);
          saveState(s2);
          return send(200, {
            ok: true, job,
            note: '已授权。到点后调度器会先查平台规则；窗口外不提交并标记 failed，不静默丢弃。',
          });
        });
      }, 'schedule-create');
    }
    // 取消预约
    if (req.method === 'POST' && req.url === '/schedule/cancel') {
      return onEnd(async (body) => {
        let id;
        try { ({ id } = JSON.parse(body || '{}')); }
        catch (e) { return send(400, { ok: false, error: '请求体不是合法 JSON' }); }
        return withState(() => {
          const s2 = loadState();
          for (const sid of Object.keys(s2.accounts)) {
            const list = s2.accounts[sid].schedules || [];
            const job = list.find((j) => j.id === id);
            if (job) {
              if (job.status !== 'pending') return send(400, { ok: false, error: `预约状态为 ${job.status}，不可取消` });
              job.status = 'cancelled';
              job.finishedAt = Date.now();
              saveState(s2);
              return send(200, { ok: true, job });
            }
          }
          return send(404, { ok: false, error: `预约 ${id} 不存在` });
        });
      }, 'schedule-cancel');
    }
    // 记录：平台记录 + 本地提交日志并列
    if (req.method === 'GET' && req.url === '/records') {
      const st = loadState(); const a = activeAccount(st);
      if (!a) return send(400, { ok: false, error: '先 /bind 绑定' });
      // 本机日志补默认值（决策：旧记录读取时补，不落盘迁移）：
      // 缺 runType 视为 CAMPUS，缺 platformId 用 sessionId 兜底 —— 否则去重键会漏配。
      const local = (a.acc.runs || []).map((r) => ({
        ...r,
        runType: r.runType || 'CAMPUS',
        platformId: r.platformId != null ? String(r.platformId)
          : (r.sessionId != null ? String(r.sessionId) : null),
      }));
      let platform = null, stats = null, errMsg = null, statsErr = null;
      const p1 = await platformReq(a.acc.creds, 'GET', '/runs?page=1&size=20');
      if (p1.json && (p1.json.code === 200 || p1.json.code === 0)) {
        // 真平台列表键是 records（flows.jsonl:28 实测），不是 list。两个都认，但以 records 为准。
        const d = p1.json.data;
        const arr = Array.isArray(d) ? d : (Array.isArray(d && d.records) ? d.records : (Array.isArray(d && d.list) ? d.list : []));
        // 保留 null 与 [] 的区别：null = 没取到，[] = 取到但空
        platform = arr.map((r) => normalizeRun(r, 'platform')).filter(Boolean);
      } else errMsg = p1.text.slice(0, 200);
      const p2 = await platformReq(a.acc.creds, 'GET', '/stats?type=semester');
      if (p2.json && (p2.json.code === 200 || p2.json.code === 0)) {
        stats = normalizeStats(p2.json.data);
        if (!stats.ok) statsErr = stats.reason;
      } else statsErr = p2.text.slice(0, 200);
      return send(200, {
        ok: true, studentId: a.id, local, platform, stats: stats && stats.ok ? stats : null,
        statsError: statsErr, platformError: errMsg,
      });
    }

    // 局域网地址：替代原来那张「手机打开本页」卡片（用户选的是去掉卡片，地址改由启动脚本/本端点打印）
    if (req.method === 'GET' && req.url === '/lan') {
      // 绑在 loopback 时服务根本不可达，枚举内网 IP 只是替攻击面做情报。
      const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
      return send(200, {
        ok: true, port: PORT, host: HOST, boundToLoopback: loopback,
        lan: loopback ? [] : lanAddresses(PORT),
        warning: loopback ? null : '服务未鉴权，勿在公共网络使用',
      });
    }
    // 附近路线：lat/lng 由前端（浏览器定位或手输）传入。缓存：账号已有 routes 且未传坐标时直接回缓存。
    if (req.method === 'GET' && (req.url === '/routes' || req.url.startsWith('/routes?'))) {
      const st = loadState(); const a = activeAccount(st);
      if (!a) return send(400, { ok: false, error: '先 /bind 绑定' });
      const q = new URL(req.url, 'http://x').searchParams;
      // 缺失的查询参数是 null，Number(null) === 0 会被当成合法赤道坐标，必须先判空
      const latRaw = q.get('lat'), lngRaw = q.get('lng');
      const lat = latRaw === null ? NaN : Number(latRaw), lng = lngRaw === null ? NaN : Number(lngRaw);
      const hasFix = Number.isFinite(lat) && Number.isFinite(lng);
      if (!hasFix && (a.acc.routes || []).length) {
        return send(200, { ok: true, routes: a.acc.routes, selectedRouteId: a.acc.selectedRouteId || null, cached: true });
      }
      if (!hasFix) return send(400, { ok: false, error: '需要 lat/lng（浏览器定位或手动输入）' });
      const rr = await platformReq(a.acc.creds, 'GET', `/routes/nearby?lat=${lat}&lng=${lng}&limit=20`);
      if (!rr.json || (rr.json.code !== 200 && rr.json.code !== 0)) {
        return send(502, { ok: false, error: '路线查询失败', detail: rr.text.slice(0, 300) });
      }
      // 归一化：点序即环序（末点连首点）；点数 <4 的路线剔除并如实上报，不猜测
      const rawList = (rr.json.data && (Array.isArray(rr.json.data) ? rr.json.data : rr.json.data.routes)) || [];
      const routes = [], skipped = [];
      for (const r of rawList) {
        const cps = (r.checkpoints || []).slice().sort((x, y) => (x.seqNo || 0) - (y.seqNo || 0))
          .map((c) => [Number(c.latitude), Number(c.longitude)])
          .filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo));
        if (!r.id || cps.length < 4) { skipped.push({ id: r.id != null ? r.id : null, reason: `打卡点 ${cps.length} 个，不足以构环` }); continue; }
        let ringLenM = 0;
        for (let i = 0; i < cps.length; i++) {
          const [la1, lo1] = cps[i], [la2, lo2] = cps[(i + 1) % cps.length];
          ringLenM += haversineM(la1, lo1, la2, lo2);
        }
        routes.push({
          routeId: r.id, name: r.name || null, schoolId: r.schoolId ?? null, ringLenM: Math.round(ringLenM),
          passMode: r.passMode || null, startAllowedRadiusM: r.startAllowedRadiusM ?? null,
          // 打卡半径与名字一起留档：提交前本地复算要用真实半径，缺省 30m 只是兜底
          checkpointHitRadiusM: Number(r.checkpointHitRadiusM) > 0 ? Number(r.checkpointHitRadiusM) : 30,
          checkpointNames: (r.checkpoints || []).slice().sort((x, y) => (x.seqNo || 0) - (y.seqNo || 0)).map((c) => c.pointName || null),
          checkpoints: cps, fetchedAt: new Date().toISOString(),
        });
      }
      return withState(() => {
        const s2 = loadState();
        const acc = s2.accounts[a.id];
        if (!acc) return send(404, { ok: false, error: `账号 ${a.id} 不存在` });
        acc.routes = routes;
        // 单条自动选中；多条不自动选（最近的不一定是学校要求那条）
        if (routes.length === 1) acc.selectedRouteId = routes[0].routeId;
        saveState(s2);
        return send(200, { ok: true, routes, skipped, selectedRouteId: acc.selectedRouteId || null });
      });
    }
    // 选定路线
    if (req.method === 'POST' && req.url === '/routes/select') {
      return onEnd(async (body) => {
        let routeId;
        try { ({ routeId } = JSON.parse(body || '{}')); }
        catch (e) { return send(400, { ok: false, error: '请求体不是合法 JSON' }); }
        return withState(() => {
          const s2 = loadState();
          const acc = s2.accounts[s2.active];
          if (!acc) return send(400, { ok: false, error: '先 /bind 绑定' });
          const hit = (acc.routes || []).find((r) => r.routeId === routeId);
          if (!hit) return send(404, { ok: false, error: `路线 ${routeId} 不在本账号路线列表，先 GET /routes?lat&lng` });
          acc.selectedRouteId = routeId;
          saveState(s2);
          return send(200, { ok: true, selectedRouteId: routeId, name: hit.name });
        });
      }, 'routes-select');
    }
    // 坐标兜底：浏览器定位被拒/不可用时，页面用它在绑定后自动取附近路线。
    // 不含任何凭据，可自由下发。
    if (req.method === 'GET' && req.url === '/config') {
      return send(200, { ok: true, schoolLat: SCHOOL_LAT, schoolLng: SCHOOL_LNG });
    }
    if (req.method === 'GET' && req.url === '/mode') {
      // 前端不调用 /mode；真实地址只留在终端日志里，不通过 HTTP 下发。
      return send(200, { ok: true, demo: DEMO_MODE });
    }
    send(404, { ok: false, error: 'not found' });
  } catch (e) {
    send(500, { ok: false, error: e.message });
  }
});

// ---------- 预约调度器 ----------
// 平台上不存在「预约」概念（只有 sessions/start → finish），预约是本服务器自己拉起的定时任务。
// 每分钟扫一次 state.json；状态全在磁盘，所以重启后能从磁盘恢复，无内存态。
// 到点动作：取任务归属账号凭据 → 查平台规则 → 窗口外不提交并标 failed（记原因，不静默丢弃）→ 否则提交。
async function tick(nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs;
  // 第一优先：到点的校园跑会话。它已经建立了平台会话，拖得越久越可能超时被撤销。
  const sessions = await withState(() => {
    const st = loadState();
    const out = [];
    for (const sid of Object.keys(st.accounts)) {
      const acc = st.accounts[sid];
      const sess = acc && acc.session;
      if (!sess) continue;
      if (sess.submitAt > now) continue;
      // 超过补提交宽限期：平台侧会话大概率已失效，撤销它并报原因
      if (now > sess.startedAt + sess.durationSec * 1000 * TIME_SCALE + SESSION_MAX_GRACE_MS) {
        out.push({ studentId: sid, stale: true, session: Object.assign({}, sess) });
        continue;
      }
      out.push({ studentId: sid, stale: false, session: Object.assign({}, sess) });
    }
    return out;
  });

  for (const item of sessions) {
    const sid = item.studentId, sess = item.session;
    try {
      const st = loadState();
      const acc = st.accounts[sid];
      if (!acc) { await clearSession(sid, '账号已不存在'); continue; }
      if (item.stale) {
        await cancelSession(acc.creds, sess.sessionId);
        await clearSession(sid, '会话超时未提交，已撤销');
        continue;
      }
      const route = (acc.routes || []).find((r) => r.routeId === sess.routeId) || null;
      if (!route) { await clearSession(sid, '路线已从缓存中消失，无法提交'); continue; }
      const r = await finishSession(acc.creds, sess, route, {});
      if (r.ok) {
        await withState(() => {
          const s2 = loadState();
          const a2 = s2.accounts[sid];
          if (a2) {
            a2.runs.unshift({
              at: new Date().toISOString(), sessionId: r.sessionId,
              runType: 'CAMPUS', platformId: r.platformId || null,
              distanceKm: r.dist2 != null ? r.dist2 : sess.distanceKm,
              durationSec: sess.durationSec,
              trackPoints: r.track ? r.track.points.length : null,
              residualPct: r.track ? +((r.track.walkedM / r.track.declaredM - 1) * 100).toFixed(4) : null,
              jittered: !!sess.jittered,
              response: r.finishJson,
            });
            a2.session = null;
            a2.lastFailure = null;
            saveState(s2);
          }
        });
        console.log('[session] ' + sess.sessionId + ' 提交成功 platformId=' + (r.platformId || '-'));
      } else if (r.retriable && (sess.attempts || 0) < 3) {
        // 网络抖动：保留会话，延后重试。间隔 30s / 2min / 5min。
        const backoff = [30000, 120000, 300000][Math.min(sess.attempts || 0, 2)];
        await withState(() => {
          const s2 = loadState();
          const a2 = s2.accounts[sid];
          if (a2 && a2.session) {
            a2.session.submitAt = Date.now() + backoff;
            a2.session.attempts = (a2.session.attempts || 0) + 1;
            a2.session.lastError = r.detail;
            saveState(s2);
          }
        });
        console.log('[session] ' + sess.sessionId + ' 提交失败（可重试），' + Math.round(backoff / 1000) + 's 后重试');
      } else {
        // 本地校验不通过 / 平台明确拒绝：撤销会话，避免平台侧留下半截记录
        await cancelSession(acc.creds, sess.sessionId);
        await clearSession(sid, (r.stage === 'guard' ? '' : '提交失败(' + r.stage + ')：') + r.detail);
      }
    } catch (e) {
      await clearSession(sid, '异常：' + (e && e.message || e));
    }
  }

  const due = await withState(() => {
    const st = loadState();
    let changed = false;
    const jobs = [];
    for (const sid of Object.keys(st.accounts)) {
      for (const job of (st.accounts[sid].schedules || [])) {
        if (job.status !== 'pending') continue;
        if (job.plannedAt > now) continue;
        if (job.nextAttemptAt && job.nextAttemptAt > now) continue;
        job.status = 'running';
        job.startedAt = now;
        job.attempts = (job.attempts || 0) + 1;
        jobs.push({ ...job });
        changed = true;
      }
    }
    if (changed) saveState(st);
    return jobs;
  });

  for (const job of due) {
    try {
      const st = loadState();
      const acc = st.accounts[job.studentId];
      if (!acc) { await finishJob(job.id, 'failed', '账号已不存在'); continue; }
      const { rules, raw } = await fetchRules(acc.creds);
      if (!rules) { await finishJob(job.id, 'failed', '开跑规则查询失败：' + raw.text.slice(0, 120)); continue; }
      // 窗口外：不提交，标 failed 并记录平台原文（决策：不拦预约，到点发现不合规则就失败）
      if (rules.runAvailableNow !== true) {
        await finishJob(job.id, 'failed', '不在开跑窗口：' + (rules.runUnavailableReason || '平台未说明原因'));
        continue;
      }
      const problems = checkRunRules(rules, job.distanceKm, job.durationSec, acc);
      if (problems.length) { await finishJob(job.id, 'failed', problems.join('；')); continue; }
      // 路线：与 /run 同一解析口径（选中，单条自动选）
      const routes = acc.routes || [];
      let sel = routes.find((r) => r.routeId === acc.selectedRouteId);
      if (!sel && routes.length === 1) sel = routes[0];
      if (!sel) { await finishJob(job.id, 'failed', '尚未选择路线：先获取附近路线并选择'); continue; }
      // 预约到点 = 建立会话；真正的 finish 由上面的 session 分支在 durationSec 后执行。
      // 这样预约与立即提交走同一条真实计时链路，不会因为"预约是自动的"就退回零等待。
      const a2 = loadState().accounts[job.studentId];
      if (a2 && a2.session) { await finishJob(job.id, 'failed', '已有正在进行的会话，跳过本次预约'); continue; }
      const started = await startSession(acc.creds, sel, job.distanceKm, job.durationSec, 'CAMPUS', TRACK_OPTIONS);
      if (!started.ok) {
        await retryOrFail(job, started.retriable, '开始跑步失败(' + started.stage + ')：' + started.detail);
        continue;
      }
      const startedAt = Date.now();
      await withState(() => {
        const s2 = loadState();
        const acc2 = s2.accounts[job.studentId];
        if (!acc2) return;
        acc2.session = {
          sessionId: started.sessionId, startedAt,
          submitAt: startedAt + job.durationSec * 1000 * TIME_SCALE - Math.min(SUBMIT_MARGIN_MS, job.durationSec * 200 * TIME_SCALE),
          distanceKm: job.distanceKm, durationSec: job.durationSec,
          routeId: sel.routeId, passMode: sel.passMode || null,
          checkpointHitRadiusM: sel.checkpointHitRadiusM != null ? sel.checkpointHitRadiusM : 30,
          selectedCheckpoints: started.selectedCheckpoints,
          scheduleId: job.id, attempts: 0, createdAt: startedAt,
        };
        const j2 = (acc2.schedules || []).find((x) => x.id === job.id);
        if (j2) { j2.status = 'running'; j2.startedAt = startedAt; j2.sessionId = started.sessionId; }
        saveState(s2);
      });
      console.log('[schedule] ' + job.id + ' 会话已建立 sessionId=' + started.sessionId + '，' + job.durationSec + 's 后提交');
    } catch (e) {
      await finishJob(job.id, 'failed', '异常：' + (e && e.message || e));
    }
  }
  return sessions.length + due.length;
}

// 预约级失败：网络类失败退避重试（30s/2min/5min），业务拒绝直接落 failed。
async function retryOrFail(job, retriable, reason) {
  const attempts = job.attempts || 0;
  if (retriable && attempts < 3) {
    const backoff = [30000, 120000, 300000][Math.min(attempts - 1, 2)];
    return withState(() => {
      const st = loadState();
      for (const sid of Object.keys(st.accounts)) {
        const j = (st.accounts[sid].schedules || []).find((x) => x.id === job.id);
        if (j) {
          j.status = 'pending'; j.nextAttemptAt = Date.now() + backoff;
          j.lastError = reason; saveState(st); return;
        }
      }
    });
  }
  return finishJob(job.id, 'failed', reason);
}

// 清掉会话；reason 非空时记到账号上，前端据此提示（不静默丢弃）
async function clearSession(studentId, reason) {
  return withState(() => {
    const st = loadState();
    const acc = st.accounts[studentId];
    if (!acc) return;
    const sess = acc.session;
    acc.session = null;
    if (reason) acc.lastFailure = { at: Date.now(), reason, sessionId: sess ? sess.sessionId : null };
    saveState(st);
  });
}

async function finishJob(id, status, reason) {
  return withState(() => {
    const st = loadState();
    for (const sid of Object.keys(st.accounts)) {
      const job = (st.accounts[sid].schedules || []).find((j) => j.id === id);
      if (job) { job.status = status; job.finishedAt = Date.now(); job.reason = reason; saveState(st); return; }
    }
  });
}

// 兜底：任何漏网的 async 异常都不该打死这个进程
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.stack || e));

// 启动恢复：crash 可能把任务留在 running（executeRun 中途退出），tick 只扫 pending，
// 这些任务会永久卡死。重启时统一重置为 pending，下个 tick 重新执行（attempts 已计数）。
function resetStaleRunning() {
  return withState(() => {
    const st = loadState();
    let n = 0;
    for (const sid of Object.keys(st.accounts)) {
      for (const job of (st.accounts[sid].schedules || [])) {
        if (job.status === 'running') { job.status = 'pending'; n++; }
      }
    }
    if (n) { saveState(st); console.log(`[scheduler] 恢复 ${n} 个上次中断的 running 任务为 pending`); }
    return n;
  });
}

// 启动恢复：会话本身写在 state 里，重启后不需要重建 —— 只要还没到点就继续等，
// 已经超过宽限期的交给 tick 撤销。这里只做一次日志，让用户知道有任务在续跑。
function resumeSessions() {
  return withState(() => {
    const st = loadState();
    for (const sid of Object.keys(st.accounts)) {
      const sess = st.accounts[sid].session;
      if (!sess) continue;
      const left = Math.round((sess.submitAt - Date.now()) / 1000);
      if (left > 0) console.log('[session] 恢复未完成的会话 ' + sess.sessionId + '，还有 ' + left + 's 提交');
      else console.log('[session] 恢复会话 ' + sess.sessionId + '，已到点，将立即提交');
    }
  });
}

function startScheduler(intervalMs) {
  resetStaleRunning();
  resumeSessions();
  const iv = intervalMs || SCHEDULER_TICK_MS;
  const timer = setInterval(() => {
    tick().catch((e) => console.error('[scheduler]', e && e.stack || e));
  }, iv);
  timer.unref();
  return timer;
}

// 端口被占用时必须明确报错退出。以前只挂 listen 回调，EADDRINUSE 被下面的
// uncaughtException 吞掉，进程还在、窗口还在，用户以为服务已启动。
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[启动失败] 端口 ${PORT} 已被占用。关掉占用它的程序，或改配置里的 port。`);
    console.error(`  Windows 查占用：netstat -ano | findstr :${PORT}`);
  } else {
    console.error('[启动失败]', e.message);
  }
  process.exit(1);
});

async function main() {
  if (DEMO_MODE) {
    const { startMock } = require('./tools/mock-platform.js');
    try {
      await startMock(DEMO_PORT);
    } catch (e) {
      console.error(`[启动失败] 演示模式的本地假平台起不来（端口 ${DEMO_PORT}）：${e.message}`);
      process.exit(1);
    }
  }
  server.listen(PORT, HOST, () => {
    console.log('校园跑 · 新版本  http://' + HOST + ':' + PORT + '/');
    if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
      console.log('  ★ 警告：HOST = ' + HOST + ' 不是 loopback。本服务持有真实 token 且无登录鉴权，');
      console.log('    同网段任何人都能读取你的学号、姓名与跑步记录。仅在你清楚风险时这样用。');
    }
    const reg = loadSchoolRegistry();
    if (reg) {
      const withCode = reg.schools.filter((x) => x && x.code).length;
      console.log(`  多校登记表：${reg.schools.length} 所（已填绑定码 ${withCode} 所）→ ${reg.path}`);
    }
    if (DEMO_MODE) {
      console.log('  ★ 演示模式：未配置真实平台，数据不会提交到任何平台。');
      console.log('  填入 config.local.json 的 baseUrl 与 signSecret 后即为真实模式（见 docs/接入新学校.md）。');
    } else {
      console.log('  真实模式，平台 BASE = ' + BASE);
    }
    startScheduler();
    console.log('  ' + (SCHEDULER_TICK_MS >= 60000 ? '预约调度器已启动（每分钟一次）' : '预约调度器已启动（每 ' + Math.round(SCHEDULER_TICK_MS / 1000) + ' 秒一次）'));
    startVersionCheck();
  });
}

if (require.main === module) {
  main().catch((e) => { console.error('[启动失败]', e && e.stack || e); process.exit(1); });
}

module.exports = { server, loadState, saveState, migrateState, publicState, activeAccount, parseWindow, nextWindowStart, defaultRunParams, lanAddresses,
  validateRunParams, checkRunRules, buildRunBodies, executeRun, fetchRules,
  startSession, finishSession, cancelSession, isRetriable, checkpointRadius, retryOrFail, resumeSessions,
  SUBMIT_MARGIN_MS, SESSION_MAX_GRACE_MS, TIME_SCALE,
  issueConfirmToken, consumeConfirmToken, tick, startScheduler, resetStaleRunning, emptyState };

