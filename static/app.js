// Meadows — main app wiring. Plain functions, no build step; loaded after
// icons.js / providers.js / conversations.js / markdown.js, and before
// chain.js (which reuses the helpers defined here: parseSSEStream,
// streamChat, transcribeAudio, speakText).

const uploads = {}; // key -> data URL string, shared by all dropzones
let session = { logged_in: false, name: null }; // Pollinations login state — never a key, just a flag + display name
let currentPanel = "chat";
let activeConversation = null;

// =========================================================================
// theme
// =========================================================================

function initTheme() {
  const saved = localStorage.getItem("meadows.theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  updateThemeBtn(saved);
}
function updateThemeBtn(theme) {
  document.getElementById("theme-btn").textContent = theme === "dark" ? "☀️" : "🌙";
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("meadows.theme", next);
  updateThemeBtn(next);
}

function initFireflies() {
  const host = document.getElementById("fireflies");
  const n = 7;
  for (let i = 0; i < n; i++) {
    const f = document.createElement("div");
    f.className = "firefly";
    f.style.left = `${5 + Math.random() * 90}%`;
    f.style.top = `${5 + Math.random() * 85}%`;
    f.style.animationDelay = `${(Math.random() * 10).toFixed(2)}s, ${(Math.random() * 3).toFixed(2)}s`;
    host.appendChild(f);
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = "status" + (kind ? ` ${kind}` : "");
}

// =========================================================================
// panel navigation (sidebar tool buttons + settings, chat is the default)
// =========================================================================

function showPanel(tab) {
  currentPanel = tab;
  document.querySelectorAll(".panel-view").forEach((p) => p.classList.remove("active"));
  document.getElementById(`panel-${tab}`)?.classList.add("active");
  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("sidebar")?.classList.remove("open");
  renderAuthGate();
}

function initSidebarNav() {
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => showPanel(btn.dataset.tab));
  });
  document.getElementById("sidebar-toggle")?.addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });
  document.getElementById("sidebar-scrim")?.addEventListener("click", () => {
    document.getElementById("sidebar").classList.remove("open");
  });
}

// =========================================================================
// session (Pollinations login) + the setup gate
// =========================================================================

async function refreshSession() {
  try {
    const res = await fetch("/api/session");
    session = await res.json();
  } catch {
    session = { logged_in: false, name: null };
  }
  renderAccountArea();
  renderAuthGate();
}

async function doLogout() {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  session = { logged_in: false, name: null };
  renderAccountArea();
  renderAuthGate();
}

function accountAreaHtml() {
  if (session.logged_in) {
    const initial = (session.name || "P").trim().charAt(0).toUpperCase();
    return `
      <div class="account-chip">
        <span class="account-avatar">${escapeHtml(initial)}</span>
        <span class="account-name">${escapeHtml(session.name || "Signed in")}</span>
        <button class="account-logout" title="Log out" aria-label="Log out">⏻</button>
      </div>`;
  }
  return `<button class="sidebar-login-btn"><span class="btn-icon">🔑</span>Sign in with Pollinations</button>`;
}

function renderAccountArea() {
  ["account-area", "settings-account-area"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = accountAreaHtml();
    el.querySelector(".sidebar-login-btn")?.addEventListener("click", () => (window.location.href = "/oauth/login"));
    el.querySelector(".account-logout")?.addEventListener("click", doLogout);
  });
}

// A provider counts as "set up" only once we know it has usable
// credentials — no anonymous Pollinations traffic, no invisible
// server-side default. Custom endpoints just need a base URL (some local/
// no-auth gateways genuinely have no key).
function isProviderConfigured(provider) {
  if (provider.kind === "pollinations") return session.logged_in;
  return !!provider.baseUrl;
}

