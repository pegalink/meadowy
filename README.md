# 🌾 Meadows

A ChatGPT/Claude-style AI playground: chat, images, video, text-to-speech,
speech-to-text, a real STT → LLM → TTS voice chain, and genuine low-latency
**Realtime** voice — all against **Pollinations.ai** (sign in with your real
account, no key ever touches the browser), or any **OpenAI-compatible
endpoint** you bring yourself (OpenRouter, OpenAI, a local gateway).

## Run it locally

```bash
pip install -r requirements.txt
python3 app.py
```

Open `http://127.0.0.1:5151`. No build step, no npm, no framework — just
Flask + vanilla JS/CSS.

## Deploying it

GitHub Pages **cannot** host this — Pages only serves static files, and
Meadows needs a real running process: the OAuth token exchange, the session
cookie, and the `/ws/realtime` WebSocket relay all require server-side
Python. If you want `meadowy.roboticrobot.xyz` to actually work, point its
DNS at a host that runs `app.py`, not at Pages.

The repo ships ready for either of these (both work from the same
`Dockerfile`):

**Render** — zero CLI. Dashboard → New → Blueprint → pick this repo →
Apply (picks up `render.yaml`, which also generates `FLASK_SECRET_KEY` for
you). Then Settings → Custom Domains → add `meadowy.roboticrobot.xyz` and
put the CNAME it gives you at your DNS provider. Caveat: the free plan's
filesystem is ephemeral and it spins down when idle, so `.sessions.json`
(and therefore everyone's login) resets on redeploy/spin-down unless you
attach a persistent disk (paid plans — instructions are commented in
`render.yaml`).

**Fly.io** — no cold starts, needs the `flyctl` CLI once:
```bash
fly launch --no-deploy   # reads fly.toml, confirms the app name
fly volumes create meadowy_data --size 1 --region <region>
fly secrets set FLASK_SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
fly deploy
fly certs add meadowy.roboticrobot.xyz   # then add the CNAME it gives you
```
The volume makes `.sessions.json` persistent across deploys — set up already
via `MEADOWS_DATA_DIR=/data` in `fly.toml`.

**A plain VPS** works too: `docker build -t meadowy . && docker run -d -p 8080:8080 -e FLASK_SECRET_KEY=... meadowy`, then reverse-proxy it (nginx/caddy) with a Let's Encrypt cert for the custom domain.

Whichever you pick, once `meadowy.roboticrobot.xyz` is live, register that
exact `https://meadowy.roboticrobot.xyz/oauth/callback` as an allowed
redirect URI on the Pollinations app behind `POLLINATIONS_APP_KEY` — the
code computes the redirect URI dynamically from the request host (via
`ProxyFix`, so it correctly resolves to `https://`, not `http://`, behind
any of these reverse proxies), so no code change is needed for a new
domain, only the registration on Pollinations' side.

Env vars a deployment cares about: `FLASK_SECRET_KEY` (set this — without
it a random one is generated per process, invalidating in-flight logins on
every restart), `POLLINATIONS_APP_KEY` (defaults to Meadows' own `pk_...`;
override if you register your own app), `MEADOWS_DATA_DIR` (where
`.sessions.json` lives — point it at a mounted persistent volume).

## How it's put together

- **`app.py`** — a small Flask proxy. Custom OpenAI-compatible endpoints
  (OpenRouter, OpenAI, a local gateway) carry their own `base_url`/`api_key`
  from the browser on every request; the server never persists those, it
  just relays. This sidesteps CORS entirely and keeps those keys out of
  server-side storage.
- **`static/providers.js`** — custom endpoint config lives in
  **localStorage only**, keyed per browser. The built-in "Pollinations"
  provider carries no key at all — see below.

### Sign in with Pollinations — real OAuth, key never leaves the server

Genuine OAuth 2.1 + PKCE ("BYOP" — Bring Your Own Pollen), verified against
Pollinations' live discovery document at
`https://enter.pollinations.ai/.well-known/oauth-authorization-server`:

| | |
|---|---|
| Authorization endpoint | `https://enter.pollinations.ai/authorize` |
| Token endpoint | `https://enter.pollinations.ai/api/oauth/token` |
| Userinfo endpoint | `https://enter.pollinations.ai/api/oauth/userinfo` |
| Auth method | public client, PKCE (S256) — no client secret |

There is no field to paste a Pollinations API key into anywhere in the UI —
the only action is **Sign in with Pollinations**. The backend runs the full
PKCE dance (Meadows ships with its own registered `pk_` App Key, so it
works out of the box — override with `POLLINATIONS_APP_KEY` to use your
own app registration instead), and on success stores the resulting access
token in an **in-memory session dict** (`SESSIONS` in `app.py`, persisted to
`.sessions.json` so logins survive a restart), addressed by an **opaque
random id in an httpOnly cookie**. That cookie is the only thing the
browser ever holds — its JavaScript cannot read it (`document.cookie` won't
show it), and every Pollinations-bound request resolves its key from that
cookie server-side, never from anything the client sends in a request body
(verified: a request that tries to smuggle its own `api_key` for the
Pollinations provider is ignored and rejected). Custom endpoints are the
one place a browser-held key still makes sense, since there's no OAuth for
arbitrary third-party APIs.

### Model auto-detection (backed by real metadata, not guesses)

Pollinations exposes per-modality catalogs — `/text/models`,
`/image/models`, `/audio/models`, `/video/models` — that return each
model's real `brand` ("OpenAI", "Google", "ElevenLabs", "Alibaba", ...),
human title, input/output modalities, and (for audio models) its actual
list of voices. Meadows uses that directly: **exact** brand→icon mapping
instead of regex-guessing from the model id, **exact** capability buckets
(chat/vision/image/video/tts/stt) derived from real input/output-modality
data, and a TTS voice dropdown that repopulates itself from whatever voices
the selected model actually supports. This caught a real bug during
development: `openai-audio` *looks* like a TTS model by name, but its
catalog entry is `category: "text"` with `output_modalities:
["audio","text"]` — it's an omni chat model, not a plain TTS model, and
Pollinations' own `/v1/audio/speech` endpoint correctly rejects it. The
metadata knew; a regex wouldn't have.

Custom (non-Pollinations) endpoints only expose a bare `GET /models` id
list with no capability metadata, so those fall back to
`static/icons.js`'s regex heuristics (`claude*` → Anthropic, `gemini*` →
Google, `gpt*` → OpenAI, etc.) — with a free-text escape hatch in every
model field in case a guess is wrong.

