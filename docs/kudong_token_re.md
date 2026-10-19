# 取码工具 逆向笔记 ★绑定码格式已确认

> 样本：`<样本程序路径>`（不随本仓库分发）
> 方法：REA MCP `inspect_managed_artifact` + `inspect_managed_members`（IL 锚点）+ 手工解析 PE CLI metadata `#US` 用户字符串堆
> 结论日期：2026-10-15

## 0. 一句话结论

**绑定码 = Base64( UTF8( `{"t":"<token>","d":"<deviceId>","f":"<fp>"}` ) )**

字段名确为 `t` / `d` / `f`，**无二次加密、无压缩、无加盐**。
⇒ `server.js` 的 `JSON.parse(Buffer.from(code,'base64').toString('utf8'))` **与 exe 完全一致，无需修改**。

## 1. Artifact 身份

| 项 | 值 |
|---|---|
| SHA-256 | `<REDACTED>`（样本程序不随本仓库分发） |
| MVID | `8b2fb2db-52c2-4911-ba89-9a71d29f2a7c` |
| Assembly | `<工具名>` 0.0.0.0，无强名称 |
| 运行时 | .NET v4.0.30319，CIL-only（`il-only` flag） |
| 容器 | PE32 x86，3 段，Managed Arch = anycpu |
| 元数据 | `#~` 3216B，`#Strings` 3740B，`#US` 2056B，`#Blob` 1468B |
| 规模 | 9 TypeDef / 36 MethodDef / 49 Field / 163 MemberRef |
| 引用 | mscorlib, System.Windows.Forms, System.Drawing, System.Core, System |
| 入口 | `0x06000001 TokenTool::Main`（`[STAThread]`） |

**是 .NET WinForms 程序，不是 pyinstaller / 不是加壳。** 早先「UTF-16 字符串提取出现乱序交错」是误判 —— 那是把整个文件按 UTF-16 强解得到的假象，`#US` 堆解析后字符串完全正常。

类型清单：
```
TokenTool   主逻辑（Main / EnsureDesktopShortcut / ScanAndExtractContexts / Extract + 4 个 P/Invoke）
MBI               MEMORY_BASIC_INFORMATION（VirtualQueryEx 用）
Result            {string Token; string DeviceId; string Fp}
MainForm          UI（MakeCard / CopyText / OnStart / 一堆控件）
RoundButton       自绘圆角按钮
<>c__DisplayClass12 / 17、<OnStart>d__19   编译器生成
```

## 2. 绑定码构造链（核心）

方法：`MainForm+<OnStart>d__19::MoveNext`，IL 偏移 1420–1565。
`MainForm::MakeCard(int,int,int,int)` 只是 UI，**不产码**（4 个 i4 参数，纯画画/布局）；产码在异步状态机里。

逐条对应（`#US` 偏移为运行时字符串堆的真实偏移）：

| IL 偏移 | 指令 | 操作数 | 实际字符串 |
|---|---|---|---|
| 1420 | `newarr` | `0x01000014` | `string[]` |
| 1430 | `ldstr` | `0x70000720` | `{"t":"` |
| 1440 | `ldfld` | `0x04000008` | `Result::Token` |
| 1454 | `ldstr` | `0x7000072e` | `","d":"` |
| 1464 | `ldfld` | `0x04000009` | `Result::DeviceId` |
| 1475 | `brtrue.s` | →1483 | 非空则跳过 |
| 1478 | `ldstr` | `0x700002ea` | *(空串)* |
| 1487 | `ldstr` | `0x7000073e` | `","f":"` |
| 1497 | `ldfld` | `0x0400000a` | `Result::Fp` |
| 1508 | `brtrue.s` | →1516 | 非空则跳过 |
| 1511 | `ldstr` | `0x700002ea` | *(空串)* |
| 1520 | `ldstr` | `0x7000074e` | `"}` |
| 1528 | `call` | `0x0a00008a` | `String.Concat(string[])` |
| 1533 | `stfld` | `0x0400002c` | `<json>5__20` |
| 1539–1544 | `call` | `0x0a00008b` | `Encoding::get_UTF8()` |
| 1550–1555 | `callvirt` | `0x0a000015` | `Encoding::GetBytes(string)` |
| 1560 | `call` | `0x0a00008c` | `Convert::ToBase64String(byte[])` |
| 1565 | `stfld` | `0x04000019` | `MainForm::lastCode` |

三个要点：

1. **空值兜底走空串**，不是跳过字段、不是用 `lastCode` 或 `(默认)`。
   所以 `d` 或 `f` 缺失时产出 `{"t":"...","d":"","f":""}`，仍是合法 Base64。
2. **`lastToken` 是另一个字段**（`0x0400001a`，偏移 1587 单独赋值 `res.Token` 原样，不编码），与码无关。
3. **`CopyText` 有 `IsNullOrEmpty` 守卫**（`MainForm::CopyText` il_size 34：偏移 2 `call IsNullOrEmpty` → 12 `brtrue.s` 跳过 18 的 `SetText`）。
   即**空码不写剪贴板**；非空码才写。偏移 1593–1609 的调用点本身无 if。

### 2.1 无加密证据

全程序扫描：`Convert::ToBase64String` **只出现 1 次**（偏移 1560）、`Encoding::get_UTF8` **只出现 1 次**（偏移 1539）。
代码中不存在 `FromBase64String` / `GZip` / `Deflate` / `SHA*` / `MD5` / `HMAC` / `Aes` / `Rijndael` / `CryptoStream` 的任何引用。

⇒ **无哈希、无加密、无压缩、无加盐、无签名**。标准 Base64 字母表，保留 `=` padding。