function renderAuthGate() {
  const gate = document.getElementById("auth-gate");
  if (!gate) return;
  if (currentPanel === "settings") {
    gate.hidden = true;
    return;
  }
  const provider = getActiveProvider();
  const configured = isProviderConfigured(provider);
  gate.hidden = configured;
  if (configured) return;

  const body = document.getElementById("auth-gate-body");
  if (provider.kind === "pollinations") {
    body.innerHTML = `
      <h2>Welcome to Meadows</h2>
      <p>Sign in with your Pollinations account to start chatting, generating images, and more. Nothing is sent anywhere until you do.</p>
      <button id="auth-gate-login-btn"><span class="btn-icon">🔑</span>Sign in with Pollinations</button>`;
    document.getElementById("auth-gate-login-btn").addEventListener("click", () => (window.location.href = "/oauth/login"));
  } else {
    body.innerHTML = `
      <h2>Endpoint not configured</h2>
      <p>"${escapeHtml(provider.name)}" needs a base URL. Open Settings to finish setting it up, or switch back to Pollinations.</p>
      <button id="auth-gate-settings-btn"><span class="btn-icon">⚙️</span>Open Settings</button>`;
    document.getElementById("auth-gate-settings-btn").addEventListener("click", () => showPanel("settings"));
  }
}

// =========================================================================
// dropzones (shared by chat / image reference upload)
// =========================================================================

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function initDropzone(key, dropId, fileId, thumbId, previewId, removeId) {
  const drop = document.getElementById(dropId);
  const input = document.getElementById(fileId);
  const thumb = document.getElementById(thumbId);
  const preview = document.getElementById(previewId);
  const removeBtn = document.getElementById(removeId);

  const setFile = async (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const dataUrl = await fileToDataUrl(file);
    uploads[key] = dataUrl;
    thumb.src = dataUrl;
    preview.hidden = false;
    drop.classList.add("has-file");
  };
  const clearFile = () => {
    delete uploads[key];
    input.value = "";
    preview.hidden = true;
    drop.classList.remove("has-file");
  };

  drop.addEventListener("click", (e) => {
    if (e.target === removeBtn || e.target.tagName === "TEXTAREA" || e.target.tagName === "BUTTON") return;
    input.click();
  });
  input.addEventListener("change", () => setFile(input.files[0]));
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    clearFile();
  });
  ["dragenter", "dragover"].forEach((evt) =>
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.remove("dragover");
    })
  );
  drop.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    setFile(file);
  });
}

// =========================================================================
// active-endpoint selector (Settings) + model auto-detection
// =========================================================================

function renderProviderSelect() {
  const sel = document.getElementById("provider-select");
  const providers = loadProviders();
  const activeId = getActiveProviderId();
  sel.innerHTML = "";
  providers.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  sel.value = activeId;
  updateProviderDot();
}

function updateProviderDot() {
  const provider = getActiveProvider();
  const dot = document.getElementById("provider-dot");
  const misconfigured = provider.kind === "custom" && !provider.baseUrl;
  dot.classList.toggle("off", misconfigured);
  const label = provider.kind === "pollinations" ? (session.logged_in ? "Signed in" : "Not signed in") : providerStatusLabel(provider);
  document.getElementById("provider-pill").title = `${provider.name} — ${label}`;
}

function wireModelIconPreview(inputId, iconSlotId) {
  const input = document.getElementById(inputId);
  const slot = document.getElementById(iconSlotId);
  const update = () => (slot.innerHTML = providerIconHtml(lookupModelMeta(input.value) || input.value));
  input.addEventListener("input", update);
  update();
}

// Repopulate a voice <select> from the currently selected model's real
// voice list (Pollinations catalog data), falling back to the select's
// original static options for custom endpoints / unrecognized models.
function wireVoiceAutoPopulate(modelInputId, voiceSelectId) {
  const input = document.getElementById(modelInputId);
  const select = document.getElementById(voiceSelectId);
  const defaultVoices = Array.from(select.options).map((o) => o.value);
  const update = () => {
    const meta = lookupModelMeta(input.value);
    const voices = meta && meta.voices && meta.voices.length ? meta.voices : defaultVoices;
    const current = select.value;
    select.innerHTML = "";
    voices.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    });
    select.value = voices.includes(current) ? current : voices[0];
  };
  input.addEventListener("input", update);
  input.addEventListener("change", update);
}

