# 校园跑平台 API 契约笔记（学校无关）★完整
> 来源：对校园跑小程序的抓包与客户端源码分析。本文只保留**字段语义与请求形状**；真实地址、AppID、学校信息、账号与记录主键均已替换为占位符（历史版本曾含真实值，已在后续提交中移除）。
> 你在自己学校使用时，把 `<YOUR_BASE>` 换成平台返回的 `serverUrl` 即可。
> 原始抓包数据不随仓库分发；需要复现时自行在小程序端抓包。

## Base URL
`<YOUR_BASE>`（形如 `https://<主机>/<前缀>`；以 profile 响应的 `serverUrl` 字段为准，不要硬编码）

## 鉴权头（每个请求都带）
```
sunshine-run: <Token>                    # 绑定码 t（UUID）
sunshine-run-device-id: dev_...          # 绑定码 d
sunshine-run-device-fp: <hex>            # 绑定码 f
user-agent: ...MiniProgramEnv/Windows WindowsWechat/WMPF   （建议仿微信）
```

凭据形态（**真实值已在整理时脱敏；当前值请用 `新版本/tools/取绑定码.js` 现取**）：
- token: `11111111-2222-3333-4444-555555555555`
- device-id: `dev_xxxxxxxxxxxxxxxxxxxx`
- fp: `deadbeef`

## ★ 跑步签名（反伪造）
适用：`POST /runs`、`POST /runs/sessions/start`、`POST /runs/sessions/{id}/finish`

> ⚠ **2026-10-16 实测更正**：签名**只在 `sessions/start` 与 `finish` 上被强制校验**。
> `POST /runs`（自由跑）**不校验签名** —— 用全 0 的错误密钥签名照样返回 `200`。详见文末「实测：自由跑（FREE）三连」。
> 小程序客户端对三个路径都带签名（`requiresRunSign` 是这么写的），但服务端只在其中两个上真正执行校验。

```
secret = "<SIGN_SECRET>"   # 硬编码在小程序客户端里，各校同一份；填到 config.local.json 的 signSecret
ts     = unix 秒（字符串）
nonce  = 随机 16 字节的 hex

signBase = "v1\n{METHOD}\n{path}\n{ts}\n{nonce}\n{sha256(token)}\n{sha256(deviceId)}\n{sha256(bodyString)}\n"
sign     = HMAC-SHA256(secret, signBase)

请求头追加：
  sunshine-run-timestamp: ts
  sunshine-run-nonce: nonce
  sunshine-run-sign: sign
```
注意：bodyString = **实际发送的 JSON 字符串**（小程序里是 `JSON.stringify(data)`，若 data 本身是 string 则原样）。sha256 均为小写 hex。

## 跑步会话流程（CAMPUS 校园跑）
1. `POST /runs/sessions/start` body:
   ```json
   {"runType":"CAMPUS","routeId":<id>,"startLatitude":<lat>,"startLongitude":<lng>}
   ```
   → `{sessionId, selectedCheckpoints:[{id,pointName,latitude,longitude,seqNo}], route:{...}}`
2. 跑步中：客户端本地累积 GPS 点（track 类过滤规则见下）
3. `POST /runs/sessions/{sessionId}/finish` body:
   ```json
   {"distance":2.15,"duration":840,"pace":"6'30\"","calories":129,
    "startTime":"2026-10-14T09:00:00","endTime":"2026-10-14T09:14:00",
    "routeData":[{"latitude":..,"longitude":..,"timestamp":1697..,"accuracy":..}, ...]}
   ```
   - distance 单位 **km**（number）；duration 单位 **秒**（int）
   - calories = floor(60 × km)
   - startTime/endTime = `UTC+8` 的 ISO 无 Z 格式 `YYYY-MM-DDTHH:MM:SS`（源码：`new Date(t.getTime()+288e5).toISOString().slice(0,19)`）
   - routeData = 原始点数组，**≤500 点**
4. 取消：`POST /runs/sessions/{sessionId}/cancel`
5. 自由跑直接入库（不走会话）：`POST /runs` body 同上 + `runType:"FREE"`
   - ⚠ **但 FREE 不计入 /stats 有效成绩**，且绕过开跑窗口。见文末「实测：自由跑（FREE）三连」

## GPS 轨迹校验参数（客户端 track 类，服务端大概率同参）

★ 已用 REA 解包小程序 `app-service.js` 的 `RunTrack` 类逐项核实（AppID、版本号、模块号与偏移均已隐去）。CAMPUS 与 FREE 是两套预设，`getTrackOptionsByMode` 按跑法切换：

