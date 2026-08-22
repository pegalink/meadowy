#!/usr/bin/env python3
"""Model quality smoke test.

Point it at any model — Pollinations or a custom OpenAI-compatible endpoint
(same two "kinds" app.py understands) — and it runs a small, fixed suite of
cheap probes covering a few different skills (arithmetic, structured output,
literal instruction-following, factual recall, basic code generation) and
prints a pass/fail scorecard.

Deliberately NOT an LLM-as-judge: every check is a deterministic string/JSON/
exec assertion, and each prompt caps `max_tokens` low, so a full run is a
handful of short requests — cheap enough to run per model without worrying
about token spend.

Usage:
    python3 tests/model_quality.py --model openai
    python3 tests/model_quality.py --model gpt-4o-mini --kind custom \\
        --base-url https://api.openai.com/v1 --api-key sk-...
    python3 tests/model_quality.py --model openai --json

Env vars (used as fallbacks so a key never has to sit in shell history):
    POLLINATIONS_API_BASE   default base for --kind pollinations
    POLLINATIONS_API_KEY    bearer token for --kind pollinations
    MEADOWS_API_KEY         bearer token for --kind custom
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request

DEFAULT_POLLINATIONS_BASE = os.environ.get("POLLINATIONS_API_BASE", "https://gen.pollinations.ai")
REQUEST_TIMEOUT = 60


# ---------------------------------------------------------------------------
# Tiny HTTP helper (stdlib only — no need to require `requests` for a CLI
# script that may run outside the app's venv).
# ---------------------------------------------------------------------------


def chat(base_url, api_key, model, messages, timeout=REQUEST_TIMEOUT):
    """POST {base_url}/chat/completions, OpenAI-compatible, non-streaming.

    `base_url` is expected to already include a trailing /v1 by the same
    convention app.py uses for custom endpoints; callers pass the
    Pollinations base + "/v1" for that provider.
    """
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {"model": model, "messages": messages, "temperature": 0, "max_tokens": 200, "stream": False}
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}: {exc.read()[:500].decode('utf-8', 'replace')}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"request failed: {exc.reason}") from exc
    elapsed = time.monotonic() - started
    try:
        content = body["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"unexpected response shape: {body}") from exc
    return content, elapsed


# ---------------------------------------------------------------------------
# Checkers — deterministic, no second model call.
# ---------------------------------------------------------------------------


def _strip_code_fence(text):
    m = re.search(r"```(?:\w+)?\s*\n?(.*?)```", text, re.DOTALL)
    return m.group(1).strip() if m else text.strip()


@contextlib.contextmanager
def _time_limit(seconds):
    def _handler(signum, frame):
        raise TimeoutError("code execution timed out")

    previous = signal.signal(signal.SIGALRM, _handler)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def check_arithmetic(response):
    numbers = re.findall(r"-?\d+", response)
    ok = "267" in numbers
    return ok, f"found numbers {numbers or '(none)'}, expected 267 (47*6-15), instruction-following: {'short reply' if len(response.strip()) <= 12 else 'padded with extra text'}"


def check_json_format(response):
    text = _strip_code_fence(response)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return False, f"not valid JSON ({exc}): {response[:120]!r}"
    ok = data.get("sum") == 15 and data.get("ok") is True
    return ok, f"parsed {data!r}"


def check_instruction_following(response):
    stripped = response.strip().strip(".\"'").lower()
    ok = stripped == "banana"
    return ok, f"got {response.strip()!r}, expected exactly 'banana'"


def check_knowledge(response):
    stripped = response.strip().strip(".").lower()
    ok = bool(re.fullmatch(r"au", stripped))
    return ok, f"got {response.strip()!r}, expected 'Au'"


def check_coding(response):
    code = _strip_code_fence(response)
    safe_builtins = {"True": True, "False": False, "None": None, "range": range, "len": len, "bool": bool, "int": int}
    sandbox = {"__builtins__": safe_builtins}
    local_ns = {}
    try:
        with _time_limit(5):
            exec(code, sandbox, local_ns)  # noqa: S102 — deliberately sandboxed, see safe_builtins above
        fn = local_ns.get("is_even") or sandbox.get("is_even")
        if not callable(fn):
            return False, "no callable `is_even` defined"
        results = {4: fn(4), 7: fn(7), 0: fn(0)}
        ok = results[4] is True and results[7] is False and results[0] is True
        return ok, f"is_even results: {results}"
    except Exception as exc:  # noqa: BLE001 — any failure of model-written code is just a fail, not a crash
        return False, f"code failed to run: {exc}"


TESTS = [
    {
        "name": "arithmetic",
        "category": "reasoning",
        "messages": [{"role": "user", "content": "Compute 47 * 6 - 15. Reply with only the final integer, nothing else."}],
        "check": check_arithmetic,
    },
    {
        "name": "json_format",
        "category": "structured output",
        "messages": [
            {
                "role": "user",
                "content": (
                    'Output only a JSON object (no markdown fences, no explanation) with exactly two keys: '
                    '"sum" whose value is the integer 15, and "ok" whose value is the boolean true.'
                ),
            }
        ],
        "check": check_json_format,
    },
    {
        "name": "instruction_following",
        "category": "literal compliance",
        "messages": [{"role": "user", "content": "Reply with exactly the single word: banana. Do not add punctuation, quotes, or any other text."}],
        "check": check_instruction_following,
    },
    {
        "name": "knowledge",
        "category": "factual recall",
        "messages": [{"role": "user", "content": "What is the chemical symbol for gold? Reply with only the symbol, capitalized correctly, nothing else."}],
        "check": check_knowledge,
    },
    {
        "name": "coding",
        "category": "code generation",
        "messages": [
            {
                "role": "user",
                "content": (
                    "Write a single Python function named `is_even` that takes an integer and returns "
                    "True if it's even, False otherwise. Output only the code, no explanation, no markdown fences."
                ),
            }
        ],
        "check": check_coding,
    },
]


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


def run(model, base_url, api_key, timeout):
    results = []
    for test in TESTS:
        try:
            response, elapsed = chat(base_url, api_key, model, test["messages"], timeout=timeout)
            passed, detail = test["check"](response)
        except Exception as exc:  # noqa: BLE001 — a broken call is a failed test, not a crashed run
            response, elapsed, passed, detail = "", 0.0, False, f"error: {exc}"
        results.append(
            {
                "name": test["name"],
                "category": test["category"],
                "passed": passed,
                "detail": detail,
                "response": response.strip(),
                "elapsed_s": round(elapsed, 2),
            }
        )
    return results


def print_report(model, results):
    passed_count = sum(1 for r in results if r["passed"])
    print(f"\nModel quality report — {model}")
    print("=" * (24 + len(model)))
    for r in results:
        mark = "PASS" if r["passed"] else "FAIL"
        print(f"[{mark}] {r['name']:<22} ({r['category']}, {r['elapsed_s']}s)")
        print(f"       {r['detail']}")
    print("-" * (24 + len(model)))
    pct = round(100 * passed_count / len(results))
    print(f"Score: {passed_count}/{len(results)} ({pct}%)\n")


def main():
    parser = argparse.ArgumentParser(description="Run a small deterministic quality suite against one model.")
    parser.add_argument("--model", required=True, help="model id to test, e.g. 'openai' or 'gpt-4o-mini'")
    parser.add_argument("--kind", choices=["pollinations", "custom"], default="pollinations")
    parser.add_argument("--base-url", help="override base URL (custom endpoints should include a trailing /v1)")
    parser.add_argument("--api-key", help="bearer token; falls back to POLLINATIONS_API_KEY / MEADOWS_API_KEY env vars")
    parser.add_argument("--timeout", type=float, default=REQUEST_TIMEOUT, help="per-request timeout in seconds")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON instead of the table")
    args = parser.parse_args()

    if args.kind == "custom":
        base_url = args.base_url
        if not base_url:
            parser.error("--base-url is required for --kind custom")
        api_key = args.api_key or os.environ.get("MEADOWS_API_KEY", "")
    else:
        base_url = (args.base_url or DEFAULT_POLLINATIONS_BASE).rstrip("/") + "/v1"
        api_key = args.api_key or os.environ.get("POLLINATIONS_API_KEY", "")

    results = run(args.model, base_url, api_key, args.timeout)

    if args.json:
        print(json.dumps({"model": args.model, "results": results}, indent=2))
    else:
        print_report(args.model, results)

    sys.exit(0 if all(r["passed"] for r in results) else 1)


if __name__ == "__main__":
    main()
