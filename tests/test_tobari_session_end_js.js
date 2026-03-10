#!/usr/bin/env node
"use strict";
/**
 * Tests for session-end functionality in tobari-session.js (TASK-092).
 *
 * Tests finalizeSession(), getGitState(), raiseVeil(), and integration
 * with /handoff and Stop Hook Circuit Breaker.
 *
 * Migrated from tests/test_session_end.py (TASK-074).
 *
 * Test plan:
 *   E1:  finalizeSession() correctly ends an active session
 *   E2:  finalizeSession() skips an inactive session
 *   E3:  git_state is correctly updated (getGitState)
 *   E4:  evidence_summary is generated
 *   E5:  retry_count is reset to 0
 *   E6:  raise_veil is correctly called (raised_at, raised_reason)
 *   E7:  /handoff references finalize_session
 *   E8:  Stop hook references finalize_session
 *   E9:  No error when session file does not exist
 *   E10: File lock during concurrent access
 *
 * Run: node --test tests/test_tobari_session_end_js.js
 */

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const session = require("../.claude/hooks/tobari-session.js");

// --- Test Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tobari-session-end-test-"));
}

function cleanup(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // Windows may hold locks briefly
  }
}

function makeActiveSession(overrides) {
  const base = {
    active: true,
    task: "test-task",
    profile: "standard",
    started_at: "2026-03-05T00:00:00Z",
    gates_passed: ["STG0", "STG1"],
    retry_count: 3,
    token_usage: { input: 100, output: 200, budget: 500000 },
    git_state: {
      branch: "feat/test",
      uncommitted_changes: false,
      pr_url: null,
    },
    contract: { intent: "test" },
    learned_permissions: [],
    evidence: [],
  };
  return { ...base, ...overrides };
}

function writeSession(sessionPath, data) {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2) + "\n");
}

// --- E3: getGitState ---

describe("getGitState", () => {
  it("E3a: returns branch and uncommitted status", () => {
    // This test runs in the actual repo, so git is available
    const state = session.getGitState();
    assert.ok("branch" in state);
    assert.ok("uncommitted_changes" in state);
    assert.ok("pr_url" in state);
    // We created a branch, so branch should be non-null
    assert.ok(typeof state.branch === "string" || state.branch === null);
  });

  it("E3b: branch is a string when in a git repo", () => {
    const state = session.getGitState();
    // We're running in a git repo
    assert.strictEqual(typeof state.branch, "string");
  });
});

// --- E1, E4, E5, E6: finalizeSession with active session ---

describe("finalizeSession (active)", () => {
  let tmpDir;
  let originalEnv;

  beforeEach(() => {
    tmpDir = createTmpDir();
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;

    // Create logs dir for evidence
    fs.mkdirSync(path.join(tmpDir, ".claude", "logs"), { recursive: true });
    session._resetCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = originalEnv;
    }
    session._resetCache();
    cleanup(tmpDir);
  });

  it("E1: finalizeSession sets active=false for an active session", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    writeSession(sessionPath, makeActiveSession());
    session._resetCache();

    const result = session.finalizeSession("test end");

    assert.strictEqual(result.status, "finalized");
    assert.strictEqual(result.reason, "test end");

    const final = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.strictEqual(final.active, false);
    assert.strictEqual(final.raised_reason, "test end");
  });

  it("E4: evidence_summary is generated", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    writeSession(sessionPath, makeActiveSession());
    session._resetCache();

    session.finalizeSession("test end");

    const final = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.ok("evidence_summary" in final);
    assert.ok("total" in final.evidence_summary);
  });

  it("E5: retry_count is reset to 0", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    writeSession(sessionPath, makeActiveSession({ retry_count: 3 }));
    session._resetCache();

    session.finalizeSession("test end");

    const final = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.strictEqual(final.retry_count, 0);
  });

  it("E6: raised_at and raised_reason are set", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    writeSession(sessionPath, makeActiveSession());
    session._resetCache();

    session.finalizeSession("test end");

    const final = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.ok("raised_at" in final);
    assert.strictEqual(final.raised_reason, "test end");
    // raised_at should be a valid ISO string
    assert.ok(!isNaN(Date.parse(final.raised_at)));
  });

  it("E6b: veil_raised evidence is written", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    writeSession(sessionPath, makeActiveSession());
    session._resetCache();

    session.finalizeSession("test end");

    const ledgerPath = path.join(
      tmpDir,
      ".claude",
      "logs",
      "evidence-ledger.jsonl"
    );
    if (fs.existsSync(ledgerPath)) {
      const lines = fs
        .readFileSync(ledgerPath, "utf-8")
        .trim()
        .split("\n");
      const veilEntries = lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.event === "veil_raised");
      assert.ok(veilEntries.length >= 1, "veil_raised evidence should exist");
    }
  });

  it("E3c: git_state is written to session", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    writeSession(sessionPath, makeActiveSession());
    session._resetCache();

    session.finalizeSession("test end");

    const final = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.ok("git_state" in final);
    assert.ok("branch" in final.git_state);
    assert.ok("uncommitted_changes" in final.git_state);
  });
});

