"use strict";

const { loadSession, getScope, runHook } = require("./tobari-session.js");
const { t } = require("./tobari-i18n.js");

function handler(_data) {
  const session = loadSession();
  if (!session || !session.active) {
    return null;
  }

  const scope = getScope();
  const include = scope && scope.include ? scope.include.join(", ") : "*";
  const exclude = scope && scope.exclude ? scope.exclude.join(", ") : "(none)";
  const gatesPassed = session.gates_passed || [];
  const profile = session.profile || "standard";
  const riskLevel = session.risk_level || "medium";
  const task = session.task || "unknown";

  const context = t("subagent.context", {
    task,
    profile,
    riskLevel,
    include,
    exclude,
    gates: JSON.stringify(gatesPassed),
  });

  return {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: context,
    },
  };
}

if (require.main === module) {
  runHook(handler);
}

module.exports = { handler };
