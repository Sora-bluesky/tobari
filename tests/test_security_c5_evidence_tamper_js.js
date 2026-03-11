#!/usr/bin/env node
"use strict";
/**
 * C5 Security Tests: Evidence Ledger Tamper Detection.
 *
 * Validates chain integrity, HMAC verification, and tamper detection
 * for the evidence ledger (.claude/logs/evidence-ledger.jsonl).
 *
 * Groups:
 *   C5-CH1..CH3:  Chain integrity (index, prev_hash, genesis)
 *   C5-HM1..HM3:  HMAC verification (existence, recompute, key change)
 *   C5-TD1..TD4:  Tamper detection (modify, HMAC tamper, delete, reorder)
 *   C5-EC1..EC3:  Edge cases (no HMAC key, canonical stability, large entry)
 *
 * Run: node --test tests/test_security_c5_evidence_tamper_js.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");

const PROJECT_DIR = path.resolve(__dirname, "..");
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
const tobariSession = require("../.claude/hooks/tobari-session.js");

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory for test isolation. */
function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tobari-c5-"));
}

/** Remove temp directory tree. */
function cleanupTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Windows may hold file locks briefly
  }
}

/**
 * Write a minimal active tobari-session.json into tmpDir/.claude/.
 * Returns the path to the session file.
 */
function createActiveSession(tmpDir) {
  const claudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const sessionPath = path.join(claudeDir, "tobari-session.json");

  const sessionData = {
    active: true,
    task: "TASK-C5-TEST",
    profile: "standard",
    gates_passed: ["STG0"],
    retry_count: 0,
    token_usage: { input: 0, output: 0, budget: 500000 },
    contract: {
      intent: "test evidence tamper detection",
      requirements: { do: ["verify chain"], do_not: [] },
      dod: ["chain verified"],
      scope: { include: [".claude/hooks/", "tests/"], exclude: [] },
    },
  };

  fs.writeFileSync(
    sessionPath,
    JSON.stringify(sessionData, null, 2) + "\n",
    "utf8",
  );

  // Create logs directory for evidence ledger
  const logsDir = path.join(claudeDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  return sessionPath;
}

/**
 * Build a sample evidence entry (without chain/HMAC fields).
 * @param {string} toolName
 * @param {number} [seq] - Optional sequence number for uniqueness.
 * @returns {Object}
 */
function sampleEntry(toolName, seq) {
  return {
    timestamp: new Date().toISOString(),
    event: "tool_complete",
    tool_name: toolName || "Bash",
    input_summary: { command: `echo test_${seq || 0}` },
    response_summary: { exit_code: 0, success: true, output_size: 10 },
    task: "TASK-C5-TEST",
    profile: "standard",
    current_gate: "STG1",
  };
}

/**
 * Read all JSONL lines from an evidence ledger file.
 * @param {string} ledgerPath
 * @returns {string[]} Raw line strings (non-empty).
 */
function readLedgerLines(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((l) => l.trim());
}

/**
 * Parse all entries from an evidence ledger file.
 * @param {string} ledgerPath
 * @returns {Object[]}
 */
function readLedgerEntries(ledgerPath) {
  return readLedgerLines(ledgerPath).map((line) => JSON.parse(line));
}

/**
 * Compute sha256 hex of a raw line string (for chain verification).
 * @param {string} line
 * @returns {string}
 */
function sha256(line) {
  return crypto.createHash("sha256").update(line, "utf8").digest("hex");
}

/**
 * Compute HMAC-SHA256 hex of canonical JSON for an entry.
 * @param {Object} entry - Entry object (without _hmac field).
 * @param {Buffer} hmacKey
 * @returns {string}
 */
function computeHmac(entry, hmacKey) {
  const withoutHmac = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k !== "_hmac") withoutHmac[k] = v;
  }
  const canonical = tobariSession.canonicalJson(withoutHmac);
  return crypto
    .createHmac("sha256", hmacKey)
    .update(canonical, "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Environment management shared across all describe blocks
// ---------------------------------------------------------------------------

let tmpDir;
let originalProjectDir;
let originalHmacKey;

// ============================================================
// C5-CH1..CH3: Chain Integrity
// ============================================================

describe("C5: Chain integrity", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    originalHmacKey = process.env.TOBARI_HMAC_KEY;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    // Set a known HMAC key for deterministic tests
    process.env.TOBARI_HMAC_KEY =
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    tobariSession._resetCache();
    createActiveSession(tmpDir);
  });

  afterEach(() => {
    if (originalProjectDir !== undefined) {
      process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    } else {
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    if (originalHmacKey !== undefined) {
      process.env.TOBARI_HMAC_KEY = originalHmacKey;
    } else {
      delete process.env.TOBARI_HMAC_KEY;
    }
    tobariSession._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("C5-CH1: write 3 entries, chain_index increments 0, 1, 2", () => {
    for (let i = 0; i < 3; i++) {
      tobariSession.writeEvidence(sampleEntry("Bash", i));
    }

    const ledgerPath = tobariSession.getEvidencePath();
    const entries = readLedgerEntries(ledgerPath);

    assert.equal(entries.length, 3);
    assert.equal(entries[0]._chain_index, 0);
    assert.equal(entries[1]._chain_index, 1);
    assert.equal(entries[2]._chain_index, 2);
  });

  it("C5-CH2: _prev_hash of entry N+1 equals sha256 of entry N line", () => {
    for (let i = 0; i < 3; i++) {
      tobariSession.writeEvidence(sampleEntry("Read", i));
    }

    const ledgerPath = tobariSession.getEvidencePath();
    const lines = readLedgerLines(ledgerPath);

    assert.equal(lines.length, 3);

    // Entry 1's _prev_hash should be sha256 of line 0
    const entry1 = JSON.parse(lines[1]);
    assert.equal(entry1._prev_hash, sha256(lines[0]));

    // Entry 2's _prev_hash should be sha256 of line 1
    const entry2 = JSON.parse(lines[2]);
    assert.equal(entry2._prev_hash, sha256(lines[1]));
  });

  it("C5-CH3: first entry uses CHAIN_GENESIS_HASH as _prev_hash", () => {
    tobariSession.writeEvidence(sampleEntry("Glob", 0));

    const ledgerPath = tobariSession.getEvidencePath();
    const entries = readLedgerEntries(ledgerPath);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]._prev_hash, tobariSession.CHAIN_GENESIS_HASH);
    // Genesis hash is 64 zero characters
    assert.equal(entries[0]._prev_hash, "0".repeat(64));
  });
});

