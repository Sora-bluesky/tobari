"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const {
  TOBARI_SKILLS,
  GITIGNORE_ENTRIES,
  buildGitignoreEntries,
} = require("../lib/deploy");

// --- Constants ---

/**
 * Hook files deployed by tobari (all files in .claude/hooks/).
 * tobari owns the entire hooks directory.
 */
const TOBARI_HOOK_FILES = [
  "lint-on-save.js",
  "tobari-config-change.js",
  "tobari-cost.js",
  "tobari-evidence-failure.js",
  "tobari-evidence.js",
  "tobari-gate.js",
  "tobari-i18n.js",
  "tobari-injection-guard.js",
  "tobari-instructions.js",
  "tobari-permission.js",
  "tobari-precompact.js",
  "tobari-postcompact.js",
  "tobari-session-start.js",
  "tobari-session-end.js",
  "tobari-session.js",
  "tobari-stage.js",
  "tobari-stop.js",
  "tobari-subagent-start.js",
  "tobari-task-completed.js",
  "tobari-teammate-idle.js",
  "tobari-user-prompt.js",
];

const TOBARI_RULE_FILES = [
  "binding-governance.md",
  "coding-principles.md",
  "dev-environment.md",
  "language.md",
  "security.md",
  "testing.md",
];

const RUNTIME_FILES = [
  ".claude/tobari-session.json",
  ".claude/tobari-session.json.lock",
  ".claude/tobari-cost-state.json",
  ".claude/tobari-cost-state.json.lock",
  ".claude/hooks/tobari-hmac-key",
  ".tobari-version",
];

const RUNTIME_DIRS = [".claude/logs/", ".claude/checkpoints/"];

const TOBARI_MARKER = "# tobari";

// --- Main ---

module.exports = async function uninstall(options) {
  const cwd = process.cwd();
  const claudeDir = path.join(cwd, ".claude");

  if (!fs.existsSync(claudeDir)) {
    console.error("Error: .claude/ directory not found. Nothing to uninstall.");
    process.exit(1);
  }

  // Collect removal targets for summary
  const targets = collectTargets(cwd);

  if (targets.length === 0) {
    console.log("No tobari files found to remove.");
    return;
  }

  // Show summary
  console.log("The following tobari files will be removed:\n");
  for (const t of targets) {
    console.log(`  ${t}`);
  }
  console.log();

  // Confirm unless --yes
  if (!options.yes) {
    const confirmed = await confirm("Proceed with uninstall? (y/N) ");
    if (!confirmed) {
      console.log("Uninstall cancelled.");
      return;
    }
  }

  // Execute removal
  removeHooks(cwd);
  removeRules(cwd);
  removeSkills(cwd);
  removeAgents(cwd);
  removeCommands(cwd);
  cleanSettingsJson(cwd);
  cleanCLAUDEmd(cwd);
  removePrepareScript(cwd);
  cleanGitignore(cwd);
  removeRuntimeFiles(cwd);

  console.log("\ntobari has been uninstalled from this project.");
  console.log(
    'User-created files in .claude/ have been preserved.\nTo reinstall, run "npx tobari init".',
  );
};

// --- Collect targets for display ---

function collectTargets(cwd) {
  const targets = [];
  const claudeDir = path.join(cwd, ".claude");

  // Hooks
  const hooksDir = path.join(claudeDir, "hooks");
  if (fs.existsSync(hooksDir)) {
    for (const f of TOBARI_HOOK_FILES) {
      if (fs.existsSync(path.join(hooksDir, f))) {
        targets.push(`.claude/hooks/${f}`);
      }
    }
    if (fs.existsSync(path.join(hooksDir, "locales"))) {
      targets.push(".claude/hooks/locales/");
    }
  }

  // Rules
  const rulesDir = path.join(claudeDir, "rules");
  if (fs.existsSync(rulesDir)) {
    for (const f of TOBARI_RULE_FILES) {
      if (fs.existsSync(path.join(rulesDir, f))) {
        targets.push(`.claude/rules/${f}`);
      }
    }
  }

  // Skills
  const skillsDir = path.join(claudeDir, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const s of TOBARI_SKILLS) {
      if (fs.existsSync(path.join(skillsDir, s))) {
        targets.push(`.claude/skills/${s}/`);
      }
    }
  }

  // Agents
  if (fs.existsSync(path.join(claudeDir, "agents"))) {
    targets.push(".claude/agents/");
  }

  // Commands
  if (fs.existsSync(path.join(claudeDir, "commands"))) {
    targets.push(".claude/commands/");
  }

  // settings.json (clean, not remove)
  if (fs.existsSync(path.join(claudeDir, "settings.json"))) {
    targets.push(".claude/settings.json (tobari hooks removed)");
  }

  // CLAUDE.md (clean tobari section)
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf8");
    if (content.includes(TOBARI_MARKER)) {
      targets.push("CLAUDE.md (tobari section removed)");
    }
  }

  // Runtime files
  for (const f of RUNTIME_FILES) {
    if (fs.existsSync(path.join(cwd, f))) {
      targets.push(f);
    }
  }
  for (const d of RUNTIME_DIRS) {
    if (fs.existsSync(path.join(cwd, d))) {
      targets.push(d);
    }
  }

  return targets;
}

// --- Removal functions ---

