// 本地假平台（mock）· 用于在任意时间端到端测试本工具
//
// 为什么存在：真平台只在每天 09:00~09:30 允许开跑，且我们不想真提交。
// 把 server.js 的 BASE 指向本进程即可全天候测试整条链路。
//
// ★ 本文件的核心价值 = 独立实现 HMAC 签名校验。
//   故意不 require('../server.js') / require('../track-core')：复用就验证不了任何东西，
//   共享 bug 会一起通过。这里逐字照契约重新实现一遍，才能交叉验证 server.js 的签名。
//
// 运行：node tools/mock-platform.js
//       环境变量 PORT（默认 8788）、KD_MOCK_WINDOW=closed（模拟窗口外）
'use strict';

const http = require('http');
const crypto = require('crypto');

let PORT = Number(process.env.PORT) || 8788;
const WINDOW_CLOSED = process.env.KD_MOCK_WINDOW === 'closed';
// /stats 返回 {data:null} → 验「平台统计取不到」的降级路径（决策 5）
const STATS_EMPTY = process.env.KD_MOCK_STATS === 'empty';
// 会话真实时长对账。真平台会拿 start 与 finish 的墙钟差比上报名义 duration（参考实现实测差 68s 判 status:2）。
// 默认开：mock 的意义就是复刻真平台，宽松模式会让"零等待提交"这种 bug 一路绿。
// KD_MOCK_STRICT_TIME=0 关掉，仅用于演示模式（用户只想看流程、不想等满时长）。
const STRICT_TIME = process.env.KD_MOCK_STRICT_TIME !== '0';
const TIME_TOLERANCE_SEC = Number(process.env.KD_MOCK_TIME_TOLERANCE_SEC) || 10;
// 与被测服务共用同一个时间缩放（验收时把 600s 压成 6s）。生产恒为 1，语义与真平台完全一致：
// 申报 600s 就必须真的过约 600s。缩放只用于让自动化测试跑得完。
const TIME_SCALE = (() => { const v = Number(process.env.KD_TIME_SCALE); return Number.isFinite(v) && v > 0 ? v : 1; })();

// 签名密钥由 KD_SIGN_SECRET 注入（演示模式下 server.js 会传固定测试值）。算法真源见 docs/api-map.md。
// 密钥来自环境变量或 server.js 的演示模式注入；不再内置任何真实值。
const SIGN_SECRET = process.env.KD_SIGN_SECRET || 'mock-secret-for-local-test-only';
const TS_TOLERANCE_SEC = 300;

// ---------- 独立实现的签名校验（不复用 server.js） ----------
const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmacHex = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest('hex');

// 与 server.js:25-27 / 小程序 requiresRunSign 完全同构：三个 POST 才需要签名。
// ⚠ 正则只认纯数字 sessionId —— 所以本 mock 返回的 sessionId 必须是纯数字，
//   否则 finish 不会带签名，验签分支就永远测不到。
function needsSign(method, pathOnly) {
  return method === 'POST' && (
    pathOnly === '/runs' ||
    pathOnly === '/runs/sessions/start' ||
    /^\/runs\/sessions\/[0-9]+\/finish$/.test(pathOnly)
  );
}

// 重建 signBase 并比对。返回 {ok, reason, computed, received}
function verifySign(method, pathOnly, bodyStr, headers) {
  const token = headers['sunshine-run'];
  const deviceId = headers['sunshine-run-device-id'] || '';
  const ts = headers['sunshine-run-timestamp'];
  const nonce = headers['sunshine-run-nonce'];
  const sign = headers['sunshine-run-sign'];

  if (!token) return { ok: false, reason: '缺少 sunshine-run（token 为空）' };

  const missing = ['sunshine-run-timestamp', 'sunshine-run-nonce', 'sunshine-run-sign']
    .filter((h) => !headers[h]);
  if (missing.length) return { ok: false, reason: '缺少签名头：' + missing.join(', ') };

  const nowSec = Math.floor(Date.now() / 1000);
  const drift = Math.abs(nowSec - Number(ts));
  if (!Number.isFinite(Number(ts))) return { ok: false, reason: `时间戳不是数字：${ts}` };
  if (drift > TS_TOLERANCE_SEC) return { ok: false, reason: `时间戳偏差 ${drift}s 超过 ${TS_TOLERANCE_SEC}s` };

  // ★ 8 段，'\n' 连接，末尾再补一个 '\n'。段序：v1, METHOD, path, ts, nonce, sha256(t), sha256(d), sha256(body)
  // ⚠ 设备指纹 f 不参与签名（已由小程序源码证实），只作请求头。
  const signBase = ['v1', method.toUpperCase(), pathOnly, ts, nonce,
    sha256hex(token), sha256hex(deviceId), sha256hex(bodyStr)].join('\n') + '\n';
  const computed = hmacHex(SIGN_SECRET, signBase);

  if (computed !== sign) {
    return { ok: false, reason: '签名不匹配', computed, received: sign, signBase };
  }
  return { ok: true, computed };
}

