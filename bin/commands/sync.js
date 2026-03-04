"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  TEMPLATE_DIR,
  VERSION_FILE,
  deployWithMerge,
  setRunShPermissions,
  updateGitignore,
  checkDrift,
} = require("../lib/deploy");

module.exports = function sync(options) {
  const cwd = process.cwd();

  if (options.check) {
    return runCheck(cwd);
  }

  const force = options.force || false;
  const pkg = require("../../package.json");
  const currentVersion = pkg.version;

  // --- Validate templates exist ---
  const templateClaudeDir = path.join(TEMPLATE_DIR, ".claude");
  if (!fs.existsSync(templateClaudeDir)) {
    console.error(
      "Error: tobari templates not found.\n" +
        "The npm package may be corrupted. Try: npm install tobari"
    );
    process.exit(1);
  }

  // --- Version check ---
  const versionFilePath = path.join(cwd, VERSION_FILE);
  if (!force) {
    const installedVersion = readVersionFile(versionFilePath);
    if (installedVersion === currentVersion) {
      console.log(`tobari v${currentVersion} - already up to date.`);
      return;
    }
  }

  // --- Check if .claude/ exists ---
  const claudeDir = path.join(cwd, ".claude");
  if (!fs.existsSync(claudeDir)) {
    // First sync = treat as fresh install (copy everything)
    console.log(`tobari sync v${currentVersion} (initial setup)\n`);
    fs.cpSync(templateClaudeDir, claudeDir, { recursive: true });
  } else {
    // Existing .claude/ = merge deploy
    console.log(`tobari sync v${currentVersion}\n`);
    deployWithMerge(cwd, { verbose: true });
  }

  // --- Post-deploy steps ---
  updateGitignore(cwd);
  setRunShPermissions(cwd);

  // --- Write version file ---
  writeVersionFile(versionFilePath, currentVersion);

  console.log(`\n  Sync complete. ${VERSION_FILE} updated to ${currentVersion}`);
};

/**
 * Read the installed version from .tobari-version file.
 * @param {string} filePath
 * @returns {string|null} Version string or null if file does not exist
 */
function readVersionFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Write version to .tobari-version file.
 * @param {string} filePath
 * @param {string} version
 */
function writeVersionFile(filePath, version) {
  fs.writeFileSync(filePath, version + "\n");
}

/**
 * Run drift check (read-only mode). Exits with code 1 if drift detected.
 * @param {string} cwd - Project root directory
 */
function runCheck(cwd) {
  const pkg = require("../../package.json");
  const currentVersion = pkg.version;

  // Validate templates exist
  const templateClaudeDir = path.join(TEMPLATE_DIR, ".claude");
  if (!fs.existsSync(templateClaudeDir)) {
    console.error(
      "Error: tobari templates not found.\n" +
        "The npm package may be corrupted. Try: npm install tobari"
    );
    process.exit(1);
  }

  console.log(`tobari sync --check v${currentVersion}\n`);

  // Check if .claude/ exists at all
  const claudeDir = path.join(cwd, ".claude");
  if (!fs.existsSync(claudeDir)) {
    printCheckResult("drift", ".claude/", "directory not found");
    console.log("\nDrift detected. Run 'tobari sync' or 'tobari init' to set up.");
    process.exit(1);
  }

  const { hasDrift, categories } = checkDrift(cwd);

  for (const cat of categories) {
    printCheckResult(cat.status, cat.name, cat.detail);
  }

  if (hasDrift) {
    console.log("\nDrift detected. Run 'tobari sync' to update.");
    process.exit(1);
  } else {
    console.log("\nAll files in sync.");
  }
}

/**
 * Print a single check result line.
 * @param {string} status - "ok" or "drift"
 * @param {string} label - Category name
 * @param {string} detail - Description
 */
function printCheckResult(status, label, detail) {
  const icon = status === "ok" ? "  [OK]  " : "  [NG]  ";
  const paddedLabel = label.padEnd(20);
  console.log(`${icon}${paddedLabel}${detail}`);
}
