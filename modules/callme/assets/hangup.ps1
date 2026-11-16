# 挂断当前 QQ 语音/视频通话
# 找通话窗口里的「挂断 / 退出通话 / 结束通话 / 取消」按钮并点击。
param([string]$LogFile = "")

if (-not $LogFile) { $LogFile = Join-Path $PSScriptRoot "logs\hangup.log" }

$dir = Split-Path $LogFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
function Log($m) { Add-Content -Path $LogFile -Value ("[" + (Get-Date).ToString("HH:mm:ss") + "] " + $m) -Encoding UTF8 }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$S = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

$hcSig = @'
using System;
using System.Runtime.InteropServices;
public class HC {
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
'@
if (-not ("HC" -as [type])) { Add-Type -TypeDefinition $hcSig -ErrorAction SilentlyContinue }

function Click-Element($el) {
  try {
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { $pat.Invoke(); return $true }
  } catch {}
  try {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -gt 0 -and $r.Height -gt 0) {
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
      Start-Sleep -Milliseconds 120
      [HC]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
      return $true
    }
  } catch {}
  return $false
}

$qqPids = @(Get-Process | Where-Object { $_.ProcessName -match 'QQ' } | Select-Object -ExpandProperty Id)
$wins = @()
foreach ($w in $AE::RootElement.FindAll($S::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  try {
    if (($qqPids -contains $w.Current.ProcessId) -and ($w.Current.Name -match '通话|来电|语音聊天|群语音')) { $wins += $w }
  } catch {}
}
if (-not $wins.Count) { Log "没有通话窗口"; exit 2 }
Log ("找到通话窗口：" + (($wins | ForEach-Object { $_.Current.Name }) -join " / "))

$names = @('挂断', '退出通话', '结束通话', '结束', '取消', '挂断通话')
foreach ($w in $wins) {
  $all = $w.FindAll($S::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $all) {
    try {
      if ($e.Current.ControlType -ne $CT::Button) { continue }
      $n = ($e.Current.Name -replace '\s', '')
      foreach ($t in $names) {
        if ($n -eq $t) {
          if (Click-Element $e) { Log ("已点击「" + $e.Current.Name + "」"); Start-Sleep -Milliseconds 800; exit 0 }
        }
      }
    } catch {}
  }
}
Log "通话窗口里没找到挂断按钮"
exit 3