const DATALIST_MAP = {
  chat: "chat-models-list",
  image: "img-models-list",
  video: "vid-models-list",
  tts: "tts-models-list",
  stt: "stt-models-list",
};

function populateDatalist(id, models) {
  const dl = document.getElementById(id);
  if (!dl) return;
  dl.innerHTML = "";
  models.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    dl.appendChild(opt);
  });
}

function maybeDefault(inputId, models) {
  const input = document.getElementById(inputId);
  if (input && !input.value && models.length) {
    input.value = models[0].id;
    input.dispatchEvent(new Event("input"));
  }
}

async function loadAndRenderModels(forceRefresh) {
  const provider = getActiveProvider();
  let entry = forceRefresh ? null : getCachedModels(provider.id);
  if (entry) applyModelEntry(entry);

  try {
    entry = await fetchModelsForProvider(provider);
  } catch (err) {
    entry = entry || { models: FALLBACK_MODELS[provider.kind] || [], error: String(err) };
  }
  applyModelEntry(entry);
  return entry;
}

function applyModelEntry(entry) {
  const chat = modelsByCapability(entry, "chat");
  const image = modelsByCapability(entry, "image");
  const video = modelsByCapability(entry, "video");
  const tts = modelsByCapability(entry, "tts");
  const stt = modelsByCapability(entry, "stt");

  populateDatalist(DATALIST_MAP.chat, chat);
  populateDatalist(DATALIST_MAP.image, image);
  populateDatalist(DATALIST_MAP.video, video);
  populateDatalist(DATALIST_MAP.tts, tts);
  populateDatalist(DATALIST_MAP.stt, stt);

  maybeDefault("chat-model", chat);
  maybeDefault("img-model", image);
  maybeDefault("vid-model", video.length ? video : chat); // most providers have no dedicated video models yet
  maybeDefault("tts-model", tts);
  maybeDefault("stt-model", stt);
  maybeDefault("chain-stt-model", stt);
  maybeDefault("chain-llm-model", chat);
  maybeDefault("chain-tts-model", tts);

  renderModelPreview(entry);
}

function renderModelPreview(entry) {
  const host = document.getElementById("model-list-preview");
  if (!host) return;
  host.innerHTML = "";
  if (entry.error && (!entry.models || !entry.models.length)) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `Couldn't fetch a model list (${entry.error}). Using built-in fallback models — you can still type any model id by hand.`;
    host.appendChild(p);
  }
  (entry.models || []).forEach((m) => {
    const chip = document.createElement("span");
    chip.className = "model-chip";
    const caps = Object.entries(m.cap || {}).filter(([, v]) => v).map(([k]) => k).join(", ");
    chip.title = `${m.title || m.id}${m.brand ? " — " + m.brand : ""}\n${caps}`;
    chip.innerHTML = `${providerIconHtml(m, 14)}<span>${m.id}</span>`;
    host.appendChild(chip);
  });
}

async function onProviderChange() {
  const sel = document.getElementById("provider-select");
  setActiveProviderId(sel.value);
  updateProviderDot();
  renderAuthGate();
  await loadAndRenderModels(false);
}

// =========================================================================
// settings panel: endpoint CRUD
// =========================================================================

function initSettings() {
  renderAccountArea();

  document.getElementById("add-provider-btn").addEventListener("click", () => {
    const name = document.getElementById("new-provider-name").value.trim();
    const baseUrl = document.getElementById("new-provider-baseurl").value.trim();
    const apiKey = document.getElementById("new-provider-key").value.trim();
    if (!name || !baseUrl) return;
    const id = crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    upsertProvider({ id, name, kind: "custom", baseUrl, apiKey });
    document.getElementById("new-provider-name").value = "";
    document.getElementById("new-provider-baseurl").value = "";
    document.getElementById("new-provider-key").value = "";
    setActiveProviderId(id);
    renderProviderSelect();
    renderCustomProviderList();
    renderAuthGate();
    loadAndRenderModels(true);
  });

  document.getElementById("refresh-models-btn").addEventListener("click", () => loadAndRenderModels(true));

  renderCustomProviderList();
}