### Realtime (the actual protocol, not an approximation)

`static/realtime.js` + `/ws/realtime` in `app.py` implement the real
OpenAI-compatible Realtime WebSocket protocol
(`wss://gen.pollinations.ai/v1/realtime?model=gpt-realtime-2.1`) —
`session.update`, `input_audio_buffer.append`, `response.audio.delta`,
server-side voice-activity detection for turn-taking. The browser talks
plain WebSocket JSON to our Flask relay (which authenticates upstream with
`Authorization: Bearer <key>`, server-to-server, so the key never has to
sit in a browser-visible URL); mic audio is downsampled to 24kHz PCM16 and
streamed continuously, replies are decoded and scheduled for gapless
playback via the Web Audio API. Just click Connect and talk — no
push-to-talk needed, the server decides when your turn ends.

### Voice Chain — a different, complementary feature

`static/chain.js` is *not* trying to be the realtime protocol — it's for
wiring together **three independently chosen models**, even across
different providers (say: Pollinations Whisper for STT, your own OpenAI
key for the LLM, ElevenLabs for TTS). Push-to-talk or a simple
volume-based hands-free loop; useful when you want control over each
stage rather than one bundled realtime model.

## Known limitations (honest, not hidden)

- **Video generation is experimental.** Pollinations' `/video/{prompt}`
  works well (confirmed against real models), but there's no standardized
  OpenAI-compatible video endpoint across the industry yet — support on
  custom endpoints will vary and errors are surfaced verbatim.
- **Realtime and custom endpoints**: the `/ws/realtime` relay will attempt
  the same protocol against any custom provider's `{base_url}/realtime`,
  but only Pollinations' has actually been exercised end-to-end here —
  OpenAI's own `/v1/realtime` should work the same way but wasn't tested
  against a live OpenAI key while building this.
- **Sessions are only as durable as the filesystem they're on.** Fine
  locally and on Fly's volume/a VPS; on Render's free plan (no persistent
  disk), a redeploy or idle spin-down logs everyone out.
- **Model capability tags for custom endpoints are still heuristic**,
  since bare `GET /models` doesn't carry capability metadata the way
  Pollinations' modality catalogs do. If a default guess is wrong, every
  model field is free-text — type any id.
