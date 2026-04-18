// Phia parser module — attaches to self.Phia.parser
self.Phia = self.Phia || {};

self.Phia.parser = (() => {
  const MAX_TRANSCRIPT_CHARS = 30000;
  const GEMINI_ENDPOINT =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

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
   */
  async function fetchTranscript(videoId) {
    const watchRes = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      { credentials: "omit" }
    );
    if (!watchRes.ok) throw new Error(`YouTube fetch failed: ${watchRes.status}`);
    const html = await watchRes.text();

    const playerResponse = extractPlayerResponse(html);
    if (!playerResponse) return null;

    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) return null;

    const track = pickBestTrack(tracks);
    if (!track?.baseUrl) return null;

    const captionRes = await fetch(`${track.baseUrl}&fmt=json3`, {
      credentials: "omit",
    });
    if (!captionRes.ok) throw new Error(`Caption fetch failed: ${captionRes.status}`);
    const data = await captionRes.json();

    const cues = [];
    const parts = [];
    for (const event of data.events || []) {
      if (!event.segs) continue;
      const cueText = event.segs.map((s) => s.utf8 || "").join("").trim();
      if (!cueText) continue;
      cues.push({ start: (event.tStartMs || 0) / 1000, text: cueText });
      parts.push(cueText);
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
   * @param {{videoMeta: import("../lib/types").VideoMeta, transcriptText: string|null, apiKey: string}}
   * @returns {Promise<import("../lib/types").Product[]>}
   */
  async function extractProducts({ videoMeta, transcriptText, apiKey }) {
    const prompt = buildPrompt({
      title: videoMeta.title,
      channel: videoMeta.channel,
      description: videoMeta.description,
      transcriptText,
    });

    const res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
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
    });

    if (!res.ok) {
      let errMsg = `Gemini error ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error?.message) errMsg += `: ${body.error.message}`;
      } catch (_) {}
      throw new Error(errMsg);
    }

    const body = await res.json();

    if (body?.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked request: ${body.promptFeedback.blockReason}`);
    }
    if (!body?.candidates?.length) {
      throw new Error("Gemini returned no candidates");
    }

    const raw = body.candidates[0].content.parts[0].text;
    const products = JSON.parse(raw);
    return products
      .filter((p) => p.confidence >= 0.4)
      .slice(0, 25);
  }

  return { fetchTranscript, extractProducts };
})();
