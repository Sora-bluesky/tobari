#!/usr/bin/env node
"use strict";
/**
 * Tests for tobari-cost.js (PostToolUse cost monitor hook).
 *
 * Groups:
 *   C1-C5:  Constants verification
 *   T1-T7:  _estimateTokensFromText
 *   E1-E6:  estimateTokens
 *   P1-P5:  calcPercent
 *   W1-W4:  buildWarningMessage
 *   H1:     handler (no session)
 *   X1:     Module exports verification
 *
 * Run: node --test tests/test_tobari_cost_js.js
 */

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const cost = require("../.claude/hooks/tobari-cost.js");

// ---------------------------------------------------------------------------
// C: Constants
// ---------------------------------------------------------------------------
describe("Constants", () => {
  it("C1: CHARS_PER_TOKEN_ASCII is 4", () => {
    assert.equal(cost.CHARS_PER_TOKEN_ASCII, 4);
  });

  it("C2: CHARS_PER_TOKEN_CJK is 1.5", () => {
    assert.equal(cost.CHARS_PER_TOKEN_CJK, 1.5);
  });

  it("C3: THRESHOLD_LOG is 0.50", () => {
    assert.equal(cost.THRESHOLD_LOG, 0.50);
  });

  it("C4: THRESHOLD_WARN is 0.80", () => {
    assert.equal(cost.THRESHOLD_WARN, 0.80);
  });

  it("C5: THRESHOLD_STOP is 1.00", () => {
    assert.equal(cost.THRESHOLD_STOP, 1.00);
  });
});

// ---------------------------------------------------------------------------
// T: _estimateTokensFromText
// ---------------------------------------------------------------------------
describe("_estimateTokensFromText", () => {
  it("T1: empty string returns 1", () => {
    assert.equal(cost._estimateTokensFromText(""), 1);
  });

  it("T2: null returns 1", () => {
    assert.equal(cost._estimateTokensFromText(null), 1);
  });

  it("T3: undefined returns 1", () => {
    assert.equal(cost._estimateTokensFromText(undefined), 1);
  });

  it("T4: pure ASCII text estimation (length / 4)", () => {
    // 40 ASCII chars / 4 = 10 tokens
    const text = "a".repeat(40);
    const result = cost._estimateTokensFromText(text);
    assert.equal(result, 10);
  });

  it("T5: pure CJK text estimation (length / 1.5)", () => {
    // 15 CJK chars / 1.5 = 10 tokens
    const text = "\u3042".repeat(15); // hiragana 'a'
    const result = cost._estimateTokensFromText(text);
    assert.equal(result, 10);
  });

  it("T6: mixed ASCII + CJK text uses weighted average", () => {
    // 20 ASCII + 10 CJK = 30 total chars
    // cjkRatio = 10/30 = 1/3
    // effectiveRate = (1/3)*1.5 + (2/3)*4 = 0.5 + 2.6667 = 3.1667
    // tokens = floor(30 / 3.1667) = floor(9.47) = 9
    const text = "a".repeat(20) + "\u3042".repeat(10);
    const result = cost._estimateTokensFromText(text);
    assert.equal(result, 9);
  });

  it("T7: always returns >= 1 even for very short text", () => {
    // 1 ASCII char / 4 = 0.25 -> floor = 0, but max(1, 0) = 1
    assert.equal(cost._estimateTokensFromText("x"), 1);
    assert.equal(cost._estimateTokensFromText("ab"), 1);
    assert.equal(cost._estimateTokensFromText("abc"), 1);
  });
});

