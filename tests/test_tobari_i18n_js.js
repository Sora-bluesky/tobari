#!/usr/bin/env node
"use strict";
/**
 * Tests for tobari-i18n.js — Internationalization module for tobari hooks.
 *
 * Covers:
 * - Constants (SUPPORTED_LANGS, DEFAULT_LANG)
 * - _detectLang (env var, session file, fallback)
 * - t() function (translation, interpolation, missing keys, edge cases)
 * - getLang() (default, env override, lazy loading)
 * - _reset() (cache clearing, language switching)
 * - Locale file validation (key parity, entry count, value types)
 * - Integration with hook key categories (gate, stage, stop, cost)
 * - Module exports completeness
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Set CLAUDE_PROJECT_DIR before requiring the module
const PROJECT_DIR = path.resolve(__dirname, "..");
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;

const i18n = require("../.claude/hooks/tobari-i18n.js");

// --- Helpers ---

/** Save and restore TOBARI_LANG env var around each test */
let savedLang;

// =========================================================================
// 1. Constants
// =========================================================================

describe("tobari-i18n.js constants", () => {
  it("SUPPORTED_LANGS is ['en', 'ja']", () => {
    assert.deepEqual(i18n.SUPPORTED_LANGS, ["en", "ja"]);
  });

  it("DEFAULT_LANG is 'en'", () => {
    assert.equal(i18n.DEFAULT_LANG, "en");
  });

  it("SUPPORTED_LANGS is an array with exactly 2 elements", () => {
    assert.ok(Array.isArray(i18n.SUPPORTED_LANGS));
    assert.equal(i18n.SUPPORTED_LANGS.length, 2);
  });
});

// =========================================================================
// 2. _detectLang
// =========================================================================

describe("_detectLang — env var priority", () => {
  beforeEach(() => {
    savedLang = process.env.TOBARI_LANG;
    i18n._reset();
  });

  afterEach(() => {
    if (savedLang === undefined) {
      delete process.env.TOBARI_LANG;
    } else {
      process.env.TOBARI_LANG = savedLang;
    }
    i18n._reset();
  });

  it("returns 'ja' when TOBARI_LANG=ja", () => {
    process.env.TOBARI_LANG = "ja";
    assert.equal(i18n._detectLang(), "ja");
  });

  it("returns 'en' when TOBARI_LANG=en", () => {
    process.env.TOBARI_LANG = "en";
    assert.equal(i18n._detectLang(), "en");
  });

  it("ignores unsupported TOBARI_LANG value (e.g., 'fr')", () => {
    process.env.TOBARI_LANG = "fr";
    // Should fall through to session or default
    const lang = i18n._detectLang();
    assert.ok(
      i18n.SUPPORTED_LANGS.includes(lang),
      `Expected supported lang, got '${lang}'`
    );
  });

  it("ignores empty TOBARI_LANG", () => {
    process.env.TOBARI_LANG = "";
    const lang = i18n._detectLang();
    assert.ok(
      i18n.SUPPORTED_LANGS.includes(lang),
      `Expected supported lang, got '${lang}'`
    );
  });
});

describe("_detectLang — session file fallback", () => {
  let tmpDir;
  const origProjectDir = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    savedLang = process.env.TOBARI_LANG;
    delete process.env.TOBARI_LANG;
    i18n._reset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tobari-i18n-"));
    const claudeDir = path.join(tmpDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
  });

  afterEach(() => {
    if (savedLang === undefined) {
      delete process.env.TOBARI_LANG;
    } else {
      process.env.TOBARI_LANG = savedLang;
    }
    process.env.CLAUDE_PROJECT_DIR = origProjectDir;
    i18n._reset();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  it("reads 'ja' from tobari-session.json lang field", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({ active: true, lang: "ja" }),
      "utf8"
    );
    assert.equal(i18n._detectLang(), "ja");
  });

  it("reads 'en' from tobari-session.json lang field", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({ active: true, lang: "en" }),
      "utf8"
    );
    assert.equal(i18n._detectLang(), "en");
  });

  it("ignores unsupported lang in session file", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({ active: true, lang: "de" }),
      "utf8"
    );
    assert.equal(i18n._detectLang(), "en"); // default
  });

  it("returns DEFAULT_LANG when session file has no lang field", () => {
    const sessionPath = path.join(tmpDir, ".claude", "tobari-session.json");
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({ active: true }),
      "utf8"
    );
    assert.equal(i18n._detectLang(), i18n.DEFAULT_LANG);
  });

  it("returns DEFAULT_LANG when no session file exists", () => {
    // tmpDir has .claude/ but no tobari-session.json
    assert.equal(i18n._detectLang(), i18n.DEFAULT_LANG);
  });
});

