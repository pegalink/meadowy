// Realtime — a genuine client for the OpenAI-compatible Realtime WebSocket
// protocol (session.update / input_audio_buffer.append / response.audio.delta
// / ...), relayed through our own /ws/realtime so the API key never has to
// live in the browser. Server-side voice-activity detection handles turn
// taking, so this is just: stream mic audio in continuously, play whatever
// audio comes back, show transcripts as they arrive.

let rtWs = null;
let rtAudioCtx = null;
let rtMicStream = null;
let rtSourceNode = null;
let rtProcessorNode = null;
let rtSilentGain = null;
let rtPlayCursor = 0;
let rtConnected = false;
let rtCurrentAssistantTurn = null;

function downsampleTo24k(float32, srcRate) {
  if (srcRate === 24000) return float32;
  const ratio = srcRate / 24000;
  const newLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, float32.length - 1);
    const frac = srcIndex - i0;
    out[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
  }
  return out;
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToFloat32(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;
  return float32;
}

function playRtAudioDelta(b64) {
  const float32 = base64ToFloat32(b64);
  if (!float32.length) return;
  const buffer = rtAudioCtx.createBuffer(1, float32.length, 24000);
  buffer.copyToChannel(float32, 0);
  const src = rtAudioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(rtAudioCtx.destination);
  const startAt = Math.max(rtPlayCursor, rtAudioCtx.currentTime);
  src.start(startAt);
  rtPlayCursor = startAt + buffer.duration;
}

function appendRtTurn(role) {
  const log = document.getElementById("rt-log");
  const el = document.createElement("div");
  el.className = "chain-turn";
  el.innerHTML = `<div class="turn-row"><span class="turn-label">${role === "user" ? "You" : "Meadows"}</span><span class="turn-text"></span></div>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  const textEl = el.querySelector(".turn-text");
  let buf = "";
  return {
    append(chunk) {
      buf += chunk;
      textEl.textContent = buf;
      log.scrollTop = log.scrollHeight;
    },
  };
}

function handleRealtimeEvent(raw) {
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return;
  }
  switch (evt.type) {
    case "response.audio.delta":
      playRtAudioDelta(evt.delta);
      break;
    case "response.audio_transcript.delta":
      if (!rtCurrentAssistantTurn) rtCurrentAssistantTurn = appendRtTurn("assistant");
      rtCurrentAssistantTurn.append(evt.delta || "");
      break;
    case "conversation.item.input_audio_transcription.completed":
      appendRtTurn("user").append(evt.transcript || "(nothing heard)");
      break;
    case "response.done":
      rtCurrentAssistantTurn = null;
      break;
    case "error":
      setStatus(document.getElementById("rt-status"), "Error: " + (evt.error?.message || JSON.stringify(evt)), "error");
      break;
    default:
      break;
  }
}

function startRtMicStreaming() {
  rtSourceNode = rtAudioCtx.createMediaStreamSource(rtMicStream);
  rtProcessorNode = rtAudioCtx.createScriptProcessor(4096, 1, 1);
  rtSilentGain = rtAudioCtx.createGain();
  rtSilentGain.gain.value = 0; // capture without feeding mic audio back to speakers
  rtSourceNode.connect(rtProcessorNode);
  rtProcessorNode.connect(rtSilentGain);
  rtSilentGain.connect(rtAudioCtx.destination);
  rtProcessorNode.onaudioprocess = (e) => {
    if (!rtWs || rtWs.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const down = downsampleTo24k(input, rtAudioCtx.sampleRate);
    const pcm16 = floatTo16BitPCM(down);
    rtWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: int16ToBase64(pcm16) }));
  };
}

async function connectRealtime() {
  const status = document.getElementById("rt-status");
  const hint = document.getElementById("rt-hint");
  const btn = document.getElementById("rt-connect-btn");
  const model = document.getElementById("rt-model").value.trim() || "gpt-realtime-2.1";
  const voice = document.getElementById("rt-voice").value;
  const provider = getActiveProvider();

  setStatus(status, "Connecting…");
  btn.disabled = true;

  try {
    rtMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus(status, "Microphone access is required: " + err.message, "error");
    btn.disabled = false;
    return;
  }

  rtAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  rtPlayCursor = rtAudioCtx.currentTime;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const qs = new URLSearchParams({ ...providerRequestFields(provider), model });
  rtWs = new WebSocket(`${proto}//${location.host}/ws/realtime?${qs.toString()}`);

  rtWs.addEventListener("open", () => {
    rtWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice,
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          turn_detection: { type: "server_vad" },
          input_audio_transcription: { model: "whisper-1" },
        },
      })
    );
    startRtMicStreaming();
    rtConnected = true;
    btn.innerHTML = '<span class="btn-icon">🛑</span>Disconnect';
    btn.disabled = false;
    hint.textContent = "Listening — just talk, no button to hold.";
    setStatus(status, "Connected.", "ok");
  });
  rtWs.addEventListener("message", (ev) => handleRealtimeEvent(ev.data));
  rtWs.addEventListener("close", () => {
    setStatus(status, "Disconnected.");
    cleanupRealtime();
  });
  rtWs.addEventListener("error", () => {
    setStatus(status, "Connection error.", "error");
  });
}

function disconnectRealtime() {
  if (rtWs) rtWs.close();
  cleanupRealtime();
}

function cleanupRealtime() {
  rtConnected = false;
  if (rtProcessorNode) {
    rtProcessorNode.onaudioprocess = null;
    rtProcessorNode.disconnect();
  }
  if (rtSourceNode) rtSourceNode.disconnect();
  if (rtSilentGain) rtSilentGain.disconnect();
  if (rtMicStream) rtMicStream.getTracks().forEach((t) => t.stop());
  const btn = document.getElementById("rt-connect-btn");
  if (btn) {
    btn.innerHTML = '<span class="btn-icon">🎧</span>Connect';
    btn.disabled = false;
  }
  const hint = document.getElementById("rt-hint");
  if (hint) hint.textContent = "Not connected.";
  rtWs = null;
}

function initRealtime() {
  wireModelIconPreview("rt-model", "rt-model-icon");
  document.getElementById("rt-connect-btn").addEventListener("click", () => {
    if (rtConnected) disconnectRealtime();
    else connectRealtime();
  });
}
