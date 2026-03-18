---
name: tobari-evolve
description: |
  帳の自己進化スキル。Claude Code の公式 API 変更を自動追跡し、
  tobari のガバナンスフレームワークを最新状態に保つ。
  Hook イベント・Permission 構文・出力フィールドの差分を検出し、
  安全な変更は自動修正、大きな変更はユーザー承認を経て適用する。
  エイリアス: /evolve
  「/tobari-evolve」「/evolve」で呼び出される。
metadata:
  short-description: 帳の自己進化 -- Claude Code API 追跡 & 自動更新
---

# /tobari-evolve -- 帳の自己進化

**Claude Code の公式 API 変更を自動追跡し、tobari を最新状態に保つ。**

## Overview

Claude Code は継続的に進化する。新しい Hook イベントの追加、Permission 構文の変更、
出力フィールドの拡張が行われるたびに、tobari もそれに追随する必要がある。

このスキルは、公式ドキュメントと GitHub Releases を定期的にフェッチし、
現在の tobari 実装との差分を検出する。検出された差分はカテゴリ別に分類され、
安全な変更は自動修正、リスクのある変更はユーザーに提示して承認を得る。

```
/tobari-evolve           <- 手動実行（単発チェック）
/loop 24h /tobari-evolve <- 定期実行（24時間ごと）
```

---

## Trigger

| Method   | Command                    | Use Case                       |
| -------- | -------------------------- | ------------------------------ |
| Manual   | `/tobari-evolve`           | On-demand compatibility check  |
| Periodic | `/loop 24h /tobari-evolve` | Scheduled monitoring (daily)   |
| Chained  | `/claude-release-watch`    | Post-release integration check |

---

## Workflow (5 Steps)

```
/tobari-evolve
  |
  v
Step 1: fetch_official_spec     公式ドキュメントの取得
  |
  v
Step 2: analyze_current         現在の tobari 実装を分析
  |
  v
Step 3: generate_diff_report    差分レポートの生成
  |                               |-- 差分なし -> 「最新です」と表示して終了
  |                               |-- 差分あり -> Step 4 へ
  v
Step 4: auto_fix_safe_changes   安全な変更の自動修正
  |
  v
Step 5: present_findings        結果の表示とユーザー承認
```

---

## Step 1: fetch_official_spec（公式ドキュメントの取得）

以下の公式ソースから最新の仕様を取得する。

### 1a. Claude Code Hooks Documentation

WebFetch で以下の URL を取得する:

| Source                | URL                                                          | Extract                                                          |
| --------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| Hooks reference       | `https://docs.anthropic.com/en/docs/claude-code/hooks`       | Supported hook events, matchers, output fields, timeout defaults |
| Security model        | `https://docs.anthropic.com/en/docs/claude-code/security`    | Security-related hook patterns, permission model changes         |
| Permissions reference | `https://docs.anthropic.com/en/docs/claude-code/permissions` | Permission syntax (allow/deny format), deprecated patterns       |

For each URL, use WebFetch with a targeted prompt to extract:

- List of all supported hook event names (e.g., `PreToolUse`, `PostToolUse`, `SessionStart`, etc.)
- Supported matcher syntax and any deprecated forms
- Available output fields per hook type (e.g., `permissionDecision`, `decision`, `reason`)
- Default and maximum timeout values
- Any deprecation notices or breaking change warnings

### 1b. GitHub Releases

Use Bash to fetch the latest releases from the Claude Code repository:

```bash
gh api repos/anthropics/claude-code/releases --jq '.[0:5] | .[] | {tag_name, published_at, body}' 2>/dev/null
```

If `gh` is not available or the repo is not accessible, use WebFetch as fallback:

```
WebFetch: https://github.com/anthropics/claude-code/releases
Prompt: "Extract the latest 5 release versions, dates, and changelog entries.
         Focus on: hook API changes, permission syntax changes, breaking changes,
         new hook events, deprecated features."
```

### 1c. Build the Official Spec Object

Aggregate fetched data into a structured spec:

```
official_spec = {
  hook_events: [list of all supported event names],
  matcher_syntax: {current format, deprecated formats},
  permission_syntax: {current format, deprecated patterns like ":*"},
  output_fields: {per-event available fields},
  timeout_limits: {default, max},
  deprecations: [list of deprecated features with migration paths],
  breaking_changes: [list of breaking changes],
  new_features: [list of new capabilities],
  latest_version: "x.y.z",
  fetched_at: "ISO-8601 timestamp"
}
```

