"use strict";
/**
 * PostToolUseFailure hook: Failure evidence — the scarred eye of tobari.
 *
 * Records tool failures to .claude/logs/evidence-ledger.jsonl
 * while the veil is active.
 *
 * Symmetric counterpart to tobari-evidence.js (which records successes).
 * Together they close the gap in the "残す" (record everything) pillar.
 *
 * Design:
 * - Fail-open: hook errors never block tool execution
 * - Veil-gated: only records when session is active
 * - Minimal: capture tool name, error, and context — no heavy processing
 */

const session = require("./tobari-session.js");

// --- Constants ---

const MAX_ERROR_LENGTH = 1000;
const MAX_COMMAND_LENGTH = 200;
const MAX_RAW_LENGTH = 200;

// --- Summarizers ---

/**
 * Truncate error message to a reasonable length.
 * @param {string} toolError
 * @returns {string}
 */
function _summarizeError(toolError) {
  if (toolError.length > MAX_ERROR_LENGTH) {
    return toolError.slice(0, MAX_ERROR_LENGTH) + "...";
  }
  return toolError;
}

/**
 * Create a compact summary of tool input for failure context.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {object}
 */
function _summarizeToolInput(toolName, toolInput) {
  if (toolName === "Bash") {
    const cmd = toolInput.command || "";
    return {
      command:
        cmd.length > MAX_COMMAND_LENGTH
          ? cmd.slice(0, MAX_COMMAND_LENGTH) + "..."
          : cmd,
    };
  }
  if (
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "NotebookEdit"
  ) {
    return {
      file_path: toolInput.file_path || toolInput.notebook_path || "",
    };
  }
  if (toolName === "Read") {
    return { file_path: toolInput.file_path || "" };
  }
  if (toolName === "Grep" || toolName === "Glob") {
    return { pattern: toolInput.pattern || "" };
  }
  // Unknown tool — generic summary
  const raw = JSON.stringify(toolInput);
  return {
    raw:
      raw.length > MAX_RAW_LENGTH
        ? raw.slice(0, MAX_RAW_LENGTH) + "..."
        : raw,
  };
}

// --- Hook handler ---

/**
 * @param {object} data - PostToolUseFailure hook input
 */
function handler(data) {
  const sess = session.loadSession();
  if (!sess) return;

  const toolName = data.tool_name || "unknown";
  const toolInput = data.tool_input || {};
  const toolError = data.tool_error || "";

  const entry = {
    event: "tool_failed",
    tool_name: toolName,
    input_summary: _summarizeToolInput(toolName, toolInput),
    error: _summarizeError(String(toolError)),
    task: sess.task || "",
    profile: sess.profile || "",
  };

  session.writeEvidence(entry);
  // No hookSpecificOutput — silent recording
}

// --- Exports (for testing) ---

module.exports = {
  _summarizeError,
  _summarizeToolInput,
  handler,
  MAX_ERROR_LENGTH,
  MAX_COMMAND_LENGTH,
  MAX_RAW_LENGTH,
};

// --- Entry point ---

if (require.main === module) {
  session.runHook(handler);
}
