#!/usr/bin/env python3
"""
PreToolUse hook: Gate Engine — the heart of tobari's veil (帳の心臓).

When the veil is active, this hook enforces safety rules:
- Bash: blocks destructive commands (rm -rf, git push --force, etc.)
- Edit/Write: blocks scope violations, boundary classification violations, secrets

When the veil is inactive, provides design-change advisory (no blocking).

Unified hook for permission decisions.
Consolidated from earlier per-tool hooks.

Profile behavior:
- Lite: destructive Bash deny only (minimal gate density)
- Standard: full deny patterns (destructive Bash + scope + boundary + secrets)
- Strict: full deny + suspicious pattern deny (curl POST, eval, exec)
"""

import json
import os
import platform
import re
import sys
from pathlib import Path

# Import shared session reader
sys.path.insert(0, str(Path(__file__).parent))
import tobari_session

# --- Constants ---

_IS_WINDOWS = platform.system() == "Windows"

MAX_PATH_LENGTH = 4096
MAX_CONTENT_LENGTH = 1_000_000
COMMAND_TRUNCATE_LENGTH = 120

def _get_project_root() -> Path | None:
    """Get project root from CLAUDE_PROJECT_DIR or fallback."""
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    if project_dir:
        return Path(os.path.realpath(project_dir))
    # Fallback: hooks dir is {project}/.claude/hooks/
    try:
        return Path(__file__).resolve().parent.parent.parent
    except Exception:
        return None

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
    (r"git\s+push\s+(?:.*\s)?-f\b", "git push -f（リモート履歴の強制上書き）"),
    (r"git\s+reset\s+--hard", "git reset --hard（未コミット変更の全破棄）"),
    (r"git\s+clean\s+.*-[a-zA-Z]*f", "git clean -f（未追跡ファイルの強制削除）"),
    (r"git\s+checkout\s+--\s+\.", "git checkout -- .（全変更の破棄）"),
    (r"git\s+restore\s+.*--worktree\s+\.", "git restore --worktree .（全変更の復元）"),
    # Refined git destructive patterns
    (r"git\s+branch\s+(?:-[a-zA-Z]*(?-i:D)|-d\s+--force)\b", "git branch -D（ブランチの強制削除）"),
    (r"git\s+push\s+.*--delete\b", "git push --delete（リモートブランチ削除）"),
    (r"git\s+push\s+\S+\s+:\S+", "git push origin :branch（リモートブランチ削除）"),
    (r"git\s+stash\s+(drop|clear)\b", "git stash drop/clear（stash の削除）"),
    (r"git\s+reflog\s+(delete|expire)\b", "git reflog delete/expire（reflog の削除）"),
    (r"git\s+filter-branch\b", "git filter-branch（履歴の書き換え）"),

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

# Hardcoded fallback (used when YAML is unavailable)
_FALLBACK_SECRET_PATTERNS: list[tuple[str, str]] = [
    (r"""(?:api[_-]?key|apikey)\s*[=:]\s*["']([A-Za-z0-9_\-]{20,})["']""",
     "API キー"),
    (r"AKIA[0-9A-Z]{16}",
     "AWS アクセスキー"),
    (r"""(?:password|passwd|pwd|secret)\s*[=:]\s*["']([^"']{8,})["']""",
     "パスワード/シークレット"),
    (r"-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----",
     "秘密鍵"),
    (r"(?:mongodb|postgres|mysql|redis)://[^:]+:[^@]+@",
     "接続文字列（パスワード含む）"),
]

# --- Sensitive File Access Patterns ---
# Detect shell commands that read sensitive files (cat, less, more, etc.)

SENSITIVE_FILE_ACCESS_PATTERNS: list[tuple[str, str]] = [
    (r"\b(cat|less|more|head|tail|bat|type)\b.*~/\.ssh/",
     "SSH key/config file access"),
    (r"\b(cat|less|more|head|tail|bat|type)\b.*/\.ssh/",
     "SSH key/config file access"),
    (r"\b(cat|less|more|head|tail|bat|type)\b.*~/\.aws/",
     "AWS credential file access"),
    (r"\b(cat|less|more|head|tail|bat|type)\b.*/\.aws/",
     "AWS credential file access"),
    (r"\b(cat|less|more|head|tail|bat|type)\b.*~/\.gnupg/",
     "GnuPG key file access"),
    (r"\b(cat|less|more|head|tail|bat|type)\b.*/\.gnupg/",
     "GnuPG key file access"),
    (r"\b(cat|less|more|head|tail|bat|type)\b.*\.env\b",
     ".env file (secrets/environment) access"),
    (r"\b(cat|less|more|head|tail|bat|type)\b.*~/\.kube/config",
     "Kubernetes config file access"),
    (r"\b(cat|less|more|head|tail|bat|type)\b.*~/\.config/gcloud/",
     "GCP credential file access"),
]

