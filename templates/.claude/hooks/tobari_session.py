#!/usr/bin/env python3
"""
Shared module for reading and updating tobari-session.json.

All hooks import this module to determine whether the veil (帳) is active
and to read contract/scope/profile information.

Usage in hooks:
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent))
    import tobari_session

    session = tobari_session.load_session()
    if session:
        # Veil is active — blocking mode
        ...
    else:
        # No veil — legacy advisory mode
        ...
"""

import contextlib
import hashlib
import hmac as hmac_mod
import json
import os
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Cache to avoid repeated file I/O within a single hook invocation.
# Each hook runs as a separate process, so this cache is per-invocation only.
_session_cache: dict[str, Any] | None = None
_session_cache_mtime: float = 0.0
_boundary_cache: dict[str, Any] | None = None

SESSION_FILENAME = "tobari-session.json"
BOUNDARY_FILENAME = "boundary-classification.yaml"
EVIDENCE_LEDGER_FILENAME = "evidence-ledger.jsonl"
EVIDENCE_LOG_DIR = "logs"
HMAC_KEY_FILENAME = "tobari-hmac-key"
HMAC_KEY_ENV_VAR = "TOBARI_HMAC_KEY"
CHAIN_GENESIS_HASH = "0" * 64  # SHA256 zero-fill for first entry

# File locking constants
LOCK_TIMEOUT = 5.0  # seconds
LOCK_RETRY_INTERVAL = 0.05  # seconds

@contextlib.contextmanager
def _file_lock(lock_path: Path, timeout: float = LOCK_TIMEOUT):
    """Cross-platform advisory file lock using a .lock sidecar file.

    Uses msvcrt on Windows, fcntl on Unix.
    Retries with fixed interval until timeout.
    """
    lock_file = lock_path.parent / (lock_path.name + ".lock")
    fd = None
    start = time.monotonic()

    try:
        while True:
            try:
                fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR)
                if sys.platform == "win32":
                    import msvcrt
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break  # Lock acquired
            except (OSError, IOError):
                if fd is not None:
                    os.close(fd)
                    fd = None
                elapsed = time.monotonic() - start
                if elapsed >= timeout:
                    raise TimeoutError(
                        f"File lock timeout ({timeout}s): {lock_file}"
                    )
                time.sleep(LOCK_RETRY_INTERVAL)

        yield  # Critical section

    finally:
        if fd is not None:
            try:
                if sys.platform == "win32":
                    import msvcrt
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_UN)
            except Exception:
                pass
            os.close(fd)