// ---------- 内存状态 ----------
const state = {
  requests: [],   // 本次进程收到的全部请求摘要
  runs: [],       // 已提交记录
  sessions: new Map(),
  nextSessionId: 1001,
  routeCache: new Map(),   // routeId → 打卡点（start 时按客户端上报的 routeId 回传）
  nextRunId: 90001,
  signOk: 0,
  signFail: 0,
};

function logRequest(entry) { state.requests.push(entry); }

// ★ 真平台记录形状（api-map.md:210-213 实测）：
//   {id,distance,duration,pace,calories,startTime,endTime,runType,routeName,routeId,sessionId,snapshotUrl,status}
//   注意 status 是**数字 1**（不是字符串 'success'），且 FREE 记录同样是 status:1 ——
//   status 区分不了「计不计成绩」，判据只有 runType/sessionId。mock 必须照抄，否则
//   前端一句 rec.status === 'failed' 就能蒙混过关（原来的假数据正是这么骗过 QA 的）。
function publicRun(rec) {
  return {
    id: rec.id, distance: rec.distance, duration: rec.duration, pace: rec.pace,
    calories: rec.calories, startTime: rec.startTime, endTime: rec.endTime,
    runType: rec.runType, routeName: rec.routeName, routeId: rec.routeId,
    sessionId: rec.sessionId, snapshotUrl: rec.snapshotUrl, status: rec.status,
  };
}

// ---------- 独立实现的 haversine（用于复核 server.js 的轨迹收敛） ----------
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 对 routeData 累加实走长度，与申报 distance(km) 比对。
// server.js 声称收敛残差 0.0013% —— 这里是唯一能独立复核它的地方。
function auditTrack(routeData, declaredKm) {
  if (!Array.isArray(routeData) || routeData.length === 0) return { ok: false, reason: 'routeData 为空或非数组' };
  if (routeData.length > 500) return { ok: false, reason: `点数 ${routeData.length} 超过 500` };
  for (let i = 0; i < routeData.length; i++) {
    const p = routeData[i];
    for (const k of ['latitude', 'longitude', 'timestamp', 'accuracy']) {
      if (typeof p?.[k] !== 'number' || !Number.isFinite(p[k])) {
        return { ok: false, reason: `第 ${i} 点字段 ${k} 非法：${JSON.stringify(p?.[k])}` };
      }
    }
  }
  let walked = 0;
  for (let i = 1; i < routeData.length; i++) {
    walked += haversineM(routeData[i - 1].latitude, routeData[i - 1].longitude,
      routeData[i].latitude, routeData[i].longitude);
  }
  const declaredM = declaredKm * 1000;
  return {
    ok: true,
    points: routeData.length,
    walkedM: +walked.toFixed(3),
    declaredM: +declaredM.toFixed(3),
    deltaPct: +((walked / declaredM - 1) * 100).toFixed(4),
    // 峰速与最小点距：轨迹能否过平台校验的两个硬指标
    maxSpeed: +maxSpeedMs(routeData).toFixed(3),
    minPointDist: +minPointDistM(routeData).toFixed(3),
    maxGapSec: +maxGapSec(routeData).toFixed(2),
  };
}

function maxSpeedMs(routeData) {
  let peak = 0;
  for (let i = 1; i < routeData.length; i++) {
    const p = routeData[i - 1], c = routeData[i];
    const dt = (c.timestamp - p.timestamp) / 1000;
    if (dt <= 0) continue;
    const v = haversineM(p.latitude, p.longitude, c.latitude, c.longitude) / dt;
    if (v > peak) peak = v;
  }
  return peak;
}

