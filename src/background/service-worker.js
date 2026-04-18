// Phia YouTube — background service worker
importScripts(
  "../lib/types.js",
  "../lib/storage.js",
  "../lib/messaging.js",
  "./parser.js"
);

const { MSG } = self.Phia.messaging;

chrome.runtime.onInstalled.addListener(() => console.log("[Phia] installed"));

Phia.messaging.onMessage(MSG.SAVE_VIDEO,   handleSaveVideo);
Phia.messaging.onMessage(MSG.GET_ITEMS,    handleGetItems);
Phia.messaging.onMessage(MSG.REMOVE_ITEM,  handleRemoveItem);
Phia.messaging.onMessage(MSG.CLEAR_ITEMS,  handleClearItems);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendProgress(tabId, status, message) {
  try {
    chrome.tabs.sendMessage(tabId, {
      type: MSG.SAVE_PROGRESS,
      payload: { status, message },
    });
  } catch (_) {}
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleSaveVideo(videoMeta, sender) {
  const tabId = sender?.tab?.id;
  const id = `${videoMeta.videoId}-${videoMeta.savedAt}`;

  const settings = await Phia.storage.getSettings();
  const apiKey = settings.geminiApiKey;
  if (!apiKey) {
    const msg = "Gemini API key not set. Open Phia popup → Settings to add one.";
    if (tabId) sendProgress(tabId, "error", msg);
    return { ok: false, error: msg };
  }

  if (tabId) sendProgress(tabId, "fetching-transcript");
  let transcript = null;
  try {
    transcript = await Phia.parser.fetchTranscript(videoMeta.videoId);
  } catch (_) {
    // Network error fetching transcript — continue without it
  }

  if (tabId) sendProgress(tabId, "extracting-products");
  let products;
  try {
    products = await Phia.parser.extractProducts({
      videoMeta,
      transcriptText: transcript?.text ?? null,
      apiKey,
    });
  } catch (err) {
    const item = { id, video: videoMeta, products: [], status: "error", error: err.message };
    await Phia.storage.addItem(item);
    if (tabId) sendProgress(tabId, "done", err.message);
    return { ok: false, error: err.message };
  }

  const item = {
    id,
    video: videoMeta,
    products,
    status: "ready",
    error: null,
  };
  await Phia.storage.addItem(item);
  if (tabId) sendProgress(tabId, "done");
  return { ok: true, count: products.length };
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