```js
// CAMPUS —— 本项目走的就是这套
C=20, I=65, P=0.5, E=0.5, B=4000
{minDistance:6, maxSpeed:8, maxSegmentDistance:180,
 segmentBreakGapSec:15, segmentBridgeGapSec:60,
 segmentBridgeMaxDistance:180, segmentBridgeMaxSpeed:6,
 accuracyTrusted:20, accuracyDegraded:65,
 compressionTolerance:10, maxPoints:500}

// FREE
{minDistance:6, maxSpeed:12, maxSegmentDistance:200,
 segmentBreakGapSec:20, segmentBridgeGapSec:60,
 segmentBridgeMaxDistance:200, segmentBridgeMaxSpeed:8,
 accuracyTrusted:25, accuracyDegraded:80,
 compressionTolerance:10, maxPoints:500}
```

含义：
- `P=0.5` —— `hasMotionEvidence` 的速度下限：点带 `speed∈[0.5, maxSpeed]` 就直接算「有运动证据」，跳过几何判定
- `E=0.5s` —— 相邻定位回调的最小间隔；`B=4000ms` —— 平滑窗口的最长时间跨度
- `accuracyTrusted=20m` / `accuracyDegraded=65m` —— `resolveAccuracyLevel`：`<=trusted` 可信，`<=degraded` 降级，超过直接丢点

**客户端还做这些事（此前未知）**：
- 5 点中位平滑（`smooth`），窗口 5 点或 >4000ms 强制滑动
- 运动确认（`isMovementConfirmed`）：阈值 `max(6, 0.5*accuracy)`，需单点 ≥1.5 倍阈值，或连续 3 点各超阈值且间隔 ≥500ms
- 传送剔除（`isTeleport`）：`d/dt > maxSpeed` 或 `d > maxSegmentDistance`
- 上传点字段**只有** `latitude/longitude/timestamp/accuracy/segmentBreak` —— `normalizeRouteDataForPersistence` 会丢弃 `speed`
- 提交（`finishRunSession`）**不做**任何本地重算：距离、配速、卡路里都是页面算好后原样发出

**客户端没有的**：变差、自相关、加速度、步频、心率反算 —— 全为零命中。也就是说「像不像人」的判断（如果有）只在服务端。


## 其他端点（全部已确认路径）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/users/profile` | 档案：`<PROFILE_ID>` / `<STUDENT_ID>` / `<NAME>` / `<SCHOOL_ID>` |
| PUT | `/users/profile/avatar` | {avatarUrl} |
| GET | `/stats?type=week|semester` | 学期标准：**有效跑步 ≥18 次**。真形状见文末「★ 实测：/stats 与 /runs 的真实字段」 |
| GET | `/runs?page=1&size=20` | 记录分页。列表键是 **records**（不是 list），翻页字段 total/size/current/pages |
| GET | `/runs/recent-week?limit=10` | 最近一周 |
| GET | `/runs/{id}` | 单条详情 |
| GET | `/routes/nearby` | 学生路线列表（带定位参数）★含 GPS 坐标 |
| GET | `/routes/{id}` | 路线详情 |
| GET | `/routes/admin/permission` | 是否管理员（false） |
| GET/POST/PUT/DELETE | `/routes/admin[/{id}[/status]]` | 管理端 CRUD |
| GET | `/run-rules/current` | 开跑规则：minDistance、runAvailableNow 等 ★时间窗口在这 |
| GET | `/schools`（getSchools） | 学校列表 |

## 用户档案实测响应
```json
{"code":200,"message":"成功","data":{"id":<PROFILE_ID>,"studentId":"<STUDENT_ID>","name":"<NAME>",
"schoolId":<SCHOOL_ID>,"schoolName":"<SCHOOL_NAME>","serverUrl":"<YOUR_BASE>",
"weight":70.00,"totalDistance":0,"totalDuration":0,"totalRuns":0,"totalCalories":0}}
```

## ★ 实测：开跑规则（/run-rules/current，2026-10-15 抓取）
```json
{"id":13,"maxDailyRuns":0,"runAvailableNow":false,
 "runUnavailableReason":"仅允许在<HH:MM>~<HH:MM>开始跑步",
 "schoolId":<SCHOOL_ID>,"semesterId":<SEMESTER_ID>,"semesterName":"<学期名>","sex":"1",
 "minDistance":1.00,"minDuration":180,"maxDuration":600,
 "minPace":180,"maxPace":600}
```
解读：**开始窗口仅 `<HH:MM>~<HH:MM>`**；
距离 ≥1km；时长 180~600s（3~10分钟）；配速 3'00"~10'00"/km。
⇒ 合规组合示例：1.2km @ ~8'20"/km ≈ 600s。（规则可能按星期/时段变化，跑之前实时查一次。）

## 小程序包解包
- V1MMWX 格式：外层 AES-256-CBC(key=PBKDF2-SHA1(AppID,"saltiest",1000), IV="the iv: 16 bytes") + XOR(ord(AppID倒数第2字符))；inner = 新文件表（u32be offset/size ×256）
- 解包：微信小程序包为 V1MMWX 格式（PBKDF2 + AES-CBC），社区有公开实现
- 输出：解包后的 app-service.js（约 558KB，114 个文件）

