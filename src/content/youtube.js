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
      open:    { background: "#22A06B", label: "✓ Open in Scout",   disabled: false },
      error:   { background: "#F0336C", label: "⚠ Error — retry",   disabled: false },
    };

    function applyBtnState(btn, state, customLabel) {
      try {
        const s = BTN_STYLES[state] || BTN_STYLES.default;
        btn.style.background = s.background;
        btn.textContent = customLabel || s.label;
        btn.disabled = s.disabled;
        btn.dataset.scoutState = BTN_STYLES[state] ? state : "default";
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
        margin: "0 0 0 8px",
        display: "inline-flex",
        alignItems: "center",
        whiteSpace: "nowrap",
        lineHeight: "1",
        transition: "background 0.15s",
        verticalAlign: "middle",
        alignSelf: "center",
        flex: "0 0 auto",
      });

      btn.textContent = "★ Save to Scout";

      btn.addEventListener("mouseenter", () => {
        if (btn.disabled) return;
        if (btn.dataset.scoutState === "open") {
          btn.style.background = "#1C8A5A";
        } else {
          btn.style.background = "#2A2A2A";
        }
      });
      btn.addEventListener("mouseleave", () => {
        if (btn.disabled) return;
        if (btn.dataset.scoutState === "open") {
          btn.style.background = BTN_STYLES.open.background;
        } else {
          btn.style.background = BTN_STYLES.default.background;
        }
      });

      return btn;
    }

    // ─── Toast (duplicate warning) ───────────────────────────────────────────

    function showDuplicateToast(savedAt, onConfirm) {
      try {
        document.getElementById("scout-toast")?.remove();
      } catch (_) {}
      const toast = document.createElement("div");
      toast.id = "scout-toast";
      Object.assign(toast.style, {
        position: "fixed",
        right: "20px",
        bottom: "20px",
        zIndex: "2147483647",
        background: "#0F0F0F",
        color: "#FFFFFF",
        padding: "14px 16px",
        borderRadius: "12px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
        fontFamily: '-apple-system, "Inter", "Segoe UI", Helvetica, Arial, sans-serif',
        fontSize: "13px",
        lineHeight: "1.4",
        maxWidth: "320px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      });

      const msg = document.createElement("div");
      const when = savedAt
        ? ` on ${new Date(savedAt).toLocaleDateString()}`
        : "";
      msg.textContent = `You already saved this video${when}.`;
      toast.appendChild(msg);

      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.gap = "8px";
      actions.style.justifyContent = "flex-end";

      const dismiss = document.createElement("button");
      dismiss.textContent = "Dismiss";
      Object.assign(dismiss.style, {
        background: "transparent",
        color: "#FFFFFF",
        border: "1px solid rgba(255,255,255,0.3)",
        padding: "6px 12px",
        borderRadius: "8px",
        cursor: "pointer",
        fontSize: "12px",
        fontWeight: "500",
      });
      dismiss.addEventListener("click", () => toast.remove());

      const confirm = document.createElement("button");
      confirm.textContent = "Save anyway";
      Object.assign(confirm.style, {
        background: "#FFFFFF",
        color: "#0F0F0F",
        border: "0",
        padding: "6px 12px",
        borderRadius: "8px",
        cursor: "pointer",
        fontSize: "12px",
        fontWeight: "600",
      });
      confirm.addEventListener("click", () => {
        toast.remove();
        try { onConfirm && onConfirm(); } catch (_) {}
      });

      actions.appendChild(dismiss);
      actions.appendChild(confirm);
      toast.appendChild(actions);
      document.body.appendChild(toast);

      setTimeout(() => {
        try { toast.remove(); } catch (_) {}
      }, 8000);
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

    /**
     * Pull the clean description from ytInitialPlayerResponse embedded in a
     * <script> tag — but ONLY if its videoId matches the given one. On SPA
     * navigations YouTube keeps the original script tag from the initial
     * page load, so without this guard we'd return the wrong video's
     * description after navigating between watch pages.
     * Returns "" on any failure — caller falls back to empty.
     */
    function readDescriptionFromPlayerResponse(expectedVideoId) {
      try {
        const scripts = document.querySelectorAll("script");
        for (const s of scripts) {
          const text = s.textContent || "";
          if (!text.includes("ytInitialPlayerResponse")) continue;

          const idx = text.indexOf("ytInitialPlayerResponse");
          if (idx === -1) continue;
          const braceStart = text.indexOf("{", idx);
          if (braceStart === -1) continue;
          let depth = 0, end = -1, inStr = false, esc = false;
          for (let i = braceStart; i < text.length; i++) {
            const ch = text[i];
            if (inStr) {
              if (esc) esc = false;
              else if (ch === "\\") esc = true;
              else if (ch === '"') inStr = false;
              continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === "{") depth++;
            else if (ch === "}") {
              depth--;
              if (depth === 0) { end = i; break; }
            }
          }
          if (end === -1) continue;
          try {
            const pr = JSON.parse(text.slice(braceStart, end + 1));
            if (expectedVideoId && pr?.videoDetails?.videoId !== expectedVideoId) {
              // Stale script tag from a previous page load — skip.
              continue;
            }
            const desc = pr?.videoDetails?.shortDescription;
            if (typeof desc === "string" && desc.trim()) return desc;
          } catch (_) {}
        }
      } catch (_) {}
      return "";
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

      // Description — read from ytInitialPlayerResponse embedded in the page.
      // This avoids YouTube's AI summary widget (which now bleeds into the
      // #description-inline-expander DOM with "Summary / AI-generated…" copy).
      // Pass the current videoId so we reject stale script tags left over
      // from prior SPA pages.
      let description = "";
      try {
        description = readDescriptionFromPlayerResponse(videoId);
      } catch (_) {}
      // Normalize consecutive blank lines (3+ newlines → 2) and cap length
      try {
        description = description.replace(/\n{3,}/g, "\n\n").slice(0, 4000);
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
      applyBtnState(btn, "default");

      function openSavedPage(id) {
        try {
          if (!id) return;
          const url = chrome.runtime.getURL(
            "src/page/index.html?id=" + encodeURIComponent(id)
          );
          window.open(url, "_blank", "noopener");
        } catch (_) {}
      }

      // Progress messages: the button shows terminal "error" state here.
      // "done" no-ops — doSave() already transitioned to "open" on resp.ok.
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

      async function doSave(force) {
        // If already in "open" state, a click should route to openSavedPage.
        // The click handler handles that directly; this guard is defense-in-depth.
        if (btn.dataset.scoutState === "open" && !force) {
          openSavedPage(btn.dataset.scoutSavedId);
          return;
        }
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

        // No optimistic "Saved" flash — we can't claim saved until the SW
        // has confirmed it isn't a duplicate. Show a transient "Saving…" state.
        btn.dataset.scoutPending = "1";
        applyBtnState(btn, "saving");

        let resp;
        try {
          resp = await sendMessage(MSG.SAVE_VIDEO, { ...meta, force: !!force });
        } catch (_) {
          resp = { ok: false, error: "No receiver" };
        }

        // Duplicate: transition straight to "open" state with the existing id.
        if (resp && resp.duplicate) {
          delete btn.dataset.scoutPending;
          if (resp.existingId) {
            btn.dataset.scoutSavedId = resp.existingId;
            applyBtnState(btn, "open");
          } else {
            applyBtnState(btn, "default");
          }
          showDuplicateToast(resp.savedAt, () => doSave(true));
          return;
        }

        // Success: compute id the same way the SW does and pin "open" state.
        if (resp && resp.ok) {
          delete btn.dataset.scoutPending;
          const savedId = `${meta.videoId}-${meta.savedAt}`;
          btn.dataset.scoutSavedId = savedId;
          applyBtnState(btn, "open");
          return;
        }

        // Non-duplicate failure (and not handled by SAVE_PROGRESS): show error.
        delete btn.dataset.scoutPending;
        const errMsg = (resp && resp.error) ? `⚠ ${resp.error}` : undefined;
        applyBtnState(btn, "error", errMsg);
      }

      btn.addEventListener("click", async () => {
        if (btn.dataset.scoutState === "open") {
          openSavedPage(btn.dataset.scoutSavedId);
          return;
        }
        if (btn.dataset.scoutPending === "1") return;
        await doSave(false);
      });

      // Preferred: insert immediately after YouTube's Subscribe button so we
      // share its exact vertical center line. Falling back to appending inside
      // #owner can land us next to the avatar (taller than Subscribe), which
      // shifts our 36px pill upward relative to Subscribe.
      try {
        const subscribeBtn = owner
          ? (owner.querySelector("#subscribe-button") ||
             owner.querySelector("ytd-subscribe-button-renderer") ||
             owner.querySelector("yt-subscribe-button-view-model") ||
             owner.querySelector("tp-yt-paper-button#subscribe"))
          : null;

        if (subscribeBtn && subscribeBtn.parentNode) {
          subscribeBtn.parentNode.insertBefore(btn, subscribeBtn.nextSibling);
        } else if (owner) {
          owner.appendChild(btn);
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

      // After inserting, ask the SW whether this video is already saved.
      // Use the freshest videoId at call time — not a closure capture.
      (async () => {
        try {
          let currentVideoId = "";
          try {
            currentVideoId = new URLSearchParams(location.search).get("v") || "";
          } catch (_) {}
          if (!currentVideoId) return;
          const resp = await sendMessage(MSG.GET_SAVED_ID, { videoId: currentVideoId });
          if (!resp || !resp.id) return;
          // Only upgrade if the button is still the fresh default (no in-flight save).
          const live = document.getElementById("scout-save-btn");
          if (!live) return;
          if (live.dataset.scoutPending === "1") return;
          if (live.dataset.scoutState && live.dataset.scoutState !== "default") return;
          // And only if the URL's videoId hasn't changed since we asked.
          let nowVideoId = "";
          try {
            nowVideoId = new URLSearchParams(location.search).get("v") || "";
          } catch (_) {}
          if (nowVideoId !== currentVideoId) return;
          live.dataset.scoutSavedId = resp.id;
          applyBtnState(live, "open");
        } catch (_) {}
      })();
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
