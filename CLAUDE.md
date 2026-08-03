# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Long Thread Organizer" — a Manifest V3 Chrome extension (no build step, no package.json, no bundler). Plain JS/HTML/CSS loaded directly by Chrome. It lets users tag, filter, delete, and jump to their own messages inside long AI chat threads on NotebookLM, ChatGPT, Claude, and Gemini, plus attach rich-text notes to any message.

## Running / testing changes

There is no build, lint, or test command — this is unpacked JS loaded straight into Chrome.

1. Open `chrome://extensions/`, enable **Developer mode**.
2. **Load unpacked** and select the repo root (first time), or click the extension's reload icon after edits.
3. If only `sidepanel.*` or `settings.js`/`noteEditor.js` changed, closing and reopening the side panel is often enough. If `content.js`/`adapters.js`/`background.js`/`manifest.json` changed, use the extensions page reload button, then refresh the target chat tab.
4. Test against a live conversation on one of the 4 supported hosts (see `host_permissions` in `manifest.json`): `notebooklm.google.com`, `chatgpt.com`, `claude.ai`, `gemini.google.com`.
5. Use the tab's DevTools console for `content.js`/`adapters.js` logs (prefixed `[content.js]`), and the side panel's own DevTools (right-click panel → Inspect) for `sidepanel.js`/`settings.js`/`noteEditor.js` logs.

`a.html` and `b.html` at the repo root are standalone Tailwind-CDN design mockups (not referenced by `manifest.json` or loaded by the extension) — useful for visual reference on styling intent, not live code.

## Architecture

Three isolated JS contexts talk over `chrome.runtime`/`chrome.tabs` messaging; there is no shared module system (all files are loaded as plain scripts, no imports/exports).

- **`background.js`** — service worker. Opens the side panel on the toolbar icon click and enables/disables the side panel per-tab based on `SUPPORTED_HOSTS`.
- **`adapters.js` + `content.js`** — injected into the chat page itself (both by `manifest.json` content_scripts and, defensively, via `chrome.scripting.executeScript` from the side panel if messaging fails — see `ensureContentScript` in `sidepanel.js`).
  - `adapters.js` defines `PLATFORM_ADAPTERS`, one entry per supported site, each implementing the same interface: `getConversationId(url)`, `chatContainerSelector`, `scanMessages()`, `findElement(turnKey)`, `applyVisibility(visibleKeys)`. **All platform-specific DOM knowledge (selectors, message pairing logic) lives here — adding a new chat platform means adding one adapter object**, nothing else in `content.js` needs to change. `detectPlatform()` picks the adapter by hostname.
  - `content.js` is platform-agnostic glue: runs `detectPlatform()` once, scans messages, tags each DOM element with `data-nblm-turn-key`, handles `SCAN_MESSAGES`/`SCROLL_TO_MESSAGE`/`APPLY_FILTERS` messages from the side panel, and maintains a `MutationObserver` (debounced 300ms) on the platform's chat container plus a `setInterval` poll for SPA URL changes (conversation switches don't trigger full page loads).
  - Message identity: a `turnKey` is either a native platform ID (ChatGPT's `data-message-id`, Gemini's container `id`) or a fallback hash of the message's first 100 chars + index (`_hashTurnKey`). This key is the join point between DOM elements and stored tags/notes/deletion state.
- **`sidepanel.html`/`sidepanel.js`/`sidepanel.css`** — the side panel UI (runs in its own extension page context, not the chat page). Owns all persisted state (messages, tags, notes, deleted-message set) and pushes visibility decisions down to `content.js` via `APPLY_FILTERS`. Also injects `settings.js` (background/color picker) and instantiates `NoteEditor` (`noteEditor.js`) as sibling panels that swap visibility with the main message list (`#messageList`, `#settingsPanel`, `#noteEditorPanel` — only one shown at a time).

### State & storage model

- Everything is stored in `chrome.storage.local`, scoped per-conversation under key `chat_tags_<conversationId>` (see `storageKey()`/`saveData()`/`loadData()` in `sidepanel.js`). The stored shape is `{ messages, messageTags, messageNotes, allTags, deletedMessages }`.
- `conversationId` is parsed from the active tab's URL per-platform (regexes in both `getConversationIdFromTab()` in `sidepanel.js` and mirrored in each adapter's `getConversationId()` — keep these in sync if a platform's URL scheme changes).
- Notes (from `NoteEditor`) are stored as a small custom Markdown dialect (`_htmlToMarkdown`/`_markdownToHtml` in `noteEditor.js`), not raw HTML — only headings, bold/italic, and ul/ol are round-tripped.
- Deletion is a soft-delete: `deletedMessages` is a set of `turnKey`s, toggled via a trash view (`showingTrash`) rather than actually removing entries from `messages`.
- `mergeMessages()` in `sidepanel.js` reconciles freshly-scanned DOM messages with previously stored ones (matches by `turnKey`, updates changed text, inserts new messages at the correct position using neighboring keys as anchors) — this is what makes tags/notes survive page reloads and lazy-loaded scroll history.
- On conversation switch (`NOTEBOOK_CHANGED` message or tab activation), `handleNotebookChange()` snapshots current `turnKey`s into `staleKeys` so `scanMessages()` can detect and retry when the DOM hasn't caught up yet (still showing the old conversation's messages).

### Adding a new supported chat platform

1. Add a host entry to `manifest.json` (`host_permissions` and `content_scripts.matches`).
2. Add the hostname to `SUPPORTED_HOSTS` in `background.js`.
3. Add a new adapter object to `PLATFORM_ADAPTERS` in `adapters.js` implementing the full interface (see existing adapters for the shape); reuse `_hashTurnKey` for platforms without stable native message IDs.
4. Add a matching URL pattern to `URL_PATTERNS` in `getConversationIdFromTab()` in `sidepanel.js`.
5. Update the empty-state copy in `updateEmptyState()` (`sidepanel.js`) and the supported-platforms list in `README.md` if user-facing.

## Privacy constraint

All data (tags, notes, deleted-message state, custom background images) must stay in `chrome.storage.local` only — no network calls to external servers. This is a stated product guarantee in `README.md`; don't introduce telemetry or remote sync without flagging it explicitly.

**One deliberate exception:** `license.js` calls Lemon Squeezy's License API (`https://api.lemonsqueezy.com/v1/licenses/*`) to activate/validate a purchased license key for the trial/paywall flow (see `paywall.js`, gated in `sidepanel.js`'s `init()`). This is the only network call in the extension — it sends only the license key and a locally-generated instance identifier, never message/tag/note content. Keep this exception scoped to licensing; don't let it become a precedent for adding other remote calls without the same explicit flagging.
