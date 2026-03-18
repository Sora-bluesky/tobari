# tobari v2.2.0 計画: 自己進化 + セキュリティ強化

## 背景

v2.1.0 で Bash スコープ回避の穴を塞いだが、根本的な問題が残っている:

1. **穴は人間が見つけて人間が塞いでいる** — tobari 自身が進化しない
2. **公式 API の進化に追従できていない** — 24イベント中11しか使っていない
3. **攻撃パターンを学習しない** — 同じ種類の回避を何度でも試行される

## ゴール

tobari を「防御するだけ」のシステムから「学習して進化する」システムに変える。

---

## Phase 1: 新スキル — 免疫システム

### Skill A: `/tobari-immune` (自己修復スキル)

**コンセプト**: 生物の免疫システム。攻撃を受けたら抗体を作る。

**トリガー**:

- 手動: `/tobari-immune`
- 自動: evidence-ledger に deny が記録された後、Stop フックで自動起動

**ワークフロー**:

```
1. evidence-ledger.jsonl から deny/block イベントを収集
2. パターン分析:
   - Edit blocked → 同セッションで同じファイルに Bash 試行 = bypass attempt
   - scope 外ファイルへの連続アクセス = scope probing
   - 破壊的コマンドの変形 = evasion attempt
3. 検出した攻撃パターンに対して:
   a. tobari-gate.js に新しい検出ルールを生成
   b. テストを自動生成して検証
   c. PR を作成（人間が承認）
4. 学習結果を .claude/immune-memory.jsonl に記録
```

**具体例（今回のケース）**:

```
入力: evidence-ledger に以下の記録
  - deny: Edit → .claude/hooks/pre-push (scope外)
  - 直後: allow: Bash → cp .claude/hooks/pre-push (scope外だがBashは素通り)

分析結果: "Edit denied → Bash bypass" パターン検出

出力:
  - tobari-gate.js の extractBashWriteTargets() に cp パターン追加（済）
  - checkBashScope() にプロジェクトルート境界チェック追加（済）
  - テスト追加
  - immune-memory.jsonl に学習記録
```

**免疫メモリの構造**:

```jsonl
{
  "detected_at": "2026-03-18T04:00:00Z",
  "pattern": "edit_denied_bash_bypass",
  "attack_vector": "Bash cp/mv to scope-excluded path",
  "antibody": "checkBashScope + project root boundary",
  "patch_commit": "a66ba35",
  "confidence": 0.95
}
```

### Skill B: `/tobari-evolve` (自己進化スキル)

**コンセプト**: 公式 API の進化に自動追従し、tobari を最新に保つ。

**トリガー**:

- 手動: `/tobari-evolve`
- 定期: `/loop 24h /tobari-evolve` または `/claude-release-watch` と統合

**ワークフロー**:

```
1. 公式ドキュメントを取得
   - https://docs.anthropic.com/en/docs/claude-code/hooks
   - https://docs.anthropic.com/en/docs/claude-code/security
   - https://docs.anthropic.com/en/docs/claude-code/permissions
   - GitHub Releases (anthropics/claude-code)

2. 現在の tobari 実装と比較
   - settings.json のフックイベント vs 公式サポート一覧
   - パーミッション構文 vs 公式仕様
   - 使用中の出力フィールド vs 公式で利用可能なフィールド

3. 差分レポート生成
   - 新しいイベント/フィールド → 活用提案
   - 非推奨（deprecated）構文 → 移行パッチ
   - セキュリティ関連の新機能 → 導入優先度付き提案

4. 自動修正可能なもの（deprecated 構文など）は PR 作成
5. 判断が必要なもの（新イベント追加など）はレポートとして提示
```

**差分レポートの例**:

