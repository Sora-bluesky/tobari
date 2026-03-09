#!/usr/bin/env node
"use strict";
/**
 * PreToolUse hook: Gate Engine — the heart of tobari's veil.
 *
 * When the veil is active, enforces safety rules:
 * - Bash: blocks destructive commands (rm -rf, git push --force, etc.)
 * - Edit/Write: blocks scope violations, boundary classification violations, secrets
 *
 * When the veil is inactive, provides design-change advisory (no blocking).
 *
 * Implements docs/24 §7 (allow/deny/ask rules) and docs/25 (STG gate spec).
 *
 * Profile behavior:
 * - Lite: destructive Bash deny only (minimal gate density)
 * - Standard: full deny patterns (destructive Bash + scope + boundary + secrets)
 * - Strict: full deny + suspicious pattern deny (curl POST, eval, exec)
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const tobariSession = require("./tobari-session.js");
const { t } = require("./tobari-i18n.js");

// --- Constants ---

const _IS_WINDOWS = process.platform === "win32";
const MAX_PATH_LENGTH = 4096;
const MAX_CONTENT_LENGTH = 1_000_000;
const COMMAND_TRUNCATE_LENGTH = 120;

// --- Helper ---

function _getProjectRoot() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  if (projectDir) {
    try {
      return fs.realpathSync(path.resolve(projectDir));
    } catch (_) {
      try { return path.resolve(projectDir); } catch (__) { return null; }
    }
  }
  // Fallback: hooks dir is {project}/.claude/hooks/
  try {
    return fs.realpathSync(path.resolve(__dirname, "..", ".."));
  } catch (_) {
    try { return path.resolve(__dirname, "..", ".."); } catch (__) { return null; }
  }
}

// --- Destructive Bash Patterns (all profiles) ---
// Each entry: [RegExp, label]
// NOTE: Line 69 of Python uses (?-i:D) which is Python-only syntax.
// We split that pattern: the git branch -D pattern is case-sensitive (no 'i' flag).

const DESTRUCTIVE_BASH_PATTERNS = [
  // File system destruction
  [/rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/i, t("gate.pattern.rm_rf")],
  [/rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+\//i, t("gate.pattern.rm_r_root")],
  [/rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+~/i, t("gate.pattern.rm_r_home")],
  [/rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+\.\s*$/i, t("gate.pattern.rm_r_current")],
  [/rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+\.\./i, t("gate.pattern.rm_r_parent")],

  // Git destructive operations
  [/git\s+push\s+.*--force(?!-with-lease)\b/i, t("gate.pattern.git_push_force")],
  [/git\s+push\s+(?:.*\s)?-f\b/i, t("gate.pattern.git_push_f")],
  [/git\s+reset\s+--hard/i, t("gate.pattern.git_reset_hard")],
  [/git\s+clean\s+.*-[a-zA-Z]*f/i, t("gate.pattern.git_clean_f")],
  [/git\s+checkout\s+--\s+\./i, t("gate.pattern.git_checkout_dot")],
  [/git\s+restore\s+.*--worktree\s+\./i, t("gate.pattern.git_restore_worktree")],
  // git branch -D: case-sensitive (uppercase D only) — no 'i' flag
  null, // placeholder — handled by CASE_SENSITIVE_DESTRUCTIVE_PATTERNS
  [/git\s+push\s+.*--delete\b/i, t("gate.pattern.git_push_delete")],
  [/git\s+push\s+\S+\s+:\S+/i, t("gate.pattern.git_push_colon")],
  [/git\s+stash\s+(drop|clear)\b/i, t("gate.pattern.git_stash_drop")],
  [/git\s+reflog\s+(delete|expire)\b/i, t("gate.pattern.git_reflog_delete")],
  [/git\s+filter-branch\b/i, t("gate.pattern.git_filter_branch")],

  // Database destruction
  [/drop\s+table/i, t("gate.pattern.drop_table")],
  [/drop\s+database/i, t("gate.pattern.drop_database")],
  [/truncate\s+table/i, t("gate.pattern.truncate_table")],

  // System-level danger
  [/chmod\s+(-[a-zA-Z]*R[a-zA-Z]*)\s+777\s+\//i, t("gate.pattern.chmod_777")],
  [/mkfs\./i, t("gate.pattern.mkfs")],
  [/dd\s+.*of=\/dev\//i, t("gate.pattern.dd_dev")],

  // Process/system danger
  [/kill\s+-9\s+-1/i, t("gate.pattern.kill_all")],
  [/\bshutdown\b/i, t("gate.pattern.shutdown")],
  [/\breboot\b/i, t("gate.pattern.reboot")],
].filter(Boolean);

// Case-sensitive pattern (Python's (?-i:D) — uppercase D only)
const CASE_SENSITIVE_DESTRUCTIVE_PATTERNS = [
  [/git\s+branch\s+(?:-[a-zA-Z]*D|-d\s+--force)\b/, t("gate.pattern.git_branch_D")],
];

// --- Strict Profile Additional Patterns ---

const STRICT_SUSPICIOUS_PATTERNS = [
  [/\|.*\bcurl\b/i, t("gate.strict.curl_pipe")],
  [/\bcurl\s+.*-X\s+(POST|PUT|DELETE)/i, t("gate.strict.curl_mutate")],
  [/\bwget\s+.*-O\s+\//i, t("gate.strict.wget_system")],
  [/\beval\s+/i, t("gate.strict.eval")],
];

// --- Secret Detection Patterns ---

const _FALLBACK_SECRET_PATTERNS = [
  [/(?:api[_-]?key|apikey)\s*[=:]\s*["']([A-Za-z0-9_\-]{20,})["']/i, t("gate.secret.api_key")],
  [/AKIA[0-9A-Z]{16}/, t("gate.secret.aws_key")],
  [/(?:password|passwd|pwd|secret)\s*[=:]\s*["']([^"']{8,})["']/i, t("gate.secret.password")],
  [/-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, t("gate.secret.private_key")],
  [/(?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@/i, t("gate.secret.connection_string")],
];

// --- Sensitive File Access Patterns ---

const SENSITIVE_FILE_ACCESS_PATTERNS = [
  [/\b(cat|less|more|head|tail|bat|type)\b.*~\/\.ssh\//i, "SSH key/config file access"],
  [/\b(cat|less|more|head|tail|bat|type)\b.*\/\.ssh\//i, "SSH key/config file access"],
  [/\b(cat|less|more|head|tail|bat|type)\b.*~\/\.aws\//i, "AWS credential file access"],
  [/\b(cat|less|more|head|tail|bat|type)\b.*\/\.aws\//i, "AWS credential file access"],
  [/\b(cat|less|more|head|tail|bat|type)\b.*~\/\.gnupg\//i, "GnuPG key file access"],
  [/\b(cat|less|more|head|tail|bat|type)\b.*\/\.gnupg\//i, "GnuPG key file access"],
  [/\b(cat|less|more|head|tail|bat|type)\b.*\.env\b/i, ".env file (secrets/environment) access"],
  [/\b(cat|less|more|head|tail|bat|type)\b.*~\/\.kube\/config/i, "Kubernetes config file access"],
  [/\b(cat|less|more|head|tail|bat|type)\b.*~\/\.config\/gcloud\//i, "GCP credential file access"],
];

function _loadSecretPatterns() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  const root = projectDir || path.resolve(__dirname, "..", "..");
  const yamlPath = path.join(root, "integration", "secret-patterns.yaml");

  try {
    if (fs.existsSync(yamlPath)) {
      // Future: line-based YAML parser if needed
      // For now, fall through to hardcoded patterns
    }
  } catch (_) {
    // ignore
  }
  return _FALLBACK_SECRET_PATTERNS;
}

const SECRET_PATTERNS = _loadSecretPatterns();

// --- Advisory Mode Patterns (veil-off) ---

const DESIGN_INDICATORS = [
  "DESIGN.md", "ARCHITECTURE.md", "architecture", "design",
  "schema", "model", "interface", "abstract", "base_",
  "core/", "/core/", "config", "settings",
  "class ", "interface ", "abstract class", "def __init__",
  "from abc import", "Protocol", "@dataclass", "TypedDict",
  "backlog", "governance", "binding", "gate", "stg",
  "preflight", "manifest", "stage_status",
];

const SIMPLE_EDIT_PATTERNS = [
  ".gitignore", "README.md", "CHANGELOG.md", "requirements.txt",
  "package.json", "pyproject.toml", ".env.example", "HANDOFF.md",
  "backlog.yaml",
];

// --- Input Validation ---

function validateInput(filePath, content) {
  if (!filePath) {
    return t("gate.validate.empty_path");
  }
  if (filePath.length > MAX_PATH_LENGTH) {
    return t("gate.validate.path_too_long", { actual: filePath.length, max: MAX_PATH_LENGTH });
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return t("gate.validate.content_too_large", { actual: content.length, max: MAX_CONTENT_LENGTH });
  }

  // Null byte check (poison byte — truncation attack)
  if (filePath.includes("\x00")) {
    return t("gate.validate.null_byte", { filePath });
  }

  // UNC path check — must come BEFORE ADS check (\\?\C:\... has colon)
  if (filePath.startsWith("\\\\") || filePath.startsWith("//")) {
    return t("gate.validate.unc_path", { filePath });
  }

  // NT prefix check
  if (filePath.startsWith("\\\\?\\") || filePath.startsWith("\\\\.\\")) {
    return t("gate.validate.nt_prefix", { filePath });
  }

  // Windows ADS check: colon only valid at drive letter position (index 1)
  if (_IS_WINDOWS) {
    const pathAfterDrive = (filePath.length > 2 && filePath[1] === ":")
      ? filePath.slice(2) : filePath;
    if (pathAfterDrive.includes(":")) {
      return t("gate.validate.windows_ads", { filePath });
    }
  }

  // Path traversal via path.resolve normalization
  const projectRoot = _getProjectRoot();
  if (projectRoot) {
    try {
      let resolved;
      if (path.isAbsolute(filePath)) {
        resolved = path.resolve(filePath);
      } else {
        resolved = path.resolve(projectRoot, filePath);
      }
      // Try to resolve symlinks (if file exists)
      try {
        resolved = fs.realpathSync(resolved);
      } catch (_) {
        // File may not exist yet — use path.resolve result
      }
      const startsWithRoot = _IS_WINDOWS
        ? resolved.toLowerCase().startsWith((projectRoot + path.sep).toLowerCase()) || resolved.toLowerCase() === projectRoot.toLowerCase()
        : resolved.startsWith(projectRoot + path.sep) || resolved === projectRoot;
      if (!startsWithRoot) {
        return t("gate.validate.traversal_outside", { filePath });
      }
    } catch (_) {
      return t("gate.validate.resolve_failed", { filePath });
    }
  } else {
    // Fallback: component-level ".." check
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    if (parts.includes("..")) {
      return t("gate.validate.traversal_dotdot", { filePath });
    }
  }

  return null;
}

function truncateCommand(command) {
  if (command.length <= COMMAND_TRUNCATE_LENGTH) {
    return command;
  }
  return command.slice(0, COMMAND_TRUNCATE_LENGTH) + "...";
}

// --- Deny Response Builder ---

function makeDenyResponse(reason, detail, recovery, toolName = "", toolInput = null) {
  const task = tobariSession.getTask() || "unknown";
  const profile = tobariSession.getProfile() || "unknown";

  // Record deny event to Evidence Ledger
  tobariSession.writeEvidence({
    event: "tool_denied",
    tool_name: toolName,
    reason,
    detail,
    task,
    profile,
  });

  // Emergency webhook: fire-and-forget if configured
  const session = tobariSession.loadSession();
  const webhookUrl = session ? tobariSession.getWebhookConfig(session) : null;
  if (webhookUrl) {
    tobariSession.sendWebhook(webhookUrl, {
      event: "tool_denied",
      task,
      tool: toolName,
      reason,
      profile,
    });
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      additionalContext:
        `${t("gate.deny.header", { reason })}\n` +
        `\n` +
        `  ${t("gate.deny.task", { task })}\n` +
        `  ${t("gate.deny.profile", { profile })}\n` +
        `  ${detail}\n` +
        `\n` +
        `${t("gate.deny.recovery_header")}\n` +
        `  ${recovery}`,
    },
  };
}

// --- Gate Checks: Bash ---

function checkDestructiveBash(command, profile) {
  // Standard patterns (case-insensitive)
  for (const [pattern, label] of DESTRUCTIVE_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return makeDenyResponse(
        t("gate.destructive_detected"),
        t("gate.destructive_detail", { label, command: truncateCommand(command) }),
        t("gate.destructive_recovery"),
        "Bash",
      );
    }
  }

  // Case-sensitive patterns (no 'i' flag — e.g., git branch -D)
  for (const [pattern, label] of CASE_SENSITIVE_DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return makeDenyResponse(
        t("gate.destructive_detected"),
        t("gate.destructive_detail", { label, command: truncateCommand(command) }),
        t("gate.destructive_recovery"),
        "Bash",
      );
    }
  }

  // Strict profile: additional suspicious patterns
  if (profile === "strict") {
    for (const [pattern, label] of STRICT_SUSPICIOUS_PATTERNS) {
      if (pattern.test(command)) {
        return makeDenyResponse(
          t("gate.strict_detected"),
          t("gate.destructive_detail", { label, command: truncateCommand(command) }),
          t("gate.strict_recovery"),
          "Bash",
        );
      }
    }
  }

  return null;
}

function checkSecretInBash(command) {
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(command)) {
      return makeDenyResponse(
        t("gate.secret_in_bash"),
        t("gate.secret_detail", { label }),
        t("gate.secret_recovery"),
        "Bash",
      );
    }
  }

  for (const [pattern, label] of SENSITIVE_FILE_ACCESS_PATTERNS) {
    if (pattern.test(command)) {
      return makeDenyResponse(
        t("gate.sensitive_file"),
        t("gate.sensitive_detail", { label, command: truncateCommand(command) }),
        t("gate.sensitive_recovery"),
        "Bash",
      );
    }
  }

  return null;
}

function checkAdvisoryDestructiveBash(command) {
  // Check standard patterns
  for (const [pattern, label] of DESTRUCTIVE_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            `[Advisory] Destructive command detected: ${label}\n` +
            `Command: ${truncateCommand(command)}\n` +
            "The veil is inactive, so this command was NOT blocked.\n" +
            "Consider using safer alternatives.",
        },
      };
    }
  }
  // Check case-sensitive patterns
  for (const [pattern, label] of CASE_SENSITIVE_DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            `[Advisory] Destructive command detected: ${label}\n` +
            `Command: ${truncateCommand(command)}\n` +
            "The veil is inactive, so this command was NOT blocked.\n" +
            "Consider using safer alternatives.",
        },
      };
    }
  }
  return null;
}

// --- Gate Checks: Edit/Write ---

function checkScope(filePath, toolName) {
  const inScope = tobariSession.isPathInScope(filePath);

  if (inScope === null || inScope === undefined) {
    return null;
  }

  if (inScope === false) {
    const scope = tobariSession.getScope() || {};
    return makeDenyResponse(
      t("gate.scope_violation"),
      t("gate.scope_detail", {
        filePath,
        include: JSON.stringify(scope.include || []),
        exclude: JSON.stringify(scope.exclude || []),
      }),
      t("gate.scope_recovery"),
      toolName,
    );
  }

  return null;
}

function checkBoundaryClassification(filePath, toolName) {
  const classification = tobariSession.getBoundaryClassification(filePath);

  if (classification !== "private_only") {
    return null;
  }

  // If scope check already allows it, don't double-block
  const scopeCheck = tobariSession.isPathInScope(filePath);
  if (scopeCheck === true) {
    return null;
  }

  return makeDenyResponse(
    t("gate.boundary_violation"),
    t("gate.boundary_detail", { filePath }),
    t("gate.boundary_recovery"),
    toolName,
  );
}

function checkSecretInContent(content, toolName) {
  if (!content) {
    return null;
  }

  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      return makeDenyResponse(
        t("gate.secret_in_content"),
        t("gate.secret_detail", { label }),
        t("gate.secret_content_recovery"),
        toolName,
      );
    }
  }

  return null;
}

// --- Advisory Mode (veil-off) ---

function checkDesignAdvisory(filePath, content) {
  const filePathLower = filePath.toLowerCase();

  for (const pattern of SIMPLE_EDIT_PATTERNS) {
    if (filePathLower.includes(pattern.toLowerCase())) {
      return null;
    }
  }

  for (const indicator of DESIGN_INDICATORS) {
    if (filePathLower.includes(indicator.toLowerCase())) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            `[Design Change Detected] File path contains '${indicator}'. ` +
            "Consider reviewing design implications before proceeding.",
        },
      };
    }
  }

  if (content && content.length > 500) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "[Large File Advisory] Creating new file with significant content. " +
          "Consider self-reviewing for design implications before proceeding.",
      },
    };
  }

  return null;
}

// --- Main Handler ---

function handler(data) {
  const toolName = data.tool_name || "";
  const toolInput = data.tool_input || {};

  const session = tobariSession.loadSession();

  if (session) {
    // === Veil active: Gate Engine mode ===
    const profile = tobariSession.getProfile() || "standard";

    if (toolName === "Bash") {
      const command = toolInput.command || "";
      if (!command) {
        return null;
      }

      // 1. Destructive command check
      let result = checkDestructiveBash(command, profile);
      if (result) return result;

      // 2. Secret in bash command
      result = checkSecretInBash(command);
      if (result) return result;

      // Pass through
      return null;
    }

    if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
      let filePath = toolInput.file_path || toolInput.notebook_path || "";
      const content = toolInput.content || toolInput.new_string || toolInput.new_source || "";

      const validationFailure = validateInput(filePath, content);
      if (validationFailure) {
        return makeDenyResponse(
          t("gate.invalid_input"),
          t("gate.validation_failed", { detail: validationFailure }),
          t("gate.validation_recovery"),
          toolName,
        );
      }

      // 1. Scope check
      let result = checkScope(filePath, toolName);
      if (result) return result;

      // 2. Boundary classification check
      result = checkBoundaryClassification(filePath, toolName);
      if (result) return result;

      // 3. Secret detection in content
      result = checkSecretInContent(content, toolName);
      if (result) return result;

      // Pass through
      return null;
    }

    // Other tools: pass through
    return null;
  }

  // === No veil: Advisory mode (backward compatible) ===
  if (toolName === "Bash") {
    const command = toolInput.command || "";
    if (command) {
      return checkAdvisoryDestructiveBash(command);
    }
    return null;
  }

  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    let filePath = toolInput.file_path || toolInput.notebook_path || "";
    const content = toolInput.content || toolInput.new_string || toolInput.new_source || "";

    const validationFailure = validateInput(filePath, content);
    if (validationFailure) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            `[Input Validation Warning] ${validationFailure}\n` +
            t("gate.validation_advisory"),
        },
      };
    }

    return checkDesignAdvisory(filePath, content);
  }

  return null;
}

// --- CLI Entry Point ---

if (require.main === module) {
  tobariSession.runHook(handler);
}

// --- Exports (for testing) ---

module.exports = {
  _IS_WINDOWS,
  MAX_PATH_LENGTH,
  MAX_CONTENT_LENGTH,
  COMMAND_TRUNCATE_LENGTH,
  DESTRUCTIVE_BASH_PATTERNS,
  CASE_SENSITIVE_DESTRUCTIVE_PATTERNS,
  STRICT_SUSPICIOUS_PATTERNS,
  SECRET_PATTERNS,
  SENSITIVE_FILE_ACCESS_PATTERNS,
  DESIGN_INDICATORS,
  SIMPLE_EDIT_PATTERNS,
  _getProjectRoot,
  validateInput,
  truncateCommand,
  makeDenyResponse,
  checkDestructiveBash,
  checkSecretInBash,
  checkAdvisoryDestructiveBash,
  checkScope,
  checkBoundaryClassification,
  checkSecretInContent,
  checkDesignAdvisory,
  handler,
};
