// Phia parser module — attaches to self.Phia.parser
self.Phia = self.Phia || {};

self.Phia.parser = (() => {
  const MAX_TRANSCRIPT_CHARS = 30000;
  const GEMINI_ENDPOINT =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  const VALID_CATEGORIES = new Set([
    "top", "bottom", "dress", "outerwear", "shoes",
    "bag", "accessory", "beauty", "other",
  ]);

  // ─── fetchTranscript ───────────────────────────────────────────────────────

  function extractPlayerResponse(html) {
    // Primary regex: handles typical inline assignment termination
    const m = html.match(
      /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script>)/
    );
    if (m) {
      try { return JSON.parse(m[1]); } catch (_) {}
    }
    // Fallback: bracket-balanced parse from the assignment
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
   * Returns null on any non-network failure; network errors may bubble to the caller
   * (service worker catches them and continues without transcript).
   */
  async function fetchTranscript(videoId) {
    const watchRes = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      { credentials: "omit" }
    );
    if (!watchRes.ok) {
      // Non-2xx from YouTube — return null rather than throwing
      return null;
    }

    let html;
    try {
      html = await watchRes.text();
    } catch (_) {
      return null;
    }

    let playerResponse;
    try {
      playerResponse = extractPlayerResponse(html);
    } catch (_) {
      return null;
    }
    if (!playerResponse) return null;

    let tracks;
    try {
      tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    } catch (_) {
      return null;
    }
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) return null;

    const track = pickBestTrack(tracks);
    if (!track?.baseUrl) return null;

    let captionRes;
    try {
      captionRes = await fetch(`${track.baseUrl}&fmt=json3`, { credentials: "omit" });
    } catch (networkErr) {
      // Let real network failures bubble so the SW can log them
      throw networkErr;
    }
    if (!captionRes.ok) {
      // Non-2xx caption fetch — return null gracefully
      return null;
    }

    let data;
    try {
      data = await captionRes.json();
    } catch (_) {
      // Malformed JSON3 caption data
      return null;
    }

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
    } catch (_) {
      return null;
    }

    let text = parts.join(" ");
    if (text.length > MAX_TRANSCRIPT_CHARS) {
      text = text.slice(0, MAX_TRANSCRIPT_CHARS) + "… [truncated]";
    }
    return { text, cues };
  }

  // ─── extractProducts ───────────────────────────────────────────────────────

  const RESPONSE_SCHEMA = {
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

  function buildPrompt({ title, channel, description, transcriptText }) {
    const transcript = transcriptText || "(no transcript available)";
    return `You are a fashion product extraction assistant for a shopping app. Given a YouTube video's title, channel, description, and transcript, extract every distinct clothing item, shoe, accessory, or beauty product that the creator wears, mentions, recommends, reviews, or links. Output STRICT JSON per the schema.

Rules:
- Only include items a shopper could realistically search for. Skip generic mentions without enough detail to search ("a cute blue top" alone → skip; "Reformation blue linen top" → include).
- Include named brands whenever stated or inferable from the description's affiliate links.
- Deduplicate. Merge near-duplicate descriptions of the same item.
- \`searchQuery\` must be Google-Shopping-ready: brand + 2–5 descriptive keywords, lowercase, no punctuation beyond spaces.
- \`timestamp\` ("m:ss" or "mm:ss") only if the transcript clearly introduces the item at a particular spoken moment; otherwise null.
- \`confidence\`: your belief this is a real, searchable product (0 to 1). Below 0.4 → drop entirely, don't return it.
- If no fashion/product content, return [].
- Return NO prose, just the JSON array.

Video title: ${title}
Channel: ${channel}
Description (may contain affiliate links / product list): ${description}
Transcript: ${transcript}`;
  }

  /**
   * Validate and coerce a raw product object from Gemini into the Product shape.
   * Returns null if the item is unsalvageable (missing required fields).
   * @param {any} p
   * @returns {import("../lib/types").Product | null}
   */
  function coerceProduct(p) {
    if (p === null || typeof p !== "object") return null;
    if (typeof p.name !== "string" || p.name.trim() === "") return null;
    if (typeof p.searchQuery !== "string" || p.searchQuery.trim() === "") return null;
    if (typeof p.confidence !== "number") return null;

    const category = VALID_CATEGORIES.has(p.category) ? p.category : "other";
    const brand = typeof p.brand === "string" ? p.brand : null;
    const timestamp =
      typeof p.timestamp === "string" && p.timestamp.trim() !== "" ? p.timestamp.trim() : null;

    return {
      name: p.name.trim(),
      brand,
      category,
      searchQuery: p.searchQuery.trim(),
      confidence: p.confidence,
      timestamp,
    };
  }

  /**
   * @param {{videoMeta: import("../lib/types").VideoMeta, transcriptText: string|null, apiKey: string}}
   * @returns {Promise<import("../lib/types").Product[]>}
   * Throws surfaceable errors (Gemini API errors, malformed JSON, timeout).
   * The service worker catches these and saves the item with status "error".
   */
  async function extractProducts({ videoMeta, transcriptText, apiKey }) {
    const prompt = buildPrompt({
      title: videoMeta.title,
      channel: videoMeta.channel,
      description: videoMeta.description,
      transcriptText,
    });

    // 45-second timeout via AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    let res;
    try {
      res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.3,
            maxOutputTokens: 4096,
          },
        }),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === "AbortError") {
        throw new Error("Gemini request timed out after 45s — check your connection and try again.");
      }
      throw fetchErr;
    }
    clearTimeout(timeoutId);

    if (!res.ok) {
      let errMsg = `Gemini error ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error?.message) errMsg += `: ${body.error.message}`;
      } catch (_) {}
      throw new Error(errMsg);
    }

    let body;
    try {
      body = await res.json();
    } catch (_) {
      throw new Error("Gemini returned malformed JSON response body");
    }

    if (body?.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked request: ${body.promptFeedback.blockReason}`);
    }
    if (!body?.candidates?.length) {
      throw new Error("Gemini returned no candidates");
    }

    let raw;
    try {
      raw = body.candidates[0].content.parts[0].text;
    } catch (_) {
      throw new Error("Gemini response missing expected text field");
    }

    let cleaned = typeof raw === "string" ? raw.trim() : "";
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new Error(`Gemini returned malformed JSON: ${err.message}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error("Gemini response was not an array");
    }

    // Validate and coerce each item; drop invalid ones
    const beforeFilter = parsed.length;
    const products = parsed
      .map(coerceProduct)
      .filter((p) => p !== null && p.confidence >= 0.4)
      .slice(0, 25);

    if (beforeFilter > 0 && products.length === 0) {
      console.warn("[Phinds] extractProducts: all", beforeFilter, "items were filtered out after validation");
    }

    return products;
  }

  return { fetchTranscript, extractProducts };
})();