function renderCustomProviderList() {
  const host = document.getElementById("custom-provider-list");
  host.innerHTML = "";
  const customs = loadProviders().filter((p) => p.kind === "custom");
  if (!customs.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No custom endpoints yet — add one below.";
    host.appendChild(p);
    return;
  }
  customs.forEach((provider) => {
    const card = document.createElement("div");
    card.className = "provider-card";
    const active = getActiveProviderId() === provider.id;
    card.innerHTML = `
      <div class="provider-card-head">
        <strong>${escapeHtml(provider.name)}</strong>
        ${active ? '<span class="badge">active</span>' : ""}
      </div>
      <p class="hint">${escapeHtml(provider.baseUrl)}</p>
      <p class="hint">${escapeHtml(providerStatusLabel(provider))}</p>
      <div class="row-actions"></div>
    `;
    const actions = card.querySelector(".row-actions");

    const useBtn = document.createElement("button");
    useBtn.className = "btn-ghost";
    useBtn.textContent = "Use this endpoint";
    useBtn.addEventListener("click", () => {
      setActiveProviderId(provider.id);
      renderProviderSelect();
      renderCustomProviderList();
      renderAuthGate();
      loadAndRenderModels(true);
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-ghost";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      deleteProvider(provider.id);
      renderProviderSelect();
      renderCustomProviderList();
      renderAuthGate();
      loadAndRenderModels(false);
    });

    actions.appendChild(useBtn);
    actions.appendChild(removeBtn);
    host.appendChild(card);
  });
}

// =========================================================================
// SSE streaming helpers (shared by chat panel + voice chain)
// =========================================================================

async function parseSSEStream(response, onDelta) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      for (const line of rawEvent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data);
          const delta = obj.choices?.[0]?.delta?.content ?? obj.choices?.[0]?.message?.content ?? "";
          if (delta) {
            full += delta;
            onDelta(full, delta);
          }
        } catch {
          // ignore malformed/heartbeat lines
        }
      }
    }
  }
  return full;
}

async function streamChat(provider, model, messages, onDelta) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...providerRequestFields(provider), model, messages }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `provider returned ${res.status}`);
  }
  return parseSSEStream(res, onDelta);
}

async function chatOnce(provider, model, messages) {
  return streamChat(provider, model, messages, () => {});
}

async function transcribeAudio(provider, model, blob) {
  const form = new FormData();
  form.append("kind", provider.kind);
  form.append("base_url", provider.baseUrl || "");
  form.append("api_key", provider.apiKey || "");
  form.append("model", model || "whisper-1");
  form.append("file", blob, "recording.webm");

  const res = await fetch("/api/stt", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `provider returned ${res.status}`);
  return data.text || "";
}

async function speakText(provider, model, voice, text) {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...providerRequestFields(provider), model, voice, text }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `provider returned ${res.status}`);
  return data.audio;
}

// =========================================================================
// chat panel — a ChatGPT/Claude-style shell: a sidebar of conversations,
// each persisted to localStorage (message text only, never a key).
// =========================================================================

function renderConversationList() {
  const host = document.getElementById("conversation-list");
  const list = loadConversations();
  const activeId = getActiveConversationId();
  host.innerHTML = "";
  list.forEach((c) => {
    const item = document.createElement("div");
    item.className = "conversation-item" + (c.id === activeId ? " active" : "");
    item.innerHTML = `<span class="conversation-title">${escapeHtml(c.title)}</span><button class="conversation-delete" title="Delete" aria-label="Delete chat">✕</button>`;
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("conversation-delete")) return;
      switchConversation(c.id);
    });
    item.querySelector(".conversation-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(c.id);
      if (getActiveConversationId()) {
        switchConversation(getActiveConversationId());
      } else {
        activeConversation = createConversation();
        renderChatLog();
      }
      renderConversationList();
    });
    host.appendChild(item);
  });
}

