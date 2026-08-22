"""Meadows — a multi-provider AI playground.

A small Flask server that proxies browser requests to whichever provider
is active. Custom OpenAI-compatible endpoints (OpenRouter, OpenAI, a local
gateway) work the way you'd expect: base URL + API key travel with each
request from the browser, kept in its localStorage, never persisted here —
that's the only way to support "bring any endpoint" without us hosting an
account system for the whole internet.

Pollinations is different on purpose: the browser never holds an API key
for it at all. Login is real OAuth 2.1 + PKCE against Pollinations' own
auth server; the resulting access token is kept server-side in an
in-memory session store (see SESSIONS below), addressed by an opaque
random id in an httpOnly cookie the page's JavaScript cannot read. Every
Pollinations-bound request resolves its key from that cookie, never from
anything the browser sends in a request body — so there's no key sitting
in localStorage, no key a browser extension or XSS payload could exfiltrate,
and no server-side env-var key silently used without the user asking.
"""

import base64
import binascii
import hashlib
import json
import os
import secrets
import threading
import time
from urllib.parse import urlencode

import requests
import websocket  # from the `websocket-client` package
from flask import Flask, Response, jsonify, redirect, render_template, request, session, stream_with_context, url_for
from flask_sock import Sock
from werkzeug.middleware.proxy_fix import ProxyFix

import quality_tests

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY") or secrets.token_hex(32)
# Real deployments sit behind a reverse proxy (Render, Fly, nginx, ...) that
# terminates TLS and forwards plain HTTP internally, setting X-Forwarded-*
# headers to say so. Without this, request.is_secure and url_for(_external=
# True) can't tell the request was actually HTTPS — which would silently
# build an http:// OAuth redirect_uri that mismatches whatever https://...
# is registered at Pollinations, breaking login only in production.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
sock = Sock(app)

# ---------------------------------------------------------------------------
# Provider resolution
# ---------------------------------------------------------------------------

POLLINATIONS_BASE = os.environ.get("POLLINATIONS_API_BASE", "https://gen.pollinations.ai")

# BYOP ("Bring Your Own Pollen") OAuth 2.1 + PKCE, per the live discovery
# document at https://enter.pollinations.ai/.well-known/oauth-authorization-server
AUTH_BASE = "https://enter.pollinations.ai"
AUTHORIZE_URL = f"{AUTH_BASE}/authorize"
TOKEN_URL = f"{AUTH_BASE}/api/oauth/token"
USERINFO_URL = f"{AUTH_BASE}/api/oauth/userinfo"

# This app's own registered pk_ App Key (a *publishable* client_id — safe to
# ship in source, same trust level as a Stripe pk_live_ key). Override via
# env if you register your own app instead.
DEFAULT_OAUTH_CLIENT_ID = os.environ.get("POLLINATIONS_APP_KEY", "pk_5ISkAhFpFnNI1QlT")

REQUEST_TIMEOUT = 120
VIDEO_TIMEOUT = 240
MODELS_TIMEOUT = 20

# ---------------------------------------------------------------------------
# Server-side login sessions for Pollinations. Keyed by an opaque random id
# that lives in an httpOnly cookie — the actual sk_ access token never
# leaves this dict, and never reaches the browser in any form (not even in
# a signed cookie payload). Persisted to a small local file so logging in
# survives a dev-server restart; this is a single-process local app, so an
# in-memory dict + flat file is the right amount of machinery, not a
# database.
# ---------------------------------------------------------------------------

SESSION_COOKIE = "meadows_session"
# Defaults to living next to app.py (fine for local dev, and for any host
# with a persistent filesystem). Point MEADOWS_DATA_DIR at a mounted
# persistent volume in containerized deployments where the app directory
# itself gets wiped/replaced on every deploy.
_DATA_DIR = os.environ.get("MEADOWS_DATA_DIR") or os.path.dirname(os.path.abspath(__file__))
_SESSIONS_FILE = os.path.join(_DATA_DIR, ".sessions.json")


