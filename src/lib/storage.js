// Scout storage module — attaches to self.Scout.storage (works in SW, content, popup)
self.Scout = self.Scout || {};

self.Scout.storage = (() => {
  const KEYS = {
    SETTINGS: "scout.settings",
    ITEMS: "scout.items",
    FAVOURITES: "scout.favourites",
  };

  /**
   * Guard that a stored item has the minimum required fields.
   * Drops items missing id or video.videoId to prevent popup crashes.
   * @param {any} item
   * @returns {boolean}
   */
  function isValidItem(item) {
    return (
      item !== null &&
      typeof item === "object" &&
      typeof item.id === "string" &&
      item.id.length > 0 &&
      item.video !== null &&
      typeof item.video === "object" &&
      typeof item.video.videoId === "string" &&
      item.video.videoId.length > 0
    );
  }

  /** @returns {Settings} */
  function normalizeSettings(raw) {
    const defaults = {
      provider: "none",
      geminiApiKey: null,
      geminiModel: null,
      openrouterApiKey: null,
      openrouterModel: null,
    };
    const s = Object.assign({}, defaults, raw && typeof raw === "object" ? raw : {});
    // Backward compat: infer provider from legacy key fields
    if (!raw?.provider) {
      if (s.geminiApiKey) s.provider = "gemini";
      else if (s.openrouterApiKey) s.provider = "openrouter";
    }
    return s;
  }

  /** @returns {Promise<Settings>} */
  async function getSettings() {
    try {
      const result = await chrome.storage.local.get(KEYS.SETTINGS);
      return normalizeSettings(result[KEYS.SETTINGS]);
    } catch (err) {
      console.warn("[Scout] getSettings failed, using default:", err.message);
      return normalizeSettings(null);
    }
  }

  /**
   * Merges partial settings into stored settings.
   * @param {Partial<{geminiApiKey: string|null}>} partial
   * @returns {Promise<void>}
   */
  async function setSettings(partial) {
    const existing = await getSettings();
    const merged = Object.assign({}, existing, partial);
    await chrome.storage.local.set({ [KEYS.SETTINGS]: merged });
  }

  /**
   * Returns all saved items, newest first.
   * Validates shape and drops corrupted entries — never throws.
   * @returns {Promise<SavedItem[]>}
   */
  async function getItems() {
    try {
      const result = await chrome.storage.local.get(KEYS.ITEMS);
      const raw = result[KEYS.ITEMS];
      if (!Array.isArray(raw)) {
        if (raw !== undefined) {
          console.warn("[Scout] getItems: stored value is not an array, returning []");
        }
        return [];
      }
      const valid = raw.filter((item) => {
        if (isValidItem(item)) return true;
        console.warn("[Scout] getItems: dropping corrupted item:", item?.id ?? "(no id)");
        return false;
      });
      return valid;
    } catch (err) {
      console.warn("[Scout] getItems failed, returning []:", err.message);
      return [];
    }
  }

  /**
   * Prepends a new item to the list.
   * Re-throws quota errors with a user-friendly message so the service worker
   * can surface them. All other errors are also re-thrown (caller must catch).
   * @param {SavedItem} item
   * @returns {Promise<void>}
   */
  async function addItem(item) {
    try {
      const items = await getItems();
      await chrome.storage.local.set({ [KEYS.ITEMS]: [item, ...items] });
    } catch (err) {
      if (err.message && err.message.includes("QUOTA_BYTES")) {
        throw new Error("Storage quota exceeded — remove some saved videos.");
      }
      throw err;
    }
  }

  /**
   * Replaces an item by ID (remove old + insert new at same position).
   * @param {string} id
   * @param {SavedItem} newItem
   * @returns {Promise<void>}
   */
  async function replaceItem(id, newItem) {
    try {
      const items = await getItems();
      const idx = items.findIndex((i) => i.id === id);
      if (idx === -1) {
        await chrome.storage.local.set({ [KEYS.ITEMS]: [newItem, ...items] });
      } else {
        const updated = [...items];
        updated[idx] = newItem;
        await chrome.storage.local.set({ [KEYS.ITEMS]: updated });
      }
    } catch (err) {
      if (err.message && err.message.includes("QUOTA_BYTES")) {
        throw new Error("Storage quota exceeded — remove some saved videos.");
      }
      throw err;
    }
  }

  /**
   * Removes an item by ID.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function removeItem(id) {
    const items = await getItems();
    await chrome.storage.local.set({ [KEYS.ITEMS]: items.filter((i) => i.id !== id) });
    try {
      const notes = await getNotes();
      if (id in notes) {
        delete notes[id];
        await chrome.storage.local.set({ "scout.notes": notes });
      }
    } catch (_) {}
  }

  /** @returns {Promise<void>} */
  async function clearItems() {
    await chrome.storage.local.set({ [KEYS.ITEMS]: [], "scout.notes": {} });
  }

  async function getNotes() {
    try {
      const result = await chrome.storage.local.get("scout.notes");
      const raw = result["scout.notes"];
      return raw && typeof raw === "object" ? raw : {};
    } catch (err) {
      console.warn("[Scout] getNotes failed:", err.message);
      return {};
    }
  }

  async function setNote(id, text) {
    if (typeof id !== "string" || id.length === 0) return;
    const notes = await getNotes();
    if (typeof text === "string" && text.length > 0) {
      notes[id] = text;
    } else {
      delete notes[id];
    }
    try {
      await chrome.storage.local.set({ "scout.notes": notes });
    } catch (err) {
      if (err.message && err.message.includes("QUOTA_BYTES")) {
        throw new Error("Storage quota exceeded — shorten your notes.");
      }
      throw err;
    }
  }

  // ── Favourites ──────────────────────────────────────────────────────────

  function favIdFor(itemId, productIndex) {
    return String(itemId) + "::" + String(productIndex);
  }

  async function getFavourites() {
    try {
      const result = await chrome.storage.local.get(KEYS.FAVOURITES);
      const raw = result[KEYS.FAVOURITES];
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch (err) {
      console.warn("[Scout] getFavourites failed:", err && err.message);
      return {};
    }
  }

  async function isFavourited(itemId, productIndex) {
    try {
      if (typeof itemId !== "string" || itemId.length === 0) return false;
      const favs = await getFavourites();
      return Object.prototype.hasOwnProperty.call(favs, favIdFor(itemId, productIndex));
    } catch (_) {
      return false;
    }
  }

  /**
   * Toggle a favourite. `flag = true` adds/updates, `flag = false` removes.
   * Never throws except on quota.
   */
  async function setFavourited(itemId, productIndex, videoMeta, product, flag) {
    try {
      if (typeof itemId !== "string" || itemId.length === 0) return;
      const favs = await getFavourites();
      const key = favIdFor(itemId, productIndex);
      if (flag) {
        const v = (videoMeta && typeof videoMeta === "object") ? videoMeta : {};
        const p = (product && typeof product === "object") ? product : {};
        favs[key] = {
          itemId,
          videoId: v.videoId || null,
          videoTitle: v.title || "",
          videoUrl: v.url || (v.videoId ? "https://www.youtube.com/watch?v=" + v.videoId : ""),
          channel: v.channel || "",
          thumbnailUrl: v.thumbnailUrl || (v.videoId ? "https://i.ytimg.com/vi/" + v.videoId + "/hqdefault.jpg" : ""),
          productIndex: productIndex,
          product: {
            name: p.name || "",
            brand: p.brand || "",
            category: p.category || "",
            searchQuery: p.searchQuery || "",
            confidence: p.confidence != null ? p.confidence : null,
            timestamp: p.timestamp != null ? p.timestamp : null,
          },
          favedAt: Date.now(),
        };
      } else {
        delete favs[key];
      }
      await chrome.storage.local.set({ [KEYS.FAVOURITES]: favs });
    } catch (err) {
      if (err && err.message && err.message.includes("QUOTA_BYTES")) {
        throw new Error("Storage quota exceeded — remove some favourites.");
      }
      console.warn("[Scout] setFavourited failed:", err && err.message);
    }
  }

  async function clearFavourites() {
    try {
      await chrome.storage.local.set({ [KEYS.FAVOURITES]: {} });
    } catch (err) {
      console.warn("[Scout] clearFavourites failed:", err && err.message);
    }
  }

  return {
    getSettings, setSettings,
    getItems, addItem, replaceItem, removeItem, clearItems,
    getNotes, setNote,
    getFavourites, isFavourited, setFavourited, clearFavourites,
  };
})();