// =========================================================================
// 3. t() function
// =========================================================================

describe("t() — translation and interpolation", () => {
  beforeEach(() => {
    savedLang = process.env.TOBARI_LANG;
    i18n._reset();
  });

  afterEach(() => {
    if (savedLang === undefined) {
      delete process.env.TOBARI_LANG;
    } else {
      process.env.TOBARI_LANG = savedLang;
    }
    i18n._reset();
  });

  it("returns English translation for existing key", () => {
    process.env.TOBARI_LANG = "en";
    const result = i18n.t("gate.validate.empty_path");
    assert.equal(result, "File path is empty");
  });

  it("returns Japanese translation for existing key", () => {
    process.env.TOBARI_LANG = "ja";
    const result = i18n.t("gate.validate.empty_path");
    assert.ok(
      result.includes("\u30d5\u30a1\u30a4\u30eb\u30d1\u30b9"),
      `Expected Japanese text, got '${result}'`
    );
  });

  it("returns the key itself for non-existent key", () => {
    process.env.TOBARI_LANG = "en";
    const key = "this.key.does.not.exist.anywhere";
    assert.equal(i18n.t(key), key);
  });

  it("handles parameter interpolation with {actual} and {max}", () => {
    process.env.TOBARI_LANG = "en";
    const result = i18n.t("gate.validate.path_too_long", {
      actual: 5000,
      max: 4096,
    });
    assert.ok(result.includes("5000"), `Should contain '5000', got '${result}'`);
    assert.ok(result.includes("4096"), `Should contain '4096', got '${result}'`);
  });

  it("handles multiple parameters in a single key", () => {
    process.env.TOBARI_LANG = "en";
    const result = i18n.t("gate.scope_detail", {
      filePath: "/some/path",
      include: "src/",
      exclude: "dist/",
    });
    assert.ok(result.includes("/some/path"));
    assert.ok(result.includes("src/"));
    assert.ok(result.includes("dist/"));
  });

  it("handles missing parameters gracefully (leaves {param} unreplaced)", () => {
    process.env.TOBARI_LANG = "en";
    // gate.validate.path_too_long has {actual} and {max}
    const result = i18n.t("gate.validate.path_too_long");
    // Without params, {actual} and {max} remain
    assert.ok(
      result.includes("{actual}"),
      `Should contain unreplaced '{actual}', got '${result}'`
    );
    assert.ok(
      result.includes("{max}"),
      `Should contain unreplaced '{max}', got '${result}'`
    );
  });

  it("works with empty params object", () => {
    process.env.TOBARI_LANG = "en";
    const result = i18n.t("gate.validate.empty_path", {});
    assert.equal(result, "File path is empty");
  });

  it("handles numeric parameter values", () => {
    process.env.TOBARI_LANG = "en";
    const result = i18n.t("gate.validate.content_too_large", {
      actual: 999,
      max: 500,
    });
    assert.ok(result.includes("999"));
    assert.ok(result.includes("500"));
  });

  it("replaces all occurrences of the same parameter", () => {
    // stop.circuit.header has {max} used twice: ({max}/{max} failures)
    process.env.TOBARI_LANG = "en";
    const result = i18n.t("stop.circuit.header", { task: "test", max: 3 });
    // Should contain "3/3"
    assert.ok(
      result.includes("3/3"),
      `Should contain '3/3', got '${result}'`
    );
  });
});