def _load_sessions():
    try:
        with open(_SESSIONS_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def _save_sessions():
    try:
        os.makedirs(_DATA_DIR, exist_ok=True)
        with open(_SESSIONS_FILE, "w") as f:
            json.dump(SESSIONS, f)
    except OSError:
        pass


SESSIONS = _load_sessions()


def current_session():
    sid = request.cookies.get(SESSION_COOKIE)
    if not sid:
        return None
    s = SESSIONS.get(sid)
    if s is None:
        # Under multiple worker processes, a session created by a sibling
        # worker won't be in *our* in-memory copy until we pick up what it
        # wrote to disk. Only costs a file read on a miss, not every
        # request, and self-heals regardless of which worker handles which
        # request from here on.
        SESSIONS.update(_load_sessions())
        s = SESSIONS.get(sid)
    return s


def current_session_key():
    s = current_session()
    return (s or {}).get("api_key", "")


def resolve_provider(data):
    """Turn a request body's provider fields into {kind, base, key}.

    kind='pollinations' always talks to POLLINATIONS_BASE (a bare host;
    its OpenAI-compatible surface lives under /v1/...) and its key comes
    *only* from the server-side session cookie — anything the browser
    might put in data["api_key"] for this kind is ignored, on purpose.
    kind='custom' talks to whatever base_url the user configured, which by
    OpenAI-SDK convention already includes a trailing /v1 (e.g.
    "https://api.openai.com/v1" or "https://openrouter.ai/api/v1"), and its
    key does come from the request body — there's no OAuth for arbitrary
    third-party endpoints, so a user-held key is the only option there.
    """
    kind = (data.get("kind") or "pollinations").strip()
    if kind == "custom":
        base = (data.get("base_url") or "").strip().rstrip("/")
        key = (data.get("api_key") or "").strip()
        return {"kind": "custom", "base": base, "key": key}
    return {"kind": "pollinations", "base": POLLINATIONS_BASE, "key": current_session_key()}


def auth_headers(provider):
    if provider["key"]:
        return {"Authorization": f"Bearer {provider['key']}"}
    return {}


def poll_url(provider, suffix):
    return f"{provider['base']}{suffix}"


def custom_url(provider, suffix):
    return f"{provider['base']}{suffix}"


def upstream_error(resp):
    return jsonify({"error": f"provider returned {resp.status_code}", "body": resp.text[:800]}), resp.status_code


def require_custom_base(provider):
    if provider["kind"] == "custom" and not provider["base"]:
        return jsonify({"error": "base_url is required for a custom endpoint"}), 400
    return None


def require_credentials(provider):
    """Generation endpoints refuse to run against an unconfigured provider —
    no silent anonymous Pollinations traffic, no silent env-var key. The
    browser has to have set something up first (Pollinations login, or a
    custom endpoint's own key/URL)."""
    err = require_custom_base(provider)
    if err:
        return err
    if provider["kind"] == "pollinations" and not provider["key"]:
        return jsonify({"error": "Sign in with Pollinations first (see the sidebar)."}), 401
    return None


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------


@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# "Sign in with Pollinations" — OAuth 2.1 authorization-code flow with PKCE
# (BYOP). Discovery document: GET {AUTH_BASE}/.well-known/oauth-authorization-server
#
# This app is a public client (no client secret — token_endpoint_auth_methods
# is "none"), so a PKCE code_verifier stands in for a secret. Flask's own
# signed `session` cookie holds that verifier for the few seconds between
# the redirect out and the callback back in — that's a *different* cookie
# from SESSION_COOKIE above, and never holds the access token. Once the
# callback exchanges the code for a token, the token goes straight into
# SESSIONS server-side and the browser only ever gets an opaque session id.
# ---------------------------------------------------------------------------


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


@app.route("/api/oauth/config")
def api_oauth_config():
    return jsonify({"redirect_uri": url_for("oauth_callback", _external=True), "default_client_id": DEFAULT_OAUTH_CLIENT_ID})


@app.route("/oauth/login")
def oauth_login():
    client_id = (request.args.get("client_id") or DEFAULT_OAUTH_CLIENT_ID or "").strip()
    if not client_id:
        return "Missing client_id — set your Pollinations App Key (pk_...) in Settings first, then try again.", 400

    verifier = _b64url(secrets.token_bytes(40))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    state = _b64url(secrets.token_bytes(16))
    redirect_uri = url_for("oauth_callback", _external=True)

    session["oauth_verifier"] = verifier
    session["oauth_state"] = state
    session["oauth_redirect_uri"] = redirect_uri
    session["oauth_client_id"] = client_id

    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": request.args.get("scope") or "profile usage",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    if request.args.get("budget"):
        params["budget"] = request.args["budget"]
    if request.args.get("expiry"):
        params["expiry"] = request.args["expiry"]

    return redirect(f"{AUTHORIZE_URL}?{urlencode(params)}")


@app.route("/oauth/callback")
def oauth_callback():
    def fail(msg):
        return redirect(f"/?login_error={requests.utils.quote(msg)}")

    err = request.args.get("error")
    if err:
        return fail(request.args.get("error_description") or err)

    code = request.args.get("code")
    state = request.args.get("state")
    if not code or not state or state != session.get("oauth_state"):
        return fail("state mismatch — please try logging in again")

    verifier = session.pop("oauth_verifier", None)
    redirect_uri = session.pop("oauth_redirect_uri", None)
    client_id = session.pop("oauth_client_id", None)
    session.pop("oauth_state", None)

    try:
        resp = requests.post(
            TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": client_id,
                "code_verifier": verifier,
            },
            headers={"Accept": "application/json"},
            timeout=20,
        )
    except requests.RequestException as exc:
        return fail(str(exc))

    if resp.status_code != 200:
        return fail(f"token exchange failed ({resp.status_code}): {resp.text[:200]}")

    try:
        token = resp.json().get("access_token")
    except ValueError:
        token = None
    if not token:
        return fail("provider response had no access_token")

    name = None
    try:
        uresp = requests.get(USERINFO_URL, headers={"Authorization": f"Bearer {token}"}, timeout=15)
        if uresp.status_code == 200:
            name = uresp.json().get("name")
    except requests.RequestException:
        pass

    session_id = secrets.token_urlsafe(32)
    SESSIONS[session_id] = {"api_key": token, "name": name}
    _save_sessions()

    resp = redirect("/")
    resp.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        samesite="Lax",
        secure=request.is_secure,
        max_age=60 * 60 * 24 * 30,
    )
    return resp


