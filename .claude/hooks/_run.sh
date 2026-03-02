#!/usr/bin/env bash
# Cross-platform Python launcher for Claude Code hooks.
# Detects python3 or python automatically. Skips gracefully if neither is found.
if command -v python3 &>/dev/null; then exec python3 "$@"
elif command -v python &>/dev/null; then exec python "$@"
else exit 0
fi