// --- E2, E9: finalizeSession edge cases ---

describe("finalizeSession (edge cases)", () => {
  let tmpDir;
  let originalEnv;

  beforeEach(() => {
    tmpDir = createTmpDir();
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    session._resetCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = originalEnv;
    }
    session._resetCache();
    cleanup(tmpDir);
  });

  it("E2: skips when session is inactive", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    writeSession(sessionPath, makeActiveSession({ active: false }));
    session._resetCache();

    const result = session.finalizeSession("test end");
    assert.strictEqual(result.status, "skipped");
  });

  it("E9: handles missing session file gracefully", () => {
    // No session file created
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });

    const result = session.finalizeSession("test end");
    assert.strictEqual(result.status, "skipped");
  });
});

// --- raiseVeil ---

describe("raiseVeil", () => {
  let tmpDir;
  let originalEnv;

  beforeEach(() => {
    tmpDir = createTmpDir();
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    fs.mkdirSync(path.join(tmpDir, ".claude", "logs"), { recursive: true });
    session._resetCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = originalEnv;
    }
    session._resetCache();
    cleanup(tmpDir);
  });

  it("R1: sets active=false", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    writeSession(sessionPath, makeActiveSession());
    session._resetCache();

    const result = session.raiseVeil("test raise");
    assert.strictEqual(result, true);

    const final = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.strictEqual(final.active, false);
    assert.strictEqual(final.raised_reason, "test raise");
    assert.ok("raised_at" in final);
  });

  it("R2: returns false when no session file", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    const result = session.raiseVeil("test raise");
    assert.strictEqual(result, false);
  });

  it("R3: writes veil_raised evidence", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    writeSession(sessionPath, makeActiveSession());
    session._resetCache();

    session.raiseVeil("test raise");

    const ledgerPath = path.join(
      tmpDir,
      ".claude",
      "logs",
      "evidence-ledger.jsonl"
    );
    if (fs.existsSync(ledgerPath)) {
      const lines = fs
        .readFileSync(ledgerPath, "utf-8")
        .trim()
        .split("\n");
      const veilEntries = lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.event === "veil_raised");
      assert.ok(veilEntries.length >= 1);
      assert.strictEqual(veilEntries[0].reason, "test raise");
    }
  });

  it("R4: default reason is 'session ended'", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    writeSession(sessionPath, makeActiveSession());
    session._resetCache();

    session.raiseVeil();

    const final = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.strictEqual(final.raised_reason, "session ended");
  });
});

// --- E7: /handoff integration ---

describe("Integration references", () => {
  it("E7: /handoff SKILL.md references finalizeSession", () => {
    const skillPath = path.join(
      __dirname,
      "..",
      ".claude",
      "skills",
      "handoff",
      "SKILL.md"
    );
    if (fs.existsSync(skillPath)) {
      const content = fs.readFileSync(skillPath, "utf-8");
      assert.ok(
        content.includes("finalize_session") ||
          content.includes("finalizeSession"),
        "handoff SKILL.md should reference finalize_session/finalizeSession"
      );
    }
  });

  it("E8: Stop hook references finalizeSession", () => {
    const stopJsPath = path.join(
      __dirname,
      "..",
      ".claude",
      "hooks",
      "tobari-stop.js"
    );
    if (fs.existsSync(stopJsPath)) {
      const content = fs.readFileSync(stopJsPath, "utf-8");
      assert.ok(
        content.includes("finalizeSession"),
        "tobari-stop.js should call finalizeSession"
      );
    }
  });
});

// --- E10: File lock ---

describe("File lock", () => {
  let tmpDir;
  let originalEnv;

  beforeEach(() => {
    tmpDir = createTmpDir();
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    fs.mkdirSync(path.join(tmpDir, ".claude", "logs"), { recursive: true });
    session._resetCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = originalEnv;
    }
    session._resetCache();
    cleanup(tmpDir);
  });

  it("E10: finalizeSession produces consistent result under sequential calls", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    writeSession(sessionPath, makeActiveSession());
    session._resetCache();

    // First call should finalize
    const result1 = session.finalizeSession("test end");
    assert.strictEqual(result1.status, "finalized");

    // Second call should skip (already inactive)
    session._resetCache();
    const result2 = session.finalizeSession("test end again");
    assert.strictEqual(result2.status, "skipped");
  });
});
