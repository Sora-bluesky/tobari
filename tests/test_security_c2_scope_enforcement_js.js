#!/usr/bin/env node
"use strict";
/**
 * Security Test C2: Scope Enforcement Bypass Resistance.
 *
 * Tests the Gate engine's scope enforcement to ensure:
 * - Files outside scope include paths are denied
 * - Files in scope exclude paths are denied (excludes take precedence)
 * - Path traversal attempts are caught
 * - Protected directories are denied unless explicitly in scope
 * - Legitimate scope access is allowed
 * - Edge cases (empty scope, backslash paths, trailing slashes) behave correctly
 *
 * Relevant source modules:
 *   .claude/hooks/tobari-session.js — isPathInScope, canonicalPathKey, isDirPrefix
 *   .claude/hooks/tobari-gate.js    — checkScope, checkProtectedDirectory, checkBoundaryClassification
 *
 * Run: node --test tests/test_security_c2_scope_enforcement_js.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PROJECT_DIR = path.resolve(__dirname, "..");
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;

const tobariSession = require("../.claude/hooks/tobari-session.js");
const gate = require("../.claude/hooks/tobari-gate.js");

// --- Test Helpers ---

/**
 * Create a temporary directory for isolated testing.
 */
function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tobari-c2-test-"));
}

/**
 * Clean up a temporary directory.
 */
function cleanupTmpDir(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // Windows may hold locks briefly
  }
}

/**
 * Create a tobari-session.json in tmpDir/.claude/ with given session data.
 */
function createSessionFile(tmpDir, session) {
  const claudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  // Also create logs dir for evidence writing
  fs.mkdirSync(path.join(claudeDir, "logs"), { recursive: true });
  const sessionPath = path.join(claudeDir, "tobari-session.json");
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), "utf8");
  return sessionPath;
}

/**
 * Build an active session with given scope.
 * Default scope: { include: ["tests/", "docs/"], exclude: ["scripts/"] }
 */
function makeActiveSession(scope) {
  return {
    active: true,
    task: "C2-scope-test",
    profile: "standard",
    gates_passed: ["STG0"],
    retry_count: 0,
    token_usage: { input: 0, output: 0, budget: 500000 },
    contract: {
      intent: "scope enforcement testing",
      scope: scope || {
        include: ["tests/", "docs/"],
        exclude: ["scripts/"],
      },
    },
  };
}

/**
 * Invoke the gate handler for a Write tool call.
 */
function gateWrite(filePath, content) {
  return gate.handler({
    tool_name: "Write",
    tool_input: { file_path: filePath, content: content || "test" },
  });
}

/**
 * Invoke the gate handler for an Edit tool call.
 */
function gateEdit(filePath, oldString, newString) {
  return gate.handler({
    tool_name: "Edit",
    tool_input: {
      file_path: filePath,
      old_string: oldString || "old",
      new_string: newString || "new",
    },
  });
}

/**
 * Assert that a gate result is a deny.
 */
function assertDeny(result, msg) {
  assert.notEqual(result, null, `Expected deny but got null: ${msg}`);
  assert.equal(
    result.hookSpecificOutput.permissionDecision,
    "deny",
    `Expected permissionDecision=deny: ${msg}`,
  );
}

/**
 * Assert that a gate result is NOT a deny (null or no deny decision).
 */
function assertAllow(result, msg) {
  if (result === null || result === undefined) return; // null = pass through
  assert.notEqual(
    result.hookSpecificOutput.permissionDecision,
    "deny",
    `Expected allow but got deny: ${msg}`,
  );
}

// =========================================================================
// C2: Scope Enforcement Bypass Resistance
// =========================================================================

describe("C2: Scope enforcement — deny out-of-scope writes", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    // Scope: include tests/ and docs/, exclude scripts/
    createSessionFile(tmpDir, makeActiveSession());
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
    tobariSession._resetCache();
    if (tmpDir) cleanupTmpDir(tmpDir);
  });

  it("denies write to file outside scope include paths (src/app.js)", () => {
    const result = gateWrite(path.join(tmpDir, "src", "app.js"));
    assertDeny(result, "src/ is not in include list");
  });

  it("denies edit of file in scope exclude path (scripts/build.sh)", () => {
    const result = gateEdit(path.join(tmpDir, "scripts", "build.sh"));
    assertDeny(result, "scripts/ is excluded");
  });

  it("denies write to completely unrelated directory (lib/util.js)", () => {
    const result = gateWrite(path.join(tmpDir, "lib", "util.js"));
    assertDeny(result, "lib/ is not in include list");
  });
});