// =========================================================================
// 4. getLang()
// =========================================================================

describe("getLang()", () => {
  beforeEach(() => {
    savedLang = process.env.TOBARI_LANG;
    i18n._reset();
  });

  afterEach(() => {
    if (savedLang === undefined) {
      delete process.env.TOBARI_LANG;
    } else {
      process.env.TOBARI_LANG = savedLang;
    }
    i18n._reset();
  });

  it("returns 'en' by default", () => {
    delete process.env.TOBARI_LANG;
    assert.equal(i18n.getLang(), "en");
  });

  it("returns 'ja' when TOBARI_LANG=ja", () => {
    process.env.TOBARI_LANG = "ja";
    assert.equal(i18n.getLang(), "ja");
  });

  it("triggers message loading if not yet loaded", () => {
    process.env.TOBARI_LANG = "en";
    // After _reset(), getLang() should trigger _loadMessages()
    const lang = i18n.getLang();
    assert.equal(lang, "en");
    // Verify messages are loaded by calling t()
    const msg = i18n.t("gate.validate.empty_path");
    assert.equal(msg, "File path is empty");
  });
});

// =========================================================================
// 5. _reset()
// =========================================================================

describe("_reset()", () => {
  beforeEach(() => {
    savedLang = process.env.TOBARI_LANG;
  });

  afterEach(() => {
    if (savedLang === undefined) {
      delete process.env.TOBARI_LANG;
    } else {
      process.env.TOBARI_LANG = savedLang;
    }
    i18n._reset();
  });

  it("clears cached messages so language detection re-runs", () => {
    // Load English first
    process.env.TOBARI_LANG = "en";
    const enMsg = i18n.t("gate.validate.empty_path");
    assert.equal(enMsg, "File path is empty");

    // Reset and switch to Japanese
    i18n._reset();
    process.env.TOBARI_LANG = "ja";
    const jaMsg = i18n.t("gate.validate.empty_path");
    assert.notEqual(jaMsg, enMsg, "Should return different text after reset + lang change");
    assert.ok(jaMsg.includes("\u30d5\u30a1\u30a4\u30eb\u30d1\u30b9"));
  });

  it("after _reset(), changing TOBARI_LANG and calling t() uses new language", () => {
    process.env.TOBARI_LANG = "ja";
    i18n.t("gate.deny.recovery_header"); // load Japanese
    assert.equal(i18n.getLang(), "ja");

    i18n._reset();
    process.env.TOBARI_LANG = "en";
    const result = i18n.t("gate.deny.recovery_header");
    assert.equal(result, "Recovery:");
    assert.equal(i18n.getLang(), "en");
  });

  it("without _reset(), changing TOBARI_LANG does NOT affect cached messages", () => {
    process.env.TOBARI_LANG = "en";
    i18n._reset();
    const enMsg = i18n.t("gate.validate.empty_path");
    assert.equal(enMsg, "File path is empty");

    // Change env WITHOUT reset — cached messages should persist
    process.env.TOBARI_LANG = "ja";
    const stillEn = i18n.t("gate.validate.empty_path");
    assert.equal(stillEn, "File path is empty", "Cached English should persist without _reset()");

    i18n._reset(); // cleanup
  });
});

// =========================================================================
// 6. Locale files validation
// =========================================================================