function switchConversation(id) {
  const convo = getConversation(id);
  if (!convo) return;
  setActiveConversationId(id);
  activeConversation = convo;
  renderChatLog();
  renderConversationList();
  showPanel("chat");
}

function startNewChat() {
  activeConversation = createConversation();
  renderChatLog();
  renderConversationList();
  showPanel("chat");
  document.getElementById("chat-input")?.focus();
}

function renderChatLog() {
  const log = document.getElementById("chat-log");
  log.innerHTML = "";
  if (!activeConversation.messages.length) {
    log.innerHTML = `
      <div class="chat-empty" id="chat-empty">
        <span class="chat-empty-mark">🌾</span>
        <h2>What's growing today?</h2>
        <p>Pick a model above and start typing. Attach an image for vision-capable models.</p>
      </div>`;
    return;
  }
  for (const msg of activeConversation.messages) {
    const text = typeof msg.content === "string" ? msg.content : msg.content.find((c) => c.type === "text")?.text || "";
    const image = Array.isArray(msg.content) ? msg.content.find((c) => c.type === "image_url")?.image_url?.url : null;
    if (msg.role === "user") {
      let html = escapeHtml(text).replace(/\n/g, "<br>");
      if (image) html += `<br><img src="${image}" alt="attachment">`;
      appendBubble("user", html);
    } else {
      appendBubble("assistant", renderMarkdown(text));
    }
  }
  log.scrollTop = log.scrollHeight;
}

function appendBubble(role, innerHtml) {
  document.getElementById("chat-empty")?.remove();
  const log = document.getElementById("chat-log");
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  const body = document.createElement("div");
  body.className = "markdown-inline";
  body.innerHTML = innerHtml;
  bubble.appendChild(body);
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
  return body;
}

function autoGrowTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

async function sendChat() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;
  const model = document.getElementById("chat-model").value.trim();
  const status = document.getElementById("chat-status");
  const sendBtn = document.getElementById("chat-send");

  if (!model) {
    setStatus(status, "Pick a model first.", "error");
    return;
  }

  const image = uploads["chat"];
  const userContent = image ? [{ type: "text", text }, { type: "image_url", image_url: { url: image } }] : text;

  let userHtml = escapeHtml(text).replace(/\n/g, "<br>");
  if (image) userHtml += `<br><img src="${image}" alt="attachment">`;
  appendBubble("user", userHtml);

  const isFirstMessage = activeConversation.messages.length === 0;
  activeConversation.messages.push({ role: "user", content: userContent });
  updateConversation(activeConversation.id, {
    messages: activeConversation.messages,
    title: isFirstMessage ? titleFromFirstMessage(text) : activeConversation.title,
  });
  renderConversationList();

  input.value = "";
  autoGrowTextarea(input);
  delete uploads["chat"];
  document.getElementById("chat-file-preview").hidden = true;
  document.getElementById("chat-drop").classList.remove("has-file");

  const assistantBody = appendBubble("assistant", '<span class="hint">thinking…</span>');
  sendBtn.disabled = true;
  setStatus(status, "");

  try {
    const provider = getActiveProvider();
    const final = await streamChat(provider, model, activeConversation.messages, (full) => {
      assistantBody.innerHTML = renderMarkdown(full);
      document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight;
    });
    activeConversation.messages.push({ role: "assistant", content: final });
    updateConversation(activeConversation.id, { messages: activeConversation.messages });
  } catch (err) {
    assistantBody.innerHTML = `<span class="hint">(error)</span>`;
    setStatus(status, "Error: " + err.message, "error");
  } finally {
    sendBtn.disabled = false;
  }
}

