"use strict";
/**
 * PostToolUse hook: tobari-cost — the cost monitor.
 *
 * Fires after each tool completion (PostToolUse = non-blocking).
 *
 * When the veil is active:
 * - Estimates token usage from tool input/output content size
 * - Atomically updates token_usage in tobari-session.json
 * - Checks budget thresholds:
 *     50%  -> logs to evidence ledger only (silent)
 *     80%  -> warns user via hookSpecificOutput.feedback
 *     100% -> strong warning + budget_exceeded event in evidence
 *
 * When the veil is inactive: returns null (no interference).
 *
 * Design:
 * - Fail-open: hook errors never block tool execution
 * - Non-blocking: PostToolUse hooks run after tool completion
 */

const session = require("./tobari-session.js");
const { t } = require("./tobari-i18n.js");

// Token estimation rates (chars per token)
const CHARS_PER_TOKEN_ASCII = 4;
const CHARS_PER_TOKEN_CJK = 1.5;

// Budget thresholds
const THRESHOLD_LOG = 0.50;
const THRESHOLD_WARN = 0.80;
const THRESHOLD_STOP = 1.00;

/**
 * Estimate token count from text using CJK-weighted average.
 * @param {string} text
 * @returns {number}
 */
function _estimateTokensFromText(text) {
  if (!text || text.length === 0) return 1;

  const totalCount = text.length;
  let cjkCount = 0;

  for (let i = 0; i < totalCount; i++) {
    const cp = text.codePointAt(i);
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
      (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
      (cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
      (cp >= 0xac00 && cp <= 0xd7af)    // Hangul
    ) {
      cjkCount++;
    }
    // Skip surrogate pair second code unit
    if (cp > 0xffff) i++;
  }

  const cjkRatio = cjkCount / totalCount;
  const effectiveRate =
    cjkRatio * CHARS_PER_TOKEN_CJK + (1 - cjkRatio) * CHARS_PER_TOKEN_ASCII;

  return Math.max(1, Math.floor(totalCount / effectiveRate));
}

/**
 * Estimate input/output tokens from tool data.
 * @param {object} toolInput
 * @param {object} toolResponse
 * @returns {[number, number]} [inputTokens, outputTokens]
 */
function estimateTokens(toolInput, toolResponse) {
  // Check for explicit usage data
  const usage = toolResponse.usage || toolResponse.token_usage;
  if (usage && typeof usage === "object") {
    const inTok = usage.input_tokens || usage.input || 0;
    const outTok = usage.output_tokens || usage.output || 0;
    if (inTok > 0 || outTok > 0) {
      return [Math.floor(inTok), Math.floor(outTok)];
    }
  }

  // Estimate from content size
  const inputText = JSON.stringify(toolInput);
  const content =
    toolResponse.content || toolResponse.output || toolResponse.stdout || "";
  let outputText;
  if (typeof content === "string") {
    outputText = content;
  } else if (Array.isArray(content)) {
    outputText = JSON.stringify(content);
  } else {
    outputText = "";
  }

  return [
    _estimateTokensFromText(inputText),
    _estimateTokensFromText(outputText),
  ];
}

/**
 * Calculate budget usage as a fraction (0.0 - N.N).
 * @param {object} usage - {input, output, budget}
 * @returns {number}
 */
function calcPercent(usage) {
  const total = (usage.input || 0) + (usage.output || 0);
  const budget = usage.budget || 500000;
  if (budget <= 0) return 0.0;
  return total / budget;
}

/**
 * Build localized warning message for budget threshold.
 * @param {number} percent
 * @param {object} usage
 * @returns {string}
 */
function buildWarningMessage(percent, usage) {
  const total = (usage.input || 0) + (usage.output || 0);
  const budget = usage.budget || 0;
  const remaining = Math.max(0, budget - total);
  const pct = (percent * 100).toFixed(1);

  if (percent >= THRESHOLD_STOP) {
    return (
      t("cost.budget_exceeded", { pct }) + "\n" +
      t("cost.budget_exceeded_detail", { total: total.toLocaleString(), budget: budget.toLocaleString() }) + "\n" +
      t("cost.budget_exceeded_action")
    );
  }
  return (
    t("cost.budget_warning", { pct }) + "\n" +
    t("cost.budget_warning_detail", { remaining: remaining.toLocaleString(), budget: budget.toLocaleString() }) + "\n" +
    t("cost.budget_warning_action")
  );
}

/**
 * PostToolUse hook handler: track token usage and check budget thresholds.
 * @param {object} data - Hook input with tool_name, tool_input, tool_response
 * @returns {object|null}
 */
function handler(data) {
  const toolName = data.tool_name || "";
  const toolInput = data.tool_input || {};
  const toolResponse = data.tool_response || {};

  // Only track when veil is active
  const sess = session.loadSession();
  if (!sess) return null;

  // Estimate token usage for this tool call
  const [deltaInput, deltaOutput] = estimateTokens(toolInput, toolResponse);

  // Atomically update session token_usage
  const updated = session.updateTokenUsage(deltaInput, deltaOutput);
  if (!updated) return null;

  const percent = calcPercent(updated);

  // Threshold routing
  if (percent >= THRESHOLD_STOP) {
    session.writeEvidence({
      event: "budget_exceeded",
      tool_name: toolName,
      token_usage: updated,
      percent: Math.round(percent * 1000) / 10,
    });
    return {
      hookSpecificOutput: {
        feedback: buildWarningMessage(percent, updated),
      },
    };
  }

  if (percent >= THRESHOLD_WARN) {
    session.writeEvidence({
      event: "budget_warning",
      tool_name: toolName,
      token_usage: updated,
      percent: Math.round(percent * 1000) / 10,
    });
    return {
      hookSpecificOutput: {
        feedback: buildWarningMessage(percent, updated),
      },
    };
  }

  if (percent >= THRESHOLD_LOG) {
    session.writeEvidence({
      event: "budget_halfway",
      tool_name: toolName,
      token_usage: updated,
      percent: Math.round(percent * 1000) / 10,
    });
  }

  return null;
}

// CLI entry point
if (require.main === module) {
  session.runHook(handler);
}

module.exports = {
  CHARS_PER_TOKEN_ASCII,
  CHARS_PER_TOKEN_CJK,
  THRESHOLD_LOG,
  THRESHOLD_WARN,
  THRESHOLD_STOP,
  _estimateTokensFromText,
  estimateTokens,
  calcPercent,
  buildWarningMessage,
  handler,
};
