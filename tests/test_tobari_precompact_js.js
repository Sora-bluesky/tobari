#!/usr/bin/env node
"use strict";
/**
 * Tests for TASK-090: tobari-precompact.js (PreCompact Hook).
 *
 * Groups:
 *   E1-E2:  Module exports
 *   H1-H3:  handler output structure
 *   I1-I2:  Inactive session behavior
 *   A1-A2:  Active session behavior
 *   N1-N2:  Null/empty data handling
 *
 * Run: node --test tests/test_tobari_precompact_js.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const precompactMod = require("../.claude/hooks/tobari-precompact.js");
const sessionMod = require("../.claude/hooks/tobari-session.js");

// --- Test Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tobari-pc-test-"));
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

// ============================================================
// E1-E2: Module exports
// ============================================================

describe("module exports", () => {
  it("E1: handler is exported as a function", () => {
    assert.strictEqual(typeof precompactMod.handler, "function");
  });

  it("E2: only exports handler (minimal surface)", () => {
    const keys = Object.keys(precompactMod);
    assert.deepStrictEqual(keys, ["handler"]);
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
    const result = precompactMod.handler({});
    assert.ok(result, "handler should return a truthy value");
    assert.ok(result.hookSpecificOutput, "should have hookSpecificOutput");
    assert.equal(
      typeof result.hookSpecificOutput.additionalContext,
      "string",
      "additionalContext should be a string"
    );
  });

  it("H2: additionalContext contains project references", () => {
    const result = precompactMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("CLAUDE.md"), "should reference CLAUDE.md");
    assert.ok(ctx.includes("DESIGN.md"), "should reference DESIGN.md");
    assert.ok(
      ctx.includes(".claude/rules/"),
      "should reference .claude/rules/"
    );
    assert.ok(
      ctx.includes("tasks/backlog.yaml"),
      "should reference tasks/backlog.yaml"
    );
  });

  it("H3: additionalContext contains compaction text", () => {
    const result = precompactMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("compaction"), "should mention compaction");
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

  it("I1: when no session active, contains compaction text but no session info", () => {
    const result = precompactMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("compaction"), "should contain compaction text");
    assert.ok(
      !ctx.includes("TOBARI SESSION ACTIVE"),
      "should NOT contain session active message"
    );
  });

  it("I2: when no session active, still provides project references", () => {
    const result = precompactMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("CLAUDE.md"), "should still reference CLAUDE.md");
    assert.ok(
      ctx.includes("tasks/backlog.yaml"),
      "should still reference backlog.yaml"
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

  it("A1: when session active, contains session active message with task info", () => {
    createActiveSession(tmpDir);
    const result = precompactMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes("TOBARI SESSION ACTIVE"),
      "should contain TOBARI SESSION ACTIVE"
    );
    assert.ok(ctx.includes("TASK-TEST"), "should contain task name");
    assert.ok(ctx.includes("standard"), "should contain profile");
  });

  it("A2: when session active, still contains compaction text and project refs", () => {
    createActiveSession(tmpDir);
    const result = precompactMod.handler({});
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes("compaction"),
      "should contain compaction text even with active session"
    );
    assert.ok(ctx.includes("CLAUDE.md"), "should still reference project files");
  });
});

// ============================================================
// N1-N2: Null/empty data handling
// ============================================================

describe("null/empty data handling", () => {
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

  it("N1: handler can be called with empty object without throwing", () => {
    assert.doesNotThrow(() => {
      precompactMod.handler({});
    });
  });

  it("N2: handler can be called with null data without throwing", () => {
    assert.doesNotThrow(() => {
      precompactMod.handler(null);
    });
  });
});
