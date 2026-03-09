#!/usr/bin/env node
"use strict";
/**
 * PermissionRequest hook: tobari-permission — the voice of the veil.
 *
 * Fires when Claude Code is about to show a permission dialog to the user.
 *
 * When the veil is active:
 * - Safe patterns within scope -> auto-allow + updatedPermissions (learning)
 * - Unknown patterns -> systemMessage with localized context (dialog shown to user)
 * - Never denies (tobari-gate.js / PreToolUse already handles denials)
 *
 * When the veil is inactive:
 * - exit 0 (no interference, advisory mode only)
 *
 * Implements docs/24 S7 (notification channel) and DM-0014 (notification architecture).
 * Learning via updatedPermissions: approved patterns are added to Claude Code's allow list.
 *
 * Node.js port of tobari-permission.py (v1.1.0 migration).
 */

const {
  loadSession,
  getTask,
  getProfile,
  isPathInScope,
  writeEvidence,
  runHook,
} = require("./tobari-session.js");
const { t } = require("./tobari-i18n.js");

// ---------------------------------------------------------------------------
// Safe Bash Patterns (auto-allow + learn)
// ---------------------------------------------------------------------------

/**
 * Array of [RegExp, label] pairs. Each regexp has the `i` flag for
 * case-insensitive matching (equivalent to Python re.IGNORECASE).
 * All patterns are anchored with `^` so `.test()` behaves like `re.match()`.
 *
 * @type {Array<[RegExp, string]>}
 */
const SAFE_BASH_PATTERNS = [
  // git commands — safe read-only operations
  [/^git\s+(status|log|diff|show|tag|remote|config|rev-parse|ls-files|ls-tree|cat-file|describe|shortlog|blame|bisect|grep|count-objects|fsck|for-each-ref)\b/i,
    t("permission.safe.git_read")],
  // git commands — safe write operations
  [/^git\s+(add|commit|fetch|pull|merge|rebase(?!\s+--exec))\b/i,
    t("permission.safe.git_write")],
  // git branch — safe (no -D flag)
  [/^git\s+branch(?!\s+.*-[dD]\b)\b/i,
    t("permission.safe.git_branch")],
  // git push — safe (no --force, --delete, or :ref deletion)
  [/^git\s+push(?!\s+.*(-f\b|--force(?!-with-lease)|--delete|--no-verify))\b/i,
    t("permission.safe.git_push")],
  // git checkout — safe (not `checkout -- .`)
  [/^git\s+checkout(?!\s+--\s+\.)\b/i,
    t("permission.safe.git_checkout")],
  // git restore — safe (not `restore --worktree .`)
  [/^git\s+restore(?!\s+.*--worktree\s+\.)\b/i,
    t("permission.safe.git_restore")],
  // git stash — safe (not drop/clear)
  [/^git\s+stash(?!\s+(drop|clear))\b/i,
    t("permission.safe.git_stash")],
  // git stash list — explicitly safe (read-only)
  [/^git\s+stash\s+list\b/i,
    "git stash list"],
  // git reflog show — safe read-only
  [/^git\s+reflog(\s+show)?\b(?!\s+(delete|expire))/i,
    t("permission.safe.git_reflog")],
  // git switch/clone/init/worktree
  [/^git\s+(switch|clone|init|worktree)\b/i,
    t("permission.safe.git_misc")],
  // pwsh/powershell scripts
  [/^pwsh\b/i,
    t("permission.safe.powershell")],
  [/^powershell\b/i,
    t("permission.safe.powershell")],
  // Test runners
  [/^pytest\b/i,
    t("permission.safe.test_runner")],
  [/^npm\s+test\b/i,
    t("permission.safe.test_runner")],
  [/^npm\s+run\s+test\b/i,
    t("permission.safe.test_runner")],
  [/^python\s+-m\s+pytest\b/i,
    t("permission.safe.test_runner")],
  // Read-only shell commands
  [/^(cat|ls|echo|pwd|head|tail|wc|sort|uniq|diff|find|grep|which|type|env)\b/i,
    t("permission.safe.read_cmd")],
  // Safe file ops
  [/^(mkdir|touch|cp|mv)\b/i,
    t("permission.safe.file_ops")],
  // Python / Node execution
  [/^(python|python3|node)\s+/i,
    t("permission.safe.script_exec")],
  // gh CLI (read-only operations)
  [/^gh\s+(pr|issue|repo|release)\s+(list|view|status|check)\b/i,
    t("permission.safe.gh_read")],
  // Text processing
  [/^(jq|awk|sed|xargs|tr|cut)\b/i,
    t("permission.safe.text_processing")],
  // Package managers (view/list only)
  [/^npm\s+(list|ls|info|show|outdated)\b/i,
    t("permission.safe.pkg_info")],
  // Environment / shell utilities
  [/^(export|source|cd)\b/i,
    t("permission.safe.shell_ops")],
  // Bash variable / conditional checks
  [/^(test|true|false|\[)\b/i,
    t("permission.safe.condition_check")],
];

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Check if a Bash command matches known-safe patterns.
 *
 * @param {string} command - The bash command string.
 * @returns {[boolean, string]} [isSafe, label] tuple.
 */
function isSafeBash(command) {
  if (!command) {
    return [false, ""];
  }

  const cmd = command.trim();
  for (const [pattern, label] of SAFE_BASH_PATTERNS) {
    if (pattern.test(cmd)) {
      return [true, label];
    }
  }
  return [false, ""];
}

/**
 * Generate a brief localized description of the tool operation.
 *
 * @param {string} toolName - Claude Code tool name (Bash, Edit, Write, etc.).
 * @param {Object} toolInput - Tool input parameters.
 * @returns {string} Localized description string.
 */
function describeOperation(toolName, toolInput) {
  if (toolName === "Bash") {
    const cmd = toolInput.command || "";
    const desc = toolInput.description || "";
    if (desc) {
      return "`" + cmd.slice(0, 60) + "` \u2014 " + desc;
    }
    return "`" + cmd.slice(0, 80) + "`";
  }
  if (toolName === "Edit" || toolName === "Write") {
    return t("permission.describe.edit_create", { filePath: toolInput.file_path || t("permission.describe.unknown_file") });
  }
  if (toolName === "Read") {
    return t("permission.describe.read", { filePath: toolInput.file_path || t("permission.describe.unknown_file") });
  }
  if (toolName === "Glob" || toolName === "Grep") {
    return t("permission.describe.search");
  }
  if (toolName === "WebFetch") {
    return t("permission.describe.fetch", { url: (toolInput.url || "URL").slice(0, 60) });
  }
  if (toolName === "WebSearch") {
    return t("permission.describe.web_search", { query: (toolInput.query || "").slice(0, 60) });
  }
  if (toolName === "Task") {
    return t("permission.describe.subagent", { description: (toolInput.description || "").slice(0, 60) });
  }
  return t("permission.describe.generic", { toolName });
}

/**
 * Classify the operation as 'safe' or 'unknown'.
 *
 * @param {string} toolName - Claude Code tool name.
 * @param {Object} toolInput - Tool input parameters.
 * @returns {[string, string]} [classification, reason] tuple.
 *   classification is 'safe' or 'unknown'.
 */
function classifyOperation(toolName, toolInput) {
  // Read-only tools: always safe
  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
    return ["safe", t("permission.classify.read_only", { toolName })];
  }

  // Task (subagent spawn): safe — already governed by its own session
  if (toolName === "Task") {
    return ["safe", t("permission.classify.subagent")];
  }

  // Bash: check safe patterns
  if (toolName === "Bash") {
    const command = toolInput.command || "";
    const [safe, label] = isSafeBash(command);
    if (safe) {
      return ["safe", label];
    }
    return ["unknown", t("permission.classify.unsafe_bash")];
  }

  // Edit/Write: check contract scope
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const filePath = toolInput.file_path || toolInput.notebook_path || "";
    if (filePath) {
      const inScope = isPathInScope(filePath);
      if (inScope === true) {
        return ["safe", t("permission.classify.in_scope")];
      }
      if (inScope === null) {
        // No scope restriction = safe
        return ["safe", t("permission.classify.no_scope")];
      }
    }
    return ["unknown", t("permission.classify.unknown_scope")];
  }

  // Other tools: unknown (let user decide)
  return ["unknown", t("permission.classify.generic", { toolName })];
}

