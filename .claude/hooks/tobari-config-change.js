"use strict";
/**
 * ConfigChange hook (A7): Record configuration changes to evidence trail.
 *
 * Monitors .claude/settings.json for changes by comparing SHA-256 hashes.
 * When a change is detected, records the event (with diff summary) to
 * the evidence ledger.
 *
 * Design:
 * - Fail-open: errors never block config loading
 * - Hash state persisted in .claude/logs/config-hash.json
 * - Evidence entry written on any change detection
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  writeEvidence,
  runHook,
} = require("./tobari-session.js");

const CONFIG_HASH_FILENAME = "config-hash.json";

/**
 * Get the path to the config hash state file.
 * @returns {string}
 */
function getConfigHashPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.join(projectDir, ".claude", "logs", CONFIG_HASH_FILENAME);
}

/**
 * Get the path to settings.json.
 * @returns {string}
 */
function getSettingsPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.join(projectDir, ".claude", "settings.json");
}

/**
 * Read and parse settings.json.
 * @returns {{ raw: string, parsed: object }|null}
 */
function readSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf8");
    return { raw, parsed: JSON.parse(raw) };
  } catch (_) {
    return null;
  }
}

/**
 * Compute SHA-256 hash of a string.
 * @param {string} content
 * @returns {string}
 */
function hashContent(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Load previously stored config hash.
 * @returns {{ hash: string, snapshot_keys: string[] }|null}
 */
function loadStoredConfigHash() {
  try {
    const raw = fs.readFileSync(getConfigHashPath(), "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Save current config hash to state file.
 * @param {string} hash
 * @param {string[]} topKeys - Top-level keys for summary
 */
function saveConfigHash(hash, topKeys) {
  const statePath = getConfigHashPath();
  const dir = path.dirname(statePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // ignore
  }
  const state = {
    hash,
    snapshot_keys: topKeys,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Detect top-level key differences between snapshots.
 * @param {string[]} oldKeys
 * @param {string[]} newKeys
 * @returns {{ added: string[], removed: string[] }}
 */
function detectKeyChanges(oldKeys, newKeys) {
  const oldSet = new Set(oldKeys || []);
  const newSet = new Set(newKeys || []);
  const added = newKeys.filter((k) => !oldSet.has(k));
  const removed = (oldKeys || []).filter((k) => !newSet.has(k));
  return { added, removed };
}

/**
 * ConfigChange hook handler.
 * @param {object} _data - Hook input
 * @returns {object|null}
 */
function handler(_data) {
  const settings = readSettings();
  if (!settings) return null;

  const currentHash = hashContent(settings.raw);
  const topKeys = Object.keys(settings.parsed);
  const stored = loadStoredConfigHash();

  // Always save current state
  saveConfigHash(currentHash, topKeys);

  // First run — baseline, no warning
  if (!stored) {
    return null;
  }

  // No change
  if (stored.hash === currentHash) {
    return null;
  }

  // Detect structural changes
  const keyChanges = detectKeyChanges(stored.snapshot_keys, topKeys);

  // Record to evidence ledger
  writeEvidence({
    event: "config_changed",
    settings_hash: currentHash,
    previous_hash: stored.hash,
    key_changes: keyChanges,
    top_level_keys: topKeys,
  });

  // Build warning message
  const parts = ["settings.json has been modified"];
  if (keyChanges.added.length > 0) {
    parts.push("New keys: " + keyChanges.added.join(", "));
  }
  if (keyChanges.removed.length > 0) {
    parts.push("Removed keys: " + keyChanges.removed.join(", "));
  }

  return {
    hookSpecificOutput: {
      hookEventName: "ConfigChange",
      additionalContext:
        "CONFIG CHANGE DETECTED: " +
        parts.join(". ") +
        ". Evidence has been recorded to the audit trail.",
    },
  };
}

// CLI entry point
if (require.main === module) {
  runHook(handler);
}

module.exports = {
  CONFIG_HASH_FILENAME,
  getConfigHashPath,
  getSettingsPath,
  readSettings,
  hashContent,
  loadStoredConfigHash,
  saveConfigHash,
  detectKeyChanges,
  handler,
};
