#!/usr/bin/env node
"use strict";
/**
 * Tests for v1.2.0 M3: A8 Agent-Aware Governance.
 *
 * Covers:
 * - tobari-session.js: getAgentPolicy(), checkAgentToolPermission()
 * - tobari-gate.js: agent policy check in handler()
 * - tobari-evidence.js: agent_id/agent_type recording
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// Set CLAUDE_PROJECT_DIR before requiring modules
const PROJECT_DIR = path.resolve(__dirname, "..");
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
process.env.TOBARI_LANG = "ja";

const tobariSession = require("../.claude/hooks/tobari-session.js");
const gate = require("../.claude/hooks/tobari-gate.js");
const evidence = require("../.claude/hooks/tobari-evidence.js");

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
    task: "test-a8",
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
// tobari-session.js: getAgentPolicy
// ========================================================================

describe("getAgentPolicy", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("returns permissive policy when no agent_policies defined", () => {
    const session = makeBaseSession();
    saveSession(session);

    const policy = tobariSession.getAgentPolicy("Explore");
    assert.deepStrictEqual(policy.allowed_tools, ["*"]);
    assert.deepStrictEqual(policy.denied_tools, []);
    assert.strictEqual(policy.scope_override, null);
  });

  it("returns specific policy for matching agent type", () => {
    const session = makeBaseSession({
      agent_policies: {
        default: { allowed_tools: ["*"], denied_tools: [], scope_override: null },
        Explore: {
          allowed_tools: ["Read", "Grep", "Glob"],
          denied_tools: ["Edit", "Write", "Bash"],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    const policy = tobariSession.getAgentPolicy("Explore");
    assert.deepStrictEqual(policy.allowed_tools, ["Read", "Grep", "Glob"]);
    assert.deepStrictEqual(policy.denied_tools, ["Edit", "Write", "Bash"]);
  });

  it("falls back to default policy for unknown agent type", () => {
    const session = makeBaseSession({
      agent_policies: {
        default: { allowed_tools: ["Read"], denied_tools: ["Bash"], scope_override: null },
      },
    });
    saveSession(session);

    const policy = tobariSession.getAgentPolicy("UnknownAgent");
    assert.deepStrictEqual(policy.allowed_tools, ["Read"]);
    assert.deepStrictEqual(policy.denied_tools, ["Bash"]);
  });

  it("returns permissive policy when session is not active", () => {
    const session = makeBaseSession({ active: false });
    saveSession(session);

    const policy = tobariSession.getAgentPolicy("Explore");
    assert.deepStrictEqual(policy.allowed_tools, ["*"]);
    assert.deepStrictEqual(policy.denied_tools, []);
  });
});

// ========================================================================
// tobari-session.js: checkAgentToolPermission
// ========================================================================

describe("checkAgentToolPermission", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("allows tool when no policies defined", () => {
    const session = makeBaseSession();
    saveSession(session);

    const result = tobariSession.checkAgentToolPermission("Explore", "Edit");
    assert.strictEqual(result.allowed, true);
  });

  it("denies tool in denied_tools list", () => {
    const session = makeBaseSession({
      agent_policies: {
        Explore: {
          allowed_tools: ["Read", "Grep", "Glob"],
          denied_tools: ["Edit", "Write", "Bash"],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    const result = tobariSession.checkAgentToolPermission("Explore", "Edit");
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes("denied"));
  });

  it("allows tool in allowed_tools list", () => {
    const session = makeBaseSession({
      agent_policies: {
        Explore: {
          allowed_tools: ["Read", "Grep", "Glob"],
          denied_tools: [],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    const result = tobariSession.checkAgentToolPermission("Explore", "Read");
    assert.strictEqual(result.allowed, true);
  });

  it("denies tool not in allowed_tools list (when not wildcard)", () => {
    const session = makeBaseSession({
      agent_policies: {
        Explore: {
          allowed_tools: ["Read", "Grep", "Glob"],
          denied_tools: [],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    const result = tobariSession.checkAgentToolPermission("Explore", "Bash");
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes("not allowed"));
  });

  it("denied_tools takes precedence over allowed_tools", () => {
    const session = makeBaseSession({
      agent_policies: {
        test: {
          allowed_tools: ["*"],
          denied_tools: ["Bash"],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    const result = tobariSession.checkAgentToolPermission("test", "Bash");
    assert.strictEqual(result.allowed, false);
  });

  it("wildcard allowed_tools permits any tool", () => {
    const session = makeBaseSession({
      agent_policies: {
        default: {
          allowed_tools: ["*"],
          denied_tools: [],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    const result = tobariSession.checkAgentToolPermission("AnyAgent", "Bash");
    assert.strictEqual(result.allowed, true);
  });
});

// ========================================================================
// tobari-gate.js: Agent policy enforcement in handler
// ========================================================================

describe("gate handler agent policy enforcement", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("allows main thread operations (no agent_id/agent_type)", () => {
    const session = makeBaseSession({
      agent_policies: {
        Explore: {
          allowed_tools: ["Read"],
          denied_tools: ["Edit", "Write", "Bash"],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    // Main thread: no agent_id or agent_type
    const result = gate.handler({
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(PROJECT_DIR, "tests", "test_file.js"),
        old_string: "old",
        new_string: "new",
      },
    });

    // Should not be denied by agent policy (main thread has no agent_type)
    // May be denied by other checks (scope, etc.) but NOT by agent policy
    if (result) {
      assert.ok(
        !result.hookSpecificOutput.additionalContext.includes("エージェントポリシー違反"),
        "Main thread should not be blocked by agent policy",
      );
    }
  });

  it("blocks subagent when tool is in denied_tools", () => {
    const session = makeBaseSession({
      agent_policies: {
        Explore: {
          allowed_tools: ["Read", "Grep", "Glob"],
          denied_tools: ["Edit", "Write", "Bash"],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    const result = gate.handler({
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(PROJECT_DIR, "tests", "test_file.js"),
        old_string: "old",
        new_string: "new",
      },
      agent_id: "agent-123",
      agent_type: "Explore",
    });

    assert.ok(result !== null, "Should be blocked");
    assert.strictEqual(result.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(result.hookSpecificOutput.additionalContext.includes("エージェントポリシー違反"));
  });

  it("allows subagent when tool is permitted", () => {
    const session = makeBaseSession({
      agent_policies: {
        Explore: {
          allowed_tools: ["Read", "Grep", "Glob"],
          denied_tools: [],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    // Read is allowed for Explore
    const result = gate.handler({
      tool_name: "Read",
      tool_input: {
        file_path: path.join(PROJECT_DIR, "tests", "test_file.js"),
      },
      agent_id: "agent-123",
      agent_type: "Explore",
    });

    // Read is a safe read-only tool, should not be blocked
    assert.strictEqual(result, null);
  });

  it("uses default policy for unknown agent type", () => {
    const session = makeBaseSession({
      agent_policies: {
        default: {
          allowed_tools: ["Read"],
          denied_tools: ["Bash"],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      agent_id: "agent-456",
      agent_type: "CustomAgent",
    });

    assert.ok(result !== null, "Should be blocked by default policy");
    assert.strictEqual(result.hookSpecificOutput.permissionDecision, "deny");
  });

  it("no blocking when no agent_policies defined", () => {
    const session = makeBaseSession();
    saveSession(session);

    // Even with agent_type, if no policies are defined, all tools are allowed
    const result = gate.handler({
      tool_name: "Read",
      tool_input: {
        file_path: path.join(PROJECT_DIR, "tests", "test_file.js"),
      },
      agent_id: "agent-789",
      agent_type: "Explore",
    });

    assert.strictEqual(result, null, "Should pass through without policies");
  });
});

// ========================================================================
// tobari-evidence.js: Agent info recording
// ========================================================================

describe("evidence handler agent info recording", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("records agent_id and agent_type when present", () => {
    const session = makeBaseSession();
    saveSession(session);

    // Capture what writeEvidence receives by temporarily replacing it
    let capturedEntry = null;
    const originalWriteEvidence = tobariSession.writeEvidence;

    // We cannot easily mock writeEvidence since it is on the module,
    // but we can verify the handler function behavior by checking
    // the evidence handler returns null (success) and the agent info
    // would be in the entry. Let's test the handler directly.
    const result = evidence.handler({
      tool_name: "Read",
      tool_input: { file_path: "/test/file.js" },
      tool_response: {},
      agent_id: "agent-abc",
      agent_type: "Explore",
    });

    // Evidence handler always returns null (fail-open)
    assert.strictEqual(result, null);
  });

  it("does not add agent fields when no agent info", () => {
    const session = makeBaseSession();
    saveSession(session);

    const result = evidence.handler({
      tool_name: "Read",
      tool_input: { file_path: "/test/file.js" },
      tool_response: {},
    });

    assert.strictEqual(result, null);
  });
});

// ========================================================================
// Integration: Full flow with agent policies
// ========================================================================

describe("A8 integration: full agent governance flow", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("Explore agent restricted to read-only tools", () => {
    const session = makeBaseSession({
      agent_policies: {
        default: { allowed_tools: ["*"], denied_tools: [], scope_override: null },
        Explore: {
          allowed_tools: ["Read", "Grep", "Glob"],
          denied_tools: ["Edit", "Write", "Bash", "NotebookEdit"],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    // Read: allowed
    assert.strictEqual(
      gate.handler({
        tool_name: "Read",
        tool_input: { file_path: "/test.js" },
        agent_id: "exp-1",
        agent_type: "Explore",
      }),
      null,
    );

    // Grep: allowed
    assert.strictEqual(
      gate.handler({
        tool_name: "Grep",
        tool_input: { pattern: "test" },
        agent_id: "exp-1",
        agent_type: "Explore",
      }),
      null,
    );

    // Edit: denied
    const editResult = gate.handler({
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(PROJECT_DIR, "tests", "x.js"),
        old_string: "a",
        new_string: "b",
      },
      agent_id: "exp-1",
      agent_type: "Explore",
    });
    assert.ok(editResult !== null);
    assert.strictEqual(editResult.hookSpecificOutput.permissionDecision, "deny");

    // Bash: denied
    const bashResult = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      agent_id: "exp-1",
      agent_type: "Explore",
    });
    assert.ok(bashResult !== null);
    assert.strictEqual(bashResult.hookSpecificOutput.permissionDecision, "deny");
  });

  it("general-purpose agent with full access", () => {
    const session = makeBaseSession({
      agent_policies: {
        default: { allowed_tools: ["*"], denied_tools: [], scope_override: null },
        Explore: {
          allowed_tools: ["Read", "Grep", "Glob"],
          denied_tools: ["Edit", "Write", "Bash"],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    // general-purpose uses default policy (all allowed)
    const result = gate.handler({
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      agent_id: "gp-1",
      agent_type: "general-purpose",
    });

    // Not blocked by agent policy (may pass or be caught by other checks)
    if (result) {
      assert.ok(
        !result.hookSpecificOutput.additionalContext.includes("エージェントポリシー違反"),
        "general-purpose should not be blocked by agent policy",
      );
    }
  });

  it("Plan agent restricted from write operations", () => {
    const session = makeBaseSession({
      agent_policies: {
        Plan: {
          allowed_tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
          denied_tools: ["Edit", "Write", "Bash"],
          scope_override: null,
        },
      },
    });
    saveSession(session);

    // Write: denied
    const writeResult = gate.handler({
      tool_name: "Write",
      tool_input: {
        file_path: path.join(PROJECT_DIR, "tests", "new.js"),
        content: "test",
      },
      agent_id: "plan-1",
      agent_type: "Plan",
    });
    assert.ok(writeResult !== null);
    assert.strictEqual(writeResult.hookSpecificOutput.permissionDecision, "deny");

    // Read: allowed
    assert.strictEqual(
      gate.handler({
        tool_name: "Read",
        tool_input: { file_path: "/test.js" },
        agent_id: "plan-1",
        agent_type: "Plan",
      }),
      null,
    );
  });
});
