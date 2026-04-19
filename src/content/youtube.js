(function scoutContentScript() {
  "use strict";

  // ─── Top-level guard ──────────────────────────────────────────────────────
  // If the lib scripts failed to load, bail silently so YouTube is unaffected.
  if (!self.Scout || !self.Scout.messaging) {
    console.warn("[Scout] messaging lib not loaded — content script inactive");
    return;
  }

  // Wrap the entire script body so any unexpected throw never crashes the page.
  try {
    _initScoutContentScript();
  } catch (err) {
    console.warn("[Scout] content script error:", err.message);
  }

  function _initScoutContentScript() {
    const { MSG, sendMessage, onMessage } = self.Scout.messaging;

    // Track last URL to detect SPA navigations
    let lastUrl = "";

    // Suppress repeated selector-miss logs (one per selector per page)
    const _warnedOnce = new Set();
    function warnOnce(key, msg) {
      if (_warnedOnce.has(key)) return;
      _warnedOnce.add(key);
      console.debug("[Scout]", msg);
    }

    // ─── DOM helpers ────────────────────────────────────────────────────────

    /**
     * Poll for a DOM element until it appears or times out.
     * Never throws — returns null on timeout.
     * @param {string} selector
     * @param {number} timeoutMs
     * @returns {Promise<Element|null>}
     */
    function waitForElement(selector, timeoutMs = 10000) {
      return new Promise((resolve) => {
        try {
          const existing = document.querySelector(selector);
          if (existing) return resolve(existing);

          const deadline = Date.now() + timeoutMs;
          const iv = setInterval(() => {
            try {
              const el = document.querySelector(selector);
              if (el) {
                clearInterval(iv);
                resolve(el);
              } else if (Date.now() >= deadline) {
                clearInterval(iv);
                resolve(null);
              }
            } catch (_) {
              clearInterval(iv);
              resolve(null);
            }
          }, 200);
        } catch (_) {
          resolve(null);
        }
      });
    }

    // ─── Button state helpers ────────────────────────────────────────────────

    const BTN_STYLES = {
      default: { background: "#0F0F0F", label: "★ Save to Scout", disabled: false },
      saving:  { background: "#0F0F0F", label: "Saving…",          disabled: true  },
      saved:   { background: "#22A06B", label: "✓ Saved",           disabled: true  },
      error:   { background: "#F0336C", label: "⚠ Error — retry",   disabled: false },
    };

    function applyBtnState(btn, state, customLabel) {
      try {
        const s = BTN_STYLES[state] || BTN_STYLES.default;
        btn.style.background = s.background;
        btn.textContent = customLabel || s.label;
        btn.disabled = s.disabled;
      } catch (_) {}
    }

    function createButton() {
      const btn = document.createElement("button");
      btn.id = "scout-save-btn";
      btn.className = "scout-save-btn";

      // Inline styles — avoids CSS specificity fights with YouTube
      Object.assign(btn.style, {
        background: "#0F0F0F",
        color: "#FFFFFF",
        padding: "10px 16px",
        borderRadius: "12px",
        fontWeight: "600",
        fontSize: "13px",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Helvetica, Arial, sans-serif',
        border: "0",
        cursor: "pointer",
        margin: "8px 0",
        display: "inline-block",
        lineHeight: "1.4",
        transition: "background 0.15s",
      });

      btn.textContent = "★ Save to Scout";

      btn.addEventListener("mouseenter", () => {
        if (!btn.disabled) btn.style.background = "#2A2A2A";
      });
      btn.addEventListener("mouseleave", () => {
        if (!btn.disabled) btn.style.background = BTN_STYLES.default.background;
      });

      return btn;
    }

    // ─── Metadata extraction ─────────────────────────────────────────────────

    /**
     * Never throws. Falls back to safe defaults for any missing selector.
     * Only videoId is critical; the click handler short-circuits without it.
     * @returns {import("../lib/types").VideoMeta}
     */
    function extractVideoMeta() {
      let videoId = "";
      try { videoId = new URLSearchParams(location.search).get("v") || ""; } catch (_) {}

      const url = videoId
        ? `https://www.youtube.com/watch?v=${videoId}`
        : location.href;

      // Title: prefer the rendered h1 inside #above-the-fold, fall back to <title>
      let title = "";
      try {
        const titleEl =
          document.querySelector("#above-the-fold #title h1") ||
          document.querySelector("#above-the-fold h1") ||
          document.querySelector("h1.ytd-watch-metadata");
        title = titleEl?.textContent?.trim() ||
          document.title.replace(/ - YouTube$/, "").trim();
      } catch (_) {
        try { title = document.title.replace(/ - YouTube$/, "").trim(); } catch (__) {}
      }

      // Channel anchor — try multiple selectors for robustness
      let channel = "";
      let channelUrl = "";
      try {
        const channelAnchor =
          document.querySelector("#above-the-fold ytd-channel-name #text a") ||
          document.querySelector("ytd-channel-name #text a") ||
          document.querySelector("#channel-name a") ||
          document.querySelector("#owner-name a");
        channel = channelAnchor?.textContent?.trim() || "";
        channelUrl = channelAnchor?.href
          ? new URL(channelAnchor.href, location.origin).href
          : "";
      } catch (_) {}

      const thumbnailUrl = videoId
        ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        : "";

      // Description — read textContent directly; do not click the expander
      let description = "";
      try {
        const descEl =
          document.querySelector("#description-inline-expander yt-formatted-string") ||
          document.querySelector("ytd-text-inline-expander yt-formatted-string") ||
          document.querySelector("#description yt-formatted-string");
        description = (descEl?.textContent || "").slice(0, 4000);
      } catch (_) {}

      return { videoId, url, title, channel, channelUrl, thumbnailUrl, description, savedAt: Date.now() };
    }

    // ─── Button injection ────────────────────────────────────────────────────

    let _injecting = false;

    async function injectButton() {
      if (_injecting) return;
      if (document.getElementById("scout-save-btn")) return; // already present

      _injecting = true;
      try {
        // Wait for the title area to exist (YouTube renders async)
        const anchor =
          (await waitForElement("#above-the-fold #title")) ||
          (await waitForElement("#above-the-fold", 3000));

        if (!anchor) {
          warnOnce("no-anchor", "could not find title anchor — button not injected");
          return; // silently exit — no button, no crash
        }

        // Re-check after the await — another yt-navigate-finish may have
        // already injected while we were waiting.
        if (document.getElementById("scout-save-btn")) return;

        await _doInject(anchor);
      } finally {
        _injecting = false;
      }
    }

    async function _doInject(anchor) {
      const btn = createButton();

      // Listen for progress messages from background
      onMessage(MSG.SAVE_PROGRESS, async (payload) => {
        try {
          const liveBtn = document.getElementById("scout-save-btn");
          if (!liveBtn) return;
          switch (payload?.status) {
            case "fetching-transcript":
              applyBtnState(liveBtn, "saving", "Reading transcript…");
              break;
            case "extracting-products":
              applyBtnState(liveBtn, "saving", "Finding products…");
              break;
            case "done":
              showSaved(liveBtn);
              break;
            case "error":
              applyBtnState(liveBtn, "error", payload.message ? `⚠ ${payload.message}` : undefined);
              break;
          }
        } catch (_) {}
      });

      btn.addEventListener("click", async () => {
        // Dedupe rapid double-clicks: if already saving, ignore
        if (btn.disabled) return;

        applyBtnState(btn, "saving");

        let meta;
        try {
          meta = extractVideoMeta();
        } catch (_) {
          applyBtnState(btn, "error", "⚠ Could not read page — retry");
          return;
        }

        if (!meta.videoId) {
          applyBtnState(btn, "error", "⚠ No video ID — retry");
          return;
        }

        let response;
        try {
          response = await sendMessage(MSG.SAVE_VIDEO, meta);
        } catch (_) {
          // sendMessage now always resolves, but be defensive
          response = { ok: false, error: "No receiver" };
        }

        if (!response || typeof response !== "object") {
          applyBtnState(btn, "error");
          return;
        }

        if (!response.ok) {
          if (response.error === "No receiver") {
            // Service worker is asleep or extension was reloaded
            applyBtnState(btn, "error", "Extension reloading — try again");
            setTimeout(() => {
              const liveBtn = document.getElementById("scout-save-btn");
              if (liveBtn && liveBtn.textContent === "Extension reloading — try again") {
                applyBtnState(liveBtn, "default");
              }
            }, 2000);
          } else {
            const msg = response.error ? `⚠ ${response.error}` : undefined;
            applyBtnState(btn, "error", msg);
          }
          return;
        }

        showSaved(btn);
      });

      // Insert after the title's h1 (or as first child of #above-the-fold)
      try {
        const h1 = anchor.querySelector("h1") || anchor;
        if (h1.parentNode) {
          h1.parentNode.insertBefore(btn, h1.nextSibling);
        } else {
          anchor.appendChild(btn);
        }
      } catch (_) {
        // DOM insertion failed — don't throw
      }
    }

    function showSaved(btn) {
      applyBtnState(btn, "saved");
      setTimeout(() => {
        try {
          if (document.getElementById("scout-save-btn") === btn) {
            applyBtnState(btn, "default");
          }
        } catch (_) {}
      }, 2000);
    }

    // ─── SPA-aware entry point ───────────────────────────────────────────────

    async function maybeInjectButton() {
      try {
        if (!/^https:\/\/(www\.)?youtube\.com\/watch/.test(location.href)) return;

        // If URL changed (SPA nav to a different video), remove stale button
        if (location.href !== lastUrl) {
          try {
            const old = document.getElementById("scout-save-btn");
            if (old) old.remove();
          } catch (_) {}
          lastUrl = location.href;
          // Reset warned-once set on SPA navigation so selector misses re-log
          _warnedOnce.clear();
        }

        await injectButton();
      } catch (err) {
        console.warn("[Scout] maybeInjectButton error:", err.message);
      }
    }

    // ─── Init ────────────────────────────────────────────────────────────────

    document.addEventListener("yt-navigate-finish", maybeInjectButton);
    maybeInjectButton();
  }
})();