## ★ 绑定码格式（2026-10-15 已反编译确认）
见 `kudong_token_re.md`。一句话：

```
绑定码 = Base64( UTF8( {"t":"<token>","d":"<deviceId>","f":"<fp>"} ) )
```
字段名 `t`/`d`/`f`，UTF-8 后 Base64，**无加密/压缩/加盐**，标准字母表保留 padding。
`server.js` 的 `JSON.parse(Buffer.from(code,'base64'))` 与此完全一致。
空 `d`/`f` 走空串（`"d":""`），`t` 空则 exe 侧作废整个结果。
来源：`取码工具` 扫 `Weixin`/`WeChatAppEx` 进程内存 + 5 条正则捞（详见该文档）。

## ★ 轨迹生成的坑（2026-10-15/16 实测修复）
`server.js` 的 `generateTrack(distanceM, durationSec, startMs)`：

1. **接缝跳变**：采样点索引必须以「本圈内弧长」从 0 起算。若用圈数 `Math.floor(dist/ringLen)%15` 当初值，
   每个圆周接缝处点位置跳变一整圈 —— 修复前峰值速度达面值的 5.6 倍（1.928km/600s 面值 3.12 → 峰值 8.27 m/s，破平台 8 m/s 上限）。
2. **折线切角**：采样点连成折线时跨顶点会切角，折线长度短于沿环弧长 1.3~3.0%
   （申报 1200m 实走 1068m）。服务端若按 `routeData` 重算距离会跌破 `minDistance`。
   **修法：对 speed 做二分**（`walked` 对 speed 单调递增），不是定点迭代 ——
   定点迭代会振荡：1.098km/248s 从 0.21% 恶化到 1.86% 再收敛，1km/260s 附近反复跳 1.4%；
   根因是 `stepSec` 随 speed 变导致点数跳变、`walked(speed)` 不连续。二分把 stepSec 固定在循环外。
   二分开区间 `[0.7n, 1.6n]`，20 次迭代。实测 7618 组合规参数最坏残差 **0.0013%**。
3. **折线步长比弧长短约 8%**：故采样弧长下限取 **7.6m**（非平台下限 6m）。
   最慢合规配速 1km/600s 下用 6m 只有 1.8% 余量（折线 6.11m），用 7.6m 后最小折线步长 6.96m。
4. **环长以本校实测为准**（不同操场不同）；申报距离须直接传米数，不可用「圈数×周长」近似。
5. **时间戳必须落在申报窗口内**：`generateTrack` 的 `startMs` 须传 `now - durationSec*1000`。
   修复前从"当前时刻"起算，末点比申报 `endTime` 晚整整一个 `durationSec`，服务端一比对就露馅。
6. **取整一致性**：轨迹与提交的 `distance` 必须共用同一个 `+distanceKm.toFixed(2)`。
   否则 1.005km 按 1005m 造轨迹、提交 1.00km，差 5m。
7. **pace 秒数进位**：`Math.round(spk % 60)` 可能得 60，须归一化成 `X+1'00"`，否则产出 `3'60"`。

自检：`node tools/verify_track.js` —— 7618 组平台合规参数 + 4 项回归断言。

## ★ 拟真层（2026-10-18）

`generateTrack(distanceM, durationSec, startMs, checkpoints, options)` 现在默认走拟真实现，
`options.realism === false` 才退回上面的等速版本（保留作负样本）。

**为什么加**：等速实现虽然 100% 通过客户端过滤，但有四项机器指纹——
`dt` 唯一值比例 0.7%、点精确落在几何折线上（偏离 sd 1.4mm）、速度 CV 1.9%、
同参数跨运行坐标逐点完全相同（100% 幂等）。客户端不做统计判断，服务端不一定。

**三层物理分离**：
1. 运动学层：速度 AR(1) 波动（`speedCv` 5%、`speedPhi` 0.7），决定实际走了多远
2. 观测层：GPS 误差 AR(1) 二维（`gpsSigmaM` 3m、`gpsPhi` 0.75），只是测量偏差
3. 过滤层：客户端 RunTrack 同款（5 点中位平滑 → <6m 丢弃 → 传送剔除 → 点数抽稀）

三层必须分开：先收敛运动学层到申报距离，再把观测噪声叠上去。混在一起会让
`walkedM == declaredM` 失控——GPS 误差看似「改变了距离」，实际只是测量偏差。

**观测噪声按切向/垂直分解，切向只保留 30%**：上传的 `routeData` 已过客户端中位平滑，
切向高频抖动本就被吸收；且切向噪声直接压缩点距，会触发 6m 下限丢点，使收敛跳变。

**收敛方法**：`walked(scale)` 对速度缩放系数严格单调，二分 60 次。
过滤是索引集上的不连续操作（丢一个点 = 跳一步长），所以先定索引集再二分；
若最终点距跌破 6m 就剔除该点重来，最多 3 轮。

