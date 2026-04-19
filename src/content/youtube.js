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

      // Inline styles — pill-shaped to match YouTube's action row buttons
      // (Subscribe, Like, Share). Avoids CSS specificity fights.
      Object.assign(btn.style, {
        background: "#0F0F0F",
        color: "#FFFFFF",
        padding: "0 16px",
        height: "36px",
        borderRadius: "18px",
        fontWeight: "600",
        fontSize: "14px",
        fontFamily: '"Roboto", "Arial", sans-serif',
        border: "0",
        cursor: "pointer",
        margin: "0 8px",
        display: "inline-flex",
        alignItems: "center",
        whiteSpace: "nowrap",
        lineHeight: "1",
        transition: "background 0.15s",
        verticalAlign: "middle",
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

    // ─── Frame + comment scraping ────────────────────────────────────────────

    /**
     * Grab the current video frame as a JPEG data URL.
     * If the canvas is tainted (no CORS) or the video isn't playing,
     * returns null and we fall back to YouTube's auto-thumbnails.
     */
    function captureCurrentFrame() {
      try {
        const video =
          document.querySelector("video.html5-main-video") ||
          document.querySelector("video.video-stream") ||
          document.querySelector("video");
        if (!video || !video.videoWidth || !video.videoHeight) return null;
        const maxW = 640;
        const w = Math.min(video.videoWidth, maxW);
        const h = Math.round((w * video.videoHeight) / video.videoWidth);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, w, h);
        return canvas.toDataURL("image/jpeg", 0.7);
      } catch (_) {
        return null;
      }
    }

    /**
     * Read whatever comments are already loaded in the DOM.
     * We don't force-scroll — too disruptive. Users who scrolled into
     * comments contribute them; others just get a shorter pool.
     * @returns {string[]}
     */
    function scrapeTopComments(maxN = 20) {
      try {
        const nodes = document.querySelectorAll(
          "ytd-comment-thread-renderer #content-text, ytd-comment-view-model #content-text, #comments #content-text"
        );
        const out = [];
        for (const n of nodes) {
          const t = (n.textContent || "").trim().replace(/\s+/g, " ");
          if (t && t.length > 3) out.push(t.slice(0, 500));
          if (out.length >= maxN) break;
        }
        return out;
      } catch (_) {
        return [];
      }
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

      // Description — read textContent directly; do not click the expander.
      // YouTube's DOM shifts — try newer container selectors first, then the
      // legacy yt-formatted-string children, stopping at the first non-empty.
      let description = "";
      try {
        const descSelectors = [
          "#description-inline-expander yt-formatted-string",
          "ytd-text-inline-expander yt-formatted-string",
          "#description yt-formatted-string",
          "#description-inline-expander",
          "ytd-text-inline-expander",
          "#description",
        ];
        for (const sel of descSelectors) {
          const el = document.querySelector(sel);
          const t = (el?.textContent || "").trim();
          if (t && t.length > 20) {
            description = t.slice(0, 4000);
            break;
          }
        }
      } catch (_) {}

      // Best-effort frame + comments — both may be empty and that's fine
      const currentFrameDataUrl = captureCurrentFrame();
      const topComments = scrapeTopComments(15);

      return {
        videoId, url, title, channel, channelUrl, thumbnailUrl, description,
        currentFrameDataUrl, topComments,
        savedAt: Date.now(),
      };
    }

    // ─── Button injection ────────────────────────────────────────────────────

    let _injecting = false;

    async function injectButton() {
      if (_injecting) return;
      if (document.getElementById("scout-save-btn")) return; // already present

      _injecting = true;
      try {
        // Preferred: the owner row inside #top-row — Subscribe lives there,
        // and inserting after #owner places us in the gap between Subscribe
        // and the Like/Share/... cluster in #actions.
        const owner =
          (await waitForElement("ytd-watch-metadata #top-row #owner", 3000)) ||
          (await waitForElement("#owner", 2000));

        // Fallback: title area (old placement) if the action row isn't there.
        const titleAnchor =
          owner ? null : ((await waitForElement("#above-the-fold #title")) ||
                          (await waitForElement("#above-the-fold", 3000)));

        if (!owner && !titleAnchor) {
          warnOnce("no-anchor", "could not find injection anchor — button not injected");
          return;
        }

        // Re-check after the await — another yt-navigate-finish may have
        // already injected while we were waiting.
        if (document.getElementById("scout-save-btn")) return;

        await _doInject(owner, titleAnchor);
      } finally {
        _injecting = false;
      }
    }

    async function _doInject(owner, titleAnchor) {
      const btn = createButton();

      // Progress messages: the button shows a green checkmark optimistically
      // on click, so we only surface terminal "error" state here. The popup
      // and saves list still reflect the real transcript/extraction progress.
      onMessage(MSG.SAVE_PROGRESS, async (payload) => {
        try {
          const liveBtn = document.getElementById("scout-save-btn");
          if (!liveBtn) return;
          if (payload?.status === "error") {
            applyBtnState(liveBtn, "error", payload.message ? `⚠ ${payload.message}` : undefined);
            delete liveBtn.dataset.scoutPending;
          }
        } catch (_) {}
      });

      btn.addEventListener("click", async () => {
        // Dedupe rapid double-clicks
        if (btn.dataset.scoutPending === "1") return;

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

        // Optimistic UX: flip to green checkmark immediately. Extraction
        // runs in the background; progress messages will update state only
        // if something actually fails.
        btn.dataset.scoutPending = "1";
        applyBtnState(btn, "saved");

        try {
          await sendMessage(MSG.SAVE_VIDEO, meta);
        } catch (_) {
          // sendMessage always resolves in practice; ignore
        }

        // Keep the "Saved" state visible for a moment, then return to default
        // so the user can save a different video. The detail-view progress
        // still lives in the popup / saves list.
        setTimeout(() => {
          try {
            const liveBtn = document.getElementById("scout-save-btn");
            if (liveBtn) applyBtnState(liveBtn, "default");
            if (liveBtn) delete liveBtn.dataset.scoutPending;
          } catch (_) {}
        }, 1800);
      });

      // Preferred: insert right after #owner so we land between Subscribe
      // and the Like cluster. Fallback: after the title h1.
      try {
        if (owner && owner.parentNode) {
          owner.parentNode.insertBefore(btn, owner.nextSibling);
        } else if (titleAnchor) {
          const h1 = titleAnchor.querySelector("h1") || titleAnchor;
          if (h1.parentNode) {
            h1.parentNode.insertBefore(btn, h1.nextSibling);
          } else {
            titleAnchor.appendChild(btn);
          }
        }
      } catch (_) {
        // DOM insertion failed — don't throw
      }
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