function removeHooks(cwd) {
  const hooksDir = path.join(cwd, ".claude", "hooks");
  if (!fs.existsSync(hooksDir)) return;

  for (const f of TOBARI_HOOK_FILES) {
    const fp = path.join(hooksDir, f);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  // Remove locales directory
  const localesDir = path.join(hooksDir, "locales");
  if (fs.existsSync(localesDir)) {
    fs.rmSync(localesDir, { recursive: true });
  }

  // Remove hooks dir if empty
  removeIfEmpty(hooksDir);
}

function removeRules(cwd) {
  const rulesDir = path.join(cwd, ".claude", "rules");
  if (!fs.existsSync(rulesDir)) return;

  for (const f of TOBARI_RULE_FILES) {
    const fp = path.join(rulesDir, f);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  removeIfEmpty(rulesDir);
}

function removeSkills(cwd) {
  const skillsDir = path.join(cwd, ".claude", "skills");
  if (!fs.existsSync(skillsDir)) return;

  for (const s of TOBARI_SKILLS) {
    const sp = path.join(skillsDir, s);
    if (fs.existsSync(sp)) {
      fs.rmSync(sp, { recursive: true });
    }
  }

  removeIfEmpty(skillsDir);
}

function removeAgents(cwd) {
  const agentsDir = path.join(cwd, ".claude", "agents");
  if (fs.existsSync(agentsDir)) {
    fs.rmSync(agentsDir, { recursive: true });
  }
}

function removeCommands(cwd) {
  const commandsDir = path.join(cwd, ".claude", "commands");
  if (fs.existsSync(commandsDir)) {
    fs.rmSync(commandsDir, { recursive: true });
  }
}

function cleanSettingsJson(cwd) {
  const settingsPath = path.join(cwd, ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return;

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return;
  }

  // Remove all hook entries that reference tobari hooks
  if (settings.hooks) {
    for (const [hookType, hookEntries] of Object.entries(settings.hooks)) {
      if (Array.isArray(hookEntries)) {
        settings.hooks[hookType] = hookEntries.filter((entry) => {
          const cmd = entry.command || "";
          const hooks = entry.hooks || [];
          // Check direct command
          if (cmd.includes("tobari-") || cmd.includes("lint-on-save")) {
            return false;
          }
          // Check nested hooks array
          if (hooks.length > 0) {
            const filtered = hooks.filter((h) => {
              const hCmd = h.command || "";
              return (
                !hCmd.includes("tobari-") && !hCmd.includes("lint-on-save")
              );
            });
            if (filtered.length === 0) return false;
            entry.hooks = filtered;
          }
          return true;
        });
        if (settings.hooks[hookType].length === 0) {
          delete settings.hooks[hookType];
        }
      }
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  // Keep permissions and env intact
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function cleanCLAUDEmd(cwd) {
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) return;

  const content = fs.readFileSync(claudeMdPath, "utf8");
  const markerIndex = content.indexOf(TOBARI_MARKER);
  if (markerIndex === -1) return;

  // Remove everything from the tobari marker onwards
  const cleaned = content.slice(0, markerIndex).trimEnd() + "\n";

  if (cleaned.trim().length === 0) {
    // CLAUDE.md was entirely tobari content
    fs.unlinkSync(claudeMdPath);
  } else {
    fs.writeFileSync(claudeMdPath, cleaned);
  }
}

function removePrepareScript(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return;
  }

  if (!pkg.scripts || !pkg.scripts.prepare) return;

  const TOBARI_SYNC = "tobari sync";
  const prepare = pkg.scripts.prepare;

  if (!prepare.includes(TOBARI_SYNC)) return;

  // Remove "tobari sync" from prepare script
  const parts = prepare
    .split("&&")
    .map((s) => s.trim())
    .filter((s) => s !== TOBARI_SYNC);

  if (parts.length === 0) {
    delete pkg.scripts.prepare;
  } else {
    pkg.scripts.prepare = parts.join(" && ");
  }

  if (Object.keys(pkg.scripts).length === 0) {
    delete pkg.scripts;
  }

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function cleanGitignore(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return;

  const content = fs.readFileSync(gitignorePath, "utf8");
  const allEntries = buildGitignoreEntries();

  // Also include the old-format entries that may have been added by earlier versions
  const entriesToRemove = new Set([
    ...allEntries,
    ...GITIGNORE_ENTRIES,
    ".claude/hooks/tobari-hmac-key",
  ]);

  const lines = content.split("\n");
  const filtered = lines.filter((line) => !entriesToRemove.has(line));

  // Remove consecutive blank lines
  const cleaned = filtered
    .reduce((acc, line) => {
      if (line === "" && acc.length > 0 && acc[acc.length - 1] === "") {
        return acc;
      }
      acc.push(line);
      return acc;
    }, [])
    .join("\n");

  fs.writeFileSync(gitignorePath, cleaned);
}

function removeRuntimeFiles(cwd) {
  for (const f of RUNTIME_FILES) {
    const fp = path.join(cwd, f);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  for (const d of RUNTIME_DIRS) {
    const dp = path.join(cwd, d);
    if (fs.existsSync(dp)) {
      fs.rmSync(dp, { recursive: true });
    }
  }
}

// --- Helpers ---

function removeIfEmpty(dir) {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    // ignore
  }
}

function confirm(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}
