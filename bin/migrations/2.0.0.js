"use strict";

/**
 * Migration: v1.x -> v2.0.0
 *
 * Removes Python hooks and _run.sh from user projects.
 * v2.0.0 uses JavaScript-only hooks — Python files are no longer needed.
 */

const fs = require("node:fs");
const path = require("node:path");

// Python hook files that existed in v1.x
const PYTHON_HOOKS_TO_REMOVE = [
  "_run.sh",
  "lint-on-save.py",
  "tobari-cost.py",
  "tobari-evidence-failure.py",
  "tobari-evidence.py",
  "tobari-gate.py",
  "tobari-injection-guard.py",
  "tobari-permission.py",
  "tobari-precompact.py",
  "tobari-session-start.py",
  "tobari-stop.py",
  "tobari_session.py",
  "tobari_stage.py",
];

// .gitignore entries to add (v2.0.0 runtime artifacts)
const GITIGNORE_ENTRIES = [
  ".claude/tobari-session.json",
  ".claude/tobari-session.json.lock",
  ".claude/tobari-cost-state.json",
  ".claude/tobari-cost-state.json.lock",
  ".claude/checkpoints/",
  ".tobari-version",
];

/**
 * Remove Python hooks from .claude/hooks/ directory.
 * @param {string} cwd - Project root directory
 * @returns {string[]} List of removed files
 */
function removePythonHooks(cwd) {
  const hooksDir = path.join(cwd, ".claude", "hooks");
  const removed = [];

  if (!fs.existsSync(hooksDir)) {
    return removed;
  }

  for (const file of PYTHON_HOOKS_TO_REMOVE) {
    const filePath = path.join(hooksDir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      removed.push(file);
    }
  }

  // Also remove any remaining .py files and __pycache__
  try {
    const entries = fs.readdirSync(hooksDir);
    for (const entry of entries) {
      const entryPath = path.join(hooksDir, entry);

      if (entry.endsWith(".py")) {
        fs.unlinkSync(entryPath);
        removed.push(entry);
      }

      if (entry === "__pycache__" && fs.statSync(entryPath).isDirectory()) {
        fs.rmSync(entryPath, { recursive: true });
        removed.push("__pycache__/");
      }
    }
  } catch (_) {
    // Best-effort cleanup
  }

  return removed;
}

/**
 * Ensure .gitignore contains v2.0.0 runtime artifact entries.
 * @param {string} cwd - Project root directory
 * @returns {string[]} List of added entries
 */
function updateGitignore(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");
  const added = [];

  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf8");
  }

  const lines = content.split("\n");
  const newEntries = [];

  for (const entry of GITIGNORE_ENTRIES) {
    if (!lines.some((line) => line.trim() === entry)) {
      newEntries.push(entry);
      added.push(entry);
    }
  }

  if (newEntries.length > 0) {
    const section = "\n# tobari v2.0.0 runtime artifacts\n" +
      newEntries.join("\n") + "\n";
    fs.writeFileSync(gitignorePath, content.trimEnd() + section);
  }

  return added;
}

/**
 * Run the v2.0.0 migration.
 * @param {string} cwd - Project root directory
 */
function run(cwd) {
  const removed = removePythonHooks(cwd);
  if (removed.length > 0) {
    console.log(`    Removed ${removed.length} Python hook(s): ${removed.join(", ")}`);
  }

  const added = updateGitignore(cwd);
  if (added.length > 0) {
    console.log(`    Added ${added.length} .gitignore entry(ies)`);
  }
}

module.exports = {
  version: "2.0.0",
  description: "Remove Python hooks, add v2.0.0 .gitignore entries",
  run,
  // Exported for testing
  PYTHON_HOOKS_TO_REMOVE,
  GITIGNORE_ENTRIES,
  removePythonHooks,
  updateGitignore,
};
