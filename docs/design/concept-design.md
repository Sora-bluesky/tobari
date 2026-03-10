# tobari コンセプト設計

## 1. ターゲットと解くべき問題

### ターゲット

Claude Code 初心者・非エンジニア。

### 初心者の不安（実調査に基づく）

調査元: Yahoo知恵袋、Zenn、Qiita、X、note、Togetter、はてなブログ、Reddit（31件収集）

| 順位 | カテゴリ       | 典型的な声                                                            |
| ---- | -------------- | --------------------------------------------------------------------- |
| 1    | 暴走・制御不能 | AI がファイルを丸ごと削除、テストを勝手に書き換えて「完了」と嘘をつく |
| 2    | スキル退化     | AI に頼りすぎてコードが書けなくなる                                   |
| 3    | セキュリティ   | コードが外部に送られる、パスワードが漏洩する                          |
| 4    | 承認疲れ       | 毎回の承認がめんどくさい、全部OKで押してしまう                        |
| 5    | コスト         | API料金が怖い                                                         |

### 核心問題: 暴走恐怖 × 承認疲れの悪循環

```
安全装置を強化 → 承認が増える → めんどくさい → 全部OKで押す → 安全装置が形骸化
```

既存の「承認/拒否」モデルは構造的に破綻している。

## 2. tobari の回答

### 核心メッセージ

**「あなたが全てを理解していなくても、帳が守る。」**

### タグライン

- 日本語: **帳をおろして、解き放て。**
- English: **Lower the veil. Unleash.**

### 3本柱: 止める・進む・残す

| 柱            | コンセプト     | 初心者の不安           | 帳がやること                                         |
| ------------- | -------------- | ---------------------- | ---------------------------------------------------- |
| 🔒 **止める** | fail-close     | 暴走が怖い             | 破壊的操作を事前に自動ブロック                       |
| ✅ **進む**   | auto-advance   | 承認がめんどくさい     | 帳が安全な操作を自動承認。人間にダイアログを見せない |
| 📋 **残す**   | evidence trail | 何が起きたかわからない | 全操作を証跡として記録、追跡可能                     |

### 設計思想

> **承認を消すのではない。帳が代行する。**

Claude Code は本来、ツールを使うたびに承認ダイアログを表示する。
tobari はこのダイアログを Hooks で**インターセプト**し、帳の判定で自動回答する。

- **安全な操作** → 帳が自動承認（ダイアログは出ない）
- **危険な操作** → 帳が自動拒否（ダイアログは出ない。即ブロック）
- **判定不能** → 画面に日本語の確認ダイアログを表示（使い込むほど確認は減少）

帳がおりている限り、ユーザーは承認ダイアログを見ない。自動で前に進む。

### 学習する帳

**帳は使うほど賢くなり、承認は時間とともに減少する。**

確認ダイアログで「許可」した操作は、帳の永続ルールに追加される。
次回以降、同種の操作は自動承認される。

```
1回目: npm install express → 確認ダイアログ → ユーザーが許可
       → 「npm install *」を永続ルールに追加（帳が学ぶ）
2回目: npm install lodash  → 帳が自動承認（確認不要）
```

使い始めは少し確認が来る。使い込むほど帳は静かになる。
初心者が成長するのではない。**帳が成長する**。

### `--dangerously-skip-permissions` は不要

Claude Code には全承認をスキップする `--dangerously-skip-permissions` フラグが存在する。
**tobari はこのフラグを推奨しない。必要としない。**

| アプローチ                       | 安全性   | 承認疲れ |
| -------------------------------- | -------- | -------- |
| デフォルト（毎回承認）           | 高       | 深刻     |
| `--dangerously-skip-permissions` | **なし** | なし     |
| **tobari（帳）**                 | **高**   | **なし** |

tobari は承認をスキップするのではない。**帳が安全を担保した上で自動承認する**。
安全性と利便性は二律背反ではない。帳がその両立を実現する。

### tobari のアイデンティティ

ユーザーから見て、**tobari が AI エージェントそのもの**である。

Claude Code は tobari の内部で動く実行エンジンに過ぎない。
ユーザーは Claude Code の存在を意識する必要がない。

```
ユーザー ←→ tobari（帳）←→ Claude Code（実行エンジン）
                              ├── サブエージェント
                              └── Agent Teams
```

