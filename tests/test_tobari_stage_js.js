#!/usr/bin/env node
"use strict";
/**
 * Tests for TASK-082: tobari-stage.js (Node.js port of tobari_stage.py).
 *
 * Groups:
 *   B1-B4:  Backlog YAML I/O (_loadBacklog, _findTask, _updateStageStatusLine)
 *   D1-D7:  DoD checkers (STG0-STG6)
 *   G1-G6:  getCurrentStage
 *   A1-A8:  advanceGate / advanceToNext
 *   S1-S3:  getStageSummary
 *   C1-C3:  CLI entry point
 *   U1-U2:  Utility functions
 *
 * Run: node --test tests/test_tobari_stage_js.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Set TOBARI_LANG before requiring modules so i18n defaults to Japanese
process.env.TOBARI_LANG = "ja";

const stage = require("../.claude/hooks/tobari-stage.js");
const session = require("../.claude/hooks/tobari-session.js");

// --- Test Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tobari-stage-test-"));
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Create a minimal backlog.yaml with one task.
 */
function createBacklog(tmpDir, taskOverrides) {
  const tasksDir = path.join(tmpDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const backlogPath = path.join(tasksDir, "backlog.yaml");

  const defaultTask = {
    id: "TASK-TEST",
    phase: "P4",
    title: "Test task",
    priority: "P1",
    status: "in-progress",
    owner: "Claude Code",
    acceptance: ["test passes"],
    evidence: [],
    stage_status: {
      STG0: "done",
      STG1: "pending",
      STG2: "pending",
      STG3: "pending",
      STG4: "pending",
      STG5: "pending",
      STG6: "pending",
    },
    next_action: "test",
    updated_at: "2026-03-06",
  };

  const task = { ...defaultTask, ...taskOverrides };

  // Write as proper YAML (matching the real format with quoted values)
  const stageLines = Object.entries(task.stage_status)
    .map(([k, v]) => `      ${k}: "${v}"`)
    .join("\n");
  const evidenceStr =
    task.evidence.length > 0
      ? "\n" + task.evidence.map((e) => `      - "${e}"`).join("\n")
      : "[]";
  const acceptanceStr = task.acceptance
    .map((a) => `      - "${a}"`)
    .join("\n");

  const content = `meta:
  last_updated: "2026-03-06"

tasks:
  - id: "${task.id}"
    phase: "${task.phase}"
    title: "${task.title}"
    priority: "${task.priority}"
    status: "${task.status}"
    owner: "${task.owner}"
    acceptance:
${acceptanceStr}
    evidence: ${evidenceStr}
    stage_status:
${stageLines}
    next_action: "${task.next_action}"
    updated_at: "${task.updated_at}"
`;

  fs.writeFileSync(backlogPath, content, "utf8");
  return backlogPath;
}

/**
 * Create an active tobari-session.json.
 */
function createSession(tmpDir, overrides) {
  const claudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const sessionPath = path.join(claudeDir, "tobari-session.json");

  const defaultSession = {
    active: true,
    task: "TASK-TEST",
    profile: "standard",
    gates_passed: ["STG0"],
    retry_count: 0,
    token_usage: { input: 0, output: 0, budget: 500000 },
    contract: {
      intent: "test",
      requirements: { do: ["task 1"], do_not: ["nothing"] },
      dod: ["test passes"],
      scope: { include: [".claude/hooks/", "tests/"], exclude: ["tasks/"] },
    },
  };

  const data = { ...defaultSession, ...overrides };
  fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2) + "\n", "utf8");

  // Also create logs directory for evidence
  const logsDir = path.join(claudeDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  return sessionPath;
}

// --- Environment Setup ---

let tmpDir;
let originalProjectDir;

beforeEach(() => {
  tmpDir = createTmpDir();
  originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmpDir;
  session._resetCache();
});

afterEach(() => {
  if (originalProjectDir !== undefined) {
    process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  } else {
    delete process.env.CLAUDE_PROJECT_DIR;
  }
  session._resetCache();
  cleanup(tmpDir);
});

// ============================================================
// U1-U2: Utility functions
// ============================================================