/**
 * Build localized systemMessage for unknown operations.
 *
 * @param {string} toolName - Claude Code tool name.
 * @param {Object} toolInput - Tool input parameters.
 * @param {string} reason - Classification reason.
 * @param {string} task - Current task name.
 * @param {string} profile - Operating profile.
 * @returns {string} Localized message for the permission dialog.
 */
function makeSystemMessage(toolName, toolInput, reason, task, profile) {
  const opDesc = describeOperation(toolName, toolInput);
  return (
    t("permission.dialog.header", { task, operation: opDesc }) + "\n" +
    t("permission.dialog.context", { profile, reason }) + "\n" +
    t("permission.dialog.learning")
  );
}

/**
 * PermissionRequest hook handler.
 *
 * @param {Object} input - Hook input from Claude Code.
 * @returns {Object|null} Hook output, or null to exit silently.
 */
function handler(input) {
  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  const permissionSuggestions = input.permission_suggestions || [];

  // Load session — veil inactive: no interference
  const session = loadSession();
  if (!session) {
    return null;
  }

  const task = getTask() || "unknown";
  const profile = getProfile() || "standard";

  // Classify the operation
  const [classification, reason] = classifyOperation(toolName, toolInput);

  if (classification === "safe") {
    // Auto-allow + learn via updatedPermissions
    writeEvidence({
      event: "permission_granted",
      tool_name: toolName,
      reason: reason,
      task: task,
      learned: permissionSuggestions.length > 0,
    });

    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedPermissions: permissionSuggestions,
        },
      },
    };
  }

  // Unknown: show dialog with localized context via systemMessage
  const msg = makeSystemMessage(toolName, toolInput, reason, task, profile);

  writeEvidence({
    event: "permission_asked",
    tool_name: toolName,
    reason: reason,
    task: task,
  });

  return {
    systemMessage: msg,
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runHook(handler);
}

// ---------------------------------------------------------------------------
// Exports (for testing)
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  SAFE_BASH_PATTERNS,

  // Functions
  isSafeBash,
  describeOperation,
  classifyOperation,
  makeSystemMessage,
  handler,
};
