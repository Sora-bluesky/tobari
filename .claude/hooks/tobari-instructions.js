"use strict";
/**
 * InstructionsLoaded hook (A6): Detect rule file hash changes.
 *
 * Computes SHA-256 hashes of all files in .claude/rules/ and CLAUDE.md,
 * compares against previously stored hashes, and logs changes to the
 * evidence ledger. Warns the user when rule files have been modified.
 *
 * Design:
 * - Fail-open: errors never block instructions loading
 * - Hash state persisted in .claude/logs/instructions-hashes.json
 * - Evidence entry written on any change detection
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  writeEvidence,
  runHook,
} = require("./tobari-session.js");

const HASH_STATE_FILENAME = "instructions-hashes.json";

/**
 * Get the path to the hash state file.
 * @returns {string}
 */
function getHashStatePath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.join(projectDir, ".claude", "logs", HASH_STATE_FILENAME);
}

/**
 * Compute SHA-256 hash of a file's contents.
 * @param {string} filePath
 * @returns {string|null} hex hash, or null if file unreadable
 */
function hashFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
  } catch (_) {
    return null;
  }
}

/**
 * Collect current hashes of all rule files + CLAUDE.md.
 * @returns {Object<string, string>} Map of relative path -> SHA-256 hash
 */
function collectCurrentHashes() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const hashes = {};

  // CLAUDE.md
  const claudeMd = path.join(projectDir, "CLAUDE.md");
  const claudeHash = hashFile(claudeMd);
  if (claudeHash) hashes["CLAUDE.md"] = claudeHash;

  // .claude/rules/*.md
  const rulesDir = path.join(projectDir, ".claude", "rules");
  try {
    const files = fs.readdirSync(rulesDir);
    for (const file of files) {
      const fullPath = path.join(rulesDir, file);
      try {
        if (!fs.statSync(fullPath).isFile()) continue;
      } catch (_) {
        continue;
      }
      const h = hashFile(fullPath);
      if (h) hashes[`.claude/rules/${file}`] = h;
    }
  } catch (_) {
    // rules dir may not exist
  }

  return hashes;
}

/**
 * Load previously stored hashes.
 * @returns {Object<string, string>|null}
 */
function loadStoredHashes() {
  try {
    const raw = fs.readFileSync(getHashStatePath(), "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Save current hashes to state file.
 * @param {Object<string, string>} hashes
 */
function saveHashes(hashes) {
  const statePath = getHashStatePath();
  const dir = path.dirname(statePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // ignore
  }
  fs.writeFileSync(statePath, JSON.stringify(hashes, null, 2), "utf8");
}

/**
 * Detect changes between stored and current hashes.
 * @param {Object<string, string>|null} stored
 * @param {Object<string, string>} current
 * @returns {{ added: string[], modified: string[], removed: string[] }}
 */
function detectChanges(stored, current) {
  if (!stored) {
    return { added: Object.keys(current), modified: [], removed: [] };
  }

  const added = [];
  const modified = [];
  const removed = [];

  for (const [file, hash] of Object.entries(current)) {
    if (!(file in stored)) {
      added.push(file);
    } else if (stored[file] !== hash) {
      modified.push(file);
    }
  }

  for (const file of Object.keys(stored)) {
    if (!(file in current)) {
      removed.push(file);
    }
  }

  return { added, modified, removed };
}

/**
 * InstructionsLoaded hook handler.
 * @param {object} _data - Hook input
 * @returns {object|null}
 */
function handler(_data) {
  const stored = loadStoredHashes();
  const current = collectCurrentHashes();
  const changes = detectChanges(stored, current);

  // Always save current state
  saveHashes(current);

  const hasChanges =
    changes.added.length > 0 ||
    changes.modified.length > 0 ||
    changes.removed.length > 0;

  // First run (no stored state) — just record baseline, no warning
  if (!stored) {
    return null;
  }

  if (!hasChanges) {
    return null;
  }

  // Record to evidence ledger
  writeEvidence({
    event: "instructions_changed",
    changes,
    file_count: Object.keys(current).length,
  });

  // Build warning message
  const parts = [];
  if (changes.modified.length > 0) {
    parts.push("Modified: " + changes.modified.join(", "));
  }
  if (changes.added.length > 0) {
    parts.push("Added: " + changes.added.join(", "));
  }
  if (changes.removed.length > 0) {
    parts.push("Removed: " + changes.removed.join(", "));
  }

  return {
    hookSpecificOutput: {
      hookEventName: "InstructionsLoaded",
      additionalContext:
        "RULE FILE CHANGE DETECTED: " +
        parts.join("; ") +
        ". Verify these changes are intentional. " +
        "Evidence has been recorded to the audit trail.",
    },
  };
}

// CLI entry point
if (require.main === module) {
  runHook(handler);
}

module.exports = {
  HASH_STATE_FILENAME,
  getHashStatePath,
  hashFile,
  collectCurrentHashes,
  loadStoredHashes,
  saveHashes,
  detectChanges,
  handler,
};
