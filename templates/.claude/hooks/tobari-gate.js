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
  [/rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/i, "rm -rf（再帰的強制削除）"],
  [/rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+\//i, "rm -r /（ルートディレクトリの再帰削除）"],
  [/rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+~/i, "rm -r ~（ホームディレクトリの再帰削除）"],
  [/rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+\.\s*$/i, "rm -r .（カレントディレクトリの再帰削除）"],
  [/rm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+\.\./i, "rm -r ..（親ディレクトリの再帰削除）"],

  // Git destructive operations
  [/git\s+push\s+.*--force(?!-with-lease)\b/i, "git push --force（リモート履歴の強制上書き）"],
  [/git\s+push\s+(?:.*\s)?-f\b/i, "git push -f（リモート履歴の強制上書き）"],
  [/git\s+reset\s+--hard/i, "git reset --hard（未コミット変更の全破棄）"],
  [/git\s+clean\s+.*-[a-zA-Z]*f/i, "git clean -f（未追跡ファイルの強制削除）"],
  [/git\s+checkout\s+--\s+\./i, "git checkout -- .（全変更の破棄）"],
  [/git\s+restore\s+.*--worktree\s+\./i, "git restore --worktree .（全変更の復元）"],
  // git branch -D: case-sensitive (uppercase D only) — no 'i' flag
  null, // placeholder — handled by CASE_SENSITIVE_DESTRUCTIVE_PATTERNS
  [/git\s+push\s+.*--delete\b/i, "git push --delete（リモートブランチ削除）"],
  [/git\s+push\s+\S+\s+:\S+/i, "git push origin :branch（リモートブランチ削除）"],
  [/git\s+stash\s+(drop|clear)\b/i, "git stash drop/clear（stash の削除）"],
  [/git\s+reflog\s+(delete|expire)\b/i, "git reflog delete/expire（reflog の削除）"],
  [/git\s+filter-branch\b/i, "git filter-branch（履歴の書き換え）"],

  // Database destruction
  [/drop\s+table/i, "DROP TABLE（テーブル削除）"],
  [/drop\s+database/i, "DROP DATABASE（データベース削除）"],
  [/truncate\s+table/i, "TRUNCATE TABLE（テーブルデータ全削除）"],

  // System-level danger
  [/chmod\s+(-[a-zA-Z]*R[a-zA-Z]*)\s+777\s+\//i, "chmod -R 777 /（全ファイルの権限変更）"],
  [/mkfs\./i, "mkfs（ディスクフォーマット）"],
  [/dd\s+.*of=\/dev\//i, "dd of=/dev/（デバイスへの直接書き込み）"],

  // Process/system danger
  [/kill\s+-9\s+-1/i, "kill -9 -1（全プロセス強制終了）"],
  [/\bshutdown\b/i, "shutdown（システムシャットダウン）"],
  [/\breboot\b/i, "reboot（システム再起動）"],
].filter(Boolean);

// Case-sensitive pattern (Python's (?-i:D) — uppercase D only)
const CASE_SENSITIVE_DESTRUCTIVE_PATTERNS = [
  [/git\s+branch\s+(?:-[a-zA-Z]*D|-d\s+--force)\b/, "git branch -D（ブランチの強制削除）"],
];

// --- Strict Profile Additional Patterns ---

const STRICT_SUSPICIOUS_PATTERNS = [
  [/\|.*\bcurl\b/i, "パイプ経由の curl（データ流出リスク）"],
  [/\bcurl\s+.*-X\s+(POST|PUT|DELETE)/i, "curl による変更系 HTTP リクエスト"],
  [/\bwget\s+.*-O\s+\//i, "wget によるシステムパスへの書き込み"],
  [/\beval\s+/i, "eval（コード注入リスク）"],
];

// --- Secret Detection Patterns ---

const _FALLBACK_SECRET_PATTERNS = [
  [/(?:api[_-]?key|apikey)\s*[=:]\s*["']([A-Za-z0-9_\-]{20,})["']/i, "API キー"],
  [/AKIA[0-9A-Z]{16}/, "AWS アクセスキー"],
  [/(?:password|passwd|pwd|secret)\s*[=:]\s*["']([^"']{8,})["']/i, "パスワード/シークレット"],
  [/-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, "秘密鍵"],
  [/(?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@/i, "接続文字列（パスワード含む）"],
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
    return "ファイルパスが空です";
  }
  if (filePath.length > MAX_PATH_LENGTH) {
    return `ファイルパスが長すぎます（${filePath.length} > ${MAX_PATH_LENGTH}）`;
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return `コンテンツが大きすぎます（${content.length} > ${MAX_CONTENT_LENGTH}）`;
  }

  // Null byte check (poison byte — truncation attack)
  if (filePath.includes("\x00")) {
    return `ヌルバイトを検出: ${filePath}`;
  }

  // UNC path check — must come BEFORE ADS check (\\?\C:\... has colon)
  if (filePath.startsWith("\\\\") || filePath.startsWith("//")) {
    return `UNC パスを検出: ${filePath}`;
  }

  // NT prefix check
  if (filePath.startsWith("\\\\?\\") || filePath.startsWith("\\\\.\\")) {
    return `NT プレフィックスを検出: ${filePath}`;
  }

  // Windows ADS check: colon only valid at drive letter position (index 1)
  if (_IS_WINDOWS) {
    const pathAfterDrive = (filePath.length > 2 && filePath[1] === ":")
      ? filePath.slice(2) : filePath;
    if (pathAfterDrive.includes(":")) {
      return `Windows ADS（代替データストリーム）を検出: ${filePath}`;
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
        return `パストラバーサルを検出（プロジェクトルート外: ${filePath}）`;
      }
    } catch (_) {
      return `パス解決に失敗: ${filePath}`;
    }
  } else {
    // Fallback: component-level ".." check
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    if (parts.includes("..")) {
      return `パストラバーサルを検出（'..' コンポーネント: ${filePath}）`;
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
        `🔒 帳が止めました — ${reason}\n` +
        `\n` +
        `  タスク: ${task}\n` +
        `  プロファイル: ${profile}\n` +
        `  ${detail}\n` +
        `\n` +
        `対処法:\n` +
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
        "破壊的コマンドを検出",
        `検出: ${label}\n  コマンド: ${truncateCommand(command)}`,
        "安全な代替コマンドを使用してください。\n" +
        "  例: rm -rf → 個別ファイルの rm、git push --force → git push --force-with-lease",
        "Bash",
      );
    }
  }

  // Case-sensitive patterns (no 'i' flag — e.g., git branch -D)
  for (const [pattern, label] of CASE_SENSITIVE_DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return makeDenyResponse(
        "破壊的コマンドを検出",
        `検出: ${label}\n  コマンド: ${truncateCommand(command)}`,
        "安全な代替コマンドを使用してください。\n" +
        "  例: rm -rf → 個別ファイルの rm、git push --force → git push --force-with-lease",
        "Bash",
      );
    }
  }

  // Strict profile: additional suspicious patterns
  if (profile === "strict") {
    for (const [pattern, label] of STRICT_SUSPICIOUS_PATTERNS) {
      if (pattern.test(command)) {
        return makeDenyResponse(
          "Strict プロファイルで不審なコマンドを検出",
          `検出: ${label}\n  コマンド: ${truncateCommand(command)}`,
          "安全性を確認してから再実行してください。\n" +
          "  Standard プロファイルに変更するか、帳をおろし直してください（/tobari）。",
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
        "Bash コマンド内に秘密情報を検出",
        `検出パターン: ${label}`,
        "秘密情報をコマンドに直接含めないでください。\n" +
        "  環境変数（$ENV_VAR）を使用してください。",
        "Bash",
      );
    }
  }

  for (const [pattern, label] of SENSITIVE_FILE_ACCESS_PATTERNS) {
    if (pattern.test(command)) {
      return makeDenyResponse(
        "機密ファイルへのアクセスを検出",
        `検出パターン: ${label}\n  コマンド: ${truncateCommand(command)}`,
        "機密ファイルの内容をコマンドラインで表示しないでください。\n" +
        "  ファイルの存在確認には `test -f` を使用してください。",
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
      "契約範囲外のファイル操作を検出",
      `対象ファイル: ${filePath}\n` +
      `  契約スコープ: ${JSON.stringify(scope.include || [])}\n` +
      `  除外パス: ${JSON.stringify(scope.exclude || [])}`,
      "契約範囲を変更するには、帳をおろし直してください（/tobari）。",
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
    "境界分類違反 — private_only ファイルへの操作を検出",
    `ファイル: ${filePath}\n  分類: private_only（ガバナンス内部専用）`,
    "このファイルはガバナンス内部専用です。\n" +
    "  契約範囲を変更するには、帳をおろし直してください（/tobari）。",
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
        "秘密情報のハードコードを検出",
        `検出パターン: ${label}`,
        "環境変数（os.environ）を使用してください。\n" +
        "  .env ファイルに秘密情報を格納し、.gitignore に追加してください。",
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
          "不正な入力を検出",
          `検証失敗: ${validationFailure}`,
          "正しいファイルパスとコンテンツで再実行してください。",
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
            "入力値を確認してください。",
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
