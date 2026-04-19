/**
 * @typedef {Object} VideoMeta
 * @property {string} videoId        - YouTube video ID (e.g. "dQw4w9WgXcQ")
 * @property {string} url            - Full watch URL
 * @property {string} title
 * @property {string} channel
 * @property {string} channelUrl
 * @property {string} thumbnailUrl
 * @property {string} description    - May be truncated
 * @property {number} savedAt        - Unix ms
 */

/**
 * @typedef {Object} Product
 * @property {string} name           - Short product name
 * @property {string|null} brand
 * @property {string|null} category  - e.g. "top", "shoes", "accessory"
 * @property {string} searchQuery    - What to search on Google Shopping
 * @property {number} confidence     - 0..1
 * @property {string|null} timestamp - "mm:ss" if mentioned at a specific point, else null
 */

/**
 * @typedef {Object} SavedItem
 * @property {string} id             - ULID or `${videoId}-${savedAt}`
 * @property {VideoMeta} video
 * @property {Product[]} products
 * @property {"pending" | "ready" | "error"} status
 * @property {string|null} error
 * @property {"gemini"|"openrouter"|"openai"|"heuristic"|null} [extractedWith]
 */

/**
 * @typedef {Object} Settings
 * @property {"none"|"gemini"|"openrouter"|"openai"} provider
 * @property {string|null} geminiApiKey
 * @property {string|null} openrouterApiKey
 * @property {string|null} openaiApiKey
 * @property {string|null} geminiModel      - null = use default
 * @property {string|null} openrouterModel  - null = use default
 * @property {string|null} openaiModel      - null = use default
 */
