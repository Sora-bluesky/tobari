#!/usr/bin/env python3
"""
Tobari Stage Controller — ✅ 進む (auto-advance).

Validates DoD (Definition of Done) conditions for each STG gate and
auto-advances stage_status in backlog.yaml + gates_passed in tobari-session.json.

Usage (CLI):
    python tobari_stage.py advance TASK-NNN STG1
    python tobari_stage.py check   TASK-NNN STG2   # dry-run
    python tobari_stage.py summary TASK-NNN
    python tobari_stage.py next    TASK-NNN

Usage (library):
    from tobari_stage import advance_gate, check_dod, get_stage_summary
    result = advance_gate("TASK-NNN", "STG1")
"""

import argparse
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Import shared session reader
sys.path.insert(0, str(Path(__file__).parent))
import tobari_session

# --- Constants ---

GATE_ORDER = ["STG0", "STG1", "STG2", "STG3", "STG4", "STG5", "STG6"]

GATE_SKIP_RULES: dict[str, set[str]] = {
    "lite": {"STG1", "STG4"},
    "standard": set(),
    "strict": set(),
}

VALID_STATUSES = {"pending", "in_progress", "done"}

BACKLOG_FILENAME = "tasks/backlog.yaml"

# --- Data Types ---

@dataclass
class DoDCondition:
    """A single DoD condition check result."""
    name: str
    satisfied: bool
    evidence: str = ""
    check_type: str = "auto"  # "auto" | "file_check" | "command" | "manual"

@dataclass
class DoDResult:
    """Result of checking all DoD conditions for a gate."""
    gate: str
    satisfied: bool
    conditions: list[DoDCondition] = field(default_factory=list)
    fail_reason: str | None = None

@dataclass
class AdvanceResult:
    """Result of attempting to advance a gate."""
    success: bool
    gate: str
    task_id: str
    action: str = ""  # "advanced" | "fail-close" | "skipped" | "checked"
    previous_status: str = ""
    new_status: str = ""
    message: str = ""
    fail_reason: str | None = None
    required_actions: list[str] = field(default_factory=list)
    evidence_data: dict = field(default_factory=dict)
    skipped: bool = False

# --- Backlog YAML I/O ---

def _get_backlog_path() -> Path:
    """Resolve the path to tasks/backlog.yaml."""
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    if project_dir:
        return Path(project_dir) / BACKLOG_FILENAME
    hooks_dir = Path(__file__).resolve().parent
    return hooks_dir.parent.parent / BACKLOG_FILENAME

