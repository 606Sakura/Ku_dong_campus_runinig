# Scan candidate WeChat processes for memory fragments containing "sunshine-run"
# and stream them to stdout as raw text. This script holds NO regex of its own:
# extraction + Base64 live in card-core.js / the Node entry point.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File extract-token.ps1
# NOTE: kept pure ASCII on purpose -- Windows PowerShell 5.1 reads .ps1 as ANSI.
param([long]$MaxMB = 2048, [int]$ChunkKB = 4096)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MemScan {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, IntPtr mbi, IntPtr len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);

  const uint PROCESS_QUERY_INFORMATION = 0x0400, PROCESS_VM_READ = 0x0010;
  const uint MEM_COMMIT = 0x1000, PAGE_GUARD = 0x100, PAGE_NOACCESS = 0x01;
  // MEMORY_BASIC_INFORMATION is 48 bytes on x64; read fields by offset.
  // ponytail: raw offsets instead of an `out` struct -- the marshalled struct form
  // silently zeroed the buffer and made every VirtualQueryEx look like a failure.
  const int OFF_BASE = 0, OFF_REGION_SIZE = 24, OFF_STATE = 32, OFF_PROTECT = 36;

  public static string Scan(int pid, string needle, long maxBytes, int chunkBytes) {
    IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
    if (h == IntPtr.Zero) return "";
    var sb = new System.Text.StringBuilder();
    IntPtr mbi = Marshal.AllocHGlobal(64);
    var buf = new byte[chunkBytes];
    long total = 0;
    try {
      long cursor = 0;
      while (true) {
        if (VirtualQueryEx(h, (IntPtr)cursor, mbi, (IntPtr)48) == IntPtr.Zero) break;
        long baseAddr = Marshal.ReadIntPtr(mbi, OFF_BASE).ToInt64();
        long regionSize = Marshal.ReadIntPtr(mbi, OFF_REGION_SIZE).ToInt64();
        uint state = (uint)Marshal.ReadInt32(mbi, OFF_STATE);
        uint protect = (uint)Marshal.ReadInt32(mbi, OFF_PROTECT);
        if (regionSize <= 0) break;
        bool readable = state == MEM_COMMIT
          && (protect & PAGE_GUARD) == 0
          && (protect & PAGE_NOACCESS) == 0
          && protect != 0;
        if (readable) {
          long end = baseAddr + regionSize;
          for (long p = baseAddr; p < end; p += chunkBytes) {
            int want = (int)Math.Min((long)chunkBytes, end - p);
            IntPtr got;
            if (ReadProcessMemory(h, (IntPtr)p, buf, (IntPtr)want, out got) && got.ToInt64() > 0) {
              int n = (int)got.ToInt64();
              total += n;
              string s = System.Text.Encoding.UTF8.GetString(buf, 0, n);
              if (s.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
                sb.Append(s).Append('\n');
              }
            }
            if (total >= maxBytes) return sb.ToString();
          }
        }
        long next = baseAddr + regionSize;
        if (next <= cursor) break;
        cursor = next;
      }
      return sb.ToString();
    } finally { Marshal.FreeHGlobal(mbi); CloseHandle(h); }
  }
}
'@ -Language CSharp

# Smallest first: the mini-program host is usually a fresh, compact process, and
# streaming to Node means we can stop as soon as a hit is found.
$procs = @()
foreach ($n in @('WeChatAppEx', 'Weixin', 'WeChat')) {
  $procs += @(Get-Process -Name $n -ErrorAction SilentlyContinue)
}
if ($procs.Count -eq 0) {
  [Console]::Error.WriteLine('NO_WECHAT_PROCESS: open PC WeChat and the campus-run mini-program first')
  exit 2
}

$chunk = $ChunkKB * 1KB
foreach ($p in ($procs | Sort-Object -Property WorkingSet64)) {
  try {
    $text = [MemScan]::Scan($p.Id, 'sunshine-run', $MaxMB * 1MB, $chunk)
    # Only lines that actually carry the needle: the raw memory dump stays in this process.
    if ($text) { ($text -split "`n" | Where-Object { $_ -match 'sunshine-run' }) -join "`n" | ForEach-Object { [Console]::Out.Write($_ + "`n") } }
  } catch {
    [Console]::Error.WriteLine("[scan] pid $($p.Id) failed: $($_.Exception.Message)")
  }
}
exit 0