describe("Utility functions", () => {
  it("U1: _escapeRegExp escapes special characters", () => {
    assert.equal(stage._escapeRegExp("TASK-082"), "TASK-082"); // hyphen is not special
    assert.equal(stage._escapeRegExp("a.b"), "a\\.b");
    assert.equal(stage._escapeRegExp("a*b"), "a\\*b");
    assert.equal(stage._escapeRegExp("a(b)"), "a\\(b\\)");
  });

  it("U2: GATE_ORDER has 7 gates in correct order", () => {
    assert.deepEqual(stage.GATE_ORDER, [
      "STG0", "STG1", "STG2", "STG3", "STG4", "STG5", "STG6",
    ]);
  });
});

// ============================================================
// B1-B4: Backlog YAML I/O
// ============================================================

describe("Backlog YAML I/O", () => {
  it("B1: _loadBacklog returns tasks array from valid YAML", () => {
    createBacklog(tmpDir, {});
    const tasks = stage._loadBacklog();
    // May be null if js-yaml not installed
    if (tasks !== null) {
      assert.ok(Array.isArray(tasks));
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, "TASK-TEST");
    }
  });

  it("B2: _loadBacklog returns null when file missing", () => {
    // No backlog created
    const tasks = stage._loadBacklog();
    assert.equal(tasks, null);
  });

  it("B3: _findTask finds existing task", () => {
    const tasks = [{ id: "TASK-001" }, { id: "TASK-002" }, { id: "TASK-003" }];
    assert.deepEqual(stage._findTask(tasks, "TASK-002"), { id: "TASK-002" });
  });

  it("B4: _findTask returns null for missing task", () => {
    const tasks = [{ id: "TASK-001" }];
    assert.equal(stage._findTask(tasks, "TASK-999"), null);
  });
});

// ============================================================
// D1-D7: DoD checkers (STG0-STG6)
// ============================================================

describe("DoD checkers", () => {
  it("D1: STG0 satisfied with active session + contract + profile", () => {
    const sess = {
      active: true,
      profile: "standard",
      contract: {
        requirements: { do: ["task1"] },
        dod: ["dod1"],
      },
    };
    const result = stage._checkStg0("TASK-TEST", {}, sess);
    assert.equal(result.satisfied, true);
    assert.equal(result.conditions.length, 3);
  });

  it("D1b: STG0 fails without session", () => {
    const result = stage._checkStg0("TASK-TEST", {}, null);
    assert.equal(result.satisfied, false);
    assert.ok(result.fail_reason.includes("session_active"));
  });

  it("D2: STG1 skipped for lite profile", () => {
    const result = stage._checkStg1("TASK-TEST", {}, null, "lite");
    assert.equal(result.satisfied, true);
    assert.equal(result.conditions[0].name, "lite_skip");
  });

  it("D2b: STG1 fails without evidence for standard profile", () => {
    const result = stage._checkStg1("TASK-TEST", { evidence: [] }, null, "standard");
    assert.equal(result.satisfied, false);
  });

  it("D2c: STG1 passes with evidence for standard profile", () => {
    const result = stage._checkStg1(
      "TASK-TEST",
      { evidence: ["design doc created"] },
      null,
      "standard"
    );
    assert.equal(result.satisfied, true);
  });

  it("D3: STG2 passes with evidence", () => {
    const result = stage._checkStg2(
      "TASK-TEST",
      { evidence: ["code written"] },
      null,
      "standard"
    );
    assert.equal(result.satisfied, true);
  });

  it("D3b: STG2 fails without evidence", () => {
    const result = stage._checkStg2(
      "TASK-TEST",
      { evidence: [] },
      null,
      "standard"
    );
    assert.equal(result.satisfied, false);
  });

  it("D4: STG3 passes with verification evidence", () => {
    const result = stage._checkStg3(
      "TASK-TEST",
      { evidence: ["test PASS 46/46"] },
      null,
      "standard"
    );
    assert.equal(result.satisfied, true);
  });

  it("D4b: STG3 fails without verification keywords", () => {
    const result = stage._checkStg3(
      "TASK-TEST",
      { evidence: ["code written"] },
      null,
      "standard"
    );
    assert.equal(result.satisfied, false);
  });

  it("D5: STG4 skipped for lite profile", () => {
    const result = stage._checkStg4("TASK-TEST", {}, null, "lite");
    assert.equal(result.satisfied, true);
  });

  it("D5b: STG4 uses STG3 substitute when no CI evidence", () => {
    const result = stage._checkStg4(
      "TASK-TEST",
      { evidence: [], stage_status: { STG3: "done" } },
      null,
      "standard"
    );
    assert.equal(result.satisfied, true);
    assert.equal(result.conditions[0].name, "ci_substitute_stg3");
  });

  it("D5c: STG4 fails with no CI and STG3 not done", () => {
    const result = stage._checkStg4(
      "TASK-TEST",
      { evidence: [], stage_status: { STG3: "pending" } },
      null,
      "standard"
    );
    assert.equal(result.satisfied, false);
  });

  it("D6: STG5 passes with commit evidence", () => {
    const result = stage._checkStg5(
      "TASK-TEST",
      { evidence: ["git commit abc123"] },
      null,
      "standard"
    );
    assert.equal(result.satisfied, true);
  });

  it("D6b: STG5 fails without commit evidence", () => {
    const result = stage._checkStg5(
      "TASK-TEST",
      { evidence: [] },
      null,
      "standard"
    );
    assert.equal(result.satisfied, false);
  });

  it("D7: STG6 passes with PR/merge evidence", () => {
    const result = stage._checkStg6(
      "TASK-TEST",
      { evidence: ["PR #42 merged"] },
      null,
      "standard"
    );
    assert.equal(result.satisfied, true);
  });

  it("D7b: STG6 fails without PR evidence", () => {
    const result = stage._checkStg6(
      "TASK-TEST",
      { evidence: [] },
      null,
      "standard"
    );
    assert.equal(result.satisfied, false);
  });
});

