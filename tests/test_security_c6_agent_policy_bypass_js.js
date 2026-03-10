#!/usr/bin/env node
"use strict";
/**
 * Security Test C6: Agent Policy Bypass Resistance.
 *
 * Tests the Agent Policy system's resistance to privilege escalation
 * and bypass attempts. Verifies that:
 * - Agents cannot escalate their privileges
 * - denied_tools always takes precedence over allowed_tools
 * - Edge cases (empty type, unknown type, missing policies) behave safely
 * - Policy manipulation attempts are handled correctly
 *
 * Target modules:
 * - tobari-session.js: getAgentPolicy(), checkAgentToolPermission()
 * - tobari-gate.js: handler() agent policy enforcement
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Set CLAUDE_PROJECT_DIR before requiring modules
const PROJECT_DIR = path.resolve(__dirname, "..");
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
process.env.TOBARI_LANG = "ja";

const tobariSession = require("../.claude/hooks/tobari-session.js");
const gate = require("../.claude/hooks/tobari-gate.js");

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
    task: "test-c6-security",
    profile: "standard",
    started_at: "2026-03-08T00:00:00Z",
    gates_passed: ["STG0"],
    retry_count: 0,
    token_usage: { input: 0, output: 0, budget: 500000 },
    git_state: { branch: "test", uncommitted_changes: false, pr_url: null },
    contract: {
      intent: "security test",
      requirements: { do: ["test"], do_not: ["none"] },
      dod: ["test passes"],
      scope: {
        include: ["tests/", ".claude/hooks/"],
        exclude: [],
      },
      risk_level: "high",
    },
    learned_permissions: [],
    evidence: [],
    agent_policies: {
      default: { allowed_tools: ["*"], denied_tools: [], scope_override: null },
      Explore: {
        allowed_tools: ["Read", "Grep", "Glob"],
        denied_tools: ["Edit", "Write", "Bash", "NotebookEdit"],
        scope_override: null,
      },
      Plan: {
        allowed_tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
        denied_tools: ["Edit", "Write", "Bash"],
        scope_override: null,
      },
    },
    ...overrides,
  };
}

/**
 * Helper to invoke gate.handler with agent context.
 */
function gateCallWithAgent(toolName, toolInput, agentType, agentId) {
  return gate.handler({
    tool_name: toolName,
    tool_input: toolInput,
    agent_id: agentId || "agent-c6-test",
    agent_type: agentType,
  });
}

/**
 * Helper to invoke gate.handler without agent context (main thread).
 */
function gateCallMainThread(toolName, toolInput) {
  return gate.handler({
    tool_name: toolName,
    tool_input: toolInput,
  });
}

/**
 * Assert that a gate result is a policy denial.
 */
function assertPolicyDenial(result, message) {
  assert.ok(result !== null, message || "Expected denial, got null (pass-through)");
  assert.strictEqual(
    result.hookSpecificOutput.permissionDecision,
    "deny",
    message || "Expected deny decision",
  );
  assert.ok(
    result.hookSpecificOutput.additionalContext.includes("エージェントポリシー違反"),
    message || "Expected agent policy violation message",
  );
}

/**
 * Assert that a gate result is NOT a policy denial (may be null or other denial).
 */
function assertNotPolicyDenial(result, message) {
  if (result === null) return; // pass-through is fine
  assert.ok(
    !result.hookSpecificOutput.additionalContext.includes("エージェントポリシー違反"),
    message || "Should not be blocked by agent policy",
  );
}

// ========================================================================
// 1. Basic Policy Enforcement
// ========================================================================

