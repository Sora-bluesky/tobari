#!/usr/bin/env python3
"""
PostToolUse hook: Evidence Ledger — the eye of tobari (帳の目, 👁️).

Records all tool operations to .claude/logs/evidence-ledger.jsonl
while the veil (帳) is active.

Implements the "📋 残す" (record everything) pillar.

Also provides CLI for querying the ledger:
    python tobari-evidence.py summary
    python tobari-evidence.py quality-gates

Design:
- Fail-open: hook errors never block tool execution
- Efficient: minimal processing, append-only JSONL
- Smart summarization: truncates large inputs/outputs
"""

import json
import sys
from pathlib import Path

# Import shared session reader + evidence writer
sys.path.insert(0, str(Path(__file__).parent))
import tobari_session

# --- Constants ---

MAX_SUMMARY_LENGTH = 200
MAX_RESPONSE_LENGTH = 500


# --- Input Summarizers ---


def _summarize_bash(tool_input: dict) -> dict:
    """Summarize Bash tool input."""
    command = tool_input.get("command", "")
    return {
        "command": command[:MAX_SUMMARY_LENGTH] + ("..." if len(command) > MAX_SUMMARY_LENGTH else ""),
    }


def _summarize_edit(tool_input: dict) -> dict:
    """Summarize Edit tool input."""
    file_path = tool_input.get("file_path", "")
    old_str = tool_input.get("old_string", "")
    new_str = tool_input.get("new_string", "")
    return {
        "file_path": file_path,
        "old_size": len(old_str),
        "new_size": len(new_str),
        "replace_all": tool_input.get("replace_all", False),
    }


def _summarize_write(tool_input: dict) -> dict:
    """Summarize Write tool input."""
    return {
        "file_path": tool_input.get("file_path", ""),
        "content_size": len(tool_input.get("content", "")),
    }


def _summarize_read(tool_input: dict) -> dict:
    """Summarize Read tool input."""
    summary = {"file_path": tool_input.get("file_path", "")}
    if "offset" in tool_input:
        summary["offset"] = tool_input["offset"]
    if "limit" in tool_input:
        summary["limit"] = tool_input["limit"]
    return summary


def _summarize_grep(tool_input: dict) -> dict:
    """Summarize Grep tool input."""
    return {
        "pattern": tool_input.get("pattern", ""),
        "path": tool_input.get("path", ""),
        "glob": tool_input.get("glob", ""),
    }


def _summarize_glob(tool_input: dict) -> dict:
    """Summarize Glob tool input."""
    return {
        "pattern": tool_input.get("pattern", ""),
        "path": tool_input.get("path", ""),
    }


def _summarize_web(tool_input: dict) -> dict:
    """Summarize WebFetch/WebSearch tool input."""
    return {
        "url": tool_input.get("url", ""),
        "query": tool_input.get("query", ""),
        "prompt": (tool_input.get("prompt", "") or "")[:MAX_SUMMARY_LENGTH],
    }


def _summarize_task(tool_input: dict) -> dict:
    """Summarize Task tool input."""
    return {
        "description": tool_input.get("description", ""),
        "subagent_type": tool_input.get("subagent_type", ""),
    }


def _summarize_generic(tool_input: dict) -> dict:
    """Summarize unknown tool input (truncated JSON)."""
    raw = json.dumps(tool_input, ensure_ascii=False)
    return {
        "raw": raw[:MAX_SUMMARY_LENGTH] + ("..." if len(raw) > MAX_SUMMARY_LENGTH else ""),
    }


_SUMMARIZERS = {
    "Bash": _summarize_bash,
    "Edit": _summarize_edit,
    "Write": _summarize_write,
    "Read": _summarize_read,
    "Grep": _summarize_grep,
    "Glob": _summarize_glob,
    "WebFetch": _summarize_web,
    "WebSearch": _summarize_web,
    "Task": _summarize_task,
}


def summarize_tool_input(tool_name: str, tool_input: dict) -> dict:
    """Create a compact summary of tool input."""
    summarizer = _SUMMARIZERS.get(tool_name, _summarize_generic)
    return summarizer(tool_input)


def summarize_tool_response(tool_response: dict) -> dict:
    """Create a compact summary of tool response."""
    summary: dict = {}

    # Exit code for Bash
    if "exit_code" in tool_response:
        summary["exit_code"] = tool_response["exit_code"]
        summary["success"] = tool_response["exit_code"] == 0

    # Content/stdout size
    content = tool_response.get("content") or tool_response.get("stdout") or ""
    if isinstance(content, str):
        summary["output_size"] = len(content)
    elif isinstance(content, list):
        summary["output_items"] = len(content)

    return summary


# --- Hook Entry Point ---


def run_hook() -> None:
    """PostToolUse hook: record tool completion to evidence ledger."""
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    tool_response = data.get("tool_response", {})

    # Only record when veil is active
    session = tobari_session.load_session()
    if not session:
        sys.exit(0)

    # Build evidence entry
    entry = {
        "event": "tool_complete",
        "tool_name": tool_name,
        "input_summary": summarize_tool_input(tool_name, tool_input),
        "response_summary": summarize_tool_response(tool_response),
        "task": session.get("task", ""),
        "profile": session.get("profile", ""),
        "current_gate": _get_current_gate(session),
    }

    tobari_session.write_evidence(entry)

    # No hookSpecificOutput needed — silent recording
    sys.exit(0)


def _get_current_gate(session: dict) -> str:
    """Determine the current gate from session gates_passed."""
    gates_passed = session.get("gates_passed", [])
    all_gates = ["STG0", "STG1", "STG2", "STG3", "STG4", "STG5", "STG6"]
    for gate in all_gates:
        if gate not in gates_passed:
            return gate
    return "complete"


# --- CLI Entry Point ---


def cli_summary() -> None:
    """Print evidence ledger summary."""
    summary = tobari_session.summarize_evidence()
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def cli_quality_gates() -> None:
    """Print quality_gate_counts from evidence ledger."""
    summary = tobari_session.summarize_evidence()
    counts = summary.get("quality_gate_counts", {})
    print(json.dumps(counts, ensure_ascii=False, indent=2))


def main() -> None:
    """CLI or hook entry point."""
    if len(sys.argv) > 1:
        command = sys.argv[1]
        if command == "summary":
            cli_summary()
        elif command == "quality-gates":
            cli_quality_gates()
        else:
            print(f"Unknown command: {command}", file=sys.stderr)
            print("Usage: python tobari-evidence.py [summary|quality-gates]",
                  file=sys.stderr)
            sys.exit(1)
    else:
        # Called as PostToolUse hook (stdin JSON)
        run_hook()


if __name__ == "__main__":
    main()