@app.route("/api/session")
def api_session():
    s = current_session()
    if not s:
        return jsonify({"logged_in": False})
    return jsonify({"logged_in": True, "name": s.get("name")})


@app.route("/api/logout", methods=["POST"])
def api_logout():
    sid = request.cookies.get(SESSION_COOKIE)
    if sid and sid in SESSIONS:
        del SESSIONS[sid]
        _save_sessions()
    resp = jsonify({"ok": True})
    resp.delete_cookie(SESSION_COOKIE)
    return resp


# ---------------------------------------------------------------------------
# Model discovery
#
# Pollinations exposes per-modality catalogs (/text/models, /image/models,
# /audio/models, /video/models) with real metadata — brand, human title,
# input/output modalities, per-model voice lists, pricing — so we use that
# as ground truth instead of guessing from the model id. Custom OpenAI-
# compatible endpoints only give us a bare `GET /models` id list, so those
# still lean on the client-side heuristics in icons.js.
# ---------------------------------------------------------------------------

_MODALITY_ENDPOINTS = [
    ("text", "/text/models"),
    ("image", "/image/models"),
    ("audio", "/audio/models"),
    ("video", "/video/models"),
]


def _classify_pollinations_model(category, input_modalities, output_modalities):
    cap = {"chat": False, "vision": False, "image": False, "video": False, "tts": False, "stt": False}
    im = input_modalities or []
    om = output_modalities or []
    if category == "text":
        cap["chat"] = True
        if "image" in im:
            cap["vision"] = True
    elif category == "image":
        cap["image"] = True
    elif category == "video":
        cap["video"] = True
    elif category == "audio":
        if "text" in om:
            cap["stt"] = True
        if "audio" in om and "text" in im:
            cap["tts"] = True
    return cap


def fetch_pollinations_catalog(headers):
    out = []
    seen = set()
    for category, path in _MODALITY_ENDPOINTS:
        try:
            resp = requests.get(f"{POLLINATIONS_BASE}{path}", headers=headers, timeout=MODELS_TIMEOUT)
        except requests.RequestException:
            continue
        if resp.status_code != 200:
            continue
        try:
            items = resp.json()
        except ValueError:
            continue
        if not isinstance(items, list):
            continue
        for m in items:
            if not isinstance(m, dict):
                continue
            mid = m.get("name")
            if not mid or mid in seen:
                continue
            seen.add(mid)
            out.append(
                {
                    "id": mid,
                    "title": m.get("title") or mid,
                    "brand": m.get("brand") or "",
                    "category": category,
                    "voices": m.get("voices") or None,
                    "paid_only": bool(m.get("paid_only")),
                    "context_length": m.get("context_length"),
                    "cap": _classify_pollinations_model(category, m.get("input_modalities"), m.get("output_modalities")),
                }
            )
    return out