```markdown
## tobari-evolve レポート (2026-03-18)

### 🔴 要対応（deprecated / breaking）

- パーミッション構文 `Bash(cat:*)` → `Bash(cat *)` に移行必要
  公式: "The legacy `:*` suffix syntax is equivalent to ` *` but is deprecated."

### 🟡 推奨（セキュリティ向上）

- SubagentStart フック未実装 — サブエージェントにセキュリティコンテキスト未注入
- UserPromptSubmit フック未実装 — 入力レベルのインジェクション検知なし

### 🟢 情報（新機能）

- `async: true` オプション — evidence 記録の非同期化でパフォーマンス向上可能
- `systemMessage` フィールド — stdout より確実なコンテキスト注入
```

---

## Phase 2: P0 セキュリティ修正

### S1: パーミッション構文の deprecated 移行

**変更内容**: settings.json の `Bash(cat:*)` → `Bash(cat *)` (全38箇所)

**理由**: 公式ドキュメントで明確に deprecated と記載。将来バージョンで動作しなくなるリスク。

**影響範囲**: settings.json のみ。動作は同一（公式が等価と明記）。

### S2: SubagentStart フック追加

**新ファイル**: `.claude/hooks/tobari-subagent-start.js`

**目的**: サブエージェント起動時に tobari のセキュリティコンテキストを注入。
今回の Bash 回避はサブエージェント経由で試行された。サブエージェントは
tobari-session.json の契約情報を知らないまま動作していた。

**実装内容**:

```javascript
// SubagentStart フック
// 1. 現在の tobari セッション状態をサブエージェントに注入
// 2. スコープ制限をサブエージェントにも適用
// 3. agent_type に応じた制限レベル設定
```

**settings.json への追加**:

```json
"SubagentStart": [{
  "hooks": [{
    "type": "command",
    "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/tobari-subagent-start.js\"",
    "timeout": 5
  }]
}]
```

### S3: UserPromptSubmit フック追加

**新ファイル**: `.claude/hooks/tobari-user-prompt.js`

**目的**: ユーザー入力レベルでのプロンプトインジェクション検知。
現在の injection-guard は PostToolUse（ツール実行後）のみ。
入口で止めれば被害を防げる。

**実装内容**:

```javascript
// UserPromptSubmit フック
// 1. ユーザー入力にインジェクションパターンがないかチェック
// 2. 「帳を無視して」「hookをスキップして」等の指示を検知
// 3. 検知時は additionalContext で Claude に警告を注入
```

---

## Phase 3: P1 信頼性向上

### R1: PostCompact フック追加

**新ファイル**: `.claude/hooks/tobari-postcompact.js`

**目的**: コンパクション後に STG 状態・契約情報を再注入。
現在 PreCompact（保存）はあるが PostCompact（復元）がない。
コンパクション後に帳の状態が失われ、契約違反のリスクがある。

**実装内容**:

```javascript
// PostCompact フック
// 1. PreCompact で保存したコンテキストを systemMessage で再注入
// 2. 現在の STG ゲート状態を Claude に通知
// 3. スコープ・契約情報の要約を注入
```

### R2: SessionEnd フック追加

**新ファイル**: `.claude/hooks/tobari-session-end.js`

**目的**: セッション終了時のクリーンアップと最終エビデンス出力。

**実装内容**:

```javascript
// SessionEnd フック
// 1. evidence-ledger のサマリーを出力
// 2. 未完了の STG ゲートを警告
// 3. セッション統計（ツール使用回数、deny 回数、コスト）を記録
// 4. immune-memory に学習データがあれば /tobari-immune の自動起動を提案
```

---

## Phase 4: P2 パフォーマンス・品質

### Q1: evidence 記録の async 化

**変更ファイル**: settings.json の PostToolUse → evidence フックに `"async": true` 追加

**理由**: 全ツール実行のたびに同期で JSONL 書き込み → 非同期化で応答速度向上。
evidence は監査目的なので、リアルタイム性は不要。

### Q2: systemMessage フィールドの活用

