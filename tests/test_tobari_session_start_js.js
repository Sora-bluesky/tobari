#!/usr/bin/env node
"use strict";
/**
 * Tests for TASK-089: tobari-session-start.js (SessionStart Hook).
 *
 * Groups:
 *   E1:  Module exports
 *   H1-H3:  handler output structure
 *   I1-I2:  Inactive session behavior
 *   A1-A2:  Active session behavior
 *   R1-R2:  Raised veil (previously active) behavior
 *   EV1-EV3: Evidence ledger recording (session_start event)
 *
 * Run: node --test tests/test_tobari_session_start_js.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const sessionStartMod = require("../.claude/hooks/tobari-session-start.js");
const sessionMod = require("../.claude/hooks/tobari-session.js");

// --- Test Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tobari-ss-test-"));
}

function cleanupTmpDir(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // Windows may hold locks briefly
  }
}

function createSessionFile(tmpDir, data) {
  const claudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const sessionPath = path.join(claudeDir, "tobari-session.json");
  fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return sessionPath;
}

function createActiveSession(tmpDir) {
  return createSessionFile(tmpDir, {
    active: true,
    task: "TASK-TEST",
    profile: "standard",
    gates_passed: ["STG0"],
    retry_count: 0,
    token_usage: { input: 100, output: 50, budget: 500000 },
    contract: {
      intent: "test",
      scope: {
        include: [".claude/hooks/", "tests/"],
        exclude: ["tasks/", "docs/"],
      },
    },
  });
}

function createRaisedSession(tmpDir) {
  return createSessionFile(tmpDir, {
    active: false,
    task: "TASK-RAISED",
    profile: "standard",
    gates_passed: ["STG0", "STG1"],
    raised_at: "2026-03-06T12:00:00+09:00",
    raised_reason: "task complete",
  });
}

// ============================================================
// E1: Module exports
// ============================================================

describe("module exports", () => {
  it("E1: handler is exported as a function", () => {
    assert.equal(typeof sessionStartMod.handler, "function");
  });
});

// ============================================================
// H1-H3: handler output structure
// ============================================================

describe("handler output structure", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    sessionMod._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    sessionMod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("H1: handler returns object with hookSpecificOutput", () => {
    const result = sessionStartMod.handler({});
    assert.ok(result, "handler should return a truthy value");
    assert.ok(result.hookSpecificOutput, "should have hookSpecificOutput");
    assert.equal(
      typeof result.hookSpecificOutput.additionalContext,
      "string",
      "additionalContext should be a string"
    );
  });

  it("H2: additionalContext contains project references", () => {
    const result = sessionStartMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("CLAUDE.md"), "should reference CLAUDE.md");
    assert.ok(
      ctx.includes("DESIGN.md"),
      "should reference DESIGN.md"
    );
    assert.ok(
      ctx.includes(".claude/rules/"),
      "should reference .claude/rules/"
    );
    assert.ok(
      ctx.includes("tasks/backlog.yaml"),
      "should reference tasks/backlog.yaml"
    );
  });

  it("H3: handler can be called with empty data without throwing", () => {
    assert.doesNotThrow(() => {
      sessionStartMod.handler({});
    });
  });
});

// ============================================================
// I1-I2: Inactive session behavior
// ============================================================

describe("inactive session behavior", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    sessionMod._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    sessionMod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("I1: when no session active, contains inactive message", () => {
    const result = sessionStartMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes("No active tobari session"),
      "should contain inactive session message"
    );
  });

  it("I2: when no session active, does not contain VEIL ACTIVE", () => {
    const result = sessionStartMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(
      !ctx.includes("TOBARI VEIL ACTIVE"),
      "should NOT contain veil active message when no session"
    );
  });
});

// ============================================================
// A1-A2: Active session behavior
// ============================================================

describe("active session behavior", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    sessionMod._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    sessionMod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("A1: when session active, contains veil active message with task info", () => {
    createActiveSession(tmpDir);
    const result = sessionStartMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes("TOBARI VEIL ACTIVE"),
      "should contain TOBARI VEIL ACTIVE"
    );
    assert.ok(
      ctx.includes("TASK-TEST"),
      "should contain task name"
    );
    assert.ok(
      ctx.includes("standard"),
      "should contain profile"
    );
  });

  it("A2: when session active, does not contain inactive message", () => {
    createActiveSession(tmpDir);
    const result = sessionStartMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(
      !ctx.includes("No active tobari session"),
      "should NOT contain inactive message when session is active"
    );
  });
});

// ============================================================
// R1-R2: Raised veil behavior
// ============================================================

describe("raised veil behavior", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    sessionMod._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    sessionMod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("R1: when veil was raised, includes notice about raised veil", () => {
    createRaisedSession(tmpDir);
    const result = sessionStartMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes("NOTICE"),
      "should contain NOTICE about raised veil"
    );
    assert.ok(
      ctx.includes("veil was raised"),
      "should mention veil was raised"
    );
    assert.ok(
      ctx.includes("TASK-RAISED"),
      "should contain the task name from raised session"
    );
  });

  it("R2: when veil was raised, includes reason and timestamp", () => {
    createRaisedSession(tmpDir);
    const result = sessionStartMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes("task complete"),
      "should contain raised reason"
    );
    assert.ok(
      ctx.includes("2026-03-06"),
      "should contain raised timestamp"
    );
  });
});

// ============================================================
// EV1-EV3: Evidence ledger recording (session_start event)
// ============================================================

describe("evidence ledger recording", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    sessionMod._resetCache();
    // Ensure logs directory exists
    fs.mkdirSync(path.join(tmpDir, ".claude", "logs"), { recursive: true });
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    sessionMod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("EV1: writes session_start event to evidence ledger when veil is active", () => {
    createActiveSession(tmpDir);
    sessionStartMod.handler({});

    const ledgerPath = path.join(tmpDir, ".claude", "logs", "evidence-ledger.jsonl");
    assert.ok(fs.existsSync(ledgerPath), "evidence ledger should be created");

    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
    assert.ok(lines.length >= 1, "should have at least one entry");

    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.event, "session_start", "event should be session_start");
    assert.equal(entry.task, "TASK-TEST", "task should match session");
    assert.equal(entry.profile, "standard", "profile should match session");
    assert.ok(Array.isArray(entry.gates_passed), "gates_passed should be an array");
    assert.ok(entry.timestamp, "should have a timestamp");
  });

  it("EV2: does NOT write to evidence ledger when veil is inactive", () => {
    // No session file created — veil is inactive
    sessionStartMod.handler({});

    const ledgerPath = path.join(tmpDir, ".claude", "logs", "evidence-ledger.jsonl");
    const exists = fs.existsSync(ledgerPath);
    if (exists) {
      const content = fs.readFileSync(ledgerPath, "utf8").trim();
      assert.equal(content, "", "evidence ledger should be empty when veil is inactive");
    }
  });

  it("EV3: does NOT write to evidence ledger when session exists but active is false", () => {
    createRaisedSession(tmpDir);
    sessionStartMod.handler({});

    const ledgerPath = path.join(tmpDir, ".claude", "logs", "evidence-ledger.jsonl");
    const exists = fs.existsSync(ledgerPath);
    if (exists) {
      const content = fs.readFileSync(ledgerPath, "utf8").trim();
      assert.equal(content, "", "evidence ledger should be empty when veil is raised");
    }
  });
});
