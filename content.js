/**
 * NotebookLM Tag & Filter Extension — Content Script
 *
 * Injects tag UI below each chat message and a filter button in the chat header.
 * Tags are persisted per-notebook in chrome.storage.local.
 *
 * DOM Structure (as of 2026-06):
 *   .chat-panel-content
 *     ├── div.chat-message-pair
 *     │     ├── chat-message.individual-message
 *     │     │     └── div.from-user-container      ← user turn
 *     │     └── chat-message.individual-message
 *     │           └── div.to-user-container        ← model turn
 *     ├── div.chat-message-pair                    ← next turn
 *     └── ...
 *
 * Strategy:
 *   - A "conversation turn" = a .chat-message-pair element.
 *   - We inject the tag container AFTER the .chat-message-pair as a sibling.
 *   - For filtering, we hide the entire .chat-message-pair.
 */

(() => {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────
  const SELECTORS = {
    chatContent: '.chat-panel-content',
    messagePair: '.chat-message-pair',
    userContent: '.from-user-container',
    modelContent: '.to-user-container',
    headerTitleArea: '.title-and-promo',
  };

  const MODEL_PREVIEW_LENGTH = 120;

  const STORAGE_PREFIX = 'nblm_tags_';
  const OBSERVER_DEBOUNCE_MS = 400;

  // ─── State ──────────────────────────────────────────────────
  let allTags = new Set();
  let messageTags = {};
  let activeFilters = new Set();
  let filterPanelOpen = false;
  let notebookId = '';

  // ─── Utilities ──────────────────────────────────────────────

  function getNotebookId() {
    const match = window.location.pathname.match(/notebook\/([^/?#]+)/);
    return match ? match[1] : 'unknown';
  }

  /**
   * Generate a stable key for a conversation turn.
   * Uses the user message text hash for cross-reload stability.
   */
  function getTurnKey(userMsgEl, turnIndex) {
    const userText = userMsgEl?.textContent?.trim()?.slice(0, 100) || '';
    let hash = 0;
    for (let i = 0; i < userText.length; i++) {
      hash = ((hash << 5) - hash) + userText.charCodeAt(i);
      hash |= 0;
    }
    return `turn_${turnIndex}_${hash}`;
  }

  function saveTags() {
    const key = STORAGE_PREFIX + notebookId;
    const data = { messageTags, allTags: Array.from(allTags) };
    chrome.storage.local.set({ [key]: data });
  }

  async function loadTags() {
    const key = STORAGE_PREFIX + notebookId;
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        if (result[key]) {
          messageTags = result[key].messageTags || {};
          allTags = new Set(result[key].allTags || []);
        } else {
          messageTags = {};
          allTags = new Set();
        }
        resolve();
      });
    });
  }

  // ─── SVG Icon Helpers (Trusted Types safe) ─────────────────

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function createFilterIconSVG() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'nblm-filter-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z');
    svg.appendChild(path);
    return svg;
  }

  function createCheckIconSVG() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'nblm-filter-checkbox-tick');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'white');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z');
    svg.appendChild(path);
    return svg;
  }

  function createChevronSVG() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'nblm-collapse-chevron');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z');
    svg.appendChild(path);
    return svg;
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // ─── Turn Pairing ──────────────────────────────────────────
  /**
   * Scan .chat-panel-content for .chat-message-pair elements.
   * Each pair contains a from-user-container and a to-user-container.
   * Returns an array of { pairEl, userEl, modelEl, turnIndex }.
   */
  function getConversationTurns() {
    const chatContent = document.querySelector(SELECTORS.chatContent);
    if (!chatContent) return [];

    const pairs = chatContent.querySelectorAll(SELECTORS.messagePair);
    const turns = [];

    pairs.forEach((pair, index) => {
      const userEl = pair.querySelector(SELECTORS.userContent);
      const modelEl = pair.querySelector(SELECTORS.modelContent);

      turns.push({
        pairEl: pair,
        userEl: userEl,
        modelEl: modelEl,
        turnIndex: index,
      });
    });

    return turns;
  }

  // ─── Tag UI (below each message turn) ──────────────────────

  function createTagContainer(turnKey) {
    const container = document.createElement('div');
    container.className = 'nblm-tag-container';
    container.dataset.turnKey = turnKey;

    const tags = messageTags[turnKey] || [];
    tags.forEach((tag) => container.appendChild(createTagPill(tag, turnKey)));
    container.appendChild(createTagInput(turnKey));

    return container;
  }

  function createTagPill(tagText, turnKey) {
    const pill = document.createElement('span');
    pill.className = 'nblm-tag';
    pill.textContent = tagText;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'nblm-tag-remove';
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
    wrapper.className = 'nblm-tag-input-wrapper';

    const input = document.createElement('input');
    input.className = 'nblm-tag-input';
    input.type = 'text';
    input.placeholder = 'Add tag';
    input.setAttribute('aria-label', 'Add a tag to this message');

    // Enter to add tag
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
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

    // Stop propagation on all keyboard events to prevent NotebookLM intercepting
    input.addEventListener('keypress', (e) => e.stopPropagation());
    input.addEventListener('keyup', (e) => e.stopPropagation());

    wrapper.appendChild(input);
    return wrapper;
  }

  function addTag(turnKey, tagText) {
    if (!messageTags[turnKey]) messageTags[turnKey] = [];
    if (messageTags[turnKey].includes(tagText)) return;

    messageTags[turnKey].push(tagText);
    allTags.add(tagText);
    saveTags();
    refreshTagContainer(turnKey);
    refreshFilterPanel();
  }

  function removeTag(turnKey, tagText) {
    if (!messageTags[turnKey]) return;
    messageTags[turnKey] = messageTags[turnKey].filter((t) => t !== tagText);
    if (messageTags[turnKey].length === 0) delete messageTags[turnKey];

    rebuildAllTags();
    saveTags();
    refreshTagContainer(turnKey);
    refreshFilterPanel();
    applyFilters();
  }

  function rebuildAllTags() {
    allTags.clear();
    Object.values(messageTags).forEach((tags) => {
      tags.forEach((t) => allTags.add(t));
    });
  }

  function refreshTagContainer(turnKey) {
    const container = document.querySelector(
      `.nblm-tag-container[data-turn-key="${turnKey}"]`
    );
    if (!container) return;
    clearChildren(container);

    const tags = messageTags[turnKey] || [];
    tags.forEach((tag) => container.appendChild(createTagPill(tag, turnKey)));
    container.appendChild(createTagInput(turnKey));
  }

  // ─── Filter UI (in chat header) ────────────────────────────

  function injectFilterButton() {
    if (document.querySelector('.nblm-filter-wrapper')) return;

    const headerArea = document.querySelector(SELECTORS.headerTitleArea);
    if (!headerArea) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'nblm-filter-wrapper';

    const btn = document.createElement('button');
    btn.className = 'nblm-filter-btn';
    btn.appendChild(createFilterIconSVG());
    btn.appendChild(document.createTextNode(' Filter '));
    const badge = document.createElement('span');
    badge.className = 'nblm-filter-badge';
    badge.textContent = '0';
    btn.appendChild(badge);
    btn.title = 'Filter messages by tag';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFilterPanel();
    });

    const panel = document.createElement('div');
    panel.className = 'nblm-filter-panel';
    panel.id = 'nblm-filter-panel';

    wrapper.appendChild(btn);
    wrapper.appendChild(panel);

    headerArea.parentElement.insertBefore(wrapper, headerArea.nextSibling);

    document.addEventListener('click', (e) => {
      if (filterPanelOpen && !wrapper.contains(e.target)) {
        closeFilterPanel();
      }
    });
  }

  function toggleFilterPanel() {
    filterPanelOpen ? closeFilterPanel() : openFilterPanel();
  }

  function openFilterPanel() {
    filterPanelOpen = true;
    refreshFilterPanel();
    const panel = document.getElementById('nblm-filter-panel');
    if (panel) panel.classList.add('open');
  }

  function closeFilterPanel() {
    filterPanelOpen = false;
    const panel = document.getElementById('nblm-filter-panel');
    if (panel) panel.classList.remove('open');
  }

  function refreshFilterPanel() {
    const panel = document.getElementById('nblm-filter-panel');
    if (!panel) return;
    clearChildren(panel);

    if (allTags.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'nblm-filter-empty';
      empty.textContent = 'No tags yet. Add tags to messages below.';
      panel.appendChild(empty);
      return;
    }

    const header = document.createElement('div');
    header.className = 'nblm-filter-panel-header';
    header.textContent = 'Filter by tags';
    panel.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'nblm-filter-tag-grid';

    const isAllActive = activeFilters.size === 0;
    const allItem = createFilterItem('All', isAllActive, true);
    allItem.addEventListener('click', () => {
      activeFilters.clear();
      refreshFilterPanel();
      applyFilters();
      updateFilterButtonState();
    });
    grid.appendChild(allItem);
    panel.appendChild(grid);

    const divider = document.createElement('div');
    divider.className = 'nblm-filter-divider';
    panel.appendChild(divider);

    const tagsGrid = document.createElement('div');
    tagsGrid.className = 'nblm-filter-tag-grid';
    Array.from(allTags).sort().forEach((tag) => {
      const isActive = activeFilters.has(tag);
      const item = createFilterItem(tag, isActive, false);
      item.addEventListener('click', () => {
        if (activeFilters.has(tag)) activeFilters.delete(tag);
        else activeFilters.add(tag);
        refreshFilterPanel();
        applyFilters();
        updateFilterButtonState();
      });
      tagsGrid.appendChild(item);
    });
    panel.appendChild(tagsGrid);
  }

  function createFilterItem(text, isChecked, isAll) {
    const item = document.createElement('div');
    item.className = `nblm-filter-item${isChecked ? ' checked' : ''}${isAll ? ' all-tag' : ''}`;

    const checkbox = document.createElement('span');
    checkbox.className = 'nblm-filter-checkbox';
    checkbox.appendChild(createCheckIconSVG());

    const label = document.createElement('span');
    label.textContent = text;

    item.appendChild(checkbox);
    item.appendChild(label);
    return item;
  }

  function updateFilterButtonState() {
    const btn = document.querySelector('.nblm-filter-btn');
    if (!btn) return;
    if (activeFilters.size > 0) {
      btn.classList.add('active');
      const badge = btn.querySelector('.nblm-filter-badge');
      if (badge) badge.textContent = activeFilters.size;
    } else {
      btn.classList.remove('active');
    }
  }

  // ─── Filtering Logic ───────────────────────────────────────

  /**
   * Apply filters by hiding/showing chat-message-pair elements.
   */
  function applyFilters() {
    const turns = getConversationTurns();

    turns.forEach((turn) => {
      const turnKey = turn.pairEl.dataset.nblmTurnKey;
      if (!turnKey) return;

      const tagCont = turn.pairEl.nextElementSibling;
      const hasTagCont = tagCont && tagCont.classList.contains('nblm-tag-container');

      if (activeFilters.size === 0) {
        // Show all
        turn.pairEl.classList.remove('nblm-hidden');
        if (hasTagCont) tagCont.classList.remove('nblm-hidden');
      } else {
        const tags = messageTags[turnKey] || [];
        const hasMatch = tags.some((t) => activeFilters.has(t));
        if (hasMatch) {
          turn.pairEl.classList.remove('nblm-hidden');
          if (hasTagCont) tagCont.classList.remove('nblm-hidden');
        } else {
          turn.pairEl.classList.add('nblm-hidden');
          if (hasTagCont) tagCont.classList.add('nblm-hidden');
        }
      }
    });
  }

  // ─── Collapsible Model Response ────────────────────────────

  /**
   * Wrap the content of a .to-user-container in a <details>/<summary>
   * element so long model responses are collapsed by default.
   */
  function wrapModelContentCollapsible(modelEl) {
    if (!modelEl) return;
    // Skip if already wrapped
    if (modelEl.querySelector('.nblm-collapse-details')) return;

    const children = Array.from(modelEl.childNodes);
    if (children.length === 0) return;

    // Build preview text from the model content
    const fullText = modelEl.textContent || '';
    const previewText = fullText.trim().slice(0, MODEL_PREVIEW_LENGTH);
    const ellipsis = fullText.trim().length > MODEL_PREVIEW_LENGTH ? '…' : '';

    // Create <details> wrapper
    const details = document.createElement('details');
    details.className = 'nblm-collapse-details';
    // Default: collapsed (no 'open' attribute)

    // Create <summary>
    const summary = document.createElement('summary');
    summary.className = 'nblm-collapse-summary';

    const chevron = createChevronSVG();
    const previewSpan = document.createElement('span');
    previewSpan.className = 'nblm-collapse-preview';
    previewSpan.textContent = previewText + ellipsis;

    summary.appendChild(chevron);
    summary.appendChild(previewSpan);
    details.appendChild(summary);

    // Create content wrapper and move all existing children into it
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'nblm-collapse-content';
    children.forEach((child) => contentWrapper.appendChild(child));
    details.appendChild(contentWrapper);

    modelEl.appendChild(details);
  }

  // ─── Injection ─────────────────────────────────────────────

  /**
   * Inject tag containers into all conversation turns.
   * Places the tag container as a sibling AFTER the model-message-container
   * inside .chat-panel-content.
   * Also wraps model responses in collapsible sections.
   */
  function injectTagContainers() {
    const turns = getConversationTurns();
    const chatContent = document.querySelector(SELECTORS.chatContent);
    if (!chatContent) return;

    turns.forEach((turn) => {
      const anchorEl = turn.pairEl;

      // Wrap model content in collapsible <details>
      wrapModelContentCollapsible(turn.modelEl);

      // Skip tag injection if already injected
      const nextSibling = anchorEl.nextElementSibling;
      if (nextSibling && nextSibling.classList.contains('nblm-tag-container')) return;

      const turnKey = getTurnKey(turn.userEl, turn.turnIndex);

      // Store the key on the pair element for filtering lookup
      turn.pairEl.dataset.nblmTurnKey = turnKey;

      const tagContainer = createTagContainer(turnKey);

      // Insert the tag container after the chat-message-pair
      anchorEl.parentElement.insertBefore(tagContainer, anchorEl.nextSibling);
    });
  }

  // ─── Initialization ────────────────────────────────────────

  async function init() {
    notebookId = getNotebookId();
    await loadTags();

    waitForElement(SELECTORS.chatContent, () => {
      injectTagContainers();
      injectFilterButton();
      applyFilters();
      observeChatContent();
    });
  }

  function waitForElement(selector, callback, maxAttempts = 50) {
    let attempts = 0;
    const check = () => {
      attempts++;
      const el = document.querySelector(selector);
      if (el) {
        callback(el);
      } else if (attempts < maxAttempts) {
        setTimeout(check, 200);
      }
    };
    check();
  }

  function observeChatContent() {
    const chatContent = document.querySelector(SELECTORS.chatContent);
    if (!chatContent) return;

    let debounceTimer;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        injectTagContainers();
        applyFilters();
      }, OBSERVER_DEBOUNCE_MS);
    });

    observer.observe(chatContent, { childList: true, subtree: true });
  }

  // ─── URL Change Detection (SPA navigation) ─────────────────

  function watchUrlChanges() {
    let lastUrl = window.location.href;
    const urlObserver = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        cleanup();
        setTimeout(init, 500);
      }
    });
    urlObserver.observe(document.body, { childList: true, subtree: true });
  }

  function cleanup() {
    document.querySelectorAll('.nblm-tag-container').forEach((el) => el.remove());
    document.querySelectorAll('.nblm-filter-wrapper').forEach((el) => el.remove());
    document.querySelectorAll('.chat-message-pair.nblm-hidden').forEach((el) => el.classList.remove('nblm-hidden'));
    activeFilters.clear();
    filterPanelOpen = false;
  }

  // ─── Bootstrap ──────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); watchUrlChanges(); });
  } else {
    init();
    watchUrlChanges();
  }
})();
