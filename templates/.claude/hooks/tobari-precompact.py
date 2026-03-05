#!/usr/bin/env python3
"""
PreCompact hook: Inject project and tobari session context before compaction.

Always injects key project file references.
When the veil is active, additionally injects session state
so the post-compaction context knows about the active task.
"""

import json
import sys
from pathlib import Path

# Import shared session reader
sys.path.insert(0, str(Path(__file__).parent))
import tobari_session

def main():
    output = tobari_session.build_context_output(
        intro_text=(
            "Context compaction triggered. Key context: "
            "Check CLAUDE.md for project rules, "
            ".claude/docs/DESIGN.md for design decisions, "
            ".claude/rules/ for coding standards, "
            "tasks/backlog.yaml for task state."
        ),
        session_active_text=(
            "TOBARI SESSION ACTIVE: task='{task}', "
            "profile='{profile}', gates_passed={gates}. "
            "Read .claude/tobari-session.json to restore full session context."
        ),
    )
    print(json.dumps(output))
    sys.exit(0)

if __name__ == "__main__":
    main()
