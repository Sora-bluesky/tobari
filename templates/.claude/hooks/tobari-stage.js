#!/usr/bin/env node
"use strict";
/**
 * Tobari Stage Controller — auto-advance.
 *
 * Validates DoD (Definition of Done) conditions for each STG gate and
 * auto-advances stage_status in backlog.yaml + gates_passed in tobari-session.json.
 *
 * Node.js port of tobari_stage.py (v1.1.0 migration).
 *
 * Usage (CLI):
 *   node tobari-stage.js advance OPS-082 STG1
 *   node tobari-stage.js check   OPS-082 STG2   // dry-run
 *   node tobari-stage.js summary OPS-082
 *   node tobari-stage.js next    OPS-082
 *
 * Usage (library):
 *   const { advanceGate, checkDod, getStageSummary } = require("./tobari-stage.js");
 *   const result = advanceGate("OPS-082", "STG1");
 */

const fs = require("fs");
const path = require("path");
const tobariSession = require("./tobari-session.js");
const { t } = require("./tobari-i18n.js");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GATE_ORDER = ["STG0", "STG1", "STG2", "STG3", "STG4", "STG5", "STG6"];

const GATE_SKIP_RULES = {
  lite: new Set(["STG1", "STG4"]),
  standard: new Set(),
  strict: new Set(),
};

const VALID_STATUSES = new Set(["pending", "in_progress", "done"]);

const BACKLOG_FILENAME = "tasks/backlog.yaml";

// ---------------------------------------------------------------------------
// Optional js-yaml (used for verification only, not required)
// ---------------------------------------------------------------------------

let yaml = null;
try {
  yaml = require("js-yaml");
} catch (_) {
  // js-yaml not installed — line-based parser will be used
}

// ---------------------------------------------------------------------------
// Backlog YAML I/O (line-based parser — no js-yaml dependency)
// ---------------------------------------------------------------------------

/**
 * Resolve the path to tasks/backlog.yaml.
 * @returns {string}
 */
function _getBacklogPath() {
  return tobariSession.getBacklogPath();
}

/**
 * Parse a YAML scalar value (handles quoted and unquoted strings, arrays, numbers, booleans).
 * @param {string} raw - raw value string after ":"
 * @returns {*}
 */
