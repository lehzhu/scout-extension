// Phia storage module — attaches to self.Phia.storage (works in SW, content, popup)
self.Phia = self.Phia || {};

self.Phia.storage = (() => {
  const KEYS = {
    SETTINGS: "phia.settings",
    ITEMS: "phia.items",
  };

  /** @returns {Promise<{geminiApiKey: string|null}>} */
  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(KEYS.SETTINGS, (result) => {
        resolve(result[KEYS.SETTINGS] || { geminiApiKey: null });
      });
    });
  }

  /**
   * Merges partial settings into stored settings.
   * @param {Partial<{geminiApiKey: string|null}>} partial
   * @returns {Promise<void>}
   */
  function setSettings(partial) {
    return getSettings().then((existing) => {
      const merged = Object.assign({}, existing, partial);
      return new Promise((resolve) => {
        chrome.storage.local.set({ [KEYS.SETTINGS]: merged }, resolve);
      });
    });
  }

  /**
   * Returns all saved items, newest first.
   * @returns {Promise<SavedItem[]>}
   */
  function getItems() {
    return new Promise((resolve) => {
      chrome.storage.local.get(KEYS.ITEMS, (result) => {
        resolve(result[KEYS.ITEMS] || []);
      });
    });
  }

  /**
   * Prepends a new item to the list.
   * @param {SavedItem} item
   * @returns {Promise<void>}
   */
  function addItem(item) {
    return getItems().then((items) => {
      const updated = [item, ...items];
      return new Promise((resolve) => {
        chrome.storage.local.set({ [KEYS.ITEMS]: updated }, resolve);
      });
    });
  }

  /**
   * Removes an item by ID.
   * @param {string} id
   * @returns {Promise<void>}
   */
  function removeItem(id) {
    return getItems().then((items) => {
      const updated = items.filter((i) => i.id !== id);
      return new Promise((resolve) => {
        chrome.storage.local.set({ [KEYS.ITEMS]: updated }, resolve);
      });
    });
  }

  /** @returns {Promise<void>} */
  function clearItems() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [KEYS.ITEMS]: [] }, resolve);
    });
  }

  return { getSettings, setSettings, getItems, addItem, removeItem, clearItems };
})();
