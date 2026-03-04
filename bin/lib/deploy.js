"use strict";

const fs = require("node:fs");
const path = require("node:path");

// --- Constants ---

const TEMPLATE_DIR = path.join(__dirname, "..", "..", "templates");

const GITIGNORE_ENTRIES = [
  "# tobari - session state and logs (do not commit)",
  ".claude/tobari-session.json",
  ".claude/logs/",
  ".claude/settings.local.json",
  ".claude/checkpoints/",
  "__pycache__/",
  "*.pyc",
  ".tobari-version",
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

const VERSION_FILE = ".tobari-version";

// --- Deploy Functions ---

/**
 * Merge-deploy tobari files into an existing .claude/ directory.
 * Hooks, rules, agents, commands are overwritten.
 * Skills: only tobari-managed skills are overwritten; user additions preserved.
 * settings.json: deep merge preserving user customizations.
 *
 * @param {string} cwd - Project root directory
 * @param {object} [options]
 * @param {boolean} [options.verbose=false] - Print progress per category
 */
function deployWithMerge(cwd, options = {}) {
  const verbose = options.verbose || false;
  const claudeDir = path.join(cwd, ".claude");
  const templateClaudeDir = path.join(TEMPLATE_DIR, ".claude");

  // Overwrite hooks
  const hooksDir = path.join(claudeDir, "hooks");
  const templateHooksDir = path.join(templateClaudeDir, "hooks");
  if (fs.existsSync(templateHooksDir)) {
    fs.cpSync(templateHooksDir, hooksDir, { recursive: true, force: true });
    if (verbose) {
      const count = countFiles(templateHooksDir);
      console.log(`  Syncing hooks...       ${count} files`);
    }
  }

  // Overwrite rules
  const rulesDir = path.join(claudeDir, "rules");
  const templateRulesDir = path.join(templateClaudeDir, "rules");
  if (fs.existsSync(templateRulesDir)) {
    fs.cpSync(templateRulesDir, rulesDir, { recursive: true, force: true });
    if (verbose) {
      const count = countFiles(templateRulesDir);
      console.log(`  Syncing rules...       ${count} files`);
    }
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
    if (verbose) {
      console.log(`  Syncing skills...      ${TOBARI_SKILLS.length} skills (tobari-managed only)`);
    }
  }

  // Agents: copy (overwrite)
  const templateAgentsDir = path.join(templateClaudeDir, "agents");
  const agentsDir = path.join(claudeDir, "agents");
  if (fs.existsSync(templateAgentsDir)) {
    fs.cpSync(templateAgentsDir, agentsDir, { recursive: true, force: true });
    if (verbose) {
      const count = countFiles(templateAgentsDir);
      console.log(`  Syncing agents...      ${count} files`);
    }
  }

  // Commands: copy (overwrite)
  const templateCommandsDir = path.join(templateClaudeDir, "commands");
  const commandsDir = path.join(claudeDir, "commands");
  if (fs.existsSync(templateCommandsDir)) {
    fs.cpSync(templateCommandsDir, commandsDir, {
      recursive: true,
      force: true,
    });
    if (verbose) {
      const count = countFiles(templateCommandsDir);
      console.log(`  Syncing commands...    ${count} files`);
    }
  }

  // Settings.json: merge
  mergeSettingsJson(cwd, { verbose });
}

/**
 * Merge tobari template settings.json with existing project settings.
 * Hooks: add without duplicating (match by command string).
 * Permissions: add without duplicating.
 * Env: existing keys take precedence.
 *
 * @param {string} cwd - Project root directory
 * @param {object} [options]
 * @param {boolean} [options.verbose=false] - Print progress
 */
function mergeSettingsJson(cwd, options = {}) {
  const verbose = options.verbose || false;
  const settingsPath = path.join(cwd, ".claude", "settings.json");
  const templateSettingsPath = path.join(TEMPLATE_DIR, ".claude", "settings.json");

  if (!fs.existsSync(templateSettingsPath)) return;

  if (!fs.existsSync(settingsPath)) {
    fs.cpSync(templateSettingsPath, settingsPath);
    if (verbose) {
      console.log("  Merging settings.json  (created from template)");
    }
    return;
  }

  // Backup existing settings
  const backupPath = settingsPath + ".bak";
  fs.copyFileSync(settingsPath, backupPath);

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
  if (verbose) {
    console.log("  Merging settings.json  (customizations preserved)");
  }
}

/**
 * Add tobari entries to .gitignore if not already present.
 * @param {string} cwd - Project root directory
 */
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

/**
 * Set executable permission on _run.sh.
 * @param {string} cwd - Project root directory
 */
function setRunShPermissions(cwd) {
  const runShPath = path.join(cwd, ".claude", "hooks", "_run.sh");
  if (!fs.existsSync(runShPath)) return;

  try {
    fs.chmodSync(runShPath, 0o755);
  } catch {
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

/**
 * Add "tobari sync" to the prepare script in package.json.
 * Idempotent: skips if already present.
 *
 * @param {string} cwd - Project root directory
 * @returns {boolean} true if package.json was modified, false if skipped
 */
function addPrepareScript(cwd) {
  const pkgPath = path.join(cwd, "package.json");

  if (!fs.existsSync(pkgPath)) {
    return false;
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return false;
  }

  const TOBARI_SYNC = "tobari sync";

  if (pkg.scripts && pkg.scripts.prepare &&
      pkg.scripts.prepare.includes(TOBARI_SYNC)) {
    return false;
  }

  if (!pkg.scripts) {
    pkg.scripts = {};
  }

  if (!pkg.scripts.prepare) {
    pkg.scripts.prepare = TOBARI_SYNC;
  } else {
    pkg.scripts.prepare = pkg.scripts.prepare + " && " + TOBARI_SYNC;
  }

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return true;
}

// --- Drift Check Functions ---

/**
 * Compare files between source (template) and destination (deployed) directories.
 * Recursively walks the source directory and checks each file against destination.
 *
 * @param {string} srcDir - Template directory (source of truth)
 * @param {string} destDir - Deployed directory
 * @returns {{ missing: string[], modified: string[] }}
 */
function compareDirectories(srcDir, destDir) {
  const missing = [];
  const modified = [];

  function walk(dir, relativePath) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relativePath ? relativePath + "/" + entry.name : entry.name;
      const srcPath = path.join(dir, entry.name);
      const destPath = path.join(destDir, rel);

      if (entry.isDirectory()) {
        walk(srcPath, rel);
      } else if (entry.isFile()) {
        if (!fs.existsSync(destPath)) {
          missing.push(rel);
        } else {
          const srcBuf = fs.readFileSync(srcPath);
          const destBuf = fs.readFileSync(destPath);
          if (!srcBuf.equals(destBuf)) {
            modified.push(rel);
          }
        }
      }
    }
  }

  if (fs.existsSync(srcDir)) {
    walk(srcDir, "");
  }

  return { missing, modified };
}

/**
 * Compute the merged settings.json result without writing to disk.
 * Replicates mergeSettingsJson() merge logic in memory only.
 *
 * @param {string} cwd - Project root directory
 * @returns {object|null} Merged settings object, or null if no template exists
 */
function computeMergedSettings(cwd) {
  const settingsPath = path.join(cwd, ".claude", "settings.json");
  const templateSettingsPath = path.join(TEMPLATE_DIR, ".claude", "settings.json");

  if (!fs.existsSync(templateSettingsPath)) return null;

  const template = JSON.parse(fs.readFileSync(templateSettingsPath, "utf8"));

  if (!fs.existsSync(settingsPath)) {
    return template;
  }

  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return template;
  }

  // Deep clone to avoid mutating the original
  const merged = JSON.parse(JSON.stringify(existing));

  // Merge hooks: add tobari hooks without duplicating
  if (template.hooks) {
    if (!merged.hooks) merged.hooks = {};
    for (const [hookType, hookEntries] of Object.entries(template.hooks)) {
      if (!merged.hooks[hookType]) {
        merged.hooks[hookType] = hookEntries;
      } else {
        const existingCommands = new Set(
          merged.hooks[hookType].map((e) => e.command)
        );
        for (const entry of hookEntries) {
          if (!existingCommands.has(entry.command)) {
            merged.hooks[hookType].push(entry);
          }
        }
      }
    }
  }

  // Merge permissions
  if (template.permissions) {
    if (!merged.permissions) merged.permissions = {};
    for (const [permType, permEntries] of Object.entries(template.permissions)) {
      if (!merged.permissions[permType]) {
        merged.permissions[permType] = permEntries;
      } else if (Array.isArray(permEntries)) {
        const existingSet = new Set(merged.permissions[permType]);
        for (const entry of permEntries) {
          if (!existingSet.has(entry)) {
            merged.permissions[permType].push(entry);
          }
        }
      }
    }
  }

  // Merge env (existing keys take precedence)
  if (template.env) {
    if (!merged.env) merged.env = {};
    for (const [key, val] of Object.entries(template.env)) {
      if (!(key in merged.env)) {
        merged.env[key] = val;
      }
    }
  }

  return merged;
}