function _parseYamlValue(raw) {
  const trimmed = raw.trim();
  if (trimmed === "[]") return [];
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~" || trimmed === "") return null;
  // Quoted string
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

/**
 * Load backlog.yaml using a line-based parser (no js-yaml dependency).
 *
 * Parses the known backlog.yaml structure:
 *   tasks:
 *     - id: "OPS-NNN"
 *       key: value
 *       nested_map:
 *         key: value
 *       list_key:
 *         - "item"
 *
 * @returns {Array<Object>|null}
 */
function _loadBacklog() {
  const backlogPath = _getBacklogPath();
  if (!fs.existsSync(backlogPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(backlogPath, "utf8");
    return _parseBacklogYaml(content);
  } catch (_) {
    return null;
  }
}

/**
 * Parse backlog YAML content into tasks array.
 * @param {string} content
 * @returns {Array<Object>|null}
 */
function _parseBacklogYaml(content) {
  const lines = content.split("\n");
  const tasks = [];
  let inTasks = false;
  let currentTask = null;
  let currentMapKey = null; // For nested maps like stage_status
  let currentListKey = null; // For list values like evidence, acceptance

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    // Detect "tasks:" section
    if (/^tasks:\s*$/.test(line)) {
      inTasks = true;
      continue;
    }

    if (!inTasks) continue;

    // New task entry: "  - id: ..."
    const taskMatch = line.match(/^  - id:\s*(.+)$/);
    if (taskMatch) {
      if (currentTask) {
        tasks.push(currentTask);
      }
      currentTask = { id: _parseYamlValue(taskMatch[1]) };
      currentMapKey = null;
      currentListKey = null;
      continue;
    }

    if (!currentTask) continue;

    // 6-space indent: nested map value (e.g., stage_status entries)
    const nestedMapMatch = line.match(/^      (\w+):\s*(.+)$/);
    if (nestedMapMatch && currentMapKey) {
      if (!currentTask[currentMapKey]) {
        currentTask[currentMapKey] = {};
      }
      currentTask[currentMapKey][nestedMapMatch[1]] =
        _parseYamlValue(nestedMapMatch[2]);
      currentListKey = null;
      continue;
    }

    // 6-space indent: list item (e.g., evidence or acceptance items)
    const nestedListMatch = line.match(/^      - (.+)$/);
    if (nestedListMatch && currentListKey) {
      if (!Array.isArray(currentTask[currentListKey])) {
        currentTask[currentListKey] = [];
      }
      currentTask[currentListKey].push(
        _parseYamlValue(nestedListMatch[1])
      );
      continue;
    }

    // 4-space indent: task property
    const propMatch = line.match(/^    (\w+):\s*(.*)$/);
    if (propMatch) {
      const key = propMatch[1];
      const rawValue = propMatch[2].trim();

      if (rawValue === "" || rawValue === undefined) {
        // Block map or block list follows (e.g., stage_status:, acceptance:)
        // Peek next line to determine
        const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
        if (/^      \w+:/.test(nextLine)) {
          // Nested map
          currentMapKey = key;
          currentListKey = null;
          currentTask[key] = {};
        } else if (/^      - /.test(nextLine)) {
          // Nested list
          currentListKey = key;
          currentMapKey = null;
          currentTask[key] = [];
        } else {
          currentTask[key] = null;
          currentMapKey = null;
          currentListKey = null;
        }
      } else {
        currentTask[key] = _parseYamlValue(rawValue);
        currentMapKey = null;
        currentListKey = null;
      }
      continue;
    }

    // Unrecognized line at task-level — stop processing this task's properties
    // (avoids misinterpreting meta: or other top-level keys)
    if (/^\S/.test(line) || /^  \S/.test(line)) {
      // New top-level or 2-space key — end of tasks section or new task
      if (!/^  -/.test(line)) {
        // Not a new task entry — might be end of tasks section
        break;
      }
    }
  }

  if (currentTask) {
    tasks.push(currentTask);
  }

  return tasks.length > 0 ? tasks : null;
}

/**
 * Find a task by ID in the tasks array.
 * @param {Array<Object>} tasks
 * @param {string} taskId
 * @returns {Object|null}
 */
function _findTask(tasks, taskId) {
  for (const task of tasks) {
    if (task.id === taskId) {
      return task;
    }
  }
  return null;
}

/**
 * Update a single STG gate status in backlog.yaml using line-based editing.
 *
 * Preserves YAML formatting (quotes, indentation) for sync-task-breakdown.ps1
 * compatibility.
 *
 * Algorithm:
 * 1. Read file as lines
 * 2. Find line matching `- id: "{task_id}"`
 * 3. From that position, scan forward for the target gate line
 * 4. Replace the status value on that line
 * 5. Write back all lines
 * 6. Verify with yaml.load()
 *
 * @param {string} taskId
 * @param {string} gate
 * @param {string} newStatus
 * @returns {boolean}
 */
function _updateStageStatusLine(taskId, gate, newStatus) {
  const backlogPath = _getBacklogPath();
  if (!fs.existsSync(backlogPath)) {
    return false;
  }

  let originalContent;
  try {
    originalContent = fs.readFileSync(backlogPath, "utf8");
  } catch (_) {
    return false;
  }

  try {
    const lines = originalContent.split("\n");

    // Find the task block
    const taskIdPattern = new RegExp(
      "^  - id:\\s*\"?" + _escapeRegExp(taskId) + "\"?\\s*$"
    );
    let taskLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (taskIdPattern.test(lines[i])) {
        taskLineIdx = i;
        break;
      }
    }

    if (taskLineIdx < 0) {
      return false;
    }

    // Find the gate line within this task's stage_status block
    const gatePattern = new RegExp(
      "^(\\s+)" + _escapeRegExp(gate) + ':\\s*"([^"]*)"'
    );
    let gateLineIdx = -1;
    for (let i = taskLineIdx + 1; i < lines.length; i++) {
      // Stop at next task entry
      if (/^  - id:/.test(lines[i])) {
        break;
      }
      if (gatePattern.test(lines[i])) {
        gateLineIdx = i;
        break;
      }
    }

    if (gateLineIdx < 0) {
      return false;
    }

    // Replace the status value, preserving indentation
    const match = gatePattern.exec(lines[gateLineIdx]);
    const indent = match[1];
    lines[gateLineIdx] = `${indent}${gate}: "${newStatus}"`;

    // Write back
    const newContent = lines.join("\n");
    fs.writeFileSync(backlogPath, newContent, "utf8");

    // Verify: re-read and check using line-based parser
    const verifyContent = fs.readFileSync(backlogPath, "utf8");
    const tasks = _parseBacklogYaml(verifyContent);
    const task = tasks && _findTask(tasks, taskId);
    if (!task) {
      // Rollback
      fs.writeFileSync(backlogPath, originalContent, "utf8");
      return false;
    }
    const actualStatus =
      task.stage_status && task.stage_status[gate];
    if (actualStatus !== newStatus) {
      // Rollback
      fs.writeFileSync(backlogPath, originalContent, "utf8");
      return false;
    }

    return true;
  } catch (e) {
    // Attempt rollback on any error
    try {
      fs.writeFileSync(backlogPath, originalContent, "utf8");
    } catch (_) {
      // Rollback failed — best effort
    }
    process.stderr.write(`Stage update error: ${e.message}\n`);
    return false;
  }
}

