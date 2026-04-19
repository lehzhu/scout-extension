# Scout

Save a YouTube fashion/haul video. Get a shoppable product list.

## Install

1. `chrome://extensions` → Developer mode → Load unpacked → this directory.
2. Scout icon → Settings → paste a [Gemini API key](https://aistudio.google.com/app/apikey) → Save.

## Use

Open any video, click **Save to Scout** next to Subscribe. 3–10s later, products show up. Click the Scout icon or **Expand ↗** to browse saves, favourite items, take notes.

## How

A service worker pulls the description, transcript, top comments, and YouTube's storyboard mosaic sheets (dense timeline frames). Gemini 2.5 Flash extracts products as structured JSON. Heuristic + synthetic fallbacks so the list is never empty. Everything lives in `chrome.storage.local` — no backend.

## Dev

Manifest V3, vanilla JS, no build step. Edit, reload from `chrome://extensions`.

Icons: `node tools/make-icons.js`