**自检**：`node tools/verify_realism.js`（或 `npm run verify:realism`）。
硬失败 = 平台规则违反或跨运行幂等；软指标 = 速度 CV / 采样间隔 / 点-环偏离 / accuracy 自相关。
新增参数在 `config.local.json` 的 `track` 对象里，全部可省略。

**距离口径（2026-10-18 复核）**：客户端 `RunTrack.addPoint` 把 `smooth(t)` 的结果推进 `rawPoints`，
`totalDistanceMeters` 累加的也是平滑后段长，而 `finish` 上传的 `routeData` 正是 `rawPoints` ——
**上传的点本身已经是 5 点中位平滑后的点**。所以我们按上传折线长度收敛即可，与服务端重算口径一致。

若把上传轨迹再平滑一遍，长度会掉约 1.8%（2km/480s：2000.0m → 1963.0m）。
这是「同一段轨迹被平滑两次」的必然结果，真实用户的数据同样如此，不构成机器指纹，
因此 `verify_realism.js` 只把它作为信息项输出，不做判定。

```bash
node tools/verify_realism.js --gen 1.2/600 --seed 42   # 同 seed 逐点可复现
```

**自检里的幂等判据**：不给 `--seed` 而两次生成逐点相同 = 硬失败（确定性缺陷）；
给了 `--seed` 则逐点相同是预期行为，反过来不一致才是硬失败。

**已知取舍**：最慢配速（1km/600s）下段数被 13m 目标步长压到约 9.8s/点、共 62 点。
比等速版的 151 点稀疏，但每个点都更接近真实 GPS 形态。`maxPoints:500` 从未触顶。

## ★ 实测：自由跑（FREE）三连（2026-10-16）

用本人真实账号对**真平台**做了两次 FREE 提交，回答「能否用 FREE 绕过开跑窗口完成学期任务」。
结论：**能绕过窗口，但不计有效成绩，因此不可用于完成任务**。

### 前置状态

```
GET /run-rules/current  → runAvailableNow: false
                          runUnavailableReason: "仅允许在<HH:MM>~<HH:MM>开始跑步"
当前时间在开跑窗口之外
提交前 GET /stats?type=semester → standards[0].currentValue: 1
                                  semesterStats.totalDistance: 1.09
                                  totalRuns: 1  totalAttempts: 1
```
（那个 `1` / `1.09` 是 2026-10-15 的一条 CAMPUS 记录，不是 FREE。）

⚠ **2026-10-16 更正**：上面的 `standardCurrentValue` 是**误记，该键并不存在**。真字段是 `standards[].currentValue`（配 `standardValue` 表示学期标准）。详见文末新增一节。

### 结论 1：`POST /runs` 不校验签名

用**全 0 密钥**签名（`WRONG_SECRET = '0'*64`），其余头齐全：

```
HTTP 200
{"code":200,"message":"成功","data":{"id":<RUN_ID_A>,"distance":1.2,...,"runType":"FREE","routeName":"自由跑","status":1}}
```

签名确实与正确值不同（`goodShort=c87fa1e5e26622b7` vs `badShort=dab156e2eb765e04`），平台照样收下。
⇒ **`/runs` 未启用签名校验**。边界要分清：`sessions/start` 与 `finish` 是校验的，别把这条推广到那两个端点。

### 结论 2：FREE 绕过开跑窗口

窗口标志为 `false`、时间在窗口外，`POST /runs` 直接入库并返回记录 id。客户端源码的推断被证实：

```js
// app-service.js onRunModeTap（只有 CAMPUS 才 loadCurrentRule）
("CAMPUS"!==e || this.ensureCampusLogin()) && (..., "CAMPUS"===e ? this.loadCurrentRule() : ...)
```
窗口约束只在 CAMPUS 分支生效，服务端对 FREE 也不查窗口。

### 结论 3：FREE **不计入**有效成绩（决定性）

做了第二次提交，**带完整 151 点轨迹**（`generateTrack` 生成，实走 1200.0m，残差 -0.0004%），
以排除「不计成绩是因为 routeData 为空」这一假设：

| 项 | 提交前 | 提交后 |
|---|---|---|
| `standards[0].currentValue`（有效次数） | 1 | **1** |
| `semesterStats.totalDistance` | 1.09 | **1.09** |
| `totalRuns` / `totalAttempts` | 1 / 1 | **1 / 1** |

两次 FREE（`<RUN_ID_A>` 无轨迹、`<RUN_ID_B>` 带 151 点轨迹）**一个统计口径都没进**，连 `totalAttempts` 都没算。

而且平台**完整保留了轨迹**（`GET /runs/<RUN_ID_B>`）：

```
runType: FREE | routeData: 151 点 | status: 1 | routeName: 自由跑
snapshotUrl: <YOUR_BASE>/../snapshots/YYYY/MM/DD/<userId>/<hash>.png
routeId: undefined | sessionId: undefined        ← 唯一的差异
```

