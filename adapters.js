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

  // ─── Gemini ────────────────────────────────────────────────
  {
    name: 'gemini',
    hostPattern: 'gemini.google.com',
    urlPatterns: ['https://gemini.google.com/*'],

    getConversationId(url) {
      const match = url.match(/\/app\/([^/?#]+)/);
      return match ? match[1] : null;
    },

    // A broad selector since Gemini's Angular app might shift specific wrappers
    chatContainerSelector: 'chat-app, main, [role="main"], body',

    scanMessages() {
      // Find all turn containers
      const containers = document.querySelectorAll('.conversation-container');
      const messages = [];

      containers.forEach((container, index) => {
        // The user text is inside .query-text-line
        const queryEls = container.querySelectorAll('.query-text-line');
        if (queryEls.length === 0) return;

        // Combine text if there are multiple paragraphs
        const fullText = Array.from(queryEls)
          .map((el) => el.textContent.trim())
          .join('\n')
          .trim();
        if (!fullText) return;

        // Use the native id if available, else fallback to hash
        const nativeId = container.id || null;
        const turnKey = nativeId || _hashTurnKey(fullText, index);

        messages.push({
          turnKey,
          fullText,
          turnIndex: index,
          element: container,
        });
      });

      return messages;
    },

    findElement(turnKey) {
      // Try by ID first if it was a native ID
      const el = document.getElementById(turnKey);
      if (el && el.classList.contains('conversation-container')) return el;

      // Fallback to data attribute
      return document.querySelector(
        `.conversation-container[data-nblm-turn-key="${turnKey}"]`
      );
    },

    applyVisibility(visibleKeys) {
      const containers = document.querySelectorAll('.conversation-container');
      const showAll = visibleKeys.size === 0;

      containers.forEach((container) => {
        const turnKey = container.dataset.nblmTurnKey;
        if (showAll || visibleKeys.has(turnKey)) {
          container.style.display = '';
        } else {
          container.style.display = 'none';
        }
      });
    },
  },

  // ─── Claude ─────────────────────────────────────────────────
  {
    name: 'claude',
    hostPattern: 'claude.ai',
    urlPatterns: ['https://claude.ai/*'],

    getConversationId(url) {
      const match = url.match(/\/chat\/([^/?#]+)/);
      return match ? match[1] : null;
    },

    // 'main' is stable semantic HTML that contains all chat messages.
    // MutationObserver uses subtree:true so this ancestor is sufficient.
    chatContainerSelector: 'main',

    /**
     * Claude uses data-user-message-bubble="true" for user messages.
     * Actual text content lives inside [data-testid="user-message"].
     * Messages are NOT paired in a wrapper — they sit as siblings.
     */
    scanMessages() {
      const userMsgs = document.querySelectorAll(
        '[data-user-message-bubble="true"]'
      );
      const messages = [];

      userMsgs.forEach((msgEl, index) => {
        const textEl = msgEl.querySelector('[data-testid="user-message"]');
        const fullText = textEl
          ? textEl.textContent.trim()
          : msgEl.textContent.trim();
        if (!fullText) return;

        const turnKey = _hashTurnKey(fullText, index);

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
      return document.querySelector(
        `[data-user-message-bubble="true"][data-nblm-turn-key="${turnKey}"]`
      );
    },

    applyVisibility(visibleKeys) {
      const userMsgs = document.querySelectorAll(
        '[data-user-message-bubble="true"]'
      );
      const showAll = visibleKeys.size === 0;

      userMsgs.forEach((msgEl) => {
        const turnKey = msgEl.dataset.nblmTurnKey;
        const assistantEl = _findClaudeAssistantReply(msgEl);

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
 * For Claude: find the assistant reply following a user message.
 * User messages ([data-user-message-bubble]) and assistant replies
 * ([data-test-render-count]) are siblings or near-siblings in the DOM.
 * We walk up from the user bubble to its nearest turn-level ancestor,
 * then scan subsequent siblings for the assistant block.
 */
function _findClaudeAssistantReply(userMsgEl) {
  // Walk up to find the turn-level wrapper (the div that contains the bubble)
  let wrapper = userMsgEl.parentElement;
  // Keep walking up until we find a sibling that contains the assistant reply,
  // or we hit a reasonable ancestor (max 5 levels)
  for (let i = 0; i < 5 && wrapper; i++) {
    let sibling = wrapper.nextElementSibling;
    while (sibling) {
      // Check if this sibling IS or CONTAINS the assistant reply
      if (sibling.hasAttribute('data-test-render-count') ||
          sibling.querySelector('[data-test-render-count]')) {
        return sibling;
      }
      // If we hit another user message, stop — no assistant reply in between
      if (sibling.hasAttribute('data-user-message-bubble') ||
          sibling.querySelector('[data-user-message-bubble]')) {
        break;
      }
      sibling = sibling.nextElementSibling;
    }
    wrapper = wrapper.parentElement;
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
