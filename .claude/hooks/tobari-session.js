#!/usr/bin/env node
"use strict";
/**
 * Shared module for reading and updating tobari-session.json.
 * Node.js port of tobari_session.py (v1.1.0 migration).
 *
 * All hooks require() this module to determine whether the veil is active
 * and to read contract/scope/profile information.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_FILENAME = "tobari-session.json";
const BOUNDARY_FILENAME = "boundary-classification.yaml";
const EVIDENCE_LEDGER_FILENAME = "evidence-ledger.jsonl";
const EVIDENCE_LOG_DIR = "logs";
const HMAC_KEY_FILENAME = "tobari-hmac-key";
const HMAC_KEY_ENV_VAR = "TOBARI_HMAC_KEY";
const CHAIN_GENESIS_HASH = "0".repeat(64); // SHA256 zero-fill for first entry

// Evidence rotation constants (A5)
const EVIDENCE_MAX_SIZE = 10 * 1024 * 1024; // 10 MB

// File locking constants
const LOCK_TIMEOUT = 5000; // milliseconds
const LOCK_RETRY_INTERVAL = 50; // milliseconds

// ---------------------------------------------------------------------------
// Cache (per-process, reset on each hook invocation)
// ---------------------------------------------------------------------------

let _sessionCache = null;
let _sessionCacheMtime = 0;
let _boundaryCache = null;

// ---------------------------------------------------------------------------
// Optional js-yaml (graceful fallback)
// ---------------------------------------------------------------------------

let yaml = null;
try {
  yaml = require("js-yaml");
} catch (_) {
  // js-yaml not installed — YAML parsing will be unavailable
}

// ---------------------------------------------------------------------------
// File Locking — O_EXCL approach with stale detection
// ---------------------------------------------------------------------------

/**
 * Cross-platform advisory file lock using a .lock sidecar file.
 *
 * Uses O_EXCL for atomic creation. Stale detection removes lock files
 * older than timeout * 2. Synchronous busy-wait is acceptable since
 * each hook is a short-lived process.
 *
 * @param {string} filePath - Path to the file being protected.
 * @param {Function} fn - Critical section function to execute.
 * @param {number} [timeout=LOCK_TIMEOUT] - Lock timeout in milliseconds.
 * @returns {*} Return value of fn().
 */
function withFileLock(filePath, fn, timeout) {
  if (timeout === undefined || timeout === null) {
    timeout = LOCK_TIMEOUT;
  }

  const lockFile = filePath + ".lock";
  const start = Date.now();
  let fd = null;

  try {
    // Acquire lock
    while (true) {
      try {
        fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        // Lock acquired — write PID for diagnostics
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        fd = null; // We closed it; the file's existence IS the lock
        break;
      } catch (err) {
        if (err.code === "EEXIST") {
          // Lock file exists — check for staleness
          try {
            const stat = fs.statSync(lockFile);
            const age = Date.now() - stat.mtimeMs;
            if (age > timeout * 2) {
              // Stale lock — remove and retry
              try {
                fs.unlinkSync(lockFile);
              } catch (_) {
                // Another process may have removed it
              }
              continue;
            }
          } catch (_) {
            // Lock file disappeared between EEXIST and stat — retry
            continue;
          }

          // Not stale — wait and retry
          const elapsed = Date.now() - start;
          if (elapsed >= timeout) {
            throw new Error(`File lock timeout (${timeout}ms): ${lockFile}`);
          }
          // Busy-wait spin for LOCK_RETRY_INTERVAL ms
          const spinEnd = Date.now() + LOCK_RETRY_INTERVAL;
          while (Date.now() < spinEnd) {
            // spin
          }
          continue;
        }
        throw err; // Unexpected error
      }
    }

    // Critical section
    return fn();
  } finally {
    // Release lock
    try {
      fs.unlinkSync(lockFile);
    } catch (_) {
      // Lock file already removed (shouldn't happen, but be safe)
    }
  }
}

/**
 * Named lock — acquire a logical lock by name, not by file path.
 *
 * Useful when the lock scope is a logical operation (e.g., "evidence",
 * "session") rather than a specific file. Lock files are stored in
 * .claude/logs/ to keep them alongside other operational artifacts.
 *
 * Delegates to withFileLock internally, so all O_EXCL / stale detection
 * behavior is inherited.
 *
 * @param {string} name - Logical lock name (e.g., "evidence", "session").
 * @param {Function} fn - Critical section function to execute.
 * @param {number} [timeout=LOCK_TIMEOUT] - Lock timeout in milliseconds.
 * @returns {*} Return value of fn().
 */
function withNamedLock(name, fn, timeout) {
  // Sanitize name for filesystem safety
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");

  // Determine lock directory: .claude/logs/ under project root
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  let lockDir;
  if (projectDir) {
    lockDir = path.join(projectDir, ".claude", EVIDENCE_LOG_DIR);
  } else {
    lockDir = path.join(__dirname, "..", EVIDENCE_LOG_DIR);
  }

  // Ensure lock directory exists
  try {
    fs.mkdirSync(lockDir, { recursive: true });
  } catch (_) {
    // Directory may already exist
  }

  const lockFilePath = path.join(lockDir, `tobari-${safeName}`);
  return withFileLock(lockFilePath, fn, timeout);
}