@app.route("/api/models", methods=["POST"])
def api_models():
    data = request.get_json(force=True, silent=True) or {}
    provider = resolve_provider(data)
    err = require_custom_base(provider)
    if err:
        return err

    headers = auth_headers(provider)

    if provider["kind"] == "pollinations":
        models = fetch_pollinations_catalog(headers)
        if models:
            return jsonify({"models": models, "source": "modality-catalog"})
        # fall through to the generic /v1/models probe below as a safety net

    candidates = [poll_url(provider, "/v1/models"), poll_url(provider, "/models")] if provider["kind"] == "pollinations" else [custom_url(provider, "/models")]

    last_error = None
    for url in candidates:
        try:
            resp = requests.get(url, headers=headers, timeout=MODELS_TIMEOUT)
        except requests.RequestException as exc:
            last_error = str(exc)
            continue
        if resp.status_code != 200:
            last_error = f"{url} -> {resp.status_code}"
            continue
        try:
            body = resp.json()
        except ValueError:
            last_error = f"{url} -> non-JSON response"
            continue

        models = normalize_models(body)
        if models:
            return jsonify({"models": models, "source": url})
        last_error = f"{url} -> empty model list"

    return jsonify({"models": [], "error": last_error or "no models endpoint responded"}), 200


def normalize_models(body):
    """Normalize the various shapes a bare OpenAI-style model-list endpoint
    returns into a flat list of {id, owned_by}."""
    items = None
    if isinstance(body, dict):
        items = body.get("data") or body.get("models")
    elif isinstance(body, list):
        items = body

    if items is None:
        return []

    out = []
    for item in items:
        if isinstance(item, str):
            out.append({"id": item, "owned_by": ""})
        elif isinstance(item, dict):
            mid = item.get("id") or item.get("name")
            if not mid:
                continue
            out.append({"id": mid, "owned_by": item.get("owned_by") or item.get("provider") or ""})
    return out


# ---------------------------------------------------------------------------
# Chat / text (streaming passthrough)
# ---------------------------------------------------------------------------


