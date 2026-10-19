# 校园跑自托管 · QA 驱动
#
# 起两个进程再跑验收：
#   1. 假平台 tools/mock-platform.js  → 127.0.0.1:8788（独立实现 HMAC 验签）
#   2. 被测服务 server.js（KD_BASE 指向假平台）→ 127.0.0.1:8791
#
# 与旧版的根本区别：本脚本会启动服务，而不是假设它已经在跑；
# 且交互验收的网络断言已从「不得调用 /bind /run /state」反转为「必须调用」。
param(
  # 空 = 自动探测。别再写死绝对路径：换机器 / 清 npm cache / Playwright 升版都会让旧值失效。
  [string]$Cli = '',
  [int]$MockPort = 8788,
  [int]$AppPort = 8791
)
$ErrorActionPreference = 'Stop'
# ★ 2026-10-16 修：PowerShell 5.1 默认用系统 ANSI（本机是 GBK）解码子进程输出。
# node 输出的是 UTF-8，中文经 GBK 解码后变乱码，还会吃掉一个字节（例："...闄?"）。
# 后果不只是显示难看：ConvertFrom-Json 会抛异常，脚本在「交互验收」之后、
# 「视觉验收」之前直接退出 —— 表现为 static-checks.json 不更新、视觉套件根本没跑，
# 而交互验收其实是全过的。必须显式把控制台与管道都设为 UTF-8。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$qaRoot = $PSScriptRoot
$kd = Split-Path -Parent (Split-Path -Parent $qaRoot)   # 仓库根（客户端平铺在根）
$repo = $kd
Set-Location -LiteralPath $qaRoot

if (-not $Cli) {
  $Cli = (Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx') -Recurse -Filter 'playwright-cli.js' -ErrorAction SilentlyContinue |
          Select-Object -First 1 -ExpandProperty FullName)
}
if (-not $Cli -or -not (Test-Path -LiteralPath $Cli)) { throw '找不到 playwright-cli.js。请先执行一次：npx @playwright/cli --version（或传入 -Cli <path>）' }
Write-Host "[qa] playwright-cli = $Cli"
$Chrome = (Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'ms-playwright') -Recurse -Filter 'chrome.exe' -ErrorAction SilentlyContinue |
          Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName)
if (-not $Chrome) { throw '找不到 chromium。请先执行：npx playwright install chromium' }
Write-Host "[qa] chromium = $Chrome"

