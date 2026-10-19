// 绑定码核心：取码工具 的提取正则 + 编码链，逐字复刻
// 真源：docs/kudong_token_re.md（正则 #US 0x700000bf/0x7000016a/0x700001da/0x7000023c/0x700002ba
//       编码链 IL 1420-1565，字段名恰为 t/d/f）
// 取绑定码.js 与 tools/verify_card_format.js 共用本模块，避免双份正则。
'use strict';

const RE_TOKEN_PREFIXED = /sunshine-run[:\s]{0,6}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const RE_DEV_PREFIXED = /sunshine-run-device-id[:\s]{0,6}(dev_[0-9A-Za-z]{6,40})/i;
const RE_FP_PREFIXED = /sunshine-run-device-fp[:\s]{0,6}([0-9a-f]{4,64})/i;
const RE_UUID_BARE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const RE_DEV_BARE = /(dev_[0-9A-Za-z]{6,40})/i;

// exe 的提取逻辑：带前缀优先，失败回退裸模式。f 没有裸兜底（exe 只有 5 条正则），这是天花板不是 bug。
function grab(text) {
  const s = String(text == null ? '' : text);
  return {
    t: (s.match(RE_TOKEN_PREFIXED) || s.match(RE_UUID_BARE) || [])[1] || null,
    d: (s.match(RE_DEV_PREFIXED) || s.match(RE_DEV_BARE) || [])[1] || null,
    f: (s.match(RE_FP_PREFIXED) || [])[1] || null,
  };
}

// 编码链：concat -> UTF8 -> Base64。空值兜底为空串（IL 的 brtrue 分支）。
const makeCard = (t, d, f) =>
  Buffer.from(`{"t":"${t || ''}","d":"${d || ''}","f":"${f || ''}"}`, 'utf8').toString('base64');

const unmake = (code) => JSON.parse(Buffer.from(code, 'base64').toString('utf8'));

module.exports = {
  RE_TOKEN_PREFIXED, RE_DEV_PREFIXED, RE_FP_PREFIXED, RE_UUID_BARE, RE_DEV_BARE,
  grab, makeCard, unmake,
};
