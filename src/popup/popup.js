// Scout popup — Shopping list + Settings
(async function scoutPopup() {
  "use strict";

  const { MSG, sendMessage } = self.Scout.messaging;

  // ── Utilities ───────────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatSearchUrl(query) {
    return "https://www.google.com/search?tbm=shop&q=" + encodeURIComponent(query);
  }

  const EXTERNAL_SVG =
    `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M2 9L9 2M9 2H4.5M9 2V6.5"
        stroke="currentColor" stroke-width="1.4"
        stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

  // ── Tab switching ───────────────────────────────────────────────────────

  function setupTabs() {
    const tabs = document.querySelectorAll(".tab");
    const panels = document.querySelectorAll(".panel");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => {
          t.classList.remove("tab--active");
          t.setAttribute("aria-selected", "false");
        });
        panels.forEach((p) => { p.hidden = true; });
        tab.classList.add("tab--active");
        tab.setAttribute("aria-selected", "true");
        const target = document.getElementById(tab.getAttribute("aria-controls"));
        if (target) target.hidden = false;
      });
    });
    panels.forEach((p, i) => { p.hidden = i !== 0; });
  }

  // ── Settings ────────────────────────────────────────────────────────────

  const PROVIDER_CONFIG = {
    none: {
      providerHint: "Extracts products from title and description using pattern matching — no API key needed.",
      keyLabel: null, keyPlaceholder: null, keyField: null,
      modelField: null, defaultModel: null, keyHintHtml: null,
    },
    gemini: {
      providerHint: "Uses Google Gemini for structured JSON product extraction.",
      keyLabel: "Gemini API Key", keyPlaceholder: "AIza\u2026",
      keyField: "geminiApiKey", modelField: "geminiModel",
      defaultModel: "gemini-2.5-flash",
      keyHintHtml: 'Get a free key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>.',
    },
    openrouter: {
      providerHint: "OpenAI-compatible API with free and paid open-weight models. OpenRouter keys only — not OpenAI keys.",
      keyLabel: "OpenRouter API Key", keyPlaceholder: "sk-or-\u2026",
      keyField: "openrouterApiKey", modelField: "openrouterModel",
      defaultModel: "meta-llama/llama-3.1-8b-instruct:free",
      keyHintHtml: 'Get a key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">openrouter.ai/keys</a>. Free models available.',
    },
    openai: {
      providerHint: "Uses OpenAI directly. gpt-4o-mini is the cheapest option.",
      keyLabel: "OpenAI API Key", keyPlaceholder: "sk-\u2026",
      keyField: "openaiApiKey", modelField: "openaiModel",
      defaultModel: "gpt-4o-mini",
      keyHintHtml: 'Get a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">platform.openai.com/api-keys</a>.',
    },
  };

  async function renderSettings() {
    const providerBtns  = document.querySelectorAll(".provider-btn");
    const keyGroup      = document.getElementById("key-group");
    const modelGroup    = document.getElementById("model-group");
    const providerHintEl= document.getElementById("provider-hint");
    const keyLabel      = document.getElementById("key-label");
    const keyInput      = document.getElementById("api-key");
    const keyHint       = document.getElementById("key-hint");
    const modelInput    = document.getElementById("model-input");
    const statusEl      = document.getElementById("save-status");
    const form          = document.getElementById("settings-form");

    let settings = {};
    try { settings = await self.Scout.storage.getSettings(); } catch (_) {}

    let currentProvider = settings.provider || "none";

    function applyProvider(provider) {
      currentProvider = provider;
      const cfg = PROVIDER_CONFIG[provider] || PROVIDER_CONFIG.none;

      providerBtns.forEach((btn) =>
        btn.classList.toggle("provider-btn--active", btn.dataset.provider === provider)
      );

      providerHintEl.textContent = cfg.providerHint;

      const needsKey = !!cfg.keyField;
      keyGroup.hidden  = !needsKey;
      modelGroup.hidden = !needsKey;

      if (needsKey) {
        keyLabel.textContent    = cfg.keyLabel;
        keyInput.placeholder    = cfg.keyPlaceholder;
        keyInput.value          = settings[cfg.keyField] || "";
        keyHint.innerHTML       = cfg.keyHintHtml;
        modelInput.placeholder  = `${cfg.defaultModel} (default)`;
        modelInput.value        = settings[cfg.modelField] || "";
      }
    }

    providerBtns.forEach((btn) =>
      btn.addEventListener("click", () => applyProvider(btn.dataset.provider))
    );

    applyProvider(currentProvider);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const cfg   = PROVIDER_CONFIG[currentProvider] || PROVIDER_CONFIG.none;
      const patch = { provider: currentProvider };
      if (cfg.keyField)   patch[cfg.keyField]   = keyInput.value.trim()  || null;
      if (cfg.modelField) patch[cfg.modelField] = modelInput.value.trim() || null;
      try {
        await self.Scout.storage.setSettings(patch);
        settings = await self.Scout.storage.getSettings();
        statusEl.textContent = "Saved \u2713";
        statusEl.className   = "save-status save-status--ok";
        setTimeout(() => { statusEl.textContent = ""; statusEl.className = "save-status"; }, 2000);
      } catch (err) {
        statusEl.textContent = "Save failed \u2014 try again";
        statusEl.className   = "save-status save-status--err";
        setTimeout(() => { statusEl.textContent = ""; statusEl.className = "save-status"; }, 3000);
      }
    });
  }

  // ── Product row builder ─────────────────────────────────────────────────

  function buildProductRow(product) {
    const row = document.createElement("div");
    row.className = "product-row";

    const bullet = document.createElement("span");
    bullet.className = "product-row__bullet";
    bullet.textContent = "\u25b8";

    const name = document.createElement("span");
    name.className = "product-row__name";
    name.textContent = product.name;

    const buy = document.createElement("a");
    buy.className = "product-row__buy";
    buy.href = formatSearchUrl(product.searchQuery || product.name || "");
    buy.target = "_blank";
    buy.rel = "noopener noreferrer";
    buy.innerHTML = "Buy " + EXTERNAL_SVG;

    row.appendChild(bullet);
    row.appendChild(name);
    if (product.brand) {
      const brand = document.createElement("span");
      brand.className = "product-row__brand";
      brand.textContent = "\u2014 " + product.brand;
      row.appendChild(brand);
    }
    row.appendChild(buy);
    return row;
  }

  // ── Pending card (in-flight save) ───────────────────────────────────────

  const STATUS_LABEL = {
    "fetching-transcript": "Reading transcript\u2026",
    "extracting-products": "Finding products\u2026",
  };

  function buildPendingCard({ videoMeta, status }) {
    const card = document.createElement("div");
    card.className = "video-card video-card--pending";
    const header = document.createElement("div");
    header.className = "video-card__header";
    const img = document.createElement("img");
    img.className = "video-card__thumb";
    img.src = videoMeta?.thumbnailUrl || "";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    const meta = document.createElement("div");
    meta.className = "video-card__meta";
    const titleEl = document.createElement("div");
    titleEl.className = "video-card__title";
    titleEl.textContent = videoMeta?.title || "Saving video\u2026";
    const pill = document.createElement("div");
    pill.className = "pending-pill";
    pill.innerHTML =
      `<span class="pending-dots"><span></span><span></span><span></span></span>` +
      `<span class="pending-pill__label">${escapeHtml(STATUS_LABEL[status] || "Saving\u2026")}</span>`;
    meta.appendChild(titleEl);
    meta.appendChild(pill);
    header.appendChild(img);
    header.appendChild(meta);
    card.appendChild(header);
    return card;
  }

  // ── Single video card — per-item defensive ──────────────────────────────

  /**
   * Builds a card for one saved item.
   * If any field is missing/wrong, renders whatever is available.
   * Never throws — returns a skeletal error card on complete failure.
   */
  function buildCard(item) {
    try {
      const { video, products, status, error, id } = item;

      // Guard required fields — without these we can't render anything useful
      if (!video || typeof video !== "object") {
        throw new Error("item.video is missing");
      }

      const card = document.createElement("div");
      card.className = "video-card";

      // Header
      const header = document.createElement("div");
      header.className = "video-card__header";
      const img = document.createElement("img");
      img.className = "video-card__thumb";
      img.src = video.thumbnailUrl || "";
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      const meta = document.createElement("div");
      meta.className = "video-card__meta";
      const titleEl = document.createElement("div");
      titleEl.className = "video-card__title";
      titleEl.textContent = video.title || "(untitled)";
      const safeProducts = Array.isArray(products) ? products : [];
      const subEl = document.createElement("div");
      subEl.className = "video-card__sub";
      const count = safeProducts.length;
      subEl.textContent =
        (video.channel ? video.channel + " \u00b7 " : "") +
        (count === 1 ? "1 product" : count + " products");
      meta.appendChild(titleEl);
      meta.appendChild(subEl);
      header.appendChild(img);
      header.appendChild(meta);
      card.appendChild(header);

      if (status === "error") {
        const notice = document.createElement("div");
        notice.className = "notice notice--error";
        const retryLabel = document.createElement("span");
        retryLabel.textContent = "\u26a0 Could not extract products";
        notice.appendChild(retryLabel);
        card.appendChild(notice);
        if (error) {
          const toggle = document.createElement("span");
          toggle.style.cssText = "cursor:pointer;text-decoration:underline;margin-left:6px;font-size:11px";
          toggle.textContent = "details";
          const detail = document.createElement("div");
          detail.className = "error-detail";
          detail.textContent = error;
          toggle.addEventListener("click", () => detail.classList.toggle("error-detail--open"));
          notice.appendChild(toggle);
          card.appendChild(detail);
        }
      }

      if (status !== "error") {
        if (safeProducts.length === 0) {
          const none = document.createElement("p");
          none.className = "notice notice--empty";
          none.textContent = "No products detected in this video.";
          card.appendChild(none);
        } else {
          const section = document.createElement("div");
          const SHOW = 3;
          const label = document.createElement("div");
          label.className = "section-label";
          label.textContent = "Products";
          section.appendChild(label);
          const list = document.createElement("div");
          list.className = "products-list";
          safeProducts.slice(0, SHOW).forEach((p) => {
            try { list.appendChild(buildProductRow(p)); } catch (_) {}
          });
          const extra = safeProducts.slice(SHOW);
          if (extra.length > 0) {
            const hiddenContainer = document.createElement("div");
            hiddenContainer.style.display = "none";
            extra.forEach((p) => {
              try { hiddenContainer.appendChild(buildProductRow(p)); } catch (_) {}
            });
            const more = document.createElement("div");
            more.className = "product-row product-row--more";
            more.textContent = `+ ${extra.length} more`;
            more.addEventListener("click", () => {
              hiddenContainer.style.cssText = "display:flex;flex-direction:column;gap:4px";
              more.style.display = "none";
            });
            list.appendChild(more);
            list.appendChild(hiddenContainer);
          }
          section.appendChild(list);
          card.appendChild(section);
        }
      }

      const actions = document.createElement("div");
      actions.className = "card-actions";
      if (status === "error") {
        const retryBtn = document.createElement("button");
        retryBtn.className = "btn-ghost btn-ghost--retry";
        retryBtn.type = "button";
        retryBtn.textContent = "Retry";
        retryBtn.addEventListener("click", async () => {
          retryBtn.disabled = true;
          retryBtn.textContent = "Retrying\u2026";
          try {
            const resp = await sendMessage(MSG.RETRY_ITEM, { id });
            if (resp && !resp.ok && resp.error) {
              retryBtn.textContent = "Retry";
              retryBtn.disabled = false;
              // Show inline failure notice
              const errSpan = document.createElement("span");
              errSpan.style.cssText = "color:#F0336C;font-size:11px;margin-left:6px";
              errSpan.textContent = resp.error;
              actions.appendChild(errSpan);
              setTimeout(() => { try { actions.removeChild(errSpan); } catch (_) {} }, 4000);
            }
          } catch (_) {
            retryBtn.textContent = "Retry";
            retryBtn.disabled = false;
          }
        });
        actions.appendChild(retryBtn);
      }
      const removeBtn = document.createElement("button");
      removeBtn.className = "btn-ghost btn-ghost--danger";
      removeBtn.type = "button";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        card.style.opacity = "0.5";
        card.style.pointerEvents = "none";
        try {
          const resp = await sendMessage(MSG.REMOVE_ITEM, { id });
          if (resp && !resp.ok) {
            // Restore card so user can try again
            card.style.opacity = "";
            card.style.pointerEvents = "";
          }
        } catch (_) {
          card.style.opacity = "";
          card.style.pointerEvents = "";
        }
      });
      const openLink = document.createElement("a");
      openLink.className = "btn-ghost";
      openLink.href = video.url || "#";
      openLink.target = "_blank";
      openLink.rel = "noopener noreferrer";
      openLink.innerHTML = "Open video " + EXTERNAL_SVG;
      actions.appendChild(removeBtn);
      actions.appendChild(openLink);
      card.appendChild(actions);

      return card;

    } catch (err) {
      // Per-item fallback: render a minimal "couldn't render" card
      console.warn("[Scout] buildCard failed for item:", item?.id, err.message);
      const fallback = document.createElement("div");
      fallback.className = "video-card";
      fallback.style.opacity = "0.7";
      const notice = document.createElement("div");
      notice.className = "notice notice--error";
      notice.textContent = "Couldn\u2019t render this video — click Remove to clean up.";
      const actions = document.createElement("div");
      actions.className = "card-actions";
      const removeBtn = document.createElement("button");
      removeBtn.className = "btn-ghost btn-ghost--danger";
      removeBtn.type = "button";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        fallback.style.opacity = "0.5";
        fallback.style.pointerEvents = "none";
        try {
          await sendMessage(MSG.REMOVE_ITEM, { id: item?.id });
        } catch (_) {}
      });
      actions.appendChild(removeBtn);
      fallback.appendChild(notice);
      fallback.appendChild(actions);
      return fallback;
    }
  }

  // ── Pending section ─────────────────────────────────────────────────────

  function renderPending(container, inFlightItems) {
    try {
      container.innerHTML = "";
      if (!Array.isArray(inFlightItems) || inFlightItems.length === 0) {
        container.hidden = true;
        return;
      }
      container.hidden = false;
      const label = document.createElement("div");
      label.className = "section-label";
      label.textContent = "Saving";
      container.appendChild(label);
      inFlightItems.forEach((item) => {
        try { container.appendChild(buildPendingCard(item)); } catch (_) {}
      });
    } catch (_) {}
  }

  // ── Shopping list ───────────────────────────────────────────────────────

  // True when extraction will work (heuristic always works; LLM needs a key).
  let _readyToExtract = false;

  async function renderList() {
    const container = document.getElementById("list");
    try {
      container.innerHTML = "";
    } catch (_) { return; }

    // Fetch items — response is always {ok, error?} or an array (legacy GET_ITEMS returns array directly)
    let items = [];
    try {
      const response = await sendMessage(MSG.GET_ITEMS);
      if (Array.isArray(response)) {
        items = response;
      } else if (response && Array.isArray(response.items)) {
        items = response.items;
      } else {
        items = [];
      }
    } catch (_) {
      items = [];
    }

    if (!Array.isArray(items) || items.length === 0) {
      // Choose empty-state message based on context
      const emptyHint = !_readyToExtract
        ? "Open Settings to configure a provider, then save a YouTube video."
        : "Save a YouTube video to get started";

      container.innerHTML =
        `<div class="empty-state">
          <svg class="empty-state__icon" width="28" height="28" viewBox="0 0 28 28"
            fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M9 7H5.5C4.67 7 4 7.67 4 8.5v13C4 22.33 4.67 23 5.5 23h17c.83 0
              1.5-.67 1.5-1.5v-13c0-.83-.67-1.5-1.5-1.5H19M9 7V5.5C9 4.12 10.12 3 11.5
              3h5C17.88 3 19 4.12 19 5.5V7M9 7h10" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M10 13h8M10 17h5" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <div class="empty-state__heading">Your shopping list is empty</div>
          <div class="empty-state__hint">${escapeHtml(emptyHint)}</div>
        </div>`;
      return;
    }

    // Render items — each in its own try/catch via buildCard
    items.forEach((item) => {
      try {
        container.appendChild(buildCard(item));
      } catch (_) {
        // buildCard itself never throws (it has an internal fallback), but be safe
      }
    });

    // Export bar
    const bar = document.createElement("div");
    bar.className = "export-bar";
    const exportBtn = document.createElement("button");
    exportBtn.className = "btn-ghost";
    exportBtn.type = "button";
    exportBtn.textContent = "Export JSON";
    exportBtn.addEventListener("click", () => {
      try {
        const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href     = url;
        a.download = `scout-export-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (_) {}
    });
    const csvBtn = document.createElement("button");
    csvBtn.className = "btn-ghost";
    csvBtn.type = "button";
    csvBtn.textContent = "Export CSV";
    csvBtn.addEventListener("click", () => {
      try {
        const rows = [["video_title","channel","product_name","brand","category","search_query","confidence","buy_link","video_url"]];
        items.forEach((item) => {
          const v = item.video || {};
          (Array.isArray(item.products) ? item.products : []).forEach((p) => {
            rows.push([
              v.title || "", v.channel || "",
              p.name || "", p.brand || "", p.category || "",
              p.searchQuery || "", p.confidence ?? "",
              formatSearchUrl(p.searchQuery || p.name || ""),
              v.url || "",
            ].map((c) => `"${String(c).replace(/"/g, '""')}"`));
          });
        });
        const csv  = rows.map((r) => r.join(",")).join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href     = url;
        a.download = `scout-export-${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (_) {}
    });
    bar.appendChild(exportBtn);
    bar.appendChild(csvBtn);
    container.appendChild(bar);
  }

  // ── Init ────────────────────────────────────────────────────────────────

  setupTabs();
  await renderSettings();

  try {
    const settings = await self.Scout.storage.getSettings();
    const p = settings.provider || "none";
    _readyToExtract =
      p === "none" ||
      (p === "gemini"      && !!settings.geminiApiKey) ||
      (p === "openrouter"  && !!settings.openrouterApiKey) ||
      (p === "openai"      && !!settings.openaiApiKey);
  } catch (_) {}

  const pendingSection = document.getElementById("pending-section");
  let inFlightItems = [];
  try {
    const resp = await sendMessage(MSG.GET_INFLIGHT);
    inFlightItems = Array.isArray(resp) ? resp : [];
  } catch (_) {}
  renderPending(pendingSection, inFlightItems);
  await renderList();

  chrome.runtime.onMessage.addListener((msg) => {
    try {
      if (msg.type === MSG.INFLIGHT_UPDATE) renderPending(pendingSection, msg.payload || []);
    } catch (_) {}
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    try {
      if (area === "local" && changes["scout.items"]) renderList();
    } catch (_) {
      // Re-render failure must not unsubscribe the listener
    }
  });
})();
