#!/usr/bin/env python3
"""
SessionStart hook: Context restoration -- the memory of tobari.

Injects project and session context at session startup/resume.
Symmetric counterpart to tobari-precompact.py (which saves context before compaction).

Design:
- Fail-open: hook errors never block session start
- Always injects project key paths
- Additionally injects session state when veil is active
- Notifies user when veil was previously raised (no longer active)
"""

import json
import sys
from pathlib import Path

# Import shared session reader
sys.path.insert(0, str(Path(__file__).parent))
import tobari_session

def main():
    # Check if veil was previously raised (user needs to know they're unprotected)
    raised_info = tobari_session.get_raised_info()

    output = tobari_session.build_context_output(
        intro_text=(
            "Session started. Key project references: "
            "CLAUDE.md (project rules), "
            ".claude/docs/DESIGN.md (design decisions), "
            ".claude/rules/ (coding standards), "
            "tasks/backlog.yaml (task state SoT)."
        ),
        session_active_text=(
            "TOBARI VEIL ACTIVE: task='{task}', "
            "profile='{profile}', gates_passed={gates}. "
            "The veil is down -- all operations are under Hook governance. "
            "Read .claude/tobari-session.json for full session contract."
        ),
        session_inactive_text=(
            "No active tobari session. "
            "Use /tobari <feature> to lower the veil and start a governed session."
        ),
    )

    # Append veil-raised notification to context if applicable
    if raised_info:
        veil_msg = (
            f"NOTICE: The veil was raised (task='{raised_info['task']}', "
            f"reason='{raised_info['raised_reason']}', "
            f"at={raised_info['raised_at']}). "
            "You are NOT under Hook governance. "
            "Use /tobari <feature> to lower the veil again."
        )
        ctx = output["hookSpecificOutput"]["additionalContext"]
        output["hookSpecificOutput"]["additionalContext"] = ctx + " " + veil_msg

    print(json.dumps(output))
    sys.exit(0)

if __name__ == "__main__":
    main()
