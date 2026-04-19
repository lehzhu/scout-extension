// Scout — background service worker
importScripts(
  "../lib/types.js",
  "../lib/storage.js",
  "../lib/messaging.js",
  "./parser.js"
);

const { MSG } = self.Scout.messaging;

// ─── In-flight saves ──────────────────────────────────────────────────────────
// Keyed by videoId → {videoMeta, startedAt, status}
const inFlight = new Map();

function broadcastInFlight() {
  // MV3's chrome.runtime.sendMessage rejects when no receiver is listening
  // (e.g. popup closed). Broadcast is best-effort — wrap in async IIFE so
  // no rejection or sync throw can escape.
  (async () => {
    try {
      await chrome.runtime.sendMessage({
        type: MSG.INFLIGHT_UPDATE,
        payload: Array.from(inFlight.values()),
      });
    } catch (_) {}
  })();
}

// ─── Message handlers ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Scout] installed");
  // One-time migration: move legacy phia.* keys to scout.*
  try {
    const legacy = await chrome.storage.local.get(["phia.settings", "phia.items"]);
    const patch = {};
    if (legacy["phia.settings"] !== undefined) patch["scout.settings"] = legacy["phia.settings"];
    if (legacy["phia.items"]    !== undefined) patch["scout.items"]    = legacy["phia.items"];
    if (Object.keys(patch).length > 0) {
      await chrome.storage.local.set(patch);
      await chrome.storage.local.remove(["phia.settings", "phia.items"]);
      console.log("[Scout] migrated legacy storage keys");
    }
  } catch (err) {
    console.warn("[Scout] storage migration failed:", err.message);
  }
});

Scout.messaging.onMessage(MSG.SAVE_VIDEO,    handleSaveVideo);
Scout.messaging.onMessage(MSG.GET_ITEMS,     handleGetItems);
Scout.messaging.onMessage(MSG.REMOVE_ITEM,   handleRemoveItem);
Scout.messaging.onMessage(MSG.CLEAR_ITEMS,   handleClearItems);
Scout.messaging.onMessage(MSG.RETRY_ITEM,    handleRetryItem);
Scout.messaging.onMessage(MSG.GET_INFLIGHT,  handleGetInFlight);
Scout.messaging.onMessage(MSG.GET_SAVED_ID,  handleGetSavedId);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendProgress(tabId, status, message) {
  // Tab may have navigated away or content script may be torn down.
  // Best-effort — wrap in async IIFE so rejection/throw can never escape.
  (async () => {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: MSG.SAVE_PROGRESS,
        payload: { status, message },
      });
    } catch (_) {}
  })();
}

