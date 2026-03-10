#!/usr/bin/env node
"use strict";
/**
 * Tests for tobari-stop.js — Stop Hook Self-Repair Engine.
 *
 * Covers:
 * - Constants (MAX_RETRIES, FAILURE_PATTERNS, SUCCESS_PATTERNS)
 * - _extractText (string, array of strings, array of objects, mixed, fallback)
 * - _messageText (content string, content array, empty dict)
 * - detectTestFailure (empty, failure patterns, success patterns, mixed ordering, edge cases)
 * - _loadTranscript (inline array, empty data, invalid data)
 * - _makeRepairInstruction (retry count, failure summary, task name, Japanese)
 * - _makeCircuitBreakerMessage (MAX_RETRIES, failure summary, Japanese)
 * - _buildEvidenceItems (evidence summary to structured items)
 * - _updateSessionEvidence (session file evidence array update)
 * - Module exports completeness
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Set CLAUDE_PROJECT_DIR before requiring the module
const PROJECT_DIR = path.resolve(__dirname, "..");
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
process.env.TOBARI_LANG = "ja";

const stop = require("../.claude/hooks/tobari-stop.js");

// --- Tests ---

// =========================================================================
// 1. Constants
// =========================================================================

describe("tobari-stop.js constants", () => {
  it("MAX_RETRIES equals 3", () => {
    assert.equal(stop.MAX_RETRIES, 3);
  });

  it("FAILURE_PATTERNS is an array of RegExp with 11+ entries", () => {
    assert.ok(Array.isArray(stop.FAILURE_PATTERNS));
    assert.ok(
      stop.FAILURE_PATTERNS.length >= 11,
      `Expected >= 11, got ${stop.FAILURE_PATTERNS.length}`
    );
    for (const p of stop.FAILURE_PATTERNS) {
      assert.ok(p instanceof RegExp, `Expected RegExp, got ${typeof p}`);
    }
  });

  it("SUCCESS_PATTERNS is an array of 9 RegExp", () => {
    assert.ok(Array.isArray(stop.SUCCESS_PATTERNS));
    assert.equal(stop.SUCCESS_PATTERNS.length, 9);
    for (const p of stop.SUCCESS_PATTERNS) {
      assert.ok(p instanceof RegExp, `Expected RegExp, got ${typeof p}`);
    }
  });

  it("FAILURE_PATTERNS are case-insensitive", () => {
    for (const p of stop.FAILURE_PATTERNS) {
      assert.ok(p.flags.includes("i"), `Pattern ${p} should be case-insensitive`);
    }
  });

  it("SUCCESS_PATTERNS are case-insensitive", () => {
    for (const p of stop.SUCCESS_PATTERNS) {
      assert.ok(p.flags.includes("i"), `Pattern ${p} should be case-insensitive`);
    }
  });
});

// =========================================================================
// 2. _extractText
// =========================================================================

describe("_extractText", () => {
  it("string input returns as-is", () => {
    assert.equal(stop._extractText("hello world"), "hello world");
  });

  it("empty string returns empty string", () => {
    assert.equal(stop._extractText(""), "");
  });

  it("array of strings joined with newline", () => {
    const result = stop._extractText(["line1", "line2", "line3"]);
    assert.equal(result, "line1\nline2\nline3");
  });

  it("array of {type: 'text', text: '...'} extracts text fields", () => {
    const input = [
      { type: "text", text: "alpha" },
      { type: "text", text: "beta" },
    ];
    assert.equal(stop._extractText(input), "alpha\nbeta");
  });

  it("array of mixed strings and objects", () => {
    const input = [
      "plain",
      { type: "text", text: "structured" },
    ];
    assert.equal(stop._extractText(input), "plain\nstructured");
  });

  it("array with objects having text field but no type", () => {
    const input = [{ text: "fallback" }];
    assert.equal(stop._extractText(input), "fallback");
  });

  it("array with object missing text field is skipped", () => {
    const input = [{ type: "image", url: "http://example.com" }];
    assert.equal(stop._extractText(input), "");
  });

  it("array with null items are skipped", () => {
    const input = ["valid", null, "also valid"];
    assert.equal(stop._extractText(input), "valid\nalso valid");
  });

  it("non-string non-array returns empty string", () => {
    assert.equal(stop._extractText(123), "");
    assert.equal(stop._extractText(null), "");
    assert.equal(stop._extractText(undefined), "");
    assert.equal(stop._extractText({}), "");
  });

  it("object with type text and empty text returns empty part", () => {
    const input = [{ type: "text" }];
    // text is undefined, so item.text || "" => ""
    assert.equal(stop._extractText(input), "");
  });
});

// =========================================================================
// 3. _messageText
// =========================================================================

describe("_messageText", () => {
  it("dict with content string extracts text", () => {
    assert.equal(stop._messageText({ content: "hello" }), "hello");
  });

  it("dict with content array extracts text", () => {
    const msg = { content: [{ type: "text", text: "from array" }] };
    assert.equal(stop._messageText(msg), "from array");
  });

  it("empty dict returns empty string", () => {
    assert.equal(stop._messageText({}), "");
  });

  it("dict with content null returns empty string", () => {
    assert.equal(stop._messageText({ content: null }), "");
  });

  it("dict with content as number returns empty string", () => {
    assert.equal(stop._messageText({ content: 42 }), "");
  });
});

// =========================================================================
// 4. detectTestFailure
// =========================================================================

describe("detectTestFailure — empty / no failure", () => {
  it("empty transcript returns [false, '']", () => {
    const [isFailure, summary] = stop.detectTestFailure([]);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("null transcript returns [false, '']", () => {
    const [isFailure, summary] = stop.detectTestFailure(null);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("undefined transcript returns [false, '']", () => {
    const [isFailure, summary] = stop.detectTestFailure(undefined);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("non-array transcript returns [false, '']", () => {
    const [isFailure, summary] = stop.detectTestFailure("not an array");
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("transcript with only whitespace entries returns [false, '']", () => {
    const transcript = [{ content: "   " }, { content: "\n" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });
});

describe("detectTestFailure — failure detection", () => {
  it("transcript with FAILED returns [true, summary]", () => {
    const transcript = [{ content: "Tests FAILED: 2 errors" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
    assert.ok(summary.length > 0);
    assert.ok(summary.includes("FAILED"));
  });

  it("transcript with 'X failed' returns [true, summary]", () => {
    const transcript = [{ content: "3 failed, 10 passed" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
    assert.ok(summary.includes("failed"));
  });

  it("transcript with AssertionError (typo preserved) returns [true, summary]", () => {
    const transcript = [{ content: "AssertionError: expected true, got false" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
    assert.ok(summary.includes("AssertionError"));
  });

  it("transcript with '\u30c6\u30b9\u30c8\u5931\u6557' returns [true, summary]", () => {
    const transcript = [{ content: "\u30c6\u30b9\u30c8\u5931\u6557\u3057\u307e\u3057\u305f" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
    assert.ok(summary.length > 0);
  });

  it("transcript with 'test fail' returns [true, summary]", () => {
    const transcript = [{ content: "test_login failed with error" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
  });

  it("transcript with 'returncode=1' returns [true, summary]", () => {
    const transcript = [{ content: "Process finished with returncode=1" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
  });

  it("transcript with 'exit code 1' returns [true, summary]", () => {
    const transcript = [{ content: "Command exited with exit code 1" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
  });

  it("transcript with 'Command failed' returns [true, summary]", () => {
    const transcript = [{ content: "Command failed: npm test" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
  });

  it("transcript with 'Traceback' returns [true, summary]", () => {
    const transcript = [{ content: "Traceback (most recent call last):\n  File..." }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
  });

  it("transcript with 'ERROR: ...' returns [true, summary]", () => {
    const transcript = [{ content: "ERROR: test_utils\nsome details" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
  });

  it("transcript with 'ERRORS: ...' returns [true, summary]", () => {
    const transcript = [{ content: "ERRORS: 5 failures found" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
  });
});

describe("detectTestFailure — success detection", () => {
  it("transcript with 'X passed' returns [false, '']", () => {
    const transcript = [{ content: "10 passed in 2.3s" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("transcript with 'PASSED' returns [false, '']", () => {
    const transcript = [{ content: "PASSED" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("transcript with 'all tests passed' returns [false, '']", () => {
    const transcript = [{ content: "all tests passed successfully" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("transcript with '\u30c6\u30b9\u30c8\u6210\u529f' returns [false, '']", () => {
    const transcript = [{ content: "\u30c6\u30b9\u30c8\u304c\u6210\u529f\u3057\u307e\u3057\u305f" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("transcript with '\u4fee\u6b63\u5b8c\u4e86' returns [false, '']", () => {
    const transcript = [{ content: "\u4fee\u6b63\u5b8c\u4e86\u3057\u307e\u3057\u305f" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("transcript with '\u5b9f\u88c5\u5b8c\u4e86' returns [false, '']", () => {
    const transcript = [{ content: "\u5b9f\u88c5\u5b8c\u4e86" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("transcript with '\u2713 5' returns [false, '']", () => {
    const transcript = [{ content: "\u2713 5 tests completed" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });
});

describe("detectTestFailure — mixed ordering (most recent wins)", () => {
  it("failure then success at end returns [false, ''] (success is most recent)", () => {
    const transcript = [
      { content: "3 failed" },
      { content: "10 passed in 5s" },
    ];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("success then failure at end returns [true, summary] (failure is most recent)", () => {
    const transcript = [
      { content: "10 passed in 5s" },
      { content: "2 failed, 8 passed" },
    ];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
    assert.ok(summary.length > 0);
  });

  it("failure, neutral, success returns [false, ''] (success is most recent recognisable)", () => {
    const transcript = [
      { content: "FAILED something" },
      { content: "running cleanup..." },
      { content: "all tests passed" },
    ];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("success, neutral, failure returns [true, summary]", () => {
    const transcript = [
      { content: "PASSED" },
      { content: "retrying..." },
      { content: "FAILED again" },
    ];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
    assert.ok(summary.includes("FAILED"));
  });
});

describe("detectTestFailure — edge cases", () => {
  it("non-dict entries are skipped", () => {
    const transcript = [
      "just a string",
      42,
      null,
      { content: "5 passed" },
    ];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("only last 8 entries are scanned", () => {
    // Build 10 entries: first 2 have failure, last 8 are neutral
    const transcript = [];
    transcript.push({ content: "FAILED critical test" });
    transcript.push({ content: "FAILED another test" });
    for (let i = 0; i < 8; i++) {
      transcript.push({ content: "some neutral log output here" });
    }
    // The failure entries (index 0, 1) are outside the last-8 window
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, false);
    assert.equal(summary, "");
  });

  it("entry with content array is handled", () => {
    const transcript = [
      { content: [{ type: "text", text: "3 failed" }] },
    ];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
  });

  it("failure in entry with both failure and success is detected as failure", () => {
    // "1 failed, 2 passed" contains both, but failure takes precedence
    const transcript = [{ content: "1 failed, 2 passed" }];
    const [isFailure, summary] = stop.detectTestFailure(transcript);
    assert.equal(isFailure, true);
  });
});

// =========================================================================
// 5. _loadTranscript
// =========================================================================

describe("_loadTranscript", () => {
  it("inline transcript array is returned directly", () => {
    const data = { transcript: [{ content: "msg1" }, { content: "msg2" }] };
    const result = stop._loadTranscript(data);
    assert.deepEqual(result, data.transcript);
  });

  it("empty data returns []", () => {
    assert.deepEqual(stop._loadTranscript({}), []);
  });

  it("null data fields return []", () => {
    assert.deepEqual(stop._loadTranscript({ transcript: null }), []);
  });

  it("non-array transcript (string) returns []", () => {
    assert.deepEqual(stop._loadTranscript({ transcript: "not an array" }), []);
  });

  it("invalid transcript_path returns []", () => {
    const data = { transcript_path: "/nonexistent/path/file.json" };
    assert.deepEqual(stop._loadTranscript(data), []);
  });

  it("inline transcript takes precedence over transcript_path", () => {
    const data = {
      transcript: [{ content: "inline" }],
      transcript_path: "/nonexistent/path.json",
    };
    const result = stop._loadTranscript(data);
    assert.deepEqual(result, [{ content: "inline" }]);
  });
});

// =========================================================================
// 6. _makeRepairInstruction
// =========================================================================

describe("_makeRepairInstruction", () => {
  it("contains retry count (attempt/max)", () => {
    const result = stop._makeRepairInstruction(0, "some error", "test-task");
    assert.ok(result.includes("1/3"), "Should show attempt 1 of 3");
  });

  it("increments retry count correctly", () => {
    const result = stop._makeRepairInstruction(2, "some error", "test-task");
    assert.ok(result.includes("3/3"), "Should show attempt 3 of 3");
  });

  it("contains failure summary", () => {
    const summary = "AssertionError: expected true got false";
    const result = stop._makeRepairInstruction(0, summary, "test-task");
    assert.ok(result.includes(summary));
  });

  it("contains task name", () => {
    const result = stop._makeRepairInstruction(0, "error", "TASK-026");
    assert.ok(result.includes("TASK-026"));
  });

  it("is in Japanese", () => {
    const result = stop._makeRepairInstruction(0, "error", "task");
    // Check for known Japanese text fragments
    assert.ok(result.includes("\u30c6\u30b9\u30c8\u5931\u6557"), "Should contain '\u30c6\u30b9\u30c8\u5931\u6557'");
    assert.ok(result.includes("\u81ea\u52d5\u4fee\u5fa9"), "Should contain '\u81ea\u52d5\u4fee\u5fa9'");
    assert.ok(result.includes("\u30a8\u30e9\u30fc\u30e1\u30c3\u30bb\u30fc\u30b8"), "Should contain '\u30a8\u30e9\u30fc\u30e1\u30c3\u30bb\u30fc\u30b8'");
    assert.ok(result.includes("\u6839\u672c\u539f\u56e0"), "Should contain '\u6839\u672c\u539f\u56e0'");
  });

  it("contains structured repair steps (1, 2, 3)", () => {
    const result = stop._makeRepairInstruction(0, "error", "task");
    assert.ok(result.includes("1."));
    assert.ok(result.includes("2."));
    assert.ok(result.includes("3."));
  });
});

// =========================================================================
// 7. _makeCircuitBreakerMessage
// =========================================================================

describe("_makeCircuitBreakerMessage", () => {
  it("contains MAX_RETRIES value", () => {
    const result = stop._makeCircuitBreakerMessage("error", "task");
    assert.ok(
      result.includes(`${stop.MAX_RETRIES}/${stop.MAX_RETRIES}`),
      "Should contain 3/3"
    );
  });

  it("contains failure summary", () => {
    const summary = "FAILED: test_login timed out";
    const result = stop._makeCircuitBreakerMessage(summary, "task");
    assert.ok(result.includes(summary));
  });

  it("contains task name", () => {
    const result = stop._makeCircuitBreakerMessage("error", "TASK-026");
    assert.ok(result.includes("TASK-026"));
  });

  it("is in Japanese", () => {
    const result = stop._makeCircuitBreakerMessage("error", "task");
    assert.ok(result.includes("\u81ea\u5df1\u4fee\u5fa9"), "Should contain '\u81ea\u5df1\u4fee\u5fa9'");
    assert.ok(result.includes("\u9650\u754c"), "Should contain '\u9650\u754c'");
    assert.ok(result.includes("\u624b\u52d5"), "Should contain '\u624b\u52d5'");
    assert.ok(result.includes("\u5bfe\u5fdc"), "Should contain '\u5bfe\u5fdc'");
  });

  it("contains structured manual steps (1, 2, 3)", () => {
    const result = stop._makeCircuitBreakerMessage("error", "task");
    assert.ok(result.includes("1."));
    assert.ok(result.includes("2."));
    assert.ok(result.includes("3."));
  });

  it("references evidence ledger path", () => {
    const result = stop._makeCircuitBreakerMessage("error", "task");
    assert.ok(result.includes("evidence-ledger.jsonl"));
  });
});

// =========================================================================
// 8. _buildEvidenceItems
// =========================================================================

describe("_buildEvidenceItems", () => {
  it("returns total_entries item for empty summary", () => {
    const items = stop._buildEvidenceItems({
      total: 0,
      events: {},
      tools: {},
      quality_gate_counts: { blocking: 0, high: 0 },
    });
    assert.ok(Array.isArray(items), "should return an array");
    const totalItem = items.find((i) => i.type === "total_entries");
    assert.ok(totalItem, "should have total_entries item");
    assert.equal(totalItem.count, 0);
  });

  it("includes event counts for known events", () => {
    const items = stop._buildEvidenceItems({
      total: 150,
      events: {
        session_start: 2,
        tool_complete: 100,
        tool_denied: 10,
        tool_failed: 3,
        stop_audit: 5,
        self_repair_attempt: 1,
      },
      tools: {},
      quality_gate_counts: { blocking: 0, high: 0 },
    });
    assert.ok(items.find((i) => i.type === "session_start" && i.count === 2));
    assert.ok(items.find((i) => i.type === "tool_complete" && i.count === 100));
    assert.ok(items.find((i) => i.type === "tool_denied" && i.count === 10));
    assert.ok(items.find((i) => i.type === "tool_failed" && i.count === 3));
    assert.ok(items.find((i) => i.type === "stop_audit" && i.count === 5));
    assert.ok(items.find((i) => i.type === "self_repair_attempt" && i.count === 1));
    assert.ok(items.find((i) => i.type === "total_entries" && i.count === 150));
  });

  it("includes top 5 tools by usage", () => {
    const items = stop._buildEvidenceItems({
      total: 20,
      events: {},
      tools: { Read: 10, Edit: 5, Write: 3, Grep: 2, Glob: 1, Bash: 8 },
      quality_gate_counts: { blocking: 0, high: 0 },
    });
    const topTools = items.find((i) => i.type === "top_tools");
    assert.ok(topTools, "should have top_tools item");
    assert.equal(topTools.tools.length, 5, "should have exactly 5 tools");
    assert.equal(topTools.tools[0].tool, "Read", "highest usage tool first");
  });

  it("includes quality gates when blocking or high > 0", () => {
    const items = stop._buildEvidenceItems({
      total: 10,
      events: {},
      tools: {},
      quality_gate_counts: { blocking: 2, high: 1 },
    });
    const qg = items.find((i) => i.type === "quality_gates");
    assert.ok(qg, "should have quality_gates item");
    assert.equal(qg.blocking, 2);
    assert.equal(qg.high, 1);
  });

  it("omits quality gates when both are 0", () => {
    const items = stop._buildEvidenceItems({
      total: 10,
      events: {},
      tools: {},
      quality_gate_counts: { blocking: 0, high: 0 },
    });
    const qg = items.find((i) => i.type === "quality_gates");
    assert.equal(qg, undefined, "should not include quality_gates when both are 0");
  });

  it("omits event types with 0 count", () => {
    const items = stop._buildEvidenceItems({
      total: 5,
      events: { tool_complete: 5 },
      tools: {},
      quality_gate_counts: { blocking: 0, high: 0 },
    });
    assert.equal(
      items.find((i) => i.type === "session_start"),
      undefined,
      "should not include session_start when not in events"
    );
    assert.equal(
      items.find((i) => i.type === "tool_denied"),
      undefined,
      "should not include tool_denied when not in events"
    );
  });
});

// =========================================================================
// 9. _updateSessionEvidence (integration)
// =========================================================================

describe("_updateSessionEvidence", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;
  const sessionMod = require("../.claude/hooks/tobari-session.js");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tobari-stop-ev-"));
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    sessionMod._resetCache();

    // Create .claude directory structure
    const claudeDir = path.join(tmpDir, ".claude");
    fs.mkdirSync(path.join(claudeDir, "logs"), { recursive: true });
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    sessionMod._resetCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  it("updates evidence array in session file when veil is active", () => {
    // Create active session
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    const sessionData = {
      active: true,
      task: "test-task",
      profile: "standard",
      gates_passed: ["STG0"],
      evidence: [],
    };
    fs.writeFileSync(sessionPath, JSON.stringify(sessionData) + "\n", "utf8");

    // Write some evidence entries to ledger
    const ledgerPath = path.join(tmpDir, ".claude", "logs", "evidence-ledger.jsonl");
    const entries = [
      { event: "session_start", task: "test-task", timestamp: "2026-01-01T00:00:00Z" },
      { event: "tool_complete", tool_name: "Read", timestamp: "2026-01-01T00:00:01Z" },
      { event: "tool_complete", tool_name: "Read", timestamp: "2026-01-01T00:00:02Z" },
      { event: "tool_denied", tool_name: "Write", timestamp: "2026-01-01T00:00:03Z" },
    ];
    fs.writeFileSync(
      ledgerPath,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8"
    );

    // Call _updateSessionEvidence
    stop._updateSessionEvidence();

    // Verify session file was updated
    const updated = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.ok(Array.isArray(updated.evidence), "evidence should be an array");
    assert.ok(updated.evidence.length > 0, "evidence should not be empty");

    const totalItem = updated.evidence.find((i) => i.type === "total_entries");
    assert.ok(totalItem, "should have total_entries");
    assert.equal(totalItem.count, 4, "should count all 4 ledger entries");

    const sessionStartItem = updated.evidence.find((i) => i.type === "session_start");
    assert.ok(sessionStartItem, "should have session_start item");
    assert.equal(sessionStartItem.count, 1);
  });

  it("does not update evidence when veil is inactive", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    const sessionData = {
      active: false,
      task: "old-task",
      evidence: [],
    };
    fs.writeFileSync(sessionPath, JSON.stringify(sessionData) + "\n", "utf8");

    stop._updateSessionEvidence();

    const updated = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.deepEqual(updated.evidence, [], "evidence should remain empty");
  });

  it("does not throw when session file does not exist", () => {
    assert.doesNotThrow(() => {
      stop._updateSessionEvidence();
    }, "should not throw when no session file");
  });
});

// =========================================================================
// 10. Module exports completeness
// =========================================================================

describe("module exports completeness", () => {
  it("exports all expected functions", () => {
    const expectedFunctions = [
      "_extractText",
      "_messageText",
      "detectTestFailure",
      "_loadTranscript",
      "_makeRepairInstruction",
      "_makeCircuitBreakerMessage",
      "handler",
    ];
    for (const fn of expectedFunctions) {
      assert.equal(typeof stop[fn], "function", `Missing function export: ${fn}`);
    }
  });

  it("exports all expected constants", () => {
    assert.equal(typeof stop.MAX_RETRIES, "number", "MAX_RETRIES should be a number");
    assert.ok(Array.isArray(stop.FAILURE_PATTERNS), "FAILURE_PATTERNS should be an array");
    assert.ok(Array.isArray(stop.SUCCESS_PATTERNS), "SUCCESS_PATTERNS should be an array");
  });

  it("exports exactly the expected set of keys", () => {
    const expectedKeys = [
      "MAX_RETRIES",
      "FAILURE_PATTERNS",
      "SUCCESS_PATTERNS",
      "_extractText",
      "_messageText",
      "_getLastAssistantMessage",
      "detectTestFailure",
      "_loadTranscript",
      "_makeRepairInstruction",
      "_makeCircuitBreakerMessage",
      "_buildEvidenceItems",
      "_updateSessionEvidence",
      "handler",
    ].sort();
    const actualKeys = Object.keys(stop).sort();
    assert.deepEqual(actualKeys, expectedKeys);
  });
});
