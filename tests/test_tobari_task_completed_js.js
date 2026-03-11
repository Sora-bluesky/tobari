#!/usr/bin/env node
"use strict";
/**
 * Tests for tobari-task-completed.js (T2 TaskCompleted hook).
 *
 * Covers:
 * - DEFAULT_FEEDBACK constant
 * - buildActiveFeedback()
 * - handler(): veil not active, veil active, error handling, missing fields
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Set CLAUDE_PROJECT_DIR before requiring modules
const PROJECT_DIR = path.resolve(__dirname, "..");
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;

const tobariSession = require("../.claude/hooks/tobari-session.js");
const taskCompleted = require("../.claude/hooks/tobari-task-completed.js");

// --- Helpers ---

const SESSION_DIR = path.join(PROJECT_DIR, ".claude");
const SESSION_PATH = path.join(SESSION_DIR, "tobari-session.json");
const EVIDENCE_PATH = path.join(
  PROJECT_DIR,
  ".claude",
  "logs",
  "evidence-ledger.jsonl"
);
let originalContent = null;

function saveSession(session) {
  fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), "utf8");
  tobariSession._resetCache();
}

function restoreSession() {
  if (originalContent !== null) {
    fs.writeFileSync(SESSION_PATH, originalContent, "utf8");
  } else {
    try { fs.unlinkSync(SESSION_PATH); } catch {}
  }
  tobariSession._resetCache();
}

function makeBaseSession(overrides = {}) {
  return {
    active: true,
    task: "test-task-completed",
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

/**
 * Read evidence ledger line count. Returns 0 if file does not exist.
 * @returns {number}
 */
function getEvidenceLineCount() {
  try {
    const content = fs.readFileSync(EVIDENCE_PATH, "utf8").trim();
    if (content.length === 0) return 0;
    return content.split("\n").length;
  } catch (_) {
    return 0;
  }
}

/**
 * Read the last line from the evidence ledger, parsed as JSON.
 * Returns null if file does not exist or is empty.
 * @returns {object|null}
 */
function getLastEvidenceEntry() {
  try {
    const content = fs.readFileSync(EVIDENCE_PATH, "utf8").trim();
    if (content.length === 0) return null;
    const lines = content.split("\n");
    return JSON.parse(lines[lines.length - 1]);
  } catch (_) {
    return null;
  }
}

// ========================================================================
// DEFAULT_FEEDBACK constant
// ========================================================================

describe("DEFAULT_FEEDBACK constant", () => {
  it("is a non-empty string", () => {
    assert.ok(typeof taskCompleted.DEFAULT_FEEDBACK === "string");
    assert.ok(taskCompleted.DEFAULT_FEEDBACK.length > 0);
  });

  it("contains 'Task completed'", () => {
    assert.ok(
      taskCompleted.DEFAULT_FEEDBACK.includes("Task completed"),
      "DEFAULT_FEEDBACK should contain 'Task completed'"
    );
  });

  it("contains 'Verify your output'", () => {
    assert.ok(
      taskCompleted.DEFAULT_FEEDBACK.includes("Verify your output"),
      "DEFAULT_FEEDBACK should contain 'Verify your output'"
    );
  });
});

// ========================================================================
// buildActiveFeedback
// ========================================================================

describe("buildActiveFeedback", () => {
  it("includes task_id and task_subject", () => {
    const feedback = taskCompleted.buildActiveFeedback(
      "task-abc",
      "Implement feature X",
      "session-main"
    );
    assert.ok(
      feedback.includes("task-abc"),
      "feedback should include task_id"
    );
    assert.ok(
      feedback.includes("Implement feature X"),
      "feedback should include task_subject"
    );
  });

  it("includes session task name", () => {
    const feedback = taskCompleted.buildActiveFeedback(
      "task-def",
      "Fix bug Y",
      "my-session-task"
    );
    assert.ok(
      feedback.includes("my-session-task"),
      "feedback should include session task name"
    );
  });

  it("contains 'Evidence recorded to audit trail'", () => {
    const feedback = taskCompleted.buildActiveFeedback(
      "task-ghi",
      "Refactor Z",
      "session-refactor"
    );
    assert.ok(
      feedback.includes("Evidence recorded to audit trail"),
      "feedback should mention evidence recording"
    );
  });

  it("contains verify/update/report instructions", () => {
    const feedback = taskCompleted.buildActiveFeedback(
      "task-jkl",
      "Test task",
      "session-test"
    );
    assert.ok(
      feedback.includes("Verify your output"),
      "feedback should include verify instruction"
    );
    assert.ok(
      feedback.includes("Update the shared task list"),
      "feedback should include update instruction"
    );
    assert.ok(
      feedback.includes("report to the team lead"),
      "feedback should include report instruction"
    );
  });
});

