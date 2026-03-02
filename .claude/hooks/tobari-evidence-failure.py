#!/usr/bin/env python3
"""
PostToolUseFailure hook: Failure evidence — the scarred eye of tobari (帳の傷目, 👁️‍🗨️).

Records tool failures to .claude/logs/evidence-ledger.jsonl
while the veil (帳) is active.

Symmetric counterpart to tobari-evidence.py (which records successes).
Together they close the gap in the "📋 残す" (record everything) pillar.

Design:
- Fail-open: hook errors never block tool execution
- Veil-gated: only records when session is active
- Minimal: capture tool name, error, and context — no heavy processing
"""

import json
import sys
from pathlib import Path

# Import shared session reader + evidence writer
sys.path.insert(0, str(Path(__file__).parent))
import tobari_session

MAX_ERROR_LENGTH = 1000


def _summarize_error(tool_error: str) -> str:
    """Truncate error message to a reasonable length."""
    if len(tool_error) > MAX_ERROR_LENGTH:
        return tool_error[:MAX_ERROR_LENGTH] + "..."
    return tool_error


def _summarize_tool_input(tool_name: str, tool_input: dict) -> dict:
    """Create a compact summary of tool input for failure context."""
    if tool_name == "Bash":
        cmd = tool_input.get("command", "")
        return {"command": cmd[:200] + ("..." if len(cmd) > 200 else "")}
    elif tool_name in ("Edit", "Write", "NotebookEdit"):
        return {
            "file_path": tool_input.get("file_path", "")
            or tool_input.get("notebook_path", ""),
        }
    elif tool_name == "Read":
        return {"file_path": tool_input.get("file_path", "")}
    elif tool_name in ("Grep", "Glob"):
        return {"pattern": tool_input.get("pattern", "")}
    else:
        raw = json.dumps(tool_input, ensure_ascii=False)
        return {"raw": raw[:200] + ("..." if len(raw) > 200 else "")}


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    # Only record when veil is active
    session = tobari_session.load_session()
    if not session:
        sys.exit(0)

    tool_name = data.get("tool_name", "unknown")
    tool_input = data.get("tool_input", {})
    tool_error = data.get("tool_error", "")

    entry = {
        "event": "tool_failed",
        "tool_name": tool_name,
        "input_summary": _summarize_tool_input(tool_name, tool_input),
        "error": _summarize_error(str(tool_error)),
        "task": session.get("task", ""),
        "profile": session.get("profile", ""),
    }

    tobari_session.write_evidence(entry)

    # No hookSpecificOutput — silent recording
    sys.exit(0)


if __name__ == "__main__":
    main()