// =========================================================================
// image panel
// =========================================================================

async function generateImage() {
  const status = document.getElementById("img-status");
  const result = document.getElementById("img-result");
  const btn = document.getElementById("img-btn");
  setStatus(status, "Generating…");
  result.innerHTML = "";
  btn.disabled = true;

  const provider = getActiveProvider();
  const body = {
    ...providerRequestFields(provider),
    prompt: document.getElementById("img-prompt").value,
    model: document.getElementById("img-model").value,
    width: document.getElementById("img-width").value,
    height: document.getElementById("img-height").value,
    seed: document.getElementById("img-seed").value,
    image: uploads["img"] || undefined,
  };

  try {
    const res = await fetch("/api/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setStatus(status, "Error: " + (data.error || res.status), "error");
      return;
    }
    setStatus(status, "Done.", "ok");
    const img = document.createElement("img");
    img.src = data.image;
    result.appendChild(img);
  } catch (err) {
    setStatus(status, "Error: " + err, "error");
  } finally {
    btn.disabled = false;
  }
}

// =========================================================================
// video panel
// =========================================================================

async function generateVideo() {
  const status = document.getElementById("vid-status");
  const result = document.getElementById("vid-result");
  const btn = document.getElementById("vid-btn");
  setStatus(status, "Generating video — this can take a while…");
  result.innerHTML = "";
  btn.disabled = true;

  const provider = getActiveProvider();
  const body = {
    ...providerRequestFields(provider),
    prompt: document.getElementById("vid-prompt").value,
    model: document.getElementById("vid-model").value,
    width: document.getElementById("vid-width").value,
    height: document.getElementById("vid-height").value,
    seed: document.getElementById("vid-seed").value,
  };

  try {
    const res = await fetch("/api/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setStatus(status, "Error: " + (data.error || res.status) + " — this provider/model may not support video generation yet.", "error");
      return;
    }
    setStatus(status, "Done.", "ok");
    const video = document.createElement("video");
    video.src = data.video;
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    result.appendChild(video);
  } catch (err) {
    setStatus(status, "Error: " + err, "error");
  } finally {
    btn.disabled = false;
  }
}

// =========================================================================
// TTS panel
// =========================================================================

async function generateSpeech() {
  const status = document.getElementById("tts-status");
  const result = document.getElementById("tts-result");
  const btn = document.getElementById("tts-btn");
  setStatus(status, "Generating…");
  result.innerHTML = "";
  btn.disabled = true;

  const provider = getActiveProvider();
  const body = {
    ...providerRequestFields(provider),
    text: document.getElementById("tts-text").value,
    model: document.getElementById("tts-model").value,
    voice: document.getElementById("tts-voice").value,
  };

  try {
    const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setStatus(status, "Error: " + (data.error || res.status), "error");
      return;
    }
    setStatus(status, "Done.", "ok");
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.autoplay = true;
    audio.src = data.audio;
    result.appendChild(audio);

    const link = document.createElement("a");
    link.href = data.audio;
    link.download = "speech.mp3";
    link.textContent = "Download";
    link.className = "download-link";
    result.appendChild(link);
  } catch (err) {
    setStatus(status, "Error: " + err, "error");
  } finally {
    btn.disabled = false;
  }
}

// =========================================================================
// hold-to-record helper (shared by STT panel + voice chain)
// =========================================================================

function wireHoldToRecord(button, { onStop, onStart } = {}) {
  let recorder = null;
  let chunks = [];
  let stream = null;
  let startedAt = 0;
  let active = false;

  const start = async (e) => {
    if (e) e.preventDefault();
    if (active) return;
    active = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      active = false;
      alert("Microphone access is required: " + err.message);
      return;
    }
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
    recorder.start();
    startedAt = Date.now();
    button.classList.add("recording");
    if (onStart) onStart();
  };

  const stop = () => {
    if (!active || !recorder) return;
    active = false;
    button.classList.remove("recording");
    const elapsed = Date.now() - startedAt;
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (elapsed < 250) return; // ignore accidental taps
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      onStop(blob);
    };
    recorder.stop();
  };

  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", stop);
  button.addEventListener("pointerleave", stop);
  button.addEventListener("pointercancel", stop);
}