/**
 * Escape special regex characters in a string.
 * @param {string} str
 * @returns {string}
 */
function _escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// DoD Check Functions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DoDCondition
 * @property {string} name
 * @property {boolean} satisfied
 * @property {string} evidence
 * @property {string} check_type - "auto" | "file_check" | "command" | "manual"
 */

/**
 * @typedef {Object} DoDResult
 * @property {string} gate
 * @property {boolean} satisfied
 * @property {DoDCondition[]} conditions
 * @property {string|null} fail_reason
 */

/**
 * @typedef {Object} AdvanceResult
 * @property {boolean} success
 * @property {string} gate
 * @property {string} task_id
 * @property {string} action - "advanced" | "fail-close" | "skipped" | "checked"
 * @property {string} previous_status
 * @property {string} new_status
 * @property {string} message
 * @property {string|null} fail_reason
 * @property {string[]} required_actions
 * @property {Object} evidence_data
 * @property {boolean} skipped
 */

/**
 * Create a DoDCondition object.
 * @param {string} name
 * @param {boolean} satisfied
 * @param {string} [evidence=""]
 * @param {string} [checkType="auto"]
 * @returns {DoDCondition}
 */
function _condition(name, satisfied, evidence, checkType) {
  return {
    name,
    satisfied,
    evidence: evidence || "",
    check_type: checkType || "auto",
  };
}

/**
 * Create a DoDResult object.
 * @param {string} gate
 * @param {boolean} satisfied
 * @param {DoDCondition[]} conditions
 * @param {string|null} [failReason=null]
 * @returns {DoDResult}
 */
function _dodResult(gate, satisfied, conditions, failReason) {
  return {
    gate,
    satisfied,
    conditions: conditions || [],
    fail_reason: failReason || null,
  };
}

/**
 * Create an AdvanceResult object.
 * @param {Object} fields
 * @returns {AdvanceResult}
 */
function _advanceResult(fields) {
  return {
    success: false,
    gate: "",
    task_id: "",
    action: "",
    previous_status: "",
    new_status: "",
    message: "",
    fail_reason: null,
    required_actions: [],
    evidence_data: {},
    skipped: false,
    ...fields,
  };
}

// --- STG0: Requirements confirmed ---
function _checkStg0(taskId, taskData, session) {
  const conditions = [];

  // 1. Session exists and active
  conditions.push(
    _condition(
      "session_active",
      session !== null,
      session
        ? "tobari-session.json exists and active=true"
        : "no active session",
      "file_check"
    )
  );

  // 2. Contract populated (requirements + dod)
  const contract = (session && session.contract) || {};
  const requirements = contract.requirements || {};
  const dod = contract.dod || [];
  const hasContract =
    Array.isArray(requirements.do) && requirements.do.length > 0 && dod.length > 0;
  conditions.push(
    _condition(
      "contract_populated",
      hasContract,
      `requirements.do=${(requirements.do || []).length} items, dod=${dod.length} items`,
      "file_check"
    )
  );

  // 3. Profile selected
  const profile = session && session.profile;
  conditions.push(
    _condition(
      "profile_selected",
      !!profile,
      profile ? `profile=${profile}` : "no profile",
      "file_check"
    )
  );

  const allSatisfied = conditions.every((c) => c.satisfied);
  const failReason = allSatisfied
    ? null
    : t("stage.stg0_fail", {
        conditions: conditions
          .filter((c) => !c.satisfied)
          .map((c) => c.name)
          .join(", "),
      });

  return _dodResult("STG0", allSatisfied, conditions, failReason);
}

