"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  TEMPLATE_DIR,
  deployWithMerge,
  setRunShPermissions,
  updateGitignore,
  addPrepareScript,
} = require("../lib/deploy");

module.exports = function init(options) {
  const cwd = process.cwd();
  const claudeDir = path.join(cwd, ".claude");
  const force = options.force || false;
  const update = options.update || false;

  // --- Update mode: hooks only ---
  if (update) {
    if (!fs.existsSync(claudeDir)) {
      console.error(
        "Error: .claude/ directory not found. Run 'tobari init' first."
      );
      process.exit(1);
    }
    updateHooksOnly(cwd);
    return;
  }

  // --- Check for existing .claude/ ---
  if (fs.existsSync(claudeDir) && !force) {
    const hasGate = fs.existsSync(
      path.join(claudeDir, "hooks", "tobari-gate.js")
    );
    if (hasGate) {
      console.error(
        "tobari is already set up in this project.\n" +
          "Use 'tobari init --update' to update hooks to the latest version.\n" +
          "Use 'tobari init --force' to overwrite all configuration."
      );
    } else {
      console.error(
        "An existing .claude/ directory was found.\n" +
          "Use 'tobari init --force' to install tobari (existing hooks/permissions will be merged)."
      );
    }
    process.exit(1);
  }

  // --- Deploy files ---
  if (force && fs.existsSync(claudeDir)) {
    // Force mode: merge settings.json, overwrite hooks/rules, preserve user skills
    deployWithMerge(cwd);
  } else {
    // Fresh install: copy everything
    const templateClaudeDir = path.join(TEMPLATE_DIR, ".claude");
    fs.cpSync(templateClaudeDir, claudeDir, { recursive: true });
  }

  // --- Handle CLAUDE.md ---
  deployCLAUDEmd(cwd);

  // --- Update .gitignore ---
  updateGitignore(cwd);

  // --- Set _run.sh permissions ---
  setRunShPermissions(cwd);

  // --- Add prepare script to package.json ---
  const prepared = addPrepareScript(cwd);
  if (prepared) {
    console.log('Added "prepare": "tobari sync" to package.json');
  }

  // --- Print completion message ---
  printSuccess();
};

function deployCLAUDEmd(cwd) {
  const templateClaude = path.join(TEMPLATE_DIR, "templates", "CLAUDE.md");
  const targetClaude = path.join(cwd, "CLAUDE.md");

  if (!fs.existsSync(templateClaude)) return;

  if (fs.existsSync(targetClaude)) {
    // Don't overwrite existing CLAUDE.md
    const templateTarget = path.join(cwd, "CLAUDE.md.tobari");
    fs.copyFileSync(templateClaude, templateTarget);
    console.log(
      "\nCLAUDE.md already exists. Template saved as CLAUDE.md.tobari"
    );
    console.log(
      "Please merge the template content into your existing CLAUDE.md manually."
    );
  } else {
    fs.copyFileSync(templateClaude, targetClaude);
  }
}

function updateHooksOnly(cwd) {
  const templateHooksDir = path.join(TEMPLATE_DIR, ".claude", "hooks");
  const hooksDir = path.join(cwd, ".claude", "hooks");

  if (!fs.existsSync(templateHooksDir)) {
    console.error("Error: Template hooks not found in package.");
    process.exit(1);
  }

  fs.cpSync(templateHooksDir, hooksDir, { recursive: true, force: true });
  setRunShPermissions(cwd);

  console.log("Hooks updated to the latest version (12 files).");
  console.log("Rules and skills were not modified.");
}

function printSuccess() {
  console.log(`
+--------------------------------------------------+
|  tobari setup complete                            |
+--------------------------------------------------+

Deployed files:
  .claude/hooks/     (governance hooks)
  .claude/rules/     (coding & security rules)
  .claude/skills/    (workflow automation)
  .claude/agents/    (agent configuration)
  .claude/commands/  (/orose alias)
  .claude/settings.json

Next steps:
  1. Open this project with Claude Code
  2. Run /tobari <task> to lower the veil
  3. The veil will guard your safety automatically

Prerequisites:
  - Node.js 18+
  - Claude Code (Max plan recommended)

Documentation: https://github.com/Sora-bluesky/tobari
`);
}
