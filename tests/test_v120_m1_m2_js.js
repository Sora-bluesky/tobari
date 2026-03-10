#!/usr/bin/env node
"use strict";
/**
 * Tests for v1.2.0 M1 Security Hardening + M2 New Hook Events.
 *
 * Covers:
 *   A1: Protected Directory Deny (checkProtectedDirectory)
 *   A3: World-Writable Audit (checkWorldWritable)
 *   A5: Evidence Rotation at 10MB
 *   A6: InstructionsLoaded Hook (hash change detection)
 *   A7: ConfigChange Hook (settings.json monitoring)
 *   A9: Stop Hook output audit (_getLastAssistantMessage)
 *
 * Run: node --test tests/test_v120_m1_m2_js.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// Set CLAUDE_PROJECT_DIR before requiring modules
const PROJECT_DIR = path.resolve(__dirname, "..");
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;

const gate = require("../.claude/hooks/tobari-gate.js");
const tobariSession = require("../.claude/hooks/tobari-session.js");
const sessionStart = require("../.claude/hooks/tobari-session-start.js");
const stopHook = require("../.claude/hooks/tobari-stop.js");
const instructionsHook = require("../.claude/hooks/tobari-instructions.js");
const configChangeHook = require("../.claude/hooks/tobari-config-change.js");

// --- Test Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tobari-v120-test-"));
}

function cleanupTmpDir(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // Windows may hold locks briefly
  }
}

function createSessionFile(tmpDir, session) {
  const claudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const sessionPath = path.join(claudeDir, "tobari-session.json");
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), "utf8");
  return sessionPath;
}

function makeActiveSession(scope) {
  return {
    active: true,
    task: "test-task",
    profile: "standard",
    gates_passed: ["STG0"],
    retry_count: 0,
    token_usage: { input: 0, output: 0, budget: 500000 },
    contract: {
      intent: "test",
      scope: scope || {
        include: ["src/", "tests/"],
        exclude: ["docs/"],
      },
    },
  };
}

// =========================================================================
// A1: Protected Directory Deny
// =========================================================================

describe("A1: Protected Directory Deny", () => {
  it("exports PROTECTED_DIRECTORIES and PROTECTED_DIRECTORY_EXCEPTIONS", () => {
    assert.ok(Array.isArray(gate.PROTECTED_DIRECTORIES));
    assert.ok(Array.isArray(gate.PROTECTED_DIRECTORY_EXCEPTIONS));
    assert.ok(gate.PROTECTED_DIRECTORIES.length >= 4);
    assert.ok(gate.PROTECTED_DIRECTORY_EXCEPTIONS.length >= 2);
  });

  it("exports checkProtectedDirectory function", () => {
    assert.equal(typeof gate.checkProtectedDirectory, "function");
  });

  it("denies write to .git/ when not in scope", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      createSessionFile(tmpDir, makeActiveSession({ include: ["src/"], exclude: [] }));
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      tobariSession._resetCache();

      const result = gate.checkProtectedDirectory(
        path.join(tmpDir, ".git", "config"),
        "Edit"
      );
      assert.notEqual(result, null, "Should deny .git/ writes");
      assert.equal(
        result.hookSpecificOutput.permissionDecision,
        "deny"
      );
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      tobariSession._resetCache();
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("denies write to .claude/hooks/ when not in scope", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      createSessionFile(tmpDir, makeActiveSession({ include: ["src/"], exclude: [] }));
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      tobariSession._resetCache();

      const result = gate.checkProtectedDirectory(
        path.join(tmpDir, ".claude", "hooks", "malicious.js"),
        "Write"
      );
      assert.notEqual(result, null, "Should deny .claude/hooks/ writes");
      assert.equal(
        result.hookSpecificOutput.permissionDecision,
        "deny"
      );
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      tobariSession._resetCache();
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("denies write to .claude/rules/ when not in scope", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      createSessionFile(tmpDir, makeActiveSession({ include: ["src/"], exclude: [] }));
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      tobariSession._resetCache();

      const result = gate.checkProtectedDirectory(
        path.join(tmpDir, ".claude", "rules", "new-rule.md"),
        "Write"
      );
      assert.notEqual(result, null, "Should deny .claude/rules/ writes");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      tobariSession._resetCache();
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("allows .claude/tobari-session.json (exception)", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      createSessionFile(tmpDir, makeActiveSession({ include: ["src/"], exclude: [] }));
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      tobariSession._resetCache();

      const result = gate.checkProtectedDirectory(
        path.join(tmpDir, ".claude", "tobari-session.json"),
        "Edit"
      );
      assert.equal(result, null, "tobari-session.json should be allowed");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      tobariSession._resetCache();
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("allows .claude/logs/ (exception)", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      createSessionFile(tmpDir, makeActiveSession({ include: ["src/"], exclude: [] }));
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      tobariSession._resetCache();

      const result = gate.checkProtectedDirectory(
        path.join(tmpDir, ".claude", "logs", "evidence-ledger.jsonl"),
        "Write"
      );
      assert.equal(result, null, ".claude/logs/ should be allowed");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      tobariSession._resetCache();
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("allows protected directory when explicitly in scope", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      // Scope explicitly includes .claude/hooks/
      createSessionFile(
        tmpDir,
        makeActiveSession({ include: [".claude/hooks/"], exclude: [] })
      );
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      tobariSession._resetCache();

      const result = gate.checkProtectedDirectory(
        path.join(tmpDir, ".claude", "hooks", "tobari-gate.js"),
        "Edit"
      );
      assert.equal(result, null, "Should allow when explicitly in scope");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      tobariSession._resetCache();
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("allows unprotected paths", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      createSessionFile(tmpDir, makeActiveSession({ include: ["src/"], exclude: [] }));
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      tobariSession._resetCache();

      const result = gate.checkProtectedDirectory(
        path.join(tmpDir, "src", "app.js"),
        "Edit"
      );
      assert.equal(result, null, "Unprotected paths should pass");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      tobariSession._resetCache();
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// A3: World-Writable Audit
// =========================================================================

describe("A3: World-Writable Audit", () => {
  it("exports checkWorldWritable function", () => {
    assert.equal(typeof sessionStart.checkWorldWritable, "function");
  });

  it("returns empty array on Windows", () => {
    // On Windows, always returns empty (ACLs are different)
    if (process.platform === "win32") {
      const result = sessionStart.checkWorldWritable();
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 0);
    } else {
      // On Unix, it checks actual permissions
      const result = sessionStart.checkWorldWritable();
      assert.ok(Array.isArray(result));
    }
  });

  it("handler includes world-writable warning when detected (Unix only)", () => {
    // This test verifies the integration path exists
    // On Windows we just check handler returns valid output
    const output = sessionStart.handler({});
    assert.ok(output !== undefined);
    if (output) {
      assert.ok(output.hookSpecificOutput);
      assert.ok(typeof output.hookSpecificOutput.additionalContext === "string");
    }
  });
});

// =========================================================================
// A5: Evidence Rotation
// =========================================================================

describe("A5: Evidence Rotation", () => {
  it("exports EVIDENCE_MAX_SIZE constant", () => {
    assert.equal(tobariSession.EVIDENCE_MAX_SIZE, 10 * 1024 * 1024);
  });

  it("rotates evidence file when exceeding size limit", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      tobariSession._resetCache();

      // Create logs directory and a large evidence file
      const logsDir = path.join(tmpDir, ".claude", "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      const evidencePath = path.join(logsDir, "evidence-ledger.jsonl");

      // Create a file just over 10MB with repeated dummy data
      const line = JSON.stringify({ event: "test", _chain_index: 0, _prev_hash: "0".repeat(64) }) + "\n";
      const linesNeeded = Math.ceil((10 * 1024 * 1024 + 1) / line.length);
      const fd = fs.openSync(evidencePath, "w");
      for (let i = 0; i < linesNeeded; i++) {
        fs.writeSync(fd, line);
      }
      fs.closeSync(fd);

      const sizeBefore = fs.statSync(evidencePath).size;
      assert.ok(sizeBefore >= 10 * 1024 * 1024, "File should be >= 10MB");

      // Write a new evidence entry — should trigger rotation
      tobariSession.writeEvidence({ event: "rotation_test" });

      // Check that the original file was rotated
      const filesAfter = fs.readdirSync(logsDir).filter(f => f.startsWith("evidence-ledger."));
      assert.ok(
        filesAfter.length >= 2,
        `Expected at least 2 evidence files after rotation, got ${filesAfter.length}: ${filesAfter.join(", ")}`
      );

      // New evidence-ledger.jsonl should be small (just the new entry)
      const newSize = fs.statSync(evidencePath).size;
      assert.ok(
        newSize < 10 * 1024 * 1024,
        `New evidence file should be < 10MB, got ${newSize}`
      );
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      tobariSession._resetCache();
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("does not rotate when file is under size limit", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      tobariSession._resetCache();

      const logsDir = path.join(tmpDir, ".claude", "logs");
      fs.mkdirSync(logsDir, { recursive: true });

      // Write a few entries (well under 10MB)
      tobariSession.writeEvidence({ event: "small_test_1" });
      tobariSession.writeEvidence({ event: "small_test_2" });

      const filesAfter = fs.readdirSync(logsDir).filter(f => f.startsWith("evidence-ledger."));
      assert.equal(filesAfter.length, 1, "Should only have 1 evidence file");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      tobariSession._resetCache();
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// A6: InstructionsLoaded Hook
// =========================================================================

describe("A6: InstructionsLoaded Hook", () => {
  it("exports expected functions", () => {
    assert.equal(typeof instructionsHook.hashFile, "function");
    assert.equal(typeof instructionsHook.collectCurrentHashes, "function");
    assert.equal(typeof instructionsHook.detectChanges, "function");
    assert.equal(typeof instructionsHook.handler, "function");
  });

  it("hashFile returns SHA-256 hex string", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      const testFile = path.join(tmpDir, "test.md");
      fs.writeFileSync(testFile, "hello world", "utf8");

      const hash = instructionsHook.hashFile(testFile);
      assert.equal(typeof hash, "string");
      assert.equal(hash.length, 64); // SHA-256 hex
      assert.equal(
        hash,
        crypto.createHash("sha256").update("hello world", "utf8").digest("hex")
      );
    } finally {
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("hashFile returns null for missing file", () => {
    const hash = instructionsHook.hashFile("/nonexistent/file.md");
    assert.equal(hash, null);
  });

  it("detectChanges identifies added files", () => {
    const stored = { "CLAUDE.md": "abc123" };
    const current = { "CLAUDE.md": "abc123", ".claude/rules/new.md": "def456" };
    const changes = instructionsHook.detectChanges(stored, current);
    assert.deepEqual(changes.added, [".claude/rules/new.md"]);
    assert.deepEqual(changes.modified, []);
    assert.deepEqual(changes.removed, []);
  });

  it("detectChanges identifies modified files", () => {
    const stored = { "CLAUDE.md": "abc123" };
    const current = { "CLAUDE.md": "xyz789" };
    const changes = instructionsHook.detectChanges(stored, current);
    assert.deepEqual(changes.added, []);
    assert.deepEqual(changes.modified, ["CLAUDE.md"]);
    assert.deepEqual(changes.removed, []);
  });

  it("detectChanges identifies removed files", () => {
    const stored = { "CLAUDE.md": "abc123", ".claude/rules/old.md": "def456" };
    const current = { "CLAUDE.md": "abc123" };
    const changes = instructionsHook.detectChanges(stored, current);
    assert.deepEqual(changes.added, []);
    assert.deepEqual(changes.modified, []);
    assert.deepEqual(changes.removed, [".claude/rules/old.md"]);
  });

  it("detectChanges treats null stored as all-added (first run)", () => {
    const current = { "CLAUDE.md": "abc", ".claude/rules/a.md": "def" };
    const changes = instructionsHook.detectChanges(null, current);
    assert.equal(changes.added.length, 2);
    assert.deepEqual(changes.modified, []);
    assert.deepEqual(changes.removed, []);
  });

  it("handler returns null on first run (baseline)", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      // Create CLAUDE.md and rules
      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "test", "utf8");
      const rulesDir = path.join(tmpDir, ".claude", "rules");
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, "test.md"), "rule", "utf8");

      // First run — saves baseline, returns null
      const result = instructionsHook.handler({});
      assert.equal(result, null);

      // Verify hash state was saved
      const statePath = instructionsHook.getHashStatePath();
      assert.ok(fs.existsSync(statePath));
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("handler detects changes on second run", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "original", "utf8");
      const logsDir = path.join(tmpDir, ".claude", "logs");
      fs.mkdirSync(logsDir, { recursive: true });

      // First run (baseline)
      instructionsHook.handler({});

      // Modify CLAUDE.md
      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "modified!", "utf8");

      // Second run — should detect change
      const result = instructionsHook.handler({});
      assert.notEqual(result, null);
      assert.ok(
        result.hookSpecificOutput.additionalContext.includes("RULE FILE CHANGE"),
        "Should warn about rule file change"
      );
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// A7: ConfigChange Hook
// =========================================================================

describe("A7: ConfigChange Hook", () => {
  it("exports expected functions", () => {
    assert.equal(typeof configChangeHook.readSettings, "function");
    assert.equal(typeof configChangeHook.hashContent, "function");
    assert.equal(typeof configChangeHook.detectKeyChanges, "function");
    assert.equal(typeof configChangeHook.handler, "function");
  });

  it("hashContent returns consistent SHA-256", () => {
    const h1 = configChangeHook.hashContent("test content");
    const h2 = configChangeHook.hashContent("test content");
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });

  it("detectKeyChanges identifies added and removed keys", () => {
    const oldKeys = ["hooks", "permissions"];
    const newKeys = ["hooks", "permissions", "env"];
    const changes = configChangeHook.detectKeyChanges(oldKeys, newKeys);
    assert.deepEqual(changes.added, ["env"]);
    assert.deepEqual(changes.removed, []);
  });

  it("detectKeyChanges handles removed keys", () => {
    const oldKeys = ["hooks", "permissions", "env"];
    const newKeys = ["hooks"];
    const changes = configChangeHook.detectKeyChanges(oldKeys, newKeys);
    assert.deepEqual(changes.added, []);
    assert.deepEqual(changes.removed, ["permissions", "env"]);
  });

  it("handler returns null when settings.json does not exist", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;
      const result = configChangeHook.handler({});
      assert.equal(result, null);
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("handler returns null on first run (baseline)", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const settingsDir = path.join(tmpDir, ".claude");
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, "settings.json"),
        JSON.stringify({ hooks: {}, permissions: {} }),
        "utf8"
      );

      const result = configChangeHook.handler({});
      assert.equal(result, null);
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });

  it("handler detects config change on second run", () => {
    let tmpDir;
    try {
      tmpDir = createTmpDir();
      process.env.CLAUDE_PROJECT_DIR = tmpDir;

      const settingsDir = path.join(tmpDir, ".claude");
      const logsDir = path.join(tmpDir, ".claude", "logs");
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });

      const settingsPath = path.join(settingsDir, "settings.json");
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: {}, permissions: {} }),
        "utf8"
      );

      // First run (baseline)
      configChangeHook.handler({});

      // Modify settings
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: {}, permissions: {}, env: {} }),
        "utf8"
      );

      // Second run — should detect change
      const result = configChangeHook.handler({});
      assert.notEqual(result, null);
      assert.ok(
        result.hookSpecificOutput.additionalContext.includes("CONFIG CHANGE"),
        "Should warn about config change"
      );
    } finally {
      process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  });
});

// =========================================================================
// A9: Stop Hook Output Audit
// =========================================================================

describe("A9: Stop Hook output audit", () => {
  it("exports _getLastAssistantMessage function", () => {
    assert.equal(typeof stopHook._getLastAssistantMessage, "function");
  });

  it("returns null for empty transcript", () => {
    assert.equal(stopHook._getLastAssistantMessage([]), null);
    assert.equal(stopHook._getLastAssistantMessage(null), null);
    assert.equal(stopHook._getLastAssistantMessage(undefined), null);
  });

  it("extracts last assistant message from transcript", () => {
    const transcript = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "I will help you" },
      { role: "user", content: "Do something" },
      { role: "assistant", content: "Done! Here is the result." },
    ];
    const result = stopHook._getLastAssistantMessage(transcript);
    assert.equal(result, "Done! Here is the result.");
  });

  it("skips non-assistant and empty messages", () => {
    const transcript = [
      { role: "assistant", content: "First response" },
      { role: "user", content: "Next" },
      { role: "assistant", content: "" },
      { role: "system", content: "System message" },
    ];
    const result = stopHook._getLastAssistantMessage(transcript);
    assert.equal(result, "First response");
  });

  it("handles array content format", () => {
    const transcript = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
    ];
    const result = stopHook._getLastAssistantMessage(transcript);
    assert.ok(result.includes("Part 1"));
    assert.ok(result.includes("Part 2"));
  });
});
