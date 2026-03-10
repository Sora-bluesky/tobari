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
    `Expected permissionDecision=deny: ${msg}`
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
    `Expected allow but got deny: ${msg}`
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
    const traversalPath = path.join(tmpDir, "tests", "..", "..", "etc", "passwd");
    const result = gateWrite(traversalPath);
    // Should be denied either by path traversal detection or scope check
    assertDeny(result, "escape from project root should be denied");
  });

  it("denies traversal to out-of-scope dir: ./tests/../scripts/dangerous.sh", () => {
    // Resolves to {tmpDir}/scripts/dangerous.sh which is in exclude
    const traversalPath = path.join(tmpDir, "tests", "..", "scripts", "dangerous.sh");
    const result = gateWrite(traversalPath);
    assertDeny(result, "traversal to excluded scripts/ should be denied");
  });
});

describe("C2: Protected directory bypass resistance", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    // Scope includes only tests/ and docs/ — NOT protected dirs
    createSessionFile(tmpDir, makeActiveSession({
      include: ["tests/", "docs/"],
      exclude: [],
    }));
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
      path.join(tmpDir, ".claude", "hooks", "tobari-gate.js")
    );
    assertDeny(result, ".claude/hooks/ is protected");
  });

  it("denies write to .claude/rules/security.md", () => {
    const result = gateWrite(
      path.join(tmpDir, ".claude", "rules", "security.md")
    );
    assertDeny(result, ".claude/rules/ is protected");
  });

  it("denies write to .agents/some-file.json", () => {
    const result = gateWrite(
      path.join(tmpDir, ".agents", "some-file.json")
    );
    assertDeny(result, ".agents/ is protected");
  });
});

describe("C2: Legitimate access — should allow", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    createSessionFile(tmpDir, makeActiveSession({
      include: ["tests/", "docs/"],
      exclude: ["scripts/"],
    }));
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
      path.join(tmpDir, ".claude", "tobari-session.json")
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
      "Write"
    );
    assert.equal(
      pdResult, null,
      ".claude/tobari-session.json is a protected directory exception"
    );
  });

  it("allows write to .claude/logs/ (protected directory exception)", () => {
    const pdResult = gate.checkProtectedDirectory(
      path.join(tmpDir, ".claude", "logs", "evidence.jsonl"),
      "Write"
    );
    assert.equal(
      pdResult, null,
      ".claude/logs/ is a protected directory exception"
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
    createSessionFile(tmpDir, makeActiveSession({
      include: [],
      exclude: [],
    }));
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();

    // isPathInScope should return null when no scope constraints
    const result = tobariSession.isPathInScope(
      path.join(tmpDir, "any", "file.js")
    );
    assert.equal(result, null, "Empty scope should return null (no restriction)");
  });

  it("Windows-style backslash paths are handled correctly", () => {
    tmpDir = createTmpDir();
    createSessionFile(tmpDir, makeActiveSession({
      include: ["tests/"],
      exclude: [],
    }));
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();

    // Use backslash path (Windows style)
    const backslashPath = tmpDir + "\\tests\\new-file.js";
    const result = tobariSession.isPathInScope(backslashPath);
    assert.equal(result, true, "Backslash paths should be normalized and matched");
  });

  it("trailing slash variations in scope patterns are handled", () => {
    tmpDir = createTmpDir();
    // Include paths with and without trailing slash
    createSessionFile(tmpDir, makeActiveSession({
      include: ["tests", "docs/"],
      exclude: [],
    }));
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();

    // Both should match
    const testsResult = tobariSession.isPathInScope(
      path.join(tmpDir, "tests", "file.js")
    );
    assert.equal(testsResult, true, "tests (no trailing slash) should match tests/file.js");

    const docsResult = tobariSession.isPathInScope(
      path.join(tmpDir, "docs", "file.md")
    );
    assert.equal(docsResult, true, "docs/ (with trailing slash) should match docs/file.md");
  });

  it("exclude takes precedence over include", () => {
    tmpDir = createTmpDir();
    // tests/ is in both include AND exclude
    createSessionFile(tmpDir, makeActiveSession({
      include: ["tests/"],
      exclude: ["tests/"],
    }));
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();

    const result = tobariSession.isPathInScope(
      path.join(tmpDir, "tests", "file.js")
    );
    assert.equal(result, false, "Exclude should take precedence over include");
  });

  it("scope does not allow partial directory name match (testsx/ vs tests/)", () => {
    tmpDir = createTmpDir();
    createSessionFile(tmpDir, makeActiveSession({
      include: ["tests/"],
      exclude: [],
    }));
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();

    // isDirPrefix should NOT match "testsx/" when scope is "tests/"
    const result = tobariSession.isPathInScope(
      path.join(tmpDir, "testsx", "file.js")
    );
    assert.equal(result, false, "testsx/ should NOT match tests/ scope (boundary check)");
  });
});

describe("C2: Handler integration — full gate flow", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    createSessionFile(tmpDir, makeActiveSession({
      include: ["tests/", "docs/"],
      exclude: ["scripts/"],
    }));
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
    assertDeny(result, "Handler should deny .git/ write via protected directory check");
  });
});
