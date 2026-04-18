// Phia messaging module — attaches to self.Phia.messaging
self.Phia = self.Phia || {};

self.Phia.messaging = (() => {
  /** Message type constants */
  const MSG = {
    SAVE_VIDEO: "SAVE_VIDEO",           // content → background | payload: VideoMeta
    GET_ITEMS: "GET_ITEMS",             // popup → background   | no payload
    REMOVE_ITEM: "REMOVE_ITEM",         // popup → background   | payload: {id}
    CLEAR_ITEMS: "CLEAR_ITEMS",         // popup → background   | no payload
    SAVE_PROGRESS: "SAVE_PROGRESS",     // background → content | payload: {status, message?}
    RETRY_ITEM: "RETRY_ITEM",           // popup → background   | payload: {id}
    GET_INFLIGHT: "GET_INFLIGHT",       // popup → background   | no payload
    INFLIGHT_UPDATE: "INFLIGHT_UPDATE", // background → popup   | payload: InFlightItem[]
  };

  /**
   * Send a typed message and await the response.
   * @param {string} type - One of MSG.*
   * @param {any} [payload]
   * @returns {Promise<any>}
   */
  function sendMessage(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * Register a handler for a specific message type.
   * @param {string} type - One of MSG.*
   * @param {function(any, chrome.runtime.MessageSender): Promise<any>} handler
   */
  function onMessage(type, handler) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type !== type) return false;
      handler(msg.payload, sender)
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true; // keep channel open for async response
    });
  }

  return { MSG, sendMessage, onMessage };
})();
