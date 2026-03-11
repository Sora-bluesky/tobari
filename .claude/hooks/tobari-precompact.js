"use strict";
/**
 * PreCompact hook: Inject project and tobari session context before compaction.
 *
 * Always injects key project file references.
 * When the veil is active, additionally injects session state
 * so the post-compaction context knows about the active task.
 */

const { buildContextOutput, runHook } = require("./tobari-session.js");

/**
 * PreCompact hook handler.
 * @param {object} _data - Hook input (unused for PreCompact)
 * @returns {object|null} hookSpecificOutput with context, or null
 */
function handler(_data) {
  return buildContextOutput(
    "Context compaction triggered. Key context: " +
      "Check CLAUDE.md for project rules, " +
      ".claude/docs/DESIGN.md for design decisions, " +
      ".claude/rules/ for coding standards, " +
      "tasks/backlog.yaml for task state.",
    "TOBARI SESSION ACTIVE: task='{task}', " +
      "profile='{profile}', gates_passed={gates}. " +
      "Read .claude/tobari-session.json to restore full session context."
  );
}

// CLI entry point
if (require.main === module) {
  runHook(handler);
}

module.exports = { handler };