def _load_secret_patterns() -> list[tuple[str, str]]:
    """Load secret patterns from shared YAML definition.

    Falls back to hardcoded patterns if YAML is unavailable.
    """
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    if project_dir:
        yaml_path = Path(project_dir) / "integration" / "secret-patterns.yaml"
    else:
        yaml_path = Path(__file__).resolve().parent.parent.parent / "integration" / "secret-patterns.yaml"

    if yaml_path.exists():
        try:
            import yaml
            with open(yaml_path, encoding="utf-8") as f:
                data = yaml.safe_load(f)
            patterns = []
            for entry in data.get("patterns", []):
                regex = entry.get("regex", "")
                label = entry.get("label_ja", entry.get("id", ""))
                if regex:
                    patterns.append((regex, label))
            if patterns:
                return patterns
        except Exception:
            pass  # Fall through to hardcoded
    return _FALLBACK_SECRET_PATTERNS

SECRET_PATTERNS = _load_secret_patterns()

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

    Path traversal checks:
    1. Null byte (poison byte — truncation attack)
    2. UNC paths (\\\\server\\share or //server/share)
    3. NT prefixes (\\\\?\\, \\\\.\\)
    4. Windows ADS (Alternate Data Streams) — colon after drive letter
    5. os.path.realpath() normalization — resolves symlinks and ..
    6. Fallback: component-level ".." check (when project root unavailable)
    """
    if not file_path:
        return "ファイルパスが空です"
    if len(file_path) > MAX_PATH_LENGTH:
        return f"ファイルパスが長すぎます（{len(file_path)} > {MAX_PATH_LENGTH}）"
    if len(content) > MAX_CONTENT_LENGTH:
        return f"コンテンツが大きすぎます（{len(content)} > {MAX_CONTENT_LENGTH}）"

    # Null byte check (poison byte — truncation attack)
    if "\x00" in file_path:
        return f"ヌルバイトを検出: {file_path!r}"

    # UNC path check — must come BEFORE ADS check (\\?\C:\... has colon)
    if file_path.startswith("\\\\") or file_path.startswith("//"):
        return f"UNC パスを検出: {file_path}"

    # NT prefix check
    if file_path.startswith("\\\\?\\") or file_path.startswith("\\\\.\\"):
        return f"NT プレフィックスを検出: {file_path}"

    # Windows ADS check: colon only valid at drive letter position (index 1)
    if _IS_WINDOWS:
        path_after_drive = file_path[2:] if len(file_path) > 2 and file_path[1] == ":" else file_path
        if ":" in path_after_drive:
            return f"Windows ADS（代替データストリーム）を検出: {file_path}"

    # Path traversal via realpath normalization
    project_root = _get_project_root()
    if project_root:
        try:
            # Resolve against project root for relative paths
            if os.path.isabs(file_path):
                resolved = os.path.realpath(file_path)
            else:
                resolved = os.path.realpath(
                    os.path.join(str(project_root), file_path)
                )
            root_str = str(project_root)
            if not (resolved.startswith(root_str + os.sep) or resolved == root_str):
                return f"パストラバーサルを検出（プロジェクトルート外: {file_path}）"
        except (OSError, ValueError):
            return f"パス解決に失敗: {file_path}"
    else:
        # Fallback: component-level ".." check (more precise than "in")
        normalized = file_path.replace("\\", "/")
        parts = normalized.split("/")
        if ".." in parts:
            return f"パストラバーサルを検出（'..' コンポーネント: {file_path}）"

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

    # Check for sensitive file access patterns
    for pattern, label in SENSITIVE_FILE_ACCESS_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return make_deny_response(
                reason="機密ファイルへのアクセスを検出",
                detail=f"検出パターン: {label}\n  コマンド: {truncate_command(command)}",
                recovery="機密ファイルの内容をコマンドラインで表示しないでください。\n"
                "  ファイルの存在確認には `test -f` を使用してください。",
                tool_name="Bash",
            )

    return None

def check_advisory_destructive_bash(command: str) -> dict | None:
    """Advisory mode: warn (but don't block) when destructive Bash patterns detected.

    Uses hookSpecificOutput.additionalContext to provide safety awareness
    even when the veil is inactive. Does NOT set permissionDecision.
    """
    for pattern, label in DESTRUCTIVE_BASH_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "additionalContext": (
                        f"[Advisory] Destructive command detected: {label}\n"
                        f"Command: {truncate_command(command)}\n"
                        "The veil is inactive, so this command was NOT blocked.\n"
                        "Consider using safer alternatives."
                    ),
                }
            }
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
                        "Consider reviewing design implications before proceeding."
                    ),
                }
            }

    if content and len(content) > 500:
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": (
                    "[Large File Advisory] Creating new file with significant content. "
                    "Consider self-reviewing for design implications before proceeding."
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
            if tool_name == "Bash":
                command = tool_input.get("command", "")
                if command:
                    result = check_advisory_destructive_bash(command)
                    if result:
                        print(json.dumps(result))
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
