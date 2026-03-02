# tobari — 帳をおろして、解き放て。

**Claude Code 専用ガバナンスフレームワーク**

Claude Code が全体統括し、サブエージェントと Agent Teams で並列実行する。
Binding ガバナンス層が STG ゲート・帳（Hooks）・品質保証を提供する。

---

## Agent Roles — 役割分担

| Agent                                   | Role       | Use For                                |
| --------------------------------------- | ---------- | -------------------------------------- |
| **Claude Code（メイン）**               | 全体統括   | ユーザー対話、タスク管理、コード編集   |
| **general-purpose（サブエージェント）** | 実装・委譲 | コード実装、ファイル操作               |
| **Agent Teams チームメイト**            | 並列協調   | /tobari, /team-implement, /team-review |
| **Explore（サブエージェント）**         | コード探索 | ファイル検索、コードベース理解         |
| **Plan（サブエージェント）**            | 設計計画   | 実装戦略の策定                         |

### 判断フロー

```
タスク受信
  ├── 計画・設計が必要？
  │     → YES: Plan モード or サブエージェント
  │
  ├── コードベース探索が必要？
  │     → YES: Explore サブエージェント
  │
  ├── 並列実装が必要？
  │     → YES: Agent Teams で並列実行
  │
  └── 通常のコード実装？
        → メインが直接 or general-purpose に委託
```

---

## 帳（とばり）— 安全アーキテクチャ

tobari の核心機能。Claude Code の承認ダイアログを Hooks でインターセプトし、
帳が安全な操作を自動承認、危険な操作を自動ブロックする。

### 3本柱

| 柱        | Hook        | 動作                                        |
| --------- | ----------- | ------------------------------------------- |
| 🔒 止める | PreToolUse  | `permissionDecision: "deny"` で自動ブロック |
| ✅ 進む   | PreToolUse  | `permissionDecision: "allow"` で自動承認    |
| 📋 残す   | PostToolUse | 全操作を Evidence Ledger (JSONL) に記録     |

### 帳の判定基準

- **allow**: 読み取り系（Read, Glob, Grep）、scope 内の Edit/Write、安全な Bash パターン
- **deny**: 破壊的 Bash、scope 外の操作、契約違反、秘密情報検出
- **ask**: どちらにも該当しない → ユーザーに確認

---

## Binding Governance — ガバナンス層

Binding（縛り）は実行統制レイヤ。LLM ではなく、ルール・ゲート・契約の体系。

### Operating Profiles

| Profile      | Gate Density                     | Use When                                    |
| ------------ | -------------------------------- | ------------------------------------------- |
| **Lite**     | STG0 + STG6 only                 | Low-risk tasks (docs, minor edits)          |
| **Standard** | All STG gates                    | Normal development tasks                    |
| **Strict**   | All STG gates + mandatory review | Security-sensitive or public-facing changes |

### STG Gates (Stage Gates)

| Gate | Name           | Purpose                            |
| ---- | -------------- | ---------------------------------- |
| STG0 | Requirements   | Task acceptance criteria confirmed |
| STG1 | Design         | Architecture/approach reviewed     |
| STG2 | Implementation | Code written and self-reviewed     |
| STG3 | Verification   | Tests pass, lint clean             |
| STG4 | Automation     | CI/CD checks pass                  |
| STG5 | Commit/Push    | Changes committed and pushed       |
| STG6 | PR/Merge       | Pull request created and merged    |

### fail-close Principle

- Safety conditions NOT met → Binding STOPS execution
- On stop: output reason + recovery steps in Japanese
- Never skip a gate

→ 詳細: `.claude/rules/binding-governance.md`

---

## Quick Reference

### サブエージェントを使う時

- **コード実装**（メインのコンテキストを節約したい場合）
- **コードベース探索**（Explore エージェント）
- **調査結果の整理** → `.claude/docs/research/` に保存

### Agent Teams を使う時

- **並列実装**（複数モジュールを同時に実装）
- **並列レビュー**（セキュリティ・品質・テストの各観点）

---

## Workflow

```
/tobari <機能名>           帳をおろしてプロジェクト開始
    ↓ 契約確認後
/team-implement            Agent Teams で並列実装
    ↓ 完了後
/team-review               Agent Teams で並列レビュー
```

---

## Tech Stack

- **PowerShell 7** / **Markdown** / **YAML**
- **git-guard** (pre-commit / pre-push)

→ 詳細: `.claude/rules/dev-environment.md`

---

## Documentation

| Location                              | Content                                            |
| ------------------------------------- | -------------------------------------------------- |
| `.claude/rules/`                      | コーディング・セキュリティ・言語・ガバナンスルール |
| `.claude/rules/binding-governance.md` | Binding ガバナンス（STG ゲート・プロファイル）     |
| `.claude/docs/`                       | 設計決定・調査結果                                 |

---

## Language Protocol

- **思考・コード**: 英語
- **ユーザー対話**: 日本語
