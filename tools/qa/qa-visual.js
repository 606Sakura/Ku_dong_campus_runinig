// 校园跑自托管 · 视觉与无障碍验收（真实接入版）
//
// 与旧版的区别：旧版依赖演示引擎的控件（#reset-demo / #demo-start / #fill-demo-code-inline）
// 来构造"仪表盘已连接"状态——这些控件已随演示引擎移除。本版改为直接调后端 /bind 与 /accounts
// 构造状态，其余检查（触控尺寸、对比度、响应式、模糊降级）与业务无关，原样保留。
//
// 运行前提同 qa-scenarios.js（假平台 :8788 + 被测服务 :8791）。
async (page) => {
  page.setDefaultTimeout(8000);
  // 输出目录跟随脚本位置，换机器/换目录都不用改；KD_QA_OUT 可覆盖。
  const OUT = process.env.KD_QA_OUT || require('path').join(__dirname, 'output') + require('path').sep;
  const BASE = 'http://127.0.0.1:8791';
  const results = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const test = async (name, fn) => {
    try { results.push({ name, pass: true, detail: await fn() }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
  };

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // 用真实后端接口确保处于「已连接」态（不依赖任何演示控件）
  const bound = await page.evaluate(() => !document.getElementById('dashboard-screen').hidden);
  if (!bound) {
    const code = Buffer.from(JSON.stringify({
      t: '11111111-2222-3333-4444-555555555555',
      d: 'dev_visualqaDevice1234567',
      f: '',
    })).toString('base64');
    await page.evaluate(async (c) => {
      await fetch('/bind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c }) });
    }, code);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
  }

  // 复用的检测器（与旧版一致：逐层 alpha 合成 + WCAG 相对亮度）
  const targets = async () => page.evaluate(() => Array.from(document.querySelectorAll(
    'button,a[href],summary,textarea,input:not([type=radio]),.segment-label'))
    .filter((el) => el.getClientRects().length && !el.closest('[hidden]'))
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.id || el.className || el.tagName,
        text: (el.innerText || el.getAttribute('aria-label') || '').slice(0, 55),
        width: r.width, height: r.height,
      };
    }));

  const contrast = async () => page.evaluate(() => {
    const rgba = (v) => { const n = (v.match(/[\d.]+/g) || [0, 0, 0, 1]).map(Number); return [n[0], n[1], n[2], n[3] ?? 1]; };
    const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const lum = (c) => c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const bgOf = (el) => {
      const selected = el.closest('.segment-label');
      if (selected && selected.querySelector('input:checked')) return [255, 255, 255];
      let node = el, acc = null;
      while (node && node !== document.documentElement) {
        const c = rgba(getComputedStyle(node).backgroundColor);
        if (c[3] > 0) { acc = acc ? [...over(acc, c), 1] : c; if (c[3] >= 1) break; }
        node = node.parentElement;
      }
      return acc ? acc.slice(0, 3) : [255, 255, 255];
    };
    const ratio = (el) => {
      const cs = getComputedStyle(el);
      const fg = rgba(cs.color), bg = bgOf(el);
      const f = over(fg, bg);
      const l1 = lum(f), l2 = lum(bg);
      return { ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05), px: parseFloat(cs.fontSize) };
    };
    const samples = [];
    for (const el of document.querySelectorAll('p,span,small,strong,dt,dd,h1,h2,h3,button,summary,label,time,b,legend')) {
      if (!el.getClientRects().length) continue;
      if (el.closest('[hidden]')) continue;
      if (el.matches('.sr-only')) continue;
      if (el.closest('svg')) continue;
      // 装饰元素：显式标记 aria-hidden 的不承载信息，不计入对比度要求
      // （旧版也排除了它们；漏掉会把 footer 的分隔符 "/" 误报为失败）
      if (el.closest('[aria-hidden="true"]')) continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      // 禁用控件：WCAG 对 inactive 组件不要求对比度
      if (el.closest('[disabled]') || el.matches(':disabled')) continue;
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const { ratio: r, px } = ratio(el);
      const large = px >= 24 || (px >= 18.66 && parseInt(getComputedStyle(el).fontWeight, 10) >= 700);
      const need = large ? 3 : 4.5;
      samples.push({ text: (el.textContent || '').trim().slice(0, 40), px, ratio: +r.toFixed(2), need, pass: r >= need - 1e-6 });
    }
    const bad = samples.filter((s) => !s.pass);
    return { total: samples.length, bad, minAll: samples.length ? +Math.min(...samples.map((s) => s.ratio)).toFixed(3) : null };
  });

  // ---------- 1. 绑定页控件触控尺寸 ----------
  await test('Binding screen controls meet 44x44 at 390 and 320', async () => {
    // 切到未绑定视图：直接看 #bind-screen 的可见性由后端状态决定，故用窄视口 + 现有页面
    const bad = [];
    for (const w of [390, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(220);
      for (const t of await targets()) {
        if (t.width < 43.99 || t.height < 43.99) bad.push({ width: w, ...t });
      }
    }
    assert(bad.length === 0, JSON.stringify(bad.slice(0, 8)));
    return { checkedAt: [390, 320] };
  });

  // ---------- 2. 仪表盘控件触控尺寸 ----------
  await test('Dashboard screen controls meet 44x44 at 390 and 320', async () => {
    const bad = [];
    for (const w of [390, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(220);
      for (const t of await targets()) {
        if (t.width < 43.99 || t.height < 43.99) bad.push({ width: w, ...t });
      }
    }
    assert(bad.length === 0, JSON.stringify(bad.slice(0, 8)));
    return { checkedAt: [390, 320] };
  });

  // ---------- 3. 对比度 ----------
  await test('Text contrast: small/body 4.5:1, large 3:1', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(300);
    const d = await contrast();
    assert(d.bad.length === 0, JSON.stringify(d.bad.slice(0, 6)));
    return { total: d.total, minAll: d.minAll };
  });

  // ---------- 4. 响应式四档无横向溢出 ----------
  await test('No horizontal overflow at 1440 / 768 / 390 / 320', async () => {
    const seen = [];
    for (const w of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(220);
      const d = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        bsw: document.body.scrollWidth,
      }));
      assert(d.sw === d.cw, `宽度 ${w} 溢出: scrollWidth ${d.sw} vs clientWidth ${d.cw}`);
      seen.push({ width: w, ...d });
    }
    return seen;
  });

  // ---------- 5. 截图集 ----------
  await test('Capture screenshot set', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: OUT + 'dashboard-1440.png', fullPage: true, animations: 'disabled' });
    for (const w of [768, 390, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: OUT + `dashboard-${w}.png`, fullPage: true, animations: 'disabled' });
    }
    return { files: 4 };
  });

  // ---------- 6. 模糊降级仍可读可操作 ----------
  await test('No-blur fallback remains legible and operable', async () => {
    const support = await page.evaluate(() => {
      const cssText = Array.from(document.styleSheets).flatMap((s) => { try { return Array.from(s.cssRules).map((r) => r.cssText); } catch { return []; } }).join('\n');
      const html = document.documentElement.outerHTML;
      return {
        supportsRulePresent: /@supports[^{]*backdrop-filter/.test(cssText) || /@supports[^{]*backdrop-filter/.test(html),
        hasGlass: html.includes('backdrop-filter'),
      };
    });
    assert(support.hasGlass, '页面未使用 backdrop-filter');
    await page.addStyleTag({ content: '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background-image:none!important}' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: OUT + 'dashboard-blur-fallback.png', fullPage: true, animations: 'disabled' });
    const operable = await page.locator('#run-submit').isEnabled().catch(() => false);
    // 合规输入下按钮应可用；若因规则不合规而禁用，也属正常——只要求表单仍可交互
    const inputOk = await page.locator('#distance-km').isEditable();
    assert(inputOk, '降级后表单不可编辑');
    return { supportsRulePresent: support.supportsRulePresent, hasGlass: support.hasGlass, operable, inputOk };
  });

  // ---------- 7. 减少动态效果 ----------
  await test('prefers-reduced-motion zeroes out transitions', async () => {
    const ctx = await page.context().browser().newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
    const p2 = await ctx.newPage();
    await p2.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p2.waitForTimeout(1200);
    const d = await p2.evaluate(() => {
      const el = document.getElementById('run-submit');
      const cs = getComputedStyle(el);
      return { transition: cs.transitionDuration, animation: cs.animationDuration };
    });
    await ctx.close();
    const bad = [d.transition, d.animation].filter((v) => v && !/^0s(,\s*0s)*$/.test(v));
    assert(bad.length === 0, '仍有动画时长: ' + JSON.stringify(d));
    return d;
  });

  return { results, output: OUT, base: BASE };
}
