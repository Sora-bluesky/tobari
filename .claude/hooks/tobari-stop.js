#!/usr/bin/env node
"use strict";
/**
 * Stop hook: tobari-stop — the self-repair engine (tobari no ashi).
 *
 * Self-Repair Engine — Leg (Stop Hook + Circuit Breaker)
 *
 * Fires when Claude Code is about to stop (finish responding).
 *
 * When the veil is active and test failure is detected:
 * - retry_count < MAX_RETRIES  -> decision: "block" + inject repair instructions
 * - retry_count >= MAX_RETRIES -> Circuit Breaker fires, allow stop, report to user
 *
 * When the veil is inactive or no test failure detected:
 * - return null (no interference)
 *
 * Node.js port of tobari-stop.py (v1.1.0 migration).
 * Implements the ashi (self-repair) design.
 */

const fs = require("fs");
const path = require("path");
const tobariSession = require("./tobari-session.js");
const { t } = require("./tobari-i18n.js");

// ---------------------------------------------------------------------------
// Evidence Summary Writer
// ---------------------------------------------------------------------------

/**
 * Build concise evidence items from the ledger summary.
 *
 * Converts the flat summary object into a structured array suitable
 * for the tobari-session.json evidence field.
 *
 * @param {Object} summary - Output from summarizeEvidence()
 * @returns {Object[]} Array of evidence items
 */
function _buildEvidenceItems(summary) {
  const items = [];
  const events = summary.events || {};
  const tools = summary.tools || {};
  const qg = summary.quality_gate_counts || {};

  if (events.session_start) {
    items.push({ type: "session_start", count: events.session_start });
  }
  if (events.tool_complete) {
    items.push({ type: "tool_complete", count: events.tool_complete });
  }
  if (events.tool_denied) {
    items.push({ type: "tool_denied", count: events.tool_denied });
  }
  if (events.tool_failed) {
    items.push({ type: "tool_failed", count: events.tool_failed });
  }
  if (events.stop_audit) {
    items.push({ type: "stop_audit", count: events.stop_audit });
  }
  if (events.self_repair_attempt) {
    items.push({
      type: "self_repair_attempt",
      count: events.self_repair_attempt,
    });
  }

  // Top 5 tools by usage
  const topTools = Object.entries(tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ tool: name, count }));
  if (topTools.length > 0) {
    items.push({ type: "top_tools", tools: topTools });
  }

  if (qg.blocking > 0 || qg.high > 0) {
    items.push({
      type: "quality_gates",
      blocking: qg.blocking,
      high: qg.high,
    });
  }

  items.push({ type: "total_entries", count: summary.total || 0 });

  return items;
}

/**
 * Update the evidence array in tobari-session.json with current ledger summary.
 *
 * Replaces (not appends) the evidence array so it always reflects current state.
 * Uses file lock for safe concurrent access.
 * Fail-open: errors are logged but never block stop.
 */
