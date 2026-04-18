// Phinds popup — Shopping list + Settings
(async function phindsPopup() {
  "use strict";

  const { MSG, sendMessage } = self.Phia.messaging;

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

  async function renderSettings() {
    const input = document.getElementById("api-key");
    const hint  = document.getElementById("key-hint");
    const status = document.getElementById("save-status");
    const form  = document.getElementById("settings-form");

    const settings = await self.Phia.storage.getSettings();
    if (settings.geminiApiKey) {
      input.value = settings.geminiApiKey;
      hint.textContent = "";
    } else {
      hint.textContent = "Required to extract products from videos.";
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const key = input.value.trim();
      try {
        await self.Phia.storage.setSettings({ geminiApiKey: key || null });
        hint.textContent = key ? "" : "Required to extract products from videos.";
        status.textContent = "Saved \u2713";
        status.className = "save-status save-status--ok";
        setTimeout(() => {
          status.textContent = "";
          status.className = "save-status";
        }, 2000);
      } catch (err) {
        status.textContent = "Error: " + escapeHtml(err.message);
        status.className = "save-status save-status--err";
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
    buy.href = formatSearchUrl(product.searchQuery);
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
    img.src = videoMeta.thumbnailUrl || "";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    const meta = document.createElement("div");
    meta.className = "video-card__meta";
    const titleEl = document.createElement("div");
    titleEl.className = "video-card__title";
    titleEl.textContent = videoMeta.title || "Saving video\u2026";
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

  // ── Single video card ───────────────────────────────────────────────────

  function buildCard(item) {
    const { video, products, status, error, id } = item;
    const card = document.createElement("div");
    card.className = "video-card";

    // Header
    const header = document.createElement("div");
    header.className = "video-card__header";
    const img = document.createElement("img");
    img.className = "video-card__thumb";
    img.src = video.thumbnailUrl;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    const meta = document.createElement("div");
    meta.className = "video-card__meta";
    const titleEl = document.createElement("div");
    titleEl.className = "video-card__title";
    titleEl.textContent = video.title;
    const subEl = document.createElement("div");
    subEl.className = "video-card__sub";
    const count = products.length;
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
      if (products.length === 0) {
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
        products.slice(0, SHOW).forEach((p) => list.appendChild(buildProductRow(p)));
        const extra = products.slice(SHOW);
        if (extra.length > 0) {
          const hiddenContainer = document.createElement("div");
          hiddenContainer.style.display = "none";
          extra.forEach((p) => hiddenContainer.appendChild(buildProductRow(p)));
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
        await sendMessage(MSG.RETRY_ITEM, { id });
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
      await sendMessage(MSG.REMOVE_ITEM, { id });
    });
    const openLink = document.createElement("a");
    openLink.className = "btn-ghost";
    openLink.href = video.url;
    openLink.target = "_blank";
    openLink.rel = "noopener noreferrer";
    openLink.innerHTML = "Open video " + EXTERNAL_SVG;
    actions.appendChild(removeBtn);
    actions.appendChild(openLink);
    card.appendChild(actions);

    return card;
  }

  // ── Pending section ─────────────────────────────────────────────────────

  function renderPending(container, inFlightItems) {
    container.innerHTML = "";
    if (!inFlightItems || inFlightItems.length === 0) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = "Saving";
    container.appendChild(label);
    inFlightItems.forEach((item) => container.appendChild(buildPendingCard(item)));
  }

  // ── Shopping list ───────────────────────────────────────────────────────

  async function renderList() {
    const container = document.getElementById("list");
    container.innerHTML = "";

    let items;
    try {
      items = await sendMessage(MSG.GET_ITEMS);
    } catch (_) {
      items = [];
    }

    if (!Array.isArray(items) || items.length === 0) {
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
          <div class="empty-state__hint">Save a YouTube video to get started</div>
        </div>`;
      return;
    }

    items.forEach((item) => container.appendChild(buildCard(item)));
  }

  // ── Init ────────────────────────────────────────────────────────────────

  setupTabs();
  await renderSettings();
  const pendingSection = document.getElementById("pending-section");
  let inFlightItems = [];
  try { inFlightItems = await sendMessage(MSG.GET_INFLIGHT) || []; } catch (_) {}
  renderPending(pendingSection, inFlightItems);
  await renderList();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.INFLIGHT_UPDATE) renderPending(pendingSection, msg.payload || []);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["phia.items"]) renderList();
  });
})();
