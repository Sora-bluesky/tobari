#!/usr/bin/env python3
"""
PostToolUse hook: tobari-cost — the cost monitor (帳の財布, 👛).

Cost Monitor — 👛 Wallet (PostToolUse async + Token Budget)

Fires after each tool completion (PostToolUse = non-blocking for main flow).

When the veil is active:
- Estimates token usage from tool input/output content size
  (or reads explicit token data if provided by the tool response)
- Atomically updates token_usage in tobari-session.json
- Checks budget thresholds:
    50%  → logs to evidence ledger only (silent)
    80%  → warns user via hookSpecificOutput.feedback
    100% → strong warning + budget_exceeded event in evidence

When the veil is inactive: exit 0 (no interference).

Design:
- Fail-open: hook errors never block tool execution
- Non-blocking: PostToolUse hooks run after tool completion
- Async: estimation + update is fast (no network, minimal I/O)

Unified hook for permission decisions.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import tobari_session

# Token estimation: ~4 chars per token (rough approximation for mixed JP/EN text)
CHARS_PER_TOKEN = 4

# Budget thresholds
THRESHOLD_LOG = 0.50   # 50%: log to evidence only
THRESHOLD_WARN = 0.80  # 80%: display warning
THRESHOLD_STOP = 1.00  # 100%: strong warning + evidence flag

def estimate_tokens(
    tool_input: dict,
    tool_response: dict,
) -> tuple[int, int]:
    """Estimate input/output tokens from tool data.

    First checks for explicit token usage in tool_response (Task tool may provide this).
    Falls back to content-size estimation using CHARS_PER_TOKEN.

    Returns:
        (input_tokens, output_tokens) — both >= 1.
    """
    # Check for explicit usage data
    usage = tool_response.get("usage") or tool_response.get("token_usage")
    if usage and isinstance(usage, dict):
        in_tok = usage.get("input_tokens") or usage.get("input") or 0
        out_tok = usage.get("output_tokens") or usage.get("output") or 0
        if in_tok > 0 or out_tok > 0:
            return int(in_tok), int(out_tok)

    # Estimate from content size
    input_text = json.dumps(tool_input, ensure_ascii=False)

    content = (
        tool_response.get("content")
        or tool_response.get("output")
        or tool_response.get("stdout")
        or ""
    )
    if isinstance(content, str):
        output_text = content
    elif isinstance(content, list):
        output_text = json.dumps(content, ensure_ascii=False)
    else:
        output_text = ""

    input_tokens = max(1, len(input_text) // CHARS_PER_TOKEN)
    output_tokens = max(1, len(output_text) // CHARS_PER_TOKEN)
    return input_tokens, output_tokens

def calc_percent(usage: dict) -> float:
    """Calculate budget usage as a fraction (0.0 – N.N).

    Returns 0.0 if budget is 0 (avoid division by zero).
    """
    total = usage.get("input", 0) + usage.get("output", 0)
    budget = usage.get("budget", 500000)
    if budget <= 0:
        return 0.0
    return total / budget

def build_warning_message(percent: float, usage: dict) -> str:
    """Build Japanese warning message for budget threshold."""
    total = usage.get("input", 0) + usage.get("output", 0)
    budget = usage.get("budget", 0)
    remaining = max(0, budget - total)

    if percent >= THRESHOLD_STOP:
        return (
            f"⚠️ 帳[👛財布] トークン予算が上限に達しました（{percent * 100:.1f}%使用済み）\n"
            f"消費: {total:,} / 予算: {budget:,} トークン\n"
            f"このセッションの作業を完了し、新しいセッションを開始してください。"
        )
    else:
        return (
            f"⚠️ 帳[👛財布] トークン予算警告（{percent * 100:.1f}%使用済み）\n"
            f"残り約 {remaining:,} トークン（予算: {budget:,} トークン）\n"
            f"作業をなるべく効率的に進めてください。"
        )

def run_hook() -> None:
    """PostToolUse hook: track token usage and check budget thresholds."""
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    tool_response = data.get("tool_response", {})

    # Only track when veil is active
    session = tobari_session.load_session()
    if not session:
        sys.exit(0)

    # Estimate token usage for this tool call
    delta_input, delta_output = estimate_tokens(tool_input, tool_response)

    # Atomically update session token_usage
    updated = tobari_session.update_token_usage(delta_input, delta_output)
    if updated is None:
        # Session update failed — fail-open, do not block
        sys.exit(0)

    percent = calc_percent(updated)

    # Threshold routing
    if percent >= THRESHOLD_STOP:
        # 100%: strong warning + evidence event
        tobari_session.write_evidence({
            "event": "budget_exceeded",
            "tool_name": tool_name,
            "token_usage": updated,
            "percent": round(percent * 100, 1),
        })
        message = build_warning_message(percent, updated)
        print(json.dumps(
            {"hookSpecificOutput": {"feedback": message}},
            ensure_ascii=False,
        ))

    elif percent >= THRESHOLD_WARN:
        # 80%: warning display
        tobari_session.write_evidence({
            "event": "budget_warning",
            "tool_name": tool_name,
            "token_usage": updated,
            "percent": round(percent * 100, 1),
        })
        message = build_warning_message(percent, updated)
        print(json.dumps(
            {"hookSpecificOutput": {"feedback": message}},
            ensure_ascii=False,
        ))

    elif percent >= THRESHOLD_LOG:
        # 50%: log to evidence ledger only (silent)
        tobari_session.write_evidence({
            "event": "budget_halfway",
            "tool_name": tool_name,
            "token_usage": updated,
            "percent": round(percent * 100, 1),
        })

    # Below 50%: no action needed
    sys.exit(0)

def main() -> None:
    """PostToolUse hook entry point."""
    run_hook()

if __name__ == "__main__":
    main()
