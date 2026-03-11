#!/usr/bin/env node
"use strict";
/**
 * Comprehensive tests for tobari-config-change.js (A7: ConfigChange Hook).
 *
 * Covers:
 *   - readSettings: invalid JSON, missing directory, valid JSON
 *   - saveConfigHash: directory creation, correct structure
 *   - loadStoredConfigHash: missing file, invalid JSON, correct data
 *   - detectKeyChanges: null oldKeys, empty arrays, identical keys
 *   - handler: no changes, added keys warning, removed keys warning,
 *     evidence recording, path resolution via CLAUDE_PROJECT_DIR
 *   - getConfigHashPath / getSettingsPath: CLAUDE_PROJECT_DIR usage
 *
 * Run: node --test --test-concurrency=1 tests/test_tobari_config_change_js.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// Preserve original PROJECT_DIR to restore after each test
const ORIGINAL_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, "..");

const configChangeHook = require("../.claude/hooks/tobari-config-change.js");

// --- Test Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tobari-cfgchg-test-"));
}

function cleanupTmpDir(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // Windows may hold locks briefly
  }
}

/**
 * Create a .claude/settings.json in the given tmpDir.
 * @param {string} tmpDir
 * @param {object} content
 * @returns {string} path to settings.json
 */
function createSettingsFile(tmpDir, content) {
  const claudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(content, null, 2), "utf8");
  return settingsPath;
}

/**
 * Create a .claude/settings.json with raw string content (for invalid JSON tests).
 * @param {string} tmpDir
 * @param {string} rawContent
 * @returns {string} path to settings.json
 */
function createRawSettingsFile(tmpDir, rawContent) {
  const claudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.writeFileSync(settingsPath, rawContent, "utf8");
  return settingsPath;
}

// =========================================================================
// readSettings
// =========================================================================

