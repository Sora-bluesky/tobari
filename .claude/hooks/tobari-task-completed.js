"use strict";
/**
 * TaskCompleted hook (T2): Record teammate task completion to evidence trail.
 *
 * Fires when a teammate in an Agent Team completes a task.
 *
 * When the veil is active:
 * - Records task completion event to the evidence ledger
 * - Returns enhanced feedback with session context and audit acknowledgment
 *
 * When the veil is NOT active:
 * - Returns default feedback (verify, update task list, report if done)
 * - Does NOT write evidence
 *
 * Design:
 * - Fail-open: errors never break the teammate — returns default feedback
 * - Evidence includes task_id, task_subject, teammate_name, team_name
 */

const {
  loadSession,
  writeEvidence,
  runHook,
} = require("./tobari-session.js");

/**
 * Default feedback returned when the veil is not active or on error.
 */
const DEFAULT_FEEDBACK =
  "Task completed. " +
  "(1) Verify your output: run lint, tests, and type checks if applicable. " +
  "(2) Update the shared task list to mark your task as done. " +
  "(3) If all team tasks are complete, report to the team lead with a summary of changes.";

/**
 * Build enhanced feedback when the veil is active.
 *
 * @param {string} taskId - The completed task identifier.
 * @param {string} taskSubject - Description of the completed task.
 * @param {string} sessionTask - Current tobari session task name.
 * @returns {string}
 */
function buildActiveFeedback(taskId, taskSubject, sessionTask) {
  const parts = [];

  parts.push(
    `Task "${taskId}" completed: ${taskSubject}. ` +
      `[Session: ${sessionTask}] Evidence recorded to audit trail.`
  );

  parts.push(
    "(1) Verify your output: run lint, tests, and type checks if applicable."
  );
  parts.push(
    "(2) Update the shared task list to mark your task as done."
  );
  parts.push(
    "(3) If all team tasks are complete, report to the team lead with a summary of changes."
  );

  return parts.join(" ");
}

/**
 * TaskCompleted hook handler.
 *
 * @param {object} data - Hook input from Claude Code.
 * @param {string} data.session_id - Session ID.
 * @param {string} data.transcript_path - Transcript file path.
 * @param {string} data.cwd - Current working directory.
 * @param {string} data.permission_mode - Permission mode.
 * @param {string} data.hook_event_name - "TaskCompleted".
 * @param {string} data.task_id - Task identifier.
 * @param {string} data.task_subject - Task description/subject.
 * @param {string} data.teammate_name - Name of the completing teammate.
 * @param {string} data.team_name - Team name.
 * @returns {object} hookSpecificOutput with feedback.
 */
function handler(data) {
  const taskId = data.task_id || "unknown";
  const taskSubject = data.task_subject || "unknown";
  const teammateName = data.teammate_name || "unknown";
  const teamName = data.team_name || "unknown";

  try {
    const sess = loadSession();

    if (!sess) {
      // Veil not active — return default feedback without evidence
      return {
        hookSpecificOutput: {
          feedback: DEFAULT_FEEDBACK,
        },
      };
    }

    // Veil active — record evidence and return enhanced feedback
    const sessionTask = sess.task || "unknown";
    const sessionProfile = sess.profile || "unknown";

    writeEvidence({
      event: "task_completed",
      task_id: taskId,
      task_subject: taskSubject,
      teammate_name: teammateName,
      team_name: teamName,
      task: sessionTask,
      profile: sessionProfile,
    });

    const feedback = buildActiveFeedback(taskId, taskSubject, sessionTask);

    return {
      hookSpecificOutput: {
        feedback,
      },
    };
  } catch (_) {
    // Fail-open: never break the teammate
    return {
      hookSpecificOutput: {
        feedback: DEFAULT_FEEDBACK,
      },
    };
  }
}

// CLI entry point
if (require.main === module) {
  runHook(handler);
}

module.exports = {
  DEFAULT_FEEDBACK,
  buildActiveFeedback,
  handler,
};
