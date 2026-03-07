#!/usr/bin/env node
"use strict";
/**
 * Stop hook: tobari-stop — the self-repair engine (tobari no ashi).
 *
 * OPS-026: Self-Repair Engine — Leg (Stop Hook + Circuit Breaker)
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
 * Implements docs/24 section-7 ashi design.
 */

const fs = require("fs");
const path = require("path");
const tobariSession = require("./tobari-session.js");

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
          : "\u30c6\u30b9\u30c8\u5931\u6557\u3092\u691c\u51fa"; // テスト失敗を検出
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
    `\uD83E\uDDBF \u5E33 [${task}] \u2014 \u30c6\u30b9\u30c8\u5931\u6557\u3092\u691c\u51fa\uFF08\u8A66\u884C ${attempt}/${MAX_RETRIES}\uFF09\n\n` +
    `\u691c\u51fa\u3055\u308c\u305f\u30a8\u30e9\u30fc:\n${failureSummary}\n\n` +
    `\u81ea\u52d5\u4fee\u5fa9\u3092\u5b9f\u884c\u3057\u3066\u304f\u3060\u3055\u3044:\n` +
    `1. \u30a8\u30e9\u30fc\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u5206\u6790\u3057\u3066\u6839\u672c\u539f\u56e0\u3092\u7279\u5b9a\n` +
    `2. \u8a72\u5f53\u3059\u308b\u30b3\u30fc\u30c9\u3092\u4fee\u6b63\n` +
    `3. \u30c6\u30b9\u30c8\u3092\u518d\u5b9f\u884c\u3057\u3066\u6210\u529f\u3092\u78ba\u8a8d`
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
    `\u26a0\ufe0f \u5e33 [${task}] \u2014 \u81ea\u5df1\u4fee\u5fa9\u306e\u9650\u754c\u306b\u9054\u3057\u307e\u3057\u305f` +
    `\uFF08${MAX_RETRIES}/${MAX_RETRIES}\u56de\u5931\u6557\uFF09\n\n` +
    `\u6700\u5f8c\u306b\u691c\u51fa\u3055\u308c\u305f\u30a8\u30e9\u30fc:\n${failureSummary}\n\n` +
    `\u624b\u52d5\u3067\u306e\u5bfe\u5fdc\u304c\u5fc5\u8981\u3067\u3059:\n` +
    `1. \u30a8\u30e9\u30fc\u306e\u8a73\u7d30\u3092\u78ba\u8a8d: .claude/logs/evidence-ledger.jsonl\n` +
    `2. \u30c6\u30b9\u30c8\u30d5\u30a1\u30a4\u30eb\u3092\u76f4\u63a5\u78ba\u8a8d\u3057\u3066\u554f\u984c\u3092\u7279\u5b9a\n` +
    `3. \u4fee\u6b63\u5f8c\u306b\u4f5c\u696d\u3092\u518d\u958b\u3057\u3066\u304f\u3060\u3055\u3044`
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

  // Analyse transcript for test failures
  const transcript = _loadTranscript(data);
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

  // Transcript loading
  _loadTranscript,

  // Message builders
  _makeRepairInstruction,
  _makeCircuitBreakerMessage,

  // Handler
  handler,
};
