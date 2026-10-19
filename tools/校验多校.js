// 多校绑定码校验：读 schools.json，逐条用 card-core 解码并校验字段完整性。
// --probe：额外对平台实测（把 code 绑定到本机服务的临时 state 副本，/bind 成功即平台认可）。
// 绝不碰真实 state.json。用法：node tools\校验多校.js [--probe]
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { unmake } = require('../card-core.js');
const { waitReady } = require('./lib/wait-ready.js');

const ROOT = path.join(__dirname, '..');
const fileIdx = process.argv.indexOf('--file');
const localList = path.join(ROOT, 'schools.json');
const exampleList = path.join(ROOT, 'schools.example.json');
const listPath = fileIdx >= 0 ? path.resolve(process.argv[fileIdx + 1]) : (fs.existsSync(localList) ? localList : exampleList);

let pass = 0, fail = 0, warn = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

(async () => {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(listPath, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    console.error(`读取 ${listPath} 失败：${e.message}`);
    console.error('该文件应为 JSON，形如 {"schools":[{"name":"某校","code":"<base64>"}]}');
    process.exit(1);
  }
  const schools = list.schools || [];
  if (!schools.length) {
    console.log(`${listPath} 里没有登记任何学校`);
    console.log('填法：{"schools":[{"name":"某校","code":"<取绑定码输出的 Base64>"}]}');
    process.exit(1);
  }

  const baseUrlOf = (p) => `http://127.0.0.1:${p}`;
  const probe = process.argv.includes('--probe');
  let baseUrl = null;
  if (probe) {
    // 起假平台 + 被测服务（state 指向临时副本），--probe 只证明「格式对且平台认」，不产生真实提交
    const mockPort = 8795, appPort = 8796;
    const stateFile = path.join(os.tmpdir(), `kd-schools-${process.pid}.json`);
    const mock = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-platform.js')], {
      env: { ...process.env, PORT: String(mockPort), KD_MOCK_WINDOW: 'closed' }, stdio: 'ignore',
    });
    const app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(appPort), KD_STATE_FILE: stateFile, KD_BASE: `http://127.0.0.1:${mockPort}`, KD_SIGN_SECRET: 'mock-secret-for-local-test-only' },
      stdio: 'ignore',
    });
    await waitReady(`http://127.0.0.1:${mockPort}/mock/log`, mock, [], '假平台');
    await waitReady(`${baseUrlOf(appPort)}/`, app, [], '被测服务');
    baseUrl = `http://127.0.0.1:${appPort}`;
    process.on('exit', () => { try { mock.kill(); app.kill(); fs.unlinkSync(stateFile); } catch { /* 无所谓 */ } });
  }

  console.log(`[校验] ${schools.length} 所学校\n`);
  for (const s of schools) {
    console.log(`· ${s.name}`);
    if (!s.code) { warn++; console.log('  ⚠ 未登记 code（跳过）'); continue; }
    let fields;
    try {
      fields = unmake(s.code);
      ok(typeof fields === 'object', 'Base64 解码为 JSON');
      ok(typeof fields.t === 'string' && /^[0-9a-f-]{36}$/.test(fields.t), `t=token（uuid，${(fields.t || '').length} 字符）`);
      ok(typeof fields.d === 'string' && /^dev_[0-9A-Za-z]{6,40}$/.test(fields.d), 'd=device-id（dev_ 前缀）');
      if (fields.f) ok(typeof fields.f === 'string' && fields.f.length >= 4, `f=fp（${fields.f.length} 字符）`);
      else warn++, console.log('  ⚠ f 为空（exe 的 f 无裸兜底，常见但不致命）');
    } catch (e) {
      fail++; console.log(`  ✗ 解码失败：${e.message}`); continue;
    }
    if (probe && baseUrl) {
      const r = await fetch(baseUrl + '/bind', { method: 'POST', body: JSON.stringify({ code: s.code }) }).then((x) => x.json());
      ok(r.ok === true, `probe：平台绑定实测 ${r.ok ? '通过' : '失败：' + (r.error || '')}`);
    }
    console.log('');
  }
  console.log(`结果：通过 ${pass}，警告 ${warn}，失败 ${fail}`);
  // 一条都没通过（例如只留了空模板）不能算成功——旧版在这里返回 0，CI 会当绿灯。
  if (pass === 0) {
    console.log('没有任何一条通过校验。请把 schools.example.json 复制为 schools.json，并填入真实的绑定码。');
    if (listPath === exampleList) console.log(`当前读的是示例文件：${exampleList}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