/**
 * Check for drift between deployed files and templates.
 * Read-only: never modifies any files.
 *
 * @param {string} cwd - Project root directory
 * @returns {{ hasDrift: boolean, categories: Array<{name: string, status: string, detail: string}> }}
 */
function checkDrift(cwd) {
  const claudeDir = path.join(cwd, ".claude");
  const templateClaudeDir = path.join(TEMPLATE_DIR, ".claude");
  const categories = [];
  let hasDrift = false;

  // Helper to format diff detail
  function formatDiff(missing, modified, totalSrc) {
    const diffs = [...missing.map((f) => f + " (missing)"), ...modified];
    if (diffs.length === 0) {
      return { status: "ok", detail: `${totalSrc} files in sync` };
    }
    hasDrift = true;
    const shown = diffs.slice(0, 5);
    const extra = diffs.length > 5 ? ` +${diffs.length - 5} more` : "";
    return {
      status: "drift",
      detail: `${diffs.length} files differ: ${shown.join(", ")}${extra}`,
    };
  }

  // 1. Hooks
  const hooksResult = compareDirectories(
    path.join(templateClaudeDir, "hooks"),
    path.join(claudeDir, "hooks")
  );
  const hooksTotal = countFilesRecursive(path.join(templateClaudeDir, "hooks"));
  const hooksDiff = formatDiff(hooksResult.missing, hooksResult.modified, hooksTotal);
  categories.push({ name: "hooks", ...hooksDiff });

  // 2. Rules
  const rulesResult = compareDirectories(
    path.join(templateClaudeDir, "rules"),
    path.join(claudeDir, "rules")
  );
  const rulesTotal = countFilesRecursive(path.join(templateClaudeDir, "rules"));
  const rulesDiff = formatDiff(rulesResult.missing, rulesResult.modified, rulesTotal);
  categories.push({ name: "rules", ...rulesDiff });

  // 3. Skills (tobari-managed only)
  const templateSkillsDir = path.join(templateClaudeDir, "skills");
  const skillsDir = path.join(claudeDir, "skills");
  const skillMissing = [];
  const skillModified = [];
  for (const skill of TOBARI_SKILLS) {
    const srcSkill = path.join(templateSkillsDir, skill);
    const destSkill = path.join(skillsDir, skill);
    if (fs.existsSync(srcSkill)) {
      const result = compareDirectories(srcSkill, destSkill);
      skillMissing.push(...result.missing.map((f) => skill + "/" + f));
      skillModified.push(...result.modified.map((f) => skill + "/" + f));
    }
  }
  const skillsDiff = skillMissing.length + skillModified.length === 0
    ? { status: "ok", detail: `${TOBARI_SKILLS.length} skills in sync` }
    : (() => {
        hasDrift = true;
        const diffs = [
          ...skillMissing.map((f) => f + " (missing)"),
          ...skillModified,
        ];
        const shown = diffs.slice(0, 5);
        const extra = diffs.length > 5 ? ` +${diffs.length - 5} more` : "";
        return {
          status: "drift",
          detail: `${diffs.length} files differ: ${shown.join(", ")}${extra}`,
        };
      })();
  categories.push({ name: "skills", ...skillsDiff });

  // 4. Agents
  const agentsResult = compareDirectories(
    path.join(templateClaudeDir, "agents"),
    path.join(claudeDir, "agents")
  );
  const agentsTotal = countFilesRecursive(path.join(templateClaudeDir, "agents"));
  const agentsDiff = formatDiff(agentsResult.missing, agentsResult.modified, agentsTotal);
  categories.push({ name: "agents", ...agentsDiff });

  // 5. Commands
  const commandsResult = compareDirectories(
    path.join(templateClaudeDir, "commands"),
    path.join(claudeDir, "commands")
  );
  const commandsTotal = countFilesRecursive(path.join(templateClaudeDir, "commands"));
  const commandsDiff = formatDiff(commandsResult.missing, commandsResult.modified, commandsTotal);
  categories.push({ name: "commands", ...commandsDiff });

  // 6. Settings.json
  const mergedSettings = computeMergedSettings(cwd);
  if (mergedSettings) {
    const settingsPath = path.join(claudeDir, "settings.json");
    if (!fs.existsSync(settingsPath)) {
      hasDrift = true;
      categories.push({
        name: "settings.json",
        status: "drift",
        detail: "missing",
      });
    } else {
      // Normalize both through JSON.stringify to avoid serialization differences
      // (e.g., file written by Python json.dumps vs Node JSON.stringify)
      const mergedStr = JSON.stringify(mergedSettings, null, 2);
      let currentObj;
      try {
        currentObj = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      } catch {
        hasDrift = true;
        categories.push({
          name: "settings.json",
          status: "drift",
          detail: "invalid JSON",
        });
        return { hasDrift, categories };
      }
      const currentStr = JSON.stringify(currentObj, null, 2);
      if (mergedStr === currentStr) {
        categories.push({
          name: "settings.json",
          status: "ok",
          detail: "in sync",
        });
      } else {
        hasDrift = true;
        categories.push({
          name: "settings.json",
          status: "drift",
          detail: "configuration differs from expected merge result",
        });
      }
    }
  }

  return { hasDrift, categories };
}

// --- Helpers ---

/**
 * Count files in a directory (non-recursive, files only).
 * @param {string} dir
 * @returns {number}
 */
function countFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) =>
      fs.statSync(path.join(dir, f)).isFile()
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Count files in a directory recursively.
 * @param {string} dir
 * @returns {number}
 */
function countFilesRecursive(dir) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += countFilesRecursive(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        count++;
      }
    }
  } catch {
    return 0;
  }
  return count;
}

module.exports = {
  TEMPLATE_DIR,
  GITIGNORE_ENTRIES,
  TOBARI_SKILLS,
  VERSION_FILE,
  deployWithMerge,
  mergeSettingsJson,
  setRunShPermissions,
  updateGitignore,
  addPrepareScript,
  checkDrift,
};
