# 主动打 QQ 语音通话：UI 自动化打开聊天 -> 点「语音通话」
# 用法：powershell -ExecutionPolicy Bypass -File call-out.ps1 [-Contact "花辞树"]
param(
  [string]$Contact = "",
  [string]$Invite = "",    # 群通话里要一起拉进来的人（昵称，逗号分隔）
  [string]$InviteQQ = "",  # 同顺序对应的 QQ 号（昵称重名时用它精确搜索）
  [int]$WaitMs = 1500,
  [switch]$DryRun
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$sig = @'
using System;
using System.Runtime.InteropServices;
public class Win32Click {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(50);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
'@
if (-not ("Win32Click" -as [type])) { Add-Type -TypeDefinition $sig }

$AE = [System.Windows.Automation.AutomationElement]
$S = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

function Log($m) {
  $line = "[{0}] {1}" -f (Get-Date).ToString("HH:mm:ss"), $m
  Write-Host $line
  $logDir = Join-Path $PSScriptRoot "logs"
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
  Add-Content -Path (Join-Path $logDir "call-out.log") -Value $line -Encoding UTF8
}

function Click-Element($el) {
  try {
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
      $pat.Invoke(); return $true
    }
  } catch {}
  try {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -gt 0 -and $r.Height -gt 0) {
      [Win32Click]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
      return $true
    }
  } catch {}
  return $false
}

function Find-All($root) {
  return $root.FindAll($S::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}

# 1) 找 QQ 主窗口（跳过登录小窗、频道窗等）
$qqPids = @(Get-Process | Where-Object { $_.ProcessName -match 'QQ' } | Select-Object -ExpandProperty Id)
$roots = $AE::RootElement.FindAll($S::Children, [System.Windows.Automation.Condition]::TrueCondition)
$qqWin = $null
foreach ($w in $roots) {
  try {
    if (($qqPids -contains $w.Current.ProcessId) -and $w.Current.Name -eq 'QQ' -and $w.Current.ClassName -eq 'Chrome_WidgetWin_1') { $qqWin = $w; break }
  } catch {}
}
if (-not $qqWin) { Log "没找到 QQ 主窗口（QQ 未登录？）"; exit 2 }
if (-not $Contact) { Log "没指定联系人（-Contact 为空）"; exit 7 }
Log "找到 QQ 主窗口"

# 2) 确认当前聊天对象；不是的话，在会话列表里点开
$all = Find-All $qqWin
$hasVoiceBtn = $false
$contactSeen = $false
foreach ($e in $all) {
  try {
    $n = $e.Current.Name
    if ($n -eq '语音通话') { $hasVoiceBtn = $true }
    if ($n -eq $Contact) { $contactSeen = $true }
  } catch {}
}

function Name-Score($name) {
  # 0 = 不匹配；越大越像。群名在会话列表里可能被截断成「前几个字…」，所以支持前缀/包含。
  try {
    if (-not $name) { return 0 }
    if ($name -eq $Contact) { return 3 }
    if ($name.StartsWith($Contact)) { return 2 }
    if ($Contact.Length -ge 2 -and $name.Contains($Contact)) { return 1 }
  } catch {}
  return 0
}

# 2) 先在会话列表里点开目标（不论当前开的是谁——避免拨错人）
$target = $null; $best = 0
foreach ($e in $all) {
  try {
    $score = Name-Score $e.Current.Name
    if ($e.Current.ControlType -ne $CT::Text) { $score = $score + 0.5 }
    if ($score -gt $best) { $target = $e; $best = $score }
  } catch {}
}
if (-not $target) { Log "会话列表里找不到「${Contact}」，请先手动打开一次和 TA 的聊天"; exit 3 }
if (Click-Element $target) { Log ("已点击会话「" + $target.Current.Name + "」") } else { Log "点不开会话项"; exit 4 }
Start-Sleep -Milliseconds $WaitMs

# 3) 点「语音通话」
$all2 = Find-All $qqWin
$callBtn = $null
foreach ($e in $all2) {
  try { if ($e.Current.Name -eq '语音通话' -and $e.Current.ControlType -eq $CT::Button) { $callBtn = $e; break } } catch {}
}
if (-not $callBtn) {
  foreach ($e in $all2) {
    try { if ($e.Current.Name -eq '语音通话') { $callBtn = $e; break } } catch {}
  }
}
if (-not $callBtn) { Log "没找到「语音通话」按钮"; exit 5 }
if ($DryRun) { Log "（演练）找到「语音通话」按钮，不点"; exit 0 }
if (Click-Element $callBtn) { Log "已发起语音通话 -> ${Contact}" } else { Log "点不动「语音通话」"; exit 6 }

# 4) 群通话的「选择成员」对话框：搜索并勾选要拉进来的人，再点确定
function Set-SearchText($box, $text) {
  $br = $box.Current.BoundingRectangle
  [Win32Click]::Click([int]($br.X + 40), [int]($br.Y + $br.Height / 2))
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait($text)
  Start-Sleep -Milliseconds 500
  $cur = ''
  try {
    $vp = $null
    if ($box.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $cur = [string]$vp.Current.Value }
  } catch {}
  if ($cur -ne $text) {
    # 键盘没输进去（或焦点丢了）：直接赋值
    try {
      $vp2 = $null
      if ($box.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp2)) { $vp2.SetValue($text); $cur = $text }
    } catch {}
    Start-Sleep -Milliseconds 400
  }
  return $cur
}