def _load_backlog() -> list[dict[str, Any]] | None:
    """Load backlog.yaml and return the tasks list."""
    backlog_path = _get_backlog_path()
    if not backlog_path.exists():
        return None
    try:
        import yaml
        with open(backlog_path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
        if isinstance(data, dict) and "tasks" in data:
            return data["tasks"]
        return None
    except Exception:
        return None

def _find_task(tasks: list[dict], task_id: str) -> dict | None:
    """Find a task by ID in the tasks list."""
    for task in tasks:
        if task.get("id") == task_id:
            return task
    return None

def _update_stage_status_line(task_id: str, gate: str, new_status: str) -> bool:
    """Update a single STG gate status in backlog.yaml using line-based editing.

    Preserves YAML formatting (quotes, indentation) for sync-task-breakdown.ps1
    compatibility.

    Algorithm:
    1. Read file as lines
    2. Find line matching `- id: "{task_id}"`
    3. From that position, scan forward for the target gate line
    4. Replace the status value on that line
    5. Write back all lines
    6. Verify with yaml.safe_load()

    Returns True on success, False on failure (with rollback).
    """
    backlog_path = _get_backlog_path()
    if not backlog_path.exists():
        return False

    try:
        with open(backlog_path, encoding="utf-8") as f:
            original_content = f.read()
        lines = original_content.split("\n")

        # Find the task block
        task_line_idx = -1
        task_id_pattern = re.compile(
            r'^  - id:\s*"?' + re.escape(task_id) + r'"?\s*$'
        )
        for i, line in enumerate(lines):
            if task_id_pattern.match(line):
                task_line_idx = i
                break

        if task_line_idx < 0:
            return False

        # Find the gate line within this task's stage_status block
        # Look for `      {gate}: "..."` pattern (6-space indent)
        gate_pattern = re.compile(
            r'^(\s+)' + re.escape(gate) + r':\s*"([^"]*)"'
        )
        gate_line_idx = -1
        # Scan from task line to next task (or end of file)
        for i in range(task_line_idx + 1, len(lines)):
            # Stop at next task entry
            if re.match(r'^  - id:', lines[i]):
                break
            match = gate_pattern.match(lines[i])
            if match:
                gate_line_idx = i
                break

        if gate_line_idx < 0:
            return False

        # Replace the status value, preserving indentation
        match = gate_pattern.match(lines[gate_line_idx])
        indent = match.group(1)
        lines[gate_line_idx] = f'{indent}{gate}: "{new_status}"'

        # Write back
        new_content = "\n".join(lines)
        with open(backlog_path, "w", encoding="utf-8") as f:
            f.write(new_content)

        # Verify: re-read with yaml.safe_load and check
        import yaml
        with open(backlog_path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
        tasks = data.get("tasks", [])
        task = _find_task(tasks, task_id)
        if not task:
            # Rollback
            with open(backlog_path, "w", encoding="utf-8") as f:
                f.write(original_content)
            return False

        actual_status = task.get("stage_status", {}).get(gate)
        if actual_status != new_status:
            # Rollback
            with open(backlog_path, "w", encoding="utf-8") as f:
                f.write(original_content)
            return False

        return True

    except Exception as e:
        # Attempt rollback on any error
        try:
            with open(backlog_path, "w", encoding="utf-8") as f:
                f.write(original_content)
        except Exception:
            pass
        print(f"Stage update error: {e}", file=sys.stderr)
        return False

# --- DoD Check Functions ---

def _check_stg0(task_id: str, task_data: dict, session: dict | None) -> DoDResult:
    """Check STG0 DoD: Requirements confirmed."""
    conditions = []

    # 1. Session exists and active
    conditions.append(DoDCondition(
        name="session_active",
        satisfied=session is not None,
        evidence="tobari-session.json exists and active=true" if session else "no active session",
        check_type="file_check",
    ))

    # 2. Contract populated (requirements + dod)
    contract = session.get("contract", {}) if session else {}
    requirements = contract.get("requirements", {})
    dod = contract.get("dod", [])
    has_contract = bool(requirements.get("do")) and bool(dod)
    conditions.append(DoDCondition(
        name="contract_populated",
        satisfied=has_contract,
        evidence=f"requirements.do={len(requirements.get('do', []))} items, dod={len(dod)} items",
        check_type="file_check",
    ))

    # 3. Profile selected
    profile = session.get("profile") if session else None
    conditions.append(DoDCondition(
        name="profile_selected",
        satisfied=bool(profile),
        evidence=f"profile={profile}" if profile else "no profile",
        check_type="file_check",
    ))

    all_satisfied = all(c.satisfied for c in conditions)
    fail_reason = None
    if not all_satisfied:
        failed = [c.name for c in conditions if not c.satisfied]
        fail_reason = f"STG0 未達条件: {', '.join(failed)}"

    return DoDResult(gate="STG0", satisfied=all_satisfied,
                     conditions=conditions, fail_reason=fail_reason)

def _check_stg1(task_id: str, task_data: dict, session: dict | None,
                profile: str) -> DoDResult:
    """Check STG1 DoD: Design approach decided."""
    if profile == "lite":
        return DoDResult(
            gate="STG1", satisfied=True,
            conditions=[DoDCondition("lite_skip", True,
                                     "Lite profile: STG1 skipped", "auto")],
        )

    conditions = []
    evidence_list = task_data.get("evidence", [])
    has_evidence = len(evidence_list) > 0
    conditions.append(DoDCondition(
        name="design_evidence_exists",
        satisfied=has_evidence,
        evidence=f"evidence entries: {len(evidence_list)}",
        check_type="file_check",
    ))

    all_satisfied = all(c.satisfied for c in conditions)
    fail_reason = None
    if not all_satisfied:
        fail_reason = "設計の証跡が evidence に存在しません"

    return DoDResult(gate="STG1", satisfied=all_satisfied,
                     conditions=conditions, fail_reason=fail_reason)

def _check_stg2(task_id: str, task_data: dict, session: dict | None,
                profile: str) -> DoDResult:
    """Check STG2 DoD: Implementation complete."""
    conditions = []
    evidence_list = task_data.get("evidence", [])

    # Check evidence exists for implementation
    has_impl_evidence = len(evidence_list) > 0
    conditions.append(DoDCondition(
        name="implementation_evidence",
        satisfied=has_impl_evidence,
        evidence=f"evidence entries: {len(evidence_list)}",
        check_type="file_check",
    ))

    all_satisfied = all(c.satisfied for c in conditions)
    fail_reason = None
    if not all_satisfied:
        fail_reason = "実装の証跡が evidence に存在しません"

    return DoDResult(gate="STG2", satisfied=all_satisfied,
                     conditions=conditions, fail_reason=fail_reason)

def _check_stg3(task_id: str, task_data: dict, session: dict | None,
                profile: str) -> DoDResult:
    """Check STG3 DoD: Verification (tests + lint)."""
    conditions = []
    evidence_list = task_data.get("evidence", [])

    # Check for verification evidence (test results, lint results)
    verification_keywords = ["test", "lint", "verify", "verification",
                             "check", "pass", "PASS"]
    has_verification = any(
        any(kw.lower() in str(e).lower() for kw in verification_keywords)
        for e in evidence_list
    )
    conditions.append(DoDCondition(
        name="verification_evidence",
        satisfied=has_verification,
        evidence="verification evidence found" if has_verification else "no verification evidence",
        check_type="file_check",
    ))

    all_satisfied = all(c.satisfied for c in conditions)
    fail_reason = None
    if not all_satisfied:
        fail_reason = "テスト/lint の検証証跡が evidence に存在しません"

    return DoDResult(gate="STG3", satisfied=all_satisfied,
                     conditions=conditions, fail_reason=fail_reason)

def _check_stg4(task_id: str, task_data: dict, session: dict | None,
                profile: str) -> DoDResult:
    """Check STG4 DoD: CI/CD automation."""
    if profile == "lite":
        return DoDResult(
            gate="STG4", satisfied=True,
            conditions=[DoDCondition("lite_skip", True,
                                     "Lite profile: STG4 skipped", "auto")],
        )

    conditions = []
    evidence_list = task_data.get("evidence", [])

    # Check for CI evidence (PR number, CI results, workflow)
    ci_keywords = ["CI", "PR #", "PR#", "workflow", "actions", "green",
                   "boundary-check", "task-breakdown-sync", "merged"]
    has_ci = any(
        any(kw.lower() in str(e).lower() for kw in ci_keywords)
        for e in evidence_list
    )

    # Fallback: if no CI configured, STG3 results substitute ( )
    stg3_status = task_data.get("stage_status", {}).get("STG3")
    if not has_ci and stg3_status == "done":
        conditions.append(DoDCondition(
            name="ci_substitute_stg3",
            satisfied=True,
            evidence="CI not configured; STG3 results substitute ( )",
            check_type="auto",
        ))
    else:
        conditions.append(DoDCondition(
            name="ci_evidence",
            satisfied=has_ci,
            evidence="CI evidence found" if has_ci else "no CI evidence",
            check_type="file_check",
        ))

    all_satisfied = all(c.satisfied for c in conditions)
    fail_reason = None
    if not all_satisfied:
        fail_reason = "CI チェックの証跡が evidence に存在しません"

    return DoDResult(gate="STG4", satisfied=all_satisfied,
                     conditions=conditions, fail_reason=fail_reason)

def _check_stg5(task_id: str, task_data: dict, session: dict | None,
                profile: str) -> DoDResult:
    """Check STG5 DoD: Commit/Push."""
    conditions = []
    evidence_list = task_data.get("evidence", [])

    # Check for commit/push evidence
    commit_keywords = ["commit", "push", "git"]
    has_commit = any(
        any(kw.lower() in str(e).lower() for kw in commit_keywords)
        for e in evidence_list
    )
    conditions.append(DoDCondition(
        name="commit_push_evidence",
        satisfied=has_commit,
        evidence="commit/push evidence found" if has_commit else "no commit/push evidence",
        check_type="file_check",
    ))

    all_satisfied = all(c.satisfied for c in conditions)
    fail_reason = None
    if not all_satisfied:
        fail_reason = "コミット/push の証跡が evidence に存在しません"

    return DoDResult(gate="STG5", satisfied=all_satisfied,
                     conditions=conditions, fail_reason=fail_reason)

def _check_stg6(task_id: str, task_data: dict, session: dict | None,
                profile: str) -> DoDResult:
    """Check STG6 DoD: PR/Merge."""
    conditions = []
    evidence_list = task_data.get("evidence", [])

    # Check for PR/merge evidence
    pr_keywords = ["PR #", "PR#", "merged", "merge"]
    has_pr = any(
        any(kw in str(e) for kw in pr_keywords)
        for e in evidence_list
    )
    conditions.append(DoDCondition(
        name="pr_merge_evidence",
        satisfied=has_pr,
        evidence="PR/merge evidence found" if has_pr else "no PR/merge evidence",
        check_type="file_check",
    ))

    all_satisfied = all(c.satisfied for c in conditions)
    fail_reason = None
    if not all_satisfied:
        fail_reason = "PR/マージの証跡が evidence に存在しません"

    return DoDResult(gate="STG6", satisfied=all_satisfied,
                     conditions=conditions, fail_reason=fail_reason)

# DoD checker dispatch table
_DOD_CHECKERS = {
    "STG0": lambda tid, td, s, p: _check_stg0(tid, td, s),
    "STG1": _check_stg1,
    "STG2": _check_stg2,
    "STG3": _check_stg3,
    "STG4": _check_stg4,
    "STG5": _check_stg5,
    "STG6": _check_stg6,
}

# --- Public API ---

def get_current_stage(task_id: str) -> str | None:
    """Get the current active STG gate for a task.

    Returns the first non-'done' gate (e.g., 'STG2' if STG0,STG1 are done).
    Returns None if all gates are done or task not found.
    """
    tasks = _load_backlog()
    if not tasks:
        return None
    task = _find_task(tasks, task_id)
    if not task:
        return None

    stage_status = task.get("stage_status", {})
    for gate in GATE_ORDER:
        if stage_status.get(gate) != "done":
            return gate
    return None  # All done

def check_dod(task_id: str, gate: str) -> DoDResult:
    """Check DoD conditions for a specific gate (dry-run, no modifications)."""
    if gate not in GATE_ORDER:
        return DoDResult(gate=gate, satisfied=False,
                         fail_reason=f"無効なゲート名: {gate}")

    tasks = _load_backlog()
    if not tasks:
        return DoDResult(gate=gate, satisfied=False,
                         fail_reason="tasks/backlog.yaml が見つかりません")

    task = _find_task(tasks, task_id)
    if not task:
        return DoDResult(gate=gate, satisfied=False,
                         fail_reason=f"タスク {task_id} が backlog.yaml に存在しません")

    session = tobari_session.load_session()
    profile = (session.get("profile") if session else None) or "standard"

    checker = _DOD_CHECKERS.get(gate)
    if not checker:
        return DoDResult(gate=gate, satisfied=False,
                         fail_reason=f"ゲート {gate} のチェッカーが未実装です")

    return checker(task_id, task, session, profile)

def advance_gate(task_id: str, gate: str) -> AdvanceResult:
    """Attempt to advance a gate to 'done'.

    Validates:
      1. Previous gate is done (sequential ordering)
      2. Gate is not already done
      3. DoD conditions are met (or gate is skipped per profile)

    On success: updates backlog.yaml + tobari-session.json.
    On failure: fail-close with reason and required actions.
    """
    if gate not in GATE_ORDER:
        return AdvanceResult(
            success=False, gate=gate, task_id=task_id, action="fail-close",
            message=f"無効なゲート名: {gate}",
            fail_reason=f"無効なゲート名: {gate}",
        )

    tasks = _load_backlog()
    if not tasks:
        return AdvanceResult(
            success=False, gate=gate, task_id=task_id, action="fail-close",
            message="tasks/backlog.yaml が見つかりません",
            fail_reason="tasks/backlog.yaml が見つかりません",
        )

    task = _find_task(tasks, task_id)
    if not task:
        return AdvanceResult(
            success=False, gate=gate, task_id=task_id, action="fail-close",
            message=f"タスク {task_id} が backlog.yaml に存在しません",
            fail_reason=f"タスク {task_id} が backlog.yaml に存在しません",
        )

    stage_status = task.get("stage_status", {})
    current_status = stage_status.get(gate, "pending")

    # Check: gate not already done
    if current_status == "done":
        return AdvanceResult(
            success=False, gate=gate, task_id=task_id, action="fail-close",
            previous_status="done", new_status="done",
            message=f"{gate} は既に完了しています",
            fail_reason=f"{gate} は既に完了しています",
        )

    # Check: previous gate is done (sequential ordering)
    gate_idx = GATE_ORDER.index(gate)
    if gate_idx > 0:
        prev_gate = GATE_ORDER[gate_idx - 1]
        prev_status = stage_status.get(prev_gate, "pending")
        if prev_status != "done":
            return AdvanceResult(
                success=False, gate=gate, task_id=task_id, action="fail-close",
                previous_status=current_status,
                message=f"{prev_gate} が完了していないため、{gate} に進めません",
                fail_reason=f"{prev_gate} が完了していないため、{gate} に進めません",
                required_actions=[
                    f"先に {prev_gate} を完了してください",
                    f"python .claude/hooks/tobari_stage.py advance {task_id} {prev_gate}",
                ],
            )

    # Check: profile-based skip
    session = tobari_session.load_session()
    profile = (session.get("profile") if session else None) or "standard"
    should_skip = gate in GATE_SKIP_RULES.get(profile, set())

    # Check DoD (even for skipped gates, we use the skip-aware checker)
    dod_result = check_dod(task_id, gate)

    if not dod_result.satisfied and not should_skip:
        return AdvanceResult(
            success=False, gate=gate, task_id=task_id, action="fail-close",
            previous_status=current_status,
            message=f"{gate} の DoD が未達です",
            fail_reason=dod_result.fail_reason,
            required_actions=[
                dod_result.fail_reason or "DoD 条件を満たしてください",
                f"修正後: python .claude/hooks/tobari_stage.py advance {task_id} {gate}",
            ],
        )

    # --- Execute transition ---

    # 1. Update backlog.yaml
    if not _update_stage_status_line(task_id, gate, "done"):
        return AdvanceResult(
            success=False, gate=gate, task_id=task_id, action="fail-close",
            previous_status=current_status,
            message="backlog.yaml の更新に失敗しました",
            fail_reason="backlog.yaml の更新に失敗しました（書き込みエラー）",
        )

    # 2. Update tobari-session.json gates_passed
    if session:
        if not tobari_session.update_gates_passed(gate):
            # Rollback backlog.yaml
            _update_stage_status_line(task_id, gate, current_status)
            return AdvanceResult(
                success=False, gate=gate, task_id=task_id, action="fail-close",
                previous_status=current_status,
                message="tobari-session.json の更新に失敗しました（backlog.yaml をロールバック済み）",
                fail_reason="tobari-session.json の更新に失敗しました",
            )

    # Build evidence data and write to Evidence Ledger (📋 残す)
    now = datetime.now(timezone.utc).isoformat()
    next_gate = GATE_ORDER[gate_idx + 1] if gate_idx < len(GATE_ORDER) - 1 else None
    evidence_data = {
        "timestamp": now,
        "event": "gate_advanced",
        "task_id": task_id,
        "gate": gate,
        "profile": profile,
        "skipped": should_skip,
        "conditions_checked": len(dod_result.conditions),
        "conditions_passed": sum(1 for c in dod_result.conditions if c.satisfied),
    }
    tobari_session.write_evidence(evidence_data)

    action = "skipped" if should_skip else "advanced"
    next_msg = f"次のゲート: {next_gate}" if next_gate else "全ゲート完了"

    return AdvanceResult(
        success=True, gate=gate, task_id=task_id, action=action,
        previous_status=current_status, new_status="done",
        message=f"{gate} → done. {next_msg}",
        evidence_data=evidence_data,
        skipped=should_skip,
    )

def advance_to_next(task_id: str) -> AdvanceResult:
    """Attempt to advance to the next eligible gate.

    Finds the current (first non-done) gate, checks DoD, advances if met.
    """
    current = get_current_stage(task_id)
    if current is None:
        return AdvanceResult(
            success=False, gate="", task_id=task_id, action="fail-close",
            message=f"タスク {task_id} の全ゲートが完了済みか、タスクが見つかりません",
            fail_reason="進むべきゲートがありません",
        )
    return advance_gate(task_id, current)

def get_stage_summary(task_id: str) -> dict:
    """Get a summary of all gate statuses for a task."""
    tasks = _load_backlog()
    if not tasks:
        return {"error": "tasks/backlog.yaml が見つかりません"}

    task = _find_task(tasks, task_id)
    if not task:
        return {"error": f"タスク {task_id} が backlog.yaml に存在しません"}

    stage_status = task.get("stage_status", {})
    session = tobari_session.load_session()
    profile = (session.get("profile") if session else None) or "standard"
    skip_gates = GATE_SKIP_RULES.get(profile, set())

    gates = []
    current_gate = None
    for gate in GATE_ORDER:
        status = stage_status.get(gate, "pending")
        is_skip = gate in skip_gates
        if status != "done" and current_gate is None:
            current_gate = gate
        gates.append({
            "gate": gate,
            "status": status,
            "skip": is_skip,
        })

    done_count = sum(1 for g in gates if g["status"] == "done")
    return {
        "task_id": task_id,
        "title": task.get("title", ""),
        "profile": profile,
        "current_gate": current_gate,
        "progress": f"{done_count}/{len(GATE_ORDER)}",
        "gates": gates,
        "veil_active": session is not None,
    }

# --- CLI Entry Point ---

def _output_json(data: Any) -> None:
    """Print JSON to stdout."""
    print(json.dumps(data, ensure_ascii=False, indent=2))

def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Tobari Stage Controller — STG gate auto-advance"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # advance: DoD check + transition
    p_advance = subparsers.add_parser("advance", help="Advance a gate to done")
    p_advance.add_argument("task_id", help="Task ID (e.g., TASK-NNN)")
    p_advance.add_argument("gate", help="Gate name (e.g., STG1)")

    # check: DoD check only (dry-run)
    p_check = subparsers.add_parser("check", help="Check DoD conditions (dry-run)")
    p_check.add_argument("task_id", help="Task ID (e.g., TASK-NNN)")
    p_check.add_argument("gate", help="Gate name (e.g., STG1)")

    # summary: all gate statuses
    p_summary = subparsers.add_parser("summary", help="Show all gate statuses")
    p_summary.add_argument("task_id", help="Task ID (e.g., TASK-NNN)")

    # next: auto-detect and advance next gate
    p_next = subparsers.add_parser("next", help="Advance to the next eligible gate")
    p_next.add_argument("task_id", help="Task ID (e.g., TASK-NNN)")

    args = parser.parse_args()

    if args.command == "advance":
        result = advance_gate(args.task_id, args.gate)
        _output_json(asdict(result))
        sys.exit(0 if result.success else 1)

    elif args.command == "check":
        result = check_dod(args.task_id, args.gate)
        _output_json(asdict(result))
        sys.exit(0 if result.satisfied else 1)

    elif args.command == "summary":
        summary = get_stage_summary(args.task_id)
        _output_json(summary)
        sys.exit(0)

    elif args.command == "next":
        result = advance_to_next(args.task_id)
        _output_json(asdict(result))
        sys.exit(0 if result.success else 1)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        _output_json({
            "success": False,
            "error": str(e),
            "message": f"Stage Controller でエラーが発生しました: {e}",
        })
        sys.exit(1)