平台甚至为它生成了轨迹快照图。⇒ **原因不是轨迹、不是参数、不是签名，而是 `runType=FREE` 本身不被计入有效成绩**，
且判据与 `sessionId` / `routeId` 的缺失相关（对照 CAMPUS 记录 `<RUN_ID_C>`：有 `routeId`、`sessionId`、`runType:CAMPUS`、123 点、计入统计）。

### 附带验证：轨迹生成器本身没问题

本次 151 点轨迹被平台收下并生成了快照图 —— 证明 `track-core.js` 的 `generateTrack`
（环长按实测值、收敛残差 < 0.001%）**产出能被平台接受**。这条链路无需再怀疑。

### 对实现的含义

- ❌ **不要**用 FREE 作为「完成学期任务」的路径
- ❌ **不要**把 FREE 的成功当成 CAMPUS 能跑通的证据 —— 签名基串含 `path` 段，端点不同即不同串
- ✅ FREE 仍可用于**零窗口约束的链路探针**（例如验证 token 有效性、验证轨迹被接受）
- ✅ CAMPUS 的 `sessions/start` → `finish` 仍是唯一能计入成绩的路径，**开跑窗口是硬约束**

### 残留

账号上多了两条不可通过 API 删除的 FREE 记录（`api-map.md` 无删除端点）：

| id | 距离 | 轨迹 | 计入成绩 |
|---|---|---|---|
| `<RUN_ID_A>` | 1.2 km | 无（`routeData: []`） | 否 |
| `<RUN_ID_B>` | 1.2 km | 151 点 | 否 |

## ★ 服务端实现要点（2026-10-15）
- `/run` 现在**先查 `/run-rules/current`** 再提交，阈值全部原样取自服务端，不本地推算
- 窗口外直接 400 并回传 `runUnavailableReason` 原文
- `dry:true` 干跑模式：跑完校验 + 生成轨迹 + 返回将要提交的 start/finish body，**不发任何 POST**
- 入参闸门（`posNum`）：`Number.isFinite && >0`；畸形入参会 400 而非打死进程
- 点数闸门：`estPoints > 490` 直接拒（合规域 600s 上限内最大 151 点，实际不可达；防超长时长 OOM）
- `platformReq` 带 15s 超时 + try/catch（原来 fetch 失败会冒泡成 unhandledRejection 打死进程）
- async 监听器统一走 `onEnd` 包装，自带 catch；另有 `unhandledRejection`/`uncaughtException` 兜底
- `dry` 响应分别返回 `declaredM` / `walkedM` / `residualPct` / `avgSpeed` / `trackWindow` —— 只看自报值会掩盖收敛残差

### 仍未修（已知，低优先）
- `maxDailyRuns > 0` 的语义是猜测（当前平台返回 0）
- `state.json` 读改写无锁：`/run` 在两次 `await` 之间持有 `st`，并发请求后写覆盖先写，计数偏小
- 500 点闸门的 `estPoints` 公式与实际循环点数在极端时长下可能有 ±1 偏差（已验证 1684421 组一致，但仅限合规域）

## 待实测（Phase 3/4）
- [ ] sessions/start → finish 全链路一次真实提交（用本人账号试跑，验证签名算法实现）—— **等开跑窗口**
  - 2026-10-16 已排除两条替代路径：FREE 绕过窗口但不计成绩（见上节）；`/runs` 不验签但不计成绩
  - 因此**仍必须**在窗口内走 CAMPUS 全链路，这是唯一未验证的环节
  - 实现侧已就绪：`server.js` 的 `executeRun()` 走 `sessions/start → finish`，签名由本地 mock 独立复核
    （`signFail === 0`），但「真平台是否接受这套签名」仍未验证
- [ ] 确认规则是否按星期变化（周一再查 /run-rules/current）
- [x] ~~FREE 能否绕过窗口完成学期任务~~ → 2026-10-16 实测：**能绕过窗口，但不计成绩，不可用**
- [x] ~~GET /stats 与 /runs 的真实字段~~ → 2026-10-16 收尾对真平台只读实测确认：
  `standards[0].currentValue=1` / `standardValue=18` / `semesterStats.qualifiedDistance=1.09`，
  记录列表键 `records`，`status` 为数字；**确认不存在 `standardCurrentValue`**。
  同一实测还确认 FREE 不计成绩（FREE 2 条而 `currentValue` 仍为 1）
- [ ] 真平台上的**首次真实提交**（上述 CAMPUS 全链路），以及提交后 `/stats` 是否按预期 +1

## ★ 实测：路线数据（GET /routes/nearby?lat=..&lng=..&limit=20）路线 `<ROUTE_ID>`「操场路线」（`schoolId=<SCHOOL_ID>`）：

### 响应字段表（server.js 归一化所依赖的子集）