def _read_modify_write_session(
    modifier: "callable",
) -> bool:
    """Read session file, apply modifier, write back — under file lock.

    Args:
        modifier: A callable that receives the session dict and mutates it.

    Returns:
        True on success, False on error.
    """
    global _session_cache, _session_cache_mtime

    session_path = _get_session_path()
    if not session_path.exists():
        return False

    try:
        with _file_lock(session_path):
            with open(session_path, encoding="utf-8") as f:
                data = json.load(f)

            if not isinstance(data, dict) or not data.get("active", False):
                return False

            modifier(data)

            with open(session_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.write("\n")

        # Invalidate cache (outside lock)
        _session_cache = None
        _session_cache_mtime = 0.0
        return True

    except (json.JSONDecodeError, OSError, TimeoutError) as e:
        print(f"Session file operation failed: {e}", file=sys.stderr)
        return False

def _get_session_path() -> Path:
    """Resolve the path to tobari-session.json."""
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    if project_dir:
        return Path(project_dir) / ".claude" / SESSION_FILENAME
    # Fallback: session file is at {project}/.claude/tobari-session.json
    # This module lives at {project}/.claude/hooks/tobari_session.py
    hooks_dir = Path(__file__).resolve().parent
    return hooks_dir.parent / SESSION_FILENAME

def load_session() -> dict[str, Any] | None:
    """Load and cache tobari-session.json.

    Returns:
        Session dict if the veil is active (file exists and active=true).
        None if the file does not exist, active=false, or on any error.
    """
    global _session_cache, _session_cache_mtime

    session_path = _get_session_path()

    if not session_path.exists():
        _session_cache = None
        return None

    try:
        mtime = session_path.stat().st_mtime
        if _session_cache is not None and mtime == _session_cache_mtime:
            return _session_cache

        with open(session_path, encoding="utf-8") as f:
            data = json.load(f)

        if not isinstance(data, dict) or not data.get("active", False):
            _session_cache = None
            return None

        _session_cache = data
        _session_cache_mtime = mtime
        return data

    except (json.JSONDecodeError, OSError, KeyError) as e:
        # File exists but is corrupted — log warning to stderr and evidence.
        # Returns None (veil treated as inactive) but records the anomaly.
        print(
            f"[tobari] WARNING: Session file exists but is corrupted: {e}",
            file=sys.stderr,
        )
        write_evidence({
            "event": "session_load_error",
            "error": str(e),
            "path": str(session_path),
        })
        _session_cache = None
        return None

def is_veil_active() -> bool:
    """Check if the veil is currently active."""
    return load_session() is not None

def get_profile() -> str | None:
    """Get the operating profile (lite/standard/strict)."""
    session = load_session()
    return session.get("profile") if session else None

def get_scope() -> dict[str, list[str]] | None:
    """Get the contract scope (include/exclude paths)."""
    session = load_session()
    if not session:
        return None
    contract = session.get("contract", {})
    return contract.get("scope")

def get_contract() -> dict[str, Any] | None:
    """Get the full contract."""
    session = load_session()
    if not session:
        return None
    return session.get("contract")

def _is_dir_prefix(path: str, prefix: str) -> bool:
    """Check if prefix is a directory-boundary-aware prefix of path.

    Returns True if:
    - path == prefix (exact match)
    - path starts with prefix + "/" (prefix is a parent directory)
    - prefix ends with "/" (already a directory indicator)

    This prevents 'home/user' from matching 'home/username/file.txt'.
    """
    if path == prefix:
        return True
    if prefix.endswith("/"):
        return path.startswith(prefix)
    return path.startswith(prefix + "/")

def is_path_in_scope(file_path: str) -> bool | None:
    """Check if a file path is within the contract scope.

    Returns:
        True if path matches an include pattern.
        False if path matches an exclude pattern or is outside all includes.
        None if no session or scope is not defined (= no restriction).

    Design: exclude takes precedence (fail-close principle).
    """
    scope = get_scope()
    if not scope:
        return None

    includes = scope.get("include", [])
    excludes = scope.get("exclude", [])

    # No scope constraints defined
    if not includes and not excludes:
        return None

    # Normalize path for cross-platform comparison
    # Use os.path.normcase() to handle Windows drive letter case (C: vs c:)
    normalized = os.path.normcase(file_path).replace("\\", "/").rstrip("/")

    # Strip project root prefix to convert absolute paths to relative
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    if project_dir:
        project_prefix = os.path.normcase(project_dir).replace("\\", "/").rstrip("/") + "/"
        if normalized.startswith(project_prefix):
            normalized = normalized[len(project_prefix):]

    # Check excludes first (deny takes precedence)
    for pattern in excludes:
        norm_pattern = os.path.normcase(pattern).replace("\\", "/").rstrip("/")
        if _is_dir_prefix(normalized, norm_pattern):
            return False

    # Check includes
    if includes:
        for pattern in includes:
            norm_pattern = os.path.normcase(pattern).replace("\\", "/").rstrip("/")
            if _is_dir_prefix(normalized, norm_pattern):
                return True
        # Path not in any include pattern = out of scope
        return False

    # Only excludes defined, path not excluded = in scope
    return True

def get_task() -> str | None:
    """Get the current task name."""
    session = load_session()
    return session.get("task") if session else None

def get_gates_passed() -> list[str]:
    """Get the list of passed STG gates."""
    session = load_session()
    if not session:
        return []
    return session.get("gates_passed", [])

def update_gates_passed(new_gate: str) -> bool:
    """Add a gate to gates_passed in tobari-session.json.

    Args:
        new_gate: Gate name (e.g., "STG1").

    Returns:
        True if successfully updated, False on error.

    Uses file lock to prevent concurrent write corruption.
    """
    def _modify(data: dict) -> None:
        gates = data.get("gates_passed", [])
        if new_gate not in gates:
            gates.append(new_gate)
            data["gates_passed"] = gates

    return _read_modify_write_session(_modify)

# --- Boundary Classification ---

def _get_boundary_path() -> Path:
    """Resolve the path to boundary-classification.yaml."""
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    if project_dir:
        return Path(project_dir) / "integration" / BOUNDARY_FILENAME
    # Fallback: {project}/integration/boundary-classification.yaml
    # This module lives at {project}/.claude/hooks/tobari_session.py
    hooks_dir = Path(__file__).resolve().parent
    return hooks_dir.parent.parent / "integration" / BOUNDARY_FILENAME

def load_boundary_classification() -> dict[str, Any] | None:
    """Load and cache boundary-classification.yaml.

    Returns parsed boundary data or None if unavailable.
    Requires pyyaml; gracefully returns None if not installed.
    """
    global _boundary_cache
    if _boundary_cache is not None:
        return _boundary_cache

    boundary_path = _get_boundary_path()
    if not boundary_path.exists():
        return None

    try:
        import yaml

        with open(boundary_path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
        _boundary_cache = data
        return data
    except ImportError:
        # pyyaml not installed: skip boundary check (fail-open)
        return None
    except Exception as e:
        # File exists but is corrupted — log warning and evidence
        print(
            f"[tobari] WARNING: Boundary file exists but is corrupted: {e}",
            file=sys.stderr,
        )
        write_evidence({
            "event": "boundary_load_error",
            "error": str(e),
            "path": str(boundary_path),
        })
        return None

def get_boundary_classification(file_path: str) -> str | None:
    """Get the boundary classification for a file path.

    Resolution order (from boundary-classification.yaml):
    1. File-level match (exact path)
    2. Longest directory prefix match
    3. None (unclassified)

    Returns: "private_only" | "sync_eligible" | "conditional" | None
    """
    data = load_boundary_classification()
    if not data:
        return None

    normalized = file_path.replace("\\", "/")
    # Strip leading ./ for consistent comparison
    if normalized.startswith("./"):
        normalized = normalized[2:]

    # 1. Check file-level overrides (exact match)
    files = data.get("files", [])
    for entry in files:
        entry_path = entry.get("path", "").replace("\\", "/")
        if entry_path.startswith("./"):
            entry_path = entry_path[2:]
        if normalized == entry_path or normalized.endswith("/" + entry_path):
            return entry.get("classification")

    # 2. Check directory-level (longest prefix match)
    directories = data.get("directories", [])
    best_match: str | None = None
    best_length = 0
    for entry in directories:
        dir_path = entry.get("path", "").replace("\\", "/")
        if dir_path.startswith("./"):
            dir_path = dir_path[2:]
        if _is_dir_prefix(normalized, dir_path):
            if len(dir_path) > best_length:
                best_match = entry.get("classification")
                best_length = len(dir_path)

    return best_match

# --- Evidence Ledger ---

def _get_evidence_dir() -> Path:
    """Resolve the path to .claude/logs/ directory."""
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    if project_dir:
        return Path(project_dir) / ".claude" / EVIDENCE_LOG_DIR
    hooks_dir = Path(__file__).resolve().parent
    return hooks_dir.parent / EVIDENCE_LOG_DIR

def _get_evidence_path() -> Path:
    """Resolve the path to .claude/logs/evidence-ledger.jsonl."""
    return _get_evidence_dir() / EVIDENCE_LEDGER_FILENAME

def _get_hmac_key() -> bytes | None:
    """Load HMAC key from environment or key file.

    Priority:
    1. TOBARI_HMAC_KEY environment variable (hex-encoded)
    2. .claude/tobari-hmac-key file
    3. Auto-generate and save to key file

    Returns key bytes, or None if generation fails (chain-only mode).
    """
    env_key = os.environ.get(HMAC_KEY_ENV_VAR, "").strip()
    if env_key:
        try:
            return bytes.fromhex(env_key)
        except ValueError:
            return env_key.encode("utf-8")

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    if project_dir:
        key_path = Path(project_dir) / ".claude" / HMAC_KEY_FILENAME
    else:
        key_path = Path(__file__).resolve().parent / HMAC_KEY_FILENAME

    if key_path.exists():
        try:
            key_hex = key_path.read_text(encoding="utf-8").strip()
            return bytes.fromhex(key_hex)
        except (ValueError, OSError):
            pass

    try:
        new_key = secrets.token_bytes(32)
        key_path.parent.mkdir(parents=True, exist_ok=True)
        key_path.write_text(new_key.hex(), encoding="utf-8")
        return new_key
    except OSError:
        return None

def _get_last_chain_state(evidence_path: Path) -> tuple[int, str]:
    """Read the last entry from evidence ledger to get chain state.

    Returns (last_index, last_hash).
    If ledger is empty or unreadable, returns (-1, CHAIN_GENESIS_HASH).
    """
    if not evidence_path.exists():
        return -1, CHAIN_GENESIS_HASH

    last_line = ""
    try:
        with open(evidence_path, encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped:
                    last_line = stripped
    except OSError:
        return -1, CHAIN_GENESIS_HASH

    if not last_line:
        return -1, CHAIN_GENESIS_HASH

    try:
        entry = json.loads(last_line)
        idx = entry.get("_chain_index", -1)
        entry_hash = hashlib.sha256(last_line.encode("utf-8")).hexdigest()
        return idx, entry_hash
    except json.JSONDecodeError:
        return -1, CHAIN_GENESIS_HASH

def _canonical_json(entry: dict) -> str:
    """Produce canonical JSON (sorted keys, no extra whitespace)."""
    return json.dumps(entry, sort_keys=True, ensure_ascii=False, separators=(",", ":"))

def write_evidence(entry: dict[str, Any]) -> bool:
    """Append an evidence entry to the JSONL ledger with hash chain + optional HMAC.

    Adds timestamp if not present. Creates directory if needed.
    Each entry gets _chain_index, _prev_hash, and optionally _hmac fields.
    Designed to be called from multiple hooks (gate, stage, evidence).
    Uses file lock to prevent interleaved writes from concurrent hooks.

    Returns True on success, False on error (fail-open: never blocks).
    """
    try:
        if "timestamp" not in entry:
            entry["timestamp"] = datetime.now(timezone.utc).isoformat()

        evidence_path = _get_evidence_path()
        evidence_path.parent.mkdir(parents=True, exist_ok=True)

        with _file_lock(evidence_path):
            # Read chain state (inside lock for atomicity)
            last_index, prev_hash = _get_last_chain_state(evidence_path)

            # Add chain fields
            entry["_chain_index"] = last_index + 1
            entry["_prev_hash"] = prev_hash

            # Compute HMAC (if key available)
            hmac_key = _get_hmac_key()
            if hmac_key:
                canonical = _canonical_json(entry)
                entry["_hmac"] = hmac_mod.new(
                    hmac_key, canonical.encode("utf-8"), hashlib.sha256
                ).hexdigest()

            with open(evidence_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        return True

    except Exception as e:
        print(
            f"[tobari] WARNING: Evidence write failed: {e}",
            file=sys.stderr,
        )
        return False

def read_evidence() -> list[dict[str, Any]]:
    """Read all entries from the evidence ledger.

    Returns a list of parsed JSONL entries.
    Skips malformed lines silently.
    """
    evidence_path = _get_evidence_path()
    if not evidence_path.exists():
        return []

    entries: list[dict[str, Any]] = []
    try:
        with open(evidence_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return entries

def summarize_evidence() -> dict[str, Any]:
    """Summarize the evidence ledger for reporting.

    Returns counts by event type, tool usage breakdown,
    and quality_gate_counts (blocking = denied operations).
    """
    entries = read_evidence()
    if not entries:
        return {"total": 0, "events": {}, "tools": {},
                "quality_gate_counts": {"blocking": 0, "high": 0}}

    events: dict[str, int] = {}
    tools: dict[str, int] = {}
    denied_count = 0

    for entry in entries:
        event = entry.get("event", "unknown")
        events[event] = events.get(event, 0) + 1

        tool = entry.get("tool_name")
        if tool:
            tools[tool] = tools.get(tool, 0) + 1

        if event == "tool_denied":
            denied_count += 1

    return {
        "total": len(entries),
        "events": events,
        "tools": tools,
        "quality_gate_counts": {
            "blocking": denied_count,
            "high": 0,
        },
    }

# --- Token Usage (token_usage) ---

def get_token_usage() -> dict[str, Any]:
    """Get current token_usage from tobari-session.json.

    Returns dict with input, output, budget fields.
    Defaults to {"input": 0, "output": 0, "budget": 500000} if not found.
    """
    session = load_session()
    if not session:
        return {"input": 0, "output": 0, "budget": 500000}
    usage = session.get("token_usage", {})
    if not isinstance(usage, dict):
        return {"input": 0, "output": 0, "budget": 500000}
    return {
        "input": int(usage.get("input", 0)),
        "output": int(usage.get("output", 0)),
        "budget": int(usage.get("budget", 500000)),
    }

def update_token_usage(delta_input: int, delta_output: int) -> dict[str, Any] | None:
    """Atomically increment token_usage in tobari-session.json.

    Args:
        delta_input: Number of input tokens to add.
        delta_output: Number of output tokens to add.

    Returns:
        Updated token_usage dict if successful, None on error or inactive session.

    Uses file lock to prevent concurrent write corruption.
    """
    result_holder: dict[str, Any] = {}

    def _modify(data: dict) -> None:
        usage = data.get("token_usage", {})
        if not isinstance(usage, dict):
            usage = {}
        new_usage = {
            "input": int(usage.get("input", 0)) + max(0, delta_input),
            "output": int(usage.get("output", 0)) + max(0, delta_output),
            "budget": int(usage.get("budget", 500000)),
        }
        data["token_usage"] = new_usage
        result_holder["usage"] = new_usage

    success = _read_modify_write_session(_modify)
    return result_holder.get("usage") if success else None

# --- Self-Repair (retry_count) ---

def get_retry_count() -> int:
    """Get current self-repair retry count from tobari-session.json.

    Returns 0 if session is inactive or field is missing.
    """
    session = load_session()
    if not session:
        return 0
    try:
        return int(session.get("retry_count", 0))
    except (TypeError, ValueError):
        return 0

def set_retry_count(count: int) -> bool:
    """Set retry_count in tobari-session.json.

    Returns True on success, False on error.
    Uses file lock to prevent concurrent write corruption.
    """
    def _modify(data: dict) -> None:
        data["retry_count"] = max(0, int(count))

    return _read_modify_write_session(_modify)

# --- Notification Utilities ---

def get_webhook_config(session: dict[str, Any]) -> str | None:
    """Read webhook URL from tobari-session.json notification config.

    Returns webhook URL string, or None if not configured or empty.
    """
    if not session:
        return None
    notification = session.get("notification", {})
    if not isinstance(notification, dict):
        return None
    url = notification.get("webhook_url")
    if url and isinstance(url, str) and url.strip():
        return url.strip()
    return None

def send_webhook(url: str, payload: dict[str, Any]) -> None:
    """Fire-and-forget HTTP POST to a webhook URL.

    Runs in a daemon thread with a 3-second timeout.
    Failures are silently recorded to the evidence ledger.
    Uses only stdlib (urllib.request) — no external dependencies.
    """
    import threading
    import urllib.request

    def _send() -> None:
        try:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=body,
                headers={
                    "Content-Type": "application/json; charset=utf-8",
                    "User-Agent": "tobari/1.0",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=3) as resp:
                resp.read()  # consume response body
        except Exception as e:
            write_evidence({
                "event": "webhook_error",
                "url": url,
                "error": str(e),
            })

    thread = threading.Thread(target=_send, daemon=True)
    thread.start()

def _get_backlog_path() -> Path:
    """Resolve the path to tasks/backlog.yaml."""
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    if project_dir:
        return Path(project_dir) / "tasks" / "backlog.yaml"
    # Fallback: {project}/tasks/backlog.yaml
    hooks_dir = Path(__file__).resolve().parent
    return hooks_dir.parent.parent / "tasks" / "backlog.yaml"

def build_context_output(
    intro_text: str,
    session_active_text: str,
    session_inactive_text: str | None = None,
) -> dict[str, Any]:
    """Build hookSpecificOutput with session context injection.

    Shared helper for PreCompact and SessionStart hooks to avoid
    duplicate session-loading and output-formatting logic.

    Args:
        intro_text: Always-injected project reference text.
        session_active_text: Text when veil is active (may contain
            {task}, {profile}, {gates} placeholders).
        session_inactive_text: Text when veil is inactive (optional).

    Returns:
        Dict suitable for JSON output as hookSpecificOutput.
    """
    context_parts = [intro_text]

    session = load_session()
    if session:
        task = session.get("task", "unknown")
        profile = session.get("profile", "standard")
        gates = session.get("gates_passed", [])
        context_parts.append(
            session_active_text.format(
                task=task, profile=profile, gates=gates,
            )
        )
    elif session_inactive_text:
        context_parts.append(session_inactive_text)

    return {
        "hookSpecificOutput": {
            "additionalContext": " ".join(context_parts)
        }
    }

def _get_git_state() -> dict[str, Any]:
    """Collect current git state for session finalization.

    Returns dict with branch, uncommitted_changes, and pr_url fields.
    Uses subprocess to run git commands; returns safe defaults on failure.
    """
    import subprocess

    result: dict[str, Any] = {
        "branch": None,
        "uncommitted_changes": False,
        "pr_url": None,
    }

    try:
        branch = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True, text=True, timeout=5,
        )
        if branch.returncode == 0:
            result["branch"] = branch.stdout.strip() or None
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    try:
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, timeout=5,
        )
        if status.returncode == 0:
            result["uncommitted_changes"] = bool(status.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    return result

def finalize_session(reason: str = "session end") -> dict[str, Any]:
    """Session end processing: update git state, summarize evidence,
    reset retry count, then raise veil.

    Called from /handoff skill or Stop hook fallback.

    Args:
        reason: Why the session is ending.

    Returns:
        Dict with status and reason.
    """
    session = load_session()
    if not session or not session.get("active"):
        return {"status": "skipped", "reason": "veil not active"}

    # 1. Git state update
    git_state = _get_git_state()

    # 2. Evidence summary
    evidence_summary = summarize_evidence()

    # 3. Update session with finalization data before raising veil
    session_path = _get_session_path()
    try:
        with _file_lock(session_path):
            with open(session_path, encoding="utf-8") as f:
                data = json.load(f)

            if isinstance(data, dict) and data.get("active"):
                data["git_state"] = git_state
                data["evidence_summary"] = evidence_summary
                data["retry_count"] = 0

                with open(session_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                    f.write("\n")

        # Invalidate cache so raise_veil reads fresh data
        global _session_cache, _session_cache_mtime
        _session_cache = None
        _session_cache_mtime = 0.0

    except (json.JSONDecodeError, OSError, TimeoutError) as e:
        print(f"[tobari] WARNING: finalize_session pre-update failed: {e}",
              file=sys.stderr)

    # 4. Raise veil (sets active=false, raised_at, raised_reason, writes evidence)
    raise_veil(reason)

    return {"status": "finalized", "reason": reason}

def raise_veil(reason: str = "session ended") -> bool:
    """Raise the veil (set active=false) with a reason and ceremony message.

    Args:
        reason: Why the veil is being raised.

    Returns:
        True if successfully raised, False on error.
    """
    session_path = _get_session_path()
    if not session_path.exists():
        return False

    try:
        with _file_lock(session_path):
            with open(session_path, encoding="utf-8") as f:
                data = json.load(f)

            if not isinstance(data, dict):
                return False

            was_active = data.get("active", False)
            data["active"] = False
            data["raised_at"] = datetime.now(timezone.utc).isoformat()
            data["raised_reason"] = reason

            with open(session_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.write("\n")

        # Invalidate cache
        global _session_cache, _session_cache_mtime
        _session_cache = None
        _session_cache_mtime = 0.0

        if was_active:
            write_evidence({
                "event": "veil_raised",
                "reason": reason,
                "task": data.get("task", "unknown"),
            })

        return True

    except (json.JSONDecodeError, OSError, TimeoutError) as e:
        print(f"[tobari] WARNING: Failed to raise veil: {e}", file=sys.stderr)
        return False

def get_raised_info() -> dict[str, str] | None:
    """Get info about when/why the veil was last raised.

    Returns dict with 'task', 'raised_at', 'raised_reason' if the session
    file exists and active=false with raised info. None otherwise.
    """
    session_path = _get_session_path()
    if not session_path.exists():
        return None

    try:
        with open(session_path, encoding="utf-8") as f:
            data = json.load(f)

        if not isinstance(data, dict):
            return None
        if data.get("active", False):
            return None  # Veil is still down

        raised_at = data.get("raised_at")
        if not raised_at:
            return None  # Old format without raised info

        return {
            "task": data.get("task", "unknown"),
            "raised_at": raised_at,
            "raised_reason": data.get("raised_reason", "unknown"),
        }
    except (json.JSONDecodeError, OSError):
        return None

def format_task_notification(task_id: str) -> str:
    """Generate GitHub PR description text from backlog.yaml task data.

    Reads the task record and formats a Japanese summary suitable for
    use as a PR body. Falls back gracefully if backlog.yaml is unavailable.
    """
    task_info: dict[str, Any] = {}
    backlog_path = _get_backlog_path()

    if backlog_path.exists():
        try:
            import yaml

            with open(backlog_path, encoding="utf-8") as f:
                data = yaml.safe_load(f)
            for task in data.get("tasks", []):
                if task.get("id") == task_id:
                    task_info = task
                    break
        except Exception:
            pass  # Fall through to minimal format

    title = task_info.get("title", task_id)
    status = task_info.get("status", "unknown")
    phase = task_info.get("phase", "")
    evidence_list = task_info.get("evidence", [])
    acceptance_list = task_info.get("acceptance", [])

    lines: list[str] = [
        f"## {task_id}: {title}",
        "",
        f"**フェーズ**: {phase}　**ステータス**: {status}",
        "",
    ]

    if acceptance_list:
        lines.append("### 受入基準")
        lines.extend(f"- {a}" for a in acceptance_list)
        lines.append("")

    lines.append("### 証跡")
    if evidence_list:
        lines.extend(f"- {e}" for e in evidence_list[:6])
    else:
        lines.append("- `.claude/logs/evidence-ledger.jsonl`")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("_Generated by tobari — Evidence Trail_")

    return "\n".join(lines)
