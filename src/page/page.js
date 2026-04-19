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
  let notesMap = {};
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
    try {
      notesMap = (self.Scout.storage && typeof self.Scout.storage.getNotes === "function")
        ? await self.Scout.storage.getNotes()
        : {};
    } catch (_) {
      notesMap = {};
    }
    route();
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

      // Notes preview (first ~18 words) — collapses if no note present.
      const noteText = notesMap[item.id];
      if (typeof noteText === "string" && noteText.trim()) {
        const note = document.createElement("div");
        note.className = "grid-card__note";
        const words = noteText.trim().split(/\s+/);
        const snippet = words.slice(0, 18).join(" ");
        note.textContent = words.length > 18 ? snippet + "…" : snippet;
        body.appendChild(note);
      }

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
    if (bar) { bar.innerHTML = ""; bar.hidden = true; }
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

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    try {
      const blob = new Blob([JSON.stringify(allItems, null, 2)], { type: "application/json" });
      triggerDownload(blob, `scout-export-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (err) {
      console.warn("[Scout] JSON export failed:", err && err.message);
    }
  }

  function csvCell(v) {
    return `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    try {
      const header = [
        "video_title", "channel", "product_name", "brand", "category",
        "search_query", "confidence", "buy_link", "video_url",
      ].map(csvCell);
      const rows = [header];

      (Array.isArray(allItems) ? allItems : []).forEach((item) => {
        const v = (item && item.video) || {};
        const products = Array.isArray(item && item.products) ? item.products : [];
        products.forEach((p) => {
          rows.push([
            v.title, v.channel,
            p.name, p.brand, p.category,
            p.searchQuery, p.confidence,
            formatSearchUrl(p.searchQuery || p.name || ""),
            v.url,
          ].map(csvCell));
        });
      });

      if (rows.length === 1) {
        console.warn("[Scout] CSV export: no products to export");
      }

      const csv = "\uFEFF" + rows.map((r) => r.join(",")).join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      triggerDownload(blob, `scout-export-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      console.warn("[Scout] CSV export failed:", err && err.message);
    }
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

  function renderDetailFilterBar(_item) {
    const bar = $("detail-filter-bar");
    if (bar) { bar.innerHTML = ""; bar.hidden = true; }
  }

  let _notesStatusTimer = null;
  const saveNoteDebounced = debounce(async (id, value) => {
    try {
      if (self.Scout.storage && typeof self.Scout.storage.setNote === "function") {
        await self.Scout.storage.setNote(id, value);
      }
      if (typeof value === "string" && value.length > 0) {
        notesMap[id] = value;
      } else {
        delete notesMap[id];
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
      const channelLink = $("video-channel-link");
      const preview = $("video-preview");
      const thumb = $("video-thumb");

      if (titleEl) titleEl.textContent = v.title || "(untitled)";
      if (channelLink) {
        if (v.channel) {
          channelLink.textContent = `${v.channel} ↗`;
          channelLink.href = v.channelUrl ||
            (v.videoId ? `https://www.youtube.com/watch?v=${v.videoId}` : "#");
          channelLink.hidden = false;
        } else {
          channelLink.hidden = true;
        }
      }
      if (preview) {
        preview.href = v.url || (v.videoId ? `https://www.youtube.com/watch?v=${v.videoId}` : "#");
      }
      if (thumb) {
        if (v.videoId) {
          const hi = `https://i.ytimg.com/vi/${v.videoId}/maxresdefault.jpg`;
          const lo = v.thumbnailUrl || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;
          thumb.onerror = () => {
            thumb.onerror = null;
            thumb.src = lo;
          };
          thumb.src = hi;
        } else {
          thumb.removeAttribute("src");
        }
      }

      renderDescription(v);
      renderComments(v);

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
      renderMetadata(item);
    } catch (err) {
      console.warn("[Scout] renderDetail failed:", err && err.message);
    }
  }

  // ── Description + comments (always visible) ────────────────────────────

  const DESC_COLLAPSED_CHARS = 420;

  function renderDescription(v) {
    const block = $("video-description-block");
    const body = $("video-description");
    const toggle = $("video-description-toggle");
    if (!block || !body || !toggle) return;

    const text = typeof v.description === "string" ? v.description.trim() : "";
    if (!text) {
      block.hidden = true;
      return;
    }
    block.hidden = false;

    const longer = text.length > DESC_COLLAPSED_CHARS;
    body.dataset.expanded = "0";
    body.textContent = longer ? text.slice(0, DESC_COLLAPSED_CHARS) + "…" : text;

    if (longer) {
      toggle.hidden = false;
      toggle.textContent = "Show more";
      toggle.onclick = () => {
        const expanded = body.dataset.expanded === "1";
        if (expanded) {
          body.textContent = text.slice(0, DESC_COLLAPSED_CHARS) + "…";
          body.dataset.expanded = "0";
          toggle.textContent = "Show more";
        } else {
          body.textContent = text;
          body.dataset.expanded = "1";
          toggle.textContent = "Show less";
        }
      };
    } else {
      toggle.hidden = true;
      toggle.onclick = null;
    }
  }

  function renderComments(v) {
    const block = $("video-comments-block");
    const list = $("video-comments");
    const countEl = $("video-comments-count");
    if (!block || !list) return;

    const comments = Array.isArray(v.topComments) ? v.topComments.filter(Boolean) : [];
    if (comments.length === 0) {
      block.hidden = true;
      list.innerHTML = "";
      if (countEl) countEl.textContent = "";
      return;
    }

    block.hidden = false;
    if (countEl) countEl.textContent = `(${comments.length})`;
    list.innerHTML = "";
    for (const c of comments) {
      const li = document.createElement("li");
      li.textContent = c;
      list.appendChild(li);
    }
  }

  // ── Metadata panel ──────────────────────────────────────────────────────

  function buildDisclosure(summary, bodyEl) {
    const d = document.createElement("details");
    d.className = "metadata-disclosure";
    const s = document.createElement("summary");
    s.textContent = summary;
    d.appendChild(s);
    d.appendChild(bodyEl);
    return d;
  }

  function renderMetadata(item) {
    const root = $("video-metadata");
    if (!root) return;
    root.innerHTML = "";

    const v = (item && item.video) || {};
    const sections = [];

    // Captured frame — at save time, for context
    if (typeof v.currentFrameDataUrl === "string" && v.currentFrameDataUrl.startsWith("data:")) {
      const img = document.createElement("img");
      img.className = "metadata-frame";
      img.alt = "Captured frame at save time";
      img.src = v.currentFrameDataUrl;
      sections.push({ title: "Captured frame", node: img });
    }

    // Video facts
    const factsRows = [
      ["Video ID", v.videoId],
      ["Channel URL", v.channelUrl],
      ["Watch URL", v.url],
      ["Saved at", v.savedAt ? new Date(v.savedAt).toLocaleString() : null],
      ["Extracted with", item && item.extractedWith],
      ["Status", item && item.status],
    ].filter(([, val]) => val !== null && val !== undefined && val !== "");
    if (factsRows.length) {
      const body = document.createElement("dl");
      body.className = "metadata-body metadata-facts";
      for (const [k, val] of factsRows) {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        if (typeof val === "string" && /^https?:\/\//.test(val)) {
          const a = document.createElement("a");
          a.href = val; a.target = "_blank"; a.rel = "noopener noreferrer";
          a.textContent = val;
          dd.appendChild(a);
        } else {
          dd.textContent = String(val);
        }
        body.appendChild(dt);
        body.appendChild(dd);
      }
      sections.push({ title: "Video facts", node: body });
    }

    // Raw JSON — catch-all for anything else collected
    const pre = document.createElement("pre");
    pre.className = "metadata-body metadata-json";
    try { pre.textContent = JSON.stringify(item, null, 2); }
    catch (_) { pre.textContent = "(unable to serialize)"; }
    sections.push({ title: "Raw data", node: pre });

    if (sections.length === 0) return;

    const header = document.createElement("div");
    header.className = "metadata-header";
    header.textContent = "Details";
    root.appendChild(header);

    for (const { title, node } of sections) {
      root.appendChild(buildDisclosure(title, node));
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