### fail-close conditions

- If ALL fetch attempts fail (all URLs unreachable) -> STOP.
  Display: 「公式ドキュメントを取得できませんでした。ネットワーク接続を確認してください。」
- If SOME fetches fail -> Continue with available data, note gaps in report.

---

## Step 2: analyze_current（現在の tobari 実装を分析）

Read the current tobari configuration and implementation files.

### 2a. Read settings.json

```
Read: .claude/settings.json
```

Extract:

- All hook event names currently configured (keys under `hooks`)
- All matcher patterns per event
- All hook commands and their timeout values
- All permission entries (allow/deny lists)

### 2b. Read Hook Implementation Files

```
Glob: .claude/hooks/tobari-*.js
```

For each hook file, extract:

- Which output fields are used (e.g., `permissionDecision`, `decision`, `reason`, `stdout`, `stderr`)
- Which environment variables are consumed (e.g., `$CLAUDE_PROJECT_DIR`, `$TOOL_NAME`)
- Hook-specific logic patterns

### 2c. Build the Current State Object

```
current_state = {
  configured_events: [list from settings.json hooks keys],
  matchers: {event -> [matcher patterns]},
  timeouts: {event -> timeout values},
  permissions: {allow: [...], deny: [...]},
  output_fields_used: [list across all hook files],
  env_vars_used: [list across all hook files],
  hook_files: [list of .js files with their roles]
}
```

---

## Step 3: generate_diff_report（差分レポートの生成）

Compare `official_spec` with `current_state` and classify differences.

### 3a. Comparison Dimensions

| Dimension             | Compare                                                          | Category Logic                                                                         |
| --------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Hook Events           | `official_spec.hook_events` vs `current_state.configured_events` | New official event not in tobari -> Info; Removed official event in tobari -> Required |
| Matcher Syntax        | `official_spec.matcher_syntax` vs matchers used                  | Deprecated syntax in use -> Required                                                   |
| Permission Syntax     | `official_spec.permission_syntax` vs permissions                 | Deprecated `:*` pattern -> Required                                                    |
| Output Fields         | `official_spec.output_fields` vs fields used                     | New fields available -> Info; Used field removed -> Required                           |
| Timeout Limits        | `official_spec.timeout_limits` vs current values                 | Exceeds new max -> Required; Below new default -> Recommended                          |
| Deprecations          | `official_spec.deprecations` vs current usage                    | Using deprecated feature -> Required                                                   |
| Breaking Changes      | `official_spec.breaking_changes` vs current impl                 | Affected by breaking change -> Required                                                |
| New Features          | `official_spec.new_features` vs current impl                     | Available but not used -> Info                                                         |
| Security Improvements | `official_spec` security patterns                                | New security pattern available -> Recommended                                          |

### 3b. Categorization

Each diff item is assigned one of three categories:

| Category    | Meaning                               | Action                     |
| ----------- | ------------------------------------- | -------------------------- |
| Required    | Deprecated or breaking changes        | Must fix to avoid breakage |
| Recommended | Security improvements, best practices | Should fix for robustness  |
| Info        | New features, enhancements            | Awareness only             |

### 3c. No Diff Case

If no differences are found:

```markdown
### 帳の互換性チェック

**結果: 最新です**

tobari の設定は Claude Code の最新仕様と完全に互換しています。

| 項目           | 値                            |
| -------------- | ----------------------------- |
| チェック日時   | {ISO-8601 timestamp}          |
| 公式バージョン | {latest_version or "unknown"} |
| 差分           | なし                          |

次回チェック: `/tobari-evolve` または `/loop 24h /tobari-evolve`
```

Then STOP (no further steps needed).

---

## Step 4: auto_fix_safe_changes（安全な変更の自動修正）

Automatically apply changes that are safe and well-defined.

### 4a. Auto-fixable Patterns

The following changes can be applied without user approval:

| Pattern                           | Auto-fix Action                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Deprecated `:*` permission syntax | Replace with current syntax (e.g., `Bash(git:*)` -> `Bash(git *)` if spec changes) |
| Timeout below new minimum         | Update to new minimum value                                                        |
| Deprecated matcher format         | Migrate to current format                                                          |