// ========================================================================
// handler — veil not active
// ========================================================================

describe("handler — veil not active", () => {
  beforeEach(() => {
    try { originalContent = fs.readFileSync(SESSION_PATH, "utf8"); } catch { originalContent = null; }
  });

  afterEach(() => {
    restoreSession();
  });

  it("returns DEFAULT_FEEDBACK when session is inactive", () => {
    const session = makeBaseSession({ active: false });
    saveSession(session);

    const result = taskCompleted.handler({
      session_id: "sess-inactive",
      hook_event_name: "TaskCompleted",
      task_id: "task-inactive",
      task_subject: "Inactive task",
      teammate_name: "teammate-a",
      team_name: "team-alpha",
    });

    assert.ok(result !== null);
    assert.strictEqual(
      result.hookSpecificOutput.feedback,
      taskCompleted.DEFAULT_FEEDBACK
    );
  });

  it("does not write evidence when session is inactive", () => {
    const session = makeBaseSession({ active: false });
    saveSession(session);

    const linesBefore = getEvidenceLineCount();

    taskCompleted.handler({
      session_id: "sess-inactive-2",
      hook_event_name: "TaskCompleted",
      task_id: "task-no-evidence",
      task_subject: "Should not record",
      teammate_name: "teammate-b",
      team_name: "team-beta",
    });

    const linesAfter = getEvidenceLineCount();
    assert.strictEqual(
      linesAfter,
      linesBefore,
      "Evidence ledger should not grow when veil is inactive"
    );
  });
});

// ========================================================================
// handler — veil active
// ========================================================================

describe("handler — veil active", () => {
  beforeEach(() => {
    try { originalContent = fs.readFileSync(SESSION_PATH, "utf8"); } catch { originalContent = null; }
  });

  afterEach(() => {
    restoreSession();
  });

  it("returns enhanced feedback containing task_id and task_subject", () => {
    const session = makeBaseSession();
    saveSession(session);

    const result = taskCompleted.handler({
      session_id: "sess-active",
      hook_event_name: "TaskCompleted",
      task_id: "task-active-x",
      task_subject: "Active feature implementation",
      teammate_name: "teammate-c",
      team_name: "team-gamma",
    });

    assert.ok(result !== null);
    const feedback = result.hookSpecificOutput.feedback;
    assert.ok(
      feedback.includes("task-active-x"),
      "feedback should include task_id"
    );
    assert.ok(
      feedback.includes("Active feature implementation"),
      "feedback should include task_subject"
    );
  });

  it("contains session task name in feedback", () => {
    const session = makeBaseSession({ task: "custom-session-task" });
    saveSession(session);

    const result = taskCompleted.handler({
      session_id: "sess-active-2",
      hook_event_name: "TaskCompleted",
      task_id: "task-sess-name",
      task_subject: "Check session name",
      teammate_name: "teammate-d",
      team_name: "team-delta",
    });

    const feedback = result.hookSpecificOutput.feedback;
    assert.ok(
      feedback.includes("custom-session-task"),
      "feedback should include session task name"
    );
  });

  it("contains 'Evidence recorded' in feedback", () => {
    const session = makeBaseSession();
    saveSession(session);

    const result = taskCompleted.handler({
      session_id: "sess-active-3",
      hook_event_name: "TaskCompleted",
      task_id: "task-evidence-check",
      task_subject: "Verify evidence mention",
      teammate_name: "teammate-e",
      team_name: "team-epsilon",
    });

    const feedback = result.hookSpecificOutput.feedback;
    assert.ok(
      feedback.includes("Evidence recorded"),
      "feedback should mention evidence recording"
    );
  });

  it("writes evidence entry with event 'task_completed' and all fields", () => {
    const session = makeBaseSession();
    saveSession(session);

    const linesBefore = getEvidenceLineCount();

    taskCompleted.handler({
      session_id: "sess-active-4",
      hook_event_name: "TaskCompleted",
      task_id: "task-ev-fields",
      task_subject: "Evidence field verification",
      teammate_name: "teammate-f",
      team_name: "team-zeta",
    });

    const linesAfter = getEvidenceLineCount();
    assert.ok(
      linesAfter > linesBefore,
      "Evidence ledger should have a new entry"
    );

    const lastEntry = getLastEvidenceEntry();
    assert.ok(lastEntry !== null, "Last evidence entry should exist");
    assert.strictEqual(lastEntry.event, "task_completed");
    assert.strictEqual(lastEntry.task_id, "task-ev-fields");
    assert.strictEqual(lastEntry.task_subject, "Evidence field verification");
    assert.strictEqual(lastEntry.teammate_name, "teammate-f");
    assert.strictEqual(lastEntry.team_name, "team-zeta");
  });
});

