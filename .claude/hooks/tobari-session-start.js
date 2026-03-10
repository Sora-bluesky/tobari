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

const fs = require("fs");
const path = require("path");
const {
  buildContextOutput,
  getRaisedInfo,
  loadSession,
  writeEvidence,
  runHook,
} = require("./tobari-session.js");

/**
 * A3: Check for world-writable directories in key project paths.
 * Only meaningful on Unix (Windows ACLs work differently).
 * @returns {string[]} List of world-writable paths found
 */
function checkWorldWritable() {
  if (process.platform === "win32") return [];

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dirsToCheck = [
    projectDir,
    path.join(projectDir, ".claude"),
    path.join(projectDir, ".claude", "hooks"),
    path.join(projectDir, ".claude", "rules"),
    path.join(projectDir, ".claude", "logs"),
  ];

  const worldWritable = [];
  for (const dir of dirsToCheck) {
    try {
      const stat = fs.statSync(dir);
      // Check "other write" bit (octal 0o002)
      if (stat.mode & 0o002) {
        worldWritable.push(dir);
      }
    } catch (_) {
      // Directory doesn't exist — skip
    }
  }
  return worldWritable;
}

/**
 * SessionStart hook handler.
 * @param {object} _data - Hook input (unused for SessionStart)
 * @returns {object|null} hookSpecificOutput with context, or null
 */
function handler(_data) {
  // Record session_start event to evidence ledger when veil is active
  const sess = loadSession();
  if (sess && sess.active) {
    writeEvidence({
      event: "session_start",
      task: sess.task || "",
      profile: sess.profile || "",
      gates_passed: sess.gates_passed || [],
    });
  }

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

  // A3: World-writable directory audit
  const wwDirs = checkWorldWritable();
  if (wwDirs.length > 0) {
    const wwWarning =
      "SECURITY WARNING: World-writable directories detected: " +
      wwDirs.join(", ") +
      ". Run 'chmod o-w <dir>' to fix.";
    output.hookSpecificOutput.additionalContext += " " + wwWarning;
  }

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

module.exports = { checkWorldWritable, handler };
