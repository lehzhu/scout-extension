// Scout messaging module — attaches to self.Scout.messaging
self.Scout = self.Scout || {};

self.Scout.messaging = (() => {
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
    GET_SAVED_ID: "GET_SAVED_ID",       // content → background | payload: {videoId} → {id: string|null}
  };

  /**
   * Send a typed message and await the response.
   * Always resolves — never rejects. Returns {ok: false, error: "..."} on failure.
   * @param {string} type - One of MSG.*
   * @param {any} [payload]
   * @returns {Promise<{ok: boolean, error?: string} | any>}
   */
  function sendMessage(type, payload) {
    if (typeof chrome === "undefined" || !chrome.runtime) {
      return Promise.resolve({ ok: false, error: "chrome.runtime unavailable" });
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
          if (chrome.runtime.lastError) {
            // Receiver doesn't exist (popup closed, SW not running, tab gone)
            resolve({ ok: false, error: "No receiver" });
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        resolve({ ok: false, error: err.message || "sendMessage failed" });
      }
    });
  }

  /**
   * Register a handler for a specific message type.
   * Wraps handler in try/catch — any throw or rejection replies with
   * {ok: false, error: "..."} so the channel is never left open.
   * @param {string} type - One of MSG.*
   * @param {function(any, chrome.runtime.MessageSender): Promise<any>} handler
   */
  function onMessage(type, handler) {
    if (typeof chrome === "undefined" || !chrome.runtime) return;
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type !== type) return false;
      // Wrap handler in try/catch so sync throws are also caught
      let resultPromise;
      try {
        resultPromise = handler(msg.payload, sender);
        // If handler returned a non-promise, wrap it
        if (!resultPromise || typeof resultPromise.then !== "function") {
          resultPromise = Promise.resolve(resultPromise);
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message || "Unknown error" });
        return true;
      }
      resultPromise
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message || "Unknown error" }));
      return true; // keep channel open for async response
    });
  }

  return { MSG, sendMessage, onMessage };
})();