@app.route("/api/chat", methods=["POST"])
def api_chat():
    data = request.get_json(force=True, silent=True) or {}
    provider = resolve_provider(data)
    err = require_credentials(provider)
    if err:
        return err

    messages = data.get("messages")
    model = data.get("model") or ("openai" if provider["kind"] == "pollinations" else "")
    if not messages:
        return jsonify({"error": "messages is required"}), 400
    if not model:
        return jsonify({"error": "model is required"}), 400

    url = poll_url(provider, "/v1/chat/completions") if provider["kind"] == "pollinations" else custom_url(provider, "/chat/completions")

    payload = {"model": model, "messages": messages, "stream": True}
    if data.get("temperature") is not None:
        payload["temperature"] = data["temperature"]
    # "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" per
    # Pollinations' own /v1/chat/completions schema. Models that don't
    # support adjustable reasoning just ignore it — safe to always forward
    # when the client sends one.
    if data.get("reasoning_effort"):
        payload["reasoning_effort"] = data["reasoning_effort"]

    headers = {**auth_headers(provider), "Content-Type": "application/json", "Accept": "text/event-stream"}

    try:
        upstream = requests.post(url, json=payload, headers=headers, stream=True, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        return jsonify({"error": str(exc)}), 502

    if upstream.status_code >= 400:
        body = upstream.content[:800]
        upstream.close()
        return jsonify({"error": f"provider returned {upstream.status_code}", "body": body.decode("utf-8", "replace")}), upstream.status_code

    def relay():
        try:
            for chunk in upstream.iter_content(chunk_size=1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    resp_headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    content_type = upstream.headers.get("Content-Type", "text/event-stream")
    return Response(stream_with_context(relay()), mimetype=content_type, headers=resp_headers)


# ---------------------------------------------------------------------------
# Model quality test — a small fixed suite (arithmetic, JSON structured
# output, literal instruction-following, factual recall, basic code
# generation) run non-streaming against one model. See quality_tests.py for
# the prompts/checks themselves; the same suite backs tests/model_quality.py
# for CLI/CI use.
# ---------------------------------------------------------------------------


@app.route("/api/quality-test", methods=["POST"])
def api_quality_test():
    data = request.get_json(force=True, silent=True) or {}
    provider = resolve_provider(data)
    err = require_credentials(provider)
    if err:
        return err

    model = data.get("model") or ("openai" if provider["kind"] == "pollinations" else "")
    if not model:
        return jsonify({"error": "model is required"}), 400

    url = poll_url(provider, "/v1/chat/completions") if provider["kind"] == "pollinations" else custom_url(provider, "/chat/completions")
    headers = {**auth_headers(provider), "Content-Type": "application/json"}

    def chat_fn(messages):
        payload = {"model": model, "messages": messages, "temperature": 0, "max_tokens": 200, "stream": False}
        started = time.monotonic()
        resp = requests.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
        elapsed = time.monotonic() - started
        if resp.status_code >= 400:
            raise RuntimeError(f"provider returned {resp.status_code}: {resp.text[:300]}")
        body = resp.json()
        content = body["choices"][0]["message"]["content"] or ""
        return content, elapsed

    results = quality_tests.run_suite(chat_fn)
    return jsonify({"model": model, "results": results})


# ---------------------------------------------------------------------------
# Image generation
# ---------------------------------------------------------------------------


def _edit_image_via_v1(provider, prompt, data, headers):
    """/image/{prompt}'s `image` query param is documented as a reference
    *URL* — passing the browser's raw data: URI there blows straight past
    GET URL-length limits (the 414 this exists to fix). The natural next
    move, Pollinations' own POST /upload to mint a short URL first, turns
    out to 404 live despite being documented (checked directly — every
    variant, with and without auth). So: go through the OpenAI-compatible
    POST /v1/images/edits instead, which is confirmed live (401s cleanly
    without auth rather than 404ing) and takes the file directly as
    multipart, no upload step needed at all.
    """
    try:
        header, b64data = data["image"].split(",", 1)
        content_type = header.split(";")[0][len("data:"):] or "image/png"
        raw = base64.b64decode(b64data)
    except (ValueError, KeyError, binascii.Error):
        return jsonify({"error": "invalid reference image data"}), 400

    ext = content_type.split("/")[-1] or "png"
    files = {"image": (f"reference.{ext}", raw, content_type)}
    form = {"prompt": prompt}
    if data.get("model"):
        form["model"] = data["model"]

    url = poll_url(provider, "/v1/images/edits")
    try:
        resp = requests.post(url, files=files, data=form, headers=headers, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        return jsonify({"error": str(exc)}), 502
    if resp.status_code != 200:
        return upstream_error(resp)

    try:
        item = resp.json()["data"][0]
    except Exception:
        return jsonify({"error": "unexpected response shape from provider", "body": resp.text[:500]}), 502

    if item.get("b64_json"):
        return jsonify({"image": f"data:image/png;base64,{item['b64_json']}"})
    if item.get("url"):
        return jsonify({"image": item["url"]})
    return jsonify({"error": "provider returned neither b64_json nor url"}), 502


@app.route("/api/image", methods=["POST"])
def api_image():
    data = request.get_json(force=True, silent=True) or {}
    provider = resolve_provider(data)
    err = require_credentials(provider)
    if err:
        return err

    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "prompt is required"}), 400

    headers = auth_headers(provider)

    if provider["kind"] == "pollinations":
        if data.get("image"):
            return _edit_image_via_v1(provider, prompt, data, headers)

        params = {}
        if data.get("model"):
            params["model"] = data["model"]
        if data.get("width"):
            params["width"] = data["width"]
        if data.get("height"):
            params["height"] = data["height"]
        if data.get("seed"):
            params["seed"] = data["seed"]

        url = poll_url(provider, f"/image/{requests.utils.quote(prompt)}")
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as exc:
            return jsonify({"error": str(exc)}), 502
        if resp.status_code != 200:
            return upstream_error(resp)

        b64 = base64.b64encode(resp.content).decode("ascii")
        content_type = resp.headers.get("Content-Type", "image/jpeg")
        return jsonify({"image": f"data:{content_type};base64,{b64}"})

    # Custom OpenAI-compatible /images/generations
    size = None
    if data.get("width") and data.get("height"):
        size = f"{data['width']}x{data['height']}"
    payload = {"model": data.get("model") or "dall-e-3", "prompt": prompt, "n": 1}
    if size:
        payload["size"] = size

    url = custom_url(provider, "/images/generations")
    try:
        resp = requests.post(url, json=payload, headers={**headers, "Content-Type": "application/json"}, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        return jsonify({"error": str(exc)}), 502
    if resp.status_code != 200:
        return upstream_error(resp)

    try:
        body = resp.json()
        item = body["data"][0]
    except Exception:
        return jsonify({"error": "unexpected response shape from provider", "body": resp.text[:500]}), 502

    if item.get("b64_json"):
        return jsonify({"image": f"data:image/png;base64,{item['b64_json']}"})
    if item.get("url"):
        return jsonify({"image": item["url"]})
    return jsonify({"error": "provider returned neither b64_json nor url"}), 502


# ---------------------------------------------------------------------------
# Video generation (experimental / best-effort — support varies wildly by
# provider and model; we surface whatever the upstream gives us rather than
# pretending this is a settled standard).
# ---------------------------------------------------------------------------


@app.route("/api/video", methods=["POST"])
def api_video():
    data = request.get_json(force=True, silent=True) or {}
    provider = resolve_provider(data)
    err = require_credentials(provider)
    if err:
        return err

    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "prompt is required"}), 400

    headers = auth_headers(provider)

    if provider["kind"] == "pollinations":
        params = {}
        if data.get("model"):
            params["model"] = data["model"]
        if data.get("width"):
            params["width"] = data["width"]
        if data.get("height"):
            params["height"] = data["height"]
        if data.get("seed"):
            params["seed"] = data["seed"]

        url = poll_url(provider, f"/video/{requests.utils.quote(prompt)}")
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=VIDEO_TIMEOUT)
        except requests.RequestException as exc:
            return jsonify({"error": str(exc)}), 502
        if resp.status_code != 200:
            return upstream_error(resp)

        content_type = resp.headers.get("Content-Type", "video/mp4")
        if "video" not in content_type and "octet-stream" not in content_type:
            return jsonify({"error": "provider did not return a video", "body": resp.text[:500]}), 502
        b64 = base64.b64encode(resp.content).decode("ascii")
        return jsonify({"video": f"data:{content_type};base64,{b64}"})

    payload = {"model": data.get("model") or "", "prompt": prompt}
    url = custom_url(provider, "/videos/generations")
    try:
        resp = requests.post(url, json=payload, headers={**headers, "Content-Type": "application/json"}, timeout=VIDEO_TIMEOUT)
    except requests.RequestException as exc:
        return jsonify({"error": str(exc)}), 502
    if resp.status_code != 200:
        return upstream_error(resp)

    try:
        body = resp.json()
        item = body["data"][0]
    except Exception:
        return jsonify({"error": "unexpected response shape from provider", "body": resp.text[:500]}), 502

    if item.get("b64_json"):
        return jsonify({"video": f"data:video/mp4;base64,{item['b64_json']}"})
    if item.get("url"):
        return jsonify({"video": item["url"]})
    return jsonify({"error": "provider returned neither b64_json nor url"}), 502