// ---------------------------------------------------------------------------
// E: estimateTokens
// ---------------------------------------------------------------------------
describe("estimateTokens", () => {
  it("E1: with explicit usage data in toolResponse returns exact values", () => {
    const toolInput = { command: "test" };
    const toolResponse = {
      usage: { input_tokens: 100, output_tokens: 200 },
    };
    const [inp, out] = cost.estimateTokens(toolInput, toolResponse);
    assert.equal(inp, 100);
    assert.equal(out, 200);
  });

  it("E2: with token_usage field instead of usage", () => {
    const toolInput = { command: "test" };
    const toolResponse = {
      token_usage: { input: 150, output: 250 },
    };
    const [inp, out] = cost.estimateTokens(toolInput, toolResponse);
    assert.equal(inp, 150);
    assert.equal(out, 250);
  });

  it("E3: without explicit data estimates from content size (string)", () => {
    const toolInput = { file_path: "/some/path/to/file.txt" };
    const toolResponse = {
      content: "Hello World from the tool response content",
    };
    const [inp, out] = cost.estimateTokens(toolInput, toolResponse);
    assert.ok(inp >= 1, "input tokens should be >= 1");
    assert.ok(out >= 1, "output tokens should be >= 1");
    // Input is JSON.stringify of toolInput, output is the string content
    const expectedInput = cost._estimateTokensFromText(
      JSON.stringify(toolInput)
    );
    const expectedOutput = cost._estimateTokensFromText(toolResponse.content);
    assert.equal(inp, expectedInput);
    assert.equal(out, expectedOutput);
  });

  it("E4: toolResponse with array content", () => {
    const toolInput = { query: "search" };
    const toolResponse = {
      content: ["line one", "line two", "line three"],
    };
    const [inp, out] = cost.estimateTokens(toolInput, toolResponse);
    assert.ok(inp >= 1);
    assert.ok(out >= 1);
    // Array content should be JSON.stringify'd
    const expectedOutput = cost._estimateTokensFromText(
      JSON.stringify(toolResponse.content)
    );
    assert.equal(out, expectedOutput);
  });

  it("E5: toolResponse with no content field", () => {
    const toolInput = { action: "run" };
    const toolResponse = {};
    const [inp, out] = cost.estimateTokens(toolInput, toolResponse);
    assert.ok(inp >= 1, "input tokens should still be estimated");
    // No content -> empty string -> 1
    assert.equal(out, 1);
  });

  it("E6: toolResponse with output field (fallback)", () => {
    const toolInput = { command: "ls" };
    const toolResponse = {
      output: "file1.txt\nfile2.txt\nfile3.txt",
    };
    const [inp, out] = cost.estimateTokens(toolInput, toolResponse);
    assert.ok(inp >= 1);
    const expectedOutput = cost._estimateTokensFromText(toolResponse.output);
    assert.equal(out, expectedOutput);
  });
});

// ---------------------------------------------------------------------------
// P: calcPercent
// ---------------------------------------------------------------------------
describe("calcPercent", () => {
  it("P1: normal usage calculation", () => {
    const usage = { input: 100000, output: 50000, budget: 500000 };
    const result = cost.calcPercent(usage);
    assert.equal(result, 0.3);
  });

  it("P2: budget 0 falls back to default 500000", () => {
    // budget=0 is falsy, so the implementation uses default 500000
    const usage = { input: 100, output: 200, budget: 0 };
    const result = cost.calcPercent(usage);
    assert.equal(result, 300 / 500000);
  });

  it("P2b: negative budget returns 0.0", () => {
    const usage = { input: 100, output: 200, budget: -1 };
    const result = cost.calcPercent(usage);
    assert.equal(result, 0.0);
  });

  it("P3: 50% usage", () => {
    const usage = { input: 150000, output: 100000, budget: 500000 };
    const result = cost.calcPercent(usage);
    assert.equal(result, 0.5);
  });

  it("P4: 100% usage", () => {
    const usage = { input: 300000, output: 200000, budget: 500000 };
    const result = cost.calcPercent(usage);
    assert.equal(result, 1.0);
  });

  it("P5: over 100% usage", () => {
    const usage = { input: 400000, output: 300000, budget: 500000 };
    const result = cost.calcPercent(usage);
    assert.equal(result, 1.4);
  });
});

