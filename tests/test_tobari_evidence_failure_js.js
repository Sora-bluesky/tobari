#!/usr/bin/env node
"use strict";
/**
 * Tests for tobari-evidence-failure.js (PostToolUseFailure hook).
 *
 * Groups:
 *   S1-S6:  _summarizeToolInput (per tool type)
 *   T1-T2:  _summarizeError (truncation)
 *   H1-H4:  handler (hook entry point)
 *   E1-E2:  Edge cases
 *   X1-X2:  Module exports verification
 *
 * Run: node --test tests/test_tobari_evidence_failure_js.js
 */

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const failure = require("../.claude/hooks/tobari-evidence-failure.js");
const session = require("../.claude/hooks/tobari-session.js");

// --- Test Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "tobari-evidence-failure-test-")
  );
}

function cleanup(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // Windows may hold locks briefly
  }
}

function createActiveSession(tmpDir, overrides) {
  const claudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const sessionPath = path.join(claudeDir, "tobari-session.json");

  const defaultSession = {
    active: true,
    task: "TASK-088",
    profile: "standard",
    gates_passed: ["STG0"],
    retry_count: 0,
    token_usage: { input: 0, output: 0, budget: 500000 },
    contract: {
      intent: "test failure evidence",
      requirements: { do: ["record failures"], do_not: [] },
      dod: ["failures recorded"],
      scope: { include: [".claude/hooks/", "tests/"], exclude: ["tasks/"] },
    },
  };

  const data = { ...defaultSession, ...overrides };
  fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2));
  return sessionPath;
}

// --- S: _summarizeToolInput ---

describe("_summarizeToolInput", () => {
  it("S1: Bash — returns truncated command", () => {
    const result = failure._summarizeToolInput("Bash", {
      command: "npm test",
    });
    assert.deepStrictEqual(result, { command: "npm test" });
  });

  it("S2: Bash — truncates long command", () => {
    const longCmd = "a".repeat(500);
    const result = failure._summarizeToolInput("Bash", { command: longCmd });
    assert.ok(result.command.endsWith("..."));
    assert.ok(result.command.length <= failure.MAX_COMMAND_LENGTH + 3);
  });

  it("S3: Edit — returns file_path", () => {
    const result = failure._summarizeToolInput("Edit", {
      file_path: "/path/to/file.py",
    });
    assert.deepStrictEqual(result, { file_path: "/path/to/file.py" });
  });

  it("S4: Write — returns file_path", () => {
    const result = failure._summarizeToolInput("Write", {
      file_path: "/path/to/new.py",
    });
    assert.deepStrictEqual(result, { file_path: "/path/to/new.py" });
  });

  it("S5: NotebookEdit — uses notebook_path", () => {
    const result = failure._summarizeToolInput("NotebookEdit", {
      notebook_path: "/path/to/nb.ipynb",
    });
    assert.deepStrictEqual(result, { file_path: "/path/to/nb.ipynb" });
  });

  it("S6: Read — returns file_path", () => {
    const result = failure._summarizeToolInput("Read", {
      file_path: "/nonexistent.py",
    });
    assert.deepStrictEqual(result, { file_path: "/nonexistent.py" });
  });

  it("S7: Grep — returns pattern", () => {
    const result = failure._summarizeToolInput("Grep", {
      pattern: "foo.*bar",
    });
    assert.deepStrictEqual(result, { pattern: "foo.*bar" });
  });

  it("S8: Glob — returns pattern", () => {
    const result = failure._summarizeToolInput("Glob", {
      pattern: "**/*.js",
    });
    assert.deepStrictEqual(result, { pattern: "**/*.js" });
  });

  it("S9: Unknown tool — generic raw summary", () => {
    const result = failure._summarizeToolInput("CustomTool", {
      key: "value",
    });
    assert.ok("raw" in result);
  });

  it("S10: Unknown tool — truncates long raw", () => {
    const bigInput = { data: "x".repeat(500) };
    const result = failure._summarizeToolInput("CustomTool", bigInput);
    assert.ok(result.raw.endsWith("..."));
    assert.ok(result.raw.length <= failure.MAX_RAW_LENGTH + 3);
  });

  it("S11: Bash — missing command defaults to empty", () => {
    const result = failure._summarizeToolInput("Bash", {});
    assert.deepStrictEqual(result, { command: "" });
  });

  it("S12: Edit — missing file_path defaults to empty", () => {
    const result = failure._summarizeToolInput("Edit", {});
    assert.deepStrictEqual(result, { file_path: "" });
  });
});

// --- T: _summarizeError ---

