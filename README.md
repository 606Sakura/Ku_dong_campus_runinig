# 校园跑自助工具 · campus run helper

[![CI](https://github.com/606Sakura/Ku_dong_campus_runinig/actions/workflows/ci.yml/badge.svg)](https://github.com/606Sakura/Ku_dong_campus_runinig/actions/workflows/ci.yml)

> **English TL;DR** — A zero-dependency, self-hosted helper for campus-run platforms.
> Requires Node.js ≥ 18; no `npm install`, no build step. Windows is needed only for the
> one-click "binding code" reader (it reads a WeChat mini-program's own process memory on
> your machine). Without any configuration it starts in **demo mode** against a local mock
> platform, so nothing is ever sent to a real server until you configure one.
> It never stores an account password — only the token/deviceId packed in your binding code,
> kept in a local `state.json`. The server binds to `127.0.0.1` and has no authentication;
> never expose it to a network. MIT licensed. Use at your own risk.

---

## 目录

- [这是什么 / 不做什么](#这是什么--不做什么)
- [零基础准备：装 Node.js](#零基础准备装-nodejs)
- [第一步：拿到项目](#第一步拿到项目)
- [第二步：启动（演示模式，不会提交）](#第二步启动演示模式不会提交)
- [第三步：先干跑，确认轨迹](#第三步先干跑确认轨迹)
- [第四步：接入真实平台](#第四步接入真实平台)
- [第五步：取绑定码](#第五步取绑定码)
- [第六步：日常使用](#第六步日常使用)
- [演示模式与真实模式怎么切换](#演示模式与真实模式怎么切换)
- [安全模型](#安全模型)
- [常见报错对照表](#常见报错对照表)
- [卸载与清理](#卸载与清理)
- [自检命令](#自检命令)
- [多账号 / 多校](#多账号--多校)
- [原理](#原理)
- [已知限制](#已知限制)
- [目录结构](#目录结构)
- [环境变量](#环境变量)
- [License](#license)

---

## 这是什么 / 不做什么

**是什么**：一个只在你本机运行的网页工具。它把「校园跑」提交所需的签名请求、GPS 轨迹生成、
开跑窗口排期、真实计时等待都做完，数据只写你本机的 `state.json`。

**不做什么**（请先看清，避免误会）：

- **不保存账号密码**。整个项目里没有任何登录表单或密码字段。身份凭证只有一份「绑定码」，
  里面装的是一对 `token` 与 `deviceId`，存在本机 `state.json`。
- **不提供账号、不代跑、不收款、不接单**。这是一个自托管工具，只服务你自己。
- **不保证可用**。平台接口随时可能变，规则在平台侧。

> **免责声明**：本项目仅供学习与研究。使用者自行准备账号、自行承担全部后果，包括但不限于
> 违反平台服务条款、成绩被判无效、账号受限或受到学校纪律处理。作者不承担任何责任。
> 请先确认你所在学校允许这类工具。

---

## 零基础准备：装 Node.js

只有两个前提：**Windows 电脑** + **Node.js 18 或更高**。

1. 打开 <https://nodejs.org/>，点绿色大按钮下载 **LTS** 版本（`.msi` 安装包）。
2. 双击安装包，一路点「Next」，保持默认选项，最后点「Install」。
3. 装完后**重新打开**一个命令行窗口（旧窗口读不到新装的环境变量）。
4. 验证：按 `Win + R`，输入 `cmd`，回车，然后输入：

   ```
   node -v
   ```

   应输出类似 `v22.11.0` 的版本号。**必须是 v18 或更高**。

> **不需要** `npm install`。这个项目零依赖，没有 `node_modules`，没有构建步骤。

如果 `node -v` 弹出应用商店，说明系统里装的是 Microsoft Store 的占位程序：
去「设置 → 应用 → 已安装的应用」，卸载 Node.js 后按上面步骤重装官方安装包。

---

## 第一步：拿到项目

### 方法 A：网页下载（不用装 Git，推荐给零基础用户）

1. 打开 <https://github.com/606Sakura/Ku_dong_campus_runinig>
2. 点绿色 **Code** 按钮 → **Download ZIP**。
3. 右键解压到 `Ku_dong_campus_runinig` 文件夹（放在 C 盘或 D 盘的根目录下一层即可）。

> 尽量**不要**放在 OneDrive / 坚果云 / 中文名很长的目录里。
> 同步盘会在程序写 `state.json` 时抢占文件句柄，Windows 上偶发 `EPERM`。

### 方法 B：命令行

```
git clone https://github.com/606Sakura/Ku_dong_campus_runinig.git
cd Ku_dong_campus_runinig
```

---

## 第二步：启动（演示模式，不会提交）

**双击 `启动.cmd`**。

脚本会：检查 Node 版本 → 打开浏览器 → 启动本机服务。

浏览器会自动打开 <http://127.0.0.1:8787/>。**如果显示「无法访问此网站」，等两秒刷新一次**——
浏览器可能比服务先打开。

终端窗口里应该看到：

```
校园跑 · 新版本  http://127.0.0.1:8787/
  ★ 演示模式：未配置真实平台，数据不会提交到任何平台。
  填入 config.local.json 的 baseUrl 与 signSecret 后即为真实模式（见 docs/接入新学校.md）。
  预约调度器已启动（每 5 秒一次）
```

页面顶部有一条**黄色横幅写着「演示模式」**——这说明它连着本地假平台，**不会向任何真实服务发请求**。

这个终端窗口**不要关**。关掉 = 服务停止。

### 演示模式下先熟悉一下

演示模式可以直接绑定一个假身份，把整条流程走完。在页面绑定框里粘贴这段 Base64：

```
eyJ0IjoiMTExMTExMTEtMjIyMi0zMzMzLTQ0NDQtNTU1NTU1NTU1NTU1IiwiZCI6ImRldl9hYWFhYWFhYWFhYWFhYWFhIiwiZiI6IiJ9
```

（这是 `{"t":"1111…","d":"dev_aaa…","f":""}` 的 Base64，纯假值。）

点「连接身份」，然后就能选路线、跑干跑、提交了。数据全部写在本机 `state.json`。

---

## 第三步：先干跑，确认轨迹

**干跑 = 完整生成一遍 GPS 轨迹并本地校验，但一个提交请求都不发。** 第一次用一定先走这一步。

1. 页面下方展开 **「调试 · 干跑预览」**。
2. 点 **「生成干跑预览」**。
3. 看四个数字：

| 字段 | 含义 | 正常范围 |
|---|---|---|
| `declaredM` | 你申报的距离（米） | 你填的 `距离km × 1000` |
| `walkedM` | 生成轨迹实际走过的长度（米） | 与 `declaredM` 非常接近 |
| `residualPct` | 收敛残差 = `walkedM/declaredM - 1`，百分比 | 绝对值应 **< 0.05%** |
| `checkpointHits` | 打卡点命中情况（`ORDERED` 模式下必须按顺序全中） | 全部命中 |

- `residualPct` 偏大 → 轨迹没收敛到目标长度，换一条路线或重试。
- `checkpointHits` 有未命中 → 这条路线不适合当前距离，换路线。
- 页面下方的轨迹图是形状核对用，不参与判定。

干跑同时会给出将要发送的请求体（点「查看请求体」）。看过一次，就知道真实提交长什么样。

---

## 第四步：接入真实平台

**需要两个值**：`baseUrl`（你学校平台的接口根地址）与 `signSecret`（请求签名密钥）。

### 方式 A：自动检测（推荐）

双击 **`get-bind-code.cmd`**（或中文名 `取绑定码并绑定.cmd`，两者等价）。
它会先运行 `tools/auto-config.js`，从本机微信小程序包里解出这两个值，写进 `config.local.json`，
然后才取码绑定。

前提：Windows 版微信已登录，且**打开过**你学校的校园跑小程序（至少进过一次首页）。

想先看看能不能检测到、不写文件：

```
node tools/auto-config.js --dry
```

### 方式 B：手动填

把 `config.example.json` 复制一份改名为 `config.local.json`，填四个字段：

```
copy config.example.json config.local.json
```

（`config.local.json` 已在 `.gitignore` 里，填什么都只留在本机，不会被提交。）

| 字段 | 填什么 |
|---|---|
| `baseUrl` | 平台接口根地址，例如 `https://<你的学校域名>/<路径前缀>`。**不要漏掉路径前缀** |
| `signSecret` | 64 位十六进制的签名密钥 |
| `schoolLat` / `schoolLng` | 学校操场中心的经纬度，选填 |

**关于坐标**：

- 在地图网站（高德/百度/腾讯地图）上找到你学校的操场，右键复制坐标，精确到小数点后 6 位。
- **没有坐标就留空。** 系统会先弹浏览器的定位授权，允许就用真实位置；拒绝且没填坐标时，页面会出现手输框。
- **不要填 `0` / `0`**：代码把 0 当作「未配置」，填了等于没填。

详细的字段来源见 [`docs/接入新学校.md`](docs/接入新学校.md)。

改完 `config.local.json` 后**关掉终端窗口，重新双击 `启动.cmd`**。终端里出现
`真实模式，平台 BASE = …` 且页面黄色横幅消失，就是接上了。

---

## 第五步：取绑定码

绑定码 = `Base64({"t":"<token>","d":"<deviceId>","f":"<fp>"})`。它从你本机微信小程序进程内存里读出来。

### 方式 A：页面按钮

页面点 **「一键读取微信信息」**。服务会调 PowerShell 读微信进程内存，取到码后自动填入并连接。

失败时会直接说原因：微信没登录 / 小程序没开过首页 / 需要管理员权限。

**需要管理员权限时**：关掉当前窗口 → 右键 `启动.cmd` → **以管理员身份运行** → 再点一次。

### 方式 B：命令行

双击 **`get-bind-code.cmd`**。它会自动检测平台配置、取码、直接绑定。

也可以只取码不绑定：

```
node tools/取绑定码.js
```

把输出的 Base64 串粘贴到页面绑定框。

### 取码的注意事项

- 微信要**先登录**，并把校园跑小程序**停在首页**（不是其他 tab）。
- 取码默认重试 3 次，每次约 1 秒；命令行总超时 120 秒。
- 绑定码会过期。提示「绑定码已失效」时，回小程序首页重新取一次。

---

## 第六步：日常使用

```
1. 双击 启动.cmd（已有账号会直接进仪表盘）
2. 选「校园跑 / 自由跑」，调距离与时长（默认值按平台规则推导，可改）
3. 点「提交跑步」→ 确认框点「确认提交」
```

- **在开跑窗口内**：立即建立平台会话，**真实等待满申报时长**后自动提交。
- **在窗口外**：自动排到下一个窗口起点 + 1~3 分钟，到点由本机调度器自动建立会话并计时。
- 每次提交的申报值会在合规区间内小幅浮动（距离 ±0.05km、时长 ±3%），浮动后重新校验。
  `config.local.json` 里设 `"track": { "jitter": false }` 可关闭。
- 参数本身不合规（距离/时长/配速越界）：直接拒绝，不会排队。

### 关于「真实等待」

校园跑（CAMPUS）是**会话制**：先 `POST /runs/sessions/start` 建会话，等满 `durationSec - 4s`
再 `POST /runs/sessions/{id}/finish`。平台会核对真实墙钟时间，秒完成会被判无效（`status: 2`）。

所以：

- **可以关掉浏览器页面**，会话和到点时刻都写在 `state.json` 里。
- **不能关掉终端窗口**——关掉就等于终止进程。
- 进程意外重启后会自动恢复：没到点的继续等，过了点的立即补提交。
- 超过「到点 + 60 秒」仍未提交成功，会主动撤销会话并记录原因。

---

## 演示模式与真实模式怎么切换

| | 演示模式 | 真实模式 |
|---|---|---|
| 触发条件 | `baseUrl` 为空 | 配了 `baseUrl` + `signSecret` |
| 请求发往 | 本机 `127.0.0.1:8788` 的假平台 | 你学校的平台 |
| 页面标识 | 顶部黄色「演示模式」横幅 | 无横幅 |
| 终端输出 | `★ 演示模式：未配置真实平台…` | `真实模式，平台 BASE = …` |

**怎么确认当前没连真平台**：看终端那行 `BASE =`。是 `http://127.0.0.1:8788` 就是假的。

两种模式**共用同一个 `state.json`**。从演示切到真实（或反过来）时：

1. 关掉 `启动.cmd` 的终端窗口。
2. 删除项目根目录的 `state.json`。
3. 重新双击 `启动.cmd`，重新绑定。

不删也能用，但旧账号会留在账号列表里，容易看混。

---

## 安全模型

请认真读这一节。这个工具的威胁模型很明确：**只服务本机、只信任本机**。

- 服务**只监听 `127.0.0.1`**。别的设备连不上。
- 服务**没有任何登录鉴权**。任何本机程序都能读写 `/state`、发 `/bind` 与 `/run`。
  它防的是浏览器跨站，不防本机进程。
- **不要改 `HOST`**，更不要绑定到 `0.0.0.0` 或局域网 IP。一旦这样做，同网段任何人都能
  读到你的姓名、学号、跑步记录，甚至替你提交。代码会打印警告，但不会阻止你。
- `state.json` 里是**明文**：`token`、`deviceId`、姓名、学号、学校名、精确轨迹。
  不要截图发群、不要放进同步盘、不要上传到任何网盘。
- **用完想解绑**：关掉终端，删除 `state.json` 即可。这不会撤销平台侧的凭证，只是本机不再保存。
- 在**公共电脑 / 他人电脑**上不要运行。

---

## 常见报错对照表

### 启动阶段

| 终端原文 | 原因 | 怎么修 |
|---|---|---|
| `[启动失败] 需要 Node.js >= 18，当前为 v16.x` | Node 版本太旧 | 去 <https://nodejs.org/> 装 LTS，装完重开命令行 |
| `[启动失败] 端口 8787 已被占用。关掉占用它的程序，或改配置里的 port。` | 上次的窗口没关，或别的程序占了 8787 | 关掉所有 `启动.cmd` 窗口重试；`netstat -ano \| findstr :8787` 查出 PID 后结束它；或改 `config.local.json` 的 `port` |
| `[启动失败] 演示模式的本地假平台起不来（端口 8788）` | 8788 被占用 | 同上，或改 `demoPort` |
| `[启动失败] 已配置 baseUrl 但缺少 signSecret。` | 只填了 `baseUrl` | 补 `signSecret`，或者把 `baseUrl` 清空回到演示模式 |
| `[config] 已从 config.seed.json 生成 config.local.json` | 首次启动自动复制了本地配置 | 正常，无需处理 |
| 双击 `.cmd` 窗口一闪就消失 | 脚本出错退出 | 在文件夹地址栏输入 `cmd` 回车，再手打 `启动.cmd`，这样能看到报错 |

### 取码阶段

| 页面/终端提示 | 原因 | 怎么修 |
|---|---|---|
| `没找到微信进程` | 电脑微信没开 | 登录 Windows 版微信 |
| `需要管理员权限` | 读不到微信进程内存 | 右键 `启动.cmd` → 以管理员身份运行 |
| 取码超时（120 秒） | 小程序没停在首页 | 在微信里把校园跑小程序切回首页，再点一次 |
| `绑定码已失效，请回到小程序首页重新取码` | 码过期或平台拒绝 | 回小程序首页，重新取码 |
| `无法连接校园平台，请检查网络` | 网络不通或 `baseUrl` 写错 | 检查网络；核对 `baseUrl` 有没有漏路径前缀 |
| `该账号未开通校园跑，或学校暂不支持` | 平台返回 404 | 确认这个账号在本校确实开通了 |

### 提交阶段

| 提示 | 原因 | 怎么修 |
|---|---|---|
| `不符合平台规则` | 距离/时长/配速超出区间 | 页面会显示平台上下限，按它改 |
| `轨迹本地校验未通过` | 点距/峰速/点数不合阈值，或打卡点没全中 | 换一条路线；先用「干跑预览」看 `checkpointHits` |
| 提交后记录迟迟不出现 | 校园跑要真实等满时长（8~15 分钟） | 正常，别关终端窗口 |
| 平台记录 `status: 2` | 平台判定无效（多半是墙钟时间对不上） | 确认提交后没有立刻重启/撤销会话 |
| `会话超时未提交，已撤销` | 到点后 60 秒内没提交成功（多半网络） | 重新提交一次 |
| 任务卡在 `running` | 进程被杀过 | 重启服务，启动时会把遗留任务重置为 `pending` |
| `state.json` 损坏 | 同步盘 / 断电 | 服务会备份为 `state.json.corrupt-<时间戳>`，重新绑定即可 |

### 杀毒软件拦截（很常见）

这个项目的取码流程会：PowerShell 内联编译 C#、读其他进程内存、解密小程序包。
行为特征与凭据窃取工具高度重合，而且所有脚本都没有数字签名。**被杀毒软件拦截是预期内的。**

表现：`extract-token.ps1` 被删、`Add-Type` 编译被拒、`node.exe` 被隔离、
`tools/auto-config.js` 读 `%APPDATA%` 被阻止。

处理：把项目目录加入杀毒软件的**排除项 / 白名单**，然后重新解压一份（被隔离的文件需要恢复）。

### 定位相关

| 现象 | 原因 | 怎么修 |
|---|---|---|
| 页面不弹定位授权 | Windows 位置服务关闭 | 设置 → 隐私和安全性 → 位置，打开「位置服务」和「让桌面应用访问你的位置」 |
| 定位超时后出现手输框 | 浏览器拿不到位置 | 手输经纬度，或按第四步填 `schoolLat` / `schoolLng` |
| 用局域网 IP 打开页面时无法定位 | 非安全上下文，浏览器直接拒绝 | 用 `http://127.0.0.1:8787/` 访问 |

---

## 卸载与清理

1. 关掉 `启动.cmd` 的终端窗口。
2. 删除项目目录里的 `state.json`（等于本机解绑）。
3. 想彻底清空配置：删除 `config.local.json`。
4. 想完全卸载：直接删掉整个项目文件夹。不会残留注册表或系统服务。

端口占用清理：`netstat -ano | findstr :8787` 查到 PID 后 `taskkill /PID <PID> /F`。

---

## 自检命令

项目自带 9 个自检脚本，全部跑在临时目录的 `state` 副本上，**不碰你的真实账号**：

```
npm test
```

| 脚本 | 检查内容 |
|---|---|
| `tools/verify_card_format.js` | 13 项：绑定码正则与编码链 |
| `tools/verify_track.js` | 7618 组合规网格：轨迹不变量 |
| `tools/verify_guard.js` | 19 项：打卡点复算、轨迹硬阈值、申报值浮动后仍合规 |
| `tools/verify_window.js` | 17 项：开跑窗口解析与排期落窗 |
| `tools/verify_e2e.js` | 69 项端到端（自动起假平台 + 被测服务，跑完自关） |
| `tools/verify_timing.js` | 21 项：真实计时、断点续跑、过期会话撤销、失败分类 |
| `tools/verify_auto_config.js` | 10 项：小程序包解包与配置提取（含歧义不猜） |
| `tools/verify_coldstart.js` | 22 项：零配置冷启动全流程 |
| `tools/check-secrets.js` | 敏感信息扫描（学号/手机号/非白名单域名/长密钥/经纬度对/本机路径） |

全部通过时，每个脚本都会打印 `结果：通过 N 项，失败 0 项`。

浏览器侧验收（可选，需要 Playwright，**当前不保证通过**——UI 断言与页面结构有已知脱节）：

```
npx @playwright/cli --version
npx playwright install chromium
cd tools/qa
.\run-qa.ps1
```

---

## 多账号 / 多校

平台按 `schoolId` 区分学校，协议共用，**换学校不需要改代码**。

- **自己的多个账号**：每个账号各取一次绑定码，在页面「切换身份」里重新绑定即可。
- **登记多所学校**（仅本机备忘）：复制 `schools.example.json` 为 `schools.json`，逐条填 `name` + `code`。

  ```
  node tools/校验多校.js
  node tools/校验多校.js --probe     ← 绑定到临时 state 副本，不碰真实账号
  ```

`schools.json` 不入库（已忽略）。

---

## 原理

**绑定码**：`Base64(UTF8({"t":"<token>","d":"<deviceId>","f":"<fp>"}))`，无加密无加盐。
`t` / `d` 以明文存在于微信小程序进程内存，取码本质是「读进程内存 + 正则捞」。

```
tools/取绑定码.js      Node 入口：流式读子进程输出，命中即停，绝不落盘
  └─ tools/extract-token.ps1   内联 P/Invoke 读微信内存
                               （OpenProcess / VirtualQueryEx / ReadProcessMemory），只做粗筛
       └─ card-core.js         5 条正则 + Base64 编码链（取码器与自检共用，只有一份）
```

**签名**：三个提交路径带 HMAC-SHA256，签名基串为 8 段 `\n` 连接：

```
v1 \n METHOD \n path \n ts \n nonce \n sha256(t) \n sha256(d) \n sha256(body) \n
```

字段语义与完整接口形状见 [`docs/api-map.md`](docs/api-map.md)。

**轨迹**：按所选路线的打卡点环生成，点距 ≥ 6m、速度 ≤ 8m/s、间隔 ≤ 15s、总点数 ≤ 500，
总长收敛到申报距离（偏差 < 0.05%）。算法只依赖环的边长，与具体学校无关。

**默认跑量**：从平台规则推导，不是硬编码。距离按性别取 2.0km / 1.5km，
时长 = 距离 × 配速区间中值，再夹进平台的 `[minDuration, maxDuration]`。

---

## 已知限制

- **自由跑（FREE）不计入学期有效成绩**，只能用来绕开开跑窗口。
- **取码仅 Windows**：需要读取 Windows 版微信进程内存。macOS / Linux 能跑服务与页面，
  但只能粘贴在别处取到的绑定码。
- **设备指纹字段常为空**：已确认它不参与签名，但平台是否校验该请求头未知。
- **每日上限只按本机日志统计**：换机器或换 `state.json` 后判据会失真。
- **校园跑要真实等待**：这是平台规则决定的，不能「秒完成」。
- **他校未实测**：协议路径各校相同，但只有作者所在学校跑通过。

---

## 目录结构

```
.
├── server.js              服务器：绑定、规则、干跑、提交、自动排期、调度器
├── index.html             前端（单文件内联，零外部资源）
├── card-core.js           绑定码正则与编码链（取码器与自检共用）
├── bind-wizard.js         一键取码（流式 NDJSON）与本地诊断的端点实现
├── track-core.js          轨迹生成（三层拟真 + 客户端过滤复刻）与校验的纯模块
├── run-guard.js           提交前本地校验：打卡点复算、轨迹硬阈值、申报值浮动
├── config.example.json    配置模板
├── config.seed.json       可选的本地配置模板（不入库；首次启动复制为 config.local.json）
├── state.example.json     状态文件模板
├── schools.example.json   多校登记表模板（复制为 schools.json 后填写）
├── 启动.cmd               双击启动（检查 Node 版本 → 开浏览器 → 起服务）
├── get-bind-code.cmd      双击取码并绑定（纯 ASCII 入口）
├── 取绑定码并绑定.cmd     同上，转发到 get-bind-code.cmd
├── docs/
│   ├── api-map.md         平台接口契约（地址与学校信息已占位符化）
│   ├── kudong_token_re.md 绑定码格式逆向笔记（第三方工具的程序标识与正则出处）
│   └── 接入新学校.md       如何填写 baseUrl / signSecret / 绑定码
├── tools/
│   ├── mock-platform.js   本地假平台（演示模式内嵌使用，也可独立启动）
│   ├── auto-config.js     从小程序包解出 baseUrl / signSecret 写入 config.local.json
│   ├── 取绑定码.js        取码入口
│   ├── get-bind-code.js   取码入口的 ASCII 别名（供 .cmd 调用）
│   ├── extract-token.ps1  读微信内存的内联 P/Invoke
│   ├── verify_*.js        自检脚本
│   ├── 校验多校.js        多校绑定码校验
│   ├── check-secrets.js   敏感信息扫描
│   └── qa/                浏览器侧验收（可选，需 Playwright）
└── .github/workflows/ci.yml
```

`state.json`、`config.local.json`、`config.seed.json`、`schools.json` 都只在本地存在，不进版本库。

---

## 环境变量

配置优先级：**环境变量 > `config.local.json` > `config.example.json` > 内置默认**。
日常使用只需 `config.local.json`，环境变量主要用于脚本与测试。

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。默认只绑本机——这个服务持有真实 token |
| `KD_BASE` | 空 | 平台地址；留空即演示模式 |
| `KD_SIGN_SECRET` | 空 | 请求签名密钥；配了 `baseUrl` 就必须同时配它 |
| `KD_SCHOOL_LAT` | 空 | 学校操场纬度，浏览器定位失败时的兜底 |
| `KD_SCHOOL_LNG` | 空 | 学校操场经度，同上 |
| `KD_STATE_FILE` | `state.json` | 状态文件路径，自检脚本靠它隔离 |
| `KD_DEMO_PORT` | `8788` | 演示模式假平台端口 |
| `KD_TICK_MS` | `5000` | 调度器扫描周期 |
| `KD_SUBMIT_MARGIN_MS` | `4000` | 提前提交的余量，补偿网络往返 |
| `KD_TIME_SCALE` | `1` | 仅验收/演示用：压缩等待时长。生产保持 1 |

另有 `AC_SCHOOLS_FILE`（多校登记表路径）与 `KD_MOCK_*` 系列（假平台专用），日常不需要设置。

> 注意：`启动.cmd` 会把 `HOST` 固定为 `127.0.0.1`，会覆盖你在系统环境变量里设的值。

---

## License

[MIT](LICENSE) © 2026 campus-run contributors