describe("A7-readSettings: invalid JSON", () => {
  it("returns null when settings.json contains invalid JSON", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      createRawSettingsFile(tmpDir, "{ this is not valid json !!! }");

      const result = configChangeHook.readSettings();
      assert.equal(result, null, "Should return null for invalid JSON");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

describe("A7-readSettings: missing directory", () => {
  it("returns null when .claude directory does not exist", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      // Do NOT create .claude/ directory

      const result = configChangeHook.readSettings();
      assert.equal(result, null, "Should return null when directory is missing");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

describe("A7-readSettings: valid JSON", () => {
  it("returns raw string and parsed object for valid settings", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const settingsObj = { hooks: { enabled: true }, permissions: { allow: [] } };
      createSettingsFile(tmpDir, settingsObj);

      const result = configChangeHook.readSettings();
      assert.notEqual(result, null, "Should return non-null for valid settings");
      assert.equal(typeof result.raw, "string", "raw should be a string");
      assert.equal(typeof result.parsed, "object", "parsed should be an object");
      assert.deepEqual(Object.keys(result.parsed).sort(), ["hooks", "permissions"]);
      assert.equal(result.parsed.hooks.enabled, true);
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("raw content round-trips through JSON.parse to match parsed", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const settingsObj = { alpha: 1, beta: "two" };
      createSettingsFile(tmpDir, settingsObj);

      const result = configChangeHook.readSettings();
      assert.deepEqual(JSON.parse(result.raw), result.parsed);
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// saveConfigHash
// =========================================================================

describe("A7-saveConfigHash: directory creation", () => {
  it("creates .claude/logs/ directory if it does not exist", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const logsDir = path.join(tmpDir, ".claude", "logs");
      assert.equal(fs.existsSync(logsDir), false, "logs dir should not exist initially");

      configChangeHook.saveConfigHash("abc123def456", ["hooks"]);

      assert.equal(fs.existsSync(logsDir), true, "logs dir should be created");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

describe("A7-saveConfigHash: correct structure", () => {
  it("writes hash, snapshot_keys, and updated_at fields", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const testHash = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
      const testKeys = ["hooks", "permissions", "env"];

      configChangeHook.saveConfigHash(testHash, testKeys);

      const hashPath = configChangeHook.getConfigHashPath();
      assert.equal(fs.existsSync(hashPath), true, "config hash file should exist");

      const stored = JSON.parse(fs.readFileSync(hashPath, "utf8"));
      assert.equal(stored.hash, testHash, "hash should match");
      assert.deepEqual(stored.snapshot_keys, testKeys, "snapshot_keys should match");
      assert.equal(typeof stored.updated_at, "string", "updated_at should be a string");
      // Verify updated_at is a valid ISO date
      const parsedDate = new Date(stored.updated_at);
      assert.equal(isNaN(parsedDate.getTime()), false, "updated_at should be valid ISO date");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("overwrites existing hash file on subsequent saves", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      configChangeHook.saveConfigHash("first_hash_value", ["keyA"]);
      configChangeHook.saveConfigHash("second_hash_value", ["keyA", "keyB"]);

      const stored = JSON.parse(fs.readFileSync(configChangeHook.getConfigHashPath(), "utf8"));
      assert.equal(stored.hash, "second_hash_value");
      assert.deepEqual(stored.snapshot_keys, ["keyA", "keyB"]);
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// loadStoredConfigHash
// =========================================================================

describe("A7-loadStoredConfigHash: missing file", () => {
  it("returns null when config-hash.json does not exist", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      // Do NOT create .claude/logs/config-hash.json

      const result = configChangeHook.loadStoredConfigHash();
      assert.equal(result, null, "Should return null for missing file");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

describe("A7-loadStoredConfigHash: invalid JSON", () => {
  it("returns null when config-hash.json contains invalid JSON", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const logsDir = path.join(tmpDir, ".claude", "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(
        path.join(logsDir, configChangeHook.CONFIG_HASH_FILENAME),
        "not-valid-json{{{",
        "utf8"
      );

      const result = configChangeHook.loadStoredConfigHash();
      assert.equal(result, null, "Should return null for invalid JSON");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

describe("A7-loadStoredConfigHash: correct data", () => {
  it("returns stored hash and snapshot_keys when file is valid", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const logsDir = path.join(tmpDir, ".claude", "logs");
      fs.mkdirSync(logsDir, { recursive: true });

      const stateData = {
        hash: "cafe0123babe4567",
        snapshot_keys: ["hooks", "permissions"],
        updated_at: "2026-03-10T12:00:00.000Z",
      };
      fs.writeFileSync(
        path.join(logsDir, configChangeHook.CONFIG_HASH_FILENAME),
        JSON.stringify(stateData),
        "utf8"
      );

      const result = configChangeHook.loadStoredConfigHash();
      assert.notEqual(result, null, "Should return stored data");
      assert.equal(result.hash, "cafe0123babe4567");
      assert.deepEqual(result.snapshot_keys, ["hooks", "permissions"]);
      assert.equal(result.updated_at, "2026-03-10T12:00:00.000Z");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("roundtrips through saveConfigHash and loadStoredConfigHash", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const expectedHash = "deadbeef" + "a1b2c3d4".repeat(7);
      const expectedKeys = ["alpha", "bravo", "charlie"];

      configChangeHook.saveConfigHash(expectedHash, expectedKeys);
      const loaded = configChangeHook.loadStoredConfigHash();

      assert.notEqual(loaded, null);
      assert.equal(loaded.hash, expectedHash);
      assert.deepEqual(loaded.snapshot_keys, expectedKeys);
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// detectKeyChanges (edge cases)
// =========================================================================

describe("A7-detectKeyChanges: edge cases", () => {
  it("handles null oldKeys gracefully (treats as empty)", () => {
    const result = configChangeHook.detectKeyChanges(null, ["hooks", "env"]);
    assert.deepEqual(result.added, ["hooks", "env"], "All new keys should be added");
    assert.deepEqual(result.removed, [], "No keys should be removed");
  });

  it("handles empty arrays (no changes)", () => {
    const result = configChangeHook.detectKeyChanges([], []);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
  });

  it("handles identical keys (no changes detected)", () => {
    const keys = ["hooks", "permissions", "env"];
    const result = configChangeHook.detectKeyChanges(keys, keys);
    assert.deepEqual(result.added, [], "No keys should be added");
    assert.deepEqual(result.removed, [], "No keys should be removed");
  });

  it("detects both added and removed in same call", () => {
    const oldKeys = ["hooks", "permissions"];
    const newKeys = ["hooks", "env", "debug"];
    const result = configChangeHook.detectKeyChanges(oldKeys, newKeys);
    assert.deepEqual(result.added, ["env", "debug"]);
    assert.deepEqual(result.removed, ["permissions"]);
  });
});

// =========================================================================
// getConfigHashPath / getSettingsPath: CLAUDE_PROJECT_DIR usage
// =========================================================================

describe("A7-getConfigHashPath: CLAUDE_PROJECT_DIR", () => {
  it("uses CLAUDE_PROJECT_DIR to build config hash path", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const result = configChangeHook.getConfigHashPath();
      const expected = path.join(tmpDir, ".claude", "logs", "config-hash.json");
      assert.equal(result, expected);
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

describe("A7-getSettingsPath: CLAUDE_PROJECT_DIR", () => {
  it("uses CLAUDE_PROJECT_DIR to build settings path", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const result = configChangeHook.getSettingsPath();
      const expected = path.join(tmpDir, ".claude", "settings.json");
      assert.equal(result, expected);
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// handler: no changes (same hash on second run)
// =========================================================================

describe("A7-handler: no changes on second run", () => {
  it("returns null when settings have not changed between runs", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const settingsObj = { hooks: { enabled: true }, permissions: { mode: "ask" } };
      createSettingsFile(tmpDir, settingsObj);
      // Ensure logs dir exists for hash state
      fs.mkdirSync(path.join(tmpDir, ".claude", "logs"), { recursive: true });

      // First run (baseline)
      const firstResult = configChangeHook.handler({});
      assert.equal(firstResult, null, "First run should return null (baseline)");

      // Second run with same settings (no changes)
      const secondResult = configChangeHook.handler({});
      assert.equal(secondResult, null, "Should return null when settings unchanged");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// handler: warning message includes added keys
// =========================================================================

describe("A7-handler: warning includes added keys", () => {
  it("includes new key names in the warning message", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const settingsPath = createSettingsFile(tmpDir, { hooks: {} });
      fs.mkdirSync(path.join(tmpDir, ".claude", "logs"), { recursive: true });

      // First run (baseline)
      configChangeHook.handler({});

      // Add new keys
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: {}, new_feature: true, debug_mode: false }),
        "utf8"
      );

      // Second run
      const result = configChangeHook.handler({});
      assert.notEqual(result, null, "Should detect config change");

      const ctx = result.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes("CONFIG CHANGE DETECTED"), "Should contain change heading");
      assert.ok(ctx.includes("New keys"), "Should mention new keys");
      assert.ok(ctx.includes("new_feature"), "Should list new_feature key");
      assert.ok(ctx.includes("debug_mode"), "Should list debug_mode key");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// handler: warning message includes removed keys
// =========================================================================

describe("A7-handler: warning includes removed keys", () => {
  it("includes removed key names in the warning message", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const settingsPath = createSettingsFile(tmpDir, {
        hooks: {},
        permissions: {},
        env: {},
      });
      fs.mkdirSync(path.join(tmpDir, ".claude", "logs"), { recursive: true });

      // First run (baseline)
      configChangeHook.handler({});

      // Remove keys
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: {} }),
        "utf8"
      );

      // Second run
      const result = configChangeHook.handler({});
      assert.notEqual(result, null, "Should detect config change");

      const ctx = result.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes("CONFIG CHANGE DETECTED"), "Should contain change heading");
      assert.ok(ctx.includes("Removed keys"), "Should mention removed keys");
      assert.ok(ctx.includes("permissions"), "Should list permissions key");
      assert.ok(ctx.includes("env"), "Should list env key");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// handler: evidence recording
// =========================================================================

describe("A7-handler: evidence recording", () => {
  it("writes evidence entry when config changes are detected", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const settingsPath = createSettingsFile(tmpDir, { hooks: {} });
      const logsDir = path.join(tmpDir, ".claude", "logs");
      fs.mkdirSync(logsDir, { recursive: true });

      // First run (baseline)
      configChangeHook.handler({});

      // Modify settings
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: {}, added_section: {} }),
        "utf8"
      );

      // Second run (should write evidence)
      const result = configChangeHook.handler({});
      assert.notEqual(result, null, "Should detect change");

      // Check evidence ledger
      const evidencePath = path.join(logsDir, "evidence-ledger.jsonl");
      assert.equal(fs.existsSync(evidencePath), true, "Evidence ledger should exist");

      const evidenceLines = fs.readFileSync(evidencePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      // Find the config_changed entry
      const configEntry = evidenceLines.find((e) => e.event === "config_changed");
      assert.notEqual(configEntry, undefined, "Should have config_changed evidence entry");
      assert.equal(typeof configEntry.settings_hash, "string", "Should have settings_hash");
      assert.equal(typeof configEntry.previous_hash, "string", "Should have previous_hash");
      assert.notEqual(
        configEntry.settings_hash,
        configEntry.previous_hash,
        "Hashes should differ"
      );
      assert.ok(configEntry.key_changes, "Should have key_changes");
      assert.ok(Array.isArray(configEntry.top_level_keys), "Should have top_level_keys");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("evidence entry includes correct key_changes details", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const settingsPath = createSettingsFile(tmpDir, {
        hooks: {},
        old_key: "will_be_removed",
      });
      const logsDir = path.join(tmpDir, ".claude", "logs");
      fs.mkdirSync(logsDir, { recursive: true });

      // First run (baseline)
      configChangeHook.handler({});

      // Modify: remove old_key, add fresh_key
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: {}, fresh_key: "newly_added" }),
        "utf8"
      );

      // Second run
      configChangeHook.handler({});

      // Parse evidence
      const evidencePath = path.join(logsDir, "evidence-ledger.jsonl");
      const evidenceLines = fs.readFileSync(evidencePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      const configEntry = evidenceLines.find((e) => e.event === "config_changed");
      assert.notEqual(configEntry, undefined);
      assert.ok(
        configEntry.key_changes.added.includes("fresh_key"),
        "key_changes.added should include fresh_key"
      );
      assert.ok(
        configEntry.key_changes.removed.includes("old_key"),
        "key_changes.removed should include old_key"
      );
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// CONFIG_HASH_FILENAME constant
// =========================================================================

describe("A7-CONFIG_HASH_FILENAME", () => {
  it("equals config-hash.json", () => {
    assert.equal(configChangeHook.CONFIG_HASH_FILENAME, "config-hash.json");
  });
});

// =========================================================================
// hashContent additional coverage
// =========================================================================

describe("A7-hashContent: additional", () => {
  it("produces different hashes for different content", () => {
    const h1 = configChangeHook.hashContent("content alpha");
    const h2 = configChangeHook.hashContent("content bravo");
    assert.notEqual(h1, h2, "Different content should produce different hashes");
  });

  it("matches manual SHA-256 computation", () => {
    const input = '{"hooks":{},"permissions":{}}';
    const expected = crypto.createHash("sha256").update(input, "utf8").digest("hex");
    const actual = configChangeHook.hashContent(input);
    assert.equal(actual, expected);
  });
});
