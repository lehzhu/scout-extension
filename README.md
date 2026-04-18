# Phia YouTube

A standalone Chrome extension that auto-saves YouTube fashion/haul videos, extracts clothing and product mentions using Gemini AI, and displays them as a shoppable list with Google Shopping links.

> Built as a hackathon companion to [phia.com](https://phia.com).

---

## Loading the extension in Chrome

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select this directory (`phia/`).
5. The "Phia YouTube" extension will appear in your toolbar.

---

## Adding your Gemini API key

1. Click the Phia YT icon in the Chrome toolbar.
2. Switch to the **Settings** tab.
3. Paste your [Gemini API key](https://aistudio.google.com/app/apikey) into the field.
4. Click **Save**.

The key is stored locally in `chrome.storage.local` and never leaves your browser except when calling the Gemini API directly.

---

## What's implemented

- [x] **Manifest V3** scaffold — service worker, content script on YouTube watch pages, popup action
- [x] **storage.js** — full CRUD for settings (API key) and saved items
- [x] **messaging.js** — typed message bus between content script, background, and popup
- [x] **types.js** — JSDoc contracts for `VideoMeta`, `Product`, `SavedItem`
- [x] **Popup shell** — tab UI (Shopping List + Settings), API key save

## What's next

- [ ] **Task 2** — YouTube DOM injection: detect video page loads, scrape `VideoMeta`
- [ ] **Task 3** — Gemini integration: fetch transcript via `timedtext` endpoint, extract products with structured JSON output
- [ ] **Task 4** — Popup list view: render saved items, product cards with Google Shopping links, remove/clear actions
- [ ] **Task 5** — Real icons, polished UI, progress indicators
- [ ] **Task 6** — Edge-case handling, error states, rate limiting