function Get-DialogRows($qqWin, $left) {
  $rows = New-Object System.Collections.ArrayList
  foreach ($t2 in $qqWin.FindAll($S::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Text)))) {
    try {
      if ($t2.Current.IsOffscreen) { continue }
      $r = $t2.Current.BoundingRectangle
      if ([Math]::Abs([int]$r.X - ($left + 294)) -le 14 -and [int]$r.Y -gt 90 -and [int]$r.Y -lt 600) { [void]$rows.Add($t2) }
    } catch {}
  }
  return $rows
}

if ($Invite) {
  $dlgOk = $null
  for ($wait = 0; $wait -lt 14 -and -not $dlgOk; $wait++) {
    Start-Sleep -Milliseconds 350
    foreach ($e in (Find-All $qqWin)) {
      try {
        if ($e.Current.Name -eq '确定' -and $e.Current.ControlType -eq $CT::Button -and -not $e.Current.IsOffscreen) { $dlgOk = $e; break }
      } catch {}
    }
  }
  if (-not $dlgOk) {
    Log "没有「选择成员」对话框（可能是私聊，直接拨出去了）"
  } else {
    Log "弹出选择成员对话框，开始勾选「${Invite}」"
    $left = [int]($qqWin.Current.BoundingRectangle.X)
    $names = @($Invite -split '[,，、\s]+' | Where-Object { $_ })
    $qns = @($InviteQQ -split '[,，、\s]+' | Where-Object { $_ })

    # 对话框里的搜索框：Edit，名字“搜索”，X 在窗口左 +200 右侧
    $box = $null
    foreach ($e in $qqWin.FindAll($S::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)))) {
      try {
        $r = $e.Current.BoundingRectangle
        if (-not $e.Current.IsOffscreen -and $e.Current.Name -eq '搜索' -and [int]$r.X -gt ($left + 200)) { $box = $e }
      } catch {}
    }
    if (-not $box) {
      Log "找不到对话框里的搜索框，跳过勾选"
    } else {
      for ($i = 0; $i -lt $names.Count; $i++) {
        $nm = $names[$i]
        $qn = if ($i -lt $qns.Count) { $qns[$i] } else { '' }

        [void](Set-SearchText $box $nm)
        Start-Sleep -Milliseconds 700
        $rows = Get-DialogRows $qqWin $left

        if (($rows.Count -ne 1) -and $qn) {
          Log ("昵称「" + $nm + "」匹配到 " + $rows.Count + " 个，改用 QQ 号 " + $qn + " 搜索")
          $got = Set-SearchText $box $qn
          Start-Sleep -Milliseconds 900
          if ($got -ne $qn) { Log ("QQ 号没写进搜索框（当前：" + $got + "）") }
          $rows = Get-DialogRows $qqWin $left
        }

        if ($rows.Count -eq 0) { Log "搜不到成员「${nm}」"; continue }

        # 依旧多个：优先名字完全一致的
        $row = $null
        if ($rows.Count -eq 1) {
          $row = $rows[0]
        } else {
          foreach ($r5 in $rows) { try { if ($r5.Current.Name -eq $nm) { $row = $r5; break } } catch {} }
          if (-not $row) { Log ("「" + $nm + "」仍有 " + $rows.Count + " 个候选，无法确定是谁，跳过（可以手动拉）"); continue }
        }

        $rr = $row.Current.BoundingRectangle
        [Win32Click]::Click([int]($rr.X - 44), [int]($rr.Y + 8))
        Start-Sleep -Milliseconds 400
        Log ("已勾选「" + $row.Current.Name + "」")
      }
    }
    try { $okr = $dlgOk.Current.BoundingRectangle } catch { $okr = $null }
    if ($okr) { [Win32Click]::Click([int]($okr.X + 20), [int]($okr.Y + 12)) }
    Log "已点确定，等待通话建立"
    Start-Sleep -Milliseconds 2500
  }
}