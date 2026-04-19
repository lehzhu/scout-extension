// Scout parser module — attaches to self.Scout.parser
self.Scout = self.Scout || {};

self.Scout.parser = (() => {
  const MAX_TRANSCRIPT_CHARS = 30000;

  const GEMINI_BASE     = "https://generativelanguage.googleapis.com/v1beta/models";
  const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
  const OPENAI_BASE     = "https://api.openai.com/v1";

  const DEFAULT_MODELS = {
    gemini:      "gemini-2.5-flash",
    openrouter:  "meta-llama/llama-3.1-8b-instruct:free",
    openai:      "gpt-4o-mini",
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
    const text = [videoMeta.description || "", videoMeta.title || ""].join("\n");
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

  const EXTRACTION_RULES = `You are a fashion product extraction assistant for a shopping extension.

Rules:
- Extract every distinct clothing item, shoe, accessory, or beauty product the creator wears, mentions, recommends, or links.
- Only include items a shopper could realistically search for. Skip vague mentions without enough detail ("a cute top" → skip; "Reformation linen top" → include).
- Include named brands whenever stated or clearly inferable from affiliate links.
- Deduplicate — merge near-duplicate mentions of the same item.
- searchQuery: Google-Shopping-ready string, brand + 2–5 descriptive keywords, lowercase, no punctuation beyond spaces.
- timestamp: "m:ss" only if the transcript clearly introduces the item at a specific spoken moment; otherwise null.
- confidence: 0–1, your certainty this is a real searchable product. Exclude items below 0.4.
- If no fashion/product content exists, return an empty array.
- Respond with ONLY a valid JSON array of product objects. No prose, no markdown.

Product shape: {"name": string, "brand": string|null, "category": "top"|"bottom"|"dress"|"outerwear"|"shoes"|"bag"|"accessory"|"beauty"|"other", "searchQuery": string, "confidence": number, "timestamp": string|null}`;

  function buildUserContent({ title, channel, description, transcriptText }) {
    return `Video title: ${title}
Channel: ${channel}
Description: ${description || "(none)"}
Transcript: ${transcriptText || "(no transcript available)"}`;
  }

  // ─── Validate / coerce ─────────────────────────────────────────────────────

  function coerceProduct(p) {
    if (p === null || typeof p !== "object") return null;
    if (typeof p.name !== "string" || p.name.trim() === "") return null;
    if (typeof p.searchQuery !== "string" || p.searchQuery.trim() === "") return null;
    if (typeof p.confidence !== "number") return null;
    return {
      name: p.name.trim(),
      brand: typeof p.brand === "string" ? p.brand : null,
      category: VALID_CATEGORIES.has(p.category) ? p.category : "other",
      searchQuery: p.searchQuery.trim(),
      confidence: p.confidence,
      timestamp: typeof p.timestamp === "string" && p.timestamp.trim() ? p.timestamp.trim() : null,
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
      .slice(0, 25);
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

  async function extractWithGemini({ videoMeta, transcriptText, apiKey, model }) {
    const userContent = buildUserContent({
      title: videoMeta.title, channel: videoMeta.channel,
      description: videoMeta.description, transcriptText,
    });

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 45000);

    let res;
    try {
      res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: EXTRACTION_RULES }] },
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: GEMINI_RESPONSE_SCHEMA,
            temperature: 0.3,
            maxOutputTokens: 4096,
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

  // ─── OAI-spec client (OpenRouter + OpenAI) ────────────────────────────────

  async function extractWithOAI({ videoMeta, transcriptText, apiKey, model, baseUrl }) {
    const userContent = buildUserContent({
      title: videoMeta.title, channel: videoMeta.channel,
      description: videoMeta.description, transcriptText,
    });

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 45000);

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };
    if (baseUrl === OPENROUTER_BASE) {
      headers["HTTP-Referer"] = "https://github.com/lehzhu/scout-extension";
      headers["X-Title"]      = "Scout Extension";
    }

    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: EXTRACTION_RULES },
            { role: "user",   content: userContent },
          ],
          temperature: 0.3,
          max_tokens: 4096,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") throw new Error("Request timed out — try again.");
      throw err;
    }
    clearTimeout(timeoutId);

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try { const b = await res.json(); if (b?.error?.message) msg += `: ${b.error.message}`; } catch (_) {}
      throw new Error(msg);
    }

    const data = await res.json();
    const raw  = data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Empty response from API");
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
      const model = settings.geminiModel || DEFAULT_MODELS.gemini;
      return extractWithGemini({ videoMeta, transcriptText, apiKey: settings.geminiApiKey, model });
    }

    if (provider === "openrouter") {
      if (!settings.openrouterApiKey) throw new Error("OpenRouter API key not set — add it in Settings.");
      const model = settings.openrouterModel || DEFAULT_MODELS.openrouter;
      return extractWithOAI({ videoMeta, transcriptText, apiKey: settings.openrouterApiKey, model, baseUrl: OPENROUTER_BASE });
    }

    if (provider === "openai") {
      if (!settings.openaiApiKey) throw new Error("OpenAI API key not set — add it in Settings.");
      const model = settings.openaiModel || DEFAULT_MODELS.openai;
      return extractWithOAI({ videoMeta, transcriptText, apiKey: settings.openaiApiKey, model, baseUrl: OPENAI_BASE });
    }

    // provider === "none": heuristic extraction, always succeeds
    return heuristicExtract(videoMeta);
  }

  return { fetchTranscript, extractProducts, DEFAULT_MODELS };
})();