function minPointDistM(routeData) {
  let min = Infinity;
  for (let i = 1; i < routeData.length; i++) {
    const p = routeData[i - 1], c = routeData[i];
    const d = haversineM(p.latitude, p.longitude, c.latitude, c.longitude);
    if (d < min) min = d;
  }
  return min === Infinity ? 0 : min;
}

function maxGapSec(routeData) {
  let gap = 0;
  for (let i = 1; i < routeData.length; i++) {
    const dt = (routeData[i].timestamp - routeData[i - 1].timestamp) / 1000;
    if (dt > gap) gap = dt;
  }
  return gap;
}

// ---------- 平台响应载荷 ----------
const PROFILE = {
  id: 1,
  // 学号可覆盖：默认值是占位学号，验收时用 KD_MOCK_STUDENT 换掉
  studentId: process.env.KD_MOCK_STUDENT || '2000000000000',
  name: '测试学生',
  schoolId: 1,
  schoolName: '示例大学',
  serverUrl: `http://127.0.0.1:${PORT}/`,
  weight: 70,
  totalDistance: 0, totalDuration: 0, totalRuns: 0, totalCalories: 0,
};

function currentRules() {
  const base = {
    id: 1, maxDailyRuns: 0, schoolId: 1, semesterId: 1, semesterName: '示例学期',
    sex: '1', minDistance: 1.00, minDuration: 180, maxDuration: 600, minPace: 180, maxPace: 600,
  };
  if (WINDOW_CLOSED) {
    return { ...base, runAvailableNow: false, runUnavailableReason: '仅允许在09:00~09:30开始跑步' };
  }
  return { ...base, runAvailableNow: true, runUnavailableReason: '' };
}

// ---------- HTTP ----------
const ok = (res, data) => send(res, 200, { code: 200, message: '成功', data });
const fail = (res, code, message, extra = {}) =>
  send(res, 200, { code, message, ...extra });   // 平台风格：业务错误也用 HTTP 200 + code 区分

