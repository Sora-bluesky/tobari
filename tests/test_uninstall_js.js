#!/usr/bin/env node
"use strict";
/**
 * Tests for uninstall command and deploy.js expanded gitignore/skill constants.
 *
 * Covers:
 * - TOBARI_SKILLS list (includes tobari-evolve, tobari-immune)
 * - buildGitignoreEntries() output (skill dirs, session state, headers)
 * - Uninstall integration: hooks, rules, skills, agents, commands removal
 * - Uninstall integration: settings.json cleaning (hooks removed, permissions preserved)
 * - Uninstall integration: CLAUDE.md tobari section removal
 * - Uninstall integration: package.json prepare script cleaning
 * - Uninstall integration: .gitignore tobari entry removal
 * - Uninstall integration: runtime file removal
 * - Uninstall integration: user file preservation
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  TOBARI_SKILLS,
  buildGitignoreEntries,
  GITIGNORE_ENTRIES,
} = require("../bin/lib/deploy");

// --- deploy.js — TOBARI_SKILLS ---

describe("deploy.js — TOBARI_SKILLS", () => {
  it("includes tobari-evolve", () => {
    assert.ok(TOBARI_SKILLS.includes("tobari-evolve"));
  });

  it("includes tobari-immune", () => {
    assert.ok(TOBARI_SKILLS.includes("tobari-immune"));
  });

  it("has 14 skills total", () => {
    assert.strictEqual(TOBARI_SKILLS.length, 14);
  });

  it("includes core skills", () => {
    const coreSkills = ["tobari", "init", "startproject", "handoff", "tdd"];
    for (const skill of coreSkills) {
      assert.ok(TOBARI_SKILLS.includes(skill), `Missing core skill: ${skill}`);
    }
  });
});

// --- deploy.js — buildGitignoreEntries ---

describe("deploy.js — buildGitignoreEntries", () => {
  it("includes .claude/hooks/", () => {
    const entries = buildGitignoreEntries();
    assert.ok(entries.includes(".claude/hooks/"));
  });

  it("includes .claude/rules/", () => {
    const entries = buildGitignoreEntries();
    assert.ok(entries.includes(".claude/rules/"));
  });

  it("includes .claude/agents/", () => {
    const entries = buildGitignoreEntries();
    assert.ok(entries.includes(".claude/agents/"));
  });

  it("includes .claude/commands/", () => {
    const entries = buildGitignoreEntries();
    assert.ok(entries.includes(".claude/commands/"));
  });

  it("includes skill directories from TOBARI_SKILLS", () => {
    const entries = buildGitignoreEntries();
    for (const skill of TOBARI_SKILLS) {
      assert.ok(
        entries.includes(`.claude/skills/${skill}/`),
        `Missing .claude/skills/${skill}/`,
      );
    }
  });

  it("does NOT include .claude/settings.json", () => {
    const entries = buildGitignoreEntries();
    assert.ok(!entries.includes(".claude/settings.json"));
  });

  it("does NOT include CLAUDE.md", () => {
    const entries = buildGitignoreEntries();
    assert.ok(!entries.includes("CLAUDE.md"));
  });

  it("includes session state files", () => {
    const entries = buildGitignoreEntries();
    assert.ok(entries.includes(".claude/tobari-session.json"));
    assert.ok(entries.includes(".claude/logs/"));
    assert.ok(entries.includes(".tobari-version"));
    assert.ok(entries.includes("HANDOFF.md"));
  });

  it("includes infrastructure header comment", () => {
    const entries = buildGitignoreEntries();
    assert.ok(entries.some((e) => e.includes("infrastructure")));
  });

  it("includes session state header comment", () => {
    const entries = buildGitignoreEntries();
    assert.ok(entries.some((e) => e.includes("session state")));
  });
});

// --- Uninstall integration tests ---

describe("uninstall — integration", () => {
  let tmpDir;
  let originalCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tobari-uninstall-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    // Create a simulated tobari installation
    const claudeDir = path.join(tmpDir, ".claude");
    fs.mkdirSync(path.join(claudeDir, "hooks", "locales"), { recursive: true });
    fs.mkdirSync(path.join(claudeDir, "rules"), { recursive: true });
    fs.mkdirSync(path.join(claudeDir, "skills", "tobari"), { recursive: true });
    fs.mkdirSync(path.join(claudeDir, "skills", "tobari-evolve"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(claudeDir, "skills", "user-custom-skill"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(claudeDir, "agents"), { recursive: true });
    fs.mkdirSync(path.join(claudeDir, "commands"), { recursive: true });

    // Create hook files
    fs.writeFileSync(
      path.join(claudeDir, "hooks", "tobari-gate.js"),
      "// gate",
    );
    fs.writeFileSync(
      path.join(claudeDir, "hooks", "tobari-session.js"),
      "// session",
    );
    fs.writeFileSync(
      path.join(claudeDir, "hooks", "lint-on-save.js"),
      "// lint",
    );
    fs.writeFileSync(path.join(claudeDir, "hooks", "locales", "en.json"), "{}");
    fs.writeFileSync(path.join(claudeDir, "hooks", "locales", "ja.json"), "{}");

    // Create rule files
    fs.writeFileSync(
      path.join(claudeDir, "rules", "binding-governance.md"),
      "# rules",
    );
    fs.writeFileSync(
      path.join(claudeDir, "rules", "security.md"),
      "# security",
    );

    // Create skill files
    fs.writeFileSync(
      path.join(claudeDir, "skills", "tobari", "SKILL.md"),
      "# tobari",
    );
    fs.writeFileSync(
      path.join(claudeDir, "skills", "tobari-evolve", "SKILL.md"),
      "# evolve",
    );
    fs.writeFileSync(
      path.join(claudeDir, "skills", "user-custom-skill", "SKILL.md"),
      "# user",
    );

    // Create agent and command files
    fs.writeFileSync(
      path.join(claudeDir, "agents", "implementer.md"),
      "# agent",
    );
    fs.writeFileSync(path.join(claudeDir, "commands", "orose.md"), "# orose");

    // Create settings.json with tobari hooks + user permissions
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "Edit|Write",
                hooks: [
                  {
                    type: "command",
                    command:
                      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/tobari-gate.js"',
                    timeout: 10,
                  },
                ],
              },
            ],
          },
          permissions: {
            allow: ["Bash(npm test)", "Read"],
          },
        },
        null,
        2,
      ),
    );

    // Create CLAUDE.md with user content + tobari section
    fs.writeFileSync(
      path.join(tmpDir, "CLAUDE.md"),
      "# My Project\n\nUser instructions here.\n\n# tobari\n\nTobari config.\n",
    );

    // Create package.json with prepare script
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "test-project",
          version: "1.0.0",
          scripts: {
            test: "node --test",
            prepare: "tobari sync",
          },
        },
        null,
        2,
      ),
    );

    // Create .gitignore with tobari entries
    fs.writeFileSync(
      path.join(tmpDir, ".gitignore"),
      [
        "node_modules/",
        "",
        "# tobari - infrastructure (regenerated by `tobari sync`)",
        ".claude/hooks/",
        ".claude/rules/",
        "",
        "# tobari - session state and logs (do not commit)",
        ".claude/tobari-session.json",
        ".tobari-version",
        "HANDOFF.md",
        "",
      ].join("\n"),
    );

    // Create runtime files
    fs.writeFileSync(path.join(tmpDir, ".tobari-version"), "2.3.0\n");
    fs.writeFileSync(path.join(claudeDir, "tobari-session.json"), "{}");
    fs.mkdirSync(path.join(claudeDir, "logs"), { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  it("removes tobari hooks and locales directory", async () => {
    delete require.cache[require.resolve("../bin/commands/uninstall")];
    const uninstall = require("../bin/commands/uninstall");
    await uninstall({ yes: true });

    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    assert.ok(!fs.existsSync(path.join(hooksDir, "tobari-gate.js")));
    assert.ok(!fs.existsSync(path.join(hooksDir, "lint-on-save.js")));
    assert.ok(!fs.existsSync(path.join(hooksDir, "locales")));
  });

  it("removes tobari rules", async () => {
    delete require.cache[require.resolve("../bin/commands/uninstall")];
    const uninstall = require("../bin/commands/uninstall");
    await uninstall({ yes: true });

    const rulesDir = path.join(tmpDir, ".claude", "rules");
    assert.ok(!fs.existsSync(path.join(rulesDir, "binding-governance.md")));
    assert.ok(!fs.existsSync(path.join(rulesDir, "security.md")));
  });

  it("removes tobari skills but preserves user skills", async () => {
    delete require.cache[require.resolve("../bin/commands/uninstall")];
    const uninstall = require("../bin/commands/uninstall");
    await uninstall({ yes: true });

    const skillsDir = path.join(tmpDir, ".claude", "skills");
    assert.ok(!fs.existsSync(path.join(skillsDir, "tobari")));
    assert.ok(!fs.existsSync(path.join(skillsDir, "tobari-evolve")));
    // User skill preserved
    assert.ok(
      fs.existsSync(path.join(skillsDir, "user-custom-skill", "SKILL.md")),
    );
  });

  it("removes agents and commands directories", async () => {
    delete require.cache[require.resolve("../bin/commands/uninstall")];
    const uninstall = require("../bin/commands/uninstall");
    await uninstall({ yes: true });

    assert.ok(!fs.existsSync(path.join(tmpDir, ".claude", "agents")));
    assert.ok(!fs.existsSync(path.join(tmpDir, ".claude", "commands")));
  });

  it("cleans settings.json — removes hooks, preserves permissions", async () => {
    delete require.cache[require.resolve("../bin/commands/uninstall")];
    const uninstall = require("../bin/commands/uninstall");
    await uninstall({ yes: true });

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf8"),
    );
    assert.ok(!settings.hooks, "hooks should be removed");
    assert.deepStrictEqual(settings.permissions, {
      allow: ["Bash(npm test)", "Read"],
    });
  });

  it("cleans CLAUDE.md — removes tobari section, preserves user content", async () => {
    delete require.cache[require.resolve("../bin/commands/uninstall")];
    const uninstall = require("../bin/commands/uninstall");
    await uninstall({ yes: true });

    const content = fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf8");
    assert.ok(content.includes("# My Project"));
    assert.ok(content.includes("User instructions here."));
    assert.ok(!content.includes("# tobari"));
  });

  it("removes prepare script from package.json", async () => {
    delete require.cache[require.resolve("../bin/commands/uninstall")];
    const uninstall = require("../bin/commands/uninstall");
    await uninstall({ yes: true });

    const pkg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "package.json"), "utf8"),
    );
    assert.ok(!pkg.scripts || !pkg.scripts.prepare);
    assert.strictEqual(pkg.scripts.test, "node --test");
  });

  it("cleans .gitignore — removes tobari entries, preserves others", async () => {
    delete require.cache[require.resolve("../bin/commands/uninstall")];
    const uninstall = require("../bin/commands/uninstall");
    await uninstall({ yes: true });

    const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf8");
    assert.ok(content.includes("node_modules/"));
    assert.ok(!content.includes("tobari"));
    assert.ok(!content.includes(".claude/hooks/"));
  });

  it("removes runtime files", async () => {
    delete require.cache[require.resolve("../bin/commands/uninstall")];
    const uninstall = require("../bin/commands/uninstall");
    await uninstall({ yes: true });

    assert.ok(!fs.existsSync(path.join(tmpDir, ".tobari-version")));
    assert.ok(
      !fs.existsSync(path.join(tmpDir, ".claude", "tobari-session.json")),
    );
    assert.ok(!fs.existsSync(path.join(tmpDir, ".claude", "logs")));
  });

  it("preserves .claude/ directory if user files remain", async () => {
    delete require.cache[require.resolve("../bin/commands/uninstall")];
    const uninstall = require("../bin/commands/uninstall");
    await uninstall({ yes: true });

    // .claude/ should still exist because user-custom-skill is there
    assert.ok(fs.existsSync(path.join(tmpDir, ".claude")));
  });
});