describe("C6-1: Basic policy enforcement", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("Explore agent denied Edit tool", () => {
    saveSession(makeBaseSession());

    const result = gateCallWithAgent("Edit", {
      file_path: path.join(PROJECT_DIR, "tests", "x.js"),
      old_string: "a",
      new_string: "b",
    }, "Explore");

    assertPolicyDenial(result);
  });

  it("Explore agent denied Write tool", () => {
    saveSession(makeBaseSession());

    const result = gateCallWithAgent("Write", {
      file_path: path.join(PROJECT_DIR, "tests", "x.js"),
      content: "test content",
    }, "Explore");

    assertPolicyDenial(result);
  });

  it("Explore agent denied Bash tool", () => {
    saveSession(makeBaseSession());

    const result = gateCallWithAgent("Bash", {
      command: "echo hello",
    }, "Explore");

    assertPolicyDenial(result);
  });

  it("Explore agent allowed Read tool", () => {
    saveSession(makeBaseSession());

    const result = gateCallWithAgent("Read", {
      file_path: path.join(PROJECT_DIR, "tests", "x.js"),
    }, "Explore");

    // Read should pass through (null = allowed)
    assert.strictEqual(result, null, "Read should be allowed for Explore agent");
  });

  it("Plan agent denied Bash tool", () => {
    saveSession(makeBaseSession());

    const result = gateCallWithAgent("Bash", {
      command: "echo hello",
    }, "Plan");

    assertPolicyDenial(result);
  });

  it("Plan agent allowed Grep tool", () => {
    saveSession(makeBaseSession());

    const result = gateCallWithAgent("Grep", {
      pattern: "test",
    }, "Plan");

    assert.strictEqual(result, null, "Grep should be allowed for Plan agent");
  });
});

// ========================================================================
// 2. Privilege Escalation Attempts
// ========================================================================

describe("C6-2: Privilege escalation attempts", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("agent claiming 'default' type gets default policy (wildcard)", () => {
    // An agent claiming to be "default" type resolves to the "default" policy
    // which has allowed_tools: ["*"]. This is by design — the "default" policy
    // IS the permissive fallback. The key test is that specific restricted
    // agent types cannot bypass their restrictions.
    saveSession(makeBaseSession());

    const permission = tobariSession.checkAgentToolPermission("default", "Bash");
    assert.strictEqual(permission.allowed, true,
      "default policy allows all tools (by design)");

    // But this does NOT let an Explore agent bypass by claiming "default"
    const exploreResult = tobariSession.checkAgentToolPermission("Explore", "Bash");
    assert.strictEqual(exploreResult.allowed, false,
      "Explore agent cannot use Bash regardless of default policy");
  });

  it("agent with empty string type skips policy check (main thread behavior)", () => {
    saveSession(makeBaseSession());

    // Empty agent_type in gate handler: treated as main thread, skips policy check
    const result = gate.handler({
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(PROJECT_DIR, "tests", "x.js"),
        old_string: "a",
        new_string: "b",
      },
      agent_id: "agent-sneaky",
      agent_type: "",
    });

    // Should NOT be blocked by agent policy (empty type = main thread)
    assertNotPolicyDenial(result);
  });

  it("agent with undefined type skips policy check (main thread behavior)", () => {
    saveSession(makeBaseSession());

    const result = gate.handler({
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(PROJECT_DIR, "tests", "x.js"),
        old_string: "a",
        new_string: "b",
      },
      agent_id: "agent-sneaky",
      // agent_type intentionally omitted (undefined)
    });

    assertNotPolicyDenial(result);
  });

  it("unknown agent type falls back to default policy", () => {
    saveSession(makeBaseSession());

    // "MaliciousAgent" has no policy defined — falls back to "default"
    const permission = tobariSession.checkAgentToolPermission("MaliciousAgent", "Bash");
    assert.strictEqual(permission.allowed, true,
      "Unknown type falls back to default (wildcard)");

    // When default policy is restrictive, unknown agents are also restricted
    const restrictiveSession = makeBaseSession({
      agent_policies: {
        default: { allowed_tools: ["Read"], denied_tools: ["Bash"], scope_override: null },
        Explore: {
          allowed_tools: ["Read", "Grep", "Glob"],
          denied_tools: ["Edit", "Write", "Bash", "NotebookEdit"],
          scope_override: null,
        },
      },
    });
    saveSession(restrictiveSession);

    const restrictedResult = tobariSession.checkAgentToolPermission("MaliciousAgent", "Bash");
    assert.strictEqual(restrictedResult.allowed, false,
      "Unknown type with restrictive default is denied Bash");
  });
});