/**
 * Read session JSON, apply modifier function, write back under lock.
 *
 * @param {Function} modifier - A function that receives the session dict and mutates it.
 * @returns {boolean} True on success, false on error.
 */
function readModifyWriteSession(modifier) {
  const sessionPath = getSessionPath();

  if (!fs.existsSync(sessionPath)) {
    return false;
  }

  try {
    return withFileLock(sessionPath, () => {
      const raw = fs.readFileSync(sessionPath, "utf8");
      const data = JSON.parse(raw);

      if (typeof data !== "object" || data === null || !data.active) {
        return false;
      }

      modifier(data);

      fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2) + "\n", "utf8");

      // Invalidate cache (outside lock is fine since we're still in the same call)
      _sessionCache = null;
      _sessionCacheMtime = 0;
      return true;
    });
  } catch (e) {
    process.stderr.write(`Session file operation failed: ${e.message}\n`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------

/**
 * Resolve the path to tobari-session.json.
 * @returns {string} Absolute path to session file.
 */
function getSessionPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  if (projectDir) {
    return path.join(projectDir, ".claude", SESSION_FILENAME);
  }
  // Fallback: session file is at {project}/.claude/tobari-session.json
  // This module lives at {project}/.claude/hooks/tobari-session.js
  const hooksDir = path.resolve(__dirname);
  return path.join(hooksDir, "..", SESSION_FILENAME);
}

/**
 * Load and cache tobari-session.json.
 *
 * @returns {Object|null} Session dict if the veil is active (file exists and active=true).
 *   null if the file does not exist, active=false, or on any error.
 */
function loadSession() {
  const sessionPath = getSessionPath();

  if (!fs.existsSync(sessionPath)) {
    _sessionCache = null;
    return null;
  }

  try {
    const stat = fs.statSync(sessionPath);
    const mtime = stat.mtimeMs;

    if (_sessionCache !== null && mtime === _sessionCacheMtime) {
      return _sessionCache;
    }

    const raw = fs.readFileSync(sessionPath, "utf8");
    const data = JSON.parse(raw);

    if (typeof data !== "object" || data === null || !data.active) {
      _sessionCache = null;
      return null;
    }

    _sessionCache = data;
    _sessionCacheMtime = mtime;
    return data;
  } catch (e) {
    // File exists but is corrupted — log warning to stderr and evidence.
    // Returns null (veil treated as inactive) but records the anomaly.
    process.stderr.write(
      `[tobari] WARNING: Session file exists but is corrupted: ${e.message}\n`
    );
    writeEvidence({
      event: "session_load_error",
      error: e.message,
      path: sessionPath,
    });
    _sessionCache = null;
    return null;
  }
}

/**
 * Check if the veil is currently active.
 * @returns {boolean}
 */
function isVeilActive() {
  return loadSession() !== null;
}

/**
 * Get the operating profile (lite/standard/strict).
 * @returns {string|null}
 */
function getProfile() {
  const session = loadSession();
  return session ? (session.profile || null) : null;
}

/**
 * Get agent policy for the given agent type.
 *
 * Agent policies are defined in tobari-session.json under "agent_policies".
 * If no policy is defined for the agent type, the "default" policy is used.
 * If no "default" policy exists, returns a permissive policy (all tools allowed).
 *
 * @param {string} agentType - The agent type (e.g., "Explore", "Plan")
 * @returns {{ allowed_tools: string[], denied_tools: string[], scope_override: Object|null }}
 */
function getAgentPolicy(agentType) {
  const session = loadSession();
  if (!session) return { allowed_tools: ["*"], denied_tools: [], scope_override: null };

  const policies = session.agent_policies || {};
  const policy = policies[agentType] || policies["default"] || null;
  if (!policy) return { allowed_tools: ["*"], denied_tools: [], scope_override: null };

  return {
    allowed_tools: policy.allowed_tools || ["*"],
    denied_tools: policy.denied_tools || [],
    scope_override: policy.scope_override || null,
  };
}

/**
 * Check if a tool is allowed by the agent policy.
 *
 * @param {string} agentType - The agent type
 * @param {string} toolName - The tool name to check
 * @returns {{ allowed: boolean, reason: string }}
 */
function checkAgentToolPermission(agentType, toolName) {
  const policy = getAgentPolicy(agentType);

  // denied_tools takes precedence over allowed_tools
  if (policy.denied_tools.length > 0 && policy.denied_tools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Agent type "${agentType}" is denied tool "${toolName}" by policy`,
    };
  }

  // Check allowed_tools (["*"] means all allowed)
  if (policy.allowed_tools.includes("*")) {
    return { allowed: true, reason: "all tools allowed" };
  }

  if (!policy.allowed_tools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Agent type "${agentType}" is not allowed tool "${toolName}" by policy`,
    };
  }

  return { allowed: true, reason: "tool in allowed list" };
}

/**
 * Get the contract scope (include/exclude paths).
 * @returns {Object|null}
 */
function getScope() {
  const session = loadSession();
  if (!session) return null;
  const contract = session.contract || {};
  return contract.scope || null;
}

/**
 * Get the full contract.
 * @returns {Object|null}
 */
function getContract() {
  const session = loadSession();
  if (!session) return null;
  return session.contract || null;
}

/**
 * Get the current task name.
 * @returns {string|null}
 */
function getTask() {
  const session = loadSession();
  return session ? (session.task || null) : null;
}