# ---------------------------------------------------------------------------
# Text-to-speech
# ---------------------------------------------------------------------------


@app.route("/api/tts", methods=["POST"])
def api_tts():
    data = request.get_json(force=True, silent=True) or {}
    provider = resolve_provider(data)
    err = require_credentials(provider)
    if err:
        return err

    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400

    voice = data.get("voice") or "alloy"
    response_format = data.get("format") or "mp3"

    payload = {"input": text, "voice": voice, "response_format": response_format}
    # `model` is optional on Pollinations' /v1/audio/speech (it applies its
    # own default) — only send it if the caller picked one, since hardcoding
    # a guess here is exactly the kind of assumption that goes stale.
    if data.get("model"):
        payload["model"] = data["model"]
    elif provider["kind"] == "custom":
        payload["model"] = "tts-1"

    url = poll_url(provider, "/v1/audio/speech") if provider["kind"] == "pollinations" else custom_url(provider, "/audio/speech")
    headers = {**auth_headers(provider), "Content-Type": "application/json"}

    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        return jsonify({"error": str(exc)}), 502
    if resp.status_code != 200:
        return upstream_error(resp)

    content_type = resp.headers.get("Content-Type", f"audio/{response_format}")
    b64 = base64.b64encode(resp.content).decode("ascii")
    return jsonify({"audio": f"data:{content_type};base64,{b64}"})


# ---------------------------------------------------------------------------
# Speech-to-text
# ---------------------------------------------------------------------------