describe("locale file validation", () => {
  let enMessages;
  let jaMessages;

  beforeEach(() => {
    const localeDir = path.join(__dirname, "..", ".claude", "hooks", "locales");
    enMessages = JSON.parse(fs.readFileSync(path.join(localeDir, "en.json"), "utf8"));
    jaMessages = JSON.parse(fs.readFileSync(path.join(localeDir, "ja.json"), "utf8"));
  });

  it("en.json and ja.json have the same keys", () => {
    const enKeys = Object.keys(enMessages).sort();
    const jaKeys = Object.keys(jaMessages).sort();
    assert.deepEqual(enKeys, jaKeys, "Key sets should be identical");
  });

  it("en.json has 160+ entries", () => {
    const count = Object.keys(enMessages).length;
    assert.ok(count >= 160, `Expected >= 160 keys in en.json, got ${count}`);
  });

  it("ja.json has 160+ entries", () => {
    const count = Object.keys(jaMessages).length;
    assert.ok(count >= 160, `Expected >= 160 keys in ja.json, got ${count}`);
  });

  it("all en.json values are non-empty strings", () => {
    for (const [key, value] of Object.entries(enMessages)) {
      assert.equal(typeof value, "string", `en.json[${key}] should be a string`);
      assert.ok(value.length > 0, `en.json[${key}] should not be empty`);
    }
  });

  it("all ja.json values are non-empty strings", () => {
    for (const [key, value] of Object.entries(jaMessages)) {
      assert.equal(typeof value, "string", `ja.json[${key}] should be a string`);
      assert.ok(value.length > 0, `ja.json[${key}] should not be empty`);
    }
  });

  it("no keys in en.json are missing from ja.json", () => {
    const enKeys = Object.keys(enMessages);
    const jaKeys = new Set(Object.keys(jaMessages));
    const missing = enKeys.filter((k) => !jaKeys.has(k));
    assert.deepEqual(missing, [], `Keys in en.json but missing from ja.json: ${missing.join(", ")}`);
  });

  it("no keys in ja.json are missing from en.json", () => {
    const jaKeys = Object.keys(jaMessages);
    const enKeys = new Set(Object.keys(enMessages));
    const missing = jaKeys.filter((k) => !enKeys.has(k));
    assert.deepEqual(missing, [], `Keys in ja.json but missing from en.json: ${missing.join(", ")}`);
  });
});

// =========================================================================
// 7. Integration with hook key categories
// =========================================================================

describe("integration — gate pattern keys", () => {
  beforeEach(() => {
    savedLang = process.env.TOBARI_LANG;
    i18n._reset();
    process.env.TOBARI_LANG = "en";
  });

  afterEach(() => {
    if (savedLang === undefined) {
      delete process.env.TOBARI_LANG;
    } else {
      process.env.TOBARI_LANG = savedLang;
    }
    i18n._reset();
  });

  it("gate.pattern.* keys exist and return non-empty strings", () => {
    const patternKeys = [
      "gate.pattern.rm_rf",
      "gate.pattern.git_push_force",
      "gate.pattern.git_reset_hard",
      "gate.pattern.drop_table",
      "gate.pattern.shutdown",
    ];
    for (const key of patternKeys) {
      const result = i18n.t(key);
      assert.notEqual(result, key, `${key} should be translated, not returned as-is`);
      assert.ok(result.length > 0, `${key} should return non-empty string`);
    }
  });
});

describe("integration — stage fail keys", () => {
  beforeEach(() => {
    savedLang = process.env.TOBARI_LANG;
    i18n._reset();
    process.env.TOBARI_LANG = "en";
  });

  afterEach(() => {
    if (savedLang === undefined) {
      delete process.env.TOBARI_LANG;
    } else {
      process.env.TOBARI_LANG = savedLang;
    }
    i18n._reset();
  });

  it("stage.stg*_fail keys exist and return non-empty strings", () => {
    for (let i = 0; i <= 6; i++) {
      const key = `stage.stg${i}_fail`;
      const result = i18n.t(key, { conditions: "test" });
      assert.notEqual(result, key, `${key} should be translated`);
      assert.ok(result.length > 0, `${key} should return non-empty string`);
    }
  });
});

