/**
 * Chat Tag & Filter — Sidebar Panel Script (v3)
 *
 * Manages the sidebar UI: message table, tags, and filter dropdowns.
 * Platform-agnostic — works with NotebookLM, ChatGPT, and more.
 * Communicates with the content script via chrome.runtime messaging.
 */

(() => {
  'use strict';

  // ─── State ──────────────────────────────────────────────────
  const STORAGE_PREFIX = 'chat_tags_';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let messages = [];         // { turnKey, fullText, turnIndex }
  let messageTags = {};      // turnKey → [tag, ...]
  let allTags = new Set();
  let activeTagFilters = new Set();
  let tagDropdownOpen = false;
  let showingTrash = false;
  let deletedMessages = new Set();
  let conversationId = 'unknown';
  
  // Cross-contamination prevention
  let staleKeys = new Set(); 
  let navigationLock = null;
  let lastVisibleKeys = []; // tracks currently visible turnKeys for scroll direction

  // ─── DOM References ────────────────────────────────────────
  const tableBody = document.getElementById('messageTableBody');
  const emptyState = document.getElementById('emptyState');
  const btnFilterTags = document.getElementById('btnFilterTags');
  const btnTrashcan = document.getElementById('btnTrashcan');
  const tagDropdown = document.getElementById('tagDropdown');
  const tagBadge = document.getElementById('tagBadge');

  // ─── Utilities ─────────────────────────────────────────────

  /**
   * Extract a conversation ID from the active tab's URL.
   * Supports multiple platforms via URL pattern matching.
   */
  function getConversationIdFromTab(explicitUrl = null) {
    const URL_PATTERNS = [
      /notebooklm\.google\.com\/notebook\/([^/?#]+)/,  // NotebookLM
      /chatgpt\.com\/c\/([^/?#]+)/,                     // ChatGPT
      /gemini\.google\.com\/app\/([^/?#]+)/,            // Gemini (future)
      /claude\.ai\/chat\/([^/?#]+)/,                    // Claude (future)
    ];

    const matchUrl = (url) => {
      for (const pattern of URL_PATTERNS) {
        const match = url.match(pattern);
        if (match) return match[1];
      }
      return 'unknown';
    };

    if (explicitUrl) {
      return Promise.resolve(matchUrl(explicitUrl));
    }

    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.url) {
          resolve(matchUrl(tabs[0].url));
          return;
        }
        resolve('unknown');
      });
    });
  }

  function storageKey() {
    return STORAGE_PREFIX + conversationId;
  }

  async function saveData() {
    const key = storageKey();
    const data = {
      messages, // <-- persist accumulated messages
      messageTags,
      allTags: Array.from(allTags),
      deletedMessages: Array.from(deletedMessages),
    };
    await chrome.storage.local.set({ [key]: data });
  }

  async function loadData() {
    const key = storageKey();
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        if (result[key]) {
          messages = result[key].messages || []; // <-- load accumulated messages
          messageTags = result[key].messageTags || {};
          allTags = new Set(result[key].allTags || []);
          deletedMessages = new Set(result[key].deletedMessages || []);
        } else {
          messages = [];
          messageTags = {};
          allTags = new Set();
          deletedMessages = new Set();
        }
        resolve();
      });
    });
  }

  let contentScriptInjected = false;

  /**
   * Inject content script programmatically into the given tab.
   * Needed when the tab was already open before the extension loaded.
   */
  async function ensureContentScript(tabId) {
    if (contentScriptInjected) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['adapters.js', 'content.js'],
      });
      contentScriptInjected = true;
      console.log('Content script injected into tab', tabId);
      // Give the script a moment to initialize
      await new Promise((r) => setTimeout(r, 800));
    } catch (err) {
      console.warn('Failed to inject content script:', err.message);
    }
  }

  function sendToContentScript(message) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (chrome.runtime.lastError) {
          console.warn('tabs.query error:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        const tab = tabs[0];
        if (!tab?.id) {
          console.warn('No active tab found');
          resolve(null);
          return;
        }

        // First attempt
        let response = await trySendMessage(tab.id, message);
        if (response !== null) {
          resolve(response);
          return;
        }

        // If first attempt failed, inject content script and retry
        console.log('First sendMessage failed — injecting content script...');
        await ensureContentScript(tab.id);
        response = await trySendMessage(tab.id, message);
        resolve(response);
      });
    });
  }

  function trySendMessage(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('sendMessage error:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response);
      });
    });
  }

  function shortenText(text, maxLen = 80) {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '…';
  }

  function createCheckSVG() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'sp-dropdown-check-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z');
    svg.appendChild(path);
    return svg;
  }

  // ─── Merge Messages (Virtual Scrolling Support) ─────────────
  
  function mergeMessages(incoming) {
    if (!incoming || incoming.length === 0) return false;
    if (messages.length === 0) {
      messages = incoming;
      return true;
    }

    let changed = false;
    const existingKeys = messages.map(m => m.turnKey);
    
    // First pass: update text in case it changed (e.g. edited message)
    for (const incMsg of incoming) {
      const idx = existingKeys.indexOf(incMsg.turnKey);
      if (idx !== -1) {
        if (messages[idx].fullText !== incMsg.fullText) {
          messages[idx].fullText = incMsg.fullText;
          changed = true;
        }
      }
    }

    // Second pass: insert new messages in the correct relative position
    for (let i = 0; i < incoming.length; i++) {
      const incMsg = incoming[i];
      if (!existingKeys.includes(incMsg.turnKey)) {
        
        // Find the closest previous incoming message that IS in our known list
        let prevAnchorKey = null;
        for (let j = i - 1; j >= 0; j--) {
          if (existingKeys.includes(incoming[j].turnKey)) {
            prevAnchorKey = incoming[j].turnKey;
            break;
          }
        }

        // Find the closest next incoming message that IS in our known list
        let nextAnchorKey = null;
        for (let j = i + 1; j < incoming.length; j++) {
          if (existingKeys.includes(incoming[j].turnKey)) {
            nextAnchorKey = incoming[j].turnKey;
            break;
          }
        }

        if (prevAnchorKey) {
          // Insert right after the previous anchor
          const insertIdx = existingKeys.indexOf(prevAnchorKey) + 1;
          messages.splice(insertIdx, 0, incMsg);
          existingKeys.splice(insertIdx, 0, incMsg.turnKey); // Keep keys sync'd
          changed = true;
        } else if (nextAnchorKey) {
          // Insert right before the next anchor
          const insertIdx = existingKeys.indexOf(nextAnchorKey);
          messages.splice(insertIdx, 0, incMsg);
          existingKeys.splice(insertIdx, 0, incMsg.turnKey);
          changed = true;
        } else {
          // Absolute fallback: No overlap (e.g. huge jump), push to end
          messages.push(incMsg);
          existingKeys.push(incMsg.turnKey);
          changed = true;
        }
      }
    }
    return changed;
  }

  // ─── Scan Messages from Content Script ─────────────────────

  async function scanMessages(retries = 5, delay = 500) {
    if (navigationLock) return;

    const response = await sendToContentScript({ type: 'SCAN_MESSAGES' });
    if (response?.messages) {
      // If the DOM still contains messages from the previous topic, it's stale!
      const isStaleDOM = response.messages.some(m => staleKeys.has(m.turnKey));
      if (isStaleDOM) {
        console.warn('Scan aborted: DOM still contains stale messages from previous topic. Retrying...');
        if (retries > 0) setTimeout(() => scanMessages(retries - 1, delay * 1.5), delay);
        return;
      }

      lastVisibleKeys = response.messages.map(m => m.turnKey);
      const changed = mergeMessages(response.messages);
      if (changed) {
        saveData(); // Persist newly discovered messages
      }
      renderTable();
      updateEmptyState();
    } else if (retries > 0) {
      // Content script may not be ready yet — retry with backoff
      console.log(`scanMessages: no response, retrying in ${delay}ms (${retries} left)`);
      setTimeout(() => scanMessages(retries - 1, delay * 1.5), delay);
    } else {
      console.warn('scanMessages: content script never responded');
      updateEmptyState();
    }
  }

  // ─── Popover Management ─────────────────────────────────────
  let activePopover = null; // currently open popover element

  function closeActivePopover() {
    if (activePopover) {
      activePopover.classList.remove('open');
      activePopover = null;
    }
  }

  // Close popover when clicking outside
  document.addEventListener('click', (e) => {
    if (activePopover && !activePopover.contains(e.target) &&
      !e.target.closest('.sp-icon-btn')) {
      closeActivePopover();
    }
  });

  // ─── Render Table ──────────────────────────────────────────

  function renderTable() {
    closeActivePopover();
    // Clear
    while (tableBody.firstChild) tableBody.removeChild(tableBody.firstChild);

    messages.forEach((msg) => {
      // If showing trash, only include deleted messages. Else, exclude deleted messages.
      if (showingTrash) {
        if (!deletedMessages.has(msg.turnKey)) return;
      } else {
        if (deletedMessages.has(msg.turnKey)) return;
      }

      const tr = document.createElement('tr');
      tr.dataset.turnKey = msg.turnKey;

      // ─ Message cell ─
      const tdMsg = document.createElement('td');
      tdMsg.className = 'sp-cell-message';
      tdMsg.title = msg.fullText;

      const msgSpan = document.createElement('span');
      msgSpan.className = 'sp-message-text';
      msgSpan.textContent = shortenText(msg.fullText);
      tdMsg.appendChild(msgSpan);

      tdMsg.addEventListener('click', () => {
        sendToContentScript({ type: 'SCROLL_TO_MESSAGE', turnKey: msg.turnKey });
      });

      // ─ Icons cell ─
      const tdMeta = document.createElement('td');
      tdMeta.className = 'sp-cell-meta';

      const iconsRow = document.createElement('div');
      iconsRow.className = 'sp-icons-row';

      if (showingTrash) {
        // Recover button
        const btnRecover = document.createElement('button');
        btnRecover.className = 'sp-btn-recover';
        btnRecover.textContent = 'Recover';
        btnRecover.addEventListener('click', (e) => {
          e.stopPropagation();
          recoverMessage(msg.turnKey);
        });
        iconsRow.appendChild(btnRecover);
      } else {
        // Tag icon button + popover
        const tags = messageTags[msg.turnKey] || [];
        iconsRow.appendChild(createTagIconBtn(msg.turnKey, tags));

        // Delete icon button
        const btnDelete = document.createElement('button');
        btnDelete.className = 'sp-icon-btn sp-icon-delete';
        btnDelete.title = 'Delete message';
        btnDelete.appendChild(createDeleteSVG());
        btnDelete.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteMessage(msg.turnKey);
        });
        iconsRow.appendChild(btnDelete);
      }

      tdMeta.appendChild(iconsRow);

      tr.appendChild(tdMsg);
      tr.appendChild(tdMeta);

      // Apply current filter visibility
      if (!isRowVisible(msg.turnKey)) {
        tr.classList.add('sp-row-hidden');
      }

      tableBody.appendChild(tr);
    });
  }

  // ─── Tag Icon Button + Popover ─────────────────────────────

  function createTagIconBtn(turnKey, tags) {
    const wrapper = document.createElement('div');
    wrapper.className = 'sp-icon-wrapper';

    // Icon button
    const btn = document.createElement('button');
    btn.className = 'sp-icon-btn sp-icon-tag';
    btn.title = tags.length > 0 ? `Tags: ${tags.join(', ')}` : 'Add tags';
    btn.appendChild(createTagSVG());

    // Badge showing tag count
    if (tags.length > 0) {
      const badge = document.createElement('span');
      badge.className = 'sp-icon-badge sp-icon-badge-tag';
      badge.textContent = tags.length;
      btn.appendChild(badge);
    }

    // Popover
    const popover = document.createElement('div');
    popover.className = 'sp-popover';
    buildTagPopoverContent(popover, turnKey);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover(popover);
    });

    wrapper.appendChild(btn);
    wrapper.appendChild(popover);
    return wrapper;
  }

  function buildTagPopoverContent(popover, turnKey) {
    while (popover.firstChild) popover.removeChild(popover.firstChild);

    const tags = messageTags[turnKey] || [];

    // Tag pills
    tags.forEach((tag) => {
      popover.appendChild(createTagPill(tag, turnKey));
    });

    // Add tag input
    popover.appendChild(createTagInput(turnKey));
  }

  function togglePopover(popover) {
    if (activePopover === popover) {
      closeActivePopover();
    } else {
      closeActivePopover();
      popover.classList.add('open');
      activePopover = popover;
    }
  }

  // ─── SVG Icon Helpers ──────────────────────────────────────

  function createTagSVG() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'sp-icon-svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS(SVG_NS, 'path');
    // Tag/label icon
    path.setAttribute('d', 'M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z');
    svg.appendChild(path);
    return svg;
  }

  function createDeleteSVG() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'sp-icon-svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z');
    svg.appendChild(path);
    return svg;
  }

  function updateEmptyState() {
    if (messages.length === 0) {
      emptyState.classList.add('visible');
    } else {
      emptyState.classList.remove('visible');
    }
  }

  // ─── Tag Pill ──────────────────────────────────────────────

  function createTagPill(tagText, turnKey) {
    const pill = document.createElement('span');
    pill.className = 'sp-tag-pill';
    pill.textContent = tagText;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'sp-tag-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove tag';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTag(turnKey, tagText);
    });

    pill.appendChild(removeBtn);
    return pill;
  }

  // ─── Tag Input ─────────────────────────────────────────────

  function createTagInput(turnKey) {
    const wrapper = document.createElement('span');
    wrapper.className = 'sp-tag-add-wrapper';

    const input = document.createElement('input');
    input.className = 'sp-tag-input';
    input.type = 'text';
    input.placeholder = 'Add tag';
    input.setAttribute('aria-label', 'Add a tag');

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = input.value.trim().toLowerCase();
        if (value) {
          addTag(turnKey, value);
          input.value = '';
        }
      } else if (e.key === 'Escape') {
        input.blur();
      }
    });

    wrapper.appendChild(input);
    return wrapper;
  }

  // ─── Tag CRUD ──────────────────────────────────────────────

  function addTag(turnKey, tagText) {
    if (!messageTags[turnKey]) messageTags[turnKey] = [];
    if (messageTags[turnKey].includes(tagText)) return;

    messageTags[turnKey].push(tagText);
    allTags.add(tagText);
    saveData();
    renderTable();
    refreshTagDropdown();
  }

  function removeTag(turnKey, tagText) {
    if (!messageTags[turnKey]) return;
    messageTags[turnKey] = messageTags[turnKey].filter((t) => t !== tagText);
    if (messageTags[turnKey].length === 0) delete messageTags[turnKey];

    rebuildAllTags();
    saveData();
    renderTable();
    refreshTagDropdown();
    applyFilters();
  }

  function rebuildAllTags() {
    allTags.clear();
    Object.values(messageTags).forEach((tags) => {
      tags.forEach((t) => allTags.add(t));
    });
  }

  // ─── Delete & Recover ───────────────────────────────────────

  function deleteMessage(turnKey) {
    deletedMessages.add(turnKey);
    saveData();
    renderTable();
    updateEmptyState();
    applyFilters();
  }

  function recoverMessage(turnKey) {
    deletedMessages.delete(turnKey);
    saveData();
    renderTable();
    updateEmptyState();
    applyFilters();
  }

  function toggleTrash() {
    showingTrash = !showingTrash;
    const btnTrash = document.getElementById('btnTrashcan');
    if (showingTrash) {
      btnTrash.classList.add('active');
      activeTagFilters.clear();
      updateTagBadge();
    } else {
      btnTrash.classList.remove('active');
    }
    renderTable();
    updateEmptyState();
    applyFilters();
  }

  // ─── Filter Logic ─────────────────────────────────────────

  function isRowVisible(turnKey) {
    if (showingTrash) {
      return deletedMessages.has(turnKey);
    }
    if (deletedMessages.has(turnKey)) {
      return false;
    }
    const tagMatch = activeTagFilters.size === 0 ||
      (messageTags[turnKey] || []).some((t) => activeTagFilters.has(t));
    return tagMatch;
  }

  function applyFilters() {
    // Update table row visibility
    const rows = tableBody.querySelectorAll('tr');
    const visibleKeys = [];
    const allVisibleIfEmpty = !showingTrash && activeTagFilters.size === 0;

    rows.forEach((row) => {
      const turnKey = row.dataset.turnKey;
      if (isRowVisible(turnKey)) {
        row.classList.remove('sp-row-hidden');
      } else {
        row.classList.add('sp-row-hidden');
      }
    });

    // Determine which keys to pass to content script to show in chat
    // Chat panel should hide deleted messages unless showingTrash is true
    messages.forEach((msg) => {
      if (showingTrash) {
        if (deletedMessages.has(msg.turnKey)) visibleKeys.push(msg.turnKey);
      } else {
        if (!deletedMessages.has(msg.turnKey) && isRowVisible(msg.turnKey)) {
          visibleKeys.push(msg.turnKey);
        }
      }
    });

    // Tell content script to hide/show messages in the chat panel
    sendToContentScript({
      type: 'APPLY_FILTERS',
      visibleKeys: (allVisibleIfEmpty && deletedMessages.size === 0) ? [] : visibleKeys,
    });
  }

  // ─── Tag Dropdown ──────────────────────────────────────────

  btnFilterTags.addEventListener('click', (e) => {
    e.stopPropagation();
    if (showingTrash) {
      showingTrash = false;
      btnTrashcan.classList.remove('active');
      renderTable();
      updateEmptyState();
      applyFilters();
    }

    tagDropdownOpen = !tagDropdownOpen;
    if (tagDropdownOpen) {
      refreshTagDropdown();
      tagDropdown.classList.add('open');
    } else {
      tagDropdown.classList.remove('open');
    }
  });

  function refreshTagDropdown() {
    while (tagDropdown.firstChild) tagDropdown.removeChild(tagDropdown.firstChild);

    if (allTags.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'sp-dropdown-empty';
      empty.textContent = 'No tags yet. Add tags to messages.';
      tagDropdown.appendChild(empty);
      return;
    }

    Array.from(allTags).sort().forEach((tag) => {
      const item = createDropdownItem(tag, activeTagFilters.has(tag));
      item.addEventListener('click', () => {
        if (activeTagFilters.has(tag)) activeTagFilters.delete(tag);
        else activeTagFilters.add(tag);
        refreshTagDropdown();
        updateTagBadge();
        applyFilters();
      });
      tagDropdown.appendChild(item);
    });
  }

  function updateTagBadge() {
    if (activeTagFilters.size > 0) {
      btnFilterTags.classList.add('active');
      tagBadge.textContent = activeTagFilters.size;
    } else {
      btnFilterTags.classList.remove('active');
    }
  }



  // ─── Shared Dropdown Item ──────────────────────────────────

  function createDropdownItem(text, isChecked) {
    const item = document.createElement('div');
    item.className = `sp-dropdown-item${isChecked ? ' checked' : ''}`;

    const checkbox = document.createElement('span');
    checkbox.className = 'sp-dropdown-checkbox';
    checkbox.appendChild(createCheckSVG());

    const label = document.createElement('span');
    label.textContent = text;

    item.appendChild(checkbox);
    item.appendChild(label);
    return item;
  }

  // ─── Close dropdowns on outside click ──────────────────────

  document.addEventListener('click', (e) => {
    const tagWrapper = document.getElementById('tagFilterWrapper');

    if (tagDropdownOpen && !tagWrapper.contains(e.target)) {
      tagDropdownOpen = false;
      tagDropdown.classList.remove('open');
    }
  });

  btnTrashcan.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close dropdowns
    tagDropdownOpen = false;
    tagDropdown.classList.remove('open');

    toggleTrash();
  });

  // ─── Listen for content script updates ─────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'MESSAGES_UPDATED') {
      // Features #1 and #3: old messages loaded on scroll / new message sent
      if (!navigationLock) scanMessages(1, 200);
    } else if (message.type === 'NOTEBOOK_CHANGED') {
      // Feature #2: user opened a different notebook
      handleNotebookChange(message.url);
    }
  });

  async function handleNotebookChange(newUrl = null) {
    console.log('Sidebar: notebook changed, reloading...');
    
    // Prevent scanning while the DOM is in a chaotic transition state
    if (navigationLock) clearTimeout(navigationLock);
    navigationLock = setTimeout(() => {
      navigationLock = null;
      scanMessages(5, 600);
    }, 1500);

    // Reset filters
    activeTagFilters.clear();
    updateTagBadge();

    // Close any open dropdowns
    tagDropdownOpen = false;
    tagDropdown.classList.remove('open');

    // Save current keys as stale before wiping memory
    if (messages.length > 0) {
      staleKeys = new Set(messages.map(m => m.turnKey));
    }

    // Force clear memory immediately so we don't accidentally merge
    messages = [];
    messageTags = {};
    allTags = new Set();
    deletedMessages = new Set();
    renderTable();

    // Re-read notebook ID and load saved data for it
    conversationId = await getConversationIdFromTab(newUrl);
    await loadData();

    // Reset injection flag so content script can be re-injected if needed
    contentScriptInjected = false;
  }

  // ─── Tab switch detection ───────────────────────────────────
  // When the user switches between tabs (e.g. ChatGPT → Claude),
  // the sidebar must re-scan for the newly active tab's messages.

  let tabSwitchDebounce = null;

  chrome.tabs.onActivated.addListener(() => {
    clearTimeout(tabSwitchDebounce);
    tabSwitchDebounce = setTimeout(() => handleNotebookChange(), 300);
  });

  // ─── Init ──────────────────────────────────────────────────

  async function init() {
    conversationId = await getConversationIdFromTab();
    console.log('Sidebar init — conversationId:', conversationId);
    await loadData();
    // Give content script time to initialize, then scan with retries
    setTimeout(() => scanMessages(5, 600), 500);
  }

  init();
})();
