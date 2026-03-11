"use strict";
/**
 * tobari-i18n — Internationalization module for tobari hooks.
 *
 * Provides t(key, params) function that resolves message keys
 * from locale JSON files (locales/en.json, locales/ja.json).
 *
 * Language detection priority:
 *   1. TOBARI_LANG environment variable
 *   2. "lang" field in tobari-session.json
 *   3. Default: "en"
 *
 * Zero npm dependencies. CommonJS.
 */

const path = require("node:path");
const fs = require("node:fs");

// Supported languages
const SUPPORTED_LANGS = ["en", "ja"];
const DEFAULT_LANG = "en";

// Cached messages (lazy-loaded on first t() call)
let _messages = null;
let _resolvedLang = null;

/**
 * Detect language from environment or session config.
 * @returns {string} "en" or "ja"
 */
function _detectLang() {
  // 1. Environment variable (highest priority)
  const envLang = process.env.TOBARI_LANG;
  if (envLang && SUPPORTED_LANGS.includes(envLang)) {
    return envLang;
  }

  // 2. tobari-session.json "lang" field
  try {
    const sessionPath = path.resolve(
      process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, "..", ".."),
      ".claude",
      "tobari-session.json"
    );
    if (fs.existsSync(sessionPath)) {
      const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
      if (session.lang && SUPPORTED_LANGS.includes(session.lang)) {
        return session.lang;
      }
    }
  } catch (_) {
    // Ignore read errors
  }

  // 3. Default
  return DEFAULT_LANG;
}

/**
 * Load messages for the detected language.
 * Falls back to English if the locale file is missing.
 * @returns {Object} Flat key-value message map.
 */
function _loadMessages() {
  if (_messages) return _messages;

  _resolvedLang = _detectLang();
  const localeDir = path.join(__dirname, "locales");

  try {
    _messages = require(path.join(localeDir, `${_resolvedLang}.json`));
  } catch (_) {
    // Fallback to English
    try {
      _messages = require(path.join(localeDir, "en.json"));
      _resolvedLang = "en";
    } catch (__) {
      _messages = {};
      _resolvedLang = "en";
    }
  }
  return _messages;
}

/**
 * Translate a message key with optional parameter interpolation.
 *
 * @param {string} key - Dot-separated message key (e.g., "gate.deny.header").
 * @param {Object} [params={}] - Interpolation parameters. {name} in the message
 *   will be replaced with params.name.
 * @returns {string} Translated message, or the key itself if not found.
 *
 * @example
 *   t("gate.deny.header", { reason: t("gate.destructive_detected") })
 *   // en: "Tobari blocked — Destructive command detected"
 *   // ja: "帳が止めました — 破壊的コマンドを検出"
 */
function t(key, params) {
  const messages = _loadMessages();
  let msg = messages[key];

  if (msg === undefined || msg === null) {
    return key; // Fallback: return the key itself
  }

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replace(new RegExp(`\{${k}\}`, "g"), String(v));
    }
  }

  return msg;
}

/**
 * Get the currently resolved language.
 * @returns {string} "en" or "ja"
 */
function getLang() {
  _loadMessages(); // Ensure detection has run
  return _resolvedLang;
}

/**
 * Reset cached messages (for testing).
 */
function _reset() {
  _messages = null;
  _resolvedLang = null;
}

module.exports = {
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  t,
  getLang,
  _detectLang,
  _loadMessages,
  _reset,
};
