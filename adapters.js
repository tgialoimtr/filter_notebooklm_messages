/**
 * Platform Adapters — Multi-platform chat message extraction
 *
 * Each adapter defines how to find and extract user messages
 * from a specific chat platform. The content script picks the
 * right adapter based on the current hostname.
 *
 * To add a new platform, add a new entry to PLATFORM_ADAPTERS.
 */

// eslint-disable-next-line no-unused-vars
const PLATFORM_ADAPTERS = [
  // ─── NotebookLM ────────────────────────────────────────────
  {
    name: 'notebooklm',
    hostPattern: 'notebooklm.google.com',
    urlPatterns: ['https://notebooklm.google.com/*'],

    /** Extract conversation ID from URL */
    getConversationId(url) {
      const match = url.match(/notebook\/([^/?#]+)/);
      return match ? match[1] : null;
    },

    /** CSS selector for the scrollable chat container */
    chatContainerSelector: '.chat-panel-content',

    /**
     * Scan all user messages from the DOM.
     * Returns array of { turnKey, fullText, turnIndex, element }.
     * `element` is the top-level element to tag with data-attr and scroll to.
     *
     * NotebookLM groups user+assistant into .chat-message-pair elements.
     */
    scanMessages() {
      const container = document.querySelector(this.chatContainerSelector);
      if (!container) return [];

      const pairs = container.querySelectorAll('.chat-message-pair');
      const messages = [];

      pairs.forEach((pair, index) => {
        const userEl = pair.querySelector('.from-user-container');
        const fullText = userEl ? userEl.textContent.trim() : '';
        if (!fullText) return;

        const turnKey = _hashTurnKey(fullText, index);

        messages.push({
          turnKey,
          fullText,
          turnIndex: index,
          element: pair,  // the element to scroll to and tag
        });
      });

      return messages;
    },

    /**
     * Given a turnKey, find the corresponding DOM element for scrolling.
     */
    findElement(turnKey) {
      return document.querySelector(
        `.chat-message-pair[data-nblm-turn-key="${turnKey}"]`
      );
    },

    /**
     * Apply visibility: hide/show message elements.
     * visibleKeys: Set of turnKeys to show. Empty = show all.
     */
    applyVisibility(visibleKeys) {
      const container = document.querySelector(this.chatContainerSelector);
      if (!container) return;

      const pairs = container.querySelectorAll('.chat-message-pair');
      const showAll = visibleKeys.size === 0;

      pairs.forEach((pair) => {
        const turnKey = pair.dataset.nblmTurnKey;
        pair.style.display = (showAll || visibleKeys.has(turnKey)) ? '' : 'none';
      });
    },
  },

  // ─── ChatGPT ───────────────────────────────────────────────
  {
    name: 'chatgpt',
    hostPattern: 'chatgpt.com',
    urlPatterns: ['https://chatgpt.com/*'],

    getConversationId(url) {
      const match = url.match(/\/c\/([^/?#]+)/);
      return match ? match[1] : null;
    },

    chatContainerSelector: '#thread',

    /**
     * ChatGPT uses flat message divs with data-message-author-role
     * and data-message-id attributes. Messages are NOT paired.
     * We only extract user messages.
     */
    scanMessages() {
      const container = document.querySelector(this.chatContainerSelector);
      if (!container) return [];

      const userMsgs = container.querySelectorAll(
        'div[data-message-author-role="user"]'
      );
      const messages = [];

      userMsgs.forEach((msgEl, index) => {
        // The actual text is in a nested div with whitespace-pre-wrap
        const textEl = msgEl.querySelector('[class*="whitespace-pre-wrap"]');
        const fullText = textEl ? textEl.textContent.trim() : msgEl.textContent.trim();
        if (!fullText) return;

        // Use ChatGPT's native message ID if available, fall back to hash
        const nativeId = msgEl.getAttribute('data-message-id');
        const turnKey = nativeId || _hashTurnKey(fullText, index);

        messages.push({
          turnKey,
          fullText,
          turnIndex: index,
          element: msgEl,
        });
      });

      return messages;
    },

    findElement(turnKey) {
      // Try native ID first
      const byId = document.querySelector(
        `div[data-message-id="${turnKey}"]`
      );
      if (byId) return byId;
      // Fall back to data attribute
      return document.querySelector(
        `[data-nblm-turn-key="${turnKey}"]`
      );
    },

    applyVisibility(visibleKeys) {
      const container = document.querySelector(this.chatContainerSelector);
      if (!container) return;

      const userMsgs = container.querySelectorAll(
        'div[data-message-author-role="user"]'
      );
      const showAll = visibleKeys.size === 0;

      userMsgs.forEach((msgEl) => {
        const turnKey = msgEl.dataset.nblmTurnKey;
        // For ChatGPT, we also need to hide the following assistant message
        const assistantEl = _findNextAssistant(msgEl);

        if (showAll || visibleKeys.has(turnKey)) {
          msgEl.style.display = '';
          if (assistantEl) assistantEl.style.display = '';
        } else {
          msgEl.style.display = 'none';
          if (assistantEl) assistantEl.style.display = 'none';
        }
      });
    },
  },

  // ─── Gemini (placeholder — fill in after DOM inspection) ───
  // {
  //   name: 'gemini',
  //   hostPattern: 'gemini.google.com',
  //   urlPatterns: ['https://gemini.google.com/*'],
  //   getConversationId(url) { ... },
  //   chatContainerSelector: '...',
  //   scanMessages() { ... },
  //   findElement(turnKey) { ... },
  //   applyVisibility(visibleKeys) { ... },
  // },

  // ─── Claude (placeholder — fill in after DOM inspection) ───
  // {
  //   name: 'claude',
  //   hostPattern: 'claude.ai',
  //   urlPatterns: ['https://claude.ai/*'],
  //   ...
  // },

  // ─── Grok (placeholder — fill in after DOM inspection) ─────
  // {
  //   name: 'grok',
  //   hostPattern: 'grok.com',
  //   urlPatterns: ['https://grok.com/*'],
  //   ...
  // },
];

// ─── Shared Helpers ─────────────────────────────────────────

/**
 * Generate a stable hash-based turn key.
 * Used as fallback when the platform doesn't provide native IDs.
 */
function _hashTurnKey(text, index) {
  const t = (text || '').trim().slice(0, 100);
  let hash = 0;
  for (let i = 0; i < t.length; i++) {
    hash = ((hash << 5) - hash) + t.charCodeAt(i);
    hash |= 0;
  }
  return `turn_${index}_${hash}`;
}

/**
 * For ChatGPT: find the next assistant message after a user message.
 * They're siblings at the same level.
 */
function _findNextAssistant(userMsgEl) {
  // Walk up to the article/section wrapper, then find next sibling
  let wrapper = userMsgEl.closest('article, [data-testid*="conversation-turn"]');
  if (wrapper) {
    const next = wrapper.nextElementSibling;
    if (next && next.querySelector('[data-message-author-role="assistant"]')) {
      return next;
    }
  }
  return null;
}

/**
 * Detect which platform adapter matches the current hostname.
 * Returns the adapter object or null.
 */
function detectPlatform() {
  const hostname = window.location.hostname;
  return PLATFORM_ADAPTERS.find(a => hostname.includes(a.hostPattern)) || null;
}