# ---- 生成运行时 config：模板(无硬编码) + 运行时探测到的 chromium 与输出目录 ----
$cfgTemplate = Get-Content -LiteralPath (Join-Path $qaRoot 'qa-cli.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $launch = $cfgTemplate.browser.launchOptions
  $launch = $launch | Add-Member -NotePropertyName executablePath -NotePropertyValue $Chrome -PassThru
  $cfgTemplate.browser.launchOptions = $launch
$cfgTemplate.outputDir = (Join-Path $qaRoot 'output')
New-Item -ItemType Directory -Force -Path $cfgTemplate.outputDir | Out-Null
$qaConfig = Join-Path ([System.IO.Path]::GetTempPath()) ('kd-qa-cfg-' + [Guid]::NewGuid().ToString('N').Substring(0,8) + '.json')
[System.IO.File]::WriteAllText($qaConfig, ($cfgTemplate | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding $false))
Write-Output "runtime config: $qaConfig"

$mockProc = $null
$appProc = $null
try {
  # ---- 起假平台 ----
  $mockProc = Start-Process -PassThru -NoNewWindow -FilePath 'node' `
    -ArgumentList (Join-Path $kd 'tools\mock-platform.js') -WorkingDirectory $kd
  Start-Sleep -Milliseconds 1200
  if (-not (Test-NetConnection -ComputerName '127.0.0.1' -Port $MockPort -InformationLevel Quiet -WarningAction SilentlyContinue)) {
    throw "假平台未在 $MockPort 监听"
  }

  # ---- 起被测服务，BASE 指向假平台 ----
  # ★ 2026-10-16 修：本脚本原先只设 KD_BASE / PORT，没设 KD_STATE_FILE —— 于是
  #    交互验收建的预约、提交的跑步全部写进真实 state.json。
  #    平台侧无法删除记录（api-map.md 无删除端点），一脏就是永久的。
  #    这里强制把 state 指到临时副本，脚本自己造、自己清。
  $qaState = Join-Path ([System.IO.Path]::GetTempPath()) ('kd-qa-' + [Guid]::NewGuid().ToString('N').Substring(0,8) + '.json')
  # 副本保留账号绑定（qa-scenarios.js 需要一个已绑定账号），但清空 runs/schedules/tokens ——
  # 否则上一次验收留下的本机记录会混进记录列表，把去重类断言打成假阳性。
  $seed = Join-Path $kd 'state.json'
  $seedJs = @"
const fs = require('fs');
const st = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
for (const k of Object.keys(st.accounts || {})) {
  st.accounts[k].runs = [];
  st.accounts[k].schedules = [];
  // 跨校改造后 CAMPUS 提交需要已选路线（server.js 如实拒绝无路线提交）。
  // 种子注入一条 8 点虚构环，坐标与 mock-platform.js 的路线无关——QA 只断言轨迹不变量。
  const cps = [];
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * 2 * Math.PI;
    cps.push([0 + 0.0006 * Math.sin(a), 0 + 0.0008 * Math.cos(a)]);
  }
  st.accounts[k].routes = [{ routeId: 61, name: 'QA环', checkpoints: cps, ringLenM: 590, passMode: 'ANY', fetchedAt: new Date().toISOString() }];
  st.accounts[k].selectedRouteId = 61;
}
st.tokens = {};
fs.writeFileSync(process.argv[2], JSON.stringify(st, null, 2));
const a = st.accounts[st.active];
console.log(a ? ('active=' + st.active + ' name=' + (a.user && a.user.name)) : 'no active account');
"@
  if (Test-Path -LiteralPath $seed) {
    node -e $seedJs $seed $qaState
  } else {
    '{"schemaVersion":2,"active":null,"accounts":{},"tokens":{}}' |
      Set-Content -LiteralPath $qaState -Encoding UTF8
  }
  $qaStateAbs = (Resolve-Path -LiteralPath $qaState).Path
  Write-Output "isolated state: $qaStateAbs"
  $env:KD_BASE = "http://127.0.0.1:$MockPort"
  $env:KD_SIGN_SECRET = "mock-secret-for-local-test-only"
  $env:PORT = "$AppPort"
  $env:KD_STATE_FILE = $qaStateAbs
  $appProc = Start-Process -PassThru -NoNewWindow -FilePath 'node' `
    -ArgumentList (Join-Path $kd 'server.js') -WorkingDirectory $kd
  Start-Sleep -Milliseconds 1500
  if (-not (Test-NetConnection -ComputerName '127.0.0.1' -Port $AppPort -InformationLevel Quiet -WarningAction SilentlyContinue)) {
    throw "被测服务未在 $AppPort 监听"
  }
  Write-Output "services up: mock=$MockPort app=$AppPort"

  # ---- 交互验收 ----
  & node $Cli -s=qa close
  & node $Cli -s=qa open "http://127.0.0.1:$AppPort/" --config $qaConfig
  & node $Cli -s=qa snapshot
  & node $Cli -s=qa run-code --filename (Join-Path $qaRoot 'qa-scenarios.js') | Tee-Object -FilePath (Join-Path $qaRoot 'qa-cli-transcript.txt')
  $qaTranscript = Get-Content -LiteralPath (Join-Path $qaRoot 'qa-cli-transcript.txt') -Raw -Encoding UTF8
  $qaLine = ($qaTranscript -split "`r?`n" | Where-Object { $_ -like '{"results":*' } | Select-Object -Last 1)
  if (-not $qaLine) { throw 'QA result object missing; inspect qa-cli-transcript.txt.' }
  # 用 WriteAllText 写无 BOM 的 UTF-8：Set-Content -Encoding utf8 在 PS 5.1 下会加 BOM，
  # 下游（node require / JSON.parse）遇到 BOM 会报 "Expected ',' or '}'" —— 正是这个坑。
  [System.IO.File]::WriteAllText((Join-Path $qaRoot 'qa-results.json'), $qaLine, (New-Object System.Text.UTF8Encoding $false))
  $qaReport = $qaLine | ConvertFrom-Json
  $qaFailures = @($qaReport.results | Where-Object { -not $_.pass })
  if ($qaFailures.Count -gt 0) {
    throw ('交互验收失败: ' + (($qaFailures | ForEach-Object { "$($_.name) → $($_.error)" }) -join '; '))
  }

  # ---- 视觉与无障碍验收 ----
  & node $Cli -s=qa run-code --filename (Join-Path $qaRoot 'qa-visual.js') | Tee-Object -FilePath (Join-Path $qaRoot 'qa-visual-transcript.txt')
  $visualTranscript = Get-Content -LiteralPath (Join-Path $qaRoot 'qa-visual-transcript.txt') -Raw -Encoding UTF8
  $visualLine = ($visualTranscript -split "`r?`n" | Where-Object { $_ -like '{"results":*' } | Select-Object -Last 1)
  if (-not $visualLine) { throw 'Visual QA result object missing.' }
  [System.IO.File]::WriteAllText((Join-Path $qaRoot 'qa-visual-results.json'), $visualLine, (New-Object System.Text.UTF8Encoding $false))
  $visualReport = $visualLine | ConvertFrom-Json
  $visualFailures = @($visualReport.results | Where-Object { -not $_.pass })
  if ($visualFailures.Count -gt 0) {
    throw ('视觉验收失败: ' + (($visualFailures | ForEach-Object { "$($_.name) → $($_.error)" }) -join '; '))
  }

  # ---- 网络断言汇总（反转后的核心结论） ----
  $calledPaths = @($qaReport.requests | ForEach-Object { ([uri]$_.url).AbsolutePath } | Sort-Object -Unique)
  $required = @('/state', '/rules', '/records', '/bind', '/confirm', '/run', '/preview', '/schedule')
  $missing = @($required | Where-Object { $p = $_; -not ($calledPaths | Where-Object { $_ -like "$p*" }) })
  $summary = [ordered]@{
    interactivePass  = @($qaReport.results).Count
    visualPass       = @($visualReport.results).Count
    calledPaths      = $calledPaths
    requiredMissing  = $missing
    requestCount     = @($qaReport.requests).Count
    pageErrors       = @($qaReport.errors).Count
  }
  # 同样写无 BOM UTF-8（BOM 会让下游 JSON.parse 直接报错）
  [System.IO.File]::WriteAllText((Join-Path $qaRoot 'static-checks.json'),
    ($summary | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))

  Write-Output ("交互验收 {0} 项通过；视觉验收 {1} 项通过" -f @($qaReport.results).Count, @($visualReport.results).Count)
  Write-Output ("已调用的后端端点: " + ($calledPaths -join ', '))
  if ($missing.Count -gt 0) { throw ("以下必需端点未被调用到，覆盖不足: " + ($missing -join ', ')) }
  Write-Output '注意：仍须人工过一遍 qa-report.md 里的「局限」一节，不要只看通过数。'
}
finally {
  if ($appProc)  { Stop-Process -Id $appProc.Id  -Force -ErrorAction SilentlyContinue }
  if ($mockProc) { Stop-Process -Id $mockProc.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item Env:KD_BASE -ErrorAction SilentlyContinue
  Remove-Item Env:PORT    -ErrorAction SilentlyContinue
  Remove-Item Env:KD_STATE_FILE -ErrorAction SilentlyContinue
  if ($qaConfig) { Remove-Item -LiteralPath $qaConfig -Force -ErrorAction SilentlyContinue }
  # 连带清掉副本与 server.js 自己写的 .bak.json
  if ($qaStateAbs) {
    Remove-Item -LiteralPath $qaStateAbs -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath ($qaStateAbs -replace '\.json$', '.bak.json') -Force -ErrorAction SilentlyContinue
  }
  Write-Output 'services stopped'
}
