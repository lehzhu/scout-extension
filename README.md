# Scout

A YouTube companion: save a haul, OOTD, or review in one click and get the products as a shoppable list.

---

## Why

Fashion and product videos drive a lot of impulse shopping, but the actual items are buried across timestamped descriptions, comments, and mid-sentence mentions. By the time you're ready to buy, the link is gone. Scout saves the video and quietly pulls every product into a clean list you can revisit.

---

## How it works

- **Save button on every watch page.** "Save to Scout" slots in next to YouTube's Subscribe button. One click queues the video.
- **Service worker pulls the raw signals.** Description, transcript, visible top comments, and the storyboard mosaic sheets YouTube ships for seek previews — which give full-timeline coverage of what's on screen without loading the whole video.
- **Gemini 2.5 Flash extracts products.** Text + images go to Gemini with a schema-constrained prompt; it returns structured products with name, brand, category, and a ready-to-search query.
- **Fallbacks so you never get an empty list.** If the LLM call fails or returns nothing, a regex heuristic mines bullets and comment noun phrases; worst case you still get a "Shop [title]" row.
- **Saves live in a full-page view.** Notes, clickable description links, top comments, per-product favourites, and Prev/Next nav through your collection.

---

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.

---

## Setup

1. Grab a free key at [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Click the Scout icon → **Settings** → paste the key → **Save**.

The key stays in `chrome.storage.local`. API calls go directly from your browser to Google — no Scout backend.

---

## Try it

1. Open any fashion haul or OOTD on YouTube.
2. Click **Save to Scout**.
3. Open the popup or click **Expand ↗** for the full grid view.
4. Extraction takes 3–10 seconds. When it's done, the save-button turns into "Open in Scout" and products show up in the list.

---

## Privacy

- No backend. Saved items, notes, and favourites live in `chrome.storage.local`.
- The Gemini API key is stored locally and rides in the request URL per Google's API convention — fine for a local extension, not a production billing key.
- Permissions: `storage`, `activeTab`, and host access to `youtube.com`, `i.ytimg.com`, and `generativelanguage.googleapis.com`.

---

## What's next

- OpenRouter as a backup provider.
- Timestamp → deep-link on products with a captured moment.
- Tags / collections beyond favourites.
- TikTok and Instagram Reels ingestion through the same pipeline.

---

## Development

No build step — Manifest V3, vanilla JS. Load unpacked, edit, and reload from `chrome://extensions`.

Regenerate icons after a palette change:

```
node tools/make-icons.js
```
