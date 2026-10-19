// 等子进程服务就绪：既要端口能连，也要进程还活着。
// 抽出来是因为三个自检脚本原本各写了一套固定 setTimeout，慢机器上会假失败。
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1000);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return r.status;
  } catch {
    return 0;
  }
}

// proc 可以是 ChildProcess；out 是收集 stderr/stdout 的数组（可为空）
async function waitReady(url, proc, out, label, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 12000)) {
    if (proc && proc.exitCode !== null) {
      throw new Error(`${label} 启动即退出（exit ${proc.exitCode}）：` + (out || []).join('').slice(-500));
    }
    if ((await probe(url)) > 0) return true;
    await sleep(150);
  }
  throw new Error(`${label} 超时未就绪：` + (out || []).join('').slice(-500));
}

module.exports = { waitReady, sleep };
