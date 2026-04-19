// Scout parser module — attaches to self.Scout.parser
self.Scout = self.Scout || {};

self.Scout.parser = (() => {
  const MAX_TRANSCRIPT_CHARS = 30000;

  const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

  const DEFAULT_MODELS = {
    gemini: "gemini-2.5-flash",
  };

  const VALID_CATEGORIES = new Set([
    "top", "bottom", "dress", "outerwear", "shoes",
    "bag", "accessory", "beauty", "other",
  ]);

  // ─── fetchTranscript ───────────────────────────────────────────────────────

  function extractPlayerResponse(html) {
    const m = html.match(
      /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script>)/
    );
    if (m) {
      try { return JSON.parse(m[1]); } catch (_) {}
    }
    const idx = html.indexOf("ytInitialPlayerResponse = ");
    if (idx === -1) return null;
    let start = html.indexOf("{", idx);
    if (start === -1) return null;
    let depth = 0, i = start;
    for (; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}") { depth--; if (depth === 0) break; }
    }
    try { return JSON.parse(html.slice(start, i + 1)); } catch (_) { return null; }
  }

  function pickBestTrack(tracks) {
    const manualEn = tracks.find((t) => t.languageCode === "en" && t.kind !== "asr");
    if (manualEn) return manualEn;
    const autoEn = tracks.find((t) => t.languageCode === "en");
    if (autoEn) return autoEn;
    return tracks[0] || null;
  }

  /**
   * @param {string} videoId
   * @returns {Promise<{text: string, cues: Array<{start: number, text: string}>} | null>}
   */
  async function fetchTranscript(videoId) {
    const watchRes = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      { credentials: "omit" }
    );
    if (!watchRes.ok) return null;

    let html;
    try { html = await watchRes.text(); } catch (_) { return null; }

    let playerResponse;
    try { playerResponse = extractPlayerResponse(html); } catch (_) { return null; }
    if (!playerResponse) return null;

    let tracks;
    try {
      tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    } catch (_) { return null; }
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) return null;

    const track = pickBestTrack(tracks);
    if (!track?.baseUrl) return null;

    let captionRes;
    try {
      captionRes = await fetch(`${track.baseUrl}&fmt=json3`, { credentials: "omit" });
    } catch (networkErr) {
      throw networkErr;
    }
    if (!captionRes.ok) return null;

    let data;
    try { data = await captionRes.json(); } catch (_) { return null; }

    const cues = [];
    const parts = [];
    try {
      for (const event of data.events || []) {
        if (!event.segs) continue;
        const cueText = event.segs.map((s) => s.utf8 || "").join("").trim();
        if (!cueText) continue;
        cues.push({ start: (event.tStartMs || 0) / 1000, text: cueText });
        parts.push(cueText);
      }
    } catch (_) { return null; }

    let text = parts.join(" ");
    if (text.length > MAX_TRANSCRIPT_CHARS) {
      text = text.slice(0, MAX_TRANSCRIPT_CHARS) + "… [truncated]";
    }
    return { text, cues };
  }

  // ─── Heuristic fallback ────────────────────────────────────────────────────

  const CATEGORY_PATTERNS = [
    [/dress|gown|jumpsuit|romper/i,                                                    "dress"],
    [/jean|denim|pant|trouser|legging|short|jogger|skirt/i,                           "bottom"],
    [/shoe|boot|sneaker|heel|loafer|sandal|mule|flat|pump|clog/i,                     "shoes"],
    [/bag|purse|tote|clutch|backpack|crossbody|shoulder bag|satchel/i,                "bag"],
    [/jacket|coat|blazer|cardigan|hoodie|sweatshirt|vest|puffer|anorak/i,             "outerwear"],
    [/necklace|earring|ring|bracelet|watch|hat|beanie|scarf|belt|sunglass|headband/i, "accessory"],
    [/makeup|lipstick|lip\s|foundation|mascara|blush|eyeshadow|skincare|serum|moisturizer|concealer|highlighter|bronzer|toner|primer|spf/i, "beauty"],
    [/top|shirt|blouse|tee|crop|tank|bodysuit|corset|bralette|sweater|knitwear/i,     "top"],
  ];

  function guessCategory(name) {
    for (const [rx, cat] of CATEGORY_PATTERNS) {
      if (rx.test(name)) return cat;
    }
    return "other";
  }

  const SECTION_RX   = /^[\s\W]*(products?|links?|shop|items?|what i.?m wearing|wearing|outfit details?|clothes|haul|picks|mentioned|tagged|today.?s look|get the look|style notes?)[\s:!]*$/i;
  const STOP_RX      = /^[\s\W]*(follow|subscribe|social|ig|instagram|twitter|tiktok|music|song|camera|filmed|edited|disclaimer|copyright|sponsor|gifted|collab|timestamps?|chapters?)[\s:!]*/i;
  const EMOJI_BULLET = /^[\s]*[▸►•✨🔗👗👠👜💕🛍️🛒✦*\-]+\s+/;
  const TIMESTAMP_RX = /^(\d{1,2}:\d{2})\s+/;
  const URL_RX       = /https?:\/\/\S+/g;
  const SEPARATORS   = /\s*[\|:–—\/]\s*/;

  // Stop-words that mean "this isn't a product mention" when they dominate a line
  const PROMO_RX = /\b(link|links|pics|pictures|blog|newsletter|discount|code|giveaway|subscribe|channel|thanks for watching|comment below)\b/i;

  /**
   * Pull a product-like noun phrase out of free-form text (e.g. a viewer comment)
   * by finding a CATEGORY_PATTERN match and keeping up to 2 adjective words before it.
   * Returns an array of candidate phrases.
   */
  function extractPhrasesFromFreeText(text) {
    if (typeof text !== "string" || !text.trim()) return [];
    // Normalize whitespace, strip URLs, lowercase for matching
    const clean = text.replace(URL_RX, " ").replace(/\s+/g, " ").trim();
    if (!clean) return [];
    const words = clean.split(/\s+/);
    const out = [];

    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[^\w\-']/g, "");
      if (!w) continue;
      // Does this word match any category noun?
      const matchedCat = CATEGORY_PATTERNS.find(([rx]) => rx.test(w));
      if (!matchedCat) continue;
      // Walk back up to 2 prior adjective-ish words (alpha, not stopwords)
      const STOP_MODIFIERS = new Set([
        "the","a","an","my","your","their","this","that","those","these",
        "and","or","but","to","of","in","on","with","for","at","by",
        "is","are","was","were","i","you","we","they",
        // verbs/adverbs that make a phrase into a clause, not a product
        "love","loved","loving","want","wanted","need","needed","see","saw",
        "look","looks","looking","feel","feels","feeling","felt",
        "watch","watched","watching","wear","wore","worn","wearing",
        "still","only","just","really","maybe","literally","actually","basically",
        "check","follow","subscribe","like","visit","join","grab","get","got","find","found","use","used",
      ]);
      const parts = [w];
      let j = i - 1;
      while (j >= 0 && parts.length < 4) {
        const prev = words[j].replace(/[^\w\-']/g, "").toLowerCase();
        if (!prev) { j--; continue; }
        if (!/^[a-z][a-z\-']*$/.test(prev)) break;
        if (STOP_MODIFIERS.has(prev)) break;
        parts.unshift(prev);
        j--;
      }
      // Include the next word if it continues the noun ("leather jacket" → "leather jackets")
      if (i + 1 < words.length) {
        const nxt = words[i + 1].replace(/[^\w\-']/g, "").toLowerCase();
        if (nxt && /^[a-z][a-z\-']*$/.test(nxt) && nxt.length > 2 && !STOP_MODIFIERS.has(nxt)) {
          // Only append if it reads like a compound noun (not a verb-continuation)
          if (CATEGORY_PATTERNS.some(([rx]) => rx.test(nxt))) parts.push(nxt);
        }
      }
      const phrase = parts.join(" ").trim();
      if (phrase.length >= 5 && phrase.length <= 60) out.push(phrase);
    }
    return out;
  }

  function heuristicExtract(videoMeta) {
    const products = [];
    const seen = new Set();

    function pushCandidate(name, { confidence = 0.35, timestamp = null } = {}) {
      if (!name) return;
      const clean = name.replace(/\s+/g, " ").trim();
      if (clean.length < 3 || clean.length > 90) return;
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      products.push({
        name: clean,
        brand: null,
        category: guessCategory(clean),
        searchQuery: clean.toLowerCase(),
        confidence,
        timestamp,
      });
    }

    // ─── Pass 1: description + title (line-oriented) ─────────────────────────
    const descText = [
      videoMeta.description || "",
      videoMeta.title || "",
    ].join("\n");
    const lines = descText.split(/\r?\n/);
    let inSection = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (SECTION_RX.test(line)) { inSection = true; continue; }
      if (STOP_RX.test(line))    { inSection = false; continue; }

      const hasBullet = EMOJI_BULLET.test(line);
      const tsMatch   = TIMESTAMP_RX.exec(line);
      URL_RX.lastIndex = 0;
      const hasUrl    = URL_RX.test(line);

      const stripped = line
        .replace(URL_RX, "")
        .replace(EMOJI_BULLET, "")
        .replace(TIMESTAMP_RX, "")
        .trim();

      let name = stripped.split(SEPARATORS)[0].trim();
      if (!name || name.length < 3 || name.length > 90) continue;
      if (STOP_RX.test(name)) continue;

      const isRelevant =
        inSection ||
        hasBullet ||
        (hasUrl && stripped.length > 0 && stripped.length < 80) ||
        (tsMatch && CATEGORY_PATTERNS.some(([rx]) => rx.test(line)));

      if (!isRelevant) continue;

      pushCandidate(name, {
        confidence: 0.4,
        timestamp: tsMatch ? tsMatch[1] : null,
      });
    }

    // ─── Pass 2: viewer comments — phrase extraction ─────────────────────────
    const comments = Array.isArray(videoMeta.topComments) ? videoMeta.topComments : [];
    for (const comment of comments) {
      if (typeof comment !== "string" || !comment.trim()) continue;
      if (PROMO_RX.test(comment)) continue; // skip creator promo / meta chatter
      const phrases = extractPhrasesFromFreeText(comment);
      for (const p of phrases) pushCandidate(p, { confidence: 0.45 });
    }

    return products.slice(0, 20);
  }

  // ─── Shared prompt helpers ─────────────────────────────────────────────────

  const EXTRACTION_RULES = `You are a shopping-product extraction assistant.

Your job: surface every searchable product a shopper might want from this YouTube video. Treat THREE sources as equally important and mine each one aggressively:

1. DESCRIPTION — creator's own links, shop sections, "outfit details", timestamps with product names. Treat any bullet-like or hyphenated line as a product candidate unless it's clearly a social/credit link.
2. VIDEO FRAMES — when mosaic sheets or still images are attached, read them cell by cell and identify every distinct garment, shoe, bag, accessory, beauty product, or physical item worn/held/demonstrated. Infer generic descriptors ("brown trench coat", "black leather loafers") when brand is unknown — shoppers can still search those. Use visible logos or tags if readable. Items shown only briefly still count.
3. VIEWER COMMENTS — these are often the richest product-identification signal. Viewers name items the creator didn't: "the funnel neck leather jacket", "love the blue maxi dress", "what are those lace trim skirts". EVERY comment that names a garment, shoe, accessory, beauty product, or shoppable item IS A PRODUCT CANDIDATE — even if the creator never mentioned it, even if there's no reply. Pull the item noun phrase out of the comment and treat it as a product. Do NOT dismiss a comment just because it's casual. Do NOT only consider comments the creator answered — extract from ALL of them.

Never emit a raw comment string as a product name. Extract the item (e.g. "lace trim skirts"), not "love the lace trim skirts!!". Never emit self-promotional creator comments ("links in description", "pics in blog", "thanks for watching") as products.

NAME QUALITY — every product must be uniquely searchable on Google Shopping:
- NEVER use placeholder labels as names: "Item 1", "Product 3", "Look 2", "#4", "Piece 5" — these are labels, not descriptions. If the description uses numbered labels, read the ACTUAL descriptor on that line/entry; if no real descriptor exists, SKIP that entry.
- NEVER use a bare category word alone: "dress", "shoes", "bag", "top", "shirt". These return garbage search results. Either add descriptors (color, material, silhouette, brand, pattern) or skip the item.
- Two products must never share the same searchQuery. If you can't differentiate two items with distinct descriptors, only include the more specific one.
- A good name reads like a product page title: "cream ribbed wool turtleneck", "Adidas Sambas white black", "beige leather bucket bag", "Rhode peptide lip treatment salted caramel". A bad name reads like a label: "Top 1", "Shoes", "Item *".

HARD EXCLUSIONS — these are NEVER products, regardless of source:
- Creator self-promotion / social CTAs: "Check Out my 2nd Channel", "Like my Facebook Page", "Subscribe", "Follow me on Instagram", "Link in bio", "Join my Discord", "Visit my shop", "My newsletter", "Patreon". If a line starts with a verb like Check/Follow/Subscribe/Like/Visit/Join or contains "my [channel/page/blog/IG/TikTok/Twitter/shop/newsletter]", it is NOT a product — skip it.
- Transcript sentence fragments: verb clauses like "still watch", "only realized that", "feel like im watching", "love how this looks", "just grabbed", "really want". A product name is a NOUN PHRASE (maybe with adjectives). If the candidate starts with an adverb (still/only/just/really/maybe) or a verb (feel/love/watch/want/check/see/think), it's a fragment — skip it.
- Generic/structural words from descriptions: "Alternatives", "Options", "Details", "Links", "Chapters", "Timestamps", "Sponsors", "Music used".
- Discount codes and promo phrases: "Use code XYZ", "20% off", "Giveaway winner".
- Equipment/gear credits: "Camera I used", "Mic I used", "Editing software" — unless the video is explicitly a gear review.
- Chapter/timestamp links: lines prefixed with → ► ▶ ➤ ➔ » or timestamped section titles like "→ 3 EASY HAIRSTYLES", "→ MORE BEAUTY". These are navigation markers, not products.
- All-caps headers with multiple words: "JOIN THE LOVE", "5 MINS BIG PONYTAIL", "MORE BEAUTY". Real product names use mixed case.
- Music credits: "Artist Name - Song Title". These appear under Music / Song / Credits sections.
- Bare technique/style nouns: "ponytail", "braid", "updo", "hairstyle", "outfit", "look". These are techniques, not shoppable items. Hair *products* (shampoo, hair ties, clips) are fine.
- Truncated or malformed strings: trailing dash ("Wild Cherry -"), unbalanced parens ("ponytail (code"). If you can't produce a clean complete name, skip the item.

Rules:
- Extract every distinct item from any of the three sources. Aim HIGH on recall: a fashion/haul/lookbook video should return 8–30 items, not 1.
- Prefer specific descriptors: color + material + silhouette + item type ("cream ribbed wool turtleneck"). Brand when available or inferable.
- Deduplicate — merge near-duplicate mentions of the same item, even across sources.
- searchQuery: Google-Shopping-ready string, 3–6 lowercase keywords, no punctuation, no numbers-as-labels. Lead with brand if known. Each query must be unique across the response.
- timestamp: "m:ss" ONLY when transcript clearly pins a moment. Use null (not "0:00" or "N/A") if unknown.
- brand: exact brand string when known, otherwise null. Do NOT write "Unknown", "N/A", or "None".
- confidence: 0–1, your certainty it's a real searchable product. Include items ≥ 0.4. Comments naming a specific garment/accessory ≥ 0.5. Drop confidence below 0.4 for any item whose name you can't make genuinely specific.
- An empty array is only correct when the video is genuinely not about shoppable items (e.g. a vlog with no visible products AND no product mentions in any source). Otherwise: return items.
- Respond with ONLY a valid JSON array of product objects. No prose, no markdown.

Product shape: {"name": string, "brand": string|null, "category": "top"|"bottom"|"dress"|"outerwear"|"shoes"|"bag"|"accessory"|"beauty"|"other", "searchQuery": string, "confidence": number, "timestamp": string|null}`;

  function buildUserContent({ title, channel, description, transcriptText, topComments, storyboard }) {
    const comments = Array.isArray(topComments) && topComments.length > 0
      ? topComments.slice(0, 15).map((c, i) => `[${i + 1}] ${c}`).join("\n")
      : "(none)";

    let imagesNote = "";
    if (storyboard && storyboard.sheetCount) {
      const secs = Math.max(1, Math.round((storyboard.intervalMs || 0) / 1000));
      imagesNote = `\nAttached images: ${storyboard.sheetCount} timeline mosaic sheet(s), each a ${storyboard.cols}×${storyboard.rows} grid of small frames sampled ~every ${secs}s across the full video. Read the grid cells left-to-right, top-to-bottom as the video progresses. Total ~${storyboard.totalFramesApprox} frames covering the whole timeline — use them to identify every distinct garment, shoe, accessory, or product that appears, including items shown only briefly.`;
    }

    return `Video title: ${title}
Channel: ${channel}

=== DESCRIPTION (creator's own product list + links) ===
${description || "(none)"}

=== TRANSCRIPT ===
${transcriptText || "(no transcript available)"}

=== VIEWER COMMENTS (${Array.isArray(topComments) ? topComments.length : 0} captured — MINE THESE for product names viewers are pointing at) ===
${comments}${imagesNote}`;
  }

  // ─── Image helpers (for vision-enabled extraction) ─────────────────────────

  /**
   * Fetch a remote image and convert to {mimeType, data} (base64).
   * Returns null on any failure so callers can quietly omit.
   * @param {string} url
   * @param {AbortSignal} [signal]
   */
  async function fetchImageAsBase64(url, signal) {
    try {
      const res = await fetch(url, { credentials: "omit", signal });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (blob.size > 2_000_000) return null; // skip oversize
      const mimeType = blob.type || "image/jpeg";
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return { mimeType, data: btoa(binary) };
    } catch (_) {
      return null;
    }
  }

  function dataUrlToInline(dataUrl) {
    try {
      const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
      if (!m) return null;
      return { mimeType: m[1], data: m[2] };
    } catch (_) { return null; }
  }

  // ─── Storyboard sheet sampling ────────────────────────────────────────────
  // YouTube publishes a `playerStoryboardSpecRenderer.spec` string on every
  // watch page that describes 1-3 levels of seek-preview mosaics, each a grid
  // of tiny frames covering the full video timeline. That's our dense source.

  const STORYBOARD_MAX_SHEETS = 18;

  async function fetchPlayerResponse(videoId) {
    try {
      const res = await fetch(
        `https://www.youtube.com/watch?v=${videoId}&hl=en`,
        { credentials: "omit" }
      );
      if (!res.ok) return null;
      const html = await res.text();
      return extractPlayerResponse(html);
    } catch (_) { return null; }
  }

  /**
   * Fetch the full, untruncated description from YouTube's server-rendered
   * watch page. More reliable than in-page DOM scraping (which can miss the
   * full text or pick up the AI summary widget).
   * Returns empty string on any failure.
   */
  async function fetchFullDescription(videoId) {
    try {
      if (!videoId) return "";
      const pr = await fetchPlayerResponse(videoId);
      const desc = pr?.videoDetails?.shortDescription;
      return typeof desc === "string" ? desc : "";
    } catch (_) { return ""; }
  }

  /**
   * Parse the `|`-separated spec into levels.
   * Base URL contains $L and $N placeholders; each level appends its own sigh.
   * @returns {{baseUrl: string, levels: Array<{level:number,width:number,height:number,count:number,cols:number,rows:number,intervalMs:number,sigh:string,sheets:number}>} | null}
   */
  function parseStoryboardSpec(spec) {
    if (typeof spec !== "string" || !spec.includes("|")) return null;
    const parts = spec.split("|");
    const baseUrl = parts[0];
    if (!baseUrl.includes("$L") || !baseUrl.includes("$N")) return null;
    const levels = [];
    for (let i = 1; i < parts.length; i++) {
      const f = parts[i].split("#");
      if (f.length < 6) continue;
      const width = +f[0], height = +f[1], count = +f[2];
      const cols = +f[3] || 5, rows = +f[4] || 5;
      const intervalMs = +f[5] || 0;
      const sigh = f[7] || f[6] || "";
      if (!width || !height || !count || !cols || !rows || !sigh) continue;
      const perSheet = cols * rows;
      const sheets = Math.max(1, Math.ceil(count / perSheet));
      levels.push({ level: i - 1, width, height, count, cols, rows, intervalMs, sigh, sheets });
    }
    return levels.length ? { baseUrl, levels } : null;
  }

  /**
   * Pick the densest usable level that fits within sheet cap.
   * User preference: parse more rather than less.
   */
  function selectStoryboardLevel(levels, maxSheets) {
    // Candidates: drop degenerate interval=0 unless it's the only option.
    const real = levels.filter((l) => l.intervalMs > 0 && l.sheets > 0);
    const pool = real.length ? real : levels;

    // Sort by density (highest count first)
    const byDensity = [...pool].sort((a, b) => b.count - a.count);

    // Densest that fits
    for (const lvl of byDensity) {
      if (lvl.sheets <= maxSheets) return { ...lvl, sampled: false };
    }
    // Even densest doesn't fit — sample `maxSheets` evenly from it.
    const densest = byDensity[0];
    return { ...densest, sampled: true, sampleCount: maxSheets };
  }

  function sheetUrl(baseUrl, level, sheetN, sigh) {
    let u = baseUrl.replace(/\$L/g, String(level)).replace(/\$N/g, String(sheetN));
    u += (u.includes("?") ? "&" : "?") + "sigh=" + encodeURIComponent(sigh);
    return u;
  }

  async function collectStoryboardParts(videoId) {
    const pr = await fetchPlayerResponse(videoId);
    const spec = pr?.storyboards?.playerStoryboardSpecRenderer?.spec;
    const parsed = parseStoryboardSpec(spec);
    if (!parsed) return null;
    const sel = selectStoryboardLevel(parsed.levels, STORYBOARD_MAX_SHEETS);
    if (!sel) return null;

    const sheetIdx = sel.sampled
      ? Array.from({ length: sel.sampleCount }, (_, i) =>
          Math.floor((i * sel.sheets) / sel.sampleCount))
      : Array.from({ length: sel.sheets }, (_, i) => i);

    const urls = sheetIdx.map((n) => sheetUrl(parsed.baseUrl, sel.level, n, sel.sigh));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const fetched = await Promise.all(
      urls.map((u) => fetchImageAsBase64(u, controller.signal))
    );
    clearTimeout(timer);

    const parts = fetched.filter(Boolean);
    if (parts.length === 0) return null;
    return {
      parts,
      meta: {
        level: sel.level,
        cols: sel.cols,
        rows: sel.rows,
        intervalMs: sel.intervalMs,
        sheetCount: parts.length,
        framesPerSheet: sel.cols * sel.rows,
        totalFramesApprox: Math.min(sel.count, parts.length * sel.cols * sel.rows),
      },
    };
  }

  /**
   * Assemble image parts for the extraction call.
   * Order of preference: storyboard mosaics (full timeline coverage),
   * then YouTube auto-thumbnails as fallback. Current-frame always first.
   * @returns {Promise<{parts: Array<{mimeType:string,data:string}>, storyboard: object|null}>}
   */
  async function collectImageParts(videoMeta) {
    /** @type {Array<{mimeType:string,data:string}>} */
    const parts = [];
    const fromFrame = dataUrlToInline(videoMeta.currentFrameDataUrl);
    if (fromFrame) parts.push(fromFrame);

    if (!videoMeta.videoId) return { parts, storyboard: null };

    const sb = await collectStoryboardParts(videoMeta.videoId);
    if (sb && sb.parts.length > 0) {
      for (const p of sb.parts) parts.push(p);
      return { parts, storyboard: sb.meta };
    }

    // Fallback: static auto-thumbnails
    const urls = [
      `https://i.ytimg.com/vi/${videoMeta.videoId}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${videoMeta.videoId}/1.jpg`,
      `https://i.ytimg.com/vi/${videoMeta.videoId}/2.jpg`,
      `https://i.ytimg.com/vi/${videoMeta.videoId}/3.jpg`,
    ];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const fetched = await Promise.all(
      urls.map((u) => fetchImageAsBase64(u, controller.signal))
    );
    clearTimeout(timer);

    for (const p of fetched) if (p) parts.push(p);
    return { parts: parts.slice(0, 5), storyboard: null };
  }

  // ─── Validate / coerce ─────────────────────────────────────────────────────

  const NULLISH_STRINGS = new Set(["unknown", "n/a", "na", "none", "null", "0:00"]);

  function normalizeStringField(v) {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t) return null;
    if (NULLISH_STRINGS.has(t.toLowerCase())) return null;
    return t;
  }

  // Placeholder/label patterns that are not real product names.
  // "ITEM 9 *", "Product 3", "#4", "Look 2", etc.
  const PLACEHOLDER_NAME_RX = /^\s*(?:[#*•\-]*\s*)?(?:item|product|look|piece|option|number|no\.?|#)\s*\d+\s*[*•\-]*\s*$/i;
  // Bare category word with no descriptor — "shoes", "dress", "bag", etc.
  // Useless as a Google-Shopping query on its own.
  const BARE_CATEGORY_RX = /^(?:top|tops|shirt|shirts|blouse|tee|tees|tank|sweater|knit|dress|dresses|skirt|skirts|pant|pants|trouser|trousers|jean|jeans|short|shorts|jacket|coat|blazer|cardigan|hoodie|shoe|shoes|boot|boots|sneaker|sneakers|heel|heels|loafer|loafers|sandal|sandals|bag|bags|purse|tote|clutch|backpack|hat|belt|scarf|necklace|earring|earrings|ring|bracelet|watch|sunglasses|accessory|item|items|product|products|outfit|look)$/i;

  // searchQuery must have real semantic content — reject numbered/empty placeholders
  const PLACEHOLDER_QUERY_RX = /^\s*(?:item|product|look|piece|no\.?|#)?\s*\d+\s*\*?\s*$/i;

  // Creator self-promo / social CTAs — never products.
  // Matches "check out my 2nd channel", "like my facebook page", "follow me on IG", etc.
  const PROMO_NAME_RX = /\b(?:my\s+(?:channel|page|blog|newsletter|shop|store|discord|patreon|instagram|ig|twitter|x|tiktok|facebook|fb|youtube|yt|podcast)|link\s+in\s+bio|links?\s+(?:in|below|above)|subscribe|follow\s+(?:me|us|the|for)|like\s+(?:my|the)|visit\s+(?:my|our)|join\s+(?:my|our|us|the)|check\s+out\s+(?:my|our)|use\s+code|promo\s+code|discount\s+code|\d+%\s*off|giveaway|the\s+love)\b/i;

  // Arrow/bullet prefixes mean "this is a chapter link", not a product.
  // YouTube descriptions commonly use: → ► ▶ ⇒ ➤ ➔ ➜ » › •
  const ARROW_PREFIX_RX = /^\s*[→►▶⇒➤➔➜»›•◆◇♦]+\s*/;

  // Truncated fragments: trailing dash (music credit chopped off) or
  // unbalanced opening paren ("ponytail (code" → discount code truncated).
  const TRAILING_DASH_RX = /[\-–—]\s*$/;
  function isUnbalancedParen(str) {
    const open = (str.match(/\(/g) || []).length;
    const close = (str.match(/\)/g) || []).length;
    return open !== close;
  }

  // Multi-word ALL-CAPS candidate = video section header / chapter title,
  // never a product name. "3 EASY HAIRSTYLES", "MORE BEAUTY", "JOIN THE LOVE".
  // Single-word all-caps (brand like "NIKE") or short 2-word brands are
  // allowed; length+digit heuristic catches the header pattern.
  function isAllCapsHeader(str) {
    const t = str.trim();
    if (t.length < 8) return false;
    const letters = t.replace(/[^A-Za-z]/g, "");
    if (!letters || letters !== letters.toUpperCase()) return false;
    const wordCount = t.split(/\s+/).filter((w) => /[A-Z]/.test(w)).length;
    return wordCount >= 2;
  }

  // Style/technique nouns — not shoppable on their own.
  // A product variant ("ponytail holder", "braid clip") still passes because
  // those have >1 word; this only catches the bare noun.
  const STYLE_NOUN_RX = /^(?:ponytail|ponytails|braid|braids|bun|buns|updo|updos|hairstyle|hairstyles|style|styling|tutorial|tutorials|outfit|outfits|vibe|vibes|aesthetic|aesthetics|technique|techniques|routine|routines)$/i;

  // Music-credit shape: "Artist - Song" or with trailing fragment.
  // Description music sections lead to titles like "Mr. Chase - Wild Cherry".
  // Without a known product category word, treat double-hyphen shape as music.
  function looksLikeMusicCredit(str) {
    const parts = str.split(/\s[-–—]\s/);
    if (parts.length < 2) return false;
    // No product-category word anywhere → likely a music credit
    return !CATEGORY_PATTERNS.some(([rx]) => rx.test(str));
  }

  // Sentence fragments from transcript / comments that aren't noun phrases.
  // Names should start with an adjective or noun, not an adverb/verb/conjunction.
  const FRAGMENT_START_RX = /^(?:still|only|just|really|maybe|literally|actually|basically|honestly|love|loved|loving|want|wanted|wanting|need|needed|feel|feels|feeling|felt|watch|watched|watching|look|looks|looking|looked|see|saw|seen|think|thought|wish|hope|try|trying|tried|check|follow|subscribe|like|visit|join|grab|get|got|find|found|use|used)\b/i;

  // Generic section labels from descriptions — "Alternatives", "Links", "Details", etc.
  const SECTION_LABEL_RX = /^(?:alternatives?|options?|details?|links?|chapters?|timestamps?|sponsors?|credits?|music(?:\s+used)?|gear(?:\s+used)?|equipment|resources?|mentioned|references?|description|outfit(?:\s+details?)?|shop(?:\s+the\s+look)?)[\s:!*•\-]*$/i;

  function hasMeaningfulContent(str) {
    if (typeof str !== "string") return false;
    const words = str.trim().split(/\s+/).filter((w) => /[a-z]/i.test(w));
    return words.length >= 2;
  }

  function coerceProduct(p) {
    if (p === null || typeof p !== "object") return null;
    if (typeof p.name !== "string" || p.name.trim() === "") return null;
    if (typeof p.searchQuery !== "string" || p.searchQuery.trim() === "") return null;
    if (typeof p.confidence !== "number") return null;

    // Strip leading arrows before running further checks — also a signal
    // that this was a chapter link, but normalize first in case the rest
    // happens to be legitimate (rare but possible).
    let name = p.name.trim();
    const hadArrowPrefix = ARROW_PREFIX_RX.test(name);
    name = name.replace(ARROW_PREFIX_RX, "").trim();
    const searchQuery = p.searchQuery.trim();

    // Arrow-prefixed names are almost always chapter/timestamp links,
    // not products. Reject unless what's left is clearly a branded product.
    if (hadArrowPrefix) return null;

    // Reject placeholder / non-unique names that would search poorly
    if (PLACEHOLDER_NAME_RX.test(name)) return null;
    if (BARE_CATEGORY_RX.test(name)) return null;
    if (PLACEHOLDER_QUERY_RX.test(searchQuery)) return null;

    // Reject creator self-promo, social CTAs, discount codes
    if (PROMO_NAME_RX.test(name)) return null;
    if (PROMO_NAME_RX.test(searchQuery)) return null;

    // Reject sentence fragments — names must be noun phrases, not clauses
    if (FRAGMENT_START_RX.test(name)) return null;

    // Reject generic section labels from descriptions
    if (SECTION_LABEL_RX.test(name)) return null;

    // Reject truncated fragments (trailing dash, unbalanced parens)
    if (TRAILING_DASH_RX.test(name)) return null;
    if (isUnbalancedParen(name)) return null;

    // Reject multi-word ALL-CAPS headers ("3 EASY HAIRSTYLES", "JOIN THE LOVE")
    if (isAllCapsHeader(name)) return null;

    // Reject bare style/technique nouns ("ponytail", "braid")
    if (STYLE_NOUN_RX.test(name)) return null;

    // Reject music-credit shape ("Artist - Title" with no product word)
    if (looksLikeMusicCredit(name)) return null;

    // Require at least 2 alphabetic words in EITHER name or searchQuery —
    // a single-word product like "dress" is not Google-Shopping-ready.
    if (!hasMeaningfulContent(name) && !hasMeaningfulContent(searchQuery)) return null;

    return {
      name,
      brand: normalizeStringField(p.brand),
      category: VALID_CATEGORIES.has(p.category) ? p.category : "other",
      searchQuery,
      confidence: p.confidence,
      timestamp: normalizeStringField(p.timestamp),
    };
  }

  function parseAndCoerce(raw) {
    let cleaned = typeof raw === "string" ? raw.trim() : "";
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    // Handle preamble before the array
    const arrIdx = cleaned.indexOf("[");
    if (arrIdx > 0) cleaned = cleaned.slice(arrIdx);
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error("Response was not a JSON array");
    const beforeFilter = parsed.length;

    // Dedupe by normalized searchQuery so two items with the same query collapse.
    const seenQueries = new Set();
    const products = [];
    for (const raw of parsed) {
      const p = coerceProduct(raw);
      if (!p) continue;
      if (p.confidence < 0.4) continue;
      const qKey = p.searchQuery.toLowerCase().replace(/\s+/g, " ").trim();
      if (seenQueries.has(qKey)) continue;
      seenQueries.add(qKey);
      products.push(p);
      if (products.length >= 150) break;
    }
    if (beforeFilter > 0 && products.length === 0) {
      console.warn("[Scout] all", beforeFilter, "items filtered out after validation");
    }
    return products;
  }

  // ─── Gemini client ─────────────────────────────────────────────────────────

  const GEMINI_RESPONSE_SCHEMA = {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        name:        { type: "STRING" },
        brand:       { type: "STRING", nullable: true },
        category:    { type: "STRING", enum: ["top","bottom","dress","outerwear","shoes","bag","accessory","beauty","other"] },
        searchQuery: { type: "STRING" },
        confidence:  { type: "NUMBER" },
        timestamp:   { type: "STRING", nullable: true },
      },
      required: ["name", "category", "searchQuery", "confidence"],
    },
  };

  async function extractWithGemini({ videoMeta, transcriptText, apiKey, model, imageParts, storyboard }) {
    const userContent = buildUserContent({
      title: videoMeta.title, channel: videoMeta.channel,
      description: videoMeta.description, transcriptText,
      topComments: videoMeta.topComments,
      storyboard,
    });

    const parts = [{ text: userContent }];
    if (Array.isArray(imageParts)) {
      for (const p of imageParts) parts.push({ inline_data: p });
    }

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 45000);

    let res;
    try {
      res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: EXTRACTION_RULES }] },
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: GEMINI_RESPONSE_SCHEMA,
            temperature: 0.3,
            maxOutputTokens: 8192,
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") throw new Error("Gemini request timed out — try again.");
      throw err;
    }
    clearTimeout(timeoutId);

    if (!res.ok) {
      let msg = `Gemini error ${res.status}`;
      try { const b = await res.json(); if (b?.error?.message) msg += `: ${b.error.message}`; } catch (_) {}
      throw new Error(msg);
    }

    const body = await res.json();
    if (body?.promptFeedback?.blockReason) throw new Error(`Gemini blocked: ${body.promptFeedback.blockReason}`);
    if (!body?.candidates?.length) throw new Error("Gemini returned no candidates");

    const raw = body.candidates[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error("Gemini response missing text field");
    return parseAndCoerce(raw);
  }

  // ─── Router ───────────────────────────────────────────────────────────────

  /**
   * @param {{videoMeta: import("../lib/types").VideoMeta, transcriptText: string|null, settings: import("../lib/types").Settings}}
   * @returns {Promise<import("../lib/types").Product[]>}
   */
  /**
   * Synthetic fallback — guarantees the saves list is never empty.
   * Used only when every other source returns zero items. A single search
   * row seeded from the video title so the user can still click through.
   */
  function syntheticMockProducts(videoMeta) {
    const rawTitle = (videoMeta?.title || "").trim();
    if (!rawTitle) return [];
    // Strip obvious noise so the shopping search is cleaner
    const cleaned = rawTitle
      .replace(/[\[\(\{][^\]\)\}]+[\]\)\}]/g, "") // drop [4K], (2026), etc.
      .replace(/[|–—].*$/, "")                    // drop everything after a dash/pipe
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    if (!cleaned) return [];
    return [{
      name: `Shop items from: ${cleaned}`,
      brand: null,
      category: "other",
      searchQuery: cleaned.toLowerCase(),
      confidence: 0.4,
      timestamp: null,
    }];
  }

  async function extractProducts({ videoMeta, transcriptText, settings }) {
    const provider = settings?.provider || "none";

    // Always fetch the description server-side for the exact videoId.
    // The in-page scrape can return the WRONG video's description on SPA
    // navigations (YouTube keeps the original ytInitialPlayerResponse
    // script tag around), and can also miss or truncate the real one.
    // A fresh fetch keyed by videoId is the source of truth.
    try {
      if (videoMeta.videoId) {
        const full = await fetchFullDescription(videoMeta.videoId);
        if (full && full.trim()) {
          videoMeta = { ...videoMeta, description: full };
        }
      }
    } catch (_) { /* non-fatal — keep whatever description we had */ }

    let products = [];
    if (provider === "gemini") {
      if (!settings.geminiApiKey) throw new Error("Gemini API key not set — add it in Settings.");
      const { parts: imageParts, storyboard } = await collectImageParts(videoMeta);
      const model = settings.geminiModel || DEFAULT_MODELS.gemini;
      try {
        products = await extractWithGemini({
          videoMeta, transcriptText, apiKey: settings.geminiApiKey, model, imageParts, storyboard,
        });
      } catch (err) {
        // If Gemini fails, fall through to heuristic rather than error out
        console.warn("[Scout] Gemini extraction failed, falling back to heuristic:", err.message);
        products = [];
      }
    }

    // Heuristic as second pass (always cheap, never throws)
    if (!Array.isArray(products) || products.length === 0) {
      products = heuristicExtract(videoMeta);
    }

    // Last-resort mockup — user explicitly asked: never show "no products".
    if (!Array.isArray(products) || products.length === 0) {
      products = syntheticMockProducts(videoMeta);
    }

    return Array.isArray(products) ? products : [];
  }

  return { fetchTranscript, extractProducts, fetchFullDescription, DEFAULT_MODELS };
})();
