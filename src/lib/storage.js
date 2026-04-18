// Phia storage module — attaches to self.Phia.storage (works in SW, content, popup)
self.Phia = self.Phia || {};

self.Phia.storage = (() => {
  const KEYS = {
    SETTINGS: "phia.settings",
    ITEMS: "phia.items",
  };

  /** @returns {Promise<{geminiApiKey: string|null}>} */
  async function getSettings() {
    const result = await chrome.storage.local.get(KEYS.SETTINGS);
    return result[KEYS.SETTINGS] || { geminiApiKey: null };
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
   * @returns {Promise<SavedItem[]>}
   */
  async function getItems() {
    const result = await chrome.storage.local.get(KEYS.ITEMS);
    return result[KEYS.ITEMS] || [];
  }

  /**
   * Prepends a new item to the list.
   * @param {SavedItem} item
   * @returns {Promise<void>}
   */
  async function addItem(item) {
    const items = await getItems();
    await chrome.storage.local.set({ [KEYS.ITEMS]: [item, ...items] });
  }

  /**
   * Replaces an item by ID (remove old + insert new at same position).
   * @param {string} id
   * @param {SavedItem} newItem
   * @returns {Promise<void>}
   */
  async function replaceItem(id, newItem) {
    const items = await getItems();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) {
      await chrome.storage.local.set({ [KEYS.ITEMS]: [newItem, ...items] });
    } else {
      const updated = [...items];
      updated[idx] = newItem;
      await chrome.storage.local.set({ [KEYS.ITEMS]: updated });
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
  }

  /** @returns {Promise<void>} */
  async function clearItems() {
    await chrome.storage.local.set({ [KEYS.ITEMS]: [] });
  }

  return { getSettings, setSettings, getItems, addItem, replaceItem, removeItem, clearItems };
})();
