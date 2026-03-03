"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const REQUIRED_HOOKS = [
  "_run.sh",
  "tobari_session.py",
  "tobari_stage.py",
  "tobari-gate.py",
  "tobari-evidence.py",
  "tobari-evidence-failure.py",
  "tobari-stop.py",
  "tobari-cost.py",
  "tobari-permission.py",
  "tobari-precompact.py",
  "tobari-session-start.py",
  "lint-on-save.py",
];

const REQUIRED_HOOK_TYPES = ["PreToolUse", "PostToolUse", "Stop"];

module.exports = function verify() {
  const cwd = process.cwd();
  const results = [];

  console.log("\ntobari setup verification\n");

  // Check 1: Python version
  results.push(checkPython());

  // Check 2: hooks files
  results.push(checkHooksFiles(cwd));

  // Check 3: settings.json hooks config
  results.push(checkSettingsJson(cwd));

  // Check 4: .gitignore entries
  results.push(checkGitignore(cwd));

  // Check 5: _run.sh executable permission
  results.push(checkRunShPermission(cwd));

  // Summary
  console.log("");
  const hasFail = results.some((r) => r === "fail");
  const hasWarn = results.some((r) => r === "warn");

  if (hasFail) {
    console.log("TOBARI_SETUP=fail");
    process.exit(1);
  } else if (hasWarn) {
    console.log("TOBARI_SETUP=warn");
  } else {
    console.log("TOBARI_SETUP=ok");
  }
};

function checkPython() {
  const candidates = ["python3", "python"];
  for (const cmd of candidates) {
    try {
      const output = execSync(`${cmd} --version`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const match = output.match(/Python\s+(\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        if (major >= 3 && minor >= 10) {
          printResult("pass", `Python 3.10+`, `${cmd} ${output}`);
          return "pass";
        }
        printResult(
          "fail",
          "Python 3.10+",
          `${output} found, but 3.10+ required`
        );
        return "fail";
      }
    } catch {
      // try next
    }
  }
  printResult("fail", "Python 3.10+", "python3/python not found");
  return "fail";
}

function checkHooksFiles(cwd) {
  const hooksDir = path.join(cwd, ".claude", "hooks");
  if (!fs.existsSync(hooksDir)) {
    printResult("fail", "hooks directory", ".claude/hooks/ not found");
    return "fail";
  }

  const missing = [];
  for (const hook of REQUIRED_HOOKS) {
    if (!fs.existsSync(path.join(hooksDir, hook))) {
      missing.push(hook);
    }
  }

  const found = REQUIRED_HOOKS.length - missing.length;
  if (missing.length === 0) {
    printResult(
      "pass",
      "hooks files",
      `${found}/${REQUIRED_HOOKS.length} present`
    );
    return "pass";
  }
  printResult(
    "fail",
    "hooks files",
    `${found}/${REQUIRED_HOOKS.length} present, missing: ${missing.join(", ")}`
  );
  return "fail";
}

function checkSettingsJson(cwd) {
  const settingsPath = path.join(cwd, ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) {
    printResult("fail", "settings.json hooks", ".claude/settings.json not found");
    return "fail";
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    printResult("fail", "settings.json hooks", "JSON parse error");
    return "fail";
  }

  if (!settings.hooks) {
    printResult("fail", "settings.json hooks", "no hooks section");
    return "fail";
  }

  const missing = [];
  for (const hookType of REQUIRED_HOOK_TYPES) {
    if (
      !settings.hooks[hookType] ||
      !Array.isArray(settings.hooks[hookType]) ||
      settings.hooks[hookType].length === 0
    ) {
      missing.push(hookType);
    }
  }

  if (missing.length === 0) {
    printResult(
      "pass",
      "settings.json hooks",
      `${REQUIRED_HOOK_TYPES.join(" / ")} configured`
    );
    return "pass";
  }
  printResult("fail", "settings.json hooks", `missing: ${missing.join(", ")}`);
  return "fail";
}

function checkGitignore(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    printResult("warn", ".gitignore", "file not found");
    return "warn";
  }

  const content = fs.readFileSync(gitignorePath, "utf8");
  if (content.includes("tobari-session.json")) {
    printResult("pass", ".gitignore", "tobari-session.json excluded");
    return "pass";
  }
  printResult("warn", ".gitignore", "tobari-session.json not excluded");
  return "warn";
}

function checkRunShPermission(cwd) {
  const runShPath = path.join(cwd, ".claude", "hooks", "_run.sh");
  if (!fs.existsSync(runShPath)) {
    printResult("warn", "_run.sh permission", "file not found");
    return "warn";
  }

  try {
    fs.accessSync(runShPath, fs.constants.X_OK);
    printResult("pass", "_run.sh permission", "executable");
    return "pass";
  } catch {
    // On Windows, X_OK check may not work correctly
    if (process.platform === "win32") {
      printResult("pass", "_run.sh permission", "Windows (git manages permissions)");
      return "pass";
    }
    printResult("warn", "_run.sh permission", "not executable");
    return "warn";
  }
}

function printResult(status, label, detail) {
  const icons = { pass: "  [OK]  ", fail: "  [NG]  ", warn: "  [!!]  " };
  const icon = icons[status] || "  [??]  ";
  const paddedLabel = label.padEnd(24);
  console.log(`${icon}${paddedLabel}${detail}`);
}
