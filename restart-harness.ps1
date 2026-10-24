param(
  [Parameter(Mandatory=$true)][string]$ExePath,
  [int]$DelaySeconds = 2,
  [string]$LogPath = ""
)
# TRANSITION SHIM — the real restart work lives in restart-harness.mjs.
#
# Why this file still exists: the Harness Host half caches its JavaScript module
# generation, so a copy of index.js that predates the windowless worker is still
# running until Harness restarts. That older copy calls THIS script by name.
# Without this shim it would fail with "restart script is missing", so the shim
# forwards to the real worker instead. Once Harness has restarted and the new
# Host half is live, nothing calls this file any more.
#
# The console window is hidden as the very first action, because PowerShell is a
# console-subsystem program and the older caller starts it through WMI, which
# cannot request CREATE_NO_WINDOW.
$ErrorActionPreference = 'Continue'

try {
  Add-Type -Name ShimHide -Namespace DshRestart -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
"@ -ErrorAction Stop
  $console = [DshRestart.ShimHide]::GetConsoleWindow()
  if ($console -ne [System.IntPtr]::Zero) { [void][DshRestart.ShimHide]::ShowWindow($console, 0) }
} catch { }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here 'launch-hidden.vbs'
$worker = Join-Path $here 'restart-harness.mjs'

if (-not (Test-Path -LiteralPath $vbs) -or -not (Test-Path -LiteralPath $worker)) {
  if ($LogPath -ne '') {
    Add-Content -Path $LogPath -Value ("{0}  shim: worker missing (vbs={1}, mjs={2})" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $vbs, $worker) -Encoding UTF8
  }
  exit 1
}

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
# wscript <launcher> <exePath> <workerPath> <logPath> <delaySeconds>
& $wscript $vbs $ExePath $worker $LogPath ([string]$DelaySeconds)
