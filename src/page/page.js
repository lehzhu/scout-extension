// Scout page — full-page shopping list view
(async function scoutPage() {
  "use strict";

  // ── Utilities ───────────────────────────────────────────────────────────

  function formatSearchUrl(query) {
    return "https://www.google.com/search?tbm=shop&q=" + encodeURIComponent(query);
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function $(id) { return document.getElementById(id); }

  // ── State ───────────────────────────────────────────────────────────────

  let allItems = [];
  let listSearchText = "";
  let listActiveCategory = "All";
  let detailActiveCategory = "All";
  let currentDetailId = null;

  // ── Routing ─────────────────────────────────────────────────────────────

  function getRouteId() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("id");
    } catch (_) {
      return null;
    }
  }

  function showListView() {
    try {
      const list = $("list-view");
      const detail = $("detail-view");
      if (list) list.hidden = false;
      if (detail) detail.hidden = true;
    } catch (_) {}
  }

  function showDetailView() {
    try {
      const list = $("list-view");
      const detail = $("detail-view");
      if (list) list.hidden = true;
      if (detail) detail.hidden = false;
    } catch (_) {}
  }

  function route() {
    try {
      const id = getRouteId();
      if (!id) {
        currentDetailId = null;
        showListView();
        renderList();
        return;
      }
      const item = allItems.find((i) => i && i.id === id);
      if (!item) {
        // Stale/invalid id — fall back to list and clear param
        currentDetailId = null;
        try { history.replaceState({}, "", window.location.pathname); } catch (_) {}
        showListView();
        renderList();
        return;
      }
      currentDetailId = id;
      detailActiveCategory = "All";
      showDetailView();
      renderDetail(item);
    } catch (err) {
      console.warn("[Scout] route failed:", err && err.message);
      showListView();
    }
  }

  async function reloadAndRoute() {
    try {
      allItems = await self.Scout.storage.getItems();
    } catch (_) {
      allItems = [];
    }
    route();
  }

  // ── Category helpers ────────────────────────────────────────────────────

  function categoriesOf(products) {
    const set = new Set();
    (Array.isArray(products) ? products : []).forEach((p) => {
      if (p && typeof p.category === "string" && p.category.trim()) {
        set.add(p.category.trim());
      }
    });
    return Array.from(set).sort();
  }

  function unionCategories(items) {
    const set = new Set();
    (Array.isArray(items) ? items : []).forEach((item) => {
      categoriesOf(item && item.products).forEach((c) => set.add(c));
    });
    return Array.from(set).sort();
  }

  function buildChip(label, isActive, onClick) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (isActive ? " chip--active" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      try { onClick(label); } catch (_) {}
    });
    return chip;
  }

  function renderChipBar(container, categories, activeCategory, onSelect) {
    try {
      container.innerHTML = "";
      const all = buildChip("All", activeCategory === "All", () => onSelect("All"));
      container.appendChild(all);
      categories.forEach((cat) => {
        container.appendChild(buildChip(cat, activeCategory === cat, () => onSelect(cat)));
      });
    } catch (_) {}
  }

  // ── List view ───────────────────────────────────────────────────────────

  function matchesSearch(item, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    try {
      const v = item.video || {};
      if ((v.title || "").toLowerCase().includes(needle)) return true;
      if ((v.channel || "").toLowerCase().includes(needle)) return true;
      const products = Array.isArray(item.products) ? item.products : [];
      for (const p of products) {
        if (!p) continue;
        if ((p.name || "").toLowerCase().includes(needle)) return true;
        if ((p.brand || "").toLowerCase().includes(needle)) return true;
      }
    } catch (_) {}
    return false;
  }

  function matchesCategory(item, cat) {
    if (!cat || cat === "All") return true;
    const products = Array.isArray(item.products) ? item.products : [];
    return products.some((p) => p && p.category === cat);
  }

  function buildGridCard(item) {
    try {
      const v = item.video || {};
      if (!v || typeof v !== "object") throw new Error("item.video missing");

      const card = document.createElement("a");
      card.className = "grid-card";
      card.href = "?id=" + encodeURIComponent(item.id);
      card.addEventListener("click", (e) => {
        e.preventDefault();
        try {
          history.pushState({}, "", "?id=" + encodeURIComponent(item.id));
          route();
        } catch (_) {}
      });

      const thumb = document.createElement("img");
      thumb.className = "grid-card__thumb";
      thumb.src = v.thumbnailUrl || "";
      thumb.alt = "";
      thumb.referrerPolicy = "no-referrer";
      card.appendChild(thumb);

      const body = document.createElement("div");
      body.className = "grid-card__body";

      const title = document.createElement("div");
      title.className = "grid-card__title";
      title.textContent = v.title || "(untitled)";
      body.appendChild(title);

      const channel = document.createElement("div");
      channel.className = "grid-card__channel";
      channel.textContent = v.channel || "";
      body.appendChild(channel);

      const footer = document.createElement("div");
      footer.className = "grid-card__footer";

      const products = Array.isArray(item.products) ? item.products : [];
      const count = document.createElement("span");
      count.className = "grid-card__count";
      count.textContent =
        products.length === 0
          ? "No products"
          : products.length === 1
          ? "1 product"
          : products.length + " products";
      footer.appendChild(count);

      const cats = categoriesOf(products);
      cats.slice(0, 3).forEach((c) => {
        const tag = document.createElement("span");
        tag.className = "grid-card__tag";
        tag.textContent = c;
        footer.appendChild(tag);
      });

      body.appendChild(footer);
      card.appendChild(body);
      return card;
    } catch (err) {
      console.warn("[Scout] buildGridCard failed:", item && item.id, err && err.message);
      const fallback = document.createElement("div");
      fallback.className = "grid-card";
      fallback.style.opacity = "0.6";
      const body = document.createElement("div");
      body.className = "grid-card__body";
      const title = document.createElement("div");
      title.className = "grid-card__title";
      title.textContent = "Couldn\u2019t render this video";
      body.appendChild(title);
      fallback.appendChild(body);
      return fallback;
    }
  }

  function renderGrid(items) {
    const grid = $("grid");
    const empty = $("empty-state");
    if (!grid) return;

    try { grid.innerHTML = ""; } catch (_) {}

    if (!Array.isArray(allItems) || allItems.length === 0) {
      if (empty) empty.hidden = false;
      grid.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    grid.hidden = false;

    const filtered = (Array.isArray(items) ? items : []).filter(
      (item) => matchesSearch(item, listSearchText) && matchesCategory(item, listActiveCategory)
    );

    filtered.forEach((item) => {
      try {
        grid.appendChild(buildGridCard(item));
      } catch (_) {}
    });

    if (filtered.length === 0) {
      const note = document.createElement("div");
      note.className = "grid-card";
      note.style.opacity = "0.6";
      const body = document.createElement("div");
      body.className = "grid-card__body";
      const title = document.createElement("div");
      title.className = "grid-card__title";
      title.textContent = "No matches";
      const channel = document.createElement("div");
      channel.className = "grid-card__channel";
      channel.textContent = "Try a different search or category.";
      body.appendChild(title);
      body.appendChild(channel);
      note.appendChild(body);
      grid.appendChild(note);
    }
  }

  function renderFilterBar() {
    const bar = $("filter-bar");
    if (!bar) return;
    const cats = unionCategories(allItems);
    renderChipBar(bar, cats, listActiveCategory, (c) => {
      listActiveCategory = c;
      renderFilterBar();
      renderGrid(allItems);
    });
  }

  function renderList() {
    try {
      const search = $("search-input");
      if (search && document.activeElement !== search) {
        search.value = listSearchText;
      }
      renderFilterBar();
      renderGrid(allItems);
    } catch (_) {}
  }

  // ── Export (from popup.js) ──────────────────────────────────────────────

  function exportJson() {
    try {
      const items = allItems;
      const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `scout-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (_) {}
  }

  function exportCsv() {
    try {
      const items = allItems;
      const rows = [[
        "video_title", "channel", "product_name", "brand", "category",
        "search_query", "confidence", "buy_link", "video_url",
      ]];
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
      const csv = rows.map((r) => r.join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `scout-export-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (_) {}
  }

  // ── Detail view ─────────────────────────────────────────────────────────

  function buildProductRow(product) {
    const row = document.createElement("div");
    row.className = "product-row";

    const name = document.createElement("span");
    name.className = "product-row__name";
    name.textContent = product.name || "(unnamed)";
    row.appendChild(name);

    if (product.brand) {
      const brand = document.createElement("span");
      brand.className = "product-row__brand";
      brand.textContent = product.brand;
      row.appendChild(brand);
    }

    if (product.category) {
      const cat = document.createElement("span");
      cat.className = "product-row__category chip";
      cat.textContent = product.category;
      row.appendChild(cat);
    }

    const buy = document.createElement("a");
    buy.className = "product-row__buy";
    buy.href = formatSearchUrl(product.searchQuery || product.name || "");
    buy.target = "_blank";
    buy.rel = "noopener noreferrer";
    buy.textContent = "Buy \u2197";
    row.appendChild(buy);

    return row;
  }

  function renderProductsList(item) {
    const list = $("products-list");
    const countEl = $("products-count");
    if (!list) return;
    try { list.innerHTML = ""; } catch (_) {}

    const products = Array.isArray(item.products) ? item.products : [];

    if (countEl) {
      countEl.textContent =
        products.length === 0
          ? "No products"
          : products.length === 1
          ? "1 product"
          : products.length + " products";
    }

    const filtered = products.filter((p) => {
      if (!p) return false;
      if (detailActiveCategory === "All") return true;
      return p.category === detailActiveCategory;
    });

    filtered.forEach((p) => {
      try { list.appendChild(buildProductRow(p)); } catch (_) {}
    });

    if (filtered.length === 0 && products.length > 0) {
      const note = document.createElement("div");
      note.className = "product-row";
      note.style.opacity = "0.6";
      const name = document.createElement("span");
      name.className = "product-row__name";
      name.textContent = "No products in this category.";
      note.appendChild(name);
      list.appendChild(note);
    }
  }

  function renderDetailFilterBar(item) {
    const bar = $("detail-filter-bar");
    if (!bar) return;
    const cats = categoriesOf(item.products);
    renderChipBar(bar, cats, detailActiveCategory, (c) => {
      detailActiveCategory = c;
      renderDetailFilterBar(item);
      renderProductsList(item);
    });
  }

  let _notesStatusTimer = null;
  const saveNoteDebounced = debounce(async (id, value) => {
    try {
      if (self.Scout.storage && typeof self.Scout.storage.setNote === "function") {
        await self.Scout.storage.setNote(id, value);
      }
      const status = $("notes-status");
      if (status) {
        status.textContent = "Saved \u2713";
        if (_notesStatusTimer) clearTimeout(_notesStatusTimer);
        _notesStatusTimer = setTimeout(() => {
          try { status.textContent = ""; } catch (_) {}
        }, 1500);
      }
    } catch (err) {
      const status = $("notes-status");
      if (status) {
        status.textContent = "Save failed";
        if (_notesStatusTimer) clearTimeout(_notesStatusTimer);
        _notesStatusTimer = setTimeout(() => {
          try { status.textContent = ""; } catch (_) {}
        }, 2500);
      }
    }
  }, 400);

  async function renderDetail(item) {
    try {
      const v = item.video || {};
      const titleEl = $("video-title");
      const channelEl = $("video-channel");
      const iframe = $("video-iframe");
      const watchLink = $("watch-on-youtube");

      if (titleEl) titleEl.textContent = v.title || "(untitled)";
      if (channelEl) channelEl.textContent = v.channel || "";
      if (iframe) {
        if (v.videoId) {
          // youtube-nocookie embeds accept chrome-extension:// origin;
          // the standard youtube.com/embed does not (Error 153).
          iframe.src =
            "https://www.youtube-nocookie.com/embed/" +
            encodeURIComponent(v.videoId);
        } else {
          iframe.removeAttribute("src");
        }
      }
      if (watchLink) {
        watchLink.href = v.url || "#";
        watchLink.target = "_blank";
        watchLink.rel = "noopener noreferrer";
      }

      // Notes
      const notesInput = $("notes-input");
      if (notesInput) {
        let notes = {};
        try {
          if (self.Scout.storage && typeof self.Scout.storage.getNotes === "function") {
            notes = await self.Scout.storage.getNotes();
          }
        } catch (_) { notes = {}; }
        notesInput.value = (notes && notes[item.id]) || "";
        notesInput.oninput = () => {
          saveNoteDebounced(item.id, notesInput.value);
        };
      }

      renderDetailFilterBar(item);
      renderProductsList(item);
    } catch (err) {
      console.warn("[Scout] renderDetail failed:", err && err.message);
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────

  function wireListControls() {
    const search = $("search-input");
    if (search) {
      const onInput = debounce(() => {
        listSearchText = search.value || "";
        renderGrid(allItems);
      }, 150);
      search.addEventListener("input", onInput);
    }

    const clearBtn = $("clear-all-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        try {
          if (!confirm("Clear all saved videos? This cannot be undone.")) return;
          await self.Scout.storage.clearItems();
        } catch (_) {}
      });
    }

    const exportJsonBtn = $("export-json-btn");
    if (exportJsonBtn) exportJsonBtn.addEventListener("click", exportJson);

    const exportCsvBtn = $("export-csv-btn");
    if (exportCsvBtn) exportCsvBtn.addEventListener("click", exportCsv);
  }

  function wireDetailControls() {
    const back = $("back-link");
    if (back) {
      back.addEventListener("click", (e) => {
        e.preventDefault();
        try {
          history.pushState({}, "", window.location.pathname);
          route();
        } catch (_) {}
      });
    }
  }

  // ── Storage listener ────────────────────────────────────────────────────

  function wireStorageListener() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        try {
          if (area !== "local") return;
          if (changes["scout.items"]) {
            reloadAndRoute();
            return;
          }
          if (changes["scout.notes"] && currentDetailId) {
            const notesInput = $("notes-input");
            if (!notesInput) return;
            if (document.activeElement === notesInput) return;
            const newVal = changes["scout.notes"].newValue;
            if (newVal && typeof newVal === "object") {
              notesInput.value = newVal[currentDetailId] || "";
            }
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  // ── Init ────────────────────────────────────────────────────────────────

  wireListControls();
  wireDetailControls();
  wireStorageListener();

  window.addEventListener("popstate", () => {
    try { route(); } catch (_) {}
  });

  try {
    allItems = await self.Scout.storage.getItems();
  } catch (_) {
    allItems = [];
  }
  route();
})();
