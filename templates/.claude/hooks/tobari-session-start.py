#!/usr/bin/env python3
"""
SessionStart hook: Context restoration — the memory of tobari (帳の記憶, 🧠).

Injects project and session context at session startup/resume.
Symmetric counterpart to tobari-precompact.py (which saves context before compaction).

Implements the "🧠 記憶" (memory) organ.

Design:
- Fail-open: hook errors never block session start
- Always injects project key paths
- Additionally injects session state when veil is active
"""

import json
import sys
from pathlib import Path

# Import shared session reader
sys.path.insert(0, str(Path(__file__).parent))
import tobari_session

def main():
    context_parts = [
        "Session started. Key project references: "
        "CLAUDE.md (project rules), "
        ".claude/docs/DESIGN.md (design decisions), "
        ".claude/rules/ (coding standards), "
        "tasks/backlog.yaml (task state SoT)."
    ]

    session = tobari_session.load_session()
    if session:
        task = session.get("task", "unknown")
        profile = session.get("profile", "standard")
        gates = session.get("gates_passed", [])
        context_parts.append(
            f"TOBARI VEIL ACTIVE: task='{task}', "
            f"profile='{profile}', gates_passed={gates}. "
            "The veil is down — all operations are under Hook governance. "
            "Read .claude/tobari-session.json for full session contract."
        )
    else:
        context_parts.append(
            "No active tobari session. "
            "Use /tobari <feature> to lower the veil and start a governed session."
        )

    output = {
        "hookSpecificOutput": {
            "additionalContext": " ".join(context_parts)
        }
    }
    print(json.dumps(output))
    sys.exit(0)

if __name__ == "__main__":
    main()
