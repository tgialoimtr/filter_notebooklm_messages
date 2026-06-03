/**
 * NotebookLM Tag & Filter — Sidebar Panel Script (v2)
 *
 * Manages the sidebar UI: message table, tags, sources, and filter dropdowns.
 * Communicates with the content script via chrome.runtime messaging.
 */

(() => {
  'use strict';

  // ─── State ──────────────────────────────────────────────────
  const STORAGE_PREFIX = 'nblm_tags_';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let messages = [];         // { turnKey, fullText, turnIndex }
  let messageTags = {};      // turnKey → [tag, ...]
  let messageSources = {};   // turnKey → [source, ...]
  let allTags = new Set();
  let allSources = new Set();
  let activeTagFilters = new Set();
  let activeSourceFilters = new Set();
  let tagDropdownOpen = false;
  let sourceDropdownOpen = false;
  let notebookId = 'unknown';

  // ─── DOM References ────────────────────────────────────────
  const tableBody = document.getElementById('messageTableBody');
  const emptyState = document.getElementById('emptyState');
  const btnFilterTags = document.getElementById('btnFilterTags');
  const btnFilterSources = document.getElementById('btnFilterSources');
  const tagDropdown = document.getElementById('tagDropdown');
  const sourceDropdown = document.getElementById('sourceDropdown');
  const tagBadge = document.getElementById('tagBadge');
  const sourceBadge = document.getElementById('sourceBadge');

  // ─── Hardcoded Sources ─────────────────────────────────────
  const HARDCODED_SOURCES = ['1', '2', '3'];

  // ─── Utilities ─────────────────────────────────────────────

  function getNotebookIdFromTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.url) {
          const match = tabs[0].url.match(/notebook\/([^/?#]+)/);
          resolve(match ? match[1] : 'unknown');
        } else {
          resolve('unknown');
        }
      });
    });
  }

  function storageKey() {
    return STORAGE_PREFIX + notebookId;
  }

  async function saveData() {
    const key = storageKey();
    const data = {
      messageTags,
      messageSources,
      allTags: Array.from(allTags),
      allSources: Array.from(allSources),
    };
    await chrome.storage.local.set({ [key]: data });
  }

  async function loadData() {
    const key = storageKey();
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        if (result[key]) {
          messageTags = result[key].messageTags || {};
          messageSources = result[key].messageSources || {};
          allTags = new Set(result[key].allTags || []);
          allSources = new Set(result[key].allSources || []);
        } else {
          messageTags = {};
          messageSources = {};
          allTags = new Set();
          allSources = new Set();
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
        files: ['content.js'],
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

  // ─── Scan Messages from Content Script ─────────────────────

  async function scanMessages(retries = 5, delay = 500) {
    const response = await sendToContentScript({ type: 'SCAN_MESSAGES' });
    if (response?.messages) {
      messages = response.messages;
      // Assign hardcoded sources for each message if not already stored
      messages.forEach((msg) => {
        if (!messageSources[msg.turnKey]) {
          messageSources[msg.turnKey] = [...HARDCODED_SOURCES];
        }
        // Rebuild allSources
        (messageSources[msg.turnKey] || []).forEach((s) => allSources.add(s));
      });
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

  // ─── Render Table ──────────────────────────────────────────

  function renderTable() {
    // Clear
    while (tableBody.firstChild) tableBody.removeChild(tableBody.firstChild);

    messages.forEach((msg) => {
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

      // ─ Tags/Sources cell ─
      const tdMeta = document.createElement('td');
      tdMeta.className = 'sp-cell-meta';

      const metaRow = document.createElement('div');
      metaRow.className = 'sp-meta-row';

      // Tags
      const tags = messageTags[msg.turnKey] || [];
      tags.forEach((tag) => {
        metaRow.appendChild(createTagPill(tag, msg.turnKey));
      });

      // Add-tag input
      metaRow.appendChild(createTagInput(msg.turnKey));

      // Separator dot (only if there are sources)
      const sources = messageSources[msg.turnKey] || [];
      if (sources.length > 0) {
        const sep = document.createElement('span');
        sep.className = 'sp-meta-sep';
        metaRow.appendChild(sep);
      }

      // Sources
      sources.forEach((src) => {
        const pill = document.createElement('span');
        pill.className = 'sp-source-pill';
        pill.textContent = src;
        metaRow.appendChild(pill);
      });

      tdMeta.appendChild(metaRow);

      tr.appendChild(tdMsg);
      tr.appendChild(tdMeta);

      // Apply current filter visibility
      if (!isRowVisible(msg.turnKey)) {
        tr.classList.add('sp-row-hidden');
      }

      tableBody.appendChild(tr);
    });
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

  // ─── Filter Logic ─────────────────────────────────────────

  function isRowVisible(turnKey) {
    const tagMatch = activeTagFilters.size === 0 ||
      (messageTags[turnKey] || []).some((t) => activeTagFilters.has(t));
    const sourceMatch = activeSourceFilters.size === 0 ||
      (messageSources[turnKey] || []).some((s) => activeSourceFilters.has(s));
    return tagMatch && sourceMatch;
  }

  function applyFilters() {
    // Update table row visibility
    const rows = tableBody.querySelectorAll('tr');
    const visibleKeys = [];

    rows.forEach((row) => {
      const turnKey = row.dataset.turnKey;
      if (isRowVisible(turnKey)) {
        row.classList.remove('sp-row-hidden');
        visibleKeys.push(turnKey);
      } else {
        row.classList.add('sp-row-hidden');
      }
    });

    // Tell content script to hide/show messages in the chat panel
    sendToContentScript({
      type: 'APPLY_FILTERS',
      visibleKeys: (activeTagFilters.size === 0 && activeSourceFilters.size === 0)
        ? []
        : visibleKeys,
    });
  }

  // ─── Tag Dropdown ──────────────────────────────────────────

  btnFilterTags.addEventListener('click', (e) => {
    e.stopPropagation();
    sourceDropdownOpen = false;
    sourceDropdown.classList.remove('open');
    btnFilterSources.classList.remove('active-dropdown');

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

  // ─── Source Dropdown ───────────────────────────────────────

  btnFilterSources.addEventListener('click', (e) => {
    e.stopPropagation();
    tagDropdownOpen = false;
    tagDropdown.classList.remove('open');

    sourceDropdownOpen = !sourceDropdownOpen;
    if (sourceDropdownOpen) {
      refreshSourceDropdown();
      sourceDropdown.classList.add('open');
    } else {
      sourceDropdown.classList.remove('open');
    }
  });

  function refreshSourceDropdown() {
    while (sourceDropdown.firstChild) sourceDropdown.removeChild(sourceDropdown.firstChild);

    if (allSources.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'sp-dropdown-empty';
      empty.textContent = 'No sources available.';
      sourceDropdown.appendChild(empty);
      return;
    }

    Array.from(allSources).sort().forEach((src) => {
      const item = createDropdownItem(src, activeSourceFilters.has(src));
      item.addEventListener('click', () => {
        if (activeSourceFilters.has(src)) activeSourceFilters.delete(src);
        else activeSourceFilters.add(src);
        refreshSourceDropdown();
        updateSourceBadge();
        applyFilters();
      });
      sourceDropdown.appendChild(item);
    });
  }

  function updateSourceBadge() {
    if (activeSourceFilters.size > 0) {
      btnFilterSources.classList.add('active');
      sourceBadge.textContent = activeSourceFilters.size;
    } else {
      btnFilterSources.classList.remove('active');
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
    const sourceWrapper = document.getElementById('sourceFilterWrapper');

    if (tagDropdownOpen && !tagWrapper.contains(e.target)) {
      tagDropdownOpen = false;
      tagDropdown.classList.remove('open');
    }
    if (sourceDropdownOpen && !sourceWrapper.contains(e.target)) {
      sourceDropdownOpen = false;
      sourceDropdown.classList.remove('open');
    }
  });

  // ─── Listen for content script updates ─────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'MESSAGES_UPDATED') {
      // Features #1 and #3: old messages loaded on scroll / new message sent
      scanMessages(1, 200);
    } else if (message.type === 'NOTEBOOK_CHANGED') {
      // Feature #2: user opened a different notebook
      handleNotebookChange();
    }
  });

  async function handleNotebookChange() {
    console.log('Sidebar: notebook changed, reloading...');
    // Reset filters
    activeTagFilters.clear();
    activeSourceFilters.clear();
    updateTagBadge();
    updateSourceBadge();

    // Close any open dropdowns
    tagDropdownOpen = false;
    sourceDropdownOpen = false;
    tagDropdown.classList.remove('open');
    sourceDropdown.classList.remove('open');

    // Re-read notebook ID and load saved data for it
    notebookId = await getNotebookIdFromTab();
    await loadData();

    // Reset injection flag so content script can be re-injected if needed
    contentScriptInjected = false;

    // Re-scan after a short delay (new chat panel may still be loading)
    setTimeout(() => scanMessages(5, 600), 500);
  }

  // ─── Init ──────────────────────────────────────────────────

  async function init() {
    notebookId = await getNotebookIdFromTab();
    console.log('Sidebar init — notebookId:', notebookId);
    await loadData();
    // Give content script time to initialize, then scan with retries
    setTimeout(() => scanMessages(5, 600), 500);
  }

  init();
})();
