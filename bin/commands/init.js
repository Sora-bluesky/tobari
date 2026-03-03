"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const TEMPLATE_DIR = path.join(__dirname, "..", "..", "templates");

const GITIGNORE_ENTRIES = [
  "# tobari - session state and logs (do not commit)",
  ".claude/tobari-session.json",
  ".claude/logs/",
  ".claude/settings.local.json",
  ".claude/checkpoints/",
  "__pycache__/",
  "*.pyc",
];

const TOBARI_SKILLS = [
  "handoff",
  "plan",
  "simplify",
  "startproject",
  "tdd",
  "team-implement",
  "team-review",
  "tobari",
];

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
  const templateClaudeDir = path.join(TEMPLATE_DIR, ".claude");

  if (force && fs.existsSync(claudeDir)) {
    // Force mode: merge settings.json, overwrite hooks/rules, preserve user skills
    deployWithMerge(cwd, templateClaudeDir);
  } else {
    // Fresh install: copy everything
    fs.cpSync(templateClaudeDir, claudeDir, { recursive: true });
  }

  // --- Handle CLAUDE.md ---
  deployCLAUDEmd(cwd);

  // --- Update .gitignore ---
  updateGitignore(cwd);

  // --- Set _run.sh permissions ---
  setRunShPermissions(cwd);

  // --- Print completion message ---
  printSuccess(python);
};

function deployWithMerge(cwd, templateClaudeDir) {
  const claudeDir = path.join(cwd, ".claude");

  // Overwrite hooks
  const hooksDir = path.join(claudeDir, "hooks");
  const templateHooksDir = path.join(templateClaudeDir, "hooks");
  if (fs.existsSync(templateHooksDir)) {
    fs.cpSync(templateHooksDir, hooksDir, { recursive: true, force: true });
  }

  // Overwrite rules
  const rulesDir = path.join(claudeDir, "rules");
  const templateRulesDir = path.join(templateClaudeDir, "rules");
  if (fs.existsSync(templateRulesDir)) {
    fs.cpSync(templateRulesDir, rulesDir, { recursive: true, force: true });
  }

  // Skills: only overwrite tobari-managed skills, preserve user additions
  const skillsDir = path.join(claudeDir, "skills");
  const templateSkillsDir = path.join(templateClaudeDir, "skills");
  if (fs.existsSync(templateSkillsDir)) {
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
    for (const skill of TOBARI_SKILLS) {
      const srcSkill = path.join(templateSkillsDir, skill);
      const destSkill = path.join(skillsDir, skill);
      if (fs.existsSync(srcSkill)) {
        fs.cpSync(srcSkill, destSkill, { recursive: true, force: true });
      }
    }
  }

  // Agents: copy (overwrite)
  const templateAgentsDir = path.join(templateClaudeDir, "agents");
  const agentsDir = path.join(claudeDir, "agents");
  if (fs.existsSync(templateAgentsDir)) {
    fs.cpSync(templateAgentsDir, agentsDir, { recursive: true, force: true });
  }

  // Commands: copy (overwrite)
  const templateCommandsDir = path.join(templateClaudeDir, "commands");
  const commandsDir = path.join(claudeDir, "commands");
  if (fs.existsSync(templateCommandsDir)) {
    fs.cpSync(templateCommandsDir, commandsDir, {
      recursive: true,
      force: true,
    });
  }

  // Settings.json: merge
  mergeSettingsJson(cwd, templateClaudeDir);
}

function mergeSettingsJson(cwd, templateClaudeDir) {
  const settingsPath = path.join(cwd, ".claude", "settings.json");
  const templateSettingsPath = path.join(templateClaudeDir, "settings.json");

  if (!fs.existsSync(templateSettingsPath)) return;

  if (!fs.existsSync(settingsPath)) {
    fs.cpSync(templateSettingsPath, settingsPath);
    return;
  }

  // Backup existing settings
  const backupPath = settingsPath + ".bak";
  fs.copyFileSync(settingsPath, backupPath);
  console.log(`Backup created: .claude/settings.json.bak`);

  let existing, template;
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    template = JSON.parse(fs.readFileSync(templateSettingsPath, "utf8"));
  } catch (e) {
    console.warn(
      "WARNING: Could not parse settings.json for merging. Using template version."
    );
    fs.cpSync(templateSettingsPath, settingsPath, { force: true });
    return;
  }

  // Merge hooks: add tobari hooks without duplicating
  if (template.hooks) {
    if (!existing.hooks) existing.hooks = {};
    for (const [hookType, hookEntries] of Object.entries(template.hooks)) {
      if (!existing.hooks[hookType]) {
        existing.hooks[hookType] = hookEntries;
      } else {
        // Add entries that don't already exist (match by command string)
        const existingCommands = new Set(
          existing.hooks[hookType].map((e) => e.command)
        );
        for (const entry of hookEntries) {
          if (!existingCommands.has(entry.command)) {
            existing.hooks[hookType].push(entry);
          }
        }
      }
    }
  }

  // Merge permissions
  if (template.permissions) {
    if (!existing.permissions) existing.permissions = {};
    for (const [permType, permEntries] of Object.entries(
      template.permissions
    )) {
      if (!existing.permissions[permType]) {
        existing.permissions[permType] = permEntries;
      } else if (Array.isArray(permEntries)) {
        const existingSet = new Set(existing.permissions[permType]);
        for (const entry of permEntries) {
          if (!existingSet.has(entry)) {
            existing.permissions[permType].push(entry);
          }
        }
      }
    }
  }

  // Merge env (existing keys take precedence)
  if (template.env) {
    if (!existing.env) existing.env = {};
    for (const [key, val] of Object.entries(template.env)) {
      if (!(key in existing.env)) {
        existing.env[key] = val;
      }
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");
  console.log("settings.json merged (existing customizations preserved).");
}

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

function updateGitignore(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");

  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf8");
  }

  const linesToAdd = [];
  for (const entry of GITIGNORE_ENTRIES) {
    if (!content.includes(entry)) {
      linesToAdd.push(entry);
    }
  }

  if (linesToAdd.length > 0) {
    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    const block = separator + "\n" + linesToAdd.join("\n") + "\n";
    fs.appendFileSync(gitignorePath, block);
  }
}

function setRunShPermissions(cwd) {
  const runShPath = path.join(cwd, ".claude", "hooks", "_run.sh");
  if (!fs.existsSync(runShPath)) return;

  try {
    fs.chmodSync(runShPath, 0o755);
  } catch {
    // chmod may fail on some Windows setups; check if already executable
    try {
      fs.accessSync(runShPath, fs.constants.X_OK);
    } catch {
      console.warn(
        "WARNING: Could not set executable permission on _run.sh. " +
          "You may need to run: chmod +x .claude/hooks/_run.sh"
      );
    }
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