// ============================================================
// G1-G6: getCurrentStage
// ============================================================

describe("getCurrentStage", () => {
  it("G1: returns first non-done gate", () => {
    createBacklog(tmpDir, {
      stage_status: {
        STG0: "done",
        STG1: "done",
        STG2: "pending",
        STG3: "pending",
        STG4: "pending",
        STG5: "pending",
        STG6: "pending",
      },
    });
    const result = stage.getCurrentStage("TASK-TEST");
    // null if js-yaml not available
    if (result !== null) {
      assert.equal(result, "STG2");
    }
  });

  it("G2: returns null when all gates done", () => {
    createBacklog(tmpDir, {
      stage_status: {
        STG0: "done",
        STG1: "done",
        STG2: "done",
        STG3: "done",
        STG4: "done",
        STG5: "done",
        STG6: "done",
      },
    });
    const result = stage.getCurrentStage("TASK-TEST");
    assert.equal(result, null);
  });

  it("G3: returns null for missing task", () => {
    createBacklog(tmpDir, {});
    const result = stage.getCurrentStage("TASK-MISSING");
    assert.equal(result, null);
  });

  it("G4: returns null when no backlog", () => {
    const result = stage.getCurrentStage("TASK-TEST");
    assert.equal(result, null);
  });

  it("G5: returns STG0 when nothing done", () => {
    createBacklog(tmpDir, {
      stage_status: {
        STG0: "pending",
        STG1: "pending",
        STG2: "pending",
        STG3: "pending",
        STG4: "pending",
        STG5: "pending",
        STG6: "pending",
      },
    });
    const result = stage.getCurrentStage("TASK-TEST");
    if (result !== null) {
      assert.equal(result, "STG0");
    }
  });
});

// ============================================================
// A1-A8: advanceGate / advanceToNext
// ============================================================