## 3. 凭据提取链（读微信内存）

### 3.1 进程发现

`<US>` 0x700005d4 = `Weixin`，0x700005e2 = `WeChatAppEx`
两个进程名找进程 → `OpenProcess(1040, 0, pid)`（`0x410` = `PROCESS_QUERY_INFORMATION|PROCESS_VM_READ`）

### 3.2 内存遍历

`TokenTool::ScanAndExtractContexts`：

```
VirtualQueryEx 遍历地址空间
  filter: State == MEM_COMMIT (4096)
          且 (Protect 通过 PAGE_* 掩码 255/256 判定)
一次分配 4194304 字节（4MB）缓冲
ReadProcessMemory 分块读入
逐字节 UTF-8 解码为 string，>=200 字节起判
逐窗口（步长 400）匹配正则
```

失败路径与成功路径共用同一套扫描逻辑，只是没命中正则；本文不复述第三方程序的具体文案。

### 3.3 五条正则（`TokenTool::Extract`，逐字）

五条 `ldstr` + `newobj Regex`，偏移 1/13/25/37/49，对应 `#US`：

```js
// 1. 带前缀的 token        #US 0x700000bf
/sunshine-run[:\s]{0,6}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
// 2. 带前缀的 device-id    #US 0x7000016a
/sunshine-run-device-id[:\s]{0,6}(dev_[0-9A-Za-z]{6,40})/i
// 3. 带前缀的 device-fp    #US 0x700001da
/sunshine-run-device-fp[:\s]{0,6}([0-9a-f]{4,64})/i
// 4. 裸 UUID（兜底）       #US 0x7000023c
/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
// 5. 裸 dev_（兜底）       #US 0x700002ba
/(dev_[0-9A-Za-z]{6,40})/i
```

匹配策略：先试带前缀的（1/2/3），失败则回退到裸模式（4/5）。结果依次填入 `Result.Token` / `DeviceId` / `Fp`（`stfld 0x04000008/9/a`，偏移 167/247/303）。
`t` 为空则整个 `Result` 丢掉（偏移 320–328：`ldfld Token; brtrue`）。

### 3.4 其余用户可见文案（`#US`）

```
<工具名> / <快捷方式名>.lnk / WScript.Shell
① 仅读取本机微信进程内存，不联网、不上传任何数据；已自动在桌面创建快捷方式
杀毒软件如提示误报，请选择「信任 / 允许运行」
点击开始后，在电脑微信里打开「校园跑小程序」小程序并停在首页
首次使用建议先在小程序面板里删除它，再重新搜索打开，触发全新登录
查找微信进程 / 扫描微信内存 / 提取 token 信息 / 生成并复制绑定码
✓ 提取成功，绑定码已复制到剪贴板 / 复制绑定码 / 复制 Token / 约 10~60 秒
token: {t}  设备: {d|(默认)}   指纹: {f|(默认)}
```
显示层对空 `d`/`f` 显示 `(默认)`（`0x7000076e`），但**该占位不进码**，码里是空串。

## 4. 对本项目的影响

| 位置 | 原假设 | 实测 | 动作 |
|---|---|---|---|
| `server.js:126` | `Base64({"t","d","f"})` | ✅ 完全一致 | **不改** |
| `server.js:128` | 缺 `t` 报错 | ✅ exe 也要求 `t` 非空 | 不改 |
| `api-map.md` 凭据段 | 三件套 `t/d/f` | ✅ 字段名一致 | 不改 |

## 5. 独立交叉验证（2026-10-15）

结论由**两个独立分析方各自得出**，方法不同（一方 REA MCP + `#US` 堆手工解析；一方按 RVA 逐字节扫描 fat header + IL 交叉验证 `0x72` 前缀的 ldstr token 集合），结果逐项吻合：

| 断言 | 本方 | 独立方 | 一致 |
|---|---|---|---|
| 构造点在 `MoveNext` 而非 `MakeCard` | ✅ | ✅ | ✅ |
| 字段名 `t`/`d`/`f` | ✅ | ✅ | ✅ |
| UTF8 → Base64，无其它变换 | ✅ | ✅ | ✅ |
| `d`/`f` 为空走空串 | ✅ | ✅ | ✅ |
| `t` 非空才产出 | ✅ | ✅ | ✅ |
| `#US` 0x70000720 载荷 `7b 00 22 00 74 00 22 00 3a 00 22 00 00` | ✅ | ✅ | ✅ |

**唯一一处分歧已修正**：本方初稿写「无条件复制剪贴板」，独立方指出 `CopyText` 内部有 `IsNullOrEmpty` 守卫。经复核 IL（`CopyText` il_size 34，偏移 2 `IsNullOrEmpty` → 12 `brtrue.s` 跳过 `SetText`），**独立方正确**，本文档第 2 节已改正。

## 6. 未能确定的部分（诚实标注）

- `Extract` 的 `for` 循环里对 `MatchCollection` 的选择顺序（5 条正则谁覆盖谁）未逐条反汇编确认。仅确证：`t` 为空则整个 `Result` 作废（偏移 320–328 `ldfld Token; brtrue`），故走到构造点时 `t` 必非空。
- `PAGE_*` 掩码判定（常量 255 / 256）的精确语义未反汇编确认。
- 4MB 分块与 200/400 的窗口步长关系未完全推导（可能是重叠滑窗防跨块漏匹配）。
- 该 exe 是**第三方工具**，非官方小程序包。其正则依赖微信把 HTTP 头以明文留在进程内存里 —— 平台或微信改版即失效。这是它的天花板，不是我们的。
