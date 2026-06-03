/**
 * NotebookLM Tag & Filter — Content Script (v2)
 *
 * Lightweight content script that:
 *  1. Scans user messages from the chat panel
 *  2. Responds to sidebar requests for message data
 *  3. Scrolls to a specific message on command
 *  4. Watches for DOM changes (new messages, scroll-loaded old messages)
 *  5. Watches for URL changes (notebook switch in SPA)
 *
 * DOM Structure (as of 2026-06):
 *   .chat-panel-content
 *     ├── div.chat-message-pair
 *     │     ├── chat-message.individual-message
 *     │     │     └── div.from-user-container      ← user turn
 *     │     └── chat-message.individual-message
 *     │           └── div.to-user-container        ← model turn
 */

(() => {
  'use strict';

  // Guard against double-injection (programmatic + manifest)
  if (window.__nblmContentScriptLoaded) return;
  window.__nblmContentScriptLoaded = true;

  const SELECTORS = {
    chatContent: '.chat-panel-content',
    messagePair: '.chat-message-pair',
    userContent: '.from-user-container',
  };

  let currentObserver = null;
  let lastUrl = window.location.href;

  /**
   * Generate a stable key for a conversation turn.
   * Uses the user message text hash for cross-reload stability.
   */
  function getTurnKey(userText, turnIndex) {
    const text = (userText || '').trim().slice(0, 100);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    return `turn_${turnIndex}_${hash}`;
  }

  /**
   * Scan all user messages in the chat panel.
   * Returns array of { turnKey, fullText, turnIndex }.
   */
  function scanMessages() {
    const chatContent = document.querySelector(SELECTORS.chatContent);
    if (!chatContent) return [];

    const pairs = chatContent.querySelectorAll(SELECTORS.messagePair);
    const messages = [];

    pairs.forEach((pair, index) => {
      const userEl = pair.querySelector(SELECTORS.userContent);
      const fullText = userEl ? userEl.textContent.trim() : '';
      if (!fullText) return;

      const turnKey = getTurnKey(fullText, index);

      // Store turnKey on the element for scroll-to lookup
      pair.dataset.nblmTurnKey = turnKey;

      messages.push({
        turnKey,
        fullText,
        turnIndex: index,
      });
    });

    return messages;
  }

  /**
   * Scroll the chat panel to the message with the given turnKey.
   */
  function scrollToMessage(turnKey) {
    const pair = document.querySelector(
      `.chat-message-pair[data-nblm-turn-key="${turnKey}"]`
    );
    if (pair) {
      pair.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight effect
      pair.style.outline = '2px solid #8ab4f8';
      pair.style.outlineOffset = '2px';
      pair.style.borderRadius = '8px';
      pair.style.transition = 'outline-color 1.5s ease';
      setTimeout(() => {
        pair.style.outlineColor = 'transparent';
        setTimeout(() => {
          pair.style.outline = '';
          pair.style.outlineOffset = '';
          pair.style.borderRadius = '';
          pair.style.transition = '';
        }, 1500);
      }, 800);
    }
  }

  /**
   * Apply visibility filters to chat-message-pair elements.
   * visibleKeys: array of turnKeys to show (empty = show all).
   */
  function applyFilters(visibleKeys) {
    const chatContent = document.querySelector(SELECTORS.chatContent);
    if (!chatContent) return;

    const pairs = chatContent.querySelectorAll(SELECTORS.messagePair);
    const keySet = new Set(visibleKeys);
    const showAll = keySet.size === 0;

    pairs.forEach((pair) => {
      const turnKey = pair.dataset.nblmTurnKey;
      if (showAll || keySet.has(turnKey)) {
        pair.style.display = '';
      } else {
        pair.style.display = 'none';
      }
    });
  }

  // ─── Safely send message to sidebar ────────────────────────
  function notifySidebar(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      // Extension context invalidated — ignore
    }
  }

  // ─── Message Listener ──────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'SCAN_MESSAGES': {
        const messages = scanMessages();
        sendResponse({ messages });
        return true;
      }
      case 'SCROLL_TO_MESSAGE': {
        scrollToMessage(message.turnKey);
        sendResponse({ ok: true });
        return true;
      }
      case 'APPLY_FILTERS': {
        applyFilters(message.visibleKeys || []);
        sendResponse({ ok: true });
        return true;
      }
      default:
        return false;
    }
  });

  // ─── Observe chat panel for new/loaded messages ────────────
  // Handles: #1 (scroll up → old messages) and #3 (send → new message)

  function observeChatContent() {
    // Disconnect previous observer if any
    if (currentObserver) {
      currentObserver.disconnect();
      currentObserver = null;
    }

    const chatContent = document.querySelector(SELECTORS.chatContent);
    if (!chatContent) return;

    let debounceTimer;
    currentObserver = new MutationObserver((mutations) => {
      // Only react to actual child additions (new message pairs)
      const hasRelevantChange = mutations.some(
        (m) => m.type === 'childList' && m.addedNodes.length > 0
      );
      if (!hasRelevantChange) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        scanMessages();
        notifySidebar({ type: 'MESSAGES_UPDATED' });
      }, 300);
    });

    currentObserver.observe(chatContent, { childList: true, subtree: true });
  }

  // ─── Detect URL changes (SPA notebook navigation) ─────────
  // Handles: #2 (open new notebook → sidebar refreshes)

  function watchUrlChanges() {
    // Poll for URL changes since NotebookLM is a SPA
    setInterval(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        console.log('[content.js] URL changed to:', currentUrl);

        // Notify sidebar that notebook changed
        notifySidebar({ type: 'NOTEBOOK_CHANGED', url: currentUrl });

        // Re-initialize: wait for new chat panel to appear, then observe it
        waitForChatPanel();
      }
    }, 500);
  }

  // ─── Wait for chat panel to appear, then start observing ───

  function waitForChatPanel(attempt = 0) {
    const chatContent = document.querySelector(SELECTORS.chatContent);
    if (chatContent) {
      const msgs = scanMessages();
      console.log('[content.js] Chat panel found, scanned', msgs.length, 'messages');
      observeChatContent();
      notifySidebar({ type: 'MESSAGES_UPDATED' });
    } else if (attempt < 30) {
      setTimeout(() => waitForChatPanel(attempt + 1), 500);
    }
  }

  // ─── Bootstrap ─────────────────────────────────────────────
  waitForChatPanel();
  watchUrlChanges();
})();