// --- STG1: Design approach decided ---
function _checkStg1(taskId, taskData, session, profile) {
  if (profile === "lite") {
    return _dodResult("STG1", true, [
      _condition("lite_skip", true, "Lite profile: STG1 skipped", "auto"),
    ]);
  }

  const conditions = [];
  const evidenceList = taskData.evidence || [];
  const hasEvidence = evidenceList.length > 0;
  conditions.push(
    _condition(
      "design_evidence_exists",
      hasEvidence,
      `evidence entries: ${evidenceList.length}`,
      "file_check"
    )
  );

  const allSatisfied = conditions.every((c) => c.satisfied);
  const failReason = allSatisfied
    ? null
    : t("stage.stg1_fail");

  return _dodResult("STG1", allSatisfied, conditions, failReason);
}

// --- STG2: Implementation complete ---
function _checkStg2(taskId, taskData, session, profile) {
  const conditions = [];
  const evidenceList = taskData.evidence || [];

  const hasImplEvidence = evidenceList.length > 0;
  conditions.push(
    _condition(
      "implementation_evidence",
      hasImplEvidence,
      `evidence entries: ${evidenceList.length}`,
      "file_check"
    )
  );

  const allSatisfied = conditions.every((c) => c.satisfied);
  const failReason = allSatisfied
    ? null
    : t("stage.stg2_fail");

  return _dodResult("STG2", allSatisfied, conditions, failReason);
}

// --- STG3: Verification (tests + lint) ---
function _checkStg3(taskId, taskData, session, profile) {
  const conditions = [];
  const evidenceList = taskData.evidence || [];

  const verificationKeywords = [
    "test", "lint", "verify", "verification", "check", "pass", "PASS",
  ];
  const hasVerification = evidenceList.some((e) =>
    verificationKeywords.some((kw) =>
      String(e).toLowerCase().includes(kw.toLowerCase())
    )
  );
  conditions.push(
    _condition(
      "verification_evidence",
      hasVerification,
      hasVerification
        ? "verification evidence found"
        : "no verification evidence",
      "file_check"
    )
  );

  const allSatisfied = conditions.every((c) => c.satisfied);
  const failReason = allSatisfied
    ? null
    : t("stage.stg3_fail");

  return _dodResult("STG3", allSatisfied, conditions, failReason);
}

// --- STG4: CI/CD automation ---
function _checkStg4(taskId, taskData, session, profile) {
  if (profile === "lite") {
    return _dodResult("STG4", true, [
      _condition("lite_skip", true, "Lite profile: STG4 skipped", "auto"),
    ]);
  }

  const conditions = [];
  const evidenceList = taskData.evidence || [];

  const ciKeywords = [
    "CI", "PR #", "PR#", "workflow", "actions", "green",
    "boundary-check", "task-breakdown-sync", "merged",
  ];
  const hasCi = evidenceList.some((e) =>
    ciKeywords.some((kw) => String(e).toLowerCase().includes(kw.toLowerCase()))
  );

  // Fallback: if no CI configured, STG3 results substitute (docs/25 §6.5)
  const stg3Status =
    taskData.stage_status && taskData.stage_status.STG3;
  if (!hasCi && stg3Status === "done") {
    conditions.push(
      _condition(
        "ci_substitute_stg3",
        true,
        "CI not configured; STG3 results substitute (docs/25 §6.5)",
        "auto"
      )
    );
  } else {
    conditions.push(
      _condition(
        "ci_evidence",
        hasCi,
        hasCi ? "CI evidence found" : "no CI evidence",
        "file_check"
      )
    );
  }

  const allSatisfied = conditions.every((c) => c.satisfied);
  const failReason = allSatisfied
    ? null
    : t("stage.stg4_fail");

  return _dodResult("STG4", allSatisfied, conditions, failReason);
}

