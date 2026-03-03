#!/usr/bin/env python3
"""
PreToolUse hook: Gate Engine — the heart of tobari's veil (帳の心臓).

When the veil is active, this hook enforces safety rules:
- Bash: blocks destructive commands (rm -rf, git push --force, etc.)
- Edit/Write: blocks scope violations, boundary classification violations, secrets

When the veil is inactive, provides design-change advisory (no blocking).

Unified PreToolUse hook for permission decisions.

Profile behavior:
- Lite: destructive Bash deny only (minimal gate density)
- Standard: full deny patterns (destructive Bash + scope + boundary + secrets)
- Strict: full deny + suspicious pattern deny (curl POST, eval, exec)
"""

import json
import re
import sys
from pathlib import Path

# Import shared session reader
sys.path.insert(0, str(Path(__file__).parent))
import tobari_session

# --- Constants ---

MAX_PATH_LENGTH = 4096
MAX_CONTENT_LENGTH = 1_000_000
COMMAND_TRUNCATE_LENGTH = 120

# --- Destructive Bash Patterns (all profiles) ---

DESTRUCTIVE_BASH_PATTERNS: list[tuple[str, str]] = [
    # File system destruction
    (r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b", "rm -rf（再帰的強制削除）"),
    (r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+/", "rm -r /（ルートディレクトリの再帰削除）"),
    (r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+~", "rm -r ~（ホームディレクトリの再帰削除）"),
    (r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+\.\s*$", "rm -r .（カレントディレクトリの再帰削除）"),
    (r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+\.\.", "rm -r ..（親ディレクトリの再帰削除）"),

    # Git destructive operations
    (r"git\s+push\s+.*--force(?!-with-lease)\b", "git push --force（リモート履歴の強制上書き）"),
    (r"git\s+push\s+.*\s-f\b", "git push -f（リモート履歴の強制上書き）"),
    (r"git\s+reset\s+--hard", "git reset --hard（未コミット変更の全破棄）"),
    (r"git\s+clean\s+.*-[a-zA-Z]*f", "git clean -f（未追跡ファイルの強制削除）"),
    (r"git\s+checkout\s+--\s+\.", "git checkout -- .（全変更の破棄）"),
    (r"git\s+restore\s+.*--worktree\s+\.", "git restore --worktree .（全変更の復元）"),

    # Database destruction
    (r"drop\s+table", "DROP TABLE（テーブル削除）"),
    (r"drop\s+database", "DROP DATABASE（データベース削除）"),
    (r"truncate\s+table", "TRUNCATE TABLE（テーブルデータ全削除）"),

    # System-level danger
    (r"chmod\s+(-[a-zA-Z]*R[a-zA-Z]*)\s+777\s+/", "chmod -R 777 /（全ファイルの権限変更）"),
    (r"mkfs\.", "mkfs（ディスクフォーマット）"),
    (r"dd\s+.*of=/dev/", "dd of=/dev/（デバイスへの直接書き込み）"),

    # Process/system danger
    (r"kill\s+-9\s+-1", "kill -9 -1（全プロセス強制終了）"),
    (r"\bshutdown\b", "shutdown（システムシャットダウン）"),
    (r"\breboot\b", "reboot（システム再起動）"),
]

# --- Strict Profile Additional Patterns ---

STRICT_SUSPICIOUS_PATTERNS: list[tuple[str, str]] = [
    (r"\|.*\bcurl\b", "パイプ経由の curl（データ流出リスク）"),
    (r"\bcurl\s+.*-X\s+(POST|PUT|DELETE)", "curl による変更系 HTTP リクエスト"),
    (r"\bwget\s+.*-O\s+/", "wget によるシステムパスへの書き込み"),
    (r"\beval\s+", "eval（コード注入リスク）"),
]

# --- Secret Detection Patterns ---

SECRET_PATTERNS: list[tuple[str, str]] = [
    # API keys with assignment
    (r"""(?:api[_-]?key|apikey)\s*[=:]\s*["']([A-Za-z0-9_\-]{20,})["']""",
     "API キー"),
    # AWS access keys
    (r"AKIA[0-9A-Z]{16}",
     "AWS アクセスキー"),
    # Generic password/secret assignment
    (r"""(?:password|passwd|pwd|secret)\s*[=:]\s*["']([^"']{8,})["']""",
     "パスワード/シークレット"),
    # Private keys
    (r"-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----",
     "秘密鍵"),
    # Connection strings with embedded passwords
    (r"(?:mongodb|postgres|mysql|redis)://[^:]+:[^@]+@",
     "接続文字列（パスワード含む）"),
]

# --- Advisory Mode Patterns (veil-off) ---

DESIGN_INDICATORS = [
    "DESIGN.md", "ARCHITECTURE.md", "architecture", "design",
    "schema", "model", "interface", "abstract", "base_",
    "core/", "/core/", "config", "settings",
    "class ", "interface ", "abstract class", "def __init__",
    "from abc import", "Protocol", "@dataclass", "TypedDict",
    "backlog", "governance", "binding", "gate", "stg",
    "preflight", "manifest", "stage_status",
]

SIMPLE_EDIT_PATTERNS = [
    ".gitignore", "README.md", "CHANGELOG.md", "requirements.txt",
    "package.json", "pyproject.toml", ".env.example", "HANDOFF.md",
    "backlog.yaml",
]


# --- Input Validation ---


def validate_input(file_path: str, content: str) -> str | None:
    """Validate input for security.

    Returns:
        None if input is valid.
        A failure reason string if input is invalid (fail-close).
    """
    if not file_path:
        return "ファイルパスが空です"
    if len(file_path) > MAX_PATH_LENGTH:
        return f"ファイルパスが長すぎます（{len(file_path)} > {MAX_PATH_LENGTH}）"
    if len(content) > MAX_CONTENT_LENGTH:
        return f"コンテンツが大きすぎます（{len(content)} > {MAX_CONTENT_LENGTH}）"
    if ".." in file_path:
        return f"パストラバーサルを検出（'..' を含むパス: {file_path}）"
    return None


def truncate_command(command: str) -> str:
    """Truncate command for display in messages."""
    if len(command) <= COMMAND_TRUNCATE_LENGTH:
        return command
    return command[:COMMAND_TRUNCATE_LENGTH] + "..."


# --- Deny Response Builder ---


def make_deny_response(reason: str, detail: str, recovery: str,
                       tool_name: str = "", tool_input: dict | None = None) -> dict:
    """Create a standardized deny response with Japanese messages.

    Also records the deny event to the Evidence Ledger (📋 残す)
    and sends an emergency webhook notification if configured.
    """
    task = tobari_session.get_task() or "unknown"
    profile = tobari_session.get_profile() or "unknown"

    # Record deny event to Evidence Ledger
    tobari_session.write_evidence({
        "event": "tool_denied",
        "tool_name": tool_name,
        "reason": reason,
        "detail": detail,
        "task": task,
        "profile": profile,
    })

    # Emergency webhook: fire-and-forget if configured in tobari-session.json
    session = tobari_session.load_session()
    webhook_url = tobari_session.get_webhook_config(session) if session else None
    if webhook_url:
        tobari_session.send_webhook(webhook_url, {
            "event": "tool_denied",
            "task": task,
            "tool": tool_name,
            "reason": reason,
            "profile": profile,
        })

    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "additionalContext": (
                f"🔒 帳が止めました — {reason}\n"
                f"\n"
                f"  タスク: {task}\n"
                f"  プロファイル: {profile}\n"
                f"  {detail}\n"
                f"\n"
                f"対処法:\n"
                f"  {recovery}"
            ),
        }
    }


# --- Gate Checks: Bash ---


def check_destructive_bash(command: str, profile: str) -> dict | None:
    """Check Bash command against destructive patterns.

    All profiles: DESTRUCTIVE_BASH_PATTERNS
    Strict only: STRICT_SUSPICIOUS_PATTERNS (additional)
    """
    for pattern, label in DESTRUCTIVE_BASH_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return make_deny_response(
                reason="破壊的コマンドを検出",
                detail=f"検出: {label}\n  コマンド: {truncate_command(command)}",
                recovery="安全な代替コマンドを使用してください。\n"
                "  例: rm -rf → 個別ファイルの rm、git push --force → git push --force-with-lease",
                tool_name="Bash",
            )

    if profile == "strict":
        for pattern, label in STRICT_SUSPICIOUS_PATTERNS:
            if re.search(pattern, command, re.IGNORECASE):
                return make_deny_response(
                    reason="Strict プロファイルで不審なコマンドを検出",
                    detail=f"検出: {label}\n  コマンド: {truncate_command(command)}",
                    recovery="安全性を確認してから再実行してください。\n"
                    "  Standard プロファイルに変更するか、帳をおろし直してください（/tobari）。",
                    tool_name="Bash",
                )

    return None


def check_secret_in_bash(command: str) -> dict | None:
    """Detect secrets leaked via Bash commands (e.g., echo with API keys)."""
    for pattern, label in SECRET_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return make_deny_response(
                reason="Bash コマンド内に秘密情報を検出",
                detail=f"検出パターン: {label}",
                recovery="秘密情報をコマンドに直接含めないでください。\n"
                "  環境変数（$ENV_VAR）を使用してください。",
                tool_name="Bash",
            )
    return None


# --- Gate Checks: Edit/Write ---


def check_scope(file_path: str, tool_name: str) -> dict | None:
    """Check file path against contract scope."""
    in_scope = tobari_session.is_path_in_scope(file_path)

    if in_scope is None:
        return None

    if in_scope is False:
        scope = tobari_session.get_scope() or {}
        return make_deny_response(
            reason="契約範囲外のファイル操作を検出",
            detail=(
                f"対象ファイル: {file_path}\n"
                f"  契約スコープ: {scope.get('include', [])}\n"
                f"  除外パス: {scope.get('exclude', [])}"
            ),
            recovery="契約範囲を変更するには、帳をおろし直してください（/tobari）。",
            tool_name=tool_name,
        )

    return None


def check_boundary_classification(file_path: str, tool_name: str) -> dict | None:
    """Check if file violates boundary classification rules.

    Blocks writes to private_only files that are outside the contract scope.
    Prevents accidental modification of governance-internal files.
    """
    classification = tobari_session.get_boundary_classification(file_path)

    if classification != "private_only":
        return None

    # If scope check already allows it, don't double-block
    scope_check = tobari_session.is_path_in_scope(file_path)
    if scope_check is True:
        return None

    return make_deny_response(
        reason="境界分類違反 — private_only ファイルへの操作を検出",
        detail=f"ファイル: {file_path}\n  分類: private_only（ガバナンス内部専用）",
        recovery="このファイルはガバナンス内部専用です。\n"
        "  契約範囲を変更するには、帳をおろし直してください（/tobari）。",
        tool_name=tool_name,
    )


def check_secret_in_content(content: str, tool_name: str) -> dict | None:
    """Detect hardcoded secrets in file content being written."""
    if not content:
        return None

    for pattern, label in SECRET_PATTERNS:
        if re.search(pattern, content, re.IGNORECASE):
            return make_deny_response(
                reason="秘密情報のハードコードを検出",
                detail=f"検出パターン: {label}",
                recovery="環境変数（os.environ）を使用してください。\n"
                "  .env ファイルに秘密情報を格納し、.gitignore に追加してください。",
                tool_name=tool_name,
            )

    return None


# --- Advisory Mode (veil-off, backward compatible) ---


def check_design_advisory(file_path: str, content: str) -> dict | None:
    """Advisory mode: flag design-related changes (no blocking)."""
    filepath_lower = file_path.lower()

    for pattern in SIMPLE_EDIT_PATTERNS:
        if pattern.lower() in filepath_lower:
            return None

    for indicator in DESIGN_INDICATORS:
        if indicator.lower() in filepath_lower:
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "additionalContext": (
                        f"[Design Change Detected] File path contains '{indicator}'. "
                        "Consider reviewing design implications before proceeding. "
                        "**Recommended**: Use Task tool with subagent_type='general-purpose' "
                        "for design review."
                    ),
                }
            }

    if content and len(content) > 500:
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": (
                    "[Review Suggestion] Creating new file with significant content. "
                    "Consider reviewing this plan for potential improvements. "
                    "**Recommended**: Use Task tool with subagent_type='general-purpose' "
                    "for deeper analysis and to preserve main context."
                ),
            }
        }

    return None