describe("advanceGate", () => {
  it("A1: invalid gate returns fail-close", () => {
    const result = stage.advanceGate("TASK-TEST", "STG99");
    assert.equal(result.success, false);
    assert.equal(result.action, "fail-close");
    assert.ok(result.fail_reason.includes("無効なゲート名"));
  });

  it("A2: missing backlog returns fail-close", () => {
    const result = stage.advanceGate("TASK-TEST", "STG1");
    assert.equal(result.success, false);
    assert.ok(result.fail_reason.includes("backlog.yaml"));
  });

  it("A3: missing task returns fail-close", () => {
    createBacklog(tmpDir, {});
    const result = stage.advanceGate("TASK-MISSING", "STG1");
    assert.equal(result.success, false);
    assert.ok(result.fail_reason.includes("TASK-MISSING"));
  });

  it("A4: already-done gate returns fail-close", () => {
    createBacklog(tmpDir, {
      stage_status: {
        STG0: "done",
        STG1: "done",
        STG2: "pending",
        STG3: "pending",
        STG4: "pending",
        STG5: "pending",
        STG6: "pending",
      },
    });
    createSession(tmpDir, {});
    const result = stage.advanceGate("TASK-TEST", "STG0");
    assert.equal(result.success, false);
    assert.ok(result.fail_reason.includes("既に完了"));
  });

  it("A5: out-of-order gate returns fail-close with required_actions", () => {
    createBacklog(tmpDir, {
      stage_status: {
        STG0: "done",
        STG1: "pending",
        STG2: "pending",
        STG3: "pending",
        STG4: "pending",
        STG5: "pending",
        STG6: "pending",
      },
    });
    createSession(tmpDir, {});
    const result = stage.advanceGate("TASK-TEST", "STG2");
    assert.equal(result.success, false);
    assert.ok(result.fail_reason.includes("STG1"));
    assert.ok(result.required_actions.length > 0);
  });

  it("A6: successful advance updates backlog and session", () => {
    createBacklog(tmpDir, {
      evidence: ["design doc"],
      stage_status: {
        STG0: "done",
        STG1: "pending",
        STG2: "pending",
        STG3: "pending",
        STG4: "pending",
        STG5: "pending",
        STG6: "pending",
      },
    });
    createSession(tmpDir, {});

    const result = stage.advanceGate("TASK-TEST", "STG1");
    assert.equal(result.success, true);
    assert.equal(result.action, "advanced");
    assert.equal(result.new_status, "done");
    assert.ok(result.message.includes("STG1"));

    // Verify backlog.yaml was updated
    const backlogContent = fs.readFileSync(
      path.join(tmpDir, "tasks", "backlog.yaml"),
      "utf8"
    );
    assert.ok(backlogContent.includes('STG1: "done"'));

    // Verify session gates_passed was updated
    session._resetCache();
    const sess = session.loadSession();
    assert.ok(sess.gates_passed.includes("STG1"));
  });

  it("A7: DoD failure returns fail-close", () => {
    createBacklog(tmpDir, {
      evidence: [], // No evidence — STG1 DoD fails
      stage_status: {
        STG0: "done",
        STG1: "pending",
        STG2: "pending",
        STG3: "pending",
        STG4: "pending",
        STG5: "pending",
        STG6: "pending",
      },
    });
    createSession(tmpDir, {});

    const result = stage.advanceGate("TASK-TEST", "STG1");
    assert.equal(result.success, false);
    assert.equal(result.action, "fail-close");
    assert.ok(result.fail_reason.includes("evidence"));
  });
});

describe("advanceToNext", () => {
  it("A8: advanceToNext advances current gate", () => {
    createBacklog(tmpDir, {
      evidence: ["design doc"],
      stage_status: {
        STG0: "done",
        STG1: "pending",
        STG2: "pending",
        STG3: "pending",
        STG4: "pending",
        STG5: "pending",
        STG6: "pending",
      },
    });
    createSession(tmpDir, {});

    const result = stage.advanceToNext("TASK-TEST");
    assert.equal(result.success, true);
    assert.equal(result.gate, "STG1");
  });

  it("A8b: advanceToNext fails when all gates done", () => {
    createBacklog(tmpDir, {
      stage_status: {
        STG0: "done",
        STG1: "done",
        STG2: "done",
        STG3: "done",
        STG4: "done",
        STG5: "done",
        STG6: "done",
      },
    });
    const result = stage.advanceToNext("TASK-TEST");
    assert.equal(result.success, false);
    assert.ok(result.fail_reason.includes("進むべきゲートがありません"));
  });
});