// --- STG5: Commit/Push ---
function _checkStg5(taskId, taskData, session, profile) {
  const conditions = [];
  const evidenceList = taskData.evidence || [];

  const commitKeywords = ["commit", "push", "git"];
  const hasCommit = evidenceList.some((e) =>
    commitKeywords.some((kw) =>
      String(e).toLowerCase().includes(kw.toLowerCase())
    )
  );
  conditions.push(
    _condition(
      "commit_push_evidence",
      hasCommit,
      hasCommit
        ? "commit/push evidence found"
        : "no commit/push evidence",
      "file_check"
    )
  );

  const allSatisfied = conditions.every((c) => c.satisfied);
  const failReason = allSatisfied
    ? null
    : t("stage.stg5_fail");

  return _dodResult("STG5", allSatisfied, conditions, failReason);
}

// --- STG6: PR/Merge ---
function _checkStg6(taskId, taskData, session, profile) {
  const conditions = [];
  const evidenceList = taskData.evidence || [];

  const prKeywords = ["PR #", "PR#", "merged", "merge"];
  const hasPr = evidenceList.some((e) =>
    prKeywords.some((kw) => String(e).includes(kw))
  );
  conditions.push(
    _condition(
      "pr_merge_evidence",
      hasPr,
      hasPr ? "PR/merge evidence found" : "no PR/merge evidence",
      "file_check"
    )
  );

  const allSatisfied = conditions.every((c) => c.satisfied);
  const failReason = allSatisfied
    ? null
    : t("stage.stg6_fail");

  return _dodResult("STG6", allSatisfied, conditions, failReason);
}

