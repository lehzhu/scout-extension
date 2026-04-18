(function phiaContentScript() {
  "use strict";

  const { MSG, sendMessage, onMessage } = self.Phia.messaging;

  // Track last URL to detect SPA navigations
  let lastUrl = "";

  // ─── DOM helpers ──────────────────────────────────────────────────────────

  /**
   * Poll for a DOM element until it appears or times out.
   * @param {string} selector
   * @param {number} timeoutMs
   * @returns {Promise<Element|null>}
   */
  function waitForElement(selector, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);

      const deadline = Date.now() + timeoutMs;
      const iv = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearInterval(iv);
          resolve(el);
        } else if (Date.now() >= deadline) {
          clearInterval(iv);
          resolve(null);
        }
      }, 200);
    });
  }

  // ─── Button state helpers ─────────────────────────────────────────────────

  const BTN_STYLES = {
    default: { background: "#e8344a", label: "★ Save to Phia", disabled: false },
    saving:  { background: "#e8344a", label: "Saving…",         disabled: true  },
    saved:   { background: "#1f8f4e", label: "✓ Saved",          disabled: true  },
    error:   { background: "#b3261e", label: "⚠ Error — retry",  disabled: false },
  };

  function applyBtnState(btn, state, customLabel) {
    const s = BTN_STYLES[state];
    btn.style.background = s.background;
    btn.textContent = customLabel || s.label;
    btn.disabled = s.disabled;
  }

  function createButton() {
    const btn = document.createElement("button");
    btn.id = "phia-save-btn";
    btn.className = "phia-save-btn";

    // Inline styles — avoids CSS specificity fights with YouTube
    Object.assign(btn.style, {
      background: "#e8344a",
      color: "#fff",
      padding: "8px 14px",
      borderRadius: "18px",
      fontWeight: "600",
      fontSize: "13px",
      fontFamily: "inherit",
      border: "0",
      cursor: "pointer",
      margin: "8px 0",
      display: "inline-block",
      lineHeight: "1.4",
      transition: "background 0.15s",
    });

    btn.textContent = "★ Save to Phia";

    btn.addEventListener("mouseenter", () => {
      if (!btn.disabled) btn.style.background = "#d62d41";
    });
    btn.addEventListener("mouseleave", () => {
      if (!btn.disabled) btn.style.background = BTN_STYLES.default.background;
    });

    return btn;
  }

  // ─── Metadata extraction ──────────────────────────────────────────────────

  /** @returns {import("../lib/types").VideoMeta} */
  function extractVideoMeta() {
    const videoId = new URLSearchParams(location.search).get("v") || "";
    const url = videoId
      ? `https://www.youtube.com/watch?v=${videoId}`
      : location.href;

    // Title: prefer the rendered h1 inside #above-the-fold, fall back to <title>
    const titleEl =
      document.querySelector("#above-the-fold #title h1") ||
      document.querySelector("#above-the-fold h1") ||
      document.querySelector("h1.ytd-watch-metadata");
    const title = titleEl?.textContent?.trim() ||
      document.title.replace(/ - YouTube$/, "").trim();

    // Channel anchor — try multiple selectors for robustness
    const channelAnchor =
      document.querySelector("#above-the-fold ytd-channel-name #text a") ||
      document.querySelector("ytd-channel-name #text a") ||
      document.querySelector("#channel-name a") ||
      document.querySelector("#owner-name a");
    const channel = channelAnchor?.textContent?.trim() || "";
    const channelUrl = channelAnchor?.href
      ? new URL(channelAnchor.href, location.origin).href
      : "";

    const thumbnailUrl = videoId
      ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      : "";

    // Description — read textContent directly; do not click the expander
    const descEl =
      document.querySelector("#description-inline-expander yt-formatted-string") ||
      document.querySelector("ytd-text-inline-expander yt-formatted-string") ||
      document.querySelector("#description yt-formatted-string");
    const description = (descEl?.textContent || "").slice(0, 4000);

    return { videoId, url, title, channel, channelUrl, thumbnailUrl, description, savedAt: Date.now() };
  }

  // ─── Button injection ─────────────────────────────────────────────────────

  async function injectButton() {
    if (document.getElementById("phia-save-btn")) return; // already present

    // Wait for the title area to exist (YouTube renders async)
    const anchor =
      (await waitForElement("#above-the-fold #title")) ||
      (await waitForElement("#above-the-fold", 3000));

    if (!anchor) return; // couldn't find a mount point

    const btn = createButton();

    // Listen for progress messages from background
    onMessage(MSG.SAVE_PROGRESS, async (payload) => {
      const liveBtn = document.getElementById("phia-save-btn");
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
    });

    btn.addEventListener("click", async () => {
      applyBtnState(btn, "saving");

      const meta = extractVideoMeta();
      if (!meta.videoId) {
        applyBtnState(btn, "error", "⚠ No video ID — retry");
        return;
      }

      try {
        const response = await sendMessage(MSG.SAVE_VIDEO, meta);
        if (response?.ok) {
          showSaved(btn);
        } else {
          const msg = response?.error ? `⚠ ${response.error}` : undefined;
          applyBtnState(btn, "error", msg);
        }
      } catch (e) {
        applyBtnState(btn, "error", e.message ? `⚠ ${e.message}` : undefined);
      }
    });

    // Insert after the title's h1 (or as first child of #above-the-fold)
    const h1 = anchor.querySelector("h1") || anchor;
    if (h1.parentNode) {
      h1.parentNode.insertBefore(btn, h1.nextSibling);
    } else {
      anchor.appendChild(btn);
    }
  }

  function showSaved(btn) {
    applyBtnState(btn, "saved");
    setTimeout(() => {
      if (document.getElementById("phia-save-btn") === btn) {
        applyBtnState(btn, "default");
      }
    }, 2000);
  }

  // ─── SPA-aware entry point ────────────────────────────────────────────────

  async function maybeInjectButton() {
    if (!/^https:\/\/(www\.)?youtube\.com\/watch/.test(location.href)) return;

    // If URL changed (SPA nav to a different video), remove stale button
    if (location.href !== lastUrl) {
      const old = document.getElementById("phia-save-btn");
      if (old) old.remove();
      lastUrl = location.href;
    }

    await injectButton();
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  document.addEventListener("yt-navigate-finish", maybeInjectButton);
  maybeInjectButton();
})();
