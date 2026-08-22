#!/usr/bin/env python3
"""Model quality smoke test — CLI.

Point it at any model — Pollinations or a custom OpenAI-compatible endpoint
(same two "kinds" app.py understands) — and it runs the small, fixed suite
in `quality_tests.py` (arithmetic, JSON structured output, literal
instruction-following, factual recall, basic code generation) and prints a
pass/fail scorecard. The same suite also backs the "Test quality" button in
the web UI (see `/api/quality-test` in app.py) — this script is for running
it from a terminal or CI instead.

Usage:
    python3 tests/model_quality.py --model openai
    python3 tests/model_quality.py --model gpt-4o-mini --kind custom \\
        --base-url https://api.openai.com/v1 --api-key sk-...

    # machine-readable output, non-zero exit on any failure (CI-friendly)
    python3 tests/model_quality.py --model openai --json

Env vars (used as fallbacks so a key never has to sit in shell history):
    POLLINATIONS_API_BASE   default base for --kind pollinations
    POLLINATIONS_API_KEY    bearer token for --kind pollinations
    MEADOWS_API_KEY         bearer token for --kind custom
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from quality_tests import run_suite  # noqa: E402

DEFAULT_POLLINATIONS_BASE = os.environ.get("POLLINATIONS_API_BASE", "https://gen.pollinations.ai")
REQUEST_TIMEOUT = 60


# ---------------------------------------------------------------------------
# Tiny HTTP helper (stdlib only — no need to require `requests` for a CLI
# script that may run outside the app's venv).
# ---------------------------------------------------------------------------


def make_chat_fn(base_url, api_key, model, timeout=REQUEST_TIMEOUT):
    """Return a chat_fn(messages) -> (content, elapsed) bound to one model.

    `base_url` is expected to already include a trailing /v1 by the same
    convention app.py uses for custom endpoints; callers pass the
    Pollinations base + "/v1" for that provider.
    """
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    def chat_fn(messages):
        payload = {"model": model, "messages": messages, "temperature": 0, "max_tokens": 200, "stream": False}
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

    return chat_fn


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

    chat_fn = make_chat_fn(base_url, api_key, args.model, timeout=args.timeout)
    results = run_suite(chat_fn)

    if args.json:
        print(json.dumps({"model": args.model, "results": results}, indent=2))
    else:
        print_report(args.model, results)

    sys.exit(0 if all(r["passed"] for r in results) else 1)


if __name__ == "__main__":
    main()