describe("integration — stop repair keys", () => {
  beforeEach(() => {
    savedLang = process.env.TOBARI_LANG;
    i18n._reset();
    process.env.TOBARI_LANG = "en";
  });

  afterEach(() => {
    if (savedLang === undefined) {
      delete process.env.TOBARI_LANG;
    } else {
      process.env.TOBARI_LANG = savedLang;
    }
    i18n._reset();
  });

  it("stop.repair.* keys exist and return non-empty strings", () => {
    const repairKeys = [
      "stop.repair.header",
      "stop.repair.errors",
      "stop.repair.instruction",
      "stop.repair.step1",
      "stop.repair.step2",
      "stop.repair.step3",
    ];
    for (const key of repairKeys) {
      const result = i18n.t(key, { task: "T1", attempt: 1, max: 3, summary: "err" });
      assert.notEqual(result, key, `${key} should be translated`);
      assert.ok(result.length > 0, `${key} should return non-empty string`);
    }
  });
});

describe("integration — cost budget keys", () => {
  beforeEach(() => {
    savedLang = process.env.TOBARI_LANG;
    i18n._reset();
    process.env.TOBARI_LANG = "en";
  });

  afterEach(() => {
    if (savedLang === undefined) {
      delete process.env.TOBARI_LANG;
    } else {
      process.env.TOBARI_LANG = savedLang;
    }
    i18n._reset();
  });

  it("cost.budget_* keys exist and return non-empty strings", () => {
    const costKeys = [
      "cost.budget_exceeded",
      "cost.budget_exceeded_detail",
      "cost.budget_exceeded_action",
      "cost.budget_warning",
      "cost.budget_warning_detail",
      "cost.budget_warning_action",
    ];
    for (const key of costKeys) {
      const result = i18n.t(key, {
        pct: 95,
        total: 800,
        budget: 1000,
        remaining: 200,
      });
      assert.notEqual(result, key, `${key} should be translated`);
      assert.ok(result.length > 0, `${key} should return non-empty string`);
    }
  });
});

// =========================================================================
// 8. _loadMessages
// =========================================================================

describe("_loadMessages()", () => {
  beforeEach(() => {
    savedLang = process.env.TOBARI_LANG;
    i18n._reset();
  });

  afterEach(() => {
    if (savedLang === undefined) {
      delete process.env.TOBARI_LANG;
    } else {
      process.env.TOBARI_LANG = savedLang;
    }
    i18n._reset();
  });

  it("returns an object with message keys", () => {
    process.env.TOBARI_LANG = "en";
    const messages = i18n._loadMessages();
    assert.equal(typeof messages, "object");
    assert.ok(Object.keys(messages).length > 0);
  });

  it("returns cached messages on second call (same reference)", () => {
    process.env.TOBARI_LANG = "en";
    const first = i18n._loadMessages();
    const second = i18n._loadMessages();
    assert.equal(first, second, "Should return same cached object");
  });
});

// =========================================================================
// 9. Module exports completeness
// =========================================================================

describe("module exports completeness", () => {
  it("exports all expected functions", () => {
    const expectedFunctions = [
      "t",
      "getLang",
      "_detectLang",
      "_loadMessages",
      "_reset",
    ];
    for (const fn of expectedFunctions) {
      assert.equal(typeof i18n[fn], "function", `Missing function export: ${fn}`);
    }
  });

  it("exports all expected constants", () => {
    assert.ok(Array.isArray(i18n.SUPPORTED_LANGS), "SUPPORTED_LANGS should be an array");
    assert.equal(typeof i18n.DEFAULT_LANG, "string", "DEFAULT_LANG should be a string");
  });

  it("exports exactly the expected set of keys", () => {
    const expectedKeys = [
      "SUPPORTED_LANGS",
      "DEFAULT_LANG",
      "t",
      "getLang",
      "_detectLang",
      "_loadMessages",
      "_reset",
    ].sort();
    const actualKeys = Object.keys(i18n).sort();
    assert.deepEqual(actualKeys, expectedKeys);
  });
});
