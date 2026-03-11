#!/usr/bin/env node
"use strict";
/**
 * Tests for tobari-evidence.js (PostToolUse evidence ledger hook).
 *
 * Groups:
 *   K1-K2:  Constants
 *   I1-I9:  summarizeToolInput (per tool type)
 *   R1-R4:  summarizeToolResponse
 *   G1-G4:  _getCurrentGate
 *   H1-H2:  handler (PostToolUse hook entry point)
 *   E1-E3:  Module exports verification
 *
 * Run: node --test tests/test_tobari_evidence_js.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const evidence = require("../.claude/hooks/tobari-evidence.js");
const session = require("../.claude/hooks/tobari-session.js");

// --- Test Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tobari-evidence-test-"));
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
    task: "TASK-TEST",
    profile: "standard",
    gates_passed: ["STG0"],
    retry_count: 0,
    token_usage: { input: 0, output: 0, budget: 500000 },
    contract: {
      intent: "test evidence recording",
      requirements: { do: ["record tools"], do_not: [] },
      dod: ["evidence recorded"],
      scope: { include: [".claude/hooks/", "tests/"], exclude: ["tasks/"] },
    },
  };

  const data = { ...defaultSession, ...overrides };
  fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2) + "\n", "utf8");

  // Create logs directory for evidence ledger
  const logsDir = path.join(claudeDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  return sessionPath;
}

// ============================================================
// K1-K2: Constants
// ============================================================

describe("Constants", () => {
  it("K1: MAX_SUMMARY_LENGTH is 200", () => {
    assert.equal(evidence.MAX_SUMMARY_LENGTH, 200);
  });

  it("K2: MAX_RESPONSE_LENGTH is 500", () => {
    assert.equal(evidence.MAX_RESPONSE_LENGTH, 500);
  });
});

// ============================================================
// I1-I9: summarizeToolInput (per tool type)
// ============================================================

describe("summarizeToolInput — Bash", () => {
  it("I1a: short command preserved as-is", () => {
    const result = evidence.summarizeToolInput("Bash", {
      command: "git status",
    });
    assert.equal(result.command, "git status");
  });

  it("I1b: long command truncated at MAX_SUMMARY_LENGTH with ellipsis", () => {
    const longCmd = "x".repeat(300);
    const result = evidence.summarizeToolInput("Bash", { command: longCmd });
    assert.equal(result.command.length, 200 + 3); // 200 chars + "..."
    assert.ok(result.command.endsWith("..."));
    assert.equal(result.command.slice(0, 200), "x".repeat(200));
  });

  it("I1c: missing command defaults to empty string", () => {
    const result = evidence.summarizeToolInput("Bash", {});
    assert.equal(result.command, "");
  });
});

describe("summarizeToolInput — Edit", () => {
  it("I2a: captures file_path, old_size, new_size, replace_all", () => {
    const result = evidence.summarizeToolInput("Edit", {
      file_path: "src/main.js",
      old_string: "hello",
      new_string: "hello world",
      replace_all: true,
    });
    assert.equal(result.file_path, "src/main.js");
    assert.equal(result.old_size, 5);
    assert.equal(result.new_size, 11);
    assert.equal(result.replace_all, true);
  });

  it("I2b: missing fields default to empty/false/0", () => {
    const result = evidence.summarizeToolInput("Edit", {});
    assert.equal(result.file_path, "");
    assert.equal(result.old_size, 0);
    assert.equal(result.new_size, 0);
    assert.equal(result.replace_all, false);
  });
});

describe("summarizeToolInput — Write", () => {
  it("I3a: captures file_path and content_size", () => {
    const result = evidence.summarizeToolInput("Write", {
      file_path: "output.txt",
      content: "Hello, world!",
    });
    assert.equal(result.file_path, "output.txt");
    assert.equal(result.content_size, 13);
  });

  it("I3b: missing content defaults to size 0", () => {
    const result = evidence.summarizeToolInput("Write", {
      file_path: "empty.txt",
    });
    assert.equal(result.file_path, "empty.txt");
    assert.equal(result.content_size, 0);
  });
});

describe("summarizeToolInput — Read", () => {
  it("I4a: captures file_path with optional offset/limit", () => {
    const result = evidence.summarizeToolInput("Read", {
      file_path: "src/app.js",
      offset: 10,
      limit: 50,
    });
    assert.equal(result.file_path, "src/app.js");
    assert.equal(result.offset, 10);
    assert.equal(result.limit, 50);
  });

  it("I4b: omits offset/limit when not provided", () => {
    const result = evidence.summarizeToolInput("Read", {
      file_path: "config.json",
    });
    assert.equal(result.file_path, "config.json");
    assert.equal("offset" in result, false);
    assert.equal("limit" in result, false);
  });

  it("I4c: includes offset=0 (falsy but not null)", () => {
    const result = evidence.summarizeToolInput("Read", {
      file_path: "data.txt",
      offset: 0,
      limit: 100,
    });
    assert.equal(result.offset, 0);
    assert.equal(result.limit, 100);
  });
});

describe("summarizeToolInput — Grep", () => {
  it("I5: captures pattern, path, glob", () => {
    const result = evidence.summarizeToolInput("Grep", {
      pattern: "TODO",
      path: "src/",
      glob: "*.js",
    });
    assert.equal(result.pattern, "TODO");
    assert.equal(result.path, "src/");
    assert.equal(result.glob, "*.js");
  });

  it("I5b: missing fields default to empty strings", () => {
    const result = evidence.summarizeToolInput("Grep", {});
    assert.equal(result.pattern, "");
    assert.equal(result.path, "");
    assert.equal(result.glob, "");
  });
});

describe("summarizeToolInput — Glob", () => {
  it("I6: captures pattern and path", () => {
    const result = evidence.summarizeToolInput("Glob", {
      pattern: "**/*.ts",
      path: "src/",
    });
    assert.equal(result.pattern, "**/*.ts");
    assert.equal(result.path, "src/");
  });

  it("I6b: missing fields default to empty strings", () => {
    const result = evidence.summarizeToolInput("Glob", {});
    assert.equal(result.pattern, "");
    assert.equal(result.path, "");
  });
});

