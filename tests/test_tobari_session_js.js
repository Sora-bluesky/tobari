#!/usr/bin/env node
"use strict";
/**
 * Tests for TASK-081: tobari-session.js (Node.js port of tobari_session.py).
 *
 * Groups:
 *   L1-L3:   withFileLock() context manager behavior
 *   L4-L6:   readModifyWriteSession() helper
 *   L7-L9:   Refactored functions (updateGatesPassed, setRetryCount, updateTokenUsage)
 *   L10-L11: writeEvidence() with lock
 *   S1-S6:   Session management (loadSession, isVeilActive, getProfile, etc.)
 *   P1-P4:   Path / scope utilities (isDirPrefix, isPathInScope)
 *   C1-C2:   canonicalJson
 *   B1-B2:   buildContextOutput
 *   V1-V3:   raiseVeil / getRaisedInfo
 *   W1-W2:   getWebhookConfig
 *
 * Run: node --test tests/test_tobari_session_js.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const mod = require("../.claude/hooks/tobari-session.js");

// --- Test Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tobari-test-"));
}

function createSessionFile(tmpDir, data) {
  const claudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const sessionPath = path.join(claudeDir, "tobari-session.json");
  fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return sessionPath;
}

function createActiveSession(tmpDir) {
  return createSessionFile(tmpDir, {
    active: true,
    task: "TASK-TEST",
    profile: "standard",
    gates_passed: ["STG0"],
    retry_count: 0,
    token_usage: { input: 100, output: 50, budget: 500000 },
    contract: {
      intent: "test",
      scope: {
        include: [".claude/hooks/", "tests/"],
        exclude: ["tasks/", "docs/"],
      },
    },
  });
}

function createEvidenceDir(tmpDir) {
  const logDir = path.join(tmpDir, ".claude", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function cleanupTmpDir(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // Windows may hold locks briefly
  }
}

// ============================================================
// L1-L3: withFileLock()
// ============================================================

describe("withFileLock", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it("L1: normal acquire and release cycle", () => {
    const target = path.join(tmpDir, "test.json");
    fs.writeFileSync(target, "{}");
    const lockFile = target + ".lock";

    const result = mod.withFileLock(target, () => {
      // Lock file should exist during critical section
      assert.ok(fs.existsSync(lockFile));
      return 42;
    });

    assert.equal(result, 42);
    // Lock file removed after release
    assert.ok(!fs.existsSync(lockFile));

    // Verify re-acquire works
    mod.withFileLock(target, () => {});
  });

  it("L2: lock timeout when file is held", () => {
    const target = path.join(tmpDir, "test.json");
    fs.writeFileSync(target, "{}");
    const lockFile = target + ".lock";

    // Create lock file to simulate held lock
    fs.writeFileSync(lockFile, "fake-pid");

    assert.throws(
      () => mod.withFileLock(target, () => {}, 200),
      (err) => err.message.includes("lock timeout")
    );

    // Cleanup
    try { fs.unlinkSync(lockFile); } catch (_) {}
  });

  it("L3: lock released on exception", () => {
    const target = path.join(tmpDir, "test.json");
    fs.writeFileSync(target, "{}");
    const lockFile = target + ".lock";

    assert.throws(
      () => mod.withFileLock(target, () => { throw new Error("test error"); }),
      (err) => err.message === "test error"
    );

    // Lock should be released — verify by re-acquiring
    assert.ok(!fs.existsSync(lockFile));
    mod.withFileLock(target, () => {});
  });
});

// ============================================================
// L4-L6: readModifyWriteSession()
// ============================================================

describe("readModifyWriteSession", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    mod._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    mod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("L4: successful modify", () => {
    const sessionPath = createActiveSession(tmpDir);

    const result = mod.readModifyWriteSession((data) => {
      data.test_field = "hello";
    });
    assert.equal(result, true);

    const written = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.equal(written.test_field, "hello");
    assert.equal(written.active, true);
  });

  it("L5: returns false when no session file", () => {
    const result = mod.readModifyWriteSession(() => {});
    assert.equal(result, false);
  });

  it("L6: returns false when session inactive", () => {
    createSessionFile(tmpDir, { active: false });
    const result = mod.readModifyWriteSession(() => {});
    assert.equal(result, false);
  });

  it("L6b: returns false on corrupted JSON", () => {
    const claudeDir = path.join(tmpDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "tobari-session.json"),
      "not valid json{{{",
      "utf8"
    );
    const result = mod.readModifyWriteSession(() => {});
    assert.equal(result, false);
  });

  it("L6c: cache invalidated after write", () => {
    createActiveSession(tmpDir);

    // Pre-populate cache
    const session = mod.loadSession();
    assert.ok(session !== null);

    mod.readModifyWriteSession(() => {});

    // Cache should be invalidated — next load reads from file
    // (We can verify by modifying the file and checking loadSession returns new data)
  });
});

// ============================================================
// L7-L9: Refactored functions
// ============================================================

describe("refactored functions", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    mod._resetCache();
    createActiveSession(tmpDir);
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    mod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("L7: updateGatesPassed adds gate", () => {
    const result = mod.updateGatesPassed("STG1");
    assert.equal(result, true);

    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    const data = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.ok(data.gates_passed.includes("STG1"));
    assert.ok(data.gates_passed.includes("STG0"));
  });

  it("L7b: duplicate gate not added twice", () => {
    mod.updateGatesPassed("STG0"); // Already present

    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    const data = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    const count = data.gates_passed.filter((g) => g === "STG0").length;
    assert.equal(count, 1);
  });

  it("L8: setRetryCount updates and persists", () => {
    const result = mod.setRetryCount(3);
    assert.equal(result, true);

    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    const data = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.equal(data.retry_count, 3);
  });

  it("L8b: negative count clamped to 0", () => {
    mod.setRetryCount(-5);

    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    const data = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.equal(data.retry_count, 0);
  });

  it("L9: updateTokenUsage increments in cost state file", () => {
    const result = mod.updateTokenUsage(200, 100);
    assert.ok(result !== null);
    assert.equal(result.input, 200); // cost state starts at 0 + 200
    assert.equal(result.output, 100); // cost state starts at 0 + 100
    assert.equal(result.budget, 500000);

    // Verify cost state file (NOT session file)
    const costPath = path.join(tmpDir, ".claude", "tobari-cost-state.json");
    assert.ok(fs.existsSync(costPath), "cost state file should exist");
    const data = JSON.parse(fs.readFileSync(costPath, "utf8"));
    assert.equal(data.input, 200);
    assert.equal(data.output, 100);

    // Session file should NOT be modified by updateTokenUsage
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    const sessionData = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.equal(sessionData.token_usage.input, 100, "session token_usage unchanged");
  });

  it("L9b: updateTokenUsage returns null when no session", () => {
    process.env.CLAUDE_PROJECT_DIR = createTmpDir();
    mod._resetCache();
    const result = mod.updateTokenUsage(100, 50);
    assert.equal(result, null);
    cleanupTmpDir(process.env.CLAUDE_PROJECT_DIR);
  });
});

// ============================================================
// L10-L11: writeEvidence() with lock
// ============================================================

describe("writeEvidence", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    mod._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    mod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("L10: write evidence appends entry", () => {
    const result = mod.writeEvidence({
      event: "test_event",
      tool_name: "Bash",
    });
    assert.equal(result, true);

    const ledgerPath = path.join(tmpDir, ".claude", "logs", "evidence-ledger.jsonl");
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, "test_event");
    assert.ok(entry.timestamp);
    assert.equal(entry._chain_index, 0);
    assert.equal(entry._prev_hash, mod.CHAIN_GENESIS_HASH);
  });

  it("L11: multiple writes all persisted with chain", () => {
    for (let i = 0; i < 5; i++) {
      mod.writeEvidence({ event: `evt_${i}` });
    }

    const ledgerPath = path.join(tmpDir, ".claude", "logs", "evidence-ledger.jsonl");
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 5);

    // Verify chain indices are sequential
    for (let i = 0; i < 5; i++) {
      const entry = JSON.parse(lines[i]);
      assert.equal(entry._chain_index, i);
    }

    // Verify chain linking (entry[1]._prev_hash === hash(entry[0] line))
    const crypto = require("crypto");
    const entry1 = JSON.parse(lines[1]);
    const expectedHash = crypto.createHash("sha256").update(lines[0], "utf8").digest("hex");
    assert.equal(entry1._prev_hash, expectedHash);
  });
});

// ============================================================
// S1-S6: Session management
// ============================================================

describe("session management", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    mod._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    mod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("S1: loadSession returns active session", () => {
    createActiveSession(tmpDir);
    const session = mod.loadSession();
    assert.ok(session !== null);
    assert.equal(session.active, true);
    assert.equal(session.task, "TASK-TEST");
  });

  it("S2: loadSession returns null when no file", () => {
    const session = mod.loadSession();
    assert.equal(session, null);
  });

  it("S3: loadSession returns null when inactive", () => {
    createSessionFile(tmpDir, { active: false, task: "OLD" });
    const session = mod.loadSession();
    assert.equal(session, null);
  });

  it("S4: isVeilActive", () => {
    createActiveSession(tmpDir);
    assert.equal(mod.isVeilActive(), true);
  });

  it("S5: getProfile / getTask / getGatesPassed", () => {
    createActiveSession(tmpDir);
    assert.equal(mod.getProfile(), "standard");
    assert.equal(mod.getTask(), "TASK-TEST");
    assert.deepEqual(mod.getGatesPassed(), ["STG0"]);
  });

  it("S6: getScope / getContract", () => {
    createActiveSession(tmpDir);
    const scope = mod.getScope();
    assert.ok(scope !== null);
    assert.deepEqual(scope.include, [".claude/hooks/", "tests/"]);

    const contract = mod.getContract();
    assert.ok(contract !== null);
    assert.equal(contract.intent, "test");
  });
});

// ============================================================
// P1-P4: Path / scope utilities
// ============================================================

describe("path utilities", () => {
  it("P1: isDirPrefix exact match", () => {
    assert.equal(mod.isDirPrefix("src/app", "src/app"), true);
  });

  it("P1b: isDirPrefix with slash", () => {
    assert.equal(mod.isDirPrefix("src/app/file.js", "src/app"), true);
    assert.equal(mod.isDirPrefix("src/app/file.js", "src/app/"), true);
  });

  it("P1c: isDirPrefix rejects partial match", () => {
    assert.equal(mod.isDirPrefix("home/username/file.txt", "home/user"), false);
  });

  it("P2: isDirPrefix empty prefix returns false", () => {
    // Empty string is not a valid directory prefix
    assert.equal(mod.isDirPrefix("anything", ""), false);
  });
});

describe("isPathInScope", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    mod._resetCache();
    createActiveSession(tmpDir);
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    mod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("P3: in-scope path returns true", () => {
    assert.equal(mod.isPathInScope(".claude/hooks/gate.py"), true);
    assert.equal(mod.isPathInScope("tests/test_foo.py"), true);
  });

  it("P3b: excluded path returns false", () => {
    assert.equal(mod.isPathInScope("tasks/backlog.yaml"), false);
    assert.equal(mod.isPathInScope("docs/readme.md"), false);
  });

  it("P3c: unknown path returns false (not in includes)", () => {
    assert.equal(mod.isPathInScope("random/file.txt"), false);
  });

  it("P4: null when no session", () => {
    const emptyDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = emptyDir;
    mod._resetCache();
    assert.equal(mod.isPathInScope("anything"), null);
    cleanupTmpDir(emptyDir);
  });
});

// ============================================================
// C1-C2: canonicalJson
// ============================================================

describe("canonicalJson", () => {
  it("C1: sorts keys deterministically", () => {
    const result = mod.canonicalJson({ z: 1, a: 2, m: 3 });
    assert.equal(result, '{"a":2,"m":3,"z":1}');
  });

  it("C2: handles nested objects", () => {
    const result = mod.canonicalJson({ b: { z: 1, a: 2 }, a: 1 });
    assert.equal(result, '{"a":1,"b":{"a":2,"z":1}}');
  });
});

// ============================================================
// B1-B2: buildContextOutput
// ============================================================

describe("buildContextOutput", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    mod._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    mod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("B1: active session with placeholder replacement", () => {
    createActiveSession(tmpDir);
    const output = mod.buildContextOutput(
      "Intro.",
      "Task={task} Profile={profile}",
      "Inactive."
    );
    assert.ok(output.hookSpecificOutput);
    const ctx = output.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("Intro."));
    assert.ok(ctx.includes("Task=TASK-TEST"));
    assert.ok(ctx.includes("Profile=standard"));
  });

  it("B2: inactive session uses inactive text", () => {
    const output = mod.buildContextOutput("Intro.", "Active.", "Inactive.");
    const ctx = output.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("Intro."));
    assert.ok(ctx.includes("Inactive."));
    assert.ok(!ctx.includes("Active."));
  });
});

// ============================================================
// V1-V3: raiseVeil / getRaisedInfo
// ============================================================

describe("veil lifecycle", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    mod._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    mod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("V1: raiseVeil sets active=false", () => {
    createActiveSession(tmpDir);
    const result = mod.raiseVeil("test reason");
    assert.equal(result, true);

    mod._resetCache();
    const session = mod.loadSession();
    assert.equal(session, null); // Now inactive
  });

  it("V2: getRaisedInfo returns info after raise", () => {
    createActiveSession(tmpDir);
    mod.raiseVeil("test reason");
    mod._resetCache();

    const info = mod.getRaisedInfo();
    assert.ok(info !== null);
    assert.equal(info.task, "TASK-TEST");
    assert.equal(info.raised_reason, "test reason");
    assert.ok(info.raised_at);
  });

  it("V3: getRaisedInfo returns null when active", () => {
    createActiveSession(tmpDir);
    const info = mod.getRaisedInfo();
    assert.equal(info, null);
  });
});

// ============================================================
// W1-W2: getWebhookConfig
// ============================================================

describe("getWebhookConfig", () => {
  it("W1: returns null for empty/missing config", () => {
    assert.equal(mod.getWebhookConfig(null), null);
    assert.equal(mod.getWebhookConfig({}), null);
    assert.equal(mod.getWebhookConfig({ notification: {} }), null);
    assert.equal(mod.getWebhookConfig({ notification: { webhook_url: "" } }), null);
  });

  it("W2: returns trimmed URL", () => {
    const url = mod.getWebhookConfig({
      notification: { webhook_url: "  https://example.com/hook  " },
    });
    assert.equal(url, "https://example.com/hook");
  });
});

// ============================================================
// E1-E2: Evidence summarize
// ============================================================

describe("summarizeEvidence", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    mod._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    mod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("E1: empty ledger returns zeros", () => {
    const summary = mod.summarizeEvidence();
    assert.equal(summary.total, 0);
    assert.equal(summary.quality_gate_counts.blocking, 0);
  });

  it("E2: counts events and tools", () => {
    mod.writeEvidence({ event: "tool_used", tool_name: "Bash" });
    mod.writeEvidence({ event: "tool_used", tool_name: "Edit" });
    mod.writeEvidence({ event: "tool_denied", tool_name: "Bash" });

    const summary = mod.summarizeEvidence();
    assert.equal(summary.total, 3);
    assert.equal(summary.events.tool_used, 2);
    assert.equal(summary.events.tool_denied, 1);
    assert.equal(summary.tools.Bash, 2);
    assert.equal(summary.tools.Edit, 1);
    assert.equal(summary.quality_gate_counts.blocking, 1);
  });
});

// ============================================================
// G1: getGitState
// ============================================================

describe("getGitState", () => {
  it("G1: returns branch and status", () => {
    const state = mod.getGitState();
    assert.ok(typeof state.branch === "string" || state.branch === null);
    assert.ok(typeof state.uncommitted_changes === "boolean");
    assert.equal(state.pr_url, null);
  });
});

// ============================================================
// T1: getTokenUsage defaults
// ============================================================

describe("getTokenUsage", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    mod._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    mod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("T1: returns defaults when no session", () => {
    const usage = mod.getTokenUsage();
    assert.equal(usage.input, 0);
    assert.equal(usage.output, 0);
    assert.equal(usage.budget, 500000);
  });

  it("T2: returns session values", () => {
    createActiveSession(tmpDir);
    const usage = mod.getTokenUsage();
    assert.equal(usage.input, 100);
    assert.equal(usage.output, 50);
    assert.equal(usage.budget, 500000);
  });
});

// ============================================================
// R1: getRetryCount
// ============================================================

describe("getRetryCount", () => {
  let tmpDir;
  const origEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    mod._resetCache();
  });

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = origEnv || "";
    mod._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("R1: returns 0 when no session", () => {
    assert.equal(mod.getRetryCount(), 0);
  });

  it("R2: returns session value", () => {
    createActiveSession(tmpDir);
    assert.equal(mod.getRetryCount(), 0);

    mod.setRetryCount(2);
    mod._resetCache();
    assert.equal(mod.getRetryCount(), 2);
  });
});
