// Voice Chain — a real STT -> LLM -> TTS pipeline you can drive either by
// holding a push-to-talk button, or hands-free via a simple volume-based
// voice-activity detector (not a low-latency realtime protocol, but it
// gets close for a playground).

let chainMessages = []; // [{role, content}] — conversation memory, no system prompt in here
let chainBusy = false;

function createChainRecorder({ onSegment }) {
  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let dataArray = null;
  let recorder = null;
  let chunks = [];
  let recording = false;
  let vadHandle = null;

  async function ensureStream() {
    if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      dataArray = new Uint8Array(analyser.frequencyBinCount);
    }
  }

  function level() {
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / dataArray.length);
  }

  function startRecorder() {
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => onSegment(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    recorder.start();
    recording = true;
  }

  function stopRecorder() {
    if (vadHandle) { cancelAnimationFrame(vadHandle); vadHandle = null; }
    if (recording && recorder && recorder.state !== "inactive") recorder.stop();
    recording = false;
  }

  return {
    async startPushToTalk() {
      await ensureStream();
      startRecorder();
    },
    stopPushToTalk() {
      stopRecorder();
    },
    async startAutoListen() {
      await ensureStream();
      startRecorder();
      const THRESHOLD = 0.02;
      const SILENCE_MS = 900;
      const MAX_MS = 15000;
      const startedAt = Date.now();
      let speechStarted = false;
      let silenceStart = null;

      const loop = () => {
        if (!recording) return;
        const now = Date.now();
        const lvl = level();
        if (lvl > THRESHOLD) {
          speechStarted = true;
          silenceStart = null;
        } else if (speechStarted) {
          if (silenceStart === null) silenceStart = now;
          if (now - silenceStart > SILENCE_MS) { stopRecorder(); return; }
        }
        if (now - startedAt > MAX_MS) { stopRecorder(); return; }
        vadHandle = requestAnimationFrame(loop);
      };
      vadHandle = requestAnimationFrame(loop);
    },
    cancel() {
      stopRecorder();
    },
  };
}

let chainRecorder = null;

function initChain() {
  const btn = document.getElementById("chain-record-btn");
  const label = btn.querySelector("span");
  const autoLoop = document.getElementById("chain-auto-loop");
  const resetBtn = document.getElementById("chain-reset");

  chainRecorder = createChainRecorder({ onSegment: handleChainSegment });

  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (autoLoop.checked || chainBusy) return;
    btn.classList.add("recording");
    chainRecorder.startPushToTalk();
  });
  const stopPTT = () => {
    if (autoLoop.checked) return;
    btn.classList.remove("recording");
    chainRecorder.stopPushToTalk();
  };
  btn.addEventListener("pointerup", stopPTT);
  btn.addEventListener("pointerleave", stopPTT);
  btn.addEventListener("pointercancel", stopPTT);

  autoLoop.addEventListener("change", () => {
    if (autoLoop.checked) {
      label.textContent = "Listening…";
      startAutoCycle();
    } else {
      label.textContent = "Hold to talk";
      btn.classList.remove("recording");
      chainRecorder.cancel();
    }
  });

  resetBtn.addEventListener("click", () => {
    chainMessages = [];
    document.getElementById("chain-log").innerHTML = "";
    setStatus(document.getElementById("chain-status"), "Conversation reset.");
  });
}

function startAutoCycle() {
  if (chainBusy) return; // re-armed automatically once the current turn finishes
  const btn = document.getElementById("chain-record-btn");
  btn.classList.add("recording");
  chainRecorder.startAutoListen();
}

async function handleChainSegment(blob) {
  const btn = document.getElementById("chain-record-btn");
  const autoLoop = document.getElementById("chain-auto-loop");
  btn.classList.remove("recording");

  if (blob.size < 800) {
    if (autoLoop.checked) startAutoCycle(); // treat as silence, keep listening
    return;
  }

  chainBusy = true;
  await runChainTurn(blob);
  chainBusy = false;

  if (autoLoop.checked) startAutoCycle();
}

async function runChainTurn(blob) {
  const status = document.getElementById("chain-status");
  const provider = getActiveProvider();
  const sttModel = document.getElementById("chain-stt-model").value;
  const llmModel = document.getElementById("chain-llm-model").value;
  const ttsModel = document.getElementById("chain-tts-model").value;
  const voice = document.getElementById("chain-tts-voice").value;
  const systemPrompt = document.getElementById("chain-system").value.trim();

  if (!sttModel || !llmModel || !ttsModel) {
    setStatus(status, "Pick a model for each of the three stages first.", "error");
    return;
  }

  const turn = appendChainTurn();
  setStatus(status, "Transcribing…");
  let transcript;
  try {
    transcript = (await transcribeAudio(provider, sttModel, blob)).trim();
  } catch (err) {
    setStatus(status, "STT error: " + err.message, "error");
    turn.remove();
    return;
  }
  turn.setTranscript(transcript || "(nothing heard)");
  if (!transcript) {
    setStatus(status, "Didn't catch that — try again.", "error");
    return;
  }

  chainMessages.push({ role: "user", content: transcript });
  const messages = systemPrompt ? [{ role: "system", content: systemPrompt }, ...chainMessages] : [...chainMessages];

  setStatus(status, "Thinking…");
  let reply;
  try {
    reply = await streamChat(provider, llmModel, messages, (full) => turn.setReply(full));
  } catch (err) {
    setStatus(status, "LLM error: " + err.message, "error");
    return;
  }
  chainMessages.push({ role: "assistant", content: reply });
  turn.setReply(reply);

  setStatus(status, "Speaking…");
  try {
    const audioUrl = await speakText(provider, ttsModel, voice, reply);
    await turn.setAudio(audioUrl); // resolves once playback ends, so auto-listen doesn't hear itself
    setStatus(status, "Done.", "ok");
  } catch (err) {
    setStatus(status, "TTS error: " + err.message, "error");
  }
}

function appendChainTurn() {
  const log = document.getElementById("chain-log");
  const el = document.createElement("div");
  el.className = "chain-turn";
  el.innerHTML = `
    <div class="turn-row"><span class="turn-label">You</span><span class="turn-you"></span></div>
    <div class="turn-row"><span class="turn-label">Reply</span><span class="turn-reply markdown-inline"></span></div>
  `;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return {
    remove: () => el.remove(),
    setTranscript: (t) => { el.querySelector(".turn-you").textContent = t; },
    setReply: (t) => {
      el.querySelector(".turn-reply").innerHTML = renderMarkdown(t);
      log.scrollTop = log.scrollHeight;
    },
    setAudio: (dataUrl) =>
      new Promise((resolve) => {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.autoplay = true;
        audio.src = dataUrl;
        audio.addEventListener("ended", resolve);
        audio.addEventListener("error", resolve);
        el.appendChild(audio);
        log.scrollTop = log.scrollHeight;
      }),
  };
}
