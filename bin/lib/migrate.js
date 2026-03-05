"use strict";

const fs = require("node:fs");
const path = require("node:path");

// --- Semver Utilities ---

/**
 * Parse a semver string into [major, minor, patch] array.
 * @param {string} version - e.g. "0.5.1"
 * @returns {number[]} [major, minor, patch]
 */
function parseSemver(version) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver: ${version}`);
  }
  return parts;
}

/**
 * Compare two semver strings.
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

// --- Migration Discovery ---

/**
 * Default migrations directory (bin/migrations/).
 * Can be overridden via TOBARI_MIGRATIONS_DIR env var for testing.
 */
function getMigrationsDir() {
  return process.env.TOBARI_MIGRATIONS_DIR ||
    path.join(__dirname, "..", "migrations");
}

/**
 * Discover migration files from the migrations directory.
 * Each file must export { version, description, run(cwd) }.
 *
 * @returns {Array<{version: string, description: string, run: function, file: string}>}
 */
function discoverMigrations() {
  const migrationsDir = getMigrationsDir();

  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".js") && f !== "index.js");

  const migrations = [];
  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    try {
      const mod = require(filePath);
      if (mod.version && typeof mod.run === "function") {
        parseSemver(mod.version); // validate version format
        migrations.push({
          version: mod.version,
          description: mod.description || "",
          run: mod.run,
          file,
        });
      }
    } catch (e) {
      console.warn(`WARNING: Skipping invalid migration ${file}: ${e.message}`);
    }
  }

  // Sort by version ascending
  migrations.sort((a, b) => compareSemver(a.version, b.version));
  return migrations;
}

// --- Migration Execution ---

/**
 * Run applicable migrations between fromVersion and toVersion.
 * Applies migrations where: fromVersion < migration.version <= toVersion
 *
 * @param {string} cwd - Project root directory
 * @param {string|null} fromVersion - Currently installed version (null = fresh)
 * @param {string} toVersion - Target version
 * @param {object} [options]
 * @param {boolean} [options.verbose=false] - Print progress
 * @returns {{ applied: string[], skipped: boolean }}
 */
function runMigrations(cwd, fromVersion, toVersion, options = {}) {
  const verbose = options.verbose || false;
  const effectiveFrom = fromVersion || "0.0.0";

  const allMigrations = discoverMigrations();

  // Filter: fromVersion < migration.version <= toVersion
  const applicable = allMigrations.filter((m) =>
    compareSemver(m.version, effectiveFrom) > 0 &&
    compareSemver(m.version, toVersion) <= 0
  );

  if (applicable.length === 0) {
    return { applied: [], skipped: true };
  }

  if (verbose) {
    console.log(`  Running ${applicable.length} migration(s)...`);
  }

  const applied = [];
  for (const migration of applicable) {
    if (verbose) {
      const desc = migration.description ? ` - ${migration.description}` : "";
      console.log(`    v${migration.version}${desc}`);
    }
    try {
      migration.run(cwd);
      applied.push(migration.version);
    } catch (e) {
      console.error(
        `\nError: Migration to v${migration.version} failed: ${e.message}\n` +
        "Migration was interrupted. Your .claude/ directory may be in a partial state.\n" +
        "Run 'tobari sync --force' after resolving the issue."
      );
      process.exit(1);
    }
  }

  return { applied, skipped: false };
}

module.exports = {
  parseSemver,
  compareSemver,
  discoverMigrations,
  runMigrations,
};
