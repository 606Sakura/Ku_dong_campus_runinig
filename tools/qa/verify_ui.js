// 浏览器侧验收（零依赖，用现成的 playwright-cli run-code 跑）：验「UI 上真的显示了真数据」。
// 后端 44 项断言验的是 JSON 契约，验不到 DOM —— 而用户要的恰恰是界面对得上平台。
//
// 用法（mock 与服务需先起来，见 run-qa.ps1 或手工两行）：
//   node <playwright-cli.js> -s=qa open http://127.0.0.1:8791/ --config output/playwright/qa-cli.config.json
//   node <playwright-cli.js> -s=qa run-code --filename tools/qa/verify_ui.js
//
// ⚠ run-code 只接受「单个 async (page) => {...} 表达式」，顶层不许有语句。
async (page) => {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, pass: Boolean(ok), detail });
    if (!ok) console.log('✗ ' + name + ' → ' + JSON.stringify(detail));
    else console.log('✓ ' + name);
  };
  const BASE = 'http://127.0.0.1:8791';
  // run-code 的沙箱里没有 setTimeout：等页面用 page.waitForTimeout
  const sleep = (ms) => page.waitForTimeout(ms);
  const txt = async (sel) => (await page.locator(sel).textContent().catch(() => null)) || '';
  const vis = async (sel) => page.locator(sel).isVisible().catch(() => false);
  const txtOf = async (fn) => await page.evaluate(fn);

  // 先清平台侧记录：否则上一轮残留会让「有效次数」等绝对断言失去意义
  await page.request.post('http://127.0.0.1:8788/mock/reset', { data: {} });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await sleep(800);

  // ---- 绑定（用 e2e 用的固定码） ----
  // 沙箱里没有 Buffer，绑定码直接给算好的字面量：Base64(UTF8("{\"t\":\"ui-token-0000\",\"d\":\"dev_ui\",\"f\":\"\"}"))
  const code = 'eyJ0IjoidWktdG9rZW4tMDAwMCIsImQiOiJkZXZfdWkiLCJmIjoiIn0=';
  // 已经绑定过就直接进面板（重复跑本脚本时 state 里已有账号）
  if (await page.locator('#bind-screen').isVisible()) {
    await page.fill('#bind-code', code);
    await page.click('#bind-submit');
  }
  await page.waitForSelector('#dashboard-screen:not([hidden])', { timeout: 15000 });
  await sleep(2000);

  // ---- 1. 学期进度卡必须显示平台真值，而不是本机条数 ----
  // 此刻平台无记录 → 有效 0、标准 18、还差 18。若前端仍读 validRuns，这里会显示本机日志条数。
  // 平台侧刚 reset：有效次数应为 0（若前端仍读本机日志条数，这里必红）
  check('U1 有效次数显示平台值 0', (await txt('#quota-available')).trim() === '0', await txt('#quota-available'));
  check('U2 学期标准显示 18（不是 — 也不是 5）', (await txt('#quota-reserved')).trim() === '18', await txt('#quota-reserved'));
  check('U3 还差 18 次', (await txt('#quota-remaining')).trim() === '18', await txt('#quota-remaining'));
  check('U4 总里程为 0.00 km', (await txt('#quota-distance')).trim() === '0.00', await txt('#quota-distance'));
  check('U5 进度说明引用平台口径', /平台统计/.test(await txt('#quota-note')), await txt('#quota-note'));

  // ---- 2. 自由跑入口 ----
  check('U6 路线维度含自由跑选项', await page.locator('input[name="route-mode"][value="free"]').count() === 1);
  await page.check('input[name="route-mode"][value="free"]');
  await sleep(400);
  check('U7 切到自由跑后标题改为「安排一次自由跑」', /自由跑/.test(await txt('#run-title')), await txt('#run-title'));
  check('U8 自由跑下合规提示标注不计成绩', /不计.*学期.*成绩|不计入学期有效成绩/.test(await txt('#compliance-text')), await txt('#compliance-text'));
  check('U9 自由跑下提交按钮可用（不受窗口限制）', await page.locator('#run-submit').isEnabled());
  check('U10 自由跑下预约被收起并强制立即提交',
    await page.locator('#schedule-fields').isHidden()
    && await page.locator('input[name="run-mode"][value="now"]').isChecked());

  // ---- 3. 窗口外：校园跑 + 预约不该被连坐 ----
  await page.check('input[name="route-mode"][value="campus"]');
  await sleep(400);
  const windowClosed = /不在开跑窗口/.test(await txt('#compliance-text'));
  if (windowClosed) {
    check('U11 窗口外校园跑立即提交：提示窗口并禁用提交', !(await page.locator('#run-submit').isEnabled()),
      { text: await txt('#compliance-text') });
    check('U12 窗口外提供「改用预约」按钮且可见', await vis('#switch-schedule-window'));
  } else {
    check('U11 校园跑窗口内：提示合规且按钮可用',
      /^合规/.test(await txt('#compliance-text')) && await page.locator('#run-submit').isEnabled(),
      await txt('#compliance-text'));
    check('U12 窗口内不显示「改用预约」（无意义入口不出现）', !(await vis('#switch-schedule-window')));
  }

  if (windowClosed) {
    // 决策 19：点它应切到预约、把时间预填到平台原文里的窗口起点
    await page.click('#switch-schedule-window');
    await sleep(500);
    const v = await page.inputValue('#schedule-datetime');
    check('U13 改用预约后切换到预约模式', await page.locator('input[name="run-mode"][value="scheduled"]').isChecked());
    check('U14 预约时间预填到窗口起点 09:00', /T09:00$/.test(v), v);
    check('U15 预约模式下提交按钮恢复可用（不再被窗口连坐）', await page.locator('#run-submit').isEnabled(),
      { text: await txt('#compliance-text') });
    check('U16 预约模式下不再提示窗口不合规（只校验参数）', !/不在开跑窗口/.test(await txt('#compliance-text')),
      await txt('#compliance-text'));
  } else {
    check('U13-U16 跳过（当前 mock 窗口为开）', true, { note: 'closed 组才有区分度' });
  }

  // 对话框等待包一层：等不到就把页面提示读出来当诊断，而不是抛出、把上下文全丢掉
  const dialogUp = async () => {
    try { await page.waitForSelector('#info-dialog[open]', { timeout: 6000 }); return true; }
    catch { return false; }
  };

  // ---- 4. 立即提交一次校园跑，看记录与进度是否更新（mock 窗口需为 open 才有意义） ----
  await page.check('input[name="route-mode"][value="campus"]');
  await page.check('input[name="run-mode"][value="now"]');
  await sleep(400);
  if (await page.locator('#run-submit').isEnabled()) {
    await page.click('#run-submit');
    const up = await dialogUp();
    check('U17a 校园跑点击后弹出确认框', up,
      { msg: await txt('#run-message'), comp: await txt('#compliance-text') });
    if (up) {
    await page.click('#info-dialog-confirm');
    await sleep(4000);
    const quota = (await txt('#quota-available')).trim();
    check('U17 提交后有效次数变为平台返回值 1', quota === '1', { quota });
    const note = await txt('#quota-note');
    check('U18 进度说明显示平台 label/details', /有效跑步次数>=18/.test(note), note);
    // 记录去重：本机日志与平台记录同一次跑步，只应出现一行
    const ids = await txtOf(() => Array.from(document.querySelectorAll('#records-list .record-id')).map((n) => n.textContent.trim()));
    check('U19 记录列表按 sessionId 去重（同一次跑步只一行）', ids.length === 1, ids);
    check('U20 该行来源标为「平台」', ids.length > 0 && ids[0].startsWith('平台'), ids);
    const statuses = await txtOf(() => Array.from(document.querySelectorAll('#records-list .status')).map((n) => n.textContent.trim()));
    check('U21 平台记录状态显示「有效」而非「成功」/「失败」', statuses[0] === '有效', statuses);
    const dist = await txtOf(() => Array.from(document.querySelectorAll('#records-list .record-stat')).map((n) => n.textContent.trim()));
    check('U22 记录距离单位为 km 且取自真字段', dist.some((s) => /1\.2\s*km/.test(s)), dist);
    }
  } else {
    check('U17-U22 跳过（窗口关，按钮按设计被禁用）', true, { note: 'closed 组符合预期' });
  }

  // ---- 5. 自由跑提交一次，验证「不计成绩」在界面上说清楚 ----
  await page.check('input[name="route-mode"][value="free"]');
  await sleep(400);
  await page.click('#run-submit');
  await dialogUp();
  // 说明文案在 caption 元素（description 只放参数摘要）
  const cap = (await txt('#info-dialog-caption')) + ' | ' + (await txt('#info-dialog-description'));
  check('U23 自由跑确认框明确说明不计成绩', /不计入学期有效成绩/.test(cap), cap);
  await page.click('#info-dialog-confirm');
  await sleep(4000);
  check('U23a 自由跑提交有结果提示', /提交成功|失败|无法取得/.test(await txt('#run-message')), await txt('#run-message'));
  check('U24 进度卡出现自由跑小字行', await vis('#quota-free'), await txt('#quota-free'));
  check('U25 自由跑小字标注不计成绩', /不计入学期成绩/.test(await txt('#quota-free')), await txt('#quota-free'));
  // FREE 不进 standards[].currentValue：有效次数必须还是「校园跑那一步的值」
  // （窗口内提交过校园跑 → 1；窗口关时校园跑压根没提交 → 0）
  const expectedValid = windowClosed ? '0' : '1';
  const quotaAfter = (await txt('#quota-available')).trim();
  check('U26 自由跑后有效次数不变（FREE 不计成绩）', quotaAfter === expectedValid, { quotaAfter, expectedValid });
  const total = await txtOf(() => document.querySelectorAll('#records-list .record-id').length);
  const expectedRows = windowClosed ? 1 : 2;   // 窗口关时只有 FREE 一条
  check('U27 记录去重后条数正确（CAMPUS 有则 2，无则 1）', total === expectedRows, { total, expectedRows });
  const freeLine = await txt('#quota-free');
  check('U28 自由跑小字给出次数', /自由跑/.test(freeLine) && /[0-9]+/.test(freeLine), freeLine);

  // ---- 6. 跑步进度条 ----
  // 校园跑改成真实计时后，进度条只在"进行中的会话"上出现；上面提交的是**自由跑**，
  // 它是单发、没有会话，所以落定后应当显示 100% 已提交，而不是一条还在走的进度。
  // （会话进度由 verify_timing.js 在服务端侧断言，这里只验自由跑这条静态终态。）
  const CUR = '#current-task ';
  const wOf = () => page.locator(CUR + '[data-role="progress"]').evaluate((el) => el.style.width).catch(() => null);
  const pctOf = (v) => parseFloat(String(v).replace('%', ''));
  check('U29 当前任务卡显示刚落定的自由跑',
    /自由跑/.test(await txt(CUR + '[data-role="title"]')), await txt(CUR + '[data-role="title"]'));
  check('U30 徽章为「已完成」且色调为 success',
    (await txt(CUR + '[data-role="status"]')).trim() === '已完成'
    && (await page.locator(CUR + '[data-role="status"]').getAttribute('data-status')) === 'success',
    { text: await txt(CUR + '[data-role="status"]') });
  check('U31 里程/配速行可见（不是 hidden）', await vis(CUR + '[data-role="pace"]'));
  const paceText = await txt(CUR + '[data-role="pace-text"]');
  check('U32 里程行给出已提交里程', /1\.2 km · 已提交/.test(paceText), paceText);
  check('U33 自由跑（无会话）不显示进行中进度：data-live=0',
    (await page.locator(CUR + '.task-progress').getAttribute('data-live')) === '0');
  check('U34 进度条停在 100%（已落定，不再移动）', pctOf(await wOf()) === 100, await wOf());
  await sleep(1500);
  check('U35 1.5 秒后进度不变（没有假装在跑）', pctOf(await wOf()) === 100, await wOf());
  await page.reload({ waitUntil: 'networkidle' });
  await sleep(1500);
  check('U36 刷新后仍是已完成终态', pctOf(await wOf()) === 100, await wOf());

  const failed = results.filter((r) => !r.pass);
  return { results, passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.name) };
}
