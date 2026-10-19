// ASCII 入口别名：部分 Windows 控制台（GBK 代码页）里 .cmd 无法安全传达中文路径，
// 因此批处理统一调本文件，由它转发给真正的中文名脚本。
// 注意：取绑定码.js 的 main 只在 `require.main === module` 时执行，直接 require 不会跑，
// 所以这里用子进程转发参数与 stdio。
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const target = path.join(__dirname, '取绑定码.js');
const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
