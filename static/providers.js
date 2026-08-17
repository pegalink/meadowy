// Provider config storage + model discovery. Providers (endpoint name,
// base URL, API key) live in localStorage only — the Flask backend never
// persists them, it just relays a request with whatever you send it.

const LS_PROVIDERS = "meadows.providers.v1";
const LS_ACTIVE = "meadows.active_provider.v1";
const LS_MODEL_CACHE = "meadows.model_cache.v1";

function loadProviders() {
  let list;
  try {
    list = JSON.parse(localStorage.getItem(LS_PROVIDERS) || "null");
  } catch {
    list = null;
  }
  if (!Array.isArray(list) || list.length === 0) {
    list = [{ id: "pollinations", name: "Pollinations", kind: "pollinations" }];
    saveProviders(list);
  }
  // The built-in Pollinations entry must always exist. Note it never
  // carries a baseUrl/apiKey — those are meaningless for it now that login
  // lives entirely server-side behind a session cookie.
  if (!list.some((p) => p.id === "pollinations")) {
    list.unshift({ id: "pollinations", name: "Pollinations", kind: "pollinations" });
  }
  return list;
}

function saveProviders(list) {
  localStorage.setItem(LS_PROVIDERS, JSON.stringify(list));
}

function getActiveProviderId() {
  return localStorage.getItem(LS_ACTIVE) || "pollinations";
}

function setActiveProviderId(id) {
  localStorage.setItem(LS_ACTIVE, id);
}

function getProvider(id) {
  return loadProviders().find((p) => p.id === id);
}

function getActiveProvider() {
  const id = getActiveProviderId();
  return getProvider(id) || getProvider("pollinations");
}

function upsertProvider(provider) {
  const list = loadProviders();
  const idx = list.findIndex((p) => p.id === provider.id);
  if (idx >= 0) list[idx] = provider;
  else list.push(provider);
  saveProviders(list);
}

function deleteProvider(id) {
  if (id === "pollinations") return; // built-in, not removable
  const list = loadProviders().filter((p) => p.id !== id);
  saveProviders(list);
  if (getActiveProviderId() === id) setActiveProviderId("pollinations");
}

function providerRequestFields(provider) {
  return {
    kind: provider.kind,
    base_url: provider.baseUrl || "",
    api_key: provider.apiKey || "",
  };
}

// Login state for the built-in Pollinations provider lives in the session
// cookie, not in this object — see app.js's `session` global for that.
// This only ever needs to describe custom endpoints.
function providerStatusLabel(provider) {
  if (provider.kind === "pollinations") return "";
  if (!provider.baseUrl) return "Not configured";
  return provider.apiKey ? "Configured" : "No API key set";
}

// ---- model discovery ----

function loadModelCache() {
  try {
    return JSON.parse(localStorage.getItem(LS_MODEL_CACHE) || "{}");
  } catch {
    return {};
  }
}

function saveModelCache(cache) {
  localStorage.setItem(LS_MODEL_CACHE, JSON.stringify(cache));
}

function getCachedModels(providerId) {
  const cache = loadModelCache();
  return cache[providerId] || null;
}

async function fetchModelsForProvider(provider) {
  const res = await fetch("/api/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(providerRequestFields(provider)),
  });
  const data = await res.json();
  let models = data.models || [];
  if (!models.length) {
    models = FALLBACK_MODELS[provider.kind] || [];
  }
  // Pollinations' modality catalogs already include a ground-truth `cap`
  // (and `brand`) computed server-side from real input/output modalities —
  // only fall back to the id-regex heuristic when that's absent, i.e. for
  // custom OpenAI-compatible endpoints that only return bare ids.
  models = models.map((m) => ({ ...m, cap: m.cap || detectCapabilities(m.id) }));

  const cache = loadModelCache();
  cache[provider.id] = { models, fetchedAt: Date.now(), error: data.error || null };
  saveModelCache(cache);
  return cache[provider.id];
}

function modelsByCapability(entry, capKey) {
  if (!entry) return [];
  return entry.models.filter((m) => m.cap[capKey]);
}

// Look up the full (possibly brand/voices-enriched) model object for the
// currently active provider by id, or null if unknown/not yet fetched.
function lookupModelMeta(modelId) {
  if (!modelId) return null;
  const entry = getCachedModels(getActiveProviderId());
  if (!entry) return null;
  return entry.models.find((m) => m.id === modelId) || null;
}
