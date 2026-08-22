"""The model quality suite — shared by the CLI (tests/model_quality.py) and
the web app's `/api/quality-test` route (app.py).

A fixed set of 5 cheap, deterministic probes covering a few different
skills: arithmetic, JSON structured output, literal instruction-following,
factual recall, and basic code generation. Deliberately NOT an
LLM-as-judge — every check is a plain string/JSON/exec assertion, and each
prompt caps `max_tokens`, so a full run against a model is just 5 short
requests.

Callers supply a `chat_fn(messages) -> (content, elapsed_seconds)` that
actually talks to the model; this module owns only the prompts and the
checks, not the HTTP.
"""

import json
import re
import subprocess
import sys
import textwrap


def _strip_code_fence(text):
    m = re.search(r"```(?:\w+)?\s*\n?(.*?)```", text, re.DOTALL)
    return m.group(1).strip() if m else text.strip()


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


_CODING_HARNESS = textwrap.dedent(
    """
    import json as _json

    # Deliberately bare: no __import__, open, eval, exec, network, etc. —
    # the model's code can define/call functions and do arithmetic, and
    # nothing else. Combined with running in a throwaway subprocess (see
    # check_coding below), this is defense in depth, not just a timeout.
    _safe_builtins = {{
        "True": True, "False": False, "None": None,
        "range": range, "len": len, "bool": bool, "int": int, "abs": abs, "min": min, "max": max,
    }}
    _sandbox = {{"__builtins__": _safe_builtins}}
    exec({code!r}, _sandbox)
    _fn = _sandbox.get("is_even")
    if not callable(_fn):
        print(_json.dumps({{"error": "no callable `is_even` defined"}}))
    else:
        print(_json.dumps({{"results": {{"4": _fn(4), "7": _fn(7), "0": _fn(0)}}}}))
    """
)


def check_coding(response):
    """Runs the model's code for real, in a throwaway subprocess.

    Two independent layers, not one: the code only ever runs against the
    restricted builtins above (no filesystem/network/process access even
    if it ran forever), *and* it runs in a separate subprocess so
    `subprocess.run(timeout=...)` can actually kill a hang from any
    calling thread — unlike `signal.alarm`, which only fires on the main
    interpreter thread and silently no-ops when this check runs inside a
    Flask request thread.
    """
    code = _strip_code_fence(response)
    script = _CODING_HARNESS.format(code=code)
    try:
        proc = subprocess.run(
            [sys.executable, "-I", "-c", script],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except subprocess.TimeoutExpired:
        return False, "code execution timed out"
    except OSError as exc:
        return False, f"could not run code: {exc}"

    if proc.returncode != 0:
        return False, f"code failed to run: {proc.stderr.strip()[-300:] or 'unknown error'}"

    last_line = (proc.stdout.strip().splitlines() or [""])[-1]
    try:
        out = json.loads(last_line)
    except json.JSONDecodeError:
        return False, f"unexpected output: {proc.stdout[:200]!r}"

    if "error" in out:
        return False, out["error"]
    results = out["results"]
    ok = results.get("4") is True and results.get("7") is False and results.get("0") is True
    return ok, f"is_even results: {results}"


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


def run_suite(chat_fn):
    """Run every test in TESTS through `chat_fn` and return a list of result dicts.

    `chat_fn(messages)` must return `(content: str, elapsed_seconds: float)`
    or raise — a raised exception is recorded as a failed test, not
    propagated, so one broken probe doesn't abort the run.
    """
    results = []
    for test in TESTS:
        try:
            response, elapsed = chat_fn(test["messages"])
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