describe("C2: Path traversal attempts", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    createSessionFile(tmpDir, makeActiveSession());
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
    tobariSession._resetCache();
    if (tmpDir) cleanupTmpDir(tmpDir);
  });

  it("denies traversal to protected dir: tests/../.git/config", () => {
    // The path resolves to {tmpDir}/.git/config which is protected
    const traversalPath = path.join(tmpDir, "tests", "..", ".git", "config");
    const result = gateWrite(traversalPath);
    assertDeny(result, "path traversal to .git/ should be denied");
  });

  it("denies escape from project root: tests/../../etc/passwd", () => {
    // This path escapes the project root — validateInput catches it
    const traversalPath = path.join(
      tmpDir,
      "tests",
      "..",
      "..",
      "etc",
      "passwd",
    );
    const result = gateWrite(traversalPath);
    // Should be denied either by path traversal detection or scope check
    assertDeny(result, "escape from project root should be denied");
  });

  it("denies traversal to out-of-scope dir: ./tests/../scripts/dangerous.sh", () => {
    // Resolves to {tmpDir}/scripts/dangerous.sh which is in exclude
    const traversalPath = path.join(
      tmpDir,
      "tests",
      "..",
      "scripts",
      "dangerous.sh",
    );
    const result = gateWrite(traversalPath);
    assertDeny(result, "traversal to excluded scripts/ should be denied");
  });
});

describe("C2: Protected directory bypass resistance", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    // Scope includes only tests/ and docs/ — NOT protected dirs
    createSessionFile(
      tmpDir,
      makeActiveSession({
        include: ["tests/", "docs/"],
        exclude: [],
      }),
    );
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
    tobariSession._resetCache();
    if (tmpDir) cleanupTmpDir(tmpDir);
  });

  it("denies direct write to .git/config", () => {
    const result = gateWrite(path.join(tmpDir, ".git", "config"));
    assertDeny(result, ".git/ is protected");
  });

  it("denies direct write to .claude/hooks/tobari-gate.js when NOT in scope", () => {
    const result = gateWrite(
      path.join(tmpDir, ".claude", "hooks", "tobari-gate.js"),
    );
    assertDeny(result, ".claude/hooks/ is protected");
  });

  it("denies write to .claude/rules/security.md", () => {
    const result = gateWrite(
      path.join(tmpDir, ".claude", "rules", "security.md"),
    );
    assertDeny(result, ".claude/rules/ is protected");
  });

  it("denies write to .agents/some-file.json", () => {
    const result = gateWrite(path.join(tmpDir, ".agents", "some-file.json"));
    assertDeny(result, ".agents/ is protected");
  });
});

describe("C2: Legitimate access — should allow", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    createSessionFile(
      tmpDir,
      makeActiveSession({
        include: ["tests/", "docs/"],
        exclude: ["scripts/"],
      }),
    );
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
    tobariSession._resetCache();
    if (tmpDir) cleanupTmpDir(tmpDir);
  });

  it("allows write to file in scope include path (tests/new-file.js)", () => {
    const result = gateWrite(path.join(tmpDir, "tests", "new-file.js"));
    assertAllow(result, "tests/ is in scope include");
  });

  it("allows edit of file in scope include path (docs/guide.md)", () => {
    const result = gateEdit(path.join(tmpDir, "docs", "guide.md"));
    assertAllow(result, "docs/ is in scope include");
  });

  it("allows write to protected directory exception (.claude/tobari-session.json)", () => {
    const result = gateWrite(
      path.join(tmpDir, ".claude", "tobari-session.json"),
    );
    // tobari-session.json is an exception to protected directory rules
    // but it is NOT in scope include, so scope check might deny it.
    // checkProtectedDirectory runs before checkScope and returns null for exceptions.
    // Then checkScope sees it is not in tests/ or docs/ and denies.
    // This tests the *protected directory exception* behavior specifically.
    // For this to pass as "allow", we need it in scope include.
    // Re-testing with scope that includes it:
    // Actually, the test intent is: the protected directory exception allows it
    // even though .claude/ is protected. But scope might still block.
    // Let's test checkProtectedDirectory directly for clarity.
    const pdResult = gate.checkProtectedDirectory(
      path.join(tmpDir, ".claude", "tobari-session.json"),
      "Write",
    );
    assert.equal(
      pdResult,
      null,
      ".claude/tobari-session.json is a protected directory exception",
    );
  });

  it("allows write to .claude/logs/ (protected directory exception)", () => {
    const pdResult = gate.checkProtectedDirectory(
      path.join(tmpDir, ".claude", "logs", "evidence.jsonl"),
      "Write",
    );
    assert.equal(
      pdResult,
      null,
      ".claude/logs/ is a protected directory exception",
    );
  });
});

