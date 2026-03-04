#!/usr/bin/env python3
"""
PreCompact hook: Inject project and tobari session context before compaction.

Always injects key project file references.
When the veil (帳) is active, additionally injects session state
so the post-compaction context knows about the active task.
"""

import json
import sys
from pathlib import Path

# Import shared session reader
sys.path.insert(0, str(Path(__file__).parent))
import tobari_session

def main():
    context_parts = [
        "Context compaction triggered. Key context: "
        "Check CLAUDE.md for project rules, "
        ".claude/docs/DESIGN.md for design decisions, "
        ".claude/rules/ for coding standards, "
        "tasks/backlog.yaml for task state."
    ]

    session = tobari_session.load_session()
    if session:
        task = session.get("task", "unknown")
        profile = session.get("profile", "standard")
        gates = session.get("gates_passed", [])
        context_parts.append(
            f"TOBARI SESSION ACTIVE: task='{task}', "
            f"profile='{profile}', gates_passed={gates}. "
            "Read .claude/tobari-session.json to restore full session context."
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
