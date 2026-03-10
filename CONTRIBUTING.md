# Contributing to tobari

tobari への貢献に興味を持っていただきありがとうございます。

## Development Setup

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | 18+ | CLI / Hooks / テスト実行 |
| [Git](https://git-scm.com/) | -- | バージョン管理 |

### Getting Started

```bash
# リポジトリをクローン
git clone https://github.com/Sora-bluesky/tobari.git
cd tobari

# 依存関係をインストール
npm install

# テストを実行
npm test
```

## How to Contribute

### Issues

- バグ報告や機能リクエストは [Issues](https://github.com/Sora-bluesky/tobari/issues) から
- テンプレートに沿って記入してください
- 再現手順・期待動作・実際の動作を明記

### Pull Requests

1. `main` ブランチから feature ブランチを作成

   ```bash
   git checkout -b feat/your-feature
   ```

2. 変更を実装

3. テストが通ることを確認

   ```bash
   npm test
   ```

4. コミット（Conventional Commits 形式）

   ```bash
   git commit -m "feat: add new detection pattern"
   ```

5. Push して PR を作成

   ```bash
   git push origin feat/your-feature
   ```

### PR のルール

- `main` ブランチへの直接 push は禁止（PR 必須）
- CI が全て通ること
- 1 PR = 1 機能 or 1 修正（小さく保つ）

## Coding Standards

### Commit Messages

[Conventional Commits](https://www.conventionalcommits.org/) に準拠:

| Prefix | Usage |
|--------|-------|
| `feat:` | 新機能 |
| `fix:` | バグ修正 |
| `docs:` | ドキュメント |
| `refactor:` | リファクタリング |
| `test:` | テスト追加・修正 |
| `chore:` | ビルド・設定 |

### JavaScript (CLI / Hooks)

- Node.js 18+
- CommonJS (`require`/`module.exports`)
- 変数名: `camelCase`
- 定数: `UPPER_SNAKE_CASE`

### General

- コードは英語で記述（変数名、コメント、docstring）
- ユーザー向けドキュメントは日本語 OK

## Project Structure

```
tobari/
  .claude/
    hooks/       Veil Hooks (auto-approve, block, evidence)
    skills/      Skill definitions (/tobari, /team-implement, etc.)
    rules/       Coding, security, and language rules
    agents/      Subagent definitions
    commands/    Slash commands
    settings.json  Permission settings
  bin/           CLI entry point + shared modules
  templates/     CLAUDE.md template for tobari init
  tests/         テスト
  package.json   npm パッケージ定義
```

## License

MIT License. 詳しくは [LICENSE](LICENSE) を参照。
