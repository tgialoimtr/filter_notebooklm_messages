/**
 * Chat Tag & Filter — Sidebar Panel Script (v3)
 *
 * Manages the sidebar UI: message cards, tags, search, and filter dropdowns.
 * Platform-agnostic — works with NotebookLM, ChatGPT, and more.
 * Communicates with the content script via chrome.runtime messaging.
 */

(() => {
  'use strict';

  const STORAGE_PREFIX = 'chat_tags_';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let messages = [];
  let messageTags = {};
  let allTags = new Set();
  let activeTagFilters = new Set();
  let tagDropdownOpen = false;
  let showingTrash = false;
  let deletedMessages = new Set();
  let conversationId = 'unknown';
  let searchTerm = '';
  let selectedTurnKey = null;

  let staleKeys = new Set();
  let navigationLock = null;
  let lastVisibleKeys = [];

  const listBody = document.getElementById('messageListBody');
  const emptyState = document.getElementById('emptyState');
  const btnFilterTags = document.getElementById('btnFilterTags');
  const btnTrashcan = document.getElementById('btnTrashcan');
  const tagDropdown = document.getElementById('tagDropdown');
  const tagBadge = document.getElementById('tagBadge');
  const searchInput = document.getElementById('searchInput');
  const searchClearBtn = document.getElementById('searchClearBtn');
  const messageCountBadge = document.getElementById('messageCountBadge');

  function getConversationIdFromTab(explicitUrl = null) {
    const URL_PATTERNS = [
      /notebooklm\.google\.com\/notebook\/([^/?#]+)/,
      /chatgpt\.com\/c\/([^/?#]+)/,
      /gemini\.google\.com\/app\/([^/?#]+)/,
      /claude\.ai\/chat\/([^/?#]+)/,
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
      messages,
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
          messages = result[key].messages || [];
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

  async function ensureContentScript(tabId) {
    if (contentScriptInjected) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['adapters.js', 'content.js'],
      });
      contentScriptInjected = true;
      console.log('Content script injected into tab', tabId);
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

        let response = await trySendMessage(tab.id, message);
        if (response !== null) {
          resolve(response);
          return;
        }

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

  function shortenText(text, maxLen = 220) {
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

  function mergeMessages(incoming) {
    if (!incoming || incoming.length === 0) return false;
    if (messages.length === 0) {
      messages = incoming;
      return true;
    }

    let changed = false;
    const existingKeys = messages.map((m) => m.turnKey);

    for (const incMsg of incoming) {
      const idx = existingKeys.indexOf(incMsg.turnKey);
      if (idx !== -1) {
        if (messages[idx].fullText !== incMsg.fullText) {
          messages[idx].fullText = incMsg.fullText;
          changed = true;
        }
      }
    }

    for (let i = 0; i < incoming.length; i++) {
      const incMsg = incoming[i];
      if (!existingKeys.includes(incMsg.turnKey)) {
        let prevAnchorKey = null;
        for (let j = i - 1; j >= 0; j--) {
          if (existingKeys.includes(incoming[j].turnKey)) {
            prevAnchorKey = incoming[j].turnKey;
            break;
          }
        }

        let nextAnchorKey = null;
        for (let j = i + 1; j < incoming.length; j++) {
          if (existingKeys.includes(incoming[j].turnKey)) {
            nextAnchorKey = incoming[j].turnKey;
            break;
          }
        }

        if (prevAnchorKey) {
          const insertIdx = existingKeys.indexOf(prevAnchorKey) + 1;
          messages.splice(insertIdx, 0, incMsg);
          existingKeys.splice(insertIdx, 0, incMsg.turnKey);
          changed = true;
        } else if (nextAnchorKey) {
          const insertIdx = existingKeys.indexOf(nextAnchorKey);
          messages.splice(insertIdx, 0, incMsg);
          existingKeys.splice(insertIdx, 0, incMsg.turnKey);
          changed = true;
        } else {
          messages.push(incMsg);
          existingKeys.push(incMsg.turnKey);
          changed = true;
        }
      }
    }
    return changed;
  }

  async function scanMessages(retries = 5, delay = 500) {
    if (navigationLock) return;

    const response = await sendToContentScript({ type: 'SCAN_MESSAGES' });
    if (response?.messages) {
      const isStaleDOM = response.messages.some((m) => staleKeys.has(m.turnKey));
      if (isStaleDOM) {
        console.warn('Scan aborted: DOM still contains stale messages from previous topic. Retrying...');
        if (retries > 0) setTimeout(() => scanMessages(retries - 1, delay * 1.5), delay);
        return;
      }

      lastVisibleKeys = response.messages.map((m) => m.turnKey);
      const changed = mergeMessages(response.messages);
      if (changed) {
        saveData();
      }
      renderTable();
      updateEmptyState();
      applyFilters();
    } else if (retries > 0) {
      console.log(`scanMessages: no response, retrying in ${delay}ms (${retries} left)`);
      setTimeout(() => scanMessages(retries - 1, delay * 1.5), delay);
    } else {
      console.warn('scanMessages: content script never responded');
      updateEmptyState();
    }
  }

  let activePopover = null;

  function closeActivePopover() {
    if (activePopover) {
      activePopover.classList.remove('open');
      activePopover = null;
    }
  }

  document.addEventListener('click', (e) => {
    if (activePopover && !activePopover.contains(e.target) && !e.target.closest('.sp-icon-btn')) {
      closeActivePopover();
    }
  });

  function matchesSearch(message) {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    if (!normalizedSearch) return true;
    return message.fullText.toLowerCase().includes(normalizedSearch);
  }

  function updateSearchUI() {
    const hasValue = searchInput.value.trim().length > 0;
    searchInput.parentElement.classList.toggle('sp-search-empty', !hasValue);
  }

  function updateMessageCount() {
    const visibleCount = messages.filter((msg) => {
      if (showingTrash) {
        return deletedMessages.has(msg.turnKey);
      }
      return !deletedMessages.has(msg.turnKey);
    }).length;

    messageCountBadge.textContent = `${visibleCount} ${visibleCount === 1 ? 'msg' : 'msgs'}`;
  }

  function renderTable() {
    closeActivePopover();
    while (listBody.firstChild) listBody.removeChild(listBody.firstChild);

    messages.forEach((msg) => {
      if (showingTrash) {
        if (!deletedMessages.has(msg.turnKey)) return;
      } else if (deletedMessages.has(msg.turnKey)) {
        return;
      }

      if (!isRowVisible(msg.turnKey, msg)) return;

      const card = document.createElement('article');
      card.className = 'sp-message-card';
      card.dataset.turnKey = msg.turnKey;
      card.title = msg.fullText;
      card.classList.toggle('selected', msg.turnKey === selectedTurnKey);

      const main = document.createElement('div');
      main.className = 'sp-message-card__main';

      const index = document.createElement('div');
      index.className = 'sp-message-card__index';
      index.textContent = `#${messages.indexOf(msg) + 1}`;

      const body = document.createElement('div');
      body.className = 'sp-message-card__body';

      const text = document.createElement('p');
      text.className = 'sp-message-text';
      text.textContent = shortenText(msg.fullText);
      body.appendChild(text);

      const tags = messageTags[msg.turnKey] || [];
      if (tags.length > 0) {
        const tagsRow = document.createElement('div');
        tagsRow.className = 'sp-message-card__tags';
        tags.forEach((tag) => {
          const pill = document.createElement('span');
          pill.className = `sp-tag-pill ${getTagToneClass(tag)}`;
          pill.textContent = tag;
          tagsRow.appendChild(pill);
        });
        body.appendChild(tagsRow);
      }

      main.appendChild(index);
      main.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'sp-message-card__actions';

      if (showingTrash) {
        const btnRecover = document.createElement('button');
        btnRecover.className = 'sp-btn-recover';
        btnRecover.textContent = 'Recover';
        btnRecover.addEventListener('click', (e) => {
          e.stopPropagation();
          recoverMessage(msg.turnKey);
        });
        actions.appendChild(btnRecover);
      } else {
        actions.appendChild(createTagIconBtn(msg.turnKey, tags));

        const btnDelete = document.createElement('button');
        btnDelete.className = 'sp-icon-btn sp-icon-delete';
        btnDelete.title = 'Delete message';
        btnDelete.appendChild(createDeleteSVG());
        btnDelete.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteMessage(msg.turnKey);
        });
        actions.appendChild(btnDelete);
      }

      card.appendChild(main);
      card.appendChild(actions);
      card.addEventListener('click', () => {
        selectedTurnKey = msg.turnKey;
        renderTable();
        sendToContentScript({ type: 'SCROLL_TO_MESSAGE', turnKey: msg.turnKey });
      });

      listBody.appendChild(card);
    });

    updateMessageCount();
    updateEmptyState();
  }

  function createTagIconBtn(turnKey, tags) {
    const wrapper = document.createElement('div');
    wrapper.className = 'sp-icon-wrapper';

    const btn = document.createElement('button');
    btn.className = 'sp-icon-btn sp-icon-tag';
    btn.title = tags.length > 0 ? `Tags: ${tags.join(', ')}` : 'Add tags';
    btn.appendChild(createTagSVG());

    if (tags.length > 0) {
      const badge = document.createElement('span');
      badge.className = 'sp-icon-badge sp-icon-badge-tag';
      badge.textContent = tags.length;
      btn.appendChild(badge);
    }

    const popover = document.createElement('div');
    popover.className = 'sp-popover';
    buildTagPopoverContent(popover, turnKey);
    
    popover.addEventListener('click', (e) => e.stopPropagation());

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

    tags.forEach((tag) => {
      popover.appendChild(createTagPill(tag, turnKey));
    });

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

  function createTagSVG() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'sp-icon-svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS(SVG_NS, 'path');
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

  function getTagToneClass(tagText) {
    const tones = ['blue', 'teal', 'violet', 'rose', 'mint', 'amber', 'cyan', 'lilac'];
    let hash = 0;

    for (let i = 0; i < tagText.length; i += 1) {
      hash = (hash << 5) - hash + tagText.charCodeAt(i);
      hash |= 0;
    }

    const index = Math.abs(hash) % tones.length;
    return `sp-tag-pill--${tones[index]}`;
  }

  function updateEmptyState() {
    const hasMessages = messages.length > 0;
    const hasVisibleMessages = messages.some((msg) => isRowVisible(msg.turnKey, msg));

    if (!hasMessages) {
      emptyState.querySelector('.sp-empty-title').textContent = 'No messages yet';
      emptyState.querySelector('.sp-empty-hint').textContent = 'Open a chat on NotebookLM, ChatGPT, or Claude to start organizing.';
      emptyState.classList.add('visible');
      return;
    }

    if (!hasVisibleMessages) {
      if (searchTerm.trim()) {
        emptyState.querySelector('.sp-empty-title').textContent = `No results for “${searchTerm.trim()}”`;
        emptyState.querySelector('.sp-empty-hint').textContent = 'Try a different keyword or clear the search.';
      } else if (showingTrash) {
        emptyState.querySelector('.sp-empty-title').textContent = 'No deleted messages';
        emptyState.querySelector('.sp-empty-hint').textContent = 'Recovered items will show up here.';
      } else if (activeTagFilters.size > 0) {
        emptyState.querySelector('.sp-empty-title').textContent = 'No messages match your filters';
        emptyState.querySelector('.sp-empty-hint').textContent = 'Try a different tag combination.';
      } else {
        emptyState.querySelector('.sp-empty-title').textContent = 'No messages yet';
        emptyState.querySelector('.sp-empty-hint').textContent = 'Open a chat on NotebookLM, ChatGPT, or Claude to start organizing.';
      }
      emptyState.classList.add('visible');
      return;
    }

    emptyState.classList.remove('visible');
  }

  function createTagPill(tagText, turnKey) {
    const pill = document.createElement('span');
    pill.className = `sp-tag-pill ${getTagToneClass(tagText)}`;
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

  function addTag(turnKey, tagText) {
    if (!messageTags[turnKey]) messageTags[turnKey] = [];
    if (messageTags[turnKey].includes(tagText)) return;

    messageTags[turnKey].push(tagText);
    allTags.add(tagText);
    saveData();
    renderTable();
    refreshTagDropdown();
    applyFilters();
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
    if (showingTrash) {
      btnTrashcan.classList.add('active');
      activeTagFilters.clear();
      updateTagBadge();
    } else {
      btnTrashcan.classList.remove('active');
    }
    renderTable();
    updateEmptyState();
    applyFilters();
  }

  function isRowVisible(turnKey, message = null) {
    const msg = message || messages.find((entry) => entry.turnKey === turnKey);
    if (!msg) return false;

    if (showingTrash) {
      return deletedMessages.has(turnKey) && matchesSearch(msg);
    }
    if (deletedMessages.has(turnKey)) {
      return false;
    }

    const tagMatch = activeTagFilters.size === 0 || (messageTags[turnKey] || []).some((t) => activeTagFilters.has(t));
    return tagMatch && matchesSearch(msg);
  }

  function applyFilters() {
    const visibleKeys = [];
    const allVisibleIfEmpty = !showingTrash && activeTagFilters.size === 0 && !searchTerm.trim();

    messages.forEach((msg) => {
      if (showingTrash) {
        if (deletedMessages.has(msg.turnKey) && isRowVisible(msg.turnKey, msg)) visibleKeys.push(msg.turnKey);
      } else if (!deletedMessages.has(msg.turnKey) && isRowVisible(msg.turnKey, msg)) {
        visibleKeys.push(msg.turnKey);
      }
    });

    sendToContentScript({
      type: 'APPLY_FILTERS',
      visibleKeys: (allVisibleIfEmpty && deletedMessages.size === 0) ? [] : visibleKeys,
    });
  }

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
        renderTable();
        updateEmptyState();
        applyFilters();
        tagDropdownOpen = false;
        tagDropdown.classList.remove('open');
      });
      tagDropdown.appendChild(item);
    });
  }

  function updateTagBadge() {
    const activeCount = activeTagFilters.size;
    if (activeCount > 0) {
      btnFilterTags.classList.add('active');
      tagBadge.textContent = activeCount;
    } else {
      btnFilterTags.classList.remove('active');
      tagBadge.textContent = '0';
    }
  }

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

  document.addEventListener('click', (e) => {
    const tagWrapper = document.getElementById('tagFilterWrapper');

    if (tagDropdownOpen && !tagWrapper.contains(e.target)) {
      tagDropdownOpen = false;
      tagDropdown.classList.remove('open');
    }
  });

  btnTrashcan.addEventListener('click', (e) => {
    e.stopPropagation();
    tagDropdownOpen = false;
    tagDropdown.classList.remove('open');
    toggleTrash();
  });

  searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value;
    updateSearchUI();
    renderTable();
    updateEmptyState();
    applyFilters();
  });

  searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchTerm = '';
    updateSearchUI();
    renderTable();
    updateEmptyState();
    applyFilters();
    searchInput.focus();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'MESSAGES_UPDATED') {
      if (!navigationLock) scanMessages(1, 200);
    } else if (message.type === 'NOTEBOOK_CHANGED') {
      handleNotebookChange(message.url);
    }
  });

  async function handleNotebookChange(newUrl = null) {
    console.log('Sidebar: notebook changed, reloading...');

    if (navigationLock) clearTimeout(navigationLock);
    navigationLock = setTimeout(() => {
      navigationLock = null;
      scanMessages(5, 600);
    }, 1500);

    activeTagFilters.clear();
    updateTagBadge();

    tagDropdownOpen = false;
    tagDropdown.classList.remove('open');

    if (messages.length > 0) {
      staleKeys = new Set(messages.map((m) => m.turnKey));
    }

    messages = [];
    messageTags = {};
    allTags = new Set();
    deletedMessages = new Set();
    searchTerm = '';
    searchInput.value = '';
    updateSearchUI();
    renderTable();

    conversationId = await getConversationIdFromTab(newUrl);
    await loadData();
    contentScriptInjected = false;
  }

  let tabSwitchDebounce = null;

  chrome.tabs.onActivated.addListener(() => {
    clearTimeout(tabSwitchDebounce);
    tabSwitchDebounce = setTimeout(() => handleNotebookChange(), 300);
  });

  async function init() {
    conversationId = await getConversationIdFromTab();
    console.log('Sidebar init — conversationId:', conversationId);
    await loadData();
    updateSearchUI();
    updateTagBadge();
    setTimeout(() => scanMessages(5, 600), 500);
  }

  updateSearchUI();
  updateTagBadge();
  renderTable();
  init();
})();
