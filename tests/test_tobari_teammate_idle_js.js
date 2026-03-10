#!/usr/bin/env node
"use strict";
/**
 * Tests for TeammateIdle hook (T1).
 *
 * Covers:
 * - buildDefaultFeedback(): default guidance message
 * - buildActiveFeedback(): enhanced guidance when veil is active
 * - workLogDirExists(): directory existence check
 * - handler(): full hook handler with veil active/inactive/error scenarios
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Set CLAUDE_PROJECT_DIR before requiring modules
const PROJECT_DIR = path.resolve(__dirname, "..");
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;

const tobariSession = require("../.claude/hooks/tobari-session.js");
const teammateIdle = require("../.claude/hooks/tobari-teammate-idle.js");

// --- Helpers ---

const SESSION_DIR = path.join(PROJECT_DIR, ".claude");
const SESSION_PATH = path.join(SESSION_DIR, "tobari-session.json");
let originalContent = null;

function saveSession(session) {
  fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), "utf8");
  tobariSession._resetCache();
}

function restoreSession() {
  if (originalContent !== null) {
    fs.writeFileSync(SESSION_PATH, originalContent, "utf8");
  }
  tobariSession._resetCache();
}

function makeBaseSession(overrides = {}) {
  return {
    active: true,
    task: "test-teammate-idle",
    profile: "standard",
    started_at: "2026-03-08T00:00:00Z",
    gates_passed: ["STG0"],
    retry_count: 0,
    token_usage: { input: 0, output: 0, budget: 500000 },
    git_state: { branch: "test", uncommitted_changes: false, pr_url: null },
    contract: {
      intent: "test",
      requirements: { do: ["test"], do_not: ["none"] },
      dod: ["test passes"],
      scope: {
        include: ["tests/", ".claude/hooks/"],
        exclude: [],
      },
      risk_level: "medium",
    },
    learned_permissions: [],
    evidence: [],
    ...overrides,
  };
}

// ========================================================================
// buildDefaultFeedback
// ========================================================================

describe("buildDefaultFeedback", () => {
  it("returns string containing 'Before going idle'", () => {
    const feedback = teammateIdle.buildDefaultFeedback("my-team", "worker-a");
    assert.ok(
      feedback.includes("Before going idle"),
      "Should contain 'Before going idle' guidance"
    );
  });

  it("includes team_name and teammate_name in path when provided", () => {
    const feedback = teammateIdle.buildDefaultFeedback("alpha-team", "bot-one");
    assert.ok(
      feedback.includes("alpha-team"),
      "Should include team_name in path"
    );
    assert.ok(
      feedback.includes("bot-one"),
      "Should include teammate_name in path"
    );
    assert.ok(
      feedback.includes(".claude/logs/agent-teams/alpha-team/bot-one.md"),
      "Should include full work log path"
    );
  });

  it("uses placeholders when team_name and teammate_name are empty", () => {
    const feedback = teammateIdle.buildDefaultFeedback("", "");
    assert.ok(
      feedback.includes("{team-name}"),
      "Should use {team-name} placeholder"
    );
    assert.ok(
      feedback.includes("{your-teammate-name}"),
      "Should use {your-teammate-name} placeholder"
    );
  });
});

// ========================================================================
// buildActiveFeedback
// ========================================================================

describe("buildActiveFeedback", () => {
  it("includes task name from session", () => {
    const sess = { task: "implement-feature-x" };
    const feedback = teammateIdle.buildActiveFeedback(
      sess,
      "team-a",
      "worker-b",
      true
    );
    assert.ok(
      feedback.includes("implement-feature-x"),
      "Should include the task name from the session"
    );
  });

  it("includes 'Evidence has been recorded'", () => {
    const sess = { task: "some-task" };
    const feedback = teammateIdle.buildActiveFeedback(
      sess,
      "team-a",
      "worker-b",
      true
    );
    assert.ok(
      feedback.includes("Evidence has been recorded"),
      "Should confirm evidence recording"
    );
  });

  it("mentions 'does not exist yet' when workLogDirExists=false", () => {
    const sess = { task: "some-task" };
    const feedback = teammateIdle.buildActiveFeedback(
      sess,
      "team-a",
      "worker-b",
      false
    );
    assert.ok(
      feedback.includes("does not exist yet"),
      "Should mention that work log directory does not exist yet"
    );
  });

  it("does not mention 'does not exist yet' when workLogDirExists=true", () => {
    const sess = { task: "some-task" };
    const feedback = teammateIdle.buildActiveFeedback(
      sess,
      "team-a",
      "worker-b",
      true
    );
    assert.ok(
      !feedback.includes("does not exist yet"),
      "Should not mention non-existence when directory exists"
    );
  });
});

// ========================================================================
// workLogDirExists
// ========================================================================

describe("workLogDirExists", () => {
  let tempTeamDir = null;

  afterEach(() => {
    // Clean up temp directory if created
    if (tempTeamDir && fs.existsSync(tempTeamDir)) {
      fs.rmdirSync(tempTeamDir);
    }
    tempTeamDir = null;
  });

  it("returns false when directory does not exist", () => {
    const result = teammateIdle.workLogDirExists("nonexistent-team-xyz");
    assert.strictEqual(result, false);
  });

  it("returns false when teamName is empty", () => {
    assert.strictEqual(teammateIdle.workLogDirExists(""), false);
  });

  it("returns false when teamName is falsy (null)", () => {
    assert.strictEqual(teammateIdle.workLogDirExists(null), false);
  });

  it("returns false when teamName is falsy (undefined)", () => {
    assert.strictEqual(teammateIdle.workLogDirExists(undefined), false);
  });

  it("returns true when directory exists", () => {
    const baseDir = path.join(
      PROJECT_DIR,
      teammateIdle.WORK_LOG_BASE_DIR
    );
    const teamName = "test-team-dir-check";
    tempTeamDir = path.join(baseDir, teamName);

    // Create the directory for the test
    fs.mkdirSync(tempTeamDir, { recursive: true });

    const result = teammateIdle.workLogDirExists(teamName);
    assert.strictEqual(result, true);
  });
});

// ========================================================================
// handler — veil not active
// ========================================================================

describe("handler — veil not active", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("returns default feedback when session has active=false", () => {
    const session = makeBaseSession({ active: false });
    saveSession(session);

    const result = teammateIdle.handler({
      session_id: "test-session",
      hook_event_name: "TeammateIdle",
      teammate_name: "idle-worker",
      team_name: "test-team",
    });

    assert.ok(result.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result.hookSpecificOutput.feedback.includes("Before going idle"),
      "Should return default feedback"
    );
  });

  it("does not write evidence when veil is inactive", () => {
    const session = makeBaseSession({ active: false });
    saveSession(session);

    // Read evidence count before
    const evidenceBefore = tobariSession.readEvidence();
    const countBefore = evidenceBefore.length;

    teammateIdle.handler({
      session_id: "test-session",
      hook_event_name: "TeammateIdle",
      teammate_name: "idle-worker",
      team_name: "test-team",
    });

    // Read evidence count after
    const evidenceAfter = tobariSession.readEvidence();
    const countAfter = evidenceAfter.length;

    assert.strictEqual(
      countAfter,
      countBefore,
      "Evidence count should not increase when veil is inactive"
    );
  });
});

// ========================================================================
// handler — veil active
// ========================================================================

describe("handler — veil active", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("returns enhanced feedback containing task name", () => {
    const session = makeBaseSession({ task: "deploy-feature-y" });
    saveSession(session);

    const result = teammateIdle.handler({
      session_id: "test-session",
      hook_event_name: "TeammateIdle",
      teammate_name: "worker-alpha",
      team_name: "deploy-team",
    });

    assert.ok(result.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result.hookSpecificOutput.feedback.includes("deploy-feature-y"),
      "Enhanced feedback should contain the task name"
    );
  });

  it("contains 'Evidence has been recorded'", () => {
    const session = makeBaseSession();
    saveSession(session);

    const result = teammateIdle.handler({
      session_id: "test-session",
      hook_event_name: "TeammateIdle",
      teammate_name: "worker-beta",
      team_name: "review-team",
    });

    assert.ok(
      result.hookSpecificOutput.feedback.includes("Evidence has been recorded"),
      "Active feedback should confirm evidence recording"
    );
  });

  it("writes evidence entry with event 'teammate_idle'", () => {
    const session = makeBaseSession({ task: "evidence-test-task" });
    saveSession(session);

    // Read evidence count before
    const evidenceBefore = tobariSession.readEvidence();
    const countBefore = evidenceBefore.length;

    teammateIdle.handler({
      session_id: "test-session",
      hook_event_name: "TeammateIdle",
      teammate_name: "evidence-worker",
      team_name: "evidence-team",
    });

    // Read evidence after
    const evidenceAfter = tobariSession.readEvidence();
    const countAfter = evidenceAfter.length;

    assert.ok(
      countAfter > countBefore,
      "Evidence count should increase after handler call"
    );

    // Check the last entry has the correct event type
    const lastEntry = evidenceAfter[evidenceAfter.length - 1];
    assert.strictEqual(
      lastEntry.event,
      "teammate_idle",
      "Evidence entry should have event='teammate_idle'"
    );
    assert.strictEqual(
      lastEntry.teammate_name,
      "evidence-worker",
      "Evidence entry should record teammate_name"
    );
    assert.strictEqual(
      lastEntry.team_name,
      "evidence-team",
      "Evidence entry should record team_name"
    );
  });
});

// ========================================================================
// handler — error handling (fail-open)
// ========================================================================

describe("handler — error handling (fail-open)", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("returns default feedback when session is corrupt", () => {
    // Write invalid JSON to session file
    fs.writeFileSync(SESSION_PATH, "<<<not valid json>>>", "utf8");
    tobariSession._resetCache();

    const result = teammateIdle.handler({
      session_id: "test-session",
      hook_event_name: "TeammateIdle",
      teammate_name: "crash-worker",
      team_name: "crash-team",
    });

    assert.ok(result.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result.hookSpecificOutput.feedback.includes("Before going idle"),
      "Should return default feedback on error"
    );
  });

  it("never throws an error", () => {
    // Write invalid JSON to session file
    fs.writeFileSync(SESSION_PATH, "<<<not valid json>>>", "utf8");
    tobariSession._resetCache();

    // Should not throw
    assert.doesNotThrow(() => {
      teammateIdle.handler({
        session_id: "test-session",
        hook_event_name: "TeammateIdle",
        teammate_name: "safe-worker",
        team_name: "safe-team",
      });
    }, "Handler should never throw (fail-open)");
  });
});

// ========================================================================
// handler — empty/missing fields
// ========================================================================

describe("handler — empty/missing fields", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("returns feedback when teammate_name and team_name are missing", () => {
    const session = makeBaseSession();
    saveSession(session);

    const result = teammateIdle.handler({
      session_id: "test-session",
      hook_event_name: "TeammateIdle",
    });

    assert.ok(result.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      typeof result.hookSpecificOutput.feedback === "string",
      "Feedback should be a string"
    );
    assert.ok(
      result.hookSpecificOutput.feedback.length > 0,
      "Feedback should not be empty"
    );
  });

  it("returns feedback with empty strings for teammate_name and team_name", () => {
    const session = makeBaseSession();
    saveSession(session);

    const result = teammateIdle.handler({
      session_id: "test-session",
      hook_event_name: "TeammateIdle",
      teammate_name: "",
      team_name: "",
    });

    assert.ok(result.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result.hookSpecificOutput.feedback.includes("{team-name}") ||
        result.hookSpecificOutput.feedback.includes("{your-teammate-name}"),
      "Should use placeholder names when fields are empty"
    );
  });

  it("returns default feedback when veil inactive and fields are missing", () => {
    const session = makeBaseSession({ active: false });
    saveSession(session);

    const result = teammateIdle.handler({
      session_id: "test-session",
      hook_event_name: "TeammateIdle",
    });

    assert.ok(result.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result.hookSpecificOutput.feedback.includes("Before going idle"),
      "Should return default feedback"
    );
  });
});