// ---------------------------------------------------------------------------
// W: buildWarningMessage
// ---------------------------------------------------------------------------
describe("buildWarningMessage", () => {
  it("W1: below THRESHOLD_STOP returns warning message", () => {
    const usage = { input: 300000, output: 100000, budget: 500000 };
    const msg = cost.buildWarningMessage(0.80, usage);
    // Should contain warning text (not exceeded)
    assert.ok(msg.includes("80.0%"), "should contain percentage");
    // Should mention remaining tokens
    assert.ok(msg.includes("100,000"), "should mention remaining tokens");
    // Should contain Japanese text about efficiency
    assert.ok(
      msg.includes("\u52b9\u7387\u7684"),
      "should contain efficiency advice"
    );
  });

  it("W2: at THRESHOLD_STOP returns exceeded message", () => {
    const usage = { input: 300000, output: 200000, budget: 500000 };
    const msg = cost.buildWarningMessage(1.00, usage);
    assert.ok(msg.includes("100.0%"), "should contain 100.0%");
    // Should contain exceeded text about completing session
    assert.ok(
      msg.includes("\u4e0a\u9650"),
      "should contain exceeded indicator"
    );
    assert.ok(
      msg.includes("\u30bb\u30c3\u30b7\u30e7\u30f3"),
      "should mention session"
    );
  });

  it("W3: above THRESHOLD_STOP returns exceeded message", () => {
    const usage = { input: 400000, output: 300000, budget: 500000 };
    const msg = cost.buildWarningMessage(1.40, usage);
    assert.ok(msg.includes("140.0%"), "should contain 140.0%");
    assert.ok(
      msg.includes("\u4e0a\u9650"),
      "should contain exceeded indicator"
    );
  });

  it("W4: message contains Japanese text", () => {
    const usage = { input: 200000, output: 200000, budget: 500000 };
    const msg = cost.buildWarningMessage(0.80, usage);
    // Should contain at least some Japanese characters
    assert.ok(
      msg.includes("\u30c8\u30fc\u30af\u30f3"),
      "should contain the word 'token' in Japanese"
    );
    assert.ok(
      msg.includes("\u4e88\u7b97"),
      "should contain the word 'budget' in Japanese"
    );
  });
});

// ---------------------------------------------------------------------------
// H: handler
// ---------------------------------------------------------------------------
describe("handler", () => {
  it("H1: returns null when no session active", () => {
    // handler calls session.loadSession() which returns null when no veil
    // We verify that handler returns null without crashing
    const result = cost.handler({
      tool_name: "Read",
      tool_input: { file_path: "/test" },
      tool_response: { content: "test content" },
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// X: Module exports verification
// ---------------------------------------------------------------------------
describe("Module exports", () => {
  it("X1: all expected exports exist", () => {
    const expectedExports = [
      "CHARS_PER_TOKEN_ASCII",
      "CHARS_PER_TOKEN_CJK",
      "THRESHOLD_LOG",
      "THRESHOLD_WARN",
      "THRESHOLD_STOP",
      "_estimateTokensFromText",
      "estimateTokens",
      "calcPercent",
      "buildWarningMessage",
      "handler",
    ];

    for (const name of expectedExports) {
      assert.ok(
        name in cost,
        `expected export '${name}' should exist in module`
      );
    }

    // Verify types
    assert.equal(typeof cost.CHARS_PER_TOKEN_ASCII, "number");
    assert.equal(typeof cost.CHARS_PER_TOKEN_CJK, "number");
    assert.equal(typeof cost.THRESHOLD_LOG, "number");
    assert.equal(typeof cost.THRESHOLD_WARN, "number");
    assert.equal(typeof cost.THRESHOLD_STOP, "number");
    assert.equal(typeof cost._estimateTokensFromText, "function");
    assert.equal(typeof cost.estimateTokens, "function");
    assert.equal(typeof cost.calcPercent, "function");
    assert.equal(typeof cost.buildWarningMessage, "function");
    assert.equal(typeof cost.handler, "function");
  });
});