/**
 * Get the list of passed STG gates.
 * @returns {string[]}
 */
function getGatesPassed() {
  const session = loadSession();
  if (!session) return [];
  return session.gates_passed || [];
}

/**
 * Add a gate to gates_passed in tobari-session.json.
 *
 * @param {string} newGate - Gate name (e.g., "STG1").
 * @returns {boolean} True if successfully updated, false on error.
 */
function updateGatesPassed(newGate) {
  return readModifyWriteSession((data) => {
    const gates = data.gates_passed || [];
    if (!gates.includes(newGate)) {
      gates.push(newGate);
      data.gates_passed = gates;
    }
  });
}

// ---------------------------------------------------------------------------
// Path / Scope Utilities
// ---------------------------------------------------------------------------

/**
 * Check if prefix is a directory-boundary-aware prefix of path.
 *
 * Returns true if:
 * - path === prefix (exact match)
 * - path starts with prefix + "/" (prefix is a parent directory)
 * - prefix ends with "/" (already a directory indicator)
 *
 * This prevents 'home/user' from matching 'home/username/file.txt'.
 *
 * @param {string} p - The path to check.
 * @param {string} prefix - The prefix to match.
 * @returns {boolean}
 */
function isDirPrefix(p, prefix) {
  if (p === prefix) return true;
  if (prefix.endsWith("/")) return p.startsWith(prefix);
  return p.startsWith(prefix + "/");
}

/**
 * Normalize a file path to a canonical key for consistent comparison.
 *
 * Returns an absolute, normalized path with:
 * - Resolved via path.resolve (relative paths resolved against CLAUDE_PROJECT_DIR)
 * - Symlinks resolved via fs.realpathSync (if file exists)
 * - Backslashes replaced with forward slashes
 * - Trailing slashes removed
 * - Windows: lowercased for case-insensitive comparison
 *
 * @param {string} filePath - Path to normalize.
 * @returns {string} Canonical absolute path key.
 */
function canonicalPathKey(filePath) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  const isWin = process.platform === "win32";

  // Resolve projectDir symlinks once for consistent path comparison
  // (macOS: /var/folders → /private/var/folders)
  let resolvedBase = projectDir || process.cwd();
  try { resolvedBase = fs.realpathSync(resolvedBase); } catch (_) {}

  // Resolve to absolute path
  let result;
  if (path.isAbsolute(filePath)) {
    result = path.resolve(filePath);
  } else {
    result = path.resolve(resolvedBase, filePath);
  }

  // Resolve symlinks if the file exists
  try {
    result = fs.realpathSync(result);
  } catch (_) {
    // File may not exist yet — replace unresolved projectDir prefix
    // with resolved version for consistent comparison
    if (projectDir && resolvedBase !== projectDir) {
      const normDir = projectDir.replace(/\\/g, "/").replace(/\/+$/, "");
      const normResolved = resolvedBase.replace(/\\/g, "/").replace(/\/+$/, "");
      const normResult = result.replace(/\\/g, "/");
      if (normResult.startsWith(normDir + "/")) {
        result = normResolved + normResult.slice(normDir.length);
      }
    }
  }

  // Forward slashes, no trailing slash
  result = result.replace(/\\/g, "/").replace(/\/+$/, "");

  // Windows: lowercase for case-insensitive comparison
  if (isWin) {
    result = result.toLowerCase();
  }

  return result;
}

/**
 * Check if a file path is within the contract scope.
 *
 * @param {string} filePath - Path to check.
 * @returns {boolean|null} true if in scope, false if out of scope,
 *   null if no session or scope is not defined (= no restriction).
 */
// Infrastructure files that are always writable when the veil is active.
// These are part of tobari's operating system, not task deliverables.
const INFRA_WHITELIST = [
  "handoff.md",
  "tasks/todo.md",
];

function isPathInScope(filePath) {
  const scope = getScope();
  if (!scope) return null;

  const includes = scope.include || [];
  const excludes = scope.exclude || [];

  // No scope constraints defined
  if (includes.length === 0 && excludes.length === 0) return null;

  // Canonical absolute key for the file
  const fileKey = canonicalPathKey(filePath);

  // Project root key for stripping prefix
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  const rootKey = projectDir ? canonicalPathKey(projectDir) : "";

  // Convert to relative for scope pattern comparison
  let relFileKey = fileKey;
  if (rootKey && fileKey.startsWith(rootKey + "/")) {
    relFileKey = fileKey.slice(rootKey.length + 1);
  }

  // Infrastructure whitelist: always allow regardless of scope
  const lowerRel = relFileKey.toLowerCase();
  for (const infra of INFRA_WHITELIST) {
    if (lowerRel === infra || lowerRel.endsWith("/" + infra)) {
      return true;
    }
  }

  const isWin = process.platform === "win32";

  // Lightweight normalization for scope patterns (already relative)
  const normPattern = (p) => {
    let n = p.replace(/\\/g, "/").replace(/\/+$/, "");
    if (n.startsWith("./")) n = n.slice(2);
    if (isWin) n = n.toLowerCase();
    return n;
  };

  // Check excludes first (deny takes precedence)
  for (const pattern of excludes) {
    if (isDirPrefix(relFileKey, normPattern(pattern))) {
      return false;
    }
  }

  // Check includes
  if (includes.length > 0) {
    for (const pattern of includes) {
      if (isDirPrefix(relFileKey, normPattern(pattern))) {
        return true;
      }
    }
    // Path not in any include pattern = out of scope
    return false;
  }

  // Only excludes defined, path not excluded = in scope
  return true;
}

