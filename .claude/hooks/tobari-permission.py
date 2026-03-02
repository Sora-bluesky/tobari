#!/usr/bin/env python3
"""
PermissionRequest hook: tobari-permission — the voice of the veil (帳の口).

Fires when Claude Code is about to show a permission dialog to the user.

When the veil is active:
- Safe patterns within scope → auto-allow + updatedPermissions (learning)
- Unknown patterns → systemMessage with Japanese context (dialog shown to user)
- Never denies (tobari-gate.py / PreToolUse already handles denials)

When the veil is inactive:
- exit 0 (no interference, advisory mode only)

Implements the 口 (notification channel) pattern.
Learning via updatedPermissions: approved patterns are added to Claude Code's allow list.
"""

import json
import re
import sys
from pathlib import Path

# Import shared session reader
sys.path.insert(0, str(Path(__file__).parent))
import tobari_session


# --- Safe Bash Patterns (auto-allow + learn) ---

SAFE_BASH_PATTERNS: list[tuple[str, str]] = [
    # git commands (read/write)
    (r"^git\s+", "git コマンド"),
    # pwsh/powershell scripts
    (r"^pwsh\b", "PowerShell スクリプト"),
    (r"^powershell\b", "PowerShell スクリプト"),
    # Test runners
    (r"^pytest\b", "テスト実行"),
    (r"^npm\s+test\b", "テスト実行"),
    (r"^npm\s+run\s+test\b", "テスト実行"),
    (r"^python\s+-m\s+pytest\b", "テスト実行"),
    # Read-only shell commands
    (r"^(cat|ls|echo|pwd|head|tail|wc|sort|uniq|diff|find|grep|which|type|env)\b",
     "読み取り系コマンド"),
    # Safe file ops
    (r"^(mkdir|touch|cp|mv)\b", "ファイル操作"),
    # Python / Node execution
    (r"^(python|python3|node)\s+", "スクリプト実行"),
    # gh CLI (read-only operations)
    (r"^gh\s+(pr|issue|repo|release)\s+(list|view|status|check)\b",
     "GitHub CLI 読み取り"),
    # Text processing
    (r"^(jq|awk|sed|xargs|tr|cut)\b", "テキスト処理"),
    # Package managers (view/list only)
    (r"^npm\s+(list|ls|info|show|outdated)\b", "パッケージ情報確認"),
    # Environment / shell utilities
    (r"^(export|source|cd)\b", "シェル操作"),
    # Bash variable / conditional checks
    (r"^(test|true|false|\[)\b", "条件確認"),
]


def is_safe_bash(command: str) -> tuple[bool, str]:
    """Check if a Bash command matches known-safe patterns.

    Returns (is_safe, label) tuple.
    """
    if not command:
        return False, ""

    cmd = command.strip()
    for pattern, label in SAFE_BASH_PATTERNS:
        if re.match(pattern, cmd, re.IGNORECASE):
            return True, label
    return False, ""


def describe_operation(tool_name: str, tool_input: dict) -> str:
    """Generate a brief Japanese description of the tool operation."""
    if tool_name == "Bash":
        cmd = tool_input.get("command", "")
        desc = tool_input.get("description", "")
        if desc:
            return f"`{cmd[:60]}` — {desc}"
        return f"`{cmd[:80]}`"
    elif tool_name in ("Edit", "Write"):
        path = tool_input.get("file_path", "不明")
        return f"`{path}` を編集/作成"
    elif tool_name == "Read":
        return f"`{tool_input.get('file_path', '不明')}` を読み込み"
    elif tool_name in ("Glob", "Grep"):
        return "ファイルを検索"
    elif tool_name == "WebFetch":
        return f"{tool_input.get('url', 'URL')[:60]} を取得"
    elif tool_name == "WebSearch":
        return f"`{tool_input.get('query', '')[:60]}` を検索"
    elif tool_name == "Task":
        return f"サブエージェントを起動: {tool_input.get('description', '')[:60]}"
    return f"{tool_name} を実行"


def classify_operation(tool_name: str, tool_input: dict) -> tuple[str, str]:
    """Classify the operation as 'safe' or 'unknown'.

    Returns (classification, reason) tuple:
    - 'safe': auto-allow + updatedPermissions
    - 'unknown': show dialog with Japanese context
    """
    # Read-only tools: always safe
    if tool_name in ("Read", "Glob", "Grep"):
        return "safe", f"{tool_name} は読み取り専用操作"

    # Task (subagent spawn): safe — already governed by its own session
    if tool_name == "Task":
        return "safe", "サブエージェント起動（帳管轄内）"

    # Bash: check safe patterns
    if tool_name == "Bash":
        command = tool_input.get("command", "")
        safe, label = is_safe_bash(command)
        if safe:
            return "safe", label
        return "unknown", "安全パターン外のコマンド"

    # Edit/Write: check contract scope
    if tool_name in ("Edit", "Write", "NotebookEdit"):
        file_path = (
            tool_input.get("file_path", "")
            or tool_input.get("notebook_path", "")
        )
        if file_path:
            in_scope = tobari_session.is_path_in_scope(file_path)
            if in_scope is True:
                return "safe", "契約スコープ内のファイル"
            if in_scope is None:
                # No scope restriction = safe
                return "safe", "スコープ制限なし"
        return "unknown", "スコープ未確認のファイル操作"

    # Other tools: unknown (let user decide)
    return "unknown", f"{tool_name} の操作"


def make_system_message(
    tool_name: str,
    tool_input: dict,
    reason: str,
    task: str,
    profile: str,
) -> str:
    """Build Japanese systemMessage for unknown operations."""
    op_desc = describe_operation(tool_name, tool_input)
    return (
        f"🎭 帳 [{task}] — {op_desc}\n"
        f"プロファイル: {profile}　理由: {reason}\n"
        f"承認する場合は「常に許可」を選択すると次回から自動承認されます。"
    )


def main() -> None:
    try:
        data = json.load(sys.stdin)
        tool_name = data.get("tool_name", "")
        tool_input = data.get("tool_input", {})
        # permission_suggestions: "always allow" options the user would see
        permission_suggestions = data.get("permission_suggestions", [])

        # Load session — veil inactive: no interference
        session = tobari_session.load_session()
        if not session:
            sys.exit(0)

        task = tobari_session.get_task() or "unknown"
        profile = tobari_session.get_profile() or "standard"

        # Classify the operation
        classification, reason = classify_operation(tool_name, tool_input)

        if classification == "safe":
            # Auto-allow + learn via updatedPermissions
            response = {
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {
                        "behavior": "allow",
                        "updatedPermissions": permission_suggestions,
                    },
                }
            }
            tobari_session.write_evidence({
                "event": "permission_granted",
                "tool_name": tool_name,
                "reason": reason,
                "task": task,
                "learned": len(permission_suggestions) > 0,
            })
            print(json.dumps(response))
            sys.exit(0)

        else:
            # Unknown: show dialog with Japanese context via systemMessage
            msg = make_system_message(tool_name, tool_input, reason, task, profile)
            response = {
                "systemMessage": msg,
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                },
            }
            tobari_session.write_evidence({
                "event": "permission_asked",
                "tool_name": tool_name,
                "reason": reason,
                "task": task,
            })
            print(json.dumps(response))
            sys.exit(0)

    except Exception as e:
        # Fail-open: never block on hook errors
        print(f"Hook error: {e}", file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