describe("C2: Edge cases", () => {
  let tmpDir;

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
    tobariSession._resetCache();
    if (tmpDir) cleanupTmpDir(tmpDir);
  });

  it("empty scope (no include/exclude) returns null — no restriction", () => {
    tmpDir = createTmpDir();
    createSessionFile(
      tmpDir,
      makeActiveSession({
        include: [],
        exclude: [],
      }),
    );
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();

    // isPathInScope should return null when no scope constraints
    const result = tobariSession.isPathInScope(
      path.join(tmpDir, "any", "file.js"),
    );
    assert.equal(
      result,
      null,
      "Empty scope should return null (no restriction)",
    );
  });

  it("Windows-style backslash paths are handled correctly", () => {
    tmpDir = createTmpDir();
    createSessionFile(
      tmpDir,
      makeActiveSession({
        include: ["tests/"],
        exclude: [],
      }),
    );
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();

    // Use backslash path (Windows style)
    const backslashPath = tmpDir + "\\tests\\new-file.js";
    const result = tobariSession.isPathInScope(backslashPath);
    assert.equal(
      result,
      true,
      "Backslash paths should be normalized and matched",
    );
  });

  it("trailing slash variations in scope patterns are handled", () => {
    tmpDir = createTmpDir();
    // Include paths with and without trailing slash
    createSessionFile(
      tmpDir,
      makeActiveSession({
        include: ["tests", "docs/"],
        exclude: [],
      }),
    );
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();

    // Both should match
    const testsResult = tobariSession.isPathInScope(
      path.join(tmpDir, "tests", "file.js"),
    );
    assert.equal(
      testsResult,
      true,
      "tests (no trailing slash) should match tests/file.js",
    );

    const docsResult = tobariSession.isPathInScope(
      path.join(tmpDir, "docs", "file.md"),
    );
    assert.equal(
      docsResult,
      true,
      "docs/ (with trailing slash) should match docs/file.md",
    );
  });

  it("exclude takes precedence over include", () => {
    tmpDir = createTmpDir();
    // tests/ is in both include AND exclude
    createSessionFile(
      tmpDir,
      makeActiveSession({
        include: ["tests/"],
        exclude: ["tests/"],
      }),
    );
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();

    const result = tobariSession.isPathInScope(
      path.join(tmpDir, "tests", "file.js"),
    );
    assert.equal(result, false, "Exclude should take precedence over include");
  });

  it("scope does not allow partial directory name match (testsx/ vs tests/)", () => {
    tmpDir = createTmpDir();
    createSessionFile(
      tmpDir,
      makeActiveSession({
        include: ["tests/"],
        exclude: [],
      }),
    );
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();

    // isDirPrefix should NOT match "testsx/" when scope is "tests/"
    const result = tobariSession.isPathInScope(
      path.join(tmpDir, "testsx", "file.js"),
    );
    assert.equal(
      result,
      false,
      "testsx/ should NOT match tests/ scope (boundary check)",
    );
  });
});

