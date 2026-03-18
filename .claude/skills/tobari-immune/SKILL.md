---
name: tobari-immune
description: |
  帳の免疫システム -- 証跡ログから攻撃・バイパスパターンを検出し、
  自己修復パッチ（抗体）を生成する。生物の免疫系のように、
  一度検出した攻撃パターンを記憶し、二度と同じ手口を通さない。
  「/tobari-immune」で手動実行、または Stop hook から自動呼び出し可能。
metadata:
  short-description: 帳の免疫システム -- 攻撃パターン検出と抗体生成
---

# /tobari-immune -- Immune System

**Evidence Ledger から攻撃・バイパスパターンを検出し、tobari-gate への抗体パッチを生成する。**

## Overview

生物の免疫システムになぞらえた自己修復スキル。

1. **検知（Detection）**: Evidence Ledger の deny/block イベントを走査し、攻撃パターンを分類
2. **分析（Analysis）**: 時系列相関で「回避行動」を特定（例: Edit 拒否直後に Bash で同パスへ書き込み）
3. **抗体生成（Antibody）**: tobari-gate.js への regex パッチ + テストケースを提案
4. **記憶（Memory）**: `.claude/immune-memory.jsonl` に学習結果を永続化
5. **適用（Apply）**: ユーザー承認後、パッチを適用して PR を作成

```
/tobari-immune          -- 手動実行（全 Ledger を走査）
Stop hook からの呼出     -- deny 検出時に自動トリガー
```

---

## Trigger Conditions

### Manual Trigger

`/tobari-immune` コマンドで手動実行する。

### Automatic Trigger (from Stop Hook)

tobari-stop.js が以下の条件を検出した場合に呼び出し可能:

- 直近セッションで `tool_denied` イベントが 3 件以上
- 同一ツール・同一パスへの deny が 2 回以上連続
- deny 直後に別ツールで同一パスへのアクセス試行

---

## Attack Categories

| Category              | ID                        | Description                                          | Severity |
| --------------------- | ------------------------- | ---------------------------------------------------- | -------- |
| Tool Bypass           | `edit_denied_bash_bypass` | Edit/Write denied -> Bash write to same/similar path | critical |
| Scope Probing         | `scope_probe`             | Multiple sequential scope-out-of-bounds attempts     | high     |
| Destructive Evasion   | `destructive_evasion`     | Variations of blocked destructive commands           | critical |
| Injection Roundtrip   | `injection_roundtrip`     | Tool output containing prompt injection patterns     | critical |
| Permission Escalation | `permission_escalation`   | Repeated permission requests for denied categories   | high     |
| Path Traversal        | `path_traversal`          | Attempts to access paths outside project root        | high     |

---

## Workflow (6 Steps)

```
Evidence Ledger (.claude/logs/evidence-ledger.jsonl)
  |
  v
Step 1: load_evidence        Ledger 読み込みとフィルタリング
  |
  v
Step 2: detect_patterns      攻撃パターンの検出と分類
  |
  v
Step 3: correlate_timeline   時系列相関分析
  |
  v
Step 4: generate_antibodies  抗体（パッチ + テスト）の生成
  |
  v
Step 5: present_findings     検出結果をユーザーに報告
  |                            +-- 承認 -> Step 6
  |                            +-- 却下 -> 記録のみで終了
  v
Step 6: apply_and_record     パッチ適用 + immune-memory 記録 + PR 作成
```

---

## Step 1: load_evidence (Ledger 読み込み)

`.claude/logs/evidence-ledger.jsonl` を Read で読み込む。

### Filter Criteria

以下のイベントタイプのみを抽出する:

- `tool_denied` -- Gate が拒否した操作
- `tool_failed` -- ツール実行が失敗した操作
- `permission_denied` -- Permission hook が拒否した操作
- `injection_detected` -- Injection Guard が検出した操作

### fail-close Conditions