// ---------------------------------------------------------------------------
// Boundary Classification
// ---------------------------------------------------------------------------

/**
 * Resolve the path to boundary-classification.yaml.
 * @returns {string}
 */
function getBoundaryPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  if (projectDir) {
    return path.join(projectDir, "integration", BOUNDARY_FILENAME);
  }
  // Fallback: {project}/integration/boundary-classification.yaml
  const hooksDir = path.resolve(__dirname);
  return path.join(hooksDir, "..", "..", "integration", BOUNDARY_FILENAME);
}

/**
 * Load and cache boundary-classification.yaml.
 *
 * Requires js-yaml; gracefully returns null if not installed.
 * @returns {Object|null}
 */
function loadBoundaryClassification() {
  if (_boundaryCache !== null) return _boundaryCache;

  const boundaryPath = getBoundaryPath();

  if (!fs.existsSync(boundaryPath)) return null;

  if (!yaml) {
    // js-yaml not installed: skip boundary check (fail-open)
    return null;
  }

  try {
    const raw = fs.readFileSync(boundaryPath, "utf8");
    const data = yaml.load(raw);
    _boundaryCache = data;
    return data;
  } catch (e) {
    // File exists but is corrupted — log warning and evidence
    process.stderr.write(
      `[tobari] WARNING: Boundary file exists but is corrupted: ${e.message}\n`
    );
    writeEvidence({
      event: "boundary_load_error",
      error: e.message,
      path: boundaryPath,
    });
    return null;
  }
}

/**
 * Get the boundary classification for a file path.
 *
 * Resolution order (from boundary-classification.yaml):
 * 1. File-level match (exact path)
 * 2. Longest directory prefix match
 * 3. null (unclassified)
 *
 * @param {string} filePath
 * @returns {string|null} "private_only" | "sync_eligible" | "conditional" | null
 */
function getBoundaryClassification(filePath) {
  const data = loadBoundaryClassification();
  if (!data) return null;

  const isWin = process.platform === "win32";

  // Canonical file key, converted to relative
  const fileKey = canonicalPathKey(filePath);
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  const rootKey = projectDir ? canonicalPathKey(projectDir) : "";

  let relFileKey = fileKey;
  if (rootKey && fileKey.startsWith(rootKey + "/")) {
    relFileKey = fileKey.slice(rootKey.length + 1);
  }

  // Normalize a YAML entry path
  const normEntry = (p) => {
    let n = (p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (n.startsWith("./")) n = n.slice(2);
    if (isWin) n = n.toLowerCase();
    return n;
  };

  // 1. Check file-level overrides (exact match)
  const files = data.files || [];
  for (const entry of files) {
    const entryKey = normEntry(entry.path);
    if (relFileKey === entryKey || relFileKey.endsWith("/" + entryKey)) {
      return entry.classification || null;
    }
  }

  // 2. Check directory-level (longest prefix match)
  const directories = data.directories || [];
  let bestMatch = null;
  let bestLength = 0;

  for (const entry of directories) {
    const dirKey = normEntry(entry.path);
    if (isDirPrefix(relFileKey, dirKey)) {
      if (dirKey.length > bestLength) {
        bestMatch = entry.classification || null;
        bestLength = dirKey.length;
      }
    }
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// Evidence Ledger
// ---------------------------------------------------------------------------

/**
 * Resolve the path to .claude/logs/ directory.
 * @returns {string}
 */
function getEvidenceDir() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  if (projectDir) {
    return path.join(projectDir, ".claude", EVIDENCE_LOG_DIR);
  }
  const hooksDir = path.resolve(__dirname);
  return path.join(hooksDir, "..", EVIDENCE_LOG_DIR);
}

/**
 * Resolve the path to .claude/logs/evidence-ledger.jsonl.
 * @returns {string}
 */
function getEvidencePath() {
  return path.join(getEvidenceDir(), EVIDENCE_LEDGER_FILENAME);
}

/**
 * Load HMAC key from environment or key file.
 *
 * Priority:
 * 1. TOBARI_HMAC_KEY environment variable (hex-encoded)
 * 2. .claude/tobari-hmac-key file
 * 3. Auto-generate and save to key file
 *
 * @returns {Buffer|null} Key bytes, or null if generation fails (chain-only mode).
 */
function getHmacKey() {
  // 1. Environment variable
  const envKey = (process.env[HMAC_KEY_ENV_VAR] || "").trim();
  if (envKey) {
    try {
      return Buffer.from(envKey, "hex");
    } catch (_) {
      return Buffer.from(envKey, "utf8");
    }
  }

  // 2. Key file
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  let keyPath;
  if (projectDir) {
    keyPath = path.join(projectDir, ".claude", HMAC_KEY_FILENAME);
  } else {
    keyPath = path.join(path.resolve(__dirname), HMAC_KEY_FILENAME);
  }

  if (fs.existsSync(keyPath)) {
    try {
      const keyHex = fs.readFileSync(keyPath, "utf8").trim();
      return Buffer.from(keyHex, "hex");
    } catch (_) {
      // Fall through to auto-generate
    }
  }

  // 3. Auto-generate
  try {
    const newKey = crypto.randomBytes(32);
    const keyDir = path.dirname(keyPath);
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(keyPath, newKey.toString("hex"), "utf8");
    return newKey;
  } catch (_) {
    return null;
  }
}

/**
 * Read the last entry from evidence ledger to get chain state.
 *
 * @param {string} evidencePath - Path to the evidence ledger JSONL file.
 * @returns {[number, string]} [lastIndex, lastHash].
 *   If ledger is empty or unreadable, returns [-1, CHAIN_GENESIS_HASH].
 */
function getLastChainState(evidencePath) {
  if (!fs.existsSync(evidencePath)) {
    return [-1, CHAIN_GENESIS_HASH];
  }

  let lastLine = "";
  try {
    const content = fs.readFileSync(evidencePath, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      const stripped = line.trim();
      if (stripped) {
        lastLine = stripped;
      }
    }
  } catch (_) {
    return [-1, CHAIN_GENESIS_HASH];
  }

  if (!lastLine) {
    return [-1, CHAIN_GENESIS_HASH];
  }

  try {
    const entry = JSON.parse(lastLine);
    const idx = entry._chain_index !== undefined ? entry._chain_index : -1;
    const entryHash = crypto.createHash("sha256").update(lastLine, "utf8").digest("hex");
    return [idx, entryHash];
  } catch (_) {
    return [-1, CHAIN_GENESIS_HASH];
  }
}

/**
 * Recursively sort object keys for canonical JSON output.
 * @param {*} obj
 * @returns {*}
 */
function sortKeys(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  return Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      acc[key] = sortKeys(obj[key]);
      return acc;
    }, {});
}

