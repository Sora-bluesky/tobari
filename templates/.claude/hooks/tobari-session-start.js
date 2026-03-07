"use strict";
/**
 * SessionStart hook: Context restoration — the memory of tobari.
 *
 * Injects project and session context at session startup/resume.
 * Symmetric counterpart to tobari-precompact.js (which saves context before compaction).
 *
 * Design:
 * - Fail-open: hook errors never block session start
 * - Always injects project key paths
 * - Additionally injects session state when veil is active
 * - Notifies user when veil was previously raised (no longer active)
 */

const { buildContextOutput, getRaisedInfo, runHook } = require("./tobari-session.js");

/**
 * SessionStart hook handler.
 * @param {object} _data - Hook input (unused for SessionStart)
 * @returns {object|null} hookSpecificOutput with context, or null
 */
function handler(_data) {
  const raisedInfo = getRaisedInfo();

  const output = buildContextOutput(
    "Session started. Key project references: " +
      "CLAUDE.md (project rules), " +
      ".claude/docs/DESIGN.md (design decisions), " +
      ".claude/rules/ (coding standards), " +
      "tasks/backlog.yaml (task state SoT).",
    "TOBARI VEIL ACTIVE: task='{task}', " +
      "profile='{profile}', gates_passed={gates}. " +
      "The veil is down -- all operations are under Hook governance. " +
      "Read .claude/tobari-session.json for full session contract.",
    "No active tobari session. " +
      "Use /tobari <feature> to lower the veil and start a governed session."
  );

  // Append veil-raised notification if applicable
  if (raisedInfo) {
    const veilMsg =
      `NOTICE: The veil was raised (task='${raisedInfo.task}', ` +
      `reason='${raisedInfo.raised_reason}', ` +
      `at=${raisedInfo.raised_at}). ` +
      "You are NOT under Hook governance. " +
      "Use /tobari <feature> to lower the veil again.";
    output.hookSpecificOutput.additionalContext += " " + veilMsg;
  }

  return output;
}

// CLI entry point
if (require.main === module) {
  runHook(handler);
}

module.exports = { handler };