function _updateSessionEvidence() {
  try {
    const summary = tobariSession.summarizeEvidence();
    const evidenceItems = _buildEvidenceItems(summary);

    const sessionPath = tobariSession.getSessionPath();
    tobariSession.withFileLock(sessionPath, () => {
      const raw = fs.readFileSync(sessionPath, "utf8");
      const data = JSON.parse(raw);

      if (typeof data === "object" && data !== null && data.active) {
        data.evidence = evidenceItems;
        fs.writeFileSync(
          sessionPath,
          JSON.stringify(data, null, 2) + "\n",
          "utf8",
        );
      }
    });
  } catch (e) {
    // Fail-open: evidence update failure must not block stop
    process.stderr.write(
      `[tobari] WARNING: Evidence summary update failed: ${e.message}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;

/**
 * Test failure indicators in transcript messages.
 * Compiled RegExp with case-insensitive flag.
 */
const FAILURE_PATTERNS = [
  /\bFAILED\b/i,
  /\b\d+\s+failed\b/i,
  /AssertionError/i,
  /AssertionError/i, // kept for backward compat (Python had typo)
  /ERRORS?\s*:\s/i,
  /\u30c6\u30b9\u30c8\u5931\u6557/i, // テスト失敗
  /test.*fail/i,
  /returncode=[1-9]\d*/i,
  /exit\s+code\s+[1-9]/i,
  /Command\s+failed/i,
  /Traceback \(most recent call last\)/i,
  /Error: .*/i,
];

/**
 * Success indicators — if present in an entry, assume outcome is success.
 * Compiled RegExp with case-insensitive flag.
 */
const SUCCESS_PATTERNS = [
  /\b\d+\s+passed\b/i,
  /\ball\s+test.*pass/i,
  /\btests?\s+passed\b/i,
  /\bOK\b.*\d+.*test/i,
  /\u30c6\u30b9\u30c8.*\u6210\u529f/i, // テスト.*成功
  /\u4fee\u6b63\u5b8c\u4e86/i, // 修正完了
  /\u5b9f\u88c5\u5b8c\u4e86/i, // 実装完了
  /\bPASSED\b/i,
  /\u2713\s+\d+/i, // ✓ \d+
];

// ---------------------------------------------------------------------------
// Text Extraction
// ---------------------------------------------------------------------------

/**
 * Extract plain text from various content shapes.
 *
 * Handles:
 * - string -> returns as-is
 * - array of strings/objects -> joins with newline
 * - object with type:"text" or "text" field
 * - anything else -> empty string
 *
 * @param {*} content - Content from a transcript message.
 * @returns {string}
 */
function _extractText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (typeof item === "object" && item !== null) {
        if (item.type === "text") {
          parts.push(item.text || "");
        } else if ("text" in item) {
          parts.push(String(item.text));
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Get text from a single transcript message.
 *
 * @param {Object} message - Transcript message dict.
 * @returns {string}
 */
function _messageText(message) {
  return _extractText(message.content || "");
}

// ---------------------------------------------------------------------------
// Failure Detection
// ---------------------------------------------------------------------------

/**
 * Detect test failure in recent transcript entries.
 *
 * Scans from most recent to oldest (up to 8 entries).
 * Returns [isFailure, failureSummary].
 *
 * Design:
 * - If the most recent entry with recognisable content shows success -> false
 * - If it shows failure -> true + extract snippet
 * - If neither -> continue scanning backwards
 *
 * @param {Array} transcript - Array of transcript message dicts.
 * @returns {[boolean, string]}
 */
function detectTestFailure(transcript) {
  if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
    return [false, ""];
  }

  const recent = transcript.slice(-8);
  const failureSnippets = [];

  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const text = _messageText(entry);
    if (!text.trim()) {
      continue;
    }

    // Check both patterns per entry — failure takes precedence over success.
    // "1 failed, 2 passed" -> failure (not pure success).
    const hasFailure = FAILURE_PATTERNS.some((p) => p.test(text));
    const hasSuccess =
      !hasFailure && SUCCESS_PATTERNS.some((p) => p.test(text));

    if (hasFailure) {
      // Extract representative snippet
      const lines = text.split("\n");
      for (const pattern of FAILURE_PATTERNS) {
        if (pattern.test(text)) {
          for (const line of lines.slice(0, 50)) {
            if (pattern.test(line)) {
              const snippet = line.trim().slice(0, 200);
              if (snippet && !failureSnippets.includes(snippet)) {
                failureSnippets.push(snippet);
              }
            }
          }
          break;
        }
      }
      const summary =
        failureSnippets.length > 0
          ? failureSnippets.slice(0, 5).join("\n")
          : t("stop.fallback_summary");
      return [true, summary];
    }

    if (hasSuccess) {
      // Pure success in this entry -> most recent outcome is success
      return [false, ""];
    }
  }

  return [false, ""];
}

// ---------------------------------------------------------------------------
// Transcript Loading
// ---------------------------------------------------------------------------

/**
 * Load transcript from hook input data.
 *
 * Supports both inline 'transcript' array and 'transcript_path' file.
 *
 * @param {Object} data - Hook input data.
 * @returns {Array}
 */
function _loadTranscript(data) {
  const inline = data.transcript;
  if (Array.isArray(inline)) {
    return inline;
  }

  const transcriptPath = data.transcript_path;
  if (transcriptPath) {
    try {
      const raw = fs.readFileSync(transcriptPath, "utf8");
      const content = JSON.parse(raw);
      if (Array.isArray(content)) {
        return content;
      }
      if (typeof content === "object" && content !== null) {
        return content.messages || content.transcript || [];
      }
    } catch (_) {
      // File read or parse error — fall through
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// A9: Last Assistant Message Extraction
// ---------------------------------------------------------------------------

/**
 * Extract the last assistant message text from transcript.
 *
 * @param {Array} transcript - Array of transcript message dicts.
 * @returns {string|null} Text of last assistant message, or null.
 */
function _getLastAssistantMessage(transcript) {
  if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
    return null;
  }
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i];
    if (
      typeof entry === "object" &&
      entry !== null &&
      entry.role === "assistant"
    ) {
      const text = _messageText(entry);
      if (text.trim()) {
        return text;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Message Builders
// ---------------------------------------------------------------------------

/**
 * Build Japanese repair instruction injected into Claude.
 *
 * @param {number} retryCount - Current retry count (before increment).
 * @param {string} failureSummary - Detected failure text.
 * @param {string} task - Current task name.
 * @returns {string}
 */
function _makeRepairInstruction(retryCount, failureSummary, task) {
  const attempt = retryCount + 1;
  return (
    t("stop.repair.header", { task, attempt, max: MAX_RETRIES }) + "\n\n" +
    t("stop.repair.errors", { summary: failureSummary }) + "\n\n" +
    t("stop.repair.instruction") + "\n" +
    t("stop.repair.step1") + "\n" +
    t("stop.repair.step2") + "\n" +
    t("stop.repair.step3")
  );
  // 🦿 帳 [{task}] — テスト失敗を検出（試行 {attempt}/{MAX_RETRIES}）
  // 検出されたエラー:
  // {failureSummary}
  //
  // 自動修復を実行してください:
  // 1. エラーメッセージを分析して根本原因を特定
  // 2. 該当するコードを修正
  // 3. テストを再実行して成功を確認
}

/**
 * Build Japanese Circuit Breaker escalation message.
 *
 * @param {string} failureSummary - Detected failure text.
 * @param {string} task - Current task name.
 * @returns {string}
 */
function _makeCircuitBreakerMessage(failureSummary, task) {
  return (
    t("stop.circuit.header", { task, max: MAX_RETRIES }) + "\n\n" +
    t("stop.circuit.last_error", { summary: failureSummary }) + "\n\n" +
    t("stop.circuit.manual") + "\n" +
    t("stop.circuit.step1") + "\n" +
    t("stop.circuit.step2") + "\n" +
    t("stop.circuit.step3")
  );
  // ⚠️ 帳 [{task}] — 自己修復の限界に達しました（{MAX_RETRIES}/{MAX_RETRIES}回失敗）
  //
  // 最後に検出されたエラー:
  // {failureSummary}
  //
  // 手動での対応が必要です:
  // 1. エラーの詳細を確認: .claude/logs/evidence-ledger.jsonl
  // 2. テストファイルを直接確認して問題を特定
  // 3. 修正後に作業を再開してください
}

// ---------------------------------------------------------------------------
// Hook Handler
// ---------------------------------------------------------------------------

/**
 * Stop hook handler.
 *
 * @param {Object} data - Hook input data from Claude Code.
 * @returns {Object|null} Block decision or null (allow stop).
 */
function handler(data) {
  // stop_hook_active guard: prevent infinite loops
  if (data.stop_hook_active) {
    return null;
  }

  // Veil inactive: no interference
  const session = tobariSession.loadSession();
  if (!session) {
    return null;
  }

  const task = tobariSession.getTask() || "unknown";

  // Update evidence array in session file with current ledger summary
  _updateSessionEvidence();

  // Analyse transcript for test failures
  const transcript = _loadTranscript(data);

  // A9: Record last assistant message to evidence trail
  const lastAssistantMsg = _getLastAssistantMessage(transcript);
  if (lastAssistantMsg) {
    tobariSession.writeEvidence({
      event: "stop_audit",
      task: task,
      last_assistant_message: lastAssistantMsg.slice(0, 2000),
    });
  }

  const [isFailure, failureSummary] = detectTestFailure(transcript);

  if (!isFailure) {
    return null;
  }

  // Test failure detected — apply Circuit Breaker logic
  const retryCount = tobariSession.getRetryCount();

  if (retryCount < MAX_RETRIES) {
    // Block stop and inject repair instructions
    tobariSession.setRetryCount(retryCount + 1);
    tobariSession.writeEvidence({
      event: "self_repair_attempt",
      attempt: retryCount + 1,
      max_retries: MAX_RETRIES,
      task: task,
      failure_summary: failureSummary.slice(0, 500),
    });
    const reason = _makeRepairInstruction(retryCount, failureSummary, task);
    return { decision: "block", reason: reason };
  } else {
    // Circuit Breaker triggered — finalize session and allow stop
    tobariSession.finalizeSession("circuit-breaker stop");
    tobariSession.writeEvidence({
      event: "circuit_breaker_triggered",
      attempts: MAX_RETRIES,
      task: task,
      failure_summary: failureSummary.slice(0, 500),
    });

    // Optional emergency webhook
    const webhookUrl = tobariSession.getWebhookConfig(session);
    if (webhookUrl) {
      tobariSession.sendWebhook(webhookUrl, {
        event: "circuit_breaker_triggered",
        task: task,
        attempts: MAX_RETRIES,
        failure_summary: failureSummary.slice(0, 200),
      });
    }

    // Surface Circuit Breaker message to user via stderr
    process.stderr.write(
      _makeCircuitBreakerMessage(failureSummary, task) + "\n"
    );
    return null; // allow stop
  }
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

if (require.main === module) {
  tobariSession.runHook(handler);
}

// ---------------------------------------------------------------------------
// Exports (for testing)
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  MAX_RETRIES,
  FAILURE_PATTERNS,
  SUCCESS_PATTERNS,

  // Text extraction
  _extractText,
  _messageText,

  // Failure detection
  detectTestFailure,
  _getLastAssistantMessage,

  // Transcript loading
  _loadTranscript,

  // Message builders
  _makeRepairInstruction,
  _makeCircuitBreakerMessage,

  // Evidence summary
  _buildEvidenceItems,
  _updateSessionEvidence,

  // Handler
  handler,
};
