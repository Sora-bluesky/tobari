"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_HOOKS = [
  "tobari-session.js",
  "tobari-stage.js",
  "tobari-gate.js",
  "tobari-evidence.js",
  "tobari-evidence-failure.js",
  "tobari-stop.js",
  "tobari-cost.js",
  "tobari-permission.js",
  "tobari-precompact.js",
  "tobari-session-start.js",
  "tobari-injection-guard.js",
  "tobari-i18n.js",
  "lint-on-save.js",
];

const REQUIRED_HOOK_TYPES = ["PreToolUse", "PostToolUse", "Stop"];

module.exports = function verify(options = {}) {
  const cwd = process.cwd();
  const results = [];
  const runTests = options.test || false;

  console.log("\ntobari setup verification\n");

  // Check 1: Node.js version
  results.push(checkNode());

  // Check 2: hooks files
  results.push(checkHooksFiles(cwd));

  // Check 3: settings.json hooks config
  results.push(checkSettingsJson(cwd));

  // Check 4: .gitignore entries
  results.push(checkGitignore(cwd));

  // Check 5: prepare script in package.json
  results.push(checkPrepareScript(cwd));

  // Check 6: run tests (--test flag)
  if (runTests) {
    results.push(runNodeTests(cwd));
  }

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

function checkNode() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major >= 18) {
    printResult("pass", "Node.js 18+", `v${process.versions.node}`);
    return "pass";
  }
  printResult("fail", "Node.js 18+", `v${process.versions.node} found, but 18+ required`);
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

function checkPrepareScript(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) {
    printResult("warn", "prepare script", "no package.json found");
    return "warn";
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    printResult("warn", "prepare script", "JSON parse error");
    return "warn";
  }

  if (pkg.scripts && pkg.scripts.prepare &&
      pkg.scripts.prepare.includes("tobari sync")) {
    printResult("pass", "prepare script", '"tobari sync" in scripts.prepare');
    return "pass";
  }

  printResult("warn", "prepare script",
    'scripts.prepare does not include "tobari sync"');
  return "warn";
}

function runNodeTests(cwd) {
  const testsDir = path.join(cwd, "tests");
  if (!fs.existsSync(testsDir)) {
    printResult("warn", "tests", "tests/ directory not found");
    return "warn";
  }

  console.log("\n  Running tests...\n");
  try {
    const { execSync } = require("node:child_process");
    execSync("node --test tests/*.js --test-concurrency=1", {
      cwd,
      encoding: "utf8",
      stdio: "inherit",
      timeout: 300000,
    });
    printResult("pass", "tests", "all passed");
    return "pass";
  } catch {
    printResult("fail", "tests", "some tests failed");
    return "fail";
  }
}

function printResult(status, label, detail) {
  const icons = { pass: "  [OK]  ", fail: "  [NG]  ", warn: "  [!!]  " };
  const icon = icons[status] || "  [??]  ";
  const paddedLabel = label.padEnd(24);
  console.log(`${icon}${paddedLabel}${detail}`);
}
