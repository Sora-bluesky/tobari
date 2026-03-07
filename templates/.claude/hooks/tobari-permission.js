#!/usr/bin/env node
"use strict";
/**
 * PermissionRequest hook: tobari-permission — the voice of the veil.
 *
 * Fires when Claude Code is about to show a permission dialog to the user.
 *
 * When the veil is active:
 * - Safe patterns within scope -> auto-allow + updatedPermissions (learning)
 * - Unknown patterns -> systemMessage with Japanese context (dialog shown to user)
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
    "git \u8AAD\u307F\u53D6\u308A\u30B3\u30DE\u30F3\u30C9"],
  // git commands — safe write operations
  [/^git\s+(add|commit|fetch|pull|merge|rebase(?!\s+--exec))\b/i,
    "git \u5909\u66F4\u30B3\u30DE\u30F3\u30C9\uFF08\u5B89\u5168\uFF09"],
  // git branch — safe (no -D flag)
  [/^git\s+branch(?!\s+.*-[dD]\b)\b/i,
    "git branch\uFF08\u5B89\u5168\uFF09"],
  // git push — safe (no --force, --delete, or :ref deletion)
  [/^git\s+push(?!\s+.*(-f\b|--force(?!-with-lease)|--delete|--no-verify))\b/i,
    "git push\uFF08\u5B89\u5168\uFF09"],
  // git checkout — safe (not `checkout -- .`)
  [/^git\s+checkout(?!\s+--\s+\.)\b/i,
    "git checkout\uFF08\u5B89\u5168\uFF09"],
  // git restore — safe (not `restore --worktree .`)
  [/^git\s+restore(?!\s+.*--worktree\s+\.)\b/i,
    "git restore\uFF08\u5B89\u5168\uFF09"],
  // git stash — safe (not drop/clear)
  [/^git\s+stash(?!\s+(drop|clear))\b/i,
    "git stash\uFF08\u5B89\u5168\uFF09"],
  // git stash list — explicitly safe (read-only)
  [/^git\s+stash\s+list\b/i,
    "git stash list"],
  // git reflog show — safe read-only
  [/^git\s+reflog(\s+show)?\b(?!\s+(delete|expire))/i,
    "git reflog\uFF08\u8AAD\u307F\u53D6\u308A\uFF09"],
  // git switch/clone/init/worktree
  [/^git\s+(switch|clone|init|worktree)\b/i,
    "git \u30B3\u30DE\u30F3\u30C9\uFF08\u5B89\u5168\uFF09"],
  // pwsh/powershell scripts
  [/^pwsh\b/i,
    "PowerShell \u30B9\u30AF\u30EA\u30D7\u30C8"],
  [/^powershell\b/i,
    "PowerShell \u30B9\u30AF\u30EA\u30D7\u30C8"],
  // Test runners
  [/^pytest\b/i,
    "\u30C6\u30B9\u30C8\u5B9F\u884C"],
  [/^npm\s+test\b/i,
    "\u30C6\u30B9\u30C8\u5B9F\u884C"],
  [/^npm\s+run\s+test\b/i,
    "\u30C6\u30B9\u30C8\u5B9F\u884C"],
  [/^python\s+-m\s+pytest\b/i,
    "\u30C6\u30B9\u30C8\u5B9F\u884C"],
  // Read-only shell commands
  [/^(cat|ls|echo|pwd|head|tail|wc|sort|uniq|diff|find|grep|which|type|env)\b/i,
    "\u8AAD\u307F\u53D6\u308A\u7CFB\u30B3\u30DE\u30F3\u30C9"],
  // Safe file ops
  [/^(mkdir|touch|cp|mv)\b/i,
    "\u30D5\u30A1\u30A4\u30EB\u64CD\u4F5C"],
  // Python / Node execution
  [/^(python|python3|node)\s+/i,
    "\u30B9\u30AF\u30EA\u30D7\u30C8\u5B9F\u884C"],
  // gh CLI (read-only operations)
  [/^gh\s+(pr|issue|repo|release)\s+(list|view|status|check)\b/i,
    "GitHub CLI \u8AAD\u307F\u53D6\u308A"],
  // Text processing
  [/^(jq|awk|sed|xargs|tr|cut)\b/i,
    "\u30C6\u30AD\u30B9\u30C8\u51E6\u7406"],
  // Package managers (view/list only)
  [/^npm\s+(list|ls|info|show|outdated)\b/i,
    "\u30D1\u30C3\u30B1\u30FC\u30B8\u60C5\u5831\u78BA\u8A8D"],
  // Environment / shell utilities
  [/^(export|source|cd)\b/i,
    "\u30B7\u30A7\u30EB\u64CD\u4F5C"],
  // Bash variable / conditional checks
  [/^(test|true|false|\[)\b/i,
    "\u6761\u4EF6\u78BA\u8A8D"],
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
 * Generate a brief Japanese description of the tool operation.
 *
 * @param {string} toolName - Claude Code tool name (Bash, Edit, Write, etc.).
 * @param {Object} toolInput - Tool input parameters.
 * @returns {string} Japanese description string.
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
    const filePath = toolInput.file_path || "\u4E0D\u660E";
    return "`" + filePath + "` \u3092\u7DE8\u96C6/\u4F5C\u6210";
  }
  if (toolName === "Read") {
    return "`" + (toolInput.file_path || "\u4E0D\u660E") + "` \u3092\u8AAD\u307F\u8FBC\u307F";
  }
  if (toolName === "Glob" || toolName === "Grep") {
    return "\u30D5\u30A1\u30A4\u30EB\u3092\u691C\u7D22";
  }
  if (toolName === "WebFetch") {
    return (toolInput.url || "URL").slice(0, 60) + " \u3092\u53D6\u5F97";
  }
  if (toolName === "WebSearch") {
    return "`" + (toolInput.query || "").slice(0, 60) + "` \u3092\u691C\u7D22";
  }
  if (toolName === "Task") {
    return "\u30B5\u30D6\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u3092\u8D77\u52D5: " + (toolInput.description || "").slice(0, 60);
  }
  return toolName + " \u3092\u5B9F\u884C";
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
    return ["safe", toolName + " \u306F\u8AAD\u307F\u53D6\u308A\u5C02\u7528\u64CD\u4F5C"];
  }

  // Task (subagent spawn): safe — already governed by its own session
  if (toolName === "Task") {
    return ["safe", "\u30B5\u30D6\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u8D77\u52D5\uFF08\u5E33\u7BA1\u8F44\u5185\uFF09"];
  }

  // Bash: check safe patterns
  if (toolName === "Bash") {
    const command = toolInput.command || "";
    const [safe, label] = isSafeBash(command);
    if (safe) {
      return ["safe", label];
    }
    return ["unknown", "\u5B89\u5168\u30D1\u30BF\u30FC\u30F3\u5916\u306E\u30B3\u30DE\u30F3\u30C9"];
  }

  // Edit/Write: check contract scope
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const filePath = toolInput.file_path || toolInput.notebook_path || "";
    if (filePath) {
      const inScope = isPathInScope(filePath);
      if (inScope === true) {
        return ["safe", "\u5951\u7D04\u30B9\u30B3\u30FC\u30D7\u5185\u306E\u30D5\u30A1\u30A4\u30EB"];
      }
      if (inScope === null) {
        // No scope restriction = safe
        return ["safe", "\u30B9\u30B3\u30FC\u30D7\u5236\u9650\u306A\u3057"];
      }
    }
    return ["unknown", "\u30B9\u30B3\u30FC\u30D7\u672A\u78BA\u8A8D\u306E\u30D5\u30A1\u30A4\u30EB\u64CD\u4F5C"];
  }

  // Other tools: unknown (let user decide)
  return ["unknown", toolName + " \u306E\u64CD\u4F5C"];
}

/**
 * Build Japanese systemMessage for unknown operations.
 *
 * @param {string} toolName - Claude Code tool name.
 * @param {Object} toolInput - Tool input parameters.
 * @param {string} reason - Classification reason.
 * @param {string} task - Current task name.
 * @param {string} profile - Operating profile.
 * @returns {string} Japanese message for the permission dialog.
 */
function makeSystemMessage(toolName, toolInput, reason, task, profile) {
  const opDesc = describeOperation(toolName, toolInput);
  return (
    "\uD83C\uDFAD \u5E33 [" + task + "] \u2014 " + opDesc + "\n" +
    "\u30D7\u30ED\u30D5\u30A1\u30A4\u30EB: " + profile + "\u3000\u7406\u7531: " + reason + "\n" +
    "\u627F\u8A8D\u3059\u308B\u5834\u5408\u306F\u300C\u5E38\u306B\u8A31\u53EF\u300D\u3092\u9078\u629E\u3059\u308B\u3068\u6B21\u56DE\u304B\u3089\u81EA\u52D5\u627F\u8A8D\u3055\u308C\u307E\u3059\u3002"
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

  // Unknown: show dialog with Japanese context via systemMessage
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
