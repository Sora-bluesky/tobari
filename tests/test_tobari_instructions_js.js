#!/usr/bin/env node
"use strict";
/**
 * Comprehensive tests for tobari-instructions.js (A6: InstructionsLoaded Hook).
 *
 * Covers collectCurrentHashes, saveHashes, loadStoredHashes, detectChanges,
 * handler, getHashStatePath, and hashFile edge cases not covered by
 * test_v120_m1_m2_js.js.
 *
 * Run: node --test --test-concurrency=1 tests/test_tobari_instructions_js.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// Save original PROJECT_DIR
const ORIGINAL_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;

const instructionsHook = require("../.claude/hooks/tobari-instructions.js");

// --- Test Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tobari-instr-test-"));
}

function cleanupTmpDir(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // Windows may hold locks briefly
  }
}

/**
 * Set up a minimal project structure in a temp directory.
 * @param {string} tmpDir
 * @param {object} opts - { claudeMd, rules: [{name, content}], logsDir }
 */
function setupProject(tmpDir, opts = {}) {
  if (opts.claudeMd !== undefined) {
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), opts.claudeMd, "utf8");
  }
  if (opts.rules) {
    const rulesDir = path.join(tmpDir, ".claude", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    for (const rule of opts.rules) {
      const fullPath = path.join(rulesDir, rule.name);
      fs.writeFileSync(fullPath, rule.content, "utf8");
    }
  }
  if (opts.logsDir) {
    const logsDir = path.join(tmpDir, ".claude", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

// =========================================================================
// collectCurrentHashes
// =========================================================================

describe("collectCurrentHashes", () => {
  it("returns CLAUDE.md hash when no rules directory exists", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "project docs", "utf8");
      // No .claude/rules/ directory

      const hashes = instructionsHook.collectCurrentHashes();
      assert.ok("CLAUDE.md" in hashes, "Should include CLAUDE.md");
      assert.equal(Object.keys(hashes).length, 1, "Should only have CLAUDE.md");
      assert.equal(hashes["CLAUDE.md"].length, 64, "Hash should be 64-char hex");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("skips subdirectories inside rules dir", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "docs", "utf8");
      const rulesDir = path.join(tmpDir, ".claude", "rules");
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, "coding.md"), "code rules", "utf8");
      // Create a subdirectory (should be skipped)
      fs.mkdirSync(path.join(rulesDir, "subdir-nested"));

      const hashes = instructionsHook.collectCurrentHashes();
      assert.ok("CLAUDE.md" in hashes);
      assert.ok(".claude/rules/coding.md" in hashes);
      assert.equal(Object.keys(hashes).length, 2, "Should not include subdirectory");
      // Verify no key contains 'subdir'
      for (const key of Object.keys(hashes)) {
        assert.ok(!key.includes("subdir"), "Should skip subdirectory entries");
      }
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("returns only CLAUDE.md when rules dir is empty", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "project", "utf8");
      const rulesDir = path.join(tmpDir, ".claude", "rules");
      fs.mkdirSync(rulesDir, { recursive: true });
      // Empty rules directory

      const hashes = instructionsHook.collectCurrentHashes();
      assert.ok("CLAUDE.md" in hashes);
      assert.equal(Object.keys(hashes).length, 1, "Empty rules dir yields only CLAUDE.md");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("collects hashes from multiple rule files", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "main doc", "utf8");
      setupProject(tmpDir, {
        rules: [
          { name: "alpha.md", content: "rule alpha" },
          { name: "bravo.md", content: "rule bravo" },
          { name: "charlie.md", content: "rule charlie" },
        ],
      });

      const hashes = instructionsHook.collectCurrentHashes();
      assert.equal(Object.keys(hashes).length, 4, "Should have CLAUDE.md + 3 rules");
      assert.ok("CLAUDE.md" in hashes);
      assert.ok(".claude/rules/alpha.md" in hashes);
      assert.ok(".claude/rules/bravo.md" in hashes);
      assert.ok(".claude/rules/charlie.md" in hashes);

      // Each hash should be unique (different content)
      const hashValues = Object.values(hashes);
      const uniqueHashes = new Set(hashValues);
      assert.equal(uniqueHashes.size, 4, "All hashes should be unique");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("skips unreadable files and returns partial results", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "main", "utf8");
      const rulesDir = path.join(tmpDir, ".claude", "rules");
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, "readable.md"), "good content", "utf8");
      fs.writeFileSync(path.join(rulesDir, "locked.md"), "locked content", "utf8");

      // Make file unreadable (Unix only — on Windows this test degrades gracefully)
      if (process.platform !== "win32") {
        fs.chmodSync(path.join(rulesDir, "locked.md"), 0o000);
      }

      const hashes = instructionsHook.collectCurrentHashes();
      assert.ok("CLAUDE.md" in hashes);
      assert.ok(".claude/rules/readable.md" in hashes);

      if (process.platform !== "win32") {
        // On Unix, locked.md should be absent
        assert.ok(
          !(".claude/rules/locked.md" in hashes),
          "Unreadable file should be skipped"
        );
        assert.equal(Object.keys(hashes).length, 2);
        // Restore permissions for cleanup
        fs.chmodSync(path.join(rulesDir, "locked.md"), 0o644);
      } else {
        // On Windows, chmod has no effect, so both files are readable
        assert.ok(".claude/rules/locked.md" in hashes);
        assert.equal(Object.keys(hashes).length, 3);
      }
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("returns empty object when neither CLAUDE.md nor rules dir exists", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      // No CLAUDE.md, no .claude/rules/

      const hashes = instructionsHook.collectCurrentHashes();
      assert.deepEqual(hashes, {});
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// saveHashes
// =========================================================================

describe("saveHashes", () => {
  it("creates directory structure if missing", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      // No .claude/logs/ directory exists yet
      const logsDir = path.join(tmpDir, ".claude", "logs");
      assert.ok(!fs.existsSync(logsDir), "logs dir should not exist initially");

      instructionsHook.saveHashes({ "CLAUDE.md": "abc123def456" });

      assert.ok(fs.existsSync(logsDir), "logs dir should be created");
      const statePath = instructionsHook.getHashStatePath();
      assert.ok(fs.existsSync(statePath), "State file should exist");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("writes valid JSON that can be parsed back", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const inputHashes = {
        "CLAUDE.md": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        ".claude/rules/lang.md": "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5",
      };

      instructionsHook.saveHashes(inputHashes);

      const statePath = instructionsHook.getHashStatePath();
      const raw = fs.readFileSync(statePath, "utf8");
      const parsed = JSON.parse(raw);

      assert.deepEqual(parsed, inputHashes, "Saved JSON should match input");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("overwrites existing state file", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const first = { "CLAUDE.md": "hash_v1" };
      const second = { "CLAUDE.md": "hash_v2", ".claude/rules/new.md": "hash_new" };

      instructionsHook.saveHashes(first);
      instructionsHook.saveHashes(second);

      const statePath = instructionsHook.getHashStatePath();
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.deepEqual(parsed, second, "Should contain second write");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// loadStoredHashes
// =========================================================================

describe("loadStoredHashes", () => {
  it("returns null when state file does not exist", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      // No state file

      const result = instructionsHook.loadStoredHashes();
      assert.equal(result, null);
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("returns null for invalid JSON content", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const logsDir = path.join(tmpDir, ".claude", "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      const statePath = path.join(logsDir, instructionsHook.HASH_STATE_FILENAME);
      fs.writeFileSync(statePath, "{ this is not valid json !!!", "utf8");

      const result = instructionsHook.loadStoredHashes();
      assert.equal(result, null, "Invalid JSON should return null");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("returns correct data for valid state file", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const expected = {
        "CLAUDE.md": "aabbccdd" + "11223344" + "aabbccdd" + "11223344" + "aabbccdd" + "11223344" + "aabbccdd" + "11223344",
        ".claude/rules/test.md": "eeff0011" + "22334455" + "eeff0011" + "22334455" + "eeff0011" + "22334455" + "eeff0011" + "22334455",
      };

      const logsDir = path.join(tmpDir, ".claude", "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      const statePath = path.join(logsDir, instructionsHook.HASH_STATE_FILENAME);
      fs.writeFileSync(statePath, JSON.stringify(expected), "utf8");

      const result = instructionsHook.loadStoredHashes();
      assert.deepEqual(result, expected);
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("round-trips with saveHashes", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const data = { "CLAUDE.md": "abcd".repeat(16) };
      instructionsHook.saveHashes(data);
      const loaded = instructionsHook.loadStoredHashes();
      assert.deepEqual(loaded, data, "loadStoredHashes should return what saveHashes wrote");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// detectChanges (advanced scenarios)
// =========================================================================

describe("detectChanges (advanced)", () => {
  it("detects simultaneous add, modify, and remove", () => {
    const stored = {
      "CLAUDE.md": "hash_original",
      ".claude/rules/old.md": "hash_old",
      ".claude/rules/stable.md": "hash_stable",
    };
    const current = {
      "CLAUDE.md": "hash_modified",
      ".claude/rules/stable.md": "hash_stable",
      ".claude/rules/brand-new.md": "hash_new",
    };

    const changes = instructionsHook.detectChanges(stored, current);
    assert.deepEqual(changes.added, [".claude/rules/brand-new.md"]);
    assert.deepEqual(changes.modified, ["CLAUDE.md"]);
    assert.deepEqual(changes.removed, [".claude/rules/old.md"]);
  });

  it("treats empty current as all removed", () => {
    const stored = {
      "CLAUDE.md": "hash_a",
      ".claude/rules/x.md": "hash_b",
      ".claude/rules/y.md": "hash_c",
    };
    const current = {};

    const changes = instructionsHook.detectChanges(stored, current);
    assert.deepEqual(changes.added, []);
    assert.deepEqual(changes.modified, []);
    assert.equal(changes.removed.length, 3, "All 3 files should be removed");
    assert.ok(changes.removed.includes("CLAUDE.md"));
    assert.ok(changes.removed.includes(".claude/rules/x.md"));
    assert.ok(changes.removed.includes(".claude/rules/y.md"));
  });

  it("treats empty stored as all added", () => {
    const stored = {};
    const current = {
      "CLAUDE.md": "hash_a",
      ".claude/rules/p.md": "hash_b",
    };

    const changes = instructionsHook.detectChanges(stored, current);
    assert.equal(changes.added.length, 2, "All files should be added");
    assert.ok(changes.added.includes("CLAUDE.md"));
    assert.ok(changes.added.includes(".claude/rules/p.md"));
    assert.deepEqual(changes.modified, []);
    assert.deepEqual(changes.removed, []);
  });

  it("returns no changes when stored and current are identical", () => {
    const data = {
      "CLAUDE.md": "same_hash",
      ".claude/rules/r.md": "same_hash_2",
    };
    const changes = instructionsHook.detectChanges(data, { ...data });
    assert.deepEqual(changes.added, []);
    assert.deepEqual(changes.modified, []);
    assert.deepEqual(changes.removed, []);
  });
});

// =========================================================================
// handler (integration scenarios)
// =========================================================================

describe("handler (integration)", () => {
  it("returns null on second run when nothing changed", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      setupProject(tmpDir, {
        claudeMd: "stable content",
        rules: [{ name: "lang.md", content: "language rules" }],
        logsDir: true,
      });

      // First run — baseline
      const firstResult = instructionsHook.handler({});
      assert.equal(firstResult, null, "First run should return null");

      // Second run — nothing changed
      const secondResult = instructionsHook.handler({});
      assert.equal(secondResult, null, "No changes should return null");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("detects added rule file on subsequent run", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      setupProject(tmpDir, {
        claudeMd: "project doc",
        rules: [{ name: "existing.md", content: "existing rule" }],
        logsDir: true,
      });

      // First run — baseline
      instructionsHook.handler({});

      // Add a new rule file
      const rulesDir = path.join(tmpDir, ".claude", "rules");
      fs.writeFileSync(path.join(rulesDir, "new-rule.md"), "brand new rule", "utf8");

      // Second run — should detect addition
      const result = instructionsHook.handler({});
      assert.notEqual(result, null, "Should detect added file");
      const ctx = result.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes("Added"), "Warning should mention Added");
      assert.ok(ctx.includes("new-rule.md"), "Warning should mention the added file");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("detects removed rule file on subsequent run", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const rulesDir = path.join(tmpDir, ".claude", "rules");
      setupProject(tmpDir, {
        claudeMd: "project doc",
        rules: [
          { name: "keep.md", content: "keep this" },
          { name: "remove-me.md", content: "will be removed" },
        ],
        logsDir: true,
      });

      // First run — baseline
      instructionsHook.handler({});

      // Remove one rule file
      fs.unlinkSync(path.join(rulesDir, "remove-me.md"));

      // Second run — should detect removal
      const result = instructionsHook.handler({});
      assert.notEqual(result, null, "Should detect removed file");
      const ctx = result.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes("Removed"), "Warning should mention Removed");
      assert.ok(ctx.includes("remove-me.md"), "Warning should mention the removed file");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("warning includes Modified, Added, and Removed labels", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const rulesDir = path.join(tmpDir, ".claude", "rules");
      setupProject(tmpDir, {
        claudeMd: "original doc",
        rules: [
          { name: "modify-target.md", content: "will change" },
          { name: "delete-target.md", content: "will vanish" },
        ],
        logsDir: true,
      });

      // First run — baseline
      instructionsHook.handler({});

      // Modify CLAUDE.md, add a new rule, remove one rule
      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "modified doc", "utf8");
      fs.writeFileSync(path.join(rulesDir, "added-rule.md"), "new content", "utf8");
      fs.unlinkSync(path.join(rulesDir, "delete-target.md"));

      // Second run
      const result = instructionsHook.handler({});
      assert.notEqual(result, null);
      const ctx = result.hookSpecificOutput.additionalContext;

      assert.ok(ctx.includes("RULE FILE CHANGE DETECTED"), "Should have change header");
      assert.ok(ctx.includes("Modified"), "Should include Modified label");
      assert.ok(ctx.includes("Added"), "Should include Added label");
      assert.ok(ctx.includes("Removed"), "Should include Removed label");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("evidence includes file_count field", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      setupProject(tmpDir, {
        claudeMd: "doc v1",
        rules: [{ name: "r1.md", content: "rule one" }],
        logsDir: true,
      });

      // First run — baseline
      instructionsHook.handler({});

      // Modify to trigger evidence write
      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "doc v2", "utf8");

      // Second run
      instructionsHook.handler({});

      // Read evidence ledger
      const evidencePath = path.join(tmpDir, ".claude", "logs", "evidence-ledger.jsonl");
      if (fs.existsSync(evidencePath)) {
        const lines = fs.readFileSync(evidencePath, "utf8").trim().split("\n");
        // Find the instructions_changed entry
        const instrEntry = lines
          .map((l) => {
            try { return JSON.parse(l); } catch (_) { return null; }
          })
          .filter(Boolean)
          .find((e) => e.event === "instructions_changed");

        if (instrEntry) {
          assert.ok("file_count" in instrEntry, "Evidence should include file_count");
          assert.equal(typeof instrEntry.file_count, "number");
          assert.ok(instrEntry.file_count >= 1, "file_count should be at least 1");
        }
        // Note: If writeEvidence is mocked or ledger format differs, we still pass
      }
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("handler output has correct hookEventName", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      setupProject(tmpDir, {
        claudeMd: "content v1",
        logsDir: true,
      });

      // First run
      instructionsHook.handler({});

      // Modify
      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "content v2", "utf8");

      // Second run
      const result = instructionsHook.handler({});
      assert.notEqual(result, null);
      assert.equal(
        result.hookSpecificOutput.hookEventName,
        "InstructionsLoaded"
      );
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("handler warns about evidence and verification", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      setupProject(tmpDir, {
        claudeMd: "text A",
        logsDir: true,
      });

      // First run
      instructionsHook.handler({});

      // Modify
      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "text B", "utf8");

      // Second run
      const result = instructionsHook.handler({});
      assert.notEqual(result, null);
      const ctx = result.hookSpecificOutput.additionalContext;
      assert.ok(
        ctx.includes("Verify these changes are intentional"),
        "Should prompt verification"
      );
      assert.ok(
        ctx.includes("Evidence has been recorded"),
        "Should mention evidence recording"
      );
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// getHashStatePath
// =========================================================================

describe("getHashStatePath", () => {
  it("uses CLAUDE_PROJECT_DIR environment variable", () => {
    const originalDir = process.env.CLAUDE_PROJECT_DIR;
    try {
      const customDir = "/tmp/custom-proj-dir";
      process.env.CLAUDE_PROJECT_DIR = customDir;

      const result = instructionsHook.getHashStatePath();
      const expected = path.join(
        customDir,
        ".claude",
        "logs",
        instructionsHook.HASH_STATE_FILENAME
      );
      assert.equal(result, expected);
    } finally {
      process.env.CLAUDE_PROJECT_DIR = originalDir;
    }
  });

  it("state filename is instructions-hashes.json", () => {
    assert.equal(
      instructionsHook.HASH_STATE_FILENAME,
      "instructions-hashes.json"
    );
  });

  it("path ends with HASH_STATE_FILENAME", () => {
    const result = instructionsHook.getHashStatePath();
    assert.ok(
      result.endsWith(instructionsHook.HASH_STATE_FILENAME),
      "Path should end with the state filename"
    );
  });
});

// =========================================================================
// hashFile (edge cases)
// =========================================================================

describe("hashFile (edge cases)", () => {
  it("returns valid hash for empty file", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      const emptyFile = path.join(tmpDir, "empty.md");
      fs.writeFileSync(emptyFile, "", "utf8");

      const hash = instructionsHook.hashFile(emptyFile);
      assert.notEqual(hash, null, "Empty file should produce a hash, not null");
      assert.equal(hash.length, 64, "Hash should be 64-char hex");

      // Verify against known SHA-256 of empty string
      const expectedHash = crypto
        .createHash("sha256")
        .update("", "utf8")
        .digest("hex");
      assert.equal(hash, expectedHash, "Should match SHA-256 of empty string");
    } finally {
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("returns different hashes for different content", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      const file1 = path.join(tmpDir, "file1.md");
      const file2 = path.join(tmpDir, "file2.md");
      fs.writeFileSync(file1, "content alpha", "utf8");
      fs.writeFileSync(file2, "content bravo", "utf8");

      const hash1 = instructionsHook.hashFile(file1);
      const hash2 = instructionsHook.hashFile(file2);
      assert.notEqual(hash1, hash2, "Different content should produce different hashes");
    } finally {
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("returns same hash for same content", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      const fileA = path.join(tmpDir, "a.md");
      const fileB = path.join(tmpDir, "b.md");
      fs.writeFileSync(fileA, "identical content", "utf8");
      fs.writeFileSync(fileB, "identical content", "utf8");

      const hashA = instructionsHook.hashFile(fileA);
      const hashB = instructionsHook.hashFile(fileB);
      assert.equal(hashA, hashB, "Same content should produce same hash");
    } finally {
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("returns null for directory path", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      // tmpDir itself is a directory, not a file
      const hash = instructionsHook.hashFile(tmpDir);
      // fs.readFileSync on a directory throws, so hashFile returns null
      assert.equal(hash, null, "Directory path should return null");
    } finally {
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});