@app.route("/api/stt", methods=["POST"])
def api_stt():
    kind = request.form.get("kind") or "pollinations"
    provider = resolve_provider(
        {
            "kind": kind,
            "base_url": request.form.get("base_url"),
            "api_key": request.form.get("api_key"),
        }
    )
    err = require_credentials(provider)
    if err:
        return err

    audio_file = request.files.get("file")
    if not audio_file:
        return jsonify({"error": "file is required"}), 400

    model = request.form.get("model") or ("whisper" if provider["kind"] == "pollinations" else "whisper-1")
    url = poll_url(provider, "/v1/audio/transcriptions") if provider["kind"] == "pollinations" else custom_url(provider, "/audio/transcriptions")

    files = {"file": (audio_file.filename or "audio.webm", audio_file.stream, audio_file.mimetype or "audio/webm")}
    form = {"model": model, "response_format": "json"}
    headers = auth_headers(provider)

    try:
        resp = requests.post(url, files=files, data=form, headers=headers, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        return jsonify({"error": str(exc)}), 502
    if resp.status_code != 200:
        return upstream_error(resp)

    try:
        body = resp.json()
        text = body.get("text", "")
    except ValueError:
        text = resp.text
    return jsonify({"text": text})


# ---------------------------------------------------------------------------
# Realtime voice — a genuine relay onto the OpenAI-compatible Realtime
# WebSocket (wss://.../v1/realtime), not a chained approximation. The
# browser talks plain WebSocket JSON to us at /ws/realtime; we open our own
# outbound WebSocket to the provider authenticated with `Authorization:
# Bearer <key>` (server-to-server auth, per the provider's own docs — the
# alternative browser-direct `?key=pk_...` scheme would mean putting a key
# in a URL the browser keeps in memory, which we'd rather not do) and pump
# JSON events in both directions unmodified.
# ---------------------------------------------------------------------------


def _realtime_upstream_url(provider, model):
    if provider["kind"] == "pollinations":
        wss_base = POLLINATIONS_BASE.replace("https://", "wss://").replace("http://", "ws://")
        return f"{wss_base}/v1/realtime?model={requests.utils.quote(model)}"
    wss_base = provider["base"].replace("https://", "wss://").replace("http://", "ws://")
    return f"{wss_base}/realtime?model={requests.utils.quote(model)}"


@sock.route("/ws/realtime")
def ws_realtime(ws):
    provider = resolve_provider(
        {
            "kind": request.args.get("kind") or "pollinations",
            "base_url": request.args.get("base_url"),
            "api_key": request.args.get("api_key"),
        }
    )
    model = request.args.get("model") or "gpt-realtime-2.1"

    if provider["kind"] == "custom" and not provider["base"]:
        ws.send(json.dumps({"type": "error", "error": {"message": "base_url is required for a custom endpoint"}}))
        return
    if provider["kind"] == "pollinations" and not provider["key"]:
        ws.send(json.dumps({"type": "error", "error": {"message": "Sign in with Pollinations first (see the sidebar)."}}))
        return

    upstream_url = _realtime_upstream_url(provider, model)
    headers = [f"Authorization: Bearer {provider['key']}"] if provider["key"] else []

    try:
        upstream = websocket.create_connection(upstream_url, header=headers, timeout=20)
    except Exception as exc:
        ws.send(json.dumps({"type": "error", "error": {"message": f"couldn't reach realtime endpoint: {exc}"}}))
        return

    stop = threading.Event()

    def pump_upstream_to_browser():
        try:
            while not stop.is_set():
                msg = upstream.recv()
                if msg in (None, ""):
                    break
                ws.send(msg)
        except Exception:
            pass
        finally:
            stop.set()

    relay_thread = threading.Thread(target=pump_upstream_to_browser, daemon=True)
    relay_thread.start()

    try:
        while not stop.is_set():
            msg = ws.receive(timeout=1)
            if msg is None:
                continue
            upstream.send(msg)
    except Exception:
        pass
    finally:
        stop.set()
        try:
            upstream.close()
        except Exception:
            pass


if __name__ == "__main__":
    print(f"Realtime/login app key: {DEFAULT_OAUTH_CLIENT_ID} (override with POLLINATIONS_APP_KEY)")
    print("No credentials are used by default — sign in with Pollinations from the sidebar before generating anything.")
    app.run(host="127.0.0.1", port=5151, debug=True, threaded=True)
