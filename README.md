# Scout

A YouTube companion: save shopping/haul videos and pull out the products as a shopping list.

> Hackathon project.

---

## Why

YouTube hauls, OOTDs, and product reviews drive a huge share of fashion impulse purchases — but the products are buried in timestamped descriptions, comment-section replies, and fleeting mentions mid-sentence. By the time the viewer is ready to buy, the link is gone or the description wall is 30 items long. Scout closes that gap: one click saves the video, and the extension quietly extracts every product into a clean, shoppable list.

---

## How it works

- **Save button on every YouTube watch page.** A "Save to Scout" button is injected next to the video title. Click it once and the video is queued.
- **Background worker fetches transcript and description.** The service worker retrieves the auto-generated transcript via YouTube's timed-text endpoint and combines it with the video description — no scraping, no page reloads.
- **Gemini 2.5 Flash extracts products as structured data.** The combined text is sent to the Gemini API, which returns a JSON array of products (name, brand, category, search query). Each product gets a direct Google Shopping link so the user can buy immediately.

---

## Install

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select this directory (the repo root).
5. The Scout icon appears in your Chrome toolbar.

---

## Setup

1. Get a free API key at [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Click the Scout icon in the toolbar.
3. Switch to the **Settings** tab.
4. Paste your Gemini API key and click **Save**.

The key is stored only in `chrome.storage.local`. API calls go directly from your browser to Google — no Scout backend sits in the middle.

---

## Try it

1. Search YouTube for "summer fashion haul" or "OOTD get ready with me" and open any video.
2. Click **Save to Scout** next to the video title.
3. Open the Scout popup — you will see a "Saving" card with an animated loader while the transcript is fetched and products are extracted (typically 3–10 seconds).
4. Once complete, the card flips to a product list with one-click Google Shopping links.
5. If extraction fails (no transcript, API error), a **Retry** button appears on the card.

---

## Design

Clean and minimal: near-black (`#0F0F0F`) for all primary CTAs, white surface with a light grey alt-surface for depth, and rounded cards throughout. Typography is system sans-serif at conservative weights. The content-script button uses a pill chip style so it reads as native to the page, not bolted on.

---

## Privacy

- No backend. All saved items live in `chrome.storage.local` on your machine.
- Your Gemini API key is stored locally and never logged.
- Gemini API calls go directly from your browser to `generativelanguage.googleapis.com`. The key rides in the request URL per Google's API convention — fine for a local extension, but don't use a production-billing key.
- The extension requests only `storage` and `activeTab` permissions, plus host access to `youtube.com` (for the save button) and `generativelanguage.googleapis.com` (for product extraction).

---

## What's next

- **Affiliate link integration** — surface direct retailer links alongside Google Shopping.
- **Bulk import of watch history** — queue up multiple saved/watched videos in one pass.
- **Price tracking** — monitor price changes for extracted products.
- **Per-channel rules** — auto-save every video from a specific creator, or suppress extraction for categories that generate noise.

---

## Development

**Regenerate icons** (after any palette or shape change):

```
node tools/make-icons.js
```

The script at `tools/make-icons.js` hand-rolls valid PNG files with no npm dependencies — safe to re-run any time.

**No build step.** The extension is vanilla JavaScript (Manifest V3). Load it unpacked, make edits, and hit the refresh icon on `chrome://extensions` to reload.
