#!/usr/bin/env node
"use strict";

const { parseArgs } = require("node:util");

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    version: { type: "boolean", short: "v", default: false },
    help: { type: "boolean", short: "h", default: false },
    force: { type: "boolean", short: "f", default: false },
    update: { type: "boolean", default: false },
  },
});

if (values.version) {
  const pkg = require("../package.json");
  console.log(`tobari v${pkg.version}`);
  process.exit(0);
}

if (values.help || positionals.length === 0) {
  printHelp();
  process.exit(0);
}

const command = positionals[0];

switch (command) {
  case "init":
    require("./commands/init")(values);
    break;
  case "verify":
    require("./commands/verify")();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "tobari --help" for usage information.');
    process.exit(1);
}

function printHelp() {
  const pkg = require("../package.json");
  console.log(`
tobari v${pkg.version}
${pkg.description}

Usage:
  tobari <command> [options]

Commands:
  init     Deploy tobari governance framework to the current project
  verify   Check if tobari is properly configured

Options:
  -v, --version  Show version
  -h, --help     Show this help message

Init Options:
  -f, --force    Overwrite existing .claude/ directory
      --update   Update hooks only (preserve rules/skills customizations)

Examples:
  tobari init          Set up tobari in the current project
  tobari init --force  Overwrite existing configuration
  tobari init --update Update hooks to the latest version
  tobari verify        Check setup status

Documentation: ${pkg.homepage}
`.trim());
}
