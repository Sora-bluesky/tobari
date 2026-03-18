# tobari — Claude Code Governance Framework

> Hooks で帳（とばり）をおろし、契約・ゲート・証跡で開発を統制する。

## Workflow

```
/tobari <機能名>    → 帳をおろす（STG0 契約）
/team-implement     → Agent Teams で並列実装
/team-review        → Agent Teams で並列レビュー
/handoff            → セッション引き継ぎ
```

## Key Gotchas

- `.claude/hooks/` は保護ディレクトリ — 帳を解除してから修正する
- `amendScope()` は scope を **置換** する（追加ではない）。既存スコープを含めて渡すこと

## Rules

@.claude/rules/binding-governance.md
@.claude/rules/coding-principles.md
@.claude/rules/security.md
@.claude/rules/dev-environment.md
@.claude/rules/language.md
@.claude/rules/testing.md

## Language Protocol

- **思考・コード**: 英語
- **ユーザー対話**: 日本語
