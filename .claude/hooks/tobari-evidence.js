"use strict";
/**
 * PostToolUse hook: Evidence Ledger — the eye of tobari.
 *
 * Records all tool operations to .claude/logs/evidence-ledger.jsonl
 * while the veil is active.
 *
 * Implements the "残す" (record everything) pillar.
 *
 * Also provides CLI for querying the ledger:
 *     node tobari-evidence.js summary
 *     node tobari-evidence.js quality-gates
 *     node tobari-evidence.js verify
 *
 * Design:
 * - Fail-open: hook errors never block tool execution
 * - Efficient: minimal processing, append-only JSONL
 * - Smart summarization: truncates large inputs/outputs
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const session = require("./tobari-session.js");

// --- Constants ---

const MAX_SUMMARY_LENGTH = 200;
const MAX_RESPONSE_LENGTH = 500;

// --- Input Summarizers ---

function _summarizeBash(toolInput) {
  const command = toolInput.command || "";
  return {
    command:
      command.length > MAX_SUMMARY_LENGTH
        ? command.slice(0, MAX_SUMMARY_LENGTH) + "..."
        : command,
  };
}

function _summarizeEdit(toolInput) {
  const oldStr = toolInput.old_string || "";
  const newStr = toolInput.new_string || "";
  return {
    file_path: toolInput.file_path || "",
    old_size: oldStr.length,
    new_size: newStr.length,
    replace_all: toolInput.replace_all || false,
  };
}

function _summarizeWrite(toolInput) {
  return {
    file_path: toolInput.file_path || "",
    content_size: (toolInput.content || "").length,
  };
}

function _summarizeRead(toolInput) {
  const summary = { file_path: toolInput.file_path || "" };
  if (toolInput.offset != null) summary.offset = toolInput.offset;
  if (toolInput.limit != null) summary.limit = toolInput.limit;
  return summary;
}

function _summarizeGrep(toolInput) {
  return {
    pattern: toolInput.pattern || "",
    path: toolInput.path || "",
    glob: toolInput.glob || "",
  };
}

function _summarizeGlob(toolInput) {
  return {
    pattern: toolInput.pattern || "",
    path: toolInput.path || "",
  };
}

function _summarizeWeb(toolInput) {
  const prompt = toolInput.prompt || "";
  return {
    url: toolInput.url || "",
    query: toolInput.query || "",
    prompt:
      prompt.length > MAX_SUMMARY_LENGTH
        ? prompt.slice(0, MAX_SUMMARY_LENGTH)
        : prompt,
  };
}

function _summarizeTask(toolInput) {
  return {
    description: toolInput.description || "",
    subagent_type: toolInput.subagent_type || "",
  };
}

function _summarizeGeneric(toolInput) {
  const raw = JSON.stringify(toolInput);
  return {
    raw:
      raw.length > MAX_SUMMARY_LENGTH
        ? raw.slice(0, MAX_SUMMARY_LENGTH) + "..."
        : raw,
  };
}

const _SUMMARIZERS = {
  Bash: _summarizeBash,
  Edit: _summarizeEdit,
  Write: _summarizeWrite,
  Read: _summarizeRead,
  Grep: _summarizeGrep,
  Glob: _summarizeGlob,
  WebFetch: _summarizeWeb,
  WebSearch: _summarizeWeb,
  Task: _summarizeTask,
};

/**
 * Create a compact summary of tool input.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {object}
 */
function summarizeToolInput(toolName, toolInput) {
  const summarizer = _SUMMARIZERS[toolName] || _summarizeGeneric;
  return summarizer(toolInput || {});
}

/**
 * Create a compact summary of tool response.
 * @param {object} toolResponse
 * @returns {object}
 */
function summarizeToolResponse(toolResponse) {
  const summary = {};

  if (toolResponse.exit_code != null) {
    summary.exit_code = toolResponse.exit_code;
    summary.success = toolResponse.exit_code === 0;
  }

  const content = toolResponse.content || toolResponse.stdout || "";
  if (typeof content === "string") {
    summary.output_size = content.length;
  } else if (Array.isArray(content)) {
    summary.output_items = content.length;
  }

  return summary;
}

/**
 * Determine the current gate from session gates_passed.
 * @param {object} sess
 * @returns {string}
 */
function _getCurrentGate(sess) {
  const gatesPassed = sess.gates_passed || [];
  const allGates = ["STG0", "STG1", "STG2", "STG3", "STG4", "STG5", "STG6"];
  for (const gate of allGates) {
    if (!gatesPassed.includes(gate)) return gate;
  }
  return "complete";
}

// --- Hook Entry Point ---