/**
 * Produce canonical JSON (sorted keys, no extra whitespace).
 * @param {Object} entry
 * @returns {string}
 */
function canonicalJson(entry) {
  return JSON.stringify(sortKeys(entry));
}

/**
 * Append an evidence entry to the JSONL ledger with hash chain + optional HMAC.
 *
 * Adds timestamp if not present. Creates directory if needed.
 * Each entry gets _chain_index, _prev_hash, and optionally _hmac fields.
 * Designed to be called from multiple hooks (gate, stage, evidence).
 * Uses file lock to prevent interleaved writes from concurrent hooks.
 *
 * @param {Object} entry - Evidence entry to append.
 * @returns {boolean} True on success, false on error (fail-open: never blocks).
 */
function writeEvidence(entry) {
  try {
    if (!entry.timestamp) {
      entry.timestamp = new Date().toISOString();
    }

    const evidencePath = getEvidencePath();
    const evidenceDir = path.dirname(evidencePath);
    fs.mkdirSync(evidenceDir, { recursive: true });

    withFileLock(evidencePath, () => {
      // A5: Rotate evidence file if it exceeds size limit
      try {
        const stat = fs.statSync(evidencePath);
        if (stat.size >= EVIDENCE_MAX_SIZE) {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const rotatedName = evidencePath.replace(
            /\.jsonl$/,
            `.${ts}.jsonl`,
          );
          fs.renameSync(evidencePath, rotatedName);
        }
      } catch (_) {
        // File may not exist yet — that's fine
      }

      // Read chain state (inside lock for atomicity)
      const [lastIndex, prevHash] = getLastChainState(evidencePath);

      // Add chain fields
      entry._chain_index = lastIndex + 1;
      entry._prev_hash = prevHash;

      // Compute HMAC (if key available)
      const hmacKey = getHmacKey();
      if (hmacKey) {
        const canonical = canonicalJson(entry);
        entry._hmac = crypto
          .createHmac("sha256", hmacKey)
          .update(canonical, "utf8")
          .digest("hex");
      }

      fs.appendFileSync(evidencePath, JSON.stringify(entry) + "\n", "utf8");
    });

    return true;
  } catch (e) {
    process.stderr.write(`[tobari] WARNING: Evidence write failed: ${e.message}\n`);
    return false;
  }
}

/**
 * Read all entries from the evidence ledger.
 *
 * @returns {Object[]} Array of parsed JSONL entries. Skips malformed lines.
 */
function readEvidence() {
  const evidencePath = getEvidencePath();
  if (!fs.existsSync(evidencePath)) return [];

  const entries = [];
  try {
    const content = fs.readFileSync(evidencePath, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      const stripped = line.trim();
      if (!stripped) continue;
      try {
        entries.push(JSON.parse(stripped));
      } catch (_) {
        continue;
      }
    }
  } catch (_) {
    // File read error — return what we have
  }
  return entries;
}

/**
 * Summarize the evidence ledger for reporting.
 *
 * Returns counts by event type, tool usage breakdown,
 * and quality_gate_counts (blocking = denied operations).
 *
 * @returns {Object}
 */
