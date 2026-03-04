#!/usr/bin/env python3
"""
Post-tool hook: Run linter/formatter on source files after Edit/Write.

Triggered after Edit or Write tools modify files.
- Python files (.py): Runs ruff (format + lint) and ty (type check) if available
- PowerShell files (.ps1, .psm1): Runs PSScriptAnalyzer if available
- Other files: Skips silently

All tool checks use graceful degradation — missing tools are silently skipped.
"""

import json
import os
import subprocess
import sys

# Input validation constants
MAX_PATH_LENGTH = 4096

def validate_path(file_path: str) -> bool:
    """Validate file path for security."""
    if not file_path or len(file_path) > MAX_PATH_LENGTH:
        return False
    if ".." in file_path:
        return False
    return True

def get_file_path() -> str | None:
    """Extract file path from hook input via stdin."""
    try:
        data = json.load(sys.stdin)
        tool_input = data.get("tool_input", {})
        return tool_input.get("file_path")
    except (json.JSONDecodeError, Exception):
        return None

def run_command(cmd: list[str], cwd: str) -> tuple[int, str, str]:
    """Run a command and return (returncode, stdout, stderr)."""
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "Command timed out"
    except FileNotFoundError:
        return -1, "", f"Command not found: {cmd[0]}"

def lint_python(file_path: str, project_dir: str, rel_path: str) -> None:
    """Run Python linters (ruff, ty) if available."""
    issues: list[str] = []

    # Run ruff format
    ret, stdout, stderr = run_command(
        ["uv", "run", "ruff", "format", file_path],
        cwd=project_dir,
    )
    if ret == -1:
        return  # uv not found, skip all Python linting
    if ret != 0:
        issues.append(f"ruff format failed:\n{stderr or stdout}")

    # Run ruff check with auto-fix
    ret, stdout, stderr = run_command(
        ["uv", "run", "ruff", "check", "--fix", file_path],
        cwd=project_dir,
    )
    if ret != 0:
        output = stdout or stderr
        if output.strip():
            issues.append(f"ruff check issues:\n{output}")

    # Run ty type check
    ret, stdout, stderr = run_command(
        ["uv", "run", "ty", "check", file_path],
        cwd=project_dir,
    )
    if ret != 0:
        output = stdout or stderr
        if output.strip():
            issues.append(f"ty check issues:\n{output}")

    if issues:
        print(f"[lint-on-save] Issues found in {rel_path}:", file=sys.stderr)
        for issue in issues:
            print(issue, file=sys.stderr)
        print("\nPlease review and fix these issues.", file=sys.stderr)
    else:
        print(f"[lint-on-save] OK: {rel_path} passed all checks")

def lint_powershell(file_path: str, project_dir: str, rel_path: str) -> None:
    """Run PowerShell linter (PSScriptAnalyzer) if available."""
    # Escape single quotes for PowerShell (prevent command injection)
    safe_path = file_path.replace("'", "''")
    ret, stdout, stderr = run_command(
        ["pwsh", "-NoProfile", "-Command",
         f"Invoke-ScriptAnalyzer -Path '{safe_path}' -Severity Warning,Error"],
        cwd=project_dir,
    )
    if ret == -1:
        return  # pwsh not found, skip
    if ret == 0 and stdout.strip():
        print(f"[lint-on-save] PSScriptAnalyzer issues in {rel_path}:", file=sys.stderr)
        print(stdout, file=sys.stderr)
    elif ret == 0:
        print(f"[lint-on-save] OK: {rel_path} passed PSScriptAnalyzer")

def main() -> None:
    file_path = get_file_path()
    if not file_path:
        return

    if not validate_path(file_path):
        print(f"[lint-on-save] WARNING: Invalid path rejected: {file_path}",
              file=sys.stderr)
        return

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())

    if file_path.startswith(project_dir):
        rel_path = os.path.relpath(file_path, project_dir)
    else:
        rel_path = file_path

    if file_path.endswith(".py"):
        lint_python(file_path, project_dir, rel_path)
    elif file_path.endswith((".ps1", ".psm1")):
        lint_powershell(file_path, project_dir, rel_path)
    # Other file types: skip silently

if __name__ == "__main__":
    main()
