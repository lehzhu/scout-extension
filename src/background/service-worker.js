// Phinds — background service worker
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

chrome.runtime.onInstalled.addListener(() => console.log("[Phinds] installed"));

Phia.messaging.onMessage(MSG.SAVE_VIDEO,    handleSaveVideo);
Phia.messaging.onMessage(MSG.GET_ITEMS,     handleGetItems);
Phia.messaging.onMessage(MSG.REMOVE_ITEM,   handleRemoveItem);
Phia.messaging.onMessage(MSG.CLEAR_ITEMS,   handleClearItems);
Phia.messaging.onMessage(MSG.RETRY_ITEM,    handleRetryItem);
Phia.messaging.onMessage(MSG.GET_INFLIGHT,  handleGetInFlight);

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

  // Belt-and-suspenders: ensure inFlight is cleaned up on any unexpected throw
  try {
    const settings = await Phia.storage.getSettings();
    const apiKey = settings.geminiApiKey;
    if (!apiKey) {
      const msg = "Gemini API key not set. Open Phinds popup → Settings to add one.";
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
      startedAt: inFlight.get(videoMeta.videoId)?.startedAt ?? Date.now(),
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
      const errorMsg = err.message || "Unknown extraction error";
      const item = { id, video: videoMeta, products: [], status: "error", error: errorMsg };
      try {
        await Phia.storage.addItem(item);
      } catch (storageErr) {
        console.error("[Phinds] runExtraction: could not save error item:", storageErr.message);
      }
      if (tabId) sendProgress(tabId, "done", errorMsg);
      return { ok: false, error: errorMsg };
    }

    inFlight.delete(videoMeta.videoId);
    broadcastInFlight();
    const item = { id, video: videoMeta, products, status: "ready", error: null };
    try {
      await Phia.storage.addItem(item);
    } catch (storageErr) {
      // Quota exceeded is re-thrown by storage with a clear message
      if (tabId) sendProgress(tabId, "error", storageErr.message);
      return { ok: false, error: storageErr.message };
    }
    if (tabId) sendProgress(tabId, "done");
    return { ok: true, count: products.length };

  } catch (err) {
    // Unexpected outer-level throw — clean up inFlight and return structured error
    inFlight.delete(videoMeta.videoId);
    broadcastInFlight();
    const errorMsg = err.message || "Unexpected error during extraction";
    console.error("[Phinds] runExtraction unexpected error:", errorMsg);
    if (tabId) sendProgress(tabId, "error", errorMsg);
    return { ok: false, error: errorMsg };
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleSaveVideo(videoMeta, sender) {
  // Validate payload
  if (!videoMeta || typeof videoMeta.videoId !== "string" || videoMeta.videoId.trim() === "") {
    return { ok: false, error: "Invalid video metadata — missing videoId" };
  }

  // Concurrent save dedupe
  if (inFlight.has(videoMeta.videoId)) {
    return { ok: false, error: "Already saving this video" };
  }

  const tabId = sender?.tab?.id ?? null;
  try {
    return await runExtraction(videoMeta, null, tabId);
  } catch (err) {
    return { ok: false, error: err.message || "Save failed" };
  }
}

async function handleGetItems() {
  try {
    return await Phia.storage.getItems();
  } catch (err) {
    console.error("[Phinds] handleGetItems error:", err.message);
    return [];
  }
}

async function handleRemoveItem(payload) {
  const id = payload?.id;
  if (typeof id !== "string" || id.trim() === "") {
    return { ok: false, error: "Invalid id" };
  }
  try {
    await Phia.storage.removeItem(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || "Remove failed" };
  }
}

async function handleClearItems() {
  try {
    await Phia.storage.clearItems();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || "Clear failed" };
  }
}

async function handleGetInFlight() {
  try {
    return Array.from(inFlight.values());
  } catch (err) {
    console.error("[Phinds] handleGetInFlight error:", err.message);
    return [];
  }
}

async function handleRetryItem(payload) {
  const id = payload?.id;
  if (typeof id !== "string" || id.trim() === "") {
    return { ok: false, error: "Invalid id" };
  }

  let items;
  try {
    items = await Phia.storage.getItems();
  } catch (err) {
    return { ok: false, error: "Could not read saved items" };
  }

  const item = items.find((i) => i.id === id);
  if (!item) return { ok: false, error: "Item not found" };

  let settings;
  try {
    settings = await Phia.storage.getSettings();
  } catch (err) {
    return { ok: false, error: "Could not read settings" };
  }

  if (!settings.geminiApiKey) {
    return { ok: false, error: "Gemini API key not set. Open Settings to add one." };
  }

  const videoMeta = item.video;

  // Concurrent save dedupe
  if (inFlight.has(videoMeta.videoId)) {
    return { ok: false, error: "Already saving this video" };
  }

  // Set inFlight before removing the old error card so the pending card renders
  // immediately — avoids a blank-list flash between remove and extraction start.
  inFlight.set(videoMeta.videoId, {
    videoMeta,
    startedAt: Date.now(),
    status: "fetching-transcript",
  });
  broadcastInFlight();

  try {
    await Phia.storage.removeItem(id);
  } catch (err) {
    // If we can't remove the old item, still try extraction but log the issue
    console.warn("[Phinds] handleRetryItem: could not remove old item:", err.message);
  }

  // Fire-and-forget: the popup updates via INFLIGHT_UPDATE and storage.onChanged.
  // Returning immediately keeps the retry button's promise from hanging 3-10s.
  runExtraction({ ...videoMeta, savedAt: Date.now() }, null, null).catch((err) => {
    // runExtraction is belt-and-suspenders — this catch is the final safety net
    inFlight.delete(videoMeta.videoId);
    broadcastInFlight();
    console.error("[Phinds] handleRetryItem: runExtraction threw unexpectedly:", err.message);
  });

  return { ok: true };
}