// ========================================================================
// handler — error handling (fail-open)
// ========================================================================

describe("handler — error handling (fail-open)", () => {
  beforeEach(() => {
    try { originalContent = fs.readFileSync(SESSION_PATH, "utf8"); } catch { originalContent = null; }
  });

  afterEach(() => {
    restoreSession();
  });

  it("returns DEFAULT_FEEDBACK when session file is corrupt", () => {
    // Write invalid JSON to session file
    fs.writeFileSync(SESSION_PATH, "{{{{not-valid-json", "utf8");
    tobariSession._resetCache();

    const result = taskCompleted.handler({
      session_id: "sess-corrupt",
      hook_event_name: "TaskCompleted",
      task_id: "task-corrupt",
      task_subject: "Corrupt session test",
      teammate_name: "teammate-g",
      team_name: "team-eta",
    });

    assert.ok(result !== null);
    assert.strictEqual(
      result.hookSpecificOutput.feedback,
      taskCompleted.DEFAULT_FEEDBACK
    );
  });

  it("never throws an error", () => {
    // Write invalid JSON to session file
    fs.writeFileSync(SESSION_PATH, "{{{{not-valid-json", "utf8");
    tobariSession._resetCache();

    // Should not throw
    assert.doesNotThrow(() => {
      taskCompleted.handler({
        session_id: "sess-no-throw",
        hook_event_name: "TaskCompleted",
        task_id: "task-no-throw",
        task_subject: "No throw test",
        teammate_name: "teammate-h",
        team_name: "team-theta",
      });
    });
  });
});

// ========================================================================
// handler — missing/default fields
// ========================================================================

describe("handler — missing/default fields", () => {
  beforeEach(() => {
    try { originalContent = fs.readFileSync(SESSION_PATH, "utf8"); } catch { originalContent = null; }
  });

  afterEach(() => {
    restoreSession();
  });

  it("works when task_id is missing (uses 'unknown' default)", () => {
    const session = makeBaseSession();
    saveSession(session);

    const result = taskCompleted.handler({
      session_id: "sess-missing-1",
      hook_event_name: "TaskCompleted",
      // task_id omitted
      task_subject: "No task_id",
      teammate_name: "teammate-i",
      team_name: "team-iota",
    });

    assert.ok(result !== null);
    const feedback = result.hookSpecificOutput.feedback;
    assert.ok(
      feedback.includes("unknown"),
      "feedback should use 'unknown' as default task_id"
    );
  });

  it("works when task_subject is missing (uses 'unknown' default)", () => {
    const session = makeBaseSession();
    saveSession(session);

    const result = taskCompleted.handler({
      session_id: "sess-missing-2",
      hook_event_name: "TaskCompleted",
      task_id: "task-no-subject",
      // task_subject omitted
      teammate_name: "teammate-j",
      team_name: "team-kappa",
    });

    assert.ok(result !== null);
    // Should not throw and should return a feedback string
    assert.ok(typeof result.hookSpecificOutput.feedback === "string");
    assert.ok(result.hookSpecificOutput.feedback.length > 0);
  });

  it("works when teammate_name and team_name are missing", () => {
    const session = makeBaseSession();
    saveSession(session);

    const linesBefore = getEvidenceLineCount();

    const result = taskCompleted.handler({
      session_id: "sess-missing-3",
      hook_event_name: "TaskCompleted",
      task_id: "task-no-team",
      task_subject: "No teammate info",
      // teammate_name and team_name omitted
    });

    assert.ok(result !== null);
    assert.ok(typeof result.hookSpecificOutput.feedback === "string");

    // Evidence should still be written with 'unknown' defaults
    const linesAfter = getEvidenceLineCount();
    assert.ok(
      linesAfter > linesBefore,
      "Evidence should be recorded even with missing fields"
    );

    const lastEntry = getLastEvidenceEntry();
    assert.ok(lastEntry !== null);
    assert.strictEqual(
      lastEntry.teammate_name,
      "unknown",
      "teammate_name should default to 'unknown'"
    );
    assert.strictEqual(
      lastEntry.team_name,
      "unknown",
      "team_name should default to 'unknown'"
    );
  });

  it("works when all optional fields are missing", () => {
    const session = makeBaseSession();
    saveSession(session);

    const result = taskCompleted.handler({
      session_id: "sess-missing-4",
      hook_event_name: "TaskCompleted",
      // All optional fields omitted: task_id, task_subject, teammate_name, team_name
    });

    assert.ok(result !== null);
    assert.ok(typeof result.hookSpecificOutput.feedback === "string");
    assert.ok(result.hookSpecificOutput.feedback.length > 0);
  });
});