describe("C2: Handler integration — full gate flow", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    createSessionFile(
      tmpDir,
      makeActiveSession({
        include: ["tests/", "docs/"],
        exclude: ["scripts/"],
      }),
    );
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
    tobariSession._resetCache();
    if (tmpDir) cleanupTmpDir(tmpDir);
  });

  it("handler denies Write to out-of-scope path through full flow", () => {
    const result = gate.handler({
      tool_name: "Write",
      tool_input: {
        file_path: path.join(tmpDir, "src", "malicious.js"),
        content: "test content",
      },
    });
    assertDeny(result, "Full handler should deny out-of-scope Write");
  });

  it("handler allows Write to in-scope path through full flow", () => {
    const result = gate.handler({
      tool_name: "Write",
      tool_input: {
        file_path: path.join(tmpDir, "tests", "legit.js"),
        content: "test content",
      },
    });
    assertAllow(result, "Full handler should allow in-scope Write");
  });

  it("handler denies Edit to excluded path through full flow", () => {
    const result = gate.handler({
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(tmpDir, "scripts", "deploy.sh"),
        old_string: "old",
        new_string: "new",
      },
    });
    assertDeny(result, "Full handler should deny Edit in excluded path");
  });

  it("handler denies protected directory write even if path looks similar to scope", () => {
    const result = gate.handler({
      tool_name: "Write",
      tool_input: {
        file_path: path.join(tmpDir, ".git", "hooks", "pre-commit"),
        content: "malicious hook",
      },
    });
    assertDeny(
      result,
      "Handler should deny .git/ write via protected directory check",
    );
  });
});

// =========================================================================
// C2: Bash Scope Bypass Resistance
// =========================================================================

describe("C2: extractBashWriteTargets", () => {
  it("detects redirect > file", () => {
    const targets = gate.extractBashWriteTargets("echo hello > output.txt");
    assert.ok(
      targets.includes("output.txt"),
      "should detect > redirect target",
    );
  });

  it("detects append redirect >> file", () => {
    const targets = gate.extractBashWriteTargets("echo hello >> log.txt");
    assert.ok(targets.includes("log.txt"), "should detect >> redirect target");
  });

  it("skips /dev/null redirect", () => {
    const targets = gate.extractBashWriteTargets("command > /dev/null");
    assert.equal(targets.length, 0, "/dev/null should be excluded");
  });

  it("skips /dev/stderr redirect", () => {
    const targets = gate.extractBashWriteTargets("command 2> /dev/stderr");
    assert.equal(targets.length, 0, "/dev/stderr should be excluded");
  });

  it("skips variable reference targets", () => {
    const targets = gate.extractBashWriteTargets("echo hello > $OUTPUT_FILE");
    assert.equal(targets.length, 0, "$VAR targets should be skipped");
  });

  it("detects tee target", () => {
    const targets = gate.extractBashWriteTargets("echo hello | tee output.txt");
    assert.ok(targets.includes("output.txt"), "should detect tee target");
  });

  it("detects tee -a target", () => {
    const targets = gate.extractBashWriteTargets("echo hello | tee -a log.txt");
    assert.ok(targets.includes("log.txt"), "should detect tee -a target");
  });

  it("detects cp destination", () => {
    const targets = gate.extractBashWriteTargets("cp source.txt dest.txt");
    assert.ok(targets.includes("dest.txt"), "should detect cp destination");
  });

  it("detects mv destination", () => {
    const targets = gate.extractBashWriteTargets("mv old.txt new.txt");
    assert.ok(targets.includes("new.txt"), "should detect mv destination");
  });

  it("detects python -c file write", () => {
    const targets = gate.extractBashWriteTargets(
      `python -c "open('CLAUDE.md','w').write('hacked')"`,
    );
    assert.ok(
      targets.includes("CLAUDE.md"),
      "should detect python -c write target",
    );
  });

  it("detects python3 -c file write", () => {
    const targets = gate.extractBashWriteTargets(
      `python3 -c "open('config.py','w').write('x')"`,
    );
    assert.ok(
      targets.includes("config.py"),
      "should detect python3 -c write target",
    );
  });

  it("detects node -e writeFileSync", () => {
    const targets = gate.extractBashWriteTargets(
      `node -e "require('fs').writeFileSync('out.js','x')"`,
    );
    assert.ok(
      targets.includes("out.js"),
      "should detect node -e writeFileSync target",
    );
  });

  it("detects dd of=file", () => {
    const targets = gate.extractBashWriteTargets(
      "dd if=/dev/zero of=disk.img bs=1M count=1",
    );
    assert.ok(targets.includes("disk.img"), "should detect dd of= target");
  });

  it("detects PowerShell Set-Content", () => {
    const targets = gate.extractBashWriteTargets(
      "pwsh -c \"Set-Content -Path config.json -Value '{}'\"",
    );
    assert.ok(
      targets.includes("config.json"),
      "should detect Set-Content target",
    );
  });

  it("detects PowerShell Out-File", () => {
    const targets = gate.extractBashWriteTargets(
      "pwsh -c \"'data' | Out-File report.txt\"",
    );
    assert.ok(targets.includes("report.txt"), "should detect Out-File target");
  });

  it("returns empty for read-only commands", () => {
    const targets = gate.extractBashWriteTargets("git status");
    assert.equal(targets.length, 0, "git status should have no write targets");
  });

  it("returns empty for echo without redirect", () => {
    const targets = gate.extractBashWriteTargets("echo hello world");
    assert.equal(
      targets.length,
      0,
      "echo without redirect should have no targets",
    );
  });
});