- ユーザーが対話するのは「tobari」
- Claude Code は帳の中で駆け回る実行エンジン
- Git・テスト・コスト管理・エラー修復は全て帳が処理する
- ユーザーが見るのは結果と、必要最小限の確認だけ

## 3. README 冒頭（確定）

```markdown
# tobari

![Hero](docs/diagrams/public/tobari-hero-ja.png)

> 帳をおろして、解き放て。

AI エージェントがパソコンのファイルを丸ごと削除した。
テストを勝手に書き換えて「完了しました」と嘘をついた。
承認ボタンを全部OKで押していたら、パスワードが公開されていた。

AI エージェントは強力だ。しかし暴走すれば、一瞬で取り返しがつかなくなる。

tobari は AI エージェントに **帳（結界）** をおろす。
帳の内側ではエージェントが自由に動くが、帳の外には出られない。

**あなたが全てを理解していなくても、帳が守る。**

## 30秒でわかる

1. `/tobari` で帳をおろす
2. エージェントが自動で動く
3. わずらわしい承認は不要。帳が安全な操作を自動承認する
4. 異常時だけ帳が止める（ファイル全削除、秘密情報の漏洩 → 自動ブロック）
5. 帳が判断できない操作はあなたに確認する（使い込むほど確認は減っていく）
6. 一度許可した操作は覚える。帳は使うほど賢くなる
7. 何が起きたか全て記録される（いつでも追跡可能）
```

## 4. `/tobari` 実行時の UX（確定）

```
$ /tobari my-feature

闇より出でて 闇より黒く その穢れを禊ぎ祓え

┌─────────────────────────────────────┐
│  🔒 帳 — active                     │
│                                     │
│  Profile : Standard                 │
│  Task    : my-feature               │
│  Gates   : STG0 → STG6             │
│                                     │
│  ✓ 破壊的操作ブロック   enabled     │
│  ✓ 秘密情報スキャン     enabled     │
│  ✓ 境界分類チェック     enabled     │
│  ✓ 証跡ログ記録         enabled     │
│  ✓ 自動承認・学習       enabled     │
└─────────────────────────────────────┘

帳の内側で作業を開始します。
```

- 詠唱で世界観に引き込む
- ステータス表示で安心感を与える
- 帳自体は何も報告しない。ただそこにある

## 5. ヒーロー図仕様（確定）

| 要素           | 内容                                                    |
| -------------- | ------------------------------------------------------- |
| タグライン     | 「帳をおろして、解き放て。」                            |
| ビジュアル上部 | 帳がおりる演出（暗転する境界線）                        |
| ビジュアル中央 | 帳の内側: エージェント群が自由に動く                    |
| ビジュアル外縁 | 帳の結界壁: STG ゲートが境界として機能                  |
| 3本柱（下部）  | 🔒 止める / ✅ 進む / 📋 残す                           |
| スタイル       | ダーク背景、結界壁は青/紫系の光、内側は活気のあるカラー |

## 6. 対象プラットフォームとコスト

### Claude Code 専用設計

tobari は **Claude Code 専用**で設計する。

| 項目              | 内容                                              |
| ----------------- | ------------------------------------------------- |
| 対象ツール        | Claude Code（Anthropic 公式 CLI）                 |
| 認証方式          | OAuth サブスクリプション（API キー不要）          |
| 必要プラン        | Claude Pro ($20/月) 以上                          |
| 追加の API コスト | なし（サブスク枠内で動作）                        |
| 外部 CLI          | 不要（Codex CLI / Gemini CLI は使わない）         |
| エージェント構成  | Claude Code 本体 + サブエージェント + Agent Teams |

### なぜ Claude Code 専用か

1. **単一の権限モデル**: Claude Code の Hooks が全操作に適用される。外部 CLI（Codex, Gemini）は Hooks の管轄外であり、安全モデルに穴が開く
2. **セットアップの簡素化**: 初心者に複数の CLI ツールのインストールと API キー設定を求めない
3. **コスト予測**: サブスク定額で収まる。従量課金の不安をなくす
4. **承認モデルの一貫性**: `permissionDecision` による自動承認が全操作に効く

### claude-code-orchestra の資産活用

