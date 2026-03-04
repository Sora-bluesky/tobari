"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
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
      path.join(claudeDir, "hooks", "tobari-gate.py")
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

  // --- Detect Python ---
  const python = detectPython();
  if (!python) {
    console.warn(
      "WARNING: Python 3.10+ not found. Hooks will not work until Python is installed.\n"
    );
  } else {
    console.log(`Python detected: ${python.version} (${python.command})`);
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
  printSuccess(python);
};

function deployCLAUDEmd(cwd) {
  const templateClaude = path.join(TEMPLATE_DIR, "CLAUDE.md");
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

function detectPython() {
  const candidates = ["python3", "python"];
  for (const cmd of candidates) {
    try {
      const output = execSync(`${cmd} --version`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      // output format: "Python 3.12.1"
      const match = output.match(/Python\s+(\d+\.\d+\.\d+)/);
      if (match) {
        const [major, minor] = match[1].split(".").map(Number);
        if (major >= 3 && minor >= 10) {
          return { command: cmd, version: output };
        }
        console.warn(
          `WARNING: ${output} found, but Python 3.10+ is required for tobari hooks.`
        );
      }
    } catch {
      // Command not found, try next
    }
  }
  return null;
}

function printSuccess(python) {
  console.log(`
+--------------------------------------------------+
|  tobari setup complete                            |
+--------------------------------------------------+

Deployed files:
  .claude/hooks/     (12 files - governance hooks)
  .claude/rules/     (6 files - coding & security rules)
  .claude/skills/    (8 skills - workflow automation)
  .claude/agents/    (1 file - agent configuration)
  .claude/commands/  (1 file - /orose alias)
  .claude/settings.json

Next steps:
  1. Open this project with Claude Code
  2. Run /tobari <task> to lower the veil
  3. The veil will guard your safety automatically

Prerequisites:
  - Python 3.10+ ${python ? "(detected)" : "(NOT FOUND - install before using hooks)"}
  - Claude Code (Max plan recommended)

Documentation: https://github.com/Sora-bluesky/tobari
`);
}