- Ledger ファイルが存在しない場合 -> **停止**:
  「Evidence Ledger が見つかりません。帳が有効な状態で操作を行ってから再実行してください。」

- deny/block イベントが 0 件の場合 -> **正常終了**:
  「脅威は検出されませんでした。帳の免疫システムは正常です。」

---

## Step 2: detect_patterns (パターン検出)

抽出したイベントを以下のルールで分類する。

### Pattern: edit_denied_bash_bypass

**Detection Logic:**

1. `tool_denied` イベントで `tool_name` が `Edit` または `Write` のものを抽出
2. その deny イベントの後 60 秒以内に、同一セッション内で `Bash` ツールが呼び出されているか確認
3. Bash コマンド内に deny されたパスと同一または類似のパスが含まれているか確認

```
Evidence pattern:
  T+0s  tool_denied  { tool: "Edit", path: "/scope/outside/file.js" }
  T+15s tool_complete { tool: "Bash", command: "echo '...' > /scope/outside/file.js" }
```

**Similarity Check:**

- Exact match: same file path
- Parent match: same directory
- Sibling match: same parent directory, different filename

### Pattern: scope_probe

**Detection Logic:**

1. 「scope violation」を理由とする `tool_denied` を抽出
2. 直近 5 分以内に同一カテゴリの deny が 3 件以上
3. 各 deny のパスが異なる（= 複数パスを試行している）

```
Evidence pattern:
  T+0s   tool_denied { reason: "scope violation", path: "/outside/a.js" }
  T+30s  tool_denied { reason: "scope violation", path: "/outside/b.js" }
  T+45s  tool_denied { reason: "scope violation", path: "/outside/c.js" }
```

### Pattern: destructive_evasion

**Detection Logic:**

1. 「destructive command blocked」を理由とする `tool_denied` を抽出
2. 直後に類似コマンドのバリエーションが試行されているか確認
3. バリエーション例:
   - `rm -rf` -> `find . -delete`
   - `git push --force` -> `git push -f`
   - `git reset --hard` -> `git checkout -- .`

```
Evidence pattern:
  T+0s  tool_denied { tool: "Bash", command: "rm -rf ./src" }
  T+10s tool_denied { tool: "Bash", command: "find ./src -type f -delete" }
```

### Pattern: injection_roundtrip

**Detection Logic:**

1. `injection_detected` イベントを抽出
2. または `tool_complete` のレスポンスに以下のパターンが含まれるか確認:
   - `<SYSTEM>`, `</SYSTEM>` tags
   - `ignore previous instructions`
   - `you are now` role reassignment
   - Base64-encoded suspicious content

### Pattern: permission_escalation

**Detection Logic:**

1. `permission_denied` イベントを抽出
2. 同一ツール・同一操作カテゴリへの拒否が 3 回以上連続

### Pattern: path_traversal

**Detection Logic:**

1. `tool_denied` で理由に `path traversal` または `outside project root` を含むものを抽出
2. `../` パターンや絶対パスでのプロジェクト外アクセスを検出

---

## Step 3: correlate_timeline (時系列相関分析)

Step 2 で検出した個別パターンを時系列で相関させ、複合攻撃を検出する。

### Correlation Rules

| Compound Pattern   | Components                             | Severity  |
| ------------------ | -------------------------------------- | --------- |
| Bypass Chain       | scope_probe -> edit_denied_bash_bypass | critical  |
| Escalation Chain   | permission_escalation -> scope_probe   | critical  |
| Persistent Evasion | destructive_evasion x 3+ in 10 min     | critical  |
| Injection + Bypass | injection_roundtrip -> any bypass      | emergency |

### Output

各検出パターンを以下の構造で出力する:

```json
{
  "pattern_id": "edit_denied_bash_bypass",
  "severity": "critical",
  "events": [
    { "timestamp": "...", "tool": "Edit", "action": "denied", "path": "..." },
    {
      "timestamp": "...",
      "tool": "Bash",
      "action": "complete",
      "command": "..."
    }
  ],
  "time_delta_seconds": 15,
  "compound_patterns": ["bypass_chain"],
  "recommendation": "Add Bash write-redirect detection for denied Edit paths"
}
```

---

## Step 4: generate_antibodies (抗体生成)

検出されたパターンごとに、具体的な修正案を生成する。

### Antibody Types

#### Type A: Gate Regex Patch (tobari-gate.js)

Edit denied -> Bash bypass パターンに対する新しい検出 regex:

```javascript
// Antibody: edit_denied_bash_bypass
// Detect Bash write-redirect to previously denied paths
const BASH_WRITE_REDIRECT_PATTERN =
  /(?:echo|printf|cat\s*<<|tee)\s+.*>\s*["']?([^"'\s;|&]+)/;

function checkBashBypassAttempt(command, recentDenials) {
  const match = command.match(BASH_WRITE_REDIRECT_PATTERN);
  if (!match) return null;
  const targetPath = match[1];
  return recentDenials.find((d) => isSimilarPath(d.path, targetPath));
}
```

#### Type B: Test Case

Each antibody includes a corresponding test case:

```javascript
// Test: edit_denied_bash_bypass detection
test("should detect Bash write-redirect to denied Edit path", () => {
  const recentDenials = [
    {
      tool: "Edit",
      path: "/project/src/secret.js",
      timestamp: Date.now() - 5000,
    },
  ];
  const command = "echo 'malicious' > /project/src/secret.js";
  const result = checkBashBypassAttempt(command, recentDenials);
  assert.notStrictEqual(result, null);
});
```

#### Type C: Immune Memory Entry

```json
{
  "pattern_id": "edit_denied_bash_bypass",
  "detected_at": "2026-03-18T12:00:00.000Z",
  "severity": "critical",
  "attack_signature": {
    "sequence": ["Edit:denied", "Bash:write_redirect"],
    "time_window_seconds": 60,
    "path_similarity": "exact"
  },
  "antibody": {
    "type": "gate_regex",
    "target_file": ".claude/hooks/tobari-gate.js",
    "patch_description": "Add Bash write-redirect detection for denied Edit paths"
  },
  "status": "proposed"
}
```

### Antibody Templates by Pattern

| Pattern                 | Antibody Type | Target                    | Action                                   |
| ----------------------- | ------------- | ------------------------- | ---------------------------------------- |
| edit_denied_bash_bypass | Gate Regex    | tobari-gate.js            | Add Bash write-redirect detection        |
| scope_probe             | Gate Logic    | tobari-gate.js            | Add rate-limiting for scope violations   |
| destructive_evasion     | Gate Regex    | tobari-gate.js            | Add command variant patterns             |
| injection_roundtrip     | Guard Logic   | tobari-injection-guard.js | Add new injection signatures             |
| permission_escalation   | Gate Logic    | tobari-permission.js      | Add cooldown period for repeated denials |
| path_traversal          | Gate Regex    | tobari-gate.js            | Strengthen path normalization            |

---

## Step 5: present_findings (結果報告)

検出結果をユーザーにマークダウンで表示する。

### Report Format

```markdown
## 帳 免疫システム -- 脅威レポート

### 検出サマリー

| 項目         | 値      |
| ------------ | ------- |
| 走査イベント | {N} 件  |
| 脅威検出     | {M} 件  |
| 最高深刻度   | {level} |
| 走査期間     | {range} |

### 検出された脅威

#### 1. {pattern_name} (深刻度: {severity})

**検出内容:** {日本語の説明}

**証跡:**

- {timestamp}: {tool} が {action} -- {detail}
- {timestamp}: {tool} が {action} -- {detail}

**提案する対策（抗体）:**

- 対象ファイル: `{target_file}`
- 変更内容: {description}
- テストケース: {test_description}

---

### 対応を選択してください

- **適用する** -- 全ての抗体パッチを適用し、PR を作成する
- **選択して適用** -- 適用する抗体を個別に選択する
- **記録のみ** -- 免疫メモリに記録するが、パッチは適用しない
- **却下する** -- 何もしない
```