describe("C2: Bash scope bypass resistance — handler integration", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    createSessionFile(
      tmpDir,
      makeActiveSession({
        include: ["tests/", "docs/"],
        exclude: ["scripts/"],
      }),
    );
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
    tobariSession._resetCache();
    if (tmpDir) cleanupTmpDir(tmpDir);
  });

  it("blocks echo > out-of-scope file via handler", () => {
    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "echo hacked > src/app.js" },
    });
    assertDeny(result, "Bash redirect to out-of-scope file should be denied");
  });

  it("blocks tee to out-of-scope file via handler", () => {
    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "echo data | tee src/config.js" },
    });
    assertDeny(result, "Bash tee to out-of-scope file should be denied");
  });

  it("blocks python -c write to out-of-scope file via handler", () => {
    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: `python -c "open('CLAUDE.md','w').write('x')"` },
    });
    assertDeny(result, "python -c write to out-of-scope file should be denied");
  });

  it("blocks cp to out-of-scope destination via handler", () => {
    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "cp tests/data.txt src/data.txt" },
    });
    assertDeny(result, "cp to out-of-scope destination should be denied");
  });

  it("blocks sed -i on excluded file via handler", () => {
    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "sed -i 's/old/new/g' scripts/deploy.sh" },
    });
    // sed -i on excluded path should be denied
    // Note: sed pattern extraction depends on expression format
    assertDeny(result, "sed -i on excluded file should be denied");
  });

  it("allows echo > in-scope file via handler", () => {
    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "echo test > tests/output.txt" },
    });
    assertAllow(result, "Bash redirect to in-scope file should be allowed");
  });

  it("allows echo > /dev/null via handler", () => {
    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "command > /dev/null 2>&1" },
    });
    assertAllow(result, "/dev/null redirect should be allowed");
  });

  it("allows git commands via handler", () => {
    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'fix: update'" },
    });
    assertAllow(result, "git commands should be allowed");
  });

  it("allows Bash read commands without scope check", () => {
    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "ls -la src/" },
    });
    assertAllow(result, "read-only commands should be allowed");
  });

  it("returns null when no session is active", () => {
    // Point to a temp dir with NO session file
    const noSessionDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = noSessionDir;
    tobariSession._resetCache();

    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "echo hacked > CLAUDE.md" },
    });
    // No session = advisory mode, not deny
    if (result) {
      assert.notEqual(
        result.hookSpecificOutput?.permissionDecision,
        "deny",
        "No session should not produce deny",
      );
    }
    cleanupTmpDir(noSessionDir);
  });

  it("allows INFRA_WHITELIST files (HANDOFF.md) via Bash", () => {
    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "echo update > HANDOFF.md" },
    });
    assertAllow(
      result,
      "HANDOFF.md is in INFRA_WHITELIST and should be allowed",
    );
  });

  it("blocks Bash redirect to protected directory (.git/config)", () => {
    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "echo x > .git/config" },
    });
    assertDeny(result, "Bash redirect to .git/ should be denied");
  });
});