// ========================================================================
// 3. Policy Manipulation
// ========================================================================

describe("C6-3: Policy manipulation", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("session with no agent_policies field defaults to all-allowed", () => {
    const session = makeBaseSession();
    delete session.agent_policies;
    saveSession(session);

    const policy = tobariSession.getAgentPolicy("Explore");
    assert.deepStrictEqual(policy.allowed_tools, ["*"]);
    assert.deepStrictEqual(policy.denied_tools, []);
    assert.strictEqual(policy.scope_override, null);

    // Gate should also pass through
    const result = gateCallWithAgent("Edit", {
      file_path: path.join(PROJECT_DIR, "tests", "x.js"),
      old_string: "a",
      new_string: "b",
    }, "Explore");

    assertNotPolicyDenial(result, "No policies = no agent policy blocking");
  });

  it("session with empty agent_policies defaults to all-allowed", () => {
    saveSession(makeBaseSession({ agent_policies: {} }));

    const policy = tobariSession.getAgentPolicy("Explore");
    assert.deepStrictEqual(policy.allowed_tools, ["*"]);
    assert.deepStrictEqual(policy.denied_tools, []);
    assert.strictEqual(policy.scope_override, null);
  });

  it("denied_tools takes precedence when tool is in both allowed and denied", () => {
    saveSession(makeBaseSession({
      agent_policies: {
        conflicting: {
          allowed_tools: ["Read", "Bash", "Edit"],
          denied_tools: ["Bash", "Edit"],
          scope_override: null,
        },
      },
    }));

    const bashResult = tobariSession.checkAgentToolPermission("conflicting", "Bash");
    assert.strictEqual(bashResult.allowed, false,
      "Bash in both lists — denied_tools wins");

    const editResult = tobariSession.checkAgentToolPermission("conflicting", "Edit");
    assert.strictEqual(editResult.allowed, false,
      "Edit in both lists — denied_tools wins");

    // Read is only in allowed_tools, should be allowed
    const readResult = tobariSession.checkAgentToolPermission("conflicting", "Read");
    assert.strictEqual(readResult.allowed, true,
      "Read only in allowed_tools — should be allowed");
  });
});

// ========================================================================
// 4. denied_tools Precedence (thorough)
// ========================================================================

describe("C6-4: denied_tools precedence", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("wildcard allowed + specific denied: denied tool is blocked", () => {
    saveSession(makeBaseSession({
      agent_policies: {
        test_agent: {
          allowed_tools: ["*"],
          denied_tools: ["Bash"],
          scope_override: null,
        },
      },
    }));

    const bashResult = tobariSession.checkAgentToolPermission("test_agent", "Bash");
    assert.strictEqual(bashResult.allowed, false,
      "Bash denied even with wildcard allowed");

    // Other tools should still be allowed
    const readResult = tobariSession.checkAgentToolPermission("test_agent", "Read");
    assert.strictEqual(readResult.allowed, true,
      "Read should be allowed (not in denied_tools)");
  });

  it("explicit allowed + explicit denied for same tool: denied wins", () => {
    saveSession(makeBaseSession({
      agent_policies: {
        test_agent: {
          allowed_tools: ["Read", "Bash"],
          denied_tools: ["Bash"],
          scope_override: null,
        },
      },
    }));

    const result = tobariSession.checkAgentToolPermission("test_agent", "Bash");
    assert.strictEqual(result.allowed, false,
      "Bash explicitly in both lists — denied takes precedence");
  });

  it("empty allowed + empty denied: tool not in allowed_tools is denied", () => {
    saveSession(makeBaseSession({
      agent_policies: {
        test_agent: {
          allowed_tools: [],
          denied_tools: [],
          scope_override: null,
        },
      },
    }));

    // With empty allowed_tools (no wildcard), any tool should be denied
    const result = tobariSession.checkAgentToolPermission("test_agent", "Read");
    assert.strictEqual(result.allowed, false,
      "Empty allowed_tools (no wildcard) — Read should be denied");
  });

  it("gate handler respects denied_tools with wildcard allowed", () => {
    saveSession(makeBaseSession({
      agent_policies: {
        RestrictedAgent: {
          allowed_tools: ["*"],
          denied_tools: ["Bash"],
          scope_override: null,
        },
      },
    }));

    const result = gateCallWithAgent("Bash", {
      command: "echo safe",
    }, "RestrictedAgent");

    assertPolicyDenial(result,
      "Gate should deny Bash for RestrictedAgent despite wildcard allowed");
  });
});