describe("summarizeToolInput — WebFetch / WebSearch", () => {
  it("I7a: WebFetch captures url, query, prompt", () => {
    const result = evidence.summarizeToolInput("WebFetch", {
      url: "https://example.com/page",
      query: "",
      prompt: "Extract the title",
    });
    assert.equal(result.url, "https://example.com/page");
    assert.equal(result.query, "");
    assert.equal(result.prompt, "Extract the title");
  });

  it("I7b: WebSearch captures query", () => {
    const result = evidence.summarizeToolInput("WebSearch", {
      url: "",
      query: "node.js best practices",
      prompt: "",
    });
    assert.equal(result.query, "node.js best practices");
  });

  it("I7c: long prompt truncated at MAX_SUMMARY_LENGTH (no ellipsis)", () => {
    const longPrompt = "y".repeat(300);
    const result = evidence.summarizeToolInput("WebFetch", {
      url: "https://example.com",
      prompt: longPrompt,
    });
    assert.equal(result.prompt.length, 200);
    assert.equal(result.prompt, "y".repeat(200));
  });
});

describe("summarizeToolInput — Task", () => {
  it("I8: captures description and subagent_type", () => {
    const result = evidence.summarizeToolInput("Task", {
      description: "Analyze codebase structure",
      subagent_type: "general-purpose",
    });
    assert.equal(result.description, "Analyze codebase structure");
    assert.equal(result.subagent_type, "general-purpose");
  });

  it("I8b: missing fields default to empty strings", () => {
    const result = evidence.summarizeToolInput("Task", {});
    assert.equal(result.description, "");
    assert.equal(result.subagent_type, "");
  });
});

