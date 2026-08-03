/**
 * Paywall Panel — shown when the trial has expired.
 * Blocks access to the message list until a valid license key is activated.
 */

(() => {
  'use strict';

  // Lemon Squeezy hosted checkout URL for the $10 one-time variant.
  // Set this after creating the product in the Lemon Squeezy dashboard.
  const CHECKOUT_URL = 'https://REPLACE-ME.lemonsqueezy.com/checkout';

  const paywallPanel = document.getElementById('paywallPanel');
  const messageListPanel = document.getElementById('messageList');
  const noteEditorPanel = document.getElementById('noteEditorPanel');
  const settingsPanel = document.getElementById('settingsPanel');

  let isOpen = false;
  let onActivated = null;

  function buildPanel() {
    paywallPanel.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'sp-paywall-inner';

    const title = document.createElement('h2');
    title.className = 'sp-paywall-title';
    title.textContent = 'Your free trial has ended';
    wrap.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'sp-paywall-subtitle';
    subtitle.textContent = 'Unlock Long Thread Organizer for good — a one-time $10 purchase, no subscription.';
    wrap.appendChild(subtitle);

    const buyBtn = document.createElement('button');
    buyBtn.className = 'sp-paywall-buy-btn';
    buyBtn.textContent = 'Buy Now — $10';
    buyBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: CHECKOUT_URL });
    });
    wrap.appendChild(buyBtn);

    const divider = document.createElement('div');
    divider.className = 'sp-paywall-divider';
    divider.textContent = 'Already purchased?';
    wrap.appendChild(divider);

    const form = document.createElement('div');
    form.className = 'sp-paywall-activate-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sp-paywall-key-input';
    input.placeholder = 'Paste your license key';
    input.setAttribute('aria-label', 'License key');
    form.appendChild(input);

    const activateBtn = document.createElement('button');
    activateBtn.className = 'sp-paywall-activate-btn';
    activateBtn.textContent = 'Activate';
    form.appendChild(activateBtn);

    wrap.appendChild(form);

    const message = document.createElement('p');
    message.className = 'sp-paywall-message';
    wrap.appendChild(message);

    async function doActivate() {
      const key = input.value.trim();
      if (!key) {
        message.textContent = 'Enter a license key.';
        message.classList.remove('success');
        message.classList.add('error');
        return;
      }
      activateBtn.disabled = true;
      activateBtn.textContent = 'Activating…';
      message.textContent = '';
      message.classList.remove('error', 'success');

      const result = await window.License.activate(key);

      activateBtn.disabled = false;
      activateBtn.textContent = 'Activate';

      if (result.success) {
        message.textContent = 'Activated! Unlocking…';
        message.classList.add('success');
        setTimeout(() => {
          close();
          if (onActivated) onActivated();
        }, 600);
      } else {
        message.textContent = result.error || 'Activation failed.';
        message.classList.add('error');
      }
    }

    activateBtn.addEventListener('click', doActivate);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doActivate();
      }
    });

    paywallPanel.appendChild(wrap);
  }

  function open(activatedCallback) {
    onActivated = activatedCallback || null;
    if (isOpen) return;
    isOpen = true;
    messageListPanel.style.display = 'none';
    noteEditorPanel.style.display = 'none';
    settingsPanel.style.display = 'none';
    buildPanel();
    paywallPanel.style.display = 'flex';
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    paywallPanel.style.display = 'none';
    messageListPanel.style.display = '';
  }

  window.Paywall = { open, close, isOpen: () => isOpen };
})();
