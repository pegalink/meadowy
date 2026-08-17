// Multi-conversation chat history — the sidebar list, persisted in
// localStorage (message content only, never a Pollinations key). Each
// conversation is {id, title, messages, updatedAt}.

const LS_CONVERSATIONS = "meadows.conversations.v1";
const LS_ACTIVE_CONVERSATION = "meadows.active_conversation.v1";

function loadConversations() {
  try {
    const list = JSON.parse(localStorage.getItem(LS_CONVERSATIONS) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveConversations(list) {
  localStorage.setItem(LS_CONVERSATIONS, JSON.stringify(list));
}

function getActiveConversationId() {
  return localStorage.getItem(LS_ACTIVE_CONVERSATION);
}

function setActiveConversationId(id) {
  localStorage.setItem(LS_ACTIVE_CONVERSATION, id);
}

function getConversation(id) {
  return loadConversations().find((c) => c.id === id) || null;
}

function createConversation() {
  const list = loadConversations();
  const convo = {
    id: crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: "New chat",
    messages: [],
    updatedAt: Date.now(),
  };
  list.unshift(convo);
  saveConversations(list);
  setActiveConversationId(convo.id);
  return convo;
}

function getOrCreateActiveConversation() {
  const id = getActiveConversationId();
  return (id && getConversation(id)) || createConversation();
}

// Bumps the conversation to the top of the list on every update, matching
// the "most recently active first" ordering of ChatGPT/Claude sidebars.
function updateConversation(id, patch) {
  const list = loadConversations();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return;
  const updated = { ...list[idx], ...patch, updatedAt: Date.now() };
  list.splice(idx, 1);
  list.unshift(updated);
  saveConversations(list);
}

function deleteConversation(id) {
  const list = loadConversations().filter((c) => c.id !== id);
  saveConversations(list);
  if (getActiveConversationId() === id) {
    if (list.length) setActiveConversationId(list[0].id);
    else localStorage.removeItem(LS_ACTIVE_CONVERSATION);
  }
}

function titleFromFirstMessage(text) {
  const clean = (text || "").trim().replace(/\s+/g, " ");
  if (!clean) return "New chat";
  return clean.length > 48 ? clean.slice(0, 48) + "…" : clean;
}