describe("_summarizeError", () => {
  it("T1: short error — not truncated", () => {
    const result = failure._summarizeError("brief error");
    assert.strictEqual(result, "brief error");
  });

  it("T2: long error — truncated with ellipsis", () => {
    const longError = "x".repeat(2000);
    const result = failure._summarizeError(longError);
    assert.ok(result.endsWith("..."));
    assert.ok(result.length <= failure.MAX_ERROR_LENGTH + 3);
  });

  it("T3: exactly at limit — not truncated", () => {
    const exact = "y".repeat(failure.MAX_ERROR_LENGTH);
    const result = failure._summarizeError(exact);
    assert.strictEqual(result, exact);
    assert.ok(!result.endsWith("..."));
  });
});

// --- H: handler ---

describe("handler", () => {
  let tmpDir;
  let originalEnv;

  beforeEach(() => {
    tmpDir = createTmpDir();
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    session._resetCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = originalEnv;
    }
    session._resetCache();
    cleanup(tmpDir);
  });

  it("H1: no veil — does not write evidence", () => {
    // No session file → inactive
    failure.handler({
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_error: "command not found",
    });

    const logsDir = path.join(tmpDir, ".claude", "logs");
    const ledgerPath = path.join(logsDir, "evidence-ledger.jsonl");
    assert.ok(!fs.existsSync(ledgerPath));
  });

  it("H2: with veil — writes failure entry", () => {
    createActiveSession(tmpDir);
    session._resetCache();

    failure.handler({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_error: "exit code 1",
    });

    const ledgerPath = path.join(
      tmpDir,
      ".claude",
      "logs",
      "evidence-ledger.jsonl"
    );
    assert.ok(fs.existsSync(ledgerPath));

    const lines = fs
      .readFileSync(ledgerPath, "utf-8")
      .trim()
      .split("\n");
    assert.ok(lines.length >= 1);
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(entry.event, "tool_failed");
    assert.strictEqual(entry.tool_name, "Bash");
    assert.ok(entry.input_summary.command.includes("npm test"));
    assert.strictEqual(entry.error, "exit code 1");
    assert.strictEqual(entry.task, "TASK-088");
  });

  it("H3: profile included in entry", () => {
    createActiveSession(tmpDir, { profile: "strict" });
    session._resetCache();

    failure.handler({
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_error: "error",
    });

    const ledgerPath = path.join(
      tmpDir,
      ".claude",
      "logs",
      "evidence-ledger.jsonl"
    );
    const lines = fs
      .readFileSync(ledgerPath, "utf-8")
      .trim()
      .split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(entry.profile, "strict");
  });

  it("H4: Edit failure — records file_path", () => {
    createActiveSession(tmpDir);
    session._resetCache();

    failure.handler({
      tool_name: "Edit",
      tool_input: { file_path: "/path/to/file.py" },
      tool_error: "old_string not found",
    });

    const ledgerPath = path.join(
      tmpDir,
      ".claude",
      "logs",
      "evidence-ledger.jsonl"
    );
    const lines = fs
      .readFileSync(ledgerPath, "utf-8")
      .trim()
      .split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(entry.tool_name, "Edit");
    assert.strictEqual(entry.input_summary.file_path, "/path/to/file.py");
  });
});

// --- E: Edge cases ---

describe("Edge cases", () => {
  let tmpDir;
  let originalEnv;

  beforeEach(() => {
    tmpDir = createTmpDir();
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    session._resetCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = originalEnv;
    }
    session._resetCache();
    cleanup(tmpDir);
  });

  it("E1: missing tool_error defaults to empty string", () => {
    createActiveSession(tmpDir);
    session._resetCache();

    failure.handler({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });

    const ledgerPath = path.join(
      tmpDir,
      ".claude",
      "logs",
      "evidence-ledger.jsonl"
    );
    const lines = fs
      .readFileSync(ledgerPath, "utf-8")
      .trim()
      .split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(entry.error, "");
  });

  it("E2: empty data object produces valid entry", () => {
    createActiveSession(tmpDir);
    session._resetCache();

    failure.handler({});

    const ledgerPath = path.join(
      tmpDir,
      ".claude",
      "logs",
      "evidence-ledger.jsonl"
    );
    const lines = fs
      .readFileSync(ledgerPath, "utf-8")
      .trim()
      .split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(entry.event, "tool_failed");
    assert.strictEqual(entry.tool_name, "unknown");
  });
});

// --- X: Module exports ---

describe("Module exports", () => {
  it("X1: exports handler function", () => {
    assert.strictEqual(typeof failure.handler, "function");
  });

  it("X2: exports summarizer functions", () => {
    assert.strictEqual(typeof failure._summarizeError, "function");
    assert.strictEqual(typeof failure._summarizeToolInput, "function");
  });

  it("X3: exports constants", () => {
    assert.strictEqual(typeof failure.MAX_ERROR_LENGTH, "number");
    assert.strictEqual(typeof failure.MAX_COMMAND_LENGTH, "number");
    assert.strictEqual(typeof failure.MAX_RAW_LENGTH, "number");
  });
});
