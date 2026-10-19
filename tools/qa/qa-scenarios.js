// 校园跑自托管 · 交互验收（真实接入版）
//
// 与旧版的根本区别：旧版断言「不得出现 /bind /run /state 请求」（把前后端脱钩判为合格）；
// 本版断言「必须真的调用这些端点」。断言的符号正反了。
//
// 运行前提（两件都要在跑）：
//   1. 假平台：node tools/mock-platform.js            → 127.0.0.1:8788
//   2. 被测服务：KD_BASE=http://127.0.0.1:8788 PORT=8791 node server.js
//
// 本脚本不写任何文件，不修改被测系统；只需有一个已绑定的账号在 state.json 里。
async (page) => {
  page.setDefaultTimeout(8000);

  const BASE = 'http://127.0.0.1:8791';
  const MOCK = 'http://127.0.0.1:8788';
  const results = [];
  const requests = [];
  const errors = [];

  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const test = async (name, action) => {
    try { const detail = await action(); results.push({ name, pass: true, detail }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
  };

  page.on('request', (r) => requests.push({ method: r.method(), url: r.url() }));
  page.on('pageerror', (e) => errors.push(e.message));

  const text = async (sel) => (await page.locator(sel).textContent() || '').trim();
  const mockLog = async () => (await (await page.request.get(MOCK + '/mock/log')).json()).data;

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // ---------- 1. 前端必须真的调用后端 ----------
  await test('Frontend actually calls backend endpoints (/state /rules /records)', async () => {
    const paths = requests.map((r) => r.url.replace(BASE, ''));
    const need = ['/state', '/rules', '/records'];
    const missing = need.filter((p) => !paths.some((u) => u.startsWith(p)));
    assert(missing.length === 0, '缺少端点调用: ' + JSON.stringify(missing) + ' 实际请求: ' + JSON.stringify([...new Set(paths)]));
    return { called: need, allPaths: [...new Set(paths)] };
  });

  // ---------- 2. 旧演示痕迹必须为零 ----------
  await test('No demo-engine residue in DOM or visible text', async () => {
    const marks = ['DEMO-KD-2026', '演示模式', '星河演示学院', '可用次数', '演示用时', '校园演示路线', 'kd-liquid-glass-demo'];
    const dom = await page.content();
    const vis = await page.evaluate(() => document.body.innerText);
    const hitDom = marks.filter((m) => dom.includes(m));
    const hitVis = marks.filter((m) => vis.includes(m));
    assert(hitDom.length === 0, 'DOM 残留: ' + JSON.stringify(hitDom));
    assert(hitVis.length === 0, '可见文本残留: ' + JSON.stringify(hitVis));
    return { checked: marks.length, hitDom, hitVis };
  });

  // ---------- 3. 身份来自后端（不是硬编码） ----------
  // 注意：这里必须与后端 /state 比对，而不是与假平台 profile 比对。
  // 原因：state.json 里可能已有真实账号（此时 active 是它，页面显示的是真实姓名），
  // 绑定假账号是另一个用例。本项要证明的是「页面字段不是写死的」，故用 /state 当基准。
  await test('Identity fields come from backend /state, not hardcoded', async () => {
    const st = (await (await page.request.get(BASE + '/state')).json());
    assert(st && st.user, '/state 未返回已绑定用户');
    const shown = {
      name: await text('#user-name'),
      school: await text('#user-school'),
      sid: await text('#user-student-id'),
    };
    assert(shown.name === st.user.name, `name 不符: 页面「${shown.name}」 vs /state「${st.user.name}」`);
    assert(shown.school === (st.user.schoolName || '—'), `school 不符: 「${shown.school}」 vs 「${st.user.schoolName}」`);
    assert(shown.sid.includes(st.user.studentId), `学号不符: 「${shown.sid}」 vs 「${st.user.studentId}」`);
    // 反向证据：硬编码的旧演示身份不应出现
    assert(!/星河演示学院|DEMO-KD-2026/.test(shown.name + shown.school), '出现了旧演示身份');
    return { shown, fromState: { name: st.user.name, schoolName: st.user.schoolName, studentId: st.user.studentId }, active: st.active };
  });

  // ---------- 4. 合规提示随输入实时变化（阈值取自后端） ----------
  await test('Compliance hint follows backend thresholds in real time', async () => {
    const rules = (await (await page.request.get(BASE + '/rules')).json()).rules;
    const cases = [
      { d: 1.2, s: 600, expectOk: true },
      { d: 0.5, s: 600, expectOk: false },
      { d: 1.2, s: 1200, expectOk: false },
      { d: 1.2, s: 200, expectOk: false },
      { d: 3.0, s: 600, expectOk: true },
    ];
    const seen = [];
    for (const c of cases) {
      await page.fill('#distance-km', String(c.d));
      await page.fill('#duration-sec', String(c.s));
      await page.waitForTimeout(200);
      const msg = await text('#compliance-text');
      const disabled = await page.locator('#run-submit').isDisabled();
      const ok = /^合规/.test(msg);
      assert(ok === c.expectOk, `${c.d}/${c.s} 期望${c.expectOk ? '合规' : '不合规'}，实际「${msg}」`);
      seen.push({ input: `${c.d}/${c.s}`, ok, disabled });
    }
    return { rules, seen };
  });

  // ---------- 5. 干跑预览：必须返回完整轨迹且零提交 ----------
  await test('Dry preview returns full track and submits nothing', async () => {
    await page.fill('#distance-km', '1.2');
    await page.fill('#duration-sec', '600');
    const before = await mockLog();
    await page.evaluate(() => { document.getElementById('console-details').open = true; });
    await page.waitForTimeout(200);
    await page.click('#run-preview');
    await page.waitForFunction(() => !document.getElementById('run-preview').disabled, null, { timeout: 30000 });
    await page.waitForTimeout(600);
    const after = await mockLog();
    const out = {
      points: await text('#preview-points'),
      ring: await text('#preview-ring'),
      distance: await text('#preview-distance'),
      residual: await text('#preview-residual'),
      polylineChars: await page.evaluate(() => (document.getElementById('track-line').getAttribute('points') || '').length),
      trackVisible: await page.evaluate(() => !document.getElementById('preview-track').hidden),
      runsDelta: after.runs.length - before.runs.length,
    };
    assert(Number(out.points) > 0, '轨迹点数为 0');
    assert(out.polylineChars > 100, 'SVG polyline 没有内容: ' + out.polylineChars);
    assert(out.trackVisible, '轨迹图未显示');
    // 页面显示的是 "-0.0004 %" 这种带单位的字符串，Number() 会得 NaN，必须先剥单位
    const residual = parseFloat(String(out.residual).replace('%', '').trim());
    assert(Number.isFinite(residual), '残差无法解析: ' + JSON.stringify(out.residual));
    assert(Math.abs(residual) < 0.05, '残差过大: ' + out.residual);
    // ★ 核心断言：干跑绝不产生提交
    assert(out.runsDelta === 0, `干跑竟然产生了 ${out.runsDelta} 条提交`);
    return out;
  });

  // ---------- 6. 两步确认：取消不提交 ----------
  await test('Cancel in confirm dialog submits nothing', async () => {
    await page.fill('#distance-km', '1.2');
    await page.fill('#duration-sec', '600');
    const before = await mockLog();
    await page.click('#run-submit');
    await page.waitForTimeout(1400);
    const open = await page.evaluate(() => document.getElementById('info-dialog').open);
    assert(open, '确认框未弹出');
    const desc = await text('#info-dialog-description');
    await page.click('#info-dialog-cancel');
    await page.waitForTimeout(1600);
    const after = await mockLog();
    assert(after.runs.length - before.runs.length === 0, '取消后竟然产生了提交');
    return { desc, runsDelta: after.runs.length - before.runs.length };
  });

  // ---------- 7. 确认提交：假平台必须收到且验签通过 ----------
  await test('Confirmed submit reaches mock platform with valid HMAC signature', async () => {
    const before = await mockLog();
    await page.fill('#distance-km', '1.2');
    await page.fill('#duration-sec', '600');
    await page.click('#run-submit');
    await page.waitForTimeout(1400);
    await page.click('#info-dialog-confirm');
    await page.waitForFunction(() => /成功|失败/.test(document.getElementById('run-message').textContent || ''), null, { timeout: 40000 });
    await page.waitForTimeout(800);
    const after = await mockLog();
    const delta = after.runs.length - before.runs.length;
    assert(delta === 1, `期望新增 1 条提交，实际 ${delta}`);
    // ★ 核心断言：签名必须全部通过（假平台独立实现验签，不是回 200 就算过）
    assert(after.signFail === 0, `验签失败 ${after.signFail} 次`);
    const last = after.runs[after.runs.length - 1];
    assert(last.trackAudit && last.trackAudit.ok, '轨迹审计未通过: ' + JSON.stringify(last.trackAudit));
    assert(last.trackAudit.points <= 500, '点数超 500');
    assert(last.trackAudit.maxSpeed < 8, '峰值速度破 8 m/s: ' + last.trackAudit.maxSpeed);
    assert(last.trackAudit.minPointDist > 6, '最小点距低于 6m: ' + last.trackAudit.minPointDist);
    assert(last.trackAudit.maxGapSec <= 15, '最大间隔超 15s: ' + last.trackAudit.maxGapSec);
    assert(Math.abs(last.trackAudit.deltaPct) < 0.05, '申报与实走偏差过大: ' + last.trackAudit.deltaPct);
    return { runsDelta: delta, signOk: after.signOk, signFail: after.signFail, trackAudit: last.trackAudit };
  });

  // ---------- 8. 令牌一次性：重放必须被拒 ----------
  await test('Confirm token is single-use (replay rejected)', async () => {
    // 用页面上下文取一个新令牌，然后在页面里立刻重放两次
    const r = await page.evaluate(async () => {
      const got = await fetch('/confirm', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ distanceKm: 1.2, durationSec: 600 }),
      }).then((x) => x.json());
      const tok = got.confirmToken;
      const call = () => fetch('/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ distanceKm: 1.2, durationSec: 600, confirmToken: tok }),
      }).then(async (x) => ({ status: x.status, body: await x.json() }));
      const first = await call();
      const second = await call();
      return { first: { status: first.status, ok: first.body.ok }, second: { status: second.status, error: second.body.error } };
    });
    assert(r.first.ok === true, '首次使用令牌应当成功: ' + JSON.stringify(r.first));
    assert(r.second.status === 403, '重放应当被拒（403），实际 ' + r.second.status);
    return r;
  });

  // ---------- 9. 无令牌的真实提交必须被拒 ----------
  await test('Live submit without token is rejected', async () => {
    const r = await page.evaluate(async () => {
      const x = await fetch('/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ distanceKm: 1.2, durationSec: 600 }),
      });
      return { status: x.status, body: await x.json() };
    });
    assert(r.status === 403, '无令牌应被拒（403），实际 ' + r.status);
    return { status: r.status, error: r.body.error };
  });

  // ---------- 10. 令牌绑定参数：换参数必须失效 ----------
  await test('Token is bound to its params (mismatch rejected)', async () => {
    const r = await page.evaluate(async () => {
      const got = await fetch('/confirm', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ distanceKm: 1.2, durationSec: 600 }),
      }).then((x) => x.json());
      const x = await fetch('/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ distanceKm: 3.0, durationSec: 600, confirmToken: got.confirmToken }),
      });
      return { status: x.status, body: await x.json() };
    });
    assert(r.status === 403, '参数不吻合应被拒（403），实际 ' + r.status);
    return { status: r.status, error: r.body.error };
  });

  // ---------- 11. 记录去重：同一次跑步只出现一行，平台优先 ----------
  // ★ 2026-10-16 断言反转。旧版要求「平台与本机两行并列」，那是前后端脱钩时代的产物：
  //   本机日志与平台记录本是同一次跑步的两个视图，并列必然重复计数。
  //   现在按 sessionId（→platformId→时间戳）左连接去重，平台记录优先，
  //   本机那条只用来补平台不返回的自检字段（residualPct/trackPoints）。
  //   因此正确行为是：去重后行数 === 平台记录条数，且来源标签为「平台」。
  await test('Records dedupe by sessionId (one row per run, platform preferred)', async () => {
    await page.click('#refresh-records');
    await page.waitForTimeout(2500);
    const info = await page.evaluate(() => ({
      ids: Array.from(document.querySelectorAll('#records-list .record-id')).map((n) => n.textContent.trim()),
    }));
    const ids = info.ids;
    assert(ids.length > 0, '记录列表为空（平台已有提交记录，不应为空）');
    // 本机日志与平台记录都指向同一次提交时，只应剩一行平台行
    assert(ids.every((t) => t.startsWith('平台')), '去重后出现了非平台来源的行（同一次跑步被重复计数）: ' + JSON.stringify(ids));
    // 平台记录唯一性：同一条记录 id 不得出现两次
    const uniq = new Set(ids);
    assert(uniq.size === ids.length, '记录列表存在重复行: ' + JSON.stringify(ids));
    return { count: ids.length, sample: ids.slice(0, 6) };
  });

  // ---------- 12. 弹窗键盘焦点不逃出 ----------
  await test('Dialog keyboard focus stays inside (Tab and Shift+Tab)', async () => {
    await page.fill('#distance-km', '1.2');
    await page.fill('#duration-sec', '600');
    await page.click('#run-submit');
    await page.waitForTimeout(1200);
    const inside = async () => page.evaluate(() => {
      const a = document.activeElement;
      return { tag: a ? a.tagName : null, id: a ? a.id : null, inDialog: !!(a && a.closest('#info-dialog')) };
    });
    const seq = [];
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Shift+Tab'); await page.waitForTimeout(90); seq.push(await inside()); }
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); await page.waitForTimeout(90); seq.push(await inside()); }
    const escaped = seq.filter((s) => !s.inDialog);
    assert(escaped.length === 0, '焦点逃出弹窗: ' + JSON.stringify(escaped));
    return { steps: seq.length, escaped: escaped.length, sample: seq.slice(0, 4) };
  });

  // ---------- 13. 取消后按钮立即恢复 + 焦点回触发元素 ----------
  await test('After cancel: button re-enabled at once and focus restored', async () => {
    await page.click('#info-dialog-cancel');
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({
      disabled: document.getElementById('run-submit').disabled,
      compliance: (document.getElementById('compliance-text').textContent || '').slice(0, 30),
      focusId: document.activeElement ? document.activeElement.id : null,
      focusTag: document.activeElement ? document.activeElement.tagName : null,
    }));
    assert(st.disabled === false, '取消后按钮仍被禁用（应立刻恢复，不依赖周期刷新）');
    assert(st.focusTag !== 'BODY', '取消后焦点掉到 BODY');
    assert(/^合规|^不合规/.test(st.compliance), '取消后合规提示未重算: ' + st.compliance);
    return st;
  });

  // ---------- 14. 无未捕获脚本错误 ----------
  await test('No uncaught page errors', async () => {
    assert(errors.length === 0, '页面错误: ' + errors.join('; '));
    return { errors };
  });

  // ---------- 15. /bind 入参闸门（不实际绑定，避免污染真实账号） ----------
  // 注意：base64 必须在浏览器上下文里算（btoa），Node 侧的 Buffer 在这个执行环境里不可用。
  await test('/bind rejects malformed codes', async () => {
    const call = (code) => page.evaluate(async (c) => {
      const x = await fetch('/bind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c }) });
      return { status: x.status, body: await x.json() };
    }, code);

    const notJson = await call('not-base64!!');
    assert(notJson.status === 400, '非法绑定码应 400，实际 ' + notJson.status);
    assert(/绑定码格式不对/.test(notJson.body.error || ''), '错误文案不符: ' + notJson.body.error);

    // 合法 Base64 但缺 t：在浏览器里用 btoa 造码
    const noT = await page.evaluate(async () => {
      const code = btoa(JSON.stringify({ d: 'dev_x123456' }));
      const x = await fetch('/bind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      return { status: x.status, body: await x.json() };
    });
    assert(noT.status === 400 && /token 字段 t/.test(noT.body.error || ''), '缺 t 未拦: ' + JSON.stringify(noT.body));

    // 有 t 缺 d（客户端强制要求两者非空）
    const noD = await page.evaluate(async () => {
      const code = btoa(JSON.stringify({ t: '11111111-2222-3333-4444-555555555555' }));
      const x = await fetch('/bind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      return { status: x.status, body: await x.json() };
    });
    assert(noD.status === 400 && /device-id 字段 d/.test(noD.body.error || ''), '缺 d 未拦: ' + JSON.stringify(noD.body));

    return { notJson: notJson.status, noT: noT.status, noD: noD.status };
  });

  // ---------- 16. /schedule 创建→取消闭环（不留残留） ----------
  await test('Schedule create then cancel closes the loop', async () => {
    const r = await page.evaluate(async () => {
      const plannedAt = Date.now() + 2 * 3600 * 1000;   // +2 小时，避免调度器在测试期间触发
      const cf = await fetch('/confirm', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ distanceKm: 1.2, durationSec: 600, plannedAt }),
      }).then((x) => x.json());
      if (!cf.confirmToken) return { step: 'confirm', cf };
      const sc = await fetch('/schedule', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ distanceKm: 1.2, durationSec: 600, plannedAt, confirmToken: cf.confirmToken }),
      }).then(async (x) => ({ status: x.status, body: await x.json() }));
      const id = sc.body && sc.body.job && sc.body.job.id;
      const listed = await fetch('/schedule').then((x) => x.json());
      const found = (listed.schedules || []).some((j) => j.id === id && j.status === 'pending');
      const cancel = await fetch('/schedule/cancel', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      }).then(async (x) => ({ status: x.status, body: await x.json() }));
      const after = await fetch('/schedule').then((x) => x.json());
      const gone = !(after.schedules || []).some((j) => j.id === id && j.status === 'pending');
      return { plannedAt, created: sc.status, id, found, cancelStatus: cancel.status, cancelled: cancel.body && cancel.body.job && cancel.body.job.status, gone };
    });
    assert(r.id, '创建预约失败: ' + JSON.stringify(r));
    assert(r.found === true, '预约未出现在列表里');
    assert(r.cancelStatus === 200, '取消失败: ' + r.cancelStatus);
    assert(r.cancelled === 'cancelled', '状态不是 cancelled: ' + r.cancelled);
    assert(r.gone === true, '预约未从待执行列表移除');
    return r;
  });

  return { results, requests, errors, base: BASE, mock: MOCK };
}