# --- Main Entry Point ---


def main():
    try:
        data = json.load(sys.stdin)
        tool_name = data.get("tool_name", "")
        tool_input = data.get("tool_input", {})

        session = tobari_session.load_session()

        if session:
            # === Veil active: Gate Engine mode ===
            profile = tobari_session.get_profile() or "standard"

            if tool_name == "Bash":
                command = tool_input.get("command", "")
                if not command:
                    sys.exit(0)

                # 1. Destructive command check
                result = check_destructive_bash(command, profile)
                if result:
                    print(json.dumps(result))
                    sys.exit(0)

                # 2. Secret in bash command
                result = check_secret_in_bash(command)
                if result:
                    print(json.dumps(result))
                    sys.exit(0)

                # Pass through
                sys.exit(0)

            elif tool_name in ("Edit", "Write", "NotebookEdit"):
                file_path = tool_input.get("file_path", "")
                if not file_path:
                    file_path = tool_input.get("notebook_path", "")
                content = (
                    tool_input.get("content", "")
                    or tool_input.get("new_string", "")
                    or tool_input.get("new_source", "")
                )

                validation_failure = validate_input(file_path, content)
                if validation_failure:
                    result = make_deny_response(
                        reason="不正な入力を検出",
                        detail=f"検証失敗: {validation_failure}",
                        recovery="正しいファイルパスとコンテンツで再実行してください。",
                        tool_name=tool_name,
                    )
                    print(json.dumps(result))
                    sys.exit(0)

                # 1. Scope check
                result = check_scope(file_path, tool_name)
                if result:
                    print(json.dumps(result))
                    sys.exit(0)

                # 2. Boundary classification check
                result = check_boundary_classification(file_path, tool_name)
                if result:
                    print(json.dumps(result))
                    sys.exit(0)

                # 3. Secret detection in content
                result = check_secret_in_content(content, tool_name)
                if result:
                    print(json.dumps(result))
                    sys.exit(0)

                # Pass through
                sys.exit(0)

            else:
                # Other tools: pass through
                sys.exit(0)

        else:
            # === No veil: Advisory mode (backward compatible) ===
            if tool_name in ("Edit", "Write", "NotebookEdit"):
                file_path = tool_input.get("file_path", "")
                if not file_path:
                    file_path = tool_input.get("notebook_path", "")
                content = (
                    tool_input.get("content", "")
                    or tool_input.get("new_string", "")
                    or tool_input.get("new_source", "")
                )

                validation_failure = validate_input(file_path, content)
                if validation_failure:
                    # Advisory mode: warn but don't block
                    print(json.dumps({
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "additionalContext": (
                                f"[Input Validation Warning] {validation_failure}\n"
                                "入力値を確認してください。"
                            ),
                        }
                    }))
                    sys.exit(0)

                result = check_design_advisory(file_path, content)
                if result:
                    print(json.dumps(result))

            sys.exit(0)

    except Exception as e:
        # Fail-open: don't block on hook errors
        print(f"Hook error: {e}", file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
