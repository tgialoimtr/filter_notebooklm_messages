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
   * If not in DOM, jump to the bottom and auto-scroll UP to find it.
   */
  async function scrollToMessage(turnKey) {
    let el = platform.findElement(turnKey) || document.querySelector(`[data-nblm-turn-key="${turnKey}"]`);

    if (!el) {
      console.log(`[content.js] Message ${turnKey} not in DOM. Jumping to bottom and seeking UP.`);
      let attempts = 0;
      const direction = -1; // Always seek up from bottom
      
      // Dynamically find ALL scrollable containers on the page
      const possibleContainers = Array.from(document.querySelectorAll('*')).filter(c => {
        const style = window.getComputedStyle(c);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && c.scrollHeight > c.clientHeight;
      });
      if (document.scrollingElement) possibleContainers.push(document.scrollingElement);

      // 1. Jump to absolute bottom
      window.scrollTo(0, document.body.scrollHeight);
      possibleContainers.forEach(c => { c.scrollTop = c.scrollHeight; });
      await new Promise(r => setTimeout(r, 300)); // Give React extra time to render the bottom anchor

      el = platform.findElement(turnKey) || document.querySelector(`[data-nblm-turn-key="${turnKey}"]`);

      // 2. Seek UP
      const maxAttempts = 150;
      const scrollStep = Math.min(window.innerHeight * 0.85, 800);

      while (!el && attempts < maxAttempts) {
        let actuallyScrolled = false;
        
        const prevScrollY = window.scrollY;
        const prevPositions = possibleContainers.map(c => c.scrollTop);

        // Try scrolling window and all containers UP
        window.scrollBy(0, direction * scrollStep);
        possibleContainers.forEach(c => {
          if (c.scrollBy) {
            c.scrollBy({ top: direction * scrollStep, behavior: 'instant' });
          } else {
            c.scrollTop += direction * scrollStep;
          }
        });
        
        // Check if anything actually moved (allow 1px rounding diffs)
        if (Math.abs(window.scrollY - prevScrollY) > 1) actuallyScrolled = true;
        possibleContainers.forEach((c, idx) => {
          if (Math.abs(c.scrollTop - prevPositions[idx]) > 1) {
             actuallyScrolled = true;
          }
        });

        if (!actuallyScrolled) {
          console.warn(`[content.js] Reached top scroll boundary, cannot seek further UP.`);
          break;
        }

        await new Promise(r => setTimeout(r, 100)); // Faster wait for virtual DOM
        el = platform.findElement(turnKey) || document.querySelector(`[data-nblm-turn-key="${turnKey}"]`);
        attempts++;
      }
      
      if (!el) {
        console.warn(`[content.js] Auto-seek failed after ${attempts} attempts for: ${turnKey}`);
      } else {
        console.log(`[content.js] Found message after ${attempts} scroll attempts!`);
      }
    }

    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      chrome.runtime.sendMessage(msg).catch(() => { });
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
