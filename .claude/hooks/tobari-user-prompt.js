#!/usr/bin/env node
"use strict";

const { loadSession, writeEvidence, runHook } = require("./tobari-session.js");
const { t } = require("./tobari-i18n.js");

// ---------------------------------------------------------------------------
// Injection Patterns — tobari bypass attempts in user prompts
// ---------------------------------------------------------------------------

const BYPASS_PATTERNS = [
  // Tobari disable attempts (JP + EN)
  [/帳を無視/i, "tobari_disable", "user_prompt.pattern.ignore_tobari"],
  [/hookをスキップ/i, "tobari_disable", "user_prompt.pattern.skip_hooks_jp"],
  [/帳を解除/i, "tobari_disable", "user_prompt.pattern.release_tobari"],
  [
    /ignore\s+tobari/i,
    "tobari_disable",
    "user_prompt.pattern.ignore_tobari_en",
  ],
  [/skip\s+hooks?/i, "tobari_disable", "user_prompt.pattern.skip_hooks"],
  [/disable\s+hooks?/i, "tobari_disable", "user_prompt.pattern.disable_hooks"],
  [/bypass\s+tobari/i, "tobari_disable", "user_prompt.pattern.bypass_tobari"],

  // Security override attempts
  [/--no-verify/i, "security_override", "user_prompt.pattern.no_verify"],
  [/no-verify/i, "security_override", "user_prompt.pattern.no_verify_bare"],
  [/force\s+push/i, "security_override", "user_prompt.pattern.force_push"],
  [/rm\s+-rf/i, "security_override", "user_prompt.pattern.rm_rf"],

  // Permission escalation
  [
    /bypassPermissions/i,
    "permission_escalation",
    "user_prompt.pattern.bypass_perms_camel",
  ],
  [
    /bypass\s+permissions/i,
    "permission_escalation",
    "user_prompt.pattern.bypass_perms",
  ],
];

// ---------------------------------------------------------------------------
// Hook Handler
// ---------------------------------------------------------------------------

function handler(data) {
  const session = loadSession();
  if (!session) return null;

  const prompt = data.prompt || data.message || data.content || "";
  if (typeof prompt !== "string" || !prompt) return null;

  const detections = [];
  const seenCategories = new Set();

  for (const [pattern, category, descKey] of BYPASS_PATTERNS) {
    if (seenCategories.has(category)) continue;
    if (pattern.test(prompt)) {
      detections.push([category, descKey]);
      seenCategories.add(category);
    }
  }

  if (detections.length === 0) return null;

  writeEvidence({
    event: "user_prompt_injection",
    detections: detections.map(([cat, descKey]) => ({
      category: cat,
      description: t(descKey),
    })),
    task: session.task || "",
    profile: session.profile || "",
  });

  const warningLines = [t("user_prompt.injection_warning")];
  for (const [_category, descKey] of detections) {
    warningLines.push("  - " + t(descKey));
  }
  warningLines.push("");
  warningLines.push(t("user_prompt.instruction"));

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: warningLines.join("\n"),
    },
  };
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runHook(handler);
}

// ---------------------------------------------------------------------------
// Exports (for testing)
// ---------------------------------------------------------------------------

module.exports = {
  BYPASS_PATTERNS,
  handler,
};