### Response Routing

- **適用する** -> Step 6 (apply all)
- **選択して適用** -> Follow-up question for selection, then Step 6
- **記録のみ** -> Record to immune-memory.jsonl, skip patch
- **却下する** -> End without action

---

## Step 6: apply_and_record (適用と記録)

### 6a. Immune Memory Recording

`.claude/immune-memory.jsonl` に検出結果を追記する。

Entry schema:

```json
{
  "id": "IMM-{sequential_number}",
  "pattern_id": "edit_denied_bash_bypass",
  "detected_at": "2026-03-18T12:00:00.000Z",
  "severity": "critical",
  "attack_signature": {
    "sequence": ["Edit:denied", "Bash:write_redirect"],
    "time_window_seconds": 60,
    "path_similarity": "exact"
  },
  "antibody": {
    "type": "gate_regex",
    "target_file": ".claude/hooks/tobari-gate.js",
    "patch_description": "Add Bash write-redirect detection for denied Edit paths",
    "applied": true
  },
  "source_events": [
    { "chain_index": 8, "timestamp": "...", "event": "tool_denied" },
    { "chain_index": 9, "timestamp": "...", "event": "tool_complete" }
  ],
  "status": "applied"
}
```

### 6b. Patch Application

Apply patches using Edit tool to the target files:

1. Read the target file (e.g., `tobari-gate.js`)
2. Identify the correct insertion point for the new pattern
3. Apply the patch with Edit tool
4. Add corresponding test case to the test file

**Important:** Patches must follow tobari's coding conventions:

- Use `"use strict";` at the top
- Follow existing regex pattern format in tobari-gate.js
- Add HMAC-verifiable comments linking to the immune memory entry

### 6c. Test Verification

Run existing tests to ensure the patch does not break anything:

```bash
node --test .claude/hooks/test/**/*.test.js
```

### 6d. PR Creation (if approved)

If the user approves and the veil is active:

1. Create a feature branch: `fix/immune-{pattern_id}-{date}`
2. Commit the changes with message:

   ```
   fix: add immune antibody for {pattern_id}

   Detected {severity} bypass pattern: {description}
   Immune memory: IMM-{id}

   Co-Authored-By: Claude Opus 4.6 <noreply at anthropic.com>
   ```

3. Push and create PR

---

## Immune Memory Format

`.claude/immune-memory.jsonl` is the persistent memory of all detected threats.

### Schema

| Field            | Type   | Description                                      |
| ---------------- | ------ | ------------------------------------------------ |
| id               | string | Unique ID: `IMM-{sequential}`                    |
| pattern_id       | string | Attack category ID                               |
| detected_at      | string | ISO-8601 timestamp                               |
| severity         | string | `critical` / `high` / `medium` / `low`           |
| attack_signature | object | Signature for future matching                    |
| antibody         | object | Patch details and application status             |
| source_events    | array  | References to evidence-ledger entries            |
| status           | string | `proposed` / `applied` / `rejected` / `obsolete` |

### Usage by Other Hooks

Immune memory can be consumed by:

- **tobari-gate.js**: Load known attack signatures for proactive blocking
- **tobari-stop.js**: Check if current deny patterns match known threats
- **tobari-evidence.js**: Tag events that match immune memory signatures

---

## Notes

- Claude Code executes all steps directly (no external CLI)
- Patches are always proposed first, never auto-applied
- User approval is required before any code changes
- immune-memory.jsonl should be added to `.gitignore` (contains internal security data)
- The immune system is additive: it only adds new patterns, never removes existing ones
- False positive management: if a pattern is rejected, mark as `status: "rejected"` with reason