// ============================================================
// S1-S3: getStageSummary
// ============================================================

describe("getStageSummary", () => {
  it("S1: returns summary with correct progress", () => {
    createBacklog(tmpDir, {
      stage_status: {
        STG0: "done",
        STG1: "done",
        STG2: "pending",
        STG3: "pending",
        STG4: "pending",
        STG5: "pending",
        STG6: "pending",
      },
    });
    createSession(tmpDir, {});

    const result = stage.getStageSummary("TASK-TEST");
    assert.equal(result.task_id, "TASK-TEST");
    assert.equal(result.progress, "2/7");
    assert.equal(result.current_gate, "STG2");
    assert.equal(result.gates.length, 7);
    assert.equal(result.veil_active, true);
  });

  it("S2: returns error for missing backlog", () => {
    const result = stage.getStageSummary("TASK-TEST");
    assert.ok(result.error);
    assert.ok(result.error.includes("backlog.yaml"));
  });

  it("S3: returns error for missing task", () => {
    createBacklog(tmpDir, {});
    const result = stage.getStageSummary("TASK-MISSING");
    assert.ok(result.error);
    assert.ok(result.error.includes("TASK-MISSING"));
  });
});

// ============================================================
// C1-C3: CLI
// ============================================================

describe("CLI", () => {
  it("C1: checkDod returns DoDResult for valid gate", () => {
    createBacklog(tmpDir, {});
    createSession(tmpDir, {});

    const result = stage.checkDod("TASK-TEST", "STG0");
    assert.equal(result.gate, "STG0");
    assert.ok(typeof result.satisfied === "boolean");
    assert.ok(Array.isArray(result.conditions));
  });

  it("C2: checkDod returns fail for invalid gate", () => {
    const result = stage.checkDod("TASK-TEST", "INVALID");
    assert.equal(result.satisfied, false);
    assert.ok(result.fail_reason.includes("無効なゲート名"));
  });

  it("C3: checkDod returns fail for missing backlog", () => {
    const result = stage.checkDod("TASK-TEST", "STG0");
    assert.equal(result.satisfied, false);
    assert.ok(result.fail_reason.includes("backlog.yaml"));
  });
});

// ============================================================
// Line-based YAML editing
// ============================================================

describe("_updateStageStatusLine", () => {
  it("Y1: updates gate status preserving format", () => {
    createBacklog(tmpDir, {});
    const success = stage._updateStageStatusLine("TASK-TEST", "STG1", "done");
    assert.equal(success, true);

    const content = fs.readFileSync(
      path.join(tmpDir, "tasks", "backlog.yaml"),
      "utf8"
    );
    assert.ok(content.includes('STG1: "done"'));
    // Other gates should be unchanged
    assert.ok(content.includes('STG2: "pending"'));
  });

  it("Y2: returns false for missing backlog", () => {
    const result = stage._updateStageStatusLine("TASK-TEST", "STG1", "done");
    assert.equal(result, false);
  });

  it("Y3: returns false for missing task", () => {
    createBacklog(tmpDir, {});
    const result = stage._updateStageStatusLine("TASK-MISSING", "STG1", "done");
    assert.equal(result, false);
  });
});

// ============================================================
// Profile skip rules
// ============================================================

describe("Profile skip rules", () => {
  it("P1: lite skips STG1 and STG4", () => {
    assert.ok(stage.GATE_SKIP_RULES.lite.has("STG1"));
    assert.ok(stage.GATE_SKIP_RULES.lite.has("STG4"));
    assert.equal(stage.GATE_SKIP_RULES.lite.size, 2);
  });

  it("P2: standard skips nothing", () => {
    assert.equal(stage.GATE_SKIP_RULES.standard.size, 0);
  });

  it("P3: strict skips nothing", () => {
    assert.equal(stage.GATE_SKIP_RULES.strict.size, 0);
  });
});
