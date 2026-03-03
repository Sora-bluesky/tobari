#!/usr/bin/env python3
"""
Stop hook: tobari-stop — the self-repair engine (帳の脚).

Self-Repair Engine — 🦿 Leg (Stop Hook + Circuit Breaker)

Fires when Claude Code is about to stop (finish responding).

When the veil is active and test failure is detected:
- retry_count < MAX_RETRIES → decision: "block" + inject repair instructions
- retry_count >= MAX_RETRIES → Circuit Breaker fires, allow stop, report to user

When the veil is inactive or no test failure detected:
- exit 0 (no interference)

Implements the 脚 (leg) design pattern.
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import tobari_session

MAX_RETRIES = 3

# Test failure indicators in transcript messages
FAILURE_PATTERNS: list[str] = [
    r"\bFAILED\b",
    r"\b\d+\s+failed\b",
    r"AssertionError",
    r"ERRORS?\s*:\s",
    r"テスト失敗",
    r"test.*fail",
    r"returncode=[1-9]\d*",
    r"exit\s+code\s+[1-9]",
    r"Command\s+failed",
    r"Traceback \(most recent call last\)",
    r"Error: .*\n",
]

# Success indicators — if present in an entry, assume outcome is success
SUCCESS_PATTERNS: list[str] = [
    r"\b\d+\s+passed\b",
    r"\ball\s+test.*pass",
    r"\btests?\s+passed\b",
    r"\bOK\b.*\d+.*test",
    r"テスト.*成功",
    r"修正完了",
    r"実装完了",
    r"\bPASSED\b",
    r"✓\s+\d+",
]


def _extract_text(content: object) -> str:
    """Extract plain text from various content shapes."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(item.get("text", ""))
                elif "text" in item:
                    parts.append(str(item["text"]))
        return "\n".join(parts)
    return ""


def _message_text(message: dict) -> str:
    """Get text from a single transcript message."""
    return _extract_text(message.get("content", ""))


def detect_test_failure(transcript: list) -> tuple[bool, str]:
    """Detect test failure in recent transcript entries.

    Scans from most recent to oldest (up to 8 entries).
    Returns (is_failure, failure_summary).

    Design:
    - If the most recent entry with recognisable content shows success → False
    - If it shows failure → True + extract snippet
    - If neither → continue scanning backwards
    """
    if not transcript:
        return False, ""

    recent = transcript[-8:]
    failure_snippets: list[str] = []

    for entry in reversed(recent):
        if not isinstance(entry, dict):
            continue
        text = _message_text(entry)
        if not text.strip():
            continue

        # Check both patterns per entry — failure takes precedence over success.
        # "1 failed, 2 passed" → failure (not pure success).
        has_failure = any(
            re.search(p, text, re.IGNORECASE) for p in FAILURE_PATTERNS
        )
        has_success = (
            not has_failure
            and any(re.search(p, text, re.IGNORECASE) for p in SUCCESS_PATTERNS)
        )

        if has_failure:
            # Extract representative snippet
            lines = text.split("\n")
            for pattern in FAILURE_PATTERNS:
                if re.search(pattern, text, re.IGNORECASE):
                    for line in lines[:50]:
                        if re.search(pattern, line, re.IGNORECASE):
                            snippet = line.strip()[:200]
                            if snippet and snippet not in failure_snippets:
                                failure_snippets.append(snippet)
                    break
            summary = (
                "\n".join(failure_snippets[:5])
                if failure_snippets
                else "テスト失敗を検出"
            )
            return True, summary

        if has_success:
            # Pure success in this entry → most recent outcome is success
            return False, ""

    return False, ""


def _load_transcript(data: dict) -> list:
    """Load transcript from hook input data.

    Supports both inline 'transcript' array and 'transcript_path' file.
    """
    inline = data.get("transcript")
    if isinstance(inline, list):
        return inline

    path = data.get("transcript_path")
    if path:
        try:
            with open(path, encoding="utf-8") as f:
                content = json.load(f)
            if isinstance(content, list):
                return content
            if isinstance(content, dict):
                return content.get("messages", content.get("transcript", []))
        except (OSError, json.JSONDecodeError):
            pass

    return []


def _make_repair_instruction(retry_count: int, failure_summary: str, task: str) -> str:
    """Build Japanese repair instruction injected into Claude."""
    attempt = retry_count + 1
    return (
        f"🦿 帳 [{task}] — テスト失敗を検出（試行 {attempt}/{MAX_RETRIES}）\n\n"
        f"検出されたエラー:\n{failure_summary}\n\n"
        f"自動修復を実行してください:\n"
        f"1. エラーメッセージを分析して根本原因を特定\n"
        f"2. 該当するコードを修正\n"
        f"3. テストを再実行して成功を確認"
    )


def _make_circuit_breaker_message(failure_summary: str, task: str) -> str:
    """Build Japanese Circuit Breaker escalation message."""
    return (
        f"⚠️ 帳 [{task}] — 自己修復の限界に達しました"
        f"（{MAX_RETRIES}/{MAX_RETRIES}回失敗）\n\n"
        f"最後に検出されたエラー:\n{failure_summary}\n\n"
        f"手動での対応が必要です:\n"
        f"1. エラーの詳細を確認: .claude/logs/evidence-ledger.jsonl\n"
        f"2. テストファイルを直接確認して問題を特定\n"
        f"3. 修正後に作業を再開してください"
    )


def main() -> None:
    try:
        data = json.load(sys.stdin)

        # stop_hook_active guard: prevent infinite loops
        if data.get("stop_hook_active", False):
            sys.exit(0)

        # Veil inactive: no interference
        session = tobari_session.load_session()
        if not session:
            sys.exit(0)

        task = tobari_session.get_task() or "unknown"

        # Analyse transcript for test failures
        transcript = _load_transcript(data)
        is_failure, failure_summary = detect_test_failure(transcript)

        if not is_failure:
            sys.exit(0)

        # Test failure detected — apply Circuit Breaker logic
        retry_count = tobari_session.get_retry_count()

        if retry_count < MAX_RETRIES:
            # Block stop and inject repair instructions
            tobari_session.set_retry_count(retry_count + 1)
            tobari_session.write_evidence({
                "event": "self_repair_attempt",
                "attempt": retry_count + 1,
                "max_retries": MAX_RETRIES,
                "task": task,
                "failure_summary": failure_summary[:500],
            })
            reason = _make_repair_instruction(retry_count, failure_summary, task)
            print(json.dumps({"decision": "block", "reason": reason},
                             ensure_ascii=False))
            sys.exit(0)

        else:
            # Circuit Breaker triggered — reset and allow stop
            tobari_session.set_retry_count(0)
            tobari_session.write_evidence({
                "event": "circuit_breaker_triggered",
                "attempts": MAX_RETRIES,
                "task": task,
                "failure_summary": failure_summary[:500],
            })

            # Optional emergency webhook
            webhook_url = tobari_session.get_webhook_config(session)
            if webhook_url:
                tobari_session.send_webhook(webhook_url, {
                    "event": "circuit_breaker_triggered",
                    "task": task,
                    "attempts": MAX_RETRIES,
                    "failure_summary": failure_summary[:200],
                })

            # Surface Circuit Breaker message to user via stderr
            print(_make_circuit_breaker_message(failure_summary, task),
                  file=sys.stderr)
            sys.exit(0)

    except Exception as e:
        # Fail-open: hook errors must never block Claude
        print(f"tobari-stop error: {e}", file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