// ========================================================================
// 5. Edge Cases
// ========================================================================

describe("C6-5: Edge cases", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("very long agent type string falls back to default", () => {
    saveSession(makeBaseSession());

    const longType = "A".repeat(10000);
    const policy = tobariSession.getAgentPolicy(longType);

    // Should fall back to default policy (no matching key)
    assert.deepStrictEqual(policy.allowed_tools, ["*"],
      "Very long agent type should fall back to default policy");
  });

  it("agent type with special characters falls back to default", () => {
    saveSession(makeBaseSession());

    const specialTypes = [
      "../../../etc/passwd",
      "__proto__",
      "constructor",
      "<script>alert(1)</script>",
      "Explore\x00Hidden",
    ];

    for (const specialType of specialTypes) {
      const policy = tobariSession.getAgentPolicy(specialType);
      // Should not crash and should fall back to default
      assert.deepStrictEqual(policy.allowed_tools, ["*"],
        `Special type "${specialType.slice(0, 30)}" should fall back to default`);
    }
  });

  it("policy with null in denied_tools array does not crash", () => {
    // Simulate malformed policy with null entries in arrays
    saveSession(makeBaseSession({
      agent_policies: {
        Malformed: {
          allowed_tools: ["Read", null, "Grep"],
          denied_tools: [null, "Bash"],
          scope_override: null,
        },
      },
    }));

    // Should not throw; denied_tools.includes("Bash") should still work
    const result = tobariSession.checkAgentToolPermission("Malformed", "Bash");
    assert.strictEqual(result.allowed, false,
      "Bash should still be denied despite null entries in array");
  });

  it("policy with undefined values returns safe defaults", () => {
    // Policy object with undefined fields — getAgentPolicy should fill defaults
    saveSession(makeBaseSession({
      agent_policies: {
        Sparse: {
          // allowed_tools and denied_tools intentionally missing
          scope_override: null,
        },
      },
    }));

    const policy = tobariSession.getAgentPolicy("Sparse");
    assert.deepStrictEqual(policy.allowed_tools, ["*"],
      "Missing allowed_tools defaults to wildcard");
    assert.deepStrictEqual(policy.denied_tools, [],
      "Missing denied_tools defaults to empty array");
  });

  it("main thread bypasses all agent policy checks via gate", () => {
    // Even with very restrictive agent policies, main thread is unaffected
    saveSession(makeBaseSession({
      agent_policies: {
        default: { allowed_tools: [], denied_tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"], scope_override: null },
        Explore: { allowed_tools: [], denied_tools: ["Read", "Edit", "Write", "Bash"], scope_override: null },
      },
    }));

    // Main thread (no agent_type) should pass through agent policy check
    const result = gateCallMainThread("Bash", { command: "echo hello" });
    assertNotPolicyDenial(result,
      "Main thread should never be blocked by agent policy");
  });
});

// ========================================================================
// 6. Gate Integration — Full Deny Flow
// ========================================================================