// DoD checker dispatch table
const _DOD_CHECKERS = {
  STG0: (tid, td, s, _p) => _checkStg0(tid, td, s),
  STG1: _checkStg1,
  STG2: _checkStg2,
  STG3: _checkStg3,
  STG4: _checkStg4,
  STG5: _checkStg5,
  STG6: _checkStg6,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the current active STG gate for a task.
 *
 * Returns the first non-'done' gate (e.g., 'STG2' if STG0,STG1 are done).
 * Returns null if all gates are done or task not found.
 *
 * @param {string} taskId
 * @returns {string|null}
 */
function getCurrentStage(taskId) {
  const tasks = _loadBacklog();
  if (!tasks) {
    return null;
  }
  const task = _findTask(tasks, taskId);
  if (!task) {
    return null;
  }

  const stageStatus = task.stage_status || {};
  for (const gate of GATE_ORDER) {
    if (stageStatus[gate] !== "done") {
      return gate;
    }
  }
  return null; // All done
}

/**
 * Check DoD conditions for a specific gate (dry-run, no modifications).
 *
 * @param {string} taskId
 * @param {string} gate
 * @returns {DoDResult}
 */
function checkDod(taskId, gate) {
  if (!GATE_ORDER.includes(gate)) {
    return _dodResult(gate, false, [], t("stage.invalid_gate", { gate }));
  }

  const tasks = _loadBacklog();
  if (!tasks) {
    return _dodResult(
      gate,
      false,
      [],
      t("stage.backlog_not_found")
    );
  }

  const task = _findTask(tasks, taskId);
  if (!task) {
    return _dodResult(
      gate,
      false,
      [],
      t("stage.task_not_found", { taskId })
    );
  }

  const session = tobariSession.loadSession();
  const profile = (session && session.profile) || "standard";

  const checker = _DOD_CHECKERS[gate];
  if (!checker) {
    return _dodResult(
      gate,
      false,
      [],
      t("stage.checker_missing", { gate })
    );
  }

  return checker(taskId, task, session, profile);
}

/**
 * Attempt to advance a gate to 'done'.
 *
 * Validates:
 *   1. Previous gate is done (sequential ordering)
 *   2. Gate is not already done
 *   3. DoD conditions are met (or gate is skipped per profile)
 *
 * On success: updates backlog.yaml + tobari-session.json.
 * On failure: fail-close with reason and required actions.
 *
 * @param {string} taskId
 * @param {string} gate
 * @returns {AdvanceResult}
 */
function advanceGate(taskId, gate) {
  if (!GATE_ORDER.includes(gate)) {
    const msg = t("stage.invalid_gate", { gate });
    return _advanceResult({
      success: false,
      gate,
      task_id: taskId,
      action: "fail-close",
      message: msg,
      fail_reason: msg,
    });
  }

  const tasks = _loadBacklog();
  if (!tasks) {
    const msg = t("stage.backlog_not_found");
    return _advanceResult({
      success: false,
      gate,
      task_id: taskId,
      action: "fail-close",
      message: msg,
      fail_reason: msg,
    });
  }

  const task = _findTask(tasks, taskId);
  if (!task) {
    const msg = t("stage.task_not_found", { taskId });
    return _advanceResult({
      success: false,
      gate,
      task_id: taskId,
      action: "fail-close",
      message: msg,
      fail_reason: msg,
    });
  }

  const stageStatus = task.stage_status || {};
  const currentStatus = stageStatus[gate] || "pending";

  // Check: gate not already done
  if (currentStatus === "done") {
    const msg = t("stage.already_done", { gate });
    return _advanceResult({
      success: false,
      gate,
      task_id: taskId,
      action: "fail-close",
      previous_status: "done",
      new_status: "done",
      message: msg,
      fail_reason: msg,
    });
  }

  // Check: previous gate is done (sequential ordering)
  const gateIdx = GATE_ORDER.indexOf(gate);
  if (gateIdx > 0) {
    const prevGate = GATE_ORDER[gateIdx - 1];
    const prevStatus = stageStatus[prevGate] || "pending";
    if (prevStatus !== "done") {
      const msg = t("stage.prev_not_done", { prevGate, gate });
      return _advanceResult({
        success: false,
        gate,
        task_id: taskId,
        action: "fail-close",
        previous_status: currentStatus,
        message: msg,
        fail_reason: msg,
        required_actions: [
          t("stage.complete_prev", { prevGate }),
          `node .claude/hooks/tobari-stage.js advance ${taskId} ${prevGate}`,
        ],
      });
    }
  }

  // Check: profile-based skip
  const session = tobariSession.loadSession();
  const profile = (session && session.profile) || "standard";
  const skipSet = GATE_SKIP_RULES[profile] || new Set();
  const shouldSkip = skipSet.has(gate);

  // Check DoD (even for skipped gates, we use the skip-aware checker)
  const dodResult = checkDod(taskId, gate);

  if (!dodResult.satisfied && !shouldSkip) {
    return _advanceResult({
      success: false,
      gate,
      task_id: taskId,
      action: "fail-close",
      previous_status: currentStatus,
      message: t("stage.dod_not_met", { gate }),
      fail_reason: dodResult.fail_reason,
      required_actions: [
        dodResult.fail_reason || t("stage.dod_fallback"),
        t("stage.retry_command", { taskId, gate }),
      ],
    });
  }

  // --- Execute transition ---

  // 1. Update backlog.yaml
  if (!_updateStageStatusLine(taskId, gate, "done")) {
    return _advanceResult({
      success: false,
      gate,
      task_id: taskId,
      action: "fail-close",
      previous_status: currentStatus,
      message: t("stage.backlog_not_found"),
      fail_reason: t("stage.backlog_write_error"),
    });
  }

  // 2. Update tobari-session.json gates_passed
  if (session) {
    if (!tobariSession.updateGatesPassed(gate)) {
      // Rollback backlog.yaml
      _updateStageStatusLine(taskId, gate, currentStatus);
      return _advanceResult({
        success: false,
        gate,
        task_id: taskId,
        action: "fail-close",
        previous_status: currentStatus,
        message: t("stage.session_write_error"),
        fail_reason: t("stage.session_write_error"),
      });
    }
  }

  // Build evidence data and write to Evidence Ledger
  const now = new Date().toISOString();
  const nextGate =
    gateIdx < GATE_ORDER.length - 1 ? GATE_ORDER[gateIdx + 1] : null;
  const evidenceData = {
    timestamp: now,
    event: "gate_advanced",
    task_id: taskId,
    gate,
    profile,
    skipped: shouldSkip,
    conditions_checked: dodResult.conditions.length,
    conditions_passed: dodResult.conditions.filter((c) => c.satisfied).length,
  };
  tobariSession.writeEvidence(evidenceData);

  const action = shouldSkip ? "skipped" : "advanced";
  const nextMsg = nextGate
    ? t("stage.next_gate", { nextGate })
    : t("stage.all_gates_done");

  return _advanceResult({
    success: true,
    gate,
    task_id: taskId,
    action,
    previous_status: currentStatus,
    new_status: "done",
    message: `${gate} → done. ${nextMsg}`,
    evidence_data: evidenceData,
    skipped: shouldSkip,
  });
}

/**
 * Attempt to advance to the next eligible gate.
 *
 * Finds the current (first non-done) gate, checks DoD, advances if met.
 *
 * @param {string} taskId
 * @returns {AdvanceResult}
 */
function advanceToNext(taskId) {
  const current = getCurrentStage(taskId);
  if (current === null) {
    return _advanceResult({
      success: false,
      gate: "",
      task_id: taskId,
      action: "fail-close",
      message: t("stage.no_next_gate", { taskId }),
      fail_reason: t("stage.no_next_gate_reason"),
    });
  }
  return advanceGate(taskId, current);
}

/**
 * Get a summary of all gate statuses for a task.
 *
 * @param {string} taskId
 * @returns {Object}
 */
function getStageSummary(taskId) {
  const tasks = _loadBacklog();
  if (!tasks) {
    return { error: t("stage.backlog_not_found") };
  }

  const task = _findTask(tasks, taskId);
  if (!task) {
    return { error: t("stage.task_not_found", { taskId }) };
  }

  const stageStatus = task.stage_status || {};
  const session = tobariSession.loadSession();
  const profile = (session && session.profile) || "standard";
  const skipGates = GATE_SKIP_RULES[profile] || new Set();

  const gates = [];
  let currentGate = null;
  for (const gate of GATE_ORDER) {
    const status = stageStatus[gate] || "pending";
    const isSkip = skipGates.has(gate);
    if (status !== "done" && currentGate === null) {
      currentGate = gate;
    }
    gates.push({ gate, status, skip: isSkip });
  }

  const doneCount = gates.filter((g) => g.status === "done").length;
  return {
    task_id: taskId,
    title: task.title || "",
    profile,
    current_gate: currentGate,
    progress: `${doneCount}/${GATE_ORDER.length}`,
    gates,
    veil_active: session !== null,
  };
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

function _outputJson(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function _printUsage() {
  process.stderr.write(
    "Usage: node tobari-stage.js <command> <task_id> [gate]\n" +
      "Commands: advance, check, summary, next\n"
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    _printUsage();
    process.exit(1);
  }

  const command = args[0];
  const taskId = args[1];

  switch (command) {
    case "advance": {
      if (args.length < 3) {
        process.stderr.write("Usage: node tobari-stage.js advance <task_id> <gate>\n");
        process.exit(1);
      }
      const gate = args[2];
      const result = advanceGate(taskId, gate);
      _outputJson(result);
      process.exit(result.success ? 0 : 1);
      break;
    }
    case "check": {
      if (args.length < 3) {
        process.stderr.write("Usage: node tobari-stage.js check <task_id> <gate>\n");
        process.exit(1);
      }
      const gate = args[2];
      const result = checkDod(taskId, gate);
      _outputJson(result);
      process.exit(result.satisfied ? 0 : 1);
      break;
    }
    case "summary": {
      const summary = getStageSummary(taskId);
      _outputJson(summary);
      process.exit(0);
      break;
    }
    case "next": {
      const result = advanceToNext(taskId);
      _outputJson(result);
      process.exit(result.success ? 0 : 1);
      break;
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      _printUsage();
      process.exit(1);
  }
}

// Run CLI if invoked directly
if (require.main === module) {
  try {
    main();
  } catch (e) {
    _outputJson({
      success: false,
      error: e.message,
      message: t("stage.controller_error", { message: e.message }),
    });
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  GATE_ORDER,
  GATE_SKIP_RULES,
  VALID_STATUSES,
  BACKLOG_FILENAME,

  // Public API
  getCurrentStage,
  checkDod,
  advanceGate,
  advanceToNext,
  getStageSummary,

  // Internal (exposed for testing)
  _getBacklogPath,
  _loadBacklog,
  _parseBacklogYaml,
  _parseYamlValue,
  _findTask,
  _updateStageStatusLine,
  _escapeRegExp,
  _condition,
  _dodResult,
  _advanceResult,

  // DoD checkers (exposed for testing)
  _checkStg0,
  _checkStg1,
  _checkStg2,
  _checkStg3,
  _checkStg4,
  _checkStg5,
  _checkStg6,

  // CLI
  main,
};
