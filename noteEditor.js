/**
 * NoteEditor — inline rich-text editor sub-panel
 *
 * Replaces the message list + search bar with an editor window when
 * the user clicks a message's circle-number button.
 * Notes are stored as markdown (via a simple serializer) alongside
 * other message data and are auto-saved on every input event.
 */

class NoteEditor {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.mountPoint   – container to show/hide (#noteEditorPanel)
   * @param {HTMLElement} opts.messagePanel – the message list panel to show/hide (#messageList)
   * @param {function}    opts.onSave       – called with (turnKey, markdownText) on every change
   * @param {function}    opts.getNotes     – called with (turnKey) → markdownText|''
   */
  constructor({ mountPoint, messagePanel, onSave, getNotes }) {
    this.mountPoint   = mountPoint;
    this.messagePanel = messagePanel;
    this.onSave       = onSave;
    this.getNotes     = getNotes;
    this.currentKey   = null;
    this.saveTimer    = null;

    this._buildUI();
    this._bindEvents();
  }

  /* ─── Build DOM ─────────────────────────────── */

  _buildUI() {
    this.mountPoint.innerHTML = '';

    /* ── Header bar ── */
    const header = document.createElement('div');
    header.className = 'ne-header';

    this.returnBtn = document.createElement('button');
    this.returnBtn.className = 'ne-return-btn';
    this.returnBtn.title = 'Back to messages';
    this.returnBtn.innerHTML = `
      <svg class="ne-icon-svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
      </svg>
      <span>Back</span>`;

    this.noteTitle = document.createElement('span');
    this.noteTitle.className = 'ne-title';
    this.noteTitle.textContent = 'Note';

    this.saveIndicator = document.createElement('span');
    this.saveIndicator.className = 'ne-save-indicator';
    this.saveIndicator.textContent = '';

    header.appendChild(this.returnBtn);
    header.appendChild(this.noteTitle);
    header.appendChild(this.saveIndicator);

    /* ── Toolbar ── */
    const toolbar = document.createElement('div');
    toolbar.className = 'ne-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Text formatting');

    const tools = [
      { cmd: 'heading',   label: 'H',    title: 'Heading',        icon: null },
      { cmd: 'bold',      label: 'B',    title: 'Bold',           icon: null },
      { cmd: 'insertUnorderedList', label: '•—', title: 'Bullet list', icon: null },
      { cmd: 'insertOrderedList',   label: '1.', title: 'Numbered list', icon: null },
    ];

    this.toolBtns = {};
    tools.forEach(({ cmd, label, title }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ne-tool-btn';
      btn.dataset.cmd = cmd;
      btn.textContent = label;
      btn.title = title;
      btn.setAttribute('aria-pressed', 'false');
      toolbar.appendChild(btn);
      this.toolBtns[cmd] = btn;
    });

    /* ── Editor area ── */
    this.editor = document.createElement('div');
    this.editor.className = 'ne-editor';
    this.editor.contentEditable = 'true';
    this.editor.setAttribute('role', 'textbox');
    this.editor.setAttribute('aria-multiline', 'true');
    this.editor.setAttribute('aria-label', 'Note editor');
    this.editor.setAttribute('spellcheck', 'true');
    this.editor.dataset.placeholder = 'Write your notes here…';

    /* ── Assemble ── */
    this.mountPoint.appendChild(header);
    this.mountPoint.appendChild(toolbar);
    this.mountPoint.appendChild(this.editor);
  }

  /* ─── Bind Events ───────────────────────────── */

  _bindEvents() {
    /* Return button */
    this.returnBtn.addEventListener('click', () => this.close());

    /* Toolbar buttons */
    Object.entries(this.toolBtns).forEach(([cmd, btn]) => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep editor focus
        if (cmd === 'heading') {
          this._toggleHeading();
        } else {
          document.execCommand(cmd, false, null);
        }
        this._updateToolbarState();
        this._scheduleSave();
      });
    });

    /* Auto-save on input */
    this.editor.addEventListener('input', () => {
      this._scheduleSave();
      this._updateToolbarState();
    });

    /* Update toolbar state on cursor move */
    this.editor.addEventListener('keyup', () => this._updateToolbarState());
    this.editor.addEventListener('mouseup', () => this._updateToolbarState());

    /* Keyboard shortcut: Ctrl+B = Bold */
    this.editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        document.execCommand('bold', false, null);
        this._updateToolbarState();
        this._scheduleSave();
      }
    });
  }

  /* ─── Heading Toggle ────────────────────────── */

  _toggleHeading() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;

    // Walk up to find if we're inside a heading
    let heading = null;
    let cur = node;
    while (cur && cur !== this.editor) {
      if (/^H[1-6]$/.test(cur.tagName)) { heading = cur; break; }
      cur = cur.parentNode;
    }

    if (heading) {
      // Convert heading → paragraph
      document.execCommand('formatBlock', false, 'p');
    } else {
      document.execCommand('formatBlock', false, 'h3');
    }
  }

  /* ─── Toolbar State ─────────────────────────── */

  _updateToolbarState() {
    const cmds = ['bold', 'insertUnorderedList', 'insertOrderedList'];
    cmds.forEach((cmd) => {
      const active = document.queryCommandState(cmd);
      if (this.toolBtns[cmd]) {
        this.toolBtns[cmd].classList.toggle('active', active);
        this.toolBtns[cmd].setAttribute('aria-pressed', String(active));
      }
    });

    // Heading: check if selection is inside H1-H6
    const sel = window.getSelection();
    let inHeading = false;
    if (sel && sel.rangeCount > 0) {
      let node = sel.getRangeAt(0).commonAncestorContainer;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
      let cur = node;
      while (cur && cur !== this.editor) {
        if (/^H[1-6]$/.test(cur.tagName)) { inHeading = true; break; }
        cur = cur.parentNode;
      }
    }
    if (this.toolBtns['heading']) {
      this.toolBtns['heading'].classList.toggle('active', inHeading);
      this.toolBtns['heading'].setAttribute('aria-pressed', String(inHeading));
    }
  }

  /* ─── Save / Load ───────────────────────────── */

  _scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this._save(), 600);
    this._showSaveIndicator('saving');
  }

  _save() {
    if (!this.currentKey) return;
    const md = this._htmlToMarkdown(this.editor.innerHTML);
    this.onSave(this.currentKey, md);
    this._showSaveIndicator('saved');
  }

  _showSaveIndicator(state) {
    if (state === 'saving') {
      this.saveIndicator.textContent = '…';
      this.saveIndicator.className = 'ne-save-indicator saving';
    } else {
      this.saveIndicator.textContent = '✓ Saved';
      this.saveIndicator.className = 'ne-save-indicator saved';
      clearTimeout(this._savedFadeTimer);
      this._savedFadeTimer = setTimeout(() => {
        this.saveIndicator.textContent = '';
        this.saveIndicator.className = 'ne-save-indicator';
      }, 1800);
    }
  }

  /* ─── Markdown Conversion ───────────────────── */

  /**
   * Convert the editor's innerHTML into simple markdown.
   * We only handle: h1-h6, b/strong, ul/ol/li, p, br.
   */
  _htmlToMarkdown(html) {
    // Parse into a temporary DOM for traversal
    const tmp = document.createElement('div');
    tmp.innerHTML = html;

    const lines = [];

    const processNode = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }

      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      const inner = Array.from(node.childNodes).map(processNode).join('');

      switch (tag) {
        case 'h1': lines.push('# ' + inner.trim()); return '';
        case 'h2': lines.push('## ' + inner.trim()); return '';
        case 'h3': lines.push('### ' + inner.trim()); return '';
        case 'h4': lines.push('#### ' + inner.trim()); return '';
        case 'h5': lines.push('##### ' + inner.trim()); return '';
        case 'h6': lines.push('###### ' + inner.trim()); return '';
        case 'p':  lines.push(inner.trim()); return '';
        case 'div': {
          if (inner.trim()) lines.push(inner.trim());
          return '';
        }
        case 'br': return '\n';
        case 'strong':
        case 'b': return `**${inner}**`;
        case 'em':
        case 'i': return `*${inner}*`;
        case 'ul': {
          Array.from(node.children).forEach((li) => {
            const liText = Array.from(li.childNodes).map(processNode).join('').trim();
            lines.push('- ' + liText);
          });
          return '';
        }
        case 'ol': {
          Array.from(node.children).forEach((li, i) => {
            const liText = Array.from(li.childNodes).map(processNode).join('').trim();
            lines.push(`${i + 1}. ` + liText);
          });
          return '';
        }
        case 'li': return inner; // handled by ul/ol
        default:   return inner;
      }
    };

    Array.from(tmp.childNodes).forEach(processNode);
    return lines.join('\n');
  }

  /**
   * Convert markdown back to HTML for display in the contenteditable editor.
   */
  _markdownToHtml(md) {
    if (!md || !md.trim()) return '';

    const lines = md.split('\n');
    let html = '';
    let inUL = false, inOL = false;

    const closeLists = () => {
      if (inUL) { html += '</ul>'; inUL = false; }
      if (inOL) { html += '</ol>'; inOL = false; }
    };

    const inlineMarkdown = (text) =>
      text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');

    lines.forEach((line) => {
      // Headings
      const hMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (hMatch) {
        closeLists();
        const level = hMatch[1].length;
        html += `<h${level}>${inlineMarkdown(hMatch[2])}</h${level}>`;
        return;
      }
      // Unordered list
      const ulMatch = line.match(/^[-*]\s+(.+)/);
      if (ulMatch) {
        closeLists();
        if (!inUL) { html += '<ul>'; inUL = true; }
        html += `<li>${inlineMarkdown(ulMatch[1])}</li>`;
        return;
      }
      // Ordered list
      const olMatch = line.match(/^\d+\.\s+(.+)/);
      if (olMatch) {
        if (inUL) { html += '</ul>'; inUL = false; }
        if (!inOL) { html += '<ol>'; inOL = true; }
        html += `<li>${inlineMarkdown(olMatch[1])}</li>`;
        return;
      }

      // Regular paragraph
      closeLists();
      if (line.trim()) {
        html += `<p>${inlineMarkdown(line)}</p>`;
      } else {
        html += '<p><br></p>';
      }
    });

    closeLists();
    return html;
  }

  /* ─── Public API ────────────────────────────── */

  /**
   * Open the editor for a specific message.
   * @param {string} turnKey
   * @param {number} msgIndex  — 1-based display number
   */
  open(turnKey, msgIndex) {
    this.currentKey = turnKey;
    this.noteTitle.textContent = `Note #${msgIndex}`;

    // Load existing note
    const existing = this.getNotes(turnKey);
    this.editor.innerHTML = existing ? this._markdownToHtml(existing) : '';

    if (!this.editor.innerHTML) {
      // Ensure editor starts with a paragraph so cursor lands correctly
      this.editor.innerHTML = '<p><br></p>';
    }

    // Show editor, hide message list
    this.messagePanel.style.display = 'none';
    this.mountPoint.style.display   = 'flex';

    // Focus editor
    requestAnimationFrame(() => {
      this.editor.focus();
      // Place cursor at end
      const range = document.createRange();
      range.selectNodeContents(this.editor);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    this._updateToolbarState();
    this.saveIndicator.textContent = '';
    this.saveIndicator.className = 'ne-save-indicator';
  }

  /** Close editor and return to message list. */
  close() {
    // Flush any pending save immediately
    clearTimeout(this.saveTimer);
    this._save();

    this.mountPoint.style.display   = 'none';
    this.messagePanel.style.display = '';
    this.currentKey = null;
  }

  /** Returns true when the editor panel is currently visible. */
  get isOpen() {
    return this.mountPoint.style.display !== 'none' && this.mountPoint.style.display !== '';
  }
}