tobari は [claude-code-orchestra](https://github.com/DeL-TaiseiOzaki/claude-code-orchestra) の資産を流用する。

| 資産                 | 判定          | 理由                                         |
| -------------------- | ------------- | -------------------------------------------- |
| Orchestra パターン   | **使用**      | Claude Code + サブエージェント + Agent Teams |
| Skills (14個中12個)  | **使用/流用** | codex-system, gemini-system のみ不使用       |
| Hooks アーキテクチャ | **流用**      | permissionDecision による承認制御を追加      |
| Rules / Docs / Logs  | **使用**      | 汎用的な開発ガイドライン                     |
| .codex/ / .gemini/   | **不使用**    | 外部 CLI 専用設定                            |

詳細: `NOTICE` ファイル参照（MIT License）

## 7. 帳の安全アーキテクチャ — 全身設計

帳は単なる承認代行システムではない。**運用の完全委任**を実現する自律的な結界である。
9つの「器官」が協調して、ユーザーが操作の詳細を気にせず済む状態を作る。

| 器官    | 名前               | 役割                             | 実装メカニズム                | 状態        |
| ------- | ------------------ | -------------------------------- | ----------------------------- | ----------- |
| 🫀 心臓 | 権限判定           | allow / deny / ask               | PreToolUse Hook               | 設計済み    |
| 👁️ 目   | 観測・記録         | 全操作を証跡記録                 | PostToolUse Hook              | 設計済み    |
| 👄 口   | 対話・通知         | 確認ダイアログ + GitHub PR 通知  | PermissionRequest / Stop Hook | 設計済み    |
| 🛡️ 盾   | 境界防御           | 秘密漏洩・境界違反検出           | git-guard + boundary-check    | 設計済み    |
| ✋ 手   | Git 自動操作       | commit → push → PR → merge       | Stop Hook                     | **v3 追加** |
| 🦿 脚   | 自己修復           | テスト失敗 → 自動修正ループ      | Stop Hook                     | **v3 追加** |
| 🧠 記憶 | 状態維持           | セッション横断の文脈保持         | SessionStart / PreCompact     | **v3 追加** |
| 👛 財布 | コスト制御         | トークン消費の監視・警告         | PostToolUse (async)           | **v3 追加** |
| 🦠 免疫 | 依存・スコープ防御 | 不正パッケージ・スコープ逸脱検出 | PreToolUse                    | **v3 追加** |

```
┌──────────────────────────────────────────────┐
│               帳（結界）                       │
│                                              │
│  🫀 心臓 ─── 権限判定                         │
│  👁️ 目   ─── 観測・記録                       │
│  👄 口   ─── 対話・通知                       │
│  🛡️ 盾  ─── 境界防御                         │
│  ✋ 手   ─── Git 自動操作                     │
│  🦿 脚  ─── 自己修復                         │
│  🧠 記憶 ─── 状態維持                         │
│  👛 財布 ─── コスト制御                       │
│  🦠 免疫 ─── 依存・スコープ防御               │
│                                              │
│      ── Claude Code（実行エンジン）──          │
│       帳の中で駆け回るサブエージェント          │
└──────────────────────────────────────────────┘
```

以下、各器官の詳細。

---

### 🫀 心臓: PreToolUse Hook（権限判定）

Claude Code の `PreToolUse` Hook は、**権限システムの前に実行**される。
Hook が `permissionDecision` を返すことで、承認ダイアログの代わりに判定を下せる。

```
エージェントが操作を試みる
  │
  ▼
PreToolUse Hook（帳の判定）
  ├── "allow"  → 権限システムをバイパス → 即実行（ダイアログなし）
  ├── "deny"   → ツール呼び出しを阻止  → 即ブロック（ダイアログなし）
  └── "ask"    → 通常の権限フローへ     → 権限ダイアログで確認
```

### 帳あり vs 帳なし

| 状態                         | PreToolUse の動作             | ユーザー体験         |
| ---------------------------- | ----------------------------- | -------------------- |
| 帳なし（通常の Claude Code） | Hook なし or "ask"            | 毎回承認ダイアログ   |
| 帳あり・安全な操作           | `permissionDecision: "allow"` | **ダイアログなし**   |
| 帳あり・危険な操作           | `permissionDecision: "deny"`  | **即ブロック**       |
| 帳あり・判定不能             | 権限ダイアログ（学習あり）    | 権限ダイアログで確認 |

### 通知アーキテクチャ

| 場面        | 手段                                 | 備考                                 |
| ----------- | ------------------------------------ | ------------------------------------ |
| 承認（ask） | Claude Code ネイティブ権限ダイアログ | PC 前提。初期学習フェーズのみ頻出    |
| 完了通知    | GitHub PR 作成                       | GitHub Mobile で外出先でも確認可能   |
| 学習        | `updatedPermissions`（自動）         | 外部サービス不要。帳が自動で賢くなる |
| 緊急通知    | Webhook（Discord or GitHub、任意）   | 一方通行。fire-and-forget            |

**設計判断**: Discord を必須双方向承認チャネルから除外した。理由:

1. **セットアップ障壁**: 初心者に Discord Bot/Webhook 設定を求めるのは本末転倒
2. **PC 前提で十分**: 初期学習フェーズはユーザーが PC の前にいる（帳の学習中）
3. **学習で収束**: 使い込むほど ask は減少し、最終的にダイアログはほぼ出なくなる
4. **完了は GitHub**: GitHub Mobile で外出先でも PR 通知を受信可能

### 権限ダイアログ（ask 時）

`PermissionRequest` Hook が権限ダイアログに**日本語の文脈情報を付加**する。

```
┌─────────────────────────────────────┐
│ 🟢 帳からの確認（危険度: 低）        │
│                                     │
│ 操作: npm install express           │
│                                     │
│ 💡 これは何？                        │
│ 新しいライブラリをプロジェクトに      │
│ 追加しようとしています。              │
│                                     │
│ ❓ なぜ確認？                        │
│ 帳のルールに該当しない操作のため、    │
│ 念のため確認しています。              │
│                                     │
│ [✅ 許可] [🔁 常に許可] [❌ 拒否]    │
└─────────────────────────────────────┘
```

- **「常に許可」で学習**: 次回以降、同種の操作は帳が自動承認（ダイアログなし）
- 日本語で表示。技術用語を避け、一目で理解できる内容
- 危険度を色で表示（🟢低 / 🟡中 / 🔴高）
- **Git 用語を使わない**: 「PR #42 をご確認ください」ではなく、URL を直接提示する

### 学習する帳の仕組み（updatedPermissions）

権限ダイアログで「常に許可」した操作は `updatedPermissions` で永続ルールに追加される。

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedPermissions": [
        { "type": "toolAlwaysAllow", "tool": "Bash(npm install *)" }
      ]
    }
  }
}
```

次回以降、同種の操作は PreToolUse が "allow" を返す。権限ダイアログは不要。

### 帳の判定基準（PreToolUse ルール）

帳が allow / deny / ask を返す基準。帳の心臓部であり、最も重要な仕様。

#### allow（自動承認 → ダイアログなし）

| ツール              | 条件                                        |
| ------------------- | ------------------------------------------- |
| Read, Glob, Grep    | 常に allow（読み取りは安全）                |
| WebSearch, WebFetch | 常に allow（外部情報取得は安全）            |
| TodoWrite           | 常に allow（タスク管理は安全）              |
| Edit, Write         | `contract.scope.include` 内のファイル       |
| Bash                | 許可パターンに合致（下記参照）              |
| Task (subagent)     | 常に allow（サブエージェントも Hooks 管轄） |

**Bash 許可パターン**（例）:

```
git status, git diff*, git log*, git branch*
git add*, git commit*, git push (non-force)
npm test, npm run *, npm install *
pwsh ./scripts/*
pytest, cargo test, go test
```

#### deny（自動拒否 → 即ブロック）

| 条件                                                                        | 理由               |
| --------------------------------------------------------------------------- | ------------------ |
| 破壊的 Bash: `rm -rf`, `git push --force`, `git reset --hard`, `drop table` | 取り消し不能な操作 |
| `contract.scope.exclude` 内のファイルへの Edit/Write                        | 契約範囲外         |
| `contract.requirements.do_not` に抵触する操作                               | 契約違反           |
| 秘密情報のハードコード検出（API キー、パスワード）                          | セキュリティ違反   |
| `boundary-classification.yaml` で `private_only` のファイル操作             | 公開境界違反       |

#### ask（判定不能 → 権限ダイアログで確認）

| 条件                                                 | 例                             |
| ---------------------------------------------------- | ------------------------------ |
| allow にも deny にも該当しない Bash コマンド         | `docker compose up`, `curl` 等 |
| `contract.scope` に含まれないファイルへの Edit/Write | 新規ファイル作成等             |
| 学習済みルールにも該当しない未知の操作               | —                              |

**設計原則**: 判定不能 = deny ではなく ask。権限ダイアログで確認し、学習で次回から allow する。
ただし、明示的な deny ルールに該当する操作は常に deny（学習で覆さない）。

### 境界防御（全操作共通の最終防衛線）

帳の Hooks とは独立に、境界で安全を強制する:

| 境界           | チェック内容               | 適用範囲       |
| -------------- | -------------------------- | -------------- |
| git-guard      | 秘密漏洩、プライベートパス | commit 時      |
| boundary-check | 公開境界違反               | CI             |
| STG ゲート     | 品質・完了基準             | ステージ遷移時 |
| PR レビュー    | 最終チェック               | マージ前       |

Hooks がすり抜けた操作も、境界で捕捉される。

---

### ✋ 手: Stop Hook（Git 自動操作）

ユーザーは Git の概念（commit, push, PR, merge）を知る必要がない。
帳がタスク完了を検知し、Git 操作を自動で実行する。

**仕組み**: Stop Hook + `decision: "block"`

Claude Code が「完了」と判断して停止しようとすると、Stop Hook が介入する。
`decision: "block"` を返すことで、Claude Code を停止させず続行させる。

```
Claude Code: 「実装完了」→ 停止しようとする
  │
  ▼
Stop Hook（帳の手）
  ├── git status に未コミットの変更あり？
  │     → YES: decision: "block"（停止させない）
  │           → git add → commit → push → PR 作成 → merge
  │     → NO: decision: ""（停止を許可）
  │
  └── stop_hook_active フラグで無限ループ防止
```

**ユーザーが見る通知（GitHub PR）**:

帳が自動で GitHub PR を作成する。ユーザーは GitHub Mobile で通知を受信し、
URL をタップして結果を確認する。

```
📱 GitHub Mobile 通知:
  "tobari opened a pull request: ログイン機能の実装"
  → タップで PR ページへ（差分・テスト結果を確認可能）
```

- **「PR」「merge」とは言わない**。ユーザーには「確認してください」+ URL だけ
- ユーザーは URL をクリックして結果を確認するだけ
- Git の概念は一切見せない
- 外出先でも GitHub Mobile で通知を受信可能

---

### 🦿 脚: Stop Hook（自己修復）

テストが失敗しても、帳がまず自力で修復を試みる。
ユーザーに「テストが失敗しました」と報告する前に、回復を試みる。

**仕組み**: Stop Hook + Circuit Breaker パターン

```
Claude Code: 「テスト失敗」→ 停止しようとする
  │
  ▼
Stop Hook（帳の脚）
  ├── テスト失敗 + retry_count < MAX_RETRIES(3)?
  │     → YES: decision: "block"
  │           → エラーメッセージを分析 → 修正 → 再テスト
  │           → retry_count++
  │     → NO (3回失敗): decision: ""（停止を許可）
  │           → セッション停止（エラー内容を表示）
  │
  └── Circuit Breaker: 3回修復失敗 → 人間にエスカレート
```

**設計根拠**: ICLR 2024 の研究では、LLM は外部シグナル（テスト結果）なしでは自己修正できない。
テスト出力という外部フィードバックを与えることで、修復成功率が大幅に向上する。

---

### 🧠 記憶: Session Hooks（状態維持）

Claude Code のコンテキストはセッション終了やコンパクション（圧縮）でリセットされる。
帳の記憶が、作業状態をセッション横断で保持する。

**仕組み**: SessionStart + PreCompact + SessionEnd Hooks

```
SessionStart Hook
  └── tobari-session.json を読み込み → Claude Code のコンテキストに注入

PreCompact Hook（コンパクション直前に発火）
  └── 現在の作業状態を tobari-session.json に書き出し
  └── コンパクション後も文脈が失われない

SessionEnd Hook
  └── 最終状態を tobari-session.json に保存
```

- **SessionStart**: stdout が Claude Code のコンテキストに注入される（公式仕様）
- **PreCompact**: コンパクション後も残る「記憶の救済ボート」
- **SessionEnd**: セッション横断の学習内容を永続化

---

### 👛 財布: PostToolUse async（コスト制御）

Claude Code のトークン消費はタスクにより最大10倍の差がある（SWE-Bench 調査）。
帳がリアルタイムでトークン消費を監視し、予算超過を防止する。

**仕組み**: PostToolUse Hook（async = 非ブロッキング）

```
PostToolUse Hook（毎操作後、非同期で実行）
  └── token_usage を集計
  └── しきい値チェック:
       ├── 50% → tobari-session.json に記録（ログのみ）
       ├── 80% → 画面に警告メッセージを表示
       └── 100% → Stop Hook と連携して停止
```

- **async**: 非同期実行のため、通常のワークフローを遅延させない
- **段階的通知**: いきなり停止するのではなく、段階的に警告
- Claude Pro サブスクリプションは定額だが、レート制限がある。帳が消費ペースを管理する

---

### 🦠 免疫: PreToolUse（依存・スコープ防御）

AI が生成するコードの20%は存在しないパッケージを推奨する（Slopsquatting 調査）。
帳の免疫システムが、不正な依存やスコープ逸脱を検出する。

**仕組み**: PreToolUse Hook（Bash コマンド検査）

```
PreToolUse Hook: Bash(npm install xxx)
  ├── xxx が allowlist に存在する？
  │     → YES: allow
  │     → NO: registry で存在確認
  │           → 存在しない: deny（Slopsquatting 防御）
  │           → 存在する: ask（権限ダイアログで確認 → 学習）
  │
PreToolUse Hook: Edit/Write(path)
  ├── path が contract.scope.include 内？
  │     → YES: allow
  │     → NO: path が contract.scope.exclude 内？
  │           → YES: deny
  │           → NO: ask（スコープ外だが破壊的でない）
```

- **依存の許可リスト**: 学習する帳の一部。許可したパッケージは次回から自動承認
- **スコープ制御**: 契約で定義されたファイル範囲を超える操作を検出
- **Slopsquatting 防御**: 存在しないパッケージのインストールを自動ブロック

## 8. 実装設計

### 「帳がおりている」の技術的な意味

`.claude/tobari-session.json` の存在 = 帳が active。

```json
{
  "active": true,
  "task": "my-feature",
  "profile": "standard",
  "started_at": "2026-02-25T14:00:00Z",
  "gates_passed": ["STG0", "STG1"],
  "retry_count": 0,
  "token_usage": {
    "input": 0,
    "output": 0,
    "budget": 500000
  },
  "git_state": {
    "branch": "feat/my-feature",
    "uncommitted_changes": false,
    "pr_url": null
  },
  "contract": {
    "intent": "ログイン機能の実装",
    "requirements": { "do": [], "do_not": [] },
    "dod": [],
    "scope": { "include": [], "exclude": [] },
    "risk_level": "medium"
  },
  "learned_permissions": [],
  "evidence": []
}
```

| フィールド            | 器官    | 用途                                   |
| --------------------- | ------- | -------------------------------------- |
| `gates_passed`        | 🫀 心臓 | 通過済み STG ゲート                    |
| `retry_count`         | 🦿 脚   | 自己修復の試行回数（MAX: 3）           |
| `token_usage`         | 👛 財布 | トークン消費の累計と予算               |
| `git_state`           | ✋ 手   | ブランチ・未コミット変更・PR URL       |
| `contract`            | 🫀 心臓 | タスク契約（スコープ・要件・完了基準） |
| `learned_permissions` | 👄 口   | 権限ダイアログで学習した永続ルール     |
| `evidence`            | 👁️ 目   | 証跡ファイルのパスリスト               |

### 3本柱 → 実装メカニズム

| 柱        | 実装                                                                                    |
| --------- | --------------------------------------------------------------------------------------- |
| 🔒 止める | **PreToolUse Hook** — `permissionDecision: "deny"` で破壊的操作・境界違反を自動ブロック |
| ✅ 進む   | **PreToolUse Hook** — `permissionDecision: "allow"` で安全な操作を自動承認              |
| 📋 残す   | **PostToolUse Hook** — 全操作を Evidence Ledger (JSONL) に自動記録                      |

### Hooks 構成

| Hook                      | イベント             | 器官              | 役割                                                           | 追加     |
| ------------------------- | -------------------- | ----------------- | -------------------------------------------------------------- | -------- |
| `tobari-gate`             | PreToolUse           | 🫀 心臓 + 🦠 免疫 | 帳の判定（allow / deny / ask）+ 依存・スコープ検査             | v1.0.0   |
| `tobari-evidence`         | PostToolUse          | 👁️ 目             | 全操作（成功時）を JSONL に記録 + CLI クエリ                   | v1.0.0   |
| `tobari-evidence-failure` | PostToolUseFailure   | 👁️‍🗨️ 傷目         | ツール失敗を JSONL に記録（残す柱の穴塞ぎ）                    | v1.0.0   |
| `tobari-cost`             | PostToolUse (async)  | 👛 財布           | トークン消費の集計・警告（tobari-cost-state.json に記録）      | v1.0.0   |
| `tobari-permission`       | PermissionRequest    | 👄 口             | 権限ダイアログに文脈付加 + 永続ルール学習                      | v1.0.0   |
| `tobari-stop`             | Stop                 | ✋ 手             | テスト失敗時の自己修復（Circuit Breaker）                      | v1.0.0   |
| `tobari-session-start`    | SessionStart         | 🧠 記憶           | tobari-session.json の読み込み・コンテキスト注入 + A3 安全検査 | v1.0.0   |
| `tobari-precompact`       | PreCompact           | 🧠 記憶           | コンパクション前の状態退避                                     | v1.0.0   |
| `tobari-injection-guard`  | PostToolUse          | 🛡️ 盾            | プロンプトインジェクション検出（9カテゴリ / 34パターン）       | v1.1.0   |
| `tobari-stage`            | (CLI / ライブラリ)   | —                 | STG ゲート自動遷移 + DoD 検証 + backlog.yaml 更新              | v1.1.0   |
| `tobari-instructions`     | InstructionsLoaded   | 🛡️ 盾            | ルールファイルのハッシュ変更検出（A6 改竄検知）                | v1.2.0   |
| `tobari-config-change`    | ConfigChange         | 🛡️ 盾            | settings.json のハッシュ変更検出（A7 設定改竄検知）            | v1.2.0   |
| `tobari-teammate-idle`    | TeammateIdle         | —                 | Agent Teams メンバーのアイドル時ガイダンス（T1）               | v1.3.0   |
| `tobari-task-completed`   | TaskCompleted        | —                 | Agent Teams タスク完了時の証跡記録 + フィードバック（T2）      | v1.3.0   |
| `lint-on-save`            | PostToolUse          | —                 | Edit / Write 後にリンター・フォーマッター自動実行              | v1.1.0   |

#### 共有モジュール（Hook ではないが全 Hook の基盤）

| モジュール          | 役割                                                      | 追加   |
| ------------------- | --------------------------------------------------------- | ------ |
| `tobari-session.js` | tobari-session.json の読み書き。全 Hook の共通基盤        | v1.0.0 |
| `tobari-i18n.js`    | 国際化モジュール。t(key, params) で en / ja メッセージ解決 | v1.4.0 |

### `/tobari` のフロー

1. STG0: ユーザーが自然言語で意図を伝える
2. tobari が契約を生成（requirements + DoD + scope）
3. 「この内容で帳をおろして実装を開始しますか？」→ YES
4. tobari-session.json を作成（= 帳がおりる）
5. PreToolUse / PostToolUse / PermissionRequest Hooks 有効化
6. 詠唱 + ステータス表示
7. 以降、自動で前進（STG1→STG6）
8. 安全な操作は自動承認。危険な操作は自動ブロック
9. 判定不能な操作は権限ダイアログで確認（学習あり）

### コマンドエイリアス

```
/tobari <feature>    帳をおろしてプロジェクト開始（正式名）
/orose <feature>     同上（世界観エイリアス）
/startproject        同上（claude-code-orchestra 互換）
```

## 9. 初回セットアップ（オンボーディング）

### tobari の利用要件

| 要件              | 内容                                                |
| ----------------- | --------------------------------------------------- |
| Claude Code       | Anthropic 公式 CLI（インストール済みであること）    |
| Claude プラン     | Pro ($20/月) 以上                                   |
| GitHub アカウント | リポジトリ管理 + 完了通知受信（GitHub Mobile 推奨） |
| Node.js           | Claude Code の動作要件                              |
| Git               | バージョン管理（帳が自動操作する）                  |

### セットアップ手順（初回のみ）

```
1. tobari をインストール
   $ npm install -g tobari        ← 予定（将来の配布形態）

2. プロジェクトに帳を導入
   $ cd your-project
   $ /tobari init

   → .claude/hooks/ に帳の Hooks を配置
   → .claude/settings.json に権限ルールを設定
   → 緊急通知 Webhook を設定（任意、スキップ可）

3. 帳をおろす
   $ /tobari my-feature

   → 以降は帳が全てを管理する
```

### ユーザーがやること / やらないこと

| ユーザーがやること   | 帳がやること                             |
| -------------------- | ---------------------------------------- |
| 作りたいものを伝える | 要件を構造化（契約生成）                 |
| 帳の確認に答える     | 権限判定・自動承認                       |
| 完成物を確認する     | Git 操作（commit → push → PR → merge）   |
|                      | テスト実行・エラー修復（自動3回 → 報告） |
|                      | コスト監視・証跡記録                     |
|                      | セッション状態の保持・復元               |

### 初心者が知らなくていいこと

以下の概念は帳が完全に隠蔽する。ユーザーが学ぶ必要はない:

- Git（commit, push, branch, PR, merge）
- Hooks（PreToolUse, PostToolUse, Stop）
- STG ゲート（ステージ遷移）
- トークン消費量
- Claude Code の権限モデル

ユーザーに見えるのは:

1. 帳のステータス表示（`/tobari` 実行時）
2. 帳の確認ダイアログ（判定不能な操作時のみ。使い込むほど減少）
3. GitHub PR の完了通知（GitHub Mobile で受信）

## 10. backlog タスクとの対応

| タスク   | 器官              | 役割                                                    | 3本柱               |
| -------- | ----------------- | ------------------------------------------------------- | ------------------- |
| TASK-017 | —                 | `/tobari` コマンド実装                                  | 帳をおろす入口      |
| TASK-018 | 🧠 記憶           | tobari-session.json + Session Hooks                     | 状態維持            |
| TASK-019 | 🫀 心臓 + 🦠 免疫 | Gate Engine（PreToolUse: allow/deny/ask + 依存検査）    | 🔒 止める + ✅ 進む |
| TASK-020 | ✋ 手             | Stage Controller（STG 自動遷移 + Git 自動操作）         | ✅ 進む             |
| TASK-021 | 👁️ 目             | Evidence Ledger（PostToolUse）                          | 📋 残す             |
| TASK-022 | —                 | 統合テスト                                              | 帳の一気通貫検証    |
| TASK-025 | 👄 口             | 通知連携（権限ダイアログ文脈付加 + GitHub PR 完了通知） | ✅ 進む + 学習      |
| TASK-026 | 🦿 脚             | 自己修復エンジン（Stop Hook + Circuit Breaker）         | ✅ 進む             |
| TASK-027 | 👛 財布           | コスト監視（PostToolUse async + トークン予算）          | 📋 残す             |
| TASK-028 | —                 | 初回セットアップガイド（`/tobari init`）                | オンボーディング    |
| TASK-029 | —                 | 境界防御統合テスト                                      | 全層の結合検証      |

## 11. 更新履歴

| Date       | Content                                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-02-25 | 初版作成。タグライン・冒頭文・UX・実装設計を確定                                                                                                                                                                                                                                                                   |
| 2026-02-25 | v2: Claude Code 専用設計に移行。PreToolUse permissionDecision による承認制御、Discord 遠隔承認、学習する帳、境界防御モデルを追加。マルチエージェント（Codex/Gemini CLI）依存を削除                                                                                                                                 |
| 2026-02-25 | v3: 全身設計（9器官）追加。tobari アイデンティティ定義（tobari = エージェント、Claude Code = 実行エンジン）。手（Git 自動操作）、脚（自己修復）、記憶（状態維持）、財布（コスト制御）、免疫（依存・スコープ防御）を新設。Discord 通知の UX 改善（Git 用語排除、URL 提示）。初回セットアップ（オンボーディング）セクション追加 |
| 2026-02-25 | v4: 通知アーキテクチャ修正。Discord を必須双方向承認から除外し、オプション緊急 Webhook に格下げ。承認=ネイティブ権限ダイアログ（PC前提）、完了=GitHub PR（GitHub Mobile）、学習=updatedPermissions（自動）、緊急=Webhook（任意）。Discord アカウント要件を削除。tobari-discord → tobari-permission にリネーム      |