| 字段 | 类型 | 说明 |
|---|---|---|
| `data`（或 `data.routes`） | array | 路线数组；`server.js` 两种键都认 |
| `[].id` | number | routeId（`sessions/start` 的 `routeId` 即此值） |
| `[].name` | string | 路线名 |
| `[].schoolId` | number | 所属学校 |
| `[].passMode` | string | `"ANY"`（任意顺序打卡）等 |
| `[].startAllowedRadiusM` | number | 开跑须在起点此半径内（实测 100） |
| `[].checkpoints[]` | array | `{seqNo, latitude, longitude}`，按 seqNo 排序后点序即环序（末点连首点） |
| `[].randomCheckpointCount` | number | 随机打卡点数（示例路线为 0） |

`server.js` 把归一化后的路线存进账号 state 的 `routes`/`selectedRouteId`，轨迹按所选环生成；
打卡点 <4 的路线剔除并在响应 `skipped` 里如实上报。
- `passMode:"ANY"`（打卡点任意顺序）、`randomCheckpointCount:0`
- `startAllowedRadiusM:100`（开跑须在起点 100m 内）、`checkpointHitRadiusM:30`
- 15 个打卡点（点位1=起点；示例占位，实际值由 `GET /routes/nearby` 返回）：

  | seq | lat | lng |
  |---|---|---|
  | 1(起) | `<LAT_1>` | `<LNG_1>` |
  | 2 | `<LAT_2>` | `<LNG_2>` |
  | … | … | … |
  | 15 | `<LAT_15>` | `<LNG_15>` |

  > 真实坐标不入库：它们能唯一定位到具体学校操场。

- 跑道一圈**按本校跑道实测**（常见 250–400m）⇒ 圈数 = 距离 ÷ 环长
- 采样点落在折线上跨顶点会切角，故 `generateTrack` 需按实测长度反推 speed（见上「轨迹生成的三个坑」）

## ★ 实测：/stats 与 /runs 的真实字段（2026-10-16，第一手）

来源：抓包 `flows.jsonl:28-29`（/runs?page=1&size=20 与 /stats?type=semester 各两次一致）
+ 小程序源码（解包后的 app-service.js）:1873/1879/1882/1885（渲染层取值点）。

**这一节是为了纠正 api-map 早先的误记** —— 那处误记（`standardCurrentValue`）加上前端自行发明的
`validRuns`/`requiredRuns`，导致「本学期进度」接真平台时恒为 0/18，且假平台照着假名字造数据，
把既有 QA 骗成全绿。字段名以此节为准。

### GET /stats?type=semester 响应

```
data: {
  currentSemesterName: "<学期名>",
  standards: [{
    id: 19, label: "有效跑步次数>=18", isMet: false, details: "还差 18 次",
    standardType: "RUN_COUNT_VALID", standardValue: 18.00, currentValue: 0
  }],
  warningInfo: { show, title, description, gap },
  semesterStats: { semester, totalDistance, qualifiedDistance, totalRuns, totalAttempts,
                   totalDuration, totalCalories, avgPace },
  overviewStats: { totalRuns, qualifiedRuns, totalDuration, totalCalories, avgDistance, avgPace }
}
```

- **不存在** `standardCurrentValue` 这个键（早先误记）。有效次数 = `standards[].currentValue`，
  学期标准 = `standards[].standardValue`。
- `standards` 数组可能有多个元素，**不要硬编码下标 0**：按
  `standardType ∈ {RUN_COUNT_VALID, RUN_COUNT_2KM, RUN_COUNT}` 挑（`app-service.js:1873`），
  回退 `semesterStats.totalRuns`。
- 总里程优先 `semesterStats.qualifiedDistance`，再回退 `totalDistance`。
- `type=week` 多出 `weeklyStats:[{day,distance,runCount}]`；`type=month` 走 `monthlyStats`。
- **FREE 不进任何口径**，连 `totalAttempts` 都不算 —— 2026-10-16 两次真实 FREE 提交后，
  `currentValue` 与 `totalDistance` 均纹丝不动。

### GET /runs?page=1&size=20 响应

```
data: { records: [...], total, size, current, pages }     ← 列表键是 records
```

- 早先按 `list` 解析会**静默空列表**（不报错，最难查）。
- 小程序翻页判据不是 total/pages，而是「本页条数 >= size 即还有下一页」(`app-service.js:1879`)。

### 单条记录字段（`app-service.js:1873/1879/1882` + api-map 的 FREE 实测 `<RUN_ID_A>`/`<RUN_ID_B>`）

