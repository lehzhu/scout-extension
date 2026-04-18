// Phia YouTube — background service worker
importScripts(
  "../lib/types.js",
  "../lib/storage.js",
  "../lib/messaging.js",
  "./parser.js"
);

const { MSG } = self.Phia.messaging;

// ─── In-flight saves ──────────────────────────────────────────────────────────
// Keyed by videoId → {videoMeta, startedAt, status}
const inFlight = new Map();

function broadcastInFlight() {
  try {
    chrome.runtime.sendMessage({
      type: MSG.INFLIGHT_UPDATE,
      payload: Array.from(inFlight.values()),
    });
  } catch (_) {}
}

// ─── Message handlers ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => console.log("[Phia] installed"));

Phia.messaging.onMessage(MSG.SAVE_VIDEO,    handleSaveVideo);
Phia.messaging.onMessage(MSG.GET_ITEMS,     handleGetItems);
Phia.messaging.onMessage(MSG.REMOVE_ITEM,  handleRemoveItem);
Phia.messaging.onMessage(MSG.CLEAR_ITEMS,  handleClearItems);
Phia.messaging.onMessage(MSG.RETRY_ITEM,   handleRetryItem);
Phia.messaging.onMessage(MSG.GET_INFLIGHT, handleGetInFlight);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendProgress(tabId, status, message) {
  try {
    chrome.tabs.sendMessage(tabId, {
      type: MSG.SAVE_PROGRESS,
      payload: { status, message },
    });
  } catch (_) {}
}

async function runExtraction(videoMeta, existingId, tabId) {
  const id = existingId || `${videoMeta.videoId}-${videoMeta.savedAt}`;

  const settings = await Phia.storage.getSettings();
  const apiKey = settings.geminiApiKey;
  if (!apiKey) {
    const msg = "Gemini API key not set. Open Phia popup → Settings to add one.";
    if (tabId) sendProgress(tabId, "error", msg);
    return { ok: false, error: msg };
  }

  inFlight.set(videoMeta.videoId, {
    videoMeta,
    startedAt: Date.now(),
    status: "fetching-transcript",
  });
  broadcastInFlight();
  if (tabId) sendProgress(tabId, "fetching-transcript");

  let transcript = null;
  try {
    transcript = await Phia.parser.fetchTranscript(videoMeta.videoId);
  } catch (_) {
    // Network error — continue without transcript
  }

  inFlight.set(videoMeta.videoId, {
    videoMeta,
    startedAt: inFlight.get(videoMeta.videoId).startedAt,
    status: "extracting-products",
  });
  broadcastInFlight();
  if (tabId) sendProgress(tabId, "extracting-products");

  let products;
  try {
    products = await Phia.parser.extractProducts({
      videoMeta,
      transcriptText: transcript?.text ?? null,
      apiKey,
    });
  } catch (err) {
    inFlight.delete(videoMeta.videoId);
    broadcastInFlight();
    const item = { id, video: videoMeta, products: [], status: "error", error: err.message };
    await Phia.storage.addItem(item);
    if (tabId) sendProgress(tabId, "done", err.message);
    return { ok: false, error: err.message };
  }

  inFlight.delete(videoMeta.videoId);
  broadcastInFlight();
  const item = { id, video: videoMeta, products, status: "ready", error: null };
  await Phia.storage.addItem(item);
  if (tabId) sendProgress(tabId, "done");
  return { ok: true, count: products.length };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleSaveVideo(videoMeta, sender) {
  const tabId = sender?.tab?.id;
  return runExtraction(videoMeta, null, tabId);
}

async function handleGetItems() {
  return Phia.storage.getItems();
}

async function handleRemoveItem({ id }) {
  await Phia.storage.removeItem(id);
  return { ok: true };
}

async function handleClearItems() {
  await Phia.storage.clearItems();
  return { ok: true };
}

async function handleGetInFlight() {
  return Array.from(inFlight.values());
}

async function handleRetryItem({ id }) {
  const items = await Phia.storage.getItems();
  const item = items.find((i) => i.id === id);
  if (!item) return { ok: false, error: "Item not found" };
  await Phia.storage.removeItem(id);
  const videoMeta = item.video;
  const newId = `${videoMeta.videoId}-${Date.now()}`;
  // Re-run extraction with a fresh ID; no tab progress for popup-triggered retry
  inFlight.set(videoMeta.videoId, {
    videoMeta,
    startedAt: Date.now(),
    status: "fetching-transcript",
  });
  broadcastInFlight();

  const settings = await Phia.storage.getSettings();
  const apiKey = settings.geminiApiKey;
  if (!apiKey) {
    inFlight.delete(videoMeta.videoId);
    broadcastInFlight();
    return { ok: false, error: "Gemini API key not set" };
  }

  let transcript = null;
  try { transcript = await Phia.parser.fetchTranscript(videoMeta.videoId); } catch (_) {}

  inFlight.set(videoMeta.videoId, {
    videoMeta,
    startedAt: inFlight.get(videoMeta.videoId).startedAt,
    status: "extracting-products",
  });
  broadcastInFlight();

  let products;
  try {
    products = await Phia.parser.extractProducts({
      videoMeta,
      transcriptText: transcript?.text ?? null,
      apiKey,
    });
  } catch (err) {
    inFlight.delete(videoMeta.videoId);
    broadcastInFlight();
    await Phia.storage.addItem({ id: newId, video: videoMeta, products: [], status: "error", error: err.message });
    return { ok: false, error: err.message };
  }

  inFlight.delete(videoMeta.videoId);
  broadcastInFlight();
  await Phia.storage.addItem({ id: newId, video: videoMeta, products, status: "ready", error: null });
  return { ok: true, count: products.length };
}