// ============================================================
// C5-HM1..HM3: HMAC Verification
// ============================================================

describe("C5: HMAC verification", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    originalHmacKey = process.env.TOBARI_HMAC_KEY;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();
    createActiveSession(tmpDir);
  });

  afterEach(() => {
    if (originalProjectDir !== undefined) {
      process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    } else {
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    if (originalHmacKey !== undefined) {
      process.env.TOBARI_HMAC_KEY = originalHmacKey;
    } else {
      delete process.env.TOBARI_HMAC_KEY;
    }
    tobariSession._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("C5-HM1: entry has _hmac field when HMAC key is set", () => {
    const hmacKeyHex =
      "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe";
    process.env.TOBARI_HMAC_KEY = hmacKeyHex;

    tobariSession.writeEvidence(sampleEntry("Bash", 0));

    const ledgerPath = tobariSession.getEvidencePath();
    const entries = readLedgerEntries(ledgerPath);

    assert.equal(entries.length, 1);
    assert.ok(
      entries[0]._hmac,
      "Expected _hmac field to be present and non-empty",
    );
    assert.equal(typeof entries[0]._hmac, "string");
    // HMAC-SHA256 hex is 64 characters
    assert.equal(entries[0]._hmac.length, 64);
  });

  it("C5-HM2: recomputed HMAC matches stored _hmac", () => {
    const hmacKeyHex =
      "aabbccddee0011ff2233445566778899aabbccddee0011ff2233445566778899";
    process.env.TOBARI_HMAC_KEY = hmacKeyHex;
    const hmacKey = Buffer.from(hmacKeyHex, "hex");

    tobariSession.writeEvidence(sampleEntry("Edit", 0));

    const ledgerPath = tobariSession.getEvidencePath();
    const entries = readLedgerEntries(ledgerPath);

    assert.equal(entries.length, 1);
    const entry = entries[0];
    const storedHmac = entry._hmac;

    // Recompute HMAC from canonical JSON (excluding _hmac)
    const recomputed = computeHmac(entry, hmacKey);

    assert.equal(
      recomputed,
      storedHmac,
      "Recomputed HMAC should match stored _hmac",
    );
  });

  it("C5-HM3: different HMAC key produces different _hmac value", () => {
    const keyA =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const keyB =
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // Write with key A
    process.env.TOBARI_HMAC_KEY = keyA;
    tobariSession.writeEvidence(sampleEntry("Bash", 0));

    const ledgerPath = tobariSession.getEvidencePath();
    const entriesA = readLedgerEntries(ledgerPath);
    const hmacA = entriesA[0]._hmac;

    // Clear ledger and write same-shaped entry with key B
    fs.writeFileSync(ledgerPath, "", "utf8");
    process.env.TOBARI_HMAC_KEY = keyB;
    tobariSession.writeEvidence(sampleEntry("Bash", 0));

    const entriesB = readLedgerEntries(ledgerPath);
    const hmacB = entriesB[0]._hmac;

    assert.ok(hmacA, "hmacA should exist");
    assert.ok(hmacB, "hmacB should exist");
    assert.notEqual(
      hmacA,
      hmacB,
      "HMACs with different keys should differ",
    );
  });
});

// ============================================================
// C5-TD1..TD4: Tamper Detection
// ============================================================

describe("C5: Tamper detection", () => {
  const HMAC_KEY_HEX =
    "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";
  let hmacKey;

  beforeEach(() => {
    tmpDir = createTmpDir();
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    originalHmacKey = process.env.TOBARI_HMAC_KEY;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    process.env.TOBARI_HMAC_KEY = HMAC_KEY_HEX;
    hmacKey = Buffer.from(HMAC_KEY_HEX, "hex");
    tobariSession._resetCache();
    createActiveSession(tmpDir);
  });

  afterEach(() => {
    if (originalProjectDir !== undefined) {
      process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    } else {
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    if (originalHmacKey !== undefined) {
      process.env.TOBARI_HMAC_KEY = originalHmacKey;
    } else {
      delete process.env.TOBARI_HMAC_KEY;
    }
    tobariSession._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("C5-TD1: modifying a middle entry breaks prev_hash chain", () => {
    // Write 3 entries
    for (let i = 0; i < 3; i++) {
      tobariSession.writeEvidence(sampleEntry("Bash", i));
    }

    const ledgerPath = tobariSession.getEvidencePath();
    const lines = readLedgerLines(ledgerPath);
    assert.equal(lines.length, 3);

    // Tamper with the middle entry (index 1): change tool_name
    const entry1 = JSON.parse(lines[1]);
    entry1.tool_name = "TAMPERED";
    const tamperedLine1 = JSON.stringify(entry1);

    // Rewrite ledger with tampered line
    const newContent = [lines[0], tamperedLine1, lines[2]]
      .map((l) => l + "\n")
      .join("");
    fs.writeFileSync(ledgerPath, newContent, "utf8");

    // Verify chain break: entry 2's _prev_hash should NOT match sha256 of
    // tampered line 1 (it was computed against the original line 1)
    const entry2 = JSON.parse(lines[2]);
    const hashOfTamperedLine1 = sha256(tamperedLine1);

    // The original entry 2's _prev_hash was computed from the ORIGINAL line 1
    // So it should NOT equal the hash of the tampered line 1
    assert.notEqual(
      entry2._prev_hash,
      hashOfTamperedLine1,
      "Tampered entry should break the hash chain",
    );

    // Additionally: original _prev_hash was valid before tampering
    const hashOfOriginalLine1 = sha256(lines[1]);
    assert.equal(
      entry2._prev_hash,
      hashOfOriginalLine1,
      "Original chain was valid before tampering",
    );
  });

  it("C5-TD2: modifying _hmac of an entry is detectable via recomputation", () => {
    tobariSession.writeEvidence(sampleEntry("Write", 0));

    const ledgerPath = tobariSession.getEvidencePath();
    const entries = readLedgerEntries(ledgerPath);
    const entry = entries[0];

    // Save the valid HMAC
    const validHmac = entry._hmac;
    assert.ok(validHmac, "Entry should have _hmac");

    // Tamper: replace HMAC with garbage
    entry._hmac = "ff".repeat(32);

    // Recompute HMAC from canonical JSON (without _hmac)
    const recomputed = computeHmac(entry, hmacKey);

    // The tampered _hmac should NOT match the recomputed value
    assert.notEqual(
      entry._hmac,
      recomputed,
      "Tampered HMAC should not match recomputed HMAC",
    );

    // But the recomputed value should match the original valid HMAC
    assert.equal(
      recomputed,
      validHmac,
      "Recomputed HMAC matches original valid HMAC",
    );
  });

  it("C5-TD3: deleting an entry creates chain_index gap", () => {
    // Write 3 entries
    for (let i = 0; i < 3; i++) {
      tobariSession.writeEvidence(sampleEntry("Grep", i));
    }

    const ledgerPath = tobariSession.getEvidencePath();
    const lines = readLedgerLines(ledgerPath);
    assert.equal(lines.length, 3);

    // Delete the middle entry (index 1)
    const newContent = [lines[0], lines[2]].map((l) => l + "\n").join("");
    fs.writeFileSync(ledgerPath, newContent, "utf8");

    // Read tampered ledger
    const tamperedLines = readLedgerLines(ledgerPath);
    assert.equal(tamperedLines.length, 2);

    const entry0 = JSON.parse(tamperedLines[0]);
    const entry2 = JSON.parse(tamperedLines[1]);

    // chain_index gap: 0, 2 (missing 1)
    assert.equal(entry0._chain_index, 0);
    assert.equal(entry2._chain_index, 2, "Gap in chain_index detected");
    assert.notEqual(
      entry2._chain_index,
      1,
      "Deleted entry leaves chain_index gap",
    );

    // Also: prev_hash of entry2 should not match sha256 of entry0 line
    // because entry2's prev_hash was computed against entry1 (now deleted)
    const hashOfEntry0Line = sha256(tamperedLines[0]);
    assert.notEqual(
      entry2._prev_hash,
      hashOfEntry0Line,
      "prev_hash mismatch after deletion",
    );
  });

  it("C5-TD4: reordering entries breaks the chain", () => {
    // Write 3 entries
    for (let i = 0; i < 3; i++) {
      tobariSession.writeEvidence(sampleEntry("Read", i));
    }

    const ledgerPath = tobariSession.getEvidencePath();
    const lines = readLedgerLines(ledgerPath);
    assert.equal(lines.length, 3);

    // Reorder: swap entry 0 and entry 2
    const reordered = [lines[2], lines[1], lines[0]]
      .map((l) => l + "\n")
      .join("");
    fs.writeFileSync(ledgerPath, reordered, "utf8");

    // Read reordered ledger
    const reorderedLines = readLedgerLines(ledgerPath);

    // First line is original entry 2 (chain_index=2), not 0
    const firstEntry = JSON.parse(reorderedLines[0]);
    assert.notEqual(
      firstEntry._chain_index,
      0,
      "Reordered first entry has wrong chain_index",
    );
    assert.equal(firstEntry._chain_index, 2);

    // Second line: entry 1's prev_hash was sha256(original line 0),
    // but now line 0 is the original line 2 — mismatch
    const secondEntry = JSON.parse(reorderedLines[1]);
    const hashOfNewFirstLine = sha256(reorderedLines[0]);
    assert.notEqual(
      secondEntry._prev_hash,
      hashOfNewFirstLine,
      "prev_hash mismatch after reorder",
    );
  });
});

// ============================================================
// C5-EC1..EC3: Edge Cases
// ============================================================

describe("C5: Edge cases", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    originalHmacKey = process.env.TOBARI_HMAC_KEY;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    tobariSession._resetCache();
    createActiveSession(tmpDir);
  });

  afterEach(() => {
    if (originalProjectDir !== undefined) {
      process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    } else {
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    if (originalHmacKey !== undefined) {
      process.env.TOBARI_HMAC_KEY = originalHmacKey;
    } else {
      delete process.env.TOBARI_HMAC_KEY;
    }
    tobariSession._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("C5-EC1: no HMAC key — chain still works, _hmac may be absent", () => {
    // Unset HMAC key env var
    delete process.env.TOBARI_HMAC_KEY;

    // Also ensure no key file exists in the tmpDir
    const keyFilePath = path.join(tmpDir, ".claude", "tobari-hmac-key");
    // getHmacKey() will auto-generate a key file if it can write,
    // so we need to check: if auto-generation happens, _hmac will be present.
    // If auto-generation fails (permission), _hmac will be absent.
    // Either way, chain fields should work.

    tobariSession.writeEvidence(sampleEntry("Bash", 0));
    tobariSession.writeEvidence(sampleEntry("Read", 1));

    const ledgerPath = tobariSession.getEvidencePath();
    const entries = readLedgerEntries(ledgerPath);

    assert.equal(entries.length, 2);

    // Chain fields always present
    assert.equal(entries[0]._chain_index, 0);
    assert.equal(entries[1]._chain_index, 1);
    assert.equal(entries[0]._prev_hash, tobariSession.CHAIN_GENESIS_HASH);

    // Verify chain linkage
    const lines = readLedgerLines(ledgerPath);
    assert.equal(entries[1]._prev_hash, sha256(lines[0]));
  });

  it("C5-EC2: canonicalJson produces stable output for same entry", () => {
    const entry = {
      zebra: "last",
      alpha: "first",
      middle: { z_key: 2, a_key: 1 },
      numbers: [3, 1, 2],
    };

    const canonical1 = tobariSession.canonicalJson(entry);
    const canonical2 = tobariSession.canonicalJson(entry);

    assert.equal(canonical1, canonical2, "Same entry produces same canonical");

    // Verify keys are sorted
    const parsed = JSON.parse(canonical1);
    const topKeys = Object.keys(parsed);
    assert.deepEqual(
      topKeys,
      ["alpha", "middle", "numbers", "zebra"],
      "Top-level keys are sorted",
    );

    // Nested keys are also sorted
    const middleKeys = Object.keys(parsed.middle);
    assert.deepEqual(
      middleKeys,
      ["a_key", "z_key"],
      "Nested keys are sorted",
    );

    // Array order is preserved (not sorted)
    assert.deepEqual(parsed.numbers, [3, 1, 2], "Array order preserved");
  });

  it("C5-EC3: very large entry does not crash writeEvidence", () => {
    const largeEntry = sampleEntry("Bash", 999);
    // Add a large payload (100KB of data)
    largeEntry.input_summary = {
      command: "x".repeat(100 * 1024),
    };

    const result = tobariSession.writeEvidence(largeEntry);
    assert.equal(result, true, "writeEvidence should succeed with large entry");

    const ledgerPath = tobariSession.getEvidencePath();
    const entries = readLedgerEntries(ledgerPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]._chain_index, 0);
    assert.ok(
      entries[0].input_summary.command.length >= 100 * 1024,
      "Large content preserved",
    );
  });
});

// ============================================================
// C5-VF1..VF2: Verification Round-Trip
// ============================================================

describe("C5: Verification round-trip", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    originalHmacKey = process.env.TOBARI_HMAC_KEY;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    process.env.TOBARI_HMAC_KEY =
      "ff00aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55";
    tobariSession._resetCache();
    createActiveSession(tmpDir);
  });

  afterEach(() => {
    if (originalProjectDir !== undefined) {
      process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    } else {
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    if (originalHmacKey !== undefined) {
      process.env.TOBARI_HMAC_KEY = originalHmacKey;
    } else {
      delete process.env.TOBARI_HMAC_KEY;
    }
    tobariSession._resetCache();
    cleanupTmpDir(tmpDir);
  });

  it("C5-VF1: getLastChainState returns correct state after writes", () => {
    tobariSession.writeEvidence(sampleEntry("Bash", 0));
    tobariSession.writeEvidence(sampleEntry("Read", 1));

    const ledgerPath = tobariSession.getEvidencePath();
    const [lastIndex, lastHash] = tobariSession.getLastChainState(ledgerPath);

    assert.equal(lastIndex, 1, "Last index should be 1 after 2 writes");
    assert.equal(typeof lastHash, "string");
    assert.equal(lastHash.length, 64, "Hash should be 64 hex chars");

    // Verify the hash is sha256 of the last line
    const lines = readLedgerLines(ledgerPath);
    const expectedHash = sha256(lines[lines.length - 1]);
    assert.equal(lastHash, expectedHash);
  });

  it("C5-VF2: getLastChainState on empty file returns genesis", () => {
    const ledgerPath = tobariSession.getEvidencePath();

    // Ledger file doesn't exist yet
    const [lastIndex, lastHash] = tobariSession.getLastChainState(ledgerPath);

    assert.equal(lastIndex, -1, "Empty ledger returns index -1");
    assert.equal(
      lastHash,
      tobariSession.CHAIN_GENESIS_HASH,
      "Empty ledger returns genesis hash",
    );
  });
});