/**
 * PostToolUse hook handler: record tool completion to evidence ledger.
 * @param {object} data - Hook input with tool_name, tool_input, tool_response
 * @returns {null} - Silent recording, no hookSpecificOutput
 */
function handler(data) {
  const toolName = data.tool_name || "";
  const toolInput = data.tool_input || {};
  const toolResponse = data.tool_response || {};

  // A8: Extract agent identification from hook input
  const agentId = data.agent_id || "";
  const agentType = data.agent_type || "";

  // Only record when veil is active
  const sess = session.loadSession();
  if (!sess) return null;

  // Build evidence entry
  const entry = {
    event: "tool_complete",
    tool_name: toolName,
    input_summary: summarizeToolInput(toolName, toolInput),
    response_summary: summarizeToolResponse(toolResponse),
    task: sess.task || "",
    profile: sess.profile || "",
    current_gate: _getCurrentGate(sess),
  };

  // A8: Record agent identification when present
  if (agentId || agentType) {
    entry.agent_id = agentId;
    entry.agent_type = agentType;
  }

  session.writeEvidence(entry);
  return null;
}

// --- CLI Entry Points ---

function cliSummary() {
  const summary = session.summarizeEvidence();
  console.log(JSON.stringify(summary, null, 2));
}

function cliQualityGates() {
  const summary = session.summarizeEvidence();
  const counts = summary.quality_gate_counts || {};
  console.log(JSON.stringify(counts, null, 2));
}

function cliVerify() {
  const evidencePath = session._getEvidencePath();
  if (!fs.existsSync(evidencePath)) {
    console.log("Evidence ledger not found.");
    return;
  }

  let rawLines;
  try {
    rawLines = fs
      .readFileSync(evidencePath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
  } catch (e) {
    console.log(`Cannot read evidence ledger: ${e.message}`);
    process.exit(1);
  }

  if (rawLines.length === 0) {
    console.log("Evidence ledger is empty.");
    return;
  }

  const hmacKey = session._getHmacKey();
  const errors = [];
  let prevHash = session.CHAIN_GENESIS_HASH;

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch (_) {
      errors.push(`Entry ${i}: invalid JSON`);
      prevHash = crypto.createHash("sha256").update(rawLine, "utf8").digest("hex");
      continue;
    }

    // Check chain index
    const actualIndex = entry._chain_index;
    if (actualIndex != null && actualIndex !== i) {
      errors.push(
        `Entry ${i}: chain_index mismatch (expected ${i}, got ${actualIndex})`
      );
    }

    // Check prev_hash
    const actualPrev = entry._prev_hash || "";
    if (actualPrev && actualPrev !== prevHash) {
      errors.push(`Entry ${i}: prev_hash mismatch`);
    }

    // Verify HMAC
    const actualHmac = entry._hmac;
    if (hmacKey && actualHmac) {
      const verifyEntry = {};
      for (const [k, v] of Object.entries(entry)) {
        if (k !== "_hmac") verifyEntry[k] = v;
      }
      const canonical = session._canonicalJson(verifyEntry);
      const expectedHmac = crypto
        .createHmac("sha256", hmacKey)
        .update(canonical, "utf8")
        .digest("hex");
      if (actualHmac !== expectedHmac) {
        errors.push(`Entry ${i}: HMAC verification failed`);
      }
    }

    prevHash = crypto.createHash("sha256").update(rawLine, "utf8").digest("hex");
  }

  if (errors.length > 0) {
    console.log(`FAIL: ${errors.length} integrity errors found:`);
    for (const err of errors) {
      console.log(`  - ${err}`);
    }
    process.exit(1);
  } else {
    const mode = hmacKey
      ? "HMAC + hash chain"
      : "hash chain only (no HMAC key)";
    console.log(`OK: ${rawLines.length} entries verified (${mode})`);
  }
}

// CLI or hook entry point
if (require.main === module) {
  const command = process.argv[2];
  if (command === "summary") {
    cliSummary();
  } else if (command === "quality-gates") {
    cliQualityGates();
  } else if (command === "verify") {
    cliVerify();
  } else if (command) {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.stderr.write(
      "Usage: node tobari-evidence.js [summary|quality-gates|verify]\n"
    );
    process.exit(1);
  } else {
    // Called as PostToolUse hook (stdin JSON)
    session.runHook(handler);
  }
}

module.exports = {
  MAX_SUMMARY_LENGTH,
  MAX_RESPONSE_LENGTH,
  summarizeToolInput,
  summarizeToolResponse,
  _getCurrentGate,
  handler,
  cliSummary,
  cliQualityGates,
  cliVerify,
};