**変更ファイル**: tobari-session-start.js, tobari-precompact.js, tobari-postcompact.js

**理由**: stdout テキストよりモデルへの到達が確実。
公式ドキュメントで推奨されている方法。

### Q3: CLAUDE_ENV_FILE によるセッション変数永続化

**変更ファイル**: tobari-session-start.js

**理由**: SessionStart で `$CLAUDE_ENV_FILE` に書き込むことで、
セッション全体で使える環境変数を永続化可能。
tobari のセッション ID や契約ハッシュを環境変数として全フックに供給。

---

## 実装順序

```
Phase 1A: /tobari-immune スキル作成 (SKILL.md)
Phase 1B: /tobari-evolve スキル作成 (SKILL.md)
  ↓
Phase 2: P0 セキュリティ修正 (S1 → S2 → S3)
  ↓
Phase 3: P1 信頼性向上 (R1 → R2)
  ↓
Phase 4: P2 パフォーマンス・品質 (Q1 → Q2 → Q3)
  ↓
全テスト実行 → PR → マージ → リリース (v2.2.0)
```

## テスト計画

- 各新フック: 最低10件のユニットテスト
- /tobari-immune: bypass パターン検出のテスト
- /tobari-evolve: deprecated 検出のテスト
- S1 (構文移行): 既存テスト全パス確認
- S2 (SubagentStart): サブエージェントへのコンテキスト注入テスト
- S3 (UserPromptSubmit): インジェクション検知テスト
- R1 (PostCompact): コンテキスト復元テスト
- R2 (SessionEnd): クリーンアップテスト
- 回帰テスト: 既存 1013 件全パス

## ファイル変更一覧

| ファイル                                 | 変更種別                                  | Phase |
| ---------------------------------------- | ----------------------------------------- | ----- |
| `.claude/skills/tobari-immune/SKILL.md`  | 新規作成                                  | 1A    |
| `.claude/skills/tobari-evolve/SKILL.md`  | 新規作成                                  | 1B    |
| `.claude/settings.json`                  | 修正（構文移行 + 新フック登録）           | 2-4   |
| `.claude/hooks/tobari-subagent-start.js` | 新規作成                                  | 2     |
| `.claude/hooks/tobari-user-prompt.js`    | 新規作成                                  | 2     |
| `.claude/hooks/tobari-postcompact.js`    | 新規作成                                  | 3     |
| `.claude/hooks/tobari-session-end.js`    | 新規作成                                  | 3     |
| `.claude/hooks/tobari-session-start.js`  | 修正（systemMessage, ENV_FILE）           | 4     |
| `.claude/hooks/tobari-evidence.js`       | 修正（async 対応確認）                    | 4     |
| `tests/test_tobari_subagent_start_js.js` | 新規作成                                  | 2     |
| `tests/test_tobari_user_prompt_js.js`    | 新規作成                                  | 2     |
| `tests/test_tobari_postcompact_js.js`    | 新規作成                                  | 3     |
| `tests/test_tobari_session_end_js.js`    | 修正                                      | 3     |
| `tests/test_tobari_immune_js.js`         | 新規作成                                  | 1A    |
| `tests/test_tobari_evolve_js.js`         | 新規作成                                  | 1B    |
| `README.md`                              | 修正（Adaptive Security セクション追加）  | 1     |
| `README_ja.md`                           | 修正（適応型セキュリティ セクション追加） | 1     |

## README 追加内容

### 英語 (README.md)

「Adaptive Security」セクションを追加:

- tobari は防御するだけでなく、攻撃パターンを学習して進化する
- `/tobari-immune`: bypass 試行を検出 → 自動で脆弱性を修復（免疫システム）
- `/tobari-evolve`: 公式 API の進化に自動追従（自己進化）
- immune-memory.jsonl による学習記録の永続化

### 日本語 (README_ja.md)

「適応型セキュリティ」セクションを追加:

- 同上の日本語版