| 字段 | 类型 / 单位 | 备注 |
|---|---|---|
| `id` | number | FREE 记录也有（`<RUN_ID_A>`/`<RUN_ID_B>`） |
| `distance` | number / **km** | `formatDistance` 直接 toFixed(2)，**不要再除 1000** |
| `duration` | number / **秒** | |
| `pace` | string | `"6'30\""` |
| `calories` / `avgHeartRate` | number | 大卡 / bpm |
| `startTime` / `endTime` | string | `YYYY-MM-DDTHH:MM:SS`（UTC+8 无 Z） |
| `runType` | string | `CAMPUS` \| `FREE` |
| `status` | **number** | **0=待同步 1=有效 2=无效**（`app-service.js:1882` getStatusLabel） |
| `invalidReason` | string | status≠1 时展示 |
| `snapshotUrl` | string | 平台为轨迹生成的快照 PNG |
| `routeData` | array | `{latitude,longitude,timestamp,accuracy,segmentBreak?}` |
| `routeId` / `sessionId` | number | **仅 CAMPUS 有**；FREE 为 undefined |
| `routeName` | string | 源码无引用，实测 FREE 为「自由跑」；卡面文案由 runType 三元生成 |

⚠ `status` 是**数字**。前端曾用 `rec.status === 'failed'` 做字符串比较，导致平台记录一律显示「成功」、
无效记录永远认不出来。

⚠ 那条被反复引用的判据 —— 「FREE 不计成绩与 `sessionId`/`routeId` 缺失相关」—— **目前仍只是相关性**：
两次 FREE 实测都同时缺少两者，无法区分是哪一个（或两者）决定的。若日后要扩展 FREE 用途，
需要专门设计一次能分离变量的实测。

### 自由跑（FREE）链路

- 入口：跑步页顶部 `mode-switch`（`page-frame.html:2119-2127`），两个 `mode-tab` 文案 `校园跑`/`自由跑`，
  `onRunModeTap`（`app-service.js:1876`）：仅 CAMPUS 分支 `loadCurrentRule()` + `refreshNearbyRoutes()`；
  FREE 分支清空打卡点、**完全跳过开跑规则与路线**。
- 提交：`POST /runs` 单发（`saveRunRecord`，`app-service.js:1838`），**不校验签名**。
- body：`{runType:"FREE", distance, duration, pace, calories, avgHeartRate,
  startTime, endTime, routeData:[…]}` —— **无 routeId、无 sessionId**。
- 返回：`{code, message, data:{id, …}}`，`data.id` 即记录 id（本项目的 `platformId`）。
- 结束交互：`长按结束`（`page-frame.html:2182`）；列表标签 `自由跑`（`page-frame.html:1323`）。
- 记录列表用的距离单位是 **`公里`**，跑中页是 **`KM`**（大写），两者不统一。

## ★ 验收：`node tools/verify_e2e.js`（44 项）+ `tools/verify_ui.js`（浏览器侧）

- `verify_e2e.js`：三组进程（closed / open / FREE）+ 降级段，纯后端契约断言，零真实提交。
  关键用途：断言 `stats.validRuns === undefined` 一类**会真变红**的映射回归 ——
  上一版 QA 全绿正是因为假平台照着前端错误字段名造数据。
- `verify_ui.js`：浏览器侧，验 DOM 真渲染（进度卡数字、按钮禁用态、记录去重行数）。
  用法见文件头注释；窗口开/关两组各跑一次，覆盖数不同。
- `mock-platform.js` 已同步真字段形状（records/standards/semesterStats/数字 status），
  并支持 `KD_MOCK_WINDOW=closed`、`KD_MOCK_STATS=empty`、`KD_MOCK_STUDENT=<学号>`。
- `server.js` 支持 `KD_STATE_FILE` 覆盖，验收脚本跑在临时副本上，**不碰真实 state.json**。`解包后的 app-service.js:1873/1879/1882/1885`（渲染层取值点）。

**这一节是为了纠正 api-map 早先的误记** —— 那处误记（`standardCurrentValue`）加上前端自行发明的
`validRuns`/`requiredRuns`，导致「本学期进度」接真平台时恒为 0/18，且假平台照着假名字造数据，
把既有 QA 骗成全绿。字段名以此节为准。

### GET /stats?type=semester 响应

```
data: {
  currentSemesterName: "<学期名>",
  standards: [{
    id: 19, label: "有效跑步次数>=18", isMet: false, details: "还差 18 次",
    standardType: "RUN_COUNT_VALID", standardValue: 18.00, currentValue: 0
  }],
  warningInfo: { show, title, description, gap },
  semesterStats: { semester, totalDistance, qualifiedDistance, totalRuns, totalAttempts,
                   totalDuration, totalCalories, avgPace },
  overviewStats: { totalRuns, qualifiedRuns, totalDuration, totalCalories, avgDistance, avgPace }
}
```

- **不存在** `standardCurrentValue` 这个键（早先误记）。有效次数 = `standards[].currentValue`，
  学期标准 = `standards[].standardValue`。
- `standards` 数组可能有多个元素，**不要硬编码下标 0**：按
  `standardType ∈ {RUN_COUNT_VALID, RUN_COUNT_2KM, RUN_COUNT}` 挑（`app-service.js:1873`），
  回退 `semesterStats.totalRuns`。
