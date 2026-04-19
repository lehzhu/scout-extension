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

  function heuristicExtract(videoMeta) {
    const commentText = Array.isArray(videoMeta.topComments)
      ? videoMeta.topComments.join("\n")
      : "";
    const text = [
      videoMeta.description || "",
      videoMeta.title || "",
      commentText,
    ].join("\n");
    const lines = text.split(/\r?\n/);
    const products = [];
    const seen = new Set();
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

      const key = name.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);

      products.push({
        name,
        brand: null,
        category: guessCategory(name),
        searchQuery: name.toLowerCase(),
        confidence: 0.35,
        timestamp: tsMatch ? tsMatch[1] : null,
      });
    }

    return products.slice(0, 20);
  }

  // ─── Shared prompt helpers ─────────────────────────────────────────────────

  const EXTRACTION_RULES = `You are a shopping-product extraction assistant.

Your job: surface every searchable product a shopper might want from this YouTube video. Use ALL available signals — title, description, transcript, top viewer comments, AND any attached video frames (thumbnails, still captures).

When frames are attached: look at garments, shoes, accessories, makeup, and visible products being held, worn, or demonstrated. Infer generic descriptors ("brown trench coat", "black leather loafers") when exact brand is unknown — shoppers can still search for these. Use visible logos or tags if readable.

Rules:
- Extract every distinct clothing item, shoe, accessory, beauty product, or physical item the creator wears, holds, demonstrates, mentions, recommends, or links.
- Prefer specific descriptors: color + material + silhouette + item type ("cream ribbed wool turtleneck"). Brand when available or inferable from links/comments/visible tags.
- Mine comments for brand/source questions the creator may have answered ("what jeans are those?" → if referenced in description, include).
- Deduplicate — merge near-duplicate mentions of the same item.
- searchQuery: Google-Shopping-ready string, 3–6 lowercase keywords, no punctuation. Lead with brand if known.
- timestamp: "m:ss" ONLY when transcript/comments clearly pin a specific moment. Use null (not "0:00" or "N/A") if unknown.
- brand: exact brand string when known, otherwise null. Do NOT write "Unknown", "N/A", or "None".
- confidence: 0–1, your certainty it's a real searchable product. Include items ≥ 0.4.
- Aim to return SOMETHING for any fashion/lifestyle/haul video. An empty array is only correct when the video is genuinely not about shoppable items (e.g. vlog with no visible products).
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
Description: ${description || "(none)"}
Transcript: ${transcriptText || "(no transcript available)"}
Top comments (may reveal products viewers asked about):
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

  function coerceProduct(p) {
    if (p === null || typeof p !== "object") return null;
    if (typeof p.name !== "string" || p.name.trim() === "") return null;
    if (typeof p.searchQuery !== "string" || p.searchQuery.trim() === "") return null;
    if (typeof p.confidence !== "number") return null;
    return {
      name: p.name.trim(),
      brand: normalizeStringField(p.brand),
      category: VALID_CATEGORIES.has(p.category) ? p.category : "other",
      searchQuery: p.searchQuery.trim(),
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
    const products = parsed
      .map(coerceProduct)
      .filter((p) => p !== null && p.confidence >= 0.4)
      .slice(0, 150);
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
  async function extractProducts({ videoMeta, transcriptText, settings }) {
    const provider = settings?.provider || "none";

    if (provider === "gemini") {
      if (!settings.geminiApiKey) throw new Error("Gemini API key not set — add it in Settings.");
      const { parts: imageParts, storyboard } = await collectImageParts(videoMeta);
      const model = settings.geminiModel || DEFAULT_MODELS.gemini;
      return extractWithGemini({
        videoMeta, transcriptText, apiKey: settings.geminiApiKey, model, imageParts, storyboard,
      });
    }

    // provider === "none": heuristic extraction, always succeeds
    return heuristicExtract(videoMeta);
  }

  return { fetchTranscript, extractProducts, DEFAULT_MODELS };
})();
