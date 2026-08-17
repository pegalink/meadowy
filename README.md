# 🌾 Meadows

A simple, good-looking AI playground: chat, images, video, text-to-speech,
speech-to-text, a real STT → LLM → TTS voice chain, and genuine low-latency
**Realtime** voice — all against **Pollinations.ai** (with real
"Sign in with Pollinations" OAuth), or any **OpenAI-compatible endpoint**
you configure yourself (OpenRouter, OpenAI, a local gateway, whatever
speaks `/chat/completions`).

## Run it

```bash
cd meadow
pip install -r requirements.txt
python3 app.py
```

Open `http://127.0.0.1:5151`. No build step, no npm, no framework — just
Flask + vanilla JS/CSS, matching the sibling `pollinations/` tester app.

Optional: set `POLLINATIONS_API_KEY` in the environment as a server-side
default key (used when the browser hasn't set its own), and
`FLASK_SECRET_KEY` to keep OAuth sessions stable across restarts (otherwise
a random one is generated per process, which just means an in-flight login
started right before a restart would need to be retried).

## How it's put together

- **`app.py`** — a small, mostly-stateless Flask proxy. Every generation
  request carries its own provider info (`kind`, `base_url`, `api_key`)
  from the browser; the server never persists a key, it just relays the
  call. This sidesteps CORS entirely and keeps keys out of `fetch()` calls
  made from pages that might be inspected. The one place the server *does*
  hold brief state is the OAuth PKCE verifier, in a Flask session, for the
  few seconds between the redirect out and the callback back in.
- **`static/providers.js`** — provider config (name, base URL, API key)
  lives in **localStorage only**, keyed per browser. The built-in
  "Pollinations" provider is always present; add as many custom
  OpenAI-compatible endpoints as you like from the Settings tab.

### Sign in with Pollinations (real OAuth 2.1 + PKCE)

This is genuine "BYOP" (Bring Your Own Pollen) OAuth, not a token-paste
placeholder — verified against Pollinations' live discovery document at
`https://enter.pollinations.ai/.well-known/oauth-authorization-server`:

| | |
|---|---|
| Authorization endpoint | `https://enter.pollinations.ai/authorize` |
| Token endpoint | `https://enter.pollinations.ai/api/oauth/token` |
| Userinfo endpoint | `https://enter.pollinations.ai/api/oauth/userinfo` |
| Auth method | public client, PKCE (S256) — no client secret |

Flow: Settings → paste your app's `pk_` **App Key** (register one at
[enter.pollinations.ai](https://enter.pollinations.ai), with this app's
callback URL — shown right there in Settings — added as an allowed
redirect URI) → **Log in with Pollinations**. The backend generates a PKCE
verifier/challenge, redirects you through Pollinations' real consent
screen, exchanges the returned code for an access token server-side, and
hands that token to the page via a URL *fragment* (`/#pollinations_token=`)
so it never lands in a server log or `Referer` header. That one-time app
registration step is unavoidable for *any* OAuth integration — it's the
same thing you'd do to get a client ID from Google or GitHub — Meadows
just can't do it on your behalf without your account. Prefer not to
bother? The "paste a token directly" field right below it still works.

### Model auto-detection (now backed by real metadata, not guesses)

Pollinations exposes per-modality catalogs — `/text/models`,
`/image/models`, `/audio/models`, `/video/models` — that return each
model's real `brand` ("OpenAI", "Google", "ElevenLabs", "Alibaba", ...),
human title, input/output modalities, and (for audio models) its actual
list of voices. Meadows uses that directly: **exact** brand→icon mapping
instead of regex-guessing from the model id, **exact** capability
buckets (chat/vision/image/video/tts/stt) derived from real
input/output-modality data, and a TTS voice dropdown that repopulates
itself from whatever voices the selected model actually supports. This
caught a real bug during development: `openai-audio` *looks* like a TTS
model by name, but its catalog entry is `category: "text"` with
`output_modalities: ["audio","text"]` — it's an omni chat model, not a
plain TTS model, and Pollinations' own `/v1/audio/speech` endpoint
correctly rejects it. The metadata knew; a regex wouldn't have.

Custom (non-Pollinations) endpoints only expose a bare `GET /models` id
list with no capability metadata, so those still fall back to
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
- **OAuth requires a one-time app registration** at enter.pollinations.ai
  to get a `pk_` App Key — Meadows can't create that for you (no
  authenticated session to do it with), only complete the login flow once
  you have one.
- **Model capability tags for custom endpoints are still heuristic**,
  since bare `GET /models` doesn't carry capability metadata the way
  Pollinations' modality catalogs do. If a default guess is wrong, every
  model field is free-text — type any id.