describe("summarizeToolInput — Unknown tool (generic)", () => {
  it("I9a: short input preserved as raw JSON", () => {
    const input = { foo: "bar", num: 42 };
    const result = evidence.summarizeToolInput("UnknownTool", input);
    assert.ok(result.raw);
    assert.equal(result.raw, JSON.stringify(input));
  });

  it("I9b: long input raw truncated with ellipsis", () => {
    const input = { data: "z".repeat(300) };
    const result = evidence.summarizeToolInput("UnknownTool", input);
    assert.equal(result.raw.length, 200 + 3); // 200 + "..."
    assert.ok(result.raw.endsWith("..."));
  });

  it("I9c: null toolInput treated as empty object", () => {
    const result = evidence.summarizeToolInput("UnknownTool", null);
    assert.ok(result.raw);
    assert.equal(result.raw, "{}");
  });
});

// ============================================================
// R1-R4: summarizeToolResponse
// ============================================================

describe("summarizeToolResponse", () => {
  it("R1a: exit_code 0 yields success=true", () => {
    const result = evidence.summarizeToolResponse({
      exit_code: 0,
      content: "output text",
    });
    assert.equal(result.exit_code, 0);
    assert.equal(result.success, true);
    assert.equal(result.output_size, 11);
  });

  it("R1b: exit_code non-zero yields success=false", () => {
    const result = evidence.summarizeToolResponse({
      exit_code: 1,
      content: "error occurred",
    });
    assert.equal(result.exit_code, 1);
    assert.equal(result.success, false);
    assert.equal(result.output_size, 14);
  });

  it("R2: string content produces output_size", () => {
    const result = evidence.summarizeToolResponse({
      content: "a".repeat(1000),
    });
    assert.equal(result.output_size, 1000);
    assert.equal("exit_code" in result, false);
    assert.equal("success" in result, false);
  });

  it("R2b: stdout fallback when content is absent", () => {
    const result = evidence.summarizeToolResponse({
      stdout: "some output",
    });
    assert.equal(result.output_size, 11);
  });

  it("R3: array content produces output_items", () => {
    const result = evidence.summarizeToolResponse({
      content: ["file1.js", "file2.js", "file3.js"],
    });
    assert.equal(result.output_items, 3);
    assert.equal("output_size" in result, false);
  });

  it("R4: empty response returns output_size 0 (fallback to empty string)", () => {
    // When content and stdout are both missing, fallback is "" (empty string)
    // which is typeof string, so output_size = 0
    const result = evidence.summarizeToolResponse({});
    assert.deepEqual(result, { output_size: 0 });
  });

  it("R4b: exit_code=0 with empty content", () => {
    const result = evidence.summarizeToolResponse({
      exit_code: 0,
      content: "",
    });
    assert.equal(result.exit_code, 0);
    assert.equal(result.success, true);
    assert.equal(result.output_size, 0);
  });
});

// ============================================================
// G1-G4: _getCurrentGate
// ============================================================

describe("_getCurrentGate", () => {
  it("G1: empty gates_passed returns STG0", () => {
    const result = evidence._getCurrentGate({ gates_passed: [] });
    assert.equal(result, "STG0");
  });

  it("G2: STG0 passed returns STG1", () => {
    const result = evidence._getCurrentGate({ gates_passed: ["STG0"] });
    assert.equal(result, "STG1");
  });

  it("G3: multiple gates passed returns next pending", () => {
    const result = evidence._getCurrentGate({
      gates_passed: ["STG0", "STG1", "STG2"],
    });
    assert.equal(result, "STG3");
  });

  it("G4: all gates passed returns complete", () => {
    const result = evidence._getCurrentGate({
      gates_passed: ["STG0", "STG1", "STG2", "STG3", "STG4", "STG5", "STG6"],
    });
    assert.equal(result, "complete");
  });

  it("G4b: missing gates_passed field treated as empty", () => {
    const result = evidence._getCurrentGate({});
    assert.equal(result, "STG0");
  });

  it("G4c: non-sequential gates still finds first missing", () => {
    // If STG0 and STG2 are passed but STG1 is not
    const result = evidence._getCurrentGate({
      gates_passed: ["STG0", "STG2"],
    });
    assert.equal(result, "STG1");
  });
});

