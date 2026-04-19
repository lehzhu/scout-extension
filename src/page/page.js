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

  // Trailing punctuation we should strip from a matched URL (so a URL at end
  // of a sentence doesn't swallow the period or closing paren).
  const URL_TRAIL_RE = /[).,;:!?'"\]]+$/;
  const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+/g;

  /**
   * Appends alternating text nodes and <a> elements into `el` for any URLs
   * found in `text`. Preserves newlines via text nodes (the container is
   * expected to have `white-space: pre-wrap`).
   */
  function linkifyInto(el, text) {
    if (!el) return;
    try { el.textContent = ""; } catch (_) {}
    if (typeof text !== "string" || text.length === 0) return;

    URL_RE.lastIndex = 0;
    let lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(text)) !== null) {
      let url = m[0];
      let matchStart = m.index;
      let matchEnd = matchStart + url.length;
      // Strip trailing punctuation and adjust so it stays as plain text.
      const trail = url.match(URL_TRAIL_RE);
      if (trail) {
        url = url.slice(0, url.length - trail[0].length);
        matchEnd = matchStart + url.length;
        URL_RE.lastIndex = matchEnd;
      }
      if (matchStart > lastIndex) {
        el.appendChild(document.createTextNode(text.slice(lastIndex, matchStart)));
      }
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = url;
      el.appendChild(a);
      lastIndex = matchEnd;
    }
    if (lastIndex < text.length) {
      el.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

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

  function getRouteView() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("view");
    } catch (_) {
      return null;
    }
  }

  function showListView() {
    try {
      const list = $("list-view");
      const detail = $("detail-view");
      const favs = $("favourites-view");
      if (list) list.hidden = false;
      if (detail) detail.hidden = true;
      if (favs) favs.hidden = true;
    } catch (_) {}
  }

  function showDetailView() {
    try {
      const list = $("list-view");
      const detail = $("detail-view");
      const favs = $("favourites-view");
      if (list) list.hidden = true;
      if (detail) detail.hidden = false;
      if (favs) favs.hidden = true;
    } catch (_) {}
  }

  function showFavouritesView() {
    try {
      const list = $("list-view");
      const detail = $("detail-view");
      const favs = $("favourites-view");
      if (list) list.hidden = true;
      if (detail) detail.hidden = true;
      if (favs) favs.hidden = false;
    } catch (_) {}
  }

  function route() {
    try {
      const view = getRouteView();
      if (view === "favourites") {
        currentDetailId = null;
        showFavouritesView();
        renderFavourites();
        return;
      }
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

  const HEART_OUTLINE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
  const HEART_FILLED_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="#F0336C" stroke="#F0336C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';

  function updateFavButtonUI(btn, on) {
    if (!btn) return;
    try {
      btn.innerHTML = on ? HEART_FILLED_SVG : HEART_OUTLINE_SVG;
      btn.classList.toggle("product-row__fav--on", !!on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.title = on ? "Remove from favourites" : "Add to favourites";
    } catch (_) {}
  }

  function buildProductRow(product, opts) {
    const itemId = opts && opts.itemId;
    const index = opts && typeof opts.index === "number" ? opts.index : -1;
    const videoMeta = (opts && opts.videoMeta) || null;

    const row = document.createElement("div");
    row.className = "product-row";

    // Heart / favourite toggle
    const fav = document.createElement("button");
    fav.type = "button";
    fav.className = "product-row__fav";
    updateFavButtonUI(fav, false);
    row.appendChild(fav);

    if (itemId && index >= 0) {
      // Seed initial state from storage without blocking row render.
      (async () => {
        try {
          const on = await self.Scout.storage.isFavourited(itemId, index);
          updateFavButtonUI(fav, on);
        } catch (_) {}
      })();

      fav.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          const currentlyOn = fav.classList.contains("product-row__fav--on");
          const next = !currentlyOn;
          // Optimistic UI flip — no full re-render.
          updateFavButtonUI(fav, next);
          await self.Scout.storage.setFavourited(itemId, index, videoMeta, product, next);
        } catch (err) {
          console.warn("[Scout] favourite toggle failed:", err && err.message);
          // Revert on failure.
          try {
            const on = await self.Scout.storage.isFavourited(itemId, index);
            updateFavButtonUI(fav, on);
          } catch (_) {}
        }
      });
    } else {
      fav.disabled = true;
      fav.style.visibility = "hidden";
    }

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

    const videoMeta = item && item.video ? item.video : null;

    // Preserve original product index (used as favourite key) when filtering.
    const indexed = products.map((p, i) => ({ p, i }));
    const filtered = indexed.filter(({ p }) => {
      if (!p) return false;
      if (detailActiveCategory === "All") return true;
      return p.category === detailActiveCategory;
    });

    filtered.forEach(({ p, i }) => {
      try {
        list.appendChild(buildProductRow(p, { itemId: item.id, index: i, videoMeta }));
      } catch (_) {}
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

      // Re-fetch description fresh from YouTube keyed on the canonical videoId.
      // This heals saves from before the SPA-navigation fix that baked in the
      // previous video's description. Non-blocking — updates in place.
      refreshDescriptionIfStale(item);

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
      updateDetailNavState();
    } catch (err) {
      console.warn("[Scout] renderDetail failed:", err && err.message);
    }
  }

  // ── Description + comments (always visible) ────────────────────────────

  const DESC_COLLAPSED_CHARS = 420;

  // In-memory de-dupe so Next/Prev nav doesn't re-fetch the same video
  // every time the user flips through.
  const _descRefreshedIds = new Set();

  async function refreshDescriptionIfStale(item) {
    try {
      if (!item || !item.id || _descRefreshedIds.has(item.id)) return;
      _descRefreshedIds.add(item.id);
      const msging = self.Scout && self.Scout.messaging;
      if (!msging) return;
      const resp = await msging.sendMessage(msging.MSG.REFRESH_DESCRIPTION, { id: item.id });
      if (!resp || !resp.ok) return;
      // Only update the DOM if the user is still viewing the same item.
      if (currentDetailId !== item.id) return;
      if (typeof resp.description !== "string" || !resp.description.trim()) return;
      if (resp.description === (item.video && item.video.description)) return;
      // Refresh in place
      const patched = { ...item.video, description: resp.description };
      renderDescription(patched);
      // Keep local cache in sync so Prev/Next don't show stale data
      const idx = allItems.findIndex((i) => i && i.id === item.id);
      if (idx !== -1) {
        allItems[idx] = { ...allItems[idx], video: patched };
      }
    } catch (_) { /* non-fatal */ }
  }

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
    linkifyInto(body, longer ? text.slice(0, DESC_COLLAPSED_CHARS) + "…" : text);

    if (longer) {
      toggle.hidden = false;
      toggle.textContent = "Show more";
      toggle.onclick = () => {
        const expanded = body.dataset.expanded === "1";
        if (expanded) {
          linkifyInto(body, text.slice(0, DESC_COLLAPSED_CHARS) + "…");
          body.dataset.expanded = "0";
          toggle.textContent = "Show more";
        } else {
          linkifyInto(body, text);
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

  // ── Favourites view ─────────────────────────────────────────────────────

  async function renderFavourites() {
    const root = $("favourites-groups");
    const empty = $("favourites-empty");
    if (!root) return;
    try { root.innerHTML = ""; } catch (_) {}

    let favs = {};
    try { favs = await self.Scout.storage.getFavourites(); }
    catch (_) { favs = {}; }

    const values = Object.keys(favs).map((k) => favs[k]).filter(Boolean);

    if (values.length === 0) {
      if (empty) empty.hidden = false;
      root.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    root.hidden = false;

    // Group by videoId (fallback to itemId if videoId missing).
    const groups = new Map();
    for (const f of values) {
      const key = f.videoId || f.itemId || "unknown";
      if (!groups.has(key)) groups.set(key, { sample: f, rows: [] });
      groups.get(key).rows.push(f);
    }

    // Sort rows inside each group by favedAt (newest first), and groups by
    // most-recent favedAt.
    const sortedGroups = [];
    for (const [, g] of groups) {
      g.rows.sort((a, b) => (b.favedAt || 0) - (a.favedAt || 0));
      sortedGroups.push(g);
    }
    sortedGroups.sort((a, b) => (b.rows[0].favedAt || 0) - (a.rows[0].favedAt || 0));

    for (const g of sortedGroups) {
      root.appendChild(buildFavouritesGroup(g));
    }
  }

  function buildFavouritesGroup(group) {
    const s = group.sample;
    const wrap = document.createElement("div");
    wrap.className = "favourites-group";

    const head = document.createElement("div");
    head.className = "favourites-group__head";

    if (s.thumbnailUrl) {
      const thumb = document.createElement("img");
      thumb.className = "favourites-group__thumb";
      thumb.src = s.thumbnailUrl;
      thumb.alt = "";
      thumb.referrerPolicy = "no-referrer";
      head.appendChild(thumb);
    }

    const meta = document.createElement("div");
    meta.className = "favourites-group__meta";

    const title = document.createElement("a");
    title.className = "favourites-group__title";
    title.textContent = s.videoTitle || "(untitled)";
    title.href = s.itemId ? "?id=" + encodeURIComponent(s.itemId) : "#";
    title.addEventListener("click", (e) => {
      if (!s.itemId) return;
      e.preventDefault();
      try {
        history.pushState({}, "", "?id=" + encodeURIComponent(s.itemId));
        route();
      } catch (_) {}
    });
    meta.appendChild(title);

    if (s.channel) {
      const channel = document.createElement("div");
      channel.className = "favourites-group__channel";
      channel.textContent = s.channel;
      meta.appendChild(channel);
    }

    head.appendChild(meta);
    wrap.appendChild(head);

    const rows = document.createElement("div");
    rows.className = "favourites-group__rows";
    for (const fav of group.rows) {
      rows.appendChild(buildFavouriteRow(fav));
    }
    wrap.appendChild(rows);

    return wrap;
  }

  function buildFavouriteRow(fav) {
    const row = document.createElement("div");
    row.className = "product-row";

    // Un-favourite button (re-uses heart styling, filled state)
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "product-row__fav product-row__fav--on";
    btn.title = "Un-favourite";
    btn.innerHTML = HEART_FILLED_SVG;
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await self.Scout.storage.setFavourited(fav.itemId, fav.productIndex, null, null, false);
        row.remove();
        // If the parent group is now empty, refresh to hide it.
        const parentGroup = row.closest(".favourites-group");
        if (parentGroup && !parentGroup.querySelector(".product-row")) {
          renderFavourites();
        }
      } catch (err) {
        console.warn("[Scout] un-favourite failed:", err && err.message);
      }
    });
    row.appendChild(btn);

    const p = fav.product || {};
    const name = document.createElement("span");
    name.className = "product-row__name";
    name.textContent = p.name || "(unnamed)";
    row.appendChild(name);

    if (p.brand) {
      const brand = document.createElement("span");
      brand.className = "product-row__brand";
      brand.textContent = p.brand;
      row.appendChild(brand);
    }

    const buy = document.createElement("a");
    buy.className = "product-row__buy";
    buy.href = formatSearchUrl(p.searchQuery || p.name || "");
    buy.target = "_blank";
    buy.rel = "noopener noreferrer";
    buy.textContent = "Buy \u2197";
    row.appendChild(buy);

    return row;
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

    const openFavs = $("open-favourites-btn");
    if (openFavs) {
      openFavs.addEventListener("click", (e) => {
        e.preventDefault();
        try {
          history.pushState({}, "", "?view=favourites");
          route();
        } catch (_) {}
      });
    }
  }

  function goToAllSaves(e) {
    if (e) e.preventDefault();
    try {
      history.pushState({}, "", window.location.pathname);
      route();
    } catch (_) {}
  }

  function navigateToDetailByOffset(offset) {
    try {
      if (!Array.isArray(allItems) || allItems.length === 0) return;
      if (!currentDetailId) return;
      const idx = allItems.findIndex((i) => i && i.id === currentDetailId);
      if (idx === -1) return;
      const n = allItems.length;
      const nextIdx = ((idx + offset) % n + n) % n;
      const nextItem = allItems[nextIdx];
      if (!nextItem || !nextItem.id) return;
      history.pushState({}, "", "?id=" + encodeURIComponent(nextItem.id));
      route();
    } catch (err) {
      console.warn("[Scout] navigateToDetailByOffset failed:", err && err.message);
    }
  }

  function wireDetailControls() {
    const back = $("back-link");
    if (back) back.addEventListener("click", goToAllSaves);

    const nextBtn = $("next-video-btn");
    if (nextBtn) {
      nextBtn.addEventListener("click", (e) => {
        e.preventDefault();
        navigateToDetailByOffset(1);
      });
    }

    const prevBtn = $("prev-video-btn");
    if (prevBtn) {
      prevBtn.addEventListener("click", (e) => {
        e.preventDefault();
        navigateToDetailByOffset(-1);
      });
    }

    const favBack = $("fav-back-link");
    if (favBack) favBack.addEventListener("click", goToAllSaves);
  }

  function updateDetailNavState() {
    try {
      const nextBtn = $("next-video-btn");
      const prevBtn = $("prev-video-btn");
      const single = !Array.isArray(allItems) || allItems.length <= 1;
      if (nextBtn) nextBtn.disabled = single;
      if (prevBtn) prevBtn.disabled = single;
    } catch (_) {}
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
          if (changes["scout.favourites"]) {
            // Only re-render the favourites view if that's what the user is
            // looking at. Heart buttons in the detail view are updated
            // optimistically and don't need a re-render.
            try {
              if (getRouteView() === "favourites") renderFavourites();
            } catch (_) {}
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
