---
name: tobari
description: |
  帳をおろしてプロジェクトを開始する（STG0 儀式）。
  自然言語の意図を構造化された契約に変換し、tobari-session.json を生成する。
  エイリアス: /orose, /startproject
  「/tobari」「帳をおろす」「/orose」で呼び出される。
metadata:
  short-description: 帳をおろす — STG0 セレモニー
---

# /tobari — 帳をおろす

**自然言語の意図を構造化された契約に変換し、帳をおろしてプロジェクトを開始する。**

## Overview

このスキルは STG0（帳をおろす儀式）を実行する。
ユーザーが自由テキストで意図を伝えるだけで、tobari がコードベースを分析し、
構造化された契約（やること / やらないこと / 完了基準 / スコープ）を自動生成する。

ユーザーが契約を承認すると、帳がおりる（= `tobari-session.json` が生成される）。

```
/tobari <feature>     <- 帳をおろす（正式名）
/orose <feature>      <- 同上（世界観エイリアス）
/startproject         <- 同上（claude-code-orchestra 互換）
    | 帳がおりた後
/team-implement       <- 並列実装（任意）
    | 完了後
/team-review          <- 並列レビュー（任意）
```

---

## Workflow (STG0: 5 Steps)

```
$ARGUMENTS（自然言語の意図）
  |
  v
Step 1: receive_intent     意図の受取
  |
  v
Step 2: analyze_context    コードベース分析 + リスク評価
  |
  v
Step 3: generate_contract  契約の生成
  |
  v
Step 4: user_confirm       ユーザー確認 [はい / 修正する / やめる]
  |                          +-- 修正する -> Step 3 に戻る
  |                          +-- やめる   -> 中止
  v
Step 5: lower_veil         帳をおろす（tobari-session.json + 詠唱 + 登録）
```

---

## $ARGUMENTS の判定（最初に実行）

`$ARGUMENTS` を受け取り、以下の順で分岐する:

| 値 | 分岐先 |
| --- | --- |
| `init` | [Init フロー](#init-flow-tobari-init) へ |
| 空 | fail-close（以下参照） |
| その他の文字列 | [通常フロー（STG0 儀式）](#workflow-stg0-5-steps) へ |

---

## Step 1: receive_intent（意図の受取）

`$ARGUMENTS` からユーザーの意図を受け取る。

### fail-close 条件

- `$ARGUMENTS` が空の場合 -> **停止**。以下を表示して再入力を促す:

```
帳をおろすには、やりたいことを伝えてください。

例:
  /tobari ログイン機能を追加
  /tobari READMEを日本語化
  /tobari APIのエラーハンドリングを改善

※ はじめて使う場合は先にセットアップを実行してください:
  /tobari init
```

---

## Step 2: analyze_context（コンテキスト分析）

Claude Code が直接ツールを使い、コードベースを分析する。

### 分析項目

1. **ディレクトリ構造**: Glob でプロジェクトの主要ディレクトリをスキャン
2. **関連ファイル**: Grep で意図に関連するコード・設定を検索
3. **影響範囲**: 変更が必要になりそうなファイル・ディレクトリを特定
4. **既存パターン**: 類似の実装がないか確認

### リスクレベルの評価

分析結果から以下の基準でリスクを判定する:

| risk_level | 条件                                                    | Profile      |
| ---------- | ------------------------------------------------------- | ------------ |
| `low`      | ドキュメントのみ、設定変更、小さな修正、テスト追加      | **Lite**     |
| `medium`   | 新機能追加、既存コードの変更、リファクタリング          | **Standard** |
| `high`     | セキュリティ関連、公開 API 変更、破壊的変更、認証・決済 | **Strict**   |

### Profile 別ゲート適用

| Profile      | 適用ゲート                           | 特徴                    |
| ------------ | ------------------------------------ | ----------------------- |
| **Lite**     | STG0 + STG6 のみ                     | 中間ゲートはスキップ    |
| **Standard** | STG0 〜 STG6 全て                    | 通常の開発フロー        |
| **Strict**   | STG0 〜 STG6 全て + 人間レビュー必須 | STG6 で自動マージしない |

---

## Step 3: generate_contract（契約の生成）

分析結果から構造化された契約を生成する。

### 契約の構成要素

| フィールド            | 内容                           | 生成方法                                |
| --------------------- | ------------------------------ | --------------------------------------- |
| `intent`              | ユーザーの意図（原文保持）     | $ARGUMENTS をそのまま                   |
| `requirements.do`     | やること（3-5 項目推奨）       | 意図を具体的なタスクに分解              |
| `requirements.do_not` | やらないこと（2-3 項目推奨）   | 典型的な除外項目をテンプレート提案      |
| `dod`                 | 完了基準（テスト可能な項目）   | コードベース分析 + パターンから自動生成 |
| `scope.include`       | 影響ファイル・ディレクトリ     | 分析で特定されたパス                    |
| `scope.exclude`       | 触らないファイル・ディレクトリ | スコープ外の重要パス                    |
| `risk_level`          | `low` / `medium` / `high`      | Step 2 の評価結果                       |

### 初心者への配慮

- ユーザーが曖昧な表現をした場合 -> 候補を提案して確認する
- やらないことが想定できない場合 -> 典型的な除外項目をテンプレートから自動提示
- 完了基準が書けない場合 -> コードベース分析 + パターンから DoD を自動生成
- 技術用語は使わず、結果ベースの日本語で提示する

---

## Step 4: user_confirm（ユーザー確認）

以下のフォーマットで契約を日本語で表示し、AskUserQuestion ツールで確認を求める。

### 契約 UX フォーマット

まずテキストで以下を表示する:

```
📋 帳の契約

やること:
  ✓ {requirements.do[0]}
  ✓ {requirements.do[1]}
  ✓ {requirements.do[2]}

やらないこと:
  ✗ {requirements.do_not[0]}
  ✗ {requirements.do_not[1]}

できあがりの確認項目:
  □ {dod[0]}
  □ {dod[1]}
  □ {dod[2]}

影響する場所:
  {scope.include の各パスを列挙}

リスク: {低 / 中 / 高} -> {Lite / Standard / Strict} プロファイル
```

その後、AskUserQuestion で以下の選択肢を提示する:

- **はい** — この内容で帳をおろして実装を開始する
- **修正する** — 契約の内容を修正する（Step 3 に戻る）
- **やめる** — 帳をおろさずに終了する

### 応答分岐

- **はい** -> Step 5 へ進む
- **修正する** -> ユーザーの修正指示を受けて Step 3 に戻る（修正ループ）
- **やめる** -> 「帳をおろさずに終了しました。」と表示して終了

---

## Step 5: lower_veil（帳をおろす）

ユーザーが「はい」を選択した後、以下を順に実行する。

### 5a. tobari-session.json の生成

`.claude/tobari-session.json` に以下のスキーマで書き出す:

```json
{
  "active": true,
  "task": "{$ARGUMENTS の feature 名}",
  "profile": "{lite / standard / strict}",
  "started_at": "{現在の ISO-8601 タイムスタンプ}",
  "gates_passed": ["STG0"],
  "retry_count": 0,
  "token_usage": {
    "input": 0,
    "output": 0,
    "budget": 500000
  },
  "git_state": {
    "branch": "feat/{feature 名のケバブケース}",
    "uncommitted_changes": false,
    "pr_url": null
  },
  "contract": {
    "intent": "{ユーザーの意図原文}",
    "requirements": {
      "do": ["{やること1}", "{やること2}"],
      "do_not": ["{やらないこと1}", "{やらないこと2}"]
    },
    "dod": ["{完了基準1}", "{完了基準2}"],
    "scope": {
      "include": ["{影響パス1}", "{影響パス2}"],
      "exclude": ["{除外パス1}", "{除外パス2}"]
    },
    "risk_level": "{low / medium / high}"
  },
  "learned_permissions": [],
  "evidence": []
}
```

### 5b. backlog.yaml にタスク登録

`tasks/backlog.yaml` を読み取り、既存タスクの最大 ID（TASK-NNN）を検出して +1 する。

> **注意**: `tasks/backlog.yaml` が存在しない場合は、以下の初期内容で自動作成する:
> ```yaml
> tasks: []
> ```

新しいタスクエントリを追加:

```yaml
- id: "TASK-{次の番号}"
  phase: "P4"
  title: "{intent から生成した日本語タイトル}"
  priority: "P1"
  status: "in-progress"
  owner: "Claude Code"
  acceptance:
    - "{dod[0]}"
    - "{dod[1]}"
  evidence: []
  stage_status:
    STG0: "done"
    STG1: "pending"
    STG2: "pending"
    STG3: "pending"
    STG4: "pending"
    STG5: "pending"
    STG6: "pending"
  next_action: "実装開始"
  updated_at: "{今日の日付 YYYY-MM-DD}"
```

### 5c. 詠唱 + ステータス表示

以下をテキスト出力する:

```
闇より出でて 闇より黒く その穢れを禊ぎ祓え

┌─────────────────────────────────────┐
│  🔒 帳 — active                     │
│                                     │
│  Profile : {Lite / Standard / Strict}│
│  Task    : {feature 名}             │
│  Gates   : STG0 -> STG6             │
│                                     │
│  ✓ 破壊的操作ブロック   enabled     │
│  ✓ 秘密情報スキャン     enabled     │
│  ✓ 境界分類チェック     enabled     │
│  ✓ 証跡ログ記録         enabled     │
│  ✓ 自動承認・学習       enabled     │
└─────────────────────────────────────┘

帳の内側で作業を開始します。
```

---

## Notes

- Claude Code が全て直接実行する（外部 CLI 不使用）
- tobari-session.json の生成 + 詠唱表示が主な成果物
- Hook 有効化は `/tobari init` でセットアップ済みの前提

---

## Init Flow: /tobari init

**プロジェクトへの帳（とばり）の初回セットアップを行う。**

`$ARGUMENTS` が `init` の場合にこのフローを実行する。

```
Init Step 1: 環境チェック      現在の設定状況を確認
Init Step 2: 状況レポート      チェック結果をユーザーに表示
Init Step 3: 確認              不足設定を自動修正するか確認
Init Step 4: 設定の適用        hooks / settings.json / .gitignore を整備
Init Step 5: Webhook 設定      緊急通知の任意設定
Init Step 6: 完了メッセージ    使い方ガイドを表示
```

---

### Init Step 1: 環境チェック

以下を**ツールで確認**する:

| チェック項目 | ツール | 確認方法 |
| --- | --- | --- |
| Python 3.8+ | Bash | `python3 --version` または `python --version` |
| hooks ディレクトリ | Glob | `.claude/hooks/*.py` の存在確認 |
| settings.json の hooks 設定 | Read | `.claude/settings.json` の `hooks` キーを確認 |
| `.gitignore` への tobari-session.json 除外 | Grep | `tobari-session.json` が `.gitignore` に含まれるか |
| `_run.sh` の実行権限 | Bash | `ls -la .claude/hooks/_run.sh`（存在と権限確認） |

---

### Init Step 2: 状況レポート

チェック結果をテーブル形式でユーザーに表示する:

```
🔍 帳のセットアップ状況

| 項目                        | 状態               |
| --------------------------- | ------------------ |
| Python 3.8+                 | ✅ 利用可能 / ❌ 未検出 |
| hooks ディレクトリ          | ✅ 存在 / ❌ なし   |
| settings.json の hooks 設定 | ✅ 設定済み / ⚠️ 要更新 |
| .gitignore への除外登録     | ✅ 登録済み / ⚠️ 未登録 |
| _run.sh 実行権限            | ✅ OK / ⚠️ 要設定  |
```

全て ✅ の場合:
```
✅ 帳のセットアップは完了しています。
   /tobari <機能名> で帳をおろして作業を開始できます。
```
-> Init Step 5（Webhook 設定）へスキップ

問題がある場合は Init Step 3 へ進む。

---

### Init Step 3: 確認

AskUserQuestion ツールで確認を求める:

- **「問題のある設定を自動で修正しますか？」**
  - **はい** -> Init Step 4 へ
  - **いいえ（手動で対応します）** -> Init Step 5 へスキップ

---

### Init Step 4: 設定の適用

「はい」の場合のみ実行。問題のある項目を順に修正する。

#### 4a. hooks ディレクトリが存在しない場合

Bash で作成:
```bash
mkdir -p .claude/hooks
```

#### 4b. 必要な hooks ファイルが存在しない場合

以下の hooks ファイルが `.claude/hooks/` に存在するか確認し、存在しないものを Write ツールで作成する:

| ファイル | 役割 |
| --- | --- |
| `_run.sh` | Python 自動検出ラッパー |
| `tobari_session.py` | セッション共有ライブラリ |
| `tobari_stage.py` | STG ステージコントローラ |
| `tobari-gate.py` | PreToolUse: 🔒 止める |
| `tobari-evidence.py` | PostToolUse: 📋 残す |
| `tobari-stop.py` | Stop: 🦿 自己修復 |
| `tobari-cost.py` | PostToolUse: 👛 コスト監視 |
| `tobari-permission.py` | PermissionRequest: 👄 口 |
| `tobari-precompact.py` | PreCompact: 🧠 記憶 |
| `lint-on-save.py` | PostToolUse: コード品質 |

**ファイル作成後**、`_run.sh` に実行権限を付与:
```bash
chmod +x .claude/hooks/_run.sh
```

#### 4c. settings.json の hooks 設定が不足している場合

`.claude/settings.json` を Read で読み込み、不足している hooks エントリを Edit で追加する。
最小構成の hooks 設定:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit|Bash",
        "hooks": [{
          "type": "command",
          "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/_run.sh\" \"$CLAUDE_PROJECT_DIR/.claude/hooks/tobari-gate.py\"",
          "timeout": 10
        }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Edit|Write|NotebookEdit|Read|Grep|Glob|WebFetch|WebSearch|Task",
        "hooks": [{
          "type": "command",
          "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/_run.sh\" \"$CLAUDE_PROJECT_DIR/.claude/hooks/tobari-evidence.py\"",
          "timeout": 5
        }]
      },
      {
        "matcher": "Bash|Edit|Write|NotebookEdit|Read|Grep|Glob|WebFetch|WebSearch|Task",
        "hooks": [{
          "type": "command",
          "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/_run.sh\" \"$CLAUDE_PROJECT_DIR/.claude/hooks/tobari-cost.py\"",
          "timeout": 5
        }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/_run.sh\" \"$CLAUDE_PROJECT_DIR/.claude/hooks/tobari-stop.py\"",
          "timeout": 30
        }]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": ".*",
        "hooks": [{
          "type": "command",
          "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/_run.sh\" \"$CLAUDE_PROJECT_DIR/.claude/hooks/tobari-permission.py\"",
          "timeout": 10
        }]
      }
    ],
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [{
          "type": "command",
          "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/_run.sh\" \"$CLAUDE_PROJECT_DIR/.claude/hooks/tobari-precompact.py\"",
          "timeout": 5
        }]
      }
    ]
  }
}
```

#### 4d. `.gitignore` に tobari-session.json が未登録の場合

`.gitignore` に以下を追記（Edit ツール使用）:
```
# tobari — session state (contains task secrets, do not commit)
.claude/tobari-session.json
```

---

### Init Step 5: Webhook 設定（任意）

AskUserQuestion ツールで確認:

- **「緊急通知用の Webhook を設定しますか？（任意、後からでも設定できます）」**
  - **設定する** -> Webhook URL の入力を促す（フォローアップ質問）
  - **スキップする** -> そのまま Init Step 6 へ

Webhook URL が入力された場合:
`.claude/tobari-session.json` を Read で確認し、`webhook_url` フィールドを設定する（ファイルが存在しない場合は skeleton を Write で作成）。

> **注意**: Webhook は一方向の緊急通知（fire-and-forget）。Discord / Slack / GitHub webhook が利用可能。

---

### Init Step 6: 完了メッセージ

以下をテキスト出力する:

```
✅ 帳のセットアップが完了しました。

┌─────────────────────────────────────┐
│  🔒 帳 — ready                      │
│                                     │
│  ✓ 破壊的操作ブロック   設定済み    │
│  ✓ 秘密情報スキャン     設定済み    │
│  ✓ 境界分類チェック     設定済み    │
│  ✓ 証跡ログ記録         設定済み    │
│  ✓ 自動承認・学習       設定済み    │
└─────────────────────────────────────┘

次のステップ:
  帳をおろして作業を開始するには:
  /tobari <やりたいこと>

  例:
    /tobari ログイン機能を追加
    /tobari READMEを日本語化
    /tobari APIのエラーハンドリングを改善

帳はあなたの代わりに安全を守ります。
安心して作業に集中してください。
```