// ============================================================
// H1-H2: handler (PostToolUse hook entry point)
// ============================================================

describe("handler", () => {
  let tmpDir;
  let originalProjectDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    session._resetCache();
  });

  afterEach(() => {
    if (originalProjectDir !== undefined) {
      process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    } else {
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    session._resetCache();
    cleanup(tmpDir);
  });

  it("H1: returns null when no active session (no recording)", () => {
    // No session file created => loadSession returns null
    const result = evidence.handler({
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: { exit_code: 0, content: "hello" },
    });
    assert.equal(result, null);

    // Verify no evidence file was created
    const ledgerPath = path.join(
      tmpDir,
      ".claude",
      "logs",
      "evidence-ledger.jsonl"
    );
    assert.equal(fs.existsSync(ledgerPath), false);
  });

  it("H2: returns null when session is active (silent recording)", () => {
    createActiveSession(tmpDir);

    const result = evidence.handler({
      tool_name: "Read",
      tool_input: { file_path: "test.txt" },
      tool_response: { content: "file contents here" },
    });
    assert.equal(result, null);

    // Verify evidence was recorded
    const ledgerPath = path.join(
      tmpDir,
      ".claude",
      "logs",
      "evidence-ledger.jsonl"
    );
    assert.ok(fs.existsSync(ledgerPath));

    const lines = fs
      .readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.trim());
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, "tool_complete");
    assert.equal(entry.tool_name, "Read");
    assert.equal(entry.task, "TASK-TEST");
    assert.equal(entry.profile, "standard");
    assert.equal(entry.current_gate, "STG1");
    assert.deepEqual(entry.input_summary, { file_path: "test.txt" });
    assert.equal(entry.response_summary.output_size, 18);
  });

  it("H2b: handler records correct gate from session gates_passed", () => {
    createActiveSession(tmpDir, {
      gates_passed: ["STG0", "STG1", "STG2"],
    });

    evidence.handler({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { exit_code: 0, content: "all tests passed" },
    });

    const ledgerPath = path.join(
      tmpDir,
      ".claude",
      "logs",
      "evidence-ledger.jsonl"
    );
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.current_gate, "STG3");
  });

  it("H2c: handler handles empty data gracefully", () => {
    createActiveSession(tmpDir);

    const result = evidence.handler({});
    assert.equal(result, null);

    const ledgerPath = path.join(
      tmpDir,
      ".claude",
      "logs",
      "evidence-ledger.jsonl"
    );
    const lines = fs
      .readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.trim());
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.tool_name, "");
    assert.equal(entry.event, "tool_complete");
  });
});

// ============================================================
// E1-E3: Module exports verification
// ============================================================

describe("Module exports", () => {
  it("E1: all expected functions are exported", () => {
    const expectedFunctions = [
      "summarizeToolInput",
      "summarizeToolResponse",
      "_getCurrentGate",
      "handler",
      "cliSummary",
      "cliQualityGates",
      "cliVerify",
    ];
    for (const name of expectedFunctions) {
      assert.equal(
        typeof evidence[name],
        "function",
        `Expected ${name} to be a function`
      );
    }
  });

  it("E2: all expected constants are exported", () => {
    const expectedConstants = [
      "MAX_SUMMARY_LENGTH",
      "MAX_RESPONSE_LENGTH",
    ];
    for (const name of expectedConstants) {
      assert.equal(
        typeof evidence[name],
        "number",
        `Expected ${name} to be a number`
      );
    }
  });

  it("E3: no unexpected exports (sanity check on count)", () => {
    const exportKeys = Object.keys(evidence);
    // 7 functions + 2 constants = 9 total
    assert.equal(exportKeys.length, 9);
  });
});
