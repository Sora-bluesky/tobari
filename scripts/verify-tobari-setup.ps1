<#
.SYNOPSIS
  tobari セットアップ状況の検証スクリプト（/tobari init の事前チェック相当）
.DESCRIPTION
  帳（とばり）が正しくセットアップされているかを確認する。
  以下の 5 項目をチェックし、結果を表示する:
  1. Python 3.8+ が利用可能か
  2. .claude/hooks/ に必要な hooks が存在するか
  3. .claude/settings.json に hooks 設定が存在するか
  4. .gitignore に tobari-session.json が除外登録されているか
  5. _run.sh に実行権限があるか
.OUTPUTS
  TOBARI_SETUP=ok   — 全チェック通過
  TOBARI_SETUP=warn — 警告あり（動作するが要確認）
  TOBARI_SETUP=fail — 必須項目が欠如（/tobari init で修正を推奨）
.EXAMPLE
  pwsh ./scripts/verify-tobari-setup.ps1
  pwsh ./scripts/verify-tobari-setup.ps1 -Root ../my-project
#>
param(
  [string]$Root = "."
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# ─── Helpers ──────────────────────────────────────────────────────────────────

function Write-Check {
  param([string]$Label, [string]$Status, [string]$Detail = "")
  $icon = switch ($Status) {
    "ok"   { "✅" }
    "warn" { "⚠️ " }
    "fail" { "❌" }
    default { "  " }
  }
  $line = "  $icon $Label"
  if ($Detail) { $line += " — $Detail" }
  Write-Host $line
}

# ─── Check 1: Python ──────────────────────────────────────────────────────────

$pythonOk = $false
$pythonDetail = ""

foreach ($cmd in @("python3", "python")) {
  try {
    $ver = & $cmd --version 2>&1
    if ($ver -match "Python (\d+)\.(\d+)") {
      $major = [int]$Matches[1]
      $minor = [int]$Matches[2]
      if ($major -gt 3 -or ($major -eq 3 -and $minor -ge 8)) {
        $pythonOk = $true
        $pythonDetail = "$cmd $ver"
        break
      } else {
        $pythonDetail = "$cmd $ver (3.8+ 必要)"
      }
    }
  } catch {
    # command not found — continue
  }
}

if (-not $pythonOk -and -not $pythonDetail) {
  $pythonDetail = "python3 / python コマンドが見つかりません"
}

# ─── Check 2: hooks ファイル ──────────────────────────────────────────────────

$requiredHooks = @(
  "_run.sh",
  "tobari_session.py",
  "tobari_stage.py",
  "tobari-gate.py",
  "tobari-evidence.py",
  "tobari-stop.py",
  "tobari-cost.py",
  "tobari-permission.py",
  "tobari-precompact.py"
)

$hooksDir = Join-Path $Root ".claude/hooks"
$missingHooks = @()

foreach ($hook in $requiredHooks) {
  $path = Join-Path $hooksDir $hook
  if (-not (Test-Path $path)) {
    $missingHooks += $hook
  }
}

$hooksOk = $missingHooks.Count -eq 0
$hooksDetail = if ($hooksOk) {
  "$($requiredHooks.Count)/$($requiredHooks.Count) 存在"
} else {
  "$($requiredHooks.Count - $missingHooks.Count)/$($requiredHooks.Count) 存在 (不足: $($missingHooks -join ', '))"
}

# ─── Check 3: settings.json の hooks 設定 ─────────────────────────────────────

$settingsPath = Join-Path $Root ".claude/settings.json"
$settingsOk = $false
$settingsDetail = ""

if (Test-Path $settingsPath) {
  try {
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
    if ($null -ne $settings.hooks) {
      $hookTypes = @($settings.hooks.PSObject.Properties.Name)
      $required = @("PreToolUse", "PostToolUse", "Stop")
      $missing = $required | Where-Object { $hookTypes -notcontains $_ }
      if ($missing.Count -eq 0) {
        $settingsOk = $true
        $settingsDetail = "PreToolUse / PostToolUse / Stop 設定済み"
      } else {
        $settingsDetail = "不足: $($missing -join ', ')"
      }
    } else {
      $settingsDetail = "hooks キーが存在しません"
    }
  } catch {
    $settingsDetail = "JSON パースエラー: $_"
  }
} else {
  $settingsDetail = ".claude/settings.json が存在しません"
}

# ─── Check 4: .gitignore への除外登録 ────────────────────────────────────────

$gitignorePath = Join-Path $Root ".gitignore"
$gitignoreOk = $false
$gitignoreDetail = ""

if (Test-Path $gitignorePath) {
  $content = Get-Content $gitignorePath -Raw
  if ($content -match "tobari-session\.json") {
    $gitignoreOk = $true
    $gitignoreDetail = "tobari-session.json 除外登録済み"
  } else {
    $gitignoreDetail = "tobari-session.json が .gitignore に未登録"
  }
} else {
  $gitignoreDetail = ".gitignore が存在しません"
}

# ─── Check 5: _run.sh 実行権限 ────────────────────────────────────────────────

$runshPath = Join-Path $hooksDir "_run.sh"
$runshOk = $false
$runshDetail = ""
$runshIsWarn = $false

if (Test-Path $runshPath) {
  # On Windows, check via bash if available
  try {
    $perm = bash -c "ls -la '$($runshPath.Replace('\', '/'))'" 2>&1
    if ($perm -match "^-rwx") {
      $runshOk = $true
      $runshDetail = "実行権限あり"
    } else {
      $runshDetail = "実行権限なし — chmod +x .claude/hooks/_run.sh を実行してください"
      $runshIsWarn = $true
    }
  } catch {
    # bash not available on this system — treat as warning
    $runshOk = $true
    $runshDetail = "権限確認スキップ（bash なし）"
    $runshIsWarn = $true
  }
} else {
  $runshDetail = "_run.sh が存在しません"
}

# ─── 結果表示 ─────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "🔍 帳のセットアップ状況"
Write-Host ""
Write-Host "  項目                          状態"
Write-Host "  ─────────────────────────────────────────────────────"

$checks = @(
  @{ Label = "Python 3.8+                  "; Ok = $pythonOk;    Detail = $pythonDetail;    IsWarn = $false },
  @{ Label = "hooks ディレクトリ           "; Ok = $hooksOk;     Detail = $hooksDetail;     IsWarn = $false },
  @{ Label = "settings.json hooks 設定     "; Ok = $settingsOk;  Detail = $settingsDetail;  IsWarn = $false },
  @{ Label = ".gitignore 除外登録          "; Ok = $gitignoreOk; Detail = $gitignoreDetail; IsWarn = $false },
  @{ Label = "_run.sh 実行権限             "; Ok = $runshOk;     Detail = $runshDetail;     IsWarn = $runshIsWarn }
)

$failCount  = 0
$warnCount  = 0

foreach ($check in $checks) {
  if ($check.Ok) {
    $status = if ($check.IsWarn) { "warn" } else { "ok" }
    if ($check.IsWarn) { $warnCount++ }
  } else {
    $status = "fail"
    $failCount++
  }
  Write-Check -Label $check.Label -Status $status -Detail $check.Detail
}

Write-Host ""

# ─── 総合判定 ─────────────────────────────────────────────────────────────────

if ($failCount -eq 0 -and $warnCount -eq 0) {
  Write-Host "TOBARI_SETUP=ok"
  Write-Host ""
  Write-Host "✅ 帳のセットアップは完了しています。"
  Write-Host "   /tobari <機能名> で帳をおろして作業を開始できます。"
  exit 0
} elseif ($failCount -eq 0) {
  Write-Host "TOBARI_SETUP=warn"
  Write-Host ""
  Write-Host "⚠️  セットアップはほぼ完了していますが、確認が必要な項目があります。"
  Write-Host "   /tobari init で問題を自動修正できます。"
  exit 0
} else {
  Write-Host "TOBARI_SETUP=fail"
  Write-Host ""
  Write-Host "❌ セットアップに問題があります。"
  Write-Host "   /tobari init で自動修正を実行してください。"
  exit 1
}
