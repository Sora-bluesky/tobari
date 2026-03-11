"use strict";
/**
 * TeammateIdle hook (T1): Provide guidance when a teammate goes idle.
 *
 * When a teammate in an Agent Team becomes idle, this hook provides
 * feedback on what to do next: check pending tasks, write a work log,
 * and report to the team lead.
 *
 * Design:
 * - Fail-open: errors never block the teammate (returns default feedback)
 * - When veil is active: records evidence and provides enhanced feedback
 * - When veil is inactive: provides default feedback without evidence
 */

const fs = require("fs");
const path = require("path");
const {
  loadSession,
  writeEvidence,
  runHook,
} = require("./tobari-session.js");

const WORK_LOG_BASE_DIR = ".claude/logs/agent-teams";

/**
 * Build the default feedback message for an idle teammate.
 * @param {string} teamName - The team name (used in path hints)
 * @param {string} teammateName - The teammate name (used in path hints)
 * @returns {string}
 */
function buildDefaultFeedback(teamName, teammateName) {
  const tn = teamName || "{team-name}";
  const mn = teammateName || "{your-teammate-name}";
  return (
    "Before going idle: " +
    "(1) Check the shared task list for pending tasks. " +
    "If all tasks are complete, verify results. " +
    "(2) IMPORTANT: Write your work log to " +
    `.claude/logs/agent-teams/${tn}/${mn}.md` +
    " if you have not done so yet. " +
    "The work log must include: Summary, Tasks Completed, Files Modified, " +
    "Key Decisions, Communication with Teammates, and Issues Encountered. " +
    "(3) Report to the team lead."
  );
}

/**
 * Build enhanced feedback when the veil is active.
 * @param {object} sess - The active tobari session object
 * @param {string} teamName - The team name
 * @param {string} teammateName - The teammate name
 * @param {boolean} workLogDirExists - Whether the work log directory exists
 * @returns {string}
 */
function buildActiveFeedback(sess, teamName, teammateName, workLogDirExists) {
  const task = sess.task || "unknown";
  const tn = teamName || "{team-name}";
  const mn = teammateName || "{your-teammate-name}";

  const parts = [];
  parts.push(`[tobari] Current task: ${task}. Evidence has been recorded.`);
  parts.push(
    "Before going idle: " +
    "(1) Check the shared task list for pending tasks. " +
    "If all tasks are complete, verify results."
  );

  if (!workLogDirExists) {
    parts.push(
      `(2) IMPORTANT: The work log directory .claude/logs/agent-teams/${tn}/ ` +
      "does not exist yet. Create it and write your work log to " +
      `.claude/logs/agent-teams/${tn}/${mn}.md. ` +
      "The work log must include: Summary, Tasks Completed, Files Modified, " +
      "Key Decisions, Communication with Teammates, and Issues Encountered."
    );
  } else {
    parts.push(
      "(2) IMPORTANT: Write your work log to " +
      `.claude/logs/agent-teams/${tn}/${mn}.md` +
      " if you have not done so yet. " +
      "The work log must include: Summary, Tasks Completed, Files Modified, " +
      "Key Decisions, Communication with Teammates, and Issues Encountered."
    );
  }

  parts.push("(3) Report to the team lead.");

  return parts.join(" ");
}

/**
 * Check if the work log directory exists for a given team.
 * @param {string} teamName - The team name
 * @returns {boolean}
 */
function workLogDirExists(teamName) {
  if (!teamName) return false;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const logDir = path.join(projectDir, WORK_LOG_BASE_DIR, teamName);
  return fs.existsSync(logDir);
}

/**
 * TeammateIdle hook handler.
 * @param {object} data - Hook input from Claude Code
 * @param {string} data.session_id - Session ID
 * @param {string} data.hook_event_name - "TeammateIdle"
 * @param {string} data.teammate_name - Name of the idle teammate
 * @param {string} data.team_name - Team name
 * @returns {object} Hook output with feedback
 */
function handler(data) {
  const teammateName = data.teammate_name || "";
  const teamName = data.team_name || "";

  try {
    const sess = loadSession();

    if (!sess) {
      // Veil not active — return default feedback without evidence
      return {
        hookSpecificOutput: {
          feedback: buildDefaultFeedback(teamName, teammateName),
        },
      };
    }

    // Veil active — record evidence
    writeEvidence({
      event: "teammate_idle",
      teammate_name: teammateName,
      team_name: teamName,
      task: sess.task || "unknown",
    });

    // Check if work log directory exists
    const logDirExists = workLogDirExists(teamName);

    return {
      hookSpecificOutput: {
        feedback: buildActiveFeedback(sess, teamName, teammateName, logDirExists),
      },
    };
  } catch (_) {
    // Fail-open: return default feedback on any error
    return {
      hookSpecificOutput: {
        feedback: buildDefaultFeedback(teamName, teammateName),
      },
    };
  }
}

// CLI entry point
if (require.main === module) {
  runHook(handler);
}

module.exports = {
  WORK_LOG_BASE_DIR,
  buildDefaultFeedback,
  buildActiveFeedback,
  workLogDirExists,
  handler,
};