### 4b. Auto-fix Execution

For each auto-fixable item:

1. Read the target file (settings.json or hook .js file)
2. Apply the fix using Edit tool
3. Record the change in the diff report as "auto-fixed"

### 4c. Safety Constraints

- NEVER auto-fix changes that add new hook events (requires user decision)
- NEVER auto-fix changes that modify hook logic (only syntax/format)
- NEVER auto-fix changes that alter permission scope (security-sensitive)
- All auto-fixes are recorded in the diff report for transparency

---

## Step 5: present_findings（結果の表示とユーザー承認）

Display the complete diff report and request approval for non-auto-fixed changes.

### 5a. Diff Report Format

```markdown
### 帳の進化レポート

| 項目           | 値                            |
| -------------- | ----------------------------- |
| チェック日時   | {ISO-8601 timestamp}          |
| 公式バージョン | {latest_version or "unknown"} |

---

#### Required（対応必須）

{If items exist:}

| #   | 項目          | 現状            | 推奨                | 影響                  |
| --- | ------------- | --------------- | ------------------- | --------------------- |
| 1   | {description} | {current value} | {recommended value} | {impact if not fixed} |

{If no items: "なし"}

---

#### Recommended（推奨）

| #   | 項目          | 現状            | 推奨                | メリット              |
| --- | ------------- | --------------- | ------------------- | --------------------- |
| 1   | {description} | {current value} | {recommended value} | {benefit of applying} |

{If no items: "なし"}

---

#### Info（参考情報）

| #   | 項目          | 説明                                                 |
| --- | ------------- | ---------------------------------------------------- |
| 1   | {description} | {what is available and how tobari could leverage it} |

{If no items: "なし"}

---

#### Auto-fixed（自動修正済み）

| #   | 項目          | 変更前      | 変更後      |
| --- | ------------- | ----------- | ----------- |
| 1   | {description} | {old value} | {new value} |

{If no items: "なし"}
```

### 5b. User Approval for Required/Recommended Items

If there are Required or Recommended items remaining (not auto-fixed):

Use AskUserQuestion:

- **「Required/Recommended の変更を適用しますか？」**
  - **すべて適用** -> Apply all Required + Recommended changes
  - **Required のみ** -> Apply only Required changes
  - **個別に選ぶ** -> Present each item one by one for approval
  - **今は適用しない** -> Save report only, no changes

### 5c. Apply Approved Changes

For each approved change:

1. Read the target file
2. Apply the change using Edit tool
3. Verify the change was applied correctly (Read back)

### 5d. Save Evolution Report

Write the report to `.claude/docs/evolution/` for audit trail:

```bash
mkdir -p .claude/docs/evolution
```

Write file: `.claude/docs/evolution/{YYYY-MM-DD}-evolve-report.md`

Content: The full diff report from 5a, plus:

- Which items were applied
- Which items were deferred
- Any auto-fixes performed

### 5e. Completion Message

```markdown
**帳の進化チェックが完了しました。**

| 項目              | 値                                               |
| ----------------- | ------------------------------------------------ |
| Required 対応済み | {n} / {total}                                    |
| Recommended 適用  | {n} / {total}                                    |
| 自動修正          | {n} 件                                           |
| レポート保存先    | `.claude/docs/evolution/{date}-evolve-report.md` |

次回チェック: `/tobari-evolve` または `/loop 24h /tobari-evolve`
```

---

## Integration Points

### /claude-release-watch

If `/claude-release-watch` detects a new Claude Code release, it can trigger `/tobari-evolve`
to check compatibility immediately:

```
/claude-release-watch -> new release detected -> /tobari-evolve
```

### /loop

For periodic monitoring:

```
/loop 24h /tobari-evolve
```

This runs the full workflow every 24 hours, saving reports to `.claude/docs/evolution/`.

---

## Notes

- Claude Code executes all steps directly (no external CLI dependency)
- WebFetch is the primary data source; `gh` CLI is a secondary source for releases
- Auto-fix is conservative: only well-defined syntax migrations are applied automatically
- All changes and reports are recorded for audit trail
- The skill respects tobari's fail-close principle: uncertain changes require user approval
