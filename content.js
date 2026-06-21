/**
 * Chat Tag & Filter — Content Script
 *
 * Platform-agnostic content script that:
 *  1. Detects which chat platform is active (via adapters.js)
 *  2. Scans user messages from the chat panel
 *  3. Responds to sidebar requests for message data
 *  4. Scrolls to a specific message on command
 *  5. Watches for DOM changes (new messages, scroll-loaded old messages)
 *  6. Watches for URL changes (conversation switch in SPA)
 *
 * Platform-specific logic lives in adapters.js.
 */

(() => {
  'use strict';

  // Guard against double-injection (programmatic + manifest)
  if (window.__nblmContentScriptLoaded) return;
  window.__nblmContentScriptLoaded = true;

  // ─── Detect Platform ──────────────────────────────────────
  const platform = detectPlatform();
  if (!platform) {
    console.warn('[content.js] No platform adapter found for', window.location.hostname);
    return;
  }
  console.log('[content.js] Platform detected:', platform.name);

  let currentObserver = null;
  let lastUrl = window.location.href;

  /**
   * Scan all user messages using the platform adapter.
   * Returns array of { turnKey, fullText, turnIndex }.
   * Also tags each element with data-nblm-turn-key for lookup.
   */
  function scanMessages() {
    const results = platform.scanMessages();

    // Tag each element with the turnKey for scroll/filter lookup
    results.forEach((msg) => {
      if (msg.element) {
        msg.element.dataset.nblmTurnKey = msg.turnKey;
      }
    });

    // Return without the element reference (not serializable for messaging)
    return results.map(({ turnKey, fullText, turnIndex }) => ({
      turnKey,
      fullText,
      turnIndex,
    }));
  }

  /**
   * Scroll to the message with the given turnKey.
   */
  function scrollToMessage(turnKey) {
    const el = platform.findElement(turnKey)
      || document.querySelector(`[data-nblm-turn-key="${turnKey}"]`);

    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Brief highlight effect
      el.style.outline = '2px solid #8ab4f8';
      el.style.outlineOffset = '2px';
      el.style.borderRadius = '8px';
      el.style.transition = 'outline-color 1.5s ease';
      setTimeout(() => {
        el.style.outlineColor = 'transparent';
        setTimeout(() => {
          el.style.outline = '';
          el.style.outlineOffset = '';
          el.style.borderRadius = '';
          el.style.transition = '';
        }, 1500);
      }, 800);
    }
  }

  /**
   * Apply visibility filters using the platform adapter.
   * visibleKeys: array of turnKeys to show (empty = show all).
   */
  function applyFilters(visibleKeys) {
    platform.applyVisibility(new Set(visibleKeys));
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
        sendResponse({ messages, platform: platform.name });
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

  // ─── Observe chat container for new/loaded messages ────────

  function observeChat() {
    if (currentObserver) {
      currentObserver.disconnect();
      currentObserver = null;
    }

    const container = document.querySelector(platform.chatContainerSelector);
    if (!container) return;

    let debounceTimer;
    currentObserver = new MutationObserver((mutations) => {
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

    currentObserver.observe(container, { childList: true, subtree: true });
  }

  // ─── Detect URL changes (SPA navigation) ──────────────────

  function watchUrlChanges() {
    setInterval(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        console.log('[content.js] URL changed to:', currentUrl);
        notifySidebar({ type: 'NOTEBOOK_CHANGED', url: currentUrl });
        waitForChat();
      }
    }, 500);
  }

  // ─── Wait for chat container to appear, then start ─────────

  function waitForChat(attempt = 0) {
    const container = document.querySelector(platform.chatContainerSelector);
    if (container) {
      const msgs = scanMessages();
      console.log(`[content.js] ${platform.name} chat found, scanned ${msgs.length} messages`);
      observeChat();
      notifySidebar({ type: 'MESSAGES_UPDATED' });
    } else if (attempt < 30) {
      setTimeout(() => waitForChat(attempt + 1), 500);
    }
  }

  // ─── Bootstrap ─────────────────────────────────────────────
  waitForChat();
  watchUrlChanges();
})();
