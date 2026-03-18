"use strict";

const {
  loadSession,
  isVeilActive,
  writeEvidence,
  runHook,
} = require("./tobari-session.js");
const { t } = require("./tobari-i18n.js");

const GATE_ORDER = ["STG0", "STG1", "STG2", "STG3", "STG4", "STG5", "STG6"];

function getCurrentGate(gatesPassed) {
  if (!gatesPassed || gatesPassed.length === 0) return GATE_ORDER[0];
  for (const gate of GATE_ORDER) {
    if (!gatesPassed.includes(gate)) return gate;
  }
  return null; // all gates done
}

function handler(_data) {
  if (!isVeilActive()) return null;

  const session = loadSession();
  if (!session) return null;

  const task = session.task || "unknown";
  const profile = session.profile || "standard";
  const gatesPassed = session.gates_passed || [];
  const contract = session.contract || {};
  const scope = contract.scope || {};
  const requirements = contract.requirements || {};
  const dod = contract.dod || [];
  const riskLevel = contract.risk_level || "medium";

  const currentGate = getCurrentGate(gatesPassed);

  const lines = [];
  lines.push(t("postcompact.header", { task, profile }));
  lines.push("");
  lines.push(
    t("postcompact.stg_status", {
      passed: gatesPassed.join(", ") || "none",
      current: currentGate || t("postcompact.all_done"),
    }),
  );
  lines.push("");

  // Scope
  const includeStr = (scope.include || []).join(", ") || "none";
  const excludeStr = (scope.exclude || []).join(", ") || "none";
  lines.push(
    t("postcompact.scope", { include: includeStr, exclude: excludeStr }),
  );
  lines.push("");

  // Requirements
  if (requirements.do && requirements.do.length > 0) {
    lines.push(
      t("postcompact.requirements_do", { items: requirements.do.join("; ") }),
    );
  }
  if (requirements.do_not && requirements.do_not.length > 0) {
    lines.push(
      t("postcompact.requirements_do_not", {
        items: requirements.do_not.join("; "),
      }),
    );
  }
  lines.push("");

  // DoD
  if (dod.length > 0) {
    lines.push(t("postcompact.dod", { items: dod.join("; ") }));
  }
  lines.push("");

  // Risk
  lines.push(t("postcompact.risk", { level: riskLevel }));
  lines.push("");
  lines.push(t("postcompact.footer"));

  const systemMessage = lines.join("\n");

  // Record restore event
  try {
    writeEvidence({
      event: "postcompact_restore",
      task,
      profile,
      gates_passed: gatesPassed,
      current_gate: currentGate,
      source: _data.source || "unknown",
    });
  } catch (_) {
    // fail-open
  }

  return {
    systemMessage,
    hookSpecificOutput: {
      hookEventName: "PostCompact",
    },
  };
}

if (require.main === module) {
  runHook(handler);
}

module.exports = { handler };