async function runExtraction(videoMeta, existingId, tabId) {
  const id = existingId || `${videoMeta.videoId}-${videoMeta.savedAt}`;

  // Belt-and-suspenders: ensure inFlight is cleaned up on any unexpected throw
  try {
    const settings = await Scout.storage.getSettings();
    const provider = settings?.provider || "none";
    const needsTranscript = provider !== "none";

    inFlight.set(videoMeta.videoId, {
      videoMeta,
      startedAt: Date.now(),
      status: needsTranscript ? "fetching-transcript" : "extracting-products",
    });
    broadcastInFlight();
    if (tabId && needsTranscript) sendProgress(tabId, "fetching-transcript");

    let transcript = null;
    if (needsTranscript) {
      try {
        transcript = await Scout.parser.fetchTranscript(videoMeta.videoId);
      } catch (_) {
        // Network error — continue without transcript
      }
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
      products = await Scout.parser.extractProducts({
        videoMeta,
        transcriptText: transcript?.text ?? null,
        settings,
      });
    } catch (err) {
      inFlight.delete(videoMeta.videoId);
      broadcastInFlight();
      const errorMsg = err.message || "Unknown extraction error";
      const item = {
        id,
        video: videoMeta,
        products: [],
        status: "error",
        error: errorMsg,
        extractedWith: provider === "gemini" ? "gemini" : "heuristic",
      };
      try {
        await Scout.storage.addItem(item);
      } catch (storageErr) {
        console.error("[Scout] runExtraction: could not save error item:", storageErr.message);
      }
      if (tabId) sendProgress(tabId, "done", errorMsg);
      return { ok: false, error: errorMsg };
    }

    inFlight.delete(videoMeta.videoId);
    broadcastInFlight();
    const item = {
      id,
      video: videoMeta,
      products,
      status: "ready",
      error: null,
      extractedWith: provider === "gemini" ? "gemini" : "heuristic",
    };
    try {
      await Scout.storage.addItem(item);
    } catch (storageErr) {
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
    console.error("[Scout] runExtraction unexpected error:", errorMsg);
    if (tabId) sendProgress(tabId, "error", errorMsg);
    return { ok: false, error: errorMsg };
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleSaveVideo(payload, sender) {
  // The content script sends either VideoMeta directly (legacy) or
  // { ...VideoMeta, force?: boolean }. Accept both.
  const force = payload && payload.force === true;
  const videoMeta = payload && typeof payload === "object" && "videoId" in payload
    ? payload
    : null;

  if (!videoMeta || typeof videoMeta.videoId !== "string" || videoMeta.videoId.trim() === "") {
    return { ok: false, error: "Invalid video metadata — missing videoId" };
  }

  // Concurrent save dedupe
  if (inFlight.has(videoMeta.videoId)) {
    return { ok: false, error: "Already saving this video" };
  }

  // Already-saved dedupe — user must opt in via force to re-save.
  if (!force) {
    try {
      const existing = await Scout.storage.getItems();
      const dup = existing.find((i) => i && i.video && i.video.videoId === videoMeta.videoId);
      if (dup) {
        return {
          ok: false,
          duplicate: true,
          existingId: dup.id,
          savedAt: dup.video && dup.video.savedAt,
          error: "Already saved",
        };
      }
    } catch (_) {
      // If lookup fails, fall through and allow the save
    }
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
    return await Scout.storage.getItems();
  } catch (err) {
    console.error("[Scout] handleGetItems error:", err.message);
    return [];
  }
}

async function handleRemoveItem(payload) {
  const id = payload?.id;
  if (typeof id !== "string" || id.trim() === "") {
    return { ok: false, error: "Invalid id" };
  }
  try {
    await Scout.storage.removeItem(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || "Remove failed" };
  }
}

async function handleClearItems() {
  try {
    await Scout.storage.clearItems();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || "Clear failed" };
  }
}

async function handleGetSavedId(payload) {
  try {
    const videoId = payload && typeof payload.videoId === "string" ? payload.videoId : "";
    if (!videoId) return { id: null };
    const items = await Scout.storage.getItems();
    if (!Array.isArray(items)) return { id: null };
    // getItems() returns newest-first per storage layer; pick the first match.
    let newest = null;
    for (const it of items) {
      if (!it || !it.video || it.video.videoId !== videoId) continue;
      const ts = (it.video && it.video.savedAt) || 0;
      if (!newest || ts > ((newest.video && newest.video.savedAt) || 0)) {
        newest = it;
      }
    }
    return { id: newest ? newest.id : null };
  } catch (_) {
    return { id: null };
  }
}

async function handleGetInFlight() {
  try {
    return Array.from(inFlight.values());
  } catch (err) {
    console.error("[Scout] handleGetInFlight error:", err.message);
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
    items = await Scout.storage.getItems();
  } catch (err) {
    return { ok: false, error: "Could not read saved items" };
  }

  const item = items.find((i) => i.id === id);
  if (!item) return { ok: false, error: "Item not found" };

  let settings;
  try {
    settings = await Scout.storage.getSettings();
  } catch (err) {
    return { ok: false, error: "Could not read settings" };
  }

  if (settings.provider === "gemini" && !settings.geminiApiKey) {
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
    status: settings.provider === "none" ? "extracting-products" : "fetching-transcript",
  });
  broadcastInFlight();

  try {
    await Scout.storage.removeItem(id);
  } catch (err) {
    // If we can't remove the old item, still try extraction but log the issue
    console.warn("[Scout] handleRetryItem: could not remove old item:", err.message);
  }

  // Fire-and-forget: the popup updates via INFLIGHT_UPDATE and storage.onChanged.
  // Returning immediately keeps the retry button's promise from hanging 3-10s.
  runExtraction({ ...videoMeta, savedAt: Date.now() }, null, null).catch((err) => {
    // runExtraction is belt-and-suspenders — this catch is the final safety net
    inFlight.delete(videoMeta.videoId);
    broadcastInFlight();
    console.error("[Scout] handleRetryItem: runExtraction threw unexpectedly:", err.message);
  });

  return { ok: true };
}