// =========================================================================
// STT panel
// =========================================================================

let sttBlob = null;

function initSttPanel() {
  const btn = document.getElementById("stt-record-btn");
  const preview = document.getElementById("stt-audio-preview");

  wireHoldToRecord(btn, {
    onStop: (blob) => {
      sttBlob = blob;
      preview.src = URL.createObjectURL(blob);
      preview.hidden = false;
    },
  });

  document.getElementById("stt-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    sttBlob = file;
    preview.src = URL.createObjectURL(file);
    preview.hidden = false;
  });

  document.getElementById("stt-btn").addEventListener("click", async () => {
    const status = document.getElementById("stt-status");
    const result = document.getElementById("stt-result");
    if (!sttBlob) {
      setStatus(status, "Record or upload audio first.", "error");
      return;
    }
    setStatus(status, "Transcribing…");
    result.textContent = "";
    try {
      const provider = getActiveProvider();
      const model = document.getElementById("stt-model").value;
      const text = await transcribeAudio(provider, model, sttBlob);
      result.textContent = text;
      setStatus(status, "Done.", "ok");
    } catch (err) {
      setStatus(status, "Error: " + err.message, "error");
    }
  });
}

// =========================================================================
// init
// =========================================================================

document.addEventListener("DOMContentLoaded", () => {
  const loginError = new URLSearchParams(location.search).get("login_error");
  if (loginError) history.replaceState(null, "", location.pathname);

  initTheme();
  initFireflies();
  initSidebarNav();
  document.getElementById("theme-btn").addEventListener("click", toggleTheme);

  initDropzone("chat", "chat-drop", "chat-file", "chat-file-thumb", "chat-file-preview", "chat-file-remove");
  initDropzone("img", "img-drop", "img-file", "img-file-thumb", "img-file-preview", "img-file-remove");

  wireModelIconPreview("chat-model", "chat-model-icon");
  wireModelIconPreview("img-model", "img-model-icon");
  wireModelIconPreview("vid-model", "vid-model-icon");
  wireModelIconPreview("tts-model", "tts-model-icon");
  wireModelIconPreview("stt-model", "stt-model-icon");
  wireModelIconPreview("chain-stt-model", "chain-stt-model-icon");
  wireModelIconPreview("chain-llm-model", "chain-llm-model-icon");
  wireModelIconPreview("chain-tts-model", "chain-tts-model-icon");
  wireVoiceAutoPopulate("tts-model", "tts-voice");
  wireVoiceAutoPopulate("chain-tts-model", "chain-tts-voice");

  document.getElementById("new-chat-btn").addEventListener("click", startNewChat);
  document.getElementById("chat-send").addEventListener("click", sendChat);
  const chatInput = document.getElementById("chat-input");
  chatInput.addEventListener("input", () => autoGrowTextarea(chatInput));
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  document.getElementById("img-btn").addEventListener("click", generateImage);
  document.getElementById("vid-btn").addEventListener("click", generateVideo);
  document.getElementById("tts-btn").addEventListener("click", generateSpeech);

  initSttPanel();
  initSettings();

  document.getElementById("provider-select").addEventListener("change", onProviderChange);
  renderProviderSelect();

  activeConversation = getOrCreateActiveConversation();
  renderChatLog();
  renderConversationList();

  loadAndRenderModels(false);

  if (typeof initChain === "function") initChain();
  if (typeof initRealtime === "function") initRealtime();

  refreshSession().then(() => {
    if (loginError) {
      const status = document.getElementById("chat-status");
      if (status) setStatus(status, "Sign-in failed: " + loginError, "error");
    }
  });
});
