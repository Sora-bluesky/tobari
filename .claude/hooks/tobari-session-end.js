"use strict";

const fs = require("fs");
const {
  loadSession,
  writeEvidence,
  getEvidencePath,
  getGatesPassed,
  runHook,
} = require("./tobari-session.js");
const { t } = require("./tobari-i18n.js");

const GATE_ORDER = ["STG0", "STG1", "STG2", "STG3", "STG4", "STG5", "STG6"];

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function computeStats(evidencePath) {
  const stats = {
    total_tool_uses: 0,
    total_denials: 0,
    tool_counts: {},
    session_start_time: null,
  };

  if (!fs.existsSync(evidencePath)) return stats;

  let content;
  try {
    content = fs.readFileSync(evidencePath, "utf8");
  } catch (_) {
    return stats;
  }

  const lines = content.split("\n");
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) continue;

    let entry;
    try {
      entry = JSON.parse(stripped);
    } catch (_) {
      continue;
    }

    const event = entry.event || "";

    if (event === "session_start" && !stats.session_start_time) {
      stats.session_start_time = entry.timestamp || null;
    }

    if (event === "tool_use" || event === "tool_denied") {
      stats.total_tool_uses++;
      const tool = entry.tool_name || "unknown";
      stats.tool_counts[tool] = (stats.tool_counts[tool] || 0) + 1;
    }

    if (event === "tool_denied") {
      stats.total_denials++;
    }
  }

  return stats;
}

function getTopTools(toolCounts, n) {
  return Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => `${name}(${count})`)
    .join(", ");
}

function getIncompleteGates(gatesPassed) {
  return GATE_ORDER.filter((g) => !gatesPassed.includes(g));
}

function handler(data) {
  const sess = loadSession();
  if (!sess) {
    // Veil not active — exit silently
    return null;
  }

  const source = data.source || "other";
  const task = sess.task || "unknown";
  const profile = sess.profile || "standard";
  const gatesPassed = getGatesPassed();

  const evidencePath = getEvidencePath();
  const stats = computeStats(evidencePath);

  // Compute duration
  let duration = t("session_end.duration_unknown");
  if (stats.session_start_time) {
    const startMs = new Date(stats.session_start_time).getTime();
    if (!isNaN(startMs)) {
      duration = formatDuration(Date.now() - startMs);
    }
  }

  const topTools = getTopTools(stats.tool_counts, 3) || t("session_end.none");

  // Check incomplete gates
  const incompleteGates = getIncompleteGates(gatesPassed);
  let gateWarning = "";
  if (incompleteGates.length > 0) {
    gateWarning = t("session_end.incomplete_gates", {
      gates: incompleteGates.join(", "),
    });
  }

  // Write session_end evidence entry
  writeEvidence({
    event: "session_end",
    source,
    task,
    profile,
    gates_passed: gatesPassed,
    summary: {
      total_tool_uses: stats.total_tool_uses,
      total_denials: stats.total_denials,
      top_tools: stats.tool_counts,
      duration,
      incomplete_gates: incompleteGates,
    },
  });

  // Build summary output
  const parts = [];
  parts.push(t("session_end.header", { task }));
  parts.push(
    t("session_end.stats", {
      duration,
      tool_uses: stats.total_tool_uses,
      denials: stats.total_denials,
      top_tools: topTools,
    }),
  );
  parts.push(
    t("session_end.gates", {
      passed:
        gatesPassed.length > 0 ? gatesPassed.join(", ") : t("session_end.none"),
    }),
  );
  if (gateWarning) {
    parts.push(gateWarning);
  }

  // Auto-trigger: suggest handoff if gates are incomplete
  if (incompleteGates.length > 0) {
    parts.push(t("session_end.handoff_suggestion"));
  }

  // SessionEnd hooks output plain text to stdout
  process.stdout.write(parts.join("\n") + "\n");
  return null;
}

if (require.main === module) {
  runHook(handler);
}

module.exports = {
  handler,
  computeStats,
  getTopTools,
  getIncompleteGates,
  formatDuration,
};