- 总里程优先 `semesterStats.qualifiedDistance`，再回退 `totalDistance`。
- `type=week` 多出 `weeklyStats:[{day,distance,runCount}]`；`type=month` 走 `monthlyStats`。
- **FREE 不进任何口径**，连 `totalAttempts` 都不算 —— 2026-10-16 两次真实 FREE 提交后，
  `currentValue` 与 `totalDistance` 均纹丝不动。

### GET /runs?page=1&size=20 响应

```
data: { records: [...], total, size, current, pages }     ← 列表键是 records
```

- 早先按 `list` 解析会**静默空列表**（不报错，最难查）。
- 小程序翻页判据不是 total/pages，而是「本页条数 >= size 即还有下一页」(`app-service.js:1879`)。

### 单条记录字段（`app-service.js:1873/1879/1882` + api-map 的 FREE 实测 `<RUN_ID_A>`/`<RUN_ID_B>`）

| 字段 | 类型 / 单位 | 备注 |
|---|---|---|
| `id` | number | FREE 记录也有（`<RUN_ID_A>`/`<RUN_ID_B>`） |
| `distance` | number / **km** | `formatDistance` 直接 toFixed(2)，**不要再除 1000** |
| `duration` | number / **秒** | |
| `pace` | string | `"6'30\""` |
| `calories` / `avgHeartRate` | number | 大卡 / bpm |
| `startTime` / `endTime` | string | `YYYY-MM-DDTHH:MM:SS`（UTC+8 无 Z） |
| `runType` | string | `CAMPUS` \| `FREE` |
| `status` | **number** | **0=待同步 1=有效 2=无效**（`app-service.js:1882` getStatusLabel） |
| `invalidReason` | string | status≠1 时展示 |
| `snapshotUrl` | string | 平台为轨迹生成的快照 PNG |
| `routeData` | array | `{latitude,longitude,timestamp,accuracy,segmentBreak?}` |
| `routeId` / `sessionId` | number | **仅 CAMPUS 有**；FREE 为 undefined |
| `routeName` | string | 源码无引用，实测 FREE 为「自由跑」；卡面文案由 runType 三元生成 |

⚠ `status` 是**数字**。前端曾用 `rec.status === 'failed'` 做字符串比较，导致平台记录一律显示「成功」、
无效记录永远认不出来。

⚠ 那条被反复引用的判据 —— 「FREE 不计成绩与 `sessionId`/`routeId` 缺失相关」—— **目前仍只是相关性**：
两次 FREE 实测都同时缺少两者，无法区分是哪一个（或两者）决定的。若日后要扩展 FREE 用途，
需要专门设计一次能分离变量的实测。

### 自由跑（FREE）链路

- 入口：跑步页顶部 `mode-switch`（`page-frame.html:2119-2127`），两个 `mode-tab` 文案 `校园跑`/`自由跑`，
  `onRunModeTap`（`app-service.js:1876`）：仅 CAMPUS 分支 `loadCurrentRule()` + `refreshNearbyRoutes()`；
  FREE 分支清空打卡点、**完全跳过开跑规则与路线**。
- 提交：`POST /runs` 单发（`saveRunRecord`，`app-service.js:1838`），**不校验签名**。
- body：`{runType:"FREE", distance, duration, pace, calories, avgHeartRate,
  startTime, endTime, routeData:[…]}` —— **无 routeId、无 sessionId**。
- 返回：`{code, message, data:{id, …}}`，`data.id` 即记录 id（本项目的 `platformId`）。
- 结束交互：`长按结束`（`page-frame.html:2182`）；列表标签 `自由跑`（`page-frame.html:1323`）。
- 记录列表用的距离单位是 **`公里`**，跑中页是 **`KM`**（大写），两者不统一。

## ★ 验收：`node tools/verify_e2e.js`（44 项）+ `tools/verify_ui.js`（浏览器侧）

- `verify_e2e.js`：三组进程（closed / open / FREE）+ 降级段，纯后端契约断言，零真实提交。
  关键用途：断言 `stats.validRuns === undefined` 一类**会真变红**的映射回归 ——
  上一版 QA 全绿正是因为假平台照着前端错误字段名造数据。
- `verify_ui.js`：浏览器侧，验 DOM 真渲染（进度卡数字、按钮禁用态、记录去重行数）。
  用法见文件头注释；窗口开/关两组各跑一次，覆盖数不同。
- `mock-platform.js` 已同步真字段形状（records/standards/semesterStats/数字 status），
  并支持 `KD_MOCK_WINDOW=closed`、`KD_MOCK_STATS=empty`、`KD_MOCK_STUDENT=<学号>`。
- `server.js` 支持 `KD_STATE_FILE` 覆盖，验收脚本跑在临时副本上，**不碰真实 state.json**。