function send(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  // body 按原始字节累积再转 utf8，保证 sha256(bodyStr) 与发送端一致
  const chunks = [];
  let tooBig = false;
  req.on('data', (c) => {
    chunks.push(c);
    const n = chunks.reduce((a, b) => a + b.length, 0);
    if (n > 10 * 1024 * 1024) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return;
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = JSON.parse(rawBody); } catch { /* 可能是空体 */ }

    const method = (req.method || 'GET').toUpperCase();
    const pathOnly = (req.url || '/').split('?')[0];
    const query = Object.fromEntries(new URLSearchParams((req.url || '').split('?')[1] || ''));

    // ---- 验签 ----
    const signed = needsSign(method, pathOnly);
    let signResult = null;
    if (signed) {
      signResult = verifySign(method, pathOnly, rawBody, req.headers);
      if (signResult.ok) state.signOk++; else state.signFail++;
      console.log(`[mock] ${method} ${pathOnly} 验签=${signResult.ok ? 'PASS' : 'FAIL'}${signResult.ok ? '' : ' ' + signResult.reason}`);
    } else {
      console.log(`[mock] ${method} ${pathOnly} 无需签名`);
    }

    logRequest({
      method, path: pathOnly, query,
      signed,
      signOk: signResult ? signResult.ok : null,
      signReason: signResult && !signResult.ok ? signResult.reason : null,
      hasToken: Boolean(req.headers['sunshine-run']),
      deviceId: req.headers['sunshine-run-device-id'] || '',
      fp: req.headers['sunshine-run-device-fp'] || '',
      bodyBytes: Buffer.byteLength(rawBody),
      // 原文留一份给验收脚本核对 body 形状（截断防爆日志；body 内不含凭据）
      body: rawBody.length > 20000 ? rawBody.slice(0, 20000) : rawBody,
      at: new Date().toISOString(),
    });

    if (signed && !signResult.ok) {
      // 调试友好：把服务端算出的 sign 与收到的 sign 都回给调用方，便于人眼比对
      return send(res, 401, {
        code: 401, message: '签名校验失败：' + signResult.reason,
        detail: { computed: signResult.computed, received: signResult.received, signBase: signResult.signBase },
      });
    }

    // ---- 路由 ----
    // === 自用端点（非平台契约）===
    if (method === 'GET' && pathOnly === '/mock/log') {
      return ok(res, {
        windowClosed: WINDOW_CLOSED,
        requestCount: state.requests.length,
        signOk: state.signOk,
        signFail: state.signFail,
        runs: state.runs,
        requests: state.requests,
      });
    }
    if (method === 'POST' && pathOnly === '/mock/reset') {
      state.requests.length = 0; state.runs.length = 0; state.sessions.clear();
      state.nextSessionId = 1001; state.nextRunId = 90001; state.signOk = 0; state.signFail = 0;
      return ok(res, { reset: true });
    }

    // === 平台契约 ===
    if (method === 'GET' && pathOnly === '/users/profile') return ok(res, PROFILE);
    if (method === 'GET' && pathOnly === '/run-rules/current') return ok(res, currentRules());
    if (method === 'GET' && pathOnly === '/schools') return ok(res, [{ id: 1, name: '示例大学' }]);
    // 附近路线：两条虚构环（200m/8 点 与 350m/12 点），支持 KD_MOCK_SCHOOL=campus2 换点集，
    // 验证 server.js 的轨迹生成确实不再绑定路线 6。
    if (method === 'GET' && pathOnly === '/routes/nearby') {
      const qLat = Number(query.lat), qLng = Number(query.lng);
      const lat = Number.isFinite(qLat) ? qLat : 0, lng = Number.isFinite(qLng) ? qLng : 0;
      const cpsA = [], cpsB = [];
      const n = process.env.KD_MOCK_SCHOOL === 'campus2' ? 10 : 8;
      for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; cpsA.push({ seqNo: i + 1, latitude: +(lat + 0.0006 * Math.sin(a)).toFixed(7), longitude: +(lng + 0.0008 * Math.cos(a)).toFixed(7) }); }
      for (let i = 0; i < 12; i++) { const a = i / 12 * 2 * Math.PI; cpsB.push({ seqNo: i + 1, latitude: +(lat + 0.0011 * Math.sin(a)).toFixed(7), longitude: +(lng + 0.0014 * Math.cos(a)).toFixed(7) }); }
      state.routeCache.set(61, cpsA);
      state.routeCache.set(62, cpsB);
      return ok(res, { routes: [
        { id: 61, name: '操场小环', schoolId: 1, passMode: 'ANY', startAllowedRadiusM: 100, randomCheckpointCount: 0, checkpoints: cpsA },
        { id: 62, name: '操场大环', schoolId: 1, passMode: 'ANY', startAllowedRadiusM: 100, randomCheckpointCount: 0, checkpoints: cpsB },
      ] });
    }

    if (method === 'GET' && pathOnly === '/runs') {
      const page = Number(query.page) || 1, size = Number(query.size) || 20;
      const start = (page - 1) * size;
      // ★ 真平台分页对象形状（flows.jsonl:28 实测）：
      //   {records:[...], total, size, current, pages} —— 列表键是 records，不是 list。
      //   前端原来读 p.list，接真平台会直接空列表（且不报错，最难查）。
      return ok(res, {
        records: state.runs.slice(start, start + size).map(publicRun),
        total: state.runs.length, size, current: page,
        pages: Math.ceil(state.runs.length / size),
      });
    }

    if (method === 'GET' && pathOnly === '/stats') {
      if (STATS_EMPTY) return ok(res, null);
      // ★ 有效成绩判据与真平台一致：只有 CAMPUS（有 sessionId）才计入。
      //   原来的实现按 status === 'success' 统计，而 FREE 也是 success —— 
      //   假平台把 FREE 算成了有效成绩，与 api-map.md 的实测结论相反。
      // 被判无效（status 2）的记录不计入有效成绩 —— 这与真平台'提交成功但被判无效'的语义一致
      const valid = state.runs.filter((r) => r.sessionId != null && r.runType === 'CAMPUS' && r.status === 1);
      const sum = (arr, k) => +arr.reduce((a, r) => a + (Number(r[k]) || 0), 0).toFixed(2);
      const gap = Math.max(0, 18 - valid.length);
      const dist = sum(valid, 'distance'), dur = sum(valid, 'duration');
      // ★ 真形状（flows.jsonl:29 实测）：
      //   standards[].{id,label,isMet,details,standardType,standardValue,currentValue}
      //   semesterStats.{semester,totalDistance,qualifiedDistance,totalRuns,totalAttempts,totalDuration,totalCalories,avgPace}
      //   ⚠ 平台**没有** standardCurrentValue 这个键（api-map.md 记错了），标准值叫 standardValue，
      //     而 mock 原来返回的 validRuns/requiredRuns 更是前端编出来的名字。
      // ⚠ FREE 不进任何口径 —— 连 totalAttempts 都不算（api-map.md FREE 实测）。
      return ok(res, {
        currentSemesterName: '示例学期',
        standards: [{
          id: 19, label: '有效跑步次数>=18', isMet: valid.length >= 18,
          details: gap > 0 ? `还差 ${gap} 次` : '已达标',
          standardType: 'RUN_COUNT_VALID', standardValue: 18, currentValue: valid.length,
        }],
        warningInfo: { show: gap > 0, title: '学期任务未完成', description: `还差 ${gap} 次`, gap },
        semesterStats: {
          semester: '示例学期',
          totalDistance: dist, qualifiedDistance: dist,
          totalRuns: valid.length, totalAttempts: valid.length,
          totalDuration: dur, totalCalories: Math.floor(dur / 60 * 8), avgPace: dist > 0 ? Math.round(dur / dist) : 0,
        },
        overviewStats: {
          totalRuns: valid.length, qualifiedRuns: valid.length, totalDuration: dur,
          totalCalories: Math.floor(dur / 60 * 8), avgDistance: valid.length ? +(dist / valid.length).toFixed(2) : 0,
          avgPace: dist > 0 ? Math.round(dur / dist) : 0,
        },
      });
    }

    if (method === 'POST' && pathOnly === '/runs/sessions/start') {
      const id = state.nextSessionId++;
      state.sessions.set(id, { id, startedAt: new Date().toISOString(), startBody: json });
      // 真平台在 start 响应里回传本次实际校验的打卡点与半径，客户端据此生成轨迹；
      // mock 必须同样回传，否则"提交前本地复算打卡点"这条路径永远走不到真实形状。
      const cps = state.routeCache.get(Number(json?.routeId)) || state.routeCache.get(62) || [];
      return ok(res, {
        sessionId: id,               // ⚠ 纯数字：否则 server.js 的 needsSign 正则不匹配，finish 会不带签名
        selectedCheckpoints: cps.map((c, i) => ({ id: 100 + i, pointName: '打卡点' + (i + 1), latitude: c.latitude, longitude: c.longitude, seqNo: c.seqNo || i + 1 })),
        route: { id: Number(json?.routeId) || 62, name: '操场路线', passMode: 'ORDERED', startAllowedRadiusM: 100, checkpointHitRadiusM: 30 },
      });
    }

    const mFinish = /^\/runs\/sessions\/([0-9]+)\/finish$/.exec(pathOnly);
    if (method === 'POST' && mFinish) {
      const id = Number(mFinish[1]);
      if (!state.sessions.has(id)) return fail(res, 404, `会话 ${id} 不存在`);
      const sess = state.sessions.get(id);
      // 真实墙钟对账：上报名义 duration 与 start→finish 实际经过秒数之差超过容差即判无效。
      const elapsedSec = Math.max(1, Math.round((Date.now() - new Date(sess.startedAt).getTime()) / 1000));
      const declaredSec = Number(json?.duration) || 0;
      const expectedSec = declaredSec * TIME_SCALE;
      const timeCheat = STRICT_TIME && Math.abs(expectedSec - elapsedSec) > TIME_TOLERANCE_SEC;
      const audit = json?.routeData ? auditTrack(json.routeData, Number(json.distance)) : { ok: false, reason: 'finish 未带 routeData' };
      if (timeCheat) console.log(`[mock] finish 会话=${id} 计时不符：申报 ${declaredSec}s 实际 ${elapsedSec}s → status=2`);
      const rec = {
        id: state.nextRunId++, sessionId: id, runType: 'CAMPUS', status: timeCheat ? 2 : 1,   // 状态码：0=待同步 1=有效 2=无效
        invalidReason: timeCheat ? `计时不符：申报 ${declaredSec}s，实际 ${elapsedSec}s` : null,
        declaredDurationSec: declaredSec, elapsedSec,
        distance: json?.distance, duration: json?.duration, pace: json?.pace,
        calories: json?.calories, startTime: json?.startTime, endTime: json?.endTime,
        routeId: 1, routeName: '操场路线',
        snapshotUrl: `https://mock.local/snapshots/${id}.png`,
        // 以下字段真平台不返回，仅供 mock 自检与断言使用，publicRun 会剔除
        trackPoints: Array.isArray(json?.routeData) ? json.routeData.length : 0,
        trackAudit: audit,
        at: new Date().toISOString(),
      };
      state.runs.push(rec);
      state.sessions.delete(id);
      console.log(`[mock] finish 会话=${id} 申报=${json?.distance}km 实走=${audit.walkedM}m 偏差=${audit.deltaPct}% 点数=${audit.points} 峰速=${audit.maxSpeed}m/s`);
      return ok(res, publicRun(rec));
    }

    const mCancel = /^\/runs\/sessions\/([0-9]+)\/cancel$/.exec(pathOnly);
    if (method === 'POST' && mCancel) {
      const id = Number(mCancel[1]);
      const had = state.sessions.delete(id);
      return had ? ok(res, { sessionId: id, cancelled: true }) : fail(res, 404, `会话 ${id} 不存在`);
    }

    if (method === 'POST' && pathOnly === '/runs') {
      // 自由跑：单发入库，无会话。真平台行为见 api-map.md「FREE 三连」：
      //   绕过开跑窗口、保留轨迹、生成快照，但**不计入有效成绩**（靠 sessionId 缺失区分）。
      const audit = json?.routeData ? auditTrack(json.routeData, Number(json.distance)) : { ok: false, reason: '未带 routeData' };
      const rec = {
        id: state.nextRunId++, sessionId: null, runType: json?.runType || 'FREE', status: 1,
        avgHeartRate: json?.avgHeartRate === undefined ? null : json?.avgHeartRate,
        distance: json?.distance, duration: json?.duration, pace: json?.pace,
        calories: json?.calories, startTime: json?.startTime, endTime: json?.endTime,
        routeId: undefined, routeName: '自由跑',
        snapshotUrl: `https://mock.local/snapshots/${state.nextRunId - 1}.png`,
        trackPoints: Array.isArray(json?.routeData) ? json.routeData.length : 0,
        trackAudit: audit,
        at: new Date().toISOString(),
      };
      state.runs.push(rec);
      console.log(`[mock] 自由跑入库 id=${rec.id} 申报=${json?.distance}km 实走=${audit.walkedM}m 偏差=${audit.deltaPct}% 窗口=${WINDOW_CLOSED ? '关' : '开'}`);
      return ok(res, publicRun(rec));
    }

    fail(res, 404, `mock 未实现：${method} ${pathOnly}`);
  });
});

function shutdown() {
  console.log(`\n[mock] 关闭。累计请求 ${state.requests.length} 次，验签通过 ${state.signOk}，失败 ${state.signFail}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function startMock(port) {
  if (port) PORT = Number(port);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      server.removeListener('error', reject);
      console.log(`[mock] 假平台运行于 http://127.0.0.1:${PORT}`);
      console.log(`[mock] 窗口开关：${WINDOW_CLOSED ? 'closed（模拟 09:00~09:30 之外）' : 'open（runAvailableNow=true）'}`);
      if (STATS_EMPTY) console.log('[mock] KD_MOCK_STATS=empty：/stats 返回 data:null，用于验降级路径');
      console.log('[mock] 自用端点：GET /mock/log  POST /mock/reset');
      resolve(server);
    });
  });
}

// 两种用法：直接 `node tools/mock-platform.js` 独立起进程；或由 server.js 演示模式 require 后调 startMock()。
if (require.main === module) startMock().catch((e) => { console.error('[mock] 启动失败：', e.message); process.exit(1); });

module.exports = { startMock, server };
