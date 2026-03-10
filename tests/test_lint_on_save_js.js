#!/usr/bin/env node
"use strict";
/**
 * Tests for lint-on-save.js (PostToolUse lint hook).
 *
 * Groups:
 *   V1-V4:  validatePath
 *   P1-P4:  escapePowershellString
 *   R1-R4:  runCommand
 *   H1-H6:  handler (hook entry point)
 *   L1-L3:  lintPython (integration-like, with mock)
 *   W1-W2:  lintPowershell (integration-like, with mock)
 *   X1-X3:  Module exports
 *
 * Run: node --test tests/test_lint_on_save_js.js
 */

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const lint = require("../.claude/hooks/lint-on-save.js");

// --- Test Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tobari-lint-test-"));
}

function cleanup(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // Windows may hold locks briefly
  }
}

// --- V: validatePath ---

describe("validatePath", () => {
  it("V1: valid path returns true", () => {
    assert.strictEqual(lint.validatePath("/path/to/file.py"), true);
  });

  it("V2: empty path returns false", () => {
    assert.strictEqual(lint.validatePath(""), false);
  });

  it("V3: path with .. returns false", () => {
    assert.strictEqual(lint.validatePath("/path/../etc/passwd"), false);
  });

  it("V4: too long path returns false", () => {
    const longPath = "/path/" + "a".repeat(lint.MAX_PATH_LENGTH);
    assert.strictEqual(lint.validatePath(longPath), false);
  });

  it("V5: null/undefined returns false", () => {
    assert.strictEqual(lint.validatePath(null), false);
    assert.strictEqual(lint.validatePath(undefined), false);
  });
});

// --- P: escapePowershellString ---

describe("escapePowershellString", () => {
  it("P1: normal string passes through", () => {
    assert.strictEqual(
      lint.escapePowershellString("C:\\path\\to\\file.ps1"),
      "C:\\path\\to\\file.ps1"
    );
  });

  it("P2: single quotes are doubled", () => {
    assert.strictEqual(
      lint.escapePowershellString("it's a test"),
      "it''s a test"
    );
  });

  it("P3: null byte returns empty", () => {
    assert.strictEqual(lint.escapePowershellString("path\x00evil"), "");
  });

  it("P4: newline returns empty", () => {
    assert.strictEqual(lint.escapePowershellString("path\nevil"), "");
    assert.strictEqual(lint.escapePowershellString("path\revil"), "");
  });
});

// --- R: runCommand ---

describe("runCommand", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("R1: successful command returns code 0", () => {
    const result = lint.runCommand("node", ["-e", "console.log('hello')"], tmpDir);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes("hello"));
  });

  it("R2: failing command returns non-zero code", () => {
    const result = lint.runCommand("node", ["-e", "process.exit(1)"], tmpDir);
    assert.notStrictEqual(result.code, 0);
  });

  it("R3: missing command returns code -1", () => {
    const result = lint.runCommand(
      "nonexistent_command_12345",
      [],
      tmpDir
    );
    assert.strictEqual(result.code, -1);
    assert.ok(result.stderr.includes("Command not found"));
  });

  it("R4: command with stdout captures output", () => {
    const result = lint.runCommand(
      "node",
      ["-e", "console.log('test output')"],
      tmpDir
    );
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes("test output"));
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
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = originalEnv;
    }
    cleanup(tmpDir);
  });

  it("H1: no file_path — returns silently", () => {
    // Should not throw
    lint.handler({ tool_input: {} });
  });

  it("H2: invalid path — rejects with warning", () => {
    // Should not throw, just warn on stderr
    lint.handler({ tool_input: { file_path: "/path/../etc/passwd" } });
  });

  it("H3: .js file — skips silently (not Python/PS)", () => {
    const jsFile = path.join(tmpDir, "test.js");
    fs.writeFileSync(jsFile, "// test");
    lint.handler({ tool_input: { file_path: jsFile } });
    // No error thrown, no linter called
  });

  it("H4: .py file — attempts Python linting", () => {
    const pyFile = path.join(tmpDir, "test.py");
    fs.writeFileSync(pyFile, "print('hello')\n");
    // Will attempt to run uv/ruff — may not be available, but shouldn't crash
    lint.handler({ tool_input: { file_path: pyFile } });
  });

  it("H5: .ps1 file — attempts PowerShell linting", () => {
    const psFile = path.join(tmpDir, "test.ps1");
    fs.writeFileSync(psFile, "Write-Host 'hello'\n");
    // Will attempt to run pwsh — may not be available, but shouldn't crash
    lint.handler({ tool_input: { file_path: psFile } });
  });

  it("H6: empty data object — returns silently", () => {
    lint.handler({});
  });
});

// --- X: Module exports ---

describe("Module exports", () => {
  it("X1: exports handler function", () => {
    assert.strictEqual(typeof lint.handler, "function");
  });

  it("X2: exports utility functions", () => {
    assert.strictEqual(typeof lint.validatePath, "function");
    assert.strictEqual(typeof lint.runCommand, "function");
    assert.strictEqual(typeof lint.lintPython, "function");
    assert.strictEqual(typeof lint.lintPowershell, "function");
    assert.strictEqual(typeof lint.escapePowershellString, "function");
  });

  it("X3: exports constants", () => {
    assert.strictEqual(typeof lint.MAX_PATH_LENGTH, "number");
    assert.strictEqual(typeof lint.COMMAND_TIMEOUT, "number");
  });
});
