/**
 * Settings Panel — Background Image Picker
 *
 * Colors: 6 solid-color options (None = no image, just a body color).
 * Presets: Flower, Saigon Street, Focus (sunset).
 * Custom: user can upload any image — stored as a base64 data URL in
 * chrome.storage.local so it survives panel restarts.
 * Default: Focus (sunset image).
 */

(() => {
  'use strict';

  const SETTINGS_KEY = 'app_settings';

  // ── Solid color options (shown in the "Color" section) ───────────────────────
  const COLORS = [
    { id: 'color-none',       label: 'None',        value: null,      textDark: false },
    { id: 'color-orange',     label: 'Orange',      value: '#FFE0B2', textDark: true  },
    { id: 'color-blue',       label: 'Blue',        value: '#BBDEFB', textDark: true  },
    { id: 'color-navy',       label: 'Navy',        value: '#0D1B2A', textDark: false },
    { id: 'color-white',      label: 'White',       value: '#FFFFFF', textDark: true  },
    { id: 'color-pink',       label: 'Pink',        value: '#FFDDE1', textDark: true  },
    { id: 'color-dark',       label: 'Dark',        value: '#1E1E1E', textDark: false },
  ];

  // ── Preset images ───────────────────────────────────────────────────────────
  const PRESETS = [
    { id: 'flower', label: 'Flower', file: 'pictures/flower.jpg' },
    { id: 'saigon-street', label: 'Saigon Street', file: 'pictures/saigon-street.jpg' },
    { id: 'sunset', label: 'Focus', file: 'pictures/sunset.jpg' },
  ];

  // ── DOM references ──────────────────────────────────────────────────────────
  const settingsPanel = document.getElementById('settingsPanel');
  const messageListPanel = document.getElementById('messageList');
  const btnSettings = document.getElementById('btnSettings');
  const noteEditorPanel = document.getElementById('noteEditorPanel');

  let isOpen = false;
  let currentBgId = 'sunset';     // default: Focus
  let currentColorId = 'color-none'; // default: no solid color overlay
  let customDataUrl = null;   // base64 data URL of user-uploaded image

  // ── Storage helpers ─────────────────────────────────────────────────────────
  async function saveSettings(patch) {
    const existing = await loadSettings();
    const merged = { ...existing, ...patch };
    return new Promise((resolve) => {
      chrome.storage.local.set({ [SETTINGS_KEY]: merged }, resolve);
    });
  }

  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([SETTINGS_KEY], (result) => {
        resolve(result[SETTINGS_KEY] || { bgId: 'sunset', colorId: 'color-none', customDataUrl: null });
      });
    });
  }

  // ── Apply solid color ───────────────────────────────────────────────────────
  function applyColor(colorId) {
    currentColorId = colorId;
    const col = COLORS.find((c) => c.id === colorId);
    if (col && col.value) {
      document.documentElement.style.setProperty('--bg-solid', col.value);
      document.documentElement.classList.add('has-bg-solid');
      document.body.classList.add('has-bg-solid');
    } else {
      document.documentElement.style.removeProperty('--bg-solid');
      document.documentElement.classList.remove('has-bg-solid');
      document.body.classList.remove('has-bg-solid');
    }
    // Refresh color swatch selection
    settingsPanel.querySelectorAll('.sp-color-swatch').forEach((el) => {
      el.classList.toggle('selected', el.dataset.colorId === colorId);
    });
  }

  // ── Apply background ────────────────────────────────────────────────────────
  function applyBackground(bgId, dataUrl = null) {
    currentBgId = bgId;

    let cssUrl;
    if (bgId === 'custom' && dataUrl) {
      cssUrl = `url("${dataUrl}")`;
    } else {
      const preset = PRESETS.find((b) => b.id === bgId);
      cssUrl = preset && preset.file ? `url("${preset.file}")` : 'none';
    }

    document.body.style.setProperty('--bg-image', cssUrl);
    document.body.classList.toggle('has-bg-image', cssUrl !== 'none');

    // Refresh selection indicators if panel is built
    settingsPanel.querySelectorAll('.sp-bg-option').forEach((el) => {
      el.classList.toggle('selected', el.dataset.bgId === bgId);
    });

    // Show/hide the remove-custom button
    const removeBtn = settingsPanel.querySelector('#btnRemoveCustom');
    if (removeBtn) removeBtn.style.display = (bgId === 'custom' && dataUrl) ? 'inline-flex' : 'none';
  }

  // ── Read file as data URL ───────────────────────────────────────────────────
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ── Build panel ─────────────────────────────────────────────────────────────
  function buildPanel() {
    settingsPanel.innerHTML = '';

    // ── Header ──────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'sp-settings-header';

    const backBtn = document.createElement('button');
    backBtn.className = 'ne-return-btn';
    backBtn.innerHTML = `
      <svg class="ne-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
      </svg>
      Back`;
    backBtn.addEventListener('click', close);

    const title = document.createElement('span');
    title.className = 'sp-settings-title';
    title.textContent = 'Settings';

    header.appendChild(backBtn);
    header.appendChild(title);
    settingsPanel.appendChild(header);

    // ── Section: Color ───────────────────────────────────────────────────────
    const colorSection = document.createElement('div');
    colorSection.className = 'sp-settings-section';

    const colorTitle = document.createElement('h2');
    colorTitle.className = 'sp-settings-section-title';
    colorTitle.textContent = 'Color';
    colorSection.appendChild(colorTitle);

    const colorRow = document.createElement('div');
    colorRow.className = 'sp-color-row';
    COLORS.forEach((col) => {
      colorRow.appendChild(buildColorSwatch(col));
    });
    colorSection.appendChild(colorRow);
    settingsPanel.appendChild(colorSection);

    // ── Section: Background ──────────────────────────────────────────────────
    const section = document.createElement('div');
    section.className = 'sp-settings-section';

    const sectionTitle = document.createElement('h2');
    sectionTitle.className = 'sp-settings-section-title';
    sectionTitle.textContent = 'Background Image';
    section.appendChild(sectionTitle);

    const grid = document.createElement('div');
    grid.className = 'sp-bg-grid';

    // ── Preset tiles ─────────────────────────────────────────────────────────
    PRESETS.forEach((bg) => {
      const item = buildPresetTile(bg);
      grid.appendChild(item);
    });

    // ── Custom upload tile ───────────────────────────────────────────────────
    grid.appendChild(buildCustomTile());

    section.appendChild(grid);

    // ── Remove custom button (hidden unless custom is active) ────────────────
    const removeBtn = document.createElement('button');
    removeBtn.id = 'btnRemoveCustom';
    removeBtn.className = 'sp-remove-custom-btn';
    removeBtn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" width="13" height="13" fill="currentColor">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
      </svg>
      Remove custom image`;
    removeBtn.style.display = (currentBgId === 'custom' && customDataUrl) ? 'inline-flex' : 'none';
    removeBtn.addEventListener('click', async () => {
      customDataUrl = null;
      currentBgId = 'none';
      await saveSettings({ bgId: 'none', customDataUrl: null });
      applyBackground('none', null);
      buildPanel();   // rebuild to reset tile preview
    });
    section.appendChild(removeBtn);

    settingsPanel.appendChild(section);
  }

  // ── Color swatch builder ─────────────────────────────────────────────────
  function buildColorSwatch(col) {
    const btn = document.createElement('button');
    btn.className = 'sp-color-swatch';
    btn.dataset.colorId = col.id;
    btn.title = col.label;
    if (col.id === currentColorId) btn.classList.add('selected');

    if (col.value) {
      btn.style.background = col.value;
    } else {
      // "None" — checker pattern via CSS class
      btn.classList.add('sp-color-swatch--none');
    }

    const label = document.createElement('span');
    label.className = 'sp-color-swatch__label';
    label.textContent = col.label;
    if (col.textDark) label.classList.add('sp-color-swatch__label--dark');
    btn.appendChild(label);

    const check = document.createElement('span');
    check.className = 'sp-color-swatch__check';
    check.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`;
    btn.appendChild(check);

    btn.addEventListener('click', async () => {
      applyColor(col.id);
      await saveSettings({ colorId: col.id });
    });

    return btn;
  }

  function buildPresetTile(bg) {
    const item = document.createElement('button');
    item.className = 'sp-bg-option';
    item.dataset.bgId = bg.id;
    item.title = bg.label;
    if (bg.id === currentBgId) item.classList.add('selected');

    if (bg.file) {
      item.style.backgroundImage = `url("${bg.file}")`;
    } else {
      item.classList.add('sp-bg-option--none');
    }

    item.appendChild(makeLabel(bg.label, !bg.file));
    item.appendChild(makeCheck());

    item.addEventListener('click', async () => {
      applyBackground(bg.id, null);
      await saveSettings({ bgId: bg.id });
    });

    return item;
  }

  function buildCustomTile() {
    // Hidden file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    fileInput.id = 'customBgFileInput';
    settingsPanel.appendChild(fileInput);

    const item = document.createElement('button');
    item.className = 'sp-bg-option sp-bg-option--custom';
    item.dataset.bgId = 'custom';
    item.title = 'Upload your own image';
    if (customDataUrl) {
      // Always show the stored thumbnail, regardless of which bg is active
      item.style.backgroundImage = `url("${customDataUrl}")`;
    }
    if (currentBgId === 'custom') {
      item.classList.add('selected');
    }

    // Upload icon (shown when no custom image yet)
    const uploadIcon = document.createElement('span');
    uploadIcon.className = 'sp-bg-option__upload-icon';
    uploadIcon.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
      </svg>
      <span>Upload Image</span>`;
    // Upload icon: hidden whenever a custom image is stored (even if not currently active)
    uploadIcon.style.display = customDataUrl ? 'none' : 'flex';
    item.appendChild(uploadIcon);

    item.appendChild(makeLabel('Custom', false));
    item.appendChild(makeCheck());

    item.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        const dataUrl = await readFileAsDataUrl(file);
        customDataUrl = dataUrl;
        await saveSettings({ bgId: 'custom', customDataUrl: dataUrl });
        applyBackground('custom', dataUrl);
        // Update tile thumbnail inline
        item.style.backgroundImage = `url("${dataUrl}")`;
        item.classList.add('selected');
        uploadIcon.style.display = 'none';
        settingsPanel.querySelectorAll('.sp-bg-option').forEach((el) => {
          if (el !== item) el.classList.remove('selected');
        });
        const removeBtn = settingsPanel.querySelector('#btnRemoveCustom');
        if (removeBtn) removeBtn.style.display = 'inline-flex';
        // Always show the thumbnail going forward
        uploadIcon.style.display = 'none';
      } catch (err) {
        console.error('Failed to read image file:', err);
      }
      fileInput.value = '';   // reset so same file can be re-selected
    });

    return item;
  }

  function makeLabel(text, isLight) {
    const label = document.createElement('span');
    label.className = 'sp-bg-option__label';
    label.textContent = text;
    if (isLight) label.classList.add('sp-bg-option__label--dark');
    return label;
  }

  function makeCheck() {
    const check = document.createElement('span');
    check.className = 'sp-bg-option__check';
    check.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`;
    return check;
  }

  // ── Open / close ────────────────────────────────────────────────────────────
  function open() {
    if (isOpen) return;
    isOpen = true;
    messageListPanel.style.display = 'none';
    noteEditorPanel.style.display = 'none';
    buildPanel();
    settingsPanel.style.display = 'flex';
    btnSettings.classList.add('active');
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    settingsPanel.style.display = 'none';
    messageListPanel.style.display = '';
    btnSettings.classList.remove('active');
  }

  function toggle() {
    if (isOpen) close(); else open();
  }

  // ── Button wiring ───────────────────────────────────────────────────────────
  btnSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });

  // ── Init ────────────────────────────────────────────────────────────────────
  async function init() {
    const settings = await loadSettings();
    customDataUrl = settings.customDataUrl || null;
    applyColor(settings.colorId || 'color-none');
    applyBackground(settings.bgId || 'sunset', customDataUrl);
  }

  init();

  window.SettingsPanel = { open, close, isOpen: () => isOpen };
})();
