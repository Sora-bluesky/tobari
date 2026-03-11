#!/usr/bin/env node
"use strict";
/**
 * Tests for tobari-permission.js — PermissionRequest Hook.
 *
 * Covers:
 * - SAFE_BASH_PATTERNS structure and count
 * - isSafeBash: safe git commands, safe other commands, unsafe commands, edge cases
 * - describeOperation: all tool types
 * - classifyOperation: safe/unknown classification
 * - makeSystemMessage: Japanese output structure
 * - Module exports completeness
 *
 * Run: node --test tests/test_tobari_permission_js.js
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Set CLAUDE_PROJECT_DIR before requiring the module
const PROJECT_DIR = path.resolve(__dirname, "..");
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;

const perm = require("../.claude/hooks/tobari-permission.js");

// --- Tests ---

describe("SAFE_BASH_PATTERNS", () => {
  it("is an array", () => {
    assert.ok(Array.isArray(perm.SAFE_BASH_PATTERNS));
  });

  it("has 24 patterns", () => {
    assert.equal(perm.SAFE_BASH_PATTERNS.length, 24);
  });

  it("each entry is [RegExp, string]", () => {
    for (const [pattern, label] of perm.SAFE_BASH_PATTERNS) {
      assert.ok(pattern instanceof RegExp, `Expected RegExp, got ${typeof pattern}`);
      assert.equal(typeof label, "string", `Expected string label, got ${typeof label}`);
    }
  });

  it("all patterns have the i flag for case-insensitive matching", () => {
    for (const [pattern] of perm.SAFE_BASH_PATTERNS) {
      assert.ok(pattern.flags.includes("i"), `Pattern ${pattern} missing i flag`);
    }
  });

  it("all patterns are anchored with ^", () => {
    for (const [pattern] of perm.SAFE_BASH_PATTERNS) {
      assert.ok(pattern.source.startsWith("^"), `Pattern ${pattern} not anchored with ^`);
    }
  });
});

describe("isSafeBash — safe git read-only commands", () => {
  it("git status is safe", () => {
    const [safe, label] = perm.isSafeBash("git status");
    assert.equal(safe, true);
    assert.ok(label.length > 0);
  });

  it("git log is safe", () => {
    const [safe] = perm.isSafeBash("git log");
    assert.equal(safe, true);
  });

  it("git log --oneline is safe", () => {
    const [safe] = perm.isSafeBash("git log --oneline");
    assert.equal(safe, true);
  });

  it("git diff is safe", () => {
    const [safe] = perm.isSafeBash("git diff");
    assert.equal(safe, true);
  });

  it("git show is safe", () => {
    const [safe] = perm.isSafeBash("git show HEAD");
    assert.equal(safe, true);
  });

  it("git blame is safe", () => {
    const [safe] = perm.isSafeBash("git blame file.js");
    assert.equal(safe, true);
  });
});

describe("isSafeBash — safe git write commands", () => {
  it("git add . is safe", () => {
    const [safe] = perm.isSafeBash("git add .");
    assert.equal(safe, true);
  });

  it("git commit -m 'msg' is safe", () => {
    const [safe] = perm.isSafeBash("git commit -m 'msg'");
    assert.equal(safe, true);
  });

  it("git fetch is safe", () => {
    const [safe] = perm.isSafeBash("git fetch origin");
    assert.equal(safe, true);
  });

  it("git pull is safe", () => {
    const [safe] = perm.isSafeBash("git pull origin main");
    assert.equal(safe, true);
  });

  it("git merge is safe", () => {
    const [safe] = perm.isSafeBash("git merge feature");
    assert.equal(safe, true);
  });

  it("git push origin main is safe", () => {
    const [safe] = perm.isSafeBash("git push origin main");
    assert.equal(safe, true);
  });

  it("git push --force-with-lease is safe", () => {
    const [safe] = perm.isSafeBash("git push --force-with-lease origin main");
    assert.equal(safe, true);
  });
});

describe("isSafeBash — safe non-git commands", () => {
  it("npm test is safe", () => {
    const [safe] = perm.isSafeBash("npm test");
    assert.equal(safe, true);
  });

  it("npm run test is safe", () => {
    const [safe] = perm.isSafeBash("npm run test");
    assert.equal(safe, true);
  });

  it("pytest is safe", () => {
    const [safe] = perm.isSafeBash("pytest -v");
    assert.equal(safe, true);
  });

  it("python -m pytest is safe", () => {
    const [safe] = perm.isSafeBash("python -m pytest tests/");
    assert.equal(safe, true);
  });

  it("ls -la is safe", () => {
    const [safe] = perm.isSafeBash("ls -la");
    assert.equal(safe, true);
  });

  it("cat file.txt is safe", () => {
    const [safe] = perm.isSafeBash("cat file.txt");
    assert.equal(safe, true);
  });

  it("node script.js is safe", () => {
    const [safe] = perm.isSafeBash("node script.js");
    assert.equal(safe, true);
  });

  it("pwsh script.ps1 is safe", () => {
    const [safe] = perm.isSafeBash("pwsh script.ps1");
    assert.equal(safe, true);
  });

  it("gh pr list is safe", () => {
    const [safe] = perm.isSafeBash("gh pr list");
    assert.equal(safe, true);
  });

  it("gh issue view 123 is safe", () => {
    const [safe] = perm.isSafeBash("gh issue view 123");
    assert.equal(safe, true);
  });

  it("npm list is safe", () => {
    const [safe] = perm.isSafeBash("npm list");
    assert.equal(safe, true);
  });

  it("jq '.key' file.json is safe", () => {
    const [safe] = perm.isSafeBash("jq '.key' file.json");
    assert.equal(safe, true);
  });
});

describe("isSafeBash — unsafe commands", () => {
  it("git push --force is NOT safe", () => {
    const [safe] = perm.isSafeBash("git push --force origin main");
    assert.equal(safe, false);
  });

  it("git push -f is NOT safe", () => {
    const [safe] = perm.isSafeBash("git push -f origin main");
    // push -f may or may not match the negative lookahead;
    // the pattern blocks -f via the push safe-pattern's negative lookahead
    // Check: push pattern is /^git\s+push(?!\s+.*(-f\b|--force...))\b/i
    // "git push -f" — the lookahead sees "-f" so push is NOT matched as safe
    assert.equal(safe, false);
  });

  it("git branch -D feature is NOT safe", () => {
    const [safe] = perm.isSafeBash("git branch -D feature");
    assert.equal(safe, false);
  });

  it("git stash drop is NOT safe", () => {
    const [safe] = perm.isSafeBash("git stash drop");
    assert.equal(safe, false);
  });

  it("git stash clear is NOT safe", () => {
    const [safe] = perm.isSafeBash("git stash clear");
    assert.equal(safe, false);
  });

  it("rm -rf / is NOT safe (not in safe patterns)", () => {
    const [safe] = perm.isSafeBash("rm -rf /");
    assert.equal(safe, false);
  });

  it("curl http://example.com is NOT safe", () => {
    const [safe] = perm.isSafeBash("curl http://example.com");
    assert.equal(safe, false);
  });
});

describe("isSafeBash — edge cases", () => {
  it("empty string returns [false, '']", () => {
    const [safe, label] = perm.isSafeBash("");
    assert.equal(safe, false);
    assert.equal(label, "");
  });

  it("null returns [false, '']", () => {
    const [safe, label] = perm.isSafeBash(null);
    assert.equal(safe, false);
    assert.equal(label, "");
  });

  it("undefined returns [false, '']", () => {
    const [safe, label] = perm.isSafeBash(undefined);
    assert.equal(safe, false);
    assert.equal(label, "");
  });

  it("case insensitive: GIT STATUS is safe", () => {
    const [safe] = perm.isSafeBash("GIT STATUS");
    assert.equal(safe, true);
  });

  it("leading whitespace is trimmed", () => {
    const [safe] = perm.isSafeBash("  git status");
    assert.equal(safe, true);
  });

  it("git stash list overrides stash drop/clear exclusion", () => {
    // "git stash list" should match the explicit stash list pattern
    const [safe] = perm.isSafeBash("git stash list");
    assert.equal(safe, true);
  });
});

describe("describeOperation — Bash", () => {
  it("Bash with description includes desc text", () => {
    const result = perm.describeOperation("Bash", {
      command: "git status",
      description: "check working tree",
    });
    assert.ok(result.includes("check working tree"));
    assert.ok(result.includes("git status"));
  });

  it("Bash without description shows command only", () => {
    const result = perm.describeOperation("Bash", { command: "git status" });
    assert.ok(result.includes("git status"));
  });

  it("Bash truncates long command to 80 chars", () => {
    const longCmd = "a".repeat(200);
    const result = perm.describeOperation("Bash", { command: longCmd });
    // Command is sliced to 80 chars
    assert.ok(result.includes("a".repeat(80)));
    assert.ok(!result.includes("a".repeat(81)));
  });

  it("Bash with desc truncates command to 60 chars", () => {
    const longCmd = "b".repeat(200);
    const result = perm.describeOperation("Bash", {
      command: longCmd,
      description: "desc",
    });
    assert.ok(result.includes("b".repeat(60)));
    assert.ok(result.includes("desc"));
  });
});

describe("describeOperation — Edit/Write", () => {
  it("Edit shows file path", () => {
    const result = perm.describeOperation("Edit", { file_path: "/foo/bar.js" });
    assert.ok(result.includes("/foo/bar.js"));
    assert.ok(result.includes("\u7DE8\u96C6") || result.includes("\u4F5C\u6210"));
  });

  it("Write shows file path", () => {
    const result = perm.describeOperation("Write", { file_path: "/baz/qux.ts" });
    assert.ok(result.includes("/baz/qux.ts"));
  });

  it("Edit with missing file_path shows fallback", () => {
    const result = perm.describeOperation("Edit", {});
    assert.ok(result.includes("\u4E0D\u660E"));
  });
});

describe("describeOperation — Read", () => {
  it("Read shows file path", () => {
    const result = perm.describeOperation("Read", { file_path: "/foo.txt" });
    assert.ok(result.includes("/foo.txt"));
    assert.ok(result.includes("\u8AAD\u307F\u8FBC\u307F"));
  });

  it("Read with missing file_path shows fallback", () => {
    const result = perm.describeOperation("Read", {});
    assert.ok(result.includes("\u4E0D\u660E"));
  });
});

describe("describeOperation — Glob/Grep", () => {
  it("Glob returns search description", () => {
    const result = perm.describeOperation("Glob", { pattern: "*.js" });
    assert.ok(result.includes("\u691C\u7D22"));
  });

  it("Grep returns search description", () => {
    const result = perm.describeOperation("Grep", { pattern: "TODO" });
    assert.ok(result.includes("\u691C\u7D22"));
  });
});

describe("describeOperation — WebFetch/WebSearch", () => {
  it("WebFetch shows URL", () => {
    const result = perm.describeOperation("WebFetch", { url: "https://example.com/page" });
    assert.ok(result.includes("example.com"));
    assert.ok(result.includes("\u53D6\u5F97"));
  });

  it("WebSearch shows query", () => {
    const result = perm.describeOperation("WebSearch", { query: "test query" });
    assert.ok(result.includes("test query"));
    assert.ok(result.includes("\u691C\u7D22"));
  });
});

describe("describeOperation — Task", () => {
  it("Task shows subagent description", () => {
    const result = perm.describeOperation("Task", { description: "analyze code" });
    assert.ok(result.includes("analyze code"));
    assert.ok(result.includes("\u30B5\u30D6\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8"));
  });
});

describe("describeOperation — unknown tool", () => {
  it("unknown tool returns tool name with suffix", () => {
    const result = perm.describeOperation("FooTool", {});
    assert.ok(result.includes("FooTool"));
    assert.ok(result.includes("\u5B9F\u884C"));
  });
});

describe("classifyOperation — safe tools", () => {
  it("Read is safe", () => {
    const [cls, reason] = perm.classifyOperation("Read", {});
    assert.equal(cls, "safe");
    assert.ok(reason.includes("Read"));
  });

  it("Glob is safe", () => {
    const [cls] = perm.classifyOperation("Glob", {});
    assert.equal(cls, "safe");
  });

  it("Grep is safe", () => {
    const [cls] = perm.classifyOperation("Grep", {});
    assert.equal(cls, "safe");
  });

  it("Task is safe", () => {
    const [cls, reason] = perm.classifyOperation("Task", {});
    assert.equal(cls, "safe");
    assert.ok(reason.length > 0);
  });
});

describe("classifyOperation — Bash", () => {
  it("safe Bash command is classified as safe", () => {
    const [cls, reason] = perm.classifyOperation("Bash", { command: "git status" });
    assert.equal(cls, "safe");
    assert.ok(reason.length > 0);
  });

  it("unsafe Bash command is classified as unknown", () => {
    const [cls, reason] = perm.classifyOperation("Bash", { command: "curl http://example.com" });
    assert.equal(cls, "unknown");
    assert.ok(reason.length > 0);
  });

  it("Bash with empty command is unknown", () => {
    const [cls] = perm.classifyOperation("Bash", { command: "" });
    assert.equal(cls, "unknown");
  });

  it("Bash with no command key is unknown", () => {
    const [cls] = perm.classifyOperation("Bash", {});
    assert.equal(cls, "unknown");
  });
});

describe("classifyOperation — Edit/Write", () => {
  it("Edit/Write delegates to isPathInScope", () => {
    // Result depends on session scope state; verify it returns a valid classification
    const [cls, reason] = perm.classifyOperation("Edit", { file_path: "/some/path.js" });
    assert.ok(cls === "safe" || cls === "unknown");
    assert.ok(reason.length > 0);
  });

  it("Edit with file_path delegates to isPathInScope", () => {
    // Result depends on active session scope: safe if in-scope or no session, unknown if out-of-scope
    const [cls] = perm.classifyOperation("Edit", {
      file_path: ".claude/hooks/tobari-permission.js",
    });
    assert.ok(cls === "safe" || cls === "unknown",
      `Expected 'safe' or 'unknown', got '${cls}'`);
  });

  it("Write with file_path is classified", () => {
    const [cls] = perm.classifyOperation("Write", { file_path: "/some/file.txt" });
    assert.ok(cls === "safe" || cls === "unknown");
  });

  it("Edit with no file_path is unknown", () => {
    const [cls] = perm.classifyOperation("Edit", {});
    assert.equal(cls, "unknown");
  });

  it("NotebookEdit with notebook_path is classified", () => {
    const [cls] = perm.classifyOperation("NotebookEdit", { notebook_path: "/nb.ipynb" });
    assert.ok(cls === "safe" || cls === "unknown");
  });
});

describe("classifyOperation — unknown tools", () => {
  it("unknown tool name returns unknown", () => {
    const [cls, reason] = perm.classifyOperation("SomeNewTool", {});
    assert.equal(cls, "unknown");
    assert.ok(reason.includes("SomeNewTool"));
  });

  it("WebFetch is unknown (not in safe list)", () => {
    const [cls] = perm.classifyOperation("WebFetch", { url: "https://example.com" });
    assert.equal(cls, "unknown");
  });

  it("WebSearch is unknown (not in safe list)", () => {
    const [cls] = perm.classifyOperation("WebSearch", { query: "test" });
    assert.equal(cls, "unknown");
  });
});

describe("makeSystemMessage", () => {
  it("returns a string", () => {
    const msg = perm.makeSystemMessage("Bash", { command: "curl http://x" }, "\u7406\u7531", "TASK-082", "strict");
    assert.equal(typeof msg, "string");
  });

  it("contains the task name", () => {
    const msg = perm.makeSystemMessage("Bash", { command: "test" }, "reason", "TASK-099", "standard");
    assert.ok(msg.includes("TASK-099"));
  });

  it("contains the profile", () => {
    const msg = perm.makeSystemMessage("Bash", { command: "test" }, "reason", "TASK-099", "strict");
    assert.ok(msg.includes("strict"));
  });

  it("contains the reason", () => {
    const msg = perm.makeSystemMessage("Bash", { command: "test" }, "\u5B89\u5168\u30D1\u30BF\u30FC\u30F3\u5916", "TASK-099", "standard");
    assert.ok(msg.includes("\u5B89\u5168\u30D1\u30BF\u30FC\u30F3\u5916"));
  });

  it("contains Japanese text (kanji/hiragana)", () => {
    const msg = perm.makeSystemMessage("Edit", { file_path: "/f.js" }, "r", "T", "lite");
    // Should contain Japanese characters (profile label, instructions)
    assert.ok(msg.includes("\u30D7\u30ED\u30D5\u30A1\u30A4\u30EB"));
    assert.ok(msg.includes("\u7406\u7531"));
  });

  it("contains the tobari veil emoji prefix", () => {
    const msg = perm.makeSystemMessage("Bash", { command: "x" }, "r", "T", "standard");
    assert.ok(msg.includes("\uD83C\uDFAD"));
  });

  it("contains the operation description from describeOperation", () => {
    const msg = perm.makeSystemMessage("Bash", { command: "curl http://api.example.com" }, "r", "T", "standard");
    assert.ok(msg.includes("curl"));
  });

  it("contains updatedPermissions guidance text", () => {
    const msg = perm.makeSystemMessage("Bash", { command: "x" }, "r", "T", "standard");
    assert.ok(msg.includes("\u5E38\u306B\u8A31\u53EF"));
  });
});

describe("module exports completeness", () => {
  it("exports all expected functions", () => {
    const expectedFunctions = [
      "isSafeBash",
      "describeOperation",
      "classifyOperation",
      "makeSystemMessage",
      "handler",
    ];
    for (const fn of expectedFunctions) {
      assert.equal(typeof perm[fn], "function", `Missing function export: ${fn}`);
    }
  });

  it("exports SAFE_BASH_PATTERNS constant", () => {
    assert.ok(Array.isArray(perm.SAFE_BASH_PATTERNS));
  });

  it("has exactly 6 exports", () => {
    const keys = Object.keys(perm);
    assert.equal(keys.length, 6);
  });
});
