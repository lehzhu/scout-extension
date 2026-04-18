// Phia YouTube — background service worker (stub)
importScripts(
  "../lib/types.js",
  "../lib/storage.js",
  "../lib/messaging.js"
);

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Phia] installed");
});
