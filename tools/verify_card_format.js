// 绑定码格式自检：复刻取码工具的提取正则 + MakeCard 编码链
// 依据：docs/kudong_token_re.md（IL 偏移 1420-1565 / Extract 偏移 1-60）
// 运行：node tools/verify_card_format.js   —— 退出码 0 = 全部通过
const assert = require('assert');

// ---- 1. 正则直接复用 card-core.js（避免两处副本漂移）----
const { RE_TOKEN_PREFIXED, RE_DEV_PREFIXED, RE_FP_PREFIXED, RE_UUID_BARE, RE_DEV_BARE, grab, makeCard, unmake } = require('../card-core.js');

// ---- 2. 风格仿真样本（非真实凭据）----
const FAKE = {
  t: '11111111-2222-3333-4444-555555555555',
  d: 'dev_aaaaaaaaaaaaaaaaaaaa',
  f: 'deadbeef',
};
const MEMORY_BLOB = [
  `sunshine-run: ${FAKE.t}`,
  `sunshine-run-device-id: ${FAKE.d}`,
  `sunshine-run-device-fp: ${FAKE.f}`,
].join('\n');

const tests = [];
const check = (name, fn) => { try { fn(); tests.push([name, true]); } catch (e) { tests.push([name, false, e.message]); } };

// ---- 断言 ----
check('正则①带回前缀 token 命中', () => {
  assert.strictEqual(MEMORY_BLOB.match(RE_TOKEN_PREFIXED)[1], FAKE.t);
});
check('正则②带回前缀 device-id 命中', () => {
  assert.strictEqual(MEMORY_BLOB.match(RE_DEV_PREFIXED)[1], FAKE.d);
});
check('正则③带回前缀 device-fp 命中', () => {
  // 注意：fp 正则会先撞上 device-id 行的前缀吗？不会 —— 前缀字面量不同
  assert.strictEqual(MEMORY_BLOB.match(RE_FP_PREFIXED)[1], FAKE.f);
});
check('正则④裸 UUID 兜底命中（噪音包裹）', () => {
  const blob = 'x'.repeat(20) + FAKE.t + 'y'.repeat(20);
  assert.strictEqual(blob.match(RE_UUID_BARE)[1], FAKE.t);
});
check('裸模式回捞：t/d 有裸兜底，f 没有（exe 只有 5 条正则，无裸 fp 模式）', () => {
  const broken = [FAKE.t, FAKE.d, FAKE.f].join(' ');
  // 实测 exe 的 5 条正则里 t/d 各有裸兜底（④⑤），fp 只有带前缀的③
  // 所以前缀丢失时 f 拿不到 —— 这是该工具的天花板，不是 bug
  assert.deepStrictEqual(grab(broken), { t: FAKE.t, d: FAKE.d, f: null });
});
check('正则⑤裸 dev_ 兜底命中', () => {
  assert.strictEqual((`noise ${FAKE.d} noise`).match(RE_DEV_BARE)[1], FAKE.d);
});
check('三条带前缀正则互不串味', () => {
  // device-id 的正则不应在 device-fp 行上命中，反之亦然
  const fpLine = `sunshine-run-device-fp: ${FAKE.f}`;
  const devLine = `sunshine-run-device-id: ${FAKE.d}`;
  assert.strictEqual(fpLine.match(RE_DEV_PREFIXED), null);
  assert.strictEqual(devLine.match(RE_FP_PREFIXED), null);
});
check('提取链完整还原三件套', () => {
  assert.deepStrictEqual(grab(MEMORY_BLOB), FAKE);
});
check('编码链往返：字段名恰为 t/d/f', () => {
  const parsed = unmake(makeCard(FAKE.t, FAKE.d, FAKE.f));
  assert.deepStrictEqual(Object.keys(parsed).sort(), ['d', 'f', 't']);
  assert.deepStrictEqual(parsed, FAKE);
});
check('编码结果与服务端解析口径一致（server.js:126）', () => {
  const code = makeCard(FAKE.t, FAKE.d, FAKE.f);
  const creds = JSON.parse(Buffer.from(code, 'base64').toString('utf8'));
  assert.strictEqual(creds.t, FAKE.t);
  assert.strictEqual(creds.d, FAKE.d);
  assert.strictEqual(creds.f, FAKE.f);
});
check('空 d/f 兜底为空串，仍产合法 Base64', () => {
  const code = makeCard(FAKE.t, '', '');
  assert.strictEqual(Buffer.from(code, 'base64').toString('utf8'), `{"t":"${FAKE.t}","d":"","f":""}`);
  assert.doesNotThrow(() => unmake(code));
});
check('全空时 t 为空串（exe 侧会作废整个 Result）', () => {
  assert.strictEqual(unmake(makeCard('', '', '')).t, '');
});
check('码本身是 Base64 规范串（服务端解码不依赖 padding 容错）', () => {
  const code = makeCard(FAKE.t, FAKE.d, FAKE.f);
  assert.match(code, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.strictEqual(code.length % 4, 0);
});

// ---- 输出 ----
let bad = 0;
for (const [name, ok, msg] of tests) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + msg}`);
  if (!ok) bad++;
}
console.log(`\n${tests.length - bad}/${tests.length} 通过`);
process.exit(bad ? 1 : 0);