function summarizeEvidence() {
  const entries = readEvidence();
  if (entries.length === 0) {
    return {
      total: 0,
      events: {},
      tools: {},
      quality_gate_counts: { blocking: 0, high: 0 },
    };
  }

  const events = {};
  const tools = {};
  let deniedCount = 0;

  for (const entry of entries) {
    const event = entry.event || "unknown";
    events[event] = (events[event] || 0) + 1;

    const tool = entry.tool_name;
    if (tool) {
      tools[tool] = (tools[tool] || 0) + 1;
    }

    if (event === "tool_denied") {
      deniedCount++;
    }
  }

  return {
    total: entries.length,
    events,
    tools,
    quality_gate_counts: {
      blocking: deniedCount,
      high: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Token Usage
// ---------------------------------------------------------------------------

/**
 * Resolve the path to tobari-cost-state.json (separate from session file).
 *
 * Token usage is tracked in a dedicated file to avoid frequent writes to
 * tobari-session.json, which causes Edit tool race conditions (the
 * "file modified since read" error).
 *
 * @returns {string} Absolute path to cost state file.
 */
function getCostStatePath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  if (projectDir) {
    return path.join(projectDir, ".claude", "tobari-cost-state.json");
  }
  const hooksDir = path.resolve(__dirname);
  return path.join(hooksDir, "..", "tobari-cost-state.json");
}

/**
 * Get current token_usage from tobari-cost-state.json (primary)
 * or tobari-session.json (fallback for migration).
 *
 * @returns {Object} {input, output, budget}
 */
function getTokenUsage() {
  const session = loadSession();
  if (!session) {
    return { input: 0, output: 0, budget: 500000 };
  }

  // Read budget from session (authoritative source for budget)
  const sessionUsage = session.token_usage;
  const budget = (sessionUsage && parseInt(sessionUsage.budget, 10)) || 500000;

  // Try cost state file first
  const costPath = getCostStatePath();
  try {
    if (fs.existsSync(costPath)) {
      const raw = fs.readFileSync(costPath, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        return {
          input: parseInt(data.input, 10) || 0,
          output: parseInt(data.output, 10) || 0,
          budget: budget,
        };
      }
    }
  } catch (_) {
    // Fall through to session fallback
  }

  // Fallback: read from session (migration path)
  if (!sessionUsage || typeof sessionUsage !== "object") {
    return { input: 0, output: 0, budget: budget };
  }
  return {
    input: parseInt(sessionUsage.input, 10) || 0,
    output: parseInt(sessionUsage.output, 10) || 0,
    budget: budget,
  };
}

/**
 * Atomically increment token_usage in tobari-cost-state.json.
 *
 * Writes ONLY to the dedicated cost state file, NOT to tobari-session.json.
 * This eliminates Edit tool race conditions caused by frequent session writes.
 *
 * @param {number} deltaInput - Number of input tokens to add.
 * @param {number} deltaOutput - Number of output tokens to add.
 * @returns {Object|null} Updated token_usage dict if successful, null on error.
 */
function updateTokenUsage(deltaInput, deltaOutput) {
  // Verify session is active
  const session = loadSession();
  if (!session) return null;

  const costPath = getCostStatePath();
  const budget = (session.token_usage && parseInt(session.token_usage.budget, 10)) || 500000;

  try {
    return withFileLock(costPath, () => {
      // Read current state
      let current = { input: 0, output: 0 };
      try {
        if (fs.existsSync(costPath)) {
          const raw = fs.readFileSync(costPath, "utf8");
          const data = JSON.parse(raw);
          if (data && typeof data === "object") {
            current.input = parseInt(data.input, 10) || 0;
            current.output = parseInt(data.output, 10) || 0;
          }
        }
      } catch (_) {
        // Start from zero on read error
      }

      const newUsage = {
        input: current.input + Math.max(0, deltaInput),
        output: current.output + Math.max(0, deltaOutput),
        budget: budget,
      };

      fs.writeFileSync(costPath, JSON.stringify(newUsage, null, 2) + "\n", "utf8");
      return newUsage;
    });
  } catch (e) {
    process.stderr.write(`Cost state update failed: ${e.message}\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Self-Repair
// ---------------------------------------------------------------------------

/**
 * Get current self-repair retry count from tobari-session.json.
 * @returns {number} Returns 0 if session is inactive or field is missing.
 */
function getRetryCount() {
  const session = loadSession();
  if (!session) return 0;
  const count = parseInt(session.retry_count, 10);
  return isNaN(count) ? 0 : count;
}

/**
 * Set retry_count in tobari-session.json.
 *
 * @param {number} count
 * @returns {boolean} True on success, false on error.
 */
function setRetryCount(count) {
  return readModifyWriteSession((data) => {
    data.retry_count = Math.max(0, parseInt(count, 10) || 0);
  });
}

// ---------------------------------------------------------------------------
// Notification Utilities
// ---------------------------------------------------------------------------

/**
 * Read webhook URL from tobari-session.json notification config.
 *
 * @param {Object} session - Session object.
 * @returns {string|null} Webhook URL string, or null if not configured.
 */
function getWebhookConfig(session) {
  if (!session) return null;
  const notification = session.notification;
  if (!notification || typeof notification !== "object") return null;
  const url = notification.webhook_url;
  if (url && typeof url === "string" && url.trim()) {
    return url.trim();
  }
  return null;
}

/**
 * Fire-and-forget HTTP POST to a webhook URL.
 *
 * Uses built-in http/https modules. Does not wait for response.
 * Failures are silently recorded to the evidence ledger.
 *
 * @param {string} url - Webhook URL.
 * @param {Object} payload - JSON payload to send.
 */
function sendWebhook(url, payload) {
  try {
    const parsedUrl = new URL(url);
    const httpModule = parsedUrl.protocol === "https:" ? require("https") : require("http");
    const body = JSON.stringify(payload);

    const options = {
      method: "POST",
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "tobari/1.0",
      },
      timeout: 3000,
    };

    const req = httpModule.request(options);

    req.on("error", (e) => {
      writeEvidence({
        event: "webhook_error",
        url: url,
        error: e.message,
      });
    });

    req.on("timeout", () => {
      req.destroy();
    });

    req.write(body);
    req.end();
    // Fire-and-forget: don't wait for response
  } catch (e) {
    writeEvidence({
      event: "webhook_error",
      url: url,
      error: e.message,
    });
  }
}

/**
 * Resolve the path to tasks/backlog.yaml.
 * @returns {string}
 */
function getBacklogPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  if (projectDir) {
    return path.join(projectDir, "tasks", "backlog.yaml");
  }
  // Fallback: {project}/tasks/backlog.yaml
  const hooksDir = path.resolve(__dirname);
  return path.join(hooksDir, "..", "..", "tasks", "backlog.yaml");
}

/**
 * Generate GitHub PR description text from backlog.yaml task data.
 *
 * Reads the task record and formats a Japanese summary suitable for
 * use as a PR body. Falls back gracefully if backlog.yaml is unavailable.
 *
 * @param {string} taskId - Task ID (e.g., "TASK-081").
 * @returns {string}
 */
function formatTaskNotification(taskId) {
  let taskInfo = {};
  const backlogPath = getBacklogPath();

  if (yaml && fs.existsSync(backlogPath)) {
    try {
      const raw = fs.readFileSync(backlogPath, "utf8");
      const data = yaml.load(raw);
      const tasks = (data && data.tasks) || [];
      for (const task of tasks) {
        if (task.id === taskId) {
          taskInfo = task;
          break;
        }
      }
    } catch (_) {
      // Fall through to minimal format
    }
  }

  const title = taskInfo.title || taskId;
  const status = taskInfo.status || "unknown";
  const phase = taskInfo.phase || "";
  const evidenceList = taskInfo.evidence || [];
  const acceptanceList = taskInfo.acceptance || [];

  const lines = [
    `## ${taskId}: ${title}`,
    "",
    `**\u30D5\u30A7\u30FC\u30BA**: ${phase}\u3000**\u30B9\u30C6\u30FC\u30BF\u30B9**: ${status}`,
    "",
  ];

  if (acceptanceList.length > 0) {
    lines.push("### \u53D7\u5165\u57FA\u6E96");
    for (const a of acceptanceList) {
      lines.push(`- ${a}`);
    }
    lines.push("");
  }

  lines.push("### \u8A3C\u8DE1");
  if (evidenceList.length > 0) {
    for (const e of evidenceList.slice(0, 6)) {
      lines.push(`- ${e}`);
    }
  } else {
    lines.push("- `.claude/logs/evidence-ledger.jsonl`");
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("_Generated by tobari \u2014 Evidence Trail_");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Context Builder
// ---------------------------------------------------------------------------

/**
 * Build hookSpecificOutput with session context injection.
 *
 * Shared helper for PreCompact and SessionStart hooks to avoid
 * duplicate session-loading and output-formatting logic.
 *
 * @param {string} introText - Always-injected project reference text.
 * @param {string} sessionActiveText - Text when veil is active (may contain
 *   {task}, {profile}, {gates} placeholders).
 * @param {string} [sessionInactiveText] - Text when veil is inactive (optional).
 * @returns {Object} Dict suitable for JSON output as hookSpecificOutput.
 */
function buildContextOutput(introText, sessionActiveText, sessionInactiveText) {
  const contextParts = [introText];

  const session = loadSession();
  if (session) {
    const task = session.task || "unknown";
    const profile = session.profile || "standard";
    const gates = session.gates_passed || [];
    const formatted = sessionActiveText
      .replace("{task}", task)
      .replace("{profile}", profile)
      .replace("{gates}", JSON.stringify(gates));
    contextParts.push(formatted);
  } else if (sessionInactiveText) {
    contextParts.push(sessionInactiveText);
  }

  return {
    hookSpecificOutput: {
      additionalContext: contextParts.join(" "),
    },
  };
}

// ---------------------------------------------------------------------------
// Session Lifecycle
// ---------------------------------------------------------------------------

/**
 * Collect current git state for session finalization.
 *
 * @returns {Object} {branch, uncommitted_changes, pr_url}
 */
function getGitState() {
  const result = {
    branch: null,
    uncommitted_changes: false,
    pr_url: null,
  };

  try {
    const branch = execSync("git branch --show-current", {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    result.branch = branch.trim() || null;
  } catch (_) {
    // git not available or not a repo
  }

  try {
    const status = execSync("git status --porcelain", {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    result.uncommitted_changes = Boolean(status.trim());
  } catch (_) {
    // git not available or not a repo
  }

  return result;
}

/**
 * Session end processing: update git state, summarize evidence,
 * reset retry count, then raise veil.
 *
 * Called from /handoff skill or Stop hook fallback.
 *
 * @param {string} [reason="session end"] - Why the session is ending.
 * @returns {Object} {status, reason}
 */
function finalizeSession(reason) {
  if (reason === undefined) reason = "session end";

  const session = loadSession();
  if (!session || !session.active) {
    return { status: "skipped", reason: "veil not active" };
  }

  // 1. Git state update
  const gitState = getGitState();

  // 2. Evidence summary
  const evidenceSummary = summarizeEvidence();

  // 3. Update session with finalization data before raising veil
  const sessionPath = getSessionPath();
  try {
    withFileLock(sessionPath, () => {
      const raw = fs.readFileSync(sessionPath, "utf8");
      const data = JSON.parse(raw);

      if (typeof data === "object" && data !== null && data.active) {
        data.git_state = gitState;
        data.evidence_summary = evidenceSummary;
        data.retry_count = 0;

        fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2) + "\n", "utf8");
      }
    });

    // Invalidate cache so raiseVeil reads fresh data
    _sessionCache = null;
    _sessionCacheMtime = 0;
  } catch (e) {
    process.stderr.write(
      `[tobari] WARNING: finalize_session pre-update failed: ${e.message}\n`
    );
  }

  // 4. Raise veil (sets active=false, raised_at, raised_reason, writes evidence)
  raiseVeil(reason);

  return { status: "finalized", reason };
}

/**
 * Raise the veil (set active=false) with a reason and ceremony message.
 *
 * @param {string} [reason="session ended"] - Why the veil is being raised.
 * @returns {boolean} True if successfully raised, false on error.
 */
function raiseVeil(reason) {
  if (reason === undefined) reason = "session ended";

  const sessionPath = getSessionPath();
  if (!fs.existsSync(sessionPath)) return false;

  try {
    let wasActive = false;
    let taskName = "unknown";

    withFileLock(sessionPath, () => {
      const raw = fs.readFileSync(sessionPath, "utf8");
      const data = JSON.parse(raw);

      if (typeof data !== "object" || data === null) return;

      wasActive = Boolean(data.active);
      taskName = data.task || "unknown";
      data.active = false;
      data.raised_at = new Date().toISOString();
      data.raised_reason = reason;

      fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    });

    // Invalidate cache
    _sessionCache = null;
    _sessionCacheMtime = 0;

    if (wasActive) {
      writeEvidence({
        event: "veil_raised",
        reason,
        task: taskName,
      });
    }

    return true;
  } catch (e) {
    process.stderr.write(`[tobari] WARNING: Failed to raise veil: ${e.message}\n`);
    return false;
  }
}

/**
 * Get info about when/why the veil was last raised.
 *
 * @returns {Object|null} {task, raised_at, raised_reason} or null.
 */
function getRaisedInfo() {
  const sessionPath = getSessionPath();
  if (!fs.existsSync(sessionPath)) return null;

  try {
    const raw = fs.readFileSync(sessionPath, "utf8");
    const data = JSON.parse(raw);

    if (typeof data !== "object" || data === null) return null;
    if (data.active) return null; // Veil is still down

    const raisedAt = data.raised_at;
    if (!raisedAt) return null; // Old format without raised info

    return {
      task: data.task || "unknown",
      raised_at: raisedAt,
      raised_reason: data.raised_reason || "unknown",
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook Runner
// ---------------------------------------------------------------------------

/**
 * Standard hook runner. Read all stdin, parse JSON, call handler, write JSON to stdout.
 *
 * Error handling: log to stderr, exit 0 (fail-open for non-gate hooks).
 *
 * @param {Function} handler - Function that receives parsed input and returns output object or null.
 */
function runHook(handler) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(data);
      const output = handler(input);
      if (output) {
        process.stdout.write(JSON.stringify(output));
      }
    } catch (e) {
      process.stderr.write(`[tobari] Hook error: ${e.message}\n`);
      process.exit(0);
    }
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  SESSION_FILENAME,
  BOUNDARY_FILENAME,
  EVIDENCE_LEDGER_FILENAME,
  EVIDENCE_LOG_DIR,
  HMAC_KEY_FILENAME,
  HMAC_KEY_ENV_VAR,
  CHAIN_GENESIS_HASH,
  EVIDENCE_MAX_SIZE,
  LOCK_TIMEOUT,
  LOCK_RETRY_INTERVAL,

  // File Locking
  withFileLock,
  withNamedLock,
  readModifyWriteSession,

  // Session Management
  getSessionPath,
  loadSession,
  isVeilActive,
  getProfile,
  getScope,
  getContract,
  getTask,
  getGatesPassed,
  updateGatesPassed,

  // Path / Scope Utilities
  isDirPrefix,
  canonicalPathKey,
  isPathInScope,

  // Boundary Classification
  getBoundaryPath,
  loadBoundaryClassification,
  getBoundaryClassification,

  // Evidence Ledger
  getEvidenceDir,
  getEvidencePath,
  getHmacKey,
  getLastChainState,
  canonicalJson,
  writeEvidence,
  readEvidence,
  summarizeEvidence,

  // Token Usage
  getCostStatePath,
  getTokenUsage,
  updateTokenUsage,

  // Self-Repair
  getRetryCount,
  setRetryCount,

  // Notification
  getWebhookConfig,
  sendWebhook,
  formatTaskNotification,

  // Context Builder
  buildContextOutput,
  getBacklogPath,

  // Agent Policy (A8)
  getAgentPolicy,
  checkAgentToolPermission,

  // Session Lifecycle
  getGitState,
  finalizeSession,
  raiseVeil,
  getRaisedInfo,

  // Hook Runner
  runHook,

  // Internal (test helpers — do not use in production hooks)
  _resetCache() {
    _sessionCache = null;
    _sessionCacheMtime = 0;
    _boundaryCache = null;
  },
};