describe("C6-6: Gate integration — deny response structure", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("deny response includes correct hook event name", () => {
    saveSession(makeBaseSession());

    const result = gateCallWithAgent("Edit", {
      file_path: path.join(PROJECT_DIR, "tests", "x.js"),
      old_string: "a",
      new_string: "b",
    }, "Explore");

    assert.ok(result !== null);
    assert.strictEqual(result.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.strictEqual(result.hookSpecificOutput.permissionDecision, "deny");
  });

  it("deny response mentions the agent type in context", () => {
    saveSession(makeBaseSession());

    const result = gateCallWithAgent("Bash", {
      command: "echo hello",
    }, "Plan");

    assert.ok(result !== null);
    const context = result.hookSpecificOutput.additionalContext;
    assert.ok(context.includes("Plan"),
      "Deny context should mention the agent type");
  });

  it("NotebookEdit denied for Explore agent", () => {
    saveSession(makeBaseSession());

    const result = gateCallWithAgent("NotebookEdit", {
      notebook_path: path.join(PROJECT_DIR, "tests", "notebook.ipynb"),
      new_source: "print('hello')",
    }, "Explore");

    assertPolicyDenial(result,
      "NotebookEdit should be denied for Explore agent");
  });

  it("multiple denied tools all produce policy denial", () => {
    saveSession(makeBaseSession());

    const deniedToolsForExplore = ["Edit", "Write", "Bash", "NotebookEdit"];

    for (const tool of deniedToolsForExplore) {
      const toolInput = tool === "Bash"
        ? { command: "echo test" }
        : tool === "NotebookEdit"
          ? { notebook_path: path.join(PROJECT_DIR, "tests", "nb.ipynb"), new_source: "x" }
          : tool === "Write"
            ? { file_path: path.join(PROJECT_DIR, "tests", "x.js"), content: "x" }
            : { file_path: path.join(PROJECT_DIR, "tests", "x.js"), old_string: "a", new_string: "b" };

      const result = gateCallWithAgent(tool, toolInput, "Explore");
      assertPolicyDenial(result,
        `${tool} should be denied for Explore agent`);
    }
  });
});

// ========================================================================
// 7. Cross-agent isolation
// ========================================================================

describe("C6-7: Cross-agent isolation", () => {
  beforeEach(() => {
    originalContent = fs.readFileSync(SESSION_PATH, "utf8");
  });

  afterEach(() => {
    restoreSession();
  });

  it("Explore policy does not affect Plan agent", () => {
    saveSession(makeBaseSession());

    // WebSearch is allowed for Plan but not in Explore's allowed_tools
    const planResult = gateCallWithAgent("WebSearch", {
      query: "test",
    }, "Plan");
    assert.strictEqual(planResult, null,
      "WebSearch should be allowed for Plan");

    // WebSearch is not in Explore's allowed_tools
    const exploreResult = gateCallWithAgent("WebSearch", {
      query: "test",
    }, "Explore");
    assertPolicyDenial(exploreResult,
      "WebSearch should be denied for Explore (not in allowed_tools)");
  });

  it("different agent IDs with same type get same policy", () => {
    saveSession(makeBaseSession());

    const result1 = tobariSession.checkAgentToolPermission("Explore", "Edit");
    const result2 = tobariSession.checkAgentToolPermission("Explore", "Edit");

    assert.strictEqual(result1.allowed, result2.allowed,
      "Same agent type should get same policy regardless of agent ID");
    assert.strictEqual(result1.allowed, false);
  });

  it("Plan agent can use WebFetch but Explore cannot", () => {
    saveSession(makeBaseSession());

    const planResult = tobariSession.checkAgentToolPermission("Plan", "WebFetch");
    assert.strictEqual(planResult.allowed, true,
      "Plan agent should be allowed WebFetch");

    const exploreResult = tobariSession.checkAgentToolPermission("Explore", "WebFetch");
    assert.strictEqual(exploreResult.allowed, false,
      "Explore agent should be denied WebFetch (not in allowed_tools)");
  });
});
